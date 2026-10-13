import { freeWatermarkArguments } from './free-watermark.mjs';
import { constants, createWriteStream } from 'node:fs';
import { access, chmod, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { movAlphaEncoderArguments, probeMovAlphaEncoder } from './export-codecs.mjs';
import { findBlenderPath, findFFmpegPath, resolveExecutablePath } from './runtime-paths.mjs';
import { inflateRawSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Zip, ZipPassThrough, strToU8 } from 'three/addons/libs/fflate.module.js';

const MODULE_ROOT = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(MODULE_ROOT, 'scripts', 'render-cycles.py');
export const REALISTIC_RENDER_LIMITS = Object.freeze({ maxUploadBytes: 536870912, maxUnpackedBytes: 536870912, maxConfigBytes: 262144, maxPhotoBytes: 67108864, maxFrames: 1800, maxPixels: 8388608, maxTriangles: 5000000, maxObjects: 4096, maxPendingFrames: 8, maxSequenceBytes: 536870912, maxOutputBytes: 2147483648, maxPrintSegments: 10000000, maxPrintLayers: 100000, maxPrintWindowSegments: 100000 });
export const REALISTIC_PREVIEW_LIMITS = Object.freeze({ maxWidth: 1600, maxHeight: 1600, maxPixels: 1600000, frames: 1, growthFrames: 1, fps: 1, samples: 64 });
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const TERMINAL = new Set(['complete', 'cancelled', 'error']);
const EXTENSIONS = new Set(['KHR_materials_pbrSpecularGlossiness', 'KHR_materials_unlit', 'KHR_texture_transform', 'KHR_materials_clearcoat', 'KHR_mesh_quantization', 'EXT_mesh_gpu_instancing', 'KHR_materials_variants', 'KHR_materials_emissive_strength', 'KHR_materials_transmission', 'KHR_materials_specular', 'KHR_materials_sheen', 'KHR_materials_ior', 'KHR_materials_volume', 'EXT_texture_webp', 'KHR_materials_anisotropy']);

export class RealisticRenderError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const invalid = message => { throw new RealisticRenderError(400, 'INVALID_RENDER_PACKAGE', message); };
const finite = (value, low, high, label, integer = false) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < low || value > high || integer && !Number.isInteger(value)) invalid(`${label}无效或超过高清渲染范围。`);
  return value;
};
const vector = (value, length, label, limit = 1000000) => {
  if (!Array.isArray(value) || value.length !== length) invalid(`${label}维度无效。`);
  return value.map(component => finite(component, -limit, limit, label));
};
const object = (value, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${label}须为对象。`);
  return value;
};
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index; for (let bit = 0; bit < 8; bit++) value = value >>> 1 ^ (value & 1 ? 0xedb88320 : 0); return value >>> 0;
});
const crc32 = buffer => { let value = 0xffffffff; for (const byte of buffer) value = crcTable[(value ^ byte) & 255] ^ value >>> 8; return (value ^ 0xffffffff) >>> 0; };

/** ZIP32 preflight happens before inflation; no uploaded pathname is used. */
export function unpackRenderPackage(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (bytes.length < 22 || bytes.length > REALISTIC_RENDER_LIMITS.maxUploadBytes) throw new RealisticRenderError(413, 'RENDER_PACKAGE_TOO_LARGE', '渲染数据为空或超过 512 MiB。');
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
    if (bytes.readUInt32LE(offset) === 0x06054b50 && offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length) { end = offset; break; }
  }
  if (end < 0) invalid('渲染数据不是完整的 ZIP。');
  const count = bytes.readUInt16LE(end + 10), start = bytes.readUInt32LE(end + 16), centralBytes = bytes.readUInt32LE(end + 12);
  if (bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6) || bytes.readUInt16LE(end + 8) !== count || count < 2 || count > 4 || start === 0xffffffff || start + centralBytes !== end) invalid('渲染包只允许模型、配置、真实切片和一张静态照片。');
  const names = new Set(['scene.glb', 'config.json', 'photo.png', 'photo.jpg', 'photo.jpeg', 'print-layer.bin']);
  const records = [], seen = new Set(); let total = 0, offset = start;
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) invalid('ZIP 索引损坏。');
    const flags = bytes.readUInt16LE(offset + 8), compression = bytes.readUInt16LE(offset + 10), crc = bytes.readUInt32LE(offset + 16), size = bytes.readUInt32LE(offset + 20), rawSize = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28), extraLength = bytes.readUInt16LE(offset + 30), commentLength = bytes.readUInt16LE(offset + 32), localOffset = bytes.readUInt32LE(offset + 42);
    const next = offset + 46 + nameLength + extraLength + commentLength;
    if (next > end || flags & 1 || ![0, 8].includes(compression) || [size, rawSize, localOffset].includes(0xffffffff)) invalid('ZIP 的压缩方式或加密格式不受支持。');
    const name = bytes.toString('utf8', offset + 46, offset + 46 + nameLength);
    const unixMode = bytes.readUInt32LE(offset + 38) >>> 16;
    if (!names.has(name) || seen.has(name) || unixMode & 0xf000 && (unixMode & 0xf000) !== 0x8000 || bytes.readUInt16LE(offset + 34)) invalid('渲染包含重复文件、路径穿越或非普通文件。');
    seen.add(name); total += rawSize;
    const maximum = name === 'config.json' ? REALISTIC_RENDER_LIMITS.maxConfigBytes : name.startsWith('photo.') ? REALISTIC_RENDER_LIMITS.maxPhotoBytes : REALISTIC_RENDER_LIMITS.maxUnpackedBytes;
    if (!rawSize || rawSize > maximum || total > REALISTIC_RENDER_LIMITS.maxUnpackedBytes || rawSize > Math.max(size * 2000, 1048576)) throw new RealisticRenderError(413, 'RENDER_PACKAGE_EXPANSION_LIMIT', '渲染包展开后过大，不能自动减面或删除照片。');
    if (localOffset + 30 > start || bytes.readUInt32LE(localOffset) !== 0x04034b50 || bytes.readUInt16LE(localOffset + 6) !== flags || bytes.readUInt16LE(localOffset + 8) !== compression) invalid('ZIP 文件头损坏。');
    const localNameLength = bytes.readUInt16LE(localOffset + 26), localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    if (bytes.toString('utf8', localOffset + 30, localOffset + 30 + localNameLength) !== name || dataStart + size > start) invalid('ZIP 文件内容位置无效。');
    records.push({ name, start: localOffset, dataStart, end: dataStart + size, size, rawSize, compression, crc }); offset = next;
  }
  if (offset !== end || !seen.has('scene.glb') || !seen.has('config.json') || [...seen].filter(name => name.startsWith('photo.')).length > 1) invalid('渲染包缺少模型或配置。');
  const sorted = [...records].sort((a, b) => a.start - b.start);
  if (sorted.some((record, index) => index > 0 && record.start < sorted[index - 1].end)) invalid('ZIP 文件内容重叠。');
  const files = {};
  for (const record of records) {
    let data;
    try { data = record.compression === 0 ? bytes.subarray(record.dataStart, record.end) : inflateRawSync(bytes.subarray(record.dataStart, record.end), { maxOutputLength: record.rawSize }); }
    catch { invalid('ZIP 展开失败或超过声明大小。'); }
    if (data.length !== record.rawSize || crc32(data) !== record.crc) invalid('渲染包校验失败，请重新导出。');
    files[record.name] = data;
  }
  return files;
}

function validatePNG(bytes, width, height, { alpha = false } = {}) {
  if (bytes.length < 45 || !bytes.subarray(0, 8).equals(PNG) || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') invalid('渲染帧不是完整 PNG。');
  if (bytes.readUInt32BE(16) !== width || bytes.readUInt32BE(20) !== height) invalid('渲染帧的尺寸与导出设置不一致。');
  let offset = 8, ended = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset), next = offset + 12 + length;
    if (next > bytes.length) break;
    if (bytes.toString('ascii', offset + 4, offset + 8) === 'IEND') { ended = length === 0 && next === bytes.length; break; }
    offset = next;
  }
  if (!ended) invalid('PNG 画面未完整写入。');
  if (alpha && ![4, 6].includes(bytes[25])) invalid('透明 MOV 的渲染帧必须保留 PNG 透明通道。');
}

function rasterDimensions(bytes, mime) {
  let width, height;
  if (mime === 'image/png' && bytes.length >= 24 && bytes.subarray(0, 8).equals(PNG)) {
    width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20);
  } else if (mime === 'image/jpeg' && bytes[0] === 255 && bytes[1] === 216) {
    let offset = 2;
    while (offset < bytes.length) {
      if (bytes[offset++] !== 255) break;
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 217 || marker === 218) break;
      if (marker === 1 || marker >= 208 && marker <= 215) continue;
      if (offset + 2 > bytes.length) break;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker) && length >= 8) { height = bytes.readUInt16BE(offset + 3); width = bytes.readUInt16BE(offset + 5); break; }
      offset += length;
    }
  } else if (mime === 'image/webp' && bytes.length >= 25 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    const kind = bytes.toString('ascii', 12, 16);
    if (kind === 'VP8X' && bytes.length >= 30) { width = bytes.readUIntLE(24, 3) + 1; height = bytes.readUIntLE(27, 3) + 1; }
    else if (kind === 'VP8L' && bytes[20] === 47) { const bits = bytes.readUInt32LE(21); width = (bits & 16383) + 1; height = (bits >>> 14 & 16383) + 1; }
    else if (kind === 'VP8 ' && bytes.length >= 30 && bytes[23] === 157 && bytes[24] === 1 && bytes[25] === 42) { width = bytes.readUInt16LE(26) & 16383; height = bytes.readUInt16LE(28) & 16383; }
  }
  if (![width, height].every(value => Number.isInteger(value) && value > 0 && value <= 8192)) invalid('嵌入照片或贴图尺寸无效或超过 8192 像素，不能自动缩小丢失细节。');
  return { width, height };
}

export function validateRenderConfig(input, files, { preview = false } = {}) {
  object(input, '渲染配置');
  if (input.schemaVersion !== 1 || input.coordinateSystem !== 'three-y-up' || input.scene !== 'scene.glb' || input.matrixConvention && input.matrixConvention !== 'column-major-column-vectors') invalid('渲染包版本或坐标约定不受支持。');
  const output = object(input.output, '导出设置');
  if (output.directory !== 'frames') invalid('输出目录必须是固定的 frames。');
  const width = finite(output.width, 64, 4096, '导出宽度', true), height = finite(output.height, 64, 4096, '导出高度', true);
  if (width % 2 || height % 2 || width * height > REALISTIC_RENDER_LIMITS.maxPixels) invalid('导出宽高须为偶数，且不能超过 8388608 像素。');
  finite(output.fps, 1, 60, '帧率', true); finite(output.frames, 1, REALISTIC_RENDER_LIMITS.maxFrames, '总帧数', true); finite(output.growthFrames, 1, output.frames, '生长帧数', true);
  if (output.durationSeconds !== undefined || output.growthSeconds !== undefined) {
    finite(output.durationSeconds, 0.01, 610, '视频用时'); finite(output.growthSeconds, 0.01, output.durationSeconds, '生长用时');
    if (Math.round(output.durationSeconds * output.fps) !== output.frames) invalid('视频用时与帧数不一致。');
  }
  if (![64, 128].includes(output.samples)) invalid('采样只支持 64 或 128。');
  if (preview) {
    finite(output.previewProgress, 0, 1, '预览生长进度');
    if (output.durationSeconds !== undefined || output.growthSeconds !== undefined || width > REALISTIC_PREVIEW_LIMITS.maxWidth || height > REALISTIC_PREVIEW_LIMITS.maxHeight || width * height > REALISTIC_PREVIEW_LIMITS.maxPixels || ['frames', 'growthFrames', 'fps', 'samples'].some(key => output[key] !== REALISTIC_PREVIEW_LIMITS[key])) invalid('写实预览只支持 160 万像素以内、64 采样的单张画面。');
  } else if (Object.hasOwn(output, 'previewProgress')) invalid('视频导出不能包含单张预览进度。');
  const camera = object(input.camera, '镜头'); vector(camera.position, 3, '镜头位置'); const quaternion = vector(camera.quaternion, 4, '镜头旋转');
  if (Math.abs(quaternion.reduce((sum, value) => sum + value * value, 0) - 1) > 0.01) invalid('镜头旋转四元数必须归一化。');
  finite(camera.fov, 3, 145, '镜头视野'); finite(camera.aspect, 0.001, 1000, '镜头比例'); finite(camera.near, 1e-9, 1000, '镜头近端'); finite(camera.far, camera.near + 1e-9, 1000000, '镜头远端');
  const projection = vector(camera.projectionMatrix, 16, '镜头投影');
  if (projection[0] <= 0 || projection[5] <= 0 || Math.abs(projection[11] + 1) > 1e-6 || Math.abs(projection[15]) > 1e-6) invalid('镜头须为有效透视投影。');
  if (camera.effectiveSensorHeightMm !== undefined || camera.physicalFocalLengthMm !== undefined) {
    const sensor = finite(camera.effectiveSensorHeightMm, .001, 100, '有效传感器高度'), lens = finite(camera.physicalFocalLengthMm, .001, 10000, '物理等效镜头');
    if (Math.abs(2 * lens / sensor - projection[5]) > 1e-6) invalid('镜头和数字裁剪传感器与实际投影不一致。');
  }
  const plane = object(input.plane, '承影底板'); finite(plane.widthM, 0.0001, 100, '底板宽度'); finite(plane.depthM, 0.0001, 100, '底板深度'); finite(plane.yM, -100, 100, '底板高度');
  const bounds = object(input.bounds, '模型范围'); const min = vector(bounds.min, 3, '模型下界', 100), max = vector(bounds.max, 3, '模型上界', 100);
  finite(bounds.minY, -100, 100, '模型底部'); finite(bounds.maxY, bounds.minY + 1e-10, 100, '模型顶部');
  if (min.some((value, index) => value > max[index]) || Math.abs(min[1] - bounds.minY) > 1e-6 || Math.abs(max[1] - bounds.maxY) > 1e-6) invalid('模型生长范围与完整姿态不一致。');
  for (const label of ['lighting', 'grading', 'surface', 'dof', 'growth', 'background']) object(input[label], label);
  if (input.growth.direction !== 'up' || input.grading.scope !== 'model-only') invalid('只支持从下往上生长及模型单独调色。');
  for (const label of ['lighting', 'grading', 'surface', 'dof', 'growth']) for (const value of Object.values(input[label])) {
    if (typeof value === 'number' && !Number.isFinite(value)) invalid('渲染参数包含非有限数值。');
  }
  if (input.surface.printCoordinatesMatrix) vector(input.surface.printCoordinatesMatrix, 16, '表面打印坐标');
  if (input.dof.fStop !== undefined) finite(input.dof.fStop, .7, 64, '光圈');
  if (input.surface.enabled) for (const key of ['layerHeightM', 'firstLayerHeightM', 'lineWidthM']) finite(input.surface[key], 1e-6, 0.01, '打印表面尺寸');
  if (input.background.type === 'photo') {
    if (!/^photo\.(png|jpe?g)$/.test(input.background.file) || !files[input.background.file] || input.background.canonical !== true || input.background.width !== width || input.background.height !== height) invalid('照片必须是当前画面的完整裁剪结果。');
    if (input.background.file === 'photo.png') validatePNG(files['photo.png'], width, height);
    const size = rasterDimensions(files[input.background.file], input.background.file.endsWith('.png') ? 'image/png' : 'image/jpeg');
    if (size.width !== width || size.height !== height) invalid('照片像素与当前输出裁剪尺寸不一致。');
  } else if (input.background.type !== 'color' || !/^#[\da-f]{6}$/i.test(input.background.color)) invalid('背景需为照片或标准颜色。');
  if (typeof input.background.transparent !== 'boolean') invalid('背景透明设置无效。');
  validateRenderPrintLayer(input.printLayer, files);
  // Canonicalize all path-bearing fields; no caller value reaches a command.
  return { ...input, scene: 'scene.glb', sceneFile: 'scene.glb', photoFile: input.background.type === 'photo' ? input.background.file : undefined, output: { ...output, directory: 'frames' } };
}

const PRINT_ARRAY_LAYOUT = Object.freeze({ positions: ['float32', 4, 6], tools: ['uint16', 2, 1], features: ['uint8', 1, 1], widths: ['float32', 4, 1], heights: ['float32', 4, 1], strokes: ['uint32', 4, 1], layers: ['uint32', 4, 1], layerHeights: ['float64', 8, 1], layerOffsets: ['uint32', 4, 1], layerSegments: ['uint32', 4, 1] });

/** Native importer preflight: every declared segment/layer/color is validated.
 * No unsupported roles, truncated spans, repeated/missing ids or inferred fit. */
export function validateRenderPrintLayer(input, files) {
  if (!input) { if (files['print-layer.bin']) invalid('真实切片二进制缺少配置。'); return null; }
  object(input, '真实切片');
  if (input.schemaVersion !== 1 || input.file !== 'print-layer.bin' || input.source !== 'sliced-gcode' || input.coordinates !== 'printer-mm-z-up' || input.endianness !== 'little' || input.exactLinearPaths !== true || input.originalPathsUnmodified !== true || !['stadium-with-elliptical-fallback', 'elliptical-bead-12-sides'].includes(input.crossSection)) invalid('真实切片版本或坐标约定无效。');
  const count = finite(input.segmentCount, 1, REALISTIC_RENDER_LIMITS.maxPrintSegments, '真实切片段数', true), layers = finite(input.layerCount, 1, REALISTIC_RENDER_LIMITS.maxPrintLayers, '真实切片层数', true);
  const history = finite(input.historyLayers, 1, 32, '显示打印层数', true);
  if (typeof input.includeSupport !== 'boolean') invalid('真实切片支撑设置无效。');
  finite(input.arcToleranceMm, 1e-6, .1, '圆弧误差');
  const matrix = vector(input.printerToMetres, 16, '真实切片坐标映射');
  const determinant = matrix[0] * (matrix[5] * matrix[10] - matrix[9] * matrix[6]) - matrix[4] * (matrix[1] * matrix[10] - matrix[9] * matrix[2]) + matrix[8] * (matrix[1] * matrix[6] - matrix[5] * matrix[2]);
  if (Math.abs(matrix[3]) + Math.abs(matrix[7]) + Math.abs(matrix[11]) > 1e-10 || Math.abs(matrix[15] - 1) > 1e-10 || Math.abs(determinant) < 1e-24) invalid('真实切片坐标映射须为可逆仿射矩阵。');
  if (!Array.isArray(input.palette) || !input.palette.length || input.palette.length > 256) invalid('真实切片耗材颜色表无效。');
  if (!['source-or-tool-overrides', 'uniform-display'].includes(input.colorMode) || input.colorMode === 'uniform-display' && !/^#[\da-f]{6}$/i.test(input.uniformColor)) invalid('真实切片渲染颜色模式无效。');
  const colors = new Set();
  for (const entry of input.palette) {
    object(entry, '耗材颜色'); finite(entry.tool, 0, 65535, '耗材工具', true);
    if (colors.has(entry.tool) || !/^#[\da-f]{6}$/i.test(entry.color)) invalid('真实切片耗材颜色缺失或重复。'); colors.add(entry.tool);
    if (input.colorMode === 'uniform-display' && entry.color.toLowerCase() !== input.uniformColor.toLowerCase()) invalid('统一渲染颜色与切片显示不一致。');
  }
  const binary = files['print-layer.bin'];
  if (!binary || !binary.length || binary.length > REALISTIC_RENDER_LIMITS.maxUnpackedBytes) invalid('完整真实切片二进制缺失或过大。');
  object(input.arrays, '真实切片数据布局');
  if (Object.keys(input.arrays).length !== Object.keys(PRINT_ARRAY_LAYOUT).length) invalid('真实切片数据布局不完整。');
  const data = new DataView(binary.buffer, binary.byteOffset, binary.byteLength), arrays = {};
  let size = 0;
  for (const [name, [type, componentSize, itemSize]] of Object.entries(PRINT_ARRAY_LAYOUT)) {
    const spec = object(input.arrays[name], '真实切片 '+name), expected = name === 'layerHeights' ? layers : name === 'layerOffsets' ? layers + 1 : count;
    size = Math.ceil(size / 8) * 8;
    if (spec.type !== type || spec.itemSize !== itemSize || spec.count !== expected || spec.byteOffset !== size || spec.byteLength !== expected * itemSize * componentSize || size + spec.byteLength > binary.length) invalid('真实切片属性跨度与完整段数不一致。');
    const read = { float32: 'getFloat32', float64: 'getFloat64', uint32: 'getUint32', uint16: 'getUint16', uint8: 'getUint8' }[type];
    arrays[name] = index => data[read](spec.byteOffset + index * componentSize, true); size += spec.byteLength;
  }
  if (size !== binary.length || arrays.layerOffsets(0) !== 0 || arrays.layerOffsets(layers) !== count) invalid('真实切片字节数或层索引不完整。');
  const seen = new Uint8Array(count), activePrefix = new Uint32Array(layers + 1); let maxWindowSegments = 0;
  for (let layer = 0; layer < layers; layer++) {
    const z = arrays.layerHeights(layer), first = arrays.layerOffsets(layer), end = arrays.layerOffsets(layer + 1);
    if (!Number.isFinite(z) || Math.abs(z) > 1e7 || layer && z <= arrays.layerHeights(layer - 1) || first >= end || end > count) invalid('真实切片层高或索引无效。');
    let active = 0;
    for (let index = first; index < end; index++) {
      const segment = arrays.layerSegments(index);
      if (segment >= count || seen[segment] || arrays.layers(segment) !== layer) invalid('真实切片层段索引遗漏、重复或越界。'); seen[segment] = 1;
      const feature = arrays.features(segment);
      if (feature >= 1 && feature <= 9 || feature === 16 || input.includeSupport && (feature === 10 || feature === 11)) active++;
      if (Math.abs(Math.max(arrays.positions(segment * 6 + 2), arrays.positions(segment * 6 + 5)) - z) > .0003) invalid('真实切片段与实际层高不一致。');
    }
    activePrefix[layer + 1] = activePrefix[layer] + active;
    maxWindowSegments = Math.max(maxWindowSegments, activePrefix[layer + 1] - activePrefix[Math.max(0, layer - history + 1)]);
  }
  if (input.maxWindowSegments !== maxWindowSegments || maxWindowSegments > REALISTIC_RENDER_LIMITS.maxPrintWindowSegments) invalid('真实切片层窗超过完整渲染预算；不会删减填充。');
  let modelSegments = 0, supportSegments = 0;
  for (let segment = 0; segment < count; segment++) {
    const feature = arrays.features(segment), model = feature >= 1 && feature <= 9 || feature === 16, support = feature === 10 || feature === 11;
    if (!colors.has(arrays.tools(segment)) || !model && !support) invalid('真实切片缺少耗材颜色或包含未支持模型用途。');
    if (model) modelSegments++; else supportSegments++;
    finite(arrays.widths(segment), 1e-6, 100, '真实线宽'); finite(arrays.heights(segment), 1e-6, 100, '真实层高');
    for (let axis = 0; axis < 6; axis++) finite(arrays.positions(segment * 6 + axis), -1e7, 1e7, '实际打印坐标');
    if (Math.hypot(arrays.positions(segment * 6 + 3) - arrays.positions(segment * 6), arrays.positions(segment * 6 + 4) - arrays.positions(segment * 6 + 1)) < 1e-10) invalid('真实切片包含零长度模型挤出。');
  }
  if (input.modelSegments !== modelSegments || input.supportSegments !== supportSegments || !modelSegments) invalid('真实模型与支撑段数不一致。');
  if (input.includeSupport && supportSegments) invalid('高清暂不能完整重建全部历史支撑，请关闭显示支撑或使用实时画质；不会省略。');
  return { segments: count, layers, maxWindowSegments };
}

export function validateRenderGLB(bytes) {
  if (!bytes || bytes.length < 28 || bytes.toString('ascii', 0, 4) !== 'glTF' || bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.length || bytes.toString('ascii', 16, 20) !== 'JSON') invalid('模型不是完整的 GLB 2.0。');
  const jsonLength = bytes.readUInt32LE(12);
  if (!jsonLength || jsonLength > 67108864 || jsonLength % 4 || 20 + jsonLength + 8 > bytes.length) invalid('GLB 配置大小或结构无效。');
  let gltf; try { gltf = JSON.parse(bytes.toString('utf8', 20, 20 + jsonLength).trim()); } catch { invalid('GLB 配置不是有效 JSON。'); }
  const binStart = 28 + jsonLength, binLength = bytes.readUInt32LE(20 + jsonLength);
  if (bytes.toString('ascii', 24 + jsonLength, 28 + jsonLength) !== 'BIN\0' || binStart + binLength !== bytes.length || gltf.asset?.version !== '2.0') invalid('GLB 必须完整嵌入网格数据。');
  if (!Array.isArray(gltf.buffers) || gltf.buffers.length !== 1 || gltf.buffers[0].uri || !Number.isInteger(gltf.buffers[0].byteLength) || gltf.buffers[0].byteLength > binLength || gltf.buffers[0].byteLength < binLength - 3) invalid('GLB 不允许外部数据文件。');
  for (const extension of new Set([...(gltf.extensionsUsed || []), ...(gltf.extensionsRequired || [])])) if (!EXTENSIONS.has(extension)) invalid(`离线导入器无法完整保留 ${String(extension).slice(0, 80)}，请使用实时导出。`);
  const accessors = gltf.accessors || [], views = gltf.bufferViews || [], meshes = gltf.meshes || [], nodes = gltf.nodes || [];
  if (!Array.isArray(accessors) || accessors.length > 50000 || !Array.isArray(views) || views.length > 50000 || !Array.isArray(meshes) || !meshes.length || meshes.length > 4096 || !Array.isArray(nodes) || nodes.length > 16384) invalid('GLB 对象数量超过完整渲染范围。');
  for (const view of views) {
    if (view.buffer !== 0 || !Number.isInteger(view.byteOffset ?? 0) || !Number.isInteger(view.byteLength) || (view.byteOffset ?? 0) < 0 || view.byteLength < 1 || (view.byteOffset ?? 0) + view.byteLength > gltf.buffers[0].byteLength) invalid('GLB 数据区域无效。');
  }
  const componentSizes = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
  const typeComponents = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
  let decodedAttributeBytes = 0;
  for (const accessor of accessors) {
    if (!Number.isInteger(accessor.count) || accessor.count < 1 || accessor.count > 15000000 || !Number.isInteger(accessor.bufferView) || !views[accessor.bufferView] || accessor.sparse) invalid('GLB 网格属性无效或含不支持的稀疏数据。');
    const componentSize = componentSizes[accessor.componentType], components = typeComponents[accessor.type], view = views[accessor.bufferView], localOffset = accessor.byteOffset ?? 0;
    if (!componentSize || !components || !Number.isInteger(localOffset) || localOffset < 0 || localOffset % componentSize || accessor.normalized !== undefined && typeof accessor.normalized !== 'boolean' || accessor.normalized && accessor.componentType === 5126) invalid('GLB 属性类型或字节偏移无效。');
    const columns = accessor.type.startsWith('MAT') ? Number(accessor.type.slice(3)) : 0;
    const itemBytes = columns ? columns * Math.ceil(columns * componentSize / 4) * 4 : components * componentSize;
    const stride = view.byteStride ?? itemBytes;
    if (!Number.isInteger(stride) || stride < itemBytes || view.byteStride !== undefined && (stride < 4 || stride > 252 || stride % componentSize) || localOffset + (accessor.count - 1) * stride + itemBytes > view.byteLength) invalid('GLB 属性声明超过实际数据范围。');
    decodedAttributeBytes += accessor.count * components * 4;
    if (decodedAttributeBytes > REALISTIC_RENDER_LIMITS.maxUnpackedBytes) invalid('GLB 属性展开超过 512 MiB，请使用实时导出；不会自动减面。');
    if (accessor.min) vector(accessor.min, components, 'GLB 属性下界', 1e10);
    if (accessor.max) vector(accessor.max, components, 'GLB 属性上界', 1e10);
  }
  const perMesh = meshes.map(mesh => {
    if (!Array.isArray(mesh.primitives) || !mesh.primitives.length) invalid('GLB 缺少三角面。');
    return mesh.primitives.reduce((sum, primitive) => {
      if (primitive.mode !== undefined && primitive.mode !== 4) invalid('高清只接受三角网格，不会静默替换路径或点云。');
      const positions = accessors[primitive.attributes?.POSITION];
      if (!positions || positions.type !== 'VEC3') invalid('GLB 缺少完整三维顶点位置。');
      if (primitive.indices !== undefined && (!accessors[primitive.indices] || accessors[primitive.indices].type !== 'SCALAR' || ![5121, 5123, 5125].includes(accessors[primitive.indices].componentType))) invalid('GLB 三角索引类型无效。');
      const accessor = accessors[primitive.indices ?? primitive.attributes?.POSITION];
      if (!accessor || accessor.count % 3) invalid('GLB 三角索引无效。');
      return sum + accessor.count / 3;
    }, 0);
  });
  let objects = 0, triangles = 0;
  for (const node of nodes) {
    for (const [key, count] of [['matrix', 16], ['translation', 3], ['rotation', 4], ['scale', 3]]) if (node[key]) vector(node[key], count, 'GLB 节点变换', 1e10);
    if (node.mesh === undefined) continue;
    if (!Number.isInteger(node.mesh) || !meshes[node.mesh]) invalid('GLB 节点引用无效。');
    const attributes = node.extensions?.EXT_mesh_gpu_instancing?.attributes; let instances = 1;
    if (attributes) {
      if (attributes._COLOR_0 !== undefined) invalid('导入器无法保留逐实例颜色，请先按源色分组。');
      const counts = Object.values(attributes).map(index => accessors[index]?.count);
      if (!counts.length || counts.some(count => !Number.isInteger(count) || count !== counts[0])) invalid('GLB 实例数据不完整。');
      instances = counts[0];
    }
    objects += instances; triangles += perMesh[node.mesh] * instances;
  }
  if (!objects || objects > REALISTIC_RENDER_LIMITS.maxObjects || triangles < 1 || triangles > REALISTIC_RENDER_LIMITS.maxTriangles) invalid('完整模型超过高清的 4096 个对象或 500 万面上限，请使用实时导出；不会自动减面。');
  let textureBytes = 0;
  for (const image of gltf.images || []) {
    if (image.uri || !Number.isInteger(image.bufferView) || !views[image.bufferView] || !['image/png', 'image/jpeg', 'image/webp'].includes(image.mimeType)) invalid('GLB 贴图必须完整嵌入普通 PNG、JPEG 或 WebP。');
    const view = views[image.bufferView], offset = binStart + (view.byteOffset ?? 0);
    const size = rasterDimensions(bytes.subarray(offset, offset + view.byteLength), image.mimeType);
    textureBytes += size.width * size.height * 8;
    if (textureBytes + decodedAttributeBytes > REALISTIC_RENDER_LIMITS.maxUnpackedBytes) invalid('网格与贴图展开预算超过 512 MiB，请使用实时导出；不会自动缩小贴图或减面。');
  }
  return { triangles, objects };
}

function safeName(value) {
  if (value !== undefined && typeof value !== 'string') invalid('导出名称须为文字。');
  const clean = (value || '模型生长-写实').normalize('NFC').replace(/\.(mp4|mov|zip|png)$/i, '').replace(/[\x00-\x1f\x7f<>:"/\\|?*]/g, '-').replace(/\s+/g, ' ').trim().replace(/^[. ]+|[. ]+$/g, '');
  let result = '';
  for (const character of clean) { if (Buffer.byteLength(result + character) > 180 || [...result].length >= 80) break; result += character; }
  return result || 'model-growth-realistic';
}

function safeStats(stats, job) {
  object(stats, '渲染统计');
  for (const key of ['originalTriangles', 'completeTriangles', 'sourceMeshes', 'materials', 'frames', 'growthFrames', 'width', 'height', 'samples']) finite(stats[key], key.includes('Triangles') ? 1 : 0, key.includes('Triangles') ? REALISTIC_RENDER_LIMITS.maxTriangles : 100000, '渲染统计', true);
  if (stats.decimation !== false || stats.originalTriangles !== stats.completeTriangles || stats.originalTriangles !== job.geometry.triangles || stats.frames !== job.config.output.frames || stats.growthFrames !== job.config.output.growthFrames || stats.width !== job.config.output.width || stats.height !== job.config.output.height || stats.samples !== job.config.output.samples) invalid('完整帧数或模型面数验证未通过，未生成最终文件。');
  if (job.format === 'preview' && stats.previewProgress !== job.config.output.previewProgress) invalid('写实预览生长进度验证未通过，未保存错误画面。');
  if (job.printGeometry && (stats.capMode !== 'sliced-gcode' || stats.printSegments !== job.printGeometry.segments || stats.printLayerCount !== job.printGeometry.layers || stats.capOnlyTrianglesPeak !== 0 || stats.sourceGeometryUnchanged !== true)) invalid('真实切片或完整源表面验证未通过，未保存近似满铺截面。');
  if (job.printGeometry) finite(stats.printWindowSegmentsPeak, 0, job.printGeometry.maxWindowSegments, '完整真实切片层窗', true);
  if (job.printGeometry && stats.printCrossSection !== job.printGeometry.crossSection) invalid('挤出截面模式与实际切片封包不一致。');
  finite(stats.projectionError, 0, 0.001, '镜头投影误差'); finite(stats.seconds, 0, 10000000, '渲染时间');
  return Object.fromEntries(['schemaVersion', 'originalTriangles', 'completeTriangles', 'sourceMeshes', 'materials', 'decimation', 'sourceGeometryUnchanged', 'frames', 'growthFrames', 'previewProgress', 'width', 'height', 'samples', 'seconds', 'projectionError', 'photoProtected', 'gradingScope', 'capMode', 'capOnlyTrianglesPeak', 'printSegments', 'printLayerCount', 'printWindowSegmentsPeak', 'printCrossSection', 'environmentMode', 'shadowMode'].map(key => [key, typeof stats[key] === 'string' ? stats[key].slice(0, 120) : stats[key]]));
}

export function createRealisticRenderService({ root = MODULE_ROOT, blenderPath = findBlenderPath({ root }), ffmpegPath = findFFmpegPath(), timeoutMs = 6 * 60 * 60 * 1000, stallTimeoutMs = 15 * 60 * 1000, maxQueued = 1, killGraceMs = 1500, maxOutputBytes = REALISTIC_RENDER_LIMITS.maxOutputBytes, spawnImpl = spawn, renameImpl = rename, alphaEncoderProbe = probeMovAlphaEncoder, exportDirectory } = {}) {
  if (!Number.isInteger(maxQueued) || maxQueued < 0 || maxQueued > 1 || ![timeoutMs, stallTimeoutMs].every(value => Number.isFinite(value) && value >= 25 && value <= 86400000) || !Number.isFinite(killGraceMs) || killGraceMs < 10 || killGraceMs > 5000) throw new RealisticRenderError(500, 'INVALID_RENDER_SERVICE_LIMITS', '写实渲染服务的队列或时间范围配置无效。');
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > REALISTIC_RENDER_LIMITS.maxOutputBytes) throw new RealisticRenderError(500, 'INVALID_RENDER_SERVICE_LIMITS', '写实导出文件大小范围配置无效。');
  root = path.resolve(root);
  let outputRoot = exportDirectory ? path.resolve(exportDirectory) : path.join(root, 'exports'), tempRoot = path.join(outputRoot, '.realistic-work');
  const jobs = new Map(), queue = []; let active = null, reservations = 0, closed = false;
  const preparations = new Set();
  const get = (id, { preview } = {}) => { const job = jobs.get(id); if (!job || typeof preview === 'boolean' && (job.format === 'preview') !== preview) throw new RealisticRenderError(404, 'REALISTIC_EXPORT_NOT_FOUND', '找不到这次写实任务。'); return job; };
  const publicJob = job => ({ id: job.id, status: job.status, format: job.format, rendered: job.reported, encoded: job.encoded, received: job.encoded, total: job.config.output.frames, progress: Math.round(job.encoded / job.config.output.frames * 100), ...(job.format === 'preview' ? { previewProgress: job.config.output.previewProgress } : {}), queued: job.status === 'queued', failure: job.failure || null, error: job.errorCode || null, filename: job.status === 'complete' ? job.filename : null, bytes: job.status === 'complete' ? job.bytes : null, url: job.status === 'complete' ? `/api/realistic-${job.format === 'preview' ? 'previews' : 'exports'}/${job.id}/file` : null, stats: job.stats || null, warnings: [job.printGeometry ? job.printGeometry.crossSection === 'stadium-with-elliptical-fallback' ? '实际路径完整保留；普通道路为圆角扁平截面，桥接或线宽小于层高时用椭圆近似。' : '旧研究封包采用椭圆截面；实际路径完整保留。' : '没有切片数据，生长截面保持开放；不会满铺假填充。'], createdAt: job.createdAt });
  async function health() {
    const blender = Boolean(resolveExecutablePath(blenderPath)), encoder = Boolean(resolveExecutablePath(ffmpegPath));
    const worker = await access(WORKER, constants.R_OK).then(() => true, () => false);
    return { available: !closed && blender && worker, encoderAvailable: encoder, encoderAlphaAvailable: encoder && (await alphaEncoderProbe(ffmpegPath)).available, engine: 'Blender Cycles', active: Boolean(active), queued: queue.length, limits: { ...REALISTIC_RENDER_LIMITS, maxOutputBytes }, previewLimits: REALISTIC_PREVIEW_LIMITS, reason: closed ? '写实渲染服务正在关闭。' : !blender || !worker ? '本机写实渲染器未准备好，可继续实时导出。' : null };
  }
  async function ensureOutput() {
    await mkdir(root, { recursive: true }); await mkdir(outputRoot, { recursive: true });
    const [actualRoot, actualOutput] = await Promise.all([realpath(root), realpath(outputRoot)]);
    const expectedOutput = exportDirectory ? path.join(await realpath(path.dirname(outputRoot)), path.basename(outputRoot)) : path.join(actualRoot, 'exports');
    if (actualOutput !== expectedOutput) throw new RealisticRenderError(500, 'UNSAFE_EXPORT_DIRECTORY', '导出目录不能通过链接指向其他位置。');
    root = actualRoot; outputRoot = actualOutput; tempRoot = path.join(actualOutput, '.realistic-work');
    await mkdir(tempRoot, { recursive: true, mode: 0o700 });
    if (await realpath(tempRoot) !== path.join(actualOutput, '.realistic-work')) throw new RealisticRenderError(500, 'UNSAFE_WORK_DIRECTORY', '写实临时目录无效。');
    await chmod(tempRoot, 0o700);
  }
  function childProcess(executable, args, job, kind, options = {}) {
    const child = spawnImpl(executable, args, { cwd: job.directory, stdio: kind === 'render' ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'ignore', 'pipe'], windowsHide: true, ...options });
    const completion = new Promise(resolve => {
      child.once('error', () => { job.processError ||= kind; });
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    child.stderr?.on('data', data => { job.logs = (job.logs + data.toString()).slice(-8192); job.touchedAt = Date.now(); });
    child.stdin?.on('error', () => {});
    return { child, completion };
  }
  function killProcess(process) {
    if (!process?.child || process.child.exitCode !== null || process.child.killed) return;
    process.child.stdin?.destroy(); process.child.kill('SIGTERM');
    const timer = setTimeout(() => { if (process.child.exitCode === null) process.child.kill('SIGKILL'); }, killGraceMs); timer.unref();
  }
  function abort(job, code, message, status = 'error') {
    if (TERMINAL.has(job.status) || job.commitStarted) return;
    job.status = status; job.errorCode = code; job.failure = message;
    killProcess(job.renderProcess); killProcess(job.encoderProcess); job.archiveStream?.destroy();
  }
  async function writeArchiveData(job, bytes) {
    if (TERMINAL.has(job.status)) throw new RealisticRenderError(409, 'RENDER_CANCELLED', '写实导出已停止。');
    await new Promise((resolve, reject) => job.archiveStream.write(bytes, error => error ? reject(error) : resolve()));
  }
  function startArchive(job) {
    job.archiveWrites = Promise.resolve();
    job.archiveStream = createWriteStream(job.partialPath, { flags: 'wx', mode: 0o600 }); job.archiveStream.on('error', () => {});
    job.archive = new Zip((error, data) => {
      job.archiveWrites = job.archiveWrites.then(() => { if (error) throw error; return writeArchiveData(job, Buffer.from(data)); });
      job.archiveWrites.catch(() => {});
    });
  }
  async function acceptFrame(job, message) {
    if (TERMINAL.has(job.status)) return;
    const index = job.encoded, expectedName = `frames${String(index).padStart(6, '0')}.png`;
    if (message.frame !== index || message.path !== expectedName) invalid('写实渲染帧顺序或名称错误，已停止导出。');
    const filename = path.join(job.directory, 'frames', expectedName), info = await stat(filename);
    const maximum = Math.min(40 * 1024 * 1024, job.config.output.width * job.config.output.height * 5 + 65536);
    if (!info.isFile() || info.size > maximum || info.size < 45 || await realpath(filename) !== filename) invalid('写实帧文件过大或不是普通 PNG。');
    await chmod(filename, 0o600);
    const data = await readFile(filename); validatePNG(data, job.config.output.width, job.config.output.height, { alpha: job.format === 'mov-alpha' });
    if (job.format === 'preview') await writeFile(job.partialPath, data, { flag: 'wx', mode: 0o600 });
    else if (job.format === 'mp4' || job.format === 'mov-alpha') await new Promise((resolve, reject) => job.encoderProcess.child.stdin.write(data, error => error ? reject(error) : resolve()));
    else {
      job.sequenceBytes += data.length;
      if (job.sequenceBytes > REALISTIC_RENDER_LIMITS.maxSequenceBytes) throw new RealisticRenderError(413, 'PNG_SEQUENCE_LIMIT', '完整 PNG 序列超过 512 MiB，未省略任何帧；请缩短时间或降低分辨率。');
      const entry = new ZipPassThrough(`frame_${String(index).padStart(6, '0')}.png`); job.archive.add(entry); entry.push(data, true); await job.archiveWrites;
    }
    if (TERMINAL.has(job.status)) return;
    job.encoded++; job.touchedAt = Date.now(); await rm(filename, { force: true });
  }
  async function run(job) {
    job.status = 'rendering'; job.touchedAt = Date.now(); job.frameWrites = Promise.resolve();
    const absoluteTimeout = setTimeout(() => abort(job, 'RENDER_TIMEOUT', '写实渲染超过总时限，请减少帧数或分辨率。'), timeoutMs); absoluteTimeout.unref();
    const stalled = setInterval(() => {
      if (Date.now() - job.touchedAt > stallTimeoutMs) abort(job, 'RENDER_STALLED', '写实渲染长时间没有进展，已停止并清理临时数据。');
      stat(job.partialPath).then(info => { if (info.size > maxOutputBytes) abort(job, 'RENDER_OUTPUT_LIMIT', '完整导出超过文件大小上限，未降低画质或丢弃帧；请缩短时间。'); }).catch(() => {});
    }, Math.max(25, Math.min(1000, stallTimeoutMs / 4))); stalled.unref();
    try {
      if (job.format === 'mp4' || job.format === 'mov-alpha') {
        job.encoderProcess = childProcess(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-f', 'image2pipe', '-vcodec', 'png', '-framerate', String(job.config.output.fps), '-i', 'pipe:0', ...(job.watermarked ? freeWatermarkArguments(job.config.output.width, job.config.output.height) : []), '-frames:v', String(job.config.output.frames), '-an', ...(job.format === 'mov-alpha' ? movAlphaEncoderArguments() : ['-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-f', 'mp4']), job.partialPath], job, 'encoder');
        job.encoderProcess.completion.then(result => { if (!TERMINAL.has(job.status) && (result.code !== 0 || result.signal || job.encoded < job.config.output.frames)) abort(job, 'ENCODER_FAILED', 'FFmpeg 编码失败，未保存不完整视频。'); });
      } else if (job.format === 'png-sequence') startArchive(job);
      const userConfig = path.join(job.directory, 'user-config'), userScripts = path.join(job.directory, 'user-scripts'), userData = path.join(job.directory, 'user-data');
      const env = { ...process.env, BLENDER_USER_CONFIG: userConfig, BLENDER_USER_SCRIPTS: userScripts, BLENDER_USER_DATAFILES: userData, PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1' };
      delete env.PYTHONPATH;
      job.renderProcess = childProcess(blenderPath, ['--background', '--factory-startup', '--disable-autoexec', '--python-exit-code', '1', '--python', WORKER, '--', path.join(job.directory, 'config.json')], job, 'render', { env });
      let lines = '';
      const handleLine = line => {
        if (TERMINAL.has(job.status) || !line.startsWith('{')) return;
        let message; try { message = JSON.parse(line); } catch { return; }
        job.touchedAt = Date.now();
        if (message.type === 'progress') {
          if (!Number.isInteger(message.frame) || message.frame !== job.reported || message.frames !== job.config.output.frames || job.reported >= job.config.output.frames) { abort(job, 'FRAME_ORDER_ERROR', '写实渲染出现缺帧或重复帧，未生成最终文件。'); return; }
          job.reported++;
          if (job.reported - job.encoded > REALISTIC_RENDER_LIMITS.maxPendingFrames) { abort(job, 'ENCODER_BACKLOG', '编码积压超过安全范围，已停止以避免耗尽磁盘。'); return; }
          job.frameWrites = job.frameWrites.then(() => acceptFrame(job, message));
          job.frameWrites.catch(error => abort(job, error.code || 'FRAME_FAILED', error.status ? error.message : '渲染帧读取或编码失败，未保存不完整视频。'));
        } else if (message.type === 'complete') {
          if (job.completeReported) { abort(job, 'DUPLICATE_COMPLETION', '渲染完成状态重复，未生成最终文件。'); return; }
          job.completeReported = true; job.rawStats = message.stats;
        } else if (message.type === 'error') abort(job, 'RENDERER_FAILED', '物理渲染器未完成，请使用实时导出或调整模型工程。');
      };
      job.renderProcess.child.stdout.on('data', data => {
        job.touchedAt = Date.now(); lines += data.toString();
        if (lines.length > 262144 && !lines.includes('\n')) { lines = ''; return; }
        let end; while ((end = lines.indexOf('\n')) >= 0) { const line = lines.slice(0, end).trim(); lines = lines.slice(end + 1); handleLine(line); }
      });
      const renderResult = await job.renderProcess.completion;
      if (lines.trim()) handleLine(lines.trim());
      await job.frameWrites;
      if (TERMINAL.has(job.status)) return;
      if (renderResult.code !== 0 || renderResult.signal || job.processError || !job.completeReported || job.reported !== job.config.output.frames || job.encoded !== job.config.output.frames) throw new RealisticRenderError(500, 'RENDER_INCOMPLETE', '物理渲染未完整完成，未保存缺帧视频。');
      job.stats = safeStats(job.rawStats, job); job.status = 'encoding';
      if (job.format === 'mp4' || job.format === 'mov-alpha') {
        job.encoderProcess.child.stdin.end(); const result = await job.encoderProcess.completion;
        if (result.code !== 0 || result.signal || TERMINAL.has(job.status)) throw new RealisticRenderError(500, 'ENCODER_FAILED', '视频编码失败，未保存不完整视频。');
      } else if (job.format === 'png-sequence') {
        const entry = new ZipPassThrough('metadata.json'); job.archive.add(entry); entry.push(strToU8(JSON.stringify(job.stats)), true); job.archive.end(); await job.archiveWrites;
        await new Promise((resolve, reject) => { job.archiveStream.once('error', reject); job.archiveStream.end(resolve); });
      }
      const info = await stat(job.partialPath); if (!info.isFile() || info.size < 1) throw new RealisticRenderError(500, 'EMPTY_RENDER', '最终文件为空，未保存这次导出。');
      if (info.size > maxOutputBytes) throw new RealisticRenderError(413, 'RENDER_OUTPUT_LIMIT', '完整导出超过文件大小上限，未降低画质或丢弃帧；请缩短时间。');
      await chmod(job.partialPath, 0o600);
      if (TERMINAL.has(job.status)) return;
      // Commit is atomic with respect to cancellation in the JS event loop.
      // Once rename starts, cancel waits for this verified finalization; it
      // never deletes a completed user export or turns it into a partial one.
      job.commitStarted = true; clearTimeout(absoluteTimeout); clearInterval(stalled);
      await renameImpl(job.partialPath, job.finalPath); job.status = 'complete'; job.bytes = info.size; job.failure = null; job.errorCode = null;
    } catch (error) {
      job.commitStarted = false;
      if (!TERMINAL.has(job.status)) abort(job, error.code || 'RENDER_FAILED', error.status ? error.message : '写实导出失败，临时数据已清理；可使用实时导出。');
    } finally {
      clearTimeout(absoluteTimeout); clearInterval(stalled);
      if (job.status !== 'complete') { killProcess(job.renderProcess); killProcess(job.encoderProcess); }
      await Promise.all([job.renderProcess?.completion, job.encoderProcess?.completion].filter(Boolean));
      await rm(job.directory, { recursive: true, force: true }).catch(() => {});
      if (job.status !== 'complete') await rm(job.partialPath, { force: true }).catch(() => {});
      job.config = { output: job.config.output }; job.logs = ''; job.rawStats = null;
    }
  }
  function dispatch() {
    if (active || closed) return;
    const job = queue.shift(); if (!job) return;
    active = job;
    job.done = run(job).finally(() => { if (active === job) active = null; dispatch(); }); job.done.catch(() => {});
  }
  async function create(buffer, options = {}) {
    if (closed) throw new RealisticRenderError(503, 'REALISTIC_SERVICE_CLOSED', '写实渲染服务正在关闭。');
    const capability = await health();
    if (!capability.available) throw new RealisticRenderError(503, 'REALISTIC_RENDER_UNAVAILABLE', capability.reason);
    const format = options.format || 'mp4'; if (!['mp4', 'mov-alpha', 'png-sequence', 'preview'].includes(format)) invalid('写实格式只支持 MP4、透明 MOV、PNG 序列或单张预览。');
    if ((format === 'mp4' || format === 'mov-alpha') && !capability.encoderAvailable) throw new RealisticRenderError(503, 'FFMPEG_UNAVAILABLE', 'FFmpeg 未准备好，请选择 PNG 序列或实时导出。');
    if (format === 'mov-alpha' && !capability.encoderAlphaAvailable) throw new RealisticRenderError(503, 'ALPHA_ENCODER_UNAVAILABLE', '本机 FFmpeg 不支持透明 ProRes MOV，请安装支持 prores_ks 的 FFmpeg 或导出透明 PNG 序列。');
    if (queue.length + reservations >= maxQueued + (active ? 0 : 1)) throw new RealisticRenderError(409, 'REALISTIC_RENDER_BUSY', '已有写实导出和等待任务，请完成或取消后再试。');
    reservations++;
    let finishPreparation;
    const preparation = new Promise(resolve => { finishPreparation = resolve; }); preparations.add(preparation);
    let directory;
    try {
      const files = unpackRenderPackage(buffer); let sourceConfig;
      try { sourceConfig = JSON.parse(files['config.json'].toString('utf8')); } catch { invalid('渲染配置不是有效 JSON。'); }
      const config = validateRenderConfig(sourceConfig, files, { preview: format === 'preview' }), geometry = validateRenderGLB(files['scene.glb']);
      if (format === 'mov-alpha' && config.background.transparent !== true) invalid('透明 MOV 必须使用透明背景渲染，未开始写实任务。');
      const printGeometry = config.printLayer ? { segments: config.printLayer.segmentCount, layers: config.printLayer.layerCount, maxWindowSegments: config.printLayer.maxWindowSegments, crossSection: config.printLayer.crossSection } : null;
      await ensureOutput();
      if (closed) throw new RealisticRenderError(503, 'REALISTIC_SERVICE_CLOSED', '写实渲染服务正在关闭。');
      const id = randomUUID(), suffix = format === 'preview' ? 'png' : format === 'mov-alpha' ? 'mov' : format === 'mp4' ? 'mp4' : 'zip';
      const name = safeName(options.name), filename = `${name}-${new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15)}-${id.slice(0, 8)}.${suffix}`;
      directory = path.join(tempRoot, id); await mkdir(directory, { mode: 0o700 }); await mkdir(path.join(directory, 'frames'), { mode: 0o700 });
      for (const [name, bytes] of Object.entries(files)) if (name !== 'config.json') await writeFile(path.join(directory, name), bytes, { flag: 'wx', mode: 0o600 });
      await writeFile(path.join(directory, 'config.json'), JSON.stringify(config), { flag: 'wx', mode: 0o600 });
      if (closed) throw new RealisticRenderError(503, 'REALISTIC_SERVICE_CLOSED', '写实渲染服务正在关闭。');
      const job = { id, config, geometry, printGeometry, format, watermarked: options.watermarked === true, directory, filename, partialPath: path.join(directory, `result.partial.${suffix}`), finalPath: path.join(format === 'preview' ? tempRoot : outputRoot, filename), status: 'queued', reported: 0, encoded: 0, sequenceBytes: 0, logs: '', createdAt: new Date().toISOString() };
      jobs.set(id, job); queue.push(job); dispatch(); return publicJob(job);
    } catch (error) {
      if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
      if (error.status) throw error;
      throw new RealisticRenderError(500, 'RENDER_PREPARE_FAILED', '写实数据准备失败，请检查磁盘空间后重试。');
    } finally { reservations--; preparations.delete(preparation); finishPreparation(); }
  }
  async function cancel(id, options) {
    const job = get(id, options);
    if (job.commitStarted) await job.done;
    if (job.status === 'complete') {
      if (job.format === 'preview') { await rm(job.finalPath, { force: true }); job.status = 'cancelled'; job.failure = '写实预览已清理。'; job.errorCode = 'RENDER_CANCELLED'; }
      return publicJob(job);
    }
    if (!TERMINAL.has(job.status)) {
      if (job.status === 'queued') { queue.splice(queue.indexOf(job), 1); abort(job, 'RENDER_CANCELLED', '写实导出已取消。', 'cancelled'); await rm(job.directory, { recursive: true, force: true }); job.config = { output: job.config.output }; }
      else { abort(job, 'RENDER_CANCELLED', '写实导出已取消。', 'cancelled'); await job.done; }
    }
    return publicJob(job);
  }
  async function file(id, options) {
    const job = get(id, options); if (job.status !== 'complete') throw new RealisticRenderError(409, 'REALISTIC_FILE_NOT_READY', job.failure || '写实导出尚未完成。');
    const info = await stat(job.finalPath); if (!info.isFile() || await realpath(job.finalPath) !== job.finalPath) throw new RealisticRenderError(404, 'REALISTIC_FILE_MISSING', '已完成文件不存在或位置无效。');
    return { path: job.finalPath, mime: job.format === 'preview' ? 'image/png' : job.format === 'mov-alpha' ? 'video/quicktime' : job.format === 'mp4' ? 'video/mp4' : 'application/zip', name: job.filename, filename: job.filename, size: info.size, bytes: info.size };
  }
  async function close() {
    if (closed) return; closed = true;
    await Promise.all([...jobs.values()].filter(job => !TERMINAL.has(job.status) || job.format === 'preview' && job.status === 'complete').map(job => cancel(job.id)));
    await Promise.all([...preparations]);
  }
  return { health, create, snapshot: (id, options) => publicJob(get(id, options)), cancel, file, close };
}
