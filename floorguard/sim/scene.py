"""Scene, control package and behaviour assumptions (validated inputs to the simulator)."""
from __future__ import annotations

import json
from pathlib import Path

from pydantic import BaseModel, Field, model_validator

SCENES = Path(__file__).resolve().parent.parent / "scenes"


class Occluder(BaseModel):
    name: str
    polygon: list[tuple[float, float]]
    height: float = Field(gt=0, description="metres; blocks sight if >= eye_block_height")


class Mirror(BaseModel):
    """Convex mirror on the column. Rectangles are (x0, y0, x1, y1) in metres."""
    position: tuple[float, float]
    ped_sees_lane: tuple[float, float, float, float]
    ped_zone: tuple[float, float, float, float]
    driver_sees_approach: tuple[float, float, float, float]
    driver_zone: tuple[float, float, float, float]


class Scene(BaseModel):
    name: str
    note: str = ""
    crossing_x: float = 0.0
    crossing_width: float = 2.0
    lane_y0: float
    lane_y1: float
    ped_y_start: float
    ped_y_end: float
    stop_line_offset_m: float = 3.0
    eye_block_height: float = 1.7
    occluders: list[Occluder]
    mirror: Mirror
    pallet_stress_rel: tuple[float, float, float, float]
    photo: dict = {}

    @classmethod
    def load(cls, name: str) -> "Scene":
        return cls.model_validate(json.loads((SCENES / f"{name}.json").read_text()))


class Package(BaseModel):
    """A set of controls. Bounds are enforced: the planner cannot propose anything else."""
    label: str = "custom"
    mirror: bool = False
    speed_limit_kmh: float | None = Field(default=None, ge=5, le=12)
    stop_line: bool = False
    crossing_offset_m: float = Field(default=0.0, ge=-6.0, le=0.0,
                                     description="move the crossing this far away from the column (negative x)")
    barrier_old_route: bool = False
    keep_clear: bool = False
    warning_light: bool = Field(default=False, description="sensor-triggered floor light warns pedestrians of an approaching forklift")
    ped_gate: bool = Field(default=False, description="swing gate at the lane edge: pedestrians stop and look before crossing")

    @model_validator(mode="after")
    def _barrier_needs_move(self):
        if self.barrier_old_route and self.crossing_offset_m == 0:
            raise ValueError("barrier_old_route only applies when the crossing is moved")
        return self

    def controls(self) -> list[str]:
        out = []
        if self.mirror: out.append("convex mirror on the column")
        if self.speed_limit_kmh is not None: out.append(f"{self.speed_limit_kmh:g} km/h speed sign")
        if self.stop_line: out.append("forklift stop line")
        if self.crossing_offset_m: out.append(f"crossing moved {abs(self.crossing_offset_m):g} m from the column")
        if self.barrier_old_route: out.append("barrier closing the old route")
        if self.keep_clear: out.append("keep-clear marking at the new crossing")
        if self.warning_light: out.append("sensor-triggered floor warning light")
        if self.ped_gate: out.append("pedestrian gate at the lane edge")
        return out or ["no change"]


class Assumptions(BaseModel):
    """Behaviour and geometry assumptions. Ranges are (low, high); every value is shown to the user."""
    forklift_kmh: tuple[float, float] = (8.0, 12.0)
    brake_ms2: tuple[float, float] = (1.5, 2.5)
    reaction_s: tuple[float, float] = (0.75, 1.5)
    ped_ms: tuple[float, float] = (1.2, 1.5)
    timing_window_s: tuple[float, float] = (-3.0, 5.0)
    ped_look: float = Field(0.85, ge=0, le=1)
    driver_attention: float = Field(0.9, ge=0, le=1)
    gate_compliance: float = Field(0.9, ge=0, le=1, description="share of pedestrians who stop at the gate rather than propping it or stepping around")
    light_alert: float = Field(0.95, ge=0, le=1, description="share of pedestrians who notice an active warning light")
    sign_compliance: float = Field(0.7, ge=0, le=1)
    stop_compliance: float = Field(0.6, ge=0, le=1)
    mirror_use: float = Field(0.5, ge=0, le=1)
    shortcut_share: float = Field(0.2, ge=0, le=1)
    pallet_prob: float = Field(0.0, ge=0, le=1)
    keep_clear_compliance: float = Field(0.7, ge=0, le=1)
    scale: float = Field(1.0, ge=0.5, le=1.5)


# Illustrative installed costs, shown as "enter your quotes"; never presented as real prices.
EXAMPLE_COSTS = {"mirror": 150, "speed_sign": 100, "stop_line": 200, "move_crossing": 800,
                 "barrier": 2500, "keep_clear": 150, "warning_light": 3500, "ped_gate": 1200}


def example_cost(p: Package) -> int:
    c = 0
    c += EXAMPLE_COSTS["mirror"] if p.mirror else 0
    c += EXAMPLE_COSTS["speed_sign"] if p.speed_limit_kmh is not None else 0
    c += EXAMPLE_COSTS["stop_line"] if p.stop_line else 0
    c += EXAMPLE_COSTS["move_crossing"] if p.crossing_offset_m else 0
    c += EXAMPLE_COSTS["barrier"] if p.barrier_old_route else 0
    c += EXAMPLE_COSTS["keep_clear"] if p.keep_clear else 0
    c += EXAMPLE_COSTS["warning_light"] if p.warning_light else 0
    c += EXAMPLE_COSTS["ped_gate"] if p.ped_gate else 0
    return c
