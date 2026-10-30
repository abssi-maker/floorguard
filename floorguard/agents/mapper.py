"""Nemotron Super VL drafts the scene from one photo: vehicles, people, crossings, sightline blockers.

The draft is shown to the user as detections; the simulation map itself is confirmed
by a person (one photo cannot give exact metres), and the UI says so.
"""
from __future__ import annotations

import base64
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field

from .llm import Client

PROMPT = """Locate objects for a forklift–pedestrian near-miss simulation in this warehouse photo.
Include every clearly visible vehicle and person, the main sightline blockers (columns, racks, pallet stacks),
any floor crossing markings, and up to 3 conflict points where vehicle and pedestrian paths meet with limited visibility.
Use precise vehicle labels (e.g. "counterbalance forklift", "reach truck"). Do not invent objects.
Boxes are [x0, y0, x1, y1] integers normalised to 0-1000 of image width and height."""


class Detection(BaseModel):
    label: str
    category: Literal["vehicle", "person", "sightline_blocker", "crossing_marking", "conflict_point"]
    box: list[int] = Field(min_length=4, max_length=4)


class Draft(BaseModel):
    objects: list[Detection]


def draft_map(llm: Client, image: Path) -> dict:
    if "vision" not in llm.models:
        return {"available": False, "objects": [], "note": f"No vision model on {llm.label}"}
    b64 = base64.b64encode(image.read_bytes()).decode()
    mime = "image/png" if image.suffix == ".png" else "image/jpeg"
    content = [{"type": "text", "text": PROMPT},
               {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}}]
    draft = llm.json_call("vision", "You draft scene maps for a safety simulation.", content, Draft,
                          "draft the scene from the photo", max_tokens=4000)
    return {"available": True, "model": llm.models["vision"], "objects": [o.model_dump() for o in draft.objects]}
