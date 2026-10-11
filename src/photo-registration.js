// Fixed-camera photo comparison and silhouette fitting. All pixels and masks
// use a top-left origin. No photo or model data leaves the browser.

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const luminance = (r, g, b) => r * 0.2126 + g * 0.7152 + b * 0.0722;

function validateImage(rgba, width, height, label) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 8 || height < 8 || !rgba || rgba.length !== width * height * 4) {
    throw new Error(`${label}需要是相同尺寸的 RGBA 照片，宽高至少为 8 像素。`);
  }
}

function quantileHistogram(histogram, count, fraction) {
  if (!count) return 0;
  const target = Math.max(1, Math.ceil(count * fraction));
  let total = 0;
  for (let i = 0; i < histogram.length; i++) {
    total += histogram[i];
    if (total >= target) return i;
  }
  return histogram.length - 1;
}

function pixelResidual(empty, target, a, b, gain, offset) {
  return (Math.abs(target[b] - (empty[a] * gain[0] + offset[0]))
    + Math.abs(target[b + 1] - (empty[a + 1] * gain[1] + offset[1]))
    + Math.abs(target[b + 2] - (empty[a + 2] * gain[2] + offset[2]))) / 3;
}

function photoSamples(empty, target, width, height, dx, dy, stride, border) {
  const a = [], b = [];
  for (let y = border; y < height - border; y += stride) {
    const ty = y + dy;
    if (ty < 0 || ty >= height) continue;
    for (let x = border; x < width - border; x += stride) {
      const tx = x + dx;
      if (tx < 0 || tx >= width) continue;
      const ai = (y * width + x) * 4, bi = (ty * width + tx) * 4;
      if (empty[ai + 3] < 128 || target[bi + 3] < 128) continue;
      a.push(ai); b.push(bi);
    }
  }
  return { a, b };
}

function fitExposure(empty, target, samples) {
  const gain = [1, 1, 1], offset = [0, 0, 0];
  const differences = Array.from({ length: 3 }, () => new Uint32Array(511));
  for (let i = 0; i < samples.a.length; i++) {
    for (let channel = 0; channel < 3; channel++) differences[channel][Math.round(target[samples.b[i] + channel] - empty[samples.a[i] + channel]) + 255]++;
  }
  for (let channel = 0; channel < 3; channel++) offset[channel] = quantileHistogram(differences[channel], samples.a.length, 0.5) - 255;
  // Refit the most stable 65% twice; a newly placed object must not determine
  // the whole photo's exposure. This also handles modest automatic exposure.
  for (let pass = 0; pass < 2; pass++) {
    const histogram = new Uint32Array(256);
    for (let i = 0; i < samples.a.length; i++) histogram[Math.min(255, Math.round(pixelResidual(empty, target, samples.a[i], samples.b[i], gain, offset)))]++;
    const cutoff = quantileHistogram(histogram, samples.a.length, 0.65) + 0.6;
    const sums = Array.from({ length: 3 }, () => [0, 0, 0, 0]);
    let count = 0;
    for (let i = 0; i < samples.a.length; i++) {
      const ai = samples.a[i], bi = samples.b[i];
      if (pixelResidual(empty, target, ai, bi, gain, offset) > cutoff) continue;
      count++;
      for (let channel = 0; channel < 3; channel++) {
        const x = empty[ai + channel], y = target[bi + channel], s = sums[channel];
        s[0] += x; s[1] += y; s[2] += x * x; s[3] += x * y;
      }
    }
    if (count < 8) break;
    for (let channel = 0; channel < 3; channel++) {
      const [x, y, xx, xy] = sums[channel];
      const variance = xx - x * x / count;
      if (variance / count > 20) gain[channel] = clamp((xy - x * y / count) / variance, 0.55, 1.8);
      offset[channel] = clamp((y - gain[channel] * x) / count, -70, 70);
    }
  }
  const histogram = new Uint32Array(256);
  for (let i = 0; i < samples.a.length; i++) histogram[Math.min(255, Math.round(pixelResidual(empty, target, samples.a[i], samples.b[i], gain, offset)))]++;
  const cutoff = quantileHistogram(histogram, samples.a.length, 0.65);
  let sum = 0, count = 0;
  for (let i = 0; i <= cutoff; i++) { sum += i * histogram[i]; count += histogram[i]; }
  return { gain, offset, score: count ? sum / count : Infinity, noise: quantileHistogram(histogram, samples.a.length, 0.5), sampleCount: samples.a.length };
}

function estimateTranslation(empty, target, width, height, maxTranslation) {
  const stride = Math.max(1, Math.floor(Math.min(width, height) / 64));
  const border = Math.min(maxTranslation + 1, Math.floor(Math.min(width, height) / 6));
  let best = null, zero = null;
  const candidates = [];
  for (let dy = -maxTranslation; dy <= maxTranslation; dy++) {
    for (let dx = -maxTranslation; dx <= maxTranslation; dx++) {
      const samples = photoSamples(empty, target, width, height, dx, dy, stride, border);
      if (samples.a.length < 8) continue;
      const exposure = fitExposure(empty, target, samples);
      // In a textureless scene many shifts fit equally well. Prefer no shift
      // instead of inventing a camera movement from that ambiguity.
      const score = exposure.score + 0.018 * (dx * dx + dy * dy);
      const candidate = { x: dx, y: dy, ...exposure, penalizedScore: score };
      if (!dx && !dy) zero = candidate;
      candidates.push(candidate);
      if (!best || score < best.penalizedScore) best = candidate;
    }
  }
  if (!best) throw new Error('照片中没有足够的有效像素，请换一组清晰的实景照片。');
  const alternatives = candidates.filter(candidate => Math.hypot(candidate.x - best.x, candidate.y - best.y) >= 2);
  const next = alternatives.reduce((min, candidate) => Math.min(min, candidate.penalizedScore), Infinity);
  return { ...best, improvement: Math.max(0, (zero?.score ?? best.score) - best.score), margin: Number.isFinite(next) ? next - best.penalizedScore : 0 };
}

function connectedComponents(mask, width, height) {
  const labels = new Int32Array(mask.length), queue = new Int32Array(mask.length), components = [];
  let label = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] || labels[i]) continue;
    label++;
    let start = 0, end = 1;
    queue[0] = i; labels[i] = label;
    const component = { label, count: 0, strong: 0, xMin: width, yMin: height, xMax: 0, yMax: 0 };
    while (start < end) {
      const index = queue[start++], x = index % width, y = Math.floor(index / width);
      component.count++; component.strong += mask[index] === 255 ? 1 : 0;
      component.xMin = Math.min(component.xMin, x); component.xMax = Math.max(component.xMax, x);
      component.yMin = Math.min(component.yMin, y); component.yMax = Math.max(component.yMax, y);
      for (const neighbour of [x > 0 ? index - 1 : -1, x + 1 < width ? index + 1 : -1, y > 0 ? index - width : -1, y + 1 < height ? index + width : -1]) {
        if (neighbour < 0 || !mask[neighbour] || labels[neighbour]) continue;
        labels[neighbour] = label; queue[end++] = neighbour;
      }
    }
    components.push(component);
  }
  return { labels, components };
}

function keepForeground(mask, width, height) {
  const { labels, components } = connectedComponents(mask, width, height);
  const largest = components.reduce((maximum, component) => component.strong > 0 ? Math.max(maximum, component.count) : maximum, 0);
  const threshold = Math.max(3, Math.floor(largest * 0.002));
  const keep = new Set(components.filter(component => component.strong > 0 && component.count >= threshold).map(component => component.label));
  const result = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) if (keep.has(labels[i])) result[i] = 255;
  return { mask: result, components: components.filter(component => keep.has(component.label)) };
}

export function maskBounds(mask, width, height) {
  let xMin = width, yMin = height, xMax = -1, yMax = -1, area = 0, xTotal = 0, yTotal = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const x = i % width, y = Math.floor(i / width);
    xMin = Math.min(xMin, x); xMax = Math.max(xMax, x); yMin = Math.min(yMin, y); yMax = Math.max(yMax, y);
    area++; xTotal += x; yTotal += y;
  }
  return area ? { x: xMin, y: yMin, width: xMax - xMin + 1, height: yMax - yMin + 1, xMin, yMin, xMax, yMax, area, centerX: xTotal / area, centerY: yTotal / area } : null;
}

function chromaticityDistance(a, b) {
  const sa = Math.max(12, a[0] + a[1] + a[2]), sb = Math.max(12, b[0] + b[1] + b[2]);
  return Math.max(...a.map((value, channel) => Math.abs(value / sa - b[channel] / sb)));
}

/**
 * Compare empty photo A with finished photo B from the same camera. Small
 * integer translations and a robust per-channel exposure change are fitted
 * from the unchanged background. The returned mask is in photo A coordinates.
 * translation {x,y} means B moved by that amount relative to A; render the
 * comparison photo B at (-x,-y), or use alignedTargetRGBA directly.
 * A mask is a difference estimate, not proof of a physical model's identity.
 */
export function analysePhotoPair({ emptyRGBA, targetRGBA, width, height, maxTranslation = 6, suppressShadows = true } = {}) {
  validateImage(emptyRGBA, width, height, '空场景照片');
  validateImage(targetRGBA, width, height, '成品照片');
  maxTranslation = clamp(Math.round(Number(maxTranslation) || 0), 0, Math.min(16, Math.floor(Math.min(width, height) / 8)));
  const translation = estimateTranslation(emptyRGBA, targetRGBA, width, height, maxTranslation);
  const warnings = [], size = width * height;
  const alignedTargetRGBA = new Uint8ClampedArray(size * 4), residual = new Float32Array(size), difference = new Uint8Array(size);
  const shadowMask = new Uint8Array(size), suspectedShadowMask = new Uint8Array(size);
  const predicted = new Float32Array(size * 3), valid = new Uint8Array(size);
  const threshold = Math.max(12, translation.noise * 3 + 8), weakThreshold = Math.max(7, threshold * 0.55);
  let suspectedShadowPixels = 0, suppressedShadowPixels = 0;
  for (let y = 0; y < height; y++) {
    const ty = y + translation.y;
    for (let x = 0; x < width; x++) {
      const index = y * width + x, ai = index * 4, tx = x + translation.x;
      for (let channel = 0; channel < 3; channel++) predicted[index * 3 + channel] = clamp(emptyRGBA[ai + channel] * translation.gain[channel] + translation.offset[channel], 0, 255);
      if (tx < 0 || tx >= width || ty < 0 || ty >= height) {
        alignedTargetRGBA.set(emptyRGBA.subarray ? emptyRGBA.subarray(ai, ai + 4) : emptyRGBA.slice(ai, ai + 4), ai);
        continue;
      }
      const bi = (ty * width + tx) * 4;
      for (let channel = 0; channel < 4; channel++) alignedTargetRGBA[ai + channel] = targetRGBA[bi + channel];
      if (emptyRGBA[ai + 3] < 128 || targetRGBA[bi + 3] < 128) continue;
      valid[index] = 1;
      residual[index] = pixelResidual(emptyRGBA, targetRGBA, ai, bi, translation.gain, translation.offset);
      difference[index] = residual[index] >= threshold ? 255 : residual[index] >= weakThreshold ? 128 : 0;
      if (!difference[index]) continue;
      const a = Array.from(predicted.subarray(index * 3, index * 3 + 3)), b = Array.from(targetRGBA.subarray ? targetRGBA.subarray(bi, bi + 3) : targetRGBA.slice(bi, bi + 3));
      const intensityA = luminance(...a), intensityB = luminance(...b), ratio = intensityB / Math.max(intensityA, 1);
      // Only modest proportional darkening is a possible cast shadow. A black
      // part and a shadow can share color, so require preserved local texture
      // below before suppressing it. Flat ambiguous regions stay in the mask.
      if (intensityA > 30 && ratio > 0.5 && ratio < 0.92 && chromaticityDistance(a, b) < 0.035) {
        suspectedShadowMask[index] = 255; suspectedShadowPixels++;
      }
    }
  }
  if (suppressShadows) {
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const index = y * width + x;
        if (!suspectedShadowMask[index]) continue;
        const neighbors = [index - 1, index + 1, index - width, index + width];
        if (neighbors.some(neighbor => !valid[neighbor]) || neighbors.filter(neighbor => suspectedShadowMask[neighbor]).length < 3) continue;
        const intensityA = luminance(...predicted.subarray(index * 3, index * 3 + 3));
        const intensityB = luminance(...alignedTargetRGBA.subarray(index * 4, index * 4 + 3));
        const ratio = intensityB / Math.max(intensityA, 1);
        let texture = 0, error = 0;
        for (const neighbor of neighbors) {
          const da = luminance(...predicted.subarray(neighbor * 3, neighbor * 3 + 3)) - intensityA;
          const db = luminance(...alignedTargetRGBA.subarray(neighbor * 4, neighbor * 4 + 3)) - intensityB;
          texture += Math.abs(da); error += Math.abs(db - ratio * da);
        }
        if (texture > 16 && error < Math.max(6, texture * 0.22)) {
          shadowMask[index] = 255; difference[index] = 0; suppressedShadowPixels++;
        }
      }
    }
  }
  const cleaned = keepForeground(difference, width, height), mask = cleaned.mask;
  const bbox = maskBounds(mask, width, height), foregroundRatio = (bbox?.area ?? 0) / size;
  let contrast = 0;
  for (let i = 0; i < size; i++) if (mask[i]) contrast += residual[i];
  contrast /= Math.max(1, bbox?.area ?? 0);
  let confidence = clamp((contrast - threshold) / 45, 0, 1) * 0.25 + clamp(1 - translation.score / 18, 0, 1) * 0.45 + clamp(foregroundRatio / 0.015, 0, 1) * 0.2;
  const usable = Boolean(bbox && bbox.area >= 12 && foregroundRatio < 0.55 && translation.score < 24);
  if (!bbox || bbox.area < 12) { warnings.push('没有识别到清楚的成品轮廓。请使用同机位的空场景与成品照片，或手动对齐。'); confidence = 0; }
  if (foregroundRatio >= 0.55) { warnings.push('照片变化覆盖了大半个画面，可能发生机位移动或光线变化。请检查照片，暂不建议自动重合。'); confidence = Math.min(confidence, 0.2); }
  if (translation.score >= 8) { warnings.push('背景仍有明显差异；请尽量保持机位、灯光和曝光一致，并检查识别轮廓。'); confidence *= clamp(1 - translation.score / 40, 0.2, 1); }
  if (maxTranslation && (Math.abs(translation.x) === maxTranslation || Math.abs(translation.y) === maxTranslation)) warnings.push('照片位移已接近自动补偿范围，请检查拍摄机位是否移动。');
  if (suspectedShadowPixels > Math.max(12, (bbox?.area ?? 0) * 0.06)) {
    warnings.push(suppressedShadowPixels > 0
      ? '已排除部分保留背景纹理的阴影；深色模型与阴影仍可能混淆，请检查轮廓。'
      : '检测到可能的阴影或同色深色区域，无法可靠区分，已保留这些区域供人工检查。');
    confidence *= 0.85;
  }
  if (bbox && (bbox.xMin <= Math.max(1, -translation.x) || bbox.yMin <= Math.max(1, -translation.y) || bbox.xMax >= width - Math.max(2, translation.x + 1) || bbox.yMax >= height - Math.max(2, translation.y + 1))) {
    warnings.push('成品轮廓接近照片边缘，可能被裁切。自动重合只能作为参考。'); confidence *= 0.8;
  }
  if (cleaned.components.filter(component => component.count > (bbox?.area ?? 1) * 0.15).length > 2) {
    warnings.push('检测到多个明显变化区域，请确认画面中只新增了需要对齐的成品。'); confidence *= 0.8;
  }
  const differenceMask = new Uint8Array(size);
  for (let i = 0; i < size; i++) if (residual[i] >= weakThreshold && valid[i]) differenceMask[i] = 255;
  return {
    mask, differenceMask, shadowMask, suspectedShadowMask, alignedTargetRGBA, width, height, bbox,
    confidence: clamp(confidence, 0, 0.88), usable, foregroundRatio, contrast, threshold,
    translation: { x: translation.x, y: translation.y, backgroundResidual: translation.score, confidence: clamp(translation.margin / 3, 0, 1) },
    exposure: { gain: translation.gain, offset: translation.offset }, suppressedShadowPixels, warnings,
    limitations: ['变化轮廓可能包含阴影、支撑或其他新增物体。', '两张同机位照片只能约束投影轮廓，无法保证三维姿态唯一。'],
  };
}

function binaryMask(source, width, height, label) {
  const data = source?.mask ?? source?.data ?? source;
  if (!data || data.length !== width * height) throw new Error(`${label}尺寸与预览不一致，请重新识别照片。`);
  const result = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) result[i] = data[i] >= 128 || data[i] === 1 ? 255 : 0;
  return result;
}

function distanceTransform(mask, width, height) {
  const distance = new Float32Array(mask.length), maximum = Math.hypot(width, height), diagonal = Math.SQRT2;
  for (let i = 0; i < mask.length; i++) distance[i] = mask[i] ? 0 : maximum;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (x) distance[i] = Math.min(distance[i], distance[i - 1] + 1);
      if (y) distance[i] = Math.min(distance[i], distance[i - width] + 1);
      if (x && y) distance[i] = Math.min(distance[i], distance[i - width - 1] + diagonal);
      if (x + 1 < width && y) distance[i] = Math.min(distance[i], distance[i - width + 1] + diagonal);
    }
  }
  for (let y = height - 1; y >= 0; y--) {
    for (let x = width - 1; x >= 0; x--) {
      const i = y * width + x;
      if (x + 1 < width) distance[i] = Math.min(distance[i], distance[i + 1] + 1);
      if (y + 1 < height) distance[i] = Math.min(distance[i], distance[i + width] + 1);
      if (x + 1 < width && y + 1 < height) distance[i] = Math.min(distance[i], distance[i + width + 1] + diagonal);
      if (x && y + 1 < height) distance[i] = Math.min(distance[i], distance[i + width - 1] + diagonal);
    }
  }
  return distance;
}

function evaluateSilhouette(target, rendered, width, height, targetDistance, targetBounds) {
  const renderedBounds = maskBounds(rendered, width, height);
  if (!renderedBounds) return { score: 0, iou: 0, chamferDistancePx: Math.hypot(width, height), renderedBounds: null };
  let intersection = 0, union = 0, forwardDistance = 0, reverseDistance = 0;
  const renderedDistance = distanceTransform(rendered, width, height);
  for (let i = 0; i < target.length; i++) {
    if (target[i] && rendered[i]) intersection++;
    if (target[i] || rendered[i]) union++;
    if (rendered[i]) forwardDistance += targetDistance[i];
    if (target[i]) reverseDistance += renderedDistance[i];
  }
  const iou = intersection / Math.max(1, union);
  const chamferDistancePx = (forwardDistance / renderedBounds.area + reverseDistance / targetBounds.area) / 2;
  const diagonal = Math.hypot(width, height);
  const shape = Math.exp(-chamferDistancePx / (diagonal * 0.045));
  const centerDistance = Math.hypot(renderedBounds.centerX - targetBounds.centerX, renderedBounds.centerY - targetBounds.centerY);
  const location = Math.exp(-centerDistance / (diagonal * 0.15));
  return { score: 0.72 * iou + 0.2 * shape + 0.08 * location, iou, chamferDistancePx, renderedBounds };
}

/**
 * Bounded deterministic coarse-to-fine silhouette fitting. Keep a calibrated
 * camera fixed and supply physical model position/scale/rotation bounds.
 * renderMask(params,width,height) may return a one-channel Uint8Array or
 * {data/mask,width,height}; rows must start at the top of the image. Rendering
 * must exclude supports and controls. The function does not mutate the studio.
 * onProgress receives {evaluations,maxEvaluations,params,score,iou}.
 */
export async function autoAlignModel({ targetMask, width = targetMask?.width, height = targetMask?.height, renderMask, initialParams = {}, bounds = {}, onProgress, shouldCancel = () => false, maxEvaluations = 180 } = {}) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 8 || height < 8) throw new Error('请先识别成品照片，再进行自动重合。');
  if (typeof renderMask !== 'function') throw new Error('模型预览尚未准备好，请先导入模型。');
  const target = binaryMask(targetMask, width, height, '成品轮廓');
  const targetBounds = maskBounds(target, width, height);
  if (!targetBounds || targetBounds.area < 12) throw new Error('成品轮廓太小或为空，请重新识别照片或手动重合。');
  const ranges = Object.entries(bounds).map(([key, range]) => ({ key, min: Number(Array.isArray(range) ? range[0] : range?.min), max: Number(Array.isArray(range) ? range[1] : range?.max) }));
  if (!ranges.length || ranges.some(range => !Number.isFinite(range.min) || !Number.isFinite(range.max) || range.min >= range.max || !Number.isFinite(initialParams[range.key]))) {
    throw new Error('模型自动重合的调整范围无效，请先回正模型后重试。');
  }
  maxEvaluations = clamp(Math.floor(Number(maxEvaluations) || 180), 1, 240);
  const initial = { ...initialParams };
  for (const range of ranges) initial[range.key] = clamp(initial[range.key], range.min, range.max);
  const targetDistance = distanceTransform(target, width, height), cache = new Map();
  let evaluations = 0, cancelled = false, best = null;
  const available = () => {
    cancelled = Boolean(shouldCancel());
    return !cancelled && evaluations < maxEvaluations;
  };
  const evaluate = async params => {
    if (!available()) return null;
    const key = ranges.map(range => Number(params[range.key]).toFixed(8)).join(',');
    if (cache.has(key)) return cache.get(key);
    const output = await renderMask({ ...params }, width, height);
    if (output?.width !== undefined && output.width !== width || output?.height !== undefined && output.height !== height) throw new Error('模型轮廓渲染尺寸不匹配，请重新尝试自动重合。');
    const rendered = binaryMask(output, width, height, '模型轮廓');
    evaluations++;
    const metrics = evaluateSilhouette(target, rendered, width, height, targetDistance, targetBounds);
    const result = { params: { ...params }, ...metrics };
    cache.set(key, result);
    if (!best || result.score > best.score + 1e-10) best = result;
    if (onProgress) await onProgress({ evaluations, maxEvaluations, params: { ...best.params }, score: best.score, iou: best.iou });
    if (evaluations % 4 === 0) await new Promise(resolve => setTimeout(resolve, 0));
    return result;
  };
  const start = await evaluate(initial);
  if (!start) return { params: initial, score: 0, initialScore: 0, iou: 0, evaluations, confidence: 0, cancelled: true, warnings: [], targetBounds };
  // Global one-dimensional scans let a displaced model approach the object
  // even when their masks initially do not overlap. Chamfer distance provides
  // a continuous incentive in that otherwise-flat IoU region.
  for (let pass = 0; pass < 2 && available() && best.score < 0.994; pass++) {
    for (const range of ranges) {
      const anchor = { ...best.params };
      for (const fraction of [0.125, 0.375, 0.625, 0.875]) {
        if (!available() || best.score >= 0.994) break;
        await evaluate({ ...anchor, [range.key]: range.min + (range.max - range.min) * fraction });
      }
      if (!available() || best.score >= 0.994) break;
    }
  }
  for (const fraction of [0.125, 0.0625, 0.03125, 0.015625, 0.0078125, 0.00390625]) {
    if (!available() || best.score >= 0.994) break;
    for (let sweep = 0; sweep < 3 && available(); sweep++) {
      const previousScore = best.score;
      for (const range of ranges) {
        const anchor = { ...best.params }, step = (range.max - range.min) * fraction;
        for (const direction of [-1, 1]) {
          if (!available() || best.score >= 0.994) break;
          const value = clamp(anchor[range.key] + direction * step, range.min, range.max);
          if (value !== anchor[range.key]) await evaluate({ ...anchor, [range.key]: value });
        }
        if (!available() || best.score >= 0.994) break;
      }
      if (best.score >= 0.994 || best.score - previousScore < 0.0001) break;
    }
  }
  const warnings = [];
  if (best.iou < 0.5) warnings.push('模型与成品轮廓仍有明显差异，请先检查平台透视、模型方向和识别轮廓，再手动微调。');
  else if (best.iou < 0.85) warnings.push('自动重合得到的是初步位置，部分边缘仍需手动微调。');
  if (!cancelled && best.score < 0.95 && best.score - start.score < 0.01) warnings.push('自动搜索没有明显改善重合程度；请先手动靠近目标位置后再试。');
  if (ranges.some(range => Math.min(best.params[range.key] - range.min, range.max - best.params[range.key]) < (range.max - range.min) * 0.004)) warnings.push('部分参数接近调整范围边界，请检查模型大小、平台透视或手动扩大调整范围。');
  return {
    params: { ...best.params }, score: best.score, initialScore: start.score, iou: best.iou,
    chamferDistancePx: best.chamferDistancePx, evaluations, confidence: clamp(best.iou * 0.88, 0, 0.88), cancelled,
    targetBounds, renderedBounds: best.renderedBounds, warnings,
    limitations: ['轮廓相同不代表三维姿态唯一；请用成品叠加画面核对颜色、底面与遮挡。', '自动搜索使用低分辨率轮廓，精细边缘需要在大预览中手动检查。'],
  };
}
