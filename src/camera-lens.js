// Full-frame-equivalent focal length uses a 24 mm vertical sensor dimension.
// Always use the full SOURCE image's vertical FOV here; an output crop changes
// the effective preview FOV but does not change the physical lens equivalent.
export const SENSOR_HEIGHT_MM = 24;
export const MIN_FOCAL_LENGTH_MM = 18;
export const MAX_FOCAL_LENGTH_MM = 135;
export const FOCAL_LENGTH_STEP_MM = 0.5;

function positive(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new RangeError(`${label}需要是大于 0 的有效数值。`);
  return value;
}

/** Pure optical conversion; unrestricted positive old lenses support migration. */
export function focalLengthToFov(focalLengthMm, sensorHeightMm = SENSOR_HEIGHT_MM) {
  const focal = positive(focalLengthMm, '镜头焦段'), sensor = positive(sensorHeightMm, '传感器高度');
  const fov = 2 * Math.atan(sensor / (2 * focal)) * 180 / Math.PI;
  if (!Number.isFinite(fov) || fov <= 0 || fov >= 180) throw new RangeError('镜头焦段与传感器尺寸差距过大，无法计算有效视角。');
  return fov;
}

/** Vertical FOV of the full source frame, in degrees, to lens millimetres. */
export function fovToFocalLength(fullSourceFov, sensorHeightMm = SENSOR_HEIGHT_MM) {
  if (typeof fullSourceFov !== 'number' || !Number.isFinite(fullSourceFov) || fullSourceFov <= 0 || fullSourceFov >= 180) {
    throw new RangeError('完整画面的镜头视角需要大于 0° 且小于 180°。');
  }
  return positive(positive(sensorHeightMm, '传感器高度') / (2 * Math.tan(fullSourceFov * Math.PI / 360)), '镜头焦段');
}

function point(value, label) {
  const values = Array.isArray(value) || ArrayBuffer.isView(value) ? Array.from(value) : value && typeof value === 'object' ? [value.x, value.y, value.z] : [];
  if (values.length !== 3 || values.some(component => typeof component !== 'number' || !Number.isFinite(component))) {
    throw new TypeError(`${label}需要包含三个有效坐标。`);
  }
  return values;
}
const difference = (a, b) => a.map((value, i) => value - b[i]);
const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);

/**
 * Change lens perspective while preserving framing on the image-parallel
 * plane through `anchor` (usually the model's world bounding-box center).
 *
 * Both camera position and its optical-axis target receive the same translation
 * so the orientation/roll is unchanged. Moving around `target` instead would
 * reframe a model that is off the optical axis. For focal ratio k and anchor
 * depth D, moving -forward * D * (k - 1) makes its new depth kD: focal/depth and
 * every projection on that reference plane are unchanged. Other depths retain
 * the genuine wide-angle/telephoto change in relative perspective.
 *
 * Supply oldFocalLength/newFocalLength OR oldFullSourceFov/newFullSourceFov.
 * New lens choices must be 18–135 mm. Old focal lengths remain unrestricted
 * positive numbers, so older saved FOV controls can migrate safely.
 */
export function compensateLensChange({ position, target, anchor, oldFocalLength, newFocalLength, oldFullSourceFov, newFullSourceFov, sensorHeightMm = SENSOR_HEIGHT_MM } = {}) {
  const cameraPosition = point(position, '相机位置'), cameraTarget = point(target, '相机目标'), reference = point(anchor, '模型参照点');
  positive(sensorHeightMm, '传感器高度');
  const hasFocal = oldFocalLength !== undefined || newFocalLength !== undefined;
  const hasFov = oldFullSourceFov !== undefined || newFullSourceFov !== undefined;
  if (hasFocal && hasFov || !hasFocal && !hasFov) throw new TypeError('请提供一组旧、新镜头焦段，或完整画面的旧、新视角。');
  const oldFocal = hasFocal ? positive(oldFocalLength, '原镜头焦段') : fovToFocalLength(oldFullSourceFov, sensorHeightMm);
  const newFocal = hasFocal ? positive(newFocalLength, '新镜头焦段') : fovToFocalLength(newFullSourceFov, sensorHeightMm);
  if (newFocal < MIN_FOCAL_LENGTH_MM - 1e-10 || newFocal > MAX_FOCAL_LENGTH_MM + 1e-10) throw new RangeError('镜头焦段需要在 18 到 135 mm 之间。');
  const direction = difference(cameraTarget, cameraPosition), targetDistance = Math.hypot(...direction);
  if (!Number.isFinite(targetDistance) || targetDistance < 1e-12) throw new RangeError('相机位置与目标不能重合。');
  const forward = direction.map(value => value / targetDistance);
  const referenceOffset = difference(reference, cameraPosition);
  const anchorDepth = dot(referenceOffset, forward);
  if (!Number.isFinite(anchorDepth) || anchorDepth <= 1e-9 * Math.max(1, targetDistance, Math.hypot(...referenceOffset))) {
    throw new RangeError('模型参照点需要位于相机前方，请先回正视角。');
  }
  const ratio = newFocal / oldFocal;
  const distanceChange = anchorDepth * (ratio - 1);
  const offset = forward.map(value => -value * distanceChange);
  const nextPosition = cameraPosition.map((value, i) => value + offset[i]);
  const nextTarget = cameraTarget.map((value, i) => value + offset[i]);
  if (!Number.isFinite(ratio) || !Number.isFinite(anchorDepth * ratio) || [...nextPosition, ...nextTarget].some(value => !Number.isFinite(value))) {
    throw new RangeError('镜头变化过大，无法保持当前构图。请先回正视角。');
  }
  return {
    position: nextPosition, target: nextTarget, offset, forward,
    oldFocalLength: oldFocal, newFocalLength: newFocal,
    oldFullSourceFov: focalLengthToFov(oldFocal, sensorHeightMm),
    newFullSourceFov: focalLengthToFov(newFocal, sensorHeightMm),
    ratio, anchorDepth, newAnchorDepth: anchorDepth * ratio,
  };
}
