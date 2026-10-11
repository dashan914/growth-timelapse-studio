// Editor helpers for the existing rigid pinhole solver. No external solver code.
import { projectWorld } from './calibration.js';

const validMetric = value => Number.isFinite(value) && value >= 0;
const planeCorners = ({ bedWidth: width, bedDepth: depth }) => [
  [-width / 2, 0, -depth / 2], [width / 2, 0, -depth / 2],
  [width / 2, 0, depth / 2], [-width / 2, 0, depth / 2],
];

function validateCamera(result) {
  const numbers = [result?.imageSize?.width, result?.imageSize?.height, result?.bedWidth, result?.bedDepth, result?.fov];
  if (!numbers.every(value => Number.isFinite(value) && value > 0)
      || !Array.isArray(result?.rotation) || result.rotation.length !== 9 || !result.rotation.every(Number.isFinite)
      || !Array.isArray(result?.translation) || result.translation.length !== 3 || !result.translation.every(Number.isFinite)) {
    throw new Error('底板相机尚未完成对齐，请先标记底板四角。');
  }
}

function normalizedProjection(point, result) {
  const pixel = projectWorld(point, result);
  if (![pixel.x, pixel.y, pixel.depth].every(Number.isFinite) || pixel.depth <= 0) {
    throw new Error('底板投影超出有效镜头范围，请重新对齐。');
  }
  return { x: pixel.x / result.imageSize.width, y: pixel.y / result.imageSize.height };
}

/** Source-photo normalized segments from the same 3D camera that renders the model. */
export function calibrationGridLines(result, divisions = 8) {
  validateCamera(result);
  if (!Number.isInteger(divisions) || divisions < 1 || divisions > 64) throw new Error('网格分段需要为 1 到 64 的整数。');
  const { bedWidth: width, bedDepth: depth } = result;
  const lines = [];
  for (let i = 0; i <= divisions; i++) {
    const x = -width / 2 + width * i / divisions;
    const z = -depth / 2 + depth * i / divisions;
    const boundary = i === 0 || i === divisions;
    lines.push({ a: normalizedProjection([x, 0, -depth / 2], result), b: normalizedProjection([x, 0, depth / 2], result), axis: 'z', boundary });
    lines.push({ a: normalizedProjection([-width / 2, 0, z], result), b: normalizedProjection([width / 2, 0, z], result), axis: 'x', boundary });
  }
  return lines;
}

/** Manual guides have strong direction weight, and never share mutable points with saved state. */
export function normalizeUprightLines(lines) {
  if (lines === undefined || lines === null) return [];
  if (!Array.isArray(lines) || lines.length > 32) throw new Error('竖直参考线需要由两端点组成，最多 32 条。');
  return lines.map(line => {
    const points = [line?.a, line?.b];
    if (points.some(point => !Number.isFinite(point?.x) || !Number.isFinite(point?.y)
        || point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1)) {
      throw new Error('请在照片内选择竖直参考线的两个端点。');
    }
    if (points[0].x === points[1].x && points[0].y === points[1].y) throw new Error('竖直参考线的两个端点不能重合。');
    return { a: { x: points[0].x, y: points[0].y }, b: { x: points[1].x, y: points[1].y }, weight: 100 };
  });
}

export const cloneUprightLines = normalizeUprightLines;

/** Optional explicit model action: remove its tilt without moving, resizing or turning its facing direction. */
export function uprightModelPose(options = {}) {
  return { ...options, modelRotationX: 0, modelRotationZ: 0 };
}

/** Separate floor and upright residuals; these describe fit to marks, not physical camera accuracy. */
export function calibrationFitFeedback(result, observedPoints) {
  if (!result) return { quality: 'unavailable', message: '请先标记底板四角。', cornerRmsPx: null, cornerMaxPx: null,
    uprightRmsDeg: null, uprightMaxDeg: null, cornerErrorsPx: [], outsideCorners: false, noUprightGuides: true };
  validateCamera(result);
  let cornerErrorsPx = [];
  let cornerRmsPx = validMetric(result.reprojectionErrorPx) ? result.reprojectionErrorPx : null;
  let cornerMaxPx = validMetric(result.maxReprojectionErrorPx) ? result.maxReprojectionErrorPx : null;
  if (observedPoints !== undefined && observedPoints !== null) {
    if (!Array.isArray(observedPoints) || observedPoints.length !== 4
        || observedPoints.some(point => !Number.isFinite(point?.x) || !Number.isFinite(point?.y))) {
      throw new Error('对齐反馈需要四个有效的底板角点。');
    }
    cornerErrorsPx = planeCorners(result).map((corner, i) => {
      const actual = normalizedProjection(corner, result);
      return Math.hypot((actual.x - observedPoints[i].x) * result.imageSize.width,
        (actual.y - observedPoints[i].y) * result.imageSize.height);
    });
    cornerRmsPx = Math.hypot(...cornerErrorsPx) / 2;
    cornerMaxPx = Math.max(...cornerErrorsPx);
  }
  const verticalErrors = Array.isArray(result.verticalLineErrorsDeg) && result.verticalLineErrorsDeg.length
    && result.verticalLineErrorsDeg.every(validMetric) ? result.verticalLineErrorsDeg : [];
  const uprightRmsDeg = verticalErrors.length ? Math.hypot(...verticalErrors) / Math.sqrt(verticalErrors.length)
    : validMetric(result.verticalErrorDeg) ? result.verticalErrorDeg : null;
  const uprightMaxDeg = verticalErrors.length ? Math.max(...verticalErrors)
    : validMetric(result.maxVerticalErrorDeg) ? result.maxVerticalErrorDeg : uprightRmsDeg;
  const outsideCorners = Array.isArray(observedPoints) && observedPoints.some(point => point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1);
  const noUprightGuides = uprightRmsDeg === null;
  const imageShortSide = Math.min(result.imageSize.width, result.imageSize.height);
  const softLimit = Math.max(1.5, imageShortSide * 0.003);
  const severeLimit = Math.max(12, imageShortSide * 0.025);
  const quality = cornerRmsPx === null ? 'unavailable'
    : cornerRmsPx > severeLimit || (uprightMaxDeg !== null && uprightMaxDeg > 2) ? 'needs-adjustment'
    : cornerRmsPx > softLimit || outsideCorners || noUprightGuides ? 'review' : 'good';
  const parts = [cornerRmsPx === null ? '底板偏差未知' : `底板偏差 ${cornerRmsPx.toFixed(1)} px`];
  if (noUprightGuides) parts.push('未添加竖直参考，请核对模型站立方向');
  else parts.push(`竖直偏差 ${uprightRmsDeg.toFixed(1)}°`);
  if (outsideCorners) parts.push('含画外估角');
  if (quality === 'needs-adjustment') parts.push('请微调参考线或底板角点');
  return { quality, message: parts.join(' · '), cornerRmsPx, cornerMaxPx, uprightRmsDeg, uprightMaxDeg,
    cornerErrorsPx, outsideCorners, noUprightGuides };
}
