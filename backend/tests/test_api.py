"""End-to-end API tests. Need a throwaway Postgres in MY2CENTS_DATABASE_URL."""

import os
import threading
import time
from datetime import date, timedelta

import numpy as np
import pandas as pd
import pytest

pytestmark = pytest.mark.skipif(not os.environ.get("MY2CENTS_DATABASE_URL"), reason="needs Postgres")

os.environ.setdefault("MY2CENTS_COOKIE_SECURE", "false")
os.environ.setdefault("MY2CENTS_DISABLE_REFRESH", "1")
os.environ.setdefault("MY2CENTS_BOOTSTRAP_ADMIN_EMAIL", "admin@example.com")
os.environ.setdefault("MY2CENTS_BOOTSTRAP_ADMIN_PASSWORD", "Admin-Password-123")
os.environ.setdefault("MY2CENTS_STATIC_DIR", "/nonexistent")

from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import text  # noqa: E402

from app import jobs, migrations, ratelimit, runner, worker  # noqa: E402
from app.db import Base, SessionLocal, engine  # noqa: E402
from app.main import app  # noqa: E402
from app.models import AppError, Backtest, BacktestDecision, Instrument, Job, PriceBar, utcnow  # noqa: E402

API = "/my2cents/api"
H = {"x-my2cents-csrf": "1"}
PW = "Correct-Horse-42"


@pytest.fixture(scope="module")
def client():
    with engine.begin() as c:
        c.execute(text("DROP SCHEMA public CASCADE; CREATE SCHEMA public;"))
    stop = threading.Event()
    ratelimit.LIMITS.update(read=100_000, write=100_000)  # polling loops below would trip the real limits
    with TestClient(app) as tc:
        _seed_prices()
        worker.start(stop, concurrency=2, idle=0.05, refresh=False)
        yield tc
    stop.set()


def _wait_backtest(c, bid):
    for _ in range(200):
        bt = c.get(f"{API}/backtests/{bid}").json()
        if bt["status"] in ("done", "failed"):
            return bt
        time.sleep(0.1)
    raise AssertionError(f"backtest stuck: {bt['status']}")


def _seed_prices():
    rng = np.random.default_rng(3)
    idx = pd.bdate_range("2019-01-01", "2023-12-29")
    with SessionLocal() as db:
        for k, sym in enumerate(["AAA.PA", "BBB.PA", "CCC.PA", "^TEST"]):
            px = 100 * np.exp(np.cumsum(rng.normal(0.0002 * (k + 1), 0.01, len(idx))))
            db.merge(Instrument(symbol=sym, name=f"Test {sym}", kind="index" if sym.startswith("^") else "equity",
                                currency="EUR", universes=["test"], last_synced_at=utcnow(),
                                first_date=idx[0].date(), last_date=idx[-1].date()))
            db.flush()
            db.add_all([PriceBar(symbol=sym, date=d.date(), open=p, high=p, low=p, close=p, adj_close=p, volume=0) for d, p in zip(idx, px)])
        db.commit()


def _login(c, email, pw=PW):
    c.cookies.clear()
    return c.post(f"{API}/auth/login", json={"email": email, "password": pw}, headers=H)


def test_csrf_header_required(client):
    r = client.post(f"{API}/auth/login", json={"email": "a@b.co", "password": "x"})
    assert r.status_code == 403


def test_register_login_and_password_policy(client):
    r = client.post(f"{API}/auth/register", json={"email": "weak@example.com", "display_name": "W", "password": "short"}, headers=H)
    assert r.status_code == 422
    r = client.post(f"{API}/auth/register", json={"email": "alice@example.com", "display_name": "Alice", "password": PW}, headers=H)
    assert r.status_code == 201, r.text
    assert r.json()["role_names"] == ["USER"]
    assert client.get(f"{API}/auth/me").json()["email"] == "alice@example.com"
    assert _login(client, "alice@example.com", "wrong").status_code == 401
    assert _login(client, "alice@example.com").status_code == 200


def test_lockout_after_failures(client):
    client.post(f"{API}/auth/register", json={"email": "bob@example.com", "display_name": "Bob", "password": PW}, headers=H)
    for _ in range(5):
        _login(client, "bob@example.com", "nope")
    assert _login(client, "bob@example.com").status_code == 423


def test_rbac_denies_and_audits(client):
    _login(client, "alice@example.com")
    assert client.get(f"{API}/audit").status_code == 403
    assert client.get(f"{API}/admin/users").status_code == 403
    _login(client, "admin@example.com", "Admin-Password-123")
    events = client.get(f"{API}/audit", params={"action": "access.denied"}).json()
    assert events["total"] >= 2
    assert client.get(f"{API}/audit/verify").json()["valid"] is True


def test_audit_is_append_only(client):
    with engine.begin() as c:
        with pytest.raises(Exception):
            c.execute(text("UPDATE audit_events SET action='x'"))
    with engine.begin() as c:
        with pytest.raises(Exception):
            c.execute(text("DELETE FROM audit_events"))


def test_strategy_versioning_and_backtest(client):
    _login(client, "alice@example.com")
    catalog = client.get(f"{API}/strategies/catalog").json()
    assert {c["kind"] for c in catalog} >= {"momentum", "benchmark_outperformance", "buy_and_hold"}
    templates = [s for s in client.get(f"{API}/strategies").json() if s["is_template"]]
    assert len(templates) >= 7
    assert not templates[0]["can_edit"]

    definition = {
        "parameters": {"lookback_days": 63, "entry_threshold_pct": 2, "exit_threshold_pct": 0, "max_positions": 2},
        "universe": {"preset": None, "symbols": ["AAA.PA", "BBB.PA", "CCC.PA"]},
        "benchmark": "^TEST", "rebalance_frequency": "weekly",
    }
    r = client.post(f"{API}/strategies", json={"name": "Mine", "kind": "benchmark_outperformance", "definition": definition}, headers=H)
    assert r.status_code == 201, r.text
    sid = r.json()["id"]
    definition["parameters"]["entry_threshold_pct"] = 3
    r = client.put(f"{API}/strategies/{sid}", json={"definition": definition, "change_note": "seuil 3 %"}, headers=H)
    assert r.json()["current_version"] == 2
    versions = client.get(f"{API}/strategies/{sid}/versions").json()
    assert [v["version"] for v in versions] == [2, 1]
    assert versions[1]["definition"]["parameters"]["entry_threshold_pct"] == 2

    r = client.put(f"{API}/strategies/{sid}", json={"definition": definition, "expected_version": 1}, headers=H)
    assert r.status_code == 409

    r = client.post(f"{API}/backtests", headers=H, json={
        "strategy_id": sid, "start": "2020-01-01", "end": "2023-12-31", "initial_capital": 10000,
        "contributions": {"amount": 200, "frequency": "monthly"}, "tax_mode": "pfu",
    })
    assert r.status_code == 202, r.text
    bid = r.json()["id"]
    assert r.json()["job_id"]
    bt = _wait_backtest(client, bid)
    assert bt["status"] == "done", bt.get("error")
    job = client.get(f"{API}/jobs/{r.json()['job_id']}").json()
    assert job["status"] == "completed" and job["progress"] == 1.0
    res = bt["results"]
    assert res["summary"]["strategy"]["total_invested"] > 10000
    assert len(res["contributions"]) > 40
    assert any("biais" in a.lower() or "anticipation" in a.lower() for a in res["assumptions"])
    assert "decisions" not in res and "trades" not in res
    dec = client.get(f"{API}/backtests/{bid}/decisions", params={"action": "buy"}).json()
    assert dec["total"] > 0 and "écart" in dec["items"][0]["reason"]
    assert dec["items"][0]["date"] >= dec["items"][-1]["date"]  # newest first
    # Every strategy-driven order points back at the decision that caused it.
    tx = client.get(f"{API}/backtests/{bid}/transactions", params={"page_size": 500}).json()
    assert tx["total"] == res["summary"]["strategy"]["trades"]
    linked = [t for t in tx["items"] if t["decision_seq"] is not None]
    assert linked
    t0 = linked[0]
    d0 = client.get(f"{API}/backtests/{bid}/decisions", params={"seq": t0["decision_seq"]}).json()["items"][0]
    assert d0["symbol"] == t0["symbol"] and d0["date"] < t0["date"]
    assert d0["action"] in (("buy", "increase") if t0["side"] == "buy" else ("sell", "decrease"))
    assert all(t["decision_seq"] is None for t in tx["items"] if t["reason"].startswith("Investissement du versement"))
    # Structured explanation: asset vs benchmark, outperformance, and the threshold it had to clear.
    ex = dec["items"][0]["explain"]
    assert [f.get("subject") for f in ex["facts"]][:2] == ["asset", "benchmark"]
    entry = next(c for c in ex["checks"] if c["label"].startswith("Seuil d'entrée"))
    assert entry["passed"] and entry["threshold"] == pytest.approx(0.03) and entry["value"] >= 0.03
    asset = client.get(f"{API}/backtests/{bid}/assets/{t0['symbol']}").json()
    assert len(asset["dates"]) == len(asset["price"]) == len(asset["benchmark_price"]) and asset["trades"]
    assert {d["action"] for d in asset["decisions"]} <= {"buy", "sell", "increase", "decrease"}
    tl = client.get(f"{API}/backtests/{bid}/timeline").json()
    assert sum(len(x["buys"]) for x in tl) >= 1 and tl == sorted(tl, key=lambda x: x["date"])
    assert client.get(f"{API}/backtests/{bid}/assets/NOPE").status_code == 404
    an = client.get(f"{API}/backtests/{bid}/analytics").json()
    assert len(an["dates"]) == len(an["sharpe"]) and 0 <= an["win_rate"] <= 1
    w = client.get(f"{API}/backtests/{bid}/window", params={"period": "1Y"}).json()
    assert w["strategy"][0] == 100 and w["metrics"]["volatility"] > 0
    dash = client.get(f"{API}/dashboard/performance", params={"period": "3Y"}).json()
    assert dash["focus"] == bid and dash["items"][0]["values"][0] == 100 and "win_rate" in dash["items"][0]
    assert client.get(f"{API}/dashboard/performance", params={"period": "2W"}).status_code == 422
    assert client.get(f"{API}/backtests/{bid}/export/trades.csv").status_code == 200
    cmp_ = client.get(f"{API}/backtests/compare", params={"ids": bid}).json()
    assert cmp_[0]["series"]["twr"]

    # Another user cannot see it
    _login(client, "admin@example.com", "Admin-Password-123")
    assert client.get(f"{API}/backtests/{bid}").status_code == 404
    assert client.get(f"{API}/strategies/{sid}").status_code == 404


def test_portfolio_simulation(client):
    _login(client, "alice@example.com")
    sid = next(s["id"] for s in client.get(f"{API}/strategies").json() if s["name"] == "Mine")
    r = client.post(f"{API}/portfolios", headers=H, json={
        "name": "PEA test", "strategy_id": sid,
        "settings": {"start": "2021-01-01", "end": "2023-12-31", "initial_capital": 0,
                     "contributions": {"amount": 500, "frequency": "monthly"}},
    })
    assert r.status_code == 201, r.text
    pid = r.json()["id"]
    for _ in range(200):
        p = client.get(f"{API}/portfolios/{pid}").json()
        if p["latest_simulation"]["status"] in ("done", "failed"):
            break
        time.sleep(0.1)
    assert p["latest_simulation"]["status"] == "done", p["latest_simulation"]
    assert p["latest_simulation"]["summary"]["total_invested"] == pytest.approx(500 * 36, rel=0.05)


def test_admin_role_change_is_audited(client):
    _login(client, "admin@example.com", "Admin-Password-123")
    users = client.get(f"{API}/admin/users", params={"q": "alice"}).json()["items"]
    r = client.patch(f"{API}/admin/users/{users[0]['id']}", json={"roles": ["USER", "AUDITOR"]}, headers=H)
    assert sorted(r.json()["role_names"]) == ["AUDITOR", "USER"]
    ev = client.get(f"{API}/audit", params={"action": "user.permissions_change"}).json()["items"][0]
    assert ev["before"]["roles"] == ["USER"] and ev["after"]["roles"] == ["AUDITOR", "USER"]
    assert client.get(f"{API}/audit/verify").json()["valid"] is True


def test_portfolio_benchmark_override(client):
    _login(client, "alice@example.com")
    sid = next(s["id"] for s in client.get(f"{API}/strategies").json() if s["name"] == "Mine")
    r = client.post(f"{API}/portfolios", headers=H, json={
        "name": "Bench", "strategy_id": sid, "benchmark": "NOPE.XX",
        "settings": {"start": "2021-01-01", "end": "2023-12-31", "initial_capital": 1000},
    })
    assert r.status_code == 422
    r = client.post(f"{API}/portfolios", headers=H, json={
        "name": "Bench", "strategy_id": sid, "benchmark": "AAA.PA",
        "settings": {"start": "2021-01-01", "end": "2023-12-31", "initial_capital": 1000},
    })
    assert r.status_code == 201, r.text
    assert r.json()["benchmark"] == "AAA.PA" and r.json()["currency"] == "EUR"
    bt = _wait_backtest(client, r.json()["latest_simulation"]["id"])
    assert bt["config"]["benchmark"] == "AAA.PA"


def test_job_failure_is_explained_without_internals(client):
    _login(client, "alice@example.com")
    sid = next(s["id"] for s in client.get(f"{API}/strategies").json() if s["name"] == "Mine")
    # Period with no market data at all: an expected, user-facing failure.
    r = client.post(f"{API}/backtests", headers=H, json={"strategy_id": sid, "start": "2010-01-01", "end": "2011-01-01"})
    bt = _wait_backtest(client, r.json()["id"])
    assert bt["status"] == "failed" and "Pas de données" in bt["error"]
    job = client.get(f"{API}/jobs/{r.json()['job_id']}").json()
    assert job["status"] == "failed" and "internal_error" not in job
    _login(client, "admin@example.com", "Admin-Password-123")
    assert client.get(f"{API}/jobs/{r.json()['job_id']}").status_code == 404  # not the owner


def test_stale_jobs_are_requeued_then_failed(client):
    ran = []
    jobs.HANDLERS["test_noop"] = lambda job, report: ran.append(job.id)
    old = utcnow() - timedelta(minutes=10)
    with SessionLocal() as db:
        retry = Job(kind="test_noop", status="running", attempts=1, heartbeat_at=old, payload={})
        dead = Job(kind="test_noop", status="running", attempts=jobs.MAX_ATTEMPTS, heartbeat_at=old, payload={})
        db.add_all([retry, dead])
        db.commit()
        retry_id, dead_id = retry.id, dead.id
    assert jobs.recover_stale() >= 2
    for _ in range(100):
        with SessionLocal() as db:
            if db.get(Job, retry_id).status == "completed":
                break
        time.sleep(0.05)
    with SessionLocal() as db:
        assert db.get(Job, retry_id).status == "completed" and db.get(Job, retry_id).attempts == 2
        d = db.get(Job, dead_id)
        assert d.status == "failed" and "interrompu" in d.user_error
    assert ran == [retry_id]


def test_unhandled_errors_are_recorded_not_leaked(client):
    def boom():
        raise RuntimeError("secret internal detail")

    app.add_api_route("/__boom", boom)
    r = client.get("/__boom")
    assert r.status_code == 500
    assert "secret" not in r.text and r.json()["ref"] == r.headers["x-request-id"]
    with SessionLocal() as db:
        err = db.query(AppError).filter(AppError.request_id == r.json()["ref"]).one()
        assert err.message == "secret internal detail" and "RuntimeError" in err.traceback


def test_legacy_results_are_normalised(client):
    with SessionLocal() as db:
        bt = db.query(Backtest).filter(Backtest.status == "done").first()
        db.query(BacktestDecision).filter(BacktestDecision.backtest_id == bt.id).delete()
        bt.results = {**bt.results, "decisions": [
            {"date": "2021-01-04", "symbol": "AAA.PA", "action": "buy", "prev_weight": 0, "target_weight": 0.5, "reason": "x", "metrics": {}},
        ], "trades": [], "positions": []}
        db.commit()
        with engine.begin() as conn:
            migrations._normalise_results(conn)
        db.expire_all()
        assert "decisions" not in db.get(Backtest, bt.id).results
        assert db.query(BacktestDecision).filter(BacktestDecision.backtest_id == bt.id).count() == 1


def test_admin_system_views_and_permissions(client):
    client.cookies.clear()
    client.post(f"{API}/auth/register", json={"email": "carol@example.com", "display_name": "Carol", "password": PW}, headers=H)
    for path in ("/admin/overview", "/admin/jobs", "/admin/errors", "/admin/providers", "/admin/strategies"):
        assert client.get(f"{API}{path}").status_code == 403, path
    _login(client, "alice@example.com")  # AUDITOR since test_admin_role_change: may read the system state, not manage jobs
    assert client.get(f"{API}/admin/overview").status_code == 200
    assert client.get(f"{API}/admin/jobs").status_code == 403
    mine = client.get(f"{API}/audit/me").json()
    assert mine["total"] > 0 and all(e["actor_email"] == "alice@example.com" for e in mine["items"])
    tx = client.get(f"{API}/transactions", params={"page_size": 5}).json()
    assert tx["total"] > 0 and tx["items"][0]["backtest_name"] and tx["sources"]

    _login(client, "admin@example.com", "Admin-Password-123")
    ov = client.get(f"{API}/admin/overview").json()
    assert ov["backtests"]["total"] >= 2 and "completed" in ov["jobs"]["by_status"]
    jl = client.get(f"{API}/admin/jobs", params={"status": "failed", "kind": "backtest"}).json()
    failed = jl["items"][0]
    assert failed["internal_error"] and failed["owner_email"] == "alice@example.com"
    r = client.post(f"{API}/admin/jobs/{failed['id']}/retry", headers=H)
    assert r.status_code == 200 and r.json()["status"] in ("queued", "running", "failed")
    assert client.post(f"{API}/admin/jobs/{failed['id']}/cancel", headers=H).status_code in (200, 409)
    assert client.get(f"{API}/admin/errors").json()["total"] >= 1
    prov = client.get(f"{API}/admin/providers").json()
    assert prov["providers"][0]["name"] == "yahoo" and prov["instruments"]
    assert any(e["action"] == "job.retry" for e in client.get(f"{API}/audit", params={"action": "job."}).json()["items"])
    assert client.post(f"{API}/admin/market/sync", headers=H, json=["BAD SYMBOL;"]).status_code == 422
    r = client.post(f"{API}/admin/market/sync", headers=H, json=["AAA.PA"])
    assert r.status_code == 202 and r.json()["payload"]["symbols"] == ["AAA.PA"]
    assert any(e["action"] == "market.sync_all" for e in client.get(f"{API}/audit", params={"action": "market."}).json()["items"])


def test_public_showcase_needs_no_login(client):
    client.cookies.clear()
    r = client.get(f"{API}/public/showcase")
    # The test database has no CW8.PA history: the endpoint says so instead of inventing data.
    assert r.status_code == 503


def test_rate_limit_returns_429_with_retry_after(client):
    saved = dict(ratelimit.LIMITS)
    ratelimit.reset()
    ratelimit.LIMITS.update(read=5, write=2)
    try:
        codes = [client.get(f"{API}/auth/config").status_code for _ in range(7)]
        assert codes[:5] == [200] * 5 and codes[5] == 429
        r = client.get(f"{API}/auth/config")
        assert int(r.headers["retry-after"]) >= 1 and "patientez" in r.json()["detail"]
        assert client.get(f"{API}/health").status_code == 200  # never limited
    finally:
        ratelimit.LIMITS.update(saved)
        ratelimit.reset()


def test_active_backtest_quota(client, monkeypatch):
    _login(client, "carol@example.com")
    sid = next(s["id"] for s in client.get(f"{API}/strategies").json() if s["is_template"])
    monkeypatch.setattr(runner, "MAX_ACTIVE_PER_USER", 0)
    r = client.post(f"{API}/backtests", headers=H, json={"strategy_id": sid, "start": "2020-01-01", "end": "2021-01-01"})
    assert r.status_code == 429 and "simulations en cours" in r.json()["detail"]


def test_other_users_cannot_reach_any_backtest_output(client):
    _login(client, "alice@example.com")
    bid = next(b["id"] for b in client.get(f"{API}/backtests", params={"status": "done"}).json()["items"])
    job_id = client.get(f"{API}/backtests/{bid}").json()["job_id"]
    sym = client.get(f"{API}/backtests/{bid}/transactions").json()["items"][0]["symbol"]
    _login(client, "carol@example.com")
    for path in ("", "/decisions", "/transactions", "/timeline", "/analytics", "/window", f"/assets/{sym}", "/export/trades.csv"):
        assert client.get(f"{API}/backtests/{bid}{path}").status_code == 404, path
    assert client.get(f"{API}/jobs/{job_id}").status_code == 404
    assert client.get(f"{API}/transactions", params={"backtest_id": bid}).json()["total"] == 0
    assert client.get(f"{API}/backtests/compare", params={"ids": bid}).status_code == 404
    assert client.delete(f"{API}/backtests/{bid}", headers=H).status_code in (403, 404)
    assert client.get(f"{API}/dashboard/performance", params={"focus": bid}).json()["items"] == []


def _wait_job(c, job_id):
    for _ in range(300):
        j = c.get(f"{API}/jobs/{job_id}").json()
        if j["status"] in ("completed", "failed"):
            return j
        time.sleep(0.1)
    raise AssertionError(f"job stuck: {j['status']}")


def _seed_private(symbols):
    """Symbols no other test syncs from the network, so their prices stay put during the test."""
    rng = np.random.default_rng(7)
    idx = pd.bdate_range("2023-01-02", "2023-12-29")
    with SessionLocal() as db:
        for k, sym in enumerate(symbols):
            px = 100 * np.exp(np.cumsum(rng.normal(0.0002 * (k + 1), 0.01, len(idx))))
            db.merge(Instrument(symbol=sym, name=f"Test {sym}", kind="index" if sym.startswith("^") else "equity", currency="EUR",
                                universes=["test"], last_synced_at=utcnow(), first_date=idx[0].date(), last_date=idx[-1].date()))
            db.flush()
            db.add_all([PriceBar(symbol=sym, date=d.date(), open=p, high=p, low=p, close=p, adj_close=p, volume=0) for d, p in zip(idx, px)])
        db.commit()


def test_real_account_orders_flow(client):
    _seed_private(["RA1.TEST", "RA2.TEST", "RA3.TEST", "^RATEST"])
    _login(client, "alice@example.com")
    r = client.post(f"{API}/strategies", headers=H, json={"name": "Fixe 60/40", "kind": "fixed_allocation", "definition": {
        "parameters": {"weights": {"RA1.TEST": 60, "RA2.TEST": 40}}, "universe": {"preset": None, "symbols": ["RA1.TEST", "RA2.TEST"]},
        "benchmark": "^RATEST", "rebalance_frequency": "monthly"}})
    assert r.status_code == 201, r.text
    r = client.post(f"{API}/accounts", headers=H, json={"name": "PEA", "strategy_id": r.json()["id"], "cash": 5_000, "fee_pct": 0.5, "fee_min": 1})
    assert r.status_code == 201, r.text
    aid = r.json()["id"]
    r = client.put(f"{API}/accounts/{aid}/positions", headers=H, json=[{"symbol": "ra3.test", "qty": 10, "avg_cost": 90}])
    assert r.status_code == 200 and r.json()["positions"][0]["symbol"] == "RA3.TEST"
    assert r.json()["total"] > 5_000

    job = client.post(f"{API}/accounts/{aid}/review", headers=H).json()
    assert _wait_job(client, job["id"])["status"] == "completed"
    acc = client.get(f"{API}/accounts/{aid}").json()
    prop = acc["latest_proposal"]
    assert prop["mode"] == "full" and prop["status"] == "open" and prop["as_of"] == "2023-12-29"
    sides = {(o["side"], o["symbol"]) for o in prop["orders"]}
    assert sides == {("sell", "RA3.TEST"), ("buy", "RA1.TEST"), ("buy", "RA2.TEST")}
    assert any("pas à jour" in w for w in prop["warnings"])  # seeded prices end in 2023
    assert acc["pending_orders"] == 3

    sell = next(o for o in prop["orders"] if o["side"] == "sell")
    cash0 = acc["cash"]
    r = client.post(f"{API}/accounts/{aid}/orders/{sell['id']}/execute", headers=H,
                    json={"qty": 10, "price": 100, "fees": 1, "date": date.today().isoformat()})
    assert r.status_code == 200, r.text
    assert r.json()["cash"] == pytest.approx(cash0 + 999)
    assert all(p["symbol"] != "RA3.TEST" for p in r.json()["positions"])
    assert client.post(f"{API}/accounts/{aid}/orders/{sell['id']}/execute", headers=H,
                       json={"qty": 10, "price": 100, "fees": 1, "date": date.today().isoformat()}).status_code == 409
    buy = next(o for o in prop["orders"] if o["symbol"] == "RA1.TEST")
    r = client.post(f"{API}/accounts/{aid}/orders/{buy['id']}/execute", headers=H,
                    json={"qty": 2, "price": 50, "fees": 1, "date": date.today().isoformat()})
    aaa = next(p for p in r.json()["positions"] if p["symbol"] == "RA1.TEST")
    assert aaa["qty"] == 2 and aaa["avg_cost"] == pytest.approx(50.5)
    other = next(o for o in prop["orders"] if o["symbol"] == "RA2.TEST")
    client.post(f"{API}/accounts/{aid}/orders/{other['id']}/skip", headers=H)
    assert client.get(f"{API}/accounts/{aid}").json()["latest_proposal"]["status"] == "closed"

    moves = client.get(f"{API}/accounts/{aid}/movements").json()
    assert [m["kind"] for m in moves][:2] == ["buy", "sell"] and moves[-1]["kind"] == "deposit"
    assert moves[1]["realized_pnl"] == pytest.approx(999 - 900)
    r = client.post(f"{API}/accounts/{aid}/movements", headers=H, json={"kind": "withdrawal", "date": date.today().isoformat(), "amount": 10**8})
    assert r.status_code == 422

    # A second review in the same rebalance period only checks stop-losses and idle cash.
    job = client.post(f"{API}/accounts/{aid}/review", params={"full": False}, headers=H).json()
    assert _wait_job(client, job["id"])["status"] == "completed"
    hist = client.get(f"{API}/accounts/{aid}/proposals").json()
    assert len(hist) == 2 and hist[0]["mode"] == "light"  # same month as the first review: no rebalance

    # Isolation: another user sees nothing and can touch nothing.
    _login(client, "carol@example.com")
    assert client.get(f"{API}/accounts").json() == []
    for path in ("", "/movements", "/proposals", f"/proposals/{prop['id']}"):
        assert client.get(f"{API}/accounts/{aid}{path}").status_code == 404, path
    assert client.post(f"{API}/accounts/{aid}/review", headers=H).status_code == 404
    assert client.post(f"{API}/accounts/{aid}/orders/{other['id']}/skip", headers=H).status_code == 404
    assert client.put(f"{API}/accounts/{aid}/positions", headers=H, json=[]).status_code == 404


def test_evening_review_is_scheduled_once_per_weekday(client):
    from datetime import datetime, timezone

    from app import accounts

    with SessionLocal() as db:
        db.execute(text("DELETE FROM jobs WHERE kind = 'account_review'"))
        db.commit()
    sat = datetime(2026, 10, 10, 23, tzinfo=timezone.utc)
    assert not accounts.schedule_evening_review(sat)
    early = datetime.now(timezone.utc).replace(hour=3)
    if early.weekday() < 5:
        assert not accounts.schedule_evening_review(early)
    late = datetime.now(timezone.utc).replace(hour=23, minute=0)
    if late.weekday() < 5:
        assert accounts.schedule_evening_review(late)
        assert not accounts.schedule_evening_review(late)
