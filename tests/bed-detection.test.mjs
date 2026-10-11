import test from 'node:test';
import assert from 'node:assert/strict';
import { detectBedCandidate } from '../src/bed-detection.js';

function photo({ width = 400, height = 300, corners = [[70, 125], [280, 102], [352, 253], [24, 278]], noise = 0, markings = false } = {}) {
  let seed = 104729;
  const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0x100000000; };
  const inside = (x, y) => corners?.every(([ax, ay], i) => {
    const [bx, by] = corners[(i + 1) % 4];
    return (bx - ax) * (y - ay) - (by - ay) * (x - ax) >= 0;
  });
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const bed = inside(x, y), i = (y * width + x) * 4;
    const shade = (random() - 0.5) * noise + (bed ? 0.04 * y : 0);
    let rgb = bed ? [170, 163, 144] : [26, 39, 52];
    if (markings && bed && x > width * 0.37 && x < width * 0.48 && y > height * 0.6 && y < height * 0.74) rgb = [35, 32, 29];
    rgba[i] = rgb[0] + shade; rgba[i + 1] = rgb[1] + shade; rgba[i + 2] = rgb[2] + shade; rgba[i + 3] = 255;
  }
  return { rgba, width, height, expected: corners?.map(([x, y]) => ({ x: x / width, y: y / height })) };
}

test('perspective plate detection finds four ordered edges, preserves texture, and requests review', () => {
  const data = photo({ noise: 50, markings: true });
  const result = detectBedCandidate(data);
  assert.ok(result.points, JSON.stringify(result));
  assert.equal(result.points.length, 4);
  result.points.forEach((point, i) => assert.ok(Math.hypot(point.x - data.expected[i].x, point.y - data.expected[i].y) < 0.025, `corner ${i}: ${JSON.stringify(point)}`));
  assert.ok(result.confidence > 0.7);
  assert.equal(result.cropped, false);
  assert.equal(result.needsReview, true);
  assert.match(result.warnings.join(' '), /拖动四角核对/);
});

test('cropped near corner is extrapolated, flagged, and never promoted to high-confidence automatic alignment', () => {
  const data = photo({ corners: [[48, 146], [240, 129], [389, 231], [-35, 342]], noise: 25 });
  const result = detectBedCandidate(data);
  assert.ok(result.points, JSON.stringify(result));
  assert.equal(result.cropped, true);
  assert.deepEqual(result.croppedCorners, [3]);
  assert.ok(result.points[3].x < 0 && result.points[3].y > 1);
  result.points.forEach((point, i) => assert.ok(Math.hypot(point.x - data.expected[i].x, point.y - data.expected[i].y) < 0.04, `corner ${i}`));
  assert.ok(result.confidence <= 0.56);
  assert.equal(result.needsReview, true);
  assert.match(result.warnings.join(' '), /超出照片.*估计/);
});

test('blank, dark, and unstructured photos do not fabricate a rectangular platform', () => {
  const dark = photo({ corners: null, noise: 20 });
  const uniform = { rgba: new Uint8ClampedArray(400 * 300 * 4).fill(230), width: 400, height: 300 };
  const random = photo({ corners: null });
  for (let i = 0; i < random.rgba.length; i += 4) {
    random.rgba[i] = (i * 37) % 256;
    random.rgba[i + 1] = (i * 71 + 39) % 256;
    random.rgba[i + 2] = (i * 19 + 13) % 256;
  }
  for (const data of [dark, uniform, random]) {
    const result = detectBedCandidate(data);
    assert.equal(result.points, null);
    assert.equal(result.confidence, 0);
    assert.equal(result.needsReview, true);
    assert.match(result.warnings.join(' '), /手动/);
  }
});

test('missing front boundary is not replaced by the image border', () => {
  const data = photo({ corners: [[54, 115], [284, 94], [440, 450], [-40, 480]], noise: 20 });
  const result = detectBedCandidate(data);
  assert.equal(result.points, null);
  assert.equal(result.confidence, 0);
});

test('invalid pixel buffers reject with a usable instruction', () => {
  assert.throws(() => detectBedCandidate(), /实景照片/);
  assert.throws(() => detectBedCandidate({ rgba: [255], width: 100, height: 100 }), /实景照片/);
  assert.throws(() => detectBedCandidate({ rgba: new Uint8Array(1600), width: 20, height: 20 }), /实景照片/);
});
