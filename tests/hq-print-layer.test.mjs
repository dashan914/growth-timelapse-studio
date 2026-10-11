import { findBlenderPath, findFFmpegPath } from '../runtime-paths.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import * as THREE from 'three';
import { unzipSync, strFromU8 } from 'three/addons/libs/fflate.module.js';
import { parsePrintLayerGCode, PRINTER_MM_TO_THREE_MM } from '../src/print-layer.js';
import { packRenderPrintLayer, createSceneRenderPackage } from '../src/scene-package.js';
import { createRealisticRenderService, validateRenderPrintLayer, validateRenderConfig, validateRenderGLB, unpackRenderPackage } from '../realistic-render.mjs';

globalThis.FileReader ||= class { readAsArrayBuffer(blob) { blob.arrayBuffer().then(result => { this.result = result; this.onloadend?.(); }); } };
function fixture() {
  const lines = [';filament_colour = #c89e59;#23599c', 'G21', 'G90', 'M83'];
  for (const z of [2, 4, 6, 8, 10]) {
    lines.push(';HEIGHT:2', ';WIDTH:4', ';TYPE:Outer wall', 'T0', `G0 X-8 Y-8 Z${z}`, 'G1 X8 Y-8 E1', 'G1 X8 Y8 E1', 'G1 X-8 Y8 E1', 'G1 X-8 Y-8 E1');
    lines.push(';WIDTH:2', ';TYPE:Inner wall', 'T1', `G0 X-4 Y-4 Z${z}`, 'G1 X4 Y-4 E1', 'G1 X4 Y4 E1', 'G1 X-4 Y4 E1', 'G1 X-4 Y-4 E1');
    lines.push(';WIDTH:1', ';TYPE:Sparse infill', `G0 X-4 Y0 Z${z}`, 'G1 X4 Y0 E1', `G0 X0 Y-4 Z${z}`, 'G1 X0 Y4 E1');
  }
  const parsed = parsePrintLayerGCode(lines.join('\n'));
  const root = new THREE.Group(), material = new THREE.MeshStandardMaterial({ color: '#f0e8d6', roughness: .64 });
  const model = new THREE.Mesh(new THREE.BoxGeometry(20, 10, 20), material); model.position.y = 5; root.add(model);
  const transient = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material); transient.userData.growthPrintLayer = true; transient.userData.growthTransient = true; root.add(transient);
  const camera = new THREE.PerspectiveCamera(45, 4 / 3, .1, 1000); camera.position.set(35, 32, 42); camera.lookAt(0, 4, 0);
  const layer = { parsed, printerToSource: Float64Array.from(PRINTER_MM_TO_THREE_MM), sourceToWorld: new THREE.Matrix4().toArray(), toolColors: parsed.toolColors, historyLayers: 3 };
  return { root, model, transient, camera, mode: 'mesh', units: { normalizedScale: 1, sourceUnitsToMm: 1 }, metadata: { format: '3mf' }, floor: { width: 80, depth: 80 }, settings: { layerLines: false, surfaceDetail: 0, floor: true, ambientIntensity: 1, keyIntensity: 2, shadowOpacity: .3 }, printLayer: layer };
}
async function packageFixture() {
  const snapshot = fixture();
  const result = await createSceneRenderPackage(snapshot, { output: { width: 320, height: 240, fps: 5, frames: 5, growthFrames: 5, samples: 64 } });
  const bytes = Buffer.from(await result.blob.arrayBuffer()), entries = unpackRenderPackage(bytes);
  return { snapshot, result, entries, config: JSON.parse(entries['config.json']) };
}

test('HQ stores every actual path once in a complete indexed binary, uses explicit metric transform and excludes transient preview geometry', async () => {
  const { snapshot, result, entries, config } = await packageFixture();
  assert.equal(config.growth.mode, 'sliced-gcode'); assert.equal(config.capabilities.triangles, 12); assert.deepEqual(validateRenderGLB(entries['scene.glb']), { triangles: 12, objects: 1 });
  assert.equal(config.printLayer.segmentCount, 50); assert.equal(config.printLayer.layerCount, 5); assert.equal(config.printLayer.maxWindowSegments, 30);
  assert.equal(config.printLayer.crossSection, 'stadium-with-elliptical-fallback');
  assert.deepEqual(config.printLayer.palette, [{ tool: 0, color: '#c89e59' }, { tool: 1, color: '#23599c' }]);
  const transformed = new THREE.Vector3(1, 2, 3).applyMatrix4(new THREE.Matrix4().fromArray(config.printLayer.printerToMetres));
  assert.deepEqual(transformed.toArray(), [.001, .003, -.002]);
  for (const [name, spec] of Object.entries(config.printLayer.arrays)) {
    const original = snapshot.printLayer.parsed[name];
    assert.deepEqual(entries['print-layer.bin'].subarray(spec.byteOffset, spec.byteOffset + spec.byteLength), Buffer.from(original.buffer, original.byteOffset, original.byteLength), `Original ${name} is unchanged`);
  }
  assert.equal(snapshot.root.children.includes(snapshot.transient), true); assert.equal(snapshot.model.geometry.attributes.position.count, 24);
  assert.deepEqual(validateRenderPrintLayer(config.printLayer, entries), { segments: 50, layers: 5, maxWindowSegments: 30 });
  assert.equal(validateRenderConfig(config, entries).printLayer.source, 'sliced-gcode');
  assert.ok(result.blob.size > entries['print-layer.bin'].length);
});

test('HQ rejects truncated spans, duplicate/wrong layer indexes, unknown roles, missing colors, nonfinite widths and singular mapping before native import', async () => {
  const { config, entries } = await packageFixture();
  for (const mutate of [m => m.arrays.positions.count--, m => m.arrays.tools.byteOffset++, m => m.palette.pop(), m => m.printerToMetres.fill(0), m => m.historyLayers = 33, m => m.maxWindowSegments--, m => m.file = '../private.bin']) {
    const manifest = structuredClone(config.printLayer); mutate(manifest); assert.throws(() => validateRenderPrintLayer(manifest, entries));
  }
  for (const change of [
    (b, m) => b.writeFloatLE(NaN, m.arrays.widths.byteOffset),
    (b, m) => b.writeUInt32LE(0, m.arrays.layerSegments.byteOffset + 4),
    (b, m) => b.writeUInt32LE(4, m.arrays.layers.byteOffset),
    (b, m) => b.writeUInt8(14, m.arrays.features.byteOffset),
    (b, m) => b.writeUInt16LE(100, m.arrays.tools.byteOffset),
  ]) {
    const binary = Buffer.from(entries['print-layer.bin']); change(binary, config.printLayer);
    assert.throws(() => validateRenderPrintLayer(config.printLayer, { ...entries, 'print-layer.bin': binary }));
  }
  assert.throws(() => validateRenderPrintLayer(null, entries));
  assert.throws(() => packRenderPrintLayer({ ...fixture().printLayer, sourceToWorld: new THREE.Matrix4().makeScale(0, 1, 1).toArray() }, .001), /不可逆/);
});

test('full support paths stay in binary while hidden; unsupported historical HQ support is rejected explicitly', () => {
  const layer = fixture().printLayer; layer.parsed.features[0] = 10; layer.parsed.features[1] = 16;
  const packed = packRenderPrintLayer(layer, .001, { includeSupport: false });
  assert.equal(packed.manifest.segmentCount, 50); assert.equal(packed.manifest.modelSegments, 49); assert.equal(packed.manifest.supportSegments, 1);
  assert.equal(packed.bytes[packed.manifest.arrays.features.byteOffset], 10);
  assert.deepEqual(validateRenderPrintLayer(packed.manifest, { 'print-layer.bin': packed.bytes }), { segments: 50, layers: 5, maxWindowSegments: 30 });
  assert.throws(() => packRenderPrintLayer(layer, .001, { includeSupport: true }), /历史支撑/);
  assert.throws(() => validateRenderPrintLayer({ ...packed.manifest, includeSupport: true }, { 'print-layer.bin': packed.bytes }), /历史支撑/);
});

test('uniform display and per-tool overrides change bead colors without changing original paths, tool ids or saved palette', () => {
  const layer = fixture().printLayer, before = [...layer.parsed.toolColors], tools = layer.parsed.tools.slice();
  const uniform = packRenderPrintLayer(layer, .001, { preserveMaterials: false, color: '#abcdef' });
  assert.equal(uniform.manifest.colorMode, 'uniform-display'); assert.deepEqual(uniform.manifest.palette.map(item => item.color), ['#abcdef', '#abcdef']);
  validateRenderPrintLayer(uniform.manifest, { 'print-layer.bin': uniform.bytes });
  const override = packRenderPrintLayer({ ...layer, toolColors: ['#123456', '#654321'] }, .001);
  assert.deepEqual(override.manifest.palette.map(item => item.color), ['#123456', '#654321']);
  assert.deepEqual(layer.parsed.toolColors, before); assert.deepEqual(layer.parsed.tools, tools);
});

test('Python worker independently validates the same binary and rejects corrupt indexes without loading Blender', async () => {
  const { config, entries } = await packageFixture(); const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'growth-hq-print-'));
  try {
    for (const [name, bytes] of Object.entries(entries)) await fs.writeFile(path.join(dir, name), bytes);
    const script = path.resolve('scripts/render-cycles.py');
    const verify = () => spawnSync('python3', ['-B', '-c', "import runpy,sys,json\nf=runpy.run_path(sys.argv[1]);c=f['validate_config'](sys.argv[2]);print(json.dumps({'segments':c['_print']['count'],'layers':c['_print']['layers']}))", script, path.join(dir, 'config.json')], { encoding: 'utf8' });
    const passed = verify(); assert.equal(passed.status, 0, passed.stderr); assert.deepEqual(JSON.parse(passed.stdout), { segments: 50, layers: 5 });
    const corrupt = Buffer.from(entries['print-layer.bin']); corrupt.writeUInt32LE(0, config.printLayer.arrays.layerSegments.byteOffset + 4); await fs.writeFile(path.join(dir, 'print-layer.bin'), corrupt);
    assert.notEqual(verify().status, 0);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('stadium profile has exact W/H and broad inter-layer contact; bridge/too-narrow roads and legacy packages use explicit ellipses', async () => {
  const script = path.resolve('scripts/render-cycles.py');
  const run = spawnSync('python3', ['-B', '-c', "import runpy,sys,json\nf=runpy.run_path(sys.argv[1])['print_bead_profile'];print(json.dumps([f(.42,.12,1),f(.42,.12,7),f(.1,.12,1),f(.42,.12,1,'elliptical-bead-12-sides')]))", script], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr); const [stadium, bridge, narrow, legacy] = JSON.parse(run.stdout);
  assert.equal(stadium[1], 'stadium'); assert.equal(stadium[0].length, 14);
  const xs = stadium[0].map(point => point[0]), zs = stadium[0].map(point => point[1]);
  assert.ok(Math.abs(Math.max(...xs) - Math.min(...xs) - .42) < 1e-10); assert.ok(Math.abs(Math.max(...zs) - Math.min(...zs) - .12) < 1e-10);
  const top = stadium[0].filter(point => Math.abs(point[1] - .06) < 1e-10).map(point => point[0]);
  assert.equal(top.length, 2); assert.ok(Math.abs(Math.max(...top) - Math.min(...top) - .3) < 1e-10);
  let twiceArea = 0; const points = stadium[0]; for (let index = 0; index < points.length; index++) { const a = points[index], b = points[(index + 1) % points.length]; twiceArea += a[0] * b[1] - b[0] * a[1]; }
  const analytic = .12 * (.42 - .12) + Math.PI * .12 ** 2 / 4; assert.ok(Math.abs(Math.abs(twiceArea) / 2 / analytic - 1) < .02);
  assert.equal(bridge[1], 'elliptical-fallback'); assert.equal(narrow[1], 'elliptical-fallback'); assert.equal(legacy[1], 'legacy-ellipse');
  const { config, entries } = await packageFixture(); validateRenderPrintLayer({ ...config.printLayer, crossSection: 'elliptical-bead-12-sides' }, entries);
});

test('actual Cycles sliced growth keeps every source face and shows actual multicolor wall/infill windows without synthetic caps', { skip: !process.env.GROWTH_TEST_BLENDER, timeout: 120000 }, async () => {
  const { entries } = await packageFixture();
  const saved = process.env.GROWTH_HQ_PRINT_ARTIFACTS;
  const dir = saved ? path.resolve(saved) : await fs.mkdtemp(path.join(os.tmpdir(), 'growth-hq-print-render-'));
  try {
    await fs.mkdir(dir, { recursive: true }); for (const [name, bytes] of Object.entries(entries)) await fs.writeFile(path.join(dir, name), bytes);
    const run = spawnSync(process.env.GROWTH_TEST_BLENDER, ['--background', '--factory-startup', '--disable-autoexec', '--python-exit-code', '1', '--python', path.resolve('scripts/render-cycles.py'), '--', path.join(dir, 'config.json')], { encoding: 'utf8', timeout: 100000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, BLENDER_USER_CONFIG: path.join(dir, 'blender-config'), BLENDER_USER_SCRIPTS: path.join(dir, 'blender-scripts'), BLENDER_USER_DATAFILES: path.join(dir, 'blender-data') } });
    assert.equal(run.status, 0, run.stdout.slice(-6000) + run.stderr);
    const events = run.stdout.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line)); const stats = events.find(event => event.type === 'complete').stats;
    assert.equal(stats.originalTriangles, 12); assert.equal(stats.completeTriangles, 12); assert.equal(stats.sourceGeometryUnchanged, true); assert.equal(stats.decimation, false);
    assert.equal(stats.capMode, 'sliced-gcode'); assert.equal(stats.capOnlyTrianglesPeak, 0); assert.equal(stats.printSegments, 50); assert.equal(stats.printLayerCount, 5); assert.equal(stats.printWindowSegmentsPeak, 30);
    assert.deepEqual(events.filter(event => event.type === 'progress').map(event => event.layerIndex), [-1, 0, 1, 2, 4]);
    assert.deepEqual(stats.printWindows.map(window => window.segments), [0, 10, 20, 30, 0]);
    assert.ok(stats.printRoleCountsPeak['1'] > 0 && stats.printRoleCountsPeak['2'] > 0 && stats.printRoleCountsPeak['3'] > 0);
    assert.equal(stats.printCrossSection, 'stadium-with-elliptical-fallback'); assert.equal(stats.printProfileCountsPeak.stadium, 24); assert.equal(stats.printProfileCountsPeak['elliptical-fallback'], 6);
    const frames = await fs.readdir(path.join(dir, 'frames')); assert.equal(frames.filter(name => name.endsWith('.png')).length, 5);
    assert.notDeepEqual(await fs.readFile(path.join(dir, 'frames/frames000000.png')), await fs.readFile(path.join(dir, 'frames/frames000002.png')));
  } finally { if (!saved) await fs.rm(dir, { recursive: true, force: true }); }
});

test('actual indexed slice ZIP reaches a verified native Cycles MP4 through production service', { skip: !process.env.GROWTH_HQ_SMOKE, timeout: 150000 }, async () => {
  const { result } = await packageFixture(); const root = await fs.mkdtemp(path.join(os.tmpdir(), 'growth-sliced-service-'));
  const service = createRealisticRenderService({ root, blenderPath: process.env.GROWTH_TEST_BLENDER || findBlenderPath(), timeoutMs: 120000, stallTimeoutMs: 60000 });
  try {
    const created = await service.create(Buffer.from(await result.blob.arrayBuffer()), { name: 'actual-indexed-slice', format: 'mp4' });
    let state; const until = Date.now() + 130000;
    while (Date.now() < until) { state = service.snapshot(created.id); if (['complete', 'error', 'cancelled'].includes(state.status)) break; await new Promise(resolve => setTimeout(resolve, 200)); }
    assert.equal(state.status, 'complete', JSON.stringify(state)); assert.equal(state.encoded, 5); assert.equal(state.rendered, 5);
    assert.equal(state.stats.capMode, 'sliced-gcode'); assert.equal(state.stats.printSegments, 50); assert.equal(state.stats.printLayerCount, 5); assert.equal(state.stats.sourceGeometryUnchanged, true); assert.equal(state.stats.capOnlyTrianglesPeak, 0);
    const file = await service.file(created.id); assert.ok(file.size > 1000); assert.equal(file.mime, 'video/mp4');
    if (process.env.GROWTH_HQ_PRINT_ARTIFACTS) {
      const artifacts = path.resolve(process.env.GROWTH_HQ_PRINT_ARTIFACTS); await fs.mkdir(artifacts, { recursive: true });
      await fs.copyFile(file.path, path.join(artifacts, 'sliced-service-smoke.mp4'));
      await fs.writeFile(path.join(artifacts, 'sliced-service-smoke.json'), JSON.stringify(state, null, 2) + '\n');
    }
  } finally { await service.close(); await fs.rm(root, { recursive: true, force: true }); }
});
