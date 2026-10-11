import { access, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { pythonCandidates, resolveExecutablePath } from './runtime-paths.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(ROOT, 'scripts', 'calibration-uprights.py');
const execFileAsync = promisify(execFile);
export const PHOTO_CALIBRATION_MAX_BYTES = 24 * 1024 * 1024;
const MAX_PIXELS = 24_000_000;
const MAX_EDGE = 12_000;
const MAX_OUTPUT = 64 * 1024;
const METHOD = 'OpenCV LSD + collinear grouping';

export class PhotoCalibrationError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const fail = (status, code, message) => new PhotoCalibrationError(status, code, message);

/** Inspect declared dimensions before allowing native image decoding. */
export function validateCalibrationImage(buffer, mimeType) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) throw fail(400, 'INVALID_IMAGE', '请上传有效的 JPEG 或 PNG 照片。');
  if (buffer.length > PHOTO_CALIBRATION_MAX_BYTES) throw fail(413, 'IMAGE_TOO_LARGE', '照片不能超过 24 MB。');
  const type = typeof mimeType === 'string' ? mimeType.split(';', 1)[0].trim().toLowerCase() : '';
  if (!['image/jpeg', 'image/png'].includes(type)) throw fail(415, 'UNSUPPORTED_IMAGE', '竖线建议仅支持 JPEG 或 PNG 照片。');
  let width, height;
  if (type === 'image/png') {
    const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    if (!buffer.subarray(0, 8).equals(signature) || buffer.readUInt32BE(8) !== 13 || buffer.toString('ascii', 12, 16) !== 'IHDR') throw fail(400, 'INVALID_IMAGE', 'PNG 照片格式无效。');
    width = buffer.readUInt32BE(16); height = buffer.readUInt32BE(20);
  } else {
    if (buffer[0] !== 255 || buffer[1] !== 216) throw fail(400, 'INVALID_IMAGE', 'JPEG 照片格式无效。');
    let offset = 2;
    while (offset < buffer.length) {
      if (buffer[offset++] !== 255) break;
      while (offset < buffer.length && buffer[offset] === 255) offset++;
      const marker = buffer[offset++];
      if (marker === 0xD9 || marker === 0xDA) break;
      if (marker === 0x01 || marker >= 0xD0 && marker <= 0xD8) continue;
      if (offset + 2 > buffer.length) break;
      const size = buffer.readUInt16BE(offset);
      if (size < 2 || offset + size > buffer.length) break;
      if ([0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF].includes(marker)) {
        if (size < 8) break;
        height = buffer.readUInt16BE(offset + 3); width = buffer.readUInt16BE(offset + 5); break;
      }
      offset += size;
    }
  }
  if (![width, height].every(value => Number.isInteger(value) && value >= 16)) throw fail(400, 'INVALID_IMAGE', '照片尺寸或格式无效。');
  if (Math.max(width, height) > MAX_EDGE || width * height > MAX_PIXELS) throw fail(413, 'IMAGE_DIMENSIONS_TOO_LARGE', '照片像素过大，请使用不超过 2400 万像素的照片。');
  return { width, height, mimeType: type };
}

export function validateUprightSuggestion(result, dimensions) {
  if (!result || !['suggested', 'low'].includes(result.confidence) || !Array.isArray(result.lines) || result.lines.length > 2 || result.method !== METHOD || typeof result.version !== 'string' || !/^\d+\.\d+(?:\.\d+)?$/.test(result.version)) throw fail(502, 'INVALID_DETECTION_RESULT', '竖线检测结果无效，请手动标记。');
  if (result.imageSize?.width !== dimensions.width || result.imageSize?.height !== dimensions.height) throw fail(502, 'INVALID_DETECTION_RESULT', '照片解码尺寸不一致，请重新保存照片后重试。');
  const lines = result.lines.map(line => {
    if (line?.weight !== 100 || [line.a?.x, line.a?.y, line.b?.x, line.b?.y].some(value => !Number.isFinite(value) || value < 0 || value > 1)) throw fail(502, 'INVALID_DETECTION_RESULT', '竖线检测坐标无效，请手动标记。');
    if (Math.hypot((line.a.x - line.b.x) * dimensions.width, (line.a.y - line.b.y) * dimensions.height) < Math.min(dimensions.width, dimensions.height) * .1) throw fail(502, 'INVALID_DETECTION_RESULT', '检测的竖线太短，请手动标记。');
    return { a: { x: line.a.x, y: line.a.y }, b: { x: line.b.x, y: line.b.y }, weight: 100 };
  });
  if (result.confidence === 'suggested' && lines.length !== 2) throw fail(502, 'INVALID_DETECTION_RESULT', '没有足够的竖线，请手动标记。');
  return { lines, confidence: result.confidence,
    warnings: lines.length === 2 ? ['检测到的是照片线段候选，请确认它们确实是实景中竖直的立柱或导杆，再用于对齐。'] : ['没有找到足够清晰且相隔较远的两条竖线，请手动标记。'],
    method: METHOD, version: result.version, imageSize: { width: dimensions.width, height: dimensions.height } };
}

function pythonEnvironment(runtime, env = process.env) {
  const configured = { ...env, PYTHONSAFEPATH: '1', PYTHONUNBUFFERED: '1', OMP_NUM_THREADS: '1', OPENBLAS_NUM_THREADS: '1' };
  if (runtime.directory) {
    configured.PYTHONPATH = runtime.directory;
    configured.PYTHONNOUSERSITE = '1';
  }
  return configured;
}

/** Optional OpenCV lives in the user's Python environment, not in the release. */
export async function resolvePhotoCalibrationRuntime({ root = ROOT, env = process.env, platform = process.platform, execute = execFileAsync } = {}) {
  try { await access(path.join(root, 'scripts/calibration-uprights.py'), constants.R_OK); }
  catch { return null; }
  const override = typeof env.PHOTO_CALIBRATION_PYTHON === 'string' ? env.PHOTO_CALIBRATION_PYTHON.trim() : '';
  const candidates = override ? [override] : pythonCandidates({ env, platform });
  const pythons = [...new Set(candidates.map(candidate => resolveExecutablePath(candidate, { env, platform })).filter(Boolean))];
  const libraryOverride = typeof env.OPENCV_PYTHONPATH === 'string' ? env.OPENCV_PYTHONPATH.trim() : '';
  const directories = libraryOverride ? [libraryOverride] : [null];
  if (!libraryOverride) {
    const legacy = path.join(root, 'research/runtime/opencv');
    try {
      await Promise.all([access(path.join(legacy, 'cv2/__init__.py')), access(path.join(legacy, 'numpy/__init__.py'))]);
      directories.push(legacy);
    } catch {}
  }
  const deadline = Date.now() + 8_000;
  for (const directory of directories) for (const python of pythons) {
    const remaining = deadline - Date.now();
    if (remaining < 1) return null;
    try {
      const { stdout } = await execute(python, ['-c', 'import json, cv2, numpy; print(json.dumps({"version": cv2.__version__}))'], {
        cwd: root, env: pythonEnvironment({ directory }, env), shell: false, windowsHide: true,
        timeout: Math.min(3_000, remaining), maxBuffer: MAX_OUTPUT,
      });
      const result = JSON.parse(stdout);
      if (typeof result.version === 'string' && /^\d+\.\d+(?:\.\d+)?$/.test(result.version)) return { python, directory, version: result.version };
    } catch {}
  }
  return null;
}

let runtimePromise, runtimeTime = 0;
function resolveRuntime() {
  if (!runtimePromise || Date.now() - runtimeTime > 30_000) {
    runtimeTime = Date.now();
    runtimePromise = resolvePhotoCalibrationRuntime();
  }
  return runtimePromise;
}

// Dependency injection is an internal test seam; it is never populated from an
// HTTP request. Script path and arguments are fixed; spawn never uses a shell.
export function createPhotoCalibrationService({ findRuntime = resolveRuntime, spawnProcess = spawn, temporaryRoot = tmpdir() } = {}) {
  let active = 0;
  async function capability() {
    const installed = await findRuntime();
    return { available: Boolean(installed), method: METHOD, version: installed?.version || null,
      warning: installed ? '检测结果需要在照片中确认。' : '本地视觉组件不可用，可以手动标记照片竖线。' };
  }
  async function detect(buffer, { mimeType, timeoutMs = 18_000 } = {}) {
    const dimensions = validateCalibrationImage(buffer, mimeType);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw fail(400, 'INVALID_TIMEOUT', '竖线检测等待时间无效。');
    if (active >= 2) throw fail(429, 'DETECTION_BUSY', '竖线检测正在运行，请稍后重试。');
    active++;
    let directory;
    try {
      const runtime = await findRuntime();
      if (!runtime) throw fail(503, 'CALIBRATION_UNAVAILABLE', '本地视觉组件不可用，请手动标记照片竖线。');
      directory = await mkdtemp(path.join(temporaryRoot, 'growth-uprights-'));
      const filename = path.join(directory, dimensions.mimeType === 'image/png' ? 'photo.png' : 'photo.jpg');
      await writeFile(filename, buffer, { flag: 'wx', mode: 0o600 });
      const output = await new Promise((resolve, reject) => {
        let child, timer, stdout = '', bytes = 0, stderrBytes = 0, error, settled = false;
        const finish = failure => {
          if (settled) return;
          settled = true; clearTimeout(timer);
          failure ? reject(failure) : resolve(stdout);
        };
        const stop = failure => { error = failure; child?.kill('SIGKILL'); };
        try {
          child = spawnProcess(runtime.python, [SCRIPT, filename], { shell: false, cwd: ROOT,
            env: pythonEnvironment(runtime),
            stdio: ['ignore', 'pipe', 'pipe'] });
        } catch { finish(fail(503, 'CALIBRATION_UNAVAILABLE', '本地视觉组件无法启动，请手动标记。')); return; }
        timer = setTimeout(() => stop(fail(504, 'DETECTION_TIMEOUT', '竖线检测超时，请重试或手动标记。')), timeoutMs);
        child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > MAX_OUTPUT) stop(fail(502, 'INVALID_DETECTION_RESULT', '竖线检测结果过大，请手动标记。')); else stdout += chunk.toString('utf8'); });
        child.stderr.on('data', chunk => { stderrBytes += chunk.length; if (stderrBytes > MAX_OUTPUT) stop(fail(502, 'DETECTION_FAILED', '竖线检测失败，请手动标记。')); });
        child.once('error', () => finish(fail(503, 'CALIBRATION_UNAVAILABLE', '本地视觉组件无法启动，请手动标记。')));
        child.once('close', code => finish(error || (code === 0 ? null : fail(422, 'DETECTION_FAILED', '照片无法检测，请使用清晰的 JPEG 或 PNG 照片，或手动标记。'))));
      });
      let parsed;
      try { parsed = JSON.parse(output); } catch { throw fail(502, 'INVALID_DETECTION_RESULT', '竖线检测结果无效，请手动标记。'); }
      return validateUprightSuggestion(parsed, dimensions);
    } finally {
      try { if (directory) await rm(directory, { recursive: true, force: true }); }
      finally { active--; }
    }
  }
  return { detect, capability };
}

const localService = createPhotoCalibrationService();
export const detectPhotoUprights = (buffer, options) => localService.detect(buffer, options);
export const photoCalibrationCapability = () => localService.capability();
