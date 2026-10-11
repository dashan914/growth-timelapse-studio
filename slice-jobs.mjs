import { createReadStream, createWriteStream, constants } from 'node:fs';
import { access, chmod, mkdir, readFile, readdir, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeSliceSettings } from './src/slice-settings.js';
import { BAMBU_STUDIO_DEFAULT_PATH } from './bambu-engine.mjs';
import { probeSlicerEngine, probeLocalSlicers, LOCAL_SLICER_IDS } from './slicer-engine.mjs';

export const SLICE_SLICER = BAMBU_STUDIO_DEFAULT_PATH;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PREPARE = path.join(HERE, 'scripts', 'prepare-slice-project.py');
export const SLICE_LIMITS = Object.freeze({ projectBytes: 128 * 1024 * 1024, stlBytes: 384 * 1024 * 1024,
  gcodeBytes: 768 * 1024 * 1024, retainedBytes: 2 * 1024 * 1024 * 1024, retainedJobs: 4 });
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export class SliceError extends Error {
  constructor(status, code, message) { super(message); this.name = 'SliceError'; this.status = status; this.code = code; }
}

export function friendlyNativeFailure(output, { preparing = false } = {}) {
  const text = String(output || '');
  const chinese = text.match(/(?:^|\n)(该工程[^\n]+|原始完整切片文件[^\n]+|原工程[^\n]+)/);
  if (chinese) return chinese[1];
  if (/No layers were detected|no layers|not generate.*layer/i.test(text)) return '模型没有产生可打印层。先核对模型单位与尺寸；若模型只有表面，请导出闭合实体后重试。';
  if (/Nothing to be sliced|0 printable|no object.*fully inside|print is empty/i.test(text)) return '模型没有可切片的实体，或超出底板范围。请核对单位和大小，并导出单盘闭合实体后重试。';
  if (/does not fit.*plate|not scaled or simplified/i.test(text)) return '模型按原始尺寸超出底板，请检查单位或选择合适底板；工具没有缩放或减面。';
  if (/not a zip|not.*zip file|BadZipFile/i.test(text)) return '这个 3MF 文件损坏或格式不正确。请在切片软件重新导出后再导入。';
  if (/unit.*invalid|unsupported.*unit|unit.*not supported|singular|transform.*invalid/i.test(text)) return '模型单位或坐标信息无效。请选择正确的毫米、厘米或米单位，重新导出模型后再试。';
  if (/param values.*error|config.*error|not in range|unsupported.*pattern|unknown.*parameter/i.test(text)) return '工程中的部分切片参数与本机切片器不兼容。请在原切片软件保存单盘工程，或直接导入完整 G-code。';
  if (/unsafe archive|duplicate ZIP|symbolic-link|3MF.*large|processing limit|expands beyond/i.test(text)) return '3MF 文件结构或规模超出处理范围。请重新保存单盘工程；工具不会删除模型细节。';
  if (/process not compatible|not compatible with.*process preset/i.test(text)) return '模型工程的配置与本机切片器不兼容。请在本机切片器中打开模型，选择兼容配置并保存后重试。';
  return preparing ? '模型读取没有完成。请确认文件可在原建模或切片软件正常打开，再重新导出单盘工程。' : '这次本机切片没有完成。请在检测到的切片软件中打开原模型，核对配置并保存后重试。';
}

export function validateSliceOptions(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new SliceError(400, 'SLICE_OPTIONS_INVALID', '切片选项格式无效。');
  const allowed = new Set(['format', 'preset', 'sourceName', 'sourceToPrinter', 'sourceCoordinateSystem', 'toolColors', 'engineId']);
  if (Object.keys(options).some(key => !allowed.has(key))) throw new SliceError(400, 'SLICE_OPTIONS_INVALID', '切片选项含不支持的字段；不接受任何本机文件路径。');
  const format = options.format ?? '3mf';
  const preset = options.preset ?? 'h2c';
  if (!['3mf', 'stl'].includes(format)) throw new SliceError(400, 'SLICE_FORMAT_INVALID', '真实切片须上传 3MF 工程或完整 STL 网格。');
  if (!['h2c', 'p1s', 'a1'].includes(preset)) throw new SliceError(400, 'SLICE_PRESET_INVALID', '切片背景预设无效。');
  const sourceCoordinateSystem = options.sourceCoordinateSystem ?? 'printer-z-up';
  if (!['three-y-up', 'printer-z-up'].includes(sourceCoordinateSystem)) throw new SliceError(400, 'SLICE_TRANSFORM_INVALID', '来源坐标系无效。');
  let sourceToPrinter = options.sourceToPrinter ?? IDENTITY;
  if (!Array.isArray(sourceToPrinter) || sourceToPrinter.length !== 16 || sourceToPrinter.some(value => typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1e7)
    || Math.abs(sourceToPrinter[3]) + Math.abs(sourceToPrinter[7]) + Math.abs(sourceToPrinter[11]) > 1e-10 || Math.abs(sourceToPrinter[15] - 1) > 1e-10) {
    throw new SliceError(400, 'SLICE_TRANSFORM_INVALID', '来源到打印机的变换须为明确的有限仿射 4×4 矩阵。');
  }
  const m = sourceToPrinter;
  const det = m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);
  if (Math.abs(det) < 1e-15) throw new SliceError(400, 'SLICE_TRANSFORM_INVALID', '来源变换不可逆，不能准确对齐真实打印路径。');
  if (format === '3mf' && (sourceCoordinateSystem !== 'printer-z-up' || sourceToPrinter.some((value, index) => Math.abs(value - IDENTITY[index]) > 1e-10))) {
    throw new SliceError(400, 'SLICE_TRANSFORM_INVALID', '3MF 使用其保存的原始盘位，不允许覆盖或猜测来源变换。');
  }
  if (sourceCoordinateSystem === 'three-y-up' && options.sourceToPrinter === undefined) throw new SliceError(400, 'SLICE_TRANSFORM_INVALID', 'Y 轴向上网格必须明确提供到打印机坐标的变换。');
  const toolColors = options.toolColors ?? [];
  if (!Array.isArray(toolColors) || toolColors.length > 256 || toolColors.some(color => typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color))) {
    throw new SliceError(400, 'SLICE_PALETTE_INVALID', '耗材颜色须为最多 256 个六位色值。');
  }
  const sourceName = options.sourceName ?? `model.${format}`;
  if (typeof sourceName !== 'string' || sourceName.length > 200 || /[\x00-\x1f\x7f]/.test(sourceName)) throw new SliceError(400, 'SLICE_NAME_INVALID', '模型名称无效。');
  const engineId = options.engineId ?? 'auto';
  if (engineId !== 'auto' && !LOCAL_SLICER_IDS.includes(engineId)) throw new SliceError(400, 'SLICE_ENGINE_INVALID', '本机切片器类型无效。');
  return { format, preset, engineId, sourceName: path.basename(sourceName.replaceAll('\\', '/')), sourceToPrinter: sourceToPrinter.slice(), sourceCoordinateSystem, toolColors: toolColors.map(color => color.toLowerCase()) };
}

async function receive(input, destination, job, maximumBytes) {
  if (Buffer.isBuffer(input) || input instanceof Uint8Array) {
    if (!input.byteLength) throw new SliceError(400, 'EMPTY_SLICE_INPUT', '模型文件为空。');
    if (input.byteLength > maximumBytes) throw new SliceError(413, 'SLICE_BODY_TOO_LARGE', '模型文件超过真实切片大小限制。');
    await writeFile(destination, input, { flag: 'wx', mode: 0o600 });
    return input.byteLength;
  }
  if (!input?.on || !input?.resume || !input?.pause || !input?.headers) throw new SliceError(400, 'SLICE_INPUT_INVALID', '须上传模型字节，不能提供本机文件路径。');
  if ((input.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/octet-stream') {
    input.resume(); throw new SliceError(415, 'SLICE_CONTENT_TYPE_INVALID', '模型须通过 application/octet-stream 上传。');
  }
  const length = input.headers['content-length'];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > maximumBytes)) {
    input.resume(); throw new SliceError(413, 'SLICE_BODY_TOO_LARGE', '模型文件超过真实切片大小限制。');
  }
  return new Promise((resolve, reject) => {
    const output = createWriteStream(destination, { flags: 'wx', mode: 0o600 });
    let bytes = 0, failure = null, finished = false;
    const cleanup = () => {
      input.off('data', onData); input.off('end', onEnd); input.off('aborted', onAbort); input.off('error', onAbort);
      output.off('drain', onDrain); job.abortUpload = null;
    };
    const fail = error => {
      if (failure || finished) return;
      failure = error; cleanup(); input.resume(); output.destroy();
    };
    const onData = chunk => {
      bytes += chunk.length;
      if (bytes > maximumBytes) fail(new SliceError(413, 'SLICE_BODY_TOO_LARGE', '模型文件超过真实切片大小限制。'));
      else if (!output.write(chunk)) input.pause();
    };
    const onDrain = () => { if (!failure) input.resume(); };
    const onEnd = () => bytes ? output.end() : fail(new SliceError(400, 'EMPTY_SLICE_INPUT', '模型文件为空。'));
    const onAbort = () => fail(new SliceError(400, 'SLICE_UPLOAD_INTERRUPTED', '模型上传中断。'));
    job.abortUpload = () => fail(new SliceError(409, 'SLICE_CANCELLED', '真实切片已取消。'));
    output.once('error', fail);
    output.once('finish', () => { finished = true; cleanup(); });
    output.once('close', () => {
      cleanup();
      if (failure) reject(failure);
      else if (finished) resolve(bytes);
      else reject(new SliceError(500, 'SLICE_INPUT_WRITE_FAILED', '模型文件保存失败。'));
    });
    output.on('drain', onDrain);
    input.on('data', onData); input.once('end', onEnd); input.once('aborted', onAbort); input.once('error', onAbort);
  });
}

/** Byte-accurate streaming index. The full original file is retained unchanged;
 * indexing never reduces, clips, re-colors or re-writes extrusion commands. */
export async function indexSliceGCode(filename, { maximumBytes = SLICE_LIMITS.gcodeBytes, isCancelled = () => false, onProgress = () => {} } = {}) {
  const fileStat = await stat(filename);
  if (!fileStat.isFile() || fileStat.size < 1) throw new SliceError(500, 'SLICE_OUTPUT_EMPTY', '切片器没有生成有效路径文件。');
  if (fileStat.size > maximumBytes) throw new SliceError(413, 'SLICE_OUTPUT_TOO_LARGE', '完整切片结果超过处理限制；不会截断路径或冒充完整结果。');
  const input = createReadStream(filename, { highWaterMark: 1024 * 1024 });
  const hash = createHash('sha256');
  let pending = Buffer.alloc(0), lineOffset = 0, consumed = 0, lineCount = 0;
  const layers = [], featureLabels = Object.create(null), configuration = Object.create(null);
  let current = null, typed = false, modelMoves = 0;
  const inspect = (raw, byteCount) => {
    const line = raw.toString('utf8').replace(/\r$/, '');
    if (line.length > 65536) throw new SliceError(400, 'SLICE_LINE_TOO_LONG', '切片输出含异常长行。');
    lineCount++;
    if (/^;\s*(?:LAYER_CHANGE|CHANGE_LAYER)\s*$/i.test(line)) {
      if (current) current.endByte = lineOffset;
      current = { index: layers.length, startByte: lineOffset, endByte: null, heightMm: null };
      layers.push(current);
      if (layers.length > 100000) throw new SliceError(413, 'SLICE_TOO_MANY_LAYERS', '完整切片层数超过处理限制。');
    }
    const z = line.match(/^;\s*(?:Z|Z_HEIGHT)\s*:\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*$/i);
    if (z && current && current.heightMm === null) current.heightMm = Number(z[1]);
    const feature = line.match(/^;\s*(?:TYPE|FEATURE)\s*:\s*(.*?)\s*$/i);
    if (feature) {
      const label = feature[1];
      if (!Object.hasOwn(featureLabels, label) && Object.keys(featureLabels).length >= 256) throw new SliceError(413, 'SLICE_FEATURE_LIMIT', '切片输出含过多不同路径类型；拒绝采用不完整结果。');
      featureLabels[label] = (featureLabels[label] || 0) + 1;
      typed = /wall|perimeter|infill|surface|skin|bridge|gap|ironing/i.test(label) && !/support|prime|wipe|purge|brim|skirt|custom/i.test(label);
    }
    if (typed && /(?:^|\s)G[0123](?:\s|$)/i.test(line) && /\bE[+-]?(?:\d|\.)/i.test(line)) modelMoves++;
    // Configuration is inert metadata, not interpreted printer instructions.
    const cfg = line.match(/^;\s*(\w+)\s*=\s*(.*?)\s*$/);
    if (cfg && !['__proto__', 'constructor', 'prototype'].includes(cfg[1]) && Object.keys(configuration).length < 5000 && cfg[2].length < 65536) configuration[cfg[1]] = cfg[2];
    lineOffset += byteCount;
  };
  try {
    for await (const chunk of input) {
      if (isCancelled()) throw new SliceError(409, 'SLICE_CANCELLED', '真实切片已取消。');
      hash.update(chunk); consumed += chunk.length;
      if (consumed > maximumBytes) throw new SliceError(413, 'SLICE_OUTPUT_TOO_LARGE', '完整切片结果超过处理限制；不会截断。');
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      let start = 0, end;
      while ((end = pending.indexOf(10, start)) !== -1) { inspect(pending.subarray(start, end), end - start + 1); start = end + 1; }
      pending = pending.subarray(start);
      if (pending.length > 65536) throw new SliceError(400, 'SLICE_LINE_TOO_LONG', '切片输出含异常长行。');
      onProgress(consumed / fileStat.size);
    }
    if (pending.length) inspect(pending, pending.length);
    if (current) current.endByte = fileStat.size;
    if (!modelMoves) throw new SliceError(500, 'SLICE_NO_MODEL_PATHS', '切片结果没有带类型标记的模型路径，不能真实还原填充。');
    if (!layers.length || layers.some(layer => !Number.isFinite(layer.heightMm))) throw new SliceError(500, 'SLICE_LAYER_INDEX_MISSING', '切片结果缺少完整的层高标记，不能采用不完整的层索引。');
    return { schemaVersion: 1, gcodeBytes: fileStat.size, gcodeSha256: hash.digest('hex'), lineCount,
      layerCount: layers.length, layers, modelMotionLines: modelMoves, featureLabels,
      rawConfiguration: configuration, completeFileRetained: true, segmentsSimplified: false };
  } finally { input.destroy(); }
}

export function createSliceService({ root = HERE, slicerPath, slicerPaths = {}, engineProbe = probeSlicerEngine, forceReslice = true, pythonPath = '/usr/bin/python3', prepareScript = PREPARE,
  timeoutMs = 15 * 60 * 1000, uploadTimeoutMs = 60 * 1000, maximumProjectBytes = SLICE_LIMITS.projectBytes,
  maximumStlBytes = SLICE_LIMITS.stlBytes, maximumGcodeBytes = SLICE_LIMITS.gcodeBytes,
  maximumRetainedBytes = SLICE_LIMITS.retainedBytes, maximumRetainedJobs = SLICE_LIMITS.retainedJobs,
  processRunner = null } = {}) {
  root = path.resolve(root);
  const jobs = new Map(), directory = path.join(root, '.slice-jobs'), diagnosticsRoot = path.join(root, '.slice-diagnostics');
  const diagnostics = new Map();
  let active = null, closed = false, retainedBytes = 0;
  let reservation = false;
  let detection = null, detectionTime = 0;
  const detectedEngines = async () => {
    if (!detection || Date.now() - detectionTime > 30_000) {
      detectionTime = Date.now();
      // An explicit path/probe is an integration seam for a local launcher or
      // tests. The regular application always detects installed applications.
      detection = (slicerPath || engineProbe !== probeSlicerEngine)
        ? engineProbe({ engineId: 'bambu', slicerPath }).then(cap => ({ engines: [{ id: 'bambu', ...cap }], preferredEngineId: cap.available ? 'bambu' : null }))
        : probeLocalSlicers({ slicerPaths });
    }
    return detection;
  };
  const health = async () => {
    let embeddedAvailable = false;
    try { await access(pythonPath, constants.X_OK); await access(prepareScript, constants.R_OK); embeddedAvailable = true; } catch {}
    const registry = await detectedEngines();
    const selected = registry.engines.find(cap => cap.id === registry.preferredEngineId);
    return { ...selected, available: Boolean(selected?.available && embeddedAvailable), embeddedAvailable,
      engine: selected?.engine || '本机切片器', engineId: selected?.id || null, engines: registry.engines,
      reason: !embeddedAvailable ? '本机模型准备环境不可用。' : selected?.reason || (!selected ? '未找到 Bambu Studio、OrcaSlicer 或 Flash Studio，请安装其中一个后重试。' : null),
      formats: ['3mf', 'stl'], exactToolpaths: true, automatic: true };
  };
  const get = id => { const job = jobs.get(id); if (!job) throw new SliceError(404, 'SLICE_NOT_FOUND', '找不到这次真实切片。'); return job; };
  const snapshot = id => {
    const job = get(id);
    return { id, status: job.status, phase: job.phase, progress: job.progress, nativeProgress: job.nativeProgress ?? null,
      completed: job.completed ?? null, total: job.total ?? null, unit: job.unit ?? null, message: job.message,
      ...(job.status === 'complete' ? job.result : {}), ...(job.errorCode ? { errorCode: job.errorCode } : {}) };
  };
  const stopChild = job => {
    if (job.child && job.child.exitCode === null && !job.child.killed) {
      const child = job.child;
      child.kill('SIGTERM');
      const timer = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 1500); timer.unref();
    }
  };
  const process = async (job, executable, args) => {
    if (job.cancelled) throw new SliceError(409, 'SLICE_CANCELLED', '真实切片已取消。');
    if (processRunner) return processRunner({ job, executable, args });
    await mkdir(job.diagnosticsDirectory, { recursive: true, mode: 0o700 });
    const preparing = executable === pythonPath;
    const logPath = path.join(job.diagnosticsDirectory, preparing ? 'prepare.log' : 'engine.log');
    return new Promise((resolve, reject) => {
      const log = createWriteStream(logPath, { flags: 'wx', mode: 0o600 });
      const child = spawn(executable, args, { cwd: job.directory, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      job.child = child;
      let output = '', bytes = 0, processError = null, logFailure = null;
      const remember = chunk => {
        bytes += chunk.length;
        if (bytes > 32 * 1024 * 1024) { logFailure = new SliceError(500, 'SLICE_LOG_TOO_LARGE', '切片器输出超过保护范围。请重新保存单盘工程后再试。'); stopChild(job); return; }
        if (!logFailure && !log.write(chunk)) { child.stdout.pause(); child.stderr.pause(); }
        output = (output + chunk.toString()).slice(-8000);
        // Native log percentages are advisory; do not invent an ETA.
        const match = output.match(/(?:progress|percent)\D{0,20}(\d{1,3})(?:\.\d+)?\s*%\s*$/i);
        if (match && !preparing && Number(match[1]) <= 100) job.nativeProgress = Number(match[1]);
      };
      log.on('drain', () => { child.stdout.resume(); child.stderr.resume(); });
      log.once('error', error => { logFailure = new SliceError(500, 'SLICE_LOG_WRITE_FAILED', '本机诊断信息保存失败，请重新打开工具后再试。'); stopChild(job); });
      child.stdout.on('data', remember); child.stderr.on('data', remember);
      child.once('error', error => { processError = error; log.write(error.message); });
      child.once('close', async (code, signal) => {
        if (job.child === child) job.child = null;
        await new Promise(finish => { if (log.destroyed || log.closed) finish(); else log.end(finish); });
        diagnostics.set(job.id, { directory: job.diagnosticsDirectory, time: Date.now() });
        while (diagnostics.size > 16) { const first = diagnostics.entries().next().value; diagnostics.delete(first[0]); await rm(first[1].directory, { recursive: true, force: true }).catch(() => {}); }
        if (logFailure) reject(logFailure);
        else if (processError) reject(new SliceError(500, 'SLICE_ENGINE_UNAVAILABLE', '本机切片器无法启动，请重新打开工具后再试。'));
        else if (code === 0 && !signal && !job.cancelled) resolve();
        else reject(new SliceError(500, 'SLICE_ENGINE_FAILED', job.cancelled ? '真实切片已取消。' : friendlyNativeFailure(output, { preparing })));
      });
    });
  };
  const removeRetained = async job => {
    if (job.retainedBytes) { retainedBytes -= job.retainedBytes; job.retainedBytes = 0; }
    await rm(job.directory, { recursive: true, force: true });
  };
  const prune = async required => {
    const complete = [...jobs.values()].filter(job => job.status === 'complete').sort((a, b) => a.finishedAt - b.finishedAt);
    while (complete.length && (retainedBytes + required > maximumRetainedBytes || complete.length >= maximumRetainedJobs)) {
      const expired = complete.shift(); await removeRetained(expired); expired.status = 'expired'; expired.phase = 'expired'; expired.message = '旧切片缓存已释放，请重新生成。';
      expired.result = null;
    }
    if (retainedBytes + required > maximumRetainedBytes) throw new SliceError(413, 'SLICE_CACHE_LIMIT', '完整切片结果超过本机缓存空间限制。');
  };
  const run = async job => {
    let completed = false;
    const timer = setTimeout(() => { job.timedOut = true; job.cancelled = true; stopChild(job); }, timeoutMs); timer.unref();
    const diskWatch = setInterval(async () => {
      if (job.status !== 'running' || job.cancelled) return;
      for (const name of ['plate_1.gcode', 'plate_1.gcode.tmp']) {
        try {
          if ((await stat(path.join(job.output, name))).size > maximumGcodeBytes) {
            job.resourceFailure = true; job.cancelled = true; stopChild(job);
          }
        } catch {}
      }
    }, 1000); diskWatch.unref();
    try {
      job.phase = 'preparing'; job.progress = 2; job.message = '保留原网格、涂色与切片参数，准备独立副本…';
      await process(job, pythonPath, [prepareScript, job.source, job.prepared, job.report, job.optionsPath]);
      if (job.cancelled) throw new SliceError(409, 'SLICE_CANCELLED', '真实切片已取消。');
      const report = JSON.parse(await readFile(job.report, 'utf8'));
      if (!Array.isArray(report.printerToSource) || report.printerToSource.length !== 16 || report.printerToSource.some(value => !Number.isFinite(value))) {
        throw new SliceError(500, 'SLICE_ALIGNMENT_MISSING', '切片副本缺少明确来源变换，拒绝猜测模型对齐。');
      }
      const embedded = !!report.embeddedGcode;
      const engine = embedded ? 'original embedded G-code' : job.engineCapability.engine;
      let outputFile;
      if (embedded) {
        if (report.embeddedGcode.file !== 'embedded.gcode') throw new SliceError(500, 'SLICE_EMBEDDED_PATH_INVALID', '原切片缓存路径无效。');
        job.phase = 'extracting-source'; job.progress = 10; job.message = '读取工程中已保存的原始完整切片，不重新切片…';
        outputFile = path.join(job.directory, 'embedded.gcode');
      } else {
        if (!job.engineCapability.available) throw new SliceError(503, 'SLICE_SLICER_UNAVAILABLE', '未找到可用的本机切片器。');
        job.phase = 'slicing'; job.progress = 10; job.message = '本机正在计算真实内外墙、填充与耗材路径…';
        await mkdir(job.output, { mode: 0o700 });
        const profile = report.fallbackEngineProfiles;
        const profileArguments = [
          ...(profile?.loadSettings?.length ? ['--load-settings', profile.loadSettings.join(';')] : []),
          ...(profile?.loadFilaments?.length ? ['--load-filaments', profile.loadFilaments.join(';')] : []),
        ];
        await process(job, job.engineCapability.executablePath || slicerPath, [
          ...(job.engineCapability.id === 'bambu' ? [] : ['--datadir', path.join(job.directory, 'profile')]),
          '--debug', '3', '--no-check', ...profileArguments,
          '--slice', '1', '--arrange', '0', '--orient', '0', '--mstpp', String(Math.max(1, Math.min(600, Math.ceil(timeoutMs / 1000)))), '--outputdir', job.output, job.prepared]);
        if (job.cancelled) throw new SliceError(409, 'SLICE_CANCELLED', '真实切片已取消。');
        const names = await readdir(job.output);
        if (!names.includes('plate_1.gcode')) throw new SliceError(500, 'SLICE_OUTPUT_MISSING', '切片器没有输出第 1 盘模型路径；请使用保存于第 1 盘的工程。');
        outputFile = path.join(job.output, 'plate_1.gcode');
      }
      job.phase = 'indexing'; job.progress = 90; job.message = '完整保留真实路径，校验层索引和参数来源…';
      job.nativeProgress = null; job.total = (await stat(outputFile)).size; job.unit = 'bytes';
      const index = await indexSliceGCode(outputFile, { maximumBytes: maximumGcodeBytes, isCancelled: () => job.cancelled,
        onProgress: fraction => { job.completed = Math.round(job.total * fraction); job.progress = 90 + Math.min(9, fraction * 9); } });
      if (job.cancelled) throw new SliceError(409, 'SLICE_CANCELLED', '真实切片已取消。');
      if (embedded && (index.gcodeSha256 !== report.embeddedGcode.sha256 || index.gcodeBytes !== report.embeddedGcode.bytes)) {
        throw new SliceError(500, 'SLICE_EMBEDDED_CHANGED', '原工程的完整切片提取后校验不一致。');
      }
      const sliceSettings = normalizeSliceSettings(embedded ? index.rawConfiguration : report.rawSettings ?? index.rawConfiguration, { preset: job.options.preset,
        objects: report.objectSettings || {}, source: embedded ? 'gcode-config' : report.sourceType === 'stl' ? 'bambu-default-staged' : 'project' });
      sliceSettings.exactToolpaths = true; sliceSettings.colorResolution = 'actual-gcode-tool';
      // A field absent in the imported project must retain its fallback
      // provenance even after staging wrote the value into a full profile.
      for (const [name, field] of Object.entries(sliceSettings.fields)) {
        const known = report.fieldSources?.[field.key];
        if (!embedded && ['bambu-default', 'studio-default'].includes(known?.source)) sliceSettings.fields[name] = { ...field, source: known.source, profile: known.profile, version: known.version, commit: known.commit, ...(known.defaultPolicy ? { defaultPolicy: known.defaultPolicy } : {}) };
      }
      sliceSettings.usesFallback = Object.values(sliceSettings.fields).some(field => ['bambu-default', 'studio-default'].includes(field.source));
      const intendedPalette = embedded && !report.sourcePaletteSaved ? [] : normalizeSliceSettings(report.rawSettings || {}, { preset: job.options.preset }).filaments.map(filament => filament.color);
      const actualSettings = normalizeSliceSettings(index.rawConfiguration, { preset: job.options.preset, source: 'actual-gcode-config' });
      const actualPalette = actualSettings.filaments.map(filament => filament.color);
      const palette = actualPalette.length && actualPalette.every(color => /^#[\da-f]{6}$/i.test(color)) ? actualPalette : null;
      if (!palette && intendedPalette.length) throw new SliceError(500, 'SLICE_PALETTE_MISSING', '真实切片未保存完整耗材颜色；不会用猜测的单色替代原色。');
      if (palette && intendedPalette.some((color, tool) => color && color !== palette[tool])) {
        throw new SliceError(500, 'SLICE_PALETTE_MISMATCH', '真实切片耗材槽位或颜色与导入工程不一致，拒绝采用变色结果。');
      }
      const toolColors = palette || job.options.toolColors;
      report.actualOutput = { gcodeSha256: index.gcodeSha256, gcodeBytes: index.gcodeBytes, layerCount: index.layerCount,
        completeFileRetained: true, geometrySimplified: false, visualizationOnly: true, engine, reSliced: !embedded };
      report.slicingEngine = engine;
      report.engineId = job.engineCapability.id; report.engineRevision = job.engineCapability.engineRevision;
      report.sliceSettings = sliceSettings;
      report.actualGCodeSettings = actualSettings;
      report.toolColors = toolColors;
      const manifest = { ...index, rawConfiguration: undefined, sourceSha256: report.sourceSha256, printerToSource: report.printerToSource,
        sourceUnits: report.sourceUnits, sourceCoordinateSystem: report.sourceCoordinateSystem, stagingTransform: report.stagingTransform,
        toolColors, sliceSettings, engine, engineId: job.engineCapability.id, engineRevision: job.engineCapability.engineRevision,
        plateCount: report.plateCount || 1, slicePlate: 1, reSliced: !embedded, visualizationOnly: true };
      await writeFile(job.report, JSON.stringify(report, null, 2), { mode: 0o600 });
      await writeFile(job.manifest, JSON.stringify(manifest), { flag: 'wx', mode: 0o600 });
      await rename(outputFile, job.gcode); await chmod(job.gcode, 0o600);
      const reportBytes = (await stat(job.report)).size, manifestBytes = (await stat(job.manifest)).size;
      const required = index.gcodeBytes + reportBytes + manifestBytes;
      await prune(required);
      job.retainedBytes = required; retainedBytes += required;
      job.result = { gcodeUrl: `/api/slices/${job.id}/gcode`, provenanceUrl: `/api/slices/${job.id}/provenance`, manifestUrl: `/api/slices/${job.id}/manifest`,
        sourceSha256: report.sourceSha256, gcodeSha256: index.gcodeSha256, gcodeBytes: index.gcodeBytes, layerCount: index.layerCount,
        printerToSource: report.printerToSource, stagingTransform: report.stagingTransform, toolColors, sliceSettings,
        sourceUnits: report.sourceUnits, sourceCoordinateSystem: report.sourceCoordinateSystem,
        completeFileRetained: true, geometrySimplified: false, visualizationOnly: true, engine,
        engineId: job.engineCapability.id, engineRevision: job.engineCapability.engineRevision,
        plateCount: report.plateCount || 1, slicePlate: 1, reSliced: !embedded };
      completed = true; job.finishedAt = Date.now();
      job.message = `真实切片已完成，共 ${index.layerCount.toLocaleString('zh-CN')} 层，完整路径与原色已保留。`;
    } catch (error) {
      job.errorCode = job.timedOut ? 'SLICE_TIMEOUT' : job.resourceFailure ? 'SLICE_OUTPUT_TOO_LARGE' : error.code || 'SLICE_FAILED';
      job.message = job.timedOut ? '真实切片计算超时；没有采用不完整路径。' : job.resourceFailure ? '完整切片结果超过处理限制；没有截断路径。' : error.message;
    } finally {
      clearTimeout(timer); clearInterval(diskWatch);
      for (const name of ['source.3mf', 'source.stl', 'prepared.3mf', 'embedded.gcode', 'options.json', 'fallback-machine.json', 'fallback-process.json', 'fallback-filament.json', 'profile', 'output']) {
        await rm(path.join(job.directory, name), { recursive: true, force: true }).catch(() => {});
      }
      for (const name of await readdir(job.directory).catch(() => [])) if (/^fallback-filament-\d+\.json$/.test(name)) await rm(path.join(job.directory, name), { force: true });
      if (completed && !job.cancelled) { job.status = 'complete'; job.phase = 'complete'; job.progress = 100; }
      else {
        await removeRetained(job).catch(() => {});
        job.status = job.cancelled && !job.timedOut && !job.resourceFailure ? 'cancelled' : 'failed'; job.phase = job.status;
        if (job.status === 'cancelled') job.message = '真实切片已取消。';
      }
      if (active === job) active = null;
    }
  };
  const create = async (input, options = {}) => {
    const resume = () => input?.resume?.();
    if (closed) { resume(); throw new SliceError(503, 'SERVER_CLOSING', '工具正在关闭。'); }
    let safe;
    try { safe = validateSliceOptions(options); } catch (error) { resume(); throw error; }
    if (active || reservation) { resume(); throw new SliceError(409, 'SLICE_BUSY', '已有真实切片正在计算；完成或取消后可重新生成。'); }
    reservation = true;
    try {
      const capabilities = await health();
      const selected = safe.engineId === 'auto' ? capabilities : await engineProbe({ engineId: safe.engineId, slicerPath: slicerPaths[safe.engineId] || slicerPath });
      if ((!selected.available || !capabilities.embeddedAvailable) && !(forceReslice === false && safe.format === '3mf' && capabilities.embeddedAvailable)) { resume(); throw new SliceError(503, 'SLICE_SLICER_UNAVAILABLE', selected.reason || '未找到可用的本机切片器。'); }
      if (closed) { resume(); throw new SliceError(503, 'SERVER_CLOSING', '工具正在关闭。'); }
      const id = randomUUID(), jobDirectory = path.join(directory, id);
      const job = { id, options: safe, directory: jobDirectory, source: path.join(jobDirectory, `source.${safe.format}`),
        diagnosticsDirectory: path.join(diagnosticsRoot, id),
        prepared: path.join(jobDirectory, 'prepared.3mf'), report: path.join(jobDirectory, 'source.json'), manifest: path.join(jobDirectory, 'manifest.json'),
        gcode: path.join(jobDirectory, 'full.gcode'), output: path.join(jobDirectory, 'output'), optionsPath: path.join(jobDirectory, 'options.json'),
        engineCapability: { id: selected.id || selected.engineId || 'bambu', ...selected },
        status: 'running', phase: 'uploading', progress: 0, message: '正在读取完整模型…', cancelled: false, retainedBytes: 0 };
      active = job;
      let uploadTimer;
      try {
        await mkdir(jobDirectory, { recursive: true, mode: 0o700 }); await chmod(jobDirectory, 0o700);
        await writeFile(job.optionsPath, JSON.stringify({ ...safe, engineId: job.engineCapability.id, profileVendor: job.engineCapability.profileVendor || 'BBL',
          slicerResources: job.engineCapability.profileDirectory, forceReslice, maximumGcodeBytes }), { flag: 'wx', mode: 0o600 });
        uploadTimer = setTimeout(() => { job.uploadTimedOut = true; job.cancelled = true; job.abortUpload?.(); }, uploadTimeoutMs); uploadTimer.unref();
        job.upload = receive(input, job.source, job, safe.format === '3mf' ? maximumProjectBytes : maximumStlBytes);
        await job.upload;
        clearTimeout(uploadTimer);
        if (closed || job.cancelled) throw new SliceError(409, 'SLICE_CANCELLED', job.uploadTimedOut ? '模型上传超时。' : '真实切片已取消。');
        jobs.set(id, job); job.completion = run(job);
        return { id };
      } catch (error) {
        clearTimeout(uploadTimer); await removeRetained(job).catch(() => {});
        if (active === job) active = null;
        throw error;
      }
    } finally { reservation = false; }
  };
  const cancel = async id => {
    const job = get(id); job.cancelled = true; job.abortUpload?.(); stopChild(job);
    await job.completion; await removeRetained(job).catch(() => {});
    job.status = 'cancelled'; job.phase = 'cancelled'; job.progress = 0; job.message = '真实切片已取消。';
    if (active === job) active = null;
    return { cancelled: true };
  };
  const ensureComplete = id => { const job = get(id); if (job.status !== 'complete') throw new SliceError(409, 'SLICE_NOT_FINISHED', job.message); return job; };
  const gcodeFile = async id => { const job = ensureComplete(id); await stat(job.gcode); return job.gcode; };
  const file = async id => { const job = ensureComplete(id); await stat(job.manifest); return job.manifest; };
  const provenance = async id => JSON.parse(await readFile(ensureComplete(id).report, 'utf8'));
  const close = async () => {
    closed = true;
    if (active && !jobs.has(active.id)) { active.cancelled = true; active.abortUpload?.(); await active.upload?.catch(() => {}); }
    await Promise.all([...jobs.keys()].map(id => cancel(id)));
    await Promise.all([...diagnostics.values()].map(item => rm(item.directory, { recursive: true, force: true })));
    diagnostics.clear();
    await rmdir(diagnosticsRoot).catch(error => { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; });
    // Other service instances can own different UUIDs under this root. Never
    // recursively erase their running or completed inputs/results.
    await rmdir(directory).catch(error => { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; });
  };
  return { create, snapshot, cancel, gcodeFile, fullGcode: gcodeFile, file, provenance, health, close };
}
