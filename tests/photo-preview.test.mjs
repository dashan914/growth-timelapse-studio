import test from 'node:test';
import assert from 'node:assert/strict';
import { PhotoPreviewRenderer } from '../src/photo-preview.js';

const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
function rgba(width, height, color) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set(color, i);
  return data;
}

function prepared(width, height, finalColor = [220, 50, 40, 255]) {
  const heights = new Uint16Array(width * height), mappedMask = new Uint8Array(width * height).fill(255);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) heights[y * width + x] = Math.round((height - 1 - y) / (height - 1) * 65535);
  return { state: { emptyRGBA: rgba(width, height, [20, 30, 40, 255]), targetRGBA: rgba(width, height, finalColor), heights, mappedMask, width, height } };
}

function canvasFixture(t) {
  const original = globalThis.ImageData;
  globalThis.ImageData = class { constructor(data, width, height) { this.data = data; this.width = width; this.height = height; } };
  t.after(() => { if (original === undefined) delete globalThis.ImageData; else globalThis.ImageData = original; });
  const canvas = { width: 0, height: 0, hidden: false, pixels: null };
  canvas.getContext = () => ({
    clearRect: () => { canvas.pixels = new Uint8ClampedArray(canvas.width * canvas.height * 4); },
    drawImage: source => { canvas.pixels.set(source.pixels); },
    getImageData: () => ({ data: canvas.pixels.slice() }),
    putImageData: image => { canvas.pixels = image.data.slice(); },
  });
  return canvas;
}

test('cached preview redraws synchronously for playback and has exact real-photo endpoints', async t => {
  const canvas = canvasFixture(t), width = 16, height = 12;
  let calls = 0, renders = 0;
  const model = { pixels: rgba(width, height, [80, 90, 100, 255]) }, frame = prepared(width, height);
  const preview = new PhotoPreviewRenderer({ canvas, prepare: async () => { calls++; return frame; }, renderBase: () => { renders++; return model; }, debounceMs: 0 });
  t.after(() => preview.dispose());
  assert.equal(preview.update({ enabled: true, key: 'pose-a', width, height, progress: 0 }), false);
  await pause(5);
  assert.equal(preview.ready, true);
  assert.deepEqual(canvas.pixels, frame.state.emptyRGBA);
  assert.equal(preview.update({ enabled: true, key: 'pose-a', width, height, progress: 0.5 }), true);
  assert.deepEqual(Array.from(canvas.pixels.subarray(0, 4)), [80, 90, 100, 255], 'high surface uses current model cap/interior fallback');
  assert.deepEqual(Array.from(canvas.pixels.subarray((height - 1) * width * 4, (height - 1) * width * 4 + 4)), [220, 50, 40, 255]);
  preview.update({ enabled: true, key: 'pose-a', width, height, progress: 1 });
  assert.deepEqual(canvas.pixels, frame.state.targetRGBA);
  assert.equal(calls, 1);
  assert.equal(renders, 3, 'render again after asynchronous preparation, then once per playback update');
  preview.update({ enabled: false });
  assert.equal(canvas.hidden, true);
  assert.equal(preview.ready, false);
});

test('debouncing coalesces changing poses and progress changes do not restart preparation', async t => {
  const canvas = canvasFixture(t), calls = [];
  const preview = new PhotoPreviewRenderer({ canvas, prepare: async (w, h, { key }) => { calls.push(key); return prepared(w, h); }, renderBase: () => ({ pixels: rgba(16, 12, [80, 90, 100, 255]) }), debounceMs: 5 });
  t.after(() => preview.dispose());
  preview.update({ enabled: true, key: 'old', width: 16, height: 12, progress: 0 });
  preview.update({ enabled: true, key: 'new', width: 16, height: 12, progress: 0.1 });
  preview.update({ enabled: true, key: 'new', width: 16, height: 12, progress: 0.8 });
  await pause(12);
  assert.deepEqual(calls, ['new']);
  assert.equal(preview.ready, true);
  assert.deepEqual(Array.from(canvas.pixels.subarray(3 * 16 * 4, 3 * 16 * 4 + 4)), [220, 50, 40, 255], 'latest progress is used after preparation');
});

test('late asynchronous results from an old camera/pose cannot replace the newest overlay', async t => {
  const canvas = canvasFixture(t), deferred = new Map();
  const preview = new PhotoPreviewRenderer({ canvas, prepare: (w, h, { key }) => new Promise(resolve => deferred.set(key, () => resolve(prepared(w, h, key === 'b' ? [40, 220, 50, 255] : [220, 50, 40, 255])))), renderBase: () => ({ pixels: rgba(16, 12, [80, 90, 100, 255]) }), debounceMs: 0 });
  t.after(() => preview.dispose());
  preview.update({ enabled: true, key: 'a', width: 16, height: 12, progress: 1 });
  await pause(5);
  preview.update({ enabled: true, key: 'b', width: 16, height: 12, progress: 1 });
  assert.equal(canvas.hidden, true);
  await pause(5);
  deferred.get('b')(); await pause(0);
  assert.deepEqual(Array.from(canvas.pixels.subarray(0, 4)), [40, 220, 50, 255]);
  deferred.get('a')(); await pause(0);
  assert.deepEqual(Array.from(canvas.pixels.subarray(0, 4)), [40, 220, 50, 255]);
  assert.equal(preview.ready, true);
});

test('unmatched photo errors hide the overlay and report once until pose changes or invalidates', async t => {
  const canvas = canvasFixture(t), errors = [];
  let calls = 0;
  const preview = new PhotoPreviewRenderer({ canvas, prepare: async (w, h, { key }) => { calls++; if (key === 'bad') throw new Error('重合不足'); return prepared(w, h); }, renderBase: () => ({ pixels: rgba(16, 12, [80, 90, 100, 255]) }), onError: error => errors.push(error.message), debounceMs: 0 });
  t.after(() => preview.dispose());
  preview.update({ enabled: true, key: 'bad', width: 16, height: 12, progress: 0.2 }); await pause(5);
  for (let i = 0; i < 4; i++) preview.update({ enabled: true, key: 'bad', width: 16, height: 12, progress: i / 4 });
  await pause(5);
  assert.equal(calls, 1); assert.deepEqual(errors, ['重合不足']); assert.equal(canvas.hidden, true);
  preview.update({ enabled: true, key: 'good', width: 16, height: 12, progress: 0.2 }); await pause(5);
  assert.equal(preview.ready, true);
  preview.invalidate(); assert.equal(canvas.hidden, true);
  preview.update({ enabled: true, key: 'good', width: 16, height: 12, progress: 0.4 }); await pause(5);
  assert.equal(calls, 3);
});

test('preview preparation caps the longest side at640 while retaining the output ratio', async t => {
  const canvas = canvasFixture(t), sizes = [];
  const preview = new PhotoPreviewRenderer({ canvas, prepare: async (w, h) => { sizes.push([w, h]); return prepared(w, h); }, renderBase: () => ({ pixels: rgba(640, 360, [80, 90, 100, 255]) }), debounceMs: 0 });
  t.after(() => preview.dispose());
  preview.update({ enabled: true, key: 'wide', width: 1600, height: 900, progress: 0.5 }); await pause(5);
  assert.deepEqual(sizes, [[640, 360]]);
  assert.deepEqual([canvas.width, canvas.height], [640, 360]);
  assert.equal(preview.ready, true);
});

test('disposal and disabled mode prevent pending work from showing a stale overlay', async t => {
  const canvas = canvasFixture(t);
  let calls = 0;
  const preview = new PhotoPreviewRenderer({ canvas, prepare: async (w, h) => { calls++; return prepared(w, h); }, renderBase: () => ({ pixels: rgba(16, 12, [80, 90, 100, 255]) }), debounceMs: 5 });
  preview.update({ enabled: true, key: 'a', width: 16, height: 12, progress: 0.4 });
  preview.dispose();
  await pause(10);
  assert.equal(calls, 0); assert.equal(canvas.hidden, true);
  assert.equal(preview.update({ enabled: true, key: 'a', width: 16, height: 12 }), false);
});
