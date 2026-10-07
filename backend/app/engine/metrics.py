from __future__ import annotations

import math

import numpy as np
import pandas as pd

TRADING_DAYS = 252


def drawdown_series(index: pd.Series) -> pd.Series:
    return index / index.cummax() - 1


def _xirr(dates: list[pd.Timestamp], amounts: list[float]) -> float | None:
    """Money-weighted annual return (solves NPV = 0 by bisection)."""
    if len(amounts) < 2 or not any(a > 0 for a in amounts) or not any(a < 0 for a in amounts):
        return None
    t0 = dates[0]
    years = np.array([(d - t0).days / 365.25 for d in dates])
    cf = np.array(amounts)

    def npv(rate: float) -> float:
        return float(np.sum(cf / (1 + rate) ** years))

    lo, hi = -0.99, 10.0
    f_lo, f_hi = npv(lo), npv(hi)
    if f_lo * f_hi > 0:
        return None
    for _ in range(200):
        mid = (lo + hi) / 2
        f_mid = npv(mid)
        if abs(f_mid) < 1e-7:
            break
        if f_lo * f_mid < 0:
            hi, f_hi = mid, f_mid
        else:
            lo, f_lo = mid, f_mid
    return mid


def _finite(x: float | None) -> float | None:
    if x is None:
        return None
    x = float(x)
    return x if math.isfinite(x) else None


def compute_metrics(
    equity: pd.Series, flows: pd.Series, ret: pd.Series, bench_ret: pd.Series | None, rf: float
) -> dict:
    twr = (1 + ret).cumprod()
    years = max((equity.index[-1] - equity.index[0]).days / 365.25, 1 / 365.25)
    total = float(twr.iloc[-1] - 1)
    cagr = (1 + total) ** (1 / years) - 1 if total > -1 else -1.0
    daily = ret.iloc[1:]
    vol = float(daily.std(ddof=1) * math.sqrt(TRADING_DAYS)) if len(daily) > 2 else None
    rf_daily = (1 + rf) ** (1 / TRADING_DAYS) - 1
    excess = daily - rf_daily
    sharpe = float(excess.mean() / daily.std(ddof=1) * math.sqrt(TRADING_DAYS)) if vol else None
    downside = daily[daily < 0]
    dd_dev = float(np.sqrt((downside**2).sum() / max(len(daily), 1)) * math.sqrt(TRADING_DAYS))
    sortino = float(excess.mean() * TRADING_DAYS / dd_dev) if dd_dev > 0 else None

    dd = drawdown_series(twr)
    mdd = float(dd.min())
    # Longest time spent under a previous peak (calendar days)
    longest, start = 0, None
    for d, v in dd.items():
        if v < 0 and start is None:
            start = d
        elif v >= 0 and start is not None:
            longest = max(longest, (d - start).days)
            start = None
    if start is not None:
        longest = max(longest, (dd.index[-1] - start).days)

    monthly = (1 + ret).resample("ME").prod() - 1
    out = {
        "total_return": total,
        "cagr": cagr,
        "volatility": vol,
        "sharpe": sharpe,
        "sortino": sortino,
        "max_drawdown": mdd,
        "max_drawdown_days": longest,
        "calmar": (cagr / abs(mdd)) if mdd < 0 else None,
        "positive_months": float((monthly > 0).mean()) if len(monthly) else None,
        "best_month": float(monthly.max()) if len(monthly) else None,
        "worst_month": float(monthly.min()) if len(monthly) else None,
        "years": years,
    }

    # Money-weighted return: initial value out, contributions out, final value back in.
    cf_dates = [equity.index[0]] + [d for d, f in flows.items() if f > 0] + [equity.index[-1]]
    cf = [-float(equity.iloc[0] - flows.iloc[0])] + [-float(f) for f in flows if f > 0] + [float(equity.iloc[-1])]
    out["irr"] = _xirr(cf_dates, cf)

    if bench_ret is not None:
        b = bench_ret.iloc[1:]
        aligned = pd.concat([daily, b], axis=1).dropna()
        if len(aligned) > 20 and aligned.iloc[:, 1].var() > 0:
            cov = np.cov(aligned.iloc[:, 0], aligned.iloc[:, 1])
            beta = cov[0, 1] / cov[1, 1]
            alpha = (aligned.iloc[:, 0].mean() - rf_daily - beta * (aligned.iloc[:, 1].mean() - rf_daily)) * TRADING_DAYS
            active = aligned.iloc[:, 0] - aligned.iloc[:, 1]
            te = active.std(ddof=1) * math.sqrt(TRADING_DAYS)
            out.update({
                "beta": beta,
                "alpha": alpha,
                "correlation": float(aligned.corr().iloc[0, 1]),
                "tracking_error": te,
                "information_ratio": (active.mean() * TRADING_DAYS / te) if te > 0 else None,
            })
    return {k: _finite(v) if not isinstance(v, int) else v for k, v in out.items()}


def monthly_returns(ret: pd.Series) -> list[dict]:
    m = (1 + ret).resample("ME").prod() - 1
    return [{"year": d.year, "month": d.month, "return": _finite(v)} for d, v in m.items()]


def yearly_returns(ret: pd.Series, bench_ret: pd.Series) -> list[dict]:
    y = (1 + ret).resample("YE").prod() - 1
    b = (1 + bench_ret).resample("YE").prod() - 1
    return [{"year": d.year, "strategy": _finite(y[d]), "benchmark": _finite(b.get(d))} for d in y.index]
