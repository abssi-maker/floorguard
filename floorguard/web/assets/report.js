// FloorGuard report: the answer and the before/after first, then stress tests, replays, how Nemotron decided, the brief.
import { $, api, cap, crossingsPlayer, esc, floorSVG, fmt, header, human, meets, modelName, perShift, providerName, setProvider, shadows, shiftNum, shortLabel, siteName, usd, when } from "./common.js";

const plainFrom = (catalog) => (s) => {
  let out = String(s ?? "");
  for (const [k, v] of Object.entries(catalog)) out = out.replaceAll(k, `“${v}”`);
  return out.replace(/\b(conflicts_per_1000|close_calls_per_shift|ped_wait_s|truck_delay_s|example_cost_usd)\b/g, (m) =>
    ({ conflicts_per_1000: "close calls per 1,000", close_calls_per_shift: "close calls per shift", ped_wait_s: "pedestrian wait", truck_delay_s: "truck delay", example_cost_usd: "cost" }[m]));
};
const SHORT = { sign_compliance_50: "Half ignore the sign", gate_compliance_60: "Gate propped open", slow_reactions: "Slow reactions", pallet_in_sightline: "Pallet in the way", shortcut_40: "Old route kept", map_scale_minus_20: "Map 20% smaller", night_shift_inattention: "Tired night shift", mirror_ignored: "Mirror ignored" };
let TILE_RUN = null;
const stressFails = (r, x) => Object.values(r.stress_results[x.package.label] || {}).filter((v) => v > 2 * r.limits.target_conflicts_per_1000).length;

// ---------- before / after on the sample photo (positions are illustrative) ----------
const pill = (x, y, t, fill, color = "#fff") => `<g><rect x="${x}" y="${y - 24}" width="${t.length * 10 + 22}" height="32" rx="6" fill="${fill}"/><text x="${x + 11}" y="${y - 2}" font-size="18" font-weight="600" font-family="Barlow" fill="${color}">${esc(t)}</text></g>`;
function photoSide(scene, r, side) {
  const P = scene.photo, [cx0, cy0, cx1, cy1] = P.crossing_box_px, col = P.column_box_px, vb = [140, 380, 935, 598], vb0 = vb[0];
  let s = `<svg viewBox="${vb.join(" ")}" preserveAspectRatio="xMidYMid slice"><defs><radialGradient id="h${side}"><stop offset="0" stop-color="#ef4b33" stop-opacity=".8"/><stop offset="1" stop-color="#ef4b33" stop-opacity="0"/></radialGradient>
    <radialGradient id="g${side}"><stop offset="0" stop-color="#f5b800" stop-opacity=".85"/><stop offset="1" stop-color="#f5b800" stop-opacity="0"/></radialGradient>
    <marker id="arr" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#f5b800"/></marker><pattern id="t${side}" width="16" height="16" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="8" height="16" fill="#f5b800"/><rect x="8" width="8" height="16" fill="#111"/></pattern></defs>
    <image href="/assets/${esc(P.file)}" width="${P.width}" height="${P.height}"/>`;
  const ped = [cx0 + 28, cy0 + 38], fork = [800, 742], at = (x) => ped[1] + (fork[1] - ped[1]) * (x - ped[0]) / (fork[0] - ped[0]), mid = (col[0] + col[2]) / 2, hy = at(col[0]);
  const p = r.recommendation?.package || {};
  if (side === "before") {
    s += `<ellipse cx="${(cx0 + cx1) / 2 + 40}" cy="${cy1 - 10}" rx="170" ry="80" fill="url(#hbefore)"/>
      <line x1="${ped[0]}" y1="${ped[1]}" x2="${col[0]}" y2="${hy}" stroke="#ef4b33" stroke-width="6" stroke-linecap="round"/>
      <line x1="${col[2]}" y1="${at(col[2])}" x2="${fork[0]}" y2="${fork[1]}" stroke="#ef4b33" stroke-width="5" stroke-dasharray="10 9"/>
      <g stroke-linecap="round"><path d="M${mid - 14} ${hy - 14} l28 28 M${mid + 14} ${hy - 14} l-28 28" stroke="#fff" stroke-width="7"/><path d="M${mid - 14} ${hy - 14} l28 28 M${mid + 14} ${hy - 14} l-28 28" stroke="#ef4b33" stroke-width="4"/></g>
      <circle cx="${ped[0]}" cy="${ped[1]}" r="12" fill="#fff" stroke="#111" stroke-width="4"/>` +
      pill(vb0 + 20, hy - 110, `Blind spot: the column hides forklifts`, "rgba(18,20,24,.92)");
  } else {
    if (p.warning_light) s += `<ellipse cx="${(cx0 + cx1) / 2}" cy="${cy1 - 10}" rx="160" ry="70" fill="url(#gafter)"/>`;
    if (p.ped_gate) s += `<rect x="${cx0 + (p.crossing_offset_m || 0) * 40 - 8}" y="${cy0 - 16}" width="${cx1 - cx0 + 16}" height="14" rx="3" fill="url(#tafter)" stroke="#111" stroke-width="2"/>`;
    if (p.mirror) s += `<circle cx="${col[2] + 18}" cy="${cy0 - 60}" r="18" fill="#fff" stroke="#111" stroke-width="4"/>`;
    const shift = (p.crossing_offset_m || 0) * 40;
    if (shift) s += `<rect x="${cx0}" y="${cy0}" width="${cx1 - cx0}" height="${cy1 - cy0}" fill="none" stroke="#fff" stroke-width="3" stroke-dasharray="6 6" opacity=".8"/>
      <rect x="${cx0 + shift}" y="${cy0}" width="${cx1 - cx0}" height="${cy1 - cy0}" fill="rgba(245,184,0,.25)" stroke="#f5b800" stroke-width="5"/>
      <path d="M${cx0 + 20} ${cy0 - 30} H${cx0 + shift + 30}" stroke="#f5b800" stroke-width="6" marker-end="url(#arr)"/>` + pill(cx0 + shift + 4, cy0 - 48, `Move crossing ${Math.abs(p.crossing_offset_m)} m`, "#f5b800", "#15171b");
    if (p.barrier_old_route) s += `<rect x="${cx0}" y="${cy1 + 2}" width="${cx1 - cx0}" height="14" fill="url(#tafter)" stroke="#111" stroke-width="2"/>`;
    s += `<circle cx="${ped[0] + shift}" cy="${ped[1]}" r="12" fill="#2fbf71" stroke="#111" stroke-width="4"/>` +
      pill(mid + 30, hy - 110, r.recommendation ? shortLabel(r.recommendation.package.label) : "no change", "rgba(18,20,24,.92)");
  }
  return s + `</svg>`;
}
function planSide(scene, r, side) {
  const pkg = side === "after" ? r.recommendation?.package : null, f = floorSVG(scene, { w: 960, h: 600, pkg });
  return `<svg viewBox="0 0 960 600" preserveAspectRatio="xMidYMid slice">${f.svg}${side === "before" ? shadows(scene, scene.crossing_x, scene.lane_y1 + 0.7, f.X, f.Y) + `<ellipse cx="${f.X(0.3)}" cy="${f.Y(1.8)}" rx="110" ry="70" fill="url(#hot)"/>` : ""}</svg>`;
}
function compare(scene, r) {
  const side = r.photo_url?.startsWith("/uploads/") ? planSide : photoSide;
  const el = $("#compare");
  const show = (which) => {
    $(".photo-fix", el).innerHTML = side(scene, r, which) + `<span class="lab" style="position:absolute;left:.9rem;top:.9rem;font-family:var(--display);font-weight:700;font-size:1.1rem"><b style="padding:.25rem .6rem;border-radius:5px;${which === "before" ? "background:var(--red)" : "background:var(--green);color:#0d0f12"}">${which === "before" ? "Today" : "Proposed layout · schematic"}</b></span>`;
    el.querySelectorAll(".seg2 button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.w === which));
  };
  el.innerHTML = `<div class="seg2"><button data-w="before">Today</button><button data-w="after">With the fix</button></div><div class="photo-fix"></div>`;
  el.querySelectorAll(".seg2 button").forEach((b) => b.addEventListener("click", () => show(b.dataset.w)));
  show(r.recommendation ? "after" : "before");
}

const PRICED = { ped_gate: "Pedestrian gate", warning_light: "Floor warning light", mirror: "Convex mirror", speed_sign: "Speed sign" };
const FIELD = { ped_gate: "ped_gate", warning_light: "warning_light", mirror: "mirror", speed_limit_kmh: "speed_sign" };
// is every priced control in this package sourced from the web today?
const sourced = (r, x) => { const items = r.prices?.items || {}; const used = Object.entries(FIELD).filter(([f]) => x.package[f]).map(([, k]) => k); return used.length > 0 && used.every((k) => items[k]); };

function pricesPanel(r) {
  const p = r.prices;
  if (!p || p.available === false) return `<p class="meta">${esc(p?.note || "No web prices for this run; costs are estimates.")}</p>`;
  const rows = Object.entries(PRICED).map(([k, name]) => {
    const it = p.items?.[k];
    return `<tr><td>${name}</td><td>${it ? `${usd(it.low)}–${usd(it.high)}` : "—"}</td><td>${it ? usd(it.used) : `${usd(r.costs?.[k])} <span class="est">estimate</span>`}</td>
      <td class="src" style="text-align:left">${it ? it.sources.map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(new URL(s.url).hostname.replace("www.", ""))}</a> ${usd(s.price)}`).join(" · ") : "no product page with a price found"}</td></tr>`;
  }).join("");
  return `<table class="plain"><thead><tr><th>Control</th><th>Price range found</th><th>Used</th><th style="text-align:left">Sources (unit price on the page)</th></tr></thead><tbody>${rows}</tbody></table>
    <p class="meta" style="margin-top:.6rem">Tavily searched ${p.searches} supplier queries on ${esc(p.date)} and returned ${p.pages_read} pages with prices; ${esc(modelName(r.models.fast))} read each one, and a price is kept only if that exact figure is printed on the page. Markings, moved crossings and barriers have no unit price online and stay estimates. Get your own quotes before buying.</p>`;
}

function tile(title, r, lim, cls) {
  const ok = meets(r, lim);
  return `<div class="panel tile ${cls}"><h3>${esc(title)}</h3><div><p class="big ${ok ? "green" : "red"}">${shiftNum(perShift(r, lim))}</p><p class="sub">close calls per shift · simulated</p>
    <p style="margin-top:.6rem"><span class="chip ${ok ? "ok" : "bad"}">${ok ? "✓ meets your limits" : "▲ misses your limits"}</span></p></div>
    <div class="cost"><small>Cost${r.example_cost_usd ? (TILE_RUN && sourced(TILE_RUN, r) ? ` <span class="est web">web prices</span>` : ` <span class="est">estimate</span>`) : ""}</small><b>${usd(r.example_cost_usd)}</b></div></div>`;
}

function stressTable(r) {
  const tests = Object.keys(r.stress_tests), t = r.limits.target_conflicts_per_1000, cls = (v) => v <= t ? "ok" : v <= 2 * t ? "warn" : "bad";
  const rows = [...r.proposed, ...r.revised], rec = r.recommendation?.package.label;
  return `<table class="heat"><thead><tr><th></th><th>As assumed</th>${tests.map((k) => `<th title="${esc(cap(r.stress_tests[k]))}">${esc(SHORT[k] || cap(r.stress_tests[k]))}</th>`).join("")}</tr></thead><tbody>
    ${rows.map((x) => `<tr class="${x.package.label === rec ? "rec" : ""}"><td>${esc(shortLabel(x.package.label))}${x.package.label === rec ? " (recommended)" : ""}</td><td class="${cls(x.conflict_rate_per_1000)}">${fmt(x.conflict_rate_per_1000)}</td>
      ${tests.map((k) => { const v = r.stress_results[x.package.label]?.[k]; return `<td class="${cls(v)}">${fmt(v)}</td>`; }).join("")}</tr>`).join("")}</tbody></table>
    <p class="meta" style="margin-top:.6rem">Close calls per 1,000 interactions. Green ≤ your target of ${t} · amber ≤ ${2 * t} · red above.</p>`;
}

function replays(scene, r) {
  const one = (key, label, color, pkg) => {
    const rp = r.replays?.[key];
    if (!rp) return `<div class="rp"><span class="lab" style="background:${color}">${label}</span><p class="meta" style="padding:3rem 1rem">No close call to replay.</p></div>`;
    return `<div><div class="rp"><svg id="rp-${key}"></svg><span class="lab" style="background:${color};color:#0d0f12">${label}</span></div>
      <p class="rp-info">${rp.collided[0] ? "Contact in the simulation" : `Closest gap ${fmt(rp.pet[0], 2)} s`} · first able to see each other at ${Number.isFinite(rp.first_vis[0]) ? fmt(rp.first_vis[0], 1) + " s" : "—"}</p></div>`;
  };
  $("#replays").innerHTML = one("today", "Today", "var(--red)") + one("recommended", "With the fix", "var(--green)");
  for (const [key, pkg] of [["today", null], ["recommended", r.recommendation?.package]]) {
    const rp = r.replays?.[key];
    if (!rp) continue;
    const conflict = rp.collided.map((c, i) => c || rp.pet[i] < 1 || rp.min_ttc[i] < 1.5);
    crossingsPlayer($(`#rp-${key}`), scene, { ...rp, conflict }, { pkg, stagger: 0, speed: 0.8, heat: false });
  }
}

function steps(r, plain) {
  const by = (p) => r.trace.filter((c) => c.purpose.startsWith(p));
  const b = (kind, model, role) => `<span class="badge ${kind}">${esc(model)} <small>· ${esc(role)}</small></span>`;
  const ultra = b("ultra", modelName(r.models.planner), "reasoning"), fast = b("fast", modelName(r.models.fast), "fast"), sim = b("sim", "Simulator", "measures"), py = b("sim", "Python rules", "decides");
  const vl = b("vl", modelName(r.models.vision || r.vision?.model || "Nemotron Super VL"), "vision");
  const names = (xs) => xs.map((p) => shortLabel(p.package.label)).join(" · ");
  const call = (c) => `<span class="call">${esc(c.model.split("/").pop())} · ${esc(providerName(c.provider))} · ${c.input_tokens + c.output_tokens} tokens · ${fmt(c.latency_s, 1)} s · $${c.cost_usd.toFixed(4)}</span>`;
  const k = Object.keys(r.stress_tests).length, best = r.recommendation;
  const list = [
    { w: vl, t: "Read the photo", s: `${r.vision?.objects?.length || 0} objects found: vehicles, people, the crossing, and what blocks a line of sight. A person confirmed the map.`, calls: by("draft") },
    ...(r.prices?.available ? [{ w: b("tavily", "Tavily", "web search"), t: "Found today's prices for the controls", s: `${Object.keys(r.prices.items || {}).length} of 4 priced from ${Object.values(r.prices.items || {}).reduce((a, it) => a + it.sources.length, 0)} supplier pages; ${modelName(r.models.fast)} read each page and Python kept only prices printed on it.`, calls: by("read supplier") }] : []),
    { w: sim, t: "Tested every control alone", s: `${r.single_controls.length - 1} controls and the usual fix, each on the same ${r.n.toLocaleString("en-US")} simulated crossings.` },
    { w: ultra, t: `Proposed ${r.proposed.length} packages`, s: names(r.proposed), q: `“${esc(plain(r.hypothesis))}”<ul>${r.proposed.map((p) => `<li><b>${esc(shortLabel(p.package.label))}</b>: ${esc(plain(p.why))}</li>`).join("")}</ul>`, calls: by("propose") },
    { w: fast, t: `Picked ${k} stress tests to break the best one`, s: Object.values(r.stress_tests).join(" · "), q: `“${esc(plain(r.stress_why))}”`, calls: by("pick") },
    { w: sim, t: "Ran every package under every stress test", s: "The simulator measures; the model never computes an outcome." },
    { w: ultra, t: r.revised.length ? `Revised: ${r.revised.length} new package${r.revised.length > 1 ? "s" : ""}` : "Kept the tested packages", s: r.revised.length ? names(r.revised) : "No new package needed.", q: `“${esc(plain(r.revision_reasoning))}”`, calls: by("revise") },
    { w: py, t: best ? `Picked ${shortLabel(best.package.label).toLowerCase()}` : "Found no package that passes", s: `Passes if it meets your limits (≤ ${r.limits.target_conflicts_per_1000} per 1,000, ≤ ${r.limits.max_truck_delay_s} s truck delay, ≤ ${usd(r.limits.budget_usd)}) and stays under twice the target in every stress test.` },
    { w: fast, t: "Wrote the decision brief", s: "From the computed numbers only.", calls: by("write") },
  ];
  const cost = r.trace.reduce((a, c) => a + c.cost_usd, 0), lat = r.trace.reduce((a, c) => a + c.latency_s, 0);
  return `<div class="panel-h"><h2>How Nemotron decided</h2><span class="meta">${r.trace.length} model calls on ${esc(providerName(r.provider))} · ${fmt(lat, 0)} s of model time · $${cost.toFixed(3)}</span></div>
    <div class="panel-b"><ol class="pipe">${list.map((x) => `<li class="pstep"><div>${x.w}</div><div><h4>${esc(x.t)}</h4><p>${esc(x.s)}</p>
      ${x.q || x.calls?.length ? `<details><summary>${x.q ? "Read the model's reasoning" : "Model call"}</summary>${x.q ? `<div class="quote">${x.q}</div>` : ""}<div class="calls">${(x.calls || []).map(call).join("")}</div></details>` : ""}</div></li>`).join("")}</ol></div>`;
}

function brief(r) {
  const b = r.brief, best = r.recommendation, a = r.assumptions, lim = r.limits, pct = (v) => `${Math.round(v * 100)}%`;
  const head = best ? `${cap(best.controls.join(" + "))}: simulated close calls drop from ${shiftNum(perShift(r.single_controls[0], lim))} to ${shiftNum(perShift(best, lim))} per shift.` : "No tested package meets your limits.";
  return `<article class="paper"><header class="paper-h"><div><p class="kick">FloorGuard decision brief</p><h2>${esc(siteName(r.photo_url))}</h2><p>${esc(when(r.created_utc))}</p></div><button class="btn quiet" onclick="window.print()">Print / save PDF</button></header>
    <p class="v">${esc(head)}</p>${b ? `<p class="w">${esc(b.why)}</p>` : ""}
    <div class="cols"><div><h4>Recommended change</h4><ul>${(best?.controls || ["—"]).map((c) => `<li>${esc(cap(c))}</li>`).join("")}</ul>
      <h4>Check on the floor before buying</h4><ul>${(b?.floor_checks || []).map((c) => `<li>${esc(c)}</li>`).join("")}</ul>
      <h4>After installation</h4><ul>${(b?.after_install || []).map((c) => `<li>${esc(c)}</li>`).join("")}</ul>
      <h4>Prices used</h4><ul>${Object.entries(FIELD).filter(([f]) => best?.package[f]).map(([, k]) => { const it = r.prices?.items?.[k]; return `<li>${PRICED[k]}: ${it ? `${usd(it.used)} (web, ${usd(it.low)}–${usd(it.high)}, ${it.sources.map((s) => esc(new URL(s.url).hostname.replace("www.", ""))).join(", ")})` : `${usd(r.costs?.[k] ?? 0)} (estimate)`}</li>`; }).join("") || "<li>—</li>"}</ul></div>
    <div><h4>Assumptions used</h4><ul><li>${pct(a.ped_look)} of pedestrians look before crossing; ${pct(a.driver_attention)} of drivers attentive</li>
      <li>Speed-sign compliance ${pct(a.sign_compliance)}; gate used as intended by ${pct(a.gate_compliance)}; mirror checked by ${pct(a.mirror_use)}</li>
      <li>Forklift speed ${a.forklift_kmh.join("–")} km/h; reaction ${a.reaction_s.join("–")} s; braking ${a.brake_ms2.join("–")} m/s²</li></ul>
      <h4>What these numbers are</h4><ul><li>Simulated close calls in a simplified 2D model, not injury predictions.</li><li>Costs: web prices where shown, estimates elsewhere; get your own quotes.</li>
      <li>Run ${esc(r.id)} · Nemotron on ${esc(providerName(r.provider))} · seed ${r.seed}</li></ul></div></div></article>`;
}

async function evidence() {
  const ev = await api("/api/evidence"), s = ev.baseline_search, rt = ev.baseline_routing, pct = (v) => `${Math.round(v * 100)}%`;
  const avg = (xs, k) => xs.reduce((a, x) => a + x[k], 0) / xs.length;
  return (s ? `<div><h3>Nemotron agent vs random search</h3><p class="meta">Same budget (${s.budget_simulations} simulations), same pass rule, same stress tests.</p>
    <table class="plain"><thead><tr><th></th><th>Found a package that passes</th><th>Median close calls / 1,000</th><th>Median cost</th></tr></thead><tbody>
    <tr><td>Nemotron agent (${s.agent.runs} runs)</td><td>${pct(s.agent.found_rate)}</td><td>${fmt(s.agent.median_best_conflicts_per_1000)}</td><td>${usd(s.agent.median_cost_usd)}</td></tr>
    <tr><td>Random search (${s.random_search.seeds} seeds)</td><td>${pct(s.random_search.found_rate)}</td><td>${fmt(s.random_search.median_best_conflicts_per_1000)}</td><td>${usd(s.random_search.median_cost_usd)}</td></tr></tbody></table>
    <p class="meta" style="margin-top:.5rem">${s.agent.runs} agent runs is a small sample.</p></div>` : "") +
    (rt ? `<div><h3>Ultra for reasoning, a fast model for everyday calls</h3><p class="meta">The track's own advice, measured on the same loop.</p>
    <table class="plain"><thead><tr><th></th><th>Fast-role calls</th><th>Total model time</th><th>Cost</th></tr></thead><tbody>
    <tr><td>Routed (Ultra + fast model)</td><td>${fmt(avg(rt.routed, "fast_role_time_s"), 1)} s</td><td>${fmt(avg(rt.routed, "model_time_s"), 0)} s</td><td>$${avg(rt.routed, "cost_usd").toFixed(3)}</td></tr>
    <tr><td>Everything on Ultra</td><td>${fmt(rt.all_ultra.fast_role_time_s, 1)} s</td><td>${fmt(rt.all_ultra.model_time_s, 0)} s</td><td>$${rt.all_ultra.cost_usd.toFixed(3)}</td></tr></tbody></table></div>` : "");
}

async function init() {
  await header("Reports");
  const id = location.pathname.split("/").pop();
  const [r, scene] = await Promise.all([api(`/api/runs/${id}`), api("/api/scene/w1")]);
  setProvider(r.provider);
  TILE_RUN = r;
  const lim = r.limits, today = r.single_controls[0], usual = r.single_controls.at(-1), best = r.recommendation, plain = plainFrom(scene.stress_catalog);
  const fails = best ? stressFails(r, best) : 0, k = Object.keys(r.stress_tests).length;
  document.title = `FloorGuard · ${siteName(r.photo_url)}`;
  $("#main").innerHTML = `
    <p class="crumb"><a href="/#reports">Reports</a> / ${esc(siteName(r.photo_url))} · ${esc(when(r.created_utc))}</p>
    <section class="hero"><div class="panel hero-t"><p><span class="tag">${best ? "Recommendation · simulated" : "No package met your limits"}</span></p>
      <h1>${best ? `${esc(cap(shortLabel(best.package.label).toLowerCase()))}.` : "Nothing tested meets your limits yet."}</h1>
      ${best ? `<p class="meta" style="font-size:1rem">${esc(cap(best.controls.join(" · ")))}</p>` : ""}
      <p class="lead">${best ? `Close calls drop from ${shiftNum(perShift(today, lim))} to ${shiftNum(perShift(best, lim))} per shift, ${human(perShift(best, lim))}. The usual fix only reaches ${shiftNum(perShift(usual, lim))}. ${fails ? `It breaks in ${fails} of ${k} stress tests.` : `It holds up in all ${k} stress tests.`}` : `Today: ${shiftNum(perShift(today, lim))} close calls per shift. Loosen a limit or allow more budget.`}</p>
      <div class="actions"><button class="btn primary" id="pdf">Download decision brief (PDF)</button><a class="btn ghost" href="/new">Run with my changes</a></div></div>
      <div id="compare"></div></section>
    <section class="tiles">${tile("Today", today, lim, "")}${tile(`Usual fix: ${usual.controls.join(" + ")}`, usual, lim, "")}${best ? tile(`Recommended: ${shortLabel(best.package.label).toLowerCase()}`, best, lim, "rec") : ""}</section>
    <p class="limits">Your limits: at most ${lim.target_conflicts_per_1000} close calls per 1,000 interactions · truck delay ≤ ${lim.max_truck_delay_s} s · budget ≤ ${usd(lim.budget_usd)}${best ? ` · Recommended package: ${esc(cap(best.controls.join(" · ")))}` : ""}</p>
    <p class="meta" style="margin:-.4rem 0 1rem">Per 1,000 interactions: today ${fmt(today.conflict_rate_per_1000)} (≤ ${fmt(today.conflict_upper_95_per_1000)}, 95%), usual fix ${fmt(usual.conflict_rate_per_1000)}${best ? `, recommended ${fmt(best.conflict_rate_per_1000)} (≤ ${fmt(best.conflict_upper_95_per_1000)})` : ""}. ${(r.simulations * r.n).toLocaleString("en-US")} crossings simulated.</p>
    <section class="row2"><div class="panel"><div class="panel-h"><h2>Stress tests chosen by Nemotron to break it</h2><span class="meta">simulated</span></div><div class="panel-b">${stressTable(r)}</div></div>
      <div class="panel"><div class="panel-h"><h2>Worst-case examples · contact remains possible</h2></div><div class="panel-b"><div class="replays" id="replays"></div>
      <p class="meta" style="margin-top:.6rem">The fix makes close calls rarer; it does not remove every simulated contact. Each side shows its own worst crossing out of 10,000, not the same crossing replayed.</p></div></div></section>
    <section class="panel sec"><div class="panel-h"><h2>Prices found on the web</h2><span class="meta">Tavily · ${esc(r.prices?.date || "")}</span></div><div class="panel-b">${pricesPanel(r)}</div></section>
    <section class="panel sec">${steps(r, plain)}</section>
    <section class="sec">${brief(r)}</section>
    <details class="more sec"><summary>For the skeptic: does the model earn its place?</summary><div class="evidence" id="evidence"></div></details>
    <p class="foot"><b>Limits.</b> FloorGuard simulates close calls (time-to-collision under 1.5 s, post-encroachment time under 1.0 s, or contact) in a simplified 2D model of one intersection, under the assumptions shown. They are not injury predictions. The map is a hand-confirmed draft from one photo, so distances are approximate. Costs use web prices where found and estimates elsewhere; get your own quotes. Decision support, not a safety certification.</p>`;
  compare(scene, r);
  replays(scene, r);
  $("#pdf").addEventListener("click", () => window.print());
  $("#evidence").innerHTML = await evidence();
}
init().catch((e) => { if (e.message !== "locked") $("#main").innerHTML = `<div class="panel empty"><h2>Couldn't load this report</h2><p class="meta">${esc(e.message)}</p></div>`; });
