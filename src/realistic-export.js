const abortError = () => new DOMException('Aborted', 'AbortError');

export function realisticExportAvailability({ runtime = null, metadata = null, backgroundType = null, appearance = 'model', showSupports = false, supportDisplay = 'solid', frames = 0 } = {}) {
  if (!runtime) return { available: false, reason: '正在检查本机写实画质…' };
  if (!runtime.available) return { available: false, reason: '本机写实画质尚未准备好，当前使用实时画质。' };
  if (metadata?.mode === 'gcode') return { available: false, reason: '打印路径使用实时画质，可保留真实挤出细节。' };
  if (backgroundType === 'video') return { available: false, reason: '背景视频使用实时画质；写实画质支持静态照片。' };
  if (appearance === 'photo') return { available: false, reason: '成品照片融合使用实时导出，直接保留实拍外观。' };
  if (showSupports && metadata?.supportSource === 'sliced-gcode-indexed' && metadata?.supportSegments > 0) return { available: false, reason: '完整支撑使用实时画质；关闭“显示支撑”可选写实画质。' };
  if (showSupports && metadata?.supportsAvailable && supportDisplay === 'paths') return { available: false, reason: '支撑路径使用实时画质，或切换为实体支撑。' };
  const limits = runtime.limits || {};
  const triangles = (metadata?.triangles || 0) + (showSupports ? metadata?.supportSurfaceTriangles || 0 : 0);
  const objects = (metadata?.meshes || 0) + (showSupports && metadata?.supportSource === 'sliced-gcode' ? metadata.supportSegments || 0 : 0);
  if (triangles > (limits.maxTriangles || 5000000) || objects > (limits.maxObjects || 4096)) return { available: false, reason: '模型或支撑规模较大，实时画质保留全部细节；不会减面。' };
  if (frames > (limits.maxFrames || 1800)) return { available: false, reason: '当前用时或帧率超过写实范围，实时画质可导出完整时长。' };
  return { available: true, reason: '' };
}

/** The same sampled timeline as realtime export. Hold begins on the first
 * frame at or beyond its exact growth endpoint; no duration is rounded away. */
export function realisticFramePlan({ duration, growth, hold = 0, fps }) {
  if (![duration, growth, hold, fps].every(Number.isFinite) || duration <= 0 || growth <= 0 || growth > duration || hold < 0 || fps < 1) throw new Error('生长用时、停留和帧率无效。');
  const frames = Math.max(1, Math.round(duration * fps));
  const growthFrames = Math.min(frames, Math.max(1, Math.ceil((frames - 1) * growth / duration - 1e-10) + 1));
  return { frames, growthFrames, durationSeconds: duration, growthSeconds: growth };
}

export function realisticProgress(snapshot) {
  const total = Number(snapshot.total) || 0, encoded = Math.max(0, Math.min(total, Number(snapshot.encoded) || 0));
  const percent = snapshot.status === 'complete' ? 100 : Math.min(98, total ? Math.round(encoded / total * 95) : 0);
  const messages = {
    queued: '等待前一个写实任务完成…',
    rendering: '正在计算光影并生成画面，完整保留模型细节…',
    encoding: '画面已完成，正在保存文件…',
    complete: '写实延时已生成，可以下载。',
    cancelled: '已取消导出，可以继续调整。',
    error: snapshot.failure || '写实导出未完成，请改用实时画质重试。',
  };
  return { percent, encoded, total, detail: messages[snapshot.status] || '准备写实画面…' };
}

export function abortableExportDelay(milliseconds, signal) {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener('abort', abort);
    const timer = setTimeout(() => { cleanup(); resolve(); }, milliseconds);
    const abort = () => { clearTimeout(timer); cleanup(); reject(abortError()); };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export async function waitForRealisticExport({ id, request, signal, onSnapshot = () => {}, intervalMs = 500 }) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('写实任务编号无效。');
  const delay = Math.max(25, Math.min(1000, Number(intervalMs) || 500));
  while (true) {
    if (signal?.aborted) throw abortError();
    const snapshot = await request(`/api/realistic-exports/${id}`, { signal });
    if (signal?.aborted) throw abortError();
    if (snapshot.id !== id || !['queued', 'rendering', 'encoding', 'complete', 'cancelled', 'error'].includes(snapshot.status)) throw new Error('写实任务状态无效。');
    onSnapshot(snapshot);
    if (['complete', 'cancelled', 'error'].includes(snapshot.status)) return snapshot;
    await abortableExportDelay(delay, signal);
  }
}

export function realisticDownloadResult(result, id) {
  if (result?.status !== 'complete' || result.id !== id || result.rendered !== result.total || result.encoded !== result.total || !Number.isInteger(result.total) || result.total < 1 || !Number.isFinite(result.bytes) || result.bytes < 1 || typeof result.filename !== 'string' || result.url !== `/api/realistic-exports/${id}/file`) throw new Error('完成文件校验未通过，请重新导出。');
  return { url: result.url, filename: result.filename, bytes: result.bytes };
}
