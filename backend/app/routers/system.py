"""Administration of the platform's moving parts (jobs, errors, data providers, strategies),
plus the few endpoints that are not tied to one resource: own activity, all transactions,
and the public showcase used by the landing page."""

import threading
import time
import uuid
from datetime import timedelta

from dateutil.relativedelta import relativedelta
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .. import audit, jobs
from ..db import SessionLocal, get_db
from ..deps import current_user, require
from ..engine.backtester import BacktestConfig, Backtester, Contributions, CostModel
from ..engine.strategies.library import build
from ..marketdata.providers import PROVIDERS
from ..marketdata.service import load_panel
from ..models import (
    AppError, AuditEvent, Backtest, BacktestTransaction, Instrument, Job, MarketDataSync, Portfolio, Strategy, User, WorkerHeartbeat, utcnow,
)
from ..rbac import Perm
from ..schemas import AuditOut
from .jobs import job_out

router = APIRouter(tags=["system"])


def _page(total: int, page: int, size: int, items: list) -> dict:
    return {"items": items, "total": total, "page": page, "page_size": size, "pages": max((total + size - 1) // size, 1)}


# ----------------------------------------------------------------- admin overview


@router.get("/admin/overview")
def overview(_: User = Depends(require(Perm.SYSTEM_READ)), db: Session = Depends(get_db)):
    day = utcnow() - timedelta(days=1)
    week = utcnow() - timedelta(days=7)
    count = lambda stmt: db.scalar(select(func.count()).select_from(stmt.subquery()))  # noqa: E731
    jobs_by_status = dict(db.execute(select(Job.status, func.count()).group_by(Job.status)).all())
    durations = db.execute(select(Job.kind, func.avg(func.extract("epoch", Job.finished_at - Job.started_at)), func.count())
                           .where(Job.status == "completed", Job.finished_at > week).group_by(Job.kind)).all()
    per_day = db.execute(select(func.date_trunc("day", Backtest.created_at).label("d"), func.count())
                         .where(Backtest.created_at > utcnow() - timedelta(days=14)).group_by("d").order_by("d")).all()
    stale = db.scalar(select(func.min(Instrument.last_synced_at)).where(Instrument.last_synced_at.is_not(None)))
    workers = db.scalars(select(WorkerHeartbeat).where(WorkerHeartbeat.seen_at > utcnow() - timedelta(hours=1))
                         .order_by(WorkerHeartbeat.seen_at.desc())).all()
    return {
        "users": {"total": count(select(User.id)), "active": count(select(User.id).where(User.is_active)),
                  "new_7d": count(select(User.id).where(User.created_at > week))},
        "strategies": {"total": count(select(Strategy.id).where(Strategy.deleted_at.is_(None))),
                       "templates": count(select(Strategy.id).where(Strategy.is_template, Strategy.deleted_at.is_(None)))},
        "backtests": {"total": count(select(Backtest.id)), "last_24h": count(select(Backtest.id).where(Backtest.created_at > day)),
                      "per_day": [{"date": d.date().isoformat(), "count": n} for d, n in per_day]},
        "portfolios": count(select(Portfolio.id)),
        "jobs": {"by_status": jobs_by_status, "failed_24h": count(select(Job.id).where(Job.status == "failed", Job.finished_at > day)),
                 "avg_duration_s": {k: round(float(v or 0), 1) for k, v, _ in durations},
                 "last_heartbeat": workers[0].seen_at if workers else None,
                 "workers": [{"name": w.name, "started_at": w.started_at, "seen_at": w.seen_at, "concurrency": w.concurrency} for w in workers]},
        "errors": {"last_24h": count(select(AppError.id).where(AppError.occurred_at > day)),
                   "last_7d": count(select(AppError.id).where(AppError.occurred_at > week))},
        "audit": {"last_24h": count(select(AuditEvent.id).where(AuditEvent.occurred_at > day)),
                  "denied_24h": count(select(AuditEvent.id).where(AuditEvent.occurred_at > day, AuditEvent.outcome == "denied"))},
        "market": {"instruments": count(select(Instrument.symbol)),
                   "in_error": count(select(Instrument.symbol).where(Instrument.sync_error.is_not(None))),
                   "oldest_sync": stale},
    }


# ----------------------------------------------------------------- jobs


@router.get("/admin/jobs")
def list_jobs(
    status: str | None = None, kind: str | None = None,
    page: int = Query(1, ge=1), page_size: int = Query(50, ge=1, le=200),
    _: User = Depends(require(Perm.JOB_ADMIN)), db: Session = Depends(get_db),
):
    stmt = select(Job)
    if status:
        stmt = stmt.where(Job.status == status)
    if kind:
        stmt = stmt.where(Job.kind == kind)
    total = db.scalar(select(func.count()).select_from(stmt.subquery()))
    rows = db.scalars(stmt.order_by(Job.created_at.desc()).offset((page - 1) * page_size).limit(page_size)).all()
    owners = dict(db.execute(select(User.id, User.email).where(User.id.in_({j.owner_id for j in rows if j.owner_id}))).all())
    return _page(total, page, page_size, [{**job_out(j, admin=True), "owner_email": owners.get(j.owner_id)} for j in rows])


@router.post("/admin/jobs/{job_id}/retry")
def retry_job(job_id: uuid.UUID, request: Request, admin: User = Depends(require(Perm.JOB_ADMIN)), db: Session = Depends(get_db)):
    job = db.get(Job, job_id)
    if job is None:
        raise HTTPException(404, "Tâche introuvable")
    if job.status != "failed":
        raise HTTPException(409, "Seule une tâche en échec peut être relancée.")
    job.status, job.progress, job.message, job.user_error, job.error = "queued", 0.0, "Relancée par un administrateur", None, None
    job.started_at = job.finished_at = None
    if job.kind == "backtest":
        bt = db.get(Backtest, job.payload["backtest_id"])
        if bt is not None:
            bt.status, bt.error, bt.finished_at = "queued", None, None
    audit.record(db, "job.retry", actor=admin, request=request, resource_type="job", resource_id=job.id, details={"kind": job.kind})
    db.commit()
    return job_out(job, admin=True)


@router.post("/admin/jobs/{job_id}/cancel")
def cancel_job(job_id: uuid.UUID, request: Request, admin: User = Depends(require(Perm.JOB_ADMIN)), db: Session = Depends(get_db)):
    job = db.scalar(select(Job).where(Job.id == job_id).with_for_update())
    if job is None:
        raise HTTPException(404, "Tâche introuvable")
    if job.status != "queued":
        raise HTTPException(409, "Seule une tâche en file d'attente peut être annulée.")
    job.status, job.finished_at, job.message = "failed", utcnow(), "Annulée"
    job.user_error = job.error = "Annulée par un administrateur."
    if job.kind == "backtest":
        bt = db.get(Backtest, job.payload["backtest_id"])
        if bt is not None:
            bt.status, bt.error, bt.finished_at = "failed", job.user_error, utcnow()
    audit.record(db, "job.cancel", actor=admin, request=request, resource_type="job", resource_id=job.id, details={"kind": job.kind})
    db.commit()
    return job_out(job, admin=True)


# ----------------------------------------------------------------- errors


@router.get("/admin/errors")
def list_errors(
    source: str | None = None, q: str | None = None,
    page: int = Query(1, ge=1), page_size: int = Query(50, ge=1, le=200),
    _: User = Depends(require(Perm.SYSTEM_READ)), db: Session = Depends(get_db),
):
    stmt = select(AppError)
    if source:
        stmt = stmt.where(AppError.source == source)
    if q:
        like = f"%{q.lower()}%"
        stmt = stmt.where(func.lower(AppError.message).like(like) | func.lower(AppError.request_id).like(like) | func.lower(AppError.path).like(like))
    total = db.scalar(select(func.count()).select_from(stmt.subquery()))
    rows = db.scalars(stmt.order_by(AppError.id.desc()).offset((page - 1) * page_size).limit(page_size)).all()
    return _page(total, page, page_size, [
        {"id": e.id, "occurred_at": e.occurred_at, "request_id": e.request_id, "source": e.source, "method": e.method, "path": e.path,
         "user_id": str(e.user_id) if e.user_id else None, "error_type": e.error_type, "message": e.message, "traceback": e.traceback}
        for e in rows
    ])


# ----------------------------------------------------------------- data providers


@router.get("/admin/providers")
def providers(_: User = Depends(require(Perm.SYSTEM_READ)), db: Session = Depends(get_db)):
    syncs = db.scalars(select(MarketDataSync).order_by(MarketDataSync.id.desc()).limit(50)).all()
    insts = db.scalars(select(Instrument).order_by(Instrument.kind, Instrument.symbol)).all()
    running = db.scalar(select(Job.id).where(Job.kind == "market_sync", Job.status.in_(["queued", "running"])).limit(1))
    return {
        "providers": [{
            "name": p.name, "label": p.label, "description": p.description,
            "instruments": sum(1 for i in insts if i.provider == p.name),
            "in_error": sum(1 for i in insts if i.provider == p.name and i.sync_error),
        } for p in PROVIDERS.values()],
        "instruments": [{"symbol": i.symbol, "name": i.name, "kind": i.kind, "provider": i.provider, "first_date": i.first_date,
                         "last_date": i.last_date, "last_synced_at": i.last_synced_at, "sync_error": i.sync_error} for i in insts],
        "syncs": [{"id": s.id, "symbol": s.symbol, "provider": s.provider, "started_at": s.started_at, "finished_at": s.finished_at,
                   "status": s.status, "bars": s.bars, "first_date": s.first_date, "last_date": s.last_date, "error": s.error} for s in syncs],
        "sync_job": str(running) if running else None,
    }


@router.post("/admin/market/sync", status_code=202)
def trigger_sync(request: Request, symbols: list[str] | None = None, admin: User = Depends(require(Perm.MARKET_REFRESH)), db: Session = Depends(get_db)):
    if db.scalar(select(Job.id).where(Job.kind == "market_sync", Job.status.in_(["queued", "running"])).limit(1)):
        raise HTTPException(409, "Une synchronisation est déjà en cours.")
    job = jobs.enqueue(db, "market_sync", {"symbols": [s.upper() for s in symbols] if symbols else None}, owner_id=admin.id,
                       message="Synchronisation demandée")
    audit.record(db, "market.sync_all", actor=admin, request=request, resource_type="job", resource_id=job.id, details={"symbols": symbols})
    db.commit()
    return job_out(job, admin=True)


# ----------------------------------------------------------------- strategies (all users)


@router.get("/admin/strategies")
def all_strategies(_: User = Depends(require(Perm.SYSTEM_READ)), db: Session = Depends(get_db)):
    counts = dict(db.execute(select(Backtest.strategy_id, func.count()).group_by(Backtest.strategy_id)).all())
    rows = db.scalars(select(Strategy).order_by(Strategy.is_template.desc(), Strategy.updated_at.desc())).unique().all()
    return [{
        "id": str(s.id), "name": s.name, "kind": s.kind, "status": s.status, "is_template": s.is_template,
        "owner_email": s.owner.email if s.owner else None, "current_version": s.current_version,
        "deleted": s.deleted_at is not None, "updated_at": s.updated_at, "backtests": counts.get(s.id, 0),
    } for s in rows]


# ----------------------------------------------------------------- user-level views


@router.get("/audit/me")
def my_activity(
    page: int = Query(1, ge=1), page_size: int = Query(50, ge=1, le=200),
    user: User = Depends(current_user), db: Session = Depends(get_db),
):
    """The user's own audit trail (what they did, and access denials on their account)."""
    stmt = select(AuditEvent).where(AuditEvent.actor_id == user.id)
    total = db.scalar(select(func.count()).select_from(stmt.subquery()))
    rows = db.scalars(stmt.order_by(AuditEvent.id.desc()).offset((page - 1) * page_size).limit(page_size)).all()
    return _page(total, page, page_size, [AuditOut.model_validate(r) for r in rows])


@router.get("/transactions")
def all_transactions(
    backtest_id: uuid.UUID | None = None, symbol: str | None = None, side: str | None = None, portfolios_only: bool = False,
    page: int = Query(1, ge=1), page_size: int = Query(50, ge=1, le=500),
    user: User = Depends(require(Perm.BACKTEST_READ)), db: Session = Depends(get_db),
):
    """Simulated transactions across all of the user's backtests and portfolio simulations."""
    T = BacktestTransaction
    stmt = select(T, Backtest.name, Backtest.portfolio_id).join(Backtest, Backtest.id == T.backtest_id).where(Backtest.owner_id == user.id)
    if backtest_id:
        stmt = stmt.where(T.backtest_id == backtest_id)
    if portfolios_only:
        stmt = stmt.where(Backtest.portfolio_id.is_not(None))
    if symbol:
        stmt = stmt.where(T.symbol == symbol.upper())
    if side in ("buy", "sell"):
        stmt = stmt.where(T.side == side)
    total = db.scalar(select(func.count()).select_from(stmt.subquery()))
    rows = db.execute(stmt.order_by(T.date.desc(), T.seq.desc()).offset((page - 1) * page_size).limit(page_size)).all()
    sources = db.execute(select(Backtest.id, Backtest.name, Backtest.portfolio_id)
                         .where(Backtest.owner_id == user.id, Backtest.status == "done").order_by(Backtest.created_at.desc()).limit(200)).all()
    return {
        **_page(total, page, page_size, [{
            "backtest_id": str(t.backtest_id), "backtest_name": name, "portfolio_id": str(pid) if pid else None,
            "seq": t.seq, "date": t.date.isoformat(), "symbol": t.symbol, "side": t.side, "qty": t.qty, "price": t.price,
            "value": t.value, "fees": t.fees, "tax": t.tax, "realized_pnl": t.realized_pnl, "reason": t.reason, "decision_seq": t.decision_seq,
        } for t, name, pid in rows]),
        "sources": [{"id": str(i), "name": n, "portfolio": p is not None} for i, n, p in sources],
    }


# ----------------------------------------------------------------- public showcase (landing page)

_SHOWCASE: dict = {}
_SHOWCASE_LOCK = threading.Lock()
SHOWCASE_TTL = 6 * 3600


def _showcase() -> dict | None:
    """A real simulation on stored historical data: 10 years of a monthly plan into an
    MSCI World ETF, compared with the CAC 40 dividends reinvested."""
    asset, bench = "CW8.PA", "CAC.PA"
    with SessionLocal() as db:
        last = db.scalar(select(Instrument.last_date).where(Instrument.symbol == asset))
        if last is None:
            return None
        start = last - relativedelta(years=10)
        close, open_ = load_panel(db, [asset, bench], start - timedelta(days=10), last)
        if close.empty or bench not in close.columns or asset not in close.columns:
            return None
        names = dict(db.execute(select(Instrument.symbol, Instrument.name).where(Instrument.symbol.in_([asset, bench]))).all())
        synced = db.scalar(select(Instrument.last_synced_at).where(Instrument.symbol == asset))
    cfg = BacktestConfig(start=start, end=last, initial_capital=1000.0, universe=[asset], benchmark=bench, rebalance="never",
                         costs=CostModel(fee_pct=0.1, fee_min=0.0, slippage_bps=5.0),
                         contributions=Contributions(amount=200.0, frequency="monthly"))
    res = Backtester(build("buy_and_hold", {}), cfg, close[[asset]], open_[[asset]], close[bench].dropna(), open_[bench].dropna(), names).run()
    s = res["series"]
    step = max(len(s["dates"]) // 260, 1)  # ~weekly points are plenty for a hero chart
    keep = list(range(0, len(s["dates"]), step)) + [len(s["dates"]) - 1]
    return {
        "title": f"1 000 € puis 200 € par mois dans un ETF {names.get(asset, asset)}",
        "asset": names.get(asset, asset), "benchmark": names.get(bench, bench),
        "start": s["dates"][0], "end": s["dates"][-1], "data_as_of": synced,
        "summary": {k: res["summary"]["strategy"].get(k) for k in ("final_value", "total_invested", "net_profit", "irr", "cagr", "max_drawdown", "volatility")},
        "benchmark_summary": {k: res["summary"]["benchmark"].get(k) for k in ("final_value", "cagr", "max_drawdown")},
        "series": {k: [s[k][i] for i in keep] for k in ("dates", "equity", "invested", "benchmark_equity")},
        "assumptions": ["Cours réels ajustés des dividendes (Yahoo Finance).", "Frais de 0,1 % par ordre et slippage de 5 points de base.",
                        "Versements le premier jour de bourse de chaque mois, investis à l'ouverture suivante.",
                        "L'indice de comparaison reçoit exactement les mêmes versements."],
    }


@router.get("/public/showcase")
def showcase():
    with _SHOWCASE_LOCK:
        if not _SHOWCASE.get("data") or time.monotonic() - _SHOWCASE["at"] > SHOWCASE_TTL:
            _SHOWCASE.update(at=time.monotonic(), data=_showcase())  # a failed build is retried on the next call
        data = _SHOWCASE["data"]
    if data is None:
        raise HTTPException(503, "Données historiques en cours de chargement.")
    return data

