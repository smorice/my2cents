import csv
import io
import uuid
from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from sqlalchemy import func, select
from sqlalchemy.orm import Session, defer

from .. import audit, runner
from ..db import get_db
from ..deps import require
from ..engine import analytics
from ..marketdata.service import load_panel
from ..models import Backtest, BacktestDecision, BacktestPosition, BacktestTransaction, Job, User
from ..rbac import Perm
from ..schemas import BacktestIn, BacktestListOut, BatchIn
from .strategies import get_visible

router = APIRouter(prefix="/backtests", tags=["backtests"])


def _own(db: Session, user: User, backtest_id: uuid.UUID) -> Backtest:
    bt = db.get(Backtest, backtest_id)
    if bt is None or bt.owner_id != user.id:
        raise HTTPException(404, "Backtest introuvable")
    return bt


def _list_out(bt: Backtest, db: Session | None = None) -> BacktestListOut:
    o = BacktestListOut.model_validate(bt)
    o.strategy_name = bt.strategy.name if bt.strategy else None
    o.strategy_kind = bt.strategy.kind if bt.strategy else None
    if db is not None and bt.job_id and bt.status in ("queued", "running"):
        job = db.get(Job, bt.job_id)
        if job:
            o.progress, o.progress_message = job.progress, job.message
    return o


def _page(total: int, page: int, size: int, items: list, **extra) -> dict:
    return {"items": items, "total": total, "page": page, "page_size": size, "pages": max((total + size - 1) // size, 1), **extra}


def _decision(d: BacktestDecision) -> dict:
    return {"seq": d.seq, "date": d.date.isoformat(), "symbol": d.symbol, "action": d.action, "prev_weight": d.prev_weight,
            "target_weight": d.target_weight, "reason": d.reason, "metrics": d.metrics, "explain": d.explain}


def _trade(t: BacktestTransaction) -> dict:
    return {"seq": t.seq, "date": t.date.isoformat(), "symbol": t.symbol, "side": t.side, "qty": t.qty, "price": t.price,
            "value": t.value, "fees": t.fees, "tax": t.tax, "realized_pnl": t.realized_pnl, "reason": t.reason,
            "decision_seq": t.decision_seq}


def positions_of(db: Session, bt: Backtest) -> list[dict]:
    names = (bt.results or {}).get("names", {})
    rows = db.scalars(select(BacktestPosition).where(BacktestPosition.backtest_id == bt.id).order_by(BacktestPosition.value.desc())).all()
    return [{"symbol": p.symbol, "name": names.get(p.symbol, p.symbol), "qty": p.qty, "avg_cost": p.avg_cost, "price": p.price,
             "value": p.value, "weight": p.weight, "unrealized_pnl": p.unrealized_pnl,
             "unrealized_pct": p.unrealized_pnl / (p.value - p.unrealized_pnl) if p.value - p.unrealized_pnl else 0.0} for p in rows]


@router.post("", response_model=BacktestListOut, status_code=202)
def launch(body: BacktestIn, request: Request, user: User = Depends(require(Perm.BACKTEST_RUN)), db: Session = Depends(get_db)):
    strategy = get_visible(db, user, body.strategy_id)
    bt = runner.create_backtest(db, user, strategy, body, request=request)
    db.commit()
    return _list_out(bt, db)


@router.post("/batch", response_model=list[BacktestListOut], status_code=202)
def launch_batch(body: BatchIn, request: Request, user: User = Depends(require(Perm.BACKTEST_RUN)), db: Session = Depends(get_db)):
    created = []
    for sid in dict.fromkeys(body.strategy_ids):
        strategy = get_visible(db, user, sid)
        b = body.base.model_copy(update={"strategy_id": sid, "version": None, "name": None})
        created.append(runner.create_backtest(db, user, strategy, b, request=request))
    db.commit()
    return [_list_out(b, db) for b in created]


@router.get("")
def list_backtests(
    strategy_id: uuid.UUID | None = None,
    status: str | None = None,
    include_portfolios: bool = False,
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=500),
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
    return _page(total, page, page_size, [_list_out(b, db) for b in rows])


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
    data = _list_out(bt, db).model_dump(mode="json")
    if bt.results:
        data["results"] = {**bt.results, "positions": positions_of(db, bt)}
    return data


@router.get("/{backtest_id}/decisions")
def decisions(
    backtest_id: uuid.UUID,
    symbol: str | None = None,
    action: str | None = None,
    date_from: date | None = Query(None, alias="from"),
    date_to: date | None = Query(None, alias="to"),
    seq: str | None = Query(None, description="Comma-separated decision seqs"),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=500),
    user: User = Depends(require(Perm.BACKTEST_READ)),
    db: Session = Depends(get_db),
):
    bt = _own(db, user, backtest_id)
    D = BacktestDecision
    stmt = select(D).where(D.backtest_id == bt.id)
    if symbol:
        stmt = stmt.where(D.symbol == symbol)
    if action:
        stmt = stmt.where(D.action.in_(action.split(",")))
    if date_from:
        stmt = stmt.where(D.date >= date_from)
    if date_to:
        stmt = stmt.where(D.date <= date_to)
    if seq:
        stmt = stmt.where(D.seq.in_([int(x) for x in seq.split(",") if x.strip().isdigit()][:200]))
    total = db.scalar(select(func.count()).select_from(stmt.subquery()))
    rows = db.scalars(stmt.order_by(D.date.desc(), D.seq.desc()).offset((page - 1) * page_size).limit(page_size)).all()
    symbols = db.scalars(select(D.symbol).where(D.backtest_id == bt.id).distinct().order_by(D.symbol)).all()
    return _page(total, page, page_size, [_decision(d) for d in rows], symbols=symbols)


@router.get("/{backtest_id}/transactions")
def transactions(
    backtest_id: uuid.UUID,
    symbol: str | None = None,
    side: str | None = None,
    decision_seq: int | None = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=500),
    user: User = Depends(require(Perm.BACKTEST_READ)),
    db: Session = Depends(get_db),
):
    bt = _own(db, user, backtest_id)
    T = BacktestTransaction
    stmt = select(T).where(T.backtest_id == bt.id)
    if symbol:
        stmt = stmt.where(T.symbol == symbol)
    if side in ("buy", "sell"):
        stmt = stmt.where(T.side == side)
    if decision_seq is not None:
        stmt = stmt.where(T.decision_seq == decision_seq)
    total = db.scalar(select(func.count()).select_from(stmt.subquery()))
    rows = db.scalars(stmt.order_by(T.date.desc(), T.seq.desc()).offset((page - 1) * page_size).limit(page_size)).all()
    symbols = db.scalars(select(T.symbol).where(T.backtest_id == bt.id).distinct().order_by(T.symbol)).all()
    return _page(total, page, page_size, [_trade(t) for t in rows], symbols=symbols)


def win_rate(db: Session, backtest_id: uuid.UUID) -> dict:
    """Share of closing sales that realised a gain (only meaningful for strategies that sell)."""
    T = BacktestTransaction
    wins, total = db.execute(select(
        func.count().filter(T.realized_pnl > 0), func.count()
    ).where(T.backtest_id == backtest_id, T.side == "sell", T.realized_pnl.is_not(None))).one()
    return {"win_rate": (wins / total) if total else None, "closed_trades": total}


@router.get("/{backtest_id}/analytics")
def backtest_analytics(backtest_id: uuid.UUID, days: int = Query(126, ge=21, le=504),
                       user: User = Depends(require(Perm.BACKTEST_READ)), db: Session = Depends(get_db)):
    bt = _own(db, user, backtest_id)
    if bt.status != "done":
        raise HTTPException(409, "Backtest non terminé")
    return {**analytics.rolling(bt.results["series"], days, bt.config.get("risk_free_pct", 2.0)), **win_rate(db, bt.id)}


@router.get("/{backtest_id}/window")
def backtest_window(backtest_id: uuid.UUID, period: str = "MAX",
                    user: User = Depends(require(Perm.BACKTEST_READ)), db: Session = Depends(get_db)):
    bt = _own(db, user, backtest_id)
    if bt.status != "done" or period not in analytics.PERIODS:
        raise HTTPException(404, "Période indisponible")
    s = bt.results["series"]
    first, last = date.fromisoformat(s["dates"][0]), date.fromisoformat(s["dates"][-1])
    w = analytics.window(s, analytics.period_start(period, first, last), last, bt.config.get("risk_free_pct", 2.0))
    if w is None:
        raise HTTPException(404, "Période trop courte")
    return {**w, "period": period}


@router.get("/{backtest_id}/timeline")
def timeline(backtest_id: uuid.UUID, user: User = Depends(require(Perm.BACKTEST_READ)), db: Session = Depends(get_db)):
    """Orders grouped by execution day: what entered, what left, and how much was traded."""
    bt = _own(db, user, backtest_id)
    T = BacktestTransaction
    rows = db.execute(select(T.date, T.side, T.symbol, T.value, T.decision_seq).where(T.backtest_id == bt.id).order_by(T.date, T.seq)).all()
    days: dict[date, dict] = {}
    for d, side, sym, value, dseq in rows:
        x = days.setdefault(d, {"date": d.isoformat(), "buy_value": 0.0, "sell_value": 0.0, "buys": [], "sells": [], "contribution_only": True})
        x[f"{side}_value"] += value
        lst = x["buys" if side == "buy" else "sells"]
        if sym not in lst:
            lst.append(sym)
        if dseq is not None:
            x["contribution_only"] = False
    return list(days.values())


@router.get("/{backtest_id}/assets/{symbol}")
def asset_detail(backtest_id: uuid.UUID, symbol: str, user: User = Depends(require(Perm.BACKTEST_READ)), db: Session = Depends(get_db)):
    """One asset's story in a backtest: its price vs the benchmark, every order and every decision."""
    bt = _own(db, user, backtest_id)
    if bt.status != "done" or symbol not in bt.config["universe"]:
        raise HTTPException(404, "Actif absent de ce backtest")
    period = bt.results["effective_period"]
    start, end = date.fromisoformat(period["start"]), date.fromisoformat(period["end"])
    bench = bt.config["benchmark"]
    close, _ = load_panel(db, [symbol, bench], start, end)
    if close.empty or symbol not in close.columns:
        raise HTTPException(404, "Pas de cours pour cet actif sur la période")
    close = close.ffill()
    T, D = BacktestTransaction, BacktestDecision
    trades = [_trade(t) for t in db.scalars(select(T).where(T.backtest_id == bt.id, T.symbol == symbol).order_by(T.seq))]
    decisions = [_decision(d) for d in db.scalars(
        select(D).where(D.backtest_id == bt.id, D.symbol == symbol, D.action.in_(["buy", "sell", "increase", "decrease"])).order_by(D.seq))]

    def r(v):
        return None if v != v else round(float(v), 6)  # NaN -> None

    return {
        "symbol": symbol, "name": bt.results.get("names", {}).get(symbol, symbol), "benchmark": bench,
        "dates": [d.date().isoformat() for d in close.index],
        "price": [r(v) for v in close[symbol]],
        "benchmark_price": [r(v) for v in close[bench]] if bench in close.columns else None,
        "trades": trades, "decisions": decisions,
        "realized_pnl": sum(t["realized_pnl"] or 0 for t in trades),
    }


@router.get("/{backtest_id}/export/{kind}.csv")
def export_csv(backtest_id: uuid.UUID, kind: str, request: Request, user: User = Depends(require(Perm.BACKTEST_READ)), db: Session = Depends(get_db)):
    bt = _own(db, user, backtest_id)
    r = bt.results or {}
    buf = io.StringIO()
    w = csv.writer(buf, delimiter=";")
    if kind == "trades":
        w.writerow(["date", "symbole", "sens", "quantité", "prix", "montant", "frais", "impôt", "plus-value réalisée", "raison"])
        T = BacktestTransaction
        for t in map(_trade, db.scalars(select(T).where(T.backtest_id == bt.id).order_by(T.seq))):
            w.writerow([t["date"], t["symbol"], t["side"], f"{t['qty']:.6f}", f"{t['price']:.4f}", f"{t['value']:.2f}",
                        f"{t['fees']:.2f}", f"{t['tax']:.2f}", "" if t["realized_pnl"] is None else f"{t['realized_pnl']:.2f}", t["reason"]])
    elif kind == "equity":
        s = r.get("series", {})
        w.writerow(["date", "valeur", "capital versé", "indice (mêmes versements)", "drawdown"])
        for i, d in enumerate(s.get("dates", [])):
            w.writerow([d, s["equity"][i], s["invested"][i], s["benchmark_equity"][i], s["drawdown"][i]])
    elif kind == "decisions":
        w.writerow(["date", "symbole", "action", "poids avant", "poids cible", "raison"])
        D = BacktestDecision
        for x in map(_decision, db.scalars(select(D).where(D.backtest_id == bt.id).order_by(D.seq))):
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
