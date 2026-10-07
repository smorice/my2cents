"""Append-only audit trail.

Every event stores the SHA-256 of the previous event, so any tampering with
past rows (which the DB trigger already forbids) is detectable by re-walking the
chain (see `verify_chain`).
"""

import hashlib
import json
import uuid
from datetime import datetime, timezone
from typing import Any

from fastapi import Request
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from .db import SessionLocal
from .models import AuditEvent, User, utcnow

GENESIS = "0" * 64
_LOCK_KEY = 0x6D3263  # arbitrary constant for pg_advisory_xact_lock


def _json_default(value: Any) -> Any:
    if isinstance(value, (datetime,)):
        return value.isoformat()
    if isinstance(value, uuid.UUID):
        return str(value)
    return str(value)


def _canonical(payload: dict) -> str:
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), default=_json_default)


def _event_hash(prev_hash: str, fields: dict) -> str:
    return hashlib.sha256((prev_hash + _canonical(fields)).encode()).hexdigest()


def _hashed_fields(ev: AuditEvent) -> dict:
    return {
        "occurred_at": ev.occurred_at.astimezone(timezone.utc).isoformat(),
        "actor_id": str(ev.actor_id) if ev.actor_id else None,
        "actor_email": ev.actor_email,
        "action": ev.action,
        "resource_type": ev.resource_type,
        "resource_id": ev.resource_id,
        "outcome": ev.outcome,
        "before": ev.before,
        "after": ev.after,
        "details": ev.details,
        "ip": ev.ip,
        "user_agent": ev.user_agent,
    }


def client_ip(request: Request | None) -> str | None:
    if request is None:
        return None
    for header in ("x-real-ip", "x-forwarded-for"):
        value = request.headers.get(header)
        if value:
            return value.split(",")[0].strip()[:64]
    return request.client.host if request.client else None


def _clean(value: dict | None) -> dict | None:
    if value is None:
        return None
    return json.loads(json.dumps(value, default=_json_default))


def record(
    db: Session,
    action: str,
    *,
    actor: User | None = None,
    actor_email: str | None = None,
    request: Request | None = None,
    resource_type: str | None = None,
    resource_id: Any = None,
    outcome: str = "success",
    before: dict | None = None,
    after: dict | None = None,
    details: dict | None = None,
) -> AuditEvent:
    """Add an audit event to the caller's transaction (committed with it)."""
    db.execute(text("SELECT pg_advisory_xact_lock(:k)"), {"k": _LOCK_KEY})
    prev = db.scalar(select(AuditEvent.hash).order_by(AuditEvent.id.desc()).limit(1)) or GENESIS
    ev = AuditEvent(
        occurred_at=utcnow(),
        actor_id=actor.id if actor else None,
        actor_email=actor.email if actor else actor_email,
        action=action,
        resource_type=resource_type,
        resource_id=str(resource_id) if resource_id is not None else None,
        outcome=outcome,
        before=_clean(before),
        after=_clean(after),
        details=_clean(details),
        ip=client_ip(request),
        user_agent=(request.headers.get("user-agent", "")[:400] if request else None),
        prev_hash=prev,
    )
    ev.hash = _event_hash(prev, _hashed_fields(ev))
    db.add(ev)
    db.flush()
    return ev


def record_now(action: str, **kwargs: Any) -> None:
    """Record an event in its own transaction (for failures / denials that roll back the main one)."""
    with SessionLocal() as db:
        record(db, action, **kwargs)
        db.commit()


def verify_chain(db: Session, batch: int = 5000) -> dict:
    prev = GENESIS
    checked = 0
    last_id = 0
    while True:
        rows = db.scalars(select(AuditEvent).where(AuditEvent.id > last_id).order_by(AuditEvent.id).limit(batch)).all()
        if not rows:
            break
        for ev in rows:
            if ev.prev_hash != prev or ev.hash != _event_hash(prev, _hashed_fields(ev)):
                return {"valid": False, "checked": checked, "broken_at": ev.id}
            prev = ev.hash
            checked += 1
            last_id = ev.id
    return {"valid": True, "checked": checked, "broken_at": None}
