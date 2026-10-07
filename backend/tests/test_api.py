"""End-to-end API tests. Need a throwaway Postgres in MY2CENTS_DATABASE_URL."""

import os
import time
from datetime import date

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

from app.db import Base, SessionLocal, engine  # noqa: E402
from app.main import app  # noqa: E402
from app.models import Instrument, PriceBar, utcnow  # noqa: E402

API = "/my2cents/api"
H = {"x-my2cents-csrf": "1"}
PW = "Correct-Horse-42"


@pytest.fixture(scope="module")
def client():
    with engine.begin() as c:
        c.execute(text("DROP SCHEMA public CASCADE; CREATE SCHEMA public;"))
    with TestClient(app) as tc:
        _seed_prices()
        yield tc


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
    for _ in range(120):
        bt = client.get(f"{API}/backtests/{bid}").json()
        if bt["status"] in ("done", "failed"):
            break
        time.sleep(0.25)
    assert bt["status"] == "done", bt.get("error")
    res = bt["results"]
    assert res["summary"]["strategy"]["total_invested"] > 10000
    assert len(res["contributions"]) > 40
    assert any("biais" in a.lower() or "anticipation" in a.lower() for a in res["assumptions"])
    dec = client.get(f"{API}/backtests/{bid}/decisions", params={"action": "buy"}).json()
    assert dec["total"] > 0 and "écart" in dec["items"][0]["reason"]
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
    for _ in range(120):
        p = client.get(f"{API}/portfolios/{pid}").json()
        if p["latest_simulation"]["status"] in ("done", "failed"):
            break
        time.sleep(0.25)
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
