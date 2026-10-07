from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import String, cast, func, or_, select
from sqlalchemy.orm import Session

from .. import audit
from ..config import get_settings
from ..db import get_db
from ..deps import require
from ..models import AuditEvent, Role, User, UserSession, utcnow
from ..rbac import PERMISSION_LABELS, Perm
from ..schemas import AdminUserPatch, AuditOut, RoleIn, RoleOut, UserOut
from .auth import issue_reset_token

router = APIRouter(tags=["admin"])
settings = get_settings()


def _page(total: int, page: int, size: int, items: list) -> dict:
    return {"items": items, "total": total, "page": page, "page_size": size, "pages": max((total + size - 1) // size, 1)}


@router.get("/admin/permissions")
def permissions(_: User = Depends(require(Perm.ROLE_ADMIN))):
    return [{"key": p.value, "label": PERMISSION_LABELS[p]} for p in Perm]


@router.get("/admin/roles", response_model=list[RoleOut])
def roles(_: User = Depends(require(Perm.USER_ADMIN)), db: Session = Depends(get_db)):
    return db.scalars(select(Role).order_by(Role.id)).all()


@router.put("/admin/roles/{name}", response_model=RoleOut)
def upsert_role(name: str, body: RoleIn, request: Request, admin: User = Depends(require(Perm.ROLE_ADMIN)), db: Session = Depends(get_db)):
    name = name.strip().upper()
    if not name.replace("_", "").isalnum() or len(name) > 40:
        raise HTTPException(422, "Nom de rôle invalide (lettres, chiffres, _).")
    unknown = [p for p in body.permissions if p not in {x.value for x in Perm}]
    if unknown:
        raise HTTPException(422, f"Permissions inconnues : {', '.join(unknown)}")
    if name == "ADMIN":
        raise HTTPException(400, "Le rôle ADMIN n'est pas modifiable.")
    role = db.scalar(select(Role).where(Role.name == name))
    before = None
    if role is None:
        role = Role(name=name, is_system=False, permissions=[])
        db.add(role)
    else:
        before = {"description": role.description, "permissions": sorted(role.permissions)}
    role.description = body.description
    role.permissions = sorted(set(body.permissions))
    db.flush()
    audit.record(db, "role.upsert", actor=admin, request=request, resource_type="role", resource_id=name,
                 before=before, after={"description": role.description, "permissions": role.permissions})
    db.commit()
    return role


@router.get("/admin/users")
def list_users(
    q: str | None = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=200),
    _: User = Depends(require(Perm.USER_ADMIN)),
    db: Session = Depends(get_db),
):
    stmt = select(User)
    if q:
        like = f"%{q.lower()}%"
        stmt = stmt.where(or_(func.lower(User.email).like(like), func.lower(User.display_name).like(like)))
    total = db.scalar(select(func.count()).select_from(stmt.subquery()))
    rows = db.scalars(stmt.order_by(User.created_at.desc()).offset((page - 1) * page_size).limit(page_size)).all()
    return _page(total, page, page_size, [UserOut.model_validate(u) for u in rows])


@router.patch("/admin/users/{user_id}", response_model=UserOut)
def patch_user(user_id: str, body: AdminUserPatch, request: Request, admin: User = Depends(require(Perm.USER_ADMIN)), db: Session = Depends(get_db)):
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(404, "Utilisateur introuvable")
    before = {"is_active": user.is_active, "roles": user.role_names, "display_name": user.display_name}
    if body.roles is not None:
        if "ADMIN" in user.role_names and "ADMIN" not in body.roles:
            others = db.scalar(
                select(func.count()).select_from(User).join(User.roles).where(Role.name == "ADMIN", User.id != user.id, User.is_active)
            )
            if not others:
                raise HTTPException(400, "Impossible de retirer le dernier administrateur.")
        roles = db.scalars(select(Role).where(Role.name.in_(body.roles))).all()
        if len(roles) != len(set(body.roles)):
            raise HTTPException(422, "Rôle inconnu.")
        user.roles = list(roles)
    if body.is_active is not None:
        if user.id == admin.id and not body.is_active:
            raise HTTPException(400, "Vous ne pouvez pas désactiver votre propre compte.")
        user.is_active = body.is_active
        if not body.is_active:
            for s in db.scalars(select(UserSession).where(UserSession.user_id == user.id, UserSession.revoked_at.is_(None))):
                s.revoked_at = utcnow()
    if body.display_name is not None:
        user.display_name = body.display_name
    after = {"is_active": user.is_active, "roles": user.role_names, "display_name": user.display_name}
    action = "user.permissions_change" if before["roles"] != after["roles"] else "user.update"
    audit.record(db, action, actor=admin, request=request, resource_type="user", resource_id=user.id, before=before, after=after)
    db.commit()
    return user


@router.post("/admin/users/{user_id}/reset-link")
def admin_reset_link(user_id: str, request: Request, admin: User = Depends(require(Perm.USER_ADMIN)), db: Session = Depends(get_db)):
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(404, "Utilisateur introuvable")
    token = issue_reset_token(db, user)
    audit.record(db, "user.reset_link_issued", actor=admin, request=request, resource_type="user", resource_id=user.id)
    db.commit()
    return {"link": f"{settings.public_url}/reset-password?token={token}", "expires_in_minutes": 60}


@router.post("/admin/users/{user_id}/revoke-sessions", status_code=204)
def admin_revoke(user_id: str, request: Request, admin: User = Depends(require(Perm.USER_ADMIN)), db: Session = Depends(get_db)):
    n = 0
    for s in db.scalars(select(UserSession).where(UserSession.user_id == user_id, UserSession.revoked_at.is_(None))):
        s.revoked_at = utcnow()
        n += 1
    audit.record(db, "user.sessions_revoked", actor=admin, request=request, resource_type="user", resource_id=user_id, details={"count": n})
    db.commit()


# ----------------------------------------------------------------- audit


@router.get("/audit")
def audit_events(
    q: str | None = None,
    actor: str | None = None,
    action: str | None = None,
    resource_type: str | None = None,
    resource_id: str | None = None,
    outcome: str | None = None,
    date_from: datetime | None = Query(None, alias="from"),
    date_to: datetime | None = Query(None, alias="to"),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=500),
    _: User = Depends(require(Perm.AUDIT_READ)),
    db: Session = Depends(get_db),
):
    stmt = select(AuditEvent)
    if q:
        like = f"%{q.lower()}%"
        stmt = stmt.where(or_(
            func.lower(AuditEvent.action).like(like), func.lower(AuditEvent.actor_email).like(like),
            func.lower(AuditEvent.resource_id).like(like), AuditEvent.ip.like(like),
            func.lower(cast(AuditEvent.details, String)).like(like),
        ))
    if actor:
        stmt = stmt.where(func.lower(AuditEvent.actor_email).like(f"%{actor.lower()}%"))
    if action:
        stmt = stmt.where(AuditEvent.action.like(f"{action}%"))
    if resource_type:
        stmt = stmt.where(AuditEvent.resource_type == resource_type)
    if resource_id:
        stmt = stmt.where(AuditEvent.resource_id == resource_id)
    if outcome:
        stmt = stmt.where(AuditEvent.outcome == outcome)
    if date_from:
        stmt = stmt.where(AuditEvent.occurred_at >= date_from)
    if date_to:
        stmt = stmt.where(AuditEvent.occurred_at <= date_to)
    total = db.scalar(select(func.count()).select_from(stmt.subquery()))
    rows = db.scalars(stmt.order_by(AuditEvent.id.desc()).offset((page - 1) * page_size).limit(page_size)).all()
    return _page(total, page, page_size, [AuditOut.model_validate(r) for r in rows])


@router.get("/audit/facets")
def audit_facets(_: User = Depends(require(Perm.AUDIT_READ)), db: Session = Depends(get_db)):
    return {
        "actions": db.scalars(select(AuditEvent.action).distinct().order_by(AuditEvent.action)).all(),
        "resource_types": [r for r in db.scalars(select(AuditEvent.resource_type).distinct()).all() if r],
        "outcomes": ["success", "failure", "denied"],
    }


@router.get("/audit/verify")
def audit_verify(request: Request, admin: User = Depends(require(Perm.AUDIT_READ)), db: Session = Depends(get_db)):
    result = audit.verify_chain(db)
    audit.record(db, "audit.verify", actor=admin, request=request, details=result, outcome="success" if result["valid"] else "failure")
    db.commit()
    return result
