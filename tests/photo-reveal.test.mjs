import test from 'node:test';
import assert from 'node:assert/strict';
import { preparePhotoReveal, composePhotoReveal } from '../src/photo-reveal.js';

function rgba(width, height, color) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set(color, i);
  return data;
}

function fixture(width = 32, height = 24) {
  const emptyRGBA = rgba(width, height, [20, 32, 41, 255]);
  const targetRGBA = rgba(width, height, [24, 34, 42, 255]);
  const targetMask = new Uint8Array(width * height), data = new Uint16Array(width * height), mask = new Uint8Array(width * height);
  for (let y = 4; y < 20; y++) {
    for (let x = 10; x < 22; x++) {
      const i = y * width + x;
      targetMask[i] = mask[i] = 255;
      data[i] = Math.round((19 - y) / 15 * 65535);
      targetRGBA.set([220, 58 + x, 40 + y, 255], i * 4);
    }
  }
  return { emptyRGBA, targetRGBA, targetMask, heightMap: { data, mask, width, height }, width, height };
}

function pixel(data, width, x, y) { return Array.from(data.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)); }

test('real-photo growth endpoints exactly reproduce complete photos A and B', () => {
  const input = fixture(), state = preparePhotoReveal(input);
  assert.deepEqual(composePhotoReveal({ state, progress: 0 }), input.emptyRGBA);
  assert.deepEqual(composePhotoReveal({ state, progress: 1 }), input.targetRGBA);
  assert.deepEqual(composePhotoReveal({ state, progress: -1 }), input.emptyRGBA);
  assert.deepEqual(composePhotoReveal({ state, progress: 2 }), input.targetRGBA);
  assert.equal(state.stats.coverage, 1);
  assert.equal(state.stats.iou, 1);
});

test('intermediate frames use world height rather than a horizontal screen wipe', () => {
  const input = fixture(), width = input.width;
  // Two same-row pixels represent surfaces at different physical heights.
  // A low foreground surface can appear above a high background surface.
  input.heightMap.data[8 * width + 12] = 10001;
  input.heightMap.data[8 * width + 18] = 54001;
  input.heightMap.data[17 * width + 16] = 61001;
  const state = preparePhotoReveal(input), frame = composePhotoReveal({ state, progress: 0.5 });
  assert.deepEqual(pixel(frame, width, 12, 8), pixel(input.targetRGBA, width, 12, 8));
  assert.deepEqual(pixel(frame, width, 18, 8), pixel(input.emptyRGBA, width, 18, 8));
  assert.deepEqual(pixel(frame, width, 16, 17), pixel(input.emptyRGBA, width, 16, 17));
  assert.deepEqual(pixel(frame, width, 13, 18), pixel(input.targetRGBA, width, 13, 18));
  assert.deepEqual(pixel(frame, width, 2, 2), pixel(input.emptyRGBA, width, 2, 2));
});

test('16-bit height thresholds are preserved rather than quantized to 256 levels', () => {
  const input = fixture(), index = 14 * input.width + 15;
  input.heightMap.data[index] = 10001;
  const state = preparePhotoReveal(input);
  assert.equal(state.heights[index], 10001);
  const before = composePhotoReveal({ state, progress: 10000 / 65535 });
  const after = composePhotoReveal({ state, progress: 10001 / 65535 });
  assert.deepEqual(Array.from(before.subarray(index * 4, index * 4 + 4)), Array.from(input.emptyRGBA.subarray(index * 4, index * 4 + 4)));
  assert.deepEqual(Array.from(after.subarray(index * 4, index * 4 + 4)), Array.from(input.targetRGBA.subarray(index * 4, index * 4 + 4)));
});

test('nearby unmatched photo edges inherit the nearest physical height within a true pixel-distance limit', () => {
  const input = fixture(), width = input.width;
  for (let y = 4; y < 20; y++) for (let x = 10; x < 12; x++) input.heightMap.mask[y * width + x] = 0;
  input.heightMap.data[11 * width + 12] = 23011;
  const state = preparePhotoReveal({ ...input, maxFillDistancePx: 2 });
  assert.equal(state.stats.filledPixels, 32);
  assert.equal(state.stats.coverageAfterFill, 1);
  assert.equal(state.stats.maxFilledDistancePx, 2);
  assert.equal(state.heights[11 * width + 10], 23011);
  assert.equal(state.heights[11 * width + 11], 23011);
  assert.match(state.warnings.join(' '), /边缘偏差补齐高度/);
});

test('diagonal gaps outside the distance limit are not silently filled', () => {
  const input = fixture(), width = input.width;
  // The nearest overlapping body pixel is (10,4): sqrt(3²+3²)>4.
  const isolated = 1 * width + 7;
  input.targetMask[isolated] = 255;
  input.targetRGBA.set([200, 20, 10, 255], isolated * 4);
  const state = preparePhotoReveal({ ...input, maxFillDistancePx: 4 });
  assert.equal(state.mappedMask[isolated], 0);
  assert.equal(state.stats.unmappedPixels, 1);
  assert.match(state.warnings.join(' '), /无法对应模型高度/);
  const frame = composePhotoReveal({ state, progress: 0.95 });
  assert.deepEqual(Array.from(frame.subarray(isolated * 4, isolated * 4 + 4)), Array.from(input.emptyRGBA.subarray(isolated * 4, isolated * 4 + 4)));
  assert.deepEqual(composePhotoReveal({ state, progress: 1 }), input.targetRGBA);
});

test('nearest-height propagation agrees with brute-force Euclidean distances for irregular sources', () => {
  const width = 13, height = 11, size = width * height;
  const emptyRGBA = rgba(width, height, [30, 40, 50, 255]), targetRGBA = rgba(width, height, [220, 80, 30, 255]);
  const targetMask = new Uint8Array(size).fill(255), mask = new Uint8Array(size), data = new Uint16Array(size);
  const sources = [{ x: 1, y: 2, value: 1101 }, { x: 7, y: 8, value: 9203 }, { x: 11, y: 1, value: 34817 }, { x: 5, y: 5, value: 60891 }];
  for (const source of sources) { mask[source.y * width + source.x] = 255; data[source.y * width + source.x] = source.value; }
  const state = preparePhotoReveal({ emptyRGBA, targetRGBA, targetMask, heightMap: { data, mask, width, height }, width, height, minCoverage: 0.01, maxFillDistancePx: 30 });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const squared = sources.map(source => (x - source.x) ** 2 + (y - source.y) ** 2), closest = Math.min(...squared);
      const validHeights = sources.filter((source, index) => squared[index] === closest).map(source => source.value);
      assert.ok(validHeights.includes(state.heights[y * width + x]), `Wrong nearest height at ${x},${y}`);
    }
  }
  assert.equal(state.stats.coverageAfterFill, 1);
});

test('a growth-clipped 3D composite supplies temporarily visible cap/interior surfaces', () => {
  const input = fixture(), state = preparePhotoReveal(input), baseRGBA = input.emptyRGBA.slice(), width = input.width;
  baseRGBA.set([25, 210, 230, 255], (6 * width + 15) * 4);
  baseRGBA.set([80, 92, 94, 255], (12 * width + 8) * 4);
  const frame = composePhotoReveal({ state, progress: 0.5, baseRGBA });
  assert.deepEqual(pixel(frame, width, 15, 6), [25, 210, 230, 255], 'unfinished surfaces remain the current clipped model render');
  assert.deepEqual(pixel(frame, width, 8, 12), [80, 92, 94, 255], 'a temporary silhouette outside final B remains visible');
  assert.deepEqual(pixel(frame, width, 16, 18), pixel(input.targetRGBA, width, 16, 18));
  assert.deepEqual(composePhotoReveal({ state, progress: 0, baseRGBA }), input.emptyRGBA);
  assert.deepEqual(composePhotoReveal({ state, progress: 1, baseRGBA }), input.targetRGBA);
});

test('poor photo/model overlap is refused before making a misleading real-photo reveal', () => {
  const input = fixture();
  for (let y = 4; y < 20; y++) for (let x = 10; x < 22; x++) if (x >= 14) input.heightMap.mask[y * input.width + x] = 0;
  assert.throws(() => preparePhotoReveal(input), /重合不足/);
  const modelTooLarge = fixture();
  modelTooLarge.heightMap.mask.fill(255);
  assert.throws(() => preparePhotoReveal(modelTooLarge), /模型覆盖/);
  const absent = fixture(); absent.heightMap.mask.fill(0);
  assert.throws(() => preparePhotoReveal(absent), /未显示/);
  const noObject = fixture(); noObject.targetMask.fill(0);
  assert.throws(() => preparePhotoReveal(noObject), /没有成品轮廓/);
});

test('photo sources remain unchanged and reusable output buffers handle backwards scrubbing', () => {
  const input = fixture(), originals = {
    emptyRGBA: input.emptyRGBA.slice(), targetRGBA: input.targetRGBA.slice(), targetMask: input.targetMask.slice(), data: input.heightMap.data.slice(), mask: input.heightMap.mask.slice(),
  };
  const state = preparePhotoReveal(input), out = new Uint8ClampedArray(input.width * input.height * 4);
  assert.equal(composePhotoReveal({ state, progress: 1, out }), out);
  assert.equal(composePhotoReveal({ state, progress: 0.2, out }), out);
  assert.deepEqual(out, composePhotoReveal({ state, progress: 0.2 }));
  assert.deepEqual(input.emptyRGBA, originals.emptyRGBA);
  assert.deepEqual(input.targetRGBA, originals.targetRGBA);
  assert.deepEqual(input.targetMask, originals.targetMask);
  assert.deepEqual(input.heightMap.data, originals.data);
  assert.deepEqual(input.heightMap.mask, originals.mask);
  input.targetRGBA.fill(0);
  assert.deepEqual(composePhotoReveal({ state, progress: 1 }), originals.targetRGBA, 'prepared state snapshots photos');
  assert.throws(() => composePhotoReveal({ state, progress: 0.5, out: state.targetRGBA }), /不能覆盖原始照片/);
});

test('invalid dimensions, height encoding and output buffers produce actionable failures', () => {
  const input = fixture();
  assert.throws(() => preparePhotoReveal({ ...input, width: 0 }), /尺寸无效/);
  assert.throws(() => preparePhotoReveal({ ...input, emptyRGBA: new Uint8Array(4) }), /空场景照片/);
  assert.throws(() => preparePhotoReveal({ ...input, heightMap: { ...input.heightMap, width: 16 } }), /高度图与照片/);
  assert.throws(() => preparePhotoReveal({ ...input, maxFillDistancePx: -1 }), /匹配范围无效/);
  const invalidHeight = { ...input.heightMap, data: Array.from(input.heightMap.data) };
  invalidHeight.data[10 * input.width + 14] = 65536;
  assert.throws(() => preparePhotoReveal({ ...input, heightMap: invalidHeight }), /16 位/);
  assert.throws(() => preparePhotoReveal({ ...input, heightMap: { ...input.heightMap, data: new Uint8Array(input.width * input.height) } }), /16 位/);
  const state = preparePhotoReveal(input);
  assert.throws(() => composePhotoReveal({ state, progress: NaN }), /进度无效/);
  assert.throws(() => composePhotoReveal({ state, progress: 0.4, out: new Uint8Array(4) }), /输出画布/);
  assert.throws(() => composePhotoReveal({ state, progress: 0.4, baseRGBA: new Uint8Array(4) }), /当前模型渲染画面/);
  assert.throws(() => composePhotoReveal({ progress: 0.2 }), /尚未准备好/);
});
