"""FastAPI server: access by link, the pages, recorded runs, live runs as server-sent events, photo upload and live crossings."""
from __future__ import annotations

import base64
import json
import os
import queue
import threading
import uuid
from datetime import date
from pathlib import Path

import numpy as np
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from .agents.llm import load_env
from .agents.loop import RUNS, STRESS_CATALOG, Limits, run
from .jsonsafe import clean
from .sim.model import PET_THRESHOLD, TTC_THRESHOLD, simulate
from .sim.scene import EXAMPLE_COSTS, Assumptions, Package, Scene

load_env()
WEB = Path(__file__).resolve().parent / "web"
UPLOADS = RUNS / "uploads"
MAX_LIVE_RUNS_PER_DAY = int(os.environ.get("MAX_LIVE_RUNS_PER_DAY", "30"))
MAX_PHOTO_BYTES = 8_000_000
_live = {"day": date.today(), "count": 0}
_lock = threading.Lock()

# Access links: FLOORGUARD_KEYS="judge:<key>,owner:<key>". Opening /access/<key> sets a cookie; everything else needs it.
KEYS = dict(reversed(pair.split(":", 1)) for pair in os.environ.get("FLOORGUARD_KEYS", "").split(",") if ":" in pair)
COOKIE = "fg_access"
OPEN = ("/access/", "/healthz", "/assets/", "/locked")

app = FastAPI(title="FloorGuard")
app.mount("/assets", StaticFiles(directory=WEB / "assets"), name="assets")


@app.middleware("http")
async def require_access(request: Request, call_next):
    path = request.url.path
    if path.startswith(OPEN) or request.cookies.get(COOKIE) in KEYS:
        return await call_next(request)
    if path.startswith("/api/") or path.startswith("/uploads/"):
        return JSONResponse({"detail": "FloorGuard is invite-only. Open your access link."}, status_code=401)
    return FileResponse(WEB / "locked.html", status_code=401)


@app.get("/access/{key}")
def access(key: str, next: str = "/"):
    if key not in KEYS:
        return RedirectResponse("/locked", status_code=303)
    resp = RedirectResponse(next if next.startswith("/") and not next.startswith("//") else "/", status_code=303)
    resp.set_cookie(COOKIE, key, max_age=60 * 60 * 24 * 60, httponly=True, samesite="lax")
    return resp


@app.get("/locked")
def locked():
    return FileResponse(WEB / "locked.html")


@app.get("/logout")
def logout():
    resp = RedirectResponse("/locked", status_code=303)
    resp.delete_cookie(COOKIE)
    return resp


@app.get("/healthz")
def healthz():
    return {"ok": True}


@app.get("/")
def dashboard():
    return FileResponse(WEB / "dashboard.html")


@app.get("/new")
def new_simulation():
    return FileResponse(WEB / "new.html")


@app.get("/report/{run_id}")
def report_page(run_id: str):
    return FileResponse(WEB / "report.html")


@app.get("/api/me")
def me(request: Request):
    return {"role": KEYS.get(request.cookies.get(COOKIE), "")}


@app.get("/api/scene/{name}")
def scene(name: str):
    sc = Scene.load(name)
    return {**sc.model_dump(), "example_costs_usd": EXAMPLE_COSTS,
            "stress_catalog": {k: v[0] for k, v in STRESS_CATALOG.items()},
            "default_limits": Limits().model_dump(), "default_assumptions": Assumptions().model_dump()}


def _records():
    return sorted(RUNS.glob("*.json"), reverse=True)


def _per_shift(r: dict, lim: dict) -> float:
    lam = lim["forklift_passes_per_hour"] / 3600
    return lim["crossings_per_shift"] * min(1.0, lam * r["window_s"]) * r["conflict_rate_per_1000"] / 1000


@app.get("/api/runs")
def runs():
    """Run summaries for the dashboard (baseline-only runs are left out)."""
    out = []
    for p in _records()[:50]:
        r = json.loads(p.read_text())
        if r.get("mode", "routed") != "routed":
            continue
        lim, today, best = r["limits"], r["single_controls"][0], r.get("recommendation")
        fails = sum(v > 2 * lim["target_conflicts_per_1000"] for v in (r["stress_results"].get(best["package"]["label"], {}) if best else {}).values())
        out.append({"id": r["id"], "created_utc": r["created_utc"], "provider": r["provider"], "verdict": r["verdict"],
                    "controls": best["controls"] if best else [], "photo_url": r.get("photo_url") or "/assets/w1.jpg",
                    "today_per_shift": _per_shift(today, lim), "best_per_shift": _per_shift(best, lim) if best else None,
                    "usual_per_shift": _per_shift(r["single_controls"][-1], lim), "cost_usd": best["example_cost_usd"] if best else None,
                    "stress_total": len(r["stress_tests"]), "stress_failed": fails,
                    "crossings": r["simulations"] * r["n"], "model_calls": len(r["trace"]),
                    "model_cost_usd": sum(c["cost_usd"] for c in r["trace"])})
    return out


@app.get("/api/runs/{run_id}")
def get_run(run_id: str):
    p = RUNS / f"{run_id}.json"
    if not p.resolve().is_relative_to(RUNS.resolve()) or not p.exists():
        raise HTTPException(404, "no such run")
    return clean(json.loads(p.read_text()))


EVIDENCE = Path(__file__).resolve().parents[1] / "evidence"


@app.get("/api/evidence")
def evidence():
    out = {}
    for name in ("baseline_search", "baseline_routing"):
        p = EVIDENCE / f"{name}.json"
        out[name] = json.loads(p.read_text()) if p.exists() else None
    return out


@app.post("/api/photo")
def upload_photo(body: dict):
    """A photo as a data URL (JPEG or PNG). Saved for this run's vision step."""
    data = str(body.get("image", ""))
    head, _, b64 = data.partition(",")
    ext = {"data:image/jpeg;base64": "jpg", "data:image/png;base64": "png"}.get(head)
    if not ext:
        raise HTTPException(400, "Send a JPEG or PNG photo.")
    raw = base64.b64decode(b64, validate=False)
    if len(raw) > MAX_PHOTO_BYTES:
        raise HTTPException(413, "That photo is over 8 MB. Use a smaller one.")
    UPLOADS.mkdir(parents=True, exist_ok=True)
    pid = f"{uuid.uuid4().hex[:12]}.{ext}"
    (UPLOADS / pid).write_bytes(raw)
    return {"photo_id": pid, "url": f"/uploads/{pid}"}


@app.get("/uploads/{name}")
def uploaded(name: str):
    p = UPLOADS / name
    if not p.resolve().is_relative_to(UPLOADS.resolve()) or not p.exists():
        raise HTTPException(404, "no such photo")
    return FileResponse(p)


@app.post("/api/crossings")
def crossings(body: dict):
    """A sample of real simulated crossings, frame by frame, for the live canvas: the worst ones plus random ones."""
    sc = Scene.load(body.get("scene", "w1"))
    pkg = Package.model_validate(body.get("package", {}))
    a = Assumptions.model_validate(body.get("assumptions", {}))
    k = int(min(max(body.get("k", 36), 6), 60))
    seed = int(body.get("seed", 1))
    full = simulate(sc, pkg, a, n=10_000, seed=seed)
    rng = np.random.default_rng(seed)
    idx = np.unique(np.r_[full.worst, rng.choice(10_000, size=k, replace=False)])[:k]
    rr = simulate(sc, pkg, a, n=10_000, seed=seed, indices=idx, record=True)
    d = rr.detail
    pet, ttc, hit = np.array(d["pet"]), np.array(d["min_ttc"]), np.array(d["collided"])
    conflict = hit | (pet < PET_THRESHOLD) | (ttc < TTC_THRESHOLD)
    return clean({**d, "conflict": conflict.tolist(), "label": pkg.label, "conflict_rate_per_1000": full.conflict_rate_per_1000})


@app.post("/api/run")
def live_run(body: dict):
    with _lock:
        if _live["day"] != date.today():
            _live.update(day=date.today(), count=0)
        if _live["count"] >= MAX_LIVE_RUNS_PER_DAY:
            raise HTTPException(429, "Today's live-run budget is used up; replay a recorded run instead.")
        _live["count"] += 1
    limits = Limits.model_validate(body.get("limits", {}))
    assumptions = Assumptions.model_validate(body.get("assumptions", {}))
    photo, photo_url = None, ""
    if body.get("photo_id"):
        p = UPLOADS / str(body["photo_id"])
        if not p.resolve().is_relative_to(UPLOADS.resolve()) or not p.exists():
            raise HTTPException(400, "Upload the photo again.")
        photo, photo_url = p, f"/uploads/{p.name}"
    q: queue.Queue = queue.Queue()

    def work():
        try:
            run(limits=limits, assumptions=assumptions, progress=q.put, photo=photo, photo_url=photo_url)
        except Exception as e:  # surfaced to the page as an error state, never hidden
            q.put({"stage": "error", "message": str(e)[:300]})
        q.put(None)

    threading.Thread(target=work, daemon=True).start()

    def stream():
        while (ev := q.get()) is not None:
            yield f"data: {json.dumps(clean(ev), default=str)}\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream")

