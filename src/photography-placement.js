import * as THREE from 'three';

const finite = value => typeof value === 'number' && Number.isFinite(value);
const POSE_TOLERANCE = 2e-7;

// Read the current local transforms without updating the caller's camera or
// parents. The supplied projection is already the final photo/crop projection.
function worldMatrix(object) {
  const local = object.matrixAutoUpdate
    ? new THREE.Matrix4().compose(object.position, object.quaternion, object.scale)
    : object.matrix.clone();
  return object.parent ? worldMatrix(object.parent).multiply(local) : local;
}

/** Fit a complete model to one photographic composition. This is a display
 * transform, not a change to source dimensions or the native slicing profile.
 * The full bounds remain fixed while the growth preview reveals the model.
 * Invalid inputs or an unreachable composition return null. No scene, camera,
 * bounds or profile is modified. Offsets use the studio's world-units divisor.
 */
export function fitPhotographicModelPose({bounds, camera, profile, offsetUnit = 4, minScale = .1, maxScale = 5} = {}) {
  if (!bounds?.isBox3 || !camera?.isPerspectiveCamera || !profile) return null;
  if (![bounds.min.x, bounds.min.y, bounds.min.z, bounds.max.x, bounds.max.y, bounds.max.z,
    profile.yawDeg, profile.centerX, profile.footY, profile.maxHeight, profile.maxWidth,
    offsetUnit, minScale, maxScale].every(finite)) return null;
  if (bounds.isEmpty() || offsetUnit <= 0 || minScale <= 0 || maxScale < minScale
    || profile.centerX <= 0 || profile.centerX >= 1 || profile.footY <= 0 || profile.footY >= 1
    || profile.maxHeight <= 0 || profile.maxHeight >= profile.footY
    || profile.maxWidth <= 0 || profile.maxWidth > 2 * Math.min(profile.centerX, 1 - profile.centerX)) return null;
  const size = bounds.getSize(new THREE.Vector3());
  if (Math.max(size.x, size.y, size.z) <= 0 || size.y <= 0) return null;
  const projection = camera.projectionMatrix.clone(), cameraWorld = worldMatrix(camera);
  if (![...projection.elements, ...cameraWorld.elements].every(finite)
    || Math.abs(projection.determinant()) < 1e-14 || Math.abs(cameraWorld.determinant()) < 1e-14) return null;
  const view = cameraWorld.clone().invert();
  const projectionInverse = projection.clone().invert();
  const eye = new THREE.Vector3().setFromMatrixPosition(cameraWorld);
  const rayPoint = new THREE.Vector3(profile.centerX * 2 - 1, 1 - profile.footY * 2, .5)
    .applyMatrix4(projectionInverse).applyMatrix4(cameraWorld);
  const ray = rayPoint.sub(eye);
  if (!finite(ray.y) || Math.abs(ray.y) < 1e-12) return null;
  const rayDistance = -eye.y / ray.y;
  if (!finite(rayDistance) || rayDistance <= 0) return null;
  const ground = eye.clone().addScaledVector(ray, rayDistance);
  const yaw = profile.yawDeg * Math.PI / 180, rotation = new THREE.Matrix4().makeRotationY(yaw);
  const corners = [];
  for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) {
    corners.push(new THREE.Vector3(x, y, z).applyMatrix4(rotation));
  }
  const center = bounds.getCenter(new THREE.Vector3()).applyMatrix4(rotation);
  const near = finite(camera.near) && camera.near > 0 ? camera.near : 1e-6;
  const far = finite(camera.far) && camera.far > near ? camera.far : Infinity;
  const worldSpan = Math.max(size.length(), eye.distanceTo(ground), 1);

  function measure(scale, x, z) {
    let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
    for (const corner of corners) {
      const point = corner.clone().multiplyScalar(scale);
      point.x += x; point.y -= bounds.min.y * scale; point.z += z;
      point.applyMatrix4(view);
      if (-point.z <= near || -point.z >= far) return null;
      point.applyMatrix4(projection);
      const screenX = (point.x + 1) / 2, screenY = (1 - point.y) / 2;
      if (!finite(screenX) || !finite(screenY)) return null;
      left = Math.min(left, screenX); right = Math.max(right, screenX);
      top = Math.min(top, screenY); bottom = Math.max(bottom, screenY);
    }
    return {left, right, top, bottom, width: right - left, height: bottom - top,
      errorX: (left + right) / 2 - profile.centerX, errorY: bottom - profile.footY};
  }

  // A ground ray supplies a scale-independent initial placement. Two bounded
  // Newton variables then align the projected whole-box centre and lowest
  // corner. Using both X and Z keeps the feet on y=0 instead of shifting the
  // model upward in screen space and detaching its contact shadow.
  function place(scale) {
    let x = ground.x - center.x * scale, z = ground.z - center.z * scale;
    let current = measure(scale, x, z);
    if (!current) return null;
    for (let iteration = 0; iteration < 36; iteration++) {
      const error = Math.hypot(current.errorX, current.errorY);
      if (error < POSE_TOLERANCE) return {scale, x, z, ...current};
      const step = Math.max(1e-6, worldSpan * 1e-5, size.length() * scale * 1e-5);
      const dx = measure(scale, x + step, z), dz = measure(scale, x, z + step);
      if (!dx || !dz) return null;
      const a = (dx.errorX - current.errorX) / step, b = (dz.errorX - current.errorX) / step;
      const c = (dx.errorY - current.errorY) / step, d = (dz.errorY - current.errorY) / step;
      const determinant = a * d - b * c;
      if (!finite(determinant) || Math.abs(determinant) < 1e-15) return null;
      let moveX = (-d * current.errorX + b * current.errorY) / determinant;
      let moveZ = (c * current.errorX - a * current.errorY) / determinant;
      const moveLength = Math.hypot(moveX, moveZ), bound = worldSpan * 2;
      if (!finite(moveLength)) return null;
      if (moveLength > bound) { moveX *= bound / moveLength; moveZ *= bound / moveLength; }
      let accepted = false;
      for (let damping = 1; damping >= 1 / 256; damping /= 2) {
        const next = measure(scale, x + moveX * damping, z + moveZ * damping);
        if (next && Math.hypot(next.errorX, next.errorY) < error) {
          x += moveX * damping; z += moveZ * damping; current = next; accepted = true; break;
        }
      }
      if (!accepted) return null;
    }
    return null;
  }

  const fits = placement => placement && placement.width <= profile.maxWidth + 1e-9
    && placement.height <= profile.maxHeight + 1e-9
    && placement.left >= -1e-8 && placement.right <= 1 + 1e-8 && placement.top >= -1e-8;
  let best = place(minScale);
  if (!fits(best)) return null;
  const largest = place(maxScale);
  if (fits(largest)) best = largest;
  else {
    let low = minScale, high = maxScale;
    // The fixed footpoint bounds the depth of the ground footprint. As scale
    // grows, the nearer edge comes toward the camera and its projected size
    // increases; reject any candidate that crosses a clip plane.
    for (let iteration = 0; iteration < 36; iteration++) {
      const middle = (low + high) / 2, candidate = place(middle);
      if (fits(candidate)) { low = middle; best = candidate; }
      else high = middle;
    }
  }
  return {
    modelOffsetX: best.x / offsetUnit,
    modelOffsetY: -bounds.min.y * best.scale / offsetUnit,
    modelOffsetZ: best.z / offsetUnit,
    modelRotationX: 0, modelRotationY: yaw, modelRotationZ: 0,
    modelScale: best.scale,
  };
}
