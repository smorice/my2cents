"""Forward-only schema migrations.

`Base.metadata.create_all` creates missing tables but never alters existing ones,
so every change to an existing table is listed here. Each step runs once, in
order, and is recorded in `schema_migrations`. Steps must be idempotent (they
also run on fresh databases where `create_all` already built the final shape).
"""

from __future__ import annotations

import logging
from collections.abc import Callable

from sqlalchemy import Connection, select, text

from .models import SchemaMigration, utcnow

log = logging.getLogger(__name__)


def _normalise_results(conn: Connection) -> None:
    """Move decisions / trades / final positions out of the per-backtest JSON blob."""
    from .results import store_outputs  # late import: results imports models

    rows = conn.execute(text(
        "SELECT id, results FROM backtests WHERE status = 'done' AND results ? 'decisions'"
    )).all()
    for bt_id, res in rows:
        store_outputs(conn, bt_id, res)
        conn.execute(
            text("UPDATE backtests SET results = results - 'decisions' - 'trades' - 'positions' WHERE id = :id"),
            {"id": bt_id},
        )
    log.info("normalised outputs of %d backtests", len(rows))


STEPS: list[tuple[str, str | Callable[[Connection], None]]] = [
    ("2026-10-07-portfolio-currency-benchmark", """
        ALTER TABLE portfolios ADD COLUMN IF NOT EXISTS currency varchar(8) NOT NULL DEFAULT 'EUR';
        ALTER TABLE portfolios ADD COLUMN IF NOT EXISTS benchmark varchar(24);
    """),
    ("2026-10-07-backtest-job", "ALTER TABLE backtests ADD COLUMN IF NOT EXISTS job_id uuid;"),
    ("2026-10-07-market-provenance", """
        ALTER TABLE instruments ADD COLUMN IF NOT EXISTS provider varchar(32) NOT NULL DEFAULT 'yahoo';
        ALTER TABLE price_bars ADD COLUMN IF NOT EXISTS source varchar(32) NOT NULL DEFAULT 'yahoo';
        ALTER TABLE price_bars ADD COLUMN IF NOT EXISTS fetched_at timestamptz;
        UPDATE price_bars p SET fetched_at = i.last_synced_at FROM instruments i
            WHERE p.symbol = i.symbol AND p.fetched_at IS NULL;
    """),
    ("2026-10-07-interrupted-backtests", """
        UPDATE backtests SET status = 'failed', error = 'Interrompu par une mise à jour du serveur. Relancez le backtest.'
            WHERE status IN ('queued', 'running') AND job_id IS NULL;
    """),
    ("2026-10-07-normalise-results", _normalise_results),
    ("2026-10-07-decision-explain", "ALTER TABLE backtest_decisions ADD COLUMN IF NOT EXISTS explain jsonb;"),
]


def run(conn: Connection) -> None:
    done = set(conn.scalars(select(SchemaMigration.id)).all())
    for step_id, step in STEPS:
        if step_id in done:
            continue
        log.info("applying migration %s", step_id)
        if callable(step):
            step(conn)
        else:
            conn.execute(text(step))
        conn.execute(SchemaMigration.__table__.insert().values(id=step_id, applied_at=utcnow()))
