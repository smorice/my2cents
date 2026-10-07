import csv
import io
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from sqlalchemy import func, select
from sqlalchemy.orm import Session, defer

from .. import audit, runner
from ..db import get_db
from ..deps import require
from ..models import Backtest, User
from ..rbac import Perm
from ..schemas import BacktestIn, BacktestListOut, BatchIn
from .strategies import get_visible

router = APIRouter(prefix="/backtests", tags=["backtests"])


def _own(db: Session, user: User, backtest_id: uuid.UUID) -> Backtest:
    bt = db.get(Backtest, backtest_id)
    if bt is None or bt.owner_id != user.id:
        raise HTTPException(404, "Backtest introuvable")
    return bt


def _list_out(bt: Backtest) -> BacktestListOut:
    o = BacktestListOut.model_validate(bt)
    o.strategy_name = bt.strategy.name if bt.strategy else None
    o.strategy_kind = bt.strategy.kind if bt.strategy else None
    return o


@router.post("", response_model=BacktestListOut, status_code=202)
def launch(body: BacktestIn, request: Request, user: User = Depends(require(Perm.BACKTEST_RUN)), db: Session = Depends(get_db)):
    strategy = get_visible(db, user, body.strategy_id)
    bt = runner.create_backtest(db, user, strategy, body, request=request)
    db.commit()
    runner.submit(bt.id)
    return _list_out(bt)


@router.post("/batch", response_model=list[BacktestListOut], status_code=202)
def launch_batch(body: BatchIn, request: Request, user: User = Depends(require(Perm.BACKTEST_RUN)), db: Session = Depends(get_db)):
    created = []
    for sid in dict.fromkeys(body.strategy_ids):
        strategy = get_visible(db, user, sid)
        b = body.base.model_copy(update={"strategy_id": sid, "version": None, "name": None})
        created.append(runner.create_backtest(db, user, strategy, b, request=request))
    db.commit()
    for bt in created:
        runner.submit(bt.id)
    return [_list_out(b) for b in created]


@router.get("")
def list_backtests(
    strategy_id: uuid.UUID | None = None,
    status: str | None = None,
    include_portfolios: bool = False,
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=100),
    user: User = Depends(require(Perm.BACKTEST_READ)),
    db: Session = Depends(get_db),
):
    stmt = select(Backtest).options(defer(Backtest.results)).where(Backtest.owner_id == user.id)
    if strategy_id:
        stmt = stmt.where(Backtest.strategy_id == strategy_id)
    if status:
        stmt = stmt.where(Backtest.status == status)
    if not include_portfolios:
        stmt = stmt.where(Backtest.portfolio_id.is_(None))
    total = db.scalar(select(func.count()).select_from(stmt.subquery()))
    rows = db.scalars(stmt.order_by(Backtest.created_at.desc()).offset((page - 1) * page_size).limit(page_size)).unique().all()
    return {"items": [_list_out(b) for b in rows], "total": total, "page": page, "page_size": page_size,
            "pages": max((total + page_size - 1) // page_size, 1)}


@router.get("/compare")
def compare(ids: str, user: User = Depends(require(Perm.BACKTEST_READ)), db: Session = Depends(get_db)):
    wanted = [uuid.UUID(x) for x in ids.split(",") if x.strip()][:8]
    out = []
    for i in wanted:
        bt = _own(db, user, i)
        if bt.status != "done":
            continue
        r = bt.results
        out.append({
            "id": str(bt.id), "name": bt.name, "strategy_name": bt.strategy.name, "strategy_kind": bt.strategy.kind,
            "strategy_version": bt.strategy_version, "config": bt.config, "summary": bt.summary,
            "series": {k: r["series"][k] for k in ("dates", "twr", "benchmark_twr", "drawdown", "equity", "invested")},
            "yearly": r["yearly"],
        })
    return out


@router.get("/{backtest_id}")
def get_backtest(backtest_id: uuid.UUID, user: User = Depends(require(Perm.BACKTEST_READ)), db: Session = Depends(get_db)):
    bt = _own(db, user, backtest_id)
    data = _list_out(bt).model_dump(mode="json")
    if bt.results:
        data["results"] = {k: v for k, v in bt.results.items() if k != "decisions"}
        data["results"]["decision_count"] = len(bt.results.get("decisions", []))
    return data


@router.get("/{backtest_id}/decisions")
def decisions(
    backtest_id: uuid.UUID,
    symbol: str | None = None,
    action: str | None = None,
    date_from: str | None = Query(None, alias="from"),
    date_to: str | None = Query(None, alias="to"),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=500),
    user: User = Depends(require(Perm.BACKTEST_READ)),
    db: Session = Depends(get_db),
):
    bt = _own(db, user, backtest_id)
    rows = (bt.results or {}).get("decisions", [])
    if symbol:
        rows = [r for r in rows if r["symbol"] == symbol]
    if action:
        acts = set(action.split(","))
        rows = [r for r in rows if r["action"] in acts]
    if date_from:
        rows = [r for r in rows if r["date"] >= date_from]
    if date_to:
        rows = [r for r in rows if r["date"] <= date_to]
    rows = list(reversed(rows))
    total = len(rows)
    start = (page - 1) * page_size
    return {"items": rows[start : start + page_size], "total": total, "page": page, "page_size": page_size,
            "pages": max((total + page_size - 1) // page_size, 1),
            "symbols": sorted({r["symbol"] for r in (bt.results or {}).get("decisions", [])})}


@router.get("/{backtest_id}/export/{kind}.csv")
def export_csv(backtest_id: uuid.UUID, kind: str, request: Request, user: User = Depends(require(Perm.BACKTEST_READ)), db: Session = Depends(get_db)):
    bt = _own(db, user, backtest_id)
    r = bt.results or {}
    buf = io.StringIO()
    w = csv.writer(buf, delimiter=";")
    if kind == "trades":
        w.writerow(["date", "symbole", "sens", "quantité", "prix", "montant", "frais", "impôt", "plus-value réalisée", "raison"])
        for t in r.get("trades", []):
            w.writerow([t["date"], t["symbol"], t["side"], f"{t['qty']:.6f}", f"{t['price']:.4f}", f"{t['value']:.2f}",
                        f"{t['fees']:.2f}", f"{t['tax']:.2f}", "" if t["realized_pnl"] is None else f"{t['realized_pnl']:.2f}", t["reason"]])
    elif kind == "equity":
        s = r.get("series", {})
        w.writerow(["date", "valeur", "capital versé", "indice (mêmes versements)", "drawdown"])
        for i, d in enumerate(s.get("dates", [])):
            w.writerow([d, s["equity"][i], s["invested"][i], s["benchmark_equity"][i], s["drawdown"][i]])
    elif kind == "decisions":
        w.writerow(["date", "symbole", "action", "poids avant", "poids cible", "raison"])
        for x in r.get("decisions", []):
            w.writerow([x["date"], x["symbol"], x["action"], f"{x['prev_weight']:.4f}", f"{x['target_weight']:.4f}", x["reason"]])
    elif kind == "contributions":
        w.writerow(["date", "versement", "cumul versé", "valeur du portefeuille"])
        for x in r.get("contributions", []):
            w.writerow([x["date"], x["amount"], x["cumulative"], f"{x['portfolio_value']:.2f}"])
    else:
        raise HTTPException(404, "Export inconnu")
    audit.record(db, "backtest.export", actor=user, request=request, resource_type="backtest", resource_id=bt.id, details={"kind": kind})
    db.commit()
    return StreamingResponse(iter(["﻿" + buf.getvalue()]), media_type="text/csv; charset=utf-8",
                             headers={"Content-Disposition": f'attachment; filename="my2cents-{kind}-{str(bt.id)[:8]}.csv"'})


@router.delete("/{backtest_id}", status_code=204)
def delete_backtest(backtest_id: uuid.UUID, request: Request, user: User = Depends(require(Perm.BACKTEST_DELETE)), db: Session = Depends(get_db)):
    bt = _own(db, user, backtest_id)
    if bt.status in ("queued", "running"):
        raise HTTPException(409, "Backtest en cours d'exécution.")
    audit.record(db, "backtest.delete", actor=user, request=request, resource_type="backtest", resource_id=bt.id,
                 before={"name": bt.name, "strategy_id": str(bt.strategy_id), "summary": (bt.summary or {}).get("strategy")})
    db.delete(bt)
    db.commit()
