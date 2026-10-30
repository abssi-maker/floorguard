// FloorGuard shared front-end code: header, helpers, the top-down floor plan and the crossings player.
export const $ = (s, el = document) => el.querySelector(s);
export const fmt = (v, d = 1) => (v === null || v === undefined || Number.isNaN(v)) ? "—" : Number(v).toFixed(d);
export const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
export const usd = (v) => `$${Math.round(v ?? 0).toLocaleString("en-US")}`;
export const cap = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);
export const shiftNum = (v) => v >= 1 ? fmt(v, 1) : fmt(v, 2);
export const human = (v) => v >= 1 ? `about ${fmt(v, 1)} a shift` : v > 0 ? `about 1 every ${Math.round(1 / v)} shifts` : "none in the simulation";
// recorded runs from before the label change still say "NVIDIA API (development)"
export const providerName = (p) => String(p ?? "").replace(/\s*\(development\)$/, "");
export const shortLabel = (label) => String(label).replace(/\s*\(.*?\)\s*$/, "");
// "nvidia/nemotron-3-ultra-550b-a55b" → "Nemotron 3 Ultra"
export const modelName = (id) => String(id ?? "").split("/").pop().replace(/_/g, ".").split("-").filter((w) => !/^nvidia$/i.test(w))
  .filter((w, i, a) => !a.slice(0, i + 1).some((x) => /^\d+b$/i.test(x))).map((w) => /^vl$/i.test(w) ? "VL" : cap(w.toLowerCase())).join(" ");
export const perShift = (r, lim) => lim.crossings_per_shift * Math.min(1, lim.forklift_passes_per_hour / 3600 * r.window_s) * r.conflict_rate_per_1000 / 1000;
export const meets = (r, lim) => r.conflict_rate_per_1000 <= lim.target_conflicts_per_1000 && r.delay_s_per_truck <= lim.max_truck_delay_s && r.example_cost_usd <= lim.budget_usd;
export const SITE = "Sample warehouse — column crossing";
export const siteName = (photoUrl) => photoUrl && photoUrl.startsWith("/uploads/") ? "Your photo — column crossing" : SITE;
export const when = (iso) => new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function api(path, opts) {
  const res = await fetch(path, opts);
  if (res.status === 401) { location.href = "/locked"; throw new Error("locked"); }
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || res.statusText);
  return res.json();
}

const LOGO = `<svg class="logo" viewBox="0 0 58 26" aria-hidden="true"><circle cx="6" cy="13" r="5" fill="#f5b800"/><path d="M11 13h12" stroke="#f5b800" stroke-width="3.5"/><rect x="25" y="1" width="8" height="24" rx="1.5" fill="#f5b800"/><path d="M35 13h12" stroke="#f5b800" stroke-width="3.5"/><circle cx="52" cy="13" r="5" fill="#f5b800"/></svg>`;

export async function header(active) {
  const nav = [["/", "Dashboard"], ["/new", "New simulation"], ["/#reports", "Reports"]];
  $("#top").innerHTML = `<div class="top-in"><a class="brand" href="/">${LOGO}<span>FloorGuard</span></a>
    <nav class="nav">${nav.map(([h, t]) => `<a href="${h}" class="${t === active ? "on" : ""}">${t}</a>`).join("")}</nav>
    <div class="top-r"><span class="pill" id="provider">NVIDIA Nemotron</span><a class="who" href="/logout" title="Sign out"><i>⦿</i><span id="role">…</span></a></div></div>`;
  try { const me = await api("/api/me"); $("#role").textContent = me.role === "judge" ? "Judge access" : cap(me.role || "Signed in"); } catch {}
}
export const setProvider = (p) => { if (p) $("#provider").textContent = `Nemotron on ${providerName(p)}`; };

export const ICONS = {
  camera: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>`,
  play: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M7 5l12 7-12 7z"/></svg>`,
  doc: `<svg viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6z M14 3v4h4 M9 12h6 M9 16h6"/></svg>`,
  map: `<svg viewBox="0 0 24 24"><path d="M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2z M9 4v14 M15 6v14"/></svg>`,
  walk: `<svg viewBox="0 0 24 24"><circle cx="13" cy="4" r="2"/><path d="M11 21l2-6-3-3 1-5 4 3h3 M8 11l2-4 M10 12l-3 3"/></svg>`,
  wrench: `<svg viewBox="0 0 24 24"><path d="M14 6a4 4 0 0 0 5 5l-9 9-3-3 9-9z"/></svg>`,
  cam: `<svg viewBox="0 0 24 24"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>`,
  upload: `<svg viewBox="0 0 24 24"><path d="M12 16V4 M7 9l5-5 5 5 M4 16v4h16v-4"/></svg>`,
};

// ---------- top-down floor plan (metres → SVG) ----------
export const WORLD = { x0: -10, x1: 16, y0: -5, y1: 9.5 };
export function projector(w, h, world = WORLD) {
  const X = (x) => (x - world.x0) / (world.x1 - world.x0) * w;
  const Y = (y) => h - (y - world.y0) / (world.y1 - world.y0) * h;
  return { X, Y, s: w / (world.x1 - world.x0) };
}

export function floorSVG(scene, { w = 960, h = 600, pkg = null, labels = true } = {}) {
  const { X, Y, s } = projector(w, h);
  const y0 = scene.lane_y0, y1 = scene.lane_y1, off = pkg?.crossing_offset_m || 0, cx = scene.crossing_x + off, cw = scene.crossing_width;
  let g = `<defs><pattern id="pal" width="14" height="14" patternUnits="userSpaceOnUse"><rect width="14" height="14" fill="#8a7553"/><path d="M0 7h14M7 0v14" stroke="#6f5d40" stroke-width="1.2"/></pattern>
    <pattern id="low" width="14" height="14" patternUnits="userSpaceOnUse"><rect width="14" height="14" fill="#4d4536"/><path d="M0 7h14M7 0v14" stroke="#3d3729" stroke-width="1"/></pattern>
    <pattern id="tape" width="14" height="14" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="7" height="14" fill="#f5b800"/><rect x="7" width="7" height="14" fill="#111"/></pattern>
    <radialGradient id="hot"><stop offset="0" stop-color="#ef4b33" stop-opacity=".85"/><stop offset="1" stop-color="#ef4b33" stop-opacity="0"/></radialGradient>
    <radialGradient id="glow"><stop offset="0" stop-color="#f5b800" stop-opacity=".7"/><stop offset="1" stop-color="#f5b800" stop-opacity="0"/></radialGradient></defs>
    <rect width="${w}" height="${h}" fill="#1a1d22"/>`;
  // floor grid
  for (let x = Math.ceil(WORLD.x0); x <= WORLD.x1; x += 2) g += `<line x1="${X(x)}" y1="0" x2="${X(x)}" y2="${h}" stroke="#20242a"/>`;
  // walkway approaching the crossing
  g += `<rect x="${X(cx - cw / 2)}" y="${Y(scene.ped_y_start)}" width="${cw * s}" height="${Y(y1) - Y(scene.ped_y_start)}" fill="#23272e"/>
    <rect x="${X(cx - cw / 2)}" y="${Y(y0)}" width="${cw * s}" height="${Y(scene.ped_y_end) - Y(y0)}" fill="#23272e"/>`;
  // lane
  g += `<rect x="0" y="${Y(y1)}" width="${w}" height="${Y(y0) - Y(y1)}" fill="#2b2f36"/>
    <line x1="0" y1="${Y(y1)}" x2="${w}" y2="${Y(y1)}" stroke="#f5b800" stroke-width="4"/><line x1="0" y1="${Y(y0)}" x2="${w}" y2="${Y(y0)}" stroke="#f5b800" stroke-width="4"/>
    <line x1="0" y1="${Y((y0 + y1) / 2)}" x2="${w}" y2="${Y((y0 + y1) / 2)}" stroke="#6b7079" stroke-width="2" stroke-dasharray="22 16"/>`;
  // zebra crossing (stripes run along the lane)
  for (let k = 0; k < 6; k++) { const yy = y0 + (k + 0.5) * (y1 - y0) / 6; g += `<rect x="${X(cx - cw / 2)}" y="${Y(yy) - 0.18 * s}" width="${cw * s}" height="${0.36 * s}" fill="#e9e7e0"/>`; }
  if (off) g += `<rect x="${X(scene.crossing_x - cw / 2)}" y="${Y(y1)}" width="${cw * s}" height="${Y(y0) - Y(y1)}" fill="none" stroke="#6b7079" stroke-width="2" stroke-dasharray="6 6"/>`;
  for (const o of scene.occluders) {
    const pts = o.polygon.map(([x, y]) => `${X(x)},${Y(y)}`).join(" ");
    const col = o.name === "steel column";
    g += `<polygon points="${pts}" fill="${col ? "#0b0c0e" : o.height >= scene.eye_block_height ? "url(#pal)" : "url(#low)"}" stroke="${col ? "#f5b800" : "#2a2620"}" stroke-width="${col ? 3 : 1.5}"/>`;
  }
  if (pkg?.ped_gate) g += `<rect x="${X(cx - cw / 2) - 6}" y="${Y(y1) - 0.55 * s}" width="${cw * s + 12}" height="${0.4 * s}" rx="3" fill="url(#tape)" stroke="#111" stroke-width="1.5"/>`;
  if (pkg?.warning_light) g += `<ellipse cx="${X(cx)}" cy="${Y((y0 + y1) / 2)}" rx="${2.6 * s}" ry="${2.2 * s}" fill="url(#glow)"/>`;
  if (pkg?.mirror) { const [mx, my] = scene.mirror.position; g += `<circle cx="${X(mx)}" cy="${Y(my) - 0.2 * s}" r="${0.42 * s}" fill="#dfe6ee" stroke="#111" stroke-width="2"/>`; }
  if (pkg?.barrier_old_route) g += `<rect x="${X(scene.crossing_x - cw / 2)}" y="${Y(y1) - 0.5 * s}" width="${cw * s}" height="${0.35 * s}" fill="url(#tape)"/>`;
  if (labels) {
    const col = scene.occluders.find((o) => o.name === "steel column"), cxm = Math.max(...col.polygon.map(([x]) => x)), cym = Math.max(...col.polygon.map(([, y]) => y));
    g += lab(X(cxm) + 8, Y(cym) - 6, "steel column", "#f5b800") + lab(X(6), Y(6.8), "pallet stacks (over eye height)", "#f2f1ec") +
      lab(X(cx - cw / 2) - 4, Y(scene.ped_y_start) + 18, "walkway", "#c3c6cc", "end") + lab(X(WORLD.x1) - 10, Y(y0) + 22, "forklift lane →  ← traffic", "#c3c6cc", "end");
  }
  return { svg: g, X, Y, s };
}
const lab = (x, y, t, c, anchor = "start") => `<text x="${x}" y="${y}" fill="${c}" font-family="Barlow" font-weight="600" font-size="16" text-anchor="${anchor}" paint-order="stroke" stroke="#121418" stroke-width="4">${esc(t)}</text>`;

// The area a person at (px, py) cannot see because of the tall occluders: shadow polygons cast from their eye.
export function shadows(scene, px, py, X, Y, reach = 40) {
  let g = "";
  for (const o of scene.occluders) {
    if (o.height < scene.eye_block_height) continue;
    const pts = o.polygon;
    const ang = pts.map(([x, y]) => Math.atan2(y - py, x - px));
    const i = ang.indexOf(Math.min(...ang)), j = ang.indexOf(Math.max(...ang));
    const far = (p) => [px + (p[0] - px) * reach, py + (p[1] - py) * reach];
    const poly = [pts[i], far(pts[i]), far(pts[j]), pts[j]].map(([x, y]) => `${X(x)},${Y(y)}`).join(" ");
    g += `<polygon points="${poly}" fill="rgba(239,75,51,.20)" stroke="rgba(239,75,51,.55)" stroke-width="1.5" stroke-dasharray="6 5"/>`;
  }
  return g;
}

// ---------- crossings player: real simulated crossings, staggered so they read as traffic ----------
export function crossingsPlayer(svgEl, scene, data, { pkg = null, stagger = 7, speed = 1, onConflict = () => {}, loop = true, heat = true, onEnd = () => {} } = {}) {
  const w = 960, h = 600, base = floorSVG(scene, { w, h, pkg });
  const { X, Y, s } = base;
  svgEl.setAttribute("viewBox", `0 0 ${w} ${h}`);
  const k = data.x_ped.length, F = data.frames.length;
  const meetAt = Array.from({ length: k }, (_, j) => {
    let best = 0, bd = Infinity;
    for (let t = 0; t < F; t++) { const d = Math.abs(data.frames[t][0][j] - data.x_ped[j]); if (d < bd) { bd = d; best = t; } }
    return best;
  });
  const jitter = Array.from({ length: k }, (_, j) => ((j * 37) % 11 - 5) / 7);
  let heatSvg = "", g = 0, raf = null, last = 0, stopped = false;
  const flashes = [];
  const total = (k - 1) * stagger + F;
  function frame(ts) {
    if (stopped) return;
    if (ts - last > 50 / speed) {
      last = ts;
      let s2 = base.svg + `<g>${heatSvg}</g>`;
      let lines = "", things = "";
      for (let j = 0; j < k; j++) {
        const t = g - j * stagger;
        if (t < 0 || t >= F) continue;
        const [fx, py, vis, mir, wait, brake] = data.frames[t].map((a) => a[j]);
        const px = data.x_ped[j] + jitter[j] * 0.6;
        if (fx > WORLD.x0 - 3 && fx < WORLD.x1 + 3) {
          if (py > data.y_lane[0] - 1 && fx > px - 1 && fx - px < 14) lines += `<line x1="${X(px)}" y1="${Y(py)}" x2="${X(fx)}" y2="${Y(data.fy)}" stroke="${vis || mir ? "#2fbf71" : "#ef4b33"}" stroke-width="2" stroke-dasharray="${vis || mir ? "0" : "7 6"}" opacity=".8"/>`;
          things += `<g transform="translate(${X(fx)},${Y(data.fy)})"><rect x="${-0.2 * s}" y="${-0.55 * s}" width="${2.4 * s}" height="${1.1 * s}" rx="4" fill="${brake ? "#ef4b33" : "#f5b800"}"/><rect x="${0.25 * s}" y="${-0.4 * s}" width="${0.6 * s}" height="${0.8 * s}" fill="#15171b"/><path d="M${-0.55 * s} 0 l${0.28 * s} ${-0.2 * s} v${0.4 * s} z" fill="#f5b800"/></g>`;
        }
        if (py < scene.ped_y_start + 0.5 && py > scene.ped_y_end - 0.5) things += `<circle cx="${X(px)}" cy="${Y(py)}" r="${0.32 * s}" fill="${wait ? "#2fbf71" : "#f2f1ec"}" stroke="#121418" stroke-width="2"/>`;
        if (t === meetAt[j] && data.conflict[j]) {
          flashes.push({ x: X(px), y: Y(data.fy), age: 0 });
          if (heat) heatSvg += `<circle cx="${X(px) + (jitter[j] * 0.5) * s}" cy="${Y(data.fy) + (jitter[(j + 3) % k] * 0.6) * s}" r="${1.7 * s}" fill="url(#hot)" opacity=".55"/>`;
          onConflict(j);
        }
      }
      for (const f of flashes) if (f.age < 12) { things += `<circle cx="${f.x}" cy="${f.y}" r="${(0.6 + f.age * 0.18) * s}" fill="none" stroke="#ef4b33" stroke-width="${4 - f.age * 0.3}" opacity="${1 - f.age / 12}"/>`; f.age++; }
      svgEl.innerHTML = s2 + lines + things;
      g++;
      if (g >= total) { if (!loop) { stopped = true; onEnd(); return; } g = 0; }
    }
    raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);
  return { stop() { stopped = true; cancelAnimationFrame(raf); }, X, Y, s, overlay(extra) { base.svg += extra; } };
}
