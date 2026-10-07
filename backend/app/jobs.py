"""Postgres-backed job queue.

The API only *enqueues*; the worker process (`python -m app.worker`) claims jobs
with `FOR UPDATE SKIP LOCKED`, reports progress and heartbeats, and records the
outcome. A job whose worker died (no heartbeat) is put back in the queue once,
then failed, so nothing stays "running" forever after a restart.
"""

from __future__ import annotations

import logging
import threading
import time
import traceback
import uuid
from collections.abc import Callable
from datetime import timedelta
from typing import Any

from sqlalchemy import select, text, update
from sqlalchemy.orm import Session

from .db import SessionLocal
from .models import Job, utcnow

log = logging.getLogger(__name__)

MAX_ATTEMPTS = 2
STALE_AFTER = timedelta(minutes=2)
HEARTBEAT_SECONDS = 15


class UserFacingError(Exception):
    """An expected failure whose message is safe and useful to show to the user."""


class Reporter:
    """Progress callback handed to job handlers (throttled, own transaction)."""

    def __init__(self, job_id: uuid.UUID):
        self.job_id = job_id
        self._last = 0.0

    def __call__(self, progress: float, message: str | None = None, force: bool = False) -> None:
        now = time.monotonic()
        if not force and now - self._last < 0.5:
            return
        self._last = now
        values: dict[str, Any] = {"progress": round(min(max(progress, 0.0), 1.0), 4), "heartbeat_at": utcnow()}
        if message is not None:
            values["message"] = message[:200]
        with SessionLocal() as db:
            db.execute(update(Job).where(Job.id == self.job_id).values(**values))
            db.commit()


Handler = Callable[[Job, Reporter], None]
HANDLERS: dict[str, Handler] = {}


def handler(kind: str) -> Callable[[Handler], Handler]:
    def deco(fn: Handler) -> Handler:
        HANDLERS[kind] = fn
        return fn

    return deco


def enqueue(db: Session, kind: str, payload: dict, owner_id: uuid.UUID | None = None, message: str | None = None) -> Job:
    """Add a job to the caller's transaction; it becomes visible to workers on commit."""
    job = Job(kind=kind, payload=payload, owner_id=owner_id, status="queued", message=message or "En file d'attente")
    db.add(job)
    db.flush()
    return job


def claim(worker: str) -> Job | None:
    with SessionLocal() as db:
        row = db.execute(text("""
            UPDATE jobs SET status = 'running', started_at = now(), heartbeat_at = now(),
                   attempts = attempts + 1, worker = :w, progress = 0, message = 'Démarrage'
            WHERE id = (SELECT id FROM jobs WHERE status = 'queued' ORDER BY created_at
                        FOR UPDATE SKIP LOCKED LIMIT 1)
            RETURNING id
        """), {"w": worker}).first()
        db.commit()
        return db.get(Job, row[0]) if row else None


def _finish(job_id: uuid.UUID, **values: Any) -> None:
    with SessionLocal() as db:
        db.execute(update(Job).where(Job.id == job_id).values(finished_at=utcnow(), heartbeat_at=utcnow(), **values))
        db.commit()


def _heartbeat(job_id: uuid.UUID, stop: threading.Event) -> None:
    while not stop.wait(HEARTBEAT_SECONDS):
        try:
            with SessionLocal() as db:
                db.execute(update(Job).where(Job.id == job_id).values(heartbeat_at=utcnow()))
                db.commit()
        except Exception:  # noqa: BLE001
            log.exception("heartbeat failed for job %s", job_id)


def execute(job: Job) -> None:
    """Run one claimed job to completion, recording success or failure."""
    from . import observability  # late import: observability imports this module's models only

    fn = HANDLERS.get(job.kind)
    stop = threading.Event()
    threading.Thread(target=_heartbeat, args=(job.id, stop), daemon=True, name=f"hb-{job.id}").start()
    started = time.monotonic()
    try:
        if fn is None:
            raise RuntimeError(f"no handler for job kind {job.kind!r}")
        fn(job, Reporter(job.id))
    except UserFacingError as exc:
        log.info("job failed", extra={"job_id": str(job.id), "kind": job.kind, "error": str(exc)})
        _finish(job.id, status="failed", user_error=str(exc)[:1000], error=str(exc)[:4000], message="Échec")
        on_failure(job, str(exc))
    except Exception as exc:  # noqa: BLE001
        ref = observability.record_error(exc, source="worker", path=f"job:{job.kind}", request_id=str(job.id))
        user_msg = f"Erreur interne lors du calcul (référence {ref}). L'administrateur peut consulter le détail."
        _finish(job.id, status="failed", user_error=user_msg, error=traceback.format_exc()[-8000:], message="Échec")
        on_failure(job, user_msg)
    else:
        _finish(job.id, status="completed", progress=1.0, message="Terminé")
        log.info("job completed", extra={"job_id": str(job.id), "kind": job.kind, "duration_ms": int((time.monotonic() - started) * 1000)})
    finally:
        stop.set()


FAILURE_HOOKS: dict[str, Callable[[Job, str], None]] = {}


def on_failure(job: Job, message: str) -> None:
    hook = FAILURE_HOOKS.get(job.kind)
    if hook:
        try:
            hook(job, message)
        except Exception:  # noqa: BLE001
            log.exception("failure hook for job %s failed", job.id)


def recover_stale() -> int:
    """Re-queue (or fail, after MAX_ATTEMPTS) running jobs whose worker stopped heartbeating."""
    limit = utcnow() - STALE_AFTER
    n = 0
    with SessionLocal() as db:
        stale = db.scalars(select(Job).where(Job.status == "running", Job.heartbeat_at < limit).with_for_update(skip_locked=True)).all()
        failed = []
        for job in stale:
            n += 1
            if job.attempts < MAX_ATTEMPTS:
                job.status, job.message, job.progress = "queued", "Relancé après l'arrêt d'un worker", 0.0
                log.warning("re-queued stale job", extra={"job_id": str(job.id), "kind": job.kind})
            else:
                job.status, job.finished_at, job.message = "failed", utcnow(), "Échec"
                job.user_error = "Le calcul a été interrompu à plusieurs reprises. Relancez-le ; si le problème persiste, contactez l'administrateur."
                job.error = f"worker {job.worker} stopped heartbeating after {job.attempts} attempts"
                failed.append(job)
                log.error("stale job failed", extra={"job_id": str(job.id), "kind": job.kind})
        db.commit()
    for job in failed:
        on_failure(job, job.user_error or "")
    return n
