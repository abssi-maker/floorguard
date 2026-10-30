"""Local runner: evaluates packages in parallel worker processes (labeled "local", never "Sandboxes")."""
from __future__ import annotations

import time
from concurrent.futures import ProcessPoolExecutor

from ..sim.metrics import close_calls_per_shift
from ..sim.model import simulate
from ..sim.scene import Assumptions, Package, Scene, example_cost

NAME = "local process pool"


def evaluate(job: dict) -> dict:
    """job = {scene, package, assumptions, n, seed, tag}; returns a JSON-able result."""
    t = time.time()
    scene = Scene.load(job["scene"])
    pkg = Package.model_validate(job["package"])
    a = Assumptions.model_validate(job.get("assumptions", {}))
    r = simulate(scene, pkg, a, n=job.get("n", 10_000), seed=job.get("seed", 1))
    out = r.summary()
    out.update(package=pkg.model_dump(), controls=pkg.controls(), example_cost_usd=example_cost(pkg),
               assumptions=a.model_dump(), tag=job.get("tag", ""), runtime_s=round(time.time() - t, 2),
               window_s=a.timing_window_s[1] - a.timing_window_s[0])
    return out


def per_shift(result: dict, site: dict) -> float:
    return close_calls_per_shift(result["conflict_rate_per_1000"] / 1000, site["crossings_per_shift"],
                                 site["forklift_passes_per_hour"], result["window_s"])


class LocalRunner:
    name = NAME

    def __init__(self, workers: int = 4):
        self.pool = ProcessPoolExecutor(workers)
        self.workers = workers

    def run(self, jobs: list[dict]) -> list[dict]:
        return list(self.pool.map(evaluate, jobs))

    def close(self):
        self.pool.shutdown()
