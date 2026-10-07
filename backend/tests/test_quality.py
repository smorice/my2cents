import pandas as pd
import pytest

from app.marketdata.quality import describe, neutralise_jumps


def panel(values, symbol="X"):
    idx = pd.bdate_range("2024-01-01", periods=len(values))
    return pd.DataFrame({symbol: values}, index=idx)


def test_unadjusted_reverse_split_is_neutralised_and_reported():
    close = panel([1.0, 1.1, 1.0, 100.0, 105.0])  # 1:100 regrouping missed by the source
    out, _, jumps = neutralise_jumps(close)
    r = out["X"].pct_change().dropna().round(6).tolist()
    assert r == pytest.approx([0.1, -1 / 11, 0.0, 0.05], abs=1e-6)
    assert out["X"].iloc[-1] == 105.0  # the latest price is never touched
    assert len(jumps) == 1 and jumps[0].change == pytest.approx(99.0)
    assert "+9900 %" in describe(jumps, {"X": "Atos"})[0] and describe(jumps, {"X": "Atos"})[0].startswith("Atos")


def test_genuine_crash_is_kept():
    close = panel([100.0, 41.0, 40.0])  # −59 % in a day, like Worldline in October 2023
    out, _, jumps = neutralise_jumps(close)
    assert jumps == [] and out["X"].tolist() == [100.0, 41.0, 40.0]


def test_successive_jumps_and_open_prices_are_rescaled_together():
    close = panel([10.0, 10.0, 80.0, 80.0, 8.0, 8.0])  # +700 % then −90 %
    open_ = close.copy()
    out, oout, jumps = neutralise_jumps(close, open_)
    assert len(jumps) == 2
    assert out["X"].pct_change().dropna().abs().max() == pytest.approx(0.0)
    assert (oout["X"] == out["X"]).all()
    assert out["X"].iloc[-1] == 8.0


def test_gaps_in_a_series_do_not_hide_a_jump():
    close = panel([10.0, None, None, 40.0, 41.0])
    _, _, jumps = neutralise_jumps(close)
    assert [round(j.change, 2) for j in jumps] == [3.0]
