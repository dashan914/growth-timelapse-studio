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

async function uploadSound(base, id, audio, type = 'application/octet-stream') {
  return fetch(`${base}/api/exports/${id}/sound`, {
    method: 'POST', headers: { 'Content-Type': type, Origin: base }, body: audio,
  });
}

async function sourceSound(root, { duration = 0.3, format = 'mp3', sampleRate = 48000, channels = 2 } = {}) {
  const filename = path.join(root, `custom-${duration}.${format}`);
  await execFileAsync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=880:sample_rate=${sampleRate}`,
    '-t', String(duration), '-ac', String(channels), '-c:a', format === 'wav' ? 'pcm_s16le' : 'libmp3lame', filename]);
  return readFile(filename);
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

test('external links may open the entry document while cross-site APIs and embedded requests remain blocked', async t => {
  const { base } = await fixture(t);
  // fetch assigns its own Sec-Fetch-Mode. Use HTTP so navigation metadata
  // reaches the server exactly as it would from a browser document request.
  const request = (route, method, headers) => new Promise((resolve, reject) => {
    const client = http.request(base + route, { method, headers }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.once('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
    });
    client.once('error', reject);
    client.end();
  });
  const navigation = { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' };
  for (const route of ['/', '/index.html', '/?from=link']) {
    const response = await request(route, 'GET', navigation);
    assert.equal(response.status, 200, route);
    assert.match(response.headers['content-type'], /^text\/html/);
    assert.equal(response.headers['x-frame-options'], 'DENY');
  }
  assert.equal((await request('/', 'HEAD', navigation)).status, 200);
  for (const [route, method, headers] of [
    ['/api/health', 'GET', navigation],
    ['/api/exports', 'POST', navigation],
    ['/', 'POST', navigation],
    ['/', 'GET', { ...navigation, Origin: 'https://example.com' }],
    ['/', 'GET', { ...navigation, Origin: 'null' }],
    ['/', 'GET', { ...navigation, 'Sec-Fetch-Dest': 'iframe' }],
    ['/', 'GET', { ...navigation, 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' }],
    ['/', 'GET', { 'Sec-Fetch-Site': 'cross-site' }],
    ['/src/test.js', 'GET', { ...navigation, 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': 'script' }],
  ]) {
    const response = await request(route, method, headers);
    assert.equal(response.status, 403, `${method} ${route} ${JSON.stringify(headers)}`);
    assert.equal(JSON.parse(response.body).error.code, 'INVALID_ORIGIN');
  }
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

test('selected sound mixes with audible or silent background, preserves frames and removes temporary files',async t=>{
  try {await execFileAsync(FFMPEG,['-version']);}catch{t.skip('FFmpeg unavailable');return;}
  for(const sourceAudio of [null,false,true]) {
    const {base,root}=await fixture(t,{ffmpegPath:FFMPEG});
    await mkdir(path.join(root,'assets','sounds'),{recursive:true});
    await writeFile(path.join(root,'assets','sounds','reference-original.wav'),await readFile(new URL('../assets/sounds/reference-original.wav',import.meta.url)));
    const {response,body:{id}}=await createExport(base,{soundEffect:'reference',soundVolume:.7});
    assert.equal(response.status,201);
    if(sourceAudio!==null)assert.equal((await uploadBackground(base,id,await sourceVideo(root,{audio:sourceAudio}))).status,200);
    for(let index=0;index<5;index++)assert.equal((await upload(base,id,index)).status,200);
    const result=await finish(base,id);assert.equal(result.status,200,JSON.stringify(await result.clone().json()));
    const saved=await result.json(),file=path.join(root,'exports',saved.filename);
    const decoded=await execFileAsync(FFMPEG,['-hide_banner','-i',file,'-map','0:v:0','-f','rawvideo','-pix_fmt','rgb24','pipe:1'],{encoding:'buffer',maxBuffer:1024*1024});
    assert.equal(decoded.stdout.length,5*64*64*3);assert.match(decoded.stderr.toString(),/Audio: aac/);
    const pcm=await execFileAsync(FFMPEG,['-v','error','-i',file,'-map','0:a:0','-ac','1','-ar','44100','-f','s16le','pipe:1'],{encoding:'buffer',maxBuffer:1024*1024});
    let peak=0;for(let i=0;i<pcm.stdout.length;i+=2)peak=Math.max(peak,Math.abs(pcm.stdout.readInt16LE(i)));assert.ok(peak>100);
    assert.deepEqual(await readdir(path.join(root,'exports')),[saved.filename]);
  }
});

test('long video plays reference audio once and keeps the remaining timeline silent',async t=>{
  try{await execFileAsync(FFMPEG,['-version']);}catch{t.skip('FFmpeg unavailable');return;}
  const {base,root}=await fixture(t,{ffmpegPath:FFMPEG});
  await mkdir(path.join(root,'assets','sounds'),{recursive:true});
  await writeFile(path.join(root,'assets','sounds','reference-original.wav'),await readFile(new URL('../assets/sounds/reference-original.wav',import.meta.url)));
  const {response,body:{id}}=await createExport(base,{frames:50,soundEffect:'reference',soundVolume:1});
  assert.equal(response.status,201);
  for(let index=0;index<50;index++)assert.equal((await upload(base,id,index)).status,200);
  const completed=await finish(base,id);assert.equal(completed.status,200,JSON.stringify(await completed.clone().json()));
  const saved=await completed.json(),file=path.join(root,'exports',saved.filename);
  const pcm=await execFileAsync(FFMPEG,['-v','error','-i',file,'-map','0:a:0','-ac','1','-ar','44100','-f','s16le','pipe:1'],{encoding:'buffer',maxBuffer:2*1024*1024});
  const peak=(start,end)=>{let value=0;for(let i=Math.round(start*44100)*2;i<Math.min(pcm.stdout.length,Math.round(end*44100)*2);i+=2)value=Math.max(value,Math.abs(pcm.stdout.readInt16LE(i)));return value;};
  assert.ok(peak(0,7)>500,'reference is audible');
  assert.ok(peak(8.5,9.5)<10,'the tail is silence, not a repeat of the source');
  const video=await execFileAsync(FFMPEG,['-v','error','-i',file,'-map','0:v:0','-f','rawvideo','-pix_fmt','rgb24','pipe:1'],{encoding:'buffer',maxBuffer:2*1024*1024});
  assert.equal(video.stdout.length,50*64*64*3);
});

test('reference audio is served as WAV and invalid sound options never reserve an export slot', async t => {
  const { base, root } = await fixture(t, { ffmpegPath: '/definitely-missing-ffmpeg' });
  await mkdir(path.join(root, 'assets', 'sounds'), { recursive: true });
  await writeFile(path.join(root, 'assets', 'sounds', 'reference-original.wav'), await readFile(new URL('../assets/sounds/reference-original.wav', import.meta.url)));
  const audio = await fetch(`${base}/assets/sounds/reference-original.wav`);
  assert.equal(audio.status, 200);
  assert.equal(audio.headers.get('content-type'), 'audio/wav');
  assert.equal(Buffer.from(await audio.arrayBuffer()).subarray(0, 4).toString(), 'RIFF');
  for (const invalid of [{ soundEffect: '../../secret' }, { soundVolume: 2 }]) {
    const created = await createExport(base, { format: 'png-sequence', ...invalid });
    assert.equal(created.response.status, 400);
    assert.equal(created.body.error.code, 'INVALID_SOUND');
  }
  assert.equal((await (await fetch(`${base}/api/health`)).json()).activeExport, false);
});

test('PNG sequence export ignores enabled sound without needing FFmpeg or the audio file', async t => {
  const { base } = await fixture(t, { ffmpegPath: '/definitely-missing-ffmpeg' });
  const created = await createExport(base, { format: 'png-sequence', frames: 1, soundEffect: 'reference' });
  assert.equal(created.response.status, 201);
  assert.equal((await upload(base, created.body.id, 0)).status, 200);
  const completed = await finish(base, created.body.id);
  assert.equal(completed.status, 200);
  assert.match((await completed.json()).filename, /\.zip$/);
});

test('missing reference audio fails cleanly and releases the export slot', async t => {
  try { await execFileAsync(FFMPEG, ['-version']); } catch { t.skip('FFmpeg unavailable'); return; }
  const { base, root } = await fixture(t, { ffmpegPath: FFMPEG });
  const created = await createExport(base, { frames: 1, soundEffect: 'reference' });
  assert.equal(created.response.status, 201);
  assert.equal((await upload(base, created.body.id, 0)).status, 200);
  const completed = await finish(base, created.body.id);
  assert.equal(completed.status, 500);
  assert.equal((await completed.json()).error.code, 'SOUND_MUX_FAILED');
  assert.deepEqual(await readdir(path.join(root, 'exports')), []);
  assert.equal((await (await fetch(`${base}/api/health`)).json()).activeExport, false);
});

test('imported MP3 normalizes once, mixes with optional background and stays silent after its end', async t => {
  try { await execFileAsync(FFMPEG, ['-version']); } catch { t.skip('FFmpeg unavailable'); return; }
  for (const backgroundAudio of [null, false, true]) {
    const { base, root } = await fixture(t, { ffmpegPath: FFMPEG });
    const custom = await sourceSound(root);
    const created = await createExport(base, { soundEffect: 'custom', frames: 10 });
    assert.equal(created.response.status, 201);
    const id = created.body.id, prepared = await uploadSound(base, id, custom);
    assert.equal(prepared.status, 200, await prepared.clone().text());
    const info = await prepared.json();
    assert.equal(info.uploaded, true); assert.equal(info.bytes, custom.length);
    assert.ok(info.duration >= .29 && info.duration <= .34);
    const files = await readdir(path.join(root, 'exports'));
    assert.ok(files.includes(`${id}.custom.wav`));
    assert.equal(files.includes(`${id}.sound-upload`), false, 'the undecoded original is removed before the upload succeeds');
    assert.equal((await readFile(path.join(root, 'exports', `${id}.custom.wav`))).subarray(0, 4).toString(), 'RIFF');
    assert.equal((await uploadSound(base, id, custom)).status, 409);
    if (backgroundAudio !== null) assert.equal((await uploadBackground(base, id, await sourceVideo(root, { audio: backgroundAudio }))).status, 200);
    for (let index = 0; index < 10; index++) assert.equal((await upload(base, id, index)).status, 200);
    const completed = await finish(base, id); assert.equal(completed.status, 200, await completed.clone().text());
    const saved = await completed.json(), file = path.join(root, 'exports', saved.filename);
    assert.equal((await fetch(base + saved.url)).status, 200);
    const video = await execFileAsync(FFMPEG, ['-v', 'error', '-i', file, '-map', '0:v:0', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { encoding: 'buffer', maxBuffer: 1024 * 1024 });
    assert.equal(video.stdout.length, 10 * 64 * 64 * 3);
    const pcm = await execFileAsync(FFMPEG, ['-v', 'error', '-i', file, '-map', '0:a:0', '-ac', '1', '-ar', '44100', '-f', 's16le', 'pipe:1'], { encoding: 'buffer', maxBuffer: 1024 * 1024 });
    const peak = (start, end) => {
      let value = 0;
      for (let i = Math.round(start * 44100) * 2; i < Math.min(pcm.stdout.length, Math.round(end * 44100) * 2); i += 2) value = Math.max(value, Math.abs(pcm.stdout.readInt16LE(i)));
      return value;
    };
    assert.ok(peak(.05, .2) > 500, 'imported sound is audible');
    if (backgroundAudio === true) assert.ok(peak(1, 1.5) > 200, 'background audio continues after the custom effect ends');
    else assert.ok(peak(1, 1.5) < 10, 'the short custom sound does not loop');
    assert.deepEqual(await readdir(path.join(root, 'exports')), [saved.filename], 'all original, normalized and mux temporary files are removed');
  }
});

test('custom upload rejects invalid contents and playlists without reserving a second task or retaining files', async t => {
  try { await execFileAsync(FFMPEG, ['-version']); } catch { t.skip('FFmpeg unavailable'); return; }
  const { base, root } = await fixture(t, { ffmpegPath: FFMPEG });
  const { body: { id } } = await createExport(base, { soundEffect: 'custom' });
  const realAudio = await sourceSound(root, { format: 'wav' });
  const playlist = Buffer.from(`ffconcat version 1.0\nfile '${path.join(root, 'custom-0.3.wav')}'\n`);
  for (const audio of [Buffer.from('not an audio file'), playlist, Buffer.from('#EXTM3U\nhttp://127.0.0.1:1/private.wav\n')]) {
    const result = await uploadSound(base, id, audio, 'audio/wav');
    assert.equal(result.status, 400, await result.clone().text());
    assert.equal((await result.json()).error.code, 'INVALID_CUSTOM_SOUND');
    assert.equal((await readdir(path.join(root, 'exports'))).some(name => /(?:custom\.wav|sound-upload)$/.test(name)), false);
  }
  const empty = await uploadSound(base, id, Buffer.alloc(0));
  assert.equal(empty.status, 400); assert.equal((await empty.json()).error.code, 'EMPTY_CUSTOM_SOUND');
  assert.equal((await uploadSound(base, id, realAudio, 'text/plain')).status, 415);
  assert.equal((await uploadSound(base, id, realAudio)).status, 200, 'invalid content leaves the task retryable');
  assert.equal((await cancel(base, id)).status, 200);
  assert.deepEqual(await readdir(path.join(root, 'exports')), []);
});

test('oversized and overlong custom audio fail clearly and remove both source and normalized files', async t => {
  try { await execFileAsync(FFMPEG, ['-version']); } catch { t.skip('FFmpeg unavailable'); return; }
  const { base, root, port } = await fixture(t, { ffmpegPath: FFMPEG });
  const { body: { id } } = await createExport(base, { soundEffect: 'custom' });
  const oversized = await new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port, method: 'POST', path: `/api/exports/${id}/sound`,
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(50 * 1024 * 1024 + 1) } }, response => {
      response.resume(); response.once('end', () => { request.destroy(); resolve(response.statusCode); });
    });
    request.once('error', error => { if (error.code !== 'ECONNRESET') reject(error); });
    request.flushHeaders();
  });
  assert.equal(oversized, 413);
  const overlong = await uploadSound(base, id, await sourceSound(root, { duration: 601, format: 'wav', sampleRate: 8000, channels: 1 }));
  assert.equal(overlong.status, 400, await overlong.clone().text());
  assert.equal((await overlong.json()).error.code, 'CUSTOM_SOUND_TOO_LONG');
  assert.equal((await readdir(path.join(root, 'exports'))).some(name => /(?:custom\.wav|sound-upload)$/.test(name)), false);
  assert.equal((await uploadSound(base, id, await sourceSound(root))).status, 200);
  await cancel(base, id);
  assert.deepEqual(await readdir(path.join(root, 'exports')), []);
});

test('a missing custom upload fails video finish and releases its slot, while PNG ignores custom sound', async t => {
  try { await execFileAsync(FFMPEG, ['-version']); } catch { t.skip('FFmpeg unavailable'); return; }
  const { base, root } = await fixture(t, { ffmpegPath: FFMPEG });
  const created = await createExport(base, { soundEffect: 'custom', frames: 1, customSoundPath: '/untrusted/path.wav' });
  assert.equal(created.response.status, 201);
  assert.equal((await upload(base, created.body.id, 0)).status, 200);
  const missing = await finish(base, created.body.id);
  assert.equal(missing.status, 400); assert.equal((await missing.json()).error.code, 'CUSTOM_SOUND_MISSING');
  assert.deepEqual(await readdir(path.join(root, 'exports')), []);
  assert.equal((await (await fetch(`${base}/api/health`)).json()).activeExport, false);
  const next = await createExport(base, { format: 'png-sequence', soundEffect: 'custom', frames: 1 });
  assert.equal(next.response.status, 201);
  const unsupported = await uploadSound(base, next.body.id, Buffer.from('ignored'));
  assert.equal(unsupported.status, 409);
  assert.equal((await upload(base, next.body.id, 0)).status, 200);
  assert.equal((await finish(base, next.body.id)).status, 200);
});

test('custom audio endpoint honors free watermarked jobs and rechecks paid authorization', async t => {
  try { await execFileAsync(FFMPEG, ['-version']); } catch { t.skip('FFmpeg unavailable'); return; }
  let activated = true;
  const betaService = { status: async () => ({ activated }), requireActivation: async () => {
    if (!activated) throw Object.assign(new Error('activation required'), { status: 403, code: 'ACTIVATION_REQUIRED' });
  } };
  const { base, root } = await fixture(t, { ffmpegPath: FFMPEG, betaService });
  const sound = await sourceSound(root), paid = await createExport(base, { soundEffect: 'custom' });
  assert.equal(paid.response.status, 201); activated = false;
  const denied = await uploadSound(base, paid.body.id, sound);
  assert.equal(denied.status, 403); assert.equal((await denied.json()).error.code, 'ACTIVATION_REQUIRED');
  assert.equal((await cancel(base, paid.body.id)).status, 200, 'an expired paid job can still be cancelled');
  const free = await createExport(base, { soundEffect: 'custom', exportMode: 'watermarked', frames: 1 });
  assert.equal(free.response.status, 201); assert.equal(free.body.watermarked, true);
  assert.equal((await uploadSound(base, free.body.id, sound)).status, 200);
  assert.equal((await upload(base, free.body.id, 0)).status, 200);
  const done = await finish(base, free.body.id); assert.equal(done.status, 200);
  assert.equal((await fetch(base + (await done.json()).url)).status, 200, 'free sound video download needs no activation');
  const unknown = await uploadSound(base, '11111111-1111-4111-8111-111111111111', sound);
  assert.equal(unknown.status, 403, 'query flags cannot grant custom upload access to an unknown job');
});

test('cancelling a custom upload closes its file, rejects concurrent work and releases the export slot', async t => {
  try { await execFileAsync(FFMPEG, ['-version']); } catch { t.skip('FFmpeg unavailable'); return; }
  const { base, root, port } = await fixture(t, { ffmpegPath: FFMPEG });
  const { body: { id } } = await createExport(base, { soundEffect: 'custom' });
  let request;
  const uploadResult = new Promise((resolve, reject) => {
    request = http.request({ hostname: '127.0.0.1', port, method: 'POST', path: `/api/exports/${id}/sound`,
      headers: { 'Content-Type': 'application/octet-stream', 'Transfer-Encoding': 'chunked' } }, response => {
      let body = ''; response.on('data', chunk => { body += chunk; });
      response.once('end', () => resolve({ status: response.statusCode, body: JSON.parse(body) }));
    });
    request.once('error', reject); request.write(Buffer.alloc(4096));
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await readdir(path.join(root, 'exports'))).some(name => name.endsWith('.sound-upload'))) break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  const concurrent = await uploadSound(base, id, Buffer.from('second upload'));
  assert.equal(concurrent.status, 409); assert.equal((await concurrent.json()).error.code, 'FRAME_IN_PROGRESS');
  assert.equal((await upload(base, id, 0)).status, 409);
  assert.equal((await finish(base, id)).status, 409);
  assert.equal((await cancel(base, id)).status, 200); request.end();
  const aborted = await uploadResult;
  assert.equal(aborted.status, 409); assert.equal(aborted.body.error.code, 'EXPORT_NOT_ACTIVE');
  assert.deepEqual(await readdir(path.join(root, 'exports')), []);
  assert.equal((await (await fetch(`${base}/api/health`)).json()).activeExport, false);
});

test('a disconnected custom uploader removes its partial file and allows a fresh upload', async t => {
  try { await execFileAsync(FFMPEG, ['-version']); } catch { t.skip('FFmpeg unavailable'); return; }
  const { base, root, port } = await fixture(t, { ffmpegPath: FFMPEG });
  const { body: { id } } = await createExport(base, { soundEffect: 'custom' });
  const request = http.request({ hostname: '127.0.0.1', port, method: 'POST', path: `/api/exports/${id}/sound`,
    headers: { 'Content-Type': 'application/octet-stream', 'Transfer-Encoding': 'chunked' } });
  request.on('error', () => {}); request.write(Buffer.alloc(4096));
  const source = path.join(root, 'exports', `${id}.sound-upload`);
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await readdir(path.join(root, 'exports'))).includes(`${id}.sound-upload`)) break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.ok((await readdir(path.join(root, 'exports'))).includes(`${id}.sound-upload`));
  request.destroy();
  for (let attempt = 0; attempt < 100; attempt++) {
    if (!(await readdir(path.join(root, 'exports'))).includes(`${id}.sound-upload`)) break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  await assert.rejects(readFile(source), { code: 'ENOENT' });
  const retried = await uploadSound(base, id, await sourceSound(root));
  assert.equal(retried.status, 200, await retried.clone().text());
  await cancel(base, id);
  assert.deepEqual(await readdir(path.join(root, 'exports')), []);
});

test('GET /api/version/check returns version check data from service', async t => {
  const mockService = {
    check: async ({ force }) => ({
      ok: true,
      currentVersion: '1.2.0-beta.6',
      latestVersion: '1.2.1',
      hasUpdate: true,
      forceChecked: Boolean(force),
      changelog: ['全新更新检测与弹窗提示'],
    }),
  };
  const { base } = await fixture(t, { versionCheckService: mockService });
  const response = await fetch(`${base}/api/version/check?force=true`);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.ok, true);
  assert.equal(data.hasUpdate, true);
  assert.equal(data.latestVersion, '1.2.1');
  assert.equal(data.forceChecked, true);
});
