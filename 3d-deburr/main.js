// 3D Deburr (3-axis, version 0.6.6)
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
const r3 = (x) => Math.round(x * 1000) / 1000, r4 = (x) => Math.round(x * 10000) / 10000;

// Every PhysCAD command goes through here, and is timed (findEdges reports the totals).
// PhysCAD's modeling engine now and then stops on a question and restarts itself (nothing is
// lost). A question that only reads the model (inspect.*) is then asked again, after a pause.
let callStats = {}, engineRestarts = 0;
const ENGINE_TRIES = 3, ENGINE_WAIT = 1500;   // ms before asking again (twice that the second time)
const engineStopped = (e) => /engine stopped/i.test(String((e && e.message) || e));
const ENGINE_GAVE_UP = "PhysCAD's modeling engine stopped while working on this and did not recover. Nothing was lost. Try again: edges already checked are not checked again.";
const engineGaveUp = (e) => String((e && e.message) || e) === ENGINE_GAVE_UP;
const pause = (ms) => new Promise((done) => (typeof setTimeout === "function" ? setTimeout(done, ms) : done()));
// One request at a time, even when two commands run at once (the panel's background checks
// while Deburr is working): parallel requests stopped the modeling engine before.
let lane = Promise.resolve();
const run = (name, args) => {
  const next = lane.then(() => runNow(name, args));
  lane = next.catch(() => {});
  return next;
};
const runNow = async (name, args) => {
  const t0 = Date.now();
  try {
    for (let attempt = 1; ; attempt++) {
      try { return await physcad.commands.run(name, args || {}); }
      catch (e) {
        if (!engineStopped(e)) throw e;
        engineRestarts++;
        if (!name.startsWith("inspect.") || attempt >= ENGINE_TRIES) {
          throw new Error(ENGINE_GAVE_UP);
        }
        await pause(ENGINE_WAIT * attempt);
      }
    }
  } finally {
    const s = callStats[name] || (callStats[name] = { calls: 0, points: 0, ms: 0 });
    s.calls++; s.ms += Date.now() - t0;
    if (args && Array.isArray(args.points)) s.points += args.points.length;
  }
};

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

// Points all along an edge, with both faces' outward directions there. The direction each face
// runs away from the edge is added by addInto, only for the edges that need it.
//  dense: the edge every FETCH_STEP, [{ p, t, arc, side }], for tool positions. At a sharp corner
//  inside the edge (the direction turns at once) there are two entries at the corner, one with
//  the direction coming in (side -1) and one with the direction going out (side 1).
//  corners: how far along the edge each of those corners is.
//  pts: the points checked, every SAMPLE_STEP. None sits on a corner, where the faces have no
//  one direction: the points beside a corner are CORNER_SIDE before and after it.
const FETCH_STEP = 0.25;     // mm between the edge points asked of PhysCAD for tool positions
const CORNER_ANGLE = 12;     // degrees the direction must turn between two of those to be a corner
const CORNER_SIDE = 0.5;     // mm from a corner to the points checked beside it
function findCorners(pts, closed, length) {
  const n = pts.length, last = closed ? n : n - 1;
  const turn = (k) => deg(Math.acos(clamp1(dot(pts[k].t, pts[(k + 1) % n].t))));
  const turns = [];
  for (let k = 0; k < last; k++) turns.push(turn(k));
  const corners = [];                                          // [{ k, x, arc }]: between dense k and k + 1
  for (let k = 0; k < last; k++) {
    const before = closed ? turns[(k - 1 + last) % last] : k > 0 ? turns[k - 1] : 0;
    const after = closed ? turns[(k + 1) % last] : k + 1 < last ? turns[k + 1] : 0;
    if (!(turns[k] > CORNER_ANGLE && before < turns[k] / 3 && after < turns[k] / 3)) continue;
    // Where the two straight runs meet.
    const a = pts[k], b = pts[(k + 1) % n], gap = len(sub(b.p, a.p));
    const w = sub(a.p, b.p), c = dot(a.t, b.t), den = 1 - c * c;
    const along = den > 1e-9 ? Math.max(0, Math.min(gap, (c * dot(b.t, w) - dot(a.t, w)) / den)) : gap / 2;
    const arcB = closed && k === n - 1 ? length : b.arc;
    corners.push({ k, x: add(a.p, scale(a.t, along)), arc: Math.min(arcB, a.arc + along) });
  }
  return corners;
}
async function sampleEdge(body, key, faces, length) {
  const [faceA, faceB] = faces;
  const count = Math.max(5, Math.min(MAX_SAMPLES, Math.ceil((length || 0) / SAMPLE_STEP) + 1));
  const ep = await run("inspect.edgePoints", { body, edge: key, count });
  const samples = (ep && ep.points) || [];
  if (samples.length < 2) return null;
  const closed = !!ep.closed, span = closed ? samples.length : samples.length - 1, L = ep.length;
  let at = samples.map((s, i) => ({ p: s.point, t: unit(s.tangent) || [0, 0, 0], arc: (i * L) / span }));

  const fCount = Math.max(2, Math.min(2000, Math.ceil(L / FETCH_STEP) + 1));
  const de = await run("inspect.edgePoints", { body, edge: key, count: fCount });
  const fSpan = closed ? de.points.length : de.points.length - 1;
  const fine = de.points.map((s, i) => ({ p: s.point, t: unit(s.tangent) || [0, 0, 0], arc: (i * L) / fSpan, side: 0 }));
  const found = findCorners(fine, closed, L);
  const dense = [];
  fine.forEach((e, k) => {
    dense.push(e);
    const c = found.find((x) => x.k === k);
    if (!c) return;
    const next = fine[(k + 1) % fine.length];
    if (len(sub(c.x, e.p)) < 1e-4) {                           // the corner is this point
      c.arc = e.arc; e.side = -1;
      dense.push({ p: e.p, t: next.t, arc: e.arc, side: 1 });
    } else if (len(sub(c.x, next.p)) < 1e-4) {                 // the corner is the next point
      c.arc = k === fine.length - 1 ? L : next.arc; next.side = 1;
      dense.push({ p: next.p, t: e.t, arc: c.arc, side: -1 });
    } else dense.push({ p: c.x, t: e.t, arc: c.arc, side: -1 }, { p: c.x, t: next.t, arc: c.arc, side: 1 });
  });
  const corners = found.map((c) => c.arc);
  if (corners.length) {
    // How far apart two places on the edge are, the short way round a closed one.
    const apart = (a, b) => { const x = Math.abs(a - b); return closed ? Math.min(x, L - x) : x; };
    at = at.filter((e) => corners.every((c) => apart(e.arc, c) > CORNER_SIDE * 0.9));
    for (const c of corners) for (const dir of [-1, 1]) {
      let want = c + dir * CORNER_SIDE;
      if (closed) want = ((want % L) + L) % L; else if (want < 0 || want > L) continue;
      let best = null;
      for (const e of fine) if (!best || apart(e.arc, want) < apart(best.arc, want)) best = e;
      if (best && apart(best.arc, c) > FETCH_STEP * 0.9 && !at.some((e) => Math.abs(e.arc - best.arc) < 1e-6)) at.push({ p: best.p, t: best.t, arc: best.arc });
    }
    at.sort((a, b) => a.arc - b.arc);
  }
  if (at.length < 2) return null;
  const pts = at.map((e) => e.p), tangents = at.map((e) => e.t), arc = at.map((e) => e.arc);
  const ra = await run("inspect.surfaceNormals", { body, face: faceA, points: pts });
  const rb = await run("inspect.surfaceNormals", { body, face: faceB, points: pts });
  const nA = ra.points.map((r) => unit(r.normal)), nB = rb.points.map((r) => unit(r.normal));
  return { body, faces, length: L, closed, pts, tangents, nA, nB, intoA: null, intoB: null, arc, dense, corners };
}

// The direction face A or B ("A" | "B") runs away from the edge at each point: square to the
// edge, along the face. Step both ways across the face: the step that stays on it is the one
// into it. A face lies on one side of its edge all the way along, so a few points are tried
// first, and every point only when those disagree.
const INTO_EVERY = 6;
async function addInto(d, which) {
  if (d["into" + which]) return;
  const face = d.faces[which === "A" ? 0 : 1], n = which === "A" ? d.nA : d.nB;
  const across = d.tangents.map((t, i) => (n[i] && unit(cross(t, n[i]))) || [0, 0, 0]);
  const sideAt = async (list) => {
    const probes = [];
    for (const i of list) probes.push(add(d.pts[i], scale(across[i], PROBE)), sub(d.pts[i], scale(across[i], PROBE)));
    const r = await run("inspect.surfaceNormals", { body: d.body, face, points: probes });
    return list.map((_, k) => (r.points[2 * k].distance <= r.points[2 * k + 1].distance ? 1 : -1));
  };
  const all = d.pts.map((_, i) => i);
  const few = all.filter((i) => i % INTO_EVERY === 0 || i === all.length - 1);
  const fewSide = await sideAt(few);
  let side;
  if (fewSide.every((x) => x === fewSide[0])) side = all.map(() => fewSide[0]);
  else side = await sideAt(all);
  d["into" + which] = across.map((a, i) => (side[i] > 0 ? a : scale(a, -1)));
}

// Classify one edge by checking it at points all along its length, on any kind of surface.
// Returns { ok, kind: "level" | "3d", reason, partial, angle, data } (angle: the smallest along
// the edge; partial: only some of the edge fails).
async function classifyEdge(body, edge, zAxis, minAngle) {
  if (!edge.faces || edge.faces.length !== 2) return { ok: false, reason: "not between two faces" };
  const d = await sampleEdge(body, edge.key, edge.faces, edge.length);
  if (!d) return { ok: false, reason: "could not sample the edge" };
  const { pts, nA, nB } = d;
  if (pts.some((_, i) => !nA[i] || !nB[i])) return { ok: false, reason: "face data missing" };

  const angles = pts.map((_, i) => deg(Math.acos(clamp1(dot(nA[i], nB[i])))));
  const minA = Math.min(...angles), smooth = angles.filter((a) => a < minAngle).length;   // too gentle to need a deburr
  let inside = 0, down = 0;
  if (!smooth) {
    await addInto(d, "B");
    for (let i = 0; i < pts.length; i++) {
      if (!(dot(d.intoB[i], nA[i]) < -1e-3)) { inside++; continue; } // B folds up in front of A: inside corner
      const bis = unit(add(nA[i], nB[i]));
      if (!bis || dot(bis, zAxis) < 0.05) down++;              // the corner faces down or sideways
    }
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
  await addInto(d, "A");
  return { ok: true, kind: oneHeight && flatOverWall ? "level" : "3d", angle, data: d };
}

// ---------- the tool, as a shape ----------
const isBall = (x) => /ball/i.test(x.type || "");
// The tool as a shape, up from its tip: the cutting end (a cone or a ball, then its diameter up
// to the end of the flutes), then what must never touch the part: the rest of the body, the
// shank up to the holder, and the holder (PhysCAD gives it as stacked rings).
function toolShape(tool) {
  const R = (tool.diameter || 6) / 2, ball = isBall(tool);
  const tanH = ball ? 1 : Math.tan(((tool.tipAngle || 90) / 2) * Math.PI / 180);
  const coneHeight = ball ? R : R / tanH;
  const cut = Math.max(tool.fluteLength || 0, coneHeight);
  const upper = [];                                            // [{ from, to, r0, r1, part }]
  const ring = (to, r0, r1, part) => {
    const from = upper.length ? upper[upper.length - 1].to : cut;
    if (to > from + 1e-6) upper.push({ from, to, r0, r1, part });
  };
  if (tool.bodyLength > cut) {
    ring(Math.min(tool.bodyLength, Math.max(tool.shoulderLength || 0, cut)), R, R, "shank");
    const rs = (tool.shankDiameter || tool.diameter || 6) / 2;
    ring(tool.bodyLength, rs, rs, "shank");
    let h = tool.bodyLength;
    for (const g of (tool.holder && tool.holder.segments) || []) {
      if (!(g.height > 0)) continue;
      h += g.height;
      ring(h, (g.lower || 0) / 2, (g.upper || 0) / 2, "holder");
    }
  }
  const low = coneHeight + 2 * R;                              // always checked, whatever the tool's lengths
  const top = upper.length ? Math.max(low, upper[upper.length - 1].to) : low;
  // The tool's radius and part at a height above the tip.
  const at = (h) => {
    if (h < cut || !upper.length) return { r: R, part: h < cut ? "cutter" : "shank" };
    for (const g of upper) if (h <= g.to) return { r: g.r0 + ((g.r1 - g.r0) * (h - g.from)) / (g.to - g.from), part: g.part };
    return { r: 0, part: "none" };                             // above the holder
  };
  return { ball, tanH, R, coneHeight, cut, low, top, at, maxR: Math.max(R, ...upper.map((g) => Math.max(g.r0, g.r1))) };
}
const toolLabel = (t) => `T${t.number} ${(t.description || t.type || "").slice(0, 44)}`.trim();

// How far inside the tool a point is (mm): positive inside, negative outside. A pointed tool is
// a cone on its tip, then a cylinder of its diameter above that (measured sideways). A ball end
// mill is a ball, then the cylinder (measured from the ball's centre, below it). Above the
// flutes: the body, shank and holder, each at its own radius.
function margin(q, tip, zAxis, sh) {
  const v = sub(q, tip), h = dot(v, zAxis);
  const r = len(sub(v, scale(zAxis, h)));
  if (h >= sh.cut) return sh.at(h).r - r;
  if (sh.ball) return h < sh.R ? sh.R - Math.sqrt(r * r + (h - sh.R) * (h - sh.R)) : sh.R - r;
  return h <= 0 ? -Math.max(r, -h) : Math.min(h * sh.tanH, sh.R) - r;
}

// Tip offsets (tip position minus edge point) given at d.pts, read anywhere along the edge:
// (arc, the edge's direction there, side) -> offset. Each offset is split into up, across the
// edge and along the edge (the last two level), and put back together with the edge's own
// direction at the point asked for. So an offset that points out from the part keeps pointing
// out from it where the edge turns between two of d.pts. Nothing is blended across a sharp
// corner: up to the corner the offset is the last one before it, and after it the first one
// after it (side says which, for a point on the corner itself).
function offsetAlong(d, off, zAxis) {
  const n = d.pts.length, A = d.arc, L = d.length, corners = d.corners || [];
  const frame = (t) => {
    const along = unit(sub(t, scale(zAxis, dot(t, zAxis))));
    return along ? { along, across: cross(along, zAxis) } : null;      // null: the edge runs straight up
  };
  const parts = off.map((o, i) => {
    const f = frame(d.tangents[i]);
    return f ? [dot(o, zAxis), dot(o, f.across), dot(o, f.along)] : null;
  });
  // The two points checked either side of `arc`, and how far between them it is.
  const locate = (arc) => {
    if (d.closed && (arc < A[0] || arc >= A[n - 1])) {
      const x = arc < A[0] ? arc + L : arc, a0 = A[n - 1], a1 = A[0] + L;
      return { i: n - 1, k: 0, x, a0, a1 };
    }
    if (arc <= A[0]) return { i: 0, k: 0, x: A[0], a0: A[0], a1: A[0] };
    if (arc >= A[n - 1]) return { i: n - 1, k: n - 1, x: A[n - 1], a0: A[n - 1], a1: A[n - 1] };
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (A[mid] <= arc) lo = mid; else hi = mid; }
    return { i: lo, k: hi, x: arc, a0: A[lo], a1: A[hi] };
  };
  return (arc, tangent, side = 0) => {
    const { i, k, x, a0, a1 } = locate(arc);
    let f = a1 > a0 ? Math.max(0, Math.min(1, (x - a0) / (a1 - a0))) : 0;
    for (const c0 of corners) for (const c of d.closed ? [c0, c0 + L] : [c0]) {
      if (!(c > a0 && c < a1)) continue;
      f = x < c - 1e-9 ? 0 : x > c + 1e-9 ? 1 : side > 0 ? 1 : 0;
    }
    const here = tangent && frame(unit(tangent) || [0, 0, 0]);
    if (!here || !parts[i] || !parts[k]) return add(off[i], scale(sub(off[k], off[i]), f));
    const c = [0, 1, 2].map((m) => parts[i][m] + (parts[k][m] - parts[i][m]) * f);
    return add(add(scale(zAxis, c[0]), scale(here.across, c[1])), scale(here.along, c[2]));
  };
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
  shank: "the tool's shank or holder would hit the part",
  digs: "the tool would dig into a steep face beside it",
  uneven: "the cut width would vary more than the tolerance",
  size: "the width is too big for this tool there",
};
const CHECK_SAMPLES = 60;   // most points checked per edge
const HIT_SAMPLES = 40;     // most points per edge checked against nearby faces
const DENSE_STEP = 0.025;   // mm between the tool positions counted along the edge
const STEEP = 0.98;         // of the slope at which the tool's side runs along the edge
const NOTCH_SIN = 0.087;    // both faces facing up by more than this (about 5 degrees): a groove
const NEAR_FACES_MAX = 200;   // most faces asked about per edge

// offsets: where the tip is at each of d.pts, as tip minus edge point (default: `width` straight
// below the edge everywhere, as the Path op on edges cuts today).
async function cutCheck(body, key, d, tool, width, zAxis, offsets) {
  const sh = toolShape(tool), n = d.pts.length;
  const off = offsets || d.pts.map(() => scale(zAxis, -width));
  const offAt = offsetAlong(d, off, zAxis);
  const every = Math.max(1, Math.ceil(n / CHECK_SAMPLES));
  const idx = [];
  for (let i = 0; i < n; i++) if (i % every === 0 || i === n - 1) idx.push(i);

  // Tool tip positions all along the edge, close together: one at each of d.dense, then filled
  // in between in straight pieces (at a sharp corner, the straight move from the tip position
  // before it to the one after it). tipArc: how far along the edge each one is.
  const fetched = d.dense.map((e) => ({ tip: add(e.p, offAt(e.arc, e.t, e.side)), arc: e.arc }));
  if (d.closed) fetched.push({ tip: fetched[0].tip, arc: d.length });
  const tipsAll = [], tipArc = [];
  for (let i = 0; i + 1 < fetched.length; i++) {
    const a = fetched[i], b = fetched[i + 1];
    const m = Math.max(1, Math.round(Math.max(b.arc - a.arc, len(sub(b.tip, a.tip))) / DENSE_STEP));
    for (let k = 0; k < m; k++) { tipsAll.push(add(a.tip, scale(sub(b.tip, a.tip), k / m))); tipArc.push(a.arc + ((b.arc - a.arc) * k) / m); }
  }
  if (!d.closed) { tipsAll.push(fetched[fetched.length - 1].tip); tipArc.push(d.length); }
  const endDir = [d.dense[0].t, d.dense[d.dense.length - 1].t];
  const firstAt = (x) => { let lo = 0, hi = tipArc.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (tipArc[mid] < x) lo = mid + 1; else hi = mid; } return lo; };
  const reachAlong = Math.ceil(sh.R / DENSE_STEP) * DENSE_STEP + DENSE_STEP / 2;
  // The tool positions within the tool's radius of point i, along the edge.
  const tipsNear = (i) => {
    const from = d.arc[i] - reachAlong, to = d.arc[i] + reachAlong, out = [];
    const take = (a, b) => { for (let j = firstAt(a); j < tipArc.length && tipArc[j] <= b; j++) out.push(tipsAll[j]); };
    if (d.closed) {
      if (to - from >= d.length) return tipsAll;
      take(from, to);
      if (from < 0) take(from + d.length, d.length);
      if (to > d.length) take(0, to - d.length);
      return out;
    }
    take(from, to);
    // Past an open edge's end the toolpath carries on (the next edge, or a lead in or out):
    // take it as going straight on.
    for (let x = -DENSE_STEP; x >= from; x -= DENSE_STEP) out.push(add(tipsAll[0], scale(endDir[0], x)));
    for (let x = d.length + DENSE_STEP; x <= to; x += DENSE_STEP) out.push(add(tipsAll[tipsAll.length - 1], scale(endDir[1], x - d.length)));
    return out;
  };
  // margin(), over many tips, without making arrays.
  const deepest = (q, tips) => {
    let best = -Infinity;
    for (const t of tips) {
      const x = q[0] - t[0], y = q[1] - t[1], z = q[2] - t[2];
      const h = x * zAxis[0] + y * zAxis[1] + z * zAxis[2];
      const r2 = Math.max(0, x * x + y * y + z * z - h * h);
      let m;
      if (sh.ball) m = h < sh.R ? sh.R - Math.sqrt(r2 + (h - sh.R) * (h - sh.R)) : sh.R - Math.sqrt(r2);
      else { const r = Math.sqrt(r2); m = h <= 0 ? -Math.max(r, -h) : Math.min(h * sh.tanH, sh.R) - r; }
      if (m > best) best = m;
    }
    return best;
  };

  const reach = Math.max(4 * width, sh.ball ? 2 * sh.R : sh.R * Math.sqrt(1 + 1 / (sh.tanH * sh.tanH)) + width);
  const steps = [];
  for (let k = 1; k <= 16; k++) steps.push((4 * width * k) / 16);
  for (let k = 1; k <= 8; k++) steps.push(4 * width + ((reach - 4 * width) * k) / 8);

  // Out across a face from each point: where does the face leave the tool? The first step past
  // that is found by halving (a face is inside the tool near the edge and outside further out),
  // so each point costs a handful of lookups, not one per step. Most cuts end within 4 widths:
  // that step is tried first.
  const N = steps.length, FIRST = 15;
  const faceCut = async (face, into) => {
    // lo: the furthest step known inside the tool (-1: the edge itself). hi: the nearest step
    // known past it (N: none yet).
    const state = idx.map((i) => {
      const tips = tipsNear(i);
      return { tips, lo: -1, loM: deepest(d.pts[i], tips), loQ: d.pts[i], hi: N, hiM: 0, hiQ: null, hiOff: false };
    });
    const nextStep = (c) => {
      if (c.hi < N) return c.hi - c.lo > 1 ? (c.lo + c.hi) >> 1 : -1;
      if (c.lo < FIRST) return FIRST;
      return c.lo < N - 1 ? N - 1 : -1;                        // inside at the last step: the tool digs in
    };
    for (;;) {
      const asks = [];
      state.forEach((c, j) => { const k = nextStep(c); if (k >= 0) asks.push([j, k]); });
      if (!asks.length) break;
      const r = await normalsOf(body, face, asks.map(([j, k]) => add(d.pts[idx[j]], scale(into[idx[j]], steps[k]))));
      asks.forEach(([j, k], n) => {
        const c = state[j], rp = r.points[n];
        // The step went off the face (a narrow face): the cut runs to its far side.
        const off = rp.distance > 0.01 + 0.2 * steps[k];
        const m = off ? 0 : deepest(rp.point, c.tips);
        if (off || m <= 0) { c.hi = k; c.hiM = m; c.hiQ = rp.point; c.hiOff = off; }
        else { c.lo = k; c.loM = m; c.loQ = rp.point; }
      });
    }
    return state.map((c) => {
      if (c.hi === N) return { leg: Infinity, at: null };
      const s0 = c.lo < 0 ? 0 : steps[c.lo];
      if (c.hiOff) return { leg: s0, at: c.loQ };
      const f = c.loM / Math.max(c.loM - c.hiM, 1e-9);
      return { leg: s0 + (steps[c.hi] - s0) * f, at: add(c.loQ, scale(sub(c.hiQ, c.loQ), f)) };
    });
  };
  const cutA = await faceCut(d.faces[0], d.intoA);
  const cutB = await faceCut(d.faces[1], d.intoB);
  const hits = await nearFaceHits(body, d, idx, sh, off, zAxis);

  const count = { steep: 0, notch: 0, digs: 0 }, at = {};
  const mark = (why, i) => { count[why]++; if (!at[why]) at[why] = d.pts[i]; };
  let lo = Infinity, hi = 0, legLo = Infinity, legHi = 0, atHi = null, atLo = null;
  idx.forEach((i, j) => {
    // A ball cuts the same in every direction: no slope is too steep for it, and it can sit on a ridge.
    if (!sh.ball) {
      const tz = Math.abs(dot(d.tangents[i], zAxis));
      if ((tz / Math.sqrt(Math.max(1e-12, 1 - tz * tz))) * sh.tanH >= STEEP) return mark("steep", i);
      if (Math.min(dot(d.nA[i], zAxis), dot(d.nB[i], zAxis)) > NOTCH_SIN) return mark("notch", i);
    }
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
    at: { steep: pt(at.steep), notch: pt(at.notch), digs: pt(at.digs), hit: hits.length ? hits[0].at : null, shank: (hits.find((h) => h.part !== "cutter") || {}).at || null, widest: pt(atHi), narrowest: pt(atLo) },
  };
}

// Faces near the edge that end up inside the tool, anywhere up its length: the cutting end, the
// shank or the holder. Points up the tool's axis are dropped onto each nearby face; a face point
// inside the tool there is a hit. (At the cutting end the faces are let in as far as the edge
// break goes; nothing may touch the shank or the holder.) Each hit: { face, part, at }.
const UPPER_CLEAR = 0.02;   // mm a face may read inside the shank or holder before it counts
async function nearFaceHits(body, d, idx, sh, off, zAxis) {
  const heights = [0.05, 0.12, 0.25, 0.45, 0.7, 1].map((f) => f * sh.low);
  for (let h = sh.low; ;) {
    h += Math.max(1, Math.min(5, sh.at(h).r));
    if (h >= sh.top) break;
    heights.push(h);
  }
  const stride = Math.max(1, Math.ceil(idx.length / HIT_SAMPLES));
  const at = idx.filter((_, j) => j % stride === 0 || j === idx.length - 1);
  const tips = at.map((i) => add(d.pts[i], off[i]));
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const t of tips) for (const p of [t, add(t, scale(zAxis, sh.top))]) for (let k = 0; k < 3; k++) {
    min[k] = Math.min(min[k], p[k] - sh.maxR - 0.5); max[k] = Math.max(max[k], p[k] + sh.maxR + 0.5);
  }
  let faces;
  try {
    const b = await run("inspect.body", { body, edges: false, maxFaces: 100000, faces: { box: { min, max } } });
    faces = b.faces || [];
  } catch (e) { if (engineGaveUp(e)) throw e; return []; }
  // How far inside the tool the edge itself is: at the cutting end, faces are let in half as much again.
  const allowed = 1.5 * Math.max(...at.map((i, k) => margin(d.pts[i], tips[k], zAxis, sh))) + 0.02, hits = [];
  let asked = 0;
  for (const face of faces) {
    // Only the points of the tool that can reach this face: by its box, along the tool and sideways.
    const bb = face.bbox && face.bbox.min && face.bbox.max ? face.bbox : null;
    let lo = -Infinity, hi = Infinity;
    if (bb) {
      lo = Infinity; hi = -Infinity;
      for (let c = 0; c < 8; c++) {
        const s = dot([c & 1 ? bb.max[0] : bb.min[0], c & 2 ? bb.max[1] : bb.min[1], c & 4 ? bb.max[2] : bb.min[2]], zAxis);
        lo = Math.min(lo, s); hi = Math.max(hi, s);
      }
    }
    const query = [], owner = [];
    tips.forEach((t, k) => {
      for (const h of heights) {
        const p = add(t, scale(zAxis, h));
        if (bb) {
          const s = dot(p, zAxis), r = Math.max(sh.R, sh.at(h).r) + 0.5;
          if (s < lo - 5.5 || s > hi + 5.5) continue;
          if (p.some((x, c) => x < bb.min[c] - r || x > bb.max[c] + r)) continue;
        }
        query.push(p); owner.push(k);
      }
    });
    if (!query.length) continue;
    if (++asked > NEAR_FACES_MAX) break;
    const r = await normalsOf(body, face.name, query);
    for (let j = 0; j < query.length; j++) {
      const q = r.points[j].point, tip = tips[owner[j]];
      const hq = dot(sub(q, tip), zAxis), part = hq < sh.cut ? "cutter" : sh.at(hq).part;
      if (part === "none") continue;
      if (margin(q, tip, zAxis, sh) > (part === "cutter" ? allowed : UPPER_CLEAR)) { hits.push({ face: face.name, part, at: q.map((x) => Math.round(x * 100) / 100) }); break; }
    }
  }
  return hits;
}

// Why a checked 3D edge must be left out, or null when it is fine.
function verdict(g, width, tolerance) {
  if (g.steep) return "steep";
  if (g.notch) return "notch";
  if (g.hits.some((h) => h.part !== "cutter")) return "shank";
  if (g.hits.length) return "hit";
  if (g.digs || !g.width) return "digs";
  const off = Math.max(Math.abs(g.width[0] - width), Math.abs(g.width[1] - width)) / width;
  return off * 100 > tolerance ? "uneven" : null;
}

// ---------- even-width break: where the tip must be ----------
// Where must the tool tip be, at each point of the edge, for a break exactly `width` wide
// (measured as in cutCheck)? Worked out on each face's flat tangent plane with the edge taken as
// straight there, counting the tool at every position along the edge, as cutCheck does.
//  Pointed tool: the tip goes below the edge, deep enough for the width. `flank` (mm) then moves
//  it out from the part and down along the cone's side, so the side does the cutting and not
//  the point, without changing the cut.
//  Ball end mill: the ball's centre sits on the line that splits the corner evenly, close
//  enough to the edge for the width.
// Returns, per point, { offset (tip minus edge point), depth (how far the edge is inside the
// tool's reach), legs (the cut on each face) }; offset null where no position works.
function tipOffsets(d, tool, width, zAxis, flank = 0) {
  const sh = toolShape(tool), t2 = sh.tanH * sh.tanH;
  const horiz = (v) => sub(v, scale(zAxis, dot(v, zAxis)));
  const none = { offset: null, depth: null, legs: null };
  return d.pts.map((_, i) => {
    const t = d.tangents[i], tz = dot(t, zAxis), b = horiz(t);
    const bis = unit(add(d.nA[i], d.nB[i]));
    if (!bis) return none;
    // inside(q, o): is the point q (from the edge point) inside the tool at some position along
    // the edge, with the tip at o? offsetOf(depth): the tip for that depth.
    let inside, offsetOf, maxDepth;
    if (sh.ball) {
      offsetOf = (dep) => sub(scale(bis, sh.R - dep), scale(zAxis, sh.R));
      inside = (q, o) => {
        const w = sub(q, add(o, scale(zAxis, sh.R))), along = dot(w, t);
        return dot(w, w) - along * along < sh.R * sh.R;
      };
      maxDepth = 0.9 * sh.R;
    } else {
      const A2 = tz * tz * t2 - dot(b, b);
      if (A2 >= -1e-9) return none;                            // too steep for this tool
      let out = unit(cross(b, zAxis));
      if (dot(out, bis) < 0) out = scale(out, -1);             // level, square to the edge, away from the part
      offsetOf = (dep) => add(scale(zAxis, -dep - flank / sh.tanH), scale(out, flank));
      inside = (q, o) => {
        const v = sub(q, o), h0 = dot(v, zAxis), a = horiz(v);
        const tau = (tz * t2 * h0 - dot(a, b)) / A2, h = h0 - tau * tz;
        if (h <= 0) return false;
        const side = sub(a, scale(b, tau));
        return h * h * t2 - dot(side, side) > 0;
      };
      maxDepth = 0.9 * sh.coneHeight;
    }
    const legOf = (dir, o) => {
      if (!inside([0, 0, 0], o)) return 0;
      if (inside(scale(dir, 1000), o)) return Infinity;
      let lo = 0, hi = 1000;
      for (let k = 0; k < 60; k++) { const mid = (lo + hi) / 2; if (inside(scale(dir, mid), o)) lo = mid; else hi = mid; }
      return (lo + hi) / 2;
    };
    const cutAt = (dep) => {
      const o = offsetOf(dep), kA = legOf(d.intoA[i], o), kB = legOf(d.intoB[i], o);
      const w = isFinite(kA) && isFinite(kB) ? len(sub(scale(d.intoA[i], kA), scale(d.intoB[i], kB))) / Math.SQRT2 : Infinity;
      return { w, legs: [kA, kB], o };
    };
    if (cutAt(maxDepth).w < width) return none;                // the width is too big for this tool here
    let lo = 0, hi = maxDepth;
    for (let k = 0; k < 50; k++) { const mid = (lo + hi) / 2; if (cutAt(mid).w < width) lo = mid; else hi = mid; }
    const r = cutAt(hi);
    return isFinite(r.w) ? { offset: r.o, depth: hi, legs: r.legs } : none;
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

// The problem edges of the last Preview or Deburr, and what they were found on. They are kept
// only while that still holds: same document, same setup, same part shape, and no new picks.
// Anything else (a setting changed in the panel, Clear picks, a run that failed) forgets them.
let lastRun = null;            // { edges: [{body, edge}], doc, setup, sigs: {body: shape signature} }
const bodySig = (b) => JSON.stringify([b.massProps, b.faces, b.edges]);
async function rememberProblems(edges, setup, sigs) {
  lastRun = { edges: edges.map((x) => ({ body: x.body, edge: x.edge })), doc: await docKey(), setup, sigs };
}
// The last run's problem edges if they still apply, else [] (and they are forgotten). deep also
// checks the part's shape, which asks PhysCAD for each body.
async function problemEdges(deep) {
  if (!lastRun) return [];
  const run0 = lastRun;
  let ok = false;
  try {
    ok = !(await pickedEdges()).length && (await docKey()) === run0.doc;
    if (ok) { const s = await run("cam.setup.get", {}); ok = !!(s && s.setup && s.setup.id === run0.setup); }
    if (ok && deep) {
      for (const [body, sig] of Object.entries(run0.sigs)) {
        if (bodySig(await run("inspect.body", { body, maxFaces: 100000 })) !== sig) { ok = false; break; }
      }
    }
  } catch (_) { ok = false; }
  if (lastRun !== run0) return lastRun ? lastRun.edges : [];   // a new run finished meanwhile
  if (!ok) lastRun = null;
  return ok ? run0.edges : [];
}

// Progress of a long command: PhysCAD's own bar (which has Cancel) and the bar in the panel.
// ctx is what PhysCAD hands a command's run(): { progress(fraction, text), cancelled }.
function progress(ctx, fraction, text) {
  if (ctx && ctx.cancelled) throw new Error("Stopped. Nothing was changed.");
  try { if (ctx && ctx.progress) ctx.progress(fraction, text); } catch (_) { /* progress is optional */ }
  try { Promise.resolve(physcad.ui.sendToPanel("panel", { progress: { fraction, text } })).catch(() => {}); } catch (_) { /* panel closed */ }
}

// What the last search worked out for each edge, kept while the body and the setup's direction
// stay the same, so a second search (or Create right after Find) doesn't ask PhysCAD again.
const edgeCache = {};          // body id -> { sig, classify: Map, cut: Map }
function cacheFor(body, b, zAxis) {
  const sig = JSON.stringify([b.massProps, b.faces, b.edges, zAxis]);
  if (!edgeCache[body] || edgeCache[body].sig !== sig) edgeCache[body] = { sig, classify: new Map(), cut: new Map() };
  return edgeCache[body];
}

// PhysCAD's Path operation cannot follow tool positions the plugin works out: that is asked
// for (an optional `points` field on cam.op.trace). Everything else is built as if it could:
// each 3D edge is checked on the even-width tool positions, and those are what the toolpath is
// to follow. Until PATH_POINTS can be turned on, the toolpath made is a stand-in: the tip runs
// `width` straight below each edge, which cuts an uneven break on wavy or sloped edges.
const PATH_POINTS = false;
const evenPaths = new Map();   // "body/edge" -> { d, offs }: the positions worked out, for the toolpath

// One 3D edge, checked on its even-width tool positions. Returns { g, why }: cutCheck's answer
// (null when no position works somewhere along the edge) and why it must be left out, or null.
async function checkEven(cache, body, key, d, tool, width, tolerance, zAxis) {
  const k = `${key} even ${isBall(tool) ? "ball" : tool.tipAngle || 90} ${tool.diameter || 6} ${width}`;
  let v = cache.cut.get(k);
  if (!v) {
    const r = tipOffsets(d, tool, width, zAxis, 0);
    if (r.every((x) => x.offset)) {
      const offs = r.map((x) => x.offset);
      v = { g: await cutCheck(body, key, d, tool, width, zAxis, offs), offs };
    } else v = { g: null, offs: null, at: d.pts[r.findIndex((x) => !x.offset)].map((x) => Math.round(x * 100) / 100) };
    cache.cut.set(k, v);
  }
  if (!v.g) return { g: null, why: isBall(tool) ? "size" : "steep", at: v.at };
  evenPaths.set(edgeId(body, key), { d, offs: v.offs });
  const why = verdict(v.g, width, tolerance);
  return { g: v.g, why, at: why ? v.g.at[why === "uneven" ? "widest" : why] : null };
}

async function findEdges({ minAngle = DEFAULT_MIN_ANGLE, exclude, skipHoles = false, holeMin = 0, holeMax = 10, skipModeled = true, width = DEFAULT_WIDTH, tool, tolerance = DEFAULT_TOL } = {}, ctx) {
  if (!(minAngle >= 0 && minAngle < 180)) throw new Error("The minimum angle must be between 0 and 180");
  if (skipHoles && holeMax > 0 && !(holeMax >= holeMin)) throw new Error("The largest hole size must be at least the smallest");
  if (!(width > 0)) throw new Error("The chamfer width must be more than 0");
  if (!(tolerance > 0)) throw new Error("The tolerance must be more than 0");
  const started = Date.now();
  callStats = {};
  engineRestarts = 0;
  lastRun = null;
  const info = await openSetup();
  const zAxis = unit(info.geometry.axes.z);
  const bodies = info.setup.bodies || [info.setup.body];
  const excluded = new Set(exclude || (await getExcluded()));
  // The tool the Path op would use, for the check of 3D edges (not pointed: no check).
  let t = null, checkTool = null, check = "on";
  try { t = await pickTool(tool, info); checkPointed(t, width); checkTool = t; }
  catch (e) { check = "off: " + e.message; }
  const found = [], skipped = {}, flagged = [], partial = [], sigs = {};
  let reused = 0;
  const skip = (why) => { skipped[why] = (skipped[why] || 0) + 1; };
  progress(ctx, 0, "Reading the part");
  for (const [bodyNo, body] of bodies.entries()) {
    const b = await run("inspect.body", { body, maxFaces: 100000 });
    sigs[body] = bodySig(b);
    const total = (b.edges || []).length;
    let edgeNo = 0;
    const facesByName = {};
    for (const f of b.faces || []) facesByName[f.name] = f;
    const widths = faceWidths(b);
    const cache = cacheFor(body, b, zAxis);
    for (const e of b.edges || []) {
      progress(ctx, (bodyNo + edgeNo / Math.max(1, total)) / bodies.length, `Checking edge ${edgeNo + 1} of ${total}`);
      edgeNo++;
      if (excluded.has(e.key) || excluded.has(edgeId(body, e.key))) { skip("excluded by you"); continue; }
      const faces = (e.faces || []).map((n) => facesByName[n]).filter(Boolean);
      if (skipHoles) {
        const hole = faces.find((f) => f.surface === "cylinder" && f.internal);
        if (hole && 2 * hole.radius >= holeMin && (!(holeMax > 0) || 2 * hole.radius <= holeMax)) { skip("hole in the skipped size range"); continue; }
      }
      const cKey = `${e.key} ${minAngle}`;
      let c = cache.classify.get(cKey);
      if (c) reused++; else { c = await classifyEdge(body, e, zAxis, minAngle); cache.classify.set(cKey, c); }
      if (!c.ok) {
        skip(c.reason);
        if (c.partial) partial.push({ body, edge: e.key, reason: c.reason });
        continue;
      }
      if (skipModeled && c.angle < MODELED_MAX_ANGLE && faces.some((f) => widths[f.name] < MODELED_MAX_WIDTH)) { skip("already chamfered or rounded on the model"); continue; }
      const item = { body, edge: e.key, kind: c.kind, angle: Math.round(c.angle), length: Math.round(e.length * 100) / 100 };
      if (c.kind === "3d" && checkTool) {
        const v = await checkEven(cache, body, e.key, c.data, checkTool, width, tolerance, zAxis);
        item.cutWidth = v.g && v.g.width;
        if (v.why) {
          skip(REASONS[v.why]);
          flagged.push({ body, edge: e.key, why: v.why, reason: REASONS[v.why], cutWidth: item.cutWidth, at: v.at });
          continue;
        }
      }
      found.push(item);
    }
  }
  await rememberProblems([...flagged, ...partial], info.setup.id, sigs);
  const doc = await docInfo();
  return { setup: info.setup.id, units: doc.units || "mm", width, tool: t ? toolLabel(t) : null, check, standIn: !PATH_POINTS, edges: found, skipped, flagged, partial, timing: { ms: Date.now() - started, reused, engineRestarts, commands: callStats } };
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

// Edges end up selected in the view that the person did not pick to deburr: the ones Preview or
// Show left out highlights, and the ones a toolpath was just made on. Those must not count as
// picks, or Deburr picked edges would make a second toolpath on them. quietKey is that
// selection; it stops applying as soon as the person changes what is selected.
let quietKey = null;
async function quietSelection() {
  try { quietKey = sameKey(await selectedEdges()); } catch (_) { quietKey = null; }
}
async function pickedEdges() {
  const s = await selectedEdges();
  return s.length && sameKey(s) === quietKey ? [] : s;
}

// ---------- commands ----------
const FIND_PARAMS = {
  minAngle: { type: "number", description: "Degrees between the two faces' directions below which an edge counts as smooth (default 30)" },
  exclude: { type: "array", items: { type: "string" }, description: "Edge keys to leave out (default: the ones excluded in the panel for this document)" },
  skipHoles: { type: "boolean", description: "Leave out round holes whose diameter is between holeMin and holeMax" },
  holeMin: { type: "number", description: "mm, default 0" },
  holeMax: { type: "number", description: "mm, default 10; 0: no upper limit" },
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
  description: "List (and highlight) the sharp outside edges of the open setup's part that a tool can reach from above. kind level: a flat top over a vertical wall at one height (2D Chamfer). kind 3d: anything else (Path); these are checked on the even-width tool positions with the tool and width given, and left out (listed in flagged, with why and where) when the edge climbs too steeply for the tool, the tool would cut a groove, hit a nearby face with its cutting end, shank or holder, or dig into a face beside the edge, or the cut width would still vary more than tolerance. cutWidth: the narrowest and widest break those positions cut, mm. standIn true: PhysCAD cannot follow those positions yet, so the toolpath made runs at one depth and cuts an uneven break on 3D edges. partial: edges skipped because only part of them qualifies.",
  params: { type: "object", properties: { ...FIND_PARAMS, highlight: { type: "boolean" } }, additionalProperties: false },
  async run(a = {}, ctx) {
    const r = await findEdges(findArgs(a), ctx);
    r.inCam = await inCam();
    // Outside CAM, selecting edges pops up PhysCAD's Edge card, so only highlight in CAM.
    if (a.highlight !== false && r.inCam) {
      try { await run("selection.set", { items: r.edges.map((e) => ({ type: "edge", body: e.body, edge: e.edge })) }); } catch (_) { /* highlighting is optional */ }
      await quietSelection();
    }
    return r;
  },
});

physcad.commands.register({
  id: "showLeftOut",
  title: "Show left-out edges",
  description: "Highlight the edges the last Preview or Deburr had a problem with (the tool can't cut them cleanly, or only part of them qualifies). Nothing when the part, setup, document or picks have changed since.",
  async run() {
    const edges = await problemEdges(true);
    if (edges.length && (await inCam())) { await run("selection.set", { items: edges.map((e) => ({ type: "edge", ...e })) }); await quietSelection(); }
    return { count: edges.length };
  },
});

physcad.commands.register({
  id: "problemCount",
  title: "Count problem edges",
  description: "How many problem edges the last Preview or Deburr found, if that result still applies (same document, setup and picks; deep: true also checks the part's shape). 0 otherwise.",
  params: { type: "object", properties: { deep: { type: "boolean" } } },
  async run({ deep } = {}) { return { count: (await problemEdges(!!deep)).length }; },
});

physcad.commands.register({
  id: "forgetProblems",
  title: "Forget problem edges",
  description: "Forget the last run's problem edges (a setting changed, so they may no longer be right).",
  async run() { lastRun = null; return { count: 0 }; },
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
// The tool positions for one edge, in the shape asked of PhysCAD: { closed, tip: [[x,y,z], ...] }.
function chainOf(d, offs, zAxis) {
  const offAt = offsetAlong(d, offs, zAxis);
  return { closed: d.closed, tip: d.dense.map((e) => add(e.p, offAt(e.arc, e.t, e.side)).map(r4)) };
}
async function makePathOp(setupId, edges, t, width, passes, zAxis) {
  const name = await nextName(setupId, "Deburr 3D");
  const fields = { name, tool: t.id || t.number };
  const paths = edges.map((e) => evenPaths.get(edgeId(e.body, e.edge)));
  if (PATH_POINTS && paths.every(Boolean)) fields.points = paths.map((x) => chainOf(x.d, x.offs, zAxis));
  else { fields.geometry = { edges: edges.map((e) => ({ body: e.body, edge: e.edge })) }; fields.heights = { bottomOffset: -width }; }
  if (passes > 1) fields.stepdown = width / passes;
  const op = await run("cam.op.trace", { fields });
  return { op, name, edgeCount: edges.length };
}

// Make the deburr toolpaths: on the edges picked in the view when there are any (or `edges`),
// else on every edge findEdges finds. Level edges get one 2D Chamfer operation, the rest one
// Path operation. Picked edges are all cut, whatever their check says: picking an edge is the
// person saying "this one". The ones with a problem are listed in flagged.
async function deburr(a, ctx, mustPick) {
  const { width = DEFAULT_WIDTH, tolerance = DEFAULT_TOL, passes = 1, tool, wallClear = 0 } = a;
  if (!(width > 0)) throw new Error("The chamfer width must be more than 0");
  if (!(tolerance > 0)) throw new Error("The tolerance must be more than 0");
  if (!(wallClear >= 0)) throw new Error("The wall clearance can't be negative");
  checkPasses(passes);
  lastRun = null;
  const info = await openSetup();
  const zAxis = unit(info.geometry.axes.z);
  const picks = a.edges && a.edges.length ? a.edges : await pickedEdges();
  if (mustPick && !picks.length) throw new Error("Pick one or more edges on the part first");
  let edges, flagged, skipped = {}, partial = [];
  if (picks.length) {
    const t0 = await pickTool(tool, info);
    edges = []; flagged = [];
    const bodies = {}, sigs = {};
    for (const [pickNo, p] of picks.entries()) {
      progress(ctx, pickNo / picks.length, `Checking edge ${pickNo + 1} of ${picks.length}`);
      if (!bodies[p.body]) {
        const b = await run("inspect.body", { body: p.body, maxFaces: 100000 });
        sigs[p.body] = bodySig(b);
        bodies[p.body] = { cache: cacheFor(p.body, b, zAxis), edges: {} };
        for (const e of b.edges || []) bodies[p.body].edges[e.key] = e;
      }
      const { cache, edges: byKey } = bodies[p.body], e = byKey[p.edge];
      if (!e) { flagged.push({ ...p, why: "unknown", reason: "not found on the part (not cut)" }); continue; }
      let c = cache.classify.get(`${e.key} 0`);
      if (!c) { c = await classifyEdge(p.body, e, zAxis, 0); cache.classify.set(`${e.key} 0`, c); }
      const item = { ...p, kind: c.ok ? c.kind : "3d" };
      if (!c.ok) flagged.push({ ...p, why: "shape", reason: c.reason });
      else if (c.kind === "3d" && isPointed(t0)) {
        const v = await checkEven(cache, p.body, e.key, c.data, t0, width, tolerance, zAxis);
        item.cutWidth = v.g && v.g.width;
        if (v.why) flagged.push({ ...p, why: v.why, reason: REASONS[v.why], cutWidth: item.cutWidth, at: v.at });
      }
      edges.push(item);
    }
    if (!edges.length) throw new Error("None of the picked edges are on the part.");
  } else {
    const r = await findEdges(findArgs(a), ctx);
    ({ edges, flagged, skipped, partial } = r);
    if (!edges.length) {
      const why = flagged.length ? ` ${flagged.length} were left out: ${[...new Set(flagged.map((f) => f.reason))].join("; ")}.` : "";
      throw new Error("No edges this tool can deburr cleanly." + why);
    }
  }
  progress(ctx, 1, "Making the toolpath");
  const level = edges.filter((e) => e.kind === "level"), wavy = edges.filter((e) => e.kind !== "level");
  const t = await pickTool(tool, info);
  if (wavy.length) checkPointed(t, width);
  const ops = [];
  // Remember each toolpath the moment it exists, so Remove last deburr can take it away even if
  // a later step fails.
  lastMade = { setup: info.setup.id, ops: [] };
  const made = (o) => { ops.push(o); lastMade.ops.push({ id: opIdOf(o.op), name: o.name }); };
  if (level.length) {
    const name = await nextName(info.setup.id);
    const op = await run("cam.op.chamfer", {
      fields: { name, tool: t.id || t.number, geometry: { edges: level.map((e) => ({ body: e.body, edge: e.edge })) }, chamferWidth: width, chamferPasses: passes, ...(wallClear > 0 ? { chamferWallClear: wallClear } : {}) },
    });
    made({ op, name, edgeCount: level.length });
  }
  if (wavy.length) made(await makePathOp(info.setup.id, wavy, t, width, passes, zAxis));
  // The toolpaths exist now. Nothing after this may turn the run into an error.
  const standIn = !PATH_POINTS && wavy.length > 0;
  try {
    await quietSelection();
    // Picked edges: remembered only now, with the picks turned into a highlight, so they count.
    if (picks.length) await rememberProblems(flagged, info.setup.id, sigs);
    const names = ops.map((o) => `${o.name} (${o.edgeCount} edges)`).join(" and ");
    const left = !flagged.length ? "" : picks.length ? ` ${flagged.length} picked edges have a problem.` : ` ${flagged.length} edges left out.`;
    const rough = standIn ? " Wavy edges are cut at one depth for now, so their break is uneven." : "";
    await physcad.ui.toast(`Made ${names} with ${toolLabel(t)}.${rough}${left} Check it in simulation before cutting.`, flagged.length || standIn ? "info" : "success");
  } catch (_) { /* the message is optional; the toolpaths are made */ }
  const doc = await docInfo();
  return { ops, mode: picks.length ? "picked" : "all", standIn, edgeCount: edges.length, edges, units: doc.units || "mm", width, tool: toolLabel(t), skipped, flagged, partial };
}
const PICK_PARAM = { type: "array", items: { type: "object", properties: { body: { type: "string" }, edge: { type: "string" } }, required: ["body", "edge"] }, description: "Deburr these edges, [{body, edge}], in place of the ones picked in the view" };
const MAKE_PARAMS = { passes: { type: "integer" }, wallClear: { type: "number", description: "Level edges' chamfer op: how close the tool's side may come to a wall it isn't chamfering, mm (default 0: touching it)" }, edges: PICK_PARAM };

physcad.commands.register({
  id: "createDeburr",
  title: "Create deburr toolpath",
  description: "Make the deburr toolpaths: on the edges picked in the view when there are any (every picked edge is cut, and the ones with a problem are listed in flagged), else on every edge findEdges finds. One 2D Chamfer operation for the level edges and one Path operation for the wavy or sloped (3D) ones. standIn true: the Path operation runs at one depth for now and cuts an uneven break (see findEdges). width: chamfer width mm (default 0.25). passes: 1-10 (default 1). tool: library tool number or id.",
  params: { type: "object", properties: { ...FIND_PARAMS, ...MAKE_PARAMS }, additionalProperties: false },
  async run(a = {}, ctx) { return deburr(a, ctx, false); },
});

physcad.commands.register({
  id: "deburrSelected",
  title: "Deburr picked edges",
  description: "createDeburr on the edges picked in the view (or `edges`) only: an error when none are picked.",
  params: { type: "object", properties: { width: FIND_PARAMS.width, tolerance: FIND_PARAMS.tolerance, tool: FIND_PARAMS.tool, ...MAKE_PARAMS }, additionalProperties: false },
  async run(a = {}, ctx) { return deburr(a, ctx, true); },
});

// Developer checks (not in the panel): where the tip must be along an edge for an even break.
function checkTipTool(t, width) {
  if (!isBall(t)) return checkPointed(t, width);
  if (width >= t.diameter / 2) throw new Error(`The width is too big for tool ${t.number}'s ball`);
}
async function solveEdge({ body, edge, width = DEFAULT_WIDTH, tool, flank = 0 }) {
  if (!(width > 0)) throw new Error("The width must be more than 0");
  if (!(flank >= 0)) throw new Error("The flank shift can't be negative");
  const info = await openSetup();
  const zAxis = unit(info.geometry.axes.z);
  const t = await pickTool(tool, info);
  checkTipTool(t, width);
  const b = await run("inspect.body", { body, maxFaces: 100000 });
  const e = (b.edges || []).find((x) => x.key === edge);
  if (!e) throw new Error(`No edge ${edge} on ${body}`);
  const d = await sampleEdge(body, edge, e.faces, e.length);
  if (!d) throw new Error("Could not sample the edge");
  await addInto(d, "A");
  await addInto(d, "B");
  const r = tipOffsets(d, t, width, zAxis, isBall(t) ? 0 : flank);
  return { t, d, r, zAxis, solved: r.every((x) => x.offset) };
}
const TIP_PARAMS = {
  body: { type: "string" }, edge: { type: "string" }, width: { type: "number" },
  tool: { type: ["number", "string"], description: "Library tool number or id: a pointed chamfer mill or spot drill, or a ball end mill" },
  flank: { type: "number", description: "Pointed tools: mm to move the tip out from the part and down along the cone's side, so the side cuts and not the point (default 0)" },
};

physcad.commands.register({
  id: "evenDepth",
  title: "Even-width depths",
  description: "For one edge: where the tool tip must be at each point for a break exactly `width` wide, and the cut on each face that gives. depth: how far the edge is inside the tool. tooSteep: points where no position works with this tool.",
  params: { type: "object", properties: { ...TIP_PARAMS, points: { type: "boolean", description: "Also return the tip positions (world mm) and the break those positions would cut" } }, required: ["body", "edge"] },
  async run(a = {}) {
    const { t, d, r, zAxis, solved } = await solveEdge(a);
    const ok = r.filter((x) => x.offset);
    const range = (xs) => (xs.length ? [r3(Math.min(...xs)), r3(Math.max(...xs))] : null);
    const out = {
      tool: toolLabel(t), points: r.length, tooSteep: r.length - ok.length,
      depth: range(ok.map((x) => x.depth)),
      cutOnFaceA: range(ok.map((x) => x.legs[0])), cutOnFaceB: range(ok.map((x) => x.legs[1])),
    };
    if (a.points && solved) {
      const offs = r.map((x) => x.offset);
      const g = await cutCheck(a.body, a.edge, d, t, a.width || DEFAULT_WIDTH, zAxis, offs);
      out.closed = d.closed;
      out.wouldCut = { width: g.width, legs: g.legs, steep: g.steep, notch: g.notch, digs: g.digs, hits: g.hits.length };
      out.tips = d.pts.map((p, i) => add(p, offs[i]).map(r4));
    }
    return out;
  },
});

// The tool path for an even break on one edge, in the shape asked of PhysCAD for cam.op.trace's
// `points`: chains of tool tip positions in world mm. Nothing can follow it yet.
const PATH_STEP = 0.25;       // mm between the tip positions given
physcad.commands.register({
  id: "tipPath",
  title: "Even-width tool path",
  description: "For one edge: the tool tip positions (world mm, `step` mm apart) that would cut a break exactly `width` wide, with a pointed tool or a ball end mill, and the check of what they would cut (wouldCut: width range, and steep, notch, digs and hit counts). chains: [{closed, tip: [[x,y,z], ...]}]. No toolpath is made: PhysCAD's Path operation cannot follow these yet.",
  params: { type: "object", properties: { ...TIP_PARAMS, step: { type: "number", description: "mm between the positions given (default 0.25)" }, tips: { type: "boolean", description: "false: leave the positions out, give only the check (default true)" } }, required: ["body", "edge"] },
  async run(a = {}) {
    const step = a.step || PATH_STEP;
    if (!(step > 0)) throw new Error("The step must be more than 0");
    const width = a.width || DEFAULT_WIDTH;
    const { t, d, r, zAxis, solved } = await solveEdge(a);
    const out = { tool: toolLabel(t), ball: isBall(t), width, flank: isBall(t) ? 0 : a.flank || 0, solved, unsolved: r.filter((x) => !x.offset).length };
    if (!solved) return out;
    const offs = r.map((x) => x.offset);
    const g = await cutCheck(a.body, a.edge, d, t, width, zAxis, offs);
    out.wouldCut = { width: g.width, legs: g.legs, steep: g.steep, notch: g.notch, digs: g.digs, hits: g.hits.length, widestAt: g.at.widest, narrowestAt: g.at.narrowest };
    // One position at each of d.dense (thinned to `step`), keeping both positions at a sharp corner.
    const every = Math.max(1, Math.round(step / FETCH_STEP)), offAt = offsetAlong(d, offs, zAxis);
    const tip = d.dense.filter((e, i) => i % every === 0 || e.side !== 0 || i === d.dense.length - 1)
      .map((e) => add(e.p, offAt(e.arc, e.t, e.side)).map(r4));
    out.corners = d.corners.map(r3);
    out.chains = [{ closed: d.closed, points: tip.length, ...(a.tips === false ? {} : { tip }) }];
    return out;
  },
});

physcad.commands.register({
  id: "selectedCount",
  title: "Count picked edges",
  description: "How many edges the person has picked in the view to deburr. Edges the plugin highlighted, or just made a toolpath on, do not count.",
  async run() { return { count: (await pickedEdges()).length }; },
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
  async run() { await setExcluded([]); lastRun = null; return { excluded: 0 }; },
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
    if (clear) { picked = []; lastRun = null; await showPicked(); }
    if (typeof on === "boolean") {
      pickOn = on;
      if (on && !clear) picked = await selectedEdges();
    }
    return { on: pickOn, count: picked.length };
  },
});

// ---- Remove last deburr: delete the toolpaths the last Deburr made, by id, and start over ----
let lastMade = null;      // { setup, ops: [{id, name}] }
const opIdOf = (r) => r && (r.id || (typeof r.op === "string" ? r.op : r.op && r.op.id) || (r.operation && r.operation.id)) || null;   // cam.op.* returns { op: "<id>" }
// The last Deburr's toolpaths that are still in their setup (found by id, or by name if no id).
async function lastMadeOps() {
  if (!lastMade) return [];
  const made = lastMade;
  let ops = [];
  try {
    const r = await run("cam.op.list", { setup: made.setup, compact: true });
    ops = r.ops || r.operations || (Array.isArray(r) ? r : []);
  } catch (_) { ops = []; }
  const left = made.ops.map((m) => ops.find((o) => (m.id && o.id === m.id) || (!m.id && o.name === m.name))).filter(Boolean);
  if (!left.length && lastMade === made) lastMade = null;
  return left;
}
physcad.commands.register({
  id: "lastDeburr",
  title: "Last deburr toolpaths",
  description: "The toolpaths the last Deburr made that are still in their setup (names), for Remove last deburr.",
  async run() { return { ops: (await lastMadeOps()).map((o) => o.name) }; },
});
physcad.commands.register({
  id: "removeLastDeburr",
  title: "Remove last deburr",
  description: "Delete the toolpaths the last Deburr made (only those), clear the picked edges and forget the problem edges, so edge picking starts over.",
  async run() {
    const left = await lastMadeOps();
    if (!left.length) throw new Error("There is no deburr toolpath to remove.");
    await run("cam.op.remove", { ops: left.map((o) => o.id) });
    lastMade = null;
    lastRun = null;
    picked = [];
    try { await run("selection.set", { items: [] }); } catch (_) { /* view may be busy */ }
    quietKey = null;
    return { removed: left.map((o) => o.name) };
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
