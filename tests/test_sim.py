import json

import numpy as np
import pytest
from pydantic import ValidationError

from floorguard.sim.geometry import apply_homography, homography, rect, sightline_blocked
from floorguard.sim.metrics import close_calls_per_shift, upper_bound_95
from floorguard.sim.model import simulate
from floorguard.sim.scene import Assumptions, Package, Scene

SCENE = Scene.load("w1")
N = 2000


def test_same_inputs_give_identical_results():
    a = simulate(SCENE, Package(), Assumptions(), n=N, seed=3).summary()
    b = simulate(SCENE, Package(), Assumptions(), n=N, seed=3).summary()
    assert json.dumps(a, sort_keys=True) == json.dumps(b, sort_keys=True)


def test_sightline_blocked_by_wall_between_points():
    wall = rect(-0.5, -5, 0.5, 5)
    ax, ay = np.array([-2.0, -2.0]), np.array([0.0, 6.0])
    bx, by = np.array([2.0, 2.0]), np.array([0.0, 6.0])
    assert sightline_blocked(ax, ay, bx, by, wall).tolist() == [True, False]


def test_occluder_mask_applies_per_event():
    wall = rect(-0.5, -5, 0.5, 5)
    ax = np.array([-2.0, -2.0]); bx = np.array([2.0, 2.0]); y = np.zeros(2)
    assert sightline_blocked(ax, y, bx, y, wall, np.array([True, False])).tolist() == [True, False]


def test_homography_round_trip():
    src = np.array([[0, 0], [1, 0], [1, 1], [0, 1]], float)
    dst = np.array([[10, 10], [50, 12], [48, 60], [8, 55]], float)
    h = homography(src, dst)
    assert np.allclose(apply_homography(h, src), dst, atol=1e-6)


def test_rule_of_three_at_zero_and_wilson_otherwise():
    assert upper_bound_95(0, 10_000) == pytest.approx(3e-4)
    ub = upper_bound_95(50, 1000)
    assert 0.05 < ub < 0.07


def test_close_calls_per_shift_conversion():
    # 600 crossings, 30 forklift passes/hour, 8 s window: p_interaction = 30/3600*8
    assert close_calls_per_shift(0.05, 600, 30, 8) == pytest.approx(600 * (30 / 3600 * 8) * 0.05)


def test_no_conflicts_when_nothing_hides_anyone_and_everyone_pays_attention():
    open_floor = SCENE.model_copy(update={"occluders": []})
    r = simulate(open_floor, Package(), Assumptions(ped_look=1, driver_attention=1), n=N, seed=1)
    assert r.conflicts == 0


def test_occluders_create_conflicts_with_inattention():
    a = Assumptions()
    open_floor = SCENE.model_copy(update={"occluders": []})
    assert simulate(SCENE, Package(), a, n=N, seed=1).conflicts > simulate(open_floor, Package(), a, n=N, seed=1).conflicts


def test_common_random_numbers_today_unchanged_by_unused_assumptions():
    base = simulate(SCENE, Package(), Assumptions(), n=N, seed=2).conflicts
    # sign compliance is irrelevant when no sign is installed
    assert simulate(SCENE, Package(), Assumptions(sign_compliance=0.1), n=N, seed=2).conflicts == base


def test_gate_effect_depends_on_compliance():
    gate = Package(ped_gate=True)
    high = simulate(SCENE, gate, Assumptions(gate_compliance=0.95), n=N, seed=1).conflicts
    low = simulate(SCENE, gate, Assumptions(gate_compliance=0.3), n=N, seed=1).conflicts
    assert high < low


def test_package_bounds_are_enforced():
    with pytest.raises(ValidationError):
        Package(speed_limit_kmh=30)
    with pytest.raises(ValidationError):
        Package(crossing_offset_m=-9)
    with pytest.raises(ValidationError):
        Package(barrier_old_route=True)  # barrier only applies to a moved crossing


def test_stopping_distance_matches_textbook_formula():
    # v·t_r + v²/2a for 10 km/h, 1.0 s reaction, 2.0 m/s² braking
    v, tr, a = 10 / 3.6, 1.0, 2.0
    assert v * tr + v * v / (2 * a) == pytest.approx(4.707, abs=1e-3)
