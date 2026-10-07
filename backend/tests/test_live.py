import pandas as pd
import pytest

from app.engine.backtester import CostModel, RiskModel
from app.engine.live import Holding, LiveConfig, due_mode, propose
from app.engine.strategies.library import REGISTRY, build

from test_engine import make_prices


def fixed(weights):
    return build("fixed_allocation", {"weights": weights})


def cfg(**kw):
    base = dict(costs=CostModel(fee_pct=0.0, fee_min=0.0, slippage_bps=0.0), fractional=False, min_order_value=0.0)
    base.update(kw)
    return LiveConfig(**base)


def run(strategy, holdings, cash, *, config=None, **kw):
    close, _, bench, _ = make_prices(400)
    return close, propose(strategy, config or cfg(), close, bench.rename("BENCH"), holdings, cash,
                          universe=list(close.columns), **kw)


def test_cash_only_account_buys_whole_shares_at_last_close():
    close, res = run(fixed({"AAA": 50, "BBB": 50}), {}, 10_000)
    last = close.iloc[-1]
    assert {o["symbol"] for o in res.orders} == {"AAA", "BBB"}
    for o in res.orders:
        assert o["side"] == "buy" and o["qty"] == int(o["qty"])
        assert o["price"] == pytest.approx(last[o["symbol"]])
        assert o["value"] <= 5_000 + 1e-6
    assert res.cash_after >= 0
    assert res.as_of == close.index[-1]


def test_fees_are_estimated_and_never_overspend():
    _, res = run(fixed({"AAA": 100}), {}, 1_000, config=cfg(costs=CostModel(fee_pct=0.5, fee_min=2.0, slippage_bps=0)))
    (o,) = res.orders
    assert o["fee_estimate"] == pytest.approx(max(2.0, o["value"] * 0.005))
    assert o["value"] + o["fee_estimate"] <= 1_000 + 1e-6


def test_sells_what_the_strategy_no_longer_holds_before_buying():
    close, res = run(fixed({"BBB": 100}), {"AAA": Holding(30, 90.0)}, 0)
    sides = [(o["side"], o["symbol"]) for o in res.orders]
    assert sides[0] == ("sell", "AAA") and res.orders[0]["qty"] == 30
    assert ("buy", "BBB") in sides  # financed by the sale


def test_small_drift_is_tolerated():
    close, _, bench, _ = make_prices(400)
    last = close.iloc[-1]
    # 50/50 by value, give or take one share: nothing worth trading.
    qa, qb = round(5_000 / last["AAA"]), round(5_000 / last["BBB"])
    res = propose(fixed({"AAA": 50, "BBB": 50}), cfg(), close, bench.rename("BENCH"),
                  {"AAA": Holding(qa, 1), "BBB": Holding(qb, 1)}, 0, universe=list(close.columns))
    assert res.orders == []
    assert {d["action"] for d in res.decisions} <= {"hold", "skip"}


def test_locked_lines_are_never_traded_nor_counted():
    _, res = run(fixed({"BBB": 100}), {"CCC": Holding(100, 50.0, locked=True)}, 5_000)
    assert all(o["symbol"] != "CCC" for o in res.orders)
    assert res.value == pytest.approx(5_000)


def test_stop_loss_sells_even_without_rebalance():
    close, _, bench, _ = make_prices(400)
    high_cost = float(close["AAA"].iloc[-1]) * 2  # position down 50 %
    res = propose(fixed({"AAA": 100}), cfg(risk=RiskModel(stop_loss_pct=20)), close, bench.rename("BENCH"),
                  {"AAA": Holding(10, high_cost)}, 0, universe=list(close.columns), mode="light")
    (o,) = res.orders
    assert o["side"] == "sell" and o["qty"] == 10 and "Stop-loss" in o["reason"]
    assert o["explain"]["checks"][0]["passed"] is True


def test_light_mode_invests_idle_cash_toward_last_targets():
    close, _, bench, _ = make_prices(400)
    res = propose(fixed({"AAA": 50, "BBB": 50}), cfg(), close, bench.rename("BENCH"), {}, 3_000,
                  universe=list(close.columns), mode="light", last_targets={"AAA": 0.5, "BBB": 0.5})
    assert res.targets is None
    assert {o["symbol"] for o in res.orders} == {"AAA", "BBB"}
    # Without targets from an earlier review there is nothing to aim for.
    res = propose(fixed({"AAA": 100}), cfg(), close, bench.rename("BENCH"), {}, 3_000, universe=list(close.columns), mode="light")
    assert res.orders == []


def test_min_order_value_filters_tiny_orders():
    _, res = run(fixed({"AAA": 99, "BBB": 1}), {}, 2_000, config=cfg(min_order_value=100, fractional=True))
    assert [o["symbol"] for o in res.orders] == ["AAA"]
    assert any("minimum" in w for w in res.warnings)


def test_due_mode_follows_the_rebalance_calendar():
    t = pd.Timestamp
    assert due_mode("monthly", t("2026-10-07"), None) == "full"
    assert due_mode("monthly", t("2026-10-07"), t("2026-10-01")) == "light"
    assert due_mode("monthly", t("2026-11-02"), t("2026-10-01")) == "full"
    assert due_mode("never", t("2026-11-02"), t("2026-10-01")) == "light"
    assert due_mode("weekly", t("2026-10-12"), t("2026-10-07")) == "full"


@pytest.mark.parametrize("kind", sorted(REGISTRY))
def test_every_strategy_proposes_explained_orders(kind):
    close, _, bench, _ = make_prices(600, symbols=tuple(f"S{k}" for k in range(8)))
    strategy = build(kind, {"weights": {"S0": 60, "S1": 40}} if kind == "fixed_allocation" else {})
    res = propose(strategy, cfg(fractional=True), close, bench.rename("BENCH"), {}, 20_000, universe=list(close.columns))
    for o in res.orders:
        assert o["reason"] and o["qty"] > 0
    assert all(d["reason"] for d in res.decisions)
