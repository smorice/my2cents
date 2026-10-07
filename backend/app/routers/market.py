import time
import uuid
from datetime import date, timedelta

import pandas as pd
from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session, defer

from .. import audit
from ..db import get_db
from ..deps import require
from ..engine import analytics
from ..marketdata.catalog import UNIVERSES
from ..marketdata.providers import DEFAULT_PROVIDER, PROVIDERS, DataError
from ..marketdata.quality import find_jumps
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


# Paris first (PEA, euros), then the other euro-area venues; anything else after.
# Exchange names come localised (the search runs in French).
_EXCHANGE_RANK = {"Paris": 0, "Amsterdam": 1, "Bruxelles": 1, "Milan": 1, "XETRA": 1, "Madrid": 1, "Lisbonne": 1, "Dublin": 1}
_SEARCH_CACHE: dict[str, tuple[float, list]] = {}
_SEARCH_TTL = 600


def _remote_search(q: str) -> list:
    key = q.lower()
    hit = _SEARCH_CACHE.get(key)
    if hit and time.monotonic() - hit[0] < _SEARCH_TTL:
        return hit[1]
    res = PROVIDERS[DEFAULT_PROVIDER].search(q)
    if len(_SEARCH_CACHE) > 500:
        _SEARCH_CACHE.clear()
    _SEARCH_CACHE[key] = (time.monotonic(), res)
    return res


@router.get("/market/search")
def search(q: str, _: User = Depends(require(Perm.MARKET_READ)), db: Session = Depends(get_db)):
    """Find instruments by name or ticker: the local catalogue, then the data provider's listings.
    A provider hit is added to the catalogue (and its history downloaded) when picked."""
    q = q.strip()[:60]
    if len(q) < 2:
        return {"items": [], "remote_error": None}
    like = f"%{q.lower()}%"
    local = db.scalars(select(Instrument).where(or_(func.lower(Instrument.symbol).like(like), func.lower(Instrument.name).like(like)))
                       .order_by(Instrument.name).limit(8)).all()
    items = [{"symbol": i.symbol, "name": i.name, "kind": i.kind, "exchange": None, "in_catalog": True} for i in local]
    seen = {i.symbol for i in local}
    remote_error = None
    try:
        hits = sorted(_remote_search(q), key=lambda h: _EXCHANGE_RANK.get(h.exchange, 2))
    except Exception:  # noqa: BLE001 - provider down or rate limited: the catalogue still answers
        hits, remote_error = [], "Recherche élargie indisponible pour le moment : seuls les titres déjà au catalogue sont proposés."
    in_db = set(db.scalars(select(Instrument.symbol).where(Instrument.symbol.in_([h.symbol for h in hits]))).all()) if hits else set()
    for h in hits:
        if h.symbol not in seen and len(items) < 15:
            seen.add(h.symbol)
            items.append({"symbol": h.symbol, "name": h.name, "kind": h.kind, "exchange": h.exchange, "in_catalog": h.symbol in in_db})
    return {"items": items, "remote_error": remote_error}


@router.post("/market/instruments", status_code=201)
def add_instrument(body: InstrumentIn, request: Request, user: User = Depends(require(Perm.STRATEGY_CREATE)), db: Session = Depends(get_db)):
    symbol = body.symbol.strip().upper()
    if not all(c.isalnum() or c in ".^-=" for c in symbol):
        raise HTTPException(422, "Symbole invalide")
    existed = db.get(Instrument, symbol) is not None
    try:
        n = sync_symbol(db, symbol)
    except DataError as exc:
        raise HTTPException(404, str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, "Source de données indisponible, réessayez plus tard.") from exc
    if body.kind and not existed:
        db.get(Instrument, symbol).kind = body.kind
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
    adj = pd.Series([r[2] for r in rows], index=pd.to_datetime([r[0] for r in rows]), dtype=float)
    return {"symbol": symbol.upper(), "dates": [r[0].isoformat() for r in rows], "close": [r[1] for r in rows], "adj_close": [r[2] for r in rows],
            # Suspect one-day jumps of the adjusted series, neutralised in simulations (see marketdata.quality)
            "anomalies": [{"date": d.date().isoformat(), "change": x} for d, x in find_jumps(adj)] if rows else []}


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


_PERF_CACHE: dict[tuple, dict] = {}


@router.get("/dashboard/performance")
def dashboard_performance(
    period: str = "MAX", focus: uuid.UUID | None = None,
    user: User = Depends(require(Perm.BACKTEST_READ)), db: Session = Depends(get_db),
):
    """« Comment mes stratégies auraient-elles performé ? » — the latest finished backtest of each
    strategy, rebased to 100 over the chosen period, with the focus backtest's full metrics."""
    from .backtests import win_rate

    if period not in analytics.PERIODS:
        raise HTTPException(422, "Période inconnue")
    # Series are only loaded (lazily) for the backtests actually shown.
    done = db.scalars(select(Backtest).options(defer(Backtest.results))
                      .where(Backtest.owner_id == user.id, Backtest.status == "done", Backtest.portfolio_id.is_(None))
                      .order_by(Backtest.finished_at.desc()).limit(60)).unique().all()
    latest: dict = {}
    for b in done:
        latest.setdefault(b.strategy_id, b)
    picked = list(latest.values())[:6]
    if focus and not any(b.id == focus for b in picked):
        extra = next((b for b in done if b.id == focus), None)
        if extra:
            picked = [extra] + picked[:5]
    if not picked:
        return {"period": period, "items": [], "focus": None}
    focus_bt = next((b for b in picked if b.id == focus), picked[0])
    # Finished backtests never change: the computed view is cached on their ids and finish times.
    key = (user.id, period, focus_bt.id, tuple((b.id, b.finished_at) for b in picked))
    hit = _PERF_CACHE.get(key)
    if hit is not None:
        return hit
    last = max(date.fromisoformat(b.results["series"]["dates"][-1]) for b in picked)
    first = min(date.fromisoformat(b.results["series"]["dates"][0]) for b in picked)
    start = analytics.period_start(period, first, last)
    items = []
    for b in picked:
        w = analytics.window(b.results["series"], start, last, b.config.get("risk_free_pct", 2.0))
        if w is None:
            continue
        names = b.results.get("names", {})
        keep = analytics.downsample_index(len(w["dates"]))
        items.append({
            "id": str(b.id), "name": b.name, "strategy_name": b.strategy.name, "strategy_id": str(b.strategy_id),
            "benchmark": b.config["benchmark"], "benchmark_name": names.get(b.config["benchmark"], b.config["benchmark"]),
            "dates": [w["dates"][i] for i in keep], "values": [w["strategy"][i] for i in keep],
            "benchmark_values": [w["benchmark"][i] for i in keep],
            "metrics": w["metrics"], "benchmark_metrics": w["benchmark_metrics"], "start": w["start"], "end": w["end"],
            **(win_rate(db, b.id) if b.id == focus_bt.id else {}),
        })
    out = {"period": period, "start": start.isoformat(), "end": last.isoformat(), "items": items,
           "focus": str(focus_bt.id) if any(i["id"] == str(focus_bt.id) for i in items) else (items[0]["id"] if items else None)}
    if len(_PERF_CACHE) > 500:
        _PERF_CACHE.clear()
    _PERF_CACHE[key] = out
    return out


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
