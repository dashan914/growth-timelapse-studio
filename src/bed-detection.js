// Local, conservative plane assistance. This estimates the outline of a large,
// relatively neutral print plate; it does not identify a printer or calibrate a
// camera. Image points follow rear-left, rear-right, front-right, front-left.
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const angleDistance = (a, b) => Math.min(Math.abs(a - b), Math.PI - Math.abs(a - b));

function imageData({ rgba, width, height }) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 24 || height < 24 || !rgba || rgba.length < width * height * 4) {
    throw new Error('请先导入清晰的实景照片，再识别打印底板。');
  }
  const scale = Math.min(1, 320 / Math.max(width, height));
  const w = Math.max(24, Math.round(width * scale)), h = Math.max(24, Math.round(height * scale));
  const luminance = new Float32Array(w * h), neutral = new Uint8Array(w * h);
  const lower = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const sx = Math.min(width - 1, Math.round((x + 0.5) * width / w - 0.5));
    const sy = Math.min(height - 1, Math.round((y + 0.5) * height / h - 0.5));
    const index = (sy * width + sx) * 4;
    const r = rgba[index], g = rgba[index + 1], b = rgba[index + 2];
    const value = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    luminance[y * w + x] = value;
    // Warm PEI plates and neutral plates. Strongly colored scenery is excluded.
    neutral[y * w + x] = rgba[index + 3] > 96 && r >= b * 0.9 && g >= b * 0.9 && Math.max(r, g, b) - Math.min(r, g, b) < Math.max(r, g, b) * 0.62 + 8 ? 1 : 0;
    if (y > h * 0.5 && neutral[y * w + x]) lower.push(value);
  }
  lower.sort((a, b) => a - b);
  const threshold = Math.max(45, (lower[Math.floor(lower.length * 0.6)] || 128) * 0.48);
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i++) mask[i] = neutral[i] && luminance[i] >= threshold ? 1 : 0;
  return { w, h, mask };
}

function closeMask(mask, w, h) {
  // Close tiny texture holes without bridging large separate structures.
  const dilated = new Uint8Array(mask.length), closed = new Uint8Array(mask.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let value = 0;
    for (let dy = -1; dy <= 1 && !value; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < w && ny < h && mask[ny * w + nx]) { value = 1; break; }
    }
    dilated[y * w + x] = value;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let value = 1;
    for (let dy = -1; dy <= 1 && value; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < w && ny < h && !dilated[ny * w + nx]) { value = 0; break; }
    }
    closed[y * w + x] = value;
  }
  return closed;
}

function plateRegion(mask, w, h) {
  const seen = new Uint8Array(mask.length), queue = new Int32Array(mask.length);
  let best = null, bestScore = 0;
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    let tail = 1, count = 0, lower = 0, center = 0;
    queue[0] = start; seen[start] = 1;
    for (let head = 0; head < tail; head++) {
      const index = queue[head], x = index % w, y = Math.floor(index / w);
      count++;
      if (y > h * 0.5) lower++;
      if (x > w * 0.2 && x < w * 0.8 && y > h * 0.5) center++;
      for (const next of [x > 0 ? index - 1 : -1, x < w - 1 ? index + 1 : -1, y > 0 ? index - w : -1, y < h - 1 ? index + w : -1]) {
        if (next >= 0 && mask[next] && !seen[next]) { seen[next] = 1; queue[tail++] = next; }
      }
    }
    const score = count * (0.4 + lower / count) + center;
    if (score > bestScore && lower > w * h * 0.07) {
      bestScore = score;
      best = Array.from(queue.slice(0, tail));
    }
  }
  if (!best || best.length < w * h * 0.12) return null;
  const region = new Uint8Array(mask.length);
  best.forEach(index => { region[index] = 1; });
  // Only the external outline participates. Printed texture or scuffs inside
  // the plate must not become guessed plate edges.
  const exterior = new Uint8Array(mask.length);
  let head = 0, tail = 0;
  for (let i = 0; i < mask.length; i++) {
    const x = i % w, y = Math.floor(i / w);
    if (!region[i] && (x === 0 || x === w - 1 || y === 0 || y === h - 1)) { exterior[i] = 1; queue[tail++] = i; }
  }
  while (head < tail) {
    const index = queue[head++], x = index % w, y = Math.floor(index / w);
    for (const next of [x > 0 ? index - 1 : -1, x < w - 1 ? index + 1 : -1, y > 0 ? index - w : -1, y < h - 1 ? index + w : -1]) {
      if (next >= 0 && !region[next] && !exterior[next]) { exterior[next] = 1; queue[tail++] = next; }
    }
  }
  const boundary = [];
  for (let y = 2; y < h - 2; y++) for (let x = 2; x < w - 2; x++) {
    const i = y * w + x;
    if (region[i] && (exterior[i - 1] || exterior[i + 1] || exterior[i - w] || exterior[i + w])) boundary.push({ x, y });
  }
  // Fill enclosed gaps for the polygon overlap score.
  for (let i = 0; i < region.length; i++) if (!exterior[i]) region[i] = 1;
  return { region, boundary, fraction: best.length / (w * h) };
}

function outlineLines(boundary, w, h) {
  const radius = Math.ceil(Math.hypot(w, h)), bins = radius * 2 + 1;
  const votes = new Uint16Array(180 * bins);
  const trig = Array.from({ length: 180 }, (_, angle) => [Math.cos(angle * Math.PI / 180), Math.sin(angle * Math.PI / 180)]);
  for (const point of boundary) for (let angle = 0; angle < 180; angle++) {
    const [nx, ny] = trig[angle], rho = Math.round(point.x * nx + point.y * ny);
    votes[angle * bins + rho + radius]++;
  }
  const peaks = [];
  for (let angle = 0; angle < 180; angle++) for (let rho = -radius; rho <= radius; rho++) {
    const count = votes[angle * bins + rho + radius];
    if (count >= Math.max(14, w * 0.055)) peaks.push({ angle, rho, count });
  }
  peaks.sort((a, b) => b.count - a.count);
  const lines = [];
  for (const peak of peaks) {
    const theta = peak.angle * Math.PI / 180;
    if (lines.some(line => angleDistance(line.theta, theta) < Math.PI * 5 / 180 && Math.abs(line.rho - peak.rho) < 6)) continue;
    const [nx, ny] = trig[peak.angle];
    const samples = boundary.filter(point => Math.abs(point.x * nx + point.y * ny - peak.rho) < 2);
    if (samples.length < w * 0.06) continue;
    const tangents = samples.map(point => -ny * point.x + nx * point.y).sort((a, b) => a - b);
    const start = tangents[Math.floor(tangents.length * 0.03)], end = tangents[Math.floor(tangents.length * 0.97)];
    const span = end - start;
    if (span < w * 0.09) continue;
    let direction = theta + Math.PI / 2;
    if (direction > Math.PI / 2) direction -= Math.PI;
    lines.push({ nx, ny, rho: peak.rho, theta, direction, span, count: samples.length, start, end });
    if (lines.length >= 32) break;
  }
  return lines;
}

function intersection(a, b) {
  const determinant = a.nx * b.ny - a.ny * b.nx;
  if (Math.abs(determinant) < 0.08) return null;
  return { x: (a.rho * b.ny - a.ny * b.rho) / determinant, y: (a.nx * b.rho - a.rho * b.nx) / determinant };
}

function inPolygon(x, y, points) {
  for (let i = 0; i < 4; i++) {
    const a = points[i], b = points[(i + 1) % 4];
    if ((b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x) < 0) return false;
  }
  return true;
}

function scorePolygon(points, lines, region, w, h) {
  if (points.some(point => !point || point.x < -w * 0.65 || point.x > w * 1.65 || point.y < h * 0.15 || point.y > h * 1.9)) return null;
  const [tl, tr, br, bl] = points;
  if (tr.x - tl.x < w * 0.2 || br.x - bl.x < w * 0.25 || tl.x > w * 0.65 || tr.x < w * 0.35 || Math.min(br.y - tr.y, bl.y - tl.y) < h * 0.1) return null;
  for (let i = 0; i < 4; i++) {
    const a = points[i], b = points[(i + 1) % 4], c = points[(i + 2) % 4];
    if ((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x) <= 0) return null;
  }
  let union = 0, overlap = 0, polygonSize = 0;
  for (let y = Math.floor(h * 0.2); y < h; y += 5) for (let x = 0; x < w; x += 5) {
    const inside = inPolygon(x, y, points), present = region[y * w + x] > 0;
    if (inside || present) union++;
    if (inside && present) overlap++;
    if (inside) polygonSize++;
  }
  const iou = overlap / Math.max(1, union), purity = overlap / Math.max(1, polygonSize);
  if (iou < 0.64 || purity < 0.8 || polygonSize < w * h / 25 * 0.13) return null;
  const edgeLengths = points.map((point, i) => Math.hypot(point.x - points[(i + 1) % 4].x, point.y - points[(i + 1) % 4].y));
  const coverage = lines.reduce((sum, line, i) => sum + Math.min(1, line.span / edgeLengths[i]), 0) / 4;
  const score = iou * 0.8 + coverage * 0.2;
  return { score, iou, purity, coverage };
}

function findPolygon(lines, region, w, h) {
  const horizontal = lines.filter(line => Math.abs(line.direction) <= Math.PI / 4 && Math.abs(line.ny) > 0.3 && line.span > w * 0.16);
  let best = null;
  for (const rear of horizontal) {
    const rearCenter = (rear.rho - rear.nx * w * 0.5) / rear.ny;
    if (rearCenter < h * 0.25 || rearCenter > h * 0.82) continue;
    for (const front of horizontal) {
      if (front === rear || angleDistance(front.theta, rear.theta) > Math.PI * 0.25) continue;
      const frontCenter = (front.rho - front.nx * w * 0.5) / front.ny;
      if (frontCenter - rearCenter < h * 0.13) continue;
      const sides = lines.filter(line => line !== rear && line !== front && angleDistance(line.theta, rear.theta) > Math.PI * 0.1 && angleDistance(line.theta, front.theta) > Math.PI * 0.08);
      const left = sides.filter(line => intersection(rear, line)?.x < w * 0.55).slice(0, 10);
      const right = sides.filter(line => intersection(rear, line)?.x > w * 0.35).slice(0, 10);
      for (const a of left) for (const b of right) {
        if (a === b) continue;
        const points = [intersection(rear, a), intersection(rear, b), intersection(front, b), intersection(front, a)];
        const score = scorePolygon(points, [rear, b, front, a], region, w, h);
        if (score && (!best || score.score > best.score)) best = { points, ...score };
      }
    }
  }
  return best;
}

/**
 * Propose normalized four-corner print-bed points from ImageData-like pixels.
 * A returned polygon ALWAYS requires human review. An absent/cropped border is
 * never silently treated as a measured corner: extrapolation is flagged and
 * confidence capped. `points: null` requests manual four-corner placement.
 */
export function detectBedCandidate(input = {}) {
  const { w, h, mask } = imageData(input);
  const plate = plateRegion(closeMask(mask, w, h), w, h);
  const empty = {
    points: null, confidence: 0, warnings: ['没有找到足够清晰的底板边缘，请手动拖动四角与照片中的底板对齐。'],
    cropped: false, needsReview: true, method: 'local-edges', diagnostics: { analysisWidth: w, analysisHeight: h },
  };
  if (!plate || plate.boundary.length < 40) return empty;
  const lines = outlineLines(plate.boundary, w, h);
  const polygon = findPolygon(lines, plate.region, w, h);
  if (!polygon) return { ...empty, diagnostics: { ...empty.diagnostics, lineCount: lines.length } };
  const points = polygon.points.map(point => ({ x: point.x / w, y: point.y / h }));
  const croppedCorners = points.map((point, i) => point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1 ? i : -1).filter(i => i >= 0);
  const cropped = croppedCorners.length > 0;
  let confidence = clamp((polygon.iou - 0.64) / 0.36 * 0.68 + polygon.coverage * 0.26, 0, 0.94);
  if (cropped) confidence = Math.min(confidence, 0.56);
  const warnings = [cropped ? '底板有角落超出照片，虚线角点为边缘延长后的估计位置。请手动核对，或使用拍全底板的照片。' : '已找到底板候选边缘。请拖动四角核对后再应用透视。'];
  if (confidence < 0.6) warnings.push('当前识别把握较低，建议按底板直边手动微调。');
  return {
    points, confidence, warnings, cropped, croppedCorners, needsReview: true, method: 'local-edges',
    diagnostics: { analysisWidth: w, analysisHeight: h, lineCount: lines.length, overlap: polygon.iou, edgeCoverage: polygon.coverage },
  };
}
