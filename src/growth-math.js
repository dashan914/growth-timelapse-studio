/** Pure timing and bounding helpers shared by preview and deterministic export. */
export function clamp01(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : 0;
}

export function growthSlice(progress, { min = 0, max = 1, direction = 'up', layerCount = 240, stepped = true } = {}) {
  const p = clamp01(progress);
  const count = Math.max(1, Math.round(Number(layerCount) || 1));
  const visibleLayers = p >= 1 ? count : Math.floor(p * count + 1e-10);
  const fraction = stepped ? visibleLayers / count : p;
  const low = Math.min(min, max);
  const high = Math.max(min, max);
  const height = direction === 'down' ? high - (high - low) * fraction : low + (high - low) * fraction;
  return { fraction, visibleLayers, height, empty: p === 0 || fraction === 0, complete: p === 1 };
}

/** Number of segments from sorted layer IDs which belong to the revealed layers. */
export function visibleSegmentCount(sortedLayers, visibleLayers, totalLayers, direction = 'up') {
  if (visibleLayers <= 0) return 0;
  if (visibleLayers >= totalLayers) return sortedLayers.length;
  const threshold = direction === 'down' ? totalLayers - visibleLayers : visibleLayers;
  let lo = 0;
  let hi = sortedLayers.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const visible = direction === 'down' ? sortedLayers[mid] >= threshold : sortedLayers[mid] < threshold;
    if (visible) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function coverTexture(imageWidth, imageHeight, viewportWidth, viewportHeight) {
  const imageAspect = imageWidth / Math.max(1, imageHeight);
  const viewportAspect = viewportWidth / Math.max(1, viewportHeight);
  if (imageAspect > viewportAspect) {
    const repeatX = viewportAspect / imageAspect;
    return { repeatX, repeatY: 1, offsetX: (1 - repeatX) / 2, offsetY: 0 };
  }
  const repeatY = imageAspect / viewportAspect;
  return { repeatX: 1, repeatY, offsetX: 0, offsetY: (1 - repeatY) / 2 };
}
