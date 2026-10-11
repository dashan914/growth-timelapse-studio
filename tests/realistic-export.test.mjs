import test from 'node:test';
import assert from 'node:assert/strict';
import { realisticExportAvailability, realisticFramePlan, realisticProgress, waitForRealisticExport, abortableExportDelay, realisticDownloadResult } from '../src/realistic-export.js';
const id = '01234567-0123-4567-8901-012345678901';
const runtime = { available: true, limits: { maxFrames: 1800, maxTriangles: 5000000, maxObjects: 4096 } };

test('HQ eligibility identifies explicit lossless realtime alternatives rather than partially exporting unsupported content', () => {
  assert.equal(realisticExportAvailability({ runtime, metadata: { mode: 'mesh', triangles: 1541408, meshes: 14 } }).available, true);
  for (const options of [{ runtime: null }, { runtime: { available: false } }, { metadata: { mode: 'gcode' } }, { backgroundType: 'video' }, { appearance: 'photo' }, { showSupports: true, supportDisplay: 'paths', metadata: { supportsAvailable: true } }, { frames: 1801 }, { metadata: { triangles: 5000001 } }, { showSupports: true, metadata: { triangles: 10, supportSurfaceTriangles: 6000000 } }, { showSupports: true, metadata: { meshes: 14, supportSource: 'sliced-gcode', supportSegments: 4090 } }]) {
    const result = realisticExportAvailability({ runtime, ...options }); assert.equal(result.available, false); assert.ok(result.reason.length > 10);
  }
  assert.equal(realisticExportAvailability({ runtime, showSupports: false, metadata: { triangles: 1541408, supportSurfaceTriangles: 6000000 } }).available, true);
});

test('frame timing preserves exact requested duration and hold sampled from the existing realtime timeline', () => {
  assert.deepEqual(realisticFramePlan({ duration: 8, growth: 8, hold: 0, fps: 30 }), { frames: 240, growthFrames: 240, durationSeconds: 8, growthSeconds: 8 });
  const held = realisticFramePlan({ duration: 11, growth: 8, hold: 3, fps: 30 });
  assert.equal(held.frames, 330); assert.equal(held.growthFrames, 241); assert.equal(held.durationSeconds, 11); assert.equal(held.growthSeconds, 8);
  const previousTime = (held.growthFrames - 2) / (held.frames - 1) * 11, finishedTime = (held.growthFrames - 1) / (held.frames - 1) * 11;
  assert.ok(previousTime < 8); assert.ok(finishedTime >= 8); assert.ok(finishedTime - 8 < 1 / 30);
  const fractional = realisticFramePlan({ duration: 8.37, growth: 7.82, hold: 0.55, fps: 24 }); assert.equal(fractional.durationSeconds, 8.37); assert.equal(fractional.growthSeconds, 7.82);
});

test('polling reports queue/render/encode phases then returns a completed snapshot with bounded refresh interval', async () => {
  const states = ['queued', 'rendering', 'encoding', 'complete'], delivered = [], urls = [];
  const result = await waitForRealisticExport({ id, intervalMs: 1, request: async url => { urls.push(url); return { id, status: states.shift(), encoded: 3, total: 3 }; }, onSnapshot: snapshot => delivered.push(snapshot.status) });
  assert.equal(result.status, 'complete'); assert.deepEqual(delivered, ['queued', 'rendering', 'encoding', 'complete']); assert.equal(urls.length, 4); assert.equal(urls.every(url => url === `/api/realistic-exports/${id}`), true);
  assert.equal(realisticProgress({ status: 'encoding', encoded: 3, total: 3 }).percent, 95); assert.equal(realisticProgress({ status: 'complete', encoded: 3, total: 3 }).percent, 100);
});

test('aborting pending poll sleep or a request stops further polling and ignores a late successful response', async () => {
  const controller = new AbortController(); let calls = 0;
  const wait = waitForRealisticExport({ id, signal: controller.signal, request: async () => { calls++; return { id, status: 'rendering' }; } });
  await new Promise(resolve => setTimeout(resolve, 10)); controller.abort(); await assert.rejects(wait, error => error.name === 'AbortError'); assert.equal(calls, 1);
  const lateController = new AbortController(); let resolveRequest;
  const late = waitForRealisticExport({ id, signal: lateController.signal, request: () => new Promise(resolve => { resolveRequest = resolve; }) });
  lateController.abort(); resolveRequest({ id, status: 'complete' }); await assert.rejects(late, error => error.name === 'AbortError');
  await assert.rejects(abortableExportDelay(100, lateController.signal), error => error.name === 'AbortError');
});

test('completed cancellation response remains downloadable while incomplete or injected URLs are rejected', () => {
  const result = { id, status: 'complete', rendered: 3, encoded: 3, total: 3, bytes: 10000, filename: '测试.mp4', url: `/api/realistic-exports/${id}/file` };
  assert.deepEqual(realisticDownloadResult(result, id), { url: result.url, filename: result.filename, bytes: result.bytes });
  for (const patch of [{ status: 'cancelled' }, { rendered: 2 }, { encoded: 2 }, { url: 'javascript:alert(1)' }, { url: 'https://external.test/video.mp4' }]) assert.throws(() => realisticDownloadResult({ ...result, ...patch }, id));
});
