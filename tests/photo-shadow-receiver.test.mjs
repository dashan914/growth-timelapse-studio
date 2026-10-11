import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { photographicReceiverSize } from '../src/photo-shadow-receiver.js';

const close = (a, b, tolerance = 1e-8) => assert.ok(Math.abs(a - b) <= tolerance, `${a} ≈ ${b}`);
const box = (min, max) => new THREE.Box3(new THREE.Vector3(...min), new THREE.Vector3(...max));

function assertContainsModelAndShadow(size, bounds, azimuth, elevation, floorY = 0, margin = 0) {
  const angle = azimuth * Math.PI / 180, rise = Math.tan(elevation * Math.PI / 180);
  for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) {
    const shadowX = x - (y - floorY) * Math.sin(angle) / rise;
    const shadowZ = z - (y - floorY) * Math.cos(angle) / rise;
    assert.ok(Math.abs(x) + margin <= size.width / 2 + 1e-8);
    assert.ok(Math.abs(z) + margin <= size.depth / 2 + 1e-8);
    assert.ok(Math.abs(shadowX) + margin <= size.width / 2 + 1e-8);
    assert.ok(Math.abs(shadowZ) + margin <= size.depth / 2 + 1e-8);
  }
}

test('receiver expands around the photo origin for a moved model and its directional ground shadow', () => {
  const bed = { width: 2, depth: 2 }, bounds = box([1, 0, 2], [2, 4, 3]);
  const at90 = photographicReceiverSize({ bed, bounds, lightAzimuth: 90, lightElevation: 45, softness: 1, mmToWorld: .01 });
  close(at90.width, 6.01); close(at90.depth, 6.01);
  const opposite = photographicReceiverSize({ bed, bounds, lightAzimuth: -90, lightElevation: 45, softness: 1, mmToWorld: .01 });
  close(opposite.width, 12.01); close(opposite.depth, 6.01);
  assertContainsModelAndShadow(at90, bounds, 90, 45, 0, .005);
  assertContainsModelAndShadow(opposite, bounds, -90, 45, 0, .005);
});

test('the three fitted reference poses have head/tail shadows beyond the old virtual bed and fit the expanded receiver', () => {
  // CPU source-vertex audit of 测试2.3mf, including the stored 3MF build transform,
  // original normalization and each photography placement (no native renderer).
  const bed = { width: 13.286064792646914, depth: 10.333605949836489 };
  const reference = [
    { name: 'pastel-rug', min: [-3.683048115635669, 0, -6.467435748374083], max: [3.683048115635673, 7.8200414601337265, 1.0166213607170578], azimuth: -45, elevation: 65, softness: 8, scale: .08409100440538043 },
    { name: 'blue-grey', min: [-4.090312881171544, 0, -6.683825747485558], max: [4.090312881171563, 8.197445799565749, .753147067410251], azimuth: -45, elevation: 65, softness: 8, scale: .08814943974885866 },
    { name: 'teal-room', min: [-4.510499429225785, 0, -8.630271286747767], max: [1.9846901759606788, 8.05247934799482, .5491348915202963], azimuth: -70, elevation: 55, softness: 7, scale: .08659212010932156 },
  ];
  for (const data of reference) {
    const bounds = box(data.min, data.max);
    const result = photographicReceiverSize({ bed, bounds, lightAzimuth: data.azimuth, lightElevation: data.elevation, softness: data.softness, mmToWorld: data.scale });
    assert.ok(result.depth > bed.depth, `${data.name} must not clip the complete shadow at the original rear edge`);
    assert.ok(result.width >= bed.width);
    const t = (data.softness - 1) / 7;
    const margin = Math.min(1.2, 18 * t ** 1.8 * data.scale) + .5 * data.scale;
    assertContainsModelAndShadow(result, bounds, data.azimuth, data.elevation, 0, margin);
  }
});

test('every light direction and the minimum ten-degree elevation remain covered', () => {
  const bounds = box([-4, -.01, -7], [9, 8, 2]);
  for (const lightAzimuth of [-180, -135, -90, -45, 0, 45, 90, 135, 180]) for (const lightElevation of [10, 35, 65, 85]) {
    const result = photographicReceiverSize({ bed: { width: 1, depth: 1 }, bounds, lightAzimuth, lightElevation, softness: 8, mmToWorld: .03, floorY: -.02 });
    assertContainsModelAndShadow(result, bounds, lightAzimuth, lightElevation, -.02, .555);
    assert.ok(Number.isFinite(result.width) && Number.isFinite(result.depth));
  }
});

test('softness uses physical units, retains its cap and adds the separate half-millimetre edge margin', () => {
  const bounds = box([-1, 0, -1], [1, 1, 1]), bed = { width: 1, depth: 1 };
  const hard = photographicReceiverSize({ bed, bounds, lightAzimuth: 90, lightElevation: 45, softness: 1, mmToWorld: .01 });
  const soft = photographicReceiverSize({ bed, bounds, lightAzimuth: 90, lightElevation: 45, softness: 8, mmToWorld: .01 });
  close(soft.width - hard.width, .36);
  close(soft.depth - hard.depth, .36);
  const capped = photographicReceiverSize({ bed, bounds, lightAzimuth: 90, lightElevation: 45, softness: 8, mmToWorld: 1 });
  close(capped.width, 7.4); close(capped.depth, 5.4);
  const x2 = photographicReceiverSize({ bed: { width: 2, depth: 2 }, bounds: box([-2, 0, -2], [2, 2, 2]), lightAzimuth: 90, lightElevation: 45, softness: 8, mmToWorld: .02 });
  close(x2.width, soft.width * 2); close(x2.depth, soft.depth * 2);
});

test('receiver uses the actual floor height and is independent of camera, raster resolution and growth progress', () => {
  const args = { bed: { width: 2, depth: 2 }, bounds: box([1, 0, 2], [2, 4, 3]), lightAzimuth: 90, lightElevation: 45, softness: 1, mmToWorld: .01, floorY: 2 };
  const result = photographicReceiverSize(args);
  close(result.width, 8.01); close(result.depth, 6.01);
  assert.deepEqual(photographicReceiverSize({ ...args, camera: new THREE.PerspectiveCamera(10), widthPx: 400, heightPx: 800, progress: 0 }), result);
  assert.deepEqual(photographicReceiverSize({ ...args, camera: new THREE.PerspectiveCamera(90), widthPx: 4096, heightPx: 4096, progress: 1 }), result);
});

test('invalid angle and softness values are bounded and cannot produce unbounded shadows', () => {
  const bed = { width: 2, depth: 2 }, bounds = box([1, 0, 2], [2, 4, 3]);
  const args = { bed, bounds, lightAzimuth: 90, lightElevation: 10, softness: 8, mmToWorld: .01 };
  assert.deepEqual(photographicReceiverSize({ ...args, lightElevation: -100, softness: 100 }), photographicReceiverSize(args));
  assert.deepEqual(photographicReceiverSize({ ...args, lightAzimuth: 810, lightElevation: 100 }), photographicReceiverSize({ ...args, lightElevation: 85 }));
  const missing = photographicReceiverSize({ bed, bounds });
  assert.deepEqual(photographicReceiverSize({ bed, bounds, lightAzimuth: NaN, lightElevation: Infinity, softness: NaN, mmToWorld: NaN, floorY: Infinity }), missing);
  const overflow = photographicReceiverSize({ bed, bounds: box([-Number.MAX_VALUE, 0, -Number.MAX_VALUE], [Number.MAX_VALUE, 4, Number.MAX_VALUE]), mmToWorld: .01 });
  assert.deepEqual(overflow, bed, 'non-finite expansion falls back to a finite calibrated rectangle');
});

test('missing or invalid geometry returns an independent bed copy, while invalid bed dimensions are rejected', () => {
  const bed = Object.freeze({ width: 180, depth: 140 });
  for (const bounds of [undefined, null, new THREE.Box3(), box([0, 0, 0], [Infinity, 1, 1])]) {
    const result = photographicReceiverSize({ bed, bounds });
    assert.deepEqual(result, bed); assert.notEqual(result, bed);
  }
  for (const invalid of [undefined, { width: 0, depth: 1 }, { width: -1, depth: 1 }, { width: 1, depth: NaN }, { width: Infinity, depth: 1 }]) assert.equal(photographicReceiverSize({ bed: invalid }), null);
});

test('calibration and complete bounds remain unchanged; a sufficiently large bed retains its original dimensions', () => {
  const bed = { width: 180, depth: 140 }, bounds = box([-1, 0, -1], [1, 4, 1]);
  const before = bounds.clone(), original = { ...bed };
  const input = { bed, bounds, lightAzimuth: -45, lightElevation: 65, softness: 4, mmToWorld: .01 };
  assert.deepEqual(photographicReceiverSize(input), bed);
  assert.ok(bounds.equals(before)); assert.deepEqual(bed, original);
  assert.deepEqual(input, { bed, bounds, lightAzimuth: -45, lightElevation: 65, softness: 4, mmToWorld: .01 });
});
