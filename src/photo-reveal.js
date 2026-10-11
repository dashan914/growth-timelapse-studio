// Reveal real finished-photo pixels using the imported model's projected
// world-height map. Photo data and source geometry are never modified.

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function checkDimensions(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new Error('实拍生长预览的画面尺寸无效，请重新导入照片。');
}

function checkRGBA(data, width, height, name) {
  if (!data || data.length !== width * height * 4) throw new Error(`${name}与实拍生长预览的尺寸不一致，请重新对齐照片。`);
}

function copyMask(source, size, name) {
  const data = source?.mask ?? source?.data ?? source;
  if (!data || data.length !== size) throw new Error(`${name}与照片的尺寸不一致，请重新识别或对齐。`);
  const mask = new Uint8Array(size);
  for (let i = 0; i < size; i++) mask[i] = data[i] === 1 || data[i] >= 128 ? 255 : 0;
  return mask;
}

// Minimize (x-sourceX)^2 + (y-sourceY)^2 in two separable passes. Row labels
// record the nearest source X; the column quadratic envelope chooses its row.
// This gives true pixel distances, so diagonal gaps cannot exceed the user's
// fill distance by following a square neighborhood instead of a circle.
function nearestSources(mask, width, height) {
  const size = mask.length, large = 1e15;
  const horizontalDistance = new Float64Array(size), horizontalSource = new Int32Array(size);
  horizontalDistance.fill(large); horizontalSource.fill(-1);
  for (let y = 0; y < height; y++) {
    let sourceX = -1;
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      if (mask[index]) sourceX = x;
      if (sourceX >= 0) { horizontalDistance[index] = (x - sourceX) ** 2; horizontalSource[index] = y * width + sourceX; }
    }
    sourceX = -1;
    for (let x = width - 1; x >= 0; x--) {
      const index = y * width + x;
      if (mask[index]) sourceX = x;
      if (sourceX >= 0 && (x - sourceX) ** 2 < horizontalDistance[index]) {
        horizontalDistance[index] = (x - sourceX) ** 2; horizontalSource[index] = y * width + sourceX;
      }
    }
  }
  const nearest = new Int32Array(size), distanceSquared = new Float64Array(size);
  nearest.fill(-1); distanceSquared.fill(large);
  const sites = new Int32Array(height), limits = new Float64Array(height + 1);
  for (let x = 0; x < width; x++) {
    let count = -1;
    for (let y = 0; y < height; y++) {
      if (horizontalSource[y * width + x] < 0) continue;
      let boundary = -Infinity;
      while (count >= 0) {
        const previous = sites[count];
        boundary = (horizontalDistance[y * width + x] + y * y - horizontalDistance[previous * width + x] - previous * previous) / (2 * (y - previous));
        if (boundary > limits[count]) break;
        count--;
      }
      count++;
      sites[count] = y; limits[count] = count ? boundary : -Infinity; limits[count + 1] = Infinity;
    }
    if (count < 0) continue;
    let site = 0;
    for (let y = 0; y < height; y++) {
      while (site < count && limits[site + 1] < y) site++;
      const sourceY = sites[site], index = y * width + x;
      nearest[index] = horizontalSource[sourceY * width + x];
      distanceSquared[index] = (y - sourceY) ** 2 + horizontalDistance[sourceY * width + x];
    }
  }
  return { nearest, distanceSquared };
}

/**
 * Build a reusable real-photo growth state after aligning the model to B.
 * All inputs have identical width/height and a top-left origin. targetRGBA B
 * should already be registered to emptyRGBA A (e.g. alignedTargetRGBA from
 * analysePhotoPair). heightMap is a full-model, supports-free render with
 * {data:Uint16Array,mask:Uint8Array,width,height}; 0..65535 represents normalized
 * world Y, not image-row Y. Do not bilinearly interpolate height across holes.
 */
export function preparePhotoReveal({ emptyRGBA, targetRGBA, targetMask, heightMap, width, height, maxFillDistancePx = 12, minCoverage = 0.55 } = {}) {
  checkDimensions(width, height);
  checkRGBA(emptyRGBA, width, height, '空场景照片');
  checkRGBA(targetRGBA, width, height, '成品照片');
  if (!heightMap || heightMap.width !== width || heightMap.height !== height || heightMap.data?.length !== width * height) {
    throw new Error('模型高度图与照片的尺寸不一致，请重新对齐并生成高度图。');
  }
  if (!(heightMap.data instanceof Uint16Array)) throw new Error('模型高度图需要保留 16 位高度数据，请重新生成。');
  if (!Number.isFinite(maxFillDistancePx) || maxFillDistancePx < 0 || !Number.isFinite(minCoverage) || minCoverage <= 0 || minCoverage > 1) {
    throw new Error('实拍轮廓的匹配范围无效，请恢复默认设置后重试。');
  }
  const size = width * height, bodyMask = copyMask(targetMask, size, '成品轮廓'), modelMask = copyMask(heightMap.mask, size, '模型轮廓');
  const heights = new Uint16Array(size), mappedMask = new Uint8Array(size);
  let targetArea = 0, modelArea = 0, intersectionArea = 0;
  for (let i = 0; i < size; i++) {
    if (bodyMask[i]) targetArea++;
    if (!modelMask[i]) continue;
    modelArea++;
    const value = heightMap.data[i];
    if (!Number.isInteger(value) || value < 0 || value > 65535) throw new Error('模型高度图需要保留 16 位高度数据，请重新生成。');
    if (bodyMask[i]) { intersectionArea++; mappedMask[i] = 255; heights[i] = value; }
  }
  if (!targetArea) throw new Error('没有成品轮廓可用于实拍生长，请先识别成品照片。');
  if (!modelArea) throw new Error('模型未显示在照片画面内，请先移动模型并与成品重合。');
  const coverage = intersectionArea / targetArea, modelCoverage = intersectionArea / modelArea;
  const iou = intersectionArea / Math.max(1, targetArea + modelArea - intersectionArea);
  if (coverage < minCoverage || modelCoverage < minCoverage) {
    throw new Error(`模型与实拍轮廓重合不足（成品覆盖 ${Math.round(coverage * 100)}%，模型覆盖 ${Math.round(modelCoverage * 100)}%）。请先调整位置、大小及透视后再使用实拍生长。`);
  }
  let filledPixels = 0, maxFilledDistance = 0;
  if (intersectionArea < targetArea && maxFillDistancePx > 0) {
    // Restrict sources to the overlap. A separate model feature outside the
    // real object must not donate an unrelated height to an unmatched edge.
    const { nearest, distanceSquared } = nearestSources(mappedMask, width, height);
    const maximumSquared = maxFillDistancePx * maxFillDistancePx;
    for (let i = 0; i < size; i++) {
      if (!bodyMask[i] || mappedMask[i] || nearest[i] < 0 || distanceSquared[i] > maximumSquared) continue;
      heights[i] = heightMap.data[nearest[i]]; mappedMask[i] = 255; filledPixels++;
      maxFilledDistance = Math.max(maxFilledDistance, Math.sqrt(distanceSquared[i]));
    }
  }
  const unmappedPixels = targetArea - intersectionArea - filledPixels, coverageAfterFill = (intersectionArea + filledPixels) / targetArea;
  const warnings = [];
  if (iou < 0.8) warnings.push('实拍与模型边缘仍有差异，建议先用半透明叠加进一步微调。');
  if (filledPixels) warnings.push(`已为 ${Math.round(filledPixels / targetArea * 100)}% 的小幅边缘偏差补齐高度，最大距离 ${maxFilledDistance.toFixed(1)} 像素。`);
  if (unmappedPixels) warnings.push(`仍有 ${Math.round(unmappedPixels / targetArea * 100)}% 的实拍轮廓无法对应模型高度；这些区域在生长时使用模型渲染，结束时显示完整成品照片。`);
  return {
    emptyRGBA: new Uint8ClampedArray(emptyRGBA), targetRGBA: new Uint8ClampedArray(targetRGBA),
    targetMask: bodyMask, mappedMask, heights, width, height,
    stats: { targetArea, modelArea, intersectionArea, coverage, modelCoverage, iou, filledPixels, unmappedPixels, coverageAfterFill, maxFilledDistancePx: maxFilledDistance },
    warnings,
    limitations: ['照片只记录最终可见表面；生长中暂时暴露的内部及切面使用三维模型渲染。', '模型与实拍需先对齐，支撑、阴影或遮挡可能无法对应模型高度。'],
  };
}

/**
 * Composite a frame using per-pixel model height. At 0 the result is exactly
 * A; at 1 it is exactly B, including its photographed shadows/background.
 * For intermediate frames baseRGBA, when supplied, must be the current
 * height-clipped 3D composite over A. It provides temporary interior/cap
 * surfaces not photographed in B. Without it, those areas remain photo A.
 * `out` can be reused by a caller for every frame to avoid RGBA allocation.
 */
export function composePhotoReveal({ state, progress = 0, baseRGBA, out } = {}) {
  if (!state || !state.heights || !state.mappedMask) throw new Error('实拍生长尚未准备好，请先对齐模型和成品照片。');
  const { width, height } = state;
  checkDimensions(width, height);
  if (!Number.isFinite(progress)) throw new Error('模型生长进度无效。');
  const size = width * height;
  checkRGBA(state.emptyRGBA, width, height, '空场景照片'); checkRGBA(state.targetRGBA, width, height, '成品照片');
  if (state.heights.length !== size || state.mappedMask.length !== size) throw new Error('实拍生长高度数据不完整，请重新准备。');
  if (out !== undefined && (!(out instanceof Uint8ClampedArray) && !(out instanceof Uint8Array) || out?.length !== size * 4)) throw new Error('输出画布尺寸不一致。');
  if (out && (out.buffer === state.emptyRGBA.buffer || out.buffer === state.targetRGBA.buffer)) throw new Error('输出缓冲区不能覆盖原始照片。');
  const result = out ?? new Uint8ClampedArray(size * 4);
  progress = clamp(progress, 0, 1);
  if (progress === 0) { result.set(state.emptyRGBA); return result; }
  if (progress === 1) { result.set(state.targetRGBA); return result; }
  if (baseRGBA !== undefined) checkRGBA(baseRGBA, width, height, '当前模型渲染画面');
  result.set(baseRGBA ?? state.emptyRGBA);
  const threshold = progress * 65535;
  for (let i = 0; i < size; i++) {
    if (!state.mappedMask[i] || state.heights[i] > threshold) continue;
    const index = i * 4;
    result[index] = state.targetRGBA[index]; result[index + 1] = state.targetRGBA[index + 1];
    result[index + 2] = state.targetRGBA[index + 2]; result[index + 3] = state.targetRGBA[index + 3];
  }
  return result;
}
