import { abortableExportDelay } from './realistic-export.js';

const aborted = () => new DOMException('Aborted', 'AbortError');
const validId = id => typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id);

/** One current-frame Cycles image. Obsolete work is cancelled before its
 * replacement is submitted; an old image can never cover a new pose. */
export class RealisticPreviewRenderer {
  constructor({ image, prepare, request, readImage, onState = () => {}, debounceMs = 700,
    intervalMs = 500, createURL = blob => URL.createObjectURL(blob), revokeURL = url => URL.revokeObjectURL(url) } = {}) {
    if (!image || typeof prepare !== 'function' || typeof request !== 'function' || typeof readImage !== 'function') throw new Error('写实预览需要画面及本机渲染服务。');
    Object.assign(this, { image, prepare, request, readImage, onState, debounceMs, intervalMs, createURL, revokeURL });
    this._generation = 0;
    this._work = Promise.resolve();
    image.hidden = true;
  }

  update({ enabled, key = '', width, height, progress = 1 } = {}) {
    if (this._disposed) return;
    if (!enabled) {
      if (this._desired?.enabled) this._cancel();
      this._desired = { enabled: false };
      this.image.hidden = true;
      this._state('disabled');
      return;
    }
    if (!Number.isFinite(progress) || progress < 0 || progress > 1 || !Number.isInteger(width) || !Number.isInteger(height) || width < 64 || height < 64) throw new Error('当前写实预览画面无效。');
    const fullKey = `${key}|${width}x${height}|${progress}`;
    if (this._desired?.enabled && this._desired.key === fullKey) return;
    this._cancel();
    this._desired = { enabled: true, key: fullKey, width, height, progress };
    if (this._cache?.key === fullKey) {
      this.image.src = this._cache.url;
      this.image.hidden = false;
      this._state('complete');
      return;
    }
    this.image.hidden = true;
    const generation = this._generation;
    this._state('waiting');
    this._timer = setTimeout(() => {
      this._timer = null;
      this._work = this._work.catch(() => {}).then(() => this._render(generation, { ...this._desired }));
    }, this.debounceMs);
  }

  _current(generation) { return !this._disposed && generation === this._generation && this._desired?.enabled; }
  _state(status, error = null) { if (!this._disposed) this.onState({ status, error }); }
  _cancel() {
    this._generation++;
    clearTimeout(this._timer);
    this._timer = null;
    this._pending?.controller.abort();
  }

  async _render(generation, desired) {
    if (!this._current(generation)) return;
    const pending = { controller: new AbortController(), id: null };
    this._pending = pending;
    const signal = pending.controller.signal;
    let url;
    const check = () => { if (signal.aborted || !this._current(generation)) throw aborted(); };
    try {
      this._state('preparing');
      const prepared = await this.prepare(desired);
      check();
      // Receive the ID even when the user changes the scene during submission,
      // so that every native job can be stopped and cleaned up.
      const job = await this.request('/api/realistic-previews', { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: prepared.blob });
      if (!validId(job.id)) throw new Error('写实预览任务编号无效。');
      pending.id = job.id;
      check();
      const route = `/api/realistic-previews/${job.id}`;
      let snapshot;
      while (true) {
        snapshot = await this.request(route, { signal });
        check();
        if (snapshot.id !== job.id || !['queued', 'rendering', 'encoding', 'complete', 'cancelled', 'error'].includes(snapshot.status)) throw new Error('写实预览状态无效。');
        if (snapshot.status === 'error') throw new Error(snapshot.failure || '写实预览计算失败。');
        if (snapshot.status === 'cancelled') throw aborted();
        if (snapshot.status === 'complete') break;
        this._state(snapshot.status === 'queued' ? 'queued' : 'rendering');
        await abortableExportDelay(this.intervalMs, signal);
      }
      if (snapshot.total !== 1 || snapshot.rendered !== 1 || snapshot.encoded !== 1 || snapshot.url !== `${route}/file`) throw new Error('写实预览画面校验失败。');
      const blob = await this.readImage(snapshot.url, { signal });
      check();
      url = this.createURL(blob);
      this.image.src = url;
      await this.image.decode();
      check();
      if (this._cache) this.revokeURL(this._cache.url);
      this._cache = { key: desired.key, url };
      url = null;
      this.image.hidden = false;
      this._state('complete');
    } catch (error) {
      if (this._current(generation) && error.name !== 'AbortError') {
        this.image.hidden = true;
        this._state('error', error);
      }
    } finally {
      if (url) this.revokeURL(url);
      if (pending.id) await this.request(`/api/realistic-previews/${pending.id}`, { method: 'DELETE' }).catch(() => {});
      if (this._pending === pending) this._pending = null;
    }
  }

  dispose() {
    this._cancel();
    this._disposed = true;
    this.image.hidden = true;
    if (this._cache) this.revokeURL(this._cache.url);
    this._cache = null;
    return this._work;
  }
}
