import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { deflateSync } from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createApp } from '../server.mjs';
import { probeMovAlphaEncoder } from '../export-codecs.mjs';
import { findPythonPath, findFFmpegPath } from '../runtime-paths.mjs';

const execFileAsync = promisify(execFile);
const FFMPEG = findFFmpegPath();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function png(width = 64, height = 64, color = [40, 100, 200, 255], alpha = true) {
  const chunk = (type, data) => {
    const name = Buffer.from(type);
    const result = Buffer.alloc(data.length + 12);
    result.writeUInt32BE(data.length);
    name.copy(result, 4);
    data.copy(result, 8);
    result.writeUInt32BE(crc32(Buffer.concat([name, data])), result.length - 4);
    return result;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = alpha ? 6 : 2;
  const channels = alpha ? 4 : 3;
  const pixels = Buffer.alloc(height * (1 + width * channels));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      for (let component = 0; component < channels; component++) pixels[y * (1 + width * channels) + 1 + x * channels + component] = color[component];
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'growth-backend-'));
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'index.html'), '<!doctype html><title>Growth</title>');
  await writeFile(path.join(root, 'src', 'test.js'), 'export const ready = true;');
  const app = createApp({ root, betaService: { requireActivation: async () => {}, status: async () => ({ activated: true }) }, ...options });
  await new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(0, '127.0.0.1', resolve);
  });
  const port = app.server.address().port;
  const base = `http://127.0.0.1:${port}`;
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  return { root, app, port, base };
}

async function createExport(base, overrides = {}) {
  const response = await fetch(`${base}/api/exports`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ width: 64, height: 64, fps: 5, frames: 5, name: 'test', ...overrides }),
  });
  return { response, body: await response.json() };
}

async function upload(base, id, index, image = png()) {
  return fetch(`${base}/api/exports/${id}/frames?index=${index}`, {
    method: 'POST', headers: { 'Content-Type': 'image/png', Origin: base }, body: image,
  });
}

async function uploadBackground(base, id, video, type = 'video/mp4') {
  return fetch(`${base}/api/exports/${id}/background`, {
    method: 'POST', headers: { 'Content-Type': type, Origin: base }, body: video,
  });
}

async function sourceVideo(root, { audio = true, duration = 0.4 } = {}) {
  const filename = path.join(root, audio ? 'background-with-audio.mp4' : 'silent-background.mp4');
  await execFileAsync(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=white:s=64x64:r=5',
    ...(audio ? ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100'] : []),
    '-t', String(duration), '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    ...(audio ? ['-c:a', 'aac'] : ['-an']), filename,
  ]);
  return readFile(filename);
}

async function finish(base, id) {
  return fetch(`${base}/api/exports/${id}/finish`, { method: 'POST', headers: { Origin: base } });
}

async function cancel(base, id) {
  return fetch(`${base}/api/exports/${id}`, { method: 'DELETE', headers: { Origin: base } });
}

test('installed app writes completed output to shared user data rather than its version directory', async t => {
  const exportDirectory = await mkdtemp(path.join(tmpdir(), 'growth-shared-exports-'));
  t.after(() => rm(exportDirectory, { recursive: true, force: true }));
  const { base, root } = await fixture(t, { exportDirectory });
  const created = await createExport(base, { format: 'png-sequence', frames: 1 });
  assert.equal(created.response.status, 201);
  assert.equal((await upload(base, created.body.id, 0)).status, 200);
  const completed = await finish(base, created.body.id);
  assert.equal(completed.status, 200);
  assert.ok((await readdir(exportDirectory)).some(name => name.endsWith('.zip')));
  await assert.rejects(readdir(path.join(root, 'exports')), { code: 'ENOENT' });
});

test('serves project files with MIME types and blocks hidden files, traversal, and external symlinks', async t => {
  const { base, root } = await fixture(t);
  let response = await fetch(base);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/html/);
  response = await fetch(`${base}/src/test.js`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/javascript/);
  assert.equal(await response.text(), 'export const ready = true;');
  for (const route of ['/server.mjs', '/.git/config', '/src/%2e%2e/server.mjs', '/src/%2eprivate', '/src/bad%00.js']) {
    assert.equal((await fetch(base + route)).status, 404, route);
  }
  const external = await mkdtemp(path.join(tmpdir(), 'growth-external-'));
  t.after(() => rm(external, { recursive: true, force: true }));
  await writeFile(path.join(external, 'secret.js'), 'secret');
  await symlink(path.join(external, 'secret.js'), path.join(root, 'src', 'linked.js'));
  assert.equal((await fetch(`${base}/src/linked.js`)).status, 404);
});

test('rejects foreign origins, cross-site fetches, and DNS-rebinding Host headers', async t => {
  const { base, port } = await fixture(t);
  for (const headers of [{ Origin: 'https://example.com' }, { Origin: 'null' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    const response = await fetch(`${base}/api/health`, { headers });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, 'INVALID_ORIGIN');
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  }
  const status = await new Promise((resolve, reject) => {
    const request = http.get({ hostname: '127.0.0.1', port, path: '/api/health', headers: { Host: `attacker.example:${port}` } }, response => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    });
    request.once('error', reject);
  });
  assert.equal(status, 403);
  assert.equal((await fetch(`${base}/api/health`, { headers: { Origin: base } })).status, 200);
});

test('local upright API accepts bounded canonical images and propagates detection failures without interpreting filenames', async t => {
  const image = png();
  let calls = 0;
  const photoCalibrationService = {
    capability: async () => ({ available: true, method: 'fixture' }),
    detect: async (body, options) => {
      calls++; assert.deepEqual(body, image); assert.equal(options.mimeType, 'image/png');
      if (calls === 2) { const error = new Error('请手动标记。'); error.status = 503; error.code = 'CALIBRATION_UNAVAILABLE'; throw error; }
      return { lines: [], confidence: 'low', warnings: ['没有足够清晰的边缘。'] };
    },
  };
  const { base } = await fixture(t, { photoCalibrationService });
  const request = () => fetch(`${base}/api/calibration/uprights`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', Origin: base, 'X-File-Name': '..%2Fignored.py' }, body: image });
  const first = await request(); assert.equal(first.status, 200); assert.equal((await first.json()).confidence, 'low');
  const second = await request(); assert.equal(second.status, 503); assert.equal((await second.json()).error.code, 'CALIBRATION_UNAVAILABLE');
  const health = await (await fetch(`${base}/api/health`)).json(); assert.equal(health.photoCalibration.available, true);
});

test('real slice routes accept streamed whole source, preserve explicit options and expose only authorized task outputs',async t=>{
  const id='11111111-1111-4111-8111-111111111111';let body,options,cancelled=false,root;
  const sliceService={health:async()=>({available:true}),create:async(request,input)=>{options=input;const chunks=[];for await(const chunk of request)chunks.push(chunk);body=Buffer.concat(chunks);return{id};},snapshot:task=>{assert.equal(task,id);return{id,status:'complete'};},cancel:async()=>{cancelled=true;return{cancelled:true};},gcodeFile:async()=>path.join(root,'whole.gcode'),file:async()=>path.join(root,'manifest.json'),provenance:async()=>({geometrySimplified:false}),close:async()=>{}};
  const fixtureResult=await fixture(t,{sliceService});root=fixtureResult.root;const base=fixtureResult.base;
  await writeFile(path.join(root,'whole.gcode'),'G1 X10 Y20 E1\n');await writeFile(path.join(root,'manifest.json'),'{}');
  const input={format:'stl',preset:'a1',sourceName:'cube.stl',toolColors:['#ABCDEF']};
  const response=await fetch(base+'/api/slices?'+new URLSearchParams({options:JSON.stringify(input)}),{method:'POST',headers:{'Content-Type':'application/octet-stream',Origin:base},body:Buffer.from('whole-STL')});
  assert.equal(response.status,201);assert.deepEqual(await response.json(),{id});assert.equal(body.toString(),'whole-STL');assert.equal(options.toolColors[0],'#abcdef');
  assert.equal((await(await fetch(`${base}/api/health`)).json()).slicing.available,true);
  assert.equal(await(await fetch(`${base}/api/slices/${id}/gcode`)).text(),'G1 X10 Y20 E1\n');
  assert.equal((await(await fetch(`${base}/api/slices/${id}/provenance`)).json()).geometrySimplified,false);
  assert.equal((await fetch(`${base}/api/slices/${id}/gcode`,{method:'HEAD'})).status,200);
  const invalid=await fetch(base+'/api/slices?'+new URLSearchParams({options:JSON.stringify({...input,path:'/secret'})}),{method:'POST',body:'data'});assert.equal(invalid.status,400);
  assert.equal((await fetch(`${base}/api/slices/${id}`,{method:'DELETE'})).status,200);assert.equal(cancelled,true);
});

test('realistic preview routes force one preview task, stream PNG inline and keep export and preview access distinct', async t => {
  const previewId = '11111111-1111-4111-8111-111111111111', exportId = '22222222-2222-4222-8222-222222222222';
  const calls = [], deleted = new Set(); let root;
  const identify = (id, options) => {
    const preview = id === previewId;
    if (![previewId, exportId].includes(id) || options?.preview !== preview) { const error = new Error('找不到任务。'); error.status = 404; error.code = 'REALISTIC_EXPORT_NOT_FOUND'; throw error; }
    return preview;
  };
  const realisticRenderService = {
    health: async () => ({ available: true, active: false }),
    create: async (body, options) => { calls.push({ body, options }); return { id: options.format === 'preview' ? previewId : exportId, status: 'rendering', format: options.format }; },
    snapshot: (id, options) => { identify(id, options); return { id, status: deleted.has(id) ? 'cancelled' : 'complete' }; },
    cancel: async (id, options) => { identify(id, options); deleted.add(id); return { id, status: 'cancelled' }; },
    file: async (id, options) => { const preview = identify(id, options); return { path: path.join(root, preview ? 'preview.png' : 'export.zip'), name: preview ? 'preview.png' : 'export.zip' }; },
    close: async () => {},
  };
  const fixtureResult = await fixture(t, { realisticRenderService }); root = fixtureResult.root; const { base } = fixtureResult;
  const image = png(); await writeFile(path.join(root, 'preview.png'), image); await writeFile(path.join(root, 'export.zip'), 'verified-export');
  const body = Buffer.from('whole-scene-package');
  let response = await fetch(`${base}/api/realistic-previews?format=mp4`, { method: 'POST', headers: { 'Content-Type': 'application/zip', Origin: base }, body });
  assert.equal(response.status, 201); assert.equal((await response.json()).id, previewId); assert.deepEqual(calls[0].body, body); assert.equal(calls[0].options.format, 'preview');
  assert.equal((await (await fetch(`${base}/api/realistic-previews/${previewId}`)).json()).status, 'complete');
  response = await fetch(`${base}/api/realistic-previews/${previewId}/file`); assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'image/png'); assert.equal(response.headers.get('content-disposition'), null); assert.deepEqual(Buffer.from(await response.arrayBuffer()), image);
  response = await fetch(`${base}/api/realistic-previews/${previewId}/file`, { method: 'HEAD' }); assert.equal(response.status, 200); assert.equal(Number(response.headers.get('content-length')), image.length); assert.equal((await response.arrayBuffer()).byteLength, 0);
  for (const route of [`/api/realistic-exports/${previewId}`, `/api/realistic-exports/${previewId}/file`, `/api/realistic-previews/${exportId}`, `/api/realistic-previews/${exportId}/file`]) assert.equal((await fetch(base + route)).status, 404);
  assert.equal((await fetch(`${base}/api/realistic-previews/${exportId}`, { method: 'DELETE', headers: { Origin: base } })).status, 404); assert.equal(deleted.has(exportId), false);
  response = await fetch(`${base}/api/realistic-exports?format=preview`, { method: 'POST', headers: { 'Content-Type': 'application/zip', Origin: base }, body }); assert.equal(response.status, 400); assert.equal((await response.json()).error.code, 'INVALID_FORMAT'); assert.equal(calls.length, 1);
  response = await fetch(`${base}/api/realistic-previews`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: '{}' }); assert.equal(response.status, 415); assert.equal(calls.length, 1);
  response = await fetch(`${base}/api/realistic-exports?format=mov-alpha`, { method: 'POST', headers: { 'Content-Type': 'application/zip', Origin: base }, body });
  assert.equal(response.status, 201); assert.equal(calls[1].options.format, 'mov-alpha'); assert.deepEqual(calls[1].body, body);
  response = await fetch(`${base}/api/realistic-previews/${previewId}`, { method: 'DELETE', headers: { Origin: base } }); assert.equal(response.status, 200); assert.equal((await response.json()).status, 'cancelled'); assert.equal(deleted.has(previewId), true);
  response = await fetch(`${base}/api/realistic-exports/${exportId}/file`); assert.equal(response.status, 200); assert.match(response.headers.get('content-disposition'), /attachment/);
});

test('validates export settings and reports missing ffmpeg without preventing PNG exports', async t => {
  const { base } = await fixture(t, { ffmpegPath: '/definitely-missing-ffmpeg' });
  const health = await (await fetch(`${base}/api/health`)).json();
  assert.deepEqual(health.ffmpeg, { available: false, version: null, alphaAvailable: false });
  assert.equal(health.activeExport, false);
  for (const invalid of [{ width: 65 }, { height: 8192 }, { fps: 61 }, { frames: 0 }, { format: 'avi' }, { name: 42 }]) {
    const { response, body } = await createExport(base, invalid);
    assert.equal(response.status, 400);
    assert.equal(typeof body.error.code, 'string');
  }
  assert.equal((await createExport(base)).response.status, 503);
  assert.equal((await createExport(base, { format: 'mov-alpha' })).response.status, 503);
  const { response, body } = await createExport(base, { format: 'png-sequence' });
  assert.equal(response.status, 201);
  assert.match(body.id, /^[0-9a-f-]{36}$/);
  assert.equal((await cancel(base, body.id)).status, 200);
});

test('only one concurrent export acquires the slot; cancellation removes all partial files', async t => {
  const { base, root } = await fixture(t, { ffmpegPath: '/definitely-missing-ffmpeg' });
  const attempts = await Promise.all([createExport(base, { format: 'png-sequence' }), createExport(base, { format: 'png-sequence' })]);
  assert.deepEqual(attempts.map(result => result.response.status).sort(), [201, 409]);
  const id = attempts.find(result => result.response.status === 201).body.id;
  assert.equal((await upload(base, id, 0)).status, 200);
  assert.equal((await cancel(base, id)).status, 200);
  assert.deepEqual(await readdir(path.join(root, 'exports')), []);
  assert.equal((await (await fetch(`${base}/api/health`)).json()).activeExport, false);
  const next = await createExport(base, { format: 'png-sequence' });
  assert.equal(next.response.status, 201);
  await cancel(base, next.body.id);
});

test('requires exact frame order, dimensions, PNG bodies, and frame count', async t => {
  const { base } = await fixture(t, { ffmpegPath: '/definitely-missing-ffmpeg' });
  const { body: { id } } = await createExport(base, { format: 'png-sequence', frames: 2 });
  assert.equal((await upload(base, id, 1)).status, 409);
  let response = await upload(base, id, 0, png(32, 32));
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'FRAME_SIZE_MISMATCH');
  response = await upload(base, id, 0, png().subarray(0, -5));
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'INVALID_PNG');
  assert.equal((await upload(base, id, 0, Buffer.alloc(90_000))).status, 413);
  assert.equal((await upload(base, id, 0)).status, 200);
  assert.equal((await upload(base, id, 0)).status, 409);
  response = await finish(base, id);
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, 'FRAMES_MISSING');
  assert.equal((await upload(base, id, 1)).status, 200);
  assert.equal((await upload(base, id, 2)).status, 409);
  await cancel(base, id);
});

test('oversized chunked uploads return a structured error and leave the frame retryable', async t => {
  const { base, port } = await fixture(t, { ffmpegPath: '/definitely-missing-ffmpeg' });
  const { body: { id } } = await createExport(base, { format: 'png-sequence', frames: 1 });
  const result = await new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port, method: 'POST',
      path: `/api/exports/${id}/frames?index=0`, headers: { 'Content-Type': 'image/png', 'Transfer-Encoding': 'chunked' } }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.once('end', () => resolve({ status: response.statusCode, body: JSON.parse(body) }));
    });
    request.once('error', reject);
    request.write(Buffer.alloc(45_000));
    request.end(Buffer.alloc(45_000));
  });
  assert.equal(result.status, 413);
  assert.equal(result.body.error.code, 'BODY_TOO_LARGE');
  assert.equal((await upload(base, id, 0)).status, 200);
  await cancel(base, id);
});

test('PNG sequence ZIP preserves exact RGBA images and filenames without ffmpeg', async t => {
  const { base, root } = await fixture(t, { ffmpegPath: '/definitely-missing-ffmpeg' });
  const images = [png(64, 64, [255, 0, 0, 0]), png(64, 64, [0, 255, 0, 128])];
  const { body: { id } } = await createExport(base, { format: 'png-sequence', frames: images.length, name: '../透明:测试.zip' });
  for (const [index, image] of images.entries()) assert.equal((await upload(base, id, index, image)).status, 200);
  const response = await finish(base, id);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.match(result.filename, /透明-测试.*\.zip$/);
  assert.equal(result.filename.includes('/'), false);
  const file = path.join(root, 'exports', result.filename);
  const { stdout: entries } = await execFileAsync(findPythonPath(), ['-B', '-c', 'import sys,zipfile; print("\\n".join(zipfile.ZipFile(sys.argv[1]).namelist()))', file]);
  assert.deepEqual(entries.trim().split(/\r?\n/), ['frame_000000.png', 'frame_000001.png']);
  for (const [index, expected] of images.entries()) {
    const { stdout: actual } = await execFileAsync(findPythonPath(), ['-B', '-c', 'import sys,zipfile; sys.stdout.buffer.write(zipfile.ZipFile(sys.argv[1]).read(sys.argv[2]))', file, `frame_${String(index).padStart(6, '0')}.png`], { encoding: 'buffer' });
    assert.deepEqual(actual, expected);
  }
  const download = await fetch(base + result.url);
  assert.equal(download.headers.get('content-type'), 'application/zip');
  assert.match(download.headers.get('content-disposition'), /filename\*=UTF-8''/);
  assert.equal((await download.arrayBuffer()).byteLength, result.bytes);
  assert.deepEqual(await readdir(path.join(root, 'exports')), [result.filename]);
  assert.equal((await cancel(base, id)).status, 409);
  assert.equal((await readFile(file)).length, result.bytes);
  assert.deepEqual(await (await finish(base, id)).json(), result);
});

test('real ffmpeg export decodes to exactly the requested frame sequence and H.264 MP4', async t => {
  try { await execFileAsync(FFMPEG, ['-version']); }
  catch { t.skip('FFmpeg is not available in this environment.'); return; }
  const { base, root } = await fixture(t, { ffmpegPath: FFMPEG });
  const { body: { id }, response } = await createExport(base, { name: '编码测试' });
  assert.equal(response.status, 201);
  for (let index = 0; index < 5; index++) {
    assert.equal((await upload(base, id, index, png(64, 64, [40 + index * 30, 100, 200, 255]))).status, 200);
  }
  const completed = await finish(base, id);
  assert.equal(completed.status, 200, JSON.stringify(await completed.clone().json()));
  const result = await completed.json();
  const file = path.join(root, 'exports', result.filename);
  const { stdout, stderr } = await execFileAsync(FFMPEG, ['-hide_banner', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], {
    encoding: 'buffer', maxBuffer: 1024 * 1024,
  });
  assert.match(stderr.toString(), /Video: h264/);
  assert.match(stderr.toString(), /Duration: 00:00:01\.00/);
  assert.equal(stdout.length, 5 * 64 * 64 * 3);
  for (let index = 0; index < 5; index++) {
    const offset = index * 64 * 64 * 3;
    assert.ok(Math.abs(stdout[offset] - (40 + index * 30)) <= 5, `frame ${index} retains its own color`);
    assert.ok(Math.abs(stdout[offset + 1] - 100) <= 5);
    assert.ok(Math.abs(stdout[offset + 2] - 200) <= 5);
  }
  const download = await fetch(base + result.url);
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('content-type'), 'video/mp4');
  assert.equal((await download.arrayBuffer()).byteLength, result.bytes);
  assert.deepEqual(await readdir(path.join(root, 'exports')), [result.filename]);
});

test('transparent MOV uses real ProRes 4444 and preserves transparent, partial and opaque alpha in every decoded pixel', async t => {
  if (!(await probeMovAlphaEncoder(FFMPEG)).available) { t.skip('FFmpeg ProRes alpha encoder is not available in this environment.'); return; }
  const { base, root } = await fixture(t, { ffmpegPath: FFMPEG });
  const health = await (await fetch(`${base}/api/health`)).json(); assert.equal(health.ffmpeg.alphaAvailable, true);
  const alpha = [0, 64, 128, 255];
  const { body: { id }, response } = await createExport(base, { format: 'mov-alpha', frames: alpha.length, name: '透明验证.mov' });
  assert.equal(response.status, 201);
  const opaquePNG = await upload(base, id, 0, png(64, 64, [40, 100, 200], false));
  assert.equal(opaquePNG.status, 400); assert.equal((await opaquePNG.json()).error.code, 'FRAME_ALPHA_REQUIRED');
  assert.equal((await uploadBackground(base, id, Buffer.from('unused-background'))).status, 409);
  for (let index = 0; index < alpha.length; index++) assert.equal((await upload(base, id, index, png(64, 64, [40 + index * 30, 100, 200, alpha[index]]))).status, 200);
  const completed = await finish(base, id); assert.equal(completed.status, 200, JSON.stringify(await completed.clone().json()));
  const result = await completed.json(); assert.match(result.filename, /^透明验证-[^.]+\.mov$/);
  const filename = path.join(root, 'exports', result.filename);
  const { stdout, stderr } = await execFileAsync(FFMPEG, ['-hide_banner', '-i', filename, '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'], { encoding: 'buffer', maxBuffer: 1024 * 1024 });
  assert.match(stderr.toString(), /Video: prores \(4444\)/); assert.match(stderr.toString(), /yuva444p/);
  assert.equal(stdout.length, alpha.length * 64 * 64 * 4);
  for (let index = 0; index < alpha.length; index++) for (let pixel = 0; pixel < 64 * 64; pixel++) {
    const actual = stdout[(index * 64 * 64 + pixel) * 4 + 3];
    assert.ok(Math.abs(actual - alpha[index]) <= 1, `frame ${index} pixel ${pixel}: alpha ${actual} instead of ${alpha[index]}`);
  }
  const downloaded = await fetch(base + result.url); assert.equal(downloaded.headers.get('content-type'), 'video/quicktime');
  assert.equal((await downloaded.arrayBuffer()).byteLength, result.bytes);
  assert.deepEqual(await readdir(path.join(root, 'exports')), [result.filename]);
});

test('an FFmpeg build without alpha encoding fails clearly before reserving a transparent export', async t => {
  try { await execFileAsync(FFMPEG, ['-version']); } catch { t.skip('FFmpeg is not available in this environment.'); return; }
  const { base, root } = await fixture(t, { ffmpegPath: FFMPEG, alphaEncoderProbe: async () => ({ available: false }) });
  const result = await createExport(base, { format: 'mov-alpha' }); assert.equal(result.response.status, 503); assert.equal(result.body.error.code, 'ALPHA_ENCODER_UNAVAILABLE');
  assert.equal((await (await fetch(`${base}/api/health`)).json()).activeExport, false);
  const pngJob = await createExport(base, { format: 'png-sequence' }); assert.equal(pngJob.response.status, 201); await cancel(base, pngJob.body.id);
  assert.deepEqual(await readdir(path.join(root, 'exports')), []);
});

test('MP4 compositing loops source audio while preserving the complete rendered video and cleans source files', async t => {
  try { await execFileAsync(FFMPEG, ['-version']); }
  catch { t.skip('FFmpeg is not available in this environment.'); return; }
  const { base, root } = await fixture(t, { ffmpegPath: FFMPEG });
  const source = await sourceVideo(root);
  const { body: { id } } = await createExport(base);
  const uploaded = await uploadBackground(base, id, source);
  assert.equal(uploaded.status, 200);
  assert.deepEqual(await uploaded.json(), { uploaded: true, bytes: source.length });
  assert.equal((await uploadBackground(base, id, source)).status, 409);
  for (let index = 0; index < 5; index++) {
    assert.equal((await upload(base, id, index, png(64, 64, [40 + index * 30, 100, 200, 255]))).status, 200);
  }
  const completed = await finish(base, id);
  assert.equal(completed.status, 200, JSON.stringify(await completed.clone().json()));
  const result = await completed.json();
  const file = path.join(root, 'exports', result.filename);
  const video = await execFileAsync(FFMPEG, ['-hide_banner', '-i', file, '-map', '0:v:0', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], {
    encoding: 'buffer', maxBuffer: 1024 * 1024,
  });
  assert.match(video.stderr.toString(), /Audio: aac/);
  // Older AAC muxers include one packet of codec padding in the container duration.
  assert.match(video.stderr.toString(), /Duration: 00:00:01\.0[0-3]/);
  assert.equal(video.stdout.length, 5 * 64 * 64 * 3);
  for (let index = 0; index < 5; index++) {
    assert.ok(Math.abs(video.stdout[index * 64 * 64 * 3] - (40 + index * 30)) <= 5, `frame ${index} remains the rendered image`);
  }
  const audio = await execFileAsync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', file, '-map', '0:a:0', '-ac', '1', '-ar', '44100', '-f', 's16le', 'pipe:1'], {
    encoding: 'buffer', maxBuffer: 1024 * 1024,
  });
  assert.ok(audio.stdout.length >= 44_100 * 2, `source audio continues past its original 0.4-second duration (${audio.stdout.length} bytes)`);
  let tailAmplitude = 0;
  for (let offset = 35_000 * 2; offset < audio.stdout.length; offset += 2) tailAmplitude = Math.max(tailAmplitude, Math.abs(audio.stdout.readInt16LE(offset)));
  assert.ok(tailAmplitude > 500, 'looped audio is audible near the end');
  assert.deepEqual(await readdir(path.join(root, 'exports')), [result.filename]);
});

test('a background video without audio still exports the exact requested silent MP4', async t => {
  try { await execFileAsync(FFMPEG, ['-version']); }
  catch { t.skip('FFmpeg is not available in this environment.'); return; }
  const { base, root } = await fixture(t, { ffmpegPath: FFMPEG });
  const source = await sourceVideo(root, { audio: false });
  const { body: { id } } = await createExport(base);
  assert.equal((await uploadBackground(base, id, source)).status, 200);
  for (let index = 0; index < 5; index++) assert.equal((await upload(base, id, index)).status, 200);
  const completed = await finish(base, id);
  assert.equal(completed.status, 200, JSON.stringify(await completed.clone().json()));
  const result = await completed.json();
  const { stdout, stderr } = await execFileAsync(FFMPEG, ['-hide_banner', '-i', path.join(root, 'exports', result.filename), '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], {
    encoding: 'buffer', maxBuffer: 1024 * 1024,
  });
  assert.equal(stdout.length, 5 * 64 * 64 * 3);
  assert.match(stderr.toString(), /Duration: 00:00:01\.00/);
  assert.doesNotMatch(stderr.toString(), /Audio:/);
  assert.deepEqual(await readdir(path.join(root, 'exports')), [result.filename]);
});

test('source-video upload is MP4-only, checks content and size limits, and cancellation removes the saved source', async t => {
  try { await execFileAsync(FFMPEG, ['-version']); }
  catch { t.skip('FFmpeg is not available in this environment.'); return; }
  const { base, root, port } = await fixture(t, { ffmpegPath: FFMPEG });
  const source = await sourceVideo(root);
  const pngJob = await createExport(base, { format: 'png-sequence' });
  assert.equal((await uploadBackground(base, pngJob.body.id, source)).status, 409);
  await cancel(base, pngJob.body.id);
  const { body: { id } } = await createExport(base);
  assert.equal((await uploadBackground(base, id, source, 'application/octet-stream')).status, 415);
  assert.equal((await uploadBackground(base, id, Buffer.alloc(0))).status, 400);
  const oversized = await new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port, method: 'POST', path: `/api/exports/${id}/background`,
      headers: { 'Content-Type': 'video/mp4', 'Content-Length': 512 * 1024 * 1024 + 1 } }, response => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    });
    request.once('error', reject);
    request.end();
  });
  assert.equal(oversized, 413);
  assert.equal((await uploadBackground(base, id, source)).status, 200);
  assert.ok((await readdir(path.join(root, 'exports'))).some(name => name.endsWith('.background')));
  assert.equal((await cancel(base, id)).status, 200);
  assert.deepEqual(await readdir(path.join(root, 'exports')), []);
  assert.equal((await uploadBackground(base, id, source)).status, 409);
});

test('cancelling an in-flight background upload closes its file and releases the export slot', async t => {
  try { await execFileAsync(FFMPEG, ['-version']); }
  catch { t.skip('FFmpeg is not available in this environment.'); return; }
  const { base, root, port } = await fixture(t, { ffmpegPath: FFMPEG });
  const { body: { id } } = await createExport(base);
  let request;
  const uploadResult = new Promise((resolve, reject) => {
    request = http.request({ hostname: '127.0.0.1', port, method: 'POST', path: `/api/exports/${id}/background`,
      headers: { 'Content-Type': 'video/mp4', 'Transfer-Encoding': 'chunked' } }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.once('end', () => resolve({ status: response.statusCode, body: JSON.parse(body) }));
    });
    request.once('error', reject);
    request.write(Buffer.alloc(4096));
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await readdir(path.join(root, 'exports'))).some(name => name.endsWith('.background'))) break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal((await cancel(base, id)).status, 200);
  request.end();
  const aborted = await uploadResult;
  assert.equal(aborted.status, 409);
  assert.equal(aborted.body.error.code, 'EXPORT_NOT_ACTIVE');
  assert.deepEqual(await readdir(path.join(root, 'exports')), []);
  assert.equal((await (await fetch(`${base}/api/health`)).json()).activeExport, false);
});

test('idle jobs are cancelled and release the export slot', async t => {
  const { base, root } = await fixture(t, { ffmpegPath: '/definitely-missing-ffmpeg', idleTimeoutMs: 200 });
  const { body: { id } } = await createExport(base, { format: 'png-sequence' });
  assert.equal((await upload(base, id, 0)).status, 200);
  await new Promise(resolve => setTimeout(resolve, 550));
  assert.equal((await (await fetch(`${base}/api/health`)).json()).activeExport, false);
  assert.equal((await upload(base, id, 1)).status, 409);
  assert.deepEqual(await readdir(path.join(root, 'exports')), []);
});
