from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session, defer

from .. import audit
from ..db import get_db
from ..deps import require
from ..marketdata.catalog import UNIVERSES
from ..marketdata.providers import PROVIDERS, DataError
from ..marketdata.service import sync_symbol
from ..models import Backtest, Benchmark, Instrument, Portfolio, PriceBar, Strategy, User
from ..rbac import Perm
from ..schemas import InstrumentIn

router = APIRouter(tags=["market"])


def _inst(i: Instrument) -> dict:
    return {"symbol": i.symbol, "name": i.name, "kind": i.kind, "currency": i.currency, "sector": i.sector,
            "universes": i.universes, "first_date": i.first_date, "last_date": i.last_date,
            "last_synced_at": i.last_synced_at, "sync_error": i.sync_error, "provider": i.provider}


@router.get("/market/universes")
def universes(_: User = Depends(require(Perm.MARKET_READ))):
    return [{"key": k, **v} for k, v in UNIVERSES.items()]


@router.get("/market/benchmarks")
def benchmarks(_: User = Depends(require(Perm.MARKET_READ)), db: Session = Depends(get_db)):
    rows = db.execute(select(Benchmark, Instrument).join(Instrument, Instrument.symbol == Benchmark.symbol).order_by(Benchmark.sort_order)).all()
    return [{"symbol": b.symbol, "label": b.label, "description": b.description, "total_return": b.total_return,
             "currency": i.currency, "kind": i.kind, "first_date": i.first_date, "last_date": i.last_date,
             "last_synced_at": i.last_synced_at, "available": i.last_date is not None} for b, i in rows]


@router.get("/market/providers")
def providers(_: User = Depends(require(Perm.MARKET_READ))):
    return [{"name": p.name, "label": p.label, "description": p.description} for p in PROVIDERS.values()]


@router.get("/market/instruments")
def instruments(q: str | None = None, kind: str | None = None, _: User = Depends(require(Perm.MARKET_READ)), db: Session = Depends(get_db)):
    stmt = select(Instrument)
    if q:
        like = f"%{q.lower()}%"
        stmt = stmt.where(or_(func.lower(Instrument.symbol).like(like), func.lower(Instrument.name).like(like)))
    if kind:
        stmt = stmt.where(Instrument.kind == kind)
    return [_inst(i) for i in db.scalars(stmt.order_by(Instrument.kind, Instrument.name)).all()]


@router.post("/market/instruments", status_code=201)
def add_instrument(body: InstrumentIn, request: Request, user: User = Depends(require(Perm.STRATEGY_CREATE)), db: Session = Depends(get_db)):
    symbol = body.symbol.strip().upper()
    if not all(c.isalnum() or c in ".^-=" for c in symbol):
        raise HTTPException(422, "Symbole invalide")
    try:
        n = sync_symbol(db, symbol)
    except DataError as exc:
        raise HTTPException(404, str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, "Source de données indisponible, réessayez plus tard.") from exc
    audit.record(db, "market.instrument_add", actor=user, request=request, resource_type="instrument", resource_id=symbol, details={"bars": n})
    db.commit()
    return _inst(db.get(Instrument, symbol))


@router.post("/market/instruments/{symbol}/sync")
def resync(symbol: str, request: Request, user: User = Depends(require(Perm.MARKET_REFRESH)), db: Session = Depends(get_db)):
    try:
        n = sync_symbol(db, symbol.upper())
    except DataError as exc:
        raise HTTPException(404, str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, "Source de données indisponible, réessayez plus tard.") from exc
    audit.record(db, "market.sync", actor=user, request=request, resource_type="instrument", resource_id=symbol.upper(), details={"bars": n})
    db.commit()
    return _inst(db.get(Instrument, symbol.upper()))


@router.get("/market/instruments/{symbol}/prices")
def prices(symbol: str, days: int = 365 * 5, _: User = Depends(require(Perm.MARKET_READ)), db: Session = Depends(get_db)):
    since = date.today() - timedelta(days=min(days, 365 * 40))
    rows = db.execute(select(PriceBar.date, PriceBar.close, PriceBar.adj_close)
                      .where(PriceBar.symbol == symbol.upper(), PriceBar.date >= since).order_by(PriceBar.date)).all()
    return {"symbol": symbol.upper(), "dates": [r[0].isoformat() for r in rows], "close": [r[1] for r in rows], "adj_close": [r[2] for r in rows]}


def _perf(db: Session, symbol: str) -> dict | None:
    rows = db.execute(select(PriceBar.date, PriceBar.adj_close).where(PriceBar.symbol == symbol, PriceBar.date >= date.today() - timedelta(days=400))
                      .order_by(PriceBar.date)).all()
    if len(rows) < 2:
        return None
    last_d, last = rows[-1]

    def back(days: int) -> float | None:
        target = last_d - timedelta(days=days)
        prev = [v for d, v in rows if d <= target]
        return (last / prev[-1] - 1) if prev else None

    ytd_rows = [v for d, v in rows if d < date(last_d.year, 1, 1)]
    return {
        "date": last_d.isoformat(), "last": last, "day": last / rows[-2][1] - 1,
        "month": back(30), "ytd": (last / ytd_rows[-1] - 1) if ytd_rows else None, "year": back(365),
        "spark": [v for _, v in rows[-90:]],
    }


@router.get("/dashboard")
def dashboard(user: User = Depends(require(Perm.STRATEGY_READ)), db: Session = Depends(get_db)):
    recent = db.scalars(select(Backtest).options(defer(Backtest.results)).where(Backtest.owner_id == user.id)
                        .order_by(Backtest.created_at.desc()).limit(6)).unique().all()
    done = db.scalars(select(Backtest).options(defer(Backtest.results))
                      .where(Backtest.owner_id == user.id, Backtest.status == "done", Backtest.portfolio_id.is_(None))).unique().all()
    best = sorted([b for b in done if b.summary and b.summary["strategy"].get("sharpe") is not None],
                  key=lambda b: -b.summary["strategy"]["sharpe"])[:5]
    markets = []
    for sym in ("^FCHI", "^STOXX50E", "^GSPC", "CW8.PA"):
        inst = db.get(Instrument, sym)
        perf = _perf(db, sym)
        if inst and perf:
            markets.append({"symbol": sym, "name": inst.name, "currency": inst.currency, **perf})

    def brief(b: Backtest) -> dict:
        s = (b.summary or {}).get("strategy") or {}
        bm = (b.summary or {}).get("benchmark") or {}
        return {"id": str(b.id), "name": b.name, "status": b.status, "strategy_name": b.strategy.name, "strategy_kind": b.strategy.kind,
                "portfolio_id": str(b.portfolio_id) if b.portfolio_id else None, "created_at": b.created_at,
                "cagr": s.get("cagr"), "sharpe": s.get("sharpe"), "max_drawdown": s.get("max_drawdown"), "benchmark_cagr": bm.get("cagr")}

    return {
        "counts": {
            "strategies": db.scalar(select(func.count()).select_from(Strategy).where(Strategy.deleted_at.is_(None), Strategy.owner_id == user.id)),
            "templates": db.scalar(select(func.count()).select_from(Strategy).where(Strategy.is_template, Strategy.deleted_at.is_(None))),
            "backtests": len(done),
            "portfolios": db.scalar(select(func.count()).select_from(Portfolio).where(Portfolio.owner_id == user.id, Portfolio.archived.is_(False))),
        },
        "recent": [brief(b) for b in recent],
        "best": [brief(b) for b in best],
        "markets": markets,
    }
