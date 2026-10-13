import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const FREE_WATERMARK_PATH = fileURLToPath(new URL('./assets/free-watermark.png', import.meta.url));
export function freeWatermarkArguments(width, height, imagePath = FREE_WATERMARK_PATH) {
  if (![width, height].every(value => Number.isInteger(value) && value >= 64)) throw new TypeError('Invalid watermark output size');
  const size = Math.min(width - 16, Math.max(128, Math.min(360, Math.round(width * 0.36))));
  return ['-i', path.resolve(imagePath), '-filter_complex',
    `[1:v]scale=${size}:-1[brand];[0:v][brand]overlay=x='8+(main_w-overlay_w-16)*(0.5-0.5*cos(t/7))':y='main_h-overlay_h-8':eval=frame:format=auto,format=yuv420p[marked]`, '-map', '[marked]'];
}
