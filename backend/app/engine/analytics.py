"""Post-simulation analytics computed from a backtest's stored daily series.

Pure functions (no I/O): the API slices stored series by period and derives
rolling risk indicators without re-running the simulation.
"""

from __future__ import annotations

import math
from datetime import date

import numpy as np
import pandas as pd
from dateutil.relativedelta import relativedelta

from .metrics import TRADING_DAYS, compute_metrics

PERIODS = ("1M", "3M", "6M", "YTD", "1Y", "3Y", "5Y", "10Y", "MAX")


def period_start(period: str, first: date, last: date) -> date:
    """Start of a display period ending at `last`, clamped to the available history."""
    months = {"1M": 1, "3M": 3, "6M": 6, "1Y": 12, "3Y": 36, "5Y": 60, "10Y": 120}
    if period == "MAX":
        start = first
    elif period == "YTD":
        start = date(last.year, 1, 1)
    elif period in months:
        start = last - relativedelta(months=months[period])
    else:
        raise ValueError(f"Période inconnue : {period}")
    return max(start, first)


def downsample_index(n: int, target: int = 600) -> list[int]:
    """Evenly spaced indices (always keeping the first and last point) for display series."""
    if n <= target:
        return list(range(n))
    step = n / target
    idx = sorted({int(i * step) for i in range(target)} | {n - 1})
    return idx


def _frame(series: dict) -> pd.DataFrame:
    idx = pd.DatetimeIndex(pd.to_datetime(series["dates"]))
    df = pd.DataFrame({"equity": series["equity"], "invested": series["invested"], "bench": series["benchmark_equity"]}, index=idx, dtype=float)
    df["flow"] = df["invested"].diff().fillna(0.0)
    return df


def _twr_returns(v: pd.Series, flows: pd.Series) -> pd.Series:
    prev = v.shift(1)
    out = (v - flows) / prev.where(prev > 0) - 1
    return out.replace([np.inf, -np.inf], np.nan).fillna(0.0)


def _clean(xs) -> list[float | None]:
    return [None if x is None or not math.isfinite(x) else round(float(x), 6) for x in xs]


def window(series: dict, start: date, end: date | None = None, rf_pct: float = 2.0) -> dict | None:
    """Metrics and base-100 curves of a backtest restricted to [start, end]."""
    df = _frame(series)
    df = df[(df.index >= pd.Timestamp(start)) & (df.index <= pd.Timestamp(end or df.index[-1]))]
    if len(df) < 2:
        return None
    flows = df["flow"].copy()
    flows.iloc[0] = 0.0  # the window opens on the value already invested
    ret, bret = _twr_returns(df["equity"], flows), _twr_returns(df["bench"], flows)
    rf = rf_pct / 100
    return {
        "start": df.index[0].date().isoformat(), "end": df.index[-1].date().isoformat(),
        "dates": [d.date().isoformat() for d in df.index],
        "strategy": _clean((1 + ret).cumprod() * 100), "benchmark": _clean((1 + bret).cumprod() * 100),
        "metrics": compute_metrics(df["equity"], flows, ret, bret, rf),
        "benchmark_metrics": compute_metrics(df["bench"], flows, bret, None, rf),
        "gain": float(df["equity"].iloc[-1] - df["equity"].iloc[0] - flows.sum()),
    }


def rolling(series: dict, days: int = 126, rf_pct: float = 2.0) -> dict:
    """Rolling volatility / Sharpe, relative performance and value decomposition."""
    df = _frame(series)
    ret, bret = _twr_returns(df["equity"], df["flow"]), _twr_returns(df["bench"], df["flow"])
    rf_daily = (1 + rf_pct / 100) ** (1 / TRADING_DAYS) - 1

    def vol(r: pd.Series) -> pd.Series:
        return r.rolling(days).std(ddof=1) * math.sqrt(TRADING_DAYS)

    def sharpe(r: pd.Series) -> pd.Series:
        sd = r.rolling(days).std(ddof=1)
        return ((r - rf_daily).rolling(days).mean() / sd.where(sd > 0)) * math.sqrt(TRADING_DAYS)

    twr, btwr = (1 + ret).cumprod(), (1 + bret).cumprod()
    return {
        "window_days": days,
        "dates": [d.date().isoformat() for d in df.index],
        "volatility": _clean(vol(ret)), "benchmark_volatility": _clean(vol(bret)),
        "sharpe": _clean(sharpe(ret)), "benchmark_sharpe": _clean(sharpe(bret)),
        # > 0 when the strategy is ahead of the benchmark since the start (ratio of base-100 curves)
        "relative": _clean(twr / btwr - 1),
        "invested": _clean(df["invested"]), "gains": _clean(df["equity"] - df["invested"]),
    }
