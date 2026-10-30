"""The FloorGuard agent loop: Nemotron proposes, the simulator tests, Nemotron revises.

Roles (the track's own advice: Ultra for serious reasoning, a fast model for everyday calls):
- planner (Nemotron 3 Ultra): proposes control packages, then revises them from measured results;
- fast (Nemotron Nano-class): picks stress tests from a fixed catalog, writes the plain-language brief;
- Python decides what passes. The model never computes outcomes and cannot change the manager's limits.
"""
from __future__ import annotations

import json
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

import numpy as np
from pydantic import BaseModel, Field

from ..jsonsafe import clean
from ..runners.local import LocalRunner, per_shift
from ..sim.model import simulate
from ..sim.scene import EXAMPLE_COSTS, Assumptions, Package, Scene
from .llm import Client
from .mapper import draft_map

RUNS = Path(__file__).resolve().parents[2] / "runs"

SINGLE_CONTROLS = [
    Package(label="Today (no change)"),
    Package(label="Convex mirror", mirror=True),
    Package(label="8 km/h speed sign", speed_limit_kmh=8),
    Package(label="Forklift stop line", stop_line=True),
    Package(label="Floor warning light", warning_light=True),
    Package(label="Pedestrian gate", ped_gate=True),
    Package(label="Move crossing 3 m", crossing_offset_m=-3),
]
USUAL_FIX = Package(label="Usual fix: mirror + 8 km/h sign", mirror=True, speed_limit_kmh=8)

STRESS_CATALOG = {
    "sign_compliance_50": ("Only half of drivers obey the speed sign", {"sign_compliance": 0.5}),
    "gate_compliance_60": ("40% of people prop the gate or step around it", {"gate_compliance": 0.6}),
    "slow_reactions": ("Slower driver reactions (1.2–2.0 s)", {"reaction_s": (1.2, 2.0)}),
    "pallet_in_sightline": ("A pallet left beside the crossing 30% of the time", {"pallet_prob": 0.3}),
    "shortcut_40": ("40% keep using the old route after a move", {"shortcut_share": 0.4}),
    "map_scale_minus_20": ("The map is 20% smaller than measured", {"scale": 0.8}),
    "night_shift_inattention": ("Tired night shift: fewer people look", {"ped_look": 0.7, "driver_attention": 0.8}),
    "mirror_ignored": ("Only a quarter of people check the mirror", {"mirror_use": 0.25}),
}


class Limits(BaseModel):
    target_conflicts_per_1000: float = 10.0
    max_truck_delay_s: float = 2.5
    budget_usd: float = 5000
    crossings_per_shift: int = 600
    forklift_passes_per_hour: int = 30


class Proposed(Package):
    why: str = Field(description="one sentence: the mechanism this package targets, citing a measured number")


class PlannerOut(BaseModel):
    hypothesis: str = Field(description="what the measured single-control results suggest is causing conflicts")
    packages: list[Proposed] = Field(min_length=1, max_length=3)


class StressPick(BaseModel):
    tests: list[str] = Field(min_length=3, max_length=3, description="ids from the catalog")
    why: str


class Revision(BaseModel):
    reasoning: str = Field(description="what the stress results showed, citing numbers")
    packages: list[Proposed] = Field(min_length=0, max_length=2)


class Brief(BaseModel):
    verdict: str = Field(description="one plain sentence a safety manager can repeat; say 'simulated'")
    why: str = Field(description="2-3 sentences on the mechanism, citing the measured numbers")
    floor_checks: list[str] = Field(min_length=2, max_length=5, description="what to measure or confirm on the floor before buying")
    after_install: list[str] = Field(min_length=2, max_length=4, description="real-world observations after installation (e.g. observed close calls per shift, share of people using the gate, pallets left in the zone), compared with the simulated expectation")


def _unique_labels(pkgs: list[Package], taken: set[str] | None = None) -> None:
    taken = set(taken or ())
    for p in pkgs:
        base, i = p.label, 2
        while p.label in taken:
            p.label = f"{base} ({i})"; i += 1
        taken.add(p.label)


def _table(results: list[dict], site: dict) -> list[dict]:
    return [{"label": r["package"]["label"], "controls": r["controls"],
             "conflicts_per_1000": round(r["conflict_rate_per_1000"], 1),
             "upper_95_per_1000": round(r["conflict_upper_95_per_1000"], 1),
             "close_calls_per_shift": round(per_shift(r, site), 2),
             "truck_delay_s": round(r["delay_s_per_truck"], 2), "ped_wait_s": round(r["ped_wait_s"], 2),
             "example_cost_usd": r["example_cost_usd"], "tag": r.get("tag", "")} for r in results]


def run(scene_name: str = "w1", limits: Limits | None = None, assumptions: Assumptions | None = None,
        n: int = 10_000, seed: int = 1, progress: Callable[[dict], None] = lambda e: None,
        provider: str | None = None, all_ultra: bool = False, photo: Path | None = None, photo_url: str = "") -> dict:
    limits = limits or Limits()
    a = assumptions or Assumptions()
    site = {"crossings_per_shift": limits.crossings_per_shift, "forklift_passes_per_hour": limits.forklift_passes_per_hour}
    scene = Scene.load(scene_name)
    llm = Client(provider)
    llm.resolve_models()
    if all_ultra:  # baseline: every call on the big model, to measure what routing saves
        llm.models["fast"] = llm.models["planner"]
    runner = LocalRunner()
    run_id = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:4]
    t0 = time.time()
    sims = 0
    close_calls = 0

    def evaluate(pkgs: list[Package], overrides: dict | None = None, tag: str = "") -> list[dict]:
        nonlocal sims
        aa = a.model_copy(update=overrides or {})
        jobs = [{"scene": scene_name, "package": p.model_dump(exclude={"why"}), "assumptions": aa.model_dump(),
                 "n": n, "seed": seed, "tag": tag} for p in pkgs]
        sims += len(jobs)
        out = runner.run(jobs)
        nonlocal close_calls
        close_calls += sum(r["conflicts"] for r in out)
        progress({"stage": "sims", "tag": tag, "simulations": sims, "crossings": sims * n, "close_calls": close_calls,
                  "results": [{"label": r["package"]["label"], "conflicts_per_1000": round(r["conflict_rate_per_1000"], 1)} for r in out]})
        return out

    def passes(r: dict) -> bool:
        return (r["conflict_rate_per_1000"] <= limits.target_conflicts_per_1000
                and r["delay_s_per_truck"] <= limits.max_truck_delay_s
                and r["example_cost_usd"] <= limits.budget_usd)

    progress({"stage": "models", "provider": llm.label, "models": llm.models})

    # 0. Nemotron Super VL drafts the scene from the photo, while the simulator tests every control alone.
    progress({"stage": "vision", "message": "Nemotron Super VL drafts the scene from the photo"})
    photo = photo or Path(__file__).resolve().parents[1] / "web" / "assets" / scene.photo.get("file", "w1.jpg")
    vision: dict = {}
    def _draft():
        try:
            vision.update(draft_map(llm, photo))
        except Exception as e:  # shown in the UI; the hand-confirmed map is used either way
            vision.update(available=False, objects=[], note=f"vision draft failed: {str(e)[:200]}")
    vt = threading.Thread(target=_draft)
    vt.start()

    # 1. Every control alone, plus the usual fix, on identical random crossings (no model involved).
    progress({"stage": "single_controls", "message": "Testing every control alone"})
    singles = evaluate(SINGLE_CONTROLS + [USUAL_FIX], tag="single")
    vt.join()
    progress({"stage": "vision_done", "objects": vision.get("objects", []), "model": vision.get("model", ""), "note": vision.get("note", "")})
    progress({"stage": "single_controls_done", "table": _table(singles, site), "lead_s": singles[0]["first_sight_lead_s_median"]})

    controls_catalog = {
        "mirror": "convex mirror on the column", "speed_limit_kmh": "speed sign, 5–12 km/h",
        "stop_line": "forklift stop line before the crossing", "crossing_offset_m": "move the crossing 0 to -6 m away from the column",
        "barrier_old_route": "barrier closing the old route (only with a moved crossing)",
        "keep_clear": "keep-clear marking at the new crossing", "warning_light": "sensor-triggered floor warning light",
        "ped_gate": "swing gate at the lane edge (stop and look)"}
    context = {
        "site": "Warehouse intersection: a forklift lane passes a pedestrian zebra crossing; a steel column and pallet stacks beside the crossing hide approaching forklifts from people about to cross.",
        "manager_limits": limits.model_dump(), "controls_allowed": controls_catalog,
        "example_costs_usd": EXAMPLE_COSTS, "behaviour_assumptions": a.model_dump(),
        "measured_single_controls": _table(singles, site),
        "metric": "simulated conflicts per 1,000 forklift–pedestrian interactions (time-to-collision < 1.5 s, post-encroachment time < 1.0 s, or contact)",
    }

    # 2. Ultra proposes packages from the measured single-control results.
    progress({"stage": "propose", "message": "Nemotron 3 Ultra proposes packages"})
    plan = llm.json_call("planner", "You are a warehouse traffic-safety engineer. Propose control packages that meet the manager's limits, "
                         "using the measured results only. Prefer controls higher in the hierarchy of controls (eliminate/separate, then engineering, then rules). "
                         "Each package must use only the allowed fields.", context, PlannerOut, "propose packages")
    _unique_labels(plan.packages)
    proposed = evaluate(plan.packages, tag="proposed")
    for p, r in zip(plan.packages, proposed):
        r["why"] = p.why
    progress({"stage": "proposed", "hypothesis": plan.hypothesis, "table": _table(proposed, site),
              "why": [p.why for p in plan.packages]})

    # 3. The fast model picks stress tests aimed at the best candidate's weak points.
    best = min(proposed, key=lambda r: (not passes(r), r["conflict_rate_per_1000"]))
    catalog = {k: v[0] for k, v in STRESS_CATALOG.items()}
    pick = llm.json_call("fast", "You are a skeptical safety auditor. Pick the 3 stress tests from the catalog most likely to break this package. "
                         "Return catalog ids in `tests`; in `why`, describe the tests in plain words and never write ids or field names.", {"package": best["controls"], "measured": _table([best], site)[0], "catalog": catalog},
                         StressPick, "pick stress tests")
    tests = [t for t in pick.tests if t in STRESS_CATALOG][:3]
    progress({"stage": "stress_pick", "tests": [{"id": t, "label": STRESS_CATALOG[t][0]} for t in tests], "why": pick.why})

    def stress(cands: list[dict]) -> dict:
        out = {}
        for t in tests:
            res = evaluate([Package.model_validate(c["package"]) for c in cands], STRESS_CATALOG[t][1], tag=f"stress:{t}")
            for c, r in zip(cands, res):
                out.setdefault(c["package"]["label"], {})[t] = round(r["conflict_rate_per_1000"], 1)
        return out

    stress_results = stress(proposed)
    progress({"stage": "stressed", "results": stress_results})

    # 4. Ultra revises from the measured stress results.
    progress({"stage": "revise", "message": "Nemotron 3 Ultra revises from the measured results"})
    rev = llm.json_call("planner", "You are a warehouse traffic-safety engineer. Revise the packages using the measured stress results. "
                        "Propose at most 2 new packages that fix what broke, or none if a tested package already holds up. "
                        "A package holds up only if every stress result stays at or under twice the target. Never repeat a tested package: each new one must change at least one control. "
                        "Refer to stress tests by their plain description, never by id, and never write field names.",
                        {**context, "proposed": _table(proposed, site), "stress_tests": {t: STRESS_CATALOG[t][0] for t in tests},
                         "stress_results": stress_results}, Revision, "revise packages")
    tested = [Package.model_validate(r["package"]).model_dump(exclude={"label"}) for r in proposed]
    rev.packages = [p for p in rev.packages if p.model_dump(exclude={"label", "why"}) not in tested]  # a repeat adds nothing
    _unique_labels(rev.packages, taken={r["package"]["label"] for r in proposed})
    revised = evaluate(rev.packages, tag="revised") if rev.packages else []
    for p, r in zip(rev.packages, revised):
        r["why"] = p.why
    if revised:
        stress_results.update(stress(revised))
    progress({"stage": "revised", "reasoning": rev.reasoning, "table": _table(revised, site)})

    # 5. Python decides.
    candidates = proposed + revised
    def robust(r):
        return all(v <= 2 * limits.target_conflicts_per_1000 for v in stress_results.get(r["package"]["label"], {}).values())
    ranked = sorted(candidates, key=lambda r: (not passes(r), not robust(r), r["conflict_rate_per_1000"], r["example_cost_usd"]))
    choice = ranked[0] if passes(ranked[0]) else None
    for r in candidates:
        r["passes_limits"], r["robust"] = passes(r), robust(r)

    # 6. The fast model writes the plain-language brief from computed numbers only.
    brief = None
    if choice:
        brief = llm.json_call("fast", "Write for a warehouse safety manager in plain words. Use only the numbers given. "
                              "Say 'simulated close calls' (not injuries), and 'per 1,000 forklift–pedestrian interactions' or 'per shift' (never 'per 1,000 crossings'). "
                              "Never write field names or underscores.",
                              {"recommended": _table([choice], site)[0], "stress": stress_results.get(choice["package"]["label"]),
                               "usual_fix": _table([singles[-1]], site)[0], "today": _table([singles[0]], site)[0],
                               "limits": limits.model_dump()}, Brief, "write decision brief")

    # Replays of the worst simulated conflict, for the screen: today, the usual fix, the recommendation.
    replays = {}
    for key, r in [("today", singles[0]), ("usual_fix", singles[-1])] + ([("recommended", choice)] if choice else []):
        if r["worst"]:
            pkg = Package.model_validate(r["package"])
            rr = simulate(scene, pkg, a.model_copy(update={}), n=n, seed=seed, indices=np.array(r["worst"][:1]), record=True)
            replays[key] = {"label": pkg.label, "controls": pkg.controls(), **rr.detail}

    record = {
        "id": run_id, "mode": "all_ultra" if all_ultra else "routed", "created_utc": datetime.now(timezone.utc).isoformat(), "scene": scene_name, "seed": seed, "n": n,
        "provider": llm.label, "provider_key": llm.provider, "models": llm.models, "runner": runner.name,
        "limits": limits.model_dump(), "assumptions": a.model_dump(),
        "single_controls": singles, "hypothesis": plan.hypothesis, "proposed": proposed,
        "stress_tests": {t: STRESS_CATALOG[t][0] for t in tests}, "stress_why": pick.why, "stress_results": stress_results,
        "revision_reasoning": rev.reasoning, "revised": revised,
        "recommendation": choice, "verdict": "recommend" if choice else "no tested package meets your limits",
        "brief": brief.model_dump() if brief else None,
        "replays": replays,
        "vision": vision, "photo_url": photo_url,
        "trace": llm.trace_dicts(), "simulations": sims, "wall_s": round(time.time() - t0, 1),
    }
    RUNS.mkdir(exist_ok=True)
    record = clean(record)
    (RUNS / f"{run_id}.json").write_text(json.dumps(record, indent=1, default=str, allow_nan=False))
    runner.close()
    progress({"stage": "done", "id": run_id})
    return record
