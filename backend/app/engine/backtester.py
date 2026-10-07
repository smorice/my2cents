"""Daily event-driven backtester.

Timeline for every trading day t:
  1. open  : orders decided at the close of t-1 are filled at t's open (+ slippage, fees, tax)
  2. intraday : scheduled contributions (DCA) are credited as cash
  3. close : portfolio is valued; stop-losses are checked; if t is a rebalance day the strategy
             is evaluated on data truncated at t, and the resulting orders are queued for t+1's open.

Because the strategy only ever receives `prices.iloc[: i + 1]` and orders fill on the *next* open,
a decision can never use a price it could not have known.
"""

from __future__ import annotations

import math
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import date
from typing import Any

import numpy as np
import pandas as pd

from .metrics import compute_metrics, drawdown_series, monthly_returns, yearly_returns
from .strategies.base import Context, Evaluation, Note, Strategy

FREQ_KEYS = {"daily", "weekly", "monthly", "quarterly", "yearly", "never"}
WEIGHT_TOLERANCE = 0.01  # absolute drift (share of portfolio) ignored when re-weighting
RELATIVE_TOLERANCE = 0.2  # ...or 20 % of the target weight, whichever is larger


def drifted(cur: float, tgt: float) -> bool:
    """Whether an existing position is far enough from its target to be worth trading.
    Entries and exits always trade; small drifts are tolerated to avoid churning fees."""
    return abs(tgt - cur) > max(WEIGHT_TOLERANCE, RELATIVE_TOLERANCE * tgt)


@dataclass
class CostModel:
    fee_pct: float = 0.1  # % of traded notional
    fee_min: float = 0.0  # minimum fee per order (currency)
    slippage_bps: float = 5.0


@dataclass
class RiskModel:
    max_weight_pct: float = 100.0
    cash_buffer_pct: float = 0.0
    stop_loss_pct: float = 0.0  # 0 = disabled; loss from average cost


@dataclass
class Contributions:
    amount: float = 0.0
    frequency: str = "none"  # none | weekly | monthly | quarterly
    start: date | None = None
    end: date | None = None


@dataclass
class BacktestConfig:
    start: date
    end: date
    initial_capital: float
    universe: list[str]
    benchmark: str
    rebalance: str = "monthly"
    costs: CostModel = field(default_factory=CostModel)
    risk: RiskModel = field(default_factory=RiskModel)
    contributions: Contributions = field(default_factory=Contributions)
    tax_mode: str = "none"  # none | pfu
    tax_rate_pct: float = 30.0
    fractional: bool = True
    risk_free_pct: float = 2.0
    currency: str = "EUR"


@dataclass
class Position:
    qty: float = 0.0
    cost: float = 0.0  # total cost basis incl. fees

    @property
    def avg_cost(self) -> float:
        return self.cost / self.qty if self.qty > 0 else 0.0


def _period_key(ts: pd.Timestamp, freq: str) -> Any:
    if freq == "daily":
        return ts
    if freq == "weekly":
        iso = ts.isocalendar()
        return (iso.year, iso.week)
    if freq == "monthly":
        return (ts.year, ts.month)
    if freq == "quarterly":
        return (ts.year, (ts.month - 1) // 3)
    if freq == "yearly":
        return ts.year
    return None


def _first_days(dates: pd.DatetimeIndex, freq: str) -> set[pd.Timestamp]:
    """First trading day of each period. Only needs past/current dates, never the next one."""
    if freq in ("none", "never"):
        return set()
    out, prev = set(), object()
    for d in dates:
        k = _period_key(d, freq)
        if k != prev:
            out.add(d)
            prev = k
    return out


class Backtester:
    def __init__(
        self,
        strategy: Strategy,
        config: BacktestConfig,
        close: pd.DataFrame,
        open_: pd.DataFrame,
        bench_close: pd.Series,
        bench_open: pd.Series,
        names: dict[str, str] | None = None,
    ):
        self.s = strategy
        self.c = config
        self.names = names or {}
        # Calendar = every day on which anything (universe or benchmark) traded.
        cal = close.index.union(bench_close.index).sort_values()
        self.close_raw = close.reindex(cal)
        # Valuation uses the last known price (a missing quote does not zero a position).
        self.close = self.close_raw.ffill()
        self.open = open_.reindex(cal)
        self.open_ff = self.open.ffill()
        self.bclose = bench_close.reindex(cal).ffill()
        self.bopen = bench_open.reindex(cal)
        self.cal = cal
        self.sim_dates = cal[(cal >= pd.Timestamp(config.start)) & (cal <= pd.Timestamp(config.end))]
        if len(self.sim_dates) < 2:
            raise ValueError("Période trop courte ou aucune donnée de marché sur la période choisie.")

        self.cash = 0.0
        self.pos: dict[str, Position] = {}
        self.state: dict[str, Any] = {}
        self.targets: dict[str, float] = {}
        self.loss_carry = 0.0
        self.tax_year, self.year_net, self.year_tax_paid = config.start.year, 0.0, 0.0
        self.totals = {"fees": 0.0, "slippage": 0.0, "taxes": 0.0, "turnover": 0.0}

        self.trades: list[dict] = []
        self.decisions: list[dict] = []
        self.contrib_log: list[dict] = []
        self.weights_snapshots: list[dict] = []
        self.warnings: list[str] = []

    # ------------------------------------------------------------------ helpers

    def _value(self, i: int, prices: pd.DataFrame | None = None) -> float:
        row = (prices if prices is not None else self.close).iloc[i]
        v = self.cash
        for s, p in self.pos.items():
            px = row.get(s)
            if p.qty and px is not None and not math.isnan(px):
                v += p.qty * px
            elif p.qty:
                v += p.qty * float(self.close[s].iloc[: i + 1].dropna().iloc[-1])
        return v

    def _weights(self, i: int) -> dict[str, float]:
        total = self._value(i)
        if total <= 0:
            return {}
        row = self.close.iloc[i]
        return {s: p.qty * row[s] / total for s, p in self.pos.items() if p.qty > 0 and not math.isnan(row[s])}

    def _apply_risk(self, targets: dict[str, float]) -> dict[str, float]:
        cap = self.c.risk.max_weight_pct / 100
        investable = 1 - self.c.risk.cash_buffer_pct / 100
        out = {s: min(max(w, 0.0), cap) for s, w in targets.items() if w > 0}
        total = sum(out.values())
        if total > investable and total > 0:
            out = {s: w * investable / total for s, w in out.items()}
        return out

    def _fee(self, notional: float) -> float:
        if notional <= 0:
            return 0.0
        return max(self.c.costs.fee_min, notional * self.c.costs.fee_pct / 100)

    def _tax_on(self, d: pd.Timestamp, realized: float) -> float:
        """French-style flat tax: gains and losses net out over the calendar year,
        and a net yearly loss is carried forward. Tax is settled sale by sale as a
        running provision (a later loss in the same year refunds part of it)."""
        if d.year != self.tax_year:
            net = self.year_net
            self.loss_carry = self.loss_carry - net if net < 0 else max(self.loss_carry - net, 0.0)
            self.tax_year, self.year_net, self.year_tax_paid = d.year, 0.0, 0.0
        self.year_net += realized
        due = max(self.year_net - self.loss_carry, 0.0) * self.c.tax_rate_pct / 100
        delta = due - self.year_tax_paid
        self.year_tax_paid = due
        return delta

    # ------------------------------------------------------------------ execution

    def _sell(self, d: pd.Timestamp, s: str, qty: float, px: float, reason: str, decision_seq: int | None = None) -> None:
        p = self.pos[s]
        qty = min(qty, p.qty)
        if qty <= 0:
            return
        fill = px * (1 - self.c.costs.slippage_bps / 10_000)
        gross = qty * fill
        fee = self._fee(gross)
        basis = p.avg_cost * qty
        realized = gross - fee - basis
        tax = self._tax_on(d, realized) if self.c.tax_mode == "pfu" else 0.0
        self.cash += gross - fee - tax
        p.cost -= basis
        p.qty -= qty
        if p.qty <= 1e-9:
            del self.pos[s]
        self.totals["fees"] += fee
        self.totals["taxes"] += tax
        self.totals["slippage"] += qty * (px - fill)
        self.totals["turnover"] += gross
        self.trades.append({
            "date": d.date().isoformat(), "symbol": s, "side": "sell", "qty": qty, "price": fill,
            "value": gross, "fees": fee, "tax": tax, "realized_pnl": realized, "reason": reason, "decision_seq": decision_seq,
        })

    def _buy(self, d: pd.Timestamp, s: str, budget: float, px: float, reason: str, decision_seq: int | None = None) -> None:
        fill = px * (1 + self.c.costs.slippage_bps / 10_000)
        budget = min(budget, self.cash)
        if budget <= 1:
            return
        # Solve qty so that qty*fill + fee(qty*fill) <= budget.
        notional = budget / (1 + self.c.costs.fee_pct / 100)
        if notional * self.c.costs.fee_pct / 100 < self.c.costs.fee_min:
            notional = budget - self.c.costs.fee_min
        qty = notional / fill
        if not self.c.fractional:
            qty = math.floor(qty)
        if qty <= 0:
            return
        gross = qty * fill
        fee = self._fee(gross)
        if gross + fee > self.cash + 1e-6:
            return
        self.cash -= gross + fee
        p = self.pos.setdefault(s, Position())
        p.qty += qty
        p.cost += gross + fee
        self.totals["fees"] += fee
        self.totals["slippage"] += qty * (fill - px)
        self.totals["turnover"] += gross
        self.trades.append({
            "date": d.date().isoformat(), "symbol": s, "side": "buy", "qty": qty, "price": fill,
            "value": gross, "fees": fee, "tax": 0.0, "realized_pnl": None, "reason": reason, "decision_seq": decision_seq,
        })

    def _execute(self, i: int, order: dict) -> None:
        d = self.cal[i]
        opens = self.open.iloc[i]
        total = self._value(i, self.open_ff)
        reasons = order["reasons"]
        seqs = order.get("decision_seqs", {})
        if order["type"] == "rebalance":
            targets = order["targets"]
            current = {s: p.qty * opens[s] / total for s, p in self.pos.items() if total > 0 and not math.isnan(opens[s])}
            # Sells first to free cash.
            for s, p in list(self.pos.items()):
                px = opens.get(s)
                if px is None or math.isnan(px):
                    continue
                tgt = targets.get(s, 0.0)
                cur = current.get(s, 0.0)
                if tgt == 0:
                    self._sell(d, s, p.qty, px, reasons.get(s, "Sortie"), seqs.get(s))
                elif cur > tgt and drifted(cur, tgt):
                    self._sell(d, s, (cur - tgt) * total / px, px, reasons.get(s, "Allègement"), seqs.get(s))
            for s, tgt in sorted(targets.items(), key=lambda kv: -kv[1]):
                px = opens.get(s)
                if px is None or math.isnan(px):
                    self.warnings.append(f"{d.date()} : pas de cotation d'ouverture pour {s}, ordre ignoré.")
                    continue
                cur = current.get(s, 0.0)
                if (cur == 0 and tgt > 0) or (tgt > cur and drifted(cur, tgt)):
                    self._buy(d, s, (tgt - cur) * total, px, reasons.get(s, "Renforcement"), seqs.get(s))
        elif order["type"] == "invest_cash":
            # New cash goes first to the lines furthest below their target weight.
            weights = {s: w for s, w in order["targets"].items() if not math.isnan(opens.get(s, math.nan))}
            wsum = sum(weights.values())
            if wsum <= 0:
                return
            budget = self.cash * min(wsum, 1.0)
            deficits = {}
            for s, w in weights.items():
                held = self.pos[s].qty * opens[s] if s in self.pos else 0.0
                deficits[s] = max(w * total - held, 0.0)
            basis = deficits if sum(deficits.values()) > 1e-9 else weights
            bsum = sum(basis.values())
            for s, v in basis.items():
                if v > 0:
                    self._buy(d, s, budget * v / bsum, opens[s], "Investissement du versement programmé (ligne sous-pondérée)")
        elif order["type"] == "stop":
            for s in order["symbols"]:
                px = opens.get(s)
                if s in self.pos and px is not None and not math.isnan(px):
                    self._sell(d, s, self.pos[s].qty, px, reasons.get(s, "Stop-loss"), seqs.get(s))

    # ------------------------------------------------------------------ decisions

    def _add_decision(self, row: dict) -> int:
        row["seq"] = len(self.decisions)
        self.decisions.append(row)
        return row["seq"]

    def _record_decisions(
        self, d: pd.Timestamp, ev: Evaluation, weights: dict[str, float], targets: dict[str, float] | None
    ) -> dict[str, int]:
        """Log the strategy's view of every asset; returns the decision seq of each asset to trade."""
        symbols = set(ev.notes) | set(weights) | set(targets or {})
        rows, any_trade = [], False
        for s in sorted(symbols):
            prev = weights.get(s, 0.0)
            tgt = prev if targets is None else targets.get(s, 0.0)
            if prev == 0 and tgt > 0:
                action = "buy"
            elif prev > 0 and tgt == 0:
                action = "sell"
            elif prev > 0 and tgt > prev and drifted(prev, tgt):
                action = "increase"
            elif prev > 0 and prev > tgt and drifted(prev, tgt):
                action = "decrease"
            elif prev > 0:
                action = "hold"
            else:
                action = "skip"
            any_trade |= action in ("buy", "sell", "increase", "decrease")
            note = ev.notes.get(s) or Note("Aucun signal calculé (historique insuffisant ou cotation absente).")
            rows.append({
                "date": d.date().isoformat(), "symbol": s, "action": action,
                "prev_weight": prev, "target_weight": tgt, "reason": note.reason,
                "metrics": {k: (None if v is None or (isinstance(v, float) and not math.isfinite(v)) else v) for k, v in note.metrics.items()},
            })
        # Skipped assets are only interesting when the portfolio actually moved.
        seqs = {}
        for r in rows:
            if r["action"] != "skip" or any_trade:
                seq = self._add_decision(r)
                if r["action"] in ("buy", "sell", "increase", "decrease"):
                    seqs[r["symbol"]] = seq
        return seqs

    # ------------------------------------------------------------------ main loop

    def run(self, progress: Callable[[float], None] | None = None) -> dict:
        """Simulate the whole period. `progress` receives the completed share (0..1) now and then."""
        c = self.c
        rebalance_days = _first_days(self.sim_dates, c.rebalance)
        contrib_dates = set()
        if c.contributions.frequency != "none" and c.contributions.amount > 0:
            cs = pd.Timestamp(c.contributions.start or c.start)
            ce = pd.Timestamp(c.contributions.end or c.end)
            contrib_dates = {d for d in _first_days(self.sim_dates, c.contributions.frequency) if cs <= d <= ce}
            if c.initial_capital > 0:
                contrib_dates.discard(self.sim_dates[0])  # the initial capital already covers day one

        start_i = int(self.cal.get_loc(self.sim_dates[0]))
        end_i = int(self.cal.get_loc(self.sim_dates[-1]))

        warm = self.s.warmup_days()
        avail_before = int(self.close_raw.iloc[:start_i].notna().sum(axis=0).max()) if start_i > 0 else 0
        if warm and avail_before < warm:
            self.warnings.append(
                f"La stratégie a besoin de {warm} jours d'historique ; seuls {avail_before} sont disponibles avant "
                "le début : les premiers signaux arriveront plus tard."
            )

        self.cash = c.initial_capital
        invested = c.initial_capital
        bench_units, bench_cash = 0.0, c.initial_capital
        pending: list[dict] = []
        bench_pending = False

        out_dates, equity, invested_s, flows, bench_eq, cash_w = [], [], [], [], [], []
        last_month = None

        step = max((end_i - start_i) // 50, 1)
        for i in range(start_i, end_i + 1):
            d = self.cal[i]
            if progress and (i - start_i) % step == 0:
                progress((i - start_i) / max(end_i - start_i, 1))
            # 1. fills at the open
            for order in pending:
                self._execute(i, order)
            pending = []
            if bench_pending and bench_cash > 0:
                bpx = self.bopen.iloc[i]
                if math.isnan(bpx):
                    bpx = self.bclose.iloc[i - 1] if i > 0 else self.bclose.iloc[i]
                if not math.isnan(bpx) and bpx > 0:
                    bench_units += bench_cash / bpx
                    bench_cash = 0.0
                    bench_pending = False

            # 2. contributions
            flow = 0.0
            if d in contrib_dates:
                flow = c.contributions.amount
                self.cash += flow
                bench_cash += flow
                invested += flow
                bench_pending = True
            if i == start_i:
                bench_pending = True

            # 3. close
            value = self._value(i)
            bench_value = bench_units * float(self.bclose.iloc[i]) + bench_cash
            out_dates.append(d)
            equity.append(value)
            invested_s.append(invested)
            flows.append(flow)
            bench_eq.append(bench_value)
            cash_w.append(self.cash / value if value > 0 else 1.0)
            if flow:
                self.contrib_log.append({"date": d.date().isoformat(), "amount": flow, "cumulative": invested, "portfolio_value": value})

            if i == end_i:
                break

            weights = self._weights(i)
            month = (d.year, d.month)
            if month != last_month:
                self.weights_snapshots.append({"date": d.date().isoformat(), "weights": {s: round(w, 5) for s, w in weights.items()}, "cash": cash_w[-1]})
                last_month = month

            # Stop-loss (checked every day, executes next open)
            if c.risk.stop_loss_pct > 0:
                hit = [
                    s for s, p in self.pos.items()
                    if not math.isnan(self.close.iloc[i][s]) and self.close.iloc[i][s] < p.avg_cost * (1 - c.risk.stop_loss_pct / 100)
                ]
                if hit:
                    reasons, seqs = {}, {}
                    for s in hit:
                        loss = self.close.iloc[i][s] / self.pos[s].avg_cost - 1
                        reasons[s] = f"Stop-loss : {loss * 100:+.1f} % sous le prix de revient (seuil −{c.risk.stop_loss_pct:g} %)."
                        seqs[s] = self._add_decision({
                            "date": d.date().isoformat(), "symbol": s, "action": "sell", "prev_weight": weights.get(s, 0.0),
                            "target_weight": 0.0, "reason": reasons[s], "metrics": {"loss_from_cost": loss},
                        })
                        self.targets.pop(s, None)
                    pending.append({"type": "stop", "symbols": hit, "reasons": reasons, "decision_seqs": seqs})
                    # Stopped symbols are banned until the next scheduled rebalance.
                    self.state.setdefault("_stopped", set()).update(hit)

            is_rebalance = i == start_i or d in rebalance_days
            if is_rebalance:
                # Strategies only need their warm-up window; truncating keeps evaluation cheap.
                lo = max(0, i + 1 - (warm + 15)) if warm else max(0, i - 5)
                hist = self.close_raw.iloc[lo : i + 1]
                ctx = Context(date=d, prices=hist, benchmark=self.bclose.iloc[lo : i + 1], weights=weights, state=self.state)
                ev = self.s.evaluate(ctx)
                targets = None if ev.targets is None else self._apply_risk(ev.targets)
                self.state.pop("_stopped", None)
                seqs = self._record_decisions(d, ev, weights, targets)
                if targets is not None:
                    self.targets = targets
                    reasons = {s: n.reason for s, n in ev.notes.items()}
                    pending.append({"type": "rebalance", "targets": targets, "reasons": reasons, "decision_seqs": seqs})
                elif self.cash > 1 and self.targets:
                    pending.append({"type": "invest_cash", "targets": self.targets, "reasons": {}})
            elif flow and self.targets:
                stopped = self.state.get("_stopped", set())
                pending.append({"type": "invest_cash", "targets": {s: w for s, w in self.targets.items() if s not in stopped}, "reasons": {}})

        return self._results(out_dates, equity, invested_s, flows, bench_eq, cash_w)

    # ------------------------------------------------------------------ outputs

    def _results(self, dates, equity, invested, flows, bench_eq, cash_w) -> dict:
        idx = pd.DatetimeIndex(dates)
        eq = pd.Series(equity, index=idx)
        fl = pd.Series(flows, index=idx)
        beq = pd.Series(bench_eq, index=idx)
        # Time-weighted returns remove the effect of contributions.
        def twr_returns(v: pd.Series) -> pd.Series:
            prev = v.shift(1)
            out = (v - fl) / prev.where(prev > 0) - 1
            return out.replace([np.inf, -np.inf], np.nan).fillna(0.0)

        ret, bret = twr_returns(eq), twr_returns(beq)
        twr = (1 + ret).cumprod()
        btwr = (1 + bret).cumprod()

        metrics = compute_metrics(eq, fl, ret, bret, self.c.risk_free_pct / 100)
        bench_metrics = compute_metrics(beq, fl, bret, None, self.c.risk_free_pct / 100)
        last_i = int(self.cal.get_loc(idx[-1]))
        last_close = self.close.iloc[last_i]
        total = eq.iloc[-1]
        positions = []
        for s, p in sorted(self.pos.items(), key=lambda kv: -kv[1].qty * last_close[kv[0]]):
            val = p.qty * last_close[s]
            positions.append({
                "symbol": s, "name": self.names.get(s, s), "qty": p.qty, "avg_cost": p.avg_cost,
                "price": float(last_close[s]), "value": float(val), "weight": float(val / total) if total else 0.0,
                "unrealized_pnl": float(val - p.cost), "unrealized_pct": float(val / p.cost - 1) if p.cost else 0.0,
            })

        # P&L attribution per symbol (realised + unrealised).
        contrib: dict[str, float] = {}
        for t in self.trades:
            if t["realized_pnl"] is not None:
                contrib[t["symbol"]] = contrib.get(t["symbol"], 0.0) + t["realized_pnl"] - t["tax"]
        for p in positions:
            contrib[p["symbol"]] = contrib.get(p["symbol"], 0.0) + p["unrealized_pnl"]

        n_years = max((idx[-1] - idx[0]).days / 365.25, 1e-9)
        avg_value = float(eq.mean()) or 1.0
        metrics.update({
            "fees": self.totals["fees"], "slippage": self.totals["slippage"], "taxes": self.totals["taxes"],
            "trades": len(self.trades),
            "annual_turnover": self.totals["turnover"] / avg_value / n_years,
            "avg_exposure": float(1 - np.mean(cash_w)),
            "total_invested": float(invested[-1]),
            "final_value": float(total),
            "net_profit": float(total - invested[-1]),
        })

        def r(x):
            return [None if (v is None or not np.isfinite(v)) else round(float(v), 6) for v in x]

        return {
            "summary": {"strategy": metrics, "benchmark": bench_metrics},
            "series": {
                "dates": [d.date().isoformat() for d in idx],
                "equity": r(eq.values), "invested": r(invested), "benchmark_equity": r(beq.values),
                "twr": r(twr.values), "benchmark_twr": r(btwr.values),
                "drawdown": r(drawdown_series(twr).values), "benchmark_drawdown": r(drawdown_series(btwr).values),
                "cash_weight": r(cash_w),
            },
            "monthly_returns": monthly_returns(ret),
            "yearly": yearly_returns(ret, bret),
            "positions": positions,
            "attribution": sorted(
                [{"symbol": s, "name": self.names.get(s, s), "pnl": v} for s, v in contrib.items()], key=lambda x: -x["pnl"]
            ),
            "trades": self.trades,
            "contributions": self.contrib_log,
            "allocation_history": self.weights_snapshots,
            "decisions": self.decisions,
            "warnings": sorted(set(self.warnings))[:50],
        }
