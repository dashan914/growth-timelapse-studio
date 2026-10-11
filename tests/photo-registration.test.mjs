import test from 'node:test';
import assert from 'node:assert/strict';
import { analysePhotoPair, autoAlignModel, maskBounds } from '../src/photo-registration.js';

function photo(width = 96, height = 72, textured = true) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const texture = textured ? (x * 17 + y * 23 + x * y * 3) % 79 : 0;
      data.set([70 + texture, 92 + texture, 105 + texture, 255], i);
    }
  }
  return data;
}

function paintRectangle(data, width, x0, y0, w, h, color) {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) data.set([...color, 255], (y * width + x) * 4);
}

function area(mask) { return mask.reduce((sum, value) => sum + (value ? 1 : 0), 0); }

function iou(a, b) {
  let intersection = 0, union = 0;
  for (let i = 0; i < a.length; i++) { if (a[i] && b[i]) intersection++; if (a[i] || b[i]) union++; }
  return intersection / Math.max(1, union);
}

function rectangleMask(width, height, x, y, w, h) {
  const mask = new Uint8Array(width * height);
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) mask[yy * width + xx] = 255;
  return mask;
}

test('fixed-camera photo pair identifies a multicolored object and preserves real openings', () => {
  const width = 96, height = 72, emptyRGBA = photo(width, height), targetRGBA = emptyRGBA.slice();
  paintRectangle(targetRGBA, width, 37, 18, 22, 36, [220, 35, 68]);
  paintRectangle(targetRGBA, width, 37, 37, 22, 17, [240, 215, 38]);
  for (let y = 24; y < 31; y++) for (let x = 43; x < 51; x++) targetRGBA.set(emptyRGBA.subarray((y * width + x) * 4, (y * width + x) * 4 + 4), (y * width + x) * 4);
  const result = analysePhotoPair({ emptyRGBA, targetRGBA, width, height });
  const expected = rectangleMask(width, height, 37, 18, 22, 36);
  for (let y = 24; y < 31; y++) for (let x = 43; x < 51; x++) expected[y * width + x] = 0;
  assert.ok(iou(result.mask, expected) > 0.99);
  assert.deepEqual({ x: result.translation.x, y: result.translation.y }, { x: 0, y: 0 });
  assert.deepEqual([result.bbox.x, result.bbox.y, result.bbox.width, result.bbox.height], [37, 18, 22, 36]);
  assert.ok(result.confidence > 0.7 && result.confidence < 1);
  assert.equal(result.usable, true);
  assert.equal(result.mask[27 * width + 46], 0, 'do not fill actual holes in a model');
});

test('global affine exposure changes do not become a fabricated object', () => {
  const width = 96, height = 72, emptyRGBA = photo(width, height), targetRGBA = emptyRGBA.slice();
  for (let i = 0; i < targetRGBA.length; i += 4) {
    targetRGBA[i] = emptyRGBA[i] * 1.12 + 9;
    targetRGBA[i + 1] = emptyRGBA[i + 1] * 1.06 + 6;
    targetRGBA[i + 2] = emptyRGBA[i + 2] * 1.08 - 2;
  }
  const result = analysePhotoPair({ emptyRGBA, targetRGBA, width, height });
  assert.equal(area(result.mask), 0);
  assert.equal(result.usable, false);
  assert.equal(result.confidence, 0);
  assert.match(result.warnings.join(' '), /没有识别到/);
  assert.ok(Math.abs(result.exposure.gain[0] - 1.12) < 0.015);
});

test('small camera translation and illumination change yield a mask in the empty-photo coordinate system', () => {
  const width = 96, height = 72, emptyRGBA = photo(width, height), scene = emptyRGBA.slice();
  paintRectangle(scene, width, 42, 19, 19, 33, [222, 66, 36]);
  const targetRGBA = photo(width, height), dx = 3, dy = -2;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const tx = x + dx, ty = y + dy;
      if (tx < 0 || tx >= width || ty < 0 || ty >= height) continue;
      const a = (y * width + x) * 4, b = (ty * width + tx) * 4;
      for (let channel = 0; channel < 3; channel++) targetRGBA[b + channel] = scene[a + channel] * 1.08 + 3;
      targetRGBA[b + 3] = 255;
    }
  }
  const result = analysePhotoPair({ emptyRGBA, targetRGBA, width, height });
  assert.deepEqual([result.translation.x, result.translation.y], [dx, dy]);
  assert.ok(iou(result.mask, rectangleMask(width, height, 42, 19, 19, 33)) > 0.98);
  assert.equal(result.alignedTargetRGBA[(26 * width + 48) * 4], targetRGBA[((26 + dy) * width + 48 + dx) * 4]);
  assert.ok(result.translation.backgroundResidual < 1);
});

test('a textured cast shadow can be excluded while a colored object is retained', () => {
  const width = 96, height = 72, emptyRGBA = photo(width, height), targetRGBA = emptyRGBA.slice();
  paintRectangle(targetRGBA, width, 34, 18, 22, 34, [228, 44, 57]);
  for (let y = 52; y < 62; y++) for (let x = 38; x < 76; x++) {
    const i = (y * width + x) * 4;
    for (let channel = 0; channel < 3; channel++) targetRGBA[i + channel] = emptyRGBA[i + channel] * 0.7;
  }
  const result = analysePhotoPair({ emptyRGBA, targetRGBA, width, height });
  assert.ok(result.suppressedShadowPixels > 200);
  assert.equal(result.mask[57 * width + 60], 0);
  assert.equal(result.mask[30 * width + 42], 255);
  assert.match(result.warnings.join(' '), /阴影/);
});

test('flat dark changes stay visible and report shadow ambiguity rather than delete a dark model', () => {
  const width = 96, height = 72, emptyRGBA = photo(width, height, false), targetRGBA = emptyRGBA.slice();
  paintRectangle(targetRGBA, width, 35, 18, 24, 36, [49, 64, 74]);
  const result = analysePhotoPair({ emptyRGBA, targetRGBA, width, height });
  assert.equal(result.suppressedShadowPixels, 0);
  assert.ok(iou(result.mask, rectangleMask(width, height, 35, 18, 24, 36)) > 0.99);
  assert.match(result.warnings.join(' '), /无法可靠区分/);
  assert.deepEqual([result.translation.x, result.translation.y], [0, 0], 'flat scenes cannot determine camera translation');
});

test('changed majority, absent photos, and incompatible sizes are not reported as trustworthy alignment', () => {
  const width = 96, height = 72, emptyRGBA = photo(width, height), targetRGBA = emptyRGBA.slice();
  paintRectangle(targetRGBA, width, 1, 1, 94, 70, [10, 240, 20]);
  const result = analysePhotoPair({ emptyRGBA, targetRGBA, width, height });
  assert.equal(result.usable, false);
  assert.ok(result.confidence <= 0.2);
  assert.throws(() => analysePhotoPair({ emptyRGBA, targetRGBA: new Uint8Array(8), width, height }), /相同尺寸/);
  assert.throws(() => analysePhotoPair({ width, height }), /RGBA/);
  assert.equal(maskBounds(new Uint8Array(width * height), width, height), null);
});

function projectedBox({ x, y, scale, yaw }, width, height) {
  const mask = new Uint8Array(width * height), angle = yaw * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle);
  for (let yy = 0; yy < height; yy++) {
    for (let xx = 0; xx < width; xx++) {
      const dx = xx + 0.5 - x, dy = yy + 0.5 - y;
      const u = (c * dx + s * dy) / scale, v = (-s * dx + c * dy) / scale;
      if (Math.abs(u) < 8 && Math.abs(v) < 15) mask[yy * width + xx] = 255;
    }
  }
  return mask;
}

test('bounded coarse-to-fine fitting finds translation, scale and rotation from initially disjoint silhouettes', async () => {
  const width = 96, height = 72, expected = { x: 68, y: 43, scale: 1.35, yaw: 22 };
  const targetMask = projectedBox(expected, width, height), initialParams = { x: 22, y: 20, scale: 0.7, yaw: -20 };
  let calls = 0, progress = 0;
  const options = {
    targetMask, width, height, initialParams, bounds: { x: [10, 85], y: [8, 64], scale: [0.5, 2], yaw: [-45, 45] },
    renderMask: async (params, w, h) => { calls++; assert.equal(w, width); assert.equal(h, height); return { data: projectedBox(params, w, h), width: w, height: h }; },
    onProgress: ({ evaluations }) => { assert.ok(evaluations > progress); progress = evaluations; }, maxEvaluations: 180,
  };
  const result = await autoAlignModel(options);
  assert.ok(result.iou > 0.9, `IoU ${result.iou}: ${JSON.stringify(result.params)}`);
  assert.ok(result.score > result.initialScore + 0.6);
  assert.ok(Math.abs(result.params.x - expected.x) < 1.5 && Math.abs(result.params.y - expected.y) < 1.5);
  assert.ok(Math.abs(result.params.scale - expected.scale) < 0.08);
  assert.ok(Math.abs(result.params.yaw - expected.yaw) < 4);
  assert.ok(calls <= 180);
  assert.equal(calls, result.evaluations);
  assert.equal(result.cancelled, false);
  assert.ok(result.confidence < 1);
  assert.match(result.limitations.join(' '), /姿态唯一/);
});

test('perfect initial alignment completes with one render and leaves input parameters unchanged', async () => {
  const width = 64, height = 64, initialParams = { x: 32, y: 32, scale: 1, yaw: 12 };
  const before = { ...initialParams };
  const targetMask = projectedBox(initialParams, width, height);
  const result = await autoAlignModel({ targetMask: { mask: targetMask, width, height }, initialParams, bounds: { x: [0, 64], scale: [0.5, 2] }, renderMask: params => projectedBox(params, width, height) });
  assert.equal(result.evaluations, 1);
  assert.equal(result.iou, 1);
  assert.deepEqual(initialParams, before);
});

test('alignment cancellation and render budget are honored without thousands of GPU calls', async () => {
  const width = 64, height = 64, targetMask = projectedBox({ x: 40, y: 35, scale: 1.3, yaw: 16 }, width, height);
  const initialParams = { x: 18, y: 18, scale: 0.7, yaw: 0 }, bounds = { x: [0, 64], y: [0, 64], scale: [0.5, 2], yaw: [-45, 45] };
  let calls = 0;
  const result = await autoAlignModel({ targetMask, width, height, initialParams, bounds, renderMask: params => { calls++; return projectedBox(params, width, height); }, shouldCancel: () => calls >= 14 });
  assert.equal(result.cancelled, true);
  assert.equal(calls, 14);
  assert.ok(result.score >= result.initialScore);
  const budgeted = await autoAlignModel({ targetMask, width, height, initialParams, bounds, renderMask: params => projectedBox(params, width, height), maxEvaluations: 9 });
  assert.equal(budgeted.evaluations, 9);
  assert.equal(budgeted.cancelled, false);
});

test('silhouette fitting rejects empty targets, invalid ranges and mismatched render sizes', async () => {
  const width = 64, height = 64, targetMask = projectedBox({ x: 32, y: 32, scale: 1, yaw: 0 }, width, height);
  await assert.rejects(autoAlignModel({ targetMask: new Uint8Array(width * height), width, height, renderMask: () => targetMask }), /太小或为空/);
  await assert.rejects(autoAlignModel({ targetMask, width, height, initialParams: { x: 20 }, bounds: { x: [2, 2] }, renderMask: () => targetMask }), /范围无效/);
  await assert.rejects(autoAlignModel({ targetMask, width, height, initialParams: { x: 20 }, bounds: { x: [0, 64] }, renderMask: () => ({ data: targetMask, width: 32, height }) }), /渲染尺寸不匹配/);
});
