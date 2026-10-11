import { findBlenderPath, findFFmpegPath } from '../runtime-paths.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import * as THREE from 'three';
import { zipSync, unzipSync, strToU8 } from 'three/addons/libs/fflate.module.js';
import { createSceneRenderPackage } from '../src/scene-package.js';
import { createRealisticRenderService, unpackRenderPackage, validateRenderConfig, validateRenderGLB, REALISTIC_PREVIEW_LIMITS } from '../realistic-render.mjs';

globalThis.FileReader ||= class { readAsArrayBuffer(blob) { blob.arrayBuffer().then(result => { this.result = result; this.onloadend?.(); }); } };
function crc32(bytes) { let crc = 0xffffffff; for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0); } return (crc ^ 0xffffffff) >>> 0; }
function png(width = 64, height = 64, alpha = true) {
  const chunk = (name, data) => { const result = Buffer.alloc(data.length + 12), type = Buffer.from(name); result.writeUInt32BE(data.length); type.copy(result, 4); data.copy(result, 8); result.writeUInt32BE(crc32(Buffer.concat([type, data])), result.length - 4); return result; };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = alpha ? 6 : 2;
  const channels = alpha ? 4 : 3, pixels = Buffer.alloc(height * (width * channels + 1));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const offset = y * (width * channels + 1) + 1 + x * channels; pixels.set(alpha ? [40, 100, 200, 255] : [40, 100, 200], offset); }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
let source;
async function packageBuffer(overrides = {}, filesOverride = null) {
  if (!source) {
    const root = new THREE.Group(); const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1), new THREE.MeshStandardMaterial({ color: '#23599c' })); mesh.position.y = 0.05; root.add(mesh);
    const camera = new THREE.PerspectiveCamera(40, 1, 0.001, 10); camera.position.set(0.2, 0.2, 0.3); camera.lookAt(0, 0.05, 0);
    const result = await createSceneRenderPackage({ root, camera, mode: 'mesh', metadata: { format: 'glb' }, units: { normalizedScale: 1, sourceUnitsToMm: 1000 }, floor: { width: 1, depth: 1 }, settings: { background: '#1c2128' } }, { output: { width: 64, height: 64, fps: 5, frames: 3, growthFrames: 3, samples: 64 } });
    source = unzipSync(new Uint8Array(await result.blob.arrayBuffer()));
  }
  const config = JSON.parse(Buffer.from(source['config.json']).toString());
  for (const [key, value] of Object.entries(overrides)) config[key] = value;
  return Buffer.from(zipSync({ ...source, 'config.json': strToU8(JSON.stringify(config)), ...filesOverride }, { level: 0 }));
}
async function previewPackage(progress = .35, outputOverrides = {}) {
  const files = unpackRenderPackage(await packageBuffer()), config = JSON.parse(files['config.json']);
  return packageBuffer({ output: { ...config.output, frames: 1, growthFrames: 1, fps: 1, samples: 64, durationSeconds: undefined, growthSeconds: undefined, previewProgress: progress, ...outputOverrides } });
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function changeGLBJSON(bytes, update) {
  const source = Buffer.from(bytes), oldLength = source.readUInt32LE(12), json = JSON.parse(source.toString('utf8', 20, 20 + oldLength).trim());
  update(json);
  const encoded = Buffer.from(JSON.stringify(json)), padded = Buffer.alloc(Math.ceil(encoded.length / 4) * 4, 32); encoded.copy(padded);
  const binary = source.subarray(20 + oldLength), header = Buffer.from(source.subarray(0, 12)), chunk = Buffer.alloc(8);
  header.writeUInt32LE(12 + 8 + padded.length + binary.length, 8); chunk.writeUInt32LE(padded.length); chunk.write('JSON', 4);
  return Buffer.concat([header, chunk, padded, binary]);
}
async function terminal(service, id, timeout = 5000) {
  const start = Date.now(); while (Date.now() - start < timeout) { const job = service.snapshot(id); if (['complete', 'error', 'cancelled'].includes(job.status)) { await sleep(40); return service.snapshot(id); } await sleep(10); }
  throw new Error('Mock render did not finish');
}
async function fixture(t, { renderMode = 'normal', encoderMode = 'normal', frameDelay = 15, renderAlpha = true, ...options } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'growth-realistic-'));
  const renderScript = path.join(root, 'render-test.mjs'), encoderScript = path.join(root, 'encoder-test.mjs');
  await writeFile(renderScript, `import fs from 'node:fs/promises'; import path from 'node:path';
const cfgPath = process.argv.at(-1), cfg = JSON.parse(await fs.readFile(cfgPath, 'utf8')); const folder = path.join(path.dirname(cfgPath), 'frames');
const mode = process.env.RENDER_TEST_MODE, delay = Number(process.env.RENDER_TEST_DELAY); console.log('Blender mock startup');
if (mode === 'hang') await new Promise(() => setInterval(() => {}, 1000));
for (let i=0; i<cfg.output.frames; i++) { await new Promise(r=>setTimeout(r,delay)); const filename='frames'+String(i).padStart(6,'0')+'.png'; const bytes = Buffer.from('${png(64,64,renderAlpha).toString('base64')}','base64'); await fs.writeFile(path.join(folder,filename), mode==='badpng'?bytes.subarray(0,40):bytes);
console.log(JSON.stringify({type:'progress',frame:mode==='order'?i+1:i,frames:cfg.output.frames,path:filename})); }
if (mode !== 'missing') console.log(JSON.stringify({type:'complete',stats:{schemaVersion:1,originalTriangles:12,completeTriangles:mode==='mesh-loss'?10:12,sourceMeshes:1,materials:1,decimation:false,...cfg.output,...(mode==='preview-progress-loss'?{previewProgress:1}:{}),projectionError:0.0000001,seconds:0.1,photoProtected:false,gradingScope:'model-only',capMode:'approximate-height-section',environmentMode:'artistic-area-light-proxy',shadowMode:'independent-rgb-catcher'}}));
if(mode==='failure') process.exit(7);
`);
  await writeFile(encoderScript, `import fs from 'node:fs'; const filename=process.argv.at(-1); const output=fs.createWriteStream(filename); let count=0;
if(process.env.ENCODER_TEST_MODE==='failure') setTimeout(()=>process.exit(9),25);
process.stdin.on('data',chunk=>{count+=chunk.length; output.write(chunk);}); process.stdin.on('end',()=>output.end(()=>{ if(!count) process.exit(3); }));
`);
  const spawns = [];
  const spawnImpl = (executable, args, opts) => {
    const render = args.includes('--python'); spawns.push({ render, executable, args });
    if (render) { assert.ok(args.includes('--disable-autoexec')); assert.ok(args.includes('--factory-startup')); assert.ok(args.includes('--python-exit-code')); assert.equal(args[args.indexOf('--python') + 1].endsWith('/scripts/render-cycles.py'), true); }
    return spawn(process.execPath, [render ? renderScript : encoderScript, args.at(-1)], { ...opts, env: { ...opts.env, RENDER_TEST_MODE: renderMode, RENDER_TEST_DELAY: String(frameDelay), ENCODER_TEST_MODE: encoderMode } });
  };
  const service = createRealisticRenderService({ root, blenderPath: process.execPath, ffmpegPath: process.execPath, spawnImpl, killGraceMs: 80, ...options });
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
  return { service, root, spawns };
}

test('ZIP guard accepts canonical files and rejects scripts, traversal, duplicate/bomb declarations and corrupt payloads', async () => {
  const buffer = await packageBuffer(); const files = unpackRenderPackage(buffer); assert.deepEqual(Object.keys(files), ['scene.glb', 'config.json']);
  for (const extra of ['../photo.png', '/tmp/scene.glb', 'render.py']) {
    const attacked = Buffer.from(zipSync({ ...source, [extra]: strToU8('payload') }, { level: 0 })); assert.throws(() => unpackRenderPackage(attacked), /路径|模型|配置|照片/);
  }
  const bomb = Buffer.from(buffer); const central = bomb.indexOf(Buffer.from([80, 75, 1, 2])); bomb.writeUInt32LE(0xffffffff, central + 24); assert.throws(() => unpackRenderPackage(bomb));
  const corrupt = Buffer.from(buffer); corrupt[80] ^= 1; assert.throws(() => unpackRenderPackage(corrupt), /校验/);
  const enormous = Buffer.from(zipSync({ 'scene.glb': new Uint8Array(1000), 'config.json': strToU8('{}') }, { level: 9 }));
  const position = enormous.indexOf(Buffer.from([80, 75, 1, 2])); enormous.writeUInt32LE(100, position + 24); assert.throws(() => unpackRenderPackage(enormous), /展开|声明|校验/);
});

test('finite output/camera, fixed paths, embedded GLB data and unsupported material extensions are validated', async () => {
  const files = unpackRenderPackage(await packageBuffer()), config = JSON.parse(files['config.json']);
  assert.equal(validateRenderConfig(config, files).sceneFile, 'scene.glb'); assert.deepEqual(validateRenderGLB(files['scene.glb']), { triangles: 12, objects: 1 });
  for (const change of [value => value.output.directory = '../exports', value => value.output.frames = 1801, value => value.camera.position[0] = Infinity, value => value.camera.quaternion = [0, 0, 0, 0], value => value.camera.effectiveSensorHeightMm *= 2, value => value.dof.fStop = 0, value => value.bounds.maxY = 0, value => value.background.transparent = 'yes']) {
    const invalid = structuredClone(config); change(invalid); assert.throws(() => validateRenderConfig(invalid, files));
  }
  const glb = Buffer.from(files['scene.glb']); glb.writeUInt32LE(glb.length - 1, 8); assert.throws(() => validateRenderGLB(glb), /完整/);
  for (const update of [value => value.accessors[0].count = 15000000, value => value.accessors[0].componentType = 9000, value => value.accessors[0].byteOffset = 1000000, value => value.bufferViews[value.accessors[0].bufferView].byteStride = 1, value => value.buffers[0].uri = 'https://example.test/model.bin', value => value.extensionsUsed = ['KHR_materials_dispersion']]) {
    assert.throws(() => validateRenderGLB(changeGLBJSON(files['scene.glb'], update)));
  }
});

test('successful MP4 preserves all ordered frames, finalizes only verified stats and uses private files', async t => {
  const { service, root, spawns } = await fixture(t);
  const started = await service.create(await packageBuffer(), { name: '测试模型', format: 'mp4' }); assert.equal(started.status, 'rendering');
  const result = await terminal(service, started.id); assert.equal(result.status, 'complete'); assert.equal(result.encoded, 3); assert.equal(result.rendered, 3); assert.equal(result.stats.originalTriangles, 12); assert.equal(result.stats.completeTriangles, 12);
  const file = await service.file(started.id); assert.equal(file.mime, 'video/mp4'); assert.match(file.name, /^测试模型-/); assert.ok(file.size > 0); assert.equal((await stat(file.path)).mode & 0o777, 0o600);
  assert.equal((await stat(path.join(root, 'exports', '.realistic-work'))).mode & 0o777, 0o700); assert.deepEqual(await readdir(path.join(root, 'exports', '.realistic-work')), []);
  assert.equal(JSON.stringify(result).includes(root), false); assert.equal(JSON.stringify(result).includes('material'), true); assert.equal(spawns.filter(item => item.render).length, 1);
  await service.cancel(started.id); assert.ok((await stat(file.path)).size > 0); await service.close(); assert.ok((await stat(file.path)).size > 0);
});

test('transparent realistic MOV requires transparent scene configuration and preserves ordered RGBA frames with ProRes alpha arguments', async t => {
  const { service, root, spawns } = await fixture(t, { alphaEncoderProbe: async () => ({ available: true }) });
  assert.equal((await service.health()).encoderAlphaAvailable, true);
  await assert.rejects(service.create(await packageBuffer(), { format: 'mov-alpha' }), { code: 'INVALID_RENDER_PACKAGE' });
  assert.equal(spawns.length, 0, 'opaque configuration is rejected before Cycles or encoder starts');
  const files = unpackRenderPackage(await packageBuffer()), config = JSON.parse(files['config.json']);
  const started = await service.create(await packageBuffer({ background: { ...config.background, transparent: true } }), { name: '透明写实.mov', format: 'mov-alpha' });
  const result = await terminal(service, started.id); assert.equal(result.status, 'complete', result.failure); assert.equal(result.encoded, 3); assert.equal(result.rendered, 3);
  const file = await service.file(started.id); assert.equal(file.mime, 'video/quicktime'); assert.match(file.name, /^透明写实-[^.]+\.mov$/);
  const args = spawns.find(item => !item.render).args;
  for (const [flag, value] of [['-c:v','prores_ks'],['-profile:v','4'],['-pix_fmt','yuva444p10le'],['-alpha_bits','16'],['-f','mov']]) {
    const index = flag === '-f' ? args.lastIndexOf(flag) : args.indexOf(flag); assert.equal(args[index + 1], value);
  }
  assert.equal((await stat(file.path)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(path.join(root, 'exports', '.realistic-work')), []);
});

test('realistic transparent MOV refuses missing alpha encoders and RGB render frames without finalizing a file', async t => {
  const noEncoder = await fixture(t, { alphaEncoderProbe: async () => ({ available: false }) });
  await assert.rejects(noEncoder.service.create(await packageBuffer(), { format: 'mov-alpha' }), { code: 'ALPHA_ENCODER_UNAVAILABLE' });
  assert.equal(noEncoder.spawns.length, 0);
  const rgbFrames = await fixture(t, { renderAlpha: false, alphaEncoderProbe: async () => ({ available: true }) });
  const files = unpackRenderPackage(await packageBuffer()), config = JSON.parse(files['config.json']);
  const started = await rgbFrames.service.create(await packageBuffer({ background: { ...config.background, transparent: true } }), { format: 'mov-alpha' });
  const result = await terminal(rgbFrames.service, started.id); assert.equal(result.status, 'error'); assert.equal(result.error, 'INVALID_RENDER_PACKAGE');
  await assert.rejects(rgbFrames.service.file(started.id), { code: 'REALISTIC_FILE_NOT_READY' });
  assert.deepEqual(await readdir(path.join(rgbFrames.root, 'exports')), ['.realistic-work']);
  assert.deepEqual(await readdir(path.join(rgbFrames.root, 'exports', '.realistic-work')), []);
});

test('PNG ZIP streams every ordered frame and metadata without an encoder process', async t => {
  const { service, spawns } = await fixture(t); const job = await service.create(await packageBuffer(), { format: 'png-sequence' });
  assert.equal((await terminal(service, job.id)).status, 'complete'); const file = await service.file(job.id); const entries = unzipSync(new Uint8Array(await readFile(file.path)));
  assert.deepEqual(Object.keys(entries), ['frame_000000.png', 'frame_000001.png', 'frame_000002.png', 'metadata.json']); assert.equal(spawns.some(item => !item.render), false);
});

test('single Cycles preview returns the requested growth PNG without encoder and can delete its completed private file', async t => {
  const { service, root, spawns } = await fixture(t, { ffmpegPath: '/missing/ffmpeg' });
  const started = await service.create(await previewPackage(.35), { format: 'preview', name: '当前画面' });
  const result = await terminal(service, started.id);
  assert.equal(result.status, 'complete'); assert.equal(result.format, 'preview'); assert.equal(result.rendered, 1); assert.equal(result.encoded, 1); assert.equal(result.total, 1);
  assert.equal(result.previewProgress, .35); assert.equal(result.stats.previewProgress, .35); assert.equal(result.stats.originalTriangles, 12); assert.equal(result.stats.completeTriangles, 12);
  assert.equal(result.url, `/api/realistic-previews/${started.id}/file`);
  const file = await service.file(started.id, { preview: true });
  assert.equal(file.mime, 'image/png'); assert.match(file.path, /exports\/\.realistic-work\/[^/]+\.png$/); assert.deepEqual(await readFile(file.path), png());
  assert.equal((await stat(file.path)).mode & 0o777, 0o600); assert.equal(spawns.length, 1); assert.equal(spawns[0].render, true);
  assert.deepEqual(await readdir(path.join(root, 'exports')), ['.realistic-work']);
  const deleted = await service.cancel(started.id, { preview: true }); assert.equal(deleted.status, 'cancelled'); assert.equal(deleted.url, null); assert.equal(deleted.filename, null);
  await assert.rejects(stat(file.path), { code: 'ENOENT' }); await assert.rejects(service.file(started.id), { code: 'REALISTIC_FILE_NOT_READY' });
  assert.deepEqual(await readdir(path.join(root, 'exports', '.realistic-work')), []);
});

test('preview limits and output progress are required, finite, and unavailable on export jobs', async t => {
  const { service, spawns } = await fixture(t);
  const files = unpackRenderPackage(await previewPackage()), config = JSON.parse(files['config.json']);
  assert.equal(validateRenderConfig(config, files, { preview: true }).output.previewProgress, .35);
  assert.deepEqual((await service.health()).previewLimits, REALISTIC_PREVIEW_LIMITS);
  assert.throws(() => validateRenderConfig(config, files), { code: 'INVALID_RENDER_PACKAGE' });
  for (const patch of [{ previewProgress: undefined }, { previewProgress: -.01 }, { previewProgress: 1.01 }, { previewProgress: null }, { previewProgress: '0.35' }, { frames: 2 }, { growthFrames: 2 }, { fps: 2 }, { samples: 128 }, { durationSeconds: 1, growthSeconds: 1 }, { width: 1602 }, { height: 1602 }, { width: 1600, height: 1002 }]) {
    const changed = structuredClone(config); Object.assign(changed.output, patch);
    assert.throws(() => validateRenderConfig(changed, files, { preview: true }), { code: 'INVALID_RENDER_PACKAGE' });
  }
  for (const progress of [0, 1]) { const changed = structuredClone(config); changed.output.previewProgress = progress; assert.equal(validateRenderConfig(changed, files, { preview: true }).output.previewProgress, progress); }
  await assert.rejects(service.create(await previewPackage(), { format: 'mp4' }), { code: 'INVALID_RENDER_PACKAGE' });
  await assert.rejects(service.create(await packageBuffer(), { format: 'preview' }), { code: 'INVALID_RENDER_PACKAGE' });
  assert.equal(spawns.length, 0);
});

test('preview and export route kinds cannot access or delete each other and share the same bounded worker', async t => {
  const { service, spawns } = await fixture(t, { frameDelay: 300 });
  const preview = await service.create(await previewPackage(), { format: 'preview' });
  const exported = await service.create(await packageBuffer(), { format: 'png-sequence' });
  assert.equal(exported.status, 'queued'); assert.equal(spawns.length, 1);
  await assert.rejects(service.create(await previewPackage(), { format: 'preview' }), { code: 'REALISTIC_RENDER_BUSY' });
  assert.throws(() => service.snapshot(preview.id, { preview: false }), { code: 'REALISTIC_EXPORT_NOT_FOUND' });
  await assert.rejects(service.cancel(exported.id, { preview: true }), { code: 'REALISTIC_EXPORT_NOT_FOUND' });
  await assert.rejects(service.file(preview.id, { preview: false }), { code: 'REALISTIC_EXPORT_NOT_FOUND' });
  assert.equal(service.snapshot(exported.id).status, 'queued');
  await service.cancel(exported.id); await service.cancel(preview.id);
});

test('preview cancellation during atomic rename removes the verified PNG while close removes remaining previews and preserves exports', async t => {
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; }), gate = new Promise(resolve => { release = resolve; });
  let gateUsed = false;
  const { service, root } = await fixture(t, { renameImpl: async (from, to) => { if (!gateUsed) { gateUsed = true; enter(); await gate; } await rename(from, to); } });
  const preview = await service.create(await previewPackage(), { format: 'preview' }); await entered;
  const cancellation = service.cancel(preview.id, { preview: true }); release(); assert.equal((await cancellation).status, 'cancelled');
  assert.deepEqual(await readdir(path.join(root, 'exports', '.realistic-work')), []);
  const next = await service.create(await previewPackage(), { format: 'preview' }); await terminal(service, next.id); const previewFile = await service.file(next.id);
  const exported = await service.create(await packageBuffer(), { format: 'png-sequence' }); await terminal(service, exported.id); const exportFile = await service.file(exported.id);
  await service.close(); await assert.rejects(stat(previewFile.path), { code: 'ENOENT' }); assert.ok((await stat(exportFile.path)).size > 0);
});

test('preview face loss, incomplete PNG and incorrect growth cannot commit a final image', async t => {
  for (const renderMode of ['mesh-loss', 'badpng', 'preview-progress-loss']) {
    await t.test(renderMode, async t => {
      const { service, root } = await fixture(t, { renderMode }); const started = await service.create(await previewPackage(), { format: 'preview' });
      const result = await terminal(service, started.id); assert.equal(result.status, 'error'); assert.equal(result.error, 'INVALID_RENDER_PACKAGE');
      await assert.rejects(service.file(started.id), { code: 'REALISTIC_FILE_NOT_READY' }); assert.deepEqual(await readdir(path.join(root, 'exports', '.realistic-work')), []);
    });
  }
});

test('one GPU worker runs at once, queue is bounded, cancellation clears queued and active data', async t => {
  const { service, root, spawns } = await fixture(t, { frameDelay: 300 }); const buffer = await packageBuffer();
  const first = await service.create(buffer); const second = await service.create(buffer); assert.equal(second.status, 'queued'); assert.equal(spawns.filter(item => item.render).length, 1);
  await assert.rejects(service.create(buffer), error => error.status === 409 && error.code === 'REALISTIC_RENDER_BUSY');
  assert.equal((await service.cancel(second.id)).status, 'cancelled'); assert.equal((await service.cancel(first.id)).status, 'cancelled');
  assert.deepEqual(await readdir(path.join(root, 'exports', '.realistic-work')), []);
  await assert.rejects(service.file(first.id), error => error.status === 409);
});

test('cancellation during atomic final rename waits for the verified commit and preserves the completed export', async t => {
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const { service } = await fixture(t, { renameImpl: async (from, to) => { enter(); await gate; await rename(from, to); } });
  const job = await service.create(await packageBuffer()); await entered;
  const cancellation = service.cancel(job.id); release();
  assert.equal((await cancellation).status, 'complete'); const file = await service.file(job.id); assert.ok((await stat(file.path)).size > 0);
});

test('missing worker runtime reports an explicit fast-render fallback without spawning', async t => {
  const { service, spawns } = await fixture(t, { blenderPath: '/missing/blender-runtime' }); const health = await service.health(); assert.equal(health.available, false); assert.match(health.reason, /实时导出/);
  await assert.rejects(service.create(await packageBuffer()), error => error.status === 503 && error.code === 'REALISTIC_RENDER_UNAVAILABLE'); assert.equal(spawns.length, 0);
});

for (const [title, options, code] of [
  ['out-of-order frames', { renderMode: 'order' }, 'FRAME_ORDER_ERROR'],
  ['missing completion', { renderMode: 'missing' }, 'RENDER_INCOMPLETE'],
  ['nonzero renderer exit after completion', { renderMode: 'failure' }, 'RENDER_INCOMPLETE'],
  ['source face loss', { renderMode: 'mesh-loss' }, 'INVALID_RENDER_PACKAGE'],
  ['incomplete PNG', { renderMode: 'badpng' }, 'INVALID_RENDER_PACKAGE'],
  ['encoder process failure', { encoderMode: 'failure', frameDelay: 30 }, 'ENCODER_FAILED'],
  ['stalled render', { renderMode: 'hang', stallTimeoutMs: 80 }, 'RENDER_STALLED'],
  ['absolute timeout', { renderMode: 'hang', timeoutMs: 80, stallTimeoutMs: 500 }, 'RENDER_TIMEOUT'],
  ['bounded final output', { maxOutputBytes: 40 }, 'RENDER_OUTPUT_LIMIT'],
]) test(`${title} cannot produce a final file and cleans temporary assets`, async t => {
  const { service, root } = await fixture(t, options); const job = await service.create(await packageBuffer()); const result = await terminal(service, job.id);
  assert.equal(result.status, 'error'); assert.equal(result.error, code); await assert.rejects(service.file(job.id), error => error.status === 409);
  assert.equal((await readdir(path.join(root, 'exports'))).some(name => name.endsWith('.mp4')), false); assert.deepEqual(await readdir(path.join(root, 'exports', '.realistic-work')), []);
});

test('actual Blender three-frame cube reaches verified MP4 with no dropped frame', { skip: !process.env.GROWTH_HQ_SMOKE, timeout: 180000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'growth-hq-smoke-'));
  let logs = '';
  const debugSpawn = (exe, args, options) => { const child = spawn(exe, args, options); child.stderr?.on('data', value => { logs = (logs + value.toString()).slice(-16000); }); child.stdout?.on('data', value => { logs = (logs + value.toString()).slice(-16000); }); return child; };
  const service = createRealisticRenderService({ root, blenderPath: process.env.GROWTH_TEST_BLENDER || findBlenderPath(), ffmpegPath: findFFmpegPath(), timeoutMs: 120000, stallTimeoutMs: 60000, spawnImpl: debugSpawn });
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
  const started = await service.create(await packageBuffer()); const result = await terminal(service, started.id, 150000); assert.equal(result.status, 'complete', JSON.stringify(result) + '\n' + logs); assert.equal(result.encoded, 3); assert.equal(result.stats.decimation, false);
  const file = await service.file(started.id); assert.ok(file.size > 1000);
});
