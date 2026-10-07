from collections.abc import Callable
from datetime import timedelta

from fastapi import Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from . import audit
from .config import get_settings
from .db import get_db
from .models import User, UserSession, utcnow
from .observability import user_id_var
from .rbac import Perm
from .security import token_digest

settings = get_settings()

CSRF_HEADER = "x-my2cents-csrf"
_SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}


def csrf_guard(request: Request) -> None:
    """The session cookie is SameSite=Strict; on top of that every state-changing
    request must carry a custom header, which a cross-site form cannot set."""
    if request.method not in _SAFE_METHODS and request.headers.get(CSRF_HEADER) != "1":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "En-tête CSRF manquant")


def _load_session(request: Request, db: Session) -> UserSession | None:
    token = request.cookies.get(settings.session_cookie)
    if not token:
        return None
    sess = db.scalar(select(UserSession).where(UserSession.token_hash == token_digest(token)))
    now = utcnow()
    if sess is None or sess.revoked_at is not None or sess.expires_at <= now:
        return None
    if sess.last_seen_at + timedelta(minutes=settings.session_idle_minutes) <= now:
        return None
    if not sess.user.is_active:
        return None
    # Throttle last_seen writes to once a minute.
    if (now - sess.last_seen_at) > timedelta(minutes=1):
        sess.last_seen_at = now
        db.commit()
    return sess


def get_session_any(request: Request, db: Session = Depends(get_db)) -> UserSession:
    """A valid session, possibly still waiting for its second factor."""
    sess = _load_session(request, db)
    if sess is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Session absente ou expirée")
    return sess


def get_session(sess: UserSession = Depends(get_session_any)) -> UserSession:
    if sess.mfa_pending:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Vérification MFA requise")
    return sess


def current_user(request: Request, sess: UserSession = Depends(get_session)) -> User:
    # Correlates logs / recorded errors with the user (read back by the request middleware).
    request.state.user_id = str(sess.user_id)
    user_id_var.set(str(sess.user_id))
    return sess.user


def require(*perms: Perm) -> Callable[..., User]:
    def checker(request: Request, user: User = Depends(current_user)) -> User:
        missing = [p for p in perms if p not in user.permissions]
        if missing:
            audit.record_now(
                "access.denied",
                actor=user,
                request=request,
                outcome="denied",
                details={"path": request.url.path, "method": request.method, "missing": missing},
            )
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Permission insuffisante")
        return user

    return checker
