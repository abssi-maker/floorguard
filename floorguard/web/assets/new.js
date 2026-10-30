// FloorGuard new simulation: photo → Nemotron reads it → 2D map → simulated crossings → blind spots → recommendation.
// Live runs stream events from /api/run; "Replay" rebuilds the same events from a recorded run. One paced player shows both.
import { $, ICONS, api, cap, crossingsPlayer, esc, floorSVG, fmt, header, human, modelName, perShift, providerName, setProvider, shadows, shiftNum, shortLabel, sleep, usd } from "./common.js";

const STEPS = ["Photo", "Nemotron reads the photo", "2D map", "Simulating crossings", "Blind spots", "Recommendation"];
const BOX = { vehicle: "#f5b800", person: "#2fbf71", sightline_blocker: "#ef4b33", crossing_marking: "#f2f1ec", conflict_point: "#ef4b33" };
const S = { scene: null, models: {}, photo: "/assets/w1.jpg", uploaded: false, img: { w: 1280, h: 997 }, crossings: 0, close: 0, pending: null, step: 0, player: null, replay: false, record: null, singles: null };

// ---------- layout ----------
function stepper() {
  return `<div class="stepper" id="stepper">${STEPS.map((t, i) => `${i ? `<span class="step-line" data-l="${i}"></span>` : ""}<span class="step" data-s="${i}"><span class="dot">${i + 1}</span>${t}</span>`).join("")}</div>`;
}
function setStep(i) {
  S.step = i;
  document.querySelectorAll(".step").forEach((el) => { const k = +el.dataset.s; el.className = `step ${k < i ? "done" : k === i ? "active" : ""}`; el.querySelector(".dot").textContent = k < i ? "✓" : k + 1; });
  document.querySelectorAll(".step-line").forEach((el) => el.classList.toggle("done", +el.dataset.l <= i));
  ["mPhoto", "mVision", "mMap"].forEach((id, k) => { if (k <= i) $(`#${id}`)?.classList.add("on"); });
  $("#progress span") && ($("#progress span").style.width = `${Math.round(100 * i / 6)}%`);
}
const badge = (kind, name, role) => `<span class="badge ${kind}">${esc(name)} <small>· ${esc(role)}</small></span>`;
const who = {
  vl: () => badge("vl", modelName(S.models.vision) || "Nemotron Super VL", "vision"),
  ultra: () => badge("ultra", modelName(S.models.planner) || "Nemotron 3 Ultra", "reasoning"),
  fast: () => badge("fast", modelName(S.models.fast) || "Nemotron Nano", "fast"),
  sim: () => badge("sim", "Simulator", "measures"),
  py: () => badge("sim", "Python rules", "decides"),
};
function feed(id, kind, text, state = "run") {
  let li = $(`#f-${id}`);
  if (!li) { li = document.createElement("li"); li.id = `f-${id}`; $("#feed").prepend(li); $("#feed").scrollTo({ top: 0, behavior: "smooth" }); }
  li.className = `fi ${state}`;
  li.innerHTML = `<span class="st"></span><div>${who[kind]()}<p>${text}</p></div>`;
  if (S.step >= 1 && !$("#canvas .done-overlay")) {
    let now = $("#now");
    if (!now) { now = document.createElement("div"); now.id = "now"; $("#canvas").appendChild(now); }
    now.className = `now ${state}`;
    now.innerHTML = `<span class="st"></span><div>${who[kind]()}<p>${text}</p></div>`;
  }
}
const caption = (html) => { $("#caption").innerHTML = html; };
const stage = (title, meta = "") => { $("#stageTitle").textContent = title; $("#stageMeta").textContent = meta; };

function tweenCount(target, close) {
  const el = $("#count"), cc = $("#close"), from = S.crossings, fromC = S.close, t0 = performance.now();
  S.crossings = target; S.close = close;
  const tick = () => {
    const k = Math.min(1, Math.max(0, (performance.now() - t0) / 1400)), e = 1 - (1 - k) ** 3;
    el.textContent = Math.round(from + (target - from) * e).toLocaleString("en-US");
    cc.textContent = Math.round(fromC + (close - fromC) * e).toLocaleString("en-US");
    if (k < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function photoSVG(objects = [], upto = Infinity) {
  const { w, h } = S.img;
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet"><image href="${esc(S.photo)}" width="${w}" height="${h}"/>` +
    objects.slice(0, upto).map((o) => {
      const [x0, y0, x1, y1] = o.box.map((v, i) => v / 1000 * (i % 2 ? h : w)), c = BOX[o.category] || "#fff", t = o.label, fs = Math.max(16, w / 55);
      return `<g><rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" fill="none" stroke="${c}" stroke-width="${w / 300}"/>
        <rect x="${x0}" y="${y0 - fs * 1.4}" width="${t.length * fs * 0.56 + 12}" height="${fs * 1.4}" fill="${c}"/>
        <text x="${x0 + 6}" y="${y0 - fs * 0.38}" font-size="${fs}" font-weight="600" font-family="Barlow" fill="${c === "#f2f1ec" || c === "#f5b800" ? "#15171b" : "#fff"}">${esc(t)}</text></g>`;
    }).join("") + `</svg>`;
}

// ---------- the start screen ----------
function pickScreen() {
  $("#main").innerHTML = stepper() + `<div class="panel pick">
    <div class="drop" id="drop">${ICONS.upload}<h3>Drop a photo of an intersection</h3>
      <p class="meta">A forklift lane meeting a pedestrian crossing: a new warehouse, or a layout you plan to change. JPEG or PNG, up to 8 MB.</p>
      <label class="btn ghost">${ICONS.camera}Choose a photo<input type="file" accept="image/jpeg,image/png" id="file" hidden></label></div>
    <div id="chosen"></div>
    <div class="or"><button class="btn primary" id="start" disabled title="Choose a photo first">${ICONS.play}Start simulation</button>
      <button class="btn quiet" id="useSample">Load sample photo</button>
      <a class="btn quiet" id="replayLink" href="#">Watch recorded demo</a></div></div>`;
  setStep(0);
  let file = null;
  const drop = $("#drop");
  const show = (src, name) => {
    $("#start").disabled = false; $("#start").title = ""; $("#chosen").innerHTML = "";
    drop.classList.add("has");
    drop.innerHTML = `<div class="picked"><img src="${esc(src)}" alt="The photo to simulate"><div><p class="tag">Photo ready</p><h3 style="margin-top:.6rem">${esc(name)}</h3>
      <p>Nemotron Super VL will read this photo, then FloorGuard simulates the intersection.</p>
      <label class="btn quiet" style="margin-top:.9rem">Choose another photo<input type="file" accept="image/jpeg,image/png" id="file2" hidden></label></div></div>`;
    $("#file2").addEventListener("change", (e) => take(e.target.files[0]));
  };
  const take = (f) => {
    if (!f || !/^image\/(jpeg|png)$/.test(f.type)) { $("#chosen").innerHTML = `<p class="red" style="margin-top:1rem">Use a JPEG or PNG photo.</p>`; return; }
    file = f; show(URL.createObjectURL(f), f.name);
  };
  $("#file").addEventListener("change", (e) => take(e.target.files[0]));
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); take(e.dataTransfer.files[0]); });
  $("#useSample").addEventListener("click", () => { file = null; show("/assets/w1.jpg", "Sample warehouse photo (Wikimedia Commons, CC BY-SA 3.0)"); });
  $("#replayLink").addEventListener("click", async (e) => { e.preventDefault(); const runs = await api("/api/runs"); if (runs[0]) startReplay(runs[0].id); });
  $("#start").addEventListener("click", () => startLive(file));
  if (new URLSearchParams(location.search).has("sample")) $("#useSample").click();
}

function simScreen() {
  $("#main").innerHTML = stepper() + `<div class="sim">
    <div class="left">
      <div class="panel mini" id="mPhoto"><h4>Your photo</h4><div class="frame"><img src="${esc(S.photo)}" alt=""></div></div>
      <div class="panel mini" id="mVision"><h4>Nemotron read the photo</h4><div class="frame" id="mVisionF"></div><p class="cap" id="mVisionC">waiting…</p></div>
      <div class="panel mini" id="mMap"><h4>2D map, confirmed</h4><div class="frame map" id="mMapF"></div><p class="cap">A person confirmed the crossing, the column and the lane.</p></div>
    </div>
    <div class="panel stage">
      <div class="stage-h"><h2 id="stageTitle">Starting</h2><span class="meta" id="stageMeta"></span></div>
      <div class="counter"><span class="big" id="count">0</span><span class="of">crossings simulated</span><span class="bar" id="progress"><span></span></span><span class="cc">close calls, all scenarios: <span id="close">0</span></span></div>
      <div class="canvas" id="canvas"><div class="layer photo-layer" id="photoLayer"></div><svg class="layer" id="mapLayer" style="opacity:0"></svg></div>
      <div class="caption" id="caption"></div>
      <div class="legend"><span><i style="width:22px;height:11px;background:#f5b800;border-radius:3px"></i>Forklift</span><span><i style="width:12px;height:12px;border-radius:50%;background:#f2f1ec"></i>Pedestrian</span>
        <span><i style="width:24px;border-top:2px solid #2fbf71"></i>Can see each other</span><span><i style="width:24px;border-top:2px dashed #ef4b33"></i>Sight line blocked</span><span><i style="width:14px;height:14px;border-radius:50%;background:radial-gradient(#ef4b33,transparent)"></i>Close call</span></div>
    </div>
    <div class="panel feed"><div class="panel-h"><h3>Nemotron at work</h3></div><ol id="feed"></ol><p class="meta" id="feedMeta"></p></div>
  </div>`;
  setStep(1);
}

// ---------- the paced player ----------
const queue = [];
let wake = null;
const push = (ev) => { queue.push(ev); wake?.(); };
const next = async () => { while (!queue.length) await new Promise((r) => (wake = r)); return queue.shift(); };

async function player() {
  for (;;) {
    const ev = await next();
    if (S.replay) await sleep({ propose: 1800, proposed: 2600, stress_pick: 2600, stressed: 2200, revise: 1800, revised: 2600, done: 1800 }[ev.stage] || 300);
    const h = handlers[ev.stage];
    if (h) await h(ev);
    if (ev.stage === "done" || ev.stage === "error") return;
  }
}

const handlers = {
  models: (ev) => { S.models = ev.models; setProvider(ev.provider); $("#feedMeta").textContent = `Models on ${providerName(ev.provider)}`; },
  vision: async () => {
    stage("Nemotron reads the photo", modelName(S.models.vision));
    $("#photoLayer").innerHTML = photoSVG() + `<div class="scan"></div>`;
    caption(`<b>${esc(modelName(S.models.vision) || "Nemotron Super VL")}</b> is looking for forklifts, people, crossings and anything that blocks a line of sight.`);
    feed("vision", "vl", "Reading the photo…");
  },
  sims: (ev) => { if (S.step >= 3) tweenCount(ev.crossings, ev.close_calls); else S.pending = ev; },
  vision_done: async (ev) => {
    const objs = ev.objects?.length ? ev.objects : (await (await fetch("/assets/w1.boxes.json")).json()).objects;
    $("#photoLayer .scan")?.remove();
    for (let i = 1; i <= objs.length; i++) { $("#photoLayer").innerHTML = photoSVG(objs, i); await sleep(Math.max(120, 1600 / objs.length)); }
    $("#mVisionF").innerHTML = photoSVG(objs);
    const kinds = (c) => objs.filter((o) => o.category === c).length, n = (k, one, many) => `${k} ${k === 1 ? one : many}`;
    $("#mVisionC").textContent = `${objs.length} objects · ${n(kinds("vehicle"), "vehicle", "vehicles")} · ${n(kinds("person"), "person", "people")} · ${n(kinds("sightline_blocker"), "sight-line blocker", "sight-line blockers")}`;
    feed("vision", "vl", `Found <b>${objs.length} objects</b>: ${n(kinds("vehicle"), "vehicle", "vehicles")}, ${n(kinds("person"), "person", "people")}, ${n(kinds("sightline_blocker"), "thing", "things")} that block a line of sight${kinds("crossing_marking") ? ", the crossing" : ""}.`, "done");
    caption(`Found <b>${objs.length} objects</b>. Its draft is a starting point: a person confirms the map before anything is simulated.`);
    await sleep(2200);
    setStep(2);
    // photo → floor plan
    stage("2D map", "metres, top-down");
    const f = floorSVG(S.scene, { w: 960, h: 600 });
    $("#mapLayer").setAttribute("viewBox", "0 0 960 600"); $("#mapLayer").innerHTML = f.svg;
    $("#photoLayer").classList.add("flat"); $("#mapLayer").style.opacity = 1;
    $("#mMapF").innerHTML = `<svg viewBox="0 0 960 600">${floorSVG(S.scene, { w: 960, h: 600, labels: false }).svg}</svg>`;
    caption(`The photo becomes a floor plan in metres: a 3.5 m forklift lane, a 2 m zebra crossing, and a steel column 1.4 m from it with pallet stacks above eye height behind it.` +
      (S.uploaded ? `<div class="limit-note">Your photo was read by Nemotron. Distances come from the confirmed map of the sample intersection; for your own site, a person confirms them in the same way.</div>` : ""));
    await sleep(2200);
    if (S.replay) { caption($("#caption").innerHTML + `<p class="meta" style="margin-top:.5rem">Map confirmed by a person in this recorded run.</p>`); await sleep(2200); }
    else {
      caption($("#caption").innerHTML + `<div class="confirm" style="margin-top:.8rem"><span>Check the crossing, the column and the forklift lane.</span><button class="btn primary" id="confirmMap">Confirm map &amp; simulate</button></div>`);
      await new Promise((r) => $("#confirmMap").addEventListener("click", r, { once: true }));
    }
    setStep(3);
    stage("Live simulation", "simulated results");
    caption(`Every forklift and person below is a real simulated crossing: random speeds, reaction times and arrival times. <b>Red dashes</b>: they can't see each other. A <b>red ring</b> marks a close call (time to collision under 1.5 s, or contact).`);
    feed("sim1", "sim", "Testing today's layout and every control on its own, 10,000 crossings each…");
    if (S.pending) { tweenCount(S.pending.crossings, S.pending.close_calls); S.pending = null; }
    try {
      const data = await api("/api/crossings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ package: {}, k: 40 }) });
      $("#photoLayer").style.display = "none";
      S.player = crossingsPlayer($("#mapLayer"), S.scene, data, { stagger: 6 });
    } catch {}
  },
  single_controls_done: async (ev) => {
    S.singles = ev.table;
    await sleep(5200);
    const today = ev.table[0], t = 10, alone = ev.table.slice(1, -1).filter((r) => r.conflicts_per_1000 <= t);
    feed("sim1", "sim", `Today: <b>${fmt(today.conflicts_per_1000)} close calls per 1,000</b> (${shiftNum(today.close_calls_per_shift)} per shift). The usual fix, mirror + speed sign: ${fmt(ev.table.at(-1).conflicts_per_1000)}. ${alone.length ? `Only ${alone.map((r) => shortLabel(r.label).toLowerCase()).join(", ")} meets the target alone.` : "No control meets the target alone."}`, "done");
    setStep(4);
    stage("Blind spots", "seen from a person waiting to cross");
    S.player?.overlay(shadows(S.scene, S.scene.crossing_x, S.scene.lane_y1 + 0.7, S.player.X, S.player.Y) +
      `<text x="${S.player.X(7)}" y="${S.player.Y(2.4)}" fill="#ef4b33" font-family="Barlow Condensed" font-weight="700" font-size="30" paint-order="stroke" stroke="#121418" stroke-width="5">BLIND SPOT</text>`);
    if (Number.isFinite(ev.lead_s)) $("#canvas").insertAdjacentHTML("beforeend", `<div class="callout"><b>Hidden by the column + pallets</b><span>Only ${fmt(ev.lead_s, 1)} s to react in a typical close call</span></div>`);
    caption(`The red wedge is what a person waiting to cross <b>cannot see</b>: forklifts coming from the right are hidden by the column and the pallet stacks. ${Number.isFinite(ev.lead_s) ? `In a typical close call they first see each other only <b>${fmt(ev.lead_s, 1)} s</b> before they meet.` : ""}`);
    await sleep(6500);
    $("#canvas .callout")?.remove();
    setStep(5);
    stage("Recommendation", "Nemotron proposes · the simulator measures · Nemotron revises");
  },
  propose: () => { feed("propose", "ultra", "Proposing control packages from the measured numbers…"); caption(`<b>${esc(modelName(S.models.planner))}</b> reads every measured result and proposes packages of controls, preferring separation and engineering over signs.`); },
  proposed: (ev) => feed("propose", "ultra", `Proposed <b>${ev.table.length} packages</b>: ${ev.table.map((r) => `${esc(shortLabel(r.label))} (${fmt(r.conflicts_per_1000)})`).join(" · ")}`, "done"),
  stress_pick: (ev) => { feed("stress", "fast", `Picked <b>${ev.tests.length} stress tests</b> to break them: ${ev.tests.map((t) => esc(t.label.toLowerCase())).join(" · ")}`, "done"); feed("stressrun", "sim", "Running every package under every stress test…"); caption(`<b>${esc(modelName(S.models.fast))}</b> plays the skeptic: it picks the conditions most likely to break each package.`); },
  stressed: (ev) => feed("stressrun", "sim", `Ran <b>${Object.keys(ev.results).length} packages × ${Object.keys(Object.values(ev.results)[0] || {}).length + 1} conditions</b>. The model never computes an outcome.`, "done"),
  revise: () => { feed("revise", "ultra", "Revising from the measured stress results…"); caption(`<b>${esc(modelName(S.models.planner))}</b> sees what broke under stress and designs packages that hold.`); },
  revised: (ev) => feed("revise", "ultra", ev.table.length ? `Added <b>${ev.table.length} new package${ev.table.length > 1 ? "s" : ""}</b>: ${ev.table.map((r) => `${esc(shortLabel(r.label))} (${fmt(r.conflicts_per_1000)})`).join(" · ")}` : "Kept the tested packages; none needed a fix.", "done"),
  error: (ev) => {
    feed("err", "sim", `<span class="red">${esc(ev.message)}</span>`, "done");
    caption(`<span class="red">The run stopped: ${esc(ev.message)}</span> <a class="btn quiet" href="/new">Try again</a> <a class="btn quiet" href="/">Back to the dashboard</a>`);
  },
  done: async (ev) => {
    const r = S.record || await api(`/api/runs/${ev.id}`);
    const lim = r.limits, today = r.single_controls[0], usual = r.single_controls.at(-1), best = r.recommendation;
    feed("decide", "py", best ? `Picked <b>${esc(shortLabel(best.package.label).toLowerCase())}</b>: meets your limits and stays under twice the target in every stress test.` : "No package meets your limits.", "done");
    if (r.brief) feed("brief", "fast", "Wrote the decision brief from the computed numbers.", "done");
    $(".counter").innerHTML = best ? `<span class="of">Simulated close calls per shift</span><span class="big"><span class="red">${shiftNum(perShift(today, lim))}</span><span class="arrow">→</span><span class="green">${shiftNum(perShift(best, lim))}</span></span><span class="meta" style="margin-left:auto">${(r.simulations * r.n).toLocaleString("en-US")} crossings across all tested scenarios</span>` : `<span class="of">No package met your limits</span>`;
    $("#feedMeta").textContent = `${r.trace.length} model calls on ${providerName(r.provider)} · ${fmt(r.trace.reduce((a, c) => a + c.latency_s, 0), 0)} s of model time · $${fmt(r.trace.reduce((a, c) => a + c.cost_usd, 0), 3)}`;
    setStep(6);
    stage(best ? "Recommendation" : "No package met your limits", "simulated");
    if (best) {
      try {
        const data = await api("/api/crossings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ package: best.package, k: 40 }) });
        S.player?.stop();
        S.player = crossingsPlayer($("#mapLayer"), S.scene, data, { pkg: best.package, stagger: 3, loop: false, onEnd: () => finish(r) });
        setTimeout(() => finish(r), 3 * 40 * 50 + data.frames.length * 50 + 1500);  // in case the tab throttles animation frames
      } catch {}
    }
    if (!best || !S.player) finish(r);
    caption(best ? `<div style="display:flex;align-items:center;justify-content:space-between;gap:1.2rem;flex-wrap:wrap">
        <div><p style="font-family:var(--display);font-size:1.9rem;font-weight:700;color:var(--text)">${esc(cap(shortLabel(best.package.label).toLowerCase()))}</p>
        <p class="meta" style="margin:.2rem 0 .4rem">${esc(cap(best.controls.join(" · ")))}</p><p>Close calls drop from <b class="red">${shiftNum(perShift(today, lim))}</b> to <b class="green">${shiftNum(perShift(best, lim))}</b> per shift (${human(perShift(best, lim))}). The usual fix only reaches ${shiftNum(perShift(usual, lim))}. Example cost ${usd(best.example_cost_usd)}.</p></div>
        <a class="btn primary" href="/report/${esc(r.id)}">Open the full report</a></div>`
      : `No tested package meets your limits. <a class="btn primary" href="/report/${esc(r.id)}">See what was tested</a>`);
  },
};

// The report is ready: stop the simulation and put the answer where the user is looking.
function finish(r) {
  S.player?.stop();
  $("#now")?.remove();
  if ($("#canvas .done-overlay")) return;
  const lim = r.limits, best = r.recommendation, today = r.single_controls[0];
  $("#canvas").insertAdjacentHTML("beforeend", `<div class="done-overlay"><div class="done-card">
    <p class="tag">${best ? "Report ready · simulated" : "Report ready"}</p>
    <h2>${best ? esc(cap(shortLabel(best.package.label).toLowerCase())) : "No package met your limits"}</h2>
    ${best ? `<p class="big"><span class="red">${shiftNum(perShift(today, lim))}</span><span class="arrow">→</span><span class="green">${shiftNum(perShift(best, lim))}</span><small> close calls per shift</small></p>` : ""}
    <div class="done-actions"><a class="btn primary" href="/report/${esc(r.id)}">See full report</a><button class="btn quiet" id="again">Replay the simulation</button></div></div></div>`);
  $("#again").addEventListener("click", () => { $("#canvas .done-overlay").remove(); S.player?.stop(); api("/api/crossings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ package: best?.package || {}, k: 40 }) })
    .then((data) => { S.player = crossingsPlayer($("#mapLayer"), S.scene, data, { pkg: best?.package, stagger: 3, loop: false, onEnd: () => finish(r) }); }); });
}

// ---------- start a live run, or replay a recorded one ----------
async function begin(photo, uploaded) {
  S.photo = photo; S.uploaded = uploaded;
  const im = new Image(); im.src = photo; await Promise.race([im.decode().catch(() => {}), sleep(1500)]); if (im.naturalWidth) S.img = { w: im.naturalWidth, h: im.naturalHeight };
  simScreen();
  player();
}

async function startLive(file) {
  let photoId = null, url = "/assets/w1.jpg";
  $("#start").disabled = true;
  try {
    if (file) {
      const data = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(file); });
      const up = await api("/api/photo", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ image: data }) });
      photoId = up.photo_id; url = up.url;
    }
  } catch (e) { $("#chosen").innerHTML = `<p class="red" style="margin-top:1rem">${esc(e.message)}</p>`; $("#start").disabled = false; return; }
  await begin(url, !!file);
  try {
    const res = await fetch("/api/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ photo_id: photoId }) });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || res.statusText);
    const reader = res.body.getReader(), dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let k;
      while ((k = buf.indexOf("\n\n")) >= 0) { push(JSON.parse(buf.slice(6, k))); buf = buf.slice(k + 2); }
    }
  } catch (e) { push({ stage: "error", message: e.message }); }
}

async function startReplay(id) {
  const r = await api(`/api/runs/${id}`);
  S.record = r; S.replay = true;
  await begin(r.photo_url || "/assets/w1.jpg", !!r.photo_url);
  const n = r.n, conflicts = (xs) => xs.reduce((a, x) => a + x.conflicts, 0), t = (xs) => xs.map((x) => ({ label: x.package.label, conflicts_per_1000: x.conflict_rate_per_1000, close_calls_per_shift: perShift(x, r.limits) }));
  const stressN = Object.keys(r.stress_tests).length, cands = r.proposed.length + r.revised.length;
  let sims = r.single_controls.length, close = conflicts(r.single_controls);
  const evs = [{ stage: "models", provider: r.provider, models: r.models }, { stage: "vision" }, { stage: "sims", crossings: sims * n, close_calls: close },
    { stage: "vision_done", objects: r.vision?.objects || [] }, { stage: "single_controls_done", table: t(r.single_controls), lead_s: r.single_controls[0].first_sight_lead_s_median },
    { stage: "propose" }];
  sims += r.proposed.length; close += conflicts(r.proposed);
  evs.push({ stage: "sims", crossings: sims * n, close_calls: close }, { stage: "proposed", table: t(r.proposed) },
    { stage: "stress_pick", tests: Object.values(r.stress_tests).map((label) => ({ label })) });
  sims += r.proposed.length * stressN; close += Math.round(Object.values(r.stress_results).flatMap(Object.values).reduce((a, v) => a + v * n / 1000, 0));
  evs.push({ stage: "sims", crossings: sims * n, close_calls: close }, { stage: "stressed", results: r.stress_results }, { stage: "revise" });
  sims = r.simulations; close += conflicts(r.revised);
  evs.push({ stage: "sims", crossings: sims * n, close_calls: close }, { stage: "revised", table: t(r.revised) }, { stage: "done", id: r.id });
  void cands;
  evs.forEach(push);
}

async function init() {
  await header("New simulation");
  S.scene = await api("/api/scene/w1");
  api("/api/runs").then((rs) => rs[0] && setProvider(rs[0].provider)).catch(() => {});
  const rid = new URLSearchParams(location.search).get("replay");
  if (rid) startReplay(rid); else pickScreen();
}
init().catch((e) => { if (e.message !== "locked") $("#main").innerHTML = `<div class="panel empty"><h2>Couldn't start</h2><p class="meta">${esc(e.message)}</p></div>`; });
