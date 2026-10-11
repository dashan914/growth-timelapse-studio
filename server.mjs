import http from 'node:http';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createGzip } from 'node:zlib';
import { createSupportManager, SUPPORT_SLICER } from './support-jobs.mjs';
import { detectPhotoUprights, photoCalibrationCapability, PHOTO_CALIBRATION_MAX_BYTES } from './photo-calibration.mjs';
import { createRealisticRenderService, REALISTIC_RENDER_LIMITS } from './realistic-render.mjs';
import { createSliceService, validateSliceOptions } from './slice-jobs.mjs';
import { movAlphaEncoderArguments, probeMovAlphaEncoder } from './export-codecs.mjs';
import { findFFmpegPath, findPythonPath } from './runtime-paths.mjs';

const execFileAsync = promisify(execFile);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const FINISH_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_PNG_BYTES = 40 * 1024 * 1024;
const MAX_BACKGROUND_BYTES = 512 * 1024 * 1024;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.zip': 'application/zip',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.stl': 'model/stl',
  '.obj': 'text/plain; charset=utf-8', '.mtl': 'text/plain; charset=utf-8',
  '.bin': 'application/octet-stream', '.wasm': 'application/wasm',
  '.woff': 'font/woff', '.woff2': 'font/woff2',
};

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function json(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

function errorResponse(response, error) {
  if (response.destroyed || response.writableEnded) return;
  if (response.headersSent) { response.destroy(); return; }
  json(response, error.status || 500, {
    error: { code: error.code || 'INTERNAL_ERROR', message: error.status ? error.message : '服务器内部错误，请重试。' },
  });
}

function safeName(value) {
  if (value !== undefined && typeof value !== 'string') throw new ApiError(400, 'INVALID_NAME', '视频名称必须是文字。');
  return (value || '模型生长').replace(/\.(mp4|mov|zip)$/i, '').normalize('NFC')
    .replace(/[\x00-\x1f\x7f<>:"/\\|?*]/g, '-').replace(/\s+/g, ' ').trim()
    .replace(/^[. ]+|[. ]+$/g, '').slice(0, 80) || 'model-growth';
}

function validateExport(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new ApiError(400, 'INVALID_OPTIONS', '请提供视频导出设置。');
  const { width, height, fps, frames } = options;
  const format = options.format || 'mp4';
  if (!['mp4', 'mov-alpha', 'png-sequence'].includes(format)) throw new ApiError(400, 'INVALID_FORMAT', '导出格式须为 mp4、mov-alpha 或 png-sequence。');
  if (![width, height].every(value => Number.isInteger(value) && value >= 64 && value <= 4096 && value % 2 === 0)
      || width * height > 8_388_608) {
    throw new ApiError(400, 'INVALID_SIZE', '宽高须为 64–4096 之间的偶数，总像素不能超过 8388608。');
  }
  if (!Number.isInteger(fps) || fps < 1 || fps > 60) throw new ApiError(400, 'INVALID_FPS', '帧率须为 1–60 之间的整数。');
  if (!Number.isInteger(frames) || frames < 1 || frames > 72000) throw new ApiError(400, 'INVALID_FRAMES', '总帧数须为 1–72000 之间的整数。');
  return { width, height, fps, frames, format, name: safeName(options.name) };
}

async function readBody(request, maximum) {
  const declared = request.headers['content-length'];
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > maximum)) {
    request.resume();
    throw new ApiError(413, 'BODY_TOO_LARGE', '上传内容超过大小限制。');
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    const cleanup = () => {
      request.off('data', onData);
      request.off('end', onEnd);
      request.off('aborted', onAbort);
      request.off('error', onAbort);
    };
    const onData = chunk => {
      length += chunk.length;
      if (length > maximum) {
        // Drain oversized chunked bodies while preserving the connection for a JSON error.
        cleanup();
        request.resume();
        reject(new ApiError(413, 'BODY_TOO_LARGE', '上传内容超过大小限制。'));
      } else chunks.push(chunk);
    };
    const onEnd = () => { cleanup(); resolve(Buffer.concat(chunks, length)); };
    const onAbort = () => { cleanup(); reject(new ApiError(400, 'INCOMPLETE_UPLOAD', '上传中断，请重试这一帧。')); };
    request.on('data', onData);
    request.once('end', onEnd);
    request.once('aborted', onAbort);
    request.once('error', onAbort);
  });
}

async function readJson(request) {
  if (!(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
    request.resume();
    throw new ApiError(415, 'INVALID_CONTENT_TYPE', '请求须使用 application/json。');
  }
  const body = await readBody(request, 16 * 1024);
  try { return JSON.parse(body.toString('utf8')); }
  catch { throw new ApiError(400, 'INVALID_JSON', '导出设置不是有效的 JSON。'); }
}

/** Stream a large source video to disk without retaining it in server memory. */
function receiveBackground(request, filename, job) {
  const declared = request.headers['content-length'];
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > MAX_BACKGROUND_BYTES)) {
    request.resume();
    return Promise.reject(new ApiError(413, 'BODY_TOO_LARGE', '实景视频不能超过 512 MB。'));
  }
  return new Promise((resolve, reject) => {
    const output = createWriteStream(filename, { flags: 'wx', mode: 0o600 });
    let bytes = 0;
    let failure;
    let finished = false;
    const cleanup = () => {
      request.off('data', onData);
      request.off('end', onEnd);
      request.off('aborted', onAbort);
      request.off('error', onAbort);
      output.off('drain', onDrain);
      job.abortBackgroundUpload = null;
    };
    const fail = error => {
      if (failure || finished) return;
      failure = error;
      cleanup();
      request.resume();
      output.destroy();
    };
    const onDrain = () => { if (!failure) request.resume(); };
    const onData = chunk => {
      bytes += chunk.length;
      job.touchedAt = Date.now();
      if (bytes > MAX_BACKGROUND_BYTES) {
        fail(new ApiError(413, 'BODY_TOO_LARGE', '实景视频不能超过 512 MB。'));
      } else if (!output.write(chunk)) request.pause();
    };
    const onEnd = () => {
      if (!bytes) { fail(new ApiError(400, 'EMPTY_BACKGROUND', '实景视频为空，请重新选择文件。')); return; }
      output.end();
    };
    const onAbort = () => fail(new ApiError(400, 'INCOMPLETE_UPLOAD', '实景视频上传中断，请重试。'));
    job.abortBackgroundUpload = () => fail(new ApiError(409, 'EXPORT_NOT_ACTIVE', job.failure || '导出已取消。'));
    output.once('error', error => fail(error));
    output.once('finish', () => { finished = true; cleanup(); });
    // Wait for the file descriptor to close before allowing cancellation to remove it.
    output.once('close', () => {
      cleanup();
      if (failure) reject(failure);
      else if (finished) resolve(bytes);
      else reject(new ApiError(500, 'BACKGROUND_WRITE_FAILED', '实景视频保存失败，请重试。'));
    });
    output.on('drain', onDrain);
    request.on('data', onData);
    request.once('end', onEnd);
    request.once('aborted', onAbort);
    request.once('error', onAbort);
  });
}

function validatePng(buffer, options) {
  if (buffer.length < 45 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)
      || buffer.readUInt32BE(8) !== 13 || buffer.toString('ascii', 12, 16) !== 'IHDR') {
    throw new ApiError(400, 'INVALID_PNG', '请上传完整的 PNG 图片。');
  }
  if (buffer.readUInt32BE(16) !== options.width || buffer.readUInt32BE(20) !== options.height) {
    throw new ApiError(400, 'FRAME_SIZE_MISMATCH', 'PNG 图片尺寸与导出设置不一致。');
  }
  let offset = 8;
  let ended = false;
  while (offset + 12 <= buffer.length) {
    const chunkLength = buffer.readUInt32BE(offset);
    const end = offset + chunkLength + 12;
    if (end > buffer.length) break;
    if (buffer.toString('ascii', offset + 4, offset + 8) === 'IEND') {
      ended = chunkLength === 0 && end === buffer.length;
      break;
    }
    offset = end;
  }
  if (!ended) throw new ApiError(400, 'INVALID_PNG', 'PNG 图片不完整，请重试这一帧。');
  if (options.format === 'mov-alpha' && ![4, 6].includes(buffer[25])) throw new ApiError(400, 'FRAME_ALPHA_REQUIRED', '透明 MOV 需要包含透明通道的 PNG 帧。');
}

function loopbackHost(hostname) {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
}

function enforceLocalRequest(request, port) {
  let host;
  try { host = new URL(`http://${request.headers.host || ''}`); }
  catch { throw new ApiError(403, 'LOCAL_ONLY', '此工具只允许本机访问。'); }
  if (!loopbackHost(host.hostname) || Number(host.port || 80) !== port || host.username || host.password
      || host.pathname !== '/' || host.search || host.hash) {
    throw new ApiError(403, 'LOCAL_ONLY', '此工具只允许本机访问。');
  }
  const originHeader = request.headers.origin;
  if (originHeader) {
    let origin;
    try { origin = new URL(originHeader); }
    catch { throw new ApiError(403, 'INVALID_ORIGIN', '请求来源不受信任。'); }
    if (origin.origin !== host.origin) throw new ApiError(403, 'INVALID_ORIGIN', '请从本机工作台页面操作。');
  }
  if (request.headers['sec-fetch-site'] === 'cross-site') {
    throw new ApiError(403, 'INVALID_ORIGIN', '请从本机工作台页面操作。');
  }
}

function within(base, candidate) {
  const relative = path.relative(base, candidate);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function contentDisposition(filename) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/** Create a local server. Importing this module never starts a listener. */
export function createApp({ root = ROOT, ffmpegPath = findFFmpegPath(),
  idleTimeoutMs = IDLE_TIMEOUT_MS, finishTimeoutMs = FINISH_TIMEOUT_MS,
  supportsSlicerPath = SUPPORT_SLICER, supportsPythonPath = findPythonPath(),
  supportJobTimeoutMs = 15 * 60 * 1000, supportMaximumUploadBytes = 128 * 1024 * 1024,
  photoCalibrationService = { detect: detectPhotoUprights, capability: photoCalibrationCapability },
  realisticRenderService, sliceService, blenderPath = process.env.BLENDER_PATH, alphaEncoderProbe = probeMovAlphaEncoder } = {}) {
  const supports = createSupportManager({ root, slicerPath: supportsSlicerPath, pythonPath: supportsPythonPath,
    timeoutMs: supportJobTimeoutMs, maximumUploadBytes: supportMaximumUploadBytes });
  const realistic = realisticRenderService || createRealisticRenderService({ root, ffmpegPath, alphaEncoderProbe, ...(blenderPath ? { blenderPath } : {}) });
  const slices = sliceService || createSliceService({ root, pythonPath: supportsPythonPath });
  const jobs = new Map();
  const outputDirectory = path.join(root, 'exports');
  let activeJob = null;
  let ffmpegInfoPromise;
  let ffmpegInfoTime = 0;
  let closed = false;

  async function ffmpegInfo() {
    if (!ffmpegInfoPromise || Date.now() - ffmpegInfoTime > 30_000) {
      ffmpegInfoTime = Date.now();
      ffmpegInfoPromise = execFileAsync(ffmpegPath, ['-version'], { timeout: 5000, maxBuffer: 64 * 1024 })
        .then(async ({ stdout }) => ({ available: true, version: stdout.split('\n')[0].trim(), alphaAvailable: (await alphaEncoderProbe(ffmpegPath)).available }))
        .catch(() => ({ available: false, version: null, alphaAvailable: false }));
    }
    return ffmpegInfoPromise;
  }

  async function stopJob(job, status = 'cancelled', message = '导出已取消。') {
    if (job.status === 'finished' || job.status === 'cancelled') return;
    job.status = status;
    job.failure = message;
    if (activeJob === job) activeJob = null;
    job.abortBackgroundUpload?.();
    job.child?.stdin.destroy();
    if (job.child && job.child.exitCode === null && !job.child.killed) {
      job.child.kill('SIGTERM');
      const timer = setTimeout(() => { if (!job.exited) job.child.kill('SIGKILL'); }, 1500);
      timer.unref();
    }
    // The child must close its output before cleanup, including on Windows.
    await job.completion;
    await job.backgroundUpload?.catch(() => {});
    await cleanupJobFiles(job);
  }

  async function cleanupJobFiles(job) {
    await rm(job.partialPath, { force: true }).catch(() => {});
    if (job.muxPath) await rm(job.muxPath, { force: true }).catch(() => {});
    if (job.backgroundPath) await rm(job.backgroundPath, { force: true }).catch(() => {});
    if (job.frameDirectory) await rm(job.frameDirectory, { recursive: true, force: true }).catch(() => {});
  }

  function getJob(id) {
    const job = jobs.get(id);
    if (!job) throw new ApiError(404, 'EXPORT_NOT_FOUND', '找不到这次导出，请重新开始。');
    return job;
  }

  function assertEncoding(job) {
    if (job.status !== 'encoding') throw new ApiError(409, 'EXPORT_NOT_ACTIVE', job.failure || '这次导出已结束。');
    if (job.failure) throw new ApiError(500, 'ENCODER_FAILED', job.failure);
  }

  async function createExport(request, response) {
    const options = validateExport(await readJson(request));
    if (activeJob) throw new ApiError(409, 'EXPORT_BUSY', '已有视频正在导出，请完成或取消后再试。');
    if (options.format !== 'png-sequence' && !(await ffmpegInfo()).available) throw new ApiError(503, 'FFMPEG_UNAVAILABLE', '未找到 FFmpeg。请安装 FFmpeg、设置 FFMPEG_PATH，或导出 PNG 序列。');
    if (options.format === 'mov-alpha' && !(await ffmpegInfo()).alphaAvailable) throw new ApiError(503, 'ALPHA_ENCODER_UNAVAILABLE', '本机 FFmpeg 不支持透明 ProRes MOV，请安装支持 prores_ks 的 FFmpeg 或导出透明 PNG 序列。');
    // Recheck after the asynchronous executable probe: two requests may arrive together.
    if (activeJob) throw new ApiError(409, 'EXPORT_BUSY', '已有视频正在导出，请完成或取消后再试。');
    const id = randomUUID();
    const stamp = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15);
    const extension = options.format === 'mov-alpha' ? 'mov' : options.format === 'mp4' ? 'mp4' : 'zip';
    const filename = `${options.name}-${stamp}-${id.slice(0, 8)}.${extension}`;
    const partialPath = path.join(outputDirectory, `${id}.partial.${extension}`);
    const job = {
      id, options, filename, partialPath, finalPath: path.join(outputDirectory, filename),
      status: 'encoding', received: 0, busy: false, touchedAt: Date.now(), stderr: '', failure: null,
    };
    // Reserve the slot before directory creation so concurrent requests cannot both start.
    activeJob = job;
    try {
      await mkdir(outputDirectory, { recursive: true });
      if (closed) throw new ApiError(503, 'SERVER_CLOSING', '工具正在关闭。');
      if (options.format === 'png-sequence') {
        job.frameDirectory = path.join(outputDirectory, `${id}.frames`);
        await mkdir(job.frameDirectory, { mode: 0o700 });
      } else {
        startEncoder(job, ffmpegPath, [
          '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-f', 'image2pipe',
          '-vcodec', 'png', '-framerate', String(options.fps), '-i', 'pipe:0',
          '-frames:v', String(options.frames), '-an',
          ...(options.format === 'mov-alpha' ? movAlphaEncoderArguments() : ['-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-f', 'mp4']), partialPath,
        ]);
      }
      jobs.set(id, job);
      json(response, 201, { id });
    } catch (error) {
      if (activeJob === job) activeJob = null;
      throw error;
    }
  }

  function startEncoder(job, executable, arguments_, cwd) {
    const encoderName = job.options.format === 'png-sequence' ? 'ZIP' : 'FFmpeg';
    const child = spawn(executable, arguments_, { cwd, stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
    job.child = child;
    job.exited = false;
    job.completion = new Promise(resolve => {
      child.once('error', error => { job.failure = `无法启动 ${encoderName}：${error.message}`; });
      child.once('close', (code, signal) => {
        job.exited = true;
        if ((code !== 0 || signal) && job.status !== 'cancelled') {
          job.failure ||= `${encoderName} 导出失败，请检查安装和磁盘空间。`;
          job.status = 'failed';
          if (activeJob === job) activeJob = null;
          job.abortBackgroundUpload?.();
          Promise.resolve(job.backgroundUpload).catch(() => {}).then(() => cleanupJobFiles(job)).catch(() => {});
        }
        resolve({ code, signal });
      });
    });
    child.stderr.on('data', chunk => { job.stderr = (job.stderr + chunk.toString()).slice(-8000); });
    // Prevent an unhandled EPIPE when an encoder rejects its input.
    child.stdin.on('error', () => {});
  }

  async function uploadBackground(job, request, response) {
    assertEncoding(job);
    if (job.options.format !== 'mp4') {
      request.resume();
      throw new ApiError(409, 'BACKGROUND_AUDIO_UNSUPPORTED', '透明导出不包含实景视频或声音。');
    }
    if (job.busy) {
      request.resume();
      throw new ApiError(409, 'FRAME_IN_PROGRESS', '请等待正在上传的文件完成。');
    }
    if (job.backgroundUploaded) {
      request.resume();
      throw new ApiError(409, 'BACKGROUND_ALREADY_UPLOADED', '本次导出的实景视频已上传。');
    }
    if (!/^video\/[a-z0-9.+-]+(?:\s*;|$)/i.test(request.headers['content-type'] || '')) {
      request.resume();
      throw new ApiError(415, 'INVALID_CONTENT_TYPE', '实景文件须使用 video/*。');
    }
    job.busy = true;
    job.touchedAt = Date.now();
    job.backgroundPath = path.join(outputDirectory, `${job.id}.background`);
    try {
      job.backgroundUpload = receiveBackground(request, job.backgroundPath, job);
      const bytes = await job.backgroundUpload;
      assertEncoding(job);
      job.backgroundUploaded = true;
      job.touchedAt = Date.now();
      json(response, 200, { uploaded: true, bytes });
    } catch (error) {
      await rm(job.backgroundPath, { force: true }).catch(() => {});
      if (['ENOSPC', 'EACCES', 'EIO'].includes(error.code)) {
        const message = error.code === 'ENOSPC' ? '磁盘空间不足，导出已取消。' : '实景视频保存失败，导出已取消。';
        await stopJob(job, 'failed', message);
        throw new ApiError(500, 'BACKGROUND_WRITE_FAILED', message);
      }
      throw error;
    } finally { job.backgroundUpload = null; job.busy = false; }
  }

  async function uploadFrame(job, request, response, url) {
    assertEncoding(job);
    const rawIndex = url.searchParams.get('index');
    if (!rawIndex || !/^\d+$/.test(rawIndex) || Number(rawIndex) !== job.received) {
      request.resume();
      throw new ApiError(409, 'FRAME_OUT_OF_ORDER', `请按顺序上传第 ${job.received} 帧（从 0 开始）。`);
    }
    if (job.received >= job.options.frames) {
      request.resume();
      throw new ApiError(409, 'TOO_MANY_FRAMES', '所有帧已上传，请完成导出。');
    }
    if (job.busy) { request.resume(); throw new ApiError(409, 'FRAME_IN_PROGRESS', '上一帧仍在处理，请逐帧上传。'); }
    if ((request.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'image/png') {
      request.resume();
      throw new ApiError(415, 'INVALID_CONTENT_TYPE', '帧须使用 image/png。');
    }
    job.busy = true;
    job.touchedAt = Date.now();
    try {
      const maximum = Math.min(MAX_PNG_BYTES, job.options.width * job.options.height * 5 + 65536);
      const png = await readBody(request, maximum);
      validatePng(png, job.options);
      assertEncoding(job);
      if (job.options.format === 'png-sequence') {
        await writeFile(path.join(job.frameDirectory, `frame_${String(job.received).padStart(6, '0')}.png`), png, { flag: 'wx' });
      } else {
        // Awaiting the write callback applies pipe backpressure before accepting the next frame.
        await new Promise((resolve, reject) => {
          job.child.stdin.write(png, error => error ? reject(new ApiError(500, 'ENCODER_FAILED', 'FFmpeg 停止接收画面，请重新导出。')) : resolve());
        });
      }
      assertEncoding(job);
      const index = job.received++;
      job.touchedAt = Date.now();
      json(response, 200, { index, received: job.received, total: job.options.frames });
    } catch (error) {
      if (error.code === 'ENCODER_FAILED' || ['ENOSPC', 'EACCES', 'EIO'].includes(error.code)) {
        const message = error.code === 'ENOSPC' ? '磁盘空间不足，导出已取消。' : '画面保存失败，导出已取消。';
        await stopJob(job, 'failed', message);
        throw new ApiError(500, 'FRAME_WRITE_FAILED', message);
      }
      throw error;
    } finally { job.busy = false; }
  }

  async function finishExport(job, request, response) {
    request.resume();
    if (job.status === 'finished') {
      json(response, 200, { url: `/api/exports/${job.id}/file`, filename: job.filename, bytes: job.bytes });
      return;
    }
    assertEncoding(job);
    if (job.busy) throw new ApiError(409, 'FRAME_IN_PROGRESS', '请等待最后一帧上传完成。');
    if (job.received !== job.options.frames) {
      throw new ApiError(409, 'FRAMES_MISSING', `应上传 ${job.options.frames} 帧，现已收到 ${job.received} 帧。`);
    }
    job.status = 'finishing';
    job.touchedAt = Date.now();
    if (job.options.format === 'png-sequence') {
      startEncoder(job, '/usr/bin/zip', ['-q', job.partialPath, '-@'], job.frameDirectory);
      job.child.stdin.end(Array.from({ length: job.options.frames }, (_, index) => `frame_${String(index).padStart(6, '0')}.png`).join('\n') + '\n');
    } else {
      job.child.stdin.end();
    }
    const timer = setTimeout(() => { stopJob(job, 'failed', '编码超时，请降低分辨率后重试。').catch(() => {}); }, finishTimeoutMs);
    timer.unref();
    try {
      const result = await job.completion;
      if (result.code !== 0 || job.status !== 'finishing') {
        throw new ApiError(500, 'ENCODER_FAILED', job.failure || '视频导出失败，请重新导出。');
      }
      let completedPath = job.partialPath;
      if (job.options.format === 'mp4' && job.backgroundUploaded) {
        job.muxPath = path.join(outputDirectory, `${job.id}.mux.mp4`);
        startEncoder(job, ffmpegPath, [
          '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', job.partialPath,
          '-stream_loop', '-1', '-i', job.backgroundPath, '-map', '0:v:0', '-map', '1:a:0?',
          // -shortest can stop looped audio early on older FFmpeg builds. The explicit
          // duration bounds the infinite source while copying every rendered frame.
          '-c:v', 'copy', '-c:a', 'aac', '-af', 'aresample=async=1:first_pts=0',
          '-t', String(job.options.frames / job.options.fps),
          '-movflags', '+faststart', '-f', 'mp4', job.muxPath,
        ]);
        job.child.stdin.end();
        const muxed = await job.completion;
        if (muxed.code !== 0 || job.status !== 'finishing') {
          throw new ApiError(500, 'BACKGROUND_AUDIO_FAILED', job.failure || '实景声音合成失败，请重试或关闭原声。');
        }
        completedPath = job.muxPath;
      }
      const info = await stat(completedPath);
      if (!info.size) throw new ApiError(500, 'EMPTY_OUTPUT', '没有生成有效的导出文件。');
      if (job.status !== 'finishing') throw new ApiError(409, 'EXPORT_NOT_ACTIVE', job.failure || '导出已取消。');
      await rename(completedPath, job.finalPath);
      await cleanupJobFiles(job);
      job.bytes = info.size;
      job.status = 'finished';
      job.touchedAt = Date.now();
      if (activeJob === job) activeJob = null;
      json(response, 200, { url: `/api/exports/${job.id}/file`, filename: job.filename, bytes: job.bytes });
    } catch (error) {
      await stopJob(job, 'failed', error.message);
      throw error;
    } finally { clearTimeout(timer); }
  }

  async function streamFile(request, response, filename, downloadName, compress = false) {
    let info;
    try { info = await stat(filename); }
    catch { throw new ApiError(404, 'FILE_NOT_FOUND', '文件不存在。'); }
    if (!info.isFile()) throw new ApiError(404, 'FILE_NOT_FOUND', '文件不存在。');
    const gzip = compress && /(?:^|[,\s])gzip(?:[,\s;]|$)/i.test(request.headers['accept-encoding'] || '') ? createGzip() : null;
    response.writeHead(200, {
      'Content-Type': MIME[path.extname(filename).toLowerCase()] || 'application/octet-stream',
      ...(gzip ? { 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' } : { 'Content-Length': info.size }), 'Cache-Control': 'no-cache',
      ...(downloadName ? { 'Content-Disposition': contentDisposition(downloadName) } : {}),
    });
    if (request.method === 'HEAD') { gzip?.destroy(); response.end(); return; }
    const stream = createReadStream(filename);
    stream.on('error', () => response.destroy());
    response.on('close', () => { stream.destroy(); gzip?.destroy(); });
    if (gzip) { gzip.on('error', () => response.destroy()); stream.pipe(gzip).pipe(response); }
    else stream.pipe(response);
  }

  const server = http.createServer(async (request, response) => {
    // A disconnected uploader can emit an error after its JSON response has already closed.
    request.on('error', () => {});
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.setHeader('X-Frame-Options', 'DENY');
    try {
      const address = server.address();
      enforceLocalRequest(request, typeof address === 'object' && address ? address.port : 4317);
      const url = new URL(request.url, `http://${request.headers.host}`);
      if (url.pathname === '/api/health' && request.method === 'GET') {
        const [ffmpeg, supportsSlicer, photoCalibration, realisticRender, slicing] = await Promise.all([ffmpegInfo(), supports.health(), photoCalibrationService.capability(), realistic.health(), slices.health()]);
        json(response, 200, { ok: true, ffmpeg, supportsSlicer, photoCalibration, realisticRender, slicing, activeExport: !!activeJob || realisticRender.active });
        return;
      }
      if (url.pathname === '/api/calibration/uprights' && request.method === 'POST') {
        const body = await readBody(request, PHOTO_CALIBRATION_MAX_BYTES);
        let mimeType = (request.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
        if (mimeType === 'application/octet-stream') mimeType = body.subarray(0, 8).equals(PNG_SIGNATURE) ? 'image/png' : body[0] === 255 && body[1] === 216 ? 'image/jpeg' : '';
        json(response, 200, await photoCalibrationService.detect(body, { mimeType }));
        return;
      }
      if (url.pathname === '/api/slices' && request.method === 'POST') {
        const raw = url.searchParams.get('options') || '{}';
        if(raw.length > 8192){request.resume();throw new ApiError(400,'SLICE_OPTIONS_INVALID','切片选项过长。');}
        let options;
        try{options=JSON.parse(raw);}catch{request.resume();throw new ApiError(400,'SLICE_OPTIONS_INVALID','切片选项无效。');}
        try{options=validateSliceOptions(options);}catch(error){request.resume();throw error;}
        json(response,201,await slices.create(request,options)); return;
      }
      const sliceMatch = /^\/api\/slices\/([0-9a-f-]{36})(?:\/(gcode|manifest|provenance))?$/.exec(url.pathname);
      if(sliceMatch){
        const [,id,resource]=sliceMatch;
        if(request.method==='GET'&&!resource){json(response,200,slices.snapshot(id));return;}
        if(request.method==='DELETE'&&!resource){request.resume();json(response,200,await slices.cancel(id));return;}
        if(request.method==='GET'&&resource==='provenance'){json(response,200,await slices.provenance(id));return;}
        if(['GET','HEAD'].includes(request.method)&&resource==='gcode'){
          await streamFile(request,response,await slices.gcodeFile(id),undefined,true);return;
        }
        if(['GET','HEAD'].includes(request.method)&&resource==='manifest'){
          await streamFile(request,response,await slices.file(id));return;
        }
        throw new ApiError(405,'METHOD_NOT_ALLOWED','此接口不支持这个操作。');
      }
      if (['/api/realistic-exports', '/api/realistic-previews'].includes(url.pathname) && request.method === 'POST') {
        const contentType = (request.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
        if (!['application/zip', 'application/octet-stream'].includes(contentType)) { request.resume(); throw new ApiError(415, 'INVALID_CONTENT_TYPE', '写实渲染需要完整场景包。'); }
        const preview = url.pathname === '/api/realistic-previews', format = preview ? 'preview' : url.searchParams.get('format') || 'mp4';
        if (!preview && !['mp4', 'mov-alpha', 'png-sequence'].includes(format)) { request.resume(); throw new ApiError(400, 'INVALID_FORMAT', '写实导出格式须为 mp4、mov-alpha 或 png-sequence。'); }
        const body = await readBody(request, REALISTIC_RENDER_LIMITS.maxUploadBytes);
        json(response, 201, await realistic.create(body, { name: url.searchParams.get('name') || undefined, format }));
        return;
      }
      const realisticMatch = /^\/api\/realistic-(exports|previews)\/([0-9a-f-]{36})(?:\/(file))?$/.exec(url.pathname);
      if (realisticMatch) {
        const options = { preview: realisticMatch[1] === 'previews' }, id = realisticMatch[2], resource = realisticMatch[3];
        if (request.method === 'GET' && !resource) { json(response, 200, realistic.snapshot(id, options)); return; }
        if (request.method === 'DELETE' && !resource) { request.resume(); json(response, 200, await realistic.cancel(id, options)); return; }
        if (['GET', 'HEAD'].includes(request.method) && resource === 'file') {
          const file = await realistic.file(id, options);
          await streamFile(request, response, file.path, options.preview ? undefined : file.name); return;
        }
        throw new ApiError(405, 'METHOD_NOT_ALLOWED', '此接口不支持这个操作。');
      }
      if (url.pathname === '/api/supports' && request.method === 'POST') {
        json(response, 201, await supports.create(request));
        return;
      }
      const supportMatch = /^\/api\/supports\/([0-9a-f-]{36})(?:\/(file))?$/.exec(url.pathname);
      if (supportMatch) {
        if (request.method === 'GET' && !supportMatch[2]) { json(response, 200, supports.snapshot(supportMatch[1])); return; }
        if (request.method === 'DELETE' && !supportMatch[2]) { request.resume(); json(response, 200, await supports.cancel(supportMatch[1])); return; }
        if (['GET', 'HEAD'].includes(request.method) && supportMatch[2] === 'file') {
          await streamFile(request, response, await supports.file(supportMatch[1]), undefined, true); return;
        }
        throw new ApiError(405, 'METHOD_NOT_ALLOWED', '此接口不支持这个操作。');
      }
      if (url.pathname === '/api/exports' && request.method === 'POST') {
        await createExport(request, response);
        return;
      }
      const match = /^\/api\/exports\/([0-9a-f-]{36})(?:\/(frames|finish|file|background))?$/.exec(url.pathname);
      if (match) {
        const job = getJob(match[1]);
        if (request.method === 'POST' && match[2] === 'background') { await uploadBackground(job, request, response); return; }
        if (request.method === 'POST' && match[2] === 'frames') { await uploadFrame(job, request, response, url); return; }
        if (request.method === 'POST' && match[2] === 'finish') { await finishExport(job, request, response); return; }
        if (['GET', 'HEAD'].includes(request.method) && match[2] === 'file') {
          if (job.status !== 'finished') throw new ApiError(409, 'EXPORT_NOT_FINISHED', '视频仍在导出中。');
          await streamFile(request, response, job.finalPath, job.filename);
          return;
        }
        if (request.method === 'DELETE' && !match[2]) {
          request.resume();
          if (job.status === 'finished') throw new ApiError(409, 'EXPORT_ALREADY_FINISHED', '视频已保存，取消不会删除已完成的视频。');
          await stopJob(job);
          json(response, 200, { cancelled: true });
          return;
        }
        throw new ApiError(405, 'METHOD_NOT_ALLOWED', '此接口不支持这个操作。');
      }
      if (url.pathname.startsWith('/api/')) throw new ApiError(404, 'NOT_FOUND', '接口不存在。');
      if (!['GET', 'HEAD'].includes(request.method)) { request.resume(); throw new ApiError(405, 'METHOD_NOT_ALLOWED', '仅支持读取静态文件。'); }
      let pathname;
      try { pathname = decodeURIComponent(url.pathname); }
      catch { throw new ApiError(400, 'INVALID_PATH', '文件路径无效。'); }
      if (pathname.includes('\0') || pathname.includes('\\') || pathname.split('/').some(part => part === '..' || part.startsWith('.'))) {
        throw new ApiError(404, 'FILE_NOT_FOUND', '文件不存在。');
      }
      if (pathname === '/') pathname = '/index.html';
      if (pathname !== '/index.html' && !/^\/(src|assets|node_modules|samples)\//.test(pathname)) {
        throw new ApiError(404, 'FILE_NOT_FOUND', '文件不存在。');
      }
      const filename = path.resolve(root, `.${pathname}`);
      let resolved;
      try { resolved = await realpath(filename); }
      catch { throw new ApiError(404, 'FILE_NOT_FOUND', '文件不存在。'); }
      const base = await realpath(root);
      if (!within(base, resolved)) throw new ApiError(404, 'FILE_NOT_FOUND', '文件不存在。');
      await streamFile(request, response, resolved);
    } catch (error) { errorResponse(response, error); }
  });

  server.requestTimeout = 120_000;
  server.headersTimeout = 15_000;
  const sweeper = setInterval(() => {
    const now = Date.now();
    if (activeJob && activeJob.status === 'encoding' && now - activeJob.touchedAt > idleTimeoutMs) {
      stopJob(activeJob, 'failed', '长时间没有收到画面，导出已取消。').catch(() => {});
    }
    // Keep finished sessions for downloads during this server run; disk files are retained.
    for (const [id, job] of jobs) {
      if (['cancelled', 'failed'].includes(job.status) && now - job.touchedAt > 60 * 60 * 1000) jobs.delete(id);
    }
  }, Math.min(30_000, Math.max(250, idleTimeoutMs / 2)));
  sweeper.unref();

  async function close() {
    closed = true;
    clearInterval(sweeper);
    if (activeJob) await stopJob(activeJob);
    await supports.close();
    await realistic.close();
    await slices.close();
    await new Promise(resolve => {
      server.close(resolve);
      server.closeIdleConnections?.();
    });
  }
  return { server, close };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4317);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error('PORT 须为 1–65535 之间的整数。');
    process.exitCode = 1;
  } else {
    const app = createApp();
    app.server.on('error', error => {
      console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已被占用。请关闭已启动的工作台，或设置 PORT 使用其他端口。` : error.message);
      process.exitCode = 1;
    });
    app.server.listen(port, '127.0.0.1', () => console.log(`模型生长延时工作台：http://127.0.0.1:${port}`));
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.once(signal, () => { app.close().then(() => process.exit(0)); });
    }
  }
}
