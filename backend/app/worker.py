"""Background worker: `python -m app.worker`.

Runs queued jobs (backtests, market data syncs, account reviews), recovers jobs
abandoned by a dead worker, and schedules the periodic market data refresh and
the weekday evening review of real accounts. Several worker processes can run
side by side; the queue hands each job to exactly one.
"""

from __future__ import annotations

import logging
import os
import signal
import socket
import threading
import time
from datetime import timedelta
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert

from . import accounts, bootstrap, jobs, runner  # noqa: F401 - runner and accounts register the job handlers
from .config import get_settings
from .db import SessionLocal
from .models import Job, WorkerHeartbeat, utcnow
from .observability import setup_logging

log = logging.getLogger("app.worker")


def _loop(name: str, stop: threading.Event, idle: float) -> None:
    while not stop.is_set():
        try:
            job = jobs.claim(name)
        except Exception:  # noqa: BLE001 - database briefly unavailable, etc.
            log.exception("claim failed")
            stop.wait(5)
            continue
        if job is None:
            stop.wait(idle)
            continue
        log.info("job started", extra={"job_id": str(job.id), "kind": job.kind, "attempt": job.attempts})
        jobs.execute(job)


def schedule_market_refresh(every: timedelta) -> bool:
    """Queue a market refresh unless one is pending or ran recently."""
    with SessionLocal() as db:
        recent = db.scalar(select(Job.id).where(
            Job.kind == "market_sync", Job.payload["scheduled"].as_boolean().is_(True),
            (Job.status.in_(["queued", "running"])) | (Job.created_at > utcnow() - every),
        ).limit(1))
        if recent:
            return False
        jobs.enqueue(db, "market_sync", {"scheduled": True}, message="Rafraîchissement planifié")
        db.commit()
        return True


ALIVE_FILE = Path(os.environ.get("MY2CENTS_WORKER_ALIVE_FILE", "/tmp/my2cents-worker-alive"))


def _beat(name: str, concurrency: int) -> None:
    with SessionLocal() as db:
        now = utcnow()
        db.execute(insert(WorkerHeartbeat).values(name=name, started_at=now, seen_at=now, concurrency=concurrency)
                   .on_conflict_do_update(index_elements=[WorkerHeartbeat.name], set_={"seen_at": now}))
        db.commit()


def _housekeeping(stop: threading.Event, refresh: bool, name: str, concurrency: int) -> None:
    settings = get_settings()
    while not stop.is_set():
        try:
            ALIVE_FILE.touch()  # container healthcheck
            _beat(name, concurrency)
            jobs.recover_stale()
            if refresh:
                schedule_market_refresh(timedelta(hours=settings.market_data_refresh_hours))
                accounts.schedule_evening_review()
        except Exception:  # noqa: BLE001
            log.exception("housekeeping failed")
        stop.wait(60)


def start(stop: threading.Event, concurrency: int = 2, idle: float = 1.0, refresh: bool = True) -> list[threading.Thread]:
    name = f"{socket.gethostname()}-{os.getpid()}"
    threads = [threading.Thread(target=_loop, args=(f"{name}/{k}", stop, idle), name=f"worker-{k}", daemon=True)
               for k in range(concurrency)]
    threads.append(threading.Thread(target=_housekeeping, args=(stop, refresh, name, concurrency), name="housekeeping", daemon=True))
    for t in threads:
        t.start()
    return threads


def main() -> None:
    setup_logging()
    bootstrap.prepare()
    stop = threading.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: stop.set())
    concurrency = int(os.environ.get("MY2CENTS_WORKER_CONCURRENCY", "2"))
    threads = start(stop, concurrency, refresh=os.environ.get("MY2CENTS_DISABLE_REFRESH") != "1")
    log.info("worker ready", extra={"concurrency": concurrency})
    while not stop.is_set():
        time.sleep(0.5)
    log.info("worker stopping: waiting for running jobs")
    for t in threads:
        t.join(timeout=60)


if __name__ == "__main__":
    main()
