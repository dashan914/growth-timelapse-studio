// Keep output framing and file dimensions fixed while giving fine geometry
// more coverage samples. Large outputs already contain enough pixels; avoid
// multiplying GPU memory there, particularly with depth-of-field targets.
export function exportRenderPlan(width, height, { maxPixels = 8_388_608, maxSize = 8192 } = {}) {
  if (![width, height].every(value => Number.isInteger(value) && value >= 16 && value <= 8192)) {
    throw new Error('导出尺寸必须为 16 至 8192 的整数。');
  }
  const doubledFits = width * 2 <= maxSize && height * 2 <= maxSize && width * height * 4 <= maxPixels;
  const scale = doubledFits ? 2 : 1;
  return { width, height, renderWidth: width * scale, renderHeight: height * scale, scale };
}

const SRGB_TO_LINEAR = Float64Array.from({ length: 256 }, (_, value) => {
  const encoded = value / 255;
  return encoded <= .04045 ? encoded / 12.92 : ((encoded + .055) / 1.055) ** 2.4;
});
const LINEAR_TO_SRGB = Uint8Array.from({ length: 65536 }, (_, value) => {
  const linear = value / 65535;
  return Math.round(255 * (linear <= .0031308 ? 12.92 * linear : 1.055 * linear ** (1 / 2.4) - .055));
});
const linearByte = value => LINEAR_TO_SRGB[Math.min(65535, Math.max(0, Math.round(value * 65535)))];
const FRAME_CANVASES = new WeakMap();

/** Exact 2× pixel-area integration of the rendered image. RGB is decoded into
 * linear light, multiplied by coverage alpha, averaged, then encoded to sRGB.
 * Tool colors and geometry are never rewritten; only pixel coverage is filtered.
 * The input is straight-alpha sRGB RGBA8, as returned by an sRGB canvas readback. */
export function linearLightDownsample2x(source, sourceWidth, sourceHeight, target = null) {
  if (![sourceWidth, sourceHeight].every(value => Number.isInteger(value) && value >= 2 && value % 2 === 0) || sourceWidth * sourceHeight > 8_388_608) {
    throw new RangeError('2×线性缩图需要完整偶数像素尺寸，且源图不能超过 8388608 像素。');
  }
  if (!(source instanceof Uint8Array || source instanceof Uint8ClampedArray) || source.length !== sourceWidth * sourceHeight * 4) throw new TypeError('线性缩图需要完整 sRGB RGBA8 像素。');
  const width = sourceWidth / 2, height = sourceHeight / 2;
  target ||= new Uint8ClampedArray(width * height * 4);
  if (!(target instanceof Uint8Array || target instanceof Uint8ClampedArray) || target.length !== width * height * 4) throw new TypeError('线性缩图目标像素尺寸错误。');
  if (target.buffer === source.buffer && target.byteOffset < source.byteOffset + source.byteLength && source.byteOffset < target.byteOffset + target.byteLength) throw new TypeError('线性缩图不能覆盖原始源像素。');
  const stride = sourceWidth * 4;
  for (let y = 0, output = 0; y < sourceHeight; y += 2) for (let x = 0; x < sourceWidth; x += 2, output += 4) {
    const a = y * stride + x * 4, b = a + 4, c = a + stride, d = c + 4;
    const aa = source[a + 3], ab = source[b + 3], ac = source[c + 3], ad = source[d + 3], sumAlpha = aa + ab + ac + ad;
    const alpha = Math.round(sumAlpha / 4);
    target[output + 3] = alpha;
    if (alpha === 0) { target[output] = target[output + 1] = target[output + 2] = 0; continue; }
    if (sumAlpha === 1020) {
      // Opaque photos/MP4 frames are the common case. Avoid unnecessary alpha
      // multiplications and divisions while retaining true linear integration.
      target[output] = linearByte((SRGB_TO_LINEAR[source[a]] + SRGB_TO_LINEAR[source[b]] + SRGB_TO_LINEAR[source[c]] + SRGB_TO_LINEAR[source[d]]) * .25);
      target[output + 1] = linearByte((SRGB_TO_LINEAR[source[a + 1]] + SRGB_TO_LINEAR[source[b + 1]] + SRGB_TO_LINEAR[source[c + 1]] + SRGB_TO_LINEAR[source[d + 1]]) * .25);
      target[output + 2] = linearByte((SRGB_TO_LINEAR[source[a + 2]] + SRGB_TO_LINEAR[source[b + 2]] + SRGB_TO_LINEAR[source[c + 2]] + SRGB_TO_LINEAR[source[d + 2]]) * .25);
    } else {
      target[output] = linearByte((SRGB_TO_LINEAR[source[a]] * aa + SRGB_TO_LINEAR[source[b]] * ab + SRGB_TO_LINEAR[source[c]] * ac + SRGB_TO_LINEAR[source[d]] * ad) / sumAlpha);
      target[output + 1] = linearByte((SRGB_TO_LINEAR[source[a + 1]] * aa + SRGB_TO_LINEAR[source[b + 1]] * ab + SRGB_TO_LINEAR[source[c + 1]] * ac + SRGB_TO_LINEAR[source[d + 1]] * ad) / sumAlpha);
      target[output + 2] = linearByte((SRGB_TO_LINEAR[source[a + 2]] * aa + SRGB_TO_LINEAR[source[b + 2]] * ab + SRGB_TO_LINEAR[source[c + 2]] * ac + SRGB_TO_LINEAR[source[d + 2]] * ad) / sumAlpha);
    }
  }
  return { data: target, width, height };
}

function scratchCanvas(canvas, width, height, createScratch) {
  if (createScratch) return createScratch(width, height);
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(width, height);
  const document = canvas.ownerDocument || globalThis.document;
  if (!document?.createElement) throw new Error('无法创建线性缩图读取画布。');
  return document.createElement('canvas');
}

/** Reuses one full-resolution readback canvas and one final-size image buffer.
 * Transparent pixels are premultiplied in linear light before filtering, avoiding
 * dark/colored fringes. Scale 1 is untouched and decoded resources always close. */
export async function downsampleExportFrame(blob, plan, canvas, decode = createImageBitmap, {
  createScratch = null, yieldToUI = () => new Promise(resolve => setTimeout(resolve, 0)),
} = {}) {
  if (plan.scale === 1) return blob;
  if (plan.scale !== 2 || plan.renderWidth !== plan.width * 2 || plan.renderHeight !== plan.height * 2) throw new Error('线性缩图仅支持明确的完整 2×画面。');
  if (!canvas) throw new Error('缺少导出画布。');
  const bitmap = await decode(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'default' });
  try {
    if (bitmap.width !== plan.renderWidth || bitmap.height !== plan.renderHeight) throw new Error('渲染源图尺寸与 2×导出计划不一致，不能改裁剪或拉伸。');
    let state = FRAME_CANVASES.get(canvas);
    if (!state || state.width !== plan.width || state.height !== plan.height) {
      const scratch = scratchCanvas(canvas, plan.renderWidth, plan.renderHeight, createScratch);
      scratch.width = plan.renderWidth; scratch.height = plan.renderHeight;
      const read = scratch.getContext('2d', { alpha: true, colorSpace: 'srgb', willReadFrequently: true });
      if (!read) throw new Error('无法创建线性缩图读取画布。');
      state = { scratch, read, width: plan.width, height: plan.height, image: null };
      FRAME_CANVASES.set(canvas, state);
    }
    if (canvas.width !== plan.width) canvas.width = plan.width;
    if (canvas.height !== plan.height) canvas.height = plan.height;
    const context = canvas.getContext('2d', { alpha: true, colorSpace: 'srgb' });
    if (!context) throw new Error('无法创建导出画布。');
    state.read.clearRect(0, 0, plan.renderWidth, plan.renderHeight);
    state.read.imageSmoothingEnabled = false;
    state.read.drawImage(bitmap, 0, 0); // 1:1 readback; browser does no sRGB resize.
    const source = state.read.getImageData(0, 0, plan.renderWidth, plan.renderHeight);
    await yieldToUI();
    state.image ||= context.createImageData(plan.width, plan.height);
    linearLightDownsample2x(source.data, plan.renderWidth, plan.renderHeight, state.image.data);
    context.putImageData(state.image, 0, 0);
    return await new Promise((resolve, reject) => canvas.toBlob(
      result => result ? resolve(result) : reject(new Error('无法生成高清画面。')), 'image/png',
    ));
  } finally { bitmap.close(); }
}
