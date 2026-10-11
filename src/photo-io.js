function dimensions(width, height) {
  if (![width, height].every(value => Number.isInteger(value) && value > 0)) throw new Error('照片或输出画面尺寸无效。');
}

function cropRectangle(crop) {
  if (!crop) return { x: 0, y: 0, width: 1, height: 1 };
  const { x, y, width, height } = crop;
  if (![x, y, width, height].every(Number.isFinite) || x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > 1 + 1e-8 || y + height > 1 + 1e-8) {
    throw new Error('裁切范围需要位于原始照片内，请重新选择画面范围。');
  }
  return { x, y, width, height };
}

// Shared source-to-output mapping for photographs and nearest-neighbor masks.
// The crop is expressed in the full source, and output uses centered COVER.
// Positive translation denotes the target photo moving right/down relative to
// the empty photo, so drawing compensates it by moving the source left/up.
export function photoCoverTransform({ originalWidth, originalHeight, width, height, translation = { x: 0, y: 0 }, translationSize = null, crop = null }) {
  dimensions(originalWidth, originalHeight); dimensions(width, height);
  const rectangle = cropRectangle(crop);
  const scale = Math.max(width / (originalWidth * rectangle.width), height / (originalHeight * rectangle.height));
  let dx = 0, dy = 0;
  if (translationSize) {
    dimensions(translationSize.width, translationSize.height);
    if (![translation?.x, translation?.y].every(Number.isFinite)) throw new Error('照片对齐位移无效，请重新识别成品照片。');
    // The analysis photo also uses COVER; its pixel-to-source scale therefore
    // depends on both axes, not just analysis width / original width.
    const analysisScale = Math.max(translationSize.width / originalWidth, translationSize.height / originalHeight);
    dx = translation.x * scale / analysisScale;
    dy = translation.y * scale / analysisScale;
  }
  return {
    scale,
    x: (width - originalWidth * rectangle.width * scale) / 2 - originalWidth * rectangle.x * scale - dx,
    y: (height - originalHeight * rectangle.height * scale) / 2 - originalHeight * rectangle.y * scale - dy,
    drawnWidth: originalWidth * scale, drawnHeight: originalHeight * scale,
  };
}

export async function readPhoto(file, { maxWidth = 320, width, height, translation = { x: 0, y: 0 }, translationSize = null, crop = null, fallbackRGBA = null } = {}) {
  const bitmap = await createImageBitmap(file);
  try {
    const originalWidth = bitmap.width, originalHeight = bitmap.height;
    if (width === undefined) width = height === undefined ? Math.min(maxWidth, originalWidth) : Math.round(height * originalWidth / originalHeight);
    if (height === undefined) height = Math.round(width * originalHeight / originalWidth);
    const transform = photoCoverTransform({ originalWidth, originalHeight, width, height, translation, translationSize, crop });
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('无法读取照片画面，请重新载入页面后重试。');
    if (fallbackRGBA?.length === width * height * 4) context.putImageData(new ImageData(fallbackRGBA instanceof Uint8ClampedArray ? fallbackRGBA : new Uint8ClampedArray(fallbackRGBA), width, height), 0, 0);
    // Draw the complete source before applying the crop so valid pixels just
    // outside the crop remain available to compensate a camera bump.
    context.drawImage(bitmap, transform.x, transform.y, transform.drawnWidth, transform.drawnHeight);
    return { rgba: context.getImageData(0, 0, width, height).data, width, height, originalWidth, originalHeight, canvas };
  } finally { bitmap.close(); }
}

export function resizeMaskCover(mask, fromWidth, fromHeight, width, height, crop = null) {
  const transform = photoCoverTransform({ originalWidth: fromWidth, originalHeight: fromHeight, width, height, crop });
  if (!mask || mask.length !== fromWidth * fromHeight) throw new Error('成品轮廓尺寸与原始照片不一致，请重新识别。');
  const result = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    // Sample pixel centers, matching the projected height map. Sampling the
    // upper-left pixel corners shifts/downsamples narrow outlines incorrectly.
    const sx = Math.min(fromWidth - 1, Math.max(0, Math.floor((x + 0.5 - transform.x) / transform.scale)));
    const sy = Math.min(fromHeight - 1, Math.max(0, Math.floor((y + 0.5 - transform.y) / transform.scale)));
    result[y * width + x] = mask[sy * fromWidth + sx];
  }
  return result;
}
