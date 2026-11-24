# Changelog

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
