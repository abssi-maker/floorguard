"""2D geometry for the floor plan, in metres.

Everything is vectorized over N simulated crossing events: points are arrays of
shape (N,) per coordinate. Occluders are convex or concave polygons given as
(k, 2) vertex arrays; a sightline is blocked if it crosses any polygon edge.
"""
from __future__ import annotations

import numpy as np


def rect(x0: float, y0: float, x1: float, y1: float) -> np.ndarray:
    return np.array([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], dtype=float)


def _segments_cross(ax, ay, bx, by, cx, cy, dx, dy):
    """True where segment AB properly intersects segment CD (vectorized over A, B)."""
    def orient(px, py, qx, qy, rx, ry):
        return (qx - px) * (ry - py) - (qy - py) * (rx - px)

    o1 = orient(ax, ay, bx, by, cx, cy)
    o2 = orient(ax, ay, bx, by, dx, dy)
    o3 = orient(cx, cy, dx, dy, ax, ay)
    o4 = orient(cx, cy, dx, dy, bx, by)
    return (o1 * o2 < 0) & (o3 * o4 < 0)


def sightline_blocked(ax, ay, bx, by, polygon: np.ndarray, active=None) -> np.ndarray:
    """True where the segment A→B crosses the polygon boundary.

    `active` optionally masks which events have this occluder present
    (e.g. a pallet left in the sightline in only some events).
    """
    blocked = np.zeros_like(ax, dtype=bool)
    k = len(polygon)
    for i in range(k):
        cx, cy = polygon[i]
        dx, dy = polygon[(i + 1) % k]
        blocked |= _segments_cross(ax, ay, bx, by, cx, cy, dx, dy)
    if active is not None:
        blocked &= active
    return blocked


def point_in_rect(px, py, r: np.ndarray) -> np.ndarray:
    x0, y0 = r.min(axis=0)
    x1, y1 = r.max(axis=0)
    return (px >= x0) & (px <= x1) & (py >= y0) & (py <= y1)


def homography(src: np.ndarray, dst: np.ndarray) -> np.ndarray:
    """3x3 homography H with dst ~ H @ src, from 4+ point pairs (direct linear transform)."""
    rows = []
    for (x, y), (u, v) in zip(src, dst):
        rows.append([-x, -y, -1, 0, 0, 0, u * x, u * y, u])
        rows.append([0, 0, 0, -x, -y, -1, v * x, v * y, v])
    _, _, vt = np.linalg.svd(np.asarray(rows, dtype=float))
    h = vt[-1].reshape(3, 3)
    return h / h[2, 2]


def apply_homography(h: np.ndarray, pts: np.ndarray) -> np.ndarray:
    pts = np.asarray(pts, dtype=float)
    p = np.c_[pts, np.ones(len(pts))] @ h.T
    return p[:, :2] / p[:, 2:3]
