import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { findBlenderPath, findFFmpegPath, findPythonPath, resolveExecutablePath } from '../runtime-paths.mjs';
import { resolvePhotoCalibrationRuntime } from '../photo-calibration.mjs';
import { probeLocalSlicers } from '../slicer-engine.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const execute = promisify(execFile);
async function probe(filename, args) {
  const resolved = resolveExecutablePath(filename);
  if (!resolved) return { available: false, path: filename };
  try {
    const { stdout, stderr } = await execute(resolved, args, { shell: false, timeout: 5_000, maxBuffer: 256 * 1024, windowsHide: true });
    return { available: true, path: resolved, version: (stdout || stderr).split('\n').find(line => line.trim())?.trim() || '' };
  } catch { return { available: false, path: resolved }; }
}

const [python, ffmpeg, blender, opencv, slicers] = await Promise.all([
  probe(findPythonPath(), ['--version']), probe(findFFmpegPath(), ['-version']),
  probe(findBlenderPath({ root }), ['--version']), resolvePhotoCalibrationRuntime({ root }),
  probeLocalSlicers({ timeoutMs: 5_000 }),
]);
const nodeSupported = Number(process.versions.node.split('.')[0]) >= 22;
python.available &&= /^Python 3\./.test(python.version);
console.log(`${nodeSupported ? 'OK' : '缺少'} Node.js ${process.versions.node}（需要 22 或更新版本，推荐 24 LTS）`);
console.log(`${python.available ? 'OK' : '缺少'} Python 3：${python.available ? python.version : '安装 Python 3 或设置 PYTHON_PATH；真实切片需要它。'}`);
console.log(`${ffmpeg.available ? 'OK' : '可选'} FFmpeg：${ffmpeg.available ? ffmpeg.version : '安装 FFmpeg 或设置 FFMPEG_PATH；未安装仍可导出 PNG 序列。'}`);
console.log(`${blender.available ? 'OK' : '可选'} Blender：${blender.available ? blender.version : '安装 Blender 或设置 BLENDER_PATH；未安装仍可使用实时预览与导出。'}`);
console.log(`${opencv ? 'OK' : '可选'} OpenCV：${opencv ? opencv.version : '为 Python 安装 opencv-python/numpy；未安装仍可手动标记照片竖线。'}`);
const engines = slicers.engines || slicers;
const availableSlicers = (Array.isArray(engines) ? engines : Object.values(engines)).filter(engine => engine?.available);
console.log(`${availableSlicers.length ? 'OK' : '缺少'} 切片软件：${availableSlicers.length ? availableSlicers.map(engine => engine.label || engine.engine).join('、') : '原始模型导入需要兼容切片器，请安装 Bambu Studio、OrcaSlicer 或兼容 Flash Studio。'}`);
console.log('检测只读取本机环境，不安装或下载运行时。');
if (!nodeSupported || !python.available || !availableSlicers.length) process.exitCode = 1;
