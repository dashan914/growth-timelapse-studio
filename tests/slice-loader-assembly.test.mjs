import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { unzipSync, strFromU8 } from 'three/addons/libs/fflate.module.js';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSliceService, SLICE_SLICER } from '../slice-jobs.mjs';
import { captureSliceSourceSnapshot } from '../src/slice-source-client.js';
import { buildSliceSourceFromSnapshot } from '../src/slice-source-worker.js';
import { modelSourceUnits } from '../src/model-units.js';
import { parsePrintLayerGCode } from '../src/print-layer.js';

globalThis.ProgressEvent ||= class ProgressEvent { constructor(type, data) { this.type = type; Object.assign(this, data); } };
const directory = path.resolve('tests/fixtures/imports');
const arrayBuffer = bytes => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
async function loadFixture(name) {
  const data = await readFile(path.join(directory, name)); const format = name.split('.').at(-1); let root;
  if (format === 'glb') root = (await new GLTFLoader().parseAsync(arrayBuffer(data), '')).scene;
  else if (format === 'gltf') root = (await new GLTFLoader().parseAsync(data.toString(), '')).scene;
  else if (format === 'obj') {
    const materials = new MTLLoader().parse(await readFile(path.join(directory, 'audit-material.mtl'), 'utf8'), '');
    materials.loadTexture = () => new THREE.Texture(); materials.preload();
    root = new OBJLoader().setMaterials(materials).parse(data.toString());
  } else if (format === 'fbx') root = new FBXLoader().parse(arrayBuffer(data), '');
  else { root = new THREE.Mesh(new STLLoader().parse(arrayBuffer(data)), new THREE.MeshStandardMaterial({ color: '#d6d6d6' })); root.rotation.x = -Math.PI/2; }
  const orientation = new THREE.Group(); orientation.add(root);
  return { root, orientation, metadata: { name, ...modelSourceUnits(format, root) }, options: { preserveMaterials: true, color: '#d6d6d6' } };
}

test('actual GLTFLoader split material primitives form one complete staged volume rather than two invalid open parts', async () => {
  const studio = await loadFixture('two-color-metres.glb'); let meshes = 0; const before = [];
  studio.root.traverse(node => { if (node.isMesh) { meshes++; before.push(node.geometry.attributes.position.array.slice()); } });
  assert.equal(meshes, 2);
  const source = buildSliceSourceFromSnapshot(await captureSliceSourceSnapshot(studio, { yieldNow: async () => {} }));
  assert.equal(source.parts, 1); assert.equal(source.sourceMeshes, 2); assert.equal(source.triangles, 12);
  assert.equal(source.sourceRevision, 'whole-assembly-discrete-vertex-paint-v4');
  const zip = unzipSync(new Uint8Array(await source.blob.arrayBuffer()));
  const model = strFromU8(zip['3D/3dmodel.model']), provenance = JSON.parse(strFromU8(zip['Metadata/growth_source.json']));
  assert.equal((model.match(/<mesh>/g) || []).length, 1); assert.equal((model.match(/<triangle /g) || []).length, 12);
  assert.deepEqual(provenance.sourceMeshes.map(mesh => mesh.faceCount), [6, 6]);
  assert.equal(provenance.nativeSliceRepairMayOccur, true);
  let at = 0; studio.root.traverse(node => { if (node.isMesh) assert.deepEqual(node.geometry.attributes.position.array, before[at++]); });
});

test('real imported GLB/glTF/OBJ-MTL/declared-centimetre FBX/Z-up STL all slice full 40mm height with the same source coordinates', {skip: !process.env.GROWTH_NATIVE_SLICER_TESTS}, async t => {
  try { await access(SLICE_SLICER, constants.X_OK); } catch { t.skip('Local native CLI not installed.'); return; }
  const root = await mkdtemp(path.join(tmpdir(), 'native-imported-assembly-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ['two-color-metres.glb', 'two-color-metres.gltf', 'textured-two-color.obj', 'centimetres-static.fbx', 'millimetres-static.stl']) {
    const studio = await loadFixture(name), source = buildSliceSourceFromSnapshot(await captureSliceSourceSnapshot(studio, { yieldNow: async () => {} }));
    const service = createSliceService({ root: path.join(root, name), timeoutMs: 60_000 });
    try {
      const { id } = await service.create(Buffer.from(await source.blob.arrayBuffer()), { format: '3mf', toolColors: source.toolColors }); let state;
      for (let attempt = 0; attempt < 1200; attempt++) { state = service.snapshot(id); if (state.status !== 'running') break; await new Promise(resolve => setTimeout(resolve, 10)); }
      assert.equal(state.status, 'complete', name+': '+state.message);
      const parsed = parsePrintLayerGCode(await readFile(await service.gcodeFile(id), 'utf8'));
      assert.equal(source.triangles, 12); assert.equal(source.parts, 1); assert.equal(parsed.layerHeights.length, 250);
      assert.ok(Math.abs(parsed.layerHeights[0] - .2) < 1e-9);
      assert.ok(Math.abs(parsed.layerHeights[1] - parsed.layerHeights[0] - .16) < 1e-9);
      assert.ok(parsed.layerHeights.at(-1) >= 40 && parsed.layerHeights.at(-1) < 40 + .16, 'native layers still cover the complete original 40mm assembly');
      assert.ok(Math.abs(parsed.bounds.max[0] - parsed.bounds.min[0] + .42 - 30) < .001);
      assert.ok(Math.abs(parsed.bounds.max[1] - parsed.bounds.min[1] + .42 - 20) < .001);
      for (const role of ['outerWall', 'innerWall', 'sparseInfill', 'solidInfill', 'topSurface', 'bottomSurface']) assert.ok(parsed.featureCounts[role] > 0, name+' '+role);
      const usedTools = [...new Set(parsed.tools)].sort((a, b) => a - b);
      assert.deepEqual(usedTools, source.toolColors.map((_, index) => index), name+' extrudes exactly the original filament slots');
      assert.deepEqual(usedTools.map(tool => parsed.toolColors[tool]), source.toolColors, name+' preserves every actually extruded source color; unused native palette slots are allowed');
      const report = await service.provenance(id); assert.equal(report.genericStaging.triangles, 12); assert.equal(report.genericStaging.geometrySimplified, false);
    } finally { await service.close(); }
  }
});
