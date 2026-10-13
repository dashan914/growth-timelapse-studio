import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
import { createExportUnlockController } from '../src/beta-access.js';

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

function watermarkPixels(frame, width, height) {
  let count = 0, sumX = 0, sumY = 0, maxBrightness = 0;
  let left = width, top = height, right = -1, bottom = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const index = (y * width + x) * 3;
    const brightness = Math.max(frame[index], frame[index + 1], frame[index + 2]);
    maxBrightness = Math.max(maxBrightness, brightness);
    if (brightness > 10) {
      count++; sumX += x; sumY += y;
      left = Math.min(left, x); right = Math.max(right, x);
      top = Math.min(top, y); bottom = Math.max(bottom, y);
    }
  }
  return { count, x: count ? sumX / count : null, y: count ? sumY / count : null, maxBrightness,
    bbox: { left, top, right, bottom, width: count ? right - left + 1 : 0, height: count ? bottom - top + 1 : 0 } };
}

function assertSubtleMovingWatermark(decoded, width, height, frames, label) {
  const frameBytes = width * height * 3, metrics = [];
  assert.equal(decoded.length, frameBytes * frames, `${label}: all requested frames survive the encoder`);
  for (let frame = 0; frame < frames; frame++) {
    const pixels = watermarkPixels(decoded.subarray(frame * frameBytes, (frame + 1) * frameBytes), width, height);
    assert.ok(pixels.count > 100, `${label}: visible branding is burned into frame ${frame}`);
    assert.ok(pixels.bbox.width <= width * .25 + 4, `${label}: the watermark stays compact rather than spanning the picture`);
    assert.ok(pixels.maxBrightness < 110, `${label}: the branding remains subtle against black instead of opaque white`);
    assert.ok(pixels.bbox.left >= width * .1 && pixels.bbox.right < width * .9
      && pixels.bbox.top >= height * .1 && pixels.bbox.bottom < height * .9,
    `${label}: cropping ten percent from every edge retains the entire watermark in frame ${frame}`);
    metrics.push(pixels);
  }
  const xRange = Math.max(...metrics.map(value => value.x)) - Math.min(...metrics.map(value => value.x));
  const yRange = Math.max(...metrics.map(value => value.y)) - Math.min(...metrics.map(value => value.y));
  assert.ok(xRange > width * .08, `${label}: branding moves horizontally over the encoded sequence`);
  assert.ok(yRange > height * .04, `${label}: branding also moves vertically over the encoded sequence`);
  let maxStepX = 0, maxStepY = 0;
  for (let frame = 1; frame < metrics.length; frame++) {
    maxStepX = Math.max(maxStepX, Math.abs(metrics[frame].x - metrics[frame - 1].x));
    maxStepY = Math.max(maxStepY, Math.abs(metrics[frame].y - metrics[frame - 1].y));
  }
  assert.ok(maxStepX < width * .025 && maxStepY < height * .025, `${label}: adjacent frames move gradually without abrupt repositioning`);
  return { frames, first: metrics[0], last: metrics.at(-1), xRange, yRange, maxStepX, maxStepY,
    minVisiblePixels: Math.min(...metrics.map(value => value.count)),
    maxBBoxWidth: Math.max(...metrics.map(value => value.bbox.width)),
    maxBrightness: Math.max(...metrics.map(value => value.maxBrightness)) };
}

test('brand asset is a PNG and watermark rejects invalid output dimensions', async () => {
  assert.deepEqual((await readFile(FREE_WATERMARK_PATH)).subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  for (const [width, height] of [[63, 64], [64, 63], [NaN, 64], [64, Infinity], [64.5, 64]]) {
    assert.throws(() => freeWatermarkArguments(width, height), TypeError);
  }
});

test('the served workbench and permission controller start without preview branding for both free and activated users', async t => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const styles = await Promise.all(['style.css', 'beta-access.css'].map(name => readFile(new URL('../src/' + name, import.meta.url), 'utf8')));
  assert.equal(/free-watermark(?:-preview|\.png)/i.test(html), false, 'the actual workbench HTML must contain no preview branding image, including before any license check');
  for (const css of styles) assert.equal(/free-watermark(?:-preview|-[xy]|\.png)/i.test(css), false, 'preview branding must not survive as a conditional style or generated background');
  for (const activated of [false, true]) {
    const f = await fixture(t, { activated });
    await writeFile(path.join(f.root, 'index.html'), html);
    await mkdir(path.join(f.root, 'src'));
    for (let index = 0; index < styles.length; index++) await writeFile(path.join(f.root, 'src', ['style.css', 'beta-access.css'][index]), styles[index]);
    const response = await f.request('/');
    assert.equal(response.status, 200);
    const served = await response.text();
    assert.equal(served, html);
    assert.equal(/free-watermark(?:-preview|\.png)/i.test(served), false);
    assert.equal((await (await f.request('/api/beta/status')).json()).activated, activated);
    const preview = await f.request('/api/realistic-previews?exportMode=watermarked', 'POST', Buffer.from('synthetic-preview-scene'), 'application/zip');
    assert.equal(preview.status, 201, 'both permission states can request the same unmarked preview');
    assert.equal((await preview.json()).watermarked, false, 'a preview ignores even an explicit watermarked export query');
    assert.equal(f.realisticCalls[0].format, 'preview');
    assert.equal(f.realisticCalls[0].watermarked, false, 'the server never asks the preview renderer to add free-export branding');

    const nodes = new Map(), document = { body: { dataset: {} }, activeElement: null };
    for (const match of served.matchAll(/\bid="([^"]+)"/g)) {
      const listeners = new Map();
      const node = {
        id: match[1], value: '', textContent: '', dataset: {}, disabled: false, hidden: false, open: false, isConnected: true,
        setAttribute() {}, classList: { toggle() {} },
        addEventListener(name, listener) { const list = listeners.get(name) || []; list.push(listener); listeners.set(name, list); },
        focus() { document.activeElement = this; }, showModal() { this.open = true; }, close() { this.open = false; },
      };
      nodes.set(match[1], node);
    }
    document.getElementById = id => nodes.get(id) || null;
    document.activeElement = nodes.get('export-button');
    let loaded = 0;
    const controller = createExportUnlockController({ document,
      loadApp: async () => { loaded++; },
      request: (url, settings) => f.request(url, settings?.method || 'GET', settings?.body === undefined ? undefined : JSON.parse(settings.body)),
    });
    await controller.start();
    const expected = activated ? 'unlocked' : 'free', deadline = Date.now() + 2000;
    while (document.body.dataset.exportState !== expected && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(document.body.dataset.betaState, 'ready', 'preview loading never waits for or requires activation');
    assert.equal(loaded, 1);
    assert.equal(document.body.dataset.exportState, expected);
    assert.equal(nodes.get('export-unlock-button').dataset.exportState, activated ? 'unlocked' : 'locked');
    assert.equal(nodes.get('beta-gate').open, false, 'starting the preview does not force an activation dialog');
    assert.equal([...nodes.keys()].some(id => /(?:preview.*watermark|watermark.*preview)/i.test(id)), false);
    assert.equal(/free-watermark(?:-preview|\.png)/i.test(served), false, 'both permission states keep the same unmarked preview markup');
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
  const metrics = assertSubtleMovingWatermark(free.decoded, options.width, options.height, options.frames, 'realtime');
  t.diagnostic('realtime encoded watermark ' + JSON.stringify(metrics));
  assert.equal((await f.request(free.result.url, 'HEAD')).status, 200, 'free download is available without a license');
  assert.equal((await f.request(free.result.url + '?exportMode=unlocked')).status, 200);
  f.state.activated = true;
  const paid = await completedVideo(f, { ...options, frames: 1, exportMode: 'unlocked' });
  assert.equal(paid.created.watermarked, false);
  assert.equal(paid.decoded.length, frameBytes);
  assert.equal(watermarkPixels(paid.decoded, options.width, options.height).count, 0, 'paid video contains no branding');
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
  const scene = Buffer.from(await pack.blob.arrayBuffer());
  async function renderAndDecode(watermarked) {
    const started = await service.create(scene, { format: 'mp4', watermarked });
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
    return stdout;
  }
  const free = await renderAndDecode(true);
  const metrics = assertSubtleMovingWatermark(free, options.width, options.height, options.frames, 'realistic');
  t.diagnostic('realistic encoded watermark ' + JSON.stringify(metrics));
  const paid = await renderAndDecode(false);
  const frameBytes = options.width * options.height * 3;
  assert.equal(paid.length, frameBytes * options.frames);
  for (let frame = 0; frame < options.frames; frame++) {
    assert.equal(watermarkPixels(paid.subarray(frame * frameBytes, (frame + 1) * frameBytes), options.width, options.height).count,
      0, `paid realistic frame ${frame} contains no branding`);
  }
});
