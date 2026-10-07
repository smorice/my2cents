"""Price-series sanity checks.

The free provider sometimes misses a corporate action (restructuring with massive dilution,
reverse split, spin-off, merger exchange ratio): the adjusted series then shows a one-day
jump that no shareholder experienced (Atos +8 528 % on 2024-11-12, Vivendi −78 % on the
day of its four-way split). Fed to a backtest, such a jump fabricates a fortune or a ruin.

Jumps beyond the thresholds below are treated as unadjusted corporate actions: the history
before the jump is rescaled so that day counts as 0 %, and every correction is reported so
the user can see it. The thresholds sit above the largest genuine one-day moves observed on
the Paris large and mid caps (Worldline −59 %, MedinCell +78 %), which are left untouched.
"""

from __future__ import annotations

from dataclasses import dataclass

import pandas as pd

JUMP_UP = 0.90
JUMP_DOWN = -0.65


@dataclass
class Jump:
    symbol: str
    date: pd.Timestamp
    change: float  # raw one-day change of the adjusted close


def find_jumps(close: pd.Series) -> list[tuple[pd.Timestamp, float]]:
    s = close.dropna()
    r = s / s.shift(1) - 1
    bad = r[(r > JUMP_UP) | (r < JUMP_DOWN)]
    return [(d, float(x)) for d, x in bad.items()]


def neutralise_jumps(close: pd.DataFrame, open_: pd.DataFrame | None = None) -> tuple[pd.DataFrame, pd.DataFrame | None, list[Jump]]:
    """Rescale the history before each suspect jump. Returns new panels and the corrections made."""
    close = close.copy()
    open_ = None if open_ is None else open_.copy()
    jumps: list[Jump] = []
    for s in close.columns:
        found = find_jumps(close[s])
        if not found:
            continue
        factor = pd.Series(1.0, index=close.index)
        for d, x in found:
            factor[close.index < d] *= 1 + x
            jumps.append(Jump(s, d, x))
        close[s] = close[s] * factor
        if open_ is not None and s in open_.columns:
            open_[s] = open_[s] * factor.reindex(open_.index).fillna(1.0)
    return close, open_, jumps


def describe(jumps: list[Jump], names: dict[str, str] | None = None) -> list[str]:
    names = names or {}
    return [
        f"{names.get(j.symbol, j.symbol)} : saut de {j.change * 100:+.0f} % le {j.date.strftime('%d/%m/%Y')} dans les données de la source, "
        "probablement une opération sur titres mal ajustée (regroupement, scission, restructuration). "
        "Ce jour-là est compté à 0 % ; l'historique antérieur est remis à l'échelle."
        for j in jumps
    ]


__all__ = ["JUMP_DOWN", "JUMP_UP", "Jump", "describe", "find_jumps", "neutralise_jumps"]
