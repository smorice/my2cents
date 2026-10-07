import uuid
from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .. import accounts as svc
from .. import audit, jobs
from ..db import get_db
from ..deps import require
from ..mailer import mail_enabled
from ..marketdata.service import sync_symbol
from ..models import AccountMovement, Instrument, Job, OrderProposal, PriceBar, ProposedOrder, RealAccount, RealPosition, User, utcnow
from ..rbac import Perm
from ..schemas import AccountIn, AccountPatch, FillIn, MovementIn, PositionIn
from .jobs import job_out
from .strategies import get_visible

router = APIRouter(prefix="/accounts", tags=["accounts"])

FREQ_FR = {"daily": "chaque jour", "weekly": "chaque semaine", "monthly": "chaque mois", "quarterly": "chaque trimestre",
           "yearly": "chaque année", "never": "jamais (achat puis conservation)"}


def _own(db: Session, user: User, aid: uuid.UUID) -> RealAccount:
    a = db.get(RealAccount, aid)
    if a is None or a.owner_id != user.id:
        raise HTTPException(404, "Compte introuvable")
    return a


def _snap(a: RealAccount) -> dict:
    return {"name": a.name, "strategy_id": str(a.strategy_id) if a.strategy_id else None, "strategy_version": a.strategy_version,
            "cash": a.cash, "fee_pct": a.fee_pct, "fee_min": a.fee_min, "fractional": a.fractional,
            "min_order_value": a.min_order_value, "auto_review": a.auto_review, "notify_email": a.notify_email, "archived": a.archived}


def _last_prices(db: Session, symbols: list[str]) -> dict[str, tuple[float, date]]:
    """Last actual close of each symbol."""
    if not symbols:
        return {}
    last = (select(PriceBar.symbol, func.max(PriceBar.date).label("d")).where(PriceBar.symbol.in_(symbols))
            .group_by(PriceBar.symbol).subquery())
    rows = db.execute(select(PriceBar.symbol, PriceBar.close, PriceBar.date)
                      .join(last, (PriceBar.symbol == last.c.symbol) & (PriceBar.date == last.c.d))).all()
    return {s: (c, d) for s, c, d in rows}


def _valuation(db: Session, a: RealAccount) -> dict:
    held = svc.positions(db, a)
    px = _last_prices(db, [p.symbol for p in held])
    names = dict(db.execute(select(Instrument.symbol, Instrument.name).where(Instrument.symbol.in_([p.symbol for p in held]))).all())
    lines, invested = [], 0.0
    for p in held:
        price, on = px.get(p.symbol, (None, None))
        value = None if price is None else p.qty * price
        invested += value or 0.0
        lines.append({"symbol": p.symbol, "name": names.get(p.symbol, p.symbol), "qty": p.qty, "avg_cost": p.avg_cost,
                      "locked": p.locked, "price": price, "price_date": on, "value": value,
                      "pnl": None if value is None or not p.avg_cost else value - p.qty * p.avg_cost,
                      "pnl_pct": None if price is None or not p.avg_cost else price / p.avg_cost - 1})
    total = invested + a.cash
    for line in lines:
        line["weight"] = None if line["value"] is None or total <= 0 else line["value"] / total
    return {"positions": lines, "invested": invested, "total": total}


def _proposal_out(db: Session, p: OrderProposal, benchmark: str | None = None) -> dict:
    symbols = list({o.symbol for o in p.orders} | {d["symbol"] for d in p.decisions} | ({benchmark} if benchmark else set()))
    names = dict(db.execute(select(Instrument.symbol, Instrument.name).where(Instrument.symbol.in_(symbols))).all())
    return {
        "id": str(p.id), "created_at": p.created_at, "as_of": p.as_of, "trigger": p.trigger, "mode": p.mode, "status": p.status,
        "strategy_version": p.strategy_version, "value": p.value, "cash": p.cash, "cash_after": p.cash_after,
        "warnings": p.warnings, "emailed_at": p.emailed_at, "names": names,
        "decisions": p.decisions,
        "orders": [{
            "id": str(o.id), "seq": o.seq, "side": o.side, "symbol": o.symbol, "qty": o.qty, "price": o.price, "value": o.value,
            "fee_estimate": o.fee_estimate, "action": o.action, "prev_weight": o.prev_weight, "target_weight": o.target_weight,
            "reason": o.reason, "explain": o.explain, "status": o.status, "resolved_at": o.resolved_at,
        } for o in p.orders],
    }


def _latest_proposal(db: Session, a: RealAccount) -> OrderProposal | None:
    return db.scalar(select(OrderProposal).where(OrderProposal.account_id == a.id).order_by(OrderProposal.created_at.desc()).limit(1))


def _pending_job(db: Session, a: RealAccount) -> Job | None:
    return db.scalar(select(Job).where(Job.kind == "account_review", Job.payload["account_id"].astext == str(a.id),
                                       Job.status.in_(["queued", "running"])).limit(1))


def _out(db: Session, a: RealAccount, full: bool = False) -> dict:
    val = _valuation(db, a)
    prop = _latest_proposal(db, a)
    d = None
    if a.strategy is not None:
        try:
            d = svc.definition(a)
        except jobs.UserFacingError:
            d = None
    out = {
        **_snap(a), "id": str(a.id), "currency": a.currency, "created_at": a.created_at, "updated_at": a.updated_at,
        "last_review_at": a.last_review_at, "last_full_on": a.last_full_on,
        "strategy_name": a.strategy.name if a.strategy else None, "strategy_kind": a.strategy.kind if a.strategy else None,
        "strategy_current_version": a.strategy.current_version if a.strategy else None,
        "rebalance": d["rebalance_frequency"] if d else None,
        "rebalance_label": FREQ_FR.get(d["rebalance_frequency"]) if d else None,
        "benchmark": d["benchmark"] if d else None,
        "invested": val["invested"], "total": val["total"],
        "pending_orders": 0 if prop is None or prop.status != "open" else sum(o.status == "pending" for o in prop.orders),
        "latest_proposal_at": prop.created_at if prop else None,
    }
    if full:
        job = _pending_job(db, a)
        out.update(positions=val["positions"], latest_proposal=_proposal_out(db, prop, d["benchmark"] if d else None) if prop else None,
                   mail_enabled=mail_enabled(), review_job=job_out(job) if job else None,
                   universe=svc.universe_of(d) if d else [])
    return out


def _check_symbol(db: Session, symbol: str) -> None:
    if db.get(Instrument, symbol) is not None:
        return
    try:
        sync_symbol(db, symbol)
    except Exception as exc:  # noqa: BLE001 - unknown ticker, provider down
        raise HTTPException(422, f"Titre inconnu ou sans cotation : {symbol} ({exc})") from exc


@router.get("")
def list_accounts(user: User = Depends(require(Perm.PORTFOLIO_READ)), db: Session = Depends(get_db)):
    rows = db.scalars(select(RealAccount).where(RealAccount.owner_id == user.id, RealAccount.archived.is_(False))
                      .order_by(RealAccount.created_at)).unique().all()
    return [_out(db, a) for a in rows]


@router.post("", status_code=201)
def create_account(body: AccountIn, request: Request, user: User = Depends(require(Perm.PORTFOLIO_WRITE)), db: Session = Depends(get_db)):
    a = RealAccount(owner_id=user.id, **{**body.model_dump(exclude={"strategy_id"}), "name": body.name.strip()})
    if body.strategy_id:
        a.strategy_id = get_visible(db, user, body.strategy_id).id
    db.add(a)
    db.flush()
    if a.cash:
        db.add(AccountMovement(account_id=a.id, date=date.today(), kind="deposit", amount=a.cash, note="Liquidités à l'ouverture"))
    audit.record(db, "account.create", actor=user, request=request, resource_type="real_account", resource_id=a.id, after=_snap(a))
    db.commit()
    db.refresh(a)
    return _out(db, a, full=True)


@router.get("/{aid}")
def get_account(aid: uuid.UUID, user: User = Depends(require(Perm.PORTFOLIO_READ)), db: Session = Depends(get_db)):
    return _out(db, _own(db, user, aid), full=True)


@router.patch("/{aid}")
def patch_account(aid: uuid.UUID, body: AccountPatch, request: Request, user: User = Depends(require(Perm.PORTFOLIO_WRITE)),
                  db: Session = Depends(get_db)):
    a = _own(db, user, aid)
    before = _snap(a)
    if body.strategy_id is not None and body.strategy_id != a.strategy_id:
        a.strategy_id = get_visible(db, user, body.strategy_id).id
        # A new strategy starts from a clean memory and is evaluated in full at the next review.
        a.strategy_state, a.last_targets, a.last_full_on = {}, None, None
    if "strategy_version" in body.model_fields_set and body.strategy_version != a.strategy_version:
        a.strategy_version = body.strategy_version
        a.last_full_on = None
    for f in ("name", "cash", "fee_pct", "fee_min", "fractional", "min_order_value", "auto_review", "notify_email", "archived"):
        v = getattr(body, f)
        if v is not None:
            setattr(a, f, v.strip() if f == "name" else v)
    a.updated_at = utcnow()
    audit.record(db, "account.update", actor=user, request=request, resource_type="real_account", resource_id=a.id,
                 before=before, after=_snap(a))
    db.commit()
    db.expire(a)
    return _out(db, _own(db, user, aid), full=True)


@router.delete("/{aid}", status_code=204)
def delete_account(aid: uuid.UUID, request: Request, user: User = Depends(require(Perm.PORTFOLIO_WRITE)), db: Session = Depends(get_db)):
    a = _own(db, user, aid)
    audit.record(db, "account.delete", actor=user, request=request, resource_type="real_account", resource_id=a.id, before=_snap(a))
    db.delete(a)
    db.commit()


@router.put("/{aid}/positions")
def put_positions(aid: uuid.UUID, body: list[PositionIn], request: Request, user: User = Depends(require(Perm.PORTFOLIO_WRITE)),
                  db: Session = Depends(get_db)):
    """Replace the holdings (initial entry or correction). Executed orders update them automatically."""
    a = _own(db, user, aid)
    if len({p.symbol for p in body}) != len(body):
        raise HTTPException(422, "Chaque titre ne peut apparaître qu'une fois.")
    if len(body) > 200:
        raise HTTPException(422, "200 lignes au maximum.")
    for p in body:
        _check_symbol(db, p.symbol)
    before = [{"symbol": p.symbol, "qty": p.qty, "avg_cost": p.avg_cost, "locked": p.locked} for p in svc.positions(db, a)]
    for p in svc.positions(db, a):
        db.delete(p)
    db.flush()
    for p in body:
        db.add(RealPosition(account_id=a.id, **p.model_dump()))
    a.updated_at = utcnow()
    audit.record(db, "account.positions", actor=user, request=request, resource_type="real_account", resource_id=a.id,
                 before={"positions": before}, after={"positions": [p.model_dump() for p in body]})
    db.commit()
    return _out(db, a, full=True)


@router.get("/{aid}/movements")
def list_movements(aid: uuid.UUID, limit: int = 200, user: User = Depends(require(Perm.PORTFOLIO_READ)), db: Session = Depends(get_db)):
    a = _own(db, user, aid)
    rows = db.scalars(select(AccountMovement).where(AccountMovement.account_id == a.id)
                      .order_by(AccountMovement.date.desc(), AccountMovement.id.desc()).limit(min(limit, 1000))).all()
    return [{"id": m.id, "date": m.date, "kind": m.kind, "symbol": m.symbol, "qty": m.qty, "price": m.price, "fees": m.fees,
             "amount": m.amount, "realized_pnl": m.realized_pnl, "order_id": str(m.order_id) if m.order_id else None, "note": m.note}
            for m in rows]


@router.post("/{aid}/movements", status_code=201)
def add_movement(aid: uuid.UUID, body: MovementIn, request: Request, user: User = Depends(require(Perm.PORTFOLIO_WRITE)),
                 db: Session = Depends(get_db)):
    a = _own(db, user, aid)
    if body.kind in ("buy", "sell"):
        _check_symbol(db, body.symbol)
        mv = svc.apply_fill(db, a, body.kind, body.symbol, body.qty, body.price, body.fees, body.date, note=body.note)
    else:
        amount = body.amount if body.kind == "deposit" else -body.amount
        if a.cash + amount < -0.005:
            raise HTTPException(422, f"Retrait supérieur aux liquidités ({a.cash:.2f} €).")
        a.cash += amount
        mv = AccountMovement(account_id=a.id, date=body.date, kind=body.kind, amount=amount, note=body.note)
        db.add(mv)
    a.updated_at = utcnow()
    db.flush()
    audit.record(db, f"account.{body.kind}", actor=user, request=request, resource_type="real_account", resource_id=a.id,
                 after=body.model_dump(mode="json"))
    db.commit()
    return _out(db, a, full=True)


@router.post("/{aid}/review", status_code=202)
def request_review(aid: uuid.UUID, full: bool = True, user: User = Depends(require(Perm.PORTFOLIO_WRITE)), db: Session = Depends(get_db)):
    """Queue a review now. `full` evaluates the strategy even outside its rebalance days."""
    a = _own(db, user, aid)
    if a.strategy_id is None:
        raise HTTPException(409, "Choisissez d'abord une stratégie pour ce compte.")
    job = _pending_job(db, a) or jobs.enqueue(db, "account_review", {"account_id": str(a.id), "force_full": full},
                                              owner_id=user.id, message="Calcul des ordres")
    db.commit()
    return job_out(job)


@router.get("/{aid}/proposals")
def list_proposals(aid: uuid.UUID, limit: int = 30, user: User = Depends(require(Perm.PORTFOLIO_READ)), db: Session = Depends(get_db)):
    a = _own(db, user, aid)
    rows = db.scalars(select(OrderProposal).where(OrderProposal.account_id == a.id)
                      .order_by(OrderProposal.created_at.desc()).limit(min(limit, 200))).all()
    return [{"id": str(p.id), "created_at": p.created_at, "as_of": p.as_of, "trigger": p.trigger, "mode": p.mode,
             "status": p.status, "orders": len(p.orders), "executed": sum(o.status == "executed" for o in p.orders),
             "emailed_at": p.emailed_at} for p in rows]


@router.get("/{aid}/proposals/{pid}")
def get_proposal(aid: uuid.UUID, pid: uuid.UUID, user: User = Depends(require(Perm.PORTFOLIO_READ)), db: Session = Depends(get_db)):
    a = _own(db, user, aid)
    p = db.get(OrderProposal, pid)
    if p is None or p.account_id != a.id:
        raise HTTPException(404, "Proposition introuvable")
    return _proposal_out(db, p)


def _order(db: Session, a: RealAccount, oid: uuid.UUID) -> tuple[ProposedOrder, OrderProposal]:
    o = db.get(ProposedOrder, oid)
    p = None if o is None else db.get(OrderProposal, o.proposal_id)
    if p is None or p.account_id != a.id:
        raise HTTPException(404, "Ordre introuvable")
    if o.status != "pending":
        raise HTTPException(409, "Cet ordre a déjà été traité.")
    if p.status != "open":
        raise HTTPException(409, "Cette proposition a été remplacée par une plus récente : relancez le calcul si besoin.")
    return o, p


@router.post("/{aid}/orders/{oid}/execute")
def execute_order(aid: uuid.UUID, oid: uuid.UUID, body: FillIn, request: Request, user: User = Depends(require(Perm.PORTFOLIO_WRITE)),
                  db: Session = Depends(get_db)):
    """Record that the user placed this order with their broker, at the actual quantity and price."""
    a = _own(db, user, aid)
    o, p = _order(db, a, oid)
    svc.apply_fill(db, a, o.side, o.symbol, body.qty, body.price, body.fees, body.date, order_id=o.id, note="Ordre proposé exécuté")
    o.status, o.resolved_at = "executed", utcnow()
    svc.close_if_done(db, p)
    audit.record(db, "account.order_executed", actor=user, request=request, resource_type="real_account", resource_id=a.id,
                 details={"order_id": str(o.id), "side": o.side, "symbol": o.symbol, "proposed_qty": o.qty, "proposed_price": o.price,
                          **body.model_dump(mode="json")})
    db.commit()
    return _out(db, a, full=True)


@router.post("/{aid}/orders/{oid}/skip")
def skip_order(aid: uuid.UUID, oid: uuid.UUID, request: Request, user: User = Depends(require(Perm.PORTFOLIO_WRITE)),
               db: Session = Depends(get_db)):
    a = _own(db, user, aid)
    o, p = _order(db, a, oid)
    o.status, o.resolved_at = "skipped", utcnow()
    svc.close_if_done(db, p)
    audit.record(db, "account.order_skipped", actor=user, request=request, resource_type="real_account", resource_id=a.id,
                 details={"order_id": str(o.id), "side": o.side, "symbol": o.symbol, "qty": o.qty})
    db.commit()
    return _out(db, a, full=True)
