"""Runs backtests off the request thread and stores their results."""

from __future__ import annotations

import logging
import traceback
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta

from fastapi import HTTPException
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from . import audit
from .config import get_settings
from .db import SessionLocal
from .engine.backtester import BacktestConfig, Backtester, Contributions, CostModel, RiskModel
from .engine.data import UNIVERSES, ensure_fresh, load_panel
from .engine.strategies.library import build
from .models import Backtest, Instrument, Strategy, User, utcnow
from .schemas import BacktestIn

log = logging.getLogger(__name__)
_pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="backtest")

FREQ_FR = {"daily": "quotidien", "weekly": "hebdomadaire", "monthly": "mensuel", "quarterly": "trimestriel", "yearly": "annuel", "never": "aucun"}


def resolve_config(strategy: Strategy, version: int, body: BacktestIn) -> dict:
    v = next((x for x in strategy.versions if x.version == version), None)
    if v is None:
        raise HTTPException(404, f"Version {version} introuvable")
    d = v.definition
    universe = body.universe.model_dump() if body.universe else d["universe"]
    symbols = list(universe.get("symbols") or [])
    if universe.get("preset") in UNIVERSES:
        symbols = list(dict.fromkeys(UNIVERSES[universe["preset"]]["symbols"] + symbols))
    if not symbols:
        raise HTTPException(422, "Univers d'investissement vide.")
    return {
        "start": body.start.isoformat(),
        "end": min(body.end, date.today()).isoformat(),
        "initial_capital": body.initial_capital,
        "contributions": body.contributions.model_dump(mode="json"),
        "tax_mode": body.tax_mode,
        "tax_rate_pct": body.tax_rate_pct,
        "fractional": body.fractional,
        "risk_free_pct": body.risk_free_pct,
        "universe": symbols,
        "universe_preset": universe.get("preset"),
        "benchmark": body.benchmark or d["benchmark"],
        "rebalance": body.rebalance_frequency or d["rebalance_frequency"],
        "costs": (body.transaction_cost_model.model_dump() if body.transaction_cost_model else d["transaction_cost_model"]),
        "risk": (body.risk_model.model_dump() if body.risk_model else d["risk_model"]),
        "kind": strategy.kind,
        "parameters": d["parameters"],
    }


def create_backtest(db: Session, user: User, strategy: Strategy, body: BacktestIn, portfolio_id=None, request=None) -> Backtest:
    if strategy.status in ("inactive", "archived") and portfolio_id is None:
        raise HTTPException(409, "Stratégie désactivée : réactivez-la pour lancer un backtest.")
    version = body.version or strategy.current_version
    cfg = resolve_config(strategy, version, body)
    bt = Backtest(
        owner_id=user.id, strategy_id=strategy.id, strategy_version=version, portfolio_id=portfolio_id,
        name=body.name or f"{strategy.name} · {cfg['start'][:4]}–{cfg['end'][:4]}", status="queued", config=cfg,
    )
    db.add(bt)
    db.flush()
    audit.record(db, "backtest.launch", actor=user, request=request, resource_type="backtest", resource_id=bt.id,
                 after={"strategy_id": str(strategy.id), "version": version, "config": cfg})
    return bt


def submit(backtest_id) -> None:
    _pool.submit(_run_safe, backtest_id)


def recover_interrupted() -> None:
    with SessionLocal() as db:
        db.execute(update(Backtest).where(Backtest.status.in_(["queued", "running"])).values(
            status="failed", error="Interrompu par un redémarrage du serveur. Relancez le backtest."))
        db.commit()


def _assumptions(cfg: dict, names: dict, bench_kind: str | None) -> list[str]:
    c, r = cfg["costs"], cfg["risk"]
    out = [
        "Les décisions sont prises à la clôture du jour J avec les seules données disponibles à cette date, "
        "et exécutées à l'ouverture du jour J+1 (pas de biais d'anticipation).",
        f"Rééquilibrage {FREQ_FR.get(cfg['rebalance'], cfg['rebalance'])} : premier jour de bourse de chaque période.",
        "Cours ajustés des dividendes et opérations sur titres (source : Yahoo Finance) : les dividendes sont "
        "considérés comme réinvestis.",
        f"Frais de courtage : {c['fee_pct']:g} % par ordre (minimum {c['fee_min']:g} €) ; slippage de "
        f"{c['slippage_bps']:g} points de base appliqué au prix d'exécution.",
        "Fractions d'actions autorisées." if cfg["fractional"] else "Achats en nombre entier d'actions uniquement.",
        (f"Fiscalité : flat tax de {cfg['tax_rate_pct']:g} % sur les plus-values nettes de l'année civile, "
         "moins-values reportables, prélevée lors des ventes." if cfg["tax_mode"] == "pfu"
         else "Fiscalité non simulée (comparable à une enveloppe PEA avant retrait)."),
        (f"L'indice de référence ({names.get(cfg['benchmark'], cfg['benchmark'])}) reçoit les mêmes versements, sans frais de courtage. "
         + ("C'est un indice de prix : il n'inclut pas les dividendes, contrairement aux cours ajustés des actions, "
            "ce qui avantage mécaniquement la stratégie face à lui (≈ 2 à 3 % par an pour le CAC 40)."
            if bench_kind == "index" else "Ses cours ajustés incluent les dividendes réinvestis (et ses frais de gestion).")),
        f"Taux sans risque pour Sharpe / Sortino / alpha : {cfg['risk_free_pct']:g} % par an.",
        "Les liquidités non investies ne sont pas rémunérées.",
    ]
    if cfg.get("universe_preset") == "cac40":
        out.append(
            "Biais du survivant : l'univers CAC 40 est la composition récente de l'indice, appliquée à tout "
            "l'historique. Les sociétés sorties de l'indice ou disparues sont absentes, ce qui flatte les résultats passés."
        )
    if r.get("max_weight_pct", 100) < 100 or r.get("cash_buffer_pct") or r.get("stop_loss_pct"):
        out.append(f"Contraintes de risque : poids max {r['max_weight_pct']:g} %, réserve de liquidités "
                   f"{r['cash_buffer_pct']:g} %, stop-loss {('−%g %%' % r['stop_loss_pct']) if r['stop_loss_pct'] else 'désactivé'}.")
    out.append("Les performances passées simulées ne préjugent pas des performances futures.")
    return out


def _run_safe(backtest_id) -> None:
    try:
        _run(backtest_id)
    except Exception as exc:  # noqa: BLE001
        log.exception("backtest %s failed", backtest_id)
        with SessionLocal() as db:
            bt = db.get(Backtest, backtest_id)
            if bt:
                bt.status = "failed"
                bt.error = str(exc) if isinstance(exc, (ValueError, RuntimeError)) else "Erreur interne : " + traceback.format_exc(limit=1).splitlines()[-1]
                bt.finished_at = utcnow()
                owner = db.get(User, bt.owner_id)
                audit.record(db, "backtest.complete", actor=owner, resource_type="backtest", resource_id=bt.id,
                             outcome="failure", details={"error": bt.error[:500]})
                db.commit()


def _run(backtest_id) -> None:
    settings = get_settings()
    with SessionLocal() as db:
        bt = db.get(Backtest, backtest_id)
        if bt is None:
            return
        bt.status, bt.started_at = "running", utcnow()
        db.commit()
        cfg = bt.config
        strategy = build(cfg["kind"], cfg["parameters"])
        symbols = cfg["universe"]
        bench = cfg["benchmark"]
        warnings = ensure_fresh(db, symbols + [bench], settings.market_data_refresh_hours)

        start, end = date.fromisoformat(cfg["start"]), date.fromisoformat(cfg["end"])
        lead = timedelta(days=int(strategy.warmup_days() * 1.5) + 30)
        close, open_ = load_panel(db, symbols + [bench], start - lead, end)
        if close.empty or bench not in close.columns:
            raise ValueError(f"Pas de données de marché pour l'indice de référence {bench} sur la période.")
        uni = [s for s in symbols if s in close.columns]
        missing = sorted(set(symbols) - set(uni))
        if missing:
            warnings.append(f"Sans données sur la période, ignorés : {', '.join(missing)}.")
        if not uni:
            raise ValueError("Aucun actif de l'univers n'a de données sur la période.")
        names = dict(db.execute(select(Instrument.symbol, Instrument.name).where(Instrument.symbol.in_(symbols + [bench]))).all())
        currencies = set(db.scalars(select(Instrument.currency).where(Instrument.symbol.in_(uni))).all())
        if len(currencies) > 1:
            warnings.append(f"Univers multi-devises ({', '.join(sorted(currencies))}) : aucune conversion de change n'est appliquée.")

        bench_close = close[bench].dropna()
        bench_open = open_[bench].dropna()
        engine = Backtester(
            strategy,
            BacktestConfig(
                start=start, end=end, initial_capital=cfg["initial_capital"], universe=uni, benchmark=bench,
                rebalance=cfg["rebalance"], costs=CostModel(**cfg["costs"]), risk=RiskModel(**cfg["risk"]),
                contributions=Contributions(
                    amount=cfg["contributions"]["amount"], frequency=cfg["contributions"]["frequency"],
                    start=date.fromisoformat(cfg["contributions"]["start"]) if cfg["contributions"].get("start") else None,
                    end=date.fromisoformat(cfg["contributions"]["end"]) if cfg["contributions"].get("end") else None,
                ),
                tax_mode=cfg["tax_mode"], tax_rate_pct=cfg["tax_rate_pct"], fractional=cfg["fractional"],
                risk_free_pct=cfg["risk_free_pct"],
            ),
            close[uni].dropna(how="all"), open_[uni], bench_close, bench_open, names,
        )
        res = engine.run()
        res["warnings"] = warnings + res["warnings"]
        res["assumptions"] = _assumptions(cfg, names, db.scalar(select(Instrument.kind).where(Instrument.symbol == bench)))
        res["names"] = names
        res["effective_period"] = {"start": res["series"]["dates"][0], "end": res["series"]["dates"][-1]}
        bt.results = res
        bt.summary = res["summary"]
        bt.status, bt.finished_at = "done", utcnow()
        owner = db.get(User, bt.owner_id)
        s = res["summary"]["strategy"]
        audit.record(db, "backtest.complete", actor=owner, resource_type="backtest", resource_id=bt.id,
                     details={"cagr": s.get("cagr"), "max_drawdown": s.get("max_drawdown"), "trades": s.get("trades")})
        db.commit()
