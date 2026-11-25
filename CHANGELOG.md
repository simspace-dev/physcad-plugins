# Changelog

## 3d-deburr 0.6.3 (2026-11-25)

Find edges is faster. On the wavy test part it now takes about 3.4 seconds, down from about 7 seconds on the same PhysCAD version, and it finds exactly the same edges with exactly the same cut widths as before. (An older measurement of 48 seconds no longer holds: PhysCAD itself has become much faster at answering the plugin's questions about curved surfaces.)

A second search is close to instant. The plugin now remembers what it worked out for each edge, so pressing Create deburr right after Find edges no longer repeats the whole search. It forgets those results as soon as the part changes or the setup points a different way, so a changed part is always checked again.

- `cutCheck` finds where each face leaves the tool by halving the distance, about 5 surface lookups per point where it used to make 16 or more. A face still inside the tool at the last step is reported as digging in, as before.
- Which side of an edge a face lies on is tried at every sixth point first, and at every point only when those disagree.
- An edge that is too smooth to need a deburr is dropped before any of that is asked. The side of the first face is only worked out for edges that pass.
- Results are kept per edge until the body (its faces, edges and size) or the setup's tool direction changes. The search reports how many edges it reused.
- `findEdges` returns `timing`: the total time and, for each PhysCAD command, how many calls, how many points and how long.
- Surface lookups are made one at a time; two used to run together in places.
- Test part: 14,156 surface points asked before, 7,360 now. A repeat search takes about 0.03 seconds. `evenDepth` on the pocket rim still gives 0.097 to 0.303 mm.
- Not run after this change: Create deburr and Deburr selected (they add toolpaths to the open file).

## 3d-deburr 0.6.2 (2026-11-25)

This version records a test and the decision that came out of it. Nothing changes in the panel or in the toolpaths the plugin creates.

Most wavy edges are still left out, because PhysCAD's Path toolpath runs at one depth and an even break on a wavy edge needs the depth to change along the edge. On 2026-11-24 a way around that was tried: draw a curve for the toolpath to follow in place of the edge itself. It works only when the edge lies in a flat plane. PhysCAD's Path toolpath does not accept a curve drawn in 3D, and the steep pocket rim would also need the tool moved sideways. The decision is to wait for the requested PhysCAD feature and not build the workaround.

To run that test, the developer command that works out the depth at each point of an edge can now also report where the tool tip would be and how wide a break those positions would cut.

- `evenDepth` has a new `points` option. It returns the tip position at each point of the edge (world mm), whether the edge is a closed loop, and the break those positions would cut (`wouldCut`: width, cut on each face, and the steep, notch, digs and hit counts). It returns them only when every point of the edge has a workable depth.
- `cutCheck` takes an optional list of depths, one per edge point, and checks the edge at those depths. Without it, it checks one depth everywhere, as before.
- `nearFaceHits` uses the same per-point depths when they are given.
- CLAUDE.md records the workaround test and the decision to wait for PhysCAD.

## 3d-deburr 0.6.1 (2026-11-24)

The plugin now has a license. Until now the code was public to read, but nobody else had the legal right to reuse it. It is now under the MIT license, a short, standard license that lets anyone use, change and sell the code as long as the copyright notice stays with it. The reason is practical: PhysCAD's developer has been invited to build 3D deburring into PhysCAD itself using this code, and the license gives him clear, lasting permission to do so.

Nothing about how the plugin works has changed in this version.

- Added `LICENSE` (MIT, copyright 2026 Music City Mfg).
- `plugin.json` now declares `"license": "MIT"`, which PhysCAD shows in its plugin list.
- README has a License section.

## 3d-deburr 0.6.0 (2026-11-24)

3D Deburr now checks every wavy or sloped edge before it cuts it, and only cuts the ones it can do cleanly. Before, it sent every edge it found to a toolpath and hoped. Now it works out how wide the cut would really be at points all along the edge, and leaves an edge out when the width would stray too far from what was asked, when the edge climbs too steeply for the tool's point, when the tool would cut a groove instead of a bevel, or when the tool would run into a wall nearby. Each edge it leaves out is listed with the reason, and a new Show left out button highlights them on the part.

This version is honest rather than complete. On the wavy test part, with a 0.25 mm break and a 1/4" 90° chamfer mill, only the hole rim passes (0.218 to 0.246 mm). The other five top edges would come out anywhere from 0.21 to 0.65 mm wide, so they are left out. An even break on those edges needs the tool to move up, down and sideways as it follows the edge, and PhysCAD's Path toolpath can only run at one depth. The plugin already works out the depth needed at every point; a feature request to PhysCAD asks for a way to hand it over.

- Width math corrected: the cut at a point now counts the tool at every position along the edge (positions 0.025 mm apart), not only the one beside it. Where an edge climbs, the wide part of the cone a little way down the slope cuts too: at a 37.8° climb a 90° tool cuts 1.59 times wider on the top face. Checked against hand-worked cases.
- New reasons a 3D edge is left out: it climbs as steeply as the tool's side; both faces slope away from it (the tip would be buried and cut a V groove); another face nearby ends up inside the tool; a face beside it rises into the tool; the width varies more than the tolerance.
- New Tolerance % setting (default 20): how far the cut width may differ from Width before an edge is left out.
- The bevel width is measured across the bevel face, as the width of a square corner's chamfer with the same face.
- Level edges go to 2D Chamfer only when they are a flat top over a vertical wall all the way along. Any other level edge is treated as a 3D edge and checked.
- New Wall clear setting for the level edges' chamfer toolpath (PhysCAD's 2D Chamfer wall clearance).
- Picked edges get the same checks, plus the inside-corner and facing-down tests. `keepFlagged` cuts them anyway.
- Tool choice: with Tool # blank it prefers a pointed tool the setup already uses, then one with a real tool number. Tools are assigned by id, so a repeated tool number can't pick the wrong tool. The panel names the tool chosen.
- Toolpath names use one more than the highest sequence number in the setup, so they no longer repeat after a delete.
- Edges skipped because only part of them qualifies are listed (`partial`) and shown by Show left out.
- Results give lengths in the document's units in the panel.
- Skip holes and Skip chamfered now work on parts with more than 300 faces.
- Multiple passes on a Path toolpath tested: two passes step down evenly to the full depth.
- PhysCAD is asked for points in batches of 1,500 at most, one request at a time. A heavier version stopped the modeling engine once.
- Developer command `evenDepth`: the tip depth at each point of an edge that would give an even bevel (0.097 to 0.303 mm along the test part's pocket rim for a 0.25 mm break).
- Known limits: Find edges takes about 48 seconds on the wavy test part. Create deburr from the panel, Show left out, and the changed level-edge rule have not been run on a real part yet.

## 3d-deburr 0.5.0 (2026-11-24)

3D Deburr now finds wavy and sloped edges by itself. Before, the automatic search only found edges that sat at one height, so a part with a wavy top had to have its edges clicked one by one. The plugin now walks along every edge of the part, checking it about every 2 mm, and looks at which way the two faces on either side of the edge are pointing at each spot. From that it decides whether the edge is a sharp outside corner that needs a burr removed and whether the tool can reach it from above. This works on every kind of surface, including freeform (spline) surfaces, using the surface-normal and edge-point tools that PhysCAD added for plugins in its latest update.

Create deburr now makes up to two toolpaths. Edges that sit at one height get a regular chamfer toolpath, as before. Wavy or sloped edges get a Path toolpath that runs the tip of a pointed chamfer mill along each edge, just below it. The panel reports how many level and 3D edges it found.

- Edge check rewritten: samples each edge with `inspect.edgePoints` and reads both faces' outward directions with `inspect.surfaceNormals`. Replaces the old flat/cylinder-only math and the spline-wall probe.
- Outside-corner test: steps 0.05 mm across one face to see which way it runs from the edge, then checks it falls away behind the other face.
- An edge is skipped if any point along it is too smooth, an inside corner, or facing down or sideways. Partial cases are reported as "partly ...".
- Edges whose height varies less than 0.01 mm are "level"; the rest are "3D".
- `createDeburr` returns `ops` (a list) instead of a single `name`. It checks that the tool is pointed when 3D edges are found.
- Path-op building and pointed-tool checks are shared between `createDeburr` and `deburrSelected`.
- Panel: "Auto (flat edges)" heading is now "Auto"; Find edges and Create deburr messages show level vs. 3D counts and every op made.
- Tested on the wavy test part: finds all 6 top edges (4 outside edges, the pocket rim and the hole rim). Before, it found none.

## 3d-deburr 0.4.0 (2026-11-23)

First version in this repo: automatic deburr of level edges with a 2D Chamfer operation, deburr of picked edges with a Path operation, pick mode, hole skipping, per-document edge exclusions, multiple passes and skipping of modeled chamfers.
