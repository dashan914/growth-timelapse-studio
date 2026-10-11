import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { focalLengthToFov, fovToFocalLength, compensateLensChange, MIN_FOCAL_LENGTH_MM, MAX_FOCAL_LENGTH_MM, FOCAL_LENGTH_STEP_MM } from '../src/camera-lens.js';

const close = (actual, expected, tolerance = 1e-9) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} ≠ ${expected}`);
function camera({ position, target, focal, aspect = 4 / 3, up = [0.12, 1, -0.07] }) {
  const camera = new THREE.PerspectiveCamera(focalLengthToFov(focal), aspect, 0.01, 10000);
  camera.position.fromArray(position); camera.up.fromArray(up); camera.lookAt(new THREE.Vector3(...target)); camera.updateMatrixWorld();
  return camera;
}
const projection = (point, camera) => new THREE.Vector3(...point).project(camera);

test('millimetre lens conversion uses full-frame vertical height and round-trips without output-ratio dependence', () => {
  close(focalLengthToFov(24), 53.13010235415598);
  for (const focal of [18, 24, 35, 50, 85, 135, 12]) close(fovToFocalLength(focalLengthToFov(focal)), focal);
  close(focalLengthToFov(24, 48), 90);
  assert.equal(MIN_FOCAL_LENGTH_MM, 18); assert.equal(MAX_FOCAL_LENGTH_MM, 135); assert.equal(FOCAL_LENGTH_STEP_MM, 0.5);
});

test('off-center model anchor and its image-parallel plane retain projection while the camera changes real perspective', () => {
  const position = [3, 6, 15], target = [-2, 1, 0], anchor = [2, 2, -1];
  const original = camera({ position, target, focal: 24 });
  const result = compensateLensChange({ position, target, anchor, oldFocalLength: 24, newFocalLength: 85 });
  const adjusted = camera({ position: result.position, target: result.target, focal: 85 });
  assert.ok(original.quaternion.angleTo(adjusted.quaternion) < 1e-7, 'orientation and roll are retained');
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(original.quaternion), up = new THREE.Vector3(0, 1, 0).applyQuaternion(original.quaternion);
  for (const [x, y] of [[0, 0], [2, 1], [-1, -2], [3, -0.5]]) {
    const point = new THREE.Vector3(...anchor).addScaledVector(right, x).addScaledVector(up, y).toArray();
    const before = projection(point, original), after = projection(point, adjusted);
    close(after.x, before.x); close(after.y, before.y);
  }
  const projectedAnchor = projection(anchor, original);
  assert.ok(Math.hypot(projectedAnchor.x, projectedAnchor.y) > 0.1, 'this is a genuinely off-center anchor');
  close(result.newAnchorDepth / result.anchorDepth, 85 / 24);
  const forward = new THREE.Vector3(...result.forward);
  const near = new THREE.Vector3(...anchor).addScaledVector(right, 1).addScaledVector(forward, -3).toArray();
  const far = new THREE.Vector3(...anchor).addScaledVector(right, 1).addScaledVector(forward, 3).toArray();
  const spread = camera => Math.abs(projection(near, camera).x - projection(far, camera).x);
  assert.ok(spread(adjusted) < spread(original) * 0.5, 'longer focal length reduces near/far relative-perspective difference');
});

test('changing lenses back and forth restores position and optical target, including source-FOV input', () => {
  const position = [-4, 7, 12], target = [-1, 2, -2], anchor = [2, 1, 0];
  const first = compensateLensChange({ position, target, anchor, oldFullSourceFov: focalLengthToFov(24), newFullSourceFov: focalLengthToFov(50) });
  const back = compensateLensChange({ position: first.position, target: first.target, anchor, oldFocalLength: 50, newFocalLength: 24 });
  back.position.forEach((value, i) => close(value, position[i]));
  back.target.forEach((value, i) => close(value, target[i]));
  assert.deepEqual(position, [-4, 7, 12]); assert.deepEqual(target, [-1, 2, -2]);
  const unchanged = compensateLensChange({ position, target, anchor, oldFocalLength: 24, newFocalLength: 24 });
  assert.deepEqual(unchanged.position, position); assert.deepEqual(unchanged.target, target);
});

test('old wide-angle FOV cache can migrate into the current focal range without losing framing', () => {
  const result = compensateLensChange({ position: [0, 0, 10], target: [0, 0, 0], anchor: [2, 1, 0], oldFullSourceFov: 90, newFullSourceFov: focalLengthToFov(18) });
  close(result.oldFocalLength, 12); close(result.newFocalLength, 18);
  result.position.forEach((value, i) => close(value, [0, 0, 15][i]));
  result.target.forEach((value, i) => close(value, [0, 0, 5][i]));
});

test('invalid geometry, behind-camera anchors, and unavailable new focal lengths fail with useful messages', () => {
  for (const value of [0, -1, NaN, Infinity, undefined]) assert.throws(() => focalLengthToFov(value), /焦段/);
  for (const value of [0, 180, NaN, Infinity, -5]) assert.throws(() => fovToFocalLength(value), /视角/);
  assert.throws(() => focalLengthToFov(24, 0), /传感器/);
  assert.throws(() => fovToFocalLength(1e-320), /焦段/);
  const options = { position: [0, 0, 10], target: [0, 0, 0], anchor: [1, 1, 0], oldFocalLength: 24, newFocalLength: 50 };
  for (const newFocalLength of [17.5, 135.5]) assert.throws(() => compensateLensChange({ ...options, newFocalLength }), /18 到 135/);
  assert.throws(() => compensateLensChange({ ...options, target: options.position }), /不能重合/);
  assert.throws(() => compensateLensChange({ ...options, anchor: [0, 0, 20] }), /相机前方/);
  assert.throws(() => compensateLensChange({ ...options, anchor: [NaN, 0, 0] }), /三个有效坐标/);
  assert.throws(() => compensateLensChange({ ...options, newFocalLength: undefined }), /新镜头/);
  assert.throws(() => compensateLensChange({ ...options, oldFullSourceFov: 53, newFullSourceFov: 30 }), /一组/);
});
