# Independent import audit fixtures

Own-generated deterministic engineering fixtures. No user model is changed, no external asset or license is borrowed. All models are the same 30 × 40 × 20 mm box, 12 triangles; Z-up files encode 30 × 20 × 40 mm and are rotated by the app. FBX explicitly declares centimetres (UnitScaleFactor 1); GLB/GLTF use metres. STL/OBJ have no fixed unit and assume millimetres.

Import OBJ together with audit-material.mtl and audit-checker.png. The textured GLB embeds the same PNG and UVs; only the blue material is textured, gold remains untextured. The plain GLTF is self-contained (data URI buffer).

Expected source values are in EXPECTED.json. Compare equal model scale on the same calibrated photo; all should project at the same physical size. Source Y-up box has height 40 mm. Missing MTL/PNG should report a clear import error and preserve the previous model. Tiny checker deliberately uses nearest filtering so texture visibility is easy to judge. Source units and face count must not be inferred from a screenshot alone.

Reproduce: node tests/create-fixtures.mjs
