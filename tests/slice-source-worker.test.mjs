import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { unzipSync, strFromU8 } from 'three/addons/libs/fflate.module.js';
import { createSliceSource, encodeWholeFacePaint } from '../src/slice-source.js';
import { decodePaintedTriangle } from '../src/painted-3mf.js';
import { createSliceService, SLICE_SLICER } from '../slice-jobs.mjs';
import { parsePrintLayerGCode } from '../src/print-layer.js';
import { buildSliceSourceFromSnapshot } from '../src/slice-source-worker.js';
import { captureSliceSourceSnapshot, createSliceSourceInWorker, sliceSourceSnapshotTransferables } from '../src/slice-source-client.js';
import { Worker as NodeWorker } from 'node:worker_threads';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function studioFixture() {
  const outside = new THREE.Group(), orientation = new THREE.Group(), root = new THREE.Group();
  outside.scale.setScalar(3); outside.position.set(8, 1, -3); outside.add(orientation); orientation.rotation.y = .34; orientation.add(root);
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(.01, .02, .012), new THREE.MeshStandardMaterial({ color: '#23599c' }));
  mesh.position.set(.015, .006, -.03); mesh.rotation.set(.1, -.5, .3); root.add(mesh);
  const ghost = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial()); ghost.userData.growthTransient = true; root.add(ghost);
  return { orientation, root, mesh, metadata: { name: '原模型 <b>', sourceUnitsToMm: 1000 }, options: { preserveMaterials: true, color: '#e5e5e5' } };
}

async function geometryFacts(source) {
  const entries = unzipSync(new Uint8Array(await source.blob.arrayBuffer()));
  const model = strFromU8(entries['3D/3dmodel.model']);
  const vertices = [...model.matchAll(/<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"\/>/g)].map(match => match.slice(1).map(Number));
  return { source, entries, model, vertices, triangles: (model.match(/<triangle /g) || []).length };
}

test('worker-owned clone preserves every source triangle, palette and explicit placement without mutating or detaching live arrays', async () => {
  const studio = studioFixture(), sourcePositions = studio.mesh.geometry.attributes.position.array, sourceIndex = studio.mesh.geometry.index.array;
  const positionsBefore = sourcePositions.slice(), indicesBefore = sourceIndex.slice();
  const direct = await geometryFacts(createSliceSource(studio));
  const snapshot = await captureSliceSourceSnapshot(studio, { yieldNow: async () => {} });
  assert.equal(snapshot.meshes.length, 1, 'transient stencil is excluded');
  assert.equal(snapshot.triangleCount, 12);
  assert.notEqual(snapshot.meshes[0].positions.buffer, sourcePositions.buffer);
  assert.notEqual(snapshot.meshes[0].indices.buffer, sourceIndex.buffer);
  const received = structuredClone(snapshot, { transfer: sliceSourceSnapshotTransferables(snapshot) });
  assert.equal(snapshot.meshes[0].positions.byteLength, 0, 'only detached owned clone was transferred');
  assert.ok(sourcePositions.byteLength > 0);
  const actual = await geometryFacts(buildSliceSourceFromSnapshot(received));
  assert.equal(actual.triangles, direct.triangles);
  assert.deepEqual(actual.source.toolColors, direct.source.toolColors);
  assert.equal(actual.vertices.length, direct.vertices.length);
  actual.vertices.forEach((vertex, index) => vertex.forEach((value, axis) => assert.ok(Math.abs(value - direct.vertices[index][axis]) < 1e-10)));
  actual.source.printerToSource.forEach((value, index) => assert.ok(Math.abs(value - direct.source.printerToSource[index]) < 1e-10));
  assert.deepEqual(sourcePositions, positionsBefore); assert.deepEqual(sourceIndex, indicesBefore);
});

test('static morph and skin pose use getVertexPosition before copying, while originals and pose buffers remain intact', async () => {
  const studio = studioFixture(), geometry = studio.mesh.geometry, raw = geometry.attributes.position.array.slice();
  const target = raw.slice(); for (let at = 0; at < target.length; at += 3) target[at] += .004;
  geometry.morphAttributes.position = [new THREE.BufferAttribute(target, 3)]; studio.mesh.updateMorphTargets(); studio.mesh.morphTargetInfluences[0] = .4;
  const expected = new THREE.Vector3(); studio.mesh.getVertexPosition(0, expected);
  const snapshot = await captureSliceSourceSnapshot(studio, { yieldNow: async () => {} });
  assert.deepEqual([...snapshot.meshes[0].positions.slice(0, 3)], expected.toArray());
  assert.deepEqual(geometry.attributes.position.array, raw);
  assert.deepEqual(geometry.morphAttributes.position[0].array, target);
  const triangle = new THREE.BufferGeometry(); triangle.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, .01, 0, 0, 0, .01, 0], 3));
  triangle.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Array(12).fill(0), 4));
  triangle.setAttribute('skinWeight', new THREE.Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4));
  const skinned = new THREE.SkinnedMesh(triangle, new THREE.MeshStandardMaterial({ color: '#f0e8d6' })), bone = new THREE.Bone(); skinned.add(bone);
  const skeleton = new THREE.Skeleton([bone]); skinned.bind(skeleton); bone.position.y = .005; skinned.updateMatrixWorld(true); skeleton.update();
  studio.root.remove(studio.mesh); studio.root.add(skinned);
  const bind = skeleton.boneMatrices.slice(), posed = new THREE.Vector3(); skinned.getVertexPosition(0, posed);
  const skinSnapshot = await captureSliceSourceSnapshot(studio, { yieldNow: async () => {} });
  assert.deepEqual([...skinSnapshot.meshes[0].positions.slice(0, 3)], posed.toArray());
  assert.ok(posed.y > .004);
  assert.deepEqual(skeleton.boneMatrices, bind);
});

test('all instanced poses and discrete group colors are retained in the background slicing copy', async () => {
  const studio = studioFixture(); studio.root.remove(studio.mesh);
  const geometry = new THREE.BoxGeometry(.01, .02, .01), materials = [new THREE.MeshStandardMaterial({ color: '#ff3344' }), new THREE.MeshStandardMaterial({ color: '#2244ff' })];
  geometry.groups.forEach((group, index) => group.materialIndex = index % 2);
  const mesh = new THREE.InstancedMesh(geometry, materials, 2); mesh.setMatrixAt(0, new THREE.Matrix4().makeTranslation(.02, 0, 0));
  mesh.setMatrixAt(1, new THREE.Matrix4().makeScale(-1, 1, 1).setPosition(-.02, 0, 0)); studio.root.add(mesh);
  const instancesBefore = mesh.instanceMatrix.array.slice();
  const direct = await geometryFacts(createSliceSource(studio));
  const snapshot = await captureSliceSourceSnapshot(studio, { yieldNow: async () => {} });
  assert.equal(snapshot.triangleCount, 24); assert.equal(snapshot.meshes[0].instances.length, 32);
  const actual = await geometryFacts(buildSliceSourceFromSnapshot(snapshot));
  assert.equal(actual.triangles, direct.triangles); assert.deepEqual(actual.source.toolColors, direct.source.toolColors);
  assert.equal(actual.source.parts, direct.source.parts);
  actual.vertices.forEach((vertex, index) => vertex.forEach((value, axis) => assert.ok(Math.abs(value - direct.vertices[index][axis]) < 1e-10)));
  assert.deepEqual(mesh.instanceMatrix.array, instancesBefore);
});

test('large main-thread copies yield and cancellation stops before worker creation or any live mutation', async () => {
  const studio = studioFixture(); studio.mesh.geometry = new THREE.PlaneGeometry(.1, .1, 100, 100);
  const signal = new AbortController(), source = studio.mesh.geometry.attributes.position.array.slice();
  let yields = 0, created = false;
  class NeverWorker { constructor() { created = true; } }
  await assert.rejects(createSliceSourceInWorker(studio, { signal: signal.signal, WorkerClass: NeverWorker, yieldNow: async () => { yields++; signal.abort(); } }), { name: 'AbortError' });
  assert.equal(yields, 1); assert.equal(created, false);
  assert.deepEqual(studio.mesh.geometry.attributes.position.array, source);
});

test('real owned transfers, texture warnings and cancellation/error worker cleanup keep the public source contract', async () => {
  const studio = studioFixture(); studio.mesh.material.map = new THREE.Texture();
  let instance;
  class FakeWorker {
    constructor(url, options) { instance = this; assert.match(url.pathname, /slice-source-worker.js$/); assert.equal(options.type, 'module'); }
    postMessage(message, transfers) {
      assert.ok(transfers.every(buffer => buffer !== studio.mesh.geometry.attributes.position.array.buffer));
      const received = structuredClone(message, { transfer: transfers });
      queueMicrotask(() => { this.onmessage({ data: { phase: 'generating' } }); this.onmessage({ data: { phase: 'complete', source: buildSliceSourceFromSnapshot(received.snapshot, { preset: received.preset }) } }); });
    }
    terminate() { this.stopped = true; }
  }
  const phases = [], result = await createSliceSourceInWorker(studio, { WorkerClass: FakeWorker, yieldNow: async () => {}, onPhase: phase => phases.push(phase) });
  assert.equal(result.format, '3mf'); assert.ok(result.blob instanceof Blob); assert.equal(result.triangles, 12);
  assert.match(result.warnings[0], /实际耗材编号/); assert.deepEqual(phases, ['copying', 'generating']); assert.equal(instance.stopped, true);
  class PendingWorker extends FakeWorker { postMessage() { setTimeout(() => this.controller.abort(), 0); } }
  const controller = new AbortController();
  class AbortWorker extends PendingWorker { constructor(...args) { super(...args); this.controller = controller; } }
  await assert.rejects(createSliceSourceInWorker(studio, { WorkerClass: AbortWorker, signal: controller.signal, yieldNow: async () => {} }), { name: 'AbortError' });
  assert.equal(instance.stopped, true);
  class ErrorWorker extends FakeWorker { postMessage() { queueMicrotask(() => this.onerror({ message: 'worker test failure' })); } }
  await assert.rejects(createSliceSourceInWorker(studio, { WorkerClass: ErrorWorker, yieldNow: async () => {} }), /worker test failure/);
  assert.equal(instance.stopped, true);
});

test('memory/triangle budgets reject before allocation and malformed snapshots cannot fabricate missing groups', async () => {
  const studio = studioFixture();
  await assert.rejects(captureSliceSourceSnapshot(studio, { maxSnapshotBytes: 1 }), /内存预算/);
  await assert.rejects(captureSliceSourceSnapshot(studio, { maxTriangles: 1 }), /不会减面/);
  await assert.rejects(captureSliceSourceSnapshot(studio, { batchVertices: 0 }), /预算/);
  const snapshot = await captureSliceSourceSnapshot(studio, { yieldNow: async () => {} });
  snapshot.meshes[0].materialArray = true; snapshot.meshes[0].groups = [];
  assert.throws(() => buildSliceSourceFromSnapshot(snapshot), /未分配/);
  assert.throws(() => buildSliceSourceFromSnapshot({ schemaVersion: 1, meshes: [] }), /快照/);
});

test('standalone module worker runs the production handler with real owned transfers and no page import map', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'growth-slice-worker-'));
  const workerModule = new URL('../src/slice-source-worker.js', import.meta.url).href;
  const wrapper = path.join(directory, 'worker.mjs');
  await writeFile(wrapper, `import {parentPort} from 'node:worker_threads';
globalThis.self={postMessage:(value)=>parentPort.postMessage(value)};
const queued=[];
parentPort.on('message',value=>typeof self.onmessage==='function'?self.onmessage({data:value}):queued.push(value));
await import(${JSON.stringify(workerModule)});
for(const value of queued)self.onmessage({data:value});
`);
  let native, stopped;
  class BrowserWorker {
    constructor(url) {
      assert.equal(url.href, workerModule);
      native = new NodeWorker(pathToFileURL(wrapper));
      native.on('message', value => this.onmessage?.({ data: value })); native.on('error', error => this.onerror?.({ message: error.message }));
    }
    postMessage(message, transfer) { native.postMessage(message, transfer); }
    terminate() { stopped = native.terminate(); }
  }
  t.after(async () => { await (stopped || native?.terminate()); await rm(directory, { recursive: true, force: true }); });
  const studio = studioFixture();studio.mesh.geometry=studio.mesh.geometry.toNonIndexed();studio.mesh.material.color.set('#ffffff');studio.mesh.material.vertexColors=true;
  const colorData=new Float32Array(studio.mesh.geometry.attributes.position.count*3);
  const colors=['#23599c','#c89e59'].map(hex=>new THREE.Color(hex));
  for(let vertex=0;vertex<studio.mesh.geometry.attributes.position.count;vertex++)colorData.set(colors[vertex<18?0:1].toArray(),vertex*3);
  studio.mesh.geometry.setAttribute('color',new THREE.BufferAttribute(colorData,3));
  const original = studio.mesh.geometry.attributes.position.array.slice(),originalColor=colorData.slice();
  const source = await createSliceSourceInWorker(studio, { WorkerClass: BrowserWorker, yieldNow: async () => {} });
  assert.equal(source.triangles, 12); assert.deepEqual(source.toolColors, ['#23599c','#c89e59']);
  assert.equal((await geometryFacts(source)).triangles, 12);
  assert.deepEqual(studio.mesh.geometry.attributes.position.array, original);
  assert.ok(colorData.byteLength>0);assert.deepEqual(colorData,originalColor);
  await stopped;
});

test('surface material groups stay on one complete original mesh and encode correct whole-facet colors', async () => {
  const studio = studioFixture(); studio.root.remove(studio.mesh);
  const geometry = new THREE.BoxGeometry(.02, .02, .02), originalIndex = geometry.index.array.slice(), originalPositions = geometry.attributes.position.array.slice();
  geometry.groups.forEach((group, index) => group.materialIndex = index % 2);
  const mesh = new THREE.Mesh(geometry, [new THREE.MeshStandardMaterial({ color: '#ff3344' }), new THREE.MeshStandardMaterial({ color: '#2244ff' })]);
  studio.root.add(mesh);
  const source = createSliceSource(studio), facts = await geometryFacts(source);
  assert.equal(source.parts, 1, 'surface groups must never become independent open volume parts');
  assert.equal(facts.triangles, 12); assert.equal(facts.vertices.length, 24);
  const codes = [...facts.model.matchAll(/paint_color="([\da-f]+)"/gi)].map(match => match[1]);
  assert.deepEqual(codes, ['4', '4', '8', '8', '4', '4', '8', '8', '4', '4', '8', '8']);
  const triangle = [[0, 0, 0], [1, 0, 0], [0, 1, 0]];
  for (let tool = 0; tool < 16; tool++) {
    const leaf = decodePaintedTriangle(encodeWholeFacePaint(tool), triangle);
    assert.equal(leaf.length, 1); assert.equal(leaf[0].state, tool + 1); assert.deepEqual(leaf[0].vertices, triangle);
  }
  assert.deepEqual(geometry.index.array, originalIndex); assert.deepEqual(geometry.attributes.position.array, originalPositions);
});

test('actual native slicing of one closed multi-material mesh keeps volume, all layers, walls, sparse fill and both surface colors', {skip: !process.env.GROWTH_NATIVE_SLICER_TESTS}, async t => {
  try { await access(SLICE_SLICER, constants.X_OK); } catch { t.skip('Local native CLI is not installed.'); return; }
  const directory = await mkdtemp(path.join(tmpdir(), 'growth-closed-painted-native-'));
  const service = createSliceService({ root: directory, timeoutMs: 60_000 });
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  const orientation = new THREE.Group(), root = new THREE.Group(); orientation.add(root);
  const geometry = new THREE.BoxGeometry(.02, .02, .02); geometry.groups.forEach((group, index) => group.materialIndex = index % 2);
  const mesh = new THREE.Mesh(geometry, [new THREE.MeshStandardMaterial({ color: '#ff3344' }), new THREE.MeshStandardMaterial({ color: '#2244ff' })]); mesh.position.y = .01; root.add(mesh);
  const before = geometry.attributes.position.array.slice();
  const source = buildSliceSourceFromSnapshot(await captureSliceSourceSnapshot({ orientation, metadata: { name: 'closed painted 20 mm cube', sourceUnitsToMm: 1000 }, options: { preserveMaterials: true } }, { yieldNow: async () => {} }));
  assert.equal(source.parts, 1); assert.equal(source.triangles, 12);
  const created = await service.create(Buffer.from(await source.blob.arrayBuffer()), { format: '3mf', preset: 'h2c', toolColors: source.toolColors });
  let state;
  for (let attempt = 0; attempt < 800; attempt++) { state = service.snapshot(created.id); if (state.status !== 'running') break; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.equal(state.status, 'complete', state.message);
  const text = await readFile(await service.gcodeFile(created.id), 'utf8'), parsed = parsePrintLayerGCode(text);
  assert.equal(parsed.layerHeights.length, 125);
  assert.ok(Math.abs(parsed.layerHeights[0] - .2) < 1e-9);
  assert.ok(Math.abs(parsed.layerHeights[1] - parsed.layerHeights[0] - .16) < 1e-9);
  assert.ok(parsed.layerHeights.at(-1) >= 20 && parsed.layerHeights.at(-1) < 20 + .16, 'all original model height is sliced under the new nominal default');
  assert.deepEqual([...new Set(parsed.tools)].sort(), [0, 1]); assert.deepEqual(parsed.toolColors, ['#ff3344', '#2244ff']);
  for (const feature of ['innerWall', 'outerWall', 'sparseInfill', 'solidInfill', 'topSurface', 'bottomSurface']) assert.ok(parsed.featureCounts[feature] > 0, feature + ' paths are really present');
  assert.ok(Math.abs(parsed.bounds.max[0] - parsed.bounds.min[0] + .42 - 20) < .001);
  assert.ok(Math.abs(parsed.bounds.max[1] - parsed.bounds.min[1] + .42 - 20) < .001);
  assert.match(text, /; wall_loops = 2/); assert.match(text, /; sparse_infill_density = 15%/); assert.match(text, /; sparse_infill_pattern = grid/);
  assert.equal(state.geometrySimplified, false); assert.deepEqual(geometry.attributes.position.array, before);
});
