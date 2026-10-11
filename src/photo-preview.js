import { composePhotoReveal } from './photo-reveal.js';

/**
 * Small real-photo preview overlay. `prepare(width,height)` supplies the same
 * {state,...} as export preparation, without calling startExport. `key` passed
 * to update must include the photo files, model pose, camera, and crop. Playback
 * progress is deliberately excluded so playback never restarts preparation.
 * renderBase(progress,{afterPrepare}) must supply the current clipped 3D frame;
 * return its canvas, or leave it undefined to read studio.canvas. It is called
 * again with afterPrepare:true after asynchronous preparation because a height pass may
 * have replaced the WebGL buffer. The helper never changes a camera or pose.
 */
export class PhotoPreviewRenderer {
  constructor({ canvas, studio, prepare, renderBase, onError, debounceMs = 200, maxDimension = 640 } = {}) {
    if (!canvas || typeof prepare !== 'function') throw new Error('实拍预览需要画布及照片准备函数。');
    this.canvas = canvas;
    this.studio = studio;
    this.prepare = prepare;
    this.renderBase = renderBase ?? (progress => { studio?.render(progress); return studio?.canvas; });
    this.onError = onError;
    this.debounceMs = Math.max(0, Number(debounceMs) || 0);
    this.maxDimension = Math.max(8, Math.min(640, Number(maxDimension) || 640));
    this._generation = 0;
    this._timer = null;
    this._pending = null;
    this._cache = null;
    this._failedKey = null;
    this._desired = null;
    this._out = null;
    this._context = canvas.getContext('2d', { willReadFrequently: true });
    if (!this._context) throw new Error('无法创建实拍预览画布。');
    canvas.hidden = true;
  }

  get ready() { return Boolean(!this._disposed && this._desired?.enabled && this._cache?.key === this._desired.key && !this.canvas.hidden); }

  update({ enabled, key = '', width, height, progress = 0 } = {}) {
    if (this._disposed) return false;
    if (!enabled || !Number.isFinite(width) || !Number.isFinite(height) || width < 8 || height < 8) {
      this._desired = { enabled: false };
      this._cancelPending();
      this.canvas.hidden = true;
      return false;
    }
    const scale = Math.min(1, this.maxDimension / width, this.maxDimension / height);
    width = Math.max(8, Math.round(width * scale)); height = Math.max(8, Math.round(height * scale));
    const cacheKey = `${String(key)}|${width}x${height}`;
    this._desired = { enabled: true, key: cacheKey, sourceKey: key, width, height, progress };
    if (this._cache?.key === cacheKey) {
      try { this.draw(this._cache.prepared, progress); return true; }
      catch (error) { this._fail(error, cacheKey); return false; }
    }
    // Hide a stale pose rather than leave the old photograph attached to a
    // newly moved model while its replacement height map is being prepared.
    this.canvas.hidden = true;
    if (this._failedKey === cacheKey || this._pending?.key === cacheKey || this._timer?.key === cacheKey) return false;
    this._cancelPending();
    const generation = this._generation;
    const timer = { key: cacheKey, generation, id: null };
    timer.id = setTimeout(() => this._prepare(generation, cacheKey, width, height, key), this.debounceMs);
    this._timer = timer;
    return false;
  }

  async _prepare(generation, key, width, height, sourceKey) {
    if (this._disposed || generation !== this._generation || this._desired?.key !== key) return;
    this._timer = null;
    this._pending = { generation, key };
    try {
      const prepared = await this.prepare(width, height, { key: sourceKey });
      if (this._disposed || generation !== this._generation || !this._desired?.enabled || this._desired.key !== key) return;
      const state = prepared?.state ?? prepared;
      if (state?.width !== width || state?.height !== height) throw new Error('实拍预览的照片与高度图尺寸不一致。');
      this._cache = { key, prepared };
      this._failedKey = null;
      this.draw(prepared, this._desired.progress, { afterPrepare: true });
    } catch (error) {
      if (!this._disposed && generation === this._generation && this._desired?.key === key) this._fail(error, key);
    } finally {
      if (this._pending?.generation === generation) this._pending = null;
    }
  }

  draw(prepared, progress, { afterPrepare = false } = {}) {
    const state = prepared?.state ?? prepared;
    if (!state?.width || !state?.height) throw new Error('实拍生长预览尚未准备好。');
    const { width, height } = state;
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
    const source = this.renderBase(progress, { afterPrepare }) ?? this.studio?.canvas;
    if (!source || typeof source.then === 'function') throw new Error('模型预览尚未准备好，实时预览需要同步渲染画面。');
    this._context.clearRect(0, 0, width, height);
    this._context.drawImage(source, 0, 0, width, height);
    const baseRGBA = this._context.getImageData(0, 0, width, height).data;
    if (this._out?.length !== width * height * 4) this._out = new Uint8ClampedArray(width * height * 4);
    composePhotoReveal({ state, progress, baseRGBA, out: this._out });
    this._context.putImageData(new ImageData(this._out, width, height), 0, 0);
    this.canvas.hidden = false;
    return this.canvas;
  }

  _fail(error, key) {
    this.canvas.hidden = true;
    this._cache = null;
    if (this._failedKey === key) return;
    this._failedKey = key;
    if (this.onError) this.onError(error instanceof Error ? error : new Error(String(error)));
  }

  _cancelPending() {
    this._generation++;
    if (this._timer) clearTimeout(this._timer.id);
    this._timer = null;
    this._pending = null;
  }

  invalidate() {
    this._cancelPending();
    this._cache = null;
    this._failedKey = null;
    this.canvas.hidden = true;
  }

  dispose() {
    this.invalidate();
    this._disposed = true;
    this._desired = null;
    this._out = null;
  }
}

export const createPhotoPreview = options => new PhotoPreviewRenderer(options);
