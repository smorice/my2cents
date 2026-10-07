"""Structured logging, request correlation and recorded application errors.

Logs are one JSON object per line (easy to grep / ship). Every API request gets
an id (returned in `X-Request-ID`) that is attached to its log lines and to any
recorded error, so a user-visible reference leads the administrator straight to
the full traceback in `app_errors` — which the user never sees.
"""

from __future__ import annotations

import contextvars
import json
import logging
import sys
import traceback
import uuid
from datetime import datetime, timezone

from .db import SessionLocal
from .models import AppError

request_id_var: contextvars.ContextVar[str | None] = contextvars.ContextVar("request_id", default=None)
user_id_var: contextvars.ContextVar[str | None] = contextvars.ContextVar("user_id", default=None)

_STD = set(logging.LogRecord("", 0, "", 0, "", None, None).__dict__) | {"message", "asctime"}


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        out = {
            "ts": datetime.fromtimestamp(record.created, timezone.utc).isoformat(timespec="milliseconds"),
            "level": record.levelname.lower(),
            "logger": record.name,
            "msg": record.getMessage(),
        }
        rid = request_id_var.get()
        if rid:
            out["request_id"] = rid
        for k, v in record.__dict__.items():
            if k not in _STD and not k.startswith("_") and k != "color_message":
                out[k] = v
        if record.exc_info:
            out["exc"] = self.formatException(record.exc_info)
        return json.dumps(out, default=str, ensure_ascii=False)


def setup_logging(level: int = logging.INFO) -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(level)
    for name in ("uvicorn", "uvicorn.error"):
        logging.getLogger(name).handlers[:] = []
        logging.getLogger(name).propagate = True
    # Request lines are logged by our own middleware, with timing and request id.
    logging.getLogger("uvicorn.access").disabled = True


def new_request_id() -> str:
    return uuid.uuid4().hex[:16]


def record_error(
    exc: BaseException,
    *,
    source: str,
    method: str | None = None,
    path: str | None = None,
    request_id: str | None = None,
    user_id: str | None = None,
) -> str:
    """Persist an unexpected error and return the short reference shown to the user."""
    ref = request_id or request_id_var.get() or new_request_id()
    logging.getLogger("app.error").error(
        "unhandled error", exc_info=(type(exc), exc, exc.__traceback__),
        extra={"source": source, "path": path, "ref": ref},
    )
    try:
        with SessionLocal() as db:
            uid = user_id or user_id_var.get()
            db.add(AppError(
                request_id=ref, source=source, method=method, path=(path or "")[:300] or None,
                user_id=uuid.UUID(uid) if uid else None, error_type=type(exc).__name__[:120],
                message=str(exc)[:4000] or type(exc).__name__,
                traceback="".join(traceback.format_exception(type(exc), exc, exc.__traceback__))[-16000:],
            ))
            db.commit()
    except Exception:  # noqa: BLE001 - never let error reporting raise
        logging.getLogger("app.error").exception("could not record error")
    return ref
