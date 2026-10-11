import test from 'node:test';
import assert from 'node:assert/strict';
import { photoCoverTransform, resizeMaskCover, readPhoto } from '../src/photo-io.js';

test('source photos use centered cover for output ratios instead of stretching', () => {
  const wide = photoCoverTransform({ originalWidth: 400, originalHeight: 300, width: 1600, height: 900 });
  assert.deepEqual(wide, { scale: 4, x: 0, y: -150, drawnWidth: 1600, drawnHeight: 1200 });
  assert.deepEqual({ x: 200 * wide.scale + wide.x, y: 150 * wide.scale + wide.y }, { x: 800, y: 450 });
  const square = photoCoverTransform({ originalWidth: 400, originalHeight: 300, width: 900, height: 900 });
  assert.deepEqual(square, { scale: 3, x: -150, y: 0, drawnWidth: 1200, drawnHeight: 900 });
});

test('translated target photos compensate analysis cover scale along both axes', () => {
  // An 8x4 photo covers an 8x6 analysis canvas at scale1.5, then the same
  // photo covers a16x12 output at scale3. A2px analysis shift is4px output.
  const transform = photoCoverTransform({ originalWidth: 8, originalHeight: 4, width: 16, height: 12, translation: { x: 2, y: -1 }, translationSize: { width: 8, height: 6 } });
  assert.equal(transform.scale, 3);
  assert.equal(transform.x, -8); // centered cover offset -4, compensation -4.
  assert.equal(transform.y, 2);
});

test('translation is applied to the whole source before cropping', () => {
  const transform = photoCoverTransform({ originalWidth: 8, originalHeight: 4, width: 12, height: 12, crop: { x: 0.25, y: 0, width: 0.5, height: 1 }, translation: { x: 2, y: 0 }, translationSize: { width: 8, height: 4 } });
  assert.deepEqual(transform, { scale: 3, x: -12, y: 0, drawnWidth: 24, drawnHeight: 12 });
  assert.equal((4 * transform.scale + transform.x), 0, 'source x4 becomes the aligned crop left edge');
});

test('mask downsampling follows output pixel centers, keeping the matching narrow outline', () => {
  const mask = new Uint8Array(8 * 4);
  mask[2 * 8 + 2] = 255;
  const reduced = resizeMaskCover(mask, 8, 4, 2, 1);
  assert.deepEqual(reduced, Uint8Array.from([255, 0]));
});

test('custom crop and arbitrary aspect ratios select the correct source-mask coordinates', () => {
  const mask = Uint8Array.from({ length: 8 * 6 }, (_, i) => i);
  const cropped = resizeMaskCover(mask, 8, 6, 4, 4, { x: 0.25, y: 1 / 6, width: 0.5, height: 2 / 3 });
  assert.equal(cropped[0], 10);
  assert.equal(cropped[3], 13);
  assert.equal(cropped[12], 34);
  assert.equal(cropped[15], 37);
  const wide = resizeMaskCover(mask, 8, 6, 8, 4);
  assert.equal(wide[0], 8);
  assert.equal(wide[31], 39);
});

test('invalid crops and incompatible mask dimensions fail instead of repeating edge foreground', () => {
  const options = { originalWidth: 8, originalHeight: 6, width: 8, height: 6 };
  assert.throws(() => photoCoverTransform({ ...options, crop: { x: -0.1, y: 0, width: 1, height: 1 } }), /裁切范围/);
  assert.throws(() => photoCoverTransform({ ...options, crop: { x: 0.2, y: 0, width: 0.9, height: 1 } }), /裁切范围/);
  assert.throws(() => photoCoverTransform({ ...options, crop: { x: 0, y: 0, width: 0, height: 1 } }), /裁切范围/);
  assert.throws(() => photoCoverTransform({ ...options, translation: { x: NaN, y: 0 }, translationSize: { width: 8, height: 6 } }), /对齐位移/);
  assert.throws(() => resizeMaskCover(new Uint8Array(2), 8, 6, 8, 6), /轮廓尺寸/);
  assert.throws(() => resizeMaskCover(new Uint8Array(48), 8, 6, 0, 6), /画面尺寸/);
});

test('photo reader draws the full aligned source over fallback and closes decoded images on success/failure', async t => {
  const originals = Object.fromEntries(['createImageBitmap', 'document', 'ImageData'].map(key => [key, globalThis[key]]));
  t.after(() => { for (const [key, value] of Object.entries(originals)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } });
  let closed = 0, failRead = false;
  const events = [];
  globalThis.createImageBitmap = async () => ({ width: 8, height: 4, close: () => closed++ });
  globalThis.ImageData = class { constructor(data, width, height) { this.data = data; this.width = width; this.height = height; } };
  globalThis.document = { createElement: () => {
    const canvas = { width: 0, height: 0 };
    canvas.getContext = () => ({
      putImageData: (...args) => events.push({ method: 'put', args }),
      drawImage: (...args) => events.push({ method: 'draw', args }),
      getImageData: () => { if (failRead) throw new Error('read failed'); return { data: new Uint8ClampedArray(canvas.width * canvas.height * 4) }; },
    });
    return canvas;
  } };
  const result = await readPhoto({}, { width: 12, height: 12, crop: { x: 0.25, y: 0, width: 0.5, height: 1 }, translation: { x: 2, y: 0 }, translationSize: { width: 8, height: 4 }, fallbackRGBA: new Uint8ClampedArray(12 * 12 * 4) });
  assert.equal(events[0].method, 'put');
  assert.equal(events[1].method, 'draw');
  assert.deepEqual(events[1].args.slice(1), [-12, 0, 24, 12]);
  assert.deepEqual([result.width, result.height, result.originalWidth, result.originalHeight], [12, 12, 8, 4]);
  assert.equal(closed, 1);
  failRead = true;
  await assert.rejects(readPhoto({}, { maxWidth: 4 }), /read failed/);
  assert.equal(closed, 2);
});
