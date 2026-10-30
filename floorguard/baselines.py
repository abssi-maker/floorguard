"""Honest baselines for the evidence page.

1. Agent versus random search: random packages from the same control space, evaluated with the
   same simulator, the same pass rule and the same stress tests, under the same simulation budget
   the agent used for its candidates. Reported whatever the outcome.
2. Routed versus all-Ultra: measured model time and cost of the same loop when every call goes to Ultra.

Usage: python -m floorguard.baselines search   |   python -m floorguard.baselines routing
"""
from __future__ import annotations

import json
import random
import statistics as st
import sys
from pathlib import Path

from .agents.loop import RUNS, STRESS_CATALOG, Limits, run
from .jsonsafe import clean
from .runners.local import LocalRunner
from .sim.scene import Package

OUT = Path(__file__).resolve().parents[1] / "evidence"


def random_package(rng: random.Random) -> Package:
    offset = rng.choice([0, 0, 0, -1, -2, -3, -4, -5, -6])
    return Package(
        label="random", mirror=rng.random() < 0.5,
        speed_limit_kmh=rng.choice([None, None, 5, 6, 7, 8, 9, 10]),
        stop_line=rng.random() < 0.5, crossing_offset_m=offset,
        barrier_old_route=bool(offset) and rng.random() < 0.5, keep_clear=rng.random() < 0.3,
        warning_light=rng.random() < 0.5, ped_gate=rng.random() < 0.5)


def search(seeds: int = 20) -> dict:
    agent_runs = [json.loads(p.read_text()) for p in sorted(RUNS.glob("*.json"))]
    agent_runs = [r for r in agent_runs if r.get("proposed") and "all_ultra" not in r.get("mode", "")]
    if not agent_runs:
        raise SystemExit("no agent runs recorded yet")
    ref = agent_runs[-1]
    limits = Limits.model_validate(ref["limits"])
    tests = list(ref["stress_tests"])
    budget = len(ref["proposed"]) + len(ref["revised"]) + len(tests) * (len(ref["proposed"]) + len(ref["revised"]))
    runner = LocalRunner()

    def job(p, overrides=None):
        a = dict(ref["assumptions"], **(overrides or {}))
        return {"scene": ref["scene"], "package": p.model_dump(), "assumptions": a, "n": ref["n"], "seed": ref["seed"]}

    def passes(r):
        return (r["conflict_rate_per_1000"] <= limits.target_conflicts_per_1000 and
                r["delay_s_per_truck"] <= limits.max_truck_delay_s and r["example_cost_usd"] <= limits.budget_usd)

    results = []
    for s in range(seeds):
        rng, used, best = random.Random(s), 0, None
        while used < budget:
            p = random_package(rng)
            r = runner.run([job(p)])[0]; used += 1
            if not passes(r) or used + len(tests) > budget:
                continue
            stressed = runner.run([job(p, STRESS_CATALOG[t][1]) for t in tests]); used += len(tests)
            if all(x["conflict_rate_per_1000"] <= 2 * limits.target_conflicts_per_1000 for x in stressed):
                if best is None or r["conflict_rate_per_1000"] < best["conflict_rate_per_1000"]:
                    best = {"controls": r["controls"], "conflict_rate_per_1000": r["conflict_rate_per_1000"],
                            "example_cost_usd": r["example_cost_usd"]}
        results.append(best)
    runner.close()

    agent = [{"id": r["id"], "controls": (r["recommendation"] or {}).get("controls"),
              "conflict_rate_per_1000": (r["recommendation"] or {}).get("conflict_rate_per_1000"),
              "example_cost_usd": (r["recommendation"] or {}).get("example_cost_usd"),
              "simulations_on_candidates": len(r["proposed"]) + len(r["revised"]) + len(r["stress_tests"]) * (len(r["proposed"]) + len(r["revised"]))}
             for r in agent_runs]
    found = [x for x in results if x]
    out = {
        "budget_simulations": budget, "stress_tests": tests, "limits": limits.model_dump(),
        "random_search": {"seeds": seeds, "found_rate": len(found) / seeds,
                          "median_best_conflicts_per_1000": st.median(x["conflict_rate_per_1000"] for x in found) if found else None,
                          "median_cost_usd": st.median(x["example_cost_usd"] for x in found) if found else None,
                          "results": results},
        "agent": {"runs": len(agent), "found_rate": sum(a["controls"] is not None for a in agent) / len(agent),
                  "median_best_conflicts_per_1000": st.median(a["conflict_rate_per_1000"] for a in agent if a["controls"]) if any(a["controls"] for a in agent) else None,
                  "median_cost_usd": st.median(a["example_cost_usd"] for a in agent if a["controls"]) if any(a["controls"] for a in agent) else None,
                  "runs_detail": agent},
    }
    OUT.mkdir(exist_ok=True)
    (OUT / "baseline_search.json").write_text(json.dumps(clean(out), indent=1))
    return out


def routing() -> dict:
    routed = [json.loads(p.read_text()) for p in sorted(RUNS.glob("*.json"))]
    routed = [r for r in routed if r.get("mode", "routed") == "routed" and r.get("trace")]
    ultra = run(all_ultra=True)
    def summary(rec):
        fast = [c for c in rec["trace"] if c["purpose"].startswith(("pick", "write"))]
        return {"id": rec["id"], "model_time_s": round(sum(c["latency_s"] for c in rec["trace"]), 1),
                "fast_role_time_s": round(sum(c["latency_s"] for c in fast), 1),
                "cost_usd": round(sum(c["cost_usd"] for c in rec["trace"]), 5), "calls": len(rec["trace"])}
    out = {"routed": [summary(r) for r in routed], "all_ultra": summary(ultra),
           "note": "Same loop; in all-Ultra mode the fast-role calls (stress-test pick, brief) also go to Nemotron 3 Ultra. Costs at Nebius list prices."}
    OUT.mkdir(exist_ok=True)
    (OUT / "baseline_routing.json").write_text(json.dumps(clean(out), indent=1))
    return out


if __name__ == "__main__":
    what = sys.argv[1] if len(sys.argv) > 1 else ""
    print(json.dumps({"search": search, "routing": routing}.get(what, lambda: __doc__)(), indent=1, default=str)[:3000])
