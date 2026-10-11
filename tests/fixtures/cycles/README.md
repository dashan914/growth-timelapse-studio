# Cycles test fixture

Two project-generated red and blue boxes, 24 triangles, exported from Blender. No photographs or external model assets are bundled. `config.json` records the test camera and model settings; the test creates its own flat-color PNG.

Regenerate `scene.glb` with your installed Blender:

```sh
blender --background --factory-startup --python tests/create-cycles-fixture.py
```
