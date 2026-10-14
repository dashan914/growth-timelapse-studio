// A frame-wide push keeps a photographed bed and its registered model aligned.
export function cameraMotionScale(time, { motion = 'fixed', pushAmount = 20, pushDuration = 8 } = {}) {
  if (motion !== 'push') return 1;
  const amount = Number.isFinite(Number(pushAmount)) ? Math.min(100, Math.max(0, Number(pushAmount))) / 100 : .2;
  const duration = Number.isFinite(Number(pushDuration)) ? Math.max(.1, Number(pushDuration)) : 8;
  const t = Math.min(1, Math.max(0, Number(time) || 0) / duration);
  return 1 + amount * t;
}

export async function applyFramePush(blob, scale, canvas = null) {
  if (scale <= 1) return blob;
  canvas ||= document.createElement('canvas');
  const bitmap = await createImageBitmap(blob);
  try {
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    const context = canvas.getContext('2d', { alpha: true });
    if (!context) throw new Error('无法创建运镜画布。');
    context.imageSmoothingEnabled = true; context.imageSmoothingQuality = 'high';
    const width = bitmap.width / scale, height = bitmap.height / scale;
    context.drawImage(bitmap, (bitmap.width-width)/2, (bitmap.height-height)/2, width, height, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('运镜画面生成失败。')), 'image/png'));
  } finally { bitmap.close(); }
}
