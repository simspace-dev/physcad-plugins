# PhysCAD Plugins

Plugins for [PhysCAD](https://physcad.io), one folder per plugin.

| Plugin | Version | What it does |
|---|---|---|
| [3d-deburr](3d-deburr/) | 0.6.6 | Breaks the sharp edges on 3D parts (including wavy and sloped edges) by adding chamfer toolpaths in CAM. Finds wavy and sloped edges automatically, works out the tool path that gives each an even break, and checks it. PhysCAD cannot follow that path yet, so for now the toolpath is a stand-in with an uneven break on wavy edges; see the known problem below. Work in progress, not released. |

See [CHANGELOG.md](CHANGELOG.md) for what changed in each version.

## 3d-deburr: known problem and what it is waiting on

**The problem.** The goal is an edge break of one even width all along every edge. On a level edge (a flat top over a straight wall) the plugin does that today. On a wavy or sloped edge it does not: the break comes out wider in some places and narrower in others. On the wavy test part, asking for 0.25 mm gives anywhere from 0.21 to 0.65 mm on five of the six top edges.

**Why.** PhysCAD's Path toolpath runs the tool's point straight below the edge at one fixed depth. A cone-shaped tool at one depth only cuts an even width where the edge is level and the faces beside it are a flat top and a straight wall. Where the edge climbs or the faces lean, the same depth cuts a different width. An even break needs the tool to move up, down and a little sideways as it follows the edge, and a plugin has no way to give PhysCAD a path like that.

**What the plugin does for now.** It is built as if PhysCAD could already follow the right path. It works out the tool positions that give an even break on each wavy edge, checks every edge on those positions, and leaves out only the edges that even that path could not cut. Then it makes a stand-in toolpath at one depth, because that is all PhysCAD can follow today:

- With no edges picked, the Deburr button finds every sharp edge and deburrs them all. With edges picked, it deburrs exactly those. Its label says which.
- The panel shows the break each wavy edge is planned to get, and says the stand-in toolpath is uneven until PhysCAD's update.
- Show problem edges highlights the edges the last run had trouble with. Remove last deburr deletes the toolpaths the last Deburr made, so you can start over.
- Check the result in PhysCAD's simulation before cutting. It shows in red where a Path toolpath cuts into the part.

The plugin will not be released until PhysCAD's side is done.

**What it is waiting on.** A request to PhysCAD's developer for a way to hand a Path toolpath the exact tool positions to follow (an optional list of 3D points on `cam.op.trace`). The plugin already works out the depth needed at each point of an edge for an even break. When PhysCAD accepts those points, the uneven breaks go away and the edges left out today can be cut.

## Loading a plugin for development

1. In PhysCAD, turn on Preferences > Labs > Third-party plugins.
2. Load the plugin's folder as a developer plugin and approve it.
3. PhysCAD reloads the plugin whenever its files are saved.

## License

[MIT](LICENSE). You may use, change and sell this code, as long as the copyright notice stays with it.
