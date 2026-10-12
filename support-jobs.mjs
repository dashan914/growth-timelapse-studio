import { createReadStream, createWriteStream, constants } from 'node:fs';
import { access, mkdir, open, readdir, readFile, rm, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findPythonPath } from './runtime-paths.mjs';

export const SUPPORT_SLICER = '/Applications/Flash Studio.app/Contents/MacOS/Flash Studio';
const PREPARE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'scripts', 'prepare-support-project.py');
const MAX_UPLOAD = 128 * 1024 * 1024;
const TOLERANCE_MM = 0.08;

class SupportError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

function receiveProject(request, filename, job, limit) {
  const declared = request.headers['content-length'];
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
    request.resume();
    return Promise.reject(new SupportError(413, 'BODY_TOO_LARGE', '3MF 文件不能超过 128 MB。'));
  }
  return new Promise((resolve, reject) => {
    const output = createWriteStream(filename, { flags: 'wx', mode: 0o600 });
    let bytes = 0;
    let error;
    let finished = false;
    const cleanup = () => {
      request.off('data', onData); request.off('end', onEnd);
      request.off('aborted', onAbort); request.off('error', onAbort);
      output.off('drain', onDrain); job.abortUpload = null;
    };
    const fail = failure => {
      if (error || finished) return;
      error = failure; cleanup(); request.resume(); output.destroy();
    };
    const onData = chunk => {
      bytes += chunk.length;
      if (bytes > limit) fail(new SupportError(413, 'BODY_TOO_LARGE', '3MF 文件不能超过 128 MB。'));
      else if (!output.write(chunk)) request.pause();
    };
    const onDrain = () => { if (!error) request.resume(); };
    const onEnd = () => bytes ? output.end() : fail(new SupportError(400, 'EMPTY_PROJECT', '3MF 文件为空。'));
    const onAbort = () => fail(new SupportError(400, 'INCOMPLETE_UPLOAD', '3MF 上传中断，请重试。'));
    job.abortUpload = () => fail(new SupportError(409, 'SUPPORT_CANCELLED', '支撑生成已取消。'));
    output.once('error', fail);
    output.once('finish', () => { finished = true; cleanup(); });
    output.once('close', () => {
      cleanup();
      if (error) reject(error);
      else if (finished) resolve(bytes);
      else reject(new SupportError(500, 'PROJECT_WRITE_FAILED', '3MF 保存失败。'));
    });
    output.on('drain', onDrain);
    request.on('data', onData); request.once('end', onEnd);
    request.once('aborted', onAbort); request.once('error', onAbort);
  });
}

function simplify(points, tolerance = TOLERANCE_MM) {
  if (points.length <= 2) return { points, maxDeviationMm: 0 };
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  const tolerance2 = tolerance * tolerance;
  let maxDeviationMm = 0;
  while (stack.length) {
    const [first, last] = stack.pop();
    const a = points[first], b = points[last];
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    const length2 = dx * dx + dy * dy + dz * dz;
    let maximum = tolerance2, actualMaximum = 0, selected = -1;
    for (let index = first + 1; index < last; index++) {
      const p = points[index];
      const t = length2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy + (p[2] - a[2]) * dz) / length2)) : 0;
      const distance2 = (p[0] - a[0] - t * dx) ** 2 + (p[1] - a[1] - t * dy) ** 2 + (p[2] - a[2] - t * dz) ** 2;
      actualMaximum = Math.max(actualMaximum, distance2);
      if (distance2 > maximum) { maximum = distance2; selected = index; }
    }
    if (selected >= 0) { keep[selected] = 1; stack.push([first, selected], [selected, last]); }
    else maxDeviationMm = Math.max(maxDeviationMm, Math.sqrt(actualMaximum));
  }
  return { points: points.filter((_, index) => keep[index]), maxDeviationMm };
}

/** Parse every source move for state, but expose only support geometry as inert JSON. */
export async function extractSupportPreview(source, destination, { report = {}, isCancelled = () => false } = {}) {
  const result = { actualSliceSegments: 0, segments: 0, visualizationToleranceMm: TOLERANCE_MM,
    maxDeviationMm: 0, strokes: 0, bounds: { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }, features: {},
    colorHeaders: {}, crossSection: { widthMm: { min: Infinity, max: -Infinity }, heightMm: { min: Infinity, max: -Infinity } } };
  const output = await open(destination, 'wx', 0o600);
  const input = createReadStream(source, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let buffered = '';
  let writtenBytes = 0;
  const write = async text => {
    buffered += text;
    if (buffered.length > 1024 * 1024) {
      await output.write(buffered); writtenBytes += Buffer.byteLength(buffered); buffered = '';
      if (writtenBytes > 128 * 1024 * 1024) throw new Error('支撑预览超过 128 MB，请减少模型规模后重试。');
    }
  };
  const writeGcode = text => write(JSON.stringify(text).slice(1, -1));
  const number = value => Number(value.toFixed(7)).toString();
  const xyzText = point => point.map((value, axis) => `${'XYZ'[axis]}${number(value)}`).join(' ');
  let points = [], pathKey = null, pathFeature = '', pathTool = 0, pathWidth = 0.42, pathHeight = 0.12;
  const flush = async () => {
    if (points.length < 2) { points = []; return; }
    const simplified = simplify(points);
    const reduced = simplified.points;
    result.maxDeviationMm = Math.max(result.maxDeviationMm, simplified.maxDeviationMm);
    result.strokes++;
    await writeGcode(`T${pathTool}\n;TYPE:${pathFeature}\n;WIDTH:${number(pathWidth)}\n;HEIGHT:${number(pathHeight)}\nG0 ${xyzText(reduced[0])}\n`);
    for (let index = 1; index < reduced.length; index++) {
      await writeGcode(`G1 ${xyzText(reduced[index])} E1\n`);
      result.segments++;
    }
    if (result.segments > 2_000_000) throw new Error('支撑路径超过 200 万段可视化限制，请减少模型规模后重试。');
    points = [];
  };
  const point = [0, 0, 0], offset = [0, 0, 0];
  let e = 0, unit = 1, absoluteCoordinates = true, absoluteExtrusion = true, motion = null;
  let tool = 0, feature = '', width = 0.42, height = 0.12;
  const wordPattern = /([A-Z])\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))/g;
  const execute = async (command, parameters) => {
    if (command?.letter === 'T') { if (Number.isInteger(command.value) && command.value >= 0 && command.value <= 65535) tool = command.value; return; }
    if (command?.letter === 'M') { if (command.value === 82) absoluteExtrusion = true; if (command.value === 83) absoluteExtrusion = false; return; }
    if (command?.letter === 'G') {
      switch (command.value) {
        case 20: unit = 25.4; return;
        case 21: unit = 1; return;
        case 90: absoluteCoordinates = true; return;
        case 91: absoluteCoordinates = false; return;
        case 92:
          for (let axis = 0; axis < 3; axis++) if (parameters['XYZ'[axis]] !== undefined) offset[axis] = point[axis] - parameters['XYZ'[axis]] * unit;
          if (parameters.E !== undefined) e = parameters.E * unit;
          return;
        case 0: case 1: case 2: case 3: motion = command.value; break;
        default: return;
      }
    } else if (command) return;
    if (motion === null) return;
    const start = point.slice();
    for (let axis = 0; axis < 3; axis++) {
      const value = parameters['XYZ'[axis]];
      if (value !== undefined) point[axis] = absoluteCoordinates ? value * unit + offset[axis] : point[axis] + value * unit;
    }
    const previousE = e;
    if (parameters.E !== undefined) e = absoluteExtrusion ? parameters.E * unit : e + parameters.E * unit;
    const isSupport = /\bsupport\b/i.test(feature);
    const extrudes = e - previousE > 1e-9 && Math.hypot(point[0] - start[0], point[1] - start[1]) > 1e-9;
    if (!isSupport || !extrudes) { await flush(); return; }
    if (motion === 2 || motion === 3) throw new Error('支撑含圆弧路径，暂不支持。请在切片器关闭圆弧拟合后重新保存。');
    if ([...start, ...point].some(value => !Number.isFinite(value) || Math.abs(value) > 1e7)) throw new Error('切片器输出了无效支撑坐标。');
    result.actualSliceSegments++;
    result.features[feature] = (result.features[feature] || 0) + 1;
    result.crossSection.widthMm.min = Math.min(result.crossSection.widthMm.min, width);
    result.crossSection.widthMm.max = Math.max(result.crossSection.widthMm.max, width);
    result.crossSection.heightMm.min = Math.min(result.crossSection.heightMm.min, height);
    result.crossSection.heightMm.max = Math.max(result.crossSection.heightMm.max, height);
    for (const endpoint of [start, point]) for (let axis = 0; axis < 3; axis++) {
      result.bounds.min[axis] = Math.min(result.bounds.min[axis], endpoint[axis]);
      result.bounds.max[axis] = Math.max(result.bounds.max[axis], endpoint[axis]);
    }
    const key = `${tool}|${feature}|${width}|${height}|${start[2]}|${point[2]}`;
    const last = points[points.length - 1];
    if (pathKey !== key || !last || last.some((value, axis) => Math.abs(value - start[axis]) > 1e-8) || points.length >= 100_000) {
      await flush(); points = [start]; pathKey = key;
      pathFeature = feature.replace(/[\r\n]/g, ' '); pathTool = tool; pathWidth = width; pathHeight = height;
    }
    points.push(point.slice());
  };
  try {
    await write('{"visualizationOnly":true,"gcode":"');
    await writeGcode('; VISUALIZATION ONLY: actual sliced support paths, never a printer job.\nG21\nG90\nM83\n');
    let count = 0;
    for await (let line of lines) {
      if (++count % 4096 === 0 && isCancelled()) throw new Error('支撑生成已取消。');
      if (line.length > 65536) throw new Error('切片输出含异常长行。');
      const commentAt = line.indexOf(';');
      if (commentAt >= 0) {
        const comment = line.slice(commentAt + 1);
        const palette = comment.match(/^\s*((?:filament|extruder)_colou?rs?)\s*[:=]\s*(.*)$/i);
        if (palette) {
          const key = palette[1].toLowerCase(), value = palette[2].trim();
          if (result.colorHeaders[key] !== value) {
            // Preserve zero-based tool order and unused slots exactly as the slicer
            // wrote them. A later source header may replace an earlier palette.
            result.colorHeaders[key] = value;
            await writeGcode(`; ${key} = ${value}\n`);
          }
        }
        const typed = comment.match(/^\s*(?:TYPE|FEATURE)\s*:\s*(.*)$/i);
        if (typed) feature = typed[1].trim();
        const measure = comment.match(/^\s*(WIDTH|HEIGHT)\s*:\s*([\d.]+)/i);
        if (measure) {
          const value = Number(measure[2]);
          if (Number.isFinite(value) && value > 0 && value < 100) { if (measure[1].toUpperCase() === 'WIDTH') width = value; else height = value; }
        }
        line = line.slice(0, commentAt);
      }
      line = line.split('*')[0].replace(/\([^)]*\)/g, '').toUpperCase();
      if (!line.trim()) continue;
      wordPattern.lastIndex = 0;
      let command = null, parameters = Object.create(null), match;
      while ((match = wordPattern.exec(line))) {
        const letter = match[1], value = Number(match[2]);
        if (letter === 'N') continue;
        if (letter === 'G' || letter === 'M' || (letter === 'T' && command === null)) {
          if (command) await execute(command, parameters);
          command = { letter, value }; parameters = Object.create(null);
        } else parameters[letter] = value;
      }
      await execute(command, parameters);
    }
    await flush();
    if (!result.actualSliceSegments) throw new Error('切片结果没有实际支撑路径。请检查原 3MF 的支撑设置。');
    await write(`",${JSON.stringify({ ...result, corrections: report.corrections || [], supportFieldsPreserved: Object.keys(report.unchangedSupportFields || {}).length }).slice(1)}`);
    if (buffered) await output.write(buffered);
    return result;
  } finally { lines.close(); input.destroy(); await output.close(); }
}

export function createSupportManager({ root, slicerPath = SUPPORT_SLICER, pythonPath = findPythonPath(),
  timeoutMs = 15 * 60 * 1000, maximumUploadBytes = MAX_UPLOAD, prepareScript = PREPARE, spawnImpl = spawn } = {}) {
  const jobs = new Map();
  const directory = path.join(root, '.support-jobs');
  let active = null, closed = false;
  const health = async () => {
    try { await access(slicerPath, constants.X_OK); await access(pythonPath, constants.X_OK); return { available: true }; }
    catch { return { available: false }; }
  };
  const get = id => { const job = jobs.get(id); if (!job) throw new SupportError(404, 'SUPPORT_NOT_FOUND', '找不到这次支撑生成。'); return job; };
  const snapshot = id => {
    const job = get(id);
    return { id, status: job.status, phase: job.phase, message: job.message,
      ...(job.status === 'complete' ? { url: `/api/supports/${id}/file`, ...job.result } : {}) };
  };
  const stopChild = job => {
    if (job.child && job.child.exitCode === null && !job.child.killed) {
      const child = job.child; child.kill('SIGTERM');
      const timer = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 1500); timer.unref();
    }
  };
  const process = (job, executable, args) => new Promise((resolve, reject) => {
    if (job.cancelled) { reject(new Error('支撑生成已取消。')); return; }
    const child = spawnImpl(executable, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
    job.child = child;
    let stderr = '';
    const remember = chunk => { stderr = (stderr + chunk.toString()).slice(-8000); };
    child.stdout.on('data', remember); child.stderr.on('data', remember);
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (job.child === child) job.child = null;
      if (code === 0 && !signal && !job.cancelled) resolve();
      else reject(new Error(job.cancelled ? '支撑生成已取消。' : `切片器处理失败（${code ?? signal}）。${stderr.slice(-1500)}`));
    });
  });
  const run = async job => {
    let completed = false;
    let terminalStatus = null;
    const timer = setTimeout(() => {
      job.timedOut = true; job.cancelled = true; stopChild(job);
    }, timeoutMs); timer.unref();
    try {
      job.phase = 'preparing'; job.message = '读取原有支撑设置，准备独立副本…';
      await process(job, pythonPath, [prepareScript, job.source, job.prepared, job.report]);
      if (job.cancelled) throw new Error('支撑生成已取消。');
      job.phase = 'slicing'; job.message = '正在计算实际支撑结构，复杂模型可能需要几分钟…';
      await mkdir(job.output, { mode: 0o700 });
      await process(job, slicerPath, ['--datadir', path.join(job.directory, 'profile'), '--debug', '3', '--no-check',
        '--slice', '1', '--arrange', '0', '--orient', '0', '--mstpp', '600', '--outputdir', job.output, job.prepared]);
      if (job.cancelled) throw new Error('支撑生成已取消。');
      const files = (await readdir(job.output)).filter(name => /^plate_1\.gcode$/i.test(name));
      if (!files.length) throw new Error('切片器没有输出第一盘的路径。请把模型保存到第 1 盘后再试。');
      job.phase = 'extracting'; job.message = '整理支撑预览，保留支撑分支与层次…';
      const report = JSON.parse(await readFile(job.report, 'utf8'));
      job.result = await extractSupportPreview(path.join(job.output, files[0]), job.preview, { report, isCancelled: () => job.cancelled });
      if (job.cancelled) throw new Error('支撑生成已取消。');
      completed = true;
      job.message = `已生成实际支撑，共 ${job.result.actualSliceSegments.toLocaleString('zh-CN')} 段切片路径。`;
    } catch (error) {
      terminalStatus = job.cancelled && !job.timedOut ? 'cancelled' : 'failed';
      job.message = job.timedOut ? '支撑计算超时，请减少模型规模后重试。' : error.message;
    } finally {
      clearTimeout(timer);
      for (const name of ['source.3mf', 'preview.3mf', 'preparation.json', 'profile', 'output']) await rm(path.join(job.directory, name), { recursive: true, force: true }).catch(() => {});
      if (!completed || job.cancelled) await rm(job.directory, { recursive: true, force: true }).catch(() => {});
      if (completed && !job.cancelled) { job.status = 'complete'; job.phase = 'complete'; }
      else if (job.cancelled && !job.timedOut) { job.status = 'cancelled'; job.phase = 'cancelled'; job.message = '支撑生成已取消。'; }
      else { job.status = terminalStatus || 'failed'; job.phase = job.status; }
      if (active === job) active = null;
    }
  };
  const create = async request => {
    if (closed) { request.resume(); throw new SupportError(503, 'SERVER_CLOSING', '工具正在关闭。'); }
    if ((request.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/octet-stream') {
      request.resume(); throw new SupportError(415, 'INVALID_CONTENT_TYPE', '3MF 上传须使用 application/octet-stream。');
    }
    if (active) { request.resume(); throw new SupportError(409, 'SUPPORT_BUSY', '已有支撑正在生成，请完成或取消后再试。'); }
    if (!(await health()).available) { request.resume(); throw new SupportError(503, 'SUPPORT_SLICER_UNAVAILABLE', '未找到本机 Flash Studio 支撑切片器。'); }
    if (active) { request.resume(); throw new SupportError(409, 'SUPPORT_BUSY', '已有支撑正在生成，请完成或取消后再试。'); }
    const id = randomUUID();
    const jobDirectory = path.join(directory, id);
    const job = { id, directory: jobDirectory, source: path.join(jobDirectory, 'source.3mf'), prepared: path.join(jobDirectory, 'preview.3mf'),
      report: path.join(jobDirectory, 'preparation.json'), preview: path.join(jobDirectory, 'support-preview.json'), output: path.join(jobDirectory, 'output'),
      status: 'running', phase: 'uploading', message: '正在读取 3MF…', cancelled: false };
    active = job;
    try {
      await mkdir(jobDirectory, { recursive: true, mode: 0o700 });
      job.upload = receiveProject(request, job.source, job, maximumUploadBytes);
      await job.upload;
      if (closed || job.cancelled) throw new SupportError(409, 'SUPPORT_CANCELLED', '支撑生成已取消。');
      jobs.set(id, job);
      job.completion = run(job);
      return { id };
    } catch (error) {
      await rm(jobDirectory, { recursive: true, force: true }).catch(() => {});
      if (active === job) active = null;
      throw error;
    }
  };
  const cancel = async id => {
    const job = get(id);
    job.cancelled = true; job.abortUpload?.(); stopChild(job);
    await job.completion;
    await rm(job.directory, { recursive: true, force: true }).catch(() => {});
    job.status = 'cancelled'; job.phase = 'cancelled'; job.message = '支撑生成已取消。';
    if (active === job) active = null;
    return { cancelled: true };
  };
  const file = async id => {
    const job = get(id);
    if (job.status !== 'complete') throw new SupportError(409, 'SUPPORT_NOT_FINISHED', job.message);
    await stat(job.preview);
    return job.preview;
  };
  const close = async () => {
    closed = true;
    if (active && !jobs.has(active.id)) { active.cancelled = true; active.abortUpload?.(); await active.upload?.catch(() => {}); }
    await Promise.all([...jobs.keys()].map(id => cancel(id)));
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  };
  return { create, snapshot, cancel, file, health, close };
}
