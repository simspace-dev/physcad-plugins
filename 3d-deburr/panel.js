const $ = (id) => document.getElementById(id);
const width = $("width"), passes = $("passes"), tool = $("tool"), angle = $("angle");
const skipModeled = $("skipModeled"), skipHoles = $("skipHoles"), holeMin = $("holeMin"), holeMax = $("holeMax");
const status = $("status"), excludedNote = $("excludedNote");

// Remember the panel's settings between sessions.
const SAVED = ["width", "passes", "angle", "holeMin", "holeMax", "wallClear", "tolerance"];
physcad.storage.get("panel").then((v) => {
  if (!v) return;
  for (const k of SAVED) if (typeof v[k] === "number") $(k).value = v[k];
  if (typeof v.tool === "string") tool.value = v.tool;
  if (typeof v.skipModeled === "boolean") skipModeled.checked = v.skipModeled;
  if (typeof v.skipHoles === "boolean") skipHoles.checked = v.skipHoles;
});
function save() {
  const v = { tool: tool.value, skipModeled: skipModeled.checked, skipHoles: skipHoles.checked };
  for (const k of SAVED) v[k] = Number($(k).value);
  return physcad.storage.set("panel", v);
}

function toolArg() {
  const t = tool.value.trim();
  if (!t) return {};
  return { tool: /^\d+$/.test(t) ? Number(t) : t };
}
const toolOpts = () => ({ width: Number(width.value), tolerance: Number($("tolerance").value), ...toolArg() });
const common = () => ({ ...toolOpts(), passes: Math.round(Number(passes.value)) });
const findOpts = () => ({
  minAngle: Number(angle.value),
  skipModeled: skipModeled.checked,
  skipHoles: skipHoles.checked,
  holeMin: Number(holeMin.value),
  holeMax: Number(holeMax.value),
});

// A length in the document's units (the plugin works in mm).
const fmt = (mm, units) => (units === "in" ? `${(mm / 25.4).toFixed(4)} in` : `${mm.toFixed(3)} mm`);
function checkText(r) {
  return r.check && r.check !== "on" ? ` 3D edge check ${r.check}.` : "";
}
// The break the 3D edges are planned to get, and what they get until PhysCAD can follow that plan.
function widthText(r) {
  const w = (r.edges || []).filter((e) => e.kind !== "level").map((e) => e.cutWidth).filter(Boolean);
  if (!w.length) return "";
  const plan = ` Wavy edges: break planned ${fmt(Math.min(...w.map((x) => x[0])), r.units)} to ${fmt(Math.max(...w.map((x) => x[1])), r.units)} wide.`;
  return plan + (r.standIn ? " Until PhysCAD's update they are cut at one depth, so the break is uneven." : "");
}
// Edges with a problem: left out when the plugin found the edges, cut anyway when you picked them.
function leftOutText(r) {
  const flagged = r.flagged || [], n = flagged.length + (r.partial || []).length;
  if (!n) return "";
  if (r.mode === "picked") return ` ${n} picked edges have a problem (cut anyway): ${[...new Set(flagged.map((f) => f.reason))].join("; ")}. Press Show problem edges to see them.`;
  return ` ${n} left out or only partly sharp: press Show problem edges to see them.`;
}
function skippedText(s) {
  const parts = Object.entries(s || {}).map(([k, n]) => `${n} ${k}`);
  return parts.length ? ` Skipped: ${parts.join("; ")}.` : "";
}

async function showExcluded() {
  try {
    const r = await physcad.commands.run("excludedCount", {});
    excludedNote.textContent = r.excluded ? `${r.excluded} edges excluded in this document.` : "";
  } catch (_) { excludedNote.textContent = ""; }
}

// The progress bar: sliding while nothing is known, then filled as main.js reports each edge.
const bar = $("bar"), barFill = $("barFill");
let working = false;
function showProgress(p) {
  if (!working || !p) return;
  const known = typeof p.fraction === "number";
  bar.classList.toggle("unknown", !known);
  barFill.style.width = known ? `${Math.round(Math.max(0, Math.min(1, p.fraction)) * 100)}%` : "";
  if (p.text) status.textContent = `${p.text}…`;
}
if (physcad.onMessage) physcad.onMessage((data) => showProgress(data && data.progress));   // sent by main.js

async function busy(btn, fn) {
  btn.disabled = true;
  working = true;
  bar.hidden = false; bar.classList.add("unknown"); barFill.style.width = "";
  status.textContent = "Working…";
  try { await queue; await save(); await fn(); }   // let a background question finish first
  catch (e) { status.textContent = e.message; await physcad.ui.toast(e.message, "error"); }
  finally {
    working = false; bar.hidden = true;
    if (btn !== removeBtn) btn.disabled = false;   // Remove last deburr: showRemove decides
    await showPicks();
    await showRemove();
  }
}

// One button does the deburring: all edges when none are picked, the picked ones when some are.
// Its label says which. Preview shows the automatic set, so it is off while edges are picked.
const makeBtn = $("make"), findBtn = $("find");
// Background questions to the plugin go one at a time (larger, parallel requests stopped
// PhysCAD's modeling engine once).
let queue = Promise.resolve();
function ask(id, args = {}) {
  const next = queue.then(() => physcad.commands.run(id, args));
  queue = next.catch(() => {});
  return next;
}
async function showPicks() {
  if (working) return;
  let n = 0;
  try { n = (await ask("selectedCount")).count || 0; } catch (_) { /* treat as none */ }
  if (working) return;
  makeBtn.textContent = n ? `Deburr ${n} picked edge${n === 1 ? "" : "s"}` : "Deburr all edges";
  findBtn.disabled = n > 0;
  await showProblems(false);
}
// The problem-edges button is only on while the last Preview or Deburr's problem edges still
// apply, and says how many. The plugin keeps that record and forgets it when the document, setup,
// part or picks change; deep also checks the part's shape.
const problemBtn = $("leftOut");
async function showProblems(deep) {
  if (working) return;
  let n = 0;
  try { n = (await ask("problemCount", { deep })).count || 0; } catch (_) { /* treat as none */ }
  if (working) return;
  problemBtn.disabled = !n;
  problemBtn.textContent = n ? `Show ${n} problem edge${n === 1 ? "" : "s"}` : "Show problem edges";
}
// Remove last deburr is only on while the last Deburr's toolpaths are still in their setup.
const removeBtn = $("removeLast");
async function showRemove() {
  if (working) return;
  let ops = [];
  try { ops = (await ask("lastDeburr")).ops || []; } catch (_) { /* treat as none */ }
  if (working) return;
  removeBtn.disabled = !ops.length;
}
// Any setting changed: the last run's problem edges may no longer be right.
function settingChanged(e) {
  if (!e.target.closest || !e.target.closest(".prop, .checks")) return;
  ask("forgetProblems").catch(() => {});
  problemBtn.disabled = true;
  problemBtn.textContent = "Show problem edges";
}
document.addEventListener("input", settingChanged);
document.addEventListener("change", settingChanged);
physcad.events.on("selectionChanged", showPicks);
showPicks();

$("find").addEventListener("click", () => busy($("find"), async () => {
  const r = await physcad.commands.run("findEdges", { ...findOpts(), ...toolOpts() });
  showCam(r.inCam);
  const wavy = r.edges.filter((e) => e.kind === "3d").length;
  status.textContent = `${r.edges.length} edges to deburr (${r.edges.length - wavy} level, ${wavy} wavy)` + (r.tool ? ` with ${r.tool}` : "") + (r.inCam ? " (highlighted)." : ". Switch to CAM to see them highlighted.") + widthText(r) + skippedText(r.skipped) + leftOutText(r) + checkText(r);
}));

$("make").addEventListener("click", () => busy($("make"), async () => {
  const r = await physcad.commands.run("createDeburr", { ...findOpts(), ...common(), wallClear: Number($("wallClear").value) });
  status.textContent = `Made ${r.ops.map((o) => `${o.name} on ${o.edgeCount} edges`).join(" and ")} with ${r.tool}.` + widthText(r) + skippedText(r.skipped) + leftOutText(r);
  removeBtn.disabled = false;
}));

removeBtn.addEventListener("click", () => busy(removeBtn, async () => {
  const r = await physcad.commands.run("removeLastDeburr", {});
  removeBtn.disabled = true;
  status.textContent = `Removed ${r.removed.join(" and ")}. Picks cleared: pick edges again, or press Deburr all edges.`;
}));

$("leftOut").addEventListener("click", () => busy($("leftOut"), async () => {
  const r = await physcad.commands.run("showLeftOut", {});
  status.textContent = r.count ? `${r.count} edges with a problem highlighted.` : "Something changed since the last run (the part, setup or picks). Run Preview or Deburr again.";
}));

$("exclude").addEventListener("click", () => busy($("exclude"), async () => {
  await physcad.commands.run("excludeSelected", {});
  await showExcluded();
  status.textContent = "Those edges will be left out whenever the plugin finds the edges itself.";
}));

$("clear").addEventListener("click", () => busy($("clear"), async () => {
  await physcad.commands.run("clearExcluded", {});
  await showExcluded();
  status.textContent = "Exclusions cleared.";
}));

const pickBtn = $("pickMode");
function showPick(r) {
  pickBtn.textContent = `Pick mode: ${r.on ? "ON" : "off"}`;
  pickBtn.classList.toggle("primary", r.on);
}
pickBtn.addEventListener("click", () => busy(pickBtn, async () => {
  const on = !pickBtn.textContent.includes("ON");
  const r = await physcad.commands.run("pickMode", { on });
  showPick(r);
  status.textContent = r.on ? "Pick mode on. Click edges to add or remove them." : "Pick mode off.";
}));
$("pickClear").addEventListener("click", () => busy($("pickClear"), async () => {
  showPick(await physcad.commands.run("pickMode", { clear: true }));   // also forgets the problem edges
  status.textContent = "Picks cleared.";
}));
physcad.commands.run("pickMode", {}).then(showPick).catch(() => {});

physcad.events.on("documentOpened", () => { showExcluded(); showPicks(); showRemove(); });
showRemove();
showExcluded();

// Tooltips: our own, so the delay is ours (the system one waits about 1 s).
const TIP_DELAY = 700;
const tip = $("tip");
let tipTimer = 0;
for (const el of document.querySelectorAll("[title]")) {
  el.dataset.tip = el.title;
  el.removeAttribute("title");
}
function hideTip() { clearTimeout(tipTimer); tip.classList.remove("show"); }
document.addEventListener("mouseover", (e) => {
  const el = e.target.closest && e.target.closest("[data-tip]");
  hideTip();
  if (!el) return;
  tipTimer = setTimeout(() => {
    tip.textContent = el.dataset.tip;
    const r = el.getBoundingClientRect();
    const w = tip.offsetWidth, h = tip.offsetHeight;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
    const below = r.bottom + 26;   // clear of the mouse pointer
    tip.style.left = left + "px";
    tip.style.top = (below + h > window.innerHeight - 4 ? Math.max(4, r.top - h - 6) : below) + "px";
    tip.classList.add("show");
  }, TIP_DELAY);
});
document.addEventListener("mousedown", hideTip);
document.addEventListener("mouseleave", hideTip);

// Show a note when the Manufacture (CAM) workspace isn't open. PhysCAD sends no
// event when the workspace changes, so check every couple of seconds.
const camWarn = $("camWarn");
function showCam(on) { camWarn.hidden = !!on; }
// The same check also sees a part edit or a setup change, so the problem-edges button greys out.
let checking = false;
async function checkCam() {
  if (working || checking) return;
  checking = true;
  try { showCam((await ask("workspace")).inCam); } catch (_) { /* leave as is */ }
  if (!problemBtn.disabled) await showProblems(true);
  if (!removeBtn.disabled) await showRemove();   // its toolpaths deleted by hand: grey it out
  checking = false;
}
checkCam();
setInterval(checkCam, 2000);
