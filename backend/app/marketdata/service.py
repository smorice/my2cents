"""Market data service: the only place that talks to providers and stores bars.

Every stored bar records its source and fetch time, and every synchronisation
attempt is logged in `market_data_syncs`, so the data behind a backtest is
always dated and attributable.
"""

from __future__ import annotations

import logging
from dataclasses import asdict
from datetime import date, timedelta

import pandas as pd
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from ..models import Benchmark, Instrument, MarketDataSync, PriceBar, utcnow
from .catalog import BENCHMARKS, CAC40, ETFS, INDICES, SBF120_EXTRA
from .providers import DataError, get_provider

log = logging.getLogger(__name__)

__all__ = ["DataError", "seed_instruments", "sync_symbol", "ensure_fresh", "load_panel", "default_symbols"]


def default_symbols() -> list[str]:
    return list(INDICES) + list(ETFS) + list(CAC40) + list(SBF120_EXTRA)


def seed_instruments(db: Session) -> None:
    rows = []
    for s, (name, sector) in CAC40.items():
        rows.append(dict(symbol=s, name=name, kind="equity", currency="EUR", sector=sector, universes=["cac40", "sbf120"]))
    for s, (name, sector) in SBF120_EXTRA.items():
        rows.append(dict(symbol=s, name=name, kind="equity", currency="EUR", sector=sector, universes=["sbf120", "mid60"]))
    for s, name in ETFS.items():
        rows.append(dict(symbol=s, name=name, kind="etf", currency="EUR", sector="ETF", universes=["etf_pea"]))
    for s, (name, cur) in INDICES.items():
        rows.append(dict(symbol=s, name=name, kind="index", currency=cur, sector=None, universes=["benchmark"]))
    for r in rows:
        stmt = insert(Instrument).values(**r).on_conflict_do_update(
            index_elements=[Instrument.symbol],
            set_={"name": r["name"], "kind": r["kind"], "sector": r["sector"], "universes": r["universes"]},
        )
        db.execute(stmt)
    db.flush()
    for order, (symbol, label, desc, total_return) in enumerate(BENCHMARKS):
        stmt = insert(Benchmark).values(symbol=symbol, label=label, description=desc, total_return=total_return, sort_order=order)
        db.execute(stmt.on_conflict_do_update(
            index_elements=[Benchmark.symbol],
            set_={"label": label, "description": desc, "total_return": total_return, "sort_order": order},
        ))
    db.commit()


def sync_symbol(db: Session, symbol: str) -> int:
    """Download the full history of `symbol` from its provider and upsert it.

    Adjusted closes are rewritten by providers after every dividend, so a refresh
    replaces the whole history rather than appending."""
    inst = db.get(Instrument, symbol)
    if inst is None:
        inst = Instrument(symbol=symbol, name=symbol, kind="equity", universes=["custom"])
        db.add(inst)
        db.flush()
    provider = get_provider(inst.provider)
    run = MarketDataSync(symbol=symbol, provider=provider.name, status="failure")
    try:
        res = provider.fetch_daily(symbol)
        if not res.bars:
            raise DataError(f"Aucune cotation pour {symbol}")
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        inst = db.get(Instrument, symbol)
        if inst is not None:
            inst.sync_error = str(exc)[:500]
            inst.last_synced_at = utcnow()
        run.error, run.finished_at = str(exc)[:1000], utcnow()
        db.add(run)
        db.commit()
        raise
    now = utcnow()
    if inst.name == symbol and res.name:
        inst.name = res.name
    inst.currency = res.currency or inst.currency
    rows = [{**asdict(b), "symbol": symbol, "source": provider.name, "fetched_at": now} for b in res.bars]
    for chunk in range(0, len(rows), 2000):
        stmt = insert(PriceBar).values(rows[chunk : chunk + 2000])
        stmt = stmt.on_conflict_do_update(
            index_elements=[PriceBar.symbol, PriceBar.date],
            set_={c: stmt.excluded[c] for c in ("open", "high", "low", "close", "adj_close", "volume", "source", "fetched_at")},
        )
        db.execute(stmt)
    inst.first_date, inst.last_date = res.bars[0].date, res.bars[-1].date
    inst.last_synced_at, inst.sync_error = now, None
    run.status, run.bars, run.finished_at = "success", len(rows), utcnow()
    run.first_date, run.last_date = inst.first_date, inst.last_date
    db.add(run)
    db.commit()
    return len(rows)


def ensure_fresh(db: Session, symbols: list[str], max_age_hours: int) -> list[str]:
    """Refresh stale symbols; returns warnings for symbols that could not be refreshed."""
    warnings = []
    limit = utcnow() - timedelta(hours=max_age_hours)
    for s in symbols:
        inst = db.get(Instrument, s)
        if inst is None or inst.last_synced_at is None or inst.last_synced_at < limit or inst.last_date is None:
            try:
                sync_symbol(db, s)
            except Exception as exc:  # noqa: BLE001
                log.warning("sync %s failed: %s", s, exc)
                has_data = db.scalar(select(PriceBar.date).where(PriceBar.symbol == s).limit(1))
                warnings.append(
                    f"{s} : rafraîchissement impossible ({exc})" + ("" if has_data else " — symbole exclu.")
                )
    return warnings


def load_panel(db: Session, symbols: list[str], start: date, end: date) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Adjusted close and adjusted open panels (dates x symbols)."""
    rows = db.execute(
        select(PriceBar.symbol, PriceBar.date, PriceBar.open, PriceBar.close, PriceBar.adj_close)
        .where(PriceBar.symbol.in_(symbols), PriceBar.date >= start, PriceBar.date <= end)
        .order_by(PriceBar.date)
    ).all()
    if not rows:
        return pd.DataFrame(), pd.DataFrame()
    df = pd.DataFrame(rows, columns=["symbol", "date", "open", "close", "adj"])
    df["date"] = pd.to_datetime(df["date"])
    # Apply the close's adjustment factor to the open so both are on the same basis.
    df["adj_open"] = df["open"] * df["adj"] / df["close"]
    close = df.pivot(index="date", columns="symbol", values="adj").sort_index()
    open_ = df.pivot(index="date", columns="symbol", values="adj_open").sort_index()
    return close, open_
