export function timelineState(time, duration, hold, motion = 'fixed') {
  const safeDuration = Math.max(0.001, duration);
  const t = Math.min(Math.max(time, 0), safeDuration);
  const growthDuration = Math.max(0.001, safeDuration - Math.min(hold, safeDuration - 0.001));
  return {
    progress: Math.min(1, t / growthDuration),
    rotation: (motion === 'turntable' ? Math.PI * 2 : motion === 'half' ? Math.PI : 0) * t / safeDuration,
  };
}

export function outputSize(ratio, resolution) {
  const maxAxis = 4096, maxPixels = 8388608;
  const requested = Number(resolution);
  const shortSide = Math.min(maxAxis, Math.max(2, Number.isFinite(requested) && requested > 0 ? requested : 1080));
  const values = String(ratio).split(':').map(Number);
  const requestedAspect = values.length === 2 && values.every(value => Number.isFinite(value) && value > 0) ? values[0] / values[1] : 16 / 9;
  const aspect = Math.min(maxAxis / 2, Math.max(2 / maxAxis, requestedAspect));
  let width = aspect >= 1 ? shortSide * aspect : shortSide;
  let height = aspect >= 1 ? shortSide : shortSide / aspect;
  const scale = Math.min(1, maxAxis / Math.max(width, height), Math.sqrt(maxPixels / (width * height)));
  width *= scale; height *= scale;
  const evenCandidates = value => [...new Set([Math.floor(value / 2) * 2, Math.ceil(value / 2) * 2].map(number => Math.max(2, Math.min(maxAxis, number))))];
  let best, bestError = Infinity;
  for (const w of evenCandidates(width)) for (const h of evenCandidates(height)) {
    if (w * h > maxPixels) continue;
    const error = 2 * Math.abs(Math.log(w / h / aspect)) + Math.abs(Math.log(w / width)) + Math.abs(Math.log(h / height));
    if (error < bestError) { best = { width: w, height: h }; bestError = error; }
  }
  return best;
}
