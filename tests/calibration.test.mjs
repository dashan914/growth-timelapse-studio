import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { solvePlanarCamera, projectWorld } from '../src/calibration.js';
import { presetDefinitions } from '../src/preset-calibrations.js';

const corners = (width, depth) => [[-width / 2, 0, -depth / 2], [width / 2, 0, -depth / 2], [width / 2, 0, depth / 2], [-width / 2, 0, depth / 2]];

function photo({ position = [6, 12, 18], target = [-1, 2, 0], up = [0, 1, 0], fov = 52, widthPx = 1200, heightPx = 900, bedWidth = 12, bedDepth = 10 } = {}) {
  const camera = new THREE.PerspectiveCamera(fov, widthPx / heightPx, 0.05, 1000);
  camera.position.fromArray(position);
  camera.up.fromArray(up);
  camera.lookAt(new THREE.Vector3(...target));
  camera.updateMatrixWorld();
  const normalized = point => {
    const projected = new THREE.Vector3(...point).project(camera);
    return { x: (projected.x + 1) / 2, y: (1 - projected.y) / 2 };
  };
  return { camera, normalized, options: { points: corners(bedWidth, bedDepth).map(normalized), widthPx, heightPx, bedWidth, bedDepth } };
}

function pixelsFromThree(point, camera, width, height) {
  const vector = new THREE.Vector3(...point).project(camera);
  return { x: (vector.x + 1) * width / 2, y: (1 - vector.y) * height / 2 };
}

function verticalLines(source) {
  return [[-4, -2], [4, 2]].map(([x, z]) => ({ a: source.normalized([x, 0, z]), b: source.normalized([x, 7, z]) }));
}

function verticalError(solved, line, width, height) {
  const focal = height / (2 * Math.tan(solved.fov * Math.PI / 360));
  const midpoint = [(line.a.x + line.b.x) * width / 2 - width / 2, (line.a.y + line.b.y) * height / 2 - height / 2];
  const direction = [focal * solved.rotation[1] - midpoint[0] * solved.rotation[7], focal * solved.rotation[4] - midpoint[1] * solved.rotation[7]];
  const observed = [(line.b.x - line.a.x) * width, (line.b.y - line.a.y) * height];
  const sine = (direction[0] * observed[1] - direction[1] * observed[0]) / (Math.hypot(...direction) * Math.hypot(...observed));
  return Math.asin(Math.min(1, Math.abs(sine))) * 180 / Math.PI;
}

test('four rectangle corners recover an off-center pinhole camera and real elevated model points', () => {
  const source = photo();
  const solved = solvePlanarCamera(source.options);
  assert.ok(solved.reprojectionErrorPx < 1e-6);
  assert.ok(Math.abs(solved.fov - 52) < 1e-6);
  assert.equal(solved.focalEstimated, true);
  assert.deepEqual(solved.warnings, []);
  solved.position.forEach((value, i) => assert.ok(Math.abs(value - source.camera.position.toArray()[i]) < 1e-6));
  for (const point of [...corners(12, 10), [1, 5, -1], [-3, 3, 2]]) {
    const expected = pixelsFromThree(point, source.camera, 1200, 900);
    const actual = projectWorld(point, solved);
    assert.ok(Math.hypot(actual.x - expected.x, actual.y - expected.y) < 1e-6);
    assert.ok(actual.depth > 0);
  }
  assert.ok(Math.hypot(...solved.target) > 0.1, 'the optical axis must not be forced to the bed center');
  assert.ok(projectWorld([0, 1, 0], solved).y < projectWorld([0, 0, 0], solved).y);
});

test('Three lookAt, quaternion, and column-major camera matrices preserve the recovered pose', () => {
  const source = photo({ up: [0.12, 1, 0.07] });
  const solved = solvePlanarCamera(source.options);
  const byLookAt = new THREE.PerspectiveCamera(solved.fov, 1200 / 900, 0.05, 1000);
  byLookAt.position.fromArray(solved.position);
  byLookAt.up.fromArray(solved.up);
  byLookAt.lookAt(new THREE.Vector3(...solved.target));
  byLookAt.updateMatrixWorld();
  assert.ok(byLookAt.quaternion.angleTo(new THREE.Quaternion(...solved.quaternion)) < 1e-6);
  const world = new THREE.Matrix4().fromArray(solved.cameraWorldMatrix);
  const view = new THREE.Matrix4().fromArray(solved.viewMatrix);
  const identity = world.clone().multiply(view).elements;
  identity.forEach((value, i) => assert.ok(Math.abs(value - (i % 5 === 0 ? 1 : 0)) < 1e-9));
  byLookAt.matrixWorld.elements.forEach((value, i) => assert.ok(Math.abs(value - world.elements[i]) < 1e-8));
  for (const point of [[0, 0, 0], [1, 5, -1]]) {
    const actual = pixelsFromThree(point, byLookAt, 1200, 900);
    const expected = pixelsFromThree(point, source.camera, 1200, 900);
    assert.ok(Math.hypot(actual.x - expected.x, actual.y - expected.y) < 1e-6);
  }
});

test('non-square platform and portrait images use vertical FOV and source world units', () => {
  const source = photo({ position: [100, 180, 340], target: [0, 30, 0], widthPx: 900, heightPx: 1200, bedWidth: 180, bedDepth: 140, fov: 58 });
  const solved = solvePlanarCamera(source.options);
  assert.ok(solved.reprojectionErrorPx < 1e-5);
  assert.ok(Math.abs(solved.fov - 58) < 1e-5);
  solved.position.forEach((value, i) => assert.ok(Math.abs(value - source.camera.position.toArray()[i]) < 1e-5));
  const expected = pixelsFromThree([20, 80, -10], source.camera, 900, 1200);
  const actual = projectWorld({ x: 20, y: 80, z: -10 }, solved, 900, 1200);
  assert.ok(Math.hypot(actual.x - expected.x, actual.y - expected.y) < 1e-5);
});

test('known lens FOV remains fixed while small marking noise reports its actual residual', () => {
  const source = photo();
  const offsets = [[1.4, -0.7], [-0.2, 0.4], [0.7, 1.3], [-1, -0.3]];
  const points = source.options.points.map((point, i) => ({ x: point.x + offsets[i][0] / 1200, y: point.y + offsets[i][1] / 900 }));
  const solved = solvePlanarCamera({ ...source.options, points, fov: 52 });
  assert.ok(Math.abs(solved.fov - 52) < 1e-10);
  assert.equal(solved.focalEstimated, false);
  assert.ok(solved.reprojectionErrorPx > 0.01 && solved.reprojectionErrorPx < 2);
  const errors = corners(12, 10).map((point, i) => {
    const pixel = projectWorld(point, solved);
    return Math.hypot(pixel.x - points[i].x * 1200, pixel.y - points[i].y * 900);
  });
  assert.ok(Math.abs(solved.reprojectionErrorPx - Math.sqrt(errors.reduce((sum, value) => sum + value ** 2, 0) / 4)) < 1e-9);
  assert.ok(Math.abs(solved.maxReprojectionErrorPx - Math.max(...errors)) < 1e-9);
});

test('unknown focal length tolerates small corner noise without pretending an exact projective fit', () => {
  const source = photo();
  const offsets = [[1, -1], [-1, 0.6], [0.4, 1.2], [-0.6, -0.5]];
  const points = source.options.points.map((point, i) => ({ x: point.x + offsets[i][0] / 1200, y: point.y + offsets[i][1] / 900 }));
  const solved = solvePlanarCamera({ ...source.options, points });
  assert.ok(solved.reprojectionErrorPx > 0.01 && solved.reprojectionErrorPx < 2);
  assert.ok(Math.abs(solved.fov - 52) < 4);
  assert.ok(solved.position[1] > 0);
});

test('front-on rectangle cannot determine focal length and reports its assumed lens', () => {
  const points = [{ x: 0.3, y: 0.3 }, { x: 0.7, y: 0.3 }, { x: 0.7, y: 0.7 }, { x: 0.3, y: 0.7 }];
  const solved = solvePlanarCamera({ points, widthPx: 1000, heightPx: 1000, bedWidth: 10, bedDepth: 10 });
  assert.equal(solved.focalEstimated, false);
  assert.ok(Math.abs(solved.fov - 36) < 1e-9);
  assert.ok(solved.reprojectionErrorPx < 1e-5);
  assert.match(solved.warnings.join(' '), /无法确定焦距/);
});

test('homography projects the physical platform and shares the reported camera residual', () => {
  const source = photo();
  const solved = solvePlanarCamera(source.options);
  corners(12, 10).forEach(([x, , z], i) => {
    const h = solved.homography;
    const divisor = h[6] * x + h[7] * z + h[8];
    const u = (h[0] * x + h[1] * z + h[2]) / divisor;
    const v = (h[3] * x + h[4] * z + h[5]) / divisor;
    assert.ok(Math.hypot(u - source.options.points[i].x * 1200, v - source.options.points[i].y * 900) < 1e-6);
    assert.ok(Math.abs(solved.projectedPoints[i].x - u / 1200) < 1e-12);
    assert.ok(Math.abs(solved.projectedPoints[i].y - v / 900) < 1e-12);
  });
});

test('crossed, reversed, collinear, duplicate, and out-of-frame marks fail with actionable messages', () => {
  const source = photo().options;
  const rectangle = [{ x: 0.2, y: 0.2 }, { x: 0.8, y: 0.2 }, { x: 0.8, y: 0.8 }, { x: 0.2, y: 0.8 }];
  assert.throws(() => solvePlanarCamera({ ...source, points: [rectangle[0], rectangle[2], rectangle[1], rectangle[3]] }), /不能交叉/);
  assert.throws(() => solvePlanarCamera({ ...source, points: rectangle.toReversed() }), /顺序反了/);
  assert.throws(() => solvePlanarCamera({ ...source, points: rectangle.map((point, i) => ({ x: 0.2 + i * 0.1, y: 0.2 + i * 0.1 })) }), /直线/);
  assert.throws(() => solvePlanarCamera({ ...source, points: [rectangle[0], rectangle[1], rectangle[1], rectangle[3]] }), /重合/);
  assert.throws(() => solvePlanarCamera({ ...source, points: [{ x: -0.1, y: 0.2 }, ...rectangle.slice(1)] }), /画面内/);
  assert.throws(() => solvePlanarCamera({ ...source, bedWidth: 0 }), /有效的平台/);
  assert.throws(() => solvePlanarCamera({ ...source, fov: NaN }), /镜头视角/);
});

test('incompatible aspect ratio with a known lens is rejected instead of reporting successful alignment', () => {
  const source = photo().options;
  assert.throws(() => solvePlanarCamera({ ...source, bedDepth: 1, fov: 52 }), /无法同时对齐|位于平台上方|视角不合理/);
});

test('optional upright edges preserve a rolled exact camera and are invariant to endpoint order', () => {
  const source = photo({ up: [0.12, 1, 0.07] });
  const lines = verticalLines(source);
  const solved = solvePlanarCamera({ ...source.options, photoVerticalLines: lines });
  assert.ok(solved.verticalErrorDeg < 1e-7);
  assert.ok(solved.reprojectionErrorPx < 1e-6);
  const reversed = solvePlanarCamera({ ...source.options, photoVerticalLines: lines.map(({ a, b }) => ({ a: b, b: a })) });
  solved.rotation.forEach((value, i) => assert.ok(Math.abs(value - reversed.rotation[i]) < 1e-10));
  assert.ok(Math.abs(solved.up[0]) > 0.02, 'upright observations must not force the camera roll to zero');
  for (const point of [[0, 0, 0], [1, 5, -1]]) {
    const expected = pixelsFromThree(point, source.camera, 1200, 900);
    const actual = projectWorld(point, solved);
    assert.ok(Math.hypot(actual.x - expected.x, actual.y - expected.y) < 1e-6);
  }
});

test('no upright observations keep the original solver result exactly unchanged', () => {
  const options = photo().options;
  const original = solvePlanarCamera(options);
  assert.deepEqual(solvePlanarCamera({ ...options, photoVerticalLines: [] }), original);
  assert.deepEqual(solvePlanarCamera({ ...options, photoVerticalLines: null }), original);
  assert.equal(original.verticalErrorDeg, undefined);
});

test('upright observations respect a fixed vertical lens and portrait image pixel geometry', () => {
  const source = photo({ position: [100, 180, 340], target: [0, 30, 0], up: [0.09, 1, 0.04], widthPx: 900, heightPx: 1200, bedWidth: 180, bedDepth: 140, fov: 58 });
  const lines = [[-50, -30], [50, 30]].map(([x, z]) => ({ a: source.normalized([x, 0, z]), b: source.normalized([x, 100, z]) }));
  const solved = solvePlanarCamera({ ...source.options, fov: 58, photoVerticalLines: lines });
  assert.equal(solved.focalEstimated, false);
  assert.ok(Math.abs(solved.fov - 58) < 1e-10);
  assert.ok(solved.reprojectionErrorPx < 1e-6);
  assert.ok(solved.verticalErrorDeg < 1e-7);
  solved.verticalLineErrorsDeg.forEach((value, i) => assert.ok(Math.abs(value - verticalError(solved, lines[i], 900, 1200)) < 1e-8));
});

test('real photo upright constraints correct convergence while reporting the separate plate fit error', () => {
  for (const preset of Object.values(presetDefinitions).filter(preset => preset.sizeBasis === 'reference-printable-area')) {
    const options = {
      points: preset.points, widthPx: preset.imageSize.width, heightPx: preset.imageSize.height,
      bedWidth: preset.widthMm, bedDepth: preset.depthMm, allowOutside: preset.allowOutside,
    };
    const lines = preset.verticalLines.map(line => ({ ...line, weight: 100 }));
    const original = solvePlanarCamera(options);
    const originalAngles = lines.map(line => verticalError(original, line, options.widthPx, options.heightPx));
    const originalRms = Math.hypot(...originalAngles) / Math.sqrt(lines.length);
    const solved = solvePlanarCamera({ ...options, photoVerticalLines: lines });
    assert.ok(solved.verticalErrorDeg < 0.7, `${preset.label}: upright error ${solved.verticalErrorDeg}`);
    assert.ok(solved.verticalErrorDeg < originalRms / 2, `${preset.label}: visible convergence must improve`);
    assert.ok(solved.reprojectionErrorPx < 45, `${preset.label}: plate error ${solved.reprojectionErrorPx}`);
    const pixelErrors = corners(options.bedWidth, options.bedDepth).map((point, i) => {
      const pixel = projectWorld(point, solved);
      return Math.hypot(pixel.x - options.points[i].x * options.widthPx, pixel.y - options.points[i].y * options.heightPx);
    });
    assert.ok(Math.abs(Math.hypot(...pixelErrors) / 2 - solved.reprojectionErrorPx) < 1e-8, 'reported plate RMS must exclude angular residuals');
    solved.verticalLineErrorsDeg.forEach((angle, i) => assert.ok(Math.abs(angle - verticalError(solved, lines[i], options.widthPx, options.heightPx)) < 1e-8));
  }
});

test('upright hints reject malformed, invisible, too-short, or nonpositive-confidence observations', () => {
  const options = photo().options;
  assert.throws(() => solvePlanarCamera({ ...options, photoVerticalLines: 'vertical' }), /两端点/);
  assert.throws(() => solvePlanarCamera({ ...options, photoVerticalLines: [{ a: { x: 0.2, y: 0.2 } }] }), /两个端点/);
  assert.throws(() => solvePlanarCamera({ ...options, photoVerticalLines: [{ a: { x: -0.1, y: 0.2 }, b: { x: 0.3, y: 0.7 } }] }), /照片内/);
  assert.throws(() => solvePlanarCamera({ ...options, photoVerticalLines: [{ a: { x: 0.2, y: 0.2 }, b: { x: 0.2, y: 0.201 } }] }), /太短/);
  assert.throws(() => solvePlanarCamera({ ...options, photoVerticalLines: [{ a: { x: 0.2, y: 0.2 }, b: { x: 0.3, y: 0.7 }, weight: 0 }] }), /权重/);
});
