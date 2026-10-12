import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { createBetaActivationService, verifyBetaLicense, BETA_PRODUCT_ID } from '../beta-activation.mjs';
import { createApp } from '../server.mjs';

const code = 'GTB1-ABCDE-FGHJK-LMNPQ-RSTUV-WXY23-4';
const keyId = 'beta-test';
function signer() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const publicKeys = { [keyId]: publicKey.export({ type: 'spki', format: 'pem' }).toString() };
  return {
    publicKeys,
    mint(installationId, extra = {}) {
      const value = { version: 1, productId: BETA_PRODUCT_ID, codeId: randomUUID(), installationId, issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: null, ...extra };
      const payload = Buffer.from(JSON.stringify(value));
      return { version: 1, algorithm: 'Ed25519', keyId, payload: payload.toString('base64url'), signature: sign(null, payload, privateKey).toString('base64url') };
    }
  };
}
async function fixture(t, options = {}) {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), 'growth-beta-'));
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));
  const signing = signer();
  const config = { productId: BETA_PRODUCT_ID, serverUrl: 'https://beta.example.test', redemptionUrl: 'https://beta.example.test/points', publicKeys: signing.publicKeys };
  return { dataDirectory, signing, config, service: createBetaActivationService({ dataDirectory, config, ...options }) };
}

test('signed credentials reject tampering, other installations, wrong products, unknown keys and expiration', () => {
  const keys = signer(), installationId = randomUUID();
  const license = keys.mint(installationId);
  assert.equal(verifyBetaLicense(license, { ...keys, installationId }).installationId, installationId);
  assert.throws(() => verifyBetaLicense({ ...license, signature: 'A'.repeat(86) }, { ...keys, installationId }), { code: 'INVALID_LICENSE' });
  assert.throws(() => verifyBetaLicense(license, { ...keys, installationId: randomUUID() }), { code: 'INVALID_LICENSE' });
  assert.throws(() => verifyBetaLicense(keys.mint(installationId, { productId: 'another-product' }), { ...keys, installationId }), { code: 'INVALID_LICENSE' });
  assert.throws(() => verifyBetaLicense({ ...license, keyId: 'untrusted' }, { ...keys, installationId }), { code: 'INVALID_LICENSE' });
  assert.throws(() => verifyBetaLicense(keys.mint(installationId, { issuedAt: new Date(Date.now() - 2000).toISOString(), expiresAt: new Date(Date.now() - 500).toISOString() }), { ...keys, installationId }), { code: 'BETA_EXPIRED' });
  assert.throws(() => verifyBetaLicense(keys.mint(installationId, { issuedAt: new Date(Date.now() + 600_000).toISOString() }), { ...keys, installationId }), { code: 'INVALID_LICENSE' });
});

test('first activation persists only a verified certificate and survives restart without network', async t => {
  const f = await fixture(t);
  let calls = 0;
  const online = createBetaActivationService({ ...f, fetchImpl: async (url, options) => {
    calls++; assert.equal(String(url), 'https://beta.example.test/api/software-beta/activate');
    const body = JSON.parse(options.body); assert.equal(body.code, code); assert.ok(!Object.hasOwn(body, 'files'));
    return Response.json({ license: f.signing.mint(body.installationId) });
  } });
  assert.equal((await online.status()).activated, false);
  assert.equal((await online.activate(code.toLowerCase())).activated, true);
  const originalId = (await online.status()).installationId;
  const saved = await readFile(path.join(f.dataDirectory, 'beta', 'license.json'), 'utf8');
  assert.ok(!saved.includes(code)); assert.equal(calls, 1);
  const offline = createBetaActivationService({ ...f, fetchImpl: async () => { throw new Error('network offline'); } });
  assert.equal((await offline.status()).installationId, originalId);
  assert.equal((await offline.status()).activated, true);
  await offline.requireActivation();
});

test('failed remote activation and untrusted credentials never unlock or create a license', async t => {
  const f = await fixture(t);
  const rejected = createBetaActivationService({ ...f, fetchImpl: async () => Response.json({ error: { code: 'DEVICE_LIMIT', message: '已达到设备上限。' } }, { status: 409 }) });
  await assert.rejects(rejected.activate(code), { code: 'DEVICE_LIMIT' });
  assert.equal((await rejected.status()).activated, false);
  await assert.rejects(readFile(path.join(f.dataDirectory, 'beta', 'license.json')), { code: 'ENOENT' });
  const tampered = createBetaActivationService({ ...f, fetchImpl: async () => Response.json({ license: signer().mint(randomUUID()) }) });
  await assert.rejects(tampered.activate(code), { code: 'INVALID_LICENSE' });
  assert.equal((await tampered.status()).activated, false);
});

test('corrupted cached credentials lock exports and do not silently discard the installation', async t => {
  const f = await fixture(t); const current = await f.service.status();
  await writeFile(path.join(f.dataDirectory, 'beta', 'license.json'), '{broken');
  const restarted = createBetaActivationService(f);
  const result = await restarted.status();
  assert.equal(result.activated, false); assert.equal(result.installationId, current.installationId);
  await assert.rejects(restarted.requireActivation(), { code: 'ACTIVATION_REQUIRED' });
});

function png() {
  const crc32 = bytes => {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const name = Buffer.from(type), bytes = Buffer.alloc(data.length + 12);
    bytes.writeUInt32BE(data.length); name.copy(bytes, 4); data.copy(bytes, 8);
    bytes.writeUInt32BE(crc32(Buffer.concat([name, data])), bytes.length - 4);
    return bytes;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(64, 0); header.writeUInt32BE(64, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.alloc(64 * (1 + 64 * 4)))), chunk('IEND', Buffer.alloc(0))]);
}

async function apiFixture(t, f) {
  const root = await mkdtemp(path.join(tmpdir(), 'growth-export-access-'));
  await writeFile(path.join(root, 'index.html'), '<!doctype html><title>Free workspace</title>');
  const image = png(), sliceId = randomUUID(), tasks = new Map(), calls = { slices: 0, previews: 0, exports: 0 };
  await writeFile(path.join(root, 'preview.png'), image);
  await writeFile(path.join(root, 'render.zip'), 'signed-export');
  await writeFile(path.join(root, 'slice.gcode'), 'G1 X10 Y20 E1\n');
  await writeFile(path.join(root, 'slice.json'), '{}');
  const identify = (id, options) => {
    const task = tasks.get(id);
    if (!task || options.preview !== (task.format === 'preview')) {
      const error = new Error('找不到任务。'); error.status = 404; error.code = 'REALISTIC_EXPORT_NOT_FOUND'; throw error;
    }
    return task;
  };
  const app = createApp({ root, betaService: f.service, ffmpegPath: '/missing-ffmpeg', supportsSlicerPath: '/missing-slicer',
    photoCalibrationService: { capability: async () => ({ available: true }), detect: async () => ({ lines: [], confidence: 'low' }) },
    sliceService: {
      health: async () => ({ available: true }), close: async () => {},
      create: async request => { for await (const _chunk of request) {} calls.slices++; return { id: sliceId }; },
      snapshot: () => ({ id: sliceId, status: 'complete' }), provenance: async () => ({ geometrySimplified: false }),
      gcodeFile: async () => path.join(root, 'slice.gcode'), file: async () => path.join(root, 'slice.json'), cancel: async () => ({ cancelled: true }),
    },
    realisticRenderService: {
      health: async () => ({ available: true }), close: async () => {}, active: false,
      create: async (_body, options) => {
        const id = randomUUID(), task = { id, format: options.format, status: 'complete' };
        tasks.set(id, task); calls[options.format === 'preview' ? 'previews' : 'exports']++;
        return task;
      },
      snapshot: (id, options) => identify(id, options),
      file: async (id, options) => { identify(id, options); return { path: path.join(root, options.preview ? 'preview.png' : 'render.zip'), name: 'render.zip' }; },
      cancel: async (id, options) => { const task = identify(id, options); task.status = 'cancelled'; return task; },
    },
  });
  await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = (route, method = 'GET', body, type = 'application/json') => fetch(base + route, {
    method, headers: { Origin: base, ...(body === undefined ? {} : { 'Content-Type': type }) },
    ...(body === undefined ? {} : { body: typeof body === 'object' && !Buffer.isBuffer(body) ? JSON.stringify(body) : body }),
  });
  return { root, base, request, image, sliceId, calls, tasks };
}

const exportOptions = { width: 64, height: 64, fps: 5, frames: 1, name: 'unlocked', format: 'png-sequence' };

async function assertFreeWorkspace(api) {
  assert.equal((await api.request('/')).status, 200);
  const health = await (await api.request('/api/health')).json();
  assert.equal(health.app, 'growth-timelapse-studio'); assert.equal(health.slicing.available, true);
  assert.equal((await api.request('/api/slices', 'POST', Buffer.from('model'), 'application/octet-stream')).status, 201);
  for (const suffix of ['', '/gcode', '/manifest', '/provenance']) assert.equal((await api.request(`/api/slices/${api.sliceId}${suffix}`)).status, 200);
  assert.equal((await api.request(`/api/slices/${api.sliceId}/gcode`, 'HEAD')).status, 200);
  assert.equal((await api.request(`/api/slices/${api.sliceId}`, 'DELETE')).status, 200);
  assert.equal((await api.request('/api/calibration/uprights', 'POST', api.image, 'image/png')).status, 200);
  const support = await api.request('/api/supports', 'POST', Buffer.from('model'), 'application/octet-stream');
  assert.equal(support.status, 503); assert.equal((await support.json()).error.code, 'SUPPORT_SLICER_UNAVAILABLE');
  const response = await api.request('/api/realistic-previews?format=mp4', 'POST', Buffer.from('scene'), 'application/zip');
  assert.equal(response.status, 201);
  const preview = await response.json(); assert.equal(preview.format, 'preview');
  assert.equal((await api.request(`/api/realistic-previews/${preview.id}`)).status, 200);
  const image = await api.request(`/api/realistic-previews/${preview.id}/file`);
  assert.equal(image.status, 200); assert.equal(image.headers.get('content-disposition'), null);
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), api.image);
  assert.equal((await api.request(`/api/realistic-previews/${preview.id}/file`, 'HEAD')).status, 200);
  assert.equal((await api.request(`/api/realistic-previews/${preview.id}`, 'DELETE')).status, 200);
}

async function assertExportDenied(api, reason, id = randomUUID()) {
  const routes = [
    ['/api/exports', 'POST', exportOptions],
    [`/api/exports/${id}/frames?index=0`, 'POST', api.image, 'image/png'],
    [`/api/exports/${id}/background`, 'POST', Buffer.from('video'), 'video/mp4'],
    [`/api/exports/${id}/finish`, 'POST'],
    [`/api/exports/${id}/file`, 'GET'], [`/api/exports/${id}/file`, 'HEAD'],
    ['/api/realistic-exports?format=png-sequence', 'POST', Buffer.from('scene'), 'application/zip'],
    [`/api/realistic-exports/${id}`, 'GET'],
    [`/api/realistic-exports/${id}/file`, 'GET'], [`/api/realistic-exports/${id}/file`, 'HEAD'],
  ];
  for (const [route, method, body, type] of routes) {
    const response = await api.request(route, method, body, type);
    assert.equal(response.status, 403, `${method} ${route}`);
    if (method !== 'HEAD') assert.equal((await response.json()).error.code, reason, route);
  }
}

test('without a code the HTTP workspace and all preview routes remain free while every export phase is locked', async t => {
  const f = await fixture(t), api = await apiFixture(t, f);
  const status = await (await api.request('/api/beta/status')).json();
  assert.equal(status.activated, false); assert.match(status.message, /导出未解锁.*兑换码/);
  await assertFreeWorkspace(api);
  await assertExportDenied(api, 'ACTIVATION_REQUIRED');
  assert.equal(api.calls.slices, 1); assert.equal(api.calls.previews, 1); assert.equal(api.calls.exports, 0);
  assert.equal((await api.request(`/api/exports/${randomUUID()}`, 'DELETE')).status, 404);
  assert.equal((await api.request(`/api/realistic-exports/${randomUUID()}`, 'DELETE')).status, 404);
  assert.equal((await api.request('/api/not-a-route')).status, 404);
  await assert.rejects(readdir(path.join(api.root, 'exports')), { code: 'ENOENT' });
});

test('invalid and expired signed credentials affect exports without blocking import, calibration or realistic previews', async t => {
  for (const reason of ['INVALID_LICENSE', 'BETA_EXPIRED']) await t.test(reason, async t => {
    const f = await fixture(t), { installationId } = await f.service.status();
    const license = reason === 'INVALID_LICENSE'
      ? signer().mint(installationId)
      : f.signing.mint(installationId, { issuedAt: new Date(Date.now() - 2000).toISOString(), expiresAt: new Date(Date.now() - 1000).toISOString() });
    await writeFile(path.join(f.dataDirectory, 'beta', 'license.json'), JSON.stringify(license));
    f.service = createBetaActivationService(f);
    const api = await apiFixture(t, f);
    await assertFreeWorkspace(api);
    await assertExportDenied(api, reason);
    assert.equal((await (await api.request('/api/beta/status')).json()).reason, reason);
  });
});

test('a verified existing certificate unlocks complete PNG export and realistic export over HTTP', async t => {
  const f = await fixture(t), { installationId } = await f.service.status();
  await writeFile(path.join(f.dataDirectory, 'beta', 'license.json'), JSON.stringify(f.signing.mint(installationId)));
  f.service = createBetaActivationService({ ...f, fetchImpl: async () => { throw new Error('offline'); } });
  const api = await apiFixture(t, f);
  assert.equal((await (await api.request('/api/beta/status')).json()).activated, true);
  const created = await api.request('/api/exports', 'POST', exportOptions);
  assert.equal(created.status, 201); const { id } = await created.json();
  assert.equal((await api.request(`/api/exports/${id}/frames?index=0`, 'POST', api.image, 'image/png')).status, 200);
  const completed = await api.request(`/api/exports/${id}/finish`, 'POST');
  assert.equal(completed.status, 200); const output = await completed.json();
  const file = await api.request(output.url); assert.equal(file.status, 200);
  assert.match(file.headers.get('content-disposition'), /attachment/);
  const archive = Buffer.from(await file.arrayBuffer()); assert.deepEqual(archive.subarray(0, 4), Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  assert.equal((await api.request(output.url, 'HEAD')).status, 200);
  const rendered = await api.request('/api/realistic-exports?format=png-sequence', 'POST', Buffer.from('scene'), 'application/zip');
  assert.equal(rendered.status, 201); const render = await rendered.json(); assert.equal(api.calls.exports, 1);
  assert.equal((await api.request(`/api/realistic-exports/${render.id}`)).status, 200);
  assert.equal((await api.request(`/api/realistic-exports/${render.id}/file`)).status, 200);
  assert.equal((await api.request(`/api/realistic-previews/${render.id}/file`)).status, 404, 'an export must not be downloadable through the free preview route');
});

test('HTTP redemption verifies a signed credential and expiry blocks further export work but permits cleanup', async t => {
  let now = Date.now(); const expiresAt = new Date(now + 10_000).toISOString();
  const f = await fixture(t);
  f.service = createBetaActivationService({ ...f, now: () => now, fetchImpl: async (_url, options) => Response.json({ license: f.signing.mint(JSON.parse(options.body).installationId, { expiresAt }) }) });
  const api = await apiFixture(t, f);
  const activated = await api.request('/api/beta/activate', 'POST', { code });
  assert.equal(activated.status, 200); assert.equal((await activated.json()).activated, true);
  const first = await api.request('/api/exports', 'POST', exportOptions);
  assert.equal(first.status, 201); const { id } = await first.json();
  const rendered = await api.request('/api/realistic-exports?format=png-sequence', 'POST', Buffer.from('scene'), 'application/zip');
  assert.equal(rendered.status, 201); const render = await rendered.json();
  now += 20_000;
  await assertExportDenied(api, 'BETA_EXPIRED', id);
  const blockedDownload = await api.request(`/api/realistic-exports/${render.id}/file`);
  assert.equal(blockedDownload.status, 403); assert.equal((await blockedDownload.json()).error.code, 'BETA_EXPIRED');
  assert.equal((await api.request(`/api/exports/${id}`, 'DELETE')).status, 200);
  assert.equal((await api.request(`/api/realistic-exports/${render.id}`, 'DELETE')).status, 200);
  assert.deepEqual(await readdir(path.join(api.root, 'exports')), []);
  await assertFreeWorkspace(api);
});
