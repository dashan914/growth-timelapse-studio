import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { ThreeMFLoader } from 'three/addons/loaders/3MFLoader.js';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'three/addons/libs/fflate.module.js';
import { DOMParser } from '../vendor/test-dom/worker.mjs';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalizeThreeMFUnitsForLoader } from '../src/three-mf-units.js';
import { captureSliceSourceSnapshot, sliceSourceSnapshotTransferables } from '../src/slice-source-client.js';
import { buildSliceSourceFromSnapshot } from '../src/slice-source-worker.js';
import { createSliceService, SLICE_SLICER } from '../slice-jobs.mjs';
import { parsePrintLayerGCode } from '../src/print-layer.js';

globalThis.DOMParser = DOMParser;
const expected = ['#23599c', '#c89e59'];
async function standardFixture({ unit = 'millimeter', colorgroup = false } = {}) {
  const filename = unit === 'centimeter' ? 'standard-two-color-centimetres.3mf' : 'standard-two-color.3mf';
  let bytes = new Uint8Array(await readFile(path.resolve('tests/fixtures/imports', filename)));
  if (colorgroup) {
    const archive = unzipSync(bytes);
    archive['3D/3dmodel.model'] = strToU8(strFromU8(archive['3D/3dmodel.model']).replace(/<basematerials[\s\S]*?<\/basematerials>/,
      '<colorgroup id="1" xmlns="http://schemas.microsoft.com/3dmanufacturing/material/2015/02"><color color="#23599CFF"/><color color="#C89E59FF"/></colorgroup>'));
    bytes = zipSync(archive);
  }
  const viewer = normalizeThreeMFUnitsForLoader(bytes);
  const root = new ThreeMFLoader().parse(viewer.data.buffer.slice(viewer.data.byteOffset,viewer.data.byteOffset+viewer.data.byteLength)); root.rotation.x = -Math.PI/2;
  const orientation = new THREE.Group(); orientation.add(root);
  return { orientation, root, bytes, metadata: { name: filename, sourceUnitsToMm: 1 }, options: { preserveMaterials: true } };
}
function preservedArrays(root) {
  const result = []; root.traverse(node => { if (node.isMesh) for (const [name, attribute] of Object.entries(node.geometry.attributes)) result.push({ name, original: attribute.array, copy: attribute.array.slice() }); }); return result;
}

test('real standard 3MF basematerials and colorgroup inputs retain both colors through owned worker snapshots without changing source attrs', async () => {
  for (const unit of ['millimeter', 'centimeter']) for (const colorgroup of [false, true]) {
    const studio = await standardFixture({ unit, colorgroup }), originals = preservedArrays(studio.root);
    let meshes = 0; studio.root.traverse(node => { if (node.isMesh) { meshes++; assert.equal(node.material.vertexColors, colorgroup); if (colorgroup) assert.equal(node.material.color.getHexString(), 'ffffff'); } });
    assert.equal(meshes, colorgroup ? 1 : 2);
    const snapshot = await captureSliceSourceSnapshot(studio, { yieldNow: async () => {} });
    if (colorgroup) {
      assert.ok(snapshot.meshes[0].colors instanceof Float64Array);
      assert.equal(snapshot.meshes[0].colorItemSize, 3);
      assert.notEqual(snapshot.meshes[0].colors.buffer, originals.find(item => item.name === 'color').original.buffer);
      assert.ok(sliceSourceSnapshotTransferables(snapshot).includes(snapshot.meshes[0].colors.buffer));
    }
    const own = structuredClone(snapshot, { transfer: sliceSourceSnapshotTransferables(snapshot) });
    const source = buildSliceSourceFromSnapshot(own);
    assert.deepEqual(source.toolColors, expected); assert.equal(source.triangles, 12); assert.equal(source.parts, 1);
    assert.equal(source.warnings.length, 0, 'constant-per-triangle colors are discrete, not guessed gradients');
    const model = strFromU8(unzipSync(new Uint8Array(await source.blob.arrayBuffer()))['3D/3dmodel.model']);
    assert.equal((model.match(/paint_color="4"/g) || []).length, 6); assert.equal((model.match(/paint_color="8"/g) || []).length, 6);
    originals.forEach(item => { assert.ok(item.original.byteLength > 0); assert.deepEqual(item.original, item.copy); });
  }
});

test('linear vertex RGB multiplies base color while original RGBA remains unchanged; gradients fall back honestly to base spool color', async () => {
  const root = new THREE.Group(), orientation = new THREE.Group(); orientation.add(root);
  const geometry = new THREE.BoxGeometry(.02, .02, .02).toNonIndexed(), rgba = new Float32Array(geometry.attributes.position.count * 4);
  for (let vertex = 0; vertex < geometry.attributes.position.count; vertex++) rgba.set([.5, .25, .125, .6], vertex*4);
  geometry.setAttribute('color', new THREE.BufferAttribute(rgba, 4));
  const material = new THREE.MeshStandardMaterial({ color: '#808080', vertexColors: true }), mesh = new THREE.Mesh(geometry, material); root.add(mesh);
  const before = rgba.slice(), base = material.color.clone();
  const source = buildSliceSourceFromSnapshot(await captureSliceSourceSnapshot({ orientation, metadata: { name: 'rgba', sourceUnitsToMm: 1000 }, options: { preserveMaterials: true } }, { yieldNow: async () => {} }));
  const effective = '#' + new THREE.Color(base.r*.5, base.g*.25, base.b*.125).getHexString();
  assert.deepEqual(source.toolColors, [effective]); assert.ok(source.warnings.some(message => /透明度/.test(message)));
  assert.deepEqual(rgba, before); assert.equal(material.color.getHexString(), '808080');
  for (let vertex = 0; vertex < geometry.attributes.position.count; vertex++) rgba.set([vertex%3===0?1:0, vertex%3===1?1:0, vertex%3===2?1:0, 1], vertex*4);
  const gradients = rgba.slice();
  const fallback = buildSliceSourceFromSnapshot(await captureSliceSourceSnapshot({ orientation, metadata: { name: 'gradient', sourceUnitsToMm: 1000 }, options: { preserveMaterials: true } }, { yieldNow: async () => {} }));
  assert.deepEqual(fallback.toolColors, ['#808080']); assert.ok(fallback.warnings.some(message => /连续顶点渐变.*估计.*RGBA/.test(message)));
  assert.deepEqual(rgba, gradients);
});

test('native standard mm/cm and real ThreeMFLoader colorgroup sources print all .16mm layers with both original filament slots', {skip: !process.env.GROWTH_NATIVE_SLICER_TESTS}, async t => {
  try { await access(SLICE_SLICER, constants.X_OK); } catch { t.skip('Native CLI unavailable.'); return; }
  const temp = await mkdtemp(path.join(tmpdir(), 'standard-color-slice-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  for (const unit of ['millimeter', 'centimeter']) for (const colorgroup of [false, true]) {
    const studio = await standardFixture({ unit, colorgroup });
    const source = buildSliceSourceFromSnapshot(await captureSliceSourceSnapshot(studio, { yieldNow: async () => {} }));
    const service = createSliceService({ root: path.join(temp, unit+'-'+colorgroup), timeoutMs: 60_000 });
    try {
      const { id } = await service.create(Buffer.from(await source.blob.arrayBuffer()), { format: '3mf', toolColors: source.toolColors }); let state;
      for (let attempt = 0; attempt < 1200; attempt++) { state = service.snapshot(id); if (state.status !== 'running') break; await new Promise(resolve => setTimeout(resolve, 10)); }
      assert.equal(state.status, 'complete', state.message);
      const printed = parsePrintLayerGCode(await readFile(await service.gcodeFile(id), 'utf8'));
      assert.equal(printed.layerHeights.length, 250);
      assert.ok(Math.abs(printed.layerHeights[0] - .2) < 1e-9);
      assert.ok(Math.abs(printed.layerHeights[1] - printed.layerHeights[0] - .16) < 1e-9);
      assert.ok(printed.layerHeights.at(-1) >= 40 && printed.layerHeights.at(-1) < 40 + .16, 'new fallback covers the full source height rather than truncating the assembly');
      assert.deepEqual(printed.toolColors, expected); assert.deepEqual([...new Set(printed.tools)].sort(), [0, 1]);
      assert.equal(source.triangles, 12); assert.equal(state.sliceSettings.sparseInfillDensityPercent, 15);
      assert.equal(state.sliceSettings.wallLoops, 2);
    } finally { await service.close(); }
  }
});
