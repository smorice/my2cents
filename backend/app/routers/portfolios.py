import uuid
from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session, defer

from .. import audit, runner
from ..db import get_db
from ..deps import require
from ..models import Backtest, Portfolio, User, utcnow
from ..rbac import Perm
from ..schemas import BacktestIn, PortfolioIn, PortfolioPatch
from .strategies import get_visible

router = APIRouter(prefix="/portfolios", tags=["portfolios"])


def _own(db: Session, user: User, pid: uuid.UUID) -> Portfolio:
    p = db.get(Portfolio, pid)
    if p is None or p.owner_id != user.id:
        raise HTTPException(404, "Portefeuille introuvable")
    return p


def _snap(p: Portfolio) -> dict:
    return {"name": p.name, "description": p.description, "strategy_id": str(p.strategy_id) if p.strategy_id else None,
            "strategy_version": p.strategy_version, "settings": p.settings, "archived": p.archived}


def _latest(db: Session, pid: uuid.UUID) -> Backtest | None:
    return db.scalar(select(Backtest).options(defer(Backtest.results)).where(Backtest.portfolio_id == pid)
                     .order_by(Backtest.created_at.desc()).limit(1))


def _out(db: Session, p: Portfolio) -> dict:
    bt = _latest(db, p.id)
    return {
        **_snap(p), "id": str(p.id), "created_at": p.created_at, "updated_at": p.updated_at,
        "strategy_name": p.strategy.name if p.strategy else None,
        "strategy_kind": p.strategy.kind if p.strategy else None,
        "strategy_current_version": p.strategy.current_version if p.strategy else None,
        "latest_simulation": None if bt is None else {
            "id": str(bt.id), "status": bt.status, "created_at": bt.created_at, "error": bt.error,
            "summary": (bt.summary or {}).get("strategy"), "benchmark": (bt.summary or {}).get("benchmark"),
        },
    }


def _simulate(db: Session, user: User, p: Portfolio, request: Request) -> Backtest:
    strategy = get_visible(db, user, p.strategy_id)
    s = p.settings
    body = BacktestIn(
        strategy_id=strategy.id, version=p.strategy_version, name=f"Portefeuille · {p.name}",
        start=date.fromisoformat(s["start"]), end=date.fromisoformat(s["end"]) if s.get("end") else date.today(),
        initial_capital=s["initial_capital"], contributions=s["contributions"], tax_mode=s["tax_mode"], fractional=s["fractional"],
    )
    bt = runner.create_backtest(db, user, strategy, body, portfolio_id=p.id, request=request)
    return bt


@router.get("")
def list_portfolios(include_archived: bool = False, user: User = Depends(require(Perm.PORTFOLIO_READ)), db: Session = Depends(get_db)):
    stmt = select(Portfolio).where(Portfolio.owner_id == user.id)
    if not include_archived:
        stmt = stmt.where(Portfolio.archived.is_(False))
    return [_out(db, p) for p in db.scalars(stmt.order_by(Portfolio.updated_at.desc())).unique().all()]


@router.post("", status_code=201)
def create_portfolio(body: PortfolioIn, request: Request, user: User = Depends(require(Perm.PORTFOLIO_WRITE)), db: Session = Depends(get_db)):
    strategy = get_visible(db, user, body.strategy_id)
    p = Portfolio(owner_id=user.id, name=body.name.strip(), description=body.description, strategy_id=strategy.id,
                  strategy_version=body.strategy_version, settings=body.settings.model_dump(mode="json"))
    db.add(p)
    db.flush()
    audit.record(db, "portfolio.create", actor=user, request=request, resource_type="portfolio", resource_id=p.id, after=_snap(p))
    bt = _simulate(db, user, p, request)
    db.commit()
    runner.submit(bt.id)
    db.refresh(p)
    return _out(db, p)


@router.get("/{pid}")
def get_portfolio(pid: uuid.UUID, user: User = Depends(require(Perm.PORTFOLIO_READ)), db: Session = Depends(get_db)):
    p = _own(db, user, pid)
    out = _out(db, p)
    out["history"] = [
        {"id": str(b.id), "status": b.status, "created_at": b.created_at, "strategy_version": b.strategy_version,
         "summary": (b.summary or {}).get("strategy")}
        for b in db.scalars(select(Backtest).options(defer(Backtest.results)).where(Backtest.portfolio_id == p.id)
                            .order_by(Backtest.created_at.desc()).limit(20)).unique().all()
    ]
    return out


@router.patch("/{pid}")
def patch_portfolio(pid: uuid.UUID, body: PortfolioPatch, request: Request, user: User = Depends(require(Perm.PORTFOLIO_WRITE)), db: Session = Depends(get_db)):
    p = _own(db, user, pid)
    before = _snap(p)
    if body.strategy_id is not None:
        p.strategy_id = get_visible(db, user, body.strategy_id).id
        p.strategy_version = body.strategy_version
    elif "strategy_version" in body.model_fields_set:
        p.strategy_version = body.strategy_version
    for f in ("name", "description", "archived"):
        v = getattr(body, f)
        if v is not None:
            setattr(p, f, v.strip() if isinstance(v, str) and f == "name" else v)
    if body.settings is not None:
        p.settings = body.settings.model_dump(mode="json")
    p.updated_at = utcnow()
    after = _snap(p)
    changed_alloc = before["strategy_id"] != after["strategy_id"] or before["strategy_version"] != after["strategy_version"] or before["settings"] != after["settings"]
    audit.record(db, "portfolio.allocation_change" if changed_alloc else "portfolio.update", actor=user, request=request,
                 resource_type="portfolio", resource_id=p.id, before=before, after=after)
    bt = _simulate(db, user, p, request) if changed_alloc and not p.archived else None
    db.commit()
    if bt:
        runner.submit(bt.id)
    return _out(db, p)


@router.post("/{pid}/simulate", status_code=202)
def simulate(pid: uuid.UUID, request: Request, user: User = Depends(require(Perm.PORTFOLIO_WRITE, Perm.BACKTEST_RUN)), db: Session = Depends(get_db)):
    p = _own(db, user, pid)
    bt = _simulate(db, user, p, request)
    db.commit()
    runner.submit(bt.id)
    return {"id": str(bt.id)}


@router.delete("/{pid}", status_code=204)
def delete_portfolio(pid: uuid.UUID, request: Request, user: User = Depends(require(Perm.PORTFOLIO_WRITE)), db: Session = Depends(get_db)):
    p = _own(db, user, pid)
    if db.scalar(select(Backtest.id).where(Backtest.portfolio_id == p.id, Backtest.status.in_(["queued", "running"])).limit(1)):
        raise HTTPException(409, "Une simulation est en cours, réessayez dans un instant.")
    audit.record(db, "portfolio.delete", actor=user, request=request, resource_type="portfolio", resource_id=p.id, before=_snap(p))
    for b in db.scalars(select(Backtest).where(Backtest.portfolio_id == p.id)).unique().all():
        db.delete(b)
    db.delete(p)
    db.commit()
