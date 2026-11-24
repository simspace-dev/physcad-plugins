# PhysCAD Plugins

Plugins for [PhysCAD](https://physcad.io), one folder per plugin.

| Plugin | Version | What it does |
|---|---|---|
| [3d-deburr](3d-deburr/) | 0.6.1 | Breaks the sharp edges on 3D parts (including wavy and sloped edges) by adding chamfer toolpaths in CAM. Finds wavy and sloped edges automatically, checks each one, and only cuts those the tool can break at an even width. Most wavy edges can't be yet: that needs a PhysCAD feature that has been requested. Work in progress, not released. |

See [CHANGELOG.md](CHANGELOG.md) for what changed in each version.

## Loading a plugin for development

1. In PhysCAD, turn on Preferences > Labs > Third-party plugins.
2. Load the plugin's folder as a developer plugin and approve it.
3. PhysCAD reloads the plugin whenever its files are saved.

## License

[MIT](LICENSE). You may use, change and sell this code, as long as the copyright notice stays with it.
