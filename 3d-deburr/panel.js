const $ = (id) => document.getElementById(id);
const width = $("width"), passes = $("passes"), tool = $("tool"), angle = $("angle");
const skipModeled = $("skipModeled"), skipHoles = $("skipHoles"), holeMin = $("holeMin"), holeMax = $("holeMax");
const status = $("status"), excludedNote = $("excludedNote");

// Remember the panel's settings between sessions.
const SAVED = ["width", "passes", "angle", "holeMin", "holeMax"];
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
const common = () => ({ width: Number(width.value), passes: Math.round(Number(passes.value)), ...toolArg() });
const findOpts = () => ({
  minAngle: Number(angle.value),
  skipModeled: skipModeled.checked,
  skipHoles: skipHoles.checked,
  holeMin: Number(holeMin.value),
  holeMax: Number(holeMax.value),
});

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

async function busy(btn, fn) {
  btn.disabled = true;
  try { await save(); await fn(); }
  catch (e) { status.textContent = e.message; await physcad.ui.toast(e.message, "error"); }
  finally { btn.disabled = false; }
}

$("find").addEventListener("click", () => busy($("find"), async () => {
  const r = await physcad.commands.run("findEdges", findOpts());
  showCam(r.inCam);
  const wavy = r.edges.filter((e) => e.kind === "3d").length;
  status.textContent = `${r.edges.length} edges to deburr (${r.edges.length - wavy} level, ${wavy} 3D)` + (r.inCam ? " (highlighted)." : ". Switch to CAM to see them highlighted.") + skippedText(r.skipped);
}));

$("make").addEventListener("click", () => busy($("make"), async () => {
  const r = await physcad.commands.run("createDeburr", { ...findOpts(), ...common() });
  status.textContent = `Made ${r.ops.map((o) => `${o.name} on ${o.edgeCount} edges`).join(" and ")}.` + skippedText(r.skipped);
}));

$("picked").addEventListener("click", () => busy($("picked"), async () => {
  const r = await physcad.commands.run("deburrSelected", common());
  status.textContent = `Made ${r.name} on ${r.edgeCount} picked edges. Check the simulation for gouges.`;
}));

$("exclude").addEventListener("click", () => busy($("exclude"), async () => {
  await physcad.commands.run("excludeSelected", {});
  await showExcluded();
  status.textContent = "Those edges will be left out of Find edges and Create deburr.";
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
  showPick(await physcad.commands.run("pickMode", { clear: true }));
  status.textContent = "Picks cleared.";
}));
physcad.commands.run("pickMode", {}).then(showPick).catch(() => {});

physcad.events.on("documentOpened", showExcluded);
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
async function checkCam() {
  try { showCam((await physcad.commands.run("workspace", {})).inCam); } catch (_) { /* leave as is */ }
}
checkCam();
setInterval(checkCam, 2000);
