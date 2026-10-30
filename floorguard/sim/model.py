"""Vectorized simulation of forklift–pedestrian crossing events at one intersection.

One *event* = one pedestrian walking the crossing while one forklift approaches
along the lane, with a random timing offset. N events run in parallel (numpy).

The model is deliberately simple and documented, not a validated safety model:
- forklift: desired speed, optional speed sign (with compliance), optional stop
  line (with compliance), driver attention, perception–reaction time, braking;
- pedestrian: walking speed, attention; an attentive pedestrian who can see an
  approaching forklift waits at the lane edge;
- line of sight: blocked by occluders taller than eye level; a mirror adds a
  view for the share of people who actually check it;
- conflict: collision, post-encroachment time (PET) < 1.0 s, or time to
  collision (TTC) < 1.5 s, the FHWA surrogate-safety style measures.

Random draws are raw uniforms generated once per seed and independent of the
package and assumptions, so every package is compared on common random numbers.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from .geometry import point_in_rect, rect, sightline_blocked
from .metrics import per_1000, upper_bound_95
from .scene import Assumptions, Package, Scene

DT = 0.05
T_MAX = 30.0
TRUCK_LEN = 2.4       # m, forklift body length along the lane
TRUCK_HALF_W = 0.6    # m
PED_R = 0.3           # m
PET_THRESHOLD = 1.0   # s
TTC_THRESHOLD = 1.5   # s
GAP_ACCEPT = 3.5      # s, pedestrian waits if a visible forklift arrives sooner
ACCEL = 1.0           # m/s², forklift acceleration back to target speed
STOP_LINE_DECEL = 1.5
CREEP = 1.4           # m/s through the crossing after a stop-line stop
LIGHT_RANGE_M = 12.0  # m, the warning light's sensor range along the lane
ANTICIPATE_M = 4.0    # m, distance from the lane at which a visible pedestrian prompts the driver to react

RAW_KEYS = ("vd", "brake", "react", "vp", "delta", "look", "attn", "sign", "stop",
            "mirror_p", "mirror_d", "short", "pallet", "gate")


def draw_raw(n: int, seed: int) -> dict[str, np.ndarray]:
    rng = np.random.default_rng(seed)
    return {k: rng.random(n) for k in RAW_KEYS}


def _lerp(u, lo_hi):
    lo, hi = lo_hi
    return lo + u * (hi - lo)


@dataclass
class SimResult:
    n: int
    conflicts: int
    collisions: int
    conflict_rate_per_1000: float
    conflict_upper_95_per_1000: float
    collisions_per_1000: float
    delay_s_per_truck: float
    ped_wait_s: float
    first_sight_lead_s_median: float
    worst: list[int] = field(default_factory=list)
    detail: dict = field(default_factory=dict)

    def summary(self) -> dict:
        return {k: v for k, v in self.__dict__.items() if k != "detail"}


def simulate(scene: Scene, pkg: Package, a: Assumptions, n: int = 10_000, seed: int = 0,
             indices: np.ndarray | None = None, record: bool = False) -> SimResult:
    raw = draw_raw(n, seed)
    if indices is not None:
        raw = {k: v[indices] for k, v in raw.items()}
    m = len(raw["vd"])
    s = a.scale

    # --- geometry (scaled about the original crossing) -------------------------------
    x0 = scene.crossing_x
    def sx(x):
        return x0 + (np.asarray(x) - x0) * s
    def sy(y):
        return np.asarray(y) * s
    y_lo, y_hi = sy(scene.lane_y0), sy(scene.lane_y1)
    fy = (y_lo + y_hi) / 2
    occluders = [(sx(np.asarray(o.polygon)[:, 0]), sy(np.asarray(o.polygon)[:, 1]), o.height)
                 for o in scene.occluders]
    occ_polys = [np.c_[px, py] for px, py, h in occluders if h >= scene.eye_block_height]

    new_x = sx(x0 + pkg.crossing_offset_m)
    moved = abs(pkg.crossing_offset_m) > 1e-9
    shortcut = moved & (not pkg.barrier_old_route) & (raw["short"] < a.shortcut_share)
    x_ped = np.where(shortcut, sx(x0), new_x)

    # temporary pallet left next to the (new) crossing, on the column side
    p_pallet = a.pallet_prob * (1 - a.keep_clear_compliance if pkg.keep_clear else 1)
    pallet_on = raw["pallet"] < p_pallet
    pallet_poly = rect(*(np.array(scene.pallet_stress_rel) * s + np.array([new_x, 0, new_x, 0])))

    # --- per-event parameters ---------------------------------------------------------
    vd = _lerp(raw["vd"], a.forklift_kmh) / 3.6
    if pkg.speed_limit_kmh is not None:
        complies = raw["sign"] < a.sign_compliance
        v_target = np.where(complies, np.minimum(vd, pkg.speed_limit_kmh / 3.6), vd)
    else:
        v_target = vd.copy()
    brake = _lerp(raw["brake"], a.brake_ms2)
    react = _lerp(raw["react"], a.reaction_s)
    vp = _lerp(raw["vp"], a.ped_ms)
    delta = _lerp(raw["delta"], a.timing_window_s)
    ped_attn = raw["look"] < a.ped_look
    drv_attn = raw["attn"] < a.driver_attention
    stop_comply = pkg.stop_line & (raw["stop"] < a.stop_compliance)
    mirror_p = pkg.mirror & (raw["mirror_p"] < a.mirror_use)
    mirror_d = pkg.mirror & (raw["mirror_d"] < a.mirror_use)
    light_alert = raw["look"] < max(a.ped_look, a.light_alert)
    gate_use = pkg.ped_gate & (raw["gate"] < a.gate_compliance)

    y_start, y_end = sy(scene.ped_y_start), sy(scene.ped_y_end)
    t_edge = (y_start - y_hi) / vp
    fx = x_ped + v_target * (t_edge + delta)     # arrives at the crossing ≈ delta s after the pedestrian reaches the lane
    fx_start = fx.copy()
    fv = v_target.copy()
    x_line = x_ped + scene.stop_line_offset_m * s

    py = np.full(m, y_start, dtype=float)
    waiting = np.zeros(m, bool)
    react_t = np.full(m, -1.0)
    braking = np.zeros(m, bool)
    line_state = np.zeros(m, np.int8)   # 0 approach, 1 stopped at line, 2 creeping, 3 done
    line_timer = np.zeros(m)

    collided = np.zeros(m, bool)
    ped_wait = np.zeros(m)
    p_in = np.full(m, np.inf); p_out = np.full(m, np.inf)
    f_in = np.full(m, np.inf); f_out = np.full(m, np.inf)
    min_ttc = np.full(m, np.inf)
    first_vis = np.full(m, np.inf)
    t_pass = np.full(m, np.inf)          # forklift front reaches x_ped - 5

    mir_ped_view, mir_ped_zone = rect(*scene.mirror.ped_sees_lane), rect(*scene.mirror.ped_zone)
    mir_drv_view, mir_drv_zone = rect(*scene.mirror.driver_sees_approach), rect(*scene.mirror.driver_zone)

    frames = [] if record else None
    steps = int(T_MAX / DT)
    for k in range(steps):
        t = k * DT
        # --- who can see whom ---
        blocked = np.zeros(m, bool)
        for poly in occ_polys:
            blocked |= sightline_blocked(x_ped, py, fx, np.full(m, fy), poly)
        blocked |= sightline_blocked(x_ped, py, fx, np.full(m, fy), pallet_poly, pallet_on)
        vis = ~blocked
        if pkg.mirror:
            mp = mirror_p & point_in_rect(fx, fy, mir_ped_view) & point_in_rect(x_ped, py, mir_ped_zone)
            md = mirror_d & point_in_rect(x_ped, py, mir_drv_view) & point_in_rect(fx, fy, mir_drv_zone)
        else:
            mp = md = np.zeros(m, bool)
        ahead = fx > x_ped - PED_R                     # forklift front has not passed the pedestrian line
        approaching = py > y_hi
        first_vis = np.where(np.isinf(first_vis) & (vis | mp | md) & ahead & approaching, t, first_vis)

        # --- pedestrian decision at the lane edge ---
        # A truck is "in the way" until its rear is 1 m past the crossing; while its
        # front is still approaching, the pedestrian judges the gap by its arrival time.
        rear_clear = fx + TRUCK_LEN < x_ped - PED_R - 1.0
        eta = np.where(ahead, (fx - x_ped - PED_R) / np.maximum(fv, 0.3), np.where(rear_clear, np.inf, 0.0))
        at_edge = approaching & (py <= y_hi + 0.5)
        light_on = pkg.warning_light & ahead & (fx <= x_ped + LIGHT_RANGE_M)
        # a gate makes everyone stop at the edge and look; a lit warning is noticed by most
        looking = ped_attn | (gate_use & at_edge)
        sees_truck = (looking & (vis | mp)) | (light_on & light_alert)
        waiting = np.where(at_edge & sees_truck & (eta < GAP_ACCEPT), True,
                           np.where(waiting & (eta >= GAP_ACCEPT), False, waiting))

        # --- driver decision ---
        # A driver who can see someone walking toward (or on) the crossing starts reacting:
        # anticipation begins within ANTICIPATE_M of the lane, not only at its edge.
        ped_in_path_soon = (py <= y_hi + ANTICIPATE_M) & (py >= y_lo - PED_R) & ~waiting
        hazard = ahead & ped_in_path_soon
        sees_ped = drv_attn & (vis | md)
        react_t = np.where(hazard & sees_ped & (react_t < 0), 0.0, react_t)
        react_t = np.where(react_t >= 0, react_t + DT, react_t)
        braking = hazard & (react_t >= react)
        cleared = ~hazard
        react_t = np.where(cleared, -1.0, react_t)

        # --- stop line ---
        to_line = fx - x_line
        approach_line = stop_comply & (line_state == 0)
        need_stop = approach_line & (to_line <= fv * fv / (2 * STOP_LINE_DECEL) + 0.05)
        line_state = np.where(approach_line & (to_line <= 0.05) & (fv <= 0.05), 1, line_state)
        line_timer = np.where(line_state == 1, line_timer + DT, line_timer)
        go = (line_state == 1) & (line_timer >= 1.0) & ~(hazard & sees_ped)
        line_state = np.where(go, 2, line_state)
        line_state = np.where((line_state == 2) & (fx < x_ped - 2.0), 3, line_state)

        # --- forklift speed and position ---
        target = np.where(line_state == 2, np.minimum(v_target, CREEP), v_target)
        decel = np.where(braking, brake, np.where(need_stop | (line_state == 1), STOP_LINE_DECEL, 0.0))
        fv = np.where(decel > 0, np.maximum(fv - decel * DT, 0.0),
                      np.minimum(fv + ACCEL * DT, target))
        fv = np.where(line_state == 1, 0.0, fv)
        fx = fx - fv * DT
        t_pass = np.where(np.isinf(t_pass) & (fx <= x_ped - 5.0), t + DT, t_pass)

        # --- pedestrian position ---
        ped_wait += np.where(waiting, DT, 0.0)
        py = np.where(waiting, py, py - vp * DT)

        # --- occupancy, collision, PET, TTC ---
        ped_in_strip = np.abs(py - fy) < TRUCK_HALF_W + PED_R
        truck_on_line = (fx <= x_ped + PED_R) & (fx + TRUCK_LEN >= x_ped - PED_R)
        collided |= ped_in_strip & truck_on_line
        p_in = np.where(ped_in_strip & np.isinf(p_in), t, p_in)
        p_out = np.where(~ped_in_strip & np.isfinite(p_in) & np.isinf(p_out), t, p_out)
        f_in = np.where(truck_on_line & np.isinf(f_in), t, f_in)
        f_out = np.where(~truck_on_line & np.isfinite(f_in) & np.isinf(f_out), t, f_out)

        t_f = np.where(fx > x_ped + PED_R, (fx - x_ped - PED_R) / np.maximum(fv, 1e-3), np.inf)
        # TTC only once the pedestrian has committed (is in the lane); someone walking up
        # to the edge to stop and yield is not on a collision course.
        t_p = np.where((py > fy + TRUCK_HALF_W + PED_R) & (py <= y_hi) & ~waiting,
                       (py - fy - TRUCK_HALF_W - PED_R) / vp, np.inf)
        dur_f = (TRUCK_LEN + 2 * PED_R) / np.maximum(fv, 1e-3)
        dur_p = 2 * (TRUCK_HALF_W + PED_R) / vp
        meet = np.isfinite(t_f) & np.isfinite(t_p) & (t_f < t_p + dur_p) & (t_p < t_f + dur_f)
        min_ttc = np.where(meet, np.minimum(min_ttc, np.maximum(t_f, t_p)), min_ttc)

        if record:
            frames.append([fx.copy(), py.copy(), vis.copy(), (mp | md).copy(), waiting.copy(), braking.copy()])
        if (fx < x_ped - 8).all() and (py < y_end).all():
            break

    pet = np.where(f_in > p_out, f_in - p_out, np.where(p_in > f_out, p_in - f_out, np.inf))
    pet = np.where(collided, 0.0, pet)
    conflict = collided | (pet < PET_THRESHOLD) | (min_ttc < TTC_THRESHOLD)

    dist = fx_start - (x_ped - 5.0)
    delay = np.where(np.isfinite(t_pass), t_pass - dist / vd, np.nan)
    meet_t = np.minimum(f_in, p_in)
    lead = np.where(conflict & np.isfinite(first_vis) & np.isfinite(meet_t), meet_t - first_vis, np.nan)

    severity = np.where(conflict, np.minimum(pet, min_ttc), np.inf)
    worst = [int(i) for i in np.argsort(severity)[:3] if np.isfinite(severity[i])]
    nc, ncol = int(conflict.sum()), int(collided.sum())
    res = SimResult(
        n=m, conflicts=nc, collisions=ncol,
        conflict_rate_per_1000=per_1000(nc, m),
        conflict_upper_95_per_1000=1000 * upper_bound_95(nc, m),
        collisions_per_1000=per_1000(ncol, m),
        delay_s_per_truck=float(np.nanmean(delay)),
        ped_wait_s=float(ped_wait.mean()),
        first_sight_lead_s_median=float(np.nanmedian(lead)) if np.isfinite(lead).any() else float("nan"),
        worst=worst,
    )
    if record:
        res.detail = {
            "dt": DT, "fy": float(fy), "x_ped": x_ped.tolist(), "y_lane": [float(y_lo), float(y_hi)],
            "frames": [[[float(v) for v in arr] for arr in f] for f in frames],
            "pet": pet.tolist(), "min_ttc": min_ttc.tolist(), "collided": collided.tolist(),
            "first_vis": first_vis.tolist(), "pallet_on": pallet_on.tolist(),
        }
    return res
