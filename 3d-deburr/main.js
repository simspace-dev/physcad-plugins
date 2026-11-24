// 3D Deburr (3-axis, version 0.4)
// Finds sharp, outside (convex) edges on the open CAM setup's part that a tool coming down the
// setup's Z axis can reach, then adds ONE 2D Chamfer operation on all of them.
// Runs in PhysCAD's plugin sandbox: one file, no imports. Lengths mm, angles degrees.

const DEFAULT_MIN_ANGLE = 30;   // edges whose faces meet at less than this are "smooth" and skipped
const DEFAULT_WIDTH = 0.25;     // chamfer (edge break) width, mm (about 0.010")

// ---------- small vector helpers ----------
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const len = (a) => Math.sqrt(dot(a, a));
const unit = (a) => { const l = len(a); return l > 1e-12 ? scale(a, 1 / l) : null; };
const deg = (r) => (r * 180) / Math.PI;

const run = (name, args) => physcad.commands.run(name, args || {});

// Outward surface normal of a face at a point on it (null if this surface type isn't handled yet).
function normalAt(face, p) {
  if (face.surface === "plane" && face.normal) return unit(face.normal);
  if (face.surface === "cylinder" && face.axis) {
    const d = unit(face.axis.dir);
    const v = sub(p, face.axis.origin);
    const radial = unit(sub(v, scale(d, dot(v, d))));
    if (!radial) return null;
    return face.internal ? scale(radial, -1) : radial; // a hole's material faces the axis
  }
  return null;
}

const PROBE = 0.05; // mm: how far below an edge we probe to measure a wall's steepness

const isUpFlat = (f, z) => f.surface === "plane" && f.normal && dot(unit(f.normal), z) > 0.999;

// Is the edge level (all at one height along the tool axis)?
function isLevel(edge, A, B, zAxis) {
  if (isUpFlat(A, zAxis) || isUpFlat(B, zAxis)) return true; // every edge of a flat top lies in it
  const pts = [...(edge.endpoints || []), edge.midpoint].filter(Boolean);
  if (pts.length < 2) return false;
  const h = pts.map((q) => dot(q, zAxis));
  return Math.max(...h) - Math.min(...h) < 0.01;
}

// Steepness of a face with no direction data (e.g. a spline wall), measured just under an edge that
// sits on an upward flat face: returns |cos| of the angle between the wall and the tool axis.
async function wallCosUnder(body, faceName, p, zAxis) {
  const q = sub(p, scale(zAxis, PROBE));
  const r = await run("inspect.body", { body, maxFaces: 0, faceAt: { point: q, tol: PROBE * 2 } });
  const hit = (r.faceAt || []).find((h) => h.face === faceName);
  if (!hit) return null;
  return Math.min(1, hit.distance / PROBE);
}

// Classify one edge. Returns { ok, kind: "level" | "3d", reason, angle }.
async function classifyEdge(body, edge, facesByName, zAxis, minAngle) {
  if (!edge.faces || edge.faces.length !== 2) return { ok: false, reason: "not between two faces" };
  let A = facesByName[edge.faces[0]], B = facesByName[edge.faces[1]];
  if (!A || !B) return { ok: false, reason: "face data missing" };
  // Reference face: an upward flat if there is one, else any flat face.
  if (isUpFlat(B, zAxis) || (A.surface !== "plane" && B.surface === "plane")) [A, B] = [B, A];
  const p = edge.midpoint;
  const nA = normalAt(A, p);
  let nB = normalAt(B, p);
  let angle;

  if (nA && nB) {
    angle = deg(Math.acos(Math.max(-1, Math.min(1, dot(nA, nB)))));
  } else if (nA && isUpFlat(A, zAxis)) {
    const c = await wallCosUnder(body, B.name, p, zAxis); // wall of unknown shape under a flat top
    if (c === null) return { ok: false, reason: "could not measure the wall" };
    angle = deg(Math.acos(c));
  } else {
    return { ok: false, reason: "two curved faces (not handled yet)" };
  }
  if (angle < minAngle) return { ok: false, reason: "smooth edge (below minimum angle)", angle };

  // Outside corner test: face B's center sits behind face A's surface.
  if (nA) {
    let side = dot(sub(B.centroid, p), nA);
    if (Math.abs(side) < 1e-6 && nB && B.surface === "plane") side = dot(sub(A.centroid, p), nB);
    if (!(side < -1e-6)) return { ok: false, reason: "inside corner (no burr)", angle };
  }

  // Reachable from above: the edge must face up the tool axis.
  if (nB) {
    const bis = unit(add(nA, nB));
    if (!bis || dot(bis, zAxis) < 0.05) return { ok: false, reason: "faces down or sideways (needs another setup)", angle };
  } else if (!isUpFlat(A, zAxis)) {
    return { ok: false, reason: "faces down or sideways (needs another setup)", angle };
  }

  if (isLevel(edge, A, B, zAxis)) return { ok: true, kind: "level", angle };
  return { ok: false, reason: "not level (sloped or wavy in height)", angle };
}

async function openSetup() {
  const info = await run("cam.setup.get", {});
  if (!info || !info.setup) throw new Error("Open a CAM setup first");
  return info;
}

// ---------- edges the person has excluded, kept per document ----------
async function docKey() {
  try { const d = await physcad.model.document(); return "exclude:" + ((d && (d.file || d.name)) || "untitled"); }
  catch (_) { return "exclude:untitled"; }
}
const edgeId = (body, edge) => `${body}/${edge}`;
async function getExcluded() { return (await physcad.storage.get(await docKey())) || []; }
async function setExcluded(list) { await physcad.storage.set(await docKey(), list); }

// A narrow face (a modeled chamfer or small round): its average width, from area and perimeter.
function faceWidths(b) {
  const perim = {};
  for (const e of b.edges || []) for (const f of e.faces || []) perim[f] = (perim[f] || 0) + (e.length || 0);
  const w = {};
  for (const f of b.faces || []) if (perim[f.name] > 0) w[f.name] = (2 * f.area) / perim[f.name];
  return w;
}
const MODELED_MAX_WIDTH = 3;   // mm: faces narrower than this, meeting at a shallow angle, are modeled edge breaks
const MODELED_MAX_ANGLE = 75;  // degrees

async function findEdges({ minAngle = DEFAULT_MIN_ANGLE, exclude, skipHoles = false, holeMin = 0, holeMax = 10, skipModeled = true } = {}) {
  if (!(minAngle >= 0 && minAngle < 180)) throw new Error("The minimum angle must be between 0 and 180");
  if (skipHoles && !(holeMax >= holeMin)) throw new Error("The largest hole size must be at least the smallest");
  const info = await openSetup();
  const zAxis = unit(info.geometry.axes.z);
  const bodies = info.setup.bodies || [info.setup.body];
  const excluded = new Set(exclude || (await getExcluded()));
  const found = [], skipped = {};
  const skip = (why) => { skipped[why] = (skipped[why] || 0) + 1; };
  for (const body of bodies) {
    const b = await run("inspect.body", { body });
    const facesByName = {};
    for (const f of b.faces || []) facesByName[f.name] = f;
    const widths = faceWidths(b);
    for (const e of b.edges || []) {
      if (excluded.has(e.key) || excluded.has(edgeId(body, e.key))) { skip("excluded by you"); continue; }
      const faces = (e.faces || []).map((n) => facesByName[n]).filter(Boolean);
      if (skipHoles) {
        const hole = faces.find((f) => f.surface === "cylinder" && f.internal);
        if (hole && 2 * hole.radius >= holeMin && 2 * hole.radius <= holeMax) { skip("hole in the skipped size range"); continue; }
      }
      const c = await classifyEdge(body, e, facesByName, zAxis, minAngle);
      if (!c.ok) { skip(c.reason); continue; }
      if (skipModeled && c.angle < MODELED_MAX_ANGLE && faces.some((f) => widths[f.name] < MODELED_MAX_WIDTH)) { skip("already chamfered or rounded on the model"); continue; }
      found.push({ body, edge: e.key, angle: Math.round(c.angle), length: Math.round(e.length * 100) / 100 });
    }
  }
  return { setup: info.setup.id, edges: found, skipped };
}

// Pick a tool: the number given, else the first chamfer mill / spot drill in the library.
// Returns the whole library tool.
async function pickTool(tool) {
  const lib = await run("cam.tools.list", {});
  const tools = lib.tools || [];
  if (tool !== undefined && tool !== null && tool !== "") {
    const t = tools.find((x) => x.number === tool || x.id === tool || String(x.number) === String(tool));
    if (!t) throw new Error(`Tool ${tool} is not in the tool library`);
    return t;
  }
  const t = tools.find((x) => /chamfer|spot/i.test(x.type || ""));
  if (!t) throw new Error("No chamfer mill or spot drill in the tool library");
  return t;
}

// Name per shop convention: <setup #>-<2-digit sequence> <label>, e.g. 1-04 Deburr.
async function nextName(setupId, label = "Deburr") {
  const all = await run("cam.setups", {});
  const list = all.setups || all;
  const idx = Array.isArray(list) ? list.findIndex((s) => s.id === setupId) : -1;
  const ops = await run("cam.op.list", { setup: setupId, compact: true });
  const count = (ops.operations || ops.ops || ops || []).length || 0;
  return `${idx >= 0 ? idx + 1 : 1}-${String(count + 1).padStart(2, "0")} ${label}`;
}

// The edges picked in the view, as [{body, edge}].
async function selectedEdges() {
  const s = await physcad.model.selection();
  const items = Array.isArray(s) ? s : (s && (s.selection || s.items)) || [];
  return items.filter((i) => i && i.type === "edge" && i.body && i.edge).map((i) => ({ body: i.body, edge: i.edge }));
}

// ---------- commands ----------
const FIND_PARAMS = {
  minAngle: { type: "number", description: "Degrees between the two faces' directions below which an edge counts as smooth (default 30)" },
  exclude: { type: "array", items: { type: "string" }, description: "Edge keys to leave out (default: the ones excluded in the panel for this document)" },
  skipHoles: { type: "boolean", description: "Leave out round holes whose diameter is between holeMin and holeMax" },
  holeMin: { type: "number", description: "mm, default 0" },
  holeMax: { type: "number", description: "mm, default 10" },
  skipModeled: { type: "boolean", description: "Leave out edges already chamfered or rounded on the model (default true)" },
};
const findArgs = (a) => ({ minAngle: a.minAngle, exclude: a.exclude, skipHoles: a.skipHoles, holeMin: a.holeMin, holeMax: a.holeMax, skipModeled: a.skipModeled });

function checkPasses(passes) {
  if (!(Number.isInteger(passes) && passes >= 1 && passes <= 10)) throw new Error("Passes must be a whole number from 1 to 10");
}

physcad.commands.register({
  id: "findEdges",
  title: "Find deburr edges",
  description: "List (and highlight) the sharp outside edges of the open setup's part that a tool can reach from above.",
  params: { type: "object", properties: { ...FIND_PARAMS, highlight: { type: "boolean" } }, additionalProperties: false },
  async run(a = {}) {
    const r = await findEdges(findArgs(a));
    r.inCam = await inCam();
    // Outside CAM, selecting edges pops up PhysCAD's Edge card, so only highlight in CAM.
    if (a.highlight !== false && r.inCam) {
      try { await run("selection.set", { items: r.edges.map((e) => ({ type: "edge", body: e.body, edge: e.edge })) }); } catch (_) { /* highlighting is optional */ }
    }
    return r;
  },
});

physcad.commands.register({
  id: "createDeburr",
  title: "Create deburr toolpath",
  description: "Add one 2D Chamfer operation that breaks every edge findEdges finds. width: chamfer width mm (default 0.25). passes: 1-10 (default 1). tool: library tool number (default: first chamfer mill or spot drill).",
  params: {
    type: "object",
    properties: { ...FIND_PARAMS, width: { type: "number" }, passes: { type: "integer" }, tool: { type: ["number", "string"] } },
    additionalProperties: false,
  },
  async run(a = {}) {
    const { width = DEFAULT_WIDTH, passes = 1, tool } = a;
    if (!(width > 0)) throw new Error("The chamfer width must be more than 0");
    checkPasses(passes);
    const r = await findEdges(findArgs(a));
    if (!r.edges.length) throw new Error("No reachable sharp edges found");
    const t = await pickTool(tool);
    const name = await nextName(r.setup);
    const op = await run("cam.op.chamfer", {
      fields: { name, tool: t.number, geometry: { edges: r.edges.map((e) => ({ body: e.body, edge: e.edge })) }, chamferWidth: width, chamferPasses: passes },
    });
    await physcad.ui.toast(`${name}: ${r.edges.length} edges. Check it in simulation before cutting.`, "success");
    return { op, name, edgeCount: r.edges.length, skipped: r.skipped };
  },
});

// Wavy / 3D edges the person picks: a Path toolpath with the pointed tool's tip run along each
// edge, `width` below it. On a straight-down wall with a 90° tool that leaves a 45° chamfer
// `width` wide on each face. Where the face beside an edge rises at 45° or more, the tool's
// side will dig into it: the plugin can't check that yet, so the simulation must.
physcad.commands.register({
  id: "deburrSelected",
  title: "Deburr selected edges",
  description: "Add a Path operation that chamfers the edges picked in the view (any shape, wavy in 3D too) with a pointed tool, its tip `width` mm below each edge. width default 0.25; passes 1-10 (default 1); tool: library tool number (default: first chamfer mill or spot drill). edges: [{body, edge}] instead of the picks.",
  params: {
    type: "object",
    properties: {
      width: { type: "number" },
      passes: { type: "integer" },
      tool: { type: ["number", "string"] },
      edges: { type: "array", items: { type: "object", properties: { body: { type: "string" }, edge: { type: "string" } }, required: ["body", "edge"] } },
    },
    additionalProperties: false,
  },
  async run({ width = DEFAULT_WIDTH, passes = 1, tool, edges } = {}) {
    if (!(width > 0)) throw new Error("The chamfer width must be more than 0");
    checkPasses(passes);
    const info = await openSetup();
    const picks = edges && edges.length ? edges : await selectedEdges();
    if (!picks.length) throw new Error("Pick one or more edges on the part first");
    const t = await pickTool(tool);
    if (!/chamfer|spot|engrave/i.test(t.type || "")) throw new Error(`Tool ${t.number} is a ${t.type}: use a pointed chamfer mill or spot drill`);
    if ((t.tipDiameter || 0) > 0.05) throw new Error(`Tool ${t.number} has a flat tip; use one with a sharp point`);
    const reach = (t.diameter / 2) / Math.tan(((t.tipAngle || 90) / 2) * Math.PI / 180);
    if (width >= reach) throw new Error(`The width is too big for tool ${t.number}'s cone`);
    const name = await nextName(info.setup.id, "Deburr 3D");
    const fields = { name, tool: t.number, geometry: { edges: picks }, heights: { bottomOffset: -width } };
    if (passes > 1) fields.stepdown = width / passes;
    const op = await run("cam.op.trace", { fields });
    await physcad.ui.toast(`${name}: ${picks.length} edges. Check it in simulation: steep faces next to an edge can be gouged.`, "success");
    return { op, name, edgeCount: picks.length };
  },
});

physcad.commands.register({
  id: "excludeSelected",
  title: "Exclude selected edges",
  description: "Add the edges picked in the view to this document's list of edges the automatic search leaves out.",
  async run() {
    const picks = await selectedEdges();
    if (!picks.length) throw new Error("Pick one or more edges on the part first");
    const list = new Set(await getExcluded());
    for (const p of picks) list.add(edgeId(p.body, p.edge));
    await setExcluded([...list]);
    return { excluded: list.size };
  },
});

physcad.commands.register({
  id: "clearExcluded",
  title: "Clear excluded edges",
  description: "Empty this document's list of excluded edges.",
  async run() { await setExcluded([]); return { excluded: 0 }; },
});

physcad.commands.register({
  id: "excludedCount",
  title: "Count excluded edges",
  description: "How many edges this document's exclude list holds.",
  async run() { return { excluded: (await getExcluded()).length }; },
});

// ---- Pick mode: plain clicks add an edge, clicking a picked edge removes it ----
let pickOn = false;
let picked = [];          // [{body, edge}]
let lastSet = null;       // the list we last pushed to the view, to ignore its echo
const idOf = (p) => edgeId(p.body, p.edge);
const sameKey = (list) => list.map(idOf).sort().join(",");
function edgesIn(data) {
  const items = (data && (data.picks || data.items)) || [];
  return items.filter((i) => i && i.type === "edge" && i.body && i.edge).map((i) => ({ body: i.body, edge: i.edge }));
}
async function showPicked(current) {
  if (current && sameKey(current) === sameKey(picked)) { lastSet = null; return; } // view already right
  lastSet = sameKey(picked);
  try { await run("selection.set", { items: picked.map((p) => ({ type: "edge", ...p })) }); }
  catch (_) { /* view may be busy */ }
}
physcad.events.on("selectionChanged", async (data) => {
  if (!pickOn) return;
  const now = edgesIn(data);
  if (lastSet !== null && sameKey(now) === lastSet) { lastSet = null; return; } // our own update
  const have = new Set(picked.map(idOf));
  if (now.length === 1) {
    // A plain click: toggle that one edge.
    const id = idOf(now[0]);
    picked = have.has(id) ? picked.filter((p) => idOf(p) !== id) : [...picked, now[0]];
  } else if (now.length > 1) {
    // Shift-click or box select: keep whatever the view now holds.
    picked = now;
  }
  // An empty click (background or Esc) leaves the list alone.
  await showPicked(now);
});

physcad.commands.register({
  id: "pickMode",
  title: "Pick mode",
  description: "Turn pick mode on or off. While on, each click on an edge adds it to the selection and clicking a picked edge removes it, with no Shift key.",
  params: { type: "object", properties: { on: { type: "boolean" }, clear: { type: "boolean" } } },
  async run({ on, clear } = {}) {
    if (clear) { picked = []; await showPicked(); }
    if (typeof on === "boolean") {
      pickOn = on;
      if (on && !clear) picked = await selectedEdges();
    }
    return { on: pickOn, count: picked.length };
  },
});

async function inCam() {
  try { const r = await run("cam.setups", {}); return !!(r && r.open); } catch (_) { return false; }
}
physcad.commands.register({
  id: "workspace",
  title: "Which workspace",
  description: "Whether the Manufacture (CAM) workspace is open, which this plugin needs.",
  async run() { return { inCam: await inCam() }; },
});

physcad.commands.register({ id: "open", title: "3D Deburr", description: "Open the 3D Deburr panel.", async run() {
  if (!(await inCam())) {
    await physcad.ui.toast("3D Deburr works in the CAM workspace. Switch to CAM, then click the icon again.", "info");
    return { opened: false };
  }
  await physcad.ui.openPanel("panel");
  return { opened: true };
} });
physcad.ui.addToolbarButton({ command: "open", tip: "3D Deburr" });
