import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { deflateSync } from 'node:zlib';
import vm from 'node:vm';
import { createApp } from '../server.mjs';
import { BetaActivationError } from '../beta-activation.mjs';
import { findFFmpegPath } from '../runtime-paths.mjs';
import { FREE_WATERMARK_PATH, freeWatermarkArguments } from '../free-watermark.mjs';
import * as THREE from 'three';
import { createSceneRenderPackage } from '../src/scene-package.js';
import { createRealisticRenderService } from '../realistic-render.mjs';

const execFileAsync = promisify(execFile);
const FFMPEG = findFFmpegPath();
const options = { width: 320, height: 240, fps: 5, frames: 40, format: 'mp4', name: 'free-test' };

function png(width, height) {
  const crc32 = bytes => {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (name, data) => {
    const type = Buffer.from(name), bytes = Buffer.alloc(data.length + 12);
    bytes.writeUInt32BE(data.length); type.copy(bytes, 4); data.copy(bytes, 8);
    bytes.writeUInt32BE(crc32(Buffer.concat([type, data])), bytes.length - 4);
    return bytes;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.alloc(height * (width * 3 + 1)))), chunk('IEND', Buffer.alloc(0))]);
}

async function fixture(t, { activated = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'growth-free-watermark-'));
  const state = { activated }, realisticCalls = [], tasks = new Map();
  const fakeFile = path.join(root, 'mock-export.mp4');
  await writeFile(fakeFile, 'synthetic-export');
  const app = createApp({ root, ffmpegPath: FFMPEG,
    betaService: {
      status: async () => ({ activated: state.activated, installationId: randomUUID() }),
      requireActivation: async () => { if (!state.activated) throw new BetaActivationError('ACTIVATION_REQUIRED', '请先激活。', 403); },
    },
    paymentService: {},
    realisticRenderService: {
      active: false, close: async () => {}, health: async () => ({ available: true }),
      create: async (_body, settings) => {
        realisticCalls.push(settings);
        const job = { id: randomUUID(), format: settings.format, status: 'complete' };
        tasks.set(job.id, job); return job;
      },
      snapshot: id => tasks.get(id),
      file: async () => ({ path: fakeFile, name: 'mock-export.mp4' }),
      cancel: async id => ({ id, status: 'cancelled' }),
    },
  });
  await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = (route, method = 'GET', body, type = 'application/json') => fetch(base + route, {
    method, headers: { Origin: base, ...(body === undefined ? {} : { 'Content-Type': type }) },
    ...(body === undefined ? {} : { body: Buffer.isBuffer(body) ? body : JSON.stringify(body) }),
  });
  return { root, state, realisticCalls, request };
}

async function completedVideo(f, settings) {
  const response = await f.request('/api/exports', 'POST', settings);
  assert.equal(response.status, 201, await response.clone().text());
  const created = await response.json(), image = png(settings.width, settings.height);
  for (let frame = 0; frame < settings.frames; frame++) {
    const uploaded = await f.request(`/api/exports/${created.id}/frames?index=${frame}`, 'POST', image, 'image/png');
    assert.equal(uploaded.status, 200, await uploaded.clone().text());
  }
  const finished = await f.request(`/api/exports/${created.id}/finish`, 'POST');
  assert.equal(finished.status, 200, await finished.clone().text());
  const result = await finished.json(), download = await f.request(result.url);
  assert.equal(download.status, 200);
  const filename = path.join(f.root, `decoded-${created.id}.mp4`);
  await writeFile(filename, Buffer.from(await download.arrayBuffer()));
  const { stdout } = await execFileAsync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', filename,
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 });
  return { created, result, decoded: stdout };
}

function brightCentroid(frame, width, height) {
  let count = 0, sum = 0, above = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const index = (y * width + x) * 3;
    if (Math.max(frame[index], frame[index + 1], frame[index + 2]) > 50) {
      if (y < height / 2) above++;
      else { count++; sum += x; }
    }
  }
  return { count, above, x: sum / count };
}

test('brand asset is a PNG and watermark rejects invalid output dimensions', async () => {
  assert.deepEqual((await readFile(FREE_WATERMARK_PATH)).subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  for (const [width, height] of [[63, 64], [64, 63], [NaN, 64], [64, Infinity], [64.5, 64]]) {
    assert.throws(() => freeWatermarkArguments(width, height), TypeError);
  }
});

test('the actual exported permission wrapper forwards free-MP4 eligibility and never grants free transparent export', async () => {
  const nodes = new Map(), document = { body: { dataset: {} }, activeElement: null };
  const get = id => {
    if (nodes.has(id)) return nodes.get(id);
    const listeners = new Map();
    const node = {
      value: '', textContent: '', dataset: {}, disabled: false, hidden: false, open: false, isConnected: true,
      setAttribute() {}, classList: { toggle() {} },
      addEventListener(name, listener) { const list = listeners.get(name) || []; list.push(listener); listeners.set(name, list); },
      async dispatch(name) { await Promise.all((listeners.get(name) || []).map(listener => listener({ preventDefault() {} }))); },
      focus() { document.activeElement = this; }, showModal() { this.open = true; },
      close() { this.open = false; void this.dispatch('close'); },
    };
    nodes.set(id, node); return node;
  };
  document.getElementById = get; document.activeElement = get('export-action');
  const context = vm.createContext({ document, Response, AbortController, setTimeout, clearTimeout,
    fetch: async url => Response.json(url === '/api/beta/payment/order'
      ? { order: null, activated: false } : { activated: false, configured: true, reason: 'ACTIVATION_REQUIRED' }),
  });
  // Replace only the unrelated workbench loader; run the real controller and module wrapper together.
  const source = (await readFile(new URL('../src/beta-access.js', import.meta.url), 'utf8'))
    .replace("loadApp = () => import('./app.js')", 'loadApp = () => Promise.resolve()')
    .replaceAll('export function ', 'function ');
  vm.runInContext(source + '\nglobalThis.testExportPermission = ensureExportUnlocked;', context);
  const free = context.testExportPermission({ allowWatermarked: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(get('beta-gate').open, true); assert.equal(get('beta-free-export').hidden, false);
  await get('beta-free-export').dispatch('click'); assert.equal(await free, 'watermarked');
  const transparent = context.testExportPermission({ allowWatermarked: false });
  let settled = false; transparent.then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(get('beta-free-export').hidden, true);
  await get('beta-free-export').dispatch('click');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, 'a hidden or programmatically clicked free button cannot unlock transparent export');
  await get('beta-dismiss').dispatch('click'); assert.equal(await transparent, false);
});

test('unlicensed realtime API allows only explicitly watermarked MP4 and rejects caller-side watermark flags', async t => {
  const f = await fixture(t);
  for (const patch of [{}, { exportMode: 'unlocked' }, { watermarked: true }, { exportMode: 'unlocked', watermarked: true }]) {
    const response = await f.request('/api/exports', 'POST', { ...options, ...patch });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, 'ACTIVATION_REQUIRED');
  }
  for (const format of ['mov-alpha', 'png-sequence']) {
    for (const exportMode of ['watermarked', 'unlocked']) {
      const response = await f.request('/api/exports', 'POST', { ...options, format, exportMode });
      assert.equal(response.status, 403);
      assert.equal((await response.json()).error.code, exportMode === 'watermarked' ? 'FREE_EXPORT_FORMAT' : 'ACTIVATION_REQUIRED');
    }
  }
  const response = await f.request('/api/exports', 'POST', { ...options, exportMode: 'anything' });
  assert.equal(response.status, 400); assert.equal((await response.json()).error.code, 'INVALID_EXPORT_MODE');
});

test('real FFmpeg burns moving branding into every free MP4 frame and preserves an unmarked paid video', async t => {
  const f = await fixture(t);
  const free = await completedVideo(f, { ...options, exportMode: 'watermarked' });
  assert.equal(free.created.watermarked, true);
  const frameBytes = options.width * options.height * 3;
  assert.equal(free.decoded.length, frameBytes * options.frames, 'all requested frames survive the overlay');
  const centroids = [];
  for (let frame = 0; frame < options.frames; frame++) {
    const values = brightCentroid(free.decoded.subarray(frame * frameBytes, (frame + 1) * frameBytes), options.width, options.height);
    assert.ok(values.count > 100, `branding is burned into frame ${frame}`);
    assert.equal(values.above, 0, 'branding avoids the center and upper scene');
    centroids.push(values.x);
  }
  assert.ok(centroids.at(-1) - centroids[0] > 30, 'branding moves across the picture over time');
  assert.equal((await f.request(free.result.url, 'HEAD')).status, 200, 'free download is available without a license');
  assert.equal((await f.request(free.result.url + '?exportMode=unlocked')).status, 200);
  f.state.activated = true;
  const paid = await completedVideo(f, { ...options, frames: 1, exportMode: 'unlocked' });
  assert.equal(paid.created.watermarked, false);
  assert.equal(paid.decoded.length, frameBytes);
  assert.equal(brightCentroid(paid.decoded, options.width, options.height).count, 0, 'paid video contains no branding');
  f.state.activated = false;
  const locked = await f.request(paid.result.url + '?exportMode=watermarked');
  assert.equal(locked.status, 403, 'a query parameter cannot convert an existing paid job into a free job');
  assert.equal((await locked.json()).error.code, 'ACTIVATION_REQUIRED');
});

test('realistic exports record free eligibility on the server and keep unmarked or transparent exports locked', async t => {
  const f = await fixture(t), scene = Buffer.from('synthetic-scene');
  for (const suffix of ['', '?exportMode=unlocked', '?watermarked=true', '?exportMode=watermarked&format=mov-alpha', '?exportMode=watermarked&format=png-sequence']) {
    const response = await f.request('/api/realistic-exports' + suffix, 'POST', scene, 'application/zip');
    assert.equal(response.status, 403);
  }
  assert.equal(f.realisticCalls.length, 0, 'rejected requests never invoke the renderer');
  const response = await f.request('/api/realistic-exports?format=mp4&exportMode=watermarked', 'POST', scene, 'application/zip');
  assert.equal(response.status, 201);
  const free = await response.json(); assert.equal(free.watermarked, true);
  assert.equal(f.realisticCalls[0].watermarked, true);
  assert.equal((await f.request(`/api/realistic-exports/${free.id}`)).status, 200);
  for (const method of ['GET', 'HEAD']) assert.equal((await f.request(`/api/realistic-exports/${free.id}/file`, method)).status, 200);
  const guessed = await f.request(`/api/realistic-exports/${randomUUID()}/file?exportMode=watermarked`);
  assert.equal(guessed.status, 403, 'the server ignores free claims on unknown jobs');
  f.state.activated = true;
  const paid = await f.request('/api/realistic-exports?format=mp4&exportMode=unlocked', 'POST', scene, 'application/zip');
  assert.equal(paid.status, 201); const unlocked = await paid.json();
  assert.equal(f.realisticCalls[1].watermarked, false);
  f.state.activated = false;
  assert.equal((await f.request(`/api/realistic-exports/${unlocked.id}/file?exportMode=watermarked`)).status, 403);
});

test('realistic rendering sends all synthetic frames through the real FFmpeg dynamic-watermark encoder', async t => {
  globalThis.FileReader ||= class {
    readAsArrayBuffer(blob) { blob.arrayBuffer().then(result => { this.result = result; this.onloadend?.(); }); }
  };
  const root = await mkdtemp(path.join(tmpdir(), 'growth-realistic-watermark-'));
  const renderScript = path.join(root, 'synthetic-render.mjs');
  await writeFile(renderScript, `import fs from 'node:fs/promises'; import path from 'node:path';
const filename = process.argv.at(-1), cfg = JSON.parse(await fs.readFile(filename,'utf8'));
const image = Buffer.from('${png(options.width, options.height).toString('base64')}','base64');
for (let frame=0;frame<cfg.output.frames;frame++) {
  const name='frames'+String(frame).padStart(6,'0')+'.png';
  await fs.writeFile(path.join(path.dirname(filename),'frames',name),image);
  console.log(JSON.stringify({type:'progress',frame,frames:cfg.output.frames,path:name}));
  await new Promise(resolve=>setTimeout(resolve,5));
}
console.log(JSON.stringify({type:'complete',stats:{schemaVersion:1,originalTriangles:12,completeTriangles:12,sourceMeshes:1,materials:1,decimation:false,...cfg.output,projectionError:0.0000001,seconds:0.1}}));
`);
  const service = createRealisticRenderService({ root, blenderPath: process.execPath, ffmpegPath: FFMPEG,
    alphaEncoderProbe: async () => ({ available: false }),
    spawnImpl: (executable, args, settings) => args.includes('--python')
      ? spawn(process.execPath, [renderScript, args.at(-1)], settings) : spawn(executable, args, settings),
  });
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
  const group = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(.1, .1, .1), new THREE.MeshStandardMaterial({ color: '#23599c' }));
  mesh.position.y = .05; group.add(mesh);
  const camera = new THREE.PerspectiveCamera(40, options.width / options.height, .001, 10);
  camera.position.set(.2, .2, .3); camera.lookAt(0, .05, 0);
  const pack = await createSceneRenderPackage({ root: group, camera, mode: 'mesh', metadata: { format: 'glb' },
    units: { normalizedScale: 1, sourceUnitsToMm: 1000 }, floor: { width: 1, depth: 1 }, settings: { background: '#000000' },
  }, { output: { width: options.width, height: options.height, fps: options.fps, frames: options.frames, growthFrames: options.frames, samples: 64 } });
  const started = await service.create(Buffer.from(await pack.blob.arrayBuffer()), { format: 'mp4', watermarked: true });
  const deadline = Date.now() + 10_000;
  let result;
  do {
    result = service.snapshot(started.id);
    if (['complete', 'error', 'cancelled'].includes(result.status)) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  assert.equal(result.status, 'complete', result.failure || 'synthetic renderer did not complete');
  assert.equal(result.rendered, options.frames); assert.equal(result.encoded, options.frames);
  const file = await service.file(started.id);
  const { stdout } = await execFileAsync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', file.path,
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 });
  const frameBytes = options.width * options.height * 3;
  assert.equal(stdout.length, frameBytes * options.frames);
  const first = brightCentroid(stdout.subarray(0, frameBytes), options.width, options.height);
  const last = brightCentroid(stdout.subarray(-frameBytes), options.width, options.height);
  assert.ok(first.count > 100); assert.ok(last.count > 100); assert.ok(last.x - first.x > 30);
});
