// 3D Deburr (3-axis, version 0.6.0)
// Finds sharp, outside (convex) edges on the open CAM setup's part that a tool coming down the
// setup's Z axis can reach, on any kind of surface, checked at points all along each edge. Level
// edges (a flat top over a vertical wall) get one 2D Chamfer operation; wavy or sloped (3D)
// edges get one Path operation, after a check that the tool can cut each of them cleanly.
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

// inspect.surfaceNormals for any number of points, asked for a batch at a time.
const NORMALS_BATCH = 1500;
async function normalsOf(body, face, points) {
  const out = [];
  for (let i = 0; i < points.length; i += NORMALS_BATCH) {
    const r = await run("inspect.surfaceNormals", { body, face, points: points.slice(i, i + NORMALS_BATCH) });
    for (const p of r.points) out.push(p);
  }
  return { points: out };
}

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const clamp1 = (x) => Math.max(-1, Math.min(1, x));

const SAMPLE_STEP = 2;       // mm between the points checked along an edge
const MAX_SAMPLES = 400;
const PROBE = 0.05;          // mm: how far across a face we step to see which side it lies on
const LEVEL_TOL = 0.01;      // mm: an edge whose height varies less than this is "level"
const FLAT_COS = 0.999;      // a face this square to the tool axis counts as flat
const VERTICAL_SIN = 0.02;   // a face leaning less than this (about 1 degree) counts as vertical
const DEFAULT_TOL = 20;      // percent the cut width may differ from the width asked for

// Points all along an edge, with both faces' outward directions there and the direction each
// face runs away from the edge (square to it, along the face).
async function sampleEdge(body, key, faces, length) {
  const [faceA, faceB] = faces;
  const count = Math.max(5, Math.min(MAX_SAMPLES, Math.ceil((length || 0) / SAMPLE_STEP) + 1));
  const ep = await run("inspect.edgePoints", { body, edge: key, count });
  const samples = (ep && ep.points) || [];
  if (samples.length < 2) return null;
  const pts = samples.map((s) => s.point), tangents = samples.map((s) => unit(s.tangent) || [0, 0, 0]);
  const [ra, rb] = await Promise.all([
    run("inspect.surfaceNormals", { body, face: faceA, points: pts }),
    run("inspect.surfaceNormals", { body, face: faceB, points: pts }),
  ]);
  const nA = ra.points.map((r) => unit(r.normal)), nB = rb.points.map((r) => unit(r.normal));
  // Step both ways across each face, square to the edge: the step that stays on the face is
  // the one into it.
  const intoOf = async (face, n) => {
    const across = tangents.map((t, i) => (n[i] && unit(cross(t, n[i]))) || [0, 0, 0]);
    const probes = [];
    pts.forEach((p, i) => { probes.push(add(p, scale(across[i], PROBE)), sub(p, scale(across[i], PROBE))); });
    const r = await run("inspect.surfaceNormals", { body, face, points: probes });
    return across.map((a, i) => (r.points[2 * i].distance <= r.points[2 * i + 1].distance ? a : scale(a, -1)));
  };
  const [intoA, intoB] = await Promise.all([intoOf(faceA, nA), intoOf(faceB, nB)]);
  const closed = !!ep.closed, span = closed ? samples.length : samples.length - 1;
  const arc = pts.map((_, i) => (i * ep.length) / span);   // how far along the edge each point is
  return { faces, length: ep.length, closed, pts, tangents, nA, nB, intoA, intoB, arc };
}

// Classify one edge by checking it at points all along its length, on any kind of surface.
// Returns { ok, kind: "level" | "3d", reason, partial, angle, data } (angle: the smallest along
// the edge; partial: only some of the edge fails).
async function classifyEdge(body, edge, zAxis, minAngle) {
  if (!edge.faces || edge.faces.length !== 2) return { ok: false, reason: "not between two faces" };
  const d = await sampleEdge(body, edge.key, edge.faces, edge.length);
  if (!d) return { ok: false, reason: "could not sample the edge" };
  const { pts, nA, nB, intoB } = d;

  let minA = 180, smooth = 0, inside = 0, down = 0;
  for (let i = 0; i < pts.length; i++) {
    if (!nA[i] || !nB[i]) return { ok: false, reason: "face data missing" };
    const a = deg(Math.acos(clamp1(dot(nA[i], nB[i]))));
    minA = Math.min(minA, a);
    if (a < minAngle) { smooth++; continue; }               // too gentle here to need a deburr
    if (!(dot(intoB[i], nA[i]) < -1e-3)) { inside++; continue; } // B folds up in front of A: inside corner
    const bis = unit(add(nA[i], nB[i]));
    if (!bis || dot(bis, zAxis) < 0.05) down++;              // the corner faces down or sideways
  }
  const n = pts.length, angle = minA;
  const fail = (k, why) => ({ ok: false, reason: (k === n ? "" : "partly ") + why, partial: k !== n, angle });
  if (smooth) return fail(smooth, "smooth edge (below minimum angle)");
  if (inside) return fail(inside, "inside corner (no burr)");
  if (down) return fail(down, "faces down or sideways (needs another setup)");

  // "Level" (a 2D Chamfer can do it): the edge sits at one height AND it is a flat top over a
  // vertical wall all the way along. Anything else is a 3D edge.
  const h = pts.map((q) => dot(q, zAxis));
  const oneHeight = Math.max(...h) - Math.min(...h) < LEVEL_TOL;
  const flatOverWall = pts.every((_, i) => {
    const a = dot(nA[i], zAxis), b = dot(nB[i], zAxis);
    return (a > FLAT_COS && Math.abs(b) < VERTICAL_SIN) || (b > FLAT_COS && Math.abs(a) < VERTICAL_SIN);
  });
  return { ok: true, kind: oneHeight && flatOverWall ? "level" : "3d", angle, data: d };
}

// ---------- the tool, as a shape ----------
function toolShape(tool) {
  const half = ((tool.tipAngle || 90) / 2) * Math.PI / 180;
  const tanH = Math.tan(half), R = (tool.diameter || 6) / 2;
  return { tanH, R, coneHeight: R / tanH };
}
const toolLabel = (t) => `T${t.number} ${(t.description || t.type || "").slice(0, 44)}`.trim();

// How far inside the tool a point is, sideways (mm): positive inside, negative outside. The
// tool is a cone on its tip, then a cylinder of its diameter above that.
function margin(q, tip, zAxis, sh) {
  const v = sub(q, tip), h = dot(v, zAxis);
  const r = len(sub(v, scale(zAxis, h)));
  return h <= 0 ? -Math.max(r, -h) : Math.min(h * sh.tanH, sh.R) - r;
}

// ---------- check of the Path toolpath on a 3D edge ----------
// The Path op runs a pointed tool's axis straight down through the edge, its tip `width` below
// it. Four things can go wrong, all checked here at points along the edge:
//  steep  the edge climbs as steeply as the tool's side, so the side ploughs along it
//  notch  both faces slope away from the edge, so the tip is buried and cuts a V groove
//  hit    the tool runs into some other face nearby (a wall, a step the edge ends against)
//  digs   a face beside the edge rises into the tool
// Otherwise it measures the cut: on each face, how far from the edge the tool reaches, counting
// the tool at EVERY position along the edge (where an edge climbs, the wide part of the cone a
// little way down the slope cuts more than the cone right at the point does).
const REASONS = {
  steep: "climbs too steeply for this tool's point",
  notch: "both faces slope away from it (the tool would cut a groove)",
  hit: "the tool would hit another face nearby",
  digs: "the tool would dig into a steep face beside it",
  uneven: "the cut width would vary more than the tolerance",
};
const CHECK_SAMPLES = 60;   // most points checked per edge
const HIT_SAMPLES = 40;     // most points per edge checked against nearby faces
const DENSE_STEP = 0.025;   // mm between the tool positions counted along the edge
const FETCH_STEP = 0.25;    // mm between the edge points asked of PhysCAD for those positions
const STEEP = 0.98;         // of the slope at which the tool's side runs along the edge
const NOTCH_SIN = 0.087;    // both faces facing up by more than this (about 5 degrees): a groove
const NEAR_FACES_MAX = 60;

async function cutCheck(body, key, d, tool, width, zAxis) {
  const sh = toolShape(tool), D = width, n = d.pts.length;
  const every = Math.max(1, Math.ceil(n / CHECK_SAMPLES));
  const idx = [];
  for (let i = 0; i < n; i++) if (i % every === 0 || i === n - 1) idx.push(i);

  // Tool tip positions all along the edge, close together.
  // Asked for every FETCH_STEP, then filled in between in straight pieces.
  const fCount = Math.max(2, Math.min(2000, Math.ceil(d.length / FETCH_STEP) + 1));
  const de = await run("inspect.edgePoints", { body, edge: key, count: fCount });
  const fetched = de.points.map((s) => sub(s.point, scale(zAxis, D)));
  if (d.closed) fetched.push(fetched[0]);
  const sub_n = Math.max(1, Math.round((d.length / (fetched.length - 1)) / DENSE_STEP));
  const tipsAll = [];
  for (let i = 0; i + 1 < fetched.length; i++) for (let k = 0; k < sub_n; k++) tipsAll.push(add(fetched[i], scale(sub(fetched[i + 1], fetched[i]), k / sub_n)));
  if (!d.closed) tipsAll.push(fetched[fetched.length - 1]);
  const dStep = d.length / (d.closed ? tipsAll.length : tipsAll.length - 1);
  const win = Math.ceil(sh.R / dStep);
  const endDir = [unit(de.points[0].tangent) || [0, 0, 0], unit(de.points[de.points.length - 1].tangent) || [0, 0, 0]];
  const tipsNear = (i) => {
    const c = Math.round(d.arc[i] / dStep), out = [];
    for (let j = c - win; j <= c + win; j++) {
      if (d.closed) out.push(tipsAll[((j % tipsAll.length) + tipsAll.length) % tipsAll.length]);
      else if (j >= 0 && j < tipsAll.length) out.push(tipsAll[j]);
      // Past an open edge's end the toolpath carries on (the next edge, or a lead in or out):
      // take it as going straight on.
      else if (j < 0) out.push(add(tipsAll[0], scale(endDir[0], j * dStep)));
      else out.push(add(tipsAll[tipsAll.length - 1], scale(endDir[1], (j - tipsAll.length + 1) * dStep)));
    }
    return out;
  };
  // margin(), over many tips, without making arrays.
  const deepest = (q, tips) => {
    let best = -Infinity;
    for (const t of tips) {
      const x = q[0] - t[0], y = q[1] - t[1], z = q[2] - t[2];
      const h = x * zAxis[0] + y * zAxis[1] + z * zAxis[2];
      const r = Math.sqrt(Math.max(0, x * x + y * y + z * z - h * h));
      const m = h <= 0 ? -Math.max(r, -h) : Math.min(h * sh.tanH, sh.R) - r;
      if (m > best) best = m;
    }
    return best;
  };

  const reach = Math.max(4 * width, sh.R * Math.sqrt(1 + 1 / (sh.tanH * sh.tanH)) + width);
  const steps = [];
  for (let k = 1; k <= 16; k++) steps.push((4 * width * k) / 16);
  for (let k = 1; k <= 8; k++) steps.push(4 * width + ((reach - 4 * width) * k) / 8);

  // Walk out across a face from each point: where does the face leave the tool? Most cuts end
  // within 4 widths, so the far steps are only asked for where the near ones didn't settle it.
  const near = steps.slice(0, 16), far = steps.slice(16);
  const faceCut = async (face, into) => {
    const walk = async (list, st, state) => {
      const query = [];
      for (const j of list) for (const s of st) query.push(add(d.pts[idx[j]], scale(into[idx[j]], s)));
      const r = await normalsOf(body, face, query);
      list.forEach((j, n) => {
        const c = state[j], tips = tipsNear(idx[j]);
        for (let k = 0; k < st.length && !c.done; k++) {
          const rp = r.points[n * st.length + k];
          // The step went off the face (a narrow face): the cut runs to its far side.
          if (rp.distance > 0.01 + 0.2 * st[k]) { c.done = true; c.leg = c.prevS; c.at = c.prevQ; break; }
          const m = deepest(rp.point, tips);
          if (m <= 0) {
            const f = c.prevM / Math.max(c.prevM - m, 1e-9);
            c.done = true; c.leg = c.prevS + (st[k] - c.prevS) * f; c.at = add(c.prevQ, scale(sub(rp.point, c.prevQ), f));
            break;
          }
          c.prevS = st[k]; c.prevM = m; c.prevQ = rp.point;
        }
      });
    };
    const state = idx.map((i) => ({ done: false, leg: Infinity, at: null, prevS: 0, prevM: deepest(d.pts[i], tipsNear(i)), prevQ: d.pts[i] }));
    const all = idx.map((_, j) => j);
    await walk(all, near, state);
    const open = all.filter((j) => !state[j].done);
    if (open.length) await walk(open, far, state);          // still inside after that: the tool digs in
    return state;
  };
  const cutA = await faceCut(d.faces[0], d.intoA);
  const cutB = await faceCut(d.faces[1], d.intoB);
  const hits = await nearFaceHits(body, d, idx, sh, D, zAxis);

  const count = { steep: 0, notch: 0, digs: 0 }, at = {};
  const mark = (why, i) => { count[why]++; if (!at[why]) at[why] = d.pts[i]; };
  let lo = Infinity, hi = 0, legLo = Infinity, legHi = 0, atHi = null, atLo = null;
  idx.forEach((i, j) => {
    const tz = Math.abs(dot(d.tangents[i], zAxis));
    if ((tz / Math.sqrt(Math.max(1e-12, 1 - tz * tz))) * sh.tanH >= STEEP) return mark("steep", i);
    if (Math.min(dot(d.nA[i], zAxis), dot(d.nB[i], zAxis)) > NOTCH_SIN) return mark("notch", i);
    const a = cutA[j], b = cutB[j];
    if (!isFinite(a.leg) || !isFinite(b.leg)) return mark("digs", i);
    // The bevel's width, as the width of a square corner's chamfer with the same bevel face.
    const w = len(sub(a.at, b.at)) / Math.SQRT2;
    if (w > hi) { hi = w; atHi = d.pts[i]; }
    if (w < lo) { lo = w; atLo = d.pts[i]; }
    legLo = Math.min(legLo, a.leg, b.leg); legHi = Math.max(legHi, a.leg, b.leg);
  });
  const r3 = (x) => Math.round(x * 1000) / 1000, pt = (p) => (p ? p.map((x) => Math.round(x * 100) / 100) : null);
  const measured = isFinite(lo);
  return {
    checked: idx.length, steep: count.steep, notch: count.notch, digs: count.digs, hits,
    width: measured ? [r3(lo), r3(hi)] : null, legs: measured ? [r3(legLo), r3(legHi)] : null,
    at: { steep: pt(at.steep), notch: pt(at.notch), digs: pt(at.digs), hit: hits.length ? hits[0].at : null, widest: pt(atHi), narrowest: pt(atLo) },
  };
}

// Faces near the edge that end up inside the tool. Points up the tool's axis are dropped onto
// each nearby face; a face point well inside the tool there is a hit. (The two faces of the
// edge itself are let in as far as the chamfer goes.)
async function nearFaceHits(body, d, idx, sh, D, zAxis) {
  const height = sh.coneHeight + 2 * sh.R;
  const fr = [0.05, 0.12, 0.25, 0.45, 0.7, 1];
  const stride = Math.max(1, Math.ceil(idx.length / HIT_SAMPLES));
  const tips = idx.filter((_, j) => j % stride === 0 || j === idx.length - 1).map((i) => sub(d.pts[i], scale(zAxis, D)));
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const t of tips) for (const p of [t, add(t, scale(zAxis, height))]) for (let k = 0; k < 3; k++) {
    min[k] = Math.min(min[k], p[k] - sh.R - 0.5); max[k] = Math.max(max[k], p[k] + sh.R + 0.5);
  }
  let names;
  try {
    const b = await run("inspect.body", { body, edges: false, maxFaces: 100000, faces: { box: { min, max } } });
    names = (b.faces || []).map((f) => f.name);
  } catch (_) { return []; }
  const allowed = 1.5 * D * sh.tanH + 0.02, hits = [];
  for (const face of names.slice(0, NEAR_FACES_MAX)) {
    const query = [];
    for (const t of tips) for (const f of fr) query.push(add(t, scale(zAxis, f * height)));
    const r = await normalsOf(body, face, query);
    for (let j = 0; j < query.length; j++) {
      const q = r.points[j].point, tip = tips[Math.floor(j / fr.length)];
      if (margin(q, tip, zAxis, sh) > allowed) { hits.push({ face, at: q.map((x) => Math.round(x * 100) / 100) }); break; }
    }
  }
  return hits;
}

// Why a checked 3D edge must be left out, or null when it is fine.
function verdict(g, width, tolerance) {
  if (g.steep) return "steep";
  if (g.notch) return "notch";
  if (g.hits.length) return "hit";
  if (g.digs || !g.width) return "digs";
  const off = Math.max(Math.abs(g.width[0] - width), Math.abs(g.width[1] - width)) / width;
  return off * 100 > tolerance ? "uneven" : null;
}

// ---------- even-width chamfer: how deep the tip must go ----------
// What depth below the edge, at each point, gives a bevel exactly `width` wide (measured as in
// cutCheck)? Worked out on each face's flat tangent plane with the edge taken as straight there,
// so everything scales with the depth: find the bevel a depth of 1 gives, then scale. Counts
// the tool at every position along the edge, as cutCheck does.
function evenDepths(d, tool, width, zAxis) {
  const { tanH } = toolShape(tool), t2 = tanH * tanH;
  const horiz = (v) => sub(v, scale(zAxis, dot(v, zAxis)));
  return d.pts.map((p, i) => {
    const t = d.tangents[i], tz = dot(t, zAxis), b = horiz(t);
    const A2 = tz * tz * t2 - dot(b, b);
    if (A2 >= -1e-9) return { depth: null, legs: null };     // too steep for this tool
    // Is the point s along `dir` inside the tool at some position along the edge? (depth 1)
    const inside = (dir, s) => {
      const h0 = s * dot(dir, zAxis) + 1, a = scale(horiz(dir), s);
      const tau = (tz * t2 * h0 - dot(a, b)) / A2, h = h0 - tau * tz;
      if (h <= 0) return false;
      const off = sub(a, scale(b, tau));
      return h * h * t2 - dot(off, off) > 0;
    };
    const legOf = (dir) => {
      if (inside(dir, 1000)) return Infinity;
      let lo = 0, hi = 1000;
      for (let k = 0; k < 60; k++) { const mid = (lo + hi) / 2; if (inside(dir, mid)) lo = mid; else hi = mid; }
      return (lo + hi) / 2;
    };
    const kA = legOf(d.intoA[i]), kB = legOf(d.intoB[i]);
    if (!isFinite(kA) || !isFinite(kB)) return { depth: null, legs: null };
    const unitWidth = len(sub(scale(d.intoA[i], kA), scale(d.intoB[i], kB))) / Math.SQRT2;
    const depth = width / unitWidth;
    return { depth, legs: [depth * kA, depth * kB] };
  });
}

async function openSetup() {
  const info = await run("cam.setup.get", {});
  if (!info || !info.setup) throw new Error("Open a CAM setup first");
  return info;
}

// ---------- edges the person has excluded, kept per document ----------
async function docInfo() { try { return (await physcad.model.document()) || {}; } catch (_) { return {}; } }
async function docKey() { const d = await docInfo(); return "exclude:" + (d.file || d.name || "untitled"); }
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

let lastLeftOut = [];          // the edges the last search left out, for "Show left out"

async function findEdges({ minAngle = DEFAULT_MIN_ANGLE, exclude, skipHoles = false, holeMin = 0, holeMax = 10, skipModeled = true, width = DEFAULT_WIDTH, tool, tolerance = DEFAULT_TOL } = {}) {
  if (!(minAngle >= 0 && minAngle < 180)) throw new Error("The minimum angle must be between 0 and 180");
  if (skipHoles && !(holeMax >= holeMin)) throw new Error("The largest hole size must be at least the smallest");
  if (!(width > 0)) throw new Error("The chamfer width must be more than 0");
  if (!(tolerance > 0)) throw new Error("The tolerance must be more than 0");
  const info = await openSetup();
  const zAxis = unit(info.geometry.axes.z);
  const bodies = info.setup.bodies || [info.setup.body];
  const excluded = new Set(exclude || (await getExcluded()));
  // The tool the Path op would use, for the check of 3D edges (not pointed: no check).
  let t = null, checkTool = null, check = "on";
  try { t = await pickTool(tool, info); checkPointed(t, width); checkTool = t; }
  catch (e) { check = "off: " + e.message; }
  const found = [], skipped = {}, flagged = [], partial = [];
  const skip = (why) => { skipped[why] = (skipped[why] || 0) + 1; };
  for (const body of bodies) {
    const b = await run("inspect.body", { body, maxFaces: 100000 });
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
      const c = await classifyEdge(body, e, zAxis, minAngle);
      if (!c.ok) {
        skip(c.reason);
        if (c.partial) partial.push({ body, edge: e.key, reason: c.reason });
        continue;
      }
      if (skipModeled && c.angle < MODELED_MAX_ANGLE && faces.some((f) => widths[f.name] < MODELED_MAX_WIDTH)) { skip("already chamfered or rounded on the model"); continue; }
      const item = { body, edge: e.key, kind: c.kind, angle: Math.round(c.angle), length: Math.round(e.length * 100) / 100 };
      if (c.kind === "3d" && checkTool) {
        const g = await cutCheck(body, e.key, c.data, checkTool, width, zAxis);
        const why = verdict(g, width, tolerance);
        item.cutWidth = g.width;
        if (why) {
          skip(REASONS[why]);
          flagged.push({ body, edge: e.key, why, reason: REASONS[why], cutWidth: g.width, at: g.at[why === "uneven" ? "widest" : why] });
          continue;
        }
      }
      found.push(item);
    }
  }
  lastLeftOut = [...flagged, ...partial].map((x) => ({ body: x.body, edge: x.edge }));
  const doc = await docInfo();
  return { setup: info.setup.id, units: doc.units || "mm", tool: t ? toolLabel(t) : null, check, edges: found, skipped, flagged, partial };
}

// Pick a tool: the number or id given, else a chamfer mill / spot drill from the library.
// Tool numbers can repeat in a library, so among several matches it prefers a pointed tool,
// then one this setup already uses, then one with a real (non-zero) number.
const isPointed = (x) => /chamfer|spot|engrave/i.test(x.type || "");
async function pickTool(tool, info) {
  const lib = await run("cam.tools.list", {});
  const tools = lib.tools || [], inSetup = (info && info.tools) || {};
  const best = (list) => list.slice().sort((a, b) =>
    (isPointed(b) - isPointed(a)) || (!!inSetup[b.id] - !!inSetup[a.id]) || ((b.number > 0) - (a.number > 0)))[0];
  if (tool !== undefined && tool !== null && tool !== "") {
    const hits = tools.filter((x) => x.id === tool || String(x.number) === String(tool));
    if (!hits.length) throw new Error(`Tool ${tool} is not in the tool library`);
    return best(hits);
  }
  const hits = tools.filter((x) => /chamfer|spot/i.test(x.type || ""));
  if (!hits.length) throw new Error("No chamfer mill or spot drill in the tool library");
  return best(hits);
}

// Name per shop convention: <setup #>-<2-digit sequence> <label>, e.g. 1-04 Deburr. The
// sequence is one more than the highest already used in the setup.
async function nextName(setupId, label = "Deburr") {
  const all = await run("cam.setups", {});
  const list = all.setups || all;
  const idx = Array.isArray(list) ? list.findIndex((s) => s.id === setupId) : -1;
  const setupNo = idx >= 0 ? idx + 1 : 1;
  const r = await run("cam.op.list", { setup: setupId, compact: true });
  const ops = r.ops || r.operations || (Array.isArray(r) ? r : []);
  let seq = 0;
  for (const o of ops) {
    const m = /^(?:❓\s*)?(\d+)-(\d+)\b/.exec(o.name || "");
    if (m && Number(m[1]) === setupNo) seq = Math.max(seq, Number(m[2]));
  }
  return `${setupNo}-${String((seq || ops.length) + 1).padStart(2, "0")} ${label}`;
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
  width: { type: "number", description: "Chamfer width mm (default 0.25)" },
  tool: { type: ["number", "string"], description: "Library tool number or id (default: a chamfer mill or spot drill, one the setup already uses if it can)" },
  tolerance: { type: "number", description: "Percent the cut width on a wavy or sloped (3D) edge may differ from width before the edge is left out (default 20)" },
};
const findArgs = (a) => ({ minAngle: a.minAngle, exclude: a.exclude, skipHoles: a.skipHoles, holeMin: a.holeMin, holeMax: a.holeMax, skipModeled: a.skipModeled, width: a.width, tool: a.tool, tolerance: a.tolerance });

function checkPasses(passes) {
  if (!(Number.isInteger(passes) && passes >= 1 && passes <= 10)) throw new Error("Passes must be a whole number from 1 to 10");
}

physcad.commands.register({
  id: "findEdges",
  title: "Find deburr edges",
  description: "List (and highlight) the sharp outside edges of the open setup's part that a tool can reach from above. kind level: a flat top over a vertical wall at one height (2D Chamfer). kind 3d: anything else (Path); these are checked with the tool and width given, and left out (listed in flagged, with why and where) when the edge climbs too steeply for the tool, the tool would cut a groove, hit a nearby face or dig into a face beside the edge, or the cut width would vary more than tolerance. cutWidth: the narrowest and widest bevel along the edge, mm. partial: edges skipped because only part of them qualifies.",
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
  id: "showLeftOut",
  title: "Show left-out edges",
  description: "Highlight the edges the last search left out because the tool can't cut them cleanly or only part of them qualifies.",
  async run() {
    if (lastLeftOut.length && (await inCam())) await run("selection.set", { items: lastLeftOut.map((e) => ({ type: "edge", ...e })) });
    return { count: lastLeftOut.length };
  },
});

// A Path toolpath with a pointed tool's tip run along each edge, `width` below it. On a flat
// top over a straight-down wall with a 90° tool that leaves a 45° chamfer `width` wide on each
// face. cutCheck says what it leaves anywhere else.
function checkPointed(t, width) {
  if (!isPointed(t)) throw new Error(`Tool ${t.number} is a ${t.type}: 3D edges need a pointed chamfer mill or spot drill`);
  if ((t.tipDiameter || 0) > 0.05) throw new Error(`Tool ${t.number} has a flat tip; 3D edges need one with a sharp point`);
  const reach = (t.diameter / 2) / Math.tan(((t.tipAngle || 90) / 2) * Math.PI / 180);
  if (width >= reach) throw new Error(`The width is too big for tool ${t.number}'s cone`);
}
async function makePathOp(setupId, edges, t, width, passes) {
  const name = await nextName(setupId, "Deburr 3D");
  const fields = { name, tool: t.id || t.number, geometry: { edges: edges.map((e) => ({ body: e.body, edge: e.edge })) }, heights: { bottomOffset: -width } };
  if (passes > 1) fields.stepdown = width / passes;
  const op = await run("cam.op.trace", { fields });
  return { op, name, edgeCount: edges.length };
}

physcad.commands.register({
  id: "createDeburr",
  title: "Create deburr toolpath",
  description: "Deburr every edge findEdges finds: one 2D Chamfer operation for the level edges and one Path operation for the wavy or sloped (3D) edges that pass its check. width: chamfer width mm (default 0.25). passes: 1-10 (default 1). tool: library tool number or id.",
  params: {
    type: "object",
    properties: { ...FIND_PARAMS, passes: { type: "integer" }, wallClear: { type: "number", description: "Level edges' chamfer op: how close the tool's side may come to a wall it isn't chamfering, mm (default 0: touching it)" } },
    additionalProperties: false,
  },
  async run(a = {}) {
    const { width = DEFAULT_WIDTH, passes = 1, tool, wallClear = 0 } = a;
    if (!(wallClear >= 0)) throw new Error("The wall clearance can't be negative");
    checkPasses(passes);
    const r = await findEdges(findArgs(a));
    if (!r.edges.length) {
      const why = r.flagged.length ? ` ${r.flagged.length} were left out: ${[...new Set(r.flagged.map((f) => f.reason))].join("; ")}.` : "";
      throw new Error("No edges this tool can deburr cleanly." + why);
    }
    const level = r.edges.filter((e) => e.kind === "level"), wavy = r.edges.filter((e) => e.kind === "3d");
    const t = await pickTool(tool, await openSetup());
    if (wavy.length) checkPointed(t, width);
    const ops = [];
    if (level.length) {
      const name = await nextName(r.setup);
      const op = await run("cam.op.chamfer", {
        fields: { name, tool: t.id || t.number, geometry: { edges: level.map((e) => ({ body: e.body, edge: e.edge })) }, chamferWidth: width, chamferPasses: passes, ...(wallClear > 0 ? { chamferWallClear: wallClear } : {}) },
      });
      ops.push({ op, name, edgeCount: level.length });
    }
    if (wavy.length) ops.push(await makePathOp(r.setup, wavy, t, width, passes));
    const names = ops.map((o) => `${o.name} (${o.edgeCount} edges)`).join(" and ");
    const left = r.flagged.length ? ` ${r.flagged.length} edges left out.` : "";
    await physcad.ui.toast(`Made ${names} with ${toolLabel(t)}.${left} Check it in simulation before cutting.`, r.flagged.length ? "info" : "success");
    return { ops, edgeCount: r.edges.length, units: r.units, tool: toolLabel(t), skipped: r.skipped, flagged: r.flagged, partial: r.partial };
  },
});

// Edges the person picks, any shape: one Path operation, after the same checks.
physcad.commands.register({
  id: "deburrSelected",
  title: "Deburr selected edges",
  description: "Add a Path operation that chamfers the edges picked in the view (any shape, wavy in 3D too) with a pointed tool, its tip `width` mm below each edge. Each edge gets the same check as findEdges' 3D edges; the ones that fail are left out and listed in flagged unless keepFlagged. width default 0.25; tolerance percent (default 20); passes 1-10 (default 1); tool: library tool number or id. edges: [{body, edge}] instead of the picks.",
  params: {
    type: "object",
    properties: {
      width: { type: "number" },
      tolerance: { type: "number" },
      passes: { type: "integer" },
      tool: { type: ["number", "string"] },
      edges: { type: "array", items: { type: "object", properties: { body: { type: "string" }, edge: { type: "string" } }, required: ["body", "edge"] } },
      keepFlagged: { type: "boolean", description: "Cut the edges that fail the check too (default false)" },
    },
    additionalProperties: false,
  },
  async run({ width = DEFAULT_WIDTH, tolerance = DEFAULT_TOL, passes = 1, tool, edges, keepFlagged = false } = {}) {
    if (!(width > 0)) throw new Error("The chamfer width must be more than 0");
    if (!(tolerance > 0)) throw new Error("The tolerance must be more than 0");
    checkPasses(passes);
    const info = await openSetup();
    const picks = edges && edges.length ? edges : await selectedEdges();
    if (!picks.length) throw new Error("Pick one or more edges on the part first");
    const t = await pickTool(tool, info);
    checkPointed(t, width);
    const zAxis = unit(info.geometry.axes.z);
    const keep = [], flagged = [];
    const edgesOf = {};
    for (const p of picks) {
      if (!edgesOf[p.body]) {
        const b = await run("inspect.body", { body: p.body, maxFaces: 100000 });
        edgesOf[p.body] = {};
        for (const e of b.edges || []) edgesOf[p.body][e.key] = e;
      }
      const e = edgesOf[p.body][p.edge];
      const flag = (why, reason, extra) => { flagged.push({ ...p, why, reason, ...extra }); if (keepFlagged) keep.push(p); };
      if (!e) { flag("unknown", "not found on the part"); continue; }
      const c = await classifyEdge(p.body, e, zAxis, 0);
      if (!c.ok) { flag("shape", c.reason); continue; }
      const g = await cutCheck(p.body, p.edge, c.data, t, width, zAxis);
      const why = verdict(g, width, tolerance);
      if (why) { flag(why, REASONS[why], { cutWidth: g.width, at: g.at[why === "uneven" ? "widest" : why] }); continue; }
      keep.push({ ...p, cutWidth: g.width });
    }
    lastLeftOut = flagged.map((x) => ({ body: x.body, edge: x.edge }));
    const doc = await docInfo();
    if (!keep.length) {
      throw new Error(`None of the ${picks.length} picked edges can be cut cleanly with ${toolLabel(t)}: ${[...new Set(flagged.map((f) => f.reason))].join("; ")}.`);
    }
    const r = await makePathOp(info.setup.id, keep, t, width, passes);
    const left = flagged.length && !keepFlagged ? ` Left out ${flagged.length}.` : "";
    await physcad.ui.toast(`${r.name}: ${keep.length} edges with ${toolLabel(t)}.${left} Check it in simulation before cutting.`, flagged.length ? "info" : "success");
    return { ...r, units: doc.units || "mm", tool: toolLabel(t), edges: keep, flagged };
  },
});

// Developer check: the depth at each point along an edge for an even bevel (not in the panel).
physcad.commands.register({
  id: "evenDepth",
  title: "Even-width depths",
  description: "For one edge: how deep below the edge the tool tip must go at each point for a bevel exactly `width` wide, and the cut on each face that gives. tooSteep: points where no depth works with this tool.",
  params: { type: "object", properties: { body: { type: "string" }, edge: { type: "string" }, width: { type: "number" }, tool: { type: ["number", "string"] } }, required: ["body", "edge"] },
  async run({ body, edge, width = DEFAULT_WIDTH, tool } = {}) {
    const info = await openSetup();
    const zAxis = unit(info.geometry.axes.z);
    const t = await pickTool(tool, info);
    checkPointed(t, width);
    const b = await run("inspect.body", { body, maxFaces: 100000 });
    const e = (b.edges || []).find((x) => x.key === edge);
    if (!e) throw new Error(`No edge ${edge} on ${body}`);
    const d = await sampleEdge(body, edge, e.faces, e.length);
    const r = evenDepths(d, t, width, zAxis);
    const ok = r.filter((x) => x.depth !== null);
    const r3 = (x) => Math.round(x * 1000) / 1000;
    const range = (xs) => (xs.length ? [r3(Math.min(...xs)), r3(Math.max(...xs))] : null);
    return {
      tool: toolLabel(t), points: r.length, tooSteep: r.length - ok.length,
      depth: range(ok.map((x) => x.depth)),
      cutOnFaceA: range(ok.map((x) => x.legs[0])), cutOnFaceB: range(ok.map((x) => x.legs[1])),
    };
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
