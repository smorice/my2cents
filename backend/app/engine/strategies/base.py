from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, ClassVar

import numpy as np
import pandas as pd


@dataclass
class Param:
    key: str
    label: str
    type: str  # int | float | bool | choice | weights (symbol -> %)
    default: Any
    help: str = ""
    min: float | None = None
    max: float | None = None
    step: float | None = None
    choices: list[Any] | None = None
    unit: str | None = None

    def as_dict(self) -> dict:
        return {k: v for k, v in self.__dict__.items() if v is not None}

    def coerce(self, value: Any) -> Any:
        if value is None:
            return self.default
        if self.type == "weights":
            if not isinstance(value, dict) or not value:
                raise ValueError(f"{self.label} : au moins une ligne requise")
            out = {str(k).upper(): float(v) for k, v in value.items() if float(v) > 0}
            if sum(out.values()) > 100.0001:
                raise ValueError(f"{self.label} : la somme des poids dépasse 100 %")
            return out
        if self.type == "int":
            value = int(value)
        elif self.type == "float":
            value = float(value)
        elif self.type == "bool":
            value = bool(value)
        elif self.type == "choice":
            if value not in (self.choices or []):
                raise ValueError(f"{self.label} : valeur non autorisée ({value})")
            return value
        if self.min is not None and value < self.min:
            raise ValueError(f"{self.label} : minimum {self.min}")
        if self.max is not None and value > self.max:
            raise ValueError(f"{self.label} : maximum {self.max}")
        return value


@dataclass
class Note:
    """Why the strategy wants (or does not want) an asset on a given day.

    `explain` is the structured form of `reason`, rendered visually by the UI:
    `facts` are the measured values, `checks` the rule's conditions with their
    thresholds and whether they held. Labels may contain `{asset}` /
    `{benchmark}`, replaced by display names in the UI."""

    reason: str
    metrics: dict[str, float | None] = field(default_factory=dict)
    explain: dict[str, Any] | None = None


Fmt = str  # pct | num | z | int


def fact(label: str, value: float | None, fmt: Fmt = "pct", *, subject: str | None = None, emphasis: bool = False) -> dict:
    out: dict[str, Any] = {"label": label, "value": value, "fmt": fmt}
    if subject:
        out["subject"] = subject  # asset | benchmark | universe
    if emphasis:
        out["emphasis"] = True
    return out


_OPS = {">=": lambda a, b: a >= b, ">": lambda a, b: a > b, "<=": lambda a, b: a <= b, "<": lambda a, b: a < b}


def check(label: str, value: float | None, op: str, threshold: float, fmt: Fmt = "pct") -> dict:
    """A threshold condition of the rule, e.g. outperformance >= +5 %."""
    passed = value is not None and _OPS[op](value, threshold)
    return {"label": label, "value": value, "op": op, "threshold": threshold, "fmt": fmt, "passed": passed}


def flag(label: str, passed: bool) -> dict:
    """A yes/no condition without a measured value (e.g. a free slot in the portfolio)."""
    return {"label": label, "passed": passed}


def explain(facts: list[dict] | None = None, checks: list[dict] | None = None) -> dict:
    return {"facts": facts or [], "checks": checks or []}


@dataclass
class Evaluation:
    # Target weights in [0, 1] summing to <= 1 (rest is cash). None = keep current holdings.
    targets: dict[str, float] | None
    notes: dict[str, Note] = field(default_factory=dict)


@dataclass
class Context:
    """Everything a strategy may look at. `prices` and `benchmark` are truncated
    at `date` (inclusive) by the engine, so future data is structurally unreachable."""

    date: pd.Timestamp
    prices: pd.DataFrame  # adjusted closes, one column per tradable symbol
    benchmark: pd.Series
    weights: dict[str, float]  # current portfolio weights (by value)
    state: dict[str, Any]  # private, persisted across evaluations


class Strategy:
    kind: ClassVar[str]
    name: ClassVar[str]
    summary: ClassVar[str]
    explanation: ClassVar[str]
    params: ClassVar[list[Param]]
    default_rebalance: ClassVar[str] = "monthly"
    uses_benchmark: ClassVar[bool] = False
    # Research metadata shown to users (no effect on the simulation)
    family: ClassVar[str] = ""
    complexity: ClassVar[int] = 1  # 1 simple … 3 advanced
    horizon: ClassVar[str] = "Long terme"
    risk_level: ClassVar[int] = 2  # 1 low … 3 high
    risks: ClassVar[list[str]] = []

    def __init__(self, values: dict[str, Any] | None = None):
        values = values or {}
        self.p = {param.key: param.coerce(values.get(param.key)) for param in self.params}
        self.validate()

    def validate(self) -> None:  # pragma: no cover - overridden when needed
        pass

    def warmup_days(self) -> int:
        """Trading days of history needed before the first meaningful signal."""
        return 0

    def evaluate(self, ctx: Context) -> Evaluation:
        raise NotImplementedError

    @classmethod
    def describe(cls) -> dict:
        return {
            "kind": cls.kind,
            "name": cls.name,
            "summary": cls.summary,
            "explanation": cls.explanation,
            "params": [p.as_dict() for p in cls.params],
            "default_rebalance": cls.default_rebalance,
            "uses_benchmark": cls.uses_benchmark,
            "family": cls.family, "complexity": cls.complexity, "horizon": cls.horizon,
            "risk_level": cls.risk_level, "risks": cls.risks,
        }


# ---------------------------------------------------------------------------
# Helpers shared by strategies. All operate on already-truncated history.
# ---------------------------------------------------------------------------


def _clean(series: pd.Series) -> np.ndarray:
    v = series.to_numpy(dtype=float, copy=False)
    return v[~np.isnan(v)]


def tradable(prices: pd.DataFrame, min_history: int) -> list[str]:
    """Symbols with a price today and at least `min_history` observations."""
    arr = prices.to_numpy(dtype=float, copy=False)
    ok = ~np.isnan(arr[-1]) & ((~np.isnan(arr)).sum(axis=0) >= min_history + 1)
    return [s for s, k in zip(prices.columns, ok) if k]


def trailing_return(series: pd.Series, days: int, skip: int = 0) -> float | None:
    s = _clean(series)
    if len(s) < days + skip + 1:
        return None
    end = s[-1 - skip]
    start = s[-1 - skip - days]
    if start <= 0:
        return None
    return float(end / start - 1.0)


def sma(series: pd.Series, window: int, offset: int = 0) -> float | None:
    s = _clean(series)
    if offset:
        s = s[:-offset]
    if len(s) < window:
        return None
    return float(s[-window:].mean())


def zscore(series: pd.Series, window: int) -> float | None:
    s = _clean(series)
    if len(s) < window:
        return None
    w = s[-window:]
    sd = float(w.std(ddof=1))
    if not np.isfinite(sd) or sd == 0:
        return None
    return float((w[-1] - w.mean()) / sd)


def equal_weights(symbols: list[str]) -> dict[str, float]:
    if not symbols:
        return {}
    w = 1.0 / len(symbols)
    return {s: w for s in symbols}


def pct(x: float | None) -> str:
    return "n/d" if x is None else f"{x * 100:+.2f} %"
