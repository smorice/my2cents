from datetime import date

import numpy as np
import pandas as pd
import pytest

from app.engine.backtester import BacktestConfig, Backtester, Contributions, CostModel, RiskModel
from app.engine.strategies.base import Context, Evaluation, Note, Strategy
from app.engine.strategies.library import REGISTRY, build


def make_prices(n=800, symbols=("AAA", "BBB", "CCC"), seed=1):
    rng = np.random.default_rng(seed)
    idx = pd.bdate_range("2018-01-01", periods=n)
    data = {}
    for k, s in enumerate(symbols):
        rets = rng.normal(0.0003 * (k + 1), 0.012, n)
        data[s] = 100 * np.exp(np.cumsum(rets))
    close = pd.DataFrame(data, index=idx)
    open_ = close.shift(1).fillna(close.iloc[0]) * (1 + rng.normal(0, 0.002, close.shape))
    bench = close.mean(axis=1)
    return close, open_, bench, bench.shift(1).fillna(bench.iloc[0])


def config(close, **kw):
    base = dict(
        start=close.index[300].date(), end=close.index[-1].date(), initial_capital=10_000.0,
        universe=list(close.columns), benchmark="BENCH", rebalance="monthly",
        costs=CostModel(fee_pct=0.0, fee_min=0.0, slippage_bps=0.0),
    )
    base.update(kw)
    return BacktestConfig(**base)


class Peeker(Strategy):
    """Fails if the engine ever exposes data beyond the decision date."""

    kind, name, summary, explanation, params = "peek", "peek", "", "", []
    seen: list = []

    def evaluate(self, ctx: Context) -> Evaluation:
        assert ctx.prices.index.max() <= ctx.date
        assert ctx.benchmark.index.max() <= ctx.date
        self.seen.append(ctx.date)
        return Evaluation({c: 1 / 3 for c in ctx.prices.columns}, {})


def test_no_lookahead():
    close, open_, b, bo = make_prices()
    s = Peeker()
    Backtester(s, config(close), close, open_, b, bo).run()
    assert len(s.seen) > 10


def test_orders_fill_on_next_open():
    close, open_, b, bo = make_prices()
    res = Backtester(build("buy_and_hold", {}), config(close), close, open_, b, bo).run()
    first_trade = res["trades"][0]
    assert first_trade["date"] == close.index[301].date().isoformat()
    assert first_trade["price"] == pytest.approx(open_.iloc[301][first_trade["symbol"]])


def test_buy_and_hold_tracks_prices_without_costs():
    close, open_, b, bo = make_prices()
    res = Backtester(build("buy_and_hold", {}), config(close), close, open_, b, bo).run()
    expected = sum(10_000 / 3 / open_.iloc[301][s] * close.iloc[-1][s] for s in close.columns)
    assert res["summary"]["strategy"]["final_value"] == pytest.approx(expected, rel=1e-9)


def test_costs_reduce_value_and_are_accounted():
    close, open_, b, bo = make_prices()
    free = Backtester(build("momentum", {"top_n": 1}), config(close), close, open_, b, bo).run()
    paid = Backtester(
        build("momentum", {"top_n": 1}),
        config(close, costs=CostModel(fee_pct=0.5, fee_min=2, slippage_bps=10)),
        close, open_, b, bo,
    ).run()
    assert paid["summary"]["strategy"]["final_value"] < free["summary"]["strategy"]["final_value"]
    assert paid["summary"]["strategy"]["fees"] == pytest.approx(sum(t["fees"] for t in paid["trades"]))


def test_dca_contributions_are_logged_and_invested():
    close, open_, b, bo = make_prices()
    cfg = config(close, contributions=Contributions(amount=500, frequency="monthly"))
    res = Backtester(build("buy_and_hold", {}), cfg, close, open_, b, bo).run()
    n = len(res["contributions"])
    assert n >= 15
    assert res["summary"]["strategy"]["total_invested"] == pytest.approx(10_000 + 500 * n)
    # Contributions are invested, not left in cash.
    assert res["series"]["cash_weight"][-1] < 0.02
    # Benchmark receives the same flows.
    assert res["series"]["invested"][-1] == pytest.approx(10_000 + 500 * n)


def test_pfu_tax_only_on_net_gains():
    close, open_, b, bo = make_prices()
    res = Backtester(
        build("momentum", {"top_n": 1, "lookback_days": 21}), config(close, tax_mode="pfu"), close, open_, b, bo
    ).run()
    by_year: dict[str, float] = {}
    for t in res["trades"]:
        if t["realized_pnl"] is not None:
            by_year[t["date"][:4]] = by_year.get(t["date"][:4], 0.0) + t["realized_pnl"]
    taxes = res["summary"]["strategy"]["taxes"]
    assert taxes >= 0
    assert taxes <= 0.3 * sum(max(v, 0) for v in by_year.values()) + 1e-6
    if any(v > 0 for v in by_year.values()):
        assert taxes > 0


def test_risk_caps_weights():
    close, open_, b, bo = make_prices()
    cfg = config(close, risk=RiskModel(max_weight_pct=20))
    res = Backtester(build("momentum", {"top_n": 1}), cfg, close, open_, b, bo).run()
    assert max(1 - w for w in res["series"]["cash_weight"][5:]) <= 0.25


@pytest.mark.parametrize("kind", sorted(REGISTRY))
def test_every_strategy_runs_and_explains(kind):
    close, open_, b, bo = make_prices()
    res = Backtester(build(kind, {}), config(close, rebalance="weekly"), close, open_, b, bo).run()
    s = res["summary"]["strategy"]
    assert np.isfinite(s["final_value"])
    assert all(d["reason"] for d in res["decisions"])
    assert len(res["series"]["dates"]) == len(res["series"]["equity"])


def test_benchmark_outperformance_rule():
    close, open_, b, bo = make_prices()
    strat = build("benchmark_outperformance", {"lookback_days": 63, "entry_threshold_pct": 3, "exit_threshold_pct": 0})
    i = 400
    ctx = Context(close.index[i], close.iloc[: i + 1], b.iloc[: i + 1], {}, {})
    ev = strat.evaluate(ctx)
    for s, note in ev.notes.items():
        excess = note.metrics["excess"]
        assert (s in ev.targets) == (excess >= 0.03)
        assert excess == pytest.approx(close[s].iloc[i] / close[s].iloc[i - 63] - b.iloc[i] / b.iloc[i - 63])


def test_param_validation():
    with pytest.raises(ValueError):
        build("golden_cross", {"fast": 200, "slow": 50})
    with pytest.raises(ValueError):
        build("momentum", {"lookback_days": 17})


def test_trades_point_to_their_decision():
    close, open_, b, bo = make_prices()
    res = Backtester(build("momentum", {"top_n": 1}), config(close), close, open_, b, bo).run()
    by_seq = {d["seq"]: d for d in res["decisions"]}
    assert [d["seq"] for d in res["decisions"]] == list(range(len(res["decisions"])))
    linked = [t for t in res["trades"] if t["decision_seq"] is not None]
    assert len(linked) == len(res["trades"])  # no contributions here: every order comes from a decision
    for t in linked:
        d = by_seq[t["decision_seq"]]
        assert d["symbol"] == t["symbol"] and d["date"] < t["date"]


def test_progress_is_reported():
    close, open_, b, bo = make_prices()
    seen = []
    Backtester(build("buy_and_hold", {}), config(close), close, open_, b, bo).run(progress=seen.append)
    assert seen[0] == 0 and 0.9 < seen[-1] <= 1 and seen == sorted(seen)


@pytest.mark.parametrize("kind,params", [
    ("buy_and_hold", {}), ("momentum", {"top_n": 1}), ("moving_average", {"sma_period": 50}), ("golden_cross", {"fast": 20, "slow": 50}),
    ("mean_reversion", {"trend_filter": False}), ("relative_strength", {"top_n": 1}),
    ("benchmark_outperformance", {"lookback_days": 21, "entry_threshold_pct": 1}),
])
def test_trade_decisions_are_explained(kind, params):
    close, open_, b, bo = make_prices()
    res = Backtester(build(kind, params), config(close, rebalance="weekly"), close, open_, b, bo).run()
    traded = [d for d in res["decisions"] if d["action"] in ("buy", "sell")]
    assert traded
    for d in traded:
        ex = d["explain"]
        assert ex and (ex["facts"] or ex["checks"])
        if d["action"] == "buy" and kind != "buy_and_hold":
            assert all(c["passed"] for c in ex["checks"]), (d["reason"], ex)


def test_window_and_rolling_analytics():
    from datetime import date as d_

    from app.engine import analytics

    close, open_, b, bo = make_prices()
    res = Backtester(build("buy_and_hold", {}), config(close, contributions=Contributions(amount=100, frequency="monthly")),
                     close, open_, b, bo).run()
    s = res["series"]
    full = analytics.window(s, d_.fromisoformat(s["dates"][0]))
    # Over the whole period the windowed TWR equals the engine's own.
    assert full["metrics"]["total_return"] == pytest.approx(res["summary"]["strategy"]["total_return"], rel=1e-6)
    assert full["strategy"][0] == 100
    last = d_.fromisoformat(s["dates"][-1])
    one_year = analytics.window(s, analytics.period_start("1Y", d_.fromisoformat(s["dates"][0]), last))
    assert one_year["strategy"][0] == 100 and 240 < len(one_year["dates"]) < 270
    assert analytics.period_start("YTD", d_(2000, 1, 1), last) == d_(last.year, 1, 1)
    r = analytics.rolling(s, 63)
    assert r["volatility"][10] is None and r["volatility"][-1] > 0
    assert r["gains"][-1] == pytest.approx(res["summary"]["strategy"]["net_profit"], rel=1e-6)


def test_benchmark_comparison_is_like_for_like():
    """Holding the benchmark itself, without costs, must reproduce the benchmark line exactly,
    contributions included: same cash flows, same execution prices, same valuation."""
    close, open_, b, bo = make_prices()
    uni = pd.DataFrame({"IDX": b})
    uni_open = pd.DataFrame({"IDX": bo})
    cfg = config(uni, universe=["IDX"], contributions=Contributions(amount=250, frequency="monthly"))
    res = Backtester(build("buy_and_hold", {}), cfg, uni, uni_open, b, bo).run()
    s = res["series"]
    assert s["equity"][-1] == pytest.approx(s["benchmark_equity"][-1], rel=1e-6)
    assert res["summary"]["strategy"]["cagr"] == pytest.approx(res["summary"]["benchmark"]["cagr"], abs=1e-6)
    assert s["invested"][-1] == pytest.approx(10_000 + 250 * len(res["contributions"]))
