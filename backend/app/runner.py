"""Backtest application service: resolves a run's configuration, queues it as a
job, and (inside the worker) feeds market data to the engine and stores results."""

from __future__ import annotations

import logging
from datetime import date, timedelta

from fastapi import HTTPException
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from . import audit, jobs
from .config import get_settings
from .db import SessionLocal
from .engine.backtester import BacktestConfig, Backtester, Contributions, CostModel, RiskModel
from .engine.strategies.library import build
from .marketdata.catalog import UNIVERSES
from .marketdata.providers import get_provider
from .marketdata.quality import describe, neutralise_jumps
from .marketdata.service import default_symbols, ensure_fresh, load_panel, sync_symbol
from .models import Backtest, BacktestDecision, BacktestPosition, BacktestTransaction, Instrument, Job, Strategy, User, utcnow
from .results import store_outputs, strip_rows
from .schemas import BacktestIn

log = logging.getLogger(__name__)

MAX_ACTIVE_PER_USER = 12  # queued + running backtests per user, protects the shared worker

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
    active = db.scalar(select(func.count()).select_from(Backtest).where(Backtest.owner_id == user.id, Backtest.status.in_(["queued", "running"])))
    if active >= MAX_ACTIVE_PER_USER:
        raise HTTPException(429, f"Vous avez déjà {active} simulations en cours : attendez qu'elles se terminent avant d'en lancer d'autres.")
    version = body.version or strategy.current_version
    cfg = resolve_config(strategy, version, body)
    bt = Backtest(
        owner_id=user.id, strategy_id=strategy.id, strategy_version=version, portfolio_id=portfolio_id,
        name=body.name or f"{strategy.name} · {cfg['start'][:4]}–{cfg['end'][:4]}", status="queued", config=cfg,
    )
    db.add(bt)
    db.flush()
    bt.job_id = jobs.enqueue(db, "backtest", {"backtest_id": str(bt.id)}, owner_id=user.id).id
    audit.record(db, "backtest.launch", actor=user, request=request, resource_type="backtest", resource_id=bt.id,
                 after={"strategy_id": str(strategy.id), "version": version, "config": cfg, "job_id": str(bt.job_id)})
    return bt


def _assumptions(cfg: dict, names: dict, bench_kind: str | None, source: str | None = None) -> list[str]:
    c, r = cfg["costs"], cfg["risk"]
    out = [
        "Les décisions sont prises à la clôture du jour J avec les seules données disponibles à cette date, "
        "et exécutées à l'ouverture du jour J+1 (pas de biais d'anticipation).",
        f"Rééquilibrage {FREQ_FR.get(cfg['rebalance'], cfg['rebalance'])} : premier jour de bourse de chaque période.",
        f"Cours ajustés des dividendes et opérations sur titres (source : {source or 'Yahoo Finance'}) : les dividendes sont "
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
    preset = cfg.get("universe_preset")
    if preset in ("cac40", "sbf120", "mid60"):
        index = "CAC 40" if preset == "cac40" else "SBF 120"
        out.append(
            f"Biais du survivant : l'univers {index} est une composition récente de l'indice, appliquée à tout "
            "l'historique. Les sociétés sorties de l'indice ou disparues sont absentes, ce qui flatte les résultats passés."
        )
    if preset in ("sbf120", "mid60"):
        out.append("Valeurs moyennes : volumes d'échange plus faibles, l'écart entre prix d'achat et de vente réel peut "
                   "dépasser le slippage simulé.")
    if r.get("max_weight_pct", 100) < 100 or r.get("cash_buffer_pct") or r.get("stop_loss_pct"):
        out.append(f"Contraintes de risque : poids max {r['max_weight_pct']:g} %, réserve de liquidités "
                   f"{r['cash_buffer_pct']:g} %, stop-loss {('−%g %%' % r['stop_loss_pct']) if r['stop_loss_pct'] else 'désactivé'}.")
    out.append("Les performances passées simulées ne préjugent pas des performances futures.")
    return out


def _benchmark_note(db: Session, bench: str) -> str | None:
    inst = db.get(Instrument, bench)
    return None if inst is None else get_provider(inst.provider).label


@jobs.handler("backtest")
def run_backtest_job(job: Job, report: jobs.Reporter) -> None:
    settings = get_settings()
    with SessionLocal() as db:
        bt = db.get(Backtest, job.payload["backtest_id"])
        if bt is None:
            return
        bt.status, bt.started_at, bt.error = "running", utcnow(), None
        db.commit()
        cfg = bt.config
        strategy = build(cfg["kind"], cfg["parameters"])
        symbols = cfg["universe"]
        bench = cfg["benchmark"]
        report(0.02, "Mise à jour des données de marché", force=True)
        warnings = ensure_fresh(db, symbols + [bench], settings.market_data_refresh_hours)

        report(0.1, "Chargement des cours", force=True)
        start, end = date.fromisoformat(cfg["start"]), date.fromisoformat(cfg["end"])
        lead = timedelta(days=int(strategy.warmup_days() * 1.5) + 30)
        close, open_ = load_panel(db, symbols + [bench], start - lead, end)
        close, open_, jumps = neutralise_jumps(close, open_)
        if close.empty or bench not in close.columns:
            raise jobs.UserFacingError(f"Pas de données de marché pour l'indice de référence {bench} sur la période.")
        uni = [s for s in symbols if s in close.columns]
        missing = sorted(set(symbols) - set(uni))
        if missing:
            warnings.append(f"Sans données sur la période, ignorés : {', '.join(missing)}.")
        if not uni:
            raise jobs.UserFacingError("Aucun actif de l'univers n'a de données sur la période.")
        names = dict(db.execute(select(Instrument.symbol, Instrument.name).where(Instrument.symbol.in_(symbols + [bench]))).all())
        warnings += describe(jumps, names)
        currencies = set(db.scalars(select(Instrument.currency).where(Instrument.symbol.in_(uni))).all())
        if len(currencies) > 1:
            warnings.append(f"Univers multi-devises ({', '.join(sorted(currencies))}) : aucune conversion de change n'est appliquée.")

        bench_close = close[bench].dropna()
        bench_open = open_[bench].dropna()
        try:
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
            res = engine.run(progress=lambda x: report(0.15 + 0.75 * x, "Simulation jour par jour"))
        except ValueError as exc:  # invalid period / configuration detected by the engine
            raise jobs.UserFacingError(str(exc)) from exc

        report(0.92, "Enregistrement des résultats", force=True)
        res["warnings"] = warnings + res["warnings"]
        res["assumptions"] = _assumptions(cfg, names, db.scalar(select(Instrument.kind).where(Instrument.symbol == bench)),
                                          _benchmark_note(db, bench))
        res["names"] = names
        res["effective_period"] = {"start": res["series"]["dates"][0], "end": res["series"]["dates"][-1]}
        res["data_as_of"] = max((v for v in db.scalars(select(Instrument.last_synced_at).where(Instrument.symbol.in_(uni + [bench]))) if v),
                                default=None)
        if res["data_as_of"]:
            res["data_as_of"] = res["data_as_of"].isoformat()
        conn = db.connection()
        for table in (BacktestDecision, BacktestTransaction, BacktestPosition):  # a re-queued job may have stored a partial run
            conn.execute(delete(table).where(table.backtest_id == bt.id))
        store_outputs(conn, bt.id, res)
        res["counts"] = {"decisions": len(res["decisions"]), "trades": len(res["trades"]), "positions": len(res["positions"])}
        bt.results = strip_rows(res)
        bt.summary = res["summary"]
        bt.status, bt.finished_at = "done", utcnow()
        owner = db.get(User, bt.owner_id)
        s = res["summary"]["strategy"]
        audit.record(db, "backtest.complete", actor=owner, resource_type="backtest", resource_id=bt.id,
                     details={"cagr": s.get("cagr"), "max_drawdown": s.get("max_drawdown"), "trades": s.get("trades")})
        db.commit()


def _backtest_failed(job: Job, message: str) -> None:
    with SessionLocal() as db:
        bt = db.get(Backtest, job.payload["backtest_id"])
        if bt is None:
            return
        bt.status, bt.error, bt.finished_at = "failed", message, utcnow()
        audit.record(db, "backtest.complete", actor=db.get(User, bt.owner_id), resource_type="backtest", resource_id=bt.id,
                     outcome="failure", details={"error": message[:500], "job_id": str(job.id)})
        db.commit()


jobs.FAILURE_HOOKS["backtest"] = _backtest_failed


@jobs.handler("market_sync")
def run_market_sync_job(job: Job, report: jobs.Reporter) -> None:
    """Refresh a list of symbols (all reference symbols by default)."""
    symbols = job.payload.get("symbols") or default_symbols()
    failures = []
    with SessionLocal() as db:
        for k, s in enumerate(symbols):
            report(k / len(symbols), f"{s} ({k + 1}/{len(symbols)})")
            try:
                sync_symbol(db, s)
            except Exception as exc:  # noqa: BLE001 - one bad symbol must not stop the others
                failures.append(f"{s}: {exc}")
    if failures and len(failures) == len(symbols):
        raise jobs.UserFacingError("Aucun symbole n'a pu être rafraîchi : " + "; ".join(failures[:5]))
    if failures:
        log.warning("market sync partial failure", extra={"job_id": str(job.id), "failures": failures[:20]})


__all__ = ["create_backtest", "resolve_config", "run_backtest_job", "run_market_sync_job"]
