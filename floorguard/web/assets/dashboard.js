// FloorGuard dashboard: the latest results first, then every saved report.
import { $, ICONS, api, cap, esc, fmt, header, setProvider, shiftNum, siteName, when } from "./common.js";

const greeting = () => { const h = new Date().getHours(); return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening"; };

function row(r) {
  const ok = r.best_per_shift !== null && r.best_per_shift !== undefined;
  return `<a class="panel rrow" href="/report/${esc(r.id)}"><img src="${esc(r.photo_url)}" alt="">
    <div><h3>${ok ? esc(cap(r.controls.length > 2 ? `${r.controls.slice(0, 2).join(" + ")} + ${r.controls.length - 2} more` : r.controls.join(" + "))) : "No package met your limits"}</h3><p class="when">${esc(siteName(r.photo_url))} · ${esc(when(r.created_utc))}</p></div>
    <p class="big"><span class="red">${shiftNum(r.today_per_shift)}</span><span class="arrow">→</span><span class="${ok ? "green" : "red"}">${ok ? shiftNum(r.best_per_shift) : "—"}</span></p></a>`;
}

function card(r, lead) {
  const best = r.best_per_shift, ok = best !== null && best !== undefined;
  const max = Math.max(r.today_per_shift, 0.001);
  return `<a class="panel rcard ${lead ? "lead" : ""}" href="/report/${esc(r.id)}">
    <div class="thumb"><img src="${esc(r.photo_url)}" alt=""><span class="heat"></span></div>
    <div>${lead ? `<span class="latest">Latest run</span>` : ""}<h3>${esc(siteName(r.photo_url))}</h3><p class="when">${esc(when(r.created_utc))}</p>
      <p class="what">${ok ? esc(r.controls.join(" + ")) : "No package met your limits"}</p>
      <p class="nums big"><span class="red">${shiftNum(r.today_per_shift)}</span><span class="arrow">→</span><span class="${ok ? "green" : "red"}">${ok ? shiftNum(best) : "—"}</span><small>per shift</small></p>
      <div class="ba"><span style="flex:${r.today_per_shift / max};background:var(--red)"></span>${ok ? `<span style="flex:${Math.max(best / max, 0.06)};background:var(--green)"></span>` : ""}</div>
      ${ok ? `<span class="chip ok">✓ Recommendation ready</span>` : `<span class="chip warn">! Needs review</span>`}</div></a>`;
}

async function init() {
  await header("Dashboard");
  const runs = await api("/api/runs");
  const latest = runs[0];
  if (latest) setProvider(latest.provider);
  const steps = [["cam", "Photo"], ["doc", "Nemotron reads it"], ["map", "2D map"], ["walk", "Simulate crossings"], ["wrench", "Fix that holds"]];
  $("#main").innerHTML = `
    <div class="greet"><h1>${greeting()}. ${runs.length} simulation${runs.length === 1 ? "" : "s"} on file.</h1>
      <div class="actions"><a class="btn primary" href="/new">${ICONS.camera}+ New simulation</a>
      ${latest ? `<a class="btn ghost" href="/new?replay=${esc(latest.id)}">${ICONS.play}Replay the demo run</a>` : ""}</div></div>
    ${latest ? `<div class="kpis">
      <div class="panel kpi"><p class="big"><span class="red">${shiftNum(latest.today_per_shift)}</span><span class="arrow">→</span><span class="green">${latest.best_per_shift != null ? shiftNum(latest.best_per_shift) : "—"}</span></p><p>close calls per shift, latest simulation</p></div>
      <div class="panel kpi"><p class="big">${latest.crossings.toLocaleString("en-US")}</p><p>crossings simulated</p></div>
      <div class="panel kpi"><p class="big ${latest.stress_failed ? "red" : "green"}">${latest.stress_total - latest.stress_failed} of ${latest.stress_total}</p><p>stress tests passed by the recommendation</p></div>
      <div class="panel kpi"><p class="big">${latest.model_calls}</p><p>Nemotron calls · $${fmt(latest.model_cost_usd, 3)}</p></div></div>` : ""}
    <div class="dash"><section id="reports"><p class="sec-t">Simulation reports</p>
      ${runs.length ? `<div class="cards">${card(runs[0], true)}<div class="rows">${runs.slice(1).map(row).join("")}</div></div>`
        : `<div class="panel empty"><h2>No simulations yet</h2><p class="meta">Upload a photo of an intersection to run your first one.</p></div>`}</section>
      <aside class="panel how"><div class="panel-h"><h2>How FloorGuard works</h2></div><div class="panel-b"><ol>
        ${steps.map(([ic, t], i) => `<li><span class="n">${i + 1}</span><span class="ic">${ICONS[ic]}</span><span>${t}</span></li>`).join("")}
        </ol><p class="foot">NVIDIA Nemotron reads the photo, proposes fixes and revises them; a simulator measures every one. Simulated close calls, not injury predictions.</p></div></aside></div>`;
}

init().catch((e) => { if (e.message !== "locked") $("#main").innerHTML = `<div class="panel empty"><h2>Couldn't load your dashboard</h2><p class="meta">${esc(e.message)}</p></div>`; });
