import time
from collections import defaultdict, deque
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .. import audit
from ..config import get_settings
from ..db import get_db
from ..deps import current_user, get_session, get_session_any
from ..mailer import mail_enabled, send_mail
from ..models import PasswordResetToken, Role, User, UserSession, utcnow
from ..schemas import (
    CodeIn,
    ForgotIn,
    LoginIn,
    MfaDisableIn,
    PasswordChangeIn,
    ProfileIn,
    RegisterIn,
    ResetIn,
    SessionOut,
    UserOut,
)
from ..security import (
    hash_password,
    new_token,
    new_totp_secret,
    password_problems,
    token_digest,
    totp_uri,
    verify_password,
    verify_totp,
)

router = APIRouter(prefix="/auth", tags=["auth"])
settings = get_settings()

# Per-IP sliding window on authentication endpoints (in addition to per-account lockout).
_ip_hits: dict[str, deque] = defaultdict(deque)
_IP_WINDOW, _IP_MAX = 300, 30


def _throttle(request: Request) -> None:
    ip = audit.client_ip(request) or "?"
    now = time.monotonic()
    q = _ip_hits[ip]
    while q and now - q[0] > _IP_WINDOW:
        q.popleft()
    if len(q) >= _IP_MAX:
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Trop de tentatives, réessayez dans quelques minutes.")
    q.append(now)


def _set_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        settings.session_cookie, token,
        max_age=settings.session_absolute_hours * 3600,
        path=settings.base_path or "/", httponly=True, secure=settings.cookie_secure, samesite="strict",
    )


def _clear_cookie(response: Response) -> None:
    response.delete_cookie(settings.session_cookie, path=settings.base_path or "/")


def _open_session(db: Session, user: User, request: Request, response: Response, mfa_pending: bool) -> None:
    token = new_token()
    db.add(UserSession(
        token_hash=token_digest(token), user_id=user.id,
        expires_at=utcnow() + timedelta(hours=settings.session_absolute_hours),
        mfa_pending=mfa_pending, ip=audit.client_ip(request),
        user_agent=request.headers.get("user-agent", "")[:400],
    ))
    _set_cookie(response, token)


def _check_password(password: str, email: str) -> None:
    problems = password_problems(password, email)
    if problems:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Mot de passe trop faible : " + ", ".join(problems) + ".")


@router.get("/config")
def auth_config():
    return {"allow_registration": settings.allow_registration, "password_reset_by_mail": mail_enabled()}


@router.post("/register", response_model=UserOut, status_code=201)
def register(body: RegisterIn, request: Request, response: Response, db: Session = Depends(get_db)):
    _throttle(request)
    if not settings.allow_registration:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Les inscriptions sont fermées.")
    email = body.email.lower()
    _check_password(body.password, email)
    if db.scalar(select(User).where(func.lower(User.email) == email)):
        audit.record_now("auth.register", actor_email=email, request=request, outcome="failure", details={"reason": "email_taken"})
        raise HTTPException(status.HTTP_409_CONFLICT, "Un compte existe déjà avec cet email.")
    user = User(email=email, display_name=body.display_name.strip(), password_hash=hash_password(body.password))
    user.roles = [db.scalar(select(Role).where(Role.name == "USER"))]
    db.add(user)
    db.flush()
    audit.record(db, "auth.register", actor=user, request=request, resource_type="user", resource_id=user.id,
                 after={"email": email, "roles": user.role_names})
    _open_session(db, user, request, response, mfa_pending=False)
    user.last_login_at = utcnow()
    db.commit()
    return user


@router.post("/login")
def login(body: LoginIn, request: Request, response: Response, db: Session = Depends(get_db)):
    _throttle(request)
    email = body.email.lower()
    user = db.scalar(select(User).where(func.lower(User.email) == email))
    now = utcnow()
    if user and user.locked_until and user.locked_until > now:
        verify_password(None, body.password)
        audit.record_now("auth.login", actor_email=email, request=request, outcome="denied", details={"reason": "locked"})
        raise HTTPException(status.HTTP_423_LOCKED, "Compte temporairement verrouillé après trop d'échecs. Réessayez plus tard.")
    if user is None or not verify_password(user.password_hash, body.password) or not user.is_active:
        reason = "unknown_email" if user is None else ("inactive" if not user.is_active else "bad_password")
        if user is not None and reason == "bad_password":
            user.failed_logins += 1
            if user.failed_logins >= settings.login_max_failures:
                user.locked_until = now + timedelta(minutes=settings.login_lockout_minutes)
                user.failed_logins = 0
                reason = "locked_now"
            db.commit()
        audit.record_now("auth.login", actor_email=email, request=request, outcome="failure", details={"reason": reason})
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Email ou mot de passe incorrect.")
    user.failed_logins = 0
    user.locked_until = None
    _open_session(db, user, request, response, mfa_pending=user.totp_enabled)
    if not user.totp_enabled:
        user.last_login_at = now
    audit.record(db, "auth.login", actor=user, request=request, resource_type="user", resource_id=user.id,
                 details={"mfa_pending": user.totp_enabled})
    db.commit()
    return {"mfa_required": user.totp_enabled, "user": None if user.totp_enabled else UserOut.model_validate(user)}


@router.post("/mfa/verify", response_model=UserOut)
def mfa_verify(body: CodeIn, request: Request, sess: UserSession = Depends(get_session_any), db: Session = Depends(get_db)):
    _throttle(request)
    sess = db.merge(sess)
    user = sess.user
    if not sess.mfa_pending:
        return user
    if not user.totp_secret or not verify_totp(user.totp_secret, body.code):
        audit.record_now("auth.mfa_verify", actor=user, request=request, outcome="failure")
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Code invalide.")
    sess.mfa_pending = False
    user.last_login_at = utcnow()
    audit.record(db, "auth.mfa_verify", actor=user, request=request, resource_type="user", resource_id=user.id)
    db.commit()
    return user


@router.post("/logout", status_code=204)
def logout(request: Request, response: Response, db: Session = Depends(get_db)):
    token = request.cookies.get(settings.session_cookie)
    if token:
        sess = db.scalar(select(UserSession).where(UserSession.token_hash == token_digest(token)))
        if sess and sess.revoked_at is None:
            sess.revoked_at = utcnow()
            audit.record(db, "auth.logout", actor=sess.user, request=request, resource_type="user", resource_id=sess.user_id)
            db.commit()
    _clear_cookie(response)


@router.get("/me", response_model=UserOut)
def me(user: User = Depends(current_user)):
    return user


@router.patch("/me", response_model=UserOut)
def update_me(body: ProfileIn, request: Request, user: User = Depends(current_user), db: Session = Depends(get_db)):
    user = db.merge(user)
    before = {"display_name": user.display_name}
    if body.display_name is not None:
        user.display_name = body.display_name.strip()
    if body.preferences is not None:
        user.preferences = {**(user.preferences or {}), **body.preferences}
    if before["display_name"] != user.display_name:
        audit.record(db, "user.profile_update", actor=user, request=request, resource_type="user", resource_id=user.id,
                     before=before, after={"display_name": user.display_name})
    db.commit()
    return user


@router.post("/password/change", status_code=204)
def change_password(body: PasswordChangeIn, request: Request, sess: UserSession = Depends(get_session), db: Session = Depends(get_db)):
    sess = db.merge(sess)
    user = sess.user
    if not verify_password(user.password_hash, body.current_password):
        audit.record_now("auth.password_change", actor=user, request=request, outcome="failure", details={"reason": "bad_current"})
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Mot de passe actuel incorrect.")
    _check_password(body.new_password, user.email)
    user.password_hash = hash_password(body.new_password)
    user.password_changed_at = utcnow()
    # Other sessions are signed out.
    for other in db.scalars(select(UserSession).where(UserSession.user_id == user.id, UserSession.id != sess.id, UserSession.revoked_at.is_(None))):
        other.revoked_at = utcnow()
    audit.record(db, "auth.password_change", actor=user, request=request, resource_type="user", resource_id=user.id)
    db.commit()


def issue_reset_token(db: Session, user: User) -> str:
    token = new_token()
    db.add(PasswordResetToken(user_id=user.id, token_hash=token_digest(token), expires_at=utcnow() + timedelta(hours=1)))
    return token


@router.post("/password/forgot", status_code=202)
def forgot_password(body: ForgotIn, request: Request, db: Session = Depends(get_db)):
    _throttle(request)
    email = body.email.lower()
    user = db.scalar(select(User).where(func.lower(User.email) == email))
    sent = False
    if user and user.is_active and mail_enabled():
        token = issue_reset_token(db, user)
        db.commit()
        link = f"{settings.public_url}/reset-password?token={token}"
        sent = send_mail(user.email, "My2cents — réinitialisation du mot de passe",
                         f"Bonjour {user.display_name},\n\nPour choisir un nouveau mot de passe (lien valable 1 h) :\n{link}\n\n"
                         "Si vous n'êtes pas à l'origine de cette demande, ignorez ce message.")
    audit.record_now("auth.password_forgot", actor_email=email, request=request,
                     outcome="success" if sent else "failure", details={"known": user is not None, "mail_sent": sent})
    # Same answer whether or not the account exists.
    return {"detail": "Si un compte correspond, un email vient d'être envoyé."}


@router.post("/password/reset", status_code=204)
def reset_password(body: ResetIn, request: Request, db: Session = Depends(get_db)):
    _throttle(request)
    row = db.scalar(select(PasswordResetToken).where(PasswordResetToken.token_hash == token_digest(body.token)))
    if row is None or row.used_at is not None or row.expires_at <= utcnow():
        audit.record_now("auth.password_reset", request=request, outcome="failure", details={"reason": "invalid_token"})
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Lien invalide ou expiré.")
    user = db.get(User, row.user_id)
    _check_password(body.password, user.email)
    user.password_hash = hash_password(body.password)
    user.password_changed_at = utcnow()
    user.failed_logins, user.locked_until = 0, None
    row.used_at = utcnow()
    for s in db.scalars(select(UserSession).where(UserSession.user_id == user.id, UserSession.revoked_at.is_(None))):
        s.revoked_at = utcnow()
    audit.record(db, "auth.password_reset", actor=user, request=request, resource_type="user", resource_id=user.id)
    db.commit()


@router.get("/sessions", response_model=list[SessionOut])
def list_sessions(sess: UserSession = Depends(get_session), db: Session = Depends(get_db)):
    rows = db.scalars(
        select(UserSession).where(
            UserSession.user_id == sess.user_id, UserSession.revoked_at.is_(None), UserSession.expires_at > utcnow()
        ).order_by(UserSession.last_seen_at.desc())
    ).all()
    out = []
    for r in rows:
        o = SessionOut.model_validate(r)
        o.current = r.id == sess.id
        out.append(o)
    return out


@router.delete("/sessions/{session_id}", status_code=204)
def revoke_session(session_id: str, request: Request, sess: UserSession = Depends(get_session), db: Session = Depends(get_db)):
    target = db.scalar(select(UserSession).where(UserSession.id == session_id, UserSession.user_id == sess.user_id))
    if target is None:
        raise HTTPException(404, "Session introuvable")
    target.revoked_at = utcnow()
    audit.record(db, "auth.session_revoke", actor=sess.user, request=request, resource_type="session", resource_id=target.id)
    db.commit()


@router.post("/mfa/setup")
def mfa_setup(user: User = Depends(current_user), db: Session = Depends(get_db)):
    user = db.merge(user)
    if user.totp_enabled:
        raise HTTPException(400, "La double authentification est déjà active.")
    user.totp_secret = new_totp_secret()
    db.commit()
    return {"secret": user.totp_secret, "uri": totp_uri(user.totp_secret, user.email)}


@router.post("/mfa/enable", response_model=UserOut)
def mfa_enable(body: CodeIn, request: Request, user: User = Depends(current_user), db: Session = Depends(get_db)):
    user = db.merge(user)
    if not user.totp_secret or not verify_totp(user.totp_secret, body.code):
        raise HTTPException(400, "Code invalide : vérifiez l'heure de votre téléphone et réessayez.")
    user.totp_enabled = True
    audit.record(db, "auth.mfa_enable", actor=user, request=request, resource_type="user", resource_id=user.id)
    db.commit()
    return user


@router.post("/mfa/disable", response_model=UserOut)
def mfa_disable(body: MfaDisableIn, request: Request, user: User = Depends(current_user), db: Session = Depends(get_db)):
    user = db.merge(user)
    if not verify_password(user.password_hash, body.password) or not verify_totp(user.totp_secret or "", body.code):
        audit.record_now("auth.mfa_disable", actor=user, request=request, outcome="failure")
        raise HTTPException(400, "Mot de passe ou code invalide.")
    user.totp_enabled, user.totp_secret = False, None
    audit.record(db, "auth.mfa_disable", actor=user, request=request, resource_type="user", resource_id=user.id)
    db.commit()
    return user
