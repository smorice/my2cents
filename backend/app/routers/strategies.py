import uuid

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import or_, select
from sqlalchemy.orm import Session, defer

from .. import audit
from ..db import get_db
from ..deps import require
from ..marketdata.catalog import UNIVERSES
from ..engine.strategies.library import REGISTRY, build
from ..models import Backtest, Strategy, StrategyVersion, User, utcnow
from ..rbac import Perm
from ..schemas import CloneIn, StatusIn, StrategyCreate, StrategyDefinition, StrategyOut, StrategyUpdate, VersionOut

router = APIRouter(prefix="/strategies", tags=["strategies"])

FREQ_LABELS = {
    "daily": "chaque jour", "weekly": "chaque semaine", "monthly": "chaque mois",
    "quarterly": "chaque trimestre", "yearly": "chaque année", "never": "jamais (achat initial uniquement)",
}


def normalise_definition(kind: str, definition: StrategyDefinition) -> dict:
    """Validate parameters against the strategy kind and return a canonical dict."""
    try:
        strat = build(kind, definition.parameters)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    d = definition.model_dump()
    d["parameters"] = strat.p
    if not d["universe"]["symbols"] and d["universe"]["preset"] not in UNIVERSES:
        raise HTTPException(422, "Univers vide : choisissez un univers prédéfini ou ajoutez des symboles.")
    if kind == "fixed_allocation":
        # The allocation's symbols are the universe.
        d["universe"] = {"preset": None, "symbols": sorted(strat.p["weights"])}
    return d


def rules_for(kind: str, d: dict) -> list[str]:
    cls = REGISTRY.get(kind)
    if cls is None:
        return []
    labels = {p.key: p for p in cls.params}
    out = [cls.summary]
    for k, v in d.get("parameters", {}).items():
        p = labels.get(k)
        if p is None:
            continue
        if isinstance(v, bool):
            v = "oui" if v else "non"
        elif isinstance(v, dict):
            v = ", ".join(f"{s} {w:g} %" for s, w in v.items())
        out.append(f"{p.label} : {v}{(' ' + p.unit) if p.unit and not isinstance(v, str) else ''}")
    u = d.get("universe", {})
    if u.get("symbols"):
        out.append(f"Univers : {len(u['symbols'])} actif(s) — {', '.join(u['symbols'][:8])}{'…' if len(u['symbols']) > 8 else ''}")
    elif u.get("preset"):
        out.append(f"Univers : {UNIVERSES.get(u['preset'], {}).get('label', u['preset'])}")
    out.append(f"Indice de référence : {d.get('benchmark')}")
    out.append(f"Rééquilibrage : {FREQ_LABELS.get(d.get('rebalance_frequency'), d.get('rebalance_frequency'))}")
    c = d.get("transaction_cost_model", {})
    out.append(f"Frais : {c.get('fee_pct', 0):g} % (min {c.get('fee_min', 0):g} €), slippage {c.get('slippage_bps', 0):g} pb")
    r = d.get("risk_model", {})
    risk = []
    if r.get("max_weight_pct", 100) < 100:
        risk.append(f"{r['max_weight_pct']:g} % max par ligne")
    if r.get("cash_buffer_pct"):
        risk.append(f"{r['cash_buffer_pct']:g} % de liquidités")
    if r.get("stop_loss_pct"):
        risk.append(f"stop-loss à −{r['stop_loss_pct']:g} %")
    out.append("Risque : " + (", ".join(risk) if risk else "aucune contrainte"))
    return out


def can_edit(user: User, s: Strategy) -> bool:
    if s.is_template:
        return Perm.STRATEGY_MANAGE_TEMPLATES in user.permissions
    return s.owner_id == user.id and Perm.STRATEGY_UPDATE in user.permissions


def get_visible(db: Session, user: User, strategy_id: uuid.UUID | str) -> Strategy:
    s = db.get(Strategy, strategy_id)
    if s is None or s.deleted_at is not None or not (s.is_template or s.owner_id == user.id):
        raise HTTPException(404, "Stratégie introuvable")
    return s


def snapshot(s: Strategy) -> dict:
    return {"name": s.name, "description": s.description, "status": s.status, "version": s.current_version}


def to_out(s: Strategy, user: User, last_bt: Backtest | None = None, with_def: bool = True) -> StrategyOut:
    o = StrategyOut.model_validate(s)
    o.author = s.owner.display_name if s.owner else "My2cents"
    cur = next((v for v in s.versions if v.version == s.current_version), None)
    if cur and with_def:
        o.definition = cur.definition
        o.rules = rules_for(s.kind, cur.definition)
    o.can_edit = can_edit(user, s)
    if last_bt is not None:
        o.last_backtest = {"id": str(last_bt.id), "created_at": last_bt.created_at.isoformat(), "summary": (last_bt.summary or {}).get("strategy")}
    return o


@router.get("/catalog")
def catalog(_: User = Depends(require(Perm.STRATEGY_READ))):
    return [cls.describe() for cls in REGISTRY.values()]


@router.get("", response_model=list[StrategyOut])
def list_strategies(include_archived: bool = False, user: User = Depends(require(Perm.STRATEGY_READ)), db: Session = Depends(get_db)):
    stmt = select(Strategy).where(Strategy.deleted_at.is_(None), or_(Strategy.is_template, Strategy.owner_id == user.id))
    if not include_archived:
        stmt = stmt.where(Strategy.status != "archived")
    rows = db.scalars(stmt.order_by(Strategy.is_template.desc(), Strategy.updated_at.desc())).unique().all()
    last = {
        b.strategy_id: b
        for b in db.scalars(
            select(Backtest).options(defer(Backtest.results), defer(Backtest.config))
            .where(Backtest.owner_id == user.id, Backtest.status == "done", Backtest.portfolio_id.is_(None))
            .order_by(Backtest.strategy_id, Backtest.created_at.desc()).distinct(Backtest.strategy_id)
        ).unique().all()
    }
    return [to_out(s, user, last.get(s.id)) for s in rows]


@router.post("", response_model=StrategyOut, status_code=201)
def create_strategy(body: StrategyCreate, request: Request, user: User = Depends(require(Perm.STRATEGY_CREATE)), db: Session = Depends(get_db)):
    if body.kind not in REGISTRY:
        raise HTTPException(422, "Type de stratégie inconnu")
    definition = normalise_definition(body.kind, body.definition)
    s = Strategy(owner_id=user.id, name=body.name.strip(), description=body.description, kind=body.kind, status="active", current_version=1)
    db.add(s)
    db.flush()
    db.add(StrategyVersion(strategy_id=s.id, version=1, definition=definition, change_note="Création", created_by=user.id))
    audit.record(db, "strategy.create", actor=user, request=request, resource_type="strategy", resource_id=s.id,
                 after={**snapshot(s), "kind": s.kind, "definition": definition})
    db.commit()
    db.refresh(s)
    return to_out(s, user)


@router.get("/{strategy_id}", response_model=StrategyOut)
def get_strategy(strategy_id: uuid.UUID, user: User = Depends(require(Perm.STRATEGY_READ)), db: Session = Depends(get_db)):
    return to_out(get_visible(db, user, strategy_id), user)


@router.get("/{strategy_id}/versions", response_model=list[VersionOut])
def versions(strategy_id: uuid.UUID, user: User = Depends(require(Perm.STRATEGY_READ)), db: Session = Depends(get_db)):
    s = get_visible(db, user, strategy_id)
    return sorted(s.versions, key=lambda v: -v.version)


@router.put("/{strategy_id}", response_model=StrategyOut)
def update_strategy(strategy_id: uuid.UUID, body: StrategyUpdate, request: Request, user: User = Depends(require(Perm.STRATEGY_READ)), db: Session = Depends(get_db)):
    s = get_visible(db, user, strategy_id)
    if not can_edit(user, s):
        audit.record_now("strategy.update", actor=user, request=request, resource_type="strategy", resource_id=s.id, outcome="denied")
        raise HTTPException(403, "Vous ne pouvez pas modifier cette stratégie (clonez-la pour l'adapter).")
    if s.status == "archived":
        raise HTTPException(409, "Stratégie archivée : désarchivez-la avant de la modifier.")
    if body.expected_version is not None and body.expected_version != s.current_version:
        raise HTTPException(409, f"La stratégie a été modifiée entre-temps (version {s.current_version}). Rechargez la page.")
    before = snapshot(s)
    cur = next(v for v in s.versions if v.version == s.current_version)
    if body.name is not None:
        s.name = body.name.strip()
    if body.description is not None:
        s.description = body.description
    new_def = None
    if body.definition is not None:
        new_def = normalise_definition(s.kind, body.definition)
        if new_def != cur.definition:
            # Never overwrite: every change to the definition is a new immutable version.
            s.current_version += 1
            db.add(StrategyVersion(strategy_id=s.id, version=s.current_version, definition=new_def,
                                   change_note=body.change_note or f"Version {s.current_version}", created_by=user.id))
        else:
            new_def = None
    s.updated_at = utcnow()
    audit.record(db, "strategy.update", actor=user, request=request, resource_type="strategy", resource_id=s.id,
                 before={**before, "definition": cur.definition if new_def else None},
                 after={**snapshot(s), "definition": new_def}, details={"change_note": body.change_note} if body.change_note else None)
    db.commit()
    db.refresh(s)
    return to_out(s, user)


@router.post("/{strategy_id}/clone", response_model=StrategyOut, status_code=201)
def clone_strategy(strategy_id: uuid.UUID, body: CloneIn, request: Request, user: User = Depends(require(Perm.STRATEGY_CREATE)), db: Session = Depends(get_db)):
    src = get_visible(db, user, strategy_id)
    cur = next(v for v in src.versions if v.version == src.current_version)
    s = Strategy(owner_id=user.id, name=(body.name or f"{src.name} (copie)").strip(), description=src.description,
                 kind=src.kind, status="active", current_version=1, cloned_from=src.id)
    db.add(s)
    db.flush()
    db.add(StrategyVersion(strategy_id=s.id, version=1, definition=cur.definition,
                           change_note=f"Clonée depuis « {src.name} » v{src.current_version}", created_by=user.id))
    audit.record(db, "strategy.clone", actor=user, request=request, resource_type="strategy", resource_id=s.id,
                 after=snapshot(s), details={"source_id": str(src.id), "source_version": src.current_version})
    db.commit()
    db.refresh(s)
    return to_out(s, user)


@router.post("/{strategy_id}/status", response_model=StrategyOut)
def set_status(strategy_id: uuid.UUID, body: StatusIn, request: Request, user: User = Depends(require(Perm.STRATEGY_READ)), db: Session = Depends(get_db)):
    s = get_visible(db, user, strategy_id)
    if not can_edit(user, s):
        audit.record_now("strategy.status", actor=user, request=request, resource_type="strategy", resource_id=s.id, outcome="denied")
        raise HTTPException(403, "Permission insuffisante")
    before = s.status
    s.status = body.status
    s.updated_at = utcnow()
    audit.record(db, "strategy.status", actor=user, request=request, resource_type="strategy", resource_id=s.id,
                 before={"status": before}, after={"status": s.status})
    db.commit()
    return to_out(s, user)


@router.delete("/{strategy_id}", status_code=204)
def delete_strategy(strategy_id: uuid.UUID, request: Request, user: User = Depends(require(Perm.STRATEGY_DELETE)), db: Session = Depends(get_db)):
    s = get_visible(db, user, strategy_id)
    if s.is_template or s.owner_id != user.id:
        audit.record_now("strategy.delete", actor=user, request=request, resource_type="strategy", resource_id=s.id, outcome="denied")
        raise HTTPException(403, "Seul l'auteur peut supprimer sa stratégie ; les modèles ne sont pas supprimables.")
    # Soft delete: versions and past backtests stay intact for traceability.
    s.deleted_at = utcnow()
    s.status = "archived"
    audit.record(db, "strategy.delete", actor=user, request=request, resource_type="strategy", resource_id=s.id, before=snapshot(s))
    db.commit()
