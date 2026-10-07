"""Persistence of a simulation's row-level outputs.

The engine returns plain dicts; aggregated series stay in `backtests.results`
(JSON, read as a whole), while decisions, transactions and final positions are
stored one row each so they can be filtered, paginated and joined.
"""

from __future__ import annotations

import uuid
from datetime import date

from sqlalchemy import Connection, insert

from .models import BacktestDecision, BacktestPosition, BacktestTransaction

ROW_KEYS = ("decisions", "trades", "positions")
_CHUNK = 2000


def _d(x: str | date) -> date:
    return x if isinstance(x, date) else date.fromisoformat(x)


def _bulk(conn: Connection, table, rows: list[dict]) -> None:
    for i in range(0, len(rows), _CHUNK):
        conn.execute(insert(table), rows[i : i + _CHUNK])


def store_outputs(conn: Connection, backtest_id: uuid.UUID, res: dict) -> None:
    decisions = [
        {
            "backtest_id": backtest_id, "seq": d.get("seq", k), "date": _d(d["date"]), "symbol": d["symbol"], "action": d["action"],
            "prev_weight": d["prev_weight"], "target_weight": d["target_weight"], "reason": d["reason"], "metrics": d.get("metrics") or {},
        }
        for k, d in enumerate(res.get("decisions", []))
    ]
    trades = [
        {
            "backtest_id": backtest_id, "seq": k, "date": _d(t["date"]), "symbol": t["symbol"], "side": t["side"], "qty": t["qty"],
            "price": t["price"], "value": t["value"], "fees": t["fees"], "tax": t["tax"], "realized_pnl": t["realized_pnl"],
            "reason": t["reason"], "decision_seq": t.get("decision_seq"),
        }
        for k, t in enumerate(res.get("trades", []))
    ]
    positions = [
        {
            "backtest_id": backtest_id, "symbol": p["symbol"], "qty": p["qty"], "avg_cost": p["avg_cost"], "price": p["price"],
            "value": p["value"], "weight": p["weight"], "unrealized_pnl": p["unrealized_pnl"],
        }
        for p in res.get("positions", [])
    ]
    _bulk(conn, BacktestDecision.__table__, decisions)
    _bulk(conn, BacktestTransaction.__table__, trades)
    _bulk(conn, BacktestPosition.__table__, positions)


def strip_rows(res: dict) -> dict:
    """The JSON kept on the backtest once row-level outputs are stored separately."""
    return {k: v for k, v in res.items() if k not in ROW_KEYS}
