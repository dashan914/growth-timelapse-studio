// A pinhole camera recovered from four points on a known, rectangular XZ plane.
// Image points use the visible preview, including its centered background crop.
// Corner order: back-left, back-right, front-right, front-left. World Y is up.

const DEFAULT_FOV = 36;
const radians = degrees => degrees * Math.PI / 180;
const degrees = radians => radians * 180 / Math.PI;
const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);
const length = a => Math.hypot(...a);
const mul = (a, value) => a.map(component => component * value);
const sub = (a, b) => a.map((component, i) => component - b[i]);
const unit = a => mul(a, 1 / length(a));
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const at = (matrix, row, column) => matrix[row * 3 + column];
const rows = matrix => [matrix.slice(0, 3), matrix.slice(3, 6), matrix.slice(6, 9)];
const transform = (matrix, point) => rows(matrix).map(row => dot(row, point));

function solveLinear(matrix, rhs) {
  const count = rhs.length;
  const a = matrix.map((row, i) => [...row, rhs[i]]);
  for (let column = 0; column < count; column++) {
    let pivot = column;
    for (let row = column + 1; row < count; row++) if (Math.abs(a[row][column]) > Math.abs(a[pivot][column])) pivot = row;
    if (Math.abs(a[pivot][column]) < 1e-14) return null;
    [a[column], a[pivot]] = [a[pivot], a[column]];
    const divisor = a[column][column];
    for (let j = column; j <= count; j++) a[column][j] /= divisor;
    for (let row = 0; row < count; row++) {
      if (row === column) continue;
      const factor = a[row][column];
      for (let j = column; j <= count; j++) a[row][j] -= factor * a[column][j];
    }
  }
  return a.map(row => row[count]);
}

function rectangle(width, depth) {
  return [[-width / 2, 0, -depth / 2], [width / 2, 0, -depth / 2], [width / 2, 0, depth / 2], [-width / 2, 0, depth / 2]];
}

function validatePoints(points, widthPx, heightPx, allowOutside = false) {
  if (!Array.isArray(points) || points.length !== 4 || points.some(point => !Number.isFinite(point?.x) || !Number.isFinite(point?.y))) {
    throw new Error('请依次标记平台的后左、后右、前右、前左四个角。');
  }
  if (!allowOutside && points.some(point => point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1)) {
    throw new Error('平台角点需要位于预览画面内，请在画面中重新标记。');
  }
  if (points.some(point => point.x < -0.5 || point.x > 1.5 || point.y < -0.5 || point.y > 1.5)) throw new Error('外推角点离照片太远，请用画面内更明确的矩形对齐。');
  const pixels = points.map(point => [point.x * widthPx, point.y * heightPx]);
  const turns = pixels.map((point, i) => {
    const next = pixels[(i + 1) % 4];
    const after = pixels[(i + 2) % 4];
    return (next[0] - point[0]) * (after[1] - next[1]) - (next[1] - point[1]) * (after[0] - next[0]);
  });
  if (turns.some(turn => Math.abs(turn) < 1) || !turns.every(turn => turn > 0) && !turns.every(turn => turn < 0)) {
    throw new Error('四个角不能交叉、重合或排成直线。请沿平台边缘依次标记后左、后右、前右、前左。');
  }
  if (turns[0] < 0) throw new Error('角点顺序反了，请依次标记后左、后右、前右、前左，以便模型向上生长。');
  const area = Math.abs(pixels.reduce((sum, point, i) => {
    const next = pixels[(i + 1) % 4];
    return sum + point[0] * next[1] - next[0] * point[1];
  }, 0)) / 2;
  if (area < 25 || pixels.some((point, i) => Math.hypot(...sub(point, pixels[(i + 1) % 4])) < 3)) {
    throw new Error('平台在画面中太小，无法可靠对齐。请先放大照片或选取更清楚的四个角。');
  }
}

function prepareVerticalLines(lines, widthPx, heightPx, imageScale, center) {
  if (lines === undefined || lines === null) return [];
  if (!Array.isArray(lines) || lines.length > 32) throw new Error('照片竖直参考线需要由两端点组成，最多可标记 32 条。');
  return lines.map(line => {
    const endpoints = [line?.a, line?.b];
    if (endpoints.some(point => !Number.isFinite(point?.x) || !Number.isFinite(point?.y) || point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1)) {
      throw new Error('照片竖直参考线的两个端点需要位于照片内。');
    }
    const weight = line.weight ?? 1;
    if (!Number.isFinite(weight) || weight <= 0 || weight > 100) throw new Error('照片竖直参考线的拟合权重需要大于 0，且不超过 100。');
    const points = endpoints.map(point => [(point.x * widthPx - center[0]) / imageScale, (point.y * heightPx - center[1]) / imageScale]);
    const direction = sub(points[1], points[0]);
    const span = length(direction);
    if (span * imageScale < 3) throw new Error('照片竖直参考线太短，请选择清晰立柱上相距较远的两个端点。');
    return {
      midpoint: points[0].map((value, i) => (value + points[1][i]) / 2),
      direction: mul(direction, 1 / span),
      // Each observation is an angle, not a distance to the remote vanishing
      // point. Longer visible edges constrain its direction more reliably.
      residualWeight: 0.2 * Math.sqrt(span * weight),
    };
  });
}

function verticalDirectionResidual(pose, line) {
  // Homogeneous image position of world +Y at infinity. Keeping the third
  // coordinate avoids dividing by an unstable, very distant vanishing point.
  const vx = pose.focal * pose.rotation[1];
  const vy = pose.focal * pose.rotation[4];
  const vz = pose.rotation[7];
  const direction = [vx - line.midpoint[0] * vz, vy - line.midpoint[1] * vz];
  const magnitude = length(direction);
  if (!Number.isFinite(magnitude) || magnitude < 1e-12) return null;
  // Lines are unoriented: swapping their endpoints must yield the same fit.
  return (line.direction[0] * direction[1] - line.direction[1] * direction[0]) / magnitude;
}

function homography(corners, points) {
  const equations = [];
  const values = [];
  corners.forEach(([x, , z], i) => {
    const [u, v] = points[i];
    equations.push([x, z, 1, 0, 0, 0, -u * x, -u * z], [0, 0, 0, x, z, 1, -v * x, -v * z]);
    values.push(u, v);
  });
  const result = solveLinear(equations, values);
  if (!result || result.some(value => !Number.isFinite(value))) throw new Error('这组角点无法计算透视。请重新标记平台四角。');
  return [...result, 1];
}

function estimateFocal(h) {
  // With square pixels and a centered principal point, the two plane axes must
  // be perpendicular and have equal length after applying K inverse.
  const first = [h[0], h[3]];
  const second = [h[1], h[4]];
  const q = [dot(first, second), dot(first, first) - dot(second, second)];
  const c = [h[6] * h[7], h[6] ** 2 - h[7] ** 2];
  const strength = length(c) / Math.max(dot(first, first) + dot(second, second) + h[6] ** 2 + h[7] ** 2, 1e-20);
  if (strength < 1e-7) return null;
  const square = -dot(q, c) / dot(c, c);
  if (!Number.isFinite(square) || square <= 0) {
    throw new Error('四个角与矩形平台的透视关系不一致，无法估算镜头。请检查角点顺序和平台长宽，或填写镜头视角后重试。');
  }
  return Math.sqrt(square);
}

function initialPose(h, focal) {
  const a = [h[0] / focal, h[3] / focal, h[6]];
  const b = [h[1] / focal, h[4] / focal, h[7]];
  const rx = unit(a);
  const orthogonal = sub(b, mul(rx, dot(rx, b)));
  if (length(orthogonal) < 1e-10) throw new Error('平台透视过于扁平，无法判断模型高度。请使用能看见平台面的照片。');
  const rz = unit(orthogonal);
  const ry = cross(rz, rx);
  return {
    rotation: [rx[0], ry[0], rz[0], rx[1], ry[1], rz[1], rx[2], ry[2], rz[2]],
    translation: mul([h[2] / focal, h[5] / focal, 1], 2 / (length(a) + length(b))),
    focal,
  };
}

function multiplyMatrices(a, b) {
  return Array.from({ length: 9 }, (_, index) => {
    const row = Math.floor(index / 3);
    const column = index % 3;
    return [0, 1, 2].reduce((sum, i) => sum + at(a, row, i) * at(b, i, column), 0);
  });
}

function rotationIncrement(vector) {
  const angle = length(vector);
  if (angle < 1e-15) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const [x, y, z] = mul(vector, 1 / angle);
  const c = Math.cos(angle), s = Math.sin(angle), v = 1 - c;
  return [x * x * v + c, x * y * v - z * s, x * z * v + y * s,
    y * x * v + z * s, y * y * v + c, y * z * v - x * s,
    z * x * v - y * s, z * y * v + x * s, z * z * v + c];
}

function incrementPose(pose, delta, fitFocal) {
  return {
    rotation: multiplyMatrices(rotationIncrement(delta.slice(0, 3)), pose.rotation),
    translation: pose.translation.map((value, i) => value + delta[i + 3]),
    focal: pose.focal * (fitFocal ? Math.exp(delta[6]) : 1),
  };
}

function residuals(pose, corners, points, verticalLines = []) {
  const result = [];
  for (let i = 0; i < corners.length; i++) {
    const camera = transform(pose.rotation, corners[i]).map((value, j) => value + pose.translation[j]);
    if (camera[2] < 1e-8 || !Number.isFinite(pose.focal)) return null;
    result.push(pose.focal * camera[0] / camera[2] - points[i][0], pose.focal * camera[1] / camera[2] - points[i][1]);
  }
  for (const line of verticalLines) {
    const residual = verticalDirectionResidual(pose, line);
    if (residual === null) return null;
    result.push(residual * line.residualWeight);
  }
  return result;
}

function refinePose(initial, corners, points, fitFocal, verticalLines = []) {
  // Fit an actual rigid camera rather than display an arbitrary projective warp.
  // The redundant eighth observation exposes incompatible/noisy corner choices.
  let pose = initial;
  let residual = residuals(pose, corners, points, verticalLines);
  if (!residual) throw new Error('平台位于镜头后方，无法对齐。请检查角点顺序。');
  let error = dot(residual, residual);
  let damping = 1e-3;
  const count = fitFocal ? 7 : 6;
  for (let iteration = 0; iteration < 60 && error > 1e-18; iteration++) {
    const jacobian = Array.from({ length: residual.length }, () => Array(count));
    for (let j = 0; j < count; j++) {
      const step = j >= 3 && j < 6 ? 1e-5 * Math.max(1, length(pose.translation)) : 1e-5;
      const delta = Array(count).fill(0);
      delta[j] = step;
      const plus = residuals(incrementPose(pose, delta, fitFocal), corners, points, verticalLines);
      delta[j] = -step;
      const minus = residuals(incrementPose(pose, delta, fitFocal), corners, points, verticalLines);
      if (!plus || !minus) return pose;
      for (let i = 0; i < residual.length; i++) jacobian[i][j] = (plus[i] - minus[i]) / (2 * step);
    }
    const normal = Array.from({ length: count }, (_, a) => Array.from({ length: count }, (_, b) => jacobian.reduce((sum, row) => sum + row[a] * row[b], 0)));
    const rhs = Array.from({ length: count }, (_, j) => -jacobian.reduce((sum, row, i) => sum + row[j] * residual[i], 0));
    for (let i = 0; i < count; i++) normal[i][i] += damping * Math.max(normal[i][i], 1e-8);
    const delta = solveLinear(normal, rhs);
    if (!delta) break;
    const candidate = incrementPose(pose, delta, fitFocal);
    const nextResidual = residuals(candidate, corners, points, verticalLines);
    const nextError = nextResidual ? dot(nextResidual, nextResidual) : Infinity;
    if (nextError < error) {
      pose = candidate;
      residual = nextResidual;
      const improvement = error - nextError;
      error = nextError;
      damping = Math.max(damping / 3, 1e-9);
      if (improvement < 1e-16) break;
    } else {
      damping *= 10;
      if (damping > 1e10) break;
    }
  }
  return pose;
}

function quaternionFromMatrix(m) {
  const trace = m[0] + m[4] + m[8];
  let x, y, z, w;
  if (trace > 0) {
    const s = 2 * Math.sqrt(trace + 1);
    w = s / 4; x = (m[7] - m[5]) / s; y = (m[2] - m[6]) / s; z = (m[3] - m[1]) / s;
  } else if (m[0] > m[4] && m[0] > m[8]) {
    const s = 2 * Math.sqrt(1 + m[0] - m[4] - m[8]);
    w = (m[7] - m[5]) / s; x = s / 4; y = (m[1] + m[3]) / s; z = (m[2] + m[6]) / s;
  } else if (m[4] > m[8]) {
    const s = 2 * Math.sqrt(1 + m[4] - m[0] - m[8]);
    w = (m[2] - m[6]) / s; x = (m[1] + m[3]) / s; y = s / 4; z = (m[5] + m[7]) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m[8] - m[0] - m[4]);
    w = (m[3] - m[1]) / s; x = (m[2] + m[6]) / s; y = (m[5] + m[7]) / s; z = s / 4;
  }
  return unit([x, y, z, w]);
}

function pixelHomography(h, imageScale, center, worldScale) {
  const result = [0, 1, 2].flatMap(row => [0, 1, 2].map(column => {
    const value = row < 2 ? imageScale * h[row * 3 + column] + center[row] * h[6 + column] : h[6 + column];
    return value / (column < 2 ? worldScale : 1);
  }));
  return result.map(value => value / result[8]);
}

/**
 * Recover a Three.js camera from normalized visible-stage corner coordinates.
 * bedWidth / bedDepth must use the same world units as the model and XZ offsets.
 * `fov`, when supplied, is the vertical field of view in degrees; otherwise it
 * is estimated with square pixels and a centered principal point.
 * Optional `photoVerticalLines: [{ a: {x,y}, b: {x,y}, weight?: 1 }]` marks
 * physical upright edges in the same normalized source photo coordinates.
 * These constrain world-Y perspective without assuming zero camera roll.
 * `weight` (0–100, default 1) scales the squared directional residual; strong
 * weights suit visible uprights when the platform corners are only estimates.
 * Returned arrays are Three.js compatible. `target` follows the optical axis;
 * it is deliberately not fixed at the world origin, which may be off-center.
 */
export function solvePlanarCamera({ points, widthPx, heightPx, bedWidth, bedDepth, fov, allowOutside = false, photoVerticalLines } = {}) {
  if (![widthPx, heightPx, bedWidth, bedDepth].every(value => Number.isFinite(value) && value > 0)) {
    throw new Error('请填写有效的平台宽度、深度，并等待预览画面显示后再对齐。');
  }
  if (fov !== undefined && (!Number.isFinite(fov) || fov < 3 || fov > 145)) throw new Error('镜头视角需在 3° 到 145° 之间。');
  validatePoints(points, widthPx, heightPx, allowOutside);
  const imageScale = Math.max(widthPx, heightPx);
  const worldScale = Math.max(bedWidth, bedDepth);
  const center = [widthPx / 2, heightPx / 2];
  const verticalLines = prepareVerticalLines(photoVerticalLines, widthPx, heightPx, imageScale, center);
  const normalized = points.map(point => [(point.x * widthPx - center[0]) / imageScale, (point.y * heightPx - center[1]) / imageScale]);
  const corners = rectangle(bedWidth / worldScale, bedDepth / worldScale);
  const h = homography(corners, normalized);
  const warnings = [];
  if (points.some(point => point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1)) warnings.push('使用了照片外的外推角点，对齐仍需手动核对；外推不是识别到真实角点。');
  const suppliedFocal = fov !== undefined;
  let focal = suppliedFocal ? heightPx / (2 * Math.tan(radians(fov) / 2) * imageScale) : estimateFocal(h);
  const inferredFocal = focal !== null && !suppliedFocal;
  if (focal === null) {
    focal = heightPx / (2 * Math.tan(radians(DEFAULT_FOV) / 2) * imageScale);
    warnings.push('当前平台接近正俯视，四个角无法确定焦距。已使用 36° 视角，可手动微调透视。');
  }
  const pose = refinePose(initialPose(h, focal), corners, normalized, inferredFocal, verticalLines);
  const finalFov = degrees(2 * Math.atan(heightPx / (2 * pose.focal * imageScale)));
  if (!Number.isFinite(finalFov) || finalFov < 3 || finalFov > 145) {
    throw new Error('这组角点算出的镜头视角不合理。请检查平台长宽和角点位置，或填写已知镜头视角。');
  }
  const rotation = pose.rotation;
  const translation = mul(pose.translation, worldScale);
  const position = [0, 1, 2].map(column => -[0, 1, 2].reduce((sum, row) => sum + at(rotation, row, column) * translation[row], 0));
  if (position[1] <= worldScale * 1e-7) throw new Error('镜头需要位于平台上方。请检查四个角的顺序，并使用能看见平台面的照片。');
  const up = mul(rotation.slice(3, 6), -1);
  const forward = rotation.slice(6, 9);
  const targetDistance = Math.max(length(position), worldScale);
  const target = position.map((value, i) => value + forward[i] * targetDistance);
  // CV optical frame: +X right, +Y down, +Z forward. Three camera frame:
  // +X right, +Y up, -Z forward. Converting both Y and Z preserves handedness.
  const cameraRotation = [0, 1, 2].flatMap(row => [at(rotation, 0, row), -at(rotation, 1, row), -at(rotation, 2, row)]);
  const cameraWorldMatrix = [0, 1, 2].flatMap(column => [cameraRotation[column], cameraRotation[3 + column], cameraRotation[6 + column], 0]).concat([...position, 1]);
  const viewMatrix = [0, 1, 2].flatMap(column => [at(rotation, 0, column), -at(rotation, 1, column), -at(rotation, 2, column), 0]).concat([translation[0], -translation[1], -translation[2], 1]);
  const residual = residuals(pose, corners, normalized);
  const reprojectionErrorPx = Math.sqrt(dot(residual, residual) / 4) * imageScale;
  const maxReprojectionErrorPx = Math.max(...[0, 1, 2, 3].map(i => Math.hypot(residual[2 * i], residual[2 * i + 1]))) * imageScale;
  if (reprojectionErrorPx > Math.max(12, Math.min(widthPx, heightPx) * 0.025)) {
    throw new Error(`四个角与平台尺寸无法同时对齐，平均误差为 ${reprojectionErrorPx.toFixed(1)} 像素。请重新标记角点并检查平台宽度、深度。`);
  }
  if (reprojectionErrorPx > Math.max(1.5, Math.min(widthPx, heightPx) * 0.003)) {
    warnings.push(`当前平均对齐误差为 ${reprojectionErrorPx.toFixed(1)} 像素。可重新微调四个角、平台尺寸或镜头视角。`);
  }
  const fitted = [pose.focal * rotation[0], pose.focal * rotation[2], pose.focal * pose.translation[0],
    pose.focal * rotation[3], pose.focal * rotation[5], pose.focal * pose.translation[1],
    rotation[6], rotation[8], pose.translation[2]];
  const result = {
    position, target, up, quaternion: quaternionFromMatrix(cameraRotation), fov: finalFov,
    rotation, translation, focalLengthPx: pose.focal * imageScale,
    homography: pixelHomography(fitted, imageScale, center, worldScale),
    observedHomography: pixelHomography(h, imageScale, center, worldScale),
    cameraWorldMatrix, viewMatrix, reprojectionErrorPx, maxReprojectionErrorPx, warnings,
    focalEstimated: inferredFocal, imageSize: { width: widthPx, height: heightPx }, bedWidth, bedDepth,
  };
  if (verticalLines.length) {
    result.verticalLineErrorsDeg = verticalLines.map(line => degrees(Math.asin(Math.min(1, Math.abs(verticalDirectionResidual(pose, line))))));
    result.verticalErrorDeg = Math.sqrt(dot(result.verticalLineErrorsDeg, result.verticalLineErrorsDeg) / verticalLines.length);
    result.maxVerticalErrorDeg = Math.max(...result.verticalLineErrorsDeg);
    if (result.maxVerticalErrorDeg > 2) warnings.push(`照片立柱与模型竖直方向仍有 ${result.maxVerticalErrorDeg.toFixed(1)}° 的偏差，请核对平台角点和竖直参考线。`);
  }
  result.projectedPoints = rectangle(bedWidth, bedDepth).map(point => {
    const pixel = projectWorld(point, result, widthPx, heightPx);
    return { x: pixel.x / widthPx, y: pixel.y / heightPx };
  });
  const base = projectWorld([0, 0, 0], result, widthPx, heightPx);
  const above = projectWorld([0, worldScale * 0.01, 0], result, widthPx, heightPx);
  if (above.y >= base.y) warnings.push('照片中的平台方向使模型向画面下方生长。请旋转照片或调整标记方向后再导出。');
  return result;
}

/** Project a world [X,Y,Z] point to pixels, with positive optical depth. */
export function projectWorld(point, calibration, widthPx = calibration.imageSize.width, heightPx = calibration.imageSize.height) {
  const coordinates = Array.isArray(point) ? point : [point.x, point.y, point.z];
  const camera = transform(calibration.rotation, coordinates).map((value, i) => value + calibration.translation[i]);
  const focal = heightPx / (2 * Math.tan(radians(calibration.fov) / 2));
  return { x: widthPx / 2 + focal * camera[0] / camera[2], y: heightPx / 2 + focal * camera[1] / camera[2], depth: camera[2] };
}
