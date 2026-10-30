"""Rates, confidence bounds and manager-unit conversions."""
from __future__ import annotations

import math


def upper_bound_95(events: int, n: int) -> float:
    """One-sided 95% upper bound on a rate: rule of three at zero, Wilson otherwise."""
    if n <= 0:
        return float("nan")
    if events == 0:
        return 3.0 / n
    z = 1.6449  # one-sided 95%
    p = events / n
    centre = p + z * z / (2 * n)
    spread = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return (centre + spread) / (1 + z * z / n)


def per_1000(events: int, n: int) -> float:
    return 1000.0 * events / n if n else float("nan")


def close_calls_per_shift(rate_per_interaction: float, crossings_per_shift: float,
                          forklift_passes_per_hour: float, window_s: float) -> float:
    """Convert a per-interaction conflict rate into expected simulated conflicts per shift.

    An interaction is a crossing that happens while a forklift is within the
    simulated timing window. With forklifts passing at rate λ per second, the
    chance a crossing overlaps one is about λ·window (capped at 1).
    """
    lam = forklift_passes_per_hour / 3600.0
    p_interaction = min(1.0, lam * window_s)
    return crossings_per_shift * p_interaction * rate_per_interaction
