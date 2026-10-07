"""Market data: Yahoo Finance daily bars cached in Postgres."""

from __future__ import annotations

import logging
import math
import urllib.parse
from datetime import date, datetime, timedelta, timezone

import httpx
import pandas as pd
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from ..models import Instrument, PriceBar, utcnow

log = logging.getLogger(__name__)

# Indicative recent CAC 40 composition. Using today's members over the past is a
# survivorship bias, which the app states explicitly in every backtest's assumptions.
CAC40 = {
    "AC.PA": ("Accor", "Consommation"), "AI.PA": ("Air Liquide", "Matériaux"), "AIR.PA": ("Airbus", "Industrie"),
    "MT.AS": ("ArcelorMittal", "Matériaux"), "CS.PA": ("AXA", "Finance"), "BNP.PA": ("BNP Paribas", "Finance"),
    "EN.PA": ("Bouygues", "Industrie"), "BVI.PA": ("Bureau Veritas", "Industrie"), "CAP.PA": ("Capgemini", "Technologie"),
    "CA.PA": ("Carrefour", "Consommation de base"), "ACA.PA": ("Crédit Agricole", "Finance"),
    "BN.PA": ("Danone", "Consommation de base"), "DSY.PA": ("Dassault Systèmes", "Technologie"),
    "EDEN.PA": ("Edenred", "Industrie"), "ENGI.PA": ("Engie", "Services publics"),
    "EL.PA": ("EssilorLuxottica", "Santé"), "ERF.PA": ("Eurofins Scientific", "Santé"),
    "RMS.PA": ("Hermès", "Luxe"), "KER.PA": ("Kering", "Luxe"), "OR.PA": ("L'Oréal", "Consommation de base"),
    "LR.PA": ("Legrand", "Industrie"), "MC.PA": ("LVMH", "Luxe"), "ML.PA": ("Michelin", "Automobile"),
    "ORA.PA": ("Orange", "Télécoms"), "RI.PA": ("Pernod Ricard", "Consommation de base"),
    "PUB.PA": ("Publicis", "Médias"), "RNO.PA": ("Renault", "Automobile"), "SAF.PA": ("Safran", "Industrie"),
    "SGO.PA": ("Saint-Gobain", "Industrie"), "SAN.PA": ("Sanofi", "Santé"), "SU.PA": ("Schneider Electric", "Industrie"),
    "GLE.PA": ("Société Générale", "Finance"), "STLAP.PA": ("Stellantis", "Automobile"),
    "STMPA.PA": ("STMicroelectronics", "Technologie"), "TEP.PA": ("Teleperformance", "Industrie"),
    "HO.PA": ("Thales", "Industrie"), "TTE.PA": ("TotalEnergies", "Énergie"),
    "URW.PA": ("Unibail-Rodamco-Westfield", "Immobilier"), "VIE.PA": ("Veolia", "Services publics"),
    "DG.PA": ("Vinci", "Industrie"),
}

ETFS = {
    "CW8.PA": "Amundi MSCI World (EUR)",
    "ESE.PA": "BNP Paribas Easy S&P 500 (EUR)",
    "PUST.PA": "Amundi PEA Nasdaq-100",
    "CAC.PA": "CAC 40 dividendes réinvestis (ETF Amundi)",
    "C40.PA": "Amundi CAC 40 ESG (Acc)",
    "PAEEM.PA": "Amundi PEA MSCI Emerging",
}

INDICES = {
    "^FCHI": ("CAC 40", "EUR"),
    "^SBF120": ("SBF 120", "EUR"),
    "^STOXX50E": ("Euro Stoxx 50", "EUR"),
    "^GSPC": ("S&P 500", "USD"),
    "^NDX": ("Nasdaq-100", "USD"),
}

UNIVERSES = {
    "cac40": {"label": "CAC 40 (composition récente)", "symbols": list(CAC40)},
    "etf_pea": {"label": "ETF éligibles PEA / européens", "symbols": list(ETFS)},
}


def seed_instruments(db: Session) -> None:
    rows = []
    for s, (name, sector) in CAC40.items():
        rows.append(dict(symbol=s, name=name, kind="equity", currency="EUR", sector=sector, universes=["cac40"]))
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
    db.commit()


class DataError(RuntimeError):
    pass


def fetch_yahoo(symbol: str, since: date | None = None) -> tuple[dict, list[dict]]:
    p1 = int(datetime.combine(since, datetime.min.time(), tzinfo=timezone.utc).timestamp()) if since else 0
    p2 = int(datetime.now(timezone.utc).timestamp()) + 86400
    url = (
        f"https://query1.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(symbol)}"
        f"?period1={p1}&period2={p2}&interval=1d&events=div%2Csplit&includeAdjustedClose=true"
    )
    r = httpx.get(url, headers={"User-Agent": "Mozilla/5.0 (My2cents research app)"}, timeout=30)
    if r.status_code == 404:
        raise DataError(f"Symbole inconnu : {symbol}")
    r.raise_for_status()
    chart = r.json().get("chart", {})
    if chart.get("error") or not chart.get("result"):
        raise DataError(f"Pas de données pour {symbol}")
    res = chart["result"][0]
    meta = res.get("meta", {})
    ts = res.get("timestamp") or []
    q = res["indicators"]["quote"][0]
    adj = (res["indicators"].get("adjclose") or [{}])[0].get("adjclose") or q.get("close")
    offset = int(meta.get("gmtoffset") or 0)
    bars = []
    for k, t in enumerate(ts):
        o, h, lo, c, a = q["open"][k], q["high"][k], q["low"][k], q["close"][k], adj[k]
        if c is None or a is None or any(isinstance(x, float) and math.isnan(x) for x in (c, a)) or c <= 0:
            continue
        o = o if o not in (None, 0) else c
        bars.append({
            "symbol": symbol,
            "date": datetime.fromtimestamp(t + offset, tz=timezone.utc).date(),
            "open": float(o), "high": float(h if h is not None else max(o, c)), "low": float(lo if lo is not None else min(o, c)),
            "close": float(c), "adj_close": float(a), "volume": float(q["volume"][k] or 0),
        })
    return meta, bars


def sync_symbol(db: Session, symbol: str, full: bool = False) -> int:
    inst = db.get(Instrument, symbol)
    if inst is None:
        inst = Instrument(symbol=symbol, name=symbol, kind="equity", universes=["custom"])
        db.add(inst)
        db.flush()
    # Adjusted closes are rewritten by the provider after every dividend, so a
    # refresh re-downloads the whole history rather than appending.
    try:
        meta, bars = fetch_yahoo(symbol)
    except Exception as exc:  # noqa: BLE001
        inst.sync_error = str(exc)[:500]
        inst.last_synced_at = utcnow()
        db.commit()
        raise
    if not bars:
        raise DataError(f"Aucune cotation pour {symbol}")
    if inst.name == symbol:
        inst.name = meta.get("longName") or meta.get("shortName") or symbol
    inst.currency = meta.get("currency") or inst.currency
    for chunk in range(0, len(bars), 2000):
        part = bars[chunk : chunk + 2000]
        stmt = insert(PriceBar).values(part)
        stmt = stmt.on_conflict_do_update(
            index_elements=[PriceBar.symbol, PriceBar.date],
            set_={c: stmt.excluded[c] for c in ("open", "high", "low", "close", "adj_close", "volume")},
        )
        db.execute(stmt)
    inst.first_date, inst.last_date = bars[0]["date"], bars[-1]["date"]
    inst.last_synced_at = utcnow()
    inst.sync_error = None
    db.commit()
    return len(bars)


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
                db.rollback()
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
