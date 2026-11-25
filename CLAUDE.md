# PhysCAD Plugins — status

One folder per plugin. Plugins run in PhysCAD's plugin sandbox: one main file, no imports, lengths in mm, angles in degrees.

## 3d-deburr — v0.6.4

Goal: a clean, consistent edge break on every sharp outside edge of a 3D part. A break whose width varies along the edge is not acceptable.

- Auto-finds sharp, outside, top-reachable edges on any surface type by sampling each edge (`inspect.edgePoints`) and reading face normals (`inspect.surfaceNormals`).
- Level edges (one height AND a flat top over a vertical wall) → one 2D Chamfer op (`<setup#>-<NN> Deburr`). Everything else is a 3D edge → one Path op (`cam.op.trace`, `<setup#>-<NN> Deburr 3D`), tip straight below the edge at one depth.
- `cutCheck` checks every 3D edge first and leaves it out when: steep (climbs as steeply as the cone's side), notch (both faces face up, tip buried), hit (another face inside the tool), or digs. It counts the tool at every position along the edge.
- Uneven edges (width off by more than Tolerance %, default 20) are KEPT and cut while we wait on PhysCAD (Chris, 2026-11-25): marked `uneven: true`, widths shown in the panel. The panel's Uneven edges checkbox (`keepUneven`, default on) turns that off. Remove or default it off once even-width paths work.
- Picked edges → Path op (`deburrSelected`). Every picked edge is cut, gouging or not, while we wait on PhysCAD (Chris, 2026-11-25); the checks only list the ones with a problem (`keepFlagged`, default true). Auto Find/Create still leave out steep, notch, hit and digs edges. Pick mode, hole skipping, exclusions, passes, skip modeled chamfers, wall clearance, Show left out.
- Wavy test part, 0.25 mm, T5 1/4" 90° chamfer mill: only the hole rim is even; the other five top edges are 0.21–0.65 mm (kept as uneven).

### Blocked on PhysCAD
A Path op can't follow a path the plugin computes (one depth only, tip on the edge). Workaround tried 2026-11-24: a flat sketch spline the Path op follows works only for an edge lying in a flat plane; 3D splines (`spline3d.create`) are not accepted by `cam.op.trace`, and the steep pocket rim also needs a sideways shift. Decision: wait for PhysCAD, do not build the workaround. Requested: an optional `points` field on `cam.op.trace` (chains of 3D tip positions), plus `source` edges and an `allowedCut` for the edge-gouge warning. `evenDepths()` already computes the depth per point. When it lands: build the tip path (depth, then a sideways shift so the flank cuts, not the tip), add ball end mills, partial edges.

### Next (not blocked)
1. Speed (done in 0.6.3): Find edges takes ~3.4 s on the wavy test part, ~0.03 s when repeated (was ~7 s on PhysCAD 0.9.20, ~48 s before). `cutCheck` finds each cut's end by halving, face sides are probed at a few points, results are cached per edge until the body or setup direction changes. `findEdges` returns `timing`. What is left is mostly `nearFaceHits`.
2. Test on a real part: Create deburr from the panel, Show left out, the level-edge rule.
3. Holder and shank check.
4. Waiting on PhysCAD: a `workspace` option for toolbar buttons / a `workspaceChanged` event (would replace the 2 s `cam.setups` polling in panel.js).

### Rules
- The repo is public and MIT licensed (`LICENSE`, copyright Music City Mfg). PhysCAD's developer has been told he may build this into PhysCAD.
- Use the word "CAM", not "Manufacture", in UI text.
- Op names follow `<setup#>-<two-digit sequence> <label>`.
- Keep PhysCAD requests small: at most 1,500 points per `inspect.surfaceNormals` call, one request at a time. Larger, parallel requests stopped the modeling engine once.
