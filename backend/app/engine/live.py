"""Order proposals for a real account.

Applies a strategy to what the user actually holds, at the last known close, and
turns the gap between current and target weights into concrete orders (side,
quantity, indicative price, estimated fees). Uses the same evaluation, risk
constraints and drift tolerance as the backtester, so a proposal is exactly what
the simulation would have decided on that day.

Nothing is executed: the user places the orders with their broker, then records
the fills, which updates the holdings.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

import pandas as pd

from .backtester import CostModel, RiskModel, _finite, _period_key, drifted
from .strategies.base import Context, Note, Strategy, check, explain, fact

# Modes: "full" evaluates the strategy (rebalance day or on demand); "light" only checks
# stop-losses and the investment of idle cash, as the backtester does between rebalances.
MODES = ("full", "light")


@dataclass
class Holding:
    qty: float
    avg_cost: float = 0.0
    locked: bool = False  # held outside the strategy: never traded, excluded from the managed value


@dataclass
class LiveConfig:
    costs: CostModel = field(default_factory=CostModel)
    risk: RiskModel = field(default_factory=RiskModel)
    fractional: bool = False
    min_order_value: float = 50.0  # smaller orders are not worth their fees
    idle_cash_pct: float = 2.0  # "light" mode invests cash above this share of the managed value


@dataclass
class LiveResult:
    as_of: pd.Timestamp
    mode: str
    value: float  # managed value: cash + unlocked positions at the last close
    orders: list[dict]
    decisions: list[dict]
    targets: dict[str, float] | None  # None: the strategy kept its holdings
    state: dict[str, Any]
    warnings: list[str]
    cash_after: float  # estimated, once every proposed order is filled


def due_mode(rebalance: str, as_of: pd.Timestamp, last_full: pd.Timestamp | None) -> str:
    """Full evaluation on the first market day of each rebalance period (as in the backtester)."""
    if last_full is None:
        return "full"
    if rebalance in ("none", "never"):
        return "light"
    return "full" if _period_key(as_of, rebalance) != _period_key(last_full, rebalance) else "light"


def _fee(c: CostModel, notional: float) -> float:
    return 0.0 if notional <= 0 else max(c.fee_min, notional * c.fee_pct / 100)


def _apply_risk(r: RiskModel, targets: dict[str, float]) -> dict[str, float]:
    cap = r.max_weight_pct / 100
    investable = 1 - r.cash_buffer_pct / 100
    out = {s: min(max(w, 0.0), cap) for s, w in targets.items() if w > 0}
    total = sum(out.values())
    if total > investable and total > 0:
        out = {s: w * investable / total for s, w in out.items()}
    return out


def _qty_for_budget(c: CostModel, budget: float, px: float, fractional: bool) -> float:
    notional = budget / (1 + c.fee_pct / 100)
    if notional * c.fee_pct / 100 < c.fee_min:
        notional = budget - c.fee_min
    qty = max(notional / px, 0.0)
    return qty if fractional else float(math.floor(qty + 1e-9))


def _round_qty(qty: float, fractional: bool) -> float:
    return round(qty, 6) if fractional else float(math.floor(qty + 1e-9))


def propose(
    strategy: Strategy,
    config: LiveConfig,
    prices: pd.DataFrame,
    benchmark: pd.Series,
    holdings: dict[str, Holding],
    cash: float,
    *,
    universe: list[str],
    mode: str = "full",
    state: dict[str, Any] | None = None,
    last_targets: dict[str, float] | None = None,
    names: dict[str, str] | None = None,
) -> LiveResult:
    """`prices` holds adjusted closes (one column per symbol: the strategy's `universe` plus
    every held symbol), ending at the last market day; the last adjusted close is the
    actual last price. Held symbols outside the universe are sold on a full evaluation."""
    if mode not in MODES:
        raise ValueError(f"mode inconnu : {mode}")
    names = names or {}
    state = dict(state or {})
    warnings: list[str] = []
    c, r = config.costs, config.risk
    closes = prices.dropna(how="all")
    if closes.empty:
        raise ValueError("Aucune cotation disponible pour calculer des ordres.")
    as_of = closes.index[-1]
    last = closes.ffill().iloc[-1]

    def px(s: str) -> float | None:
        v = last.get(s)
        return None if v is None or (isinstance(v, float) and math.isnan(v)) or v <= 0 else float(v)

    managed = {s: h for s, h in holdings.items() if not h.locked and h.qty > 0}
    for s in managed:
        if px(s) is None:
            warnings.append(f"Pas de cours connu pour {names.get(s, s)} : cette ligne n'est ni valorisée ni traitée.")
    managed = {s: h for s, h in managed.items() if px(s) is not None}
    value = cash + sum(h.qty * px(s) for s, h in managed.items())
    if value <= 0:
        raise ValueError("Le portefeuille géré est vide : ajoutez des liquidités ou des positions.")
    weights = {s: h.qty * px(s) / value for s, h in managed.items()}

    decisions: list[dict] = []
    targets: dict[str, float] | None = None
    reasons: dict[str, str] = {}
    explains: dict[str, dict | None] = {}
    stops: set[str] = set()

    # Stop-losses are checked on every review, as the backtester does every day.
    if r.stop_loss_pct > 0:
        for s, h in managed.items():
            if h.avg_cost > 0 and px(s) < h.avg_cost * (1 - r.stop_loss_pct / 100):
                loss = px(s) / h.avg_cost - 1
                stops.add(s)
                reasons[s] = f"Stop-loss : {loss * 100:+.1f} % sous le prix de revient (seuil −{r.stop_loss_pct:g} %)."
                explains[s] = explain(
                    [fact("Prix de revient moyen de {asset}", h.avg_cost, "num", subject="asset"),
                     fact("Dernier cours", px(s), "num"), fact("Variation depuis l'achat", loss, emphasis=True)],
                    [check("Stop-loss déclenché sous", loss, "<", -r.stop_loss_pct / 100)],
                )

    if mode == "full":
        hist = closes[[s for s in universe if s in closes.columns]]
        warm = strategy.warmup_days()
        if warm and int(hist.notna().sum(axis=0).max()) < warm:
            warnings.append(f"La stratégie demande {warm} jours d'historique : les signaux peuvent être incomplets.")
        if stops:
            state["_stopped"] = set(stops)
        ev = strategy.evaluate(Context(date=as_of, prices=hist, benchmark=benchmark.loc[:as_of], weights=weights, state=state))
        state.pop("_stopped", None)
        if ev.targets is not None:
            targets = _apply_risk(r, {s: w for s, w in ev.targets.items() if s not in stops})
        for s, n in ev.notes.items():
            if s not in stops:
                reasons[s], explains[s] = n.reason, n.explain
        symbols = set(ev.notes) | set(weights) | set(targets or {})
        for s in sorted(symbols):
            prev = weights.get(s, 0.0)
            tgt = 0.0 if s in stops else (prev if targets is None else targets.get(s, 0.0))
            note = ev.notes.get(s) or Note("Aucun signal calculé (historique insuffisant ou cotation absente).")
            decisions.append({
                "symbol": s, "action": _action(prev, tgt), "prev_weight": prev, "target_weight": tgt,
                "reason": reasons.get(s, note.reason),
                "metrics": _finite({k: v for k, v in note.metrics.items()}),
                "explain": _finite(explains.get(s, note.explain)),
            })
    else:
        for s in sorted(stops):
            decisions.append({"symbol": s, "action": "sell", "prev_weight": weights.get(s, 0.0), "target_weight": 0.0,
                              "reason": reasons[s], "metrics": {}, "explain": _finite(explains[s])})

    orders: list[dict] = []
    avail = cash

    def add(side: str, s: str, qty: float, reason: str, action: str, tgt: float) -> None:
        nonlocal avail
        p = px(s)
        gross = qty * p
        if qty <= 0:
            return
        if gross < config.min_order_value and not (side == "sell" and qty >= managed[s].qty - 1e-9):
            warnings.append(f"{'Vente' if side == 'sell' else 'Achat'} de {names.get(s, s)} ignoré : "
                            f"{gross:.0f} € est sous le montant minimum d'un ordre ({config.min_order_value:g} €).")
            return
        fee = _fee(c, gross)
        avail += gross - fee if side == "sell" else -(gross + fee)
        orders.append({
            "seq": len(orders), "side": side, "symbol": s, "qty": qty, "price": p, "value": gross, "fee_estimate": fee,
            "action": action, "prev_weight": weights.get(s, 0.0), "target_weight": tgt,
            "reason": reason, "explain": _finite(explains.get(s)),
        })

    # Sells first, to free the cash the buys need.
    for s in sorted(stops):
        add("sell", s, managed[s].qty, reasons[s], "sell", 0.0)
    if targets is not None:
        for s, h in sorted(managed.items()):
            if s in stops:
                continue
            tgt, cur = targets.get(s, 0.0), weights.get(s, 0.0)
            if tgt == 0:
                add("sell", s, h.qty, reasons.get(s, "Sortie : la stratégie ne retient plus cette ligne."), "sell", 0.0)
            elif cur > tgt and drifted(cur, tgt):
                qty = min(_round_qty((cur - tgt) * value / px(s), config.fractional), h.qty)
                add("sell", s, qty, reasons.get(s, "Allègement vers le poids cible."), "decrease", tgt)
        for s, tgt in sorted(targets.items(), key=lambda kv: -kv[1]):
            cur = weights.get(s, 0.0)
            if not ((cur == 0 and tgt > 0) or (tgt > cur and drifted(cur, tgt))):
                continue
            if px(s) is None:
                warnings.append(f"Pas de cours connu pour {names.get(s, s)} : achat impossible à chiffrer.")
                continue
            budget = min((tgt - cur) * value, avail)
            qty = _qty_for_budget(c, budget, px(s), config.fractional)
            if qty <= 0:
                warnings.append(f"Achat de {names.get(s, s)} impossible : {budget:.0f} € ne suffisent pas pour une part à {px(s):.2f} €.")
                continue
            add("buy", s, qty, reasons.get(s, "Renforcement vers le poids cible."), "buy" if cur == 0 else "increase", tgt)
    else:
        # No rebalance: new cash goes to the lines furthest below their last target.
        tg = {s: w for s, w in (last_targets or {}).items() if s not in stops and px(s) is not None}
        if tg and avail > max(config.min_order_value, value * config.idle_cash_pct / 100):
            budget = avail * min(sum(tg.values()), 1.0)
            deficits = {s: max(w * value - (managed[s].qty * px(s) if s in managed else 0.0), 0.0) for s, w in tg.items()}
            basis = deficits if sum(deficits.values()) > 1e-9 else tg
            bsum = sum(basis.values())
            for s, v in sorted(basis.items(), key=lambda kv: -kv[1]):
                if v <= 0:
                    continue
                qty = _qty_for_budget(c, min(budget * v / bsum, avail), px(s), config.fractional)
                add("buy", s, qty, "Investissement des liquidités disponibles (ligne sous-pondérée par rapport à sa cible).",
                    "buy" if s not in managed else "increase", tg[s])

    if avail < -0.01:
        warnings.append("Les achats proposés dépassent les liquidités estimées : vérifiez les montants avant de passer les ordres.")
    if (pd.Timestamp.now(tz=None).normalize() - as_of.normalize()).days > 5:
        warnings.append(f"Dernière cotation connue le {as_of.date().isoformat()} : les données de marché ne sont pas à jour.")
    state.pop("_stopped", None)
    return LiveResult(as_of=as_of, mode=mode, value=value, orders=orders, decisions=decisions, targets=targets,
                      state=state, warnings=warnings, cash_after=avail)


def _action(prev: float, tgt: float) -> str:
    if prev == 0 and tgt > 0:
        return "buy"
    if prev > 0 and tgt == 0:
        return "sell"
    if prev > 0 and tgt > prev and drifted(prev, tgt):
        return "increase"
    if prev > 0 and prev > tgt and drifted(prev, tgt):
        return "decrease"
    return "hold" if prev > 0 else "skip"
