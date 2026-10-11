import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { solvePlanarCamera, projectWorld } from '../src/calibration.js';
import { calibrationGridLines, calibrationFitFeedback, normalizeUprightLines, cloneUprightLines, uprightModelPose } from '../src/calibration-editor.js';

function sourceCamera({ widthPx = 1200, heightPx = 900 } = {}) {
  const bedWidth = 12, bedDepth = 10;
  const camera = new THREE.PerspectiveCamera(52, widthPx / heightPx, 0.05, 1000);
  camera.position.set(6, 12, 18);
  camera.up.set(0.12, 1, 0.07);
  camera.lookAt(new THREE.Vector3(-1, 2, 0));
  camera.updateMatrixWorld();
  const project = point => {
    const pixel = new THREE.Vector3(...point).project(camera);
    return { x: (pixel.x + 1) / 2, y: (1 - pixel.y) / 2 };
  };
  const corners = [[-6, 0, -5], [6, 0, -5], [6, 0, 5], [-6, 0, 5]];
  const points = corners.map(project);
  const upright = [[-4, -2], [4, 2]].map(([x, z]) => ({ a: project([x, 0, z]), b: project([x, 7, z]) }));
  const result = solvePlanarCamera({ points, widthPx, heightPx, bedWidth, bedDepth, photoVerticalLines: normalizeUprightLines(upright) });
  return { result, project, points, upright };
}

function closePoint(actual, expected) {
  assert.ok(Math.hypot(actual.x - expected.x, actual.y - expected.y) < 1e-8);
}

test('editor grid projects actual floor segments through the recovered camera in landscape and portrait photos', () => {
  for (const size of [{ widthPx: 1200, heightPx: 900 }, { widthPx: 900, heightPx: 1200 }]) {
    const { result, project } = sourceCamera(size);
    const lines = calibrationGridLines(result, 4);
    assert.equal(lines.length, 10);
    for (let i = 0; i <= 4; i++) {
      const x = -6 + 12 * i / 4, z = -5 + 10 * i / 4;
      closePoint(lines[i * 2].a, project([x, 0, -5]));
      closePoint(lines[i * 2].b, project([x, 0, 5]));
      closePoint(lines[i * 2 + 1].a, project([-6, 0, z]));
      closePoint(lines[i * 2 + 1].b, project([6, 0, z]));
      assert.equal(lines[i * 2].axis, 'z');
      assert.equal(lines[i * 2 + 1].axis, 'x');
      assert.equal(lines[i * 2].boundary, i === 0 || i === 4);
    }
    assert.deepEqual(calibrationGridLines({ ...result, observedHomography: Array(9).fill(0), projectedPoints: [] }, 4), lines,
      'the observed planar warp must not override the fitted model camera grid');
  }
});

test('source-photo fixture reports the upright improvement and the separate cost to floor fit', () => {
  const widthPx = 1706, heightPx = 1279;
  const points = [[.126, .477], [.592, .423], [1.039, .790], [-.096, 1.189]].map(([x, y]) => ({ x, y }));
  const options = { points, widthPx, heightPx, bedWidth: 330, bedDepth: 320, allowOutside: true };
  const pixels = [[625, 152, 654, 572], [1614, 134, 1492, 799]];
  const upright = normalizeUprightLines(pixels.map(([ax, ay, bx, by]) => ({ a: { x: ax / widthPx, y: ay / heightPx }, b: { x: bx / widthPx, y: by / heightPx } })));
  const original = solvePlanarCamera(options);
  const constrained = solvePlanarCamera({ ...options, photoVerticalLines: upright });
  const before = calibrationFitFeedback(original, points);
  const after = calibrationFitFeedback(constrained, points);
  assert.ok(Math.abs(before.cornerRmsPx - 16.6127035772725) < 1e-6);
  assert.ok(Math.abs(after.cornerRmsPx - 30.49431105572083) < 1e-6);
  assert.ok(after.uprightRmsDeg < 0.4);
  assert.ok(after.uprightMaxDeg < 0.5);
  assert.ok(after.cornerRmsPx > before.cornerRmsPx, 'guides do not magically make guessed corners physically exact');
  assert.equal(before.noUprightGuides, true);
  assert.equal(before.uprightRmsDeg, null);
  assert.equal(after.noUprightGuides, false);
  assert.equal(after.outsideCorners, true);
  assert.equal(after.quality, 'review');
  assert.match(after.message, /30\.5 px/);
  assert.match(after.message, /0\.4°/);
  assert.match(after.message, /画外估角/);
  const grid = calibrationGridLines(constrained);
  closePoint(grid[0].a, constrained.projectedPoints[0]);
  closePoint(grid[0].b, constrained.projectedPoints[3]);
  assert.ok(Math.abs(grid[0].a.y - points[0].y) > .02, 'grid exposes the actual model fit rather than drawing the requested quadrilateral');
  assert.ok(grid.some(line => line.a.x < 0 || line.b.x > 1 || line.b.y > 1), 'do not clamp extrapolated corners into the source photograph');
});

test('fit feedback computes original-pixel corner errors without mixing angular residuals', () => {
  const { result, points } = sourceCamera();
  const good = calibrationFitFeedback(result, points);
  assert.equal(good.quality, 'good');
  assert.equal(good.outsideCorners, false);
  assert.equal(good.noUprightGuides, false);
  assert.ok(good.cornerRmsPx < 1e-6);
  assert.ok(good.uprightRmsDeg < 1e-6);
  const shifted = points.map((point, i) => ({ x: point.x + (i + 1) / 1200, y: point.y }));
  const feedback = calibrationFitFeedback(result, shifted);
  assert.ok(Math.abs(feedback.cornerRmsPx - Math.sqrt(30 / 4)) < 1e-6);
  assert.ok(Math.abs(feedback.cornerMaxPx - 4) < 1e-6);
  assert.ok(Math.abs(feedback.uprightRmsDeg - good.uprightRmsDeg) < 1e-12);
  assert.equal(calibrationFitFeedback({ ...result, verticalErrorDeg: 5, maxVerticalErrorDeg: 5, verticalLineErrorsDeg: [5, 5] }, points).quality, 'needs-adjustment');
  assert.equal(calibrationFitFeedback({ ...result, reprojectionErrorPx: undefined, maxReprojectionErrorPx: undefined }).quality, 'unavailable');
  assert.equal(calibrationFitFeedback(null).quality, 'unavailable');
  assert.throws(() => calibrationFitFeedback(result, [{ x: 0, y: 0 }]), /四个有效/);
});

test('manual upright input uses strong weights and independent endpoint copies', () => {
  const input = [{ a: { x: .2, y: .3 }, b: { x: .21, y: .6 }, weight: 1 }];
  const normalized = normalizeUprightLines(input);
  assert.equal(normalized[0].weight, 100);
  assert.deepEqual(cloneUprightLines(input), normalized);
  normalized[0].a.x = .9;
  assert.equal(input[0].a.x, .2);
  assert.equal(input[0].weight, 1);
  assert.deepEqual(normalizeUprightLines(null), []);
  assert.deepEqual(normalizeUprightLines(undefined), []);
  for (const lines of ['bad', [null], [{ a: { x: -.1, y: .2 }, b: { x: .2, y: .3 } }],
    [{ a: { x: NaN, y: .2 }, b: { x: .2, y: .3 } }], [{ a: { x: .2, y: .3 }, b: { x: .2, y: .3 } }], Array(33).fill(input[0])]) {
    assert.throws(() => normalizeUprightLines(lines), /参考线|照片内|重合/);
  }
});

test('standing the model upright preserves yaw, all offsets, scale and unrelated rendering settings', () => {
  const options = { modelRotationX: .4, modelRotationY: -.7, modelRotationZ: .2,
    modelOffsetX: -.13, modelOffsetY: .07, modelOffsetZ: .22, modelScale: 1.42, dof: true };
  const pose = uprightModelPose(options);
  assert.notEqual(pose, options);
  assert.deepEqual(pose, { ...options, modelRotationX: 0, modelRotationZ: 0 });
  assert.equal(options.modelRotationX, .4);
  assert.equal(options.modelRotationZ, .2);
  assert.deepEqual(uprightModelPose(), { modelRotationX: 0, modelRotationZ: 0 });
});

test('grid input validation prevents invalid subdivisions or behind-camera segments', () => {
  const { result } = sourceCamera();
  assert.throws(() => calibrationGridLines(null), /尚未完成/);
  assert.throws(() => calibrationGridLines({ ...result, bedWidth: 0 }), /尚未完成/);
  for (const divisions of [0, -1, 1.5, 65, Infinity, NaN]) assert.throws(() => calibrationGridLines(result, divisions), /分段/);
  assert.throws(() => calibrationGridLines({ ...result, translation: [0, 0, -100] }), /有效镜头/);
  const direct = projectWorld([0, 0, 0], result);
  assert.ok(Number.isFinite(direct.x), 'the valid control camera remains usable after rejected inputs');
});
