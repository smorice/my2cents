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
    """Why the strategy wants (or does not want) an asset on a given day."""

    reason: str
    metrics: dict[str, float | None] = field(default_factory=dict)


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
