# PhysCAD Plugins

Plugins for [PhysCAD](https://physcad.io), one folder per plugin.

| Plugin | Version | What it does |
|---|---|---|
| [3d-deburr](3d-deburr/) | 0.5.0 | Breaks the sharp edges on 3D parts (including wavy and sloped edges) by adding chamfer toolpaths in CAM. Finds wavy and sloped edges automatically. Work in progress, not released. |

See [CHANGELOG.md](CHANGELOG.md) for what changed in each version.

## Loading a plugin for development

1. In PhysCAD, turn on Preferences > Labs > Third-party plugins.
2. Load the plugin's folder as a developer plugin and approve it.
3. PhysCAD reloads the plugin whenever its files are saved.
