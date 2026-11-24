# PhysCAD Plugins — status

One folder per plugin. Plugins run in PhysCAD's plugin sandbox: one main file, no imports, lengths in mm, angles in degrees.

## 3d-deburr — v0.5.0

- Auto-finds sharp, outside, top-reachable edges on any surface type by sampling each edge (`inspect.edgePoints`) and reading face normals (`inspect.surfaceNormals`).
- Level edges → one 2D Chamfer op (`<setup#>-<NN> Deburr`); wavy/sloped edges → one Path op (`cam.op.trace`, `<setup#>-<NN> Deburr 3D`).
- Picked edges → Path op (`deburrSelected`). Pick mode, hole skipping, exclusions, passes, skip modeled chamfers.

### Next
1. Gouge check on 3D edges (tool cone vs. the faces beside the edge).
2. "Model Chamfer" option: keep the chamfer width constant along tilted 3D edges.
3. PhysCAD's new edge-gouge warning fires on every deburr Path op (the chamfer isn't modeled). Feature request drafted for an optional "allowed cut into part" setting on Path ops.
4. Waiting on PhysCAD: a `workspace` option for toolbar buttons / a `workspaceChanged` event (would replace the 2 s `cam.setups` polling in panel.js).

### Rules
- Use the word "CAM", not "Manufacture", in UI text.
- Op names follow `<setup#>-<two-digit sequence> <label>`.
