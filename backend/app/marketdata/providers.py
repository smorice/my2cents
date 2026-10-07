"""Market data providers.

A provider only knows how to fetch daily bars for a symbol from one source and
return them in the normalised shape below. Persistence, freshness and history
are handled by `service.py`, so swapping or adding a source never touches the
backtesting engine.
"""

from __future__ import annotations

import math
import urllib.parse
from dataclasses import dataclass
from datetime import date, datetime, timezone
from typing import Protocol

import httpx


class DataError(RuntimeError):
    """The provider answered, but has no usable data for the request."""


@dataclass(frozen=True)
class Bar:
    date: date
    open: float
    high: float
    low: float
    close: float
    adj_close: float  # close adjusted for dividends and corporate actions
    volume: float


@dataclass(frozen=True)
class FetchResult:
    symbol: str
    name: str | None
    currency: str | None
    bars: list[Bar]


class MarketDataProvider(Protocol):
    name: str
    label: str
    description: str

    def fetch_daily(self, symbol: str) -> FetchResult:
        """Full daily history for `symbol`, oldest first."""
        ...


class YahooProvider:
    name = "yahoo"
    label = "Yahoo Finance"
    description = (
        "Source gratuite et non officielle : cours quotidiens, ajustés des dividendes et opérations sur titres. "
        "Limites de débit et conditions d'utilisation non garanties."
    )

    def fetch_daily(self, symbol: str) -> FetchResult:
        url = (
            f"https://query1.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(symbol)}"
            f"?period1=0&period2={int(datetime.now(timezone.utc).timestamp()) + 86400}"
            "&interval=1d&events=div%2Csplit&includeAdjustedClose=true"
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
            bars.append(Bar(
                date=datetime.fromtimestamp(t + offset, tz=timezone.utc).date(),
                open=float(o), high=float(h if h is not None else max(o, c)), low=float(lo if lo is not None else min(o, c)),
                close=float(c), adj_close=float(a), volume=float(q["volume"][k] or 0),
            ))
        return FetchResult(symbol, meta.get("longName") or meta.get("shortName"), meta.get("currency"), bars)


PROVIDERS: dict[str, MarketDataProvider] = {p.name: p for p in (YahooProvider(),)}
DEFAULT_PROVIDER = "yahoo"


def get_provider(name: str | None) -> MarketDataProvider:
    try:
        return PROVIDERS[name or DEFAULT_PROVIDER]
    except KeyError:
        raise DataError(f"Fournisseur de données inconnu : {name}") from None
