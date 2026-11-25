# PhysCAD Plugins — status

One folder per plugin. Plugins run in PhysCAD's plugin sandbox: one main file, no imports, lengths in mm, angles in degrees.

## 3d-deburr — v0.6.6

Goal: a clean, consistent edge break on every sharp outside edge of a 3D part. A break whose width varies along the edge is not acceptable.

- Auto-finds sharp, outside, top-reachable edges on any surface type by sampling each edge (`inspect.edgePoints`) and reading face normals (`inspect.surfaceNormals`).
- Level edges (one height AND a flat top over a vertical wall) → one 2D Chamfer op (`<setup#>-<NN> Deburr`). Everything else is a 3D edge → one Path op (`cam.op.trace`, `<setup#>-<NN> Deburr 3D`).
- Direction (Chris, 2026-11-25): build it as if PhysCAD already had the `points` field, so it is production ready the day that lands. The plugin is not released until then. Every 3D edge is checked on its even-width tool positions (`checkEven` = `tipOffsets` + `cutCheck`), not on today's fixed depth. The toolpath made today is a stand-in: tip `width` straight below the edge, uneven break and gouging accepted. `PATH_POINTS` in main.js is the one switch: true passes `points` chains (`chainOf`) to `cam.op.trace`.
- A 3D edge is left out when, on the even-width positions, it is: steep (no position works for the cone), notch (both faces face up), hit (a face inside the cutting end), shank (a face inside the body, shank or holder), digs, or still uneven (off by more than Tolerance %, default 20).
- One action (`deburr()`, command `createDeburr`): with edges picked in the view it deburrs exactly those, all of them, and lists the ones with a problem; with none picked it finds every edge itself. `deburrSelected` is the same but errors with no picks. The panel has one button whose label says which ("Deburr all edges" / "Deburr N picked edges"), Preview (`findEdges`, off while edges are picked) and Show problem edges (`showLeftOut`; on only while the last run's problem edges still apply). main.js owns that record (`lastRun`, `problemEdges`, commands `problemCount` / `forgetProblems`); it is forgotten when the document, setup, part shape or picks change, a setting is edited, Clear picks or Clear excluded is pressed, or a new run starts. The panel's 2 s poll does the part-shape check. Remove last deburr (`removeLastDeburr`, `lastDeburr`): deletes only the toolpaths the last Deburr made (by op id, `lastMade`), clears picks and problem edges; on only while those toolpaths still exist. Tested live 2026-11-25. Deburr made a toolpath and still reported "PhysCAD couldn't finish… Part of it may have gone through" once (19:24:56, ~10 s after three quick plugin saves; not reproduced). Cause not found. Fixed around it: main.js's `run` now sends one PhysCAD request at a time across all commands (the panel's background checks included), each toolpath goes into `lastMade` as soon as it exists, and nothing after the toolpaths are made can turn the run into an error.
- Edges the plugin highlighted or just made a toolpath on do not count as picked (`quietKey`), so the button cannot make a duplicate.
- Pick mode, hole skipping (Hole max 0 = any size), exclusions, passes, skip modeled chamfers, wall clearance, progress bar (PhysCAD's `ctx.progress` plus `sendToPanel` → `physcad.onMessage` in the panel).
- Wavy test part, 0.25 mm, T1 3/8" 90° chamfer mill: all six top edges pass on the even-width positions, 0.242–0.261 mm. The stand-in toolpath cuts them 0.21–0.65 mm.

### Blocked on PhysCAD
A Path op can't follow a path the plugin computes (one depth only, tip on the edge). Workaround tried 2026-11-24: a flat sketch spline the Path op follows works only for an edge lying in a flat plane; 3D splines (`spline3d.create`) are not accepted by `cam.op.trace`, and the steep pocket rim also needs a sideways shift. Decision: wait for PhysCAD, do not build the workaround. Requested: an optional `points` field on `cam.op.trace` (chains of 3D tip positions), plus `source` edges and an `allowedCut` for the edge-gouge warning. `evenDepths()` already computes the depth per point. When it lands: build the tip path (depth, then a sideways shift so the flank cuts, not the tip), add ball end mills, partial edges.

### Next (not blocked)
0. Chris has not yet confirmed on screen (as of 2026-11-25): the panel layout (fields two per row, checkbox row), the progress bar, the one-button flow, Show problem edges, Remove last deburr, the equal-width buttons. All of it is in 0.6.6.
1. Speed (done in 0.6.3): Find edges takes ~3.4 s on the wavy test part, ~0.03 s when repeated (was ~7 s on PhysCAD 0.9.20, ~48 s before). `cutCheck` finds each cut's end by halving, face sides are probed at a few points, results are cached per edge until the body or setup direction changes. `findEdges` returns `timing`. What is left is mostly `nearFaceHits`.
2. Test on a real part: Create deburr from the panel, Show left out, the level-edge rule.
3. Holder and shank check (done in 0.6.6): `toolShape` builds the tool's full profile (flutes, body, shank to `bodyLength`, then `holder.segments`), and `nearFaceHits` checks all of it, pruned by each face's box. A hit above the flutes is reason `shank`. Unit-tested on the profile; no real part has triggered it yet.
4. Waiting on PhysCAD: a `workspace` option for toolbar buttons / a `workspaceChanged` event (would replace the 2 s `cam.setups` polling in panel.js).

### Built ahead of PhysCAD's `points` field (0.6.6; `PATH_POINTS` is false until PhysCAD has the field)
- `tipOffsets(d, tool, width, zAxis, flank)`: the tip position at each edge point for an even break. Pointed tool (depth, plus `flank` mm out and down along the cone's side) or ball end mill (centre on the corner's bisector). Replaces `evenDepths`.
- `cutCheck` takes those offsets (was depths) and knows the ball shape (`toolShape().ball`, `margin`). `offsetAlong` rebuilds each offset with the edge's own direction between samples.
- Dev command `tipPath` (body, edge, width, tool, flank, step, tips): returns `chains: [{closed, tip}]` in the shape asked of PhysCAD, plus `wouldCut`. `evenDepth` takes `flank` and ball tools too.
- Wavy test part, 0.25 mm asked. 3/8" 90° chamfer mill, flank 0: 0.242–0.261 on the four edges tried. 1/4" ball end mill: 0.249–0.253 on the outer edges. Today's fixed depth gives 0.21–0.65.
- Sharp corners inside an edge (done): `sampleEdge` fetches the edge every 0.25 mm (`d.dense`), finds corners (direction turns more than 12° between two points), puts two entries at each corner (direction in, direction out) and keeps the checked points 0.5 mm either side of it. `offsetAlong` never blends across a corner. Pocket rim (a 28° corner at x25 y20): chamfer mill 0.242–0.255, ball 0.249–0.253, was 0.23–0.41 at the corner. The corner point itself is not measured.
- Known gaps: (1) `flank` 0.5 mm gives 0.233–0.29 on the pocket rim: needs a correction pass from the measured width. (2) Past an open edge's end the path is taken as straight on: chains of several edges are not joined yet.
- When `points` lands: pass `chains` to `cam.op.trace`, add ball end mills to the tool picker and panel, then partial edges.

### Missing compared with pro CAM deburring (list from 2026-11-24)
1. Ball end mill support: the usual tool for 3-axis 3D deburring, since a ball cuts the same in every direction. Needs the tip-point list from PhysCAD.
2. Holder and shank check: done, see Next 3.
3. Partial edges: deburr the reachable part of an edge and stop short of walls.
4. Smooth entry and exit moves, and an overlap on closed loops.
5. A different width per edge or per group of edges.
6. A choice of where each loop starts.

### Rules
- Saving a plugin file makes PhysCAD reload the plugin. Wait a few seconds before running a command, and never call `plugins.reload` as well: both engine stops on 2026-11-25 came on the first search right after a save.
- The repo is public and MIT licensed (`LICENSE`, copyright Music City Mfg). PhysCAD's developer has been told he may build this into PhysCAD.
- Use the word "CAM", not "Manufacture", in UI text.
- Op names follow `<setup#>-<two-digit sequence> <label>`.
- PhysCAD's modeling engine stopped once mid-search on 2026-11-25 (cause unknown; seen once in about eight searches). `run` now asks an `inspect.*` question again after an engine stop, up to 3 tries; other commands are never repeated. `timing.engineRestarts` counts the stops.
- Keep PhysCAD requests small: at most 1,500 points per `inspect.surfaceNormals` call, one request at a time. Larger, parallel requests stopped the modeling engine once.
