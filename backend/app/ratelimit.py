"""In-process sliding-window rate limiting for the API (one uvicorn process serves the API).

Reads and writes have separate budgets per client IP; authentication endpoints keep their
own stricter throttle (routers/auth.py)."""

from __future__ import annotations

import threading
import time
from collections import defaultdict, deque

WINDOW_SECONDS = 60
LIMITS = {"read": 600, "write": 90}

_hits: dict[tuple[str, str], deque] = defaultdict(deque)
_lock = threading.Lock()


def check(ip: str, method: str) -> float | None:
    """Record a request; returns the number of seconds to wait if the budget is exhausted."""
    kind = "read" if method in ("GET", "HEAD", "OPTIONS") else "write"
    now = time.monotonic()
    with _lock:
        q = _hits[(ip, kind)]
        while q and now - q[0] > WINDOW_SECONDS:
            q.popleft()
        if len(q) >= LIMITS[kind]:
            return WINDOW_SECONDS - (now - q[0])
        q.append(now)
        if len(_hits) > 50_000:  # forget idle clients
            for key in [k for k, v in _hits.items() if not v or now - v[-1] > WINDOW_SECONDS]:
                del _hits[key]
    return None


def reset() -> None:
    with _lock:
        _hits.clear()
