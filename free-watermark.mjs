import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const FREE_WATERMARK_PATH = fileURLToPath(new URL('./assets/free-watermark.png', import.meta.url));
export function freeWatermarkArguments(width, height, imagePath = FREE_WATERMARK_PATH) {
  if (![width, height].every(value => Number.isInteger(value) && value >= 64)) throw new TypeError('Invalid watermark output size');
  const size = Math.min(width - 16, Math.max(24, Math.min(170, Math.round(width * 0.16))));
  return ['-i', path.resolve(imagePath), '-filter_complex',
    `[1:v]scale=${size}:-1,format=rgba,colorchannelmixer=aa=0.38[brand];[0:v][brand]overlay=x='(main_w-overlay_w)*(0.5+0.28*sin(2*PI*t/53-0.6))':y='(main_h-overlay_h)*(0.5+0.21*sin(2*PI*t/67+0.5))':eval=frame:format=auto,format=yuv420p[marked]`, '-map', '[marked]'];
}
