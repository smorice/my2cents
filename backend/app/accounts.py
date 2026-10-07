"""Real accounts: reviews that turn a strategy into order proposals, and the ledger of fills.

A review runs in the worker (it may need to refresh market data): on demand from the
account page, or every weekday evening for accounts with `auto_review`, in which case
the owner gets an email when there are orders to place.
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import Callable
from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

import pandas as pd
from fastapi import HTTPException
from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from . import audit, jobs
from .config import get_settings
from .db import SessionLocal
from .engine.backtester import CostModel, RiskModel
from .engine.live import Holding, LiveConfig, due_mode, propose
from .engine.strategies.library import build
from .mailer import mail_enabled, send_mail
from .marketdata.catalog import UNIVERSES
from .marketdata.quality import describe, neutralise_jumps
from .marketdata.service import ensure_fresh, load_panel
from .models import AccountMovement, Instrument, Job, OrderProposal, PriceBar, ProposedOrder, RealAccount, RealPosition, User, utcnow

log = logging.getLogger(__name__)

REVIEW_DATA_MAX_AGE_HOURS = 2
PARIS = ZoneInfo("Europe/Paris")
SESSION_END = time(17, 40)  # Euronext closing auction is over


def definition(acc: RealAccount) -> dict:
    s = acc.strategy
    if s is None:
        raise jobs.UserFacingError("Choisissez d'abord une stratégie pour ce compte.")
    version = acc.strategy_version or s.current_version
    v = next((x for x in s.versions if x.version == version), None)
    if v is None:
        raise jobs.UserFacingError(f"Version {version} de la stratégie introuvable.")
    return v.definition


def universe_of(d: dict) -> list[str]:
    u = d.get("universe") or {}
    symbols = list(u.get("symbols") or [])
    if u.get("preset") in UNIVERSES:
        symbols = list(dict.fromkeys(UNIVERSES[u["preset"]]["symbols"] + symbols))
    return symbols


def positions(db: Session, acc: RealAccount) -> list[RealPosition]:
    return list(db.scalars(select(RealPosition).where(RealPosition.account_id == acc.id).order_by(RealPosition.symbol)).all())


def _refresh(db: Session, symbols: list[str], progress: Callable[[float, str], None] | None) -> list[str]:
    warnings = []
    for k, s in enumerate(symbols):
        if progress:
            progress(0.9 * k / len(symbols), f"Mise à jour des cours : {s} ({k + 1}/{len(symbols)})")
        warnings += ensure_fresh(db, [s], REVIEW_DATA_MAX_AGE_HOURS)
    return warnings


def review(db: Session, acc: RealAccount, trigger: str, force_full: bool = False,
           progress: Callable[[float, str], None] | None = None) -> OrderProposal:
    """Evaluate the account's strategy on its real holdings and store the resulting proposal."""
    d = definition(acc)
    strategy = build(acc.strategy.kind, d["parameters"])
    universe = universe_of(d)
    bench = d["benchmark"]
    held = positions(db, acc)
    symbols = list(dict.fromkeys(universe + [p.symbol for p in held]))
    warnings = _refresh(db, symbols + [bench], progress)
    if progress:
        progress(0.92, "Application de la stratégie")
    lead = timedelta(days=int(strategy.warmup_days() * 1.6) + 40)
    # The window reaches back from each symbol's own last close, so one lagging series (provider
    # outage, suspended stock) still gets its history; it is valued at its last known close.
    lasts = dict(db.execute(select(PriceBar.symbol, func.max(PriceBar.date)).where(PriceBar.symbol.in_(symbols + [bench]))
                            .group_by(PriceBar.symbol)).all())
    anchor = max(lasts.values(), default=date.today())
    close, _ = load_panel(db, symbols + [bench], min(lasts.values(), default=anchor) - lead, anchor)
    close, _, jumps = neutralise_jumps(close)
    for s, d_ in sorted(lasts.items()):
        if (anchor - d_).days > 5:
            warnings.append(f"Cours de {s} pas à jour (dernier le {d_.strftime('%d/%m/%Y')}) : il est valorisé à ce dernier cours.")
    if close.empty or bench not in close.columns:
        raise jobs.UserFacingError(f"Pas de données de marché récentes pour l'indice de référence {bench}.")
    prices = close[[s for s in symbols if s in close.columns]]
    as_of = prices.dropna(how="all").index[-1]
    paris = datetime.now(PARIS)
    if as_of.date() == paris.date() and paris.time() < SESSION_END:
        warnings.append("Séance en cours : les cours utilisés sont ceux du moment (différés de quelques minutes), pas des cours de clôture. "
                        "Les signaux peuvent encore changer d'ici la clôture.")
    last_full = pd.Timestamp(acc.last_full_on) if acc.last_full_on else None
    mode = "full" if force_full else due_mode(d["rebalance_frequency"], as_of, last_full)
    names = dict(db.execute(select(Instrument.symbol, Instrument.name).where(Instrument.symbol.in_(symbols + [bench]))).all())
    # Only corrections inside the strategy's look-back matter for today's signals.
    warnings += describe([j for j in jumps if j.date >= close.index[-1] - lead], names)
    risk = d.get("risk_model") or {}
    try:
        res = propose(
            strategy,
            LiveConfig(costs=CostModel(fee_pct=acc.fee_pct, fee_min=acc.fee_min, slippage_bps=0.0),
                       risk=RiskModel(**risk), fractional=acc.fractional, min_order_value=acc.min_order_value),
            prices, close[bench].dropna().rename(bench),
            {p.symbol: Holding(p.qty, p.avg_cost, p.locked) for p in held}, acc.cash,
            universe=[s for s in universe if s in close.columns], mode=mode,
            state=acc.strategy_state, last_targets=acc.last_targets, names=names,
        )
    except ValueError as exc:
        raise jobs.UserFacingError(str(exc)) from exc

    db.execute(update(OrderProposal).where(OrderProposal.account_id == acc.id, OrderProposal.status == "open")
               .values(status="superseded"))
    prop = OrderProposal(
        account_id=acc.id, as_of=res.as_of.date(), trigger=trigger, mode=res.mode, status="open" if res.orders else "closed",
        strategy_id=acc.strategy_id, strategy_version=acc.strategy_version or acc.strategy.current_version,
        value=res.value, cash=acc.cash, cash_after=res.cash_after, decisions=res.decisions, warnings=warnings + res.warnings,
        orders=[ProposedOrder(**o) for o in res.orders],
    )
    db.add(prop)
    if res.mode == "full":
        acc.strategy_state = {k: v for k, v in res.state.items() if not k.startswith("_")}
        acc.last_full_on = res.as_of.date()
        if res.targets is not None:
            acc.last_targets = res.targets
    acc.last_review_at = utcnow()
    db.flush()
    return prop


def summary_text(acc: RealAccount, prop: OrderProposal, names: dict[str, str]) -> str:
    s = get_settings()
    lines = [
        f"Compte « {acc.name} » — stratégie {acc.strategy.name if acc.strategy else '?'}",
        f"Calcul sur les derniers cours connus (séance du {prop.as_of.strftime('%d/%m/%Y')}).",
        "",
        f"{len(prop.orders)} ordre(s) proposé(s) :",
    ]
    for o in prop.orders:
        verb = "ACHETER" if o.side == "buy" else "VENDRE"
        qty = f"{o.qty:g}"
        lines.append(f"  • {verb} {qty} × {names.get(o.symbol, o.symbol)} ({o.symbol}) — environ {o.value:,.2f} € "
                     f"(cours indicatif {o.price:,.2f} €)".replace(",", " "))
        lines.append(f"    Pourquoi : {o.reason}")
    if prop.warnings:
        lines += ["", "À vérifier :"] + [f"  - {w}" for w in prop.warnings]
    lines += [
        "",
        f"Détail et explications : {s.public_url}/accounts/{acc.id}",
        "",
        "Ces propositions appliquent mécaniquement les règles de la stratégie que vous avez choisie. "
        "Elles ne constituent pas un conseil en investissement. Vérifiez chaque ordre avant de le passer.",
    ]
    return "\n".join(lines)


def notify(db: Session, acc: RealAccount, prop: OrderProposal) -> bool:
    owner = db.get(User, acc.owner_id)
    if owner is None or not prop.orders or not acc.notify_email or not mail_enabled():
        return False
    names = dict(db.execute(select(Instrument.symbol, Instrument.name).where(Instrument.symbol.in_([o.symbol for o in prop.orders]))).all())
    subject = f"My2cents · {len(prop.orders)} ordre(s) à passer sur « {acc.name} »"
    if send_mail(owner.email, subject, summary_text(acc, prop, names)):
        prop.emailed_at = utcnow()
        return True
    return False


# ---------------------------------------------------------------------------
# Ledger
# ---------------------------------------------------------------------------


def apply_fill(db: Session, acc: RealAccount, side: str, symbol: str, qty: float, price: float, fees: float,
               on: date, order_id: uuid.UUID | None = None, note: str = "") -> AccountMovement:
    """Record an executed buy or sell and update holdings and cash (average cost method)."""
    if qty <= 0 or price <= 0 or fees < 0:
        raise HTTPException(422, "Quantité et prix doivent être positifs, les frais positifs ou nuls.")
    pos = db.get(RealPosition, (acc.id, symbol))
    realized = None
    if side == "buy":
        cost = qty * price + fees
        if pos is None:
            pos = RealPosition(account_id=acc.id, symbol=symbol, qty=0.0, avg_cost=0.0, locked=False)
            db.add(pos)
        pos.avg_cost = (pos.avg_cost * pos.qty + cost) / (pos.qty + qty)
        pos.qty += qty
        amount = -cost
    else:
        if pos is None or pos.qty < qty - 1e-9:
            raise HTTPException(422, f"Vous ne détenez que {0 if pos is None else pos.qty:g} {symbol} : vente impossible.")
        amount = qty * price - fees
        realized = amount - pos.avg_cost * qty
        pos.qty -= qty
        if pos.qty <= 1e-9:
            db.delete(pos)
    acc.cash += amount
    mv = AccountMovement(account_id=acc.id, date=on, kind=side, symbol=symbol, qty=qty, price=price, fees=fees,
                         amount=amount, realized_pnl=realized, order_id=order_id, note=note)
    db.add(mv)
    acc.updated_at = utcnow()
    return mv


def close_if_done(db: Session, prop: OrderProposal) -> None:
    if prop.status == "open" and all(o.status != "pending" for o in prop.orders):
        prop.status = "closed"


# ---------------------------------------------------------------------------
# Worker
# ---------------------------------------------------------------------------


@jobs.handler("account_review")
def run_review_job(job: Job, report: jobs.Reporter) -> None:
    """payload: {"account_id": ..., "force_full": bool} for one account, or {"scheduled": true} for all."""
    with SessionLocal() as db:
        if job.payload.get("account_id"):
            ids = [uuid.UUID(job.payload["account_id"])]
        else:
            ids = list(db.scalars(select(RealAccount.id).where(
                RealAccount.auto_review.is_(True), RealAccount.archived.is_(False), RealAccount.strategy_id.is_not(None))).all())
        failures = []
        for k, aid in enumerate(ids):
            report(k / max(len(ids), 1), f"Compte {k + 1}/{len(ids)}", force=True)
            step = report if len(ids) == 1 else None
            acc = db.get(RealAccount, aid)
            if acc is None:
                continue
            trigger = "scheduled" if job.payload.get("scheduled") else "manual"
            try:
                prop = review(db, acc, trigger, force_full=bool(job.payload.get("force_full")), progress=step)
                emailed = notify(db, acc, prop) if trigger == "scheduled" else False
                audit.record(db, "account.review", actor=db.get(User, acc.owner_id), resource_type="real_account", resource_id=acc.id,
                             details={"proposal_id": str(prop.id), "orders": len(prop.orders), "mode": prop.mode,
                                      "trigger": trigger, "emailed": emailed})
                db.commit()
            except jobs.UserFacingError as exc:
                db.rollback()
                if len(ids) == 1:
                    raise
                failures.append(f"{aid}: {exc}")
        if failures:
            log.warning("account reviews partially failed", extra={"job_id": str(job.id), "failures": failures[:20]})


def schedule_evening_review(now: datetime | None = None) -> bool:
    """Queue the all-accounts review once per weekday, after the US close (and so after Europe's)."""
    now = now or datetime.now(timezone.utc)
    hour = get_settings().review_hour_utc
    if now.weekday() >= 5 or now.hour < hour:
        return False
    day = now.date().isoformat()
    with SessionLocal() as db:
        done = db.scalar(select(Job.id).where(Job.kind == "account_review", Job.payload["day"].astext == day).limit(1))
        if done:
            return False
        jobs.enqueue(db, "account_review", {"scheduled": True, "day": day}, message="Revue du soir des comptes réels")
        db.commit()
        return True
