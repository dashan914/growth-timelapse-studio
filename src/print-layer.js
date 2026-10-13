/**
 * Exact sliced model paths. This module never invents an infill pattern, fits a
 * bounding box, reduces G1 paths, or changes the imported CAD mesh.
 *
 * G-code coordinates are millimetres with printer Z up. Feature annotations are
 * necessary to separate the model from purge towers and support. Supported arcs
 * are sampled with a stated physical sagitta bound; unsupported motion fails
 * instead of silently presenting an incomplete slice as the real one.
 */
import {normalizeSliceSettings, DEFAULT_LAYER_HEIGHT_MM} from './slice-settings.js';
export const PRINT_FEATURE = Object.freeze({
  unknown: 0, outerWall: 1, innerWall: 2, sparseInfill: 3, solidInfill: 4,
  topSurface: 5, bottomSurface: 6, bridge: 7, gapInfill: 8, ironing: 9,
  support: 10, supportInterface: 11, brim: 12, skirt: 13, primeTower: 14, custom: 15, overhangWall: 16,
});
export const PRINT_FEATURE_NAMES = Object.freeze(Object.fromEntries(Object.entries(PRINT_FEATURE).map(([name, id]) => [id, name])));
const MODEL_FEATURES = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 16]);
const SUPPORT_FEATURES = new Set([10, 11]);
const TAU = Math.PI * 2;
const identity = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
// Explicit Bambu machine macros, verified against the official Bambu Studio
// templates at BambuStudio commit 3f126b717ed1f10fee0f32f05ed9731808d0c8bb.
// Empty axes are settings only; XYZ macros leave physical position uncertain.
// G2814 is A1 pre-extrude Z calibration; only its explicit axes become unknown.
// Official A1 startup ends with bare G29.4; no parameterized form is verified.
// G387 has conditional clamped travel, not the commanded G1 endpoint.
const MACHINE_G_CODES = new Map([
  ...['29.1','29.2','29.20','29.4','29.7','29.9','29.99','392'].map(code => [code, '']),
  ...['28.14','28.140','39.1','150','150.1','150.2','150.3','151','383','383.3','383.4','383.7'].map(code => [code, 'XYZ']),
  ['2814','specified'],
  ...['380','3811','387'].map(code => [code, 'specified']),
]);
const SERVICE_TOOLS = new Set([255, 1000, 1001, 1100, 65279, 65535]);

export function classifyPrintFeature(label) {
  const name = String(label || '').trim().toLowerCase().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ');
  if (/support/.test(name)) return /interface|contact|roof|floor/.test(name) ? PRINT_FEATURE.supportInterface : PRINT_FEATURE.support;
  if (/prime|wipe tower|purge/.test(name)) return PRINT_FEATURE.primeTower;
  if (/brim/.test(name)) return PRINT_FEATURE.brim;
  if (/skirt/.test(name)) return PRINT_FEATURE.skirt;
  if (/overhang wall|overhang perimeter/.test(name)) return PRINT_FEATURE.overhangWall;
  if (/outer wall|external perimeter|wall outer/.test(name)) return PRINT_FEATURE.outerWall;
  if (/inner wall|internal perimeter|wall inner/.test(name) || name === 'perimeter') return PRINT_FEATURE.innerWall;
  if (/top surface|top solid|top skin/.test(name)) return PRINT_FEATURE.topSurface;
  if (/bottom surface|bottom solid|bottom skin/.test(name)) return PRINT_FEATURE.bottomSurface;
  if (/bridge/.test(name)) return PRINT_FEATURE.bridge;
  if (/gap/.test(name)) return PRINT_FEATURE.gapInfill;
  if (/ironing/.test(name)) return PRINT_FEATURE.ironing;
  // Bambu's GCodeProcessor maps erFloatingVerticalShell to erSolidInfill.
  if (name === 'floating vertical shell') return PRINT_FEATURE.solidInfill;
  if (/sparse|internal infill/.test(name) || name === 'fill' || name === 'infill') return PRINT_FEATURE.sparseInfill;
  if (/solid|skin/.test(name)) return PRINT_FEATURE.solidInfill;
  if (/custom/.test(name)) return PRINT_FEATURE.custom;
  return PRINT_FEATURE.unknown;
}

function matrixElements(matrix, name = 'printerToSource') {
  const elements = matrix?.elements || matrix;
  if (!elements || elements.length !== 16 || [...elements].some(value => !Number.isFinite(value))) {
    throw new TypeError(`${name} 必须是明确的 4×4 有限仿射矩阵；不能按包围盒自动猜测对齐。`);
  }
  if (Math.abs(elements[3]) + Math.abs(elements[7]) + Math.abs(elements[11]) > 1e-10 || Math.abs(elements[15] - 1) > 1e-10) {
    throw new TypeError(`${name} 必须是仿射矩阵。`);
  }
  return elements;
}

function applyPoint(matrix, x, y, z, target, offset) {
  target[offset] = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12];
  target[offset + 1] = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13];
  target[offset + 2] = matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14];
}

function arcPoints(start, end, command, parameters, { unit, centerAbsolute, coordinateOffset, toleranceMm }) {
  let cx, cy;
  const clockwise = command === 2;
  if (parameters.I !== undefined || parameters.J !== undefined) {
    cx = centerAbsolute ? (parameters.I ?? (start[0] - coordinateOffset[0]) / unit) * unit + coordinateOffset[0] : start[0] + (parameters.I || 0) * unit;
    cy = centerAbsolute ? (parameters.J ?? (start[1] - coordinateOffset[1]) / unit) * unit + coordinateOffset[1] : start[1] + (parameters.J || 0) * unit;
  } else if (parameters.R !== undefined) {
    const radius = Math.abs(parameters.R * unit);
    const dx = end[0] - start[0], dy = end[1] - start[1], chord = Math.hypot(dx, dy);
    if (chord < 1e-10 || radius < chord / 2 - 1e-6) throw new Error('G-code 圆弧半径无效，不能完整还原切片路径。');
    const distance = Math.sqrt(Math.max(0, radius * radius - chord * chord / 4));
    const candidates = [-1, 1].map(sign => [(start[0] + end[0]) / 2 + sign * -dy / chord * distance, (start[1] + end[1]) / 2 + sign * dx / chord * distance]);
    const candidate = candidates.find(([x, y]) => {
      const a = Math.atan2(start[1] - y, start[0] - x), b = Math.atan2(end[1] - y, end[0] - x);
      const sweep = clockwise ? ((a - b + TAU) % TAU) : ((b - a + TAU) % TAU);
      return parameters.R >= 0 ? sweep <= Math.PI + 1e-7 : sweep > Math.PI - 1e-7;
    });
    if (!candidate) throw new Error('无法确定 G-code 圆弧方向。');
    [cx, cy] = candidate;
  } else throw new Error('G2/G3 挤出缺少 I/J 或 R，不能完整还原切片路径。');
  const radius = Math.hypot(start[0] - cx, start[1] - cy);
  const endRadius = Math.hypot(end[0] - cx, end[1] - cy);
  if (radius < 1e-9 || Math.abs(radius - endRadius) > Math.max(0.05, radius * 0.001)) throw new Error('G-code 圆弧端点与圆心不一致，不能完整还原切片路径。');
  const a = Math.atan2(start[1] - cy, start[0] - cx), b = Math.atan2(end[1] - cy, end[0] - cx);
  let sweep = clockwise ? -((a - b + TAU) % TAU) : ((b - a + TAU) % TAU);
  if (Math.hypot(end[0] - start[0], end[1] - start[1]) < 1e-8) sweep = clockwise ? -TAU : TAU;
  const maxAngle = radius <= toleranceMm ? Math.PI / 4 : Math.min(Math.PI / 4, 2 * Math.acos(Math.max(-1, 1 - toleranceMm / radius)));
  const count = Math.max(1, Math.ceil(Math.abs(sweep) / maxAngle));
  if (count > 1_000_000) throw new Error('单个圆弧过大，无法可靠还原打印路径。');
  const points = [];
  for (let i = 1; i <= count; i++) {
    const t = i / count, angle = a + sweep * t;
    points.push(i === count ? end.slice() : [cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius, start[2] + (end[2] - start[2]) * t]);
  }
  return points;
}

/**
 * Build a compact exact segment table plus a stable per-layer index. No segment
 * limit is allowed to truncate: a limit failure leaves callers' old state intact.
 * includeAuxiliary retains support/purge/brim for inspection, never for a cap.
 */
export function parsePrintLayerGCode(text, {
  maxSegments = 10_000_000, maxTextBytes = 512 * 1024 * 1024,
  arcToleranceMm = 0.01, includeAuxiliary = false, includeSupport = false, defaultWidthMm = 0.42, defaultHeightMm = DEFAULT_LAYER_HEIGHT_MM, strictFeatures = true, onProgress = null,
} = {}) {
  if (typeof text !== 'string') throw new TypeError('打印层 G-code 必须是文本。');
  if (text.length > maxTextBytes) throw new RangeError('切片文本过大，无法完整读取；不会截断或显示假的完整填充。');
  if (!Number.isInteger(maxSegments) || maxSegments < 1 || maxSegments > 50_000_000) throw new RangeError('打印层段数限制无效。');
  if (![arcToleranceMm, defaultWidthMm, defaultHeightMm].every(value => Number.isFinite(value) && value > 0) || arcToleranceMm > 0.1) throw new RangeError('打印层尺寸或圆弧容差无效。');
  if (onProgress !== null && typeof onProgress !== 'function') throw new TypeError('切片读取进度回调无效。');
  let capacity = Math.min(8192, maxSegments), count = 0;
  let positions = new Float32Array(capacity * 6), tools = new Uint16Array(capacity), features = new Uint8Array(capacity);
  let widths = new Float32Array(capacity), heights = new Float32Array(capacity), keys = new Float64Array(capacity), strokes = new Uint32Array(capacity);
  const rawFeatureCounts = {}, rawConfiguration = {}, toolColors = [], warnings = [], unknownFeatureLabels = {};
  const reportProgress = (phase, completed, total) => onProgress?.({ phase, completed, total, progress: total > 0 ? completed / total : null, segmentCount: count });
  // Saved CONFIG_BLOCKs are often after the moves. Read inert settings first
  // without splitting a multi-hundred-MB source into millions of JS strings.
  reportProgress('configuration', 0, null);
  for(const match of text.matchAll(/^[\t ]*;[\t ]*([a-z][\w]*)[\t ]*=[\t ]*([^\r\n]*)/gim))rawConfiguration[match[1].toLowerCase()]=match[2].trim();
  const savedSettings=normalizeSliceSettings(rawConfiguration,{source:'gcode-config'});
  const machineStartEnd = text.search(/^[\t ]*;[\t ]*MACHINE_START_GCODE_END[\t ]*\r?$/m);
  const sourceNozzles = String(rawConfiguration.nozzle_diameter || '').split(/[;,]/).map(value => Number(value.trim()));
  const x2dPrime = {O:0,X:100,Y:-0.2,Z:0.6,L:40,E:12,D:4};
  let commandLineStart = 0, modelSectionSeen = false, extrusionPositionKnown = true, excludedStartupExtrusionMacros = 0;
  let inferredHeights=new Uint8Array(capacity),inferredWidths=new Uint8Array(capacity);
  let featureLabel = '';
  let allExtrusionMoves = 0, sampledArcMoves = 0, unknownExtrusionMoves = 0, inferredWidthSegments = 0, inferredHeightSegments = 0;
  let point = [0, 0, 0], offset = [0, 0, 0], e = 0, unit = 1, absolute = true, absoluteE = true, centerAbsolute = false;
  const positionKnown = [true, true, true];
  let motion = null, tool = 0, feature = PRINT_FEATURE.unknown, width = defaultWidthMm, height = defaultHeightMm;
  let widthExplicit = false, heightExplicit = false, plane = 17, stroke = 0, connected = false;
  const printedLayerKeys = new Set();
  const append = (start, end) => {
    if (count >= maxSegments) throw new RangeError(`真实切片路径超过 ${maxSegments.toLocaleString('zh-CN')} 段限制；必须完整读取，当前结果不会采用。`);
    if (count === capacity) {
      capacity = Math.min(maxSegments, capacity * 2);
      const grow = (array, size) => { const next = new array.constructor(size); next.set(array); return next; };
      positions = grow(positions, capacity * 6); tools = grow(tools, capacity); features = grow(features, capacity);
      widths = grow(widths, capacity); heights = grow(heights, capacity); keys = grow(keys, capacity); strokes = grow(strokes, capacity);
      inferredHeights=grow(inferredHeights,capacity);inferredWidths=grow(inferredWidths,capacity);
    }
    positions.set(start, count * 6); positions.set(end, count * 6 + 3);
    tools[count] = tool; features[count] = feature; widths[count] = width; heights[count] = height;
    inferredHeights[count]=Number(!heightExplicit);inferredWidths[count]=Number(!widthExplicit);
    const key = Math.round(Math.max(start[2], end[2]) * 10000);
    keys[count] = key; strokes[count] = stroke; printedLayerKeys.add(key);
    if (!widthExplicit) inferredWidthSegments++;
    if (!heightExplicit) inferredHeightSegments++;
    count++;
  };
  const execute = (command, values) => {
    if (command?.letter === 'T') {
      if (Number.isInteger(command.value) && command.value >= 0 && command.value < 255) { if (tool !== command.value) { connected = false; stroke++; } tool = command.value; }
      else if (!SERVICE_TOOLS.has(command.value)) throw new Error(`不支持的耗材工具编号 T${command.value}，无法保证真实颜色。`);
      return;
    }
    if (command?.letter === 'M') { if (command.value === 82) absoluteE = true; if (command.value === 83) absoluteE = false; return; }
    if (command?.letter === 'G') {
      const code = command.code ?? String(command.value);
      if (code === '130') {
        // X2D's official O0/D4 nozzle-load macro extrudes a firmware-generated
        // startup line. Its E12 is not a G1 endpoint or an E-coordinate delta.
        // Only this verified form, explicitly before Bambu's startup boundary,
        // may be excluded from a model-only visualization. Never invent it.
        const knownForm = Object.keys(values).length === 8 && Object.entries(x2dPrime).every(([key,value]) => values[key] === value) && values.F > 0;
        if (includeAuxiliary || rawConfiguration.printer_model !== 'Bambu Lab X2D' || sourceNozzles.length !== 2 || !sourceNozzles.every(value => value === 0.4) ||
          machineStartEnd < 0 || commandLineStart >= machineStartEnd || modelSectionSeen || feature !== PRINT_FEATURE.custom ||
          unit !== 1 || !absolute || absoluteE || !knownForm) {
          throw new Error('不支持的 G130 形式或使用区段，无法完整还原真实模型路径或全部辅助挤出。');
        }
        excludedStartupExtrusionMacros++;
        positionKnown.fill(false); extrusionPositionKnown = false;
        connected = false; motion = null; return;
      }
      if (code.startsWith('130.')) throw new Error(`不支持的 G${code} 指令，无法完整还原真实切片。`);
      if (MACHINE_G_CODES.has(code)) {
        if (values.E !== undefined) throw new Error(`不支持的 G${code} 运动，无法完整还原真实切片；不会静默遗漏墙线或填充。`);
        if (code === '29.4' && Object.keys(values).length) throw new Error('不支持的 G29.4 参数，无法完整还原真实切片。');
        const unknownAxes = MACHINE_G_CODES.get(code);
        for (let axis = 0; axis < 3; axis++) {
          if (unknownAxes === 'XYZ' || unknownAxes === 'specified' && values['XYZ'[axis]] !== undefined) positionKnown[axis] = false;
        }
        connected = false; motion = null; return;
      }
      // Decimal subcodes are identifiers: G29.20 is not G29.2, nor may an
      // unknown G29.10 silently inherit the known G29.1 calibration behavior.
      if (/^(?:28|29|150|383)\./.test(code)) throw new Error(`不支持的 G${code} 指令，无法完整还原真实切片。`);
      switch (command.value) {
        case 20: unit = 25.4; return;
        case 21: unit = 1; return;
        case 90: absolute = true; return;
        case 91: absolute = false; return;
        case 90.1: centerAbsolute = true; return;
        case 91.1: centerAbsolute = false; return;
        case 17: case 18: case 19: plane = command.value; return;
        case 28:
          if (values.E !== undefined) throw new Error('回零指令不能包含待还原的模型挤出。');
          for (let axis = 0; axis < 3; axis++) positionKnown[axis] = false;
          connected = false; motion = null; return;
        case 92:
          for (let axis = 0; axis < 3; axis++) if (values['XYZ'[axis]] !== undefined) {
            if (!positionKnown[axis]) throw new Error('机器动作后的位置未知，无法可靠还原 G92 坐标偏移。');
            offset[axis] = point[axis] - values['XYZ'[axis]] * unit;
          }
          if (values.E !== undefined) { e = values.E * unit; extrusionPositionKnown = true; }
          return;
        case 0: case 1: case 2: case 3: motion = command.value; break;
        default:
          // Dwell, bare retract/homing/probing and cancel-cycle instructions
          // are not deposited model paths. Unknown trajectories must never
          // inherit an earlier G1 mode and disappear from an "exact" slice.
          if ([4, 10, 11, 28, 29, 30, 80].includes(command.value) && values.E === undefined) { connected = false; return; }
          if ([5, 6, 7].includes(command.value) || Object.keys(values).some(key => 'XYZIJKER'.includes(key))) {
            throw new Error(`不支持的 G${command.value} 运动，无法完整还原真实切片；不会静默遗漏墙线或填充。`);
          }
          connected = false;
          return;
      }
    } else if (command) return;
    if (motion === null || !Object.keys(values).some(key => 'XYZE'.includes(key))) return;
    const start = point.slice();
    const startPositionKnown = positionKnown.every(Boolean);
    for (let axis = 0; axis < 3; axis++) {
      const value = values['XYZ'[axis]];
      if (value !== undefined) {
        point[axis] = absolute ? value * unit + offset[axis] : point[axis] + value * unit;
        if (absolute) positionKnown[axis] = true;
      }
    }
    if (values.E !== undefined && absoluteE && !extrusionPositionKnown) throw new Error('机器启动挤出后的挤出坐标未知，需要 G92 E 明确重设后才能还原绝对挤出。');
    const previousE = e;
    if (values.E !== undefined) e = absoluteE ? values.E * unit : e + values.E * unit;
    const arc = motion === 2 || motion === 3;
    const xyMoved = Math.hypot(point[0] - start[0], point[1] - start[1]) > 1e-9 || (arc && (values.I !== undefined || values.J !== undefined));
    if (e - previousE <= 1e-9 || !xyMoved) { connected = false; return; }
    allExtrusionMoves++;
    rawFeatureCounts[PRINT_FEATURE_NAMES[feature]] = (rawFeatureCounts[PRINT_FEATURE_NAMES[feature]] || 0) + 1;
    if (feature === PRINT_FEATURE.unknown) {
      unknownExtrusionMoves++;
      if (featureLabel) {
        unknownFeatureLabels[featureLabel] = (unknownFeatureLabels[featureLabel] || 0) + 1;
        if (strictFeatures) throw new Error(`无法识别切片用途“${featureLabel}”，不能完整还原真实墙线和填充。`);
      }
    }
    if (!includeAuxiliary && !MODEL_FEATURES.has(feature) && !(includeSupport && SUPPORT_FEATURES.has(feature))) { connected = false; return; }
    if (!startPositionKnown || !positionKnown.every(Boolean)) throw new Error('机器校准或擦嘴后缺少明确的绝对定位，无法完整还原后续打印路径。');
    if ([...start, ...point].some(value => !Number.isFinite(value) || Math.abs(value) > 1e7)) throw new Error('真实切片路径包含异常坐标。');
    if (!connected) stroke++;
    if (arc) {
      if (plane !== 17) throw new Error('仅支持 XY 平面 G17 的打印圆弧；其他圆弧不会被静默丢弃。');
      const arcEnds = arcPoints(start, point, motion, values, { unit, centerAbsolute, coordinateOffset: offset, toleranceMm: arcToleranceMm });
      let previous = start;
      for (const next of arcEnds) { append(previous, next); previous = next; }
      sampledArcMoves++;
    } else append(start, point);
    connected = true;
  };
  const wordPattern = /([A-Z])\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))/g;
  let nextProgressCharacter = 1_048_576;
  reportProgress('parse', 0, text.length);
  for (let start = 0; start < text.length;) {
    commandLineStart = start;
    if (onProgress && start >= nextProgressCharacter) {
      reportProgress('parse', start, text.length);
      nextProgressCharacter = start + 1_048_576;
    }
    let end = text.indexOf('\n', start); if (end < 0) end = text.length;
    if (end - start > 65536) throw new Error('切片包含异常长行，不能完整读取。');
    let line = text.slice(start, end); start = end + 1;
    const commentAt = line.indexOf(';');
    if (commentAt >= 0) {
      const comment = line.slice(commentAt + 1).trim();
      const virtualTool = !line.slice(0, commentAt).trim() && comment.match(/^VT\s*([+-]?\d+)(?=\s|$)/i);
      if (virtualTool) {
        const filament = Number(virtualTool[1]);
        if (!Number.isInteger(filament) || filament < 0 || filament >= 255) throw new Error('切片虚拟耗材编号无效，无法保证真实颜色。');
        execute({ letter: 'T', value: filament }, Object.create(null));
      }
      const typed = comment.match(/^(?:TYPE|FEATURE)\s*:\s*(.*)$/i);
      if (typed) { featureLabel = typed[1].trim(); const next = classifyPrintFeature(featureLabel); if (next !== feature) { connected = false; stroke++; } feature = next; if (MODEL_FEATURES.has(next) || SUPPORT_FEATURES.has(next)) modelSectionSeen = true; }
      if (/^(?:(?:printing object|LAYER_CHANGE|CHANGE_LAYER)(?=\s|:|$)|layer #\d)/i.test(comment)) modelSectionSeen = true;
      const size = comment.match(/^(WIDTH|HEIGHT|LINE_WIDTH|LAYER_HEIGHT)\s*:\s*([\d.]+)/i);
      if (size) {
        const value = Number(size[2]);
        if (!Number.isFinite(value) || value <= 0 || value > 100) throw new Error('切片路径截面尺寸无效。');
        if (/WIDTH/i.test(size[1])) { if (width !== value) connected = false; width = value; widthExplicit = true; }
        else { if (height !== value) connected = false; height = value; heightExplicit = true; }
      }
      const config = comment.match(/^([a-z][\w]*)\s*=\s*(.*)$/i);
      if (config) rawConfiguration[config[1].toLowerCase()] = config[2].trim();
      const palette = comment.match(/^(?:filament|extruder)_colou?rs?\s*[:=]\s*(.*)$/i);
      if (palette) {
        const raw = palette[1].trim().replace(/^\[/, '').replace(/\]$/, '');
        const colors = /[;,]/.test(raw) ? raw.split(/[;,]/) : raw.match(/#[\da-f]{6}(?:[\da-f]{2})?\b/gi) || [];
        for (let i = 0; i < colors.length; i++) { const match = colors[i].match(/#([\da-f]{6})(?:[\da-f]{2})?\b/i); if (match) toolColors[i] = `#${match[1].toLowerCase()}`; }
      }
      // Bambu headers may provide only one-based filament XML, not a palette.
      const filament = comment.match(/^<filament\s.*?\bid="(\d+)".*?\bcolor="(#([\da-f]{6})(?:[\da-f]{2})?)"/i);
      if (filament && Number(filament[1]) > 0) toolColors[Number(filament[1]) - 1] = `#${filament[3].toLowerCase()}`;
      if (/^(?:printing object|stop printing object|WIPE|WIPE_TOWER|LAYER_CHANGE|CHANGE_LAYER|layer #)/i.test(comment)) connected = false;
      line = line.slice(0, commentAt);
    }
    line = line.split('*')[0].replace(/\([^)]*\)/g, '').toUpperCase();
    if (!line.trim()) continue;
    // In Bambu's SYNC command T is waiting time, not a filament selector.
    // Its parameters must not be reparsed as T or inherited axis movements.
    if (/^\s*(?:N\d+\s*)?SYNC(?:\s|$)/.test(line)) continue;
    wordPattern.lastIndex = 0;
    let command = null, values = Object.create(null), match;
    while ((match = wordPattern.exec(line))) {
      const letter = match[1], value = Number(match[2]);
      if (!Number.isFinite(value) || letter === 'N') continue;
      if (letter === 'G' || letter === 'M' || (letter === 'T' && command === null)) {
        if (command) execute(command, values);
        command = { letter, value, code: match[2].replace(/^\+?0+(?=\d)/, '') }; values = Object.create(null);
      } else values[letter] = value;
    }
    execute(command, values);
  }
  if (!count) throw new Error('未找到带墙、填充或表面类型标记的真实模型切片路径；不能用单色实心平面代替。');
  positions = positions.slice(0, count * 6); tools = tools.slice(0, count); features = features.slice(0, count);
  widths = widths.slice(0, count); heights = heights.slice(0, count); strokes = strokes.slice(0, count);
  const sortedKeys = [...printedLayerKeys].sort((a, b) => a - b);
  const layerHeights = Float64Array.from(sortedKeys, key => key / 10000);
  const ids = new Map(sortedKeys.map((key, index) => [key, index]));
  const layers = new Uint32Array(count), layerOffsets = new Uint32Array(layerHeights.length + 1), bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  reportProgress('parse', text.length, text.length);
  reportProgress('index', 0, count * 3);
  const usedTools = new Set(), featureCounts = {};
  for (let i = 0; i < count; i++) {
    if (onProgress && i % 65536 === 0) reportProgress('index', i, count * 3);
    const id = ids.get(keys[i]); layers[i] = id; layerOffsets[id + 1]++;
    usedTools.add(tools[i]); featureCounts[PRINT_FEATURE_NAMES[features[i]]] = (featureCounts[PRINT_FEATURE_NAMES[features[i]]] || 0) + 1;
    for (let endpoint = 0; endpoint < 2; endpoint++) for (let axis = 0; axis < 3; axis++) {
      const value = positions[i * 6 + endpoint * 3 + axis]; bounds.min[axis] = Math.min(bounds.min[axis], value); bounds.max[axis] = Math.max(bounds.max[axis], value);
    }
  }
  for (let i = 1; i < layerOffsets.length; i++) layerOffsets[i] += layerOffsets[i - 1];
  const cursor = layerOffsets.slice(0, -1), layerSegments = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    if (onProgress && i % 65536 === 0) reportProgress('index', count + i, count * 3);
    layerSegments[cursor[layers[i]]++] = i;
  }
  const sectionSources={width:{annotation:count-inferredWidthSegments,saved:0,bambuDefault:0},height:{annotation:count-inferredHeightSegments,saved:0,layerSpacing:0,bambuDefault:0,studioDefault:0}};
  const heightFallback = provenance => provenance.source === 'studio-default' ? 'studioDefault' : provenance.source === 'bambu-default' ? 'bambuDefault' : 'saved';
  const roleWidth={1:'outerWall',2:'innerWall',3:'sparseInfill',4:'solidInfill',5:'topSurface',6:'solidInfill',7:'default',8:'solidInfill',9:'topSurface',16:'outerWall'};
  for(let index=0;index<count;index++){
    if (onProgress && index % 65536 === 0) reportProgress('index', count * 2 + index, count * 3);
    const layer=layers[index];
    if(inferredHeights[index]){
      const field=layer===0?'firstLayerHeightMm':'layerHeightMm',provenance=savedSettings.fields[field];
      const spacing=layer>0?layerHeights[layer]-layerHeights[layer-1]:layerHeights[0];
      if(layer===0&&!['bambu-default','studio-default'].includes(provenance.source)){heights[index]=savedSettings[field];sectionSources.height.saved++;}
      else if(Number.isFinite(spacing)&&spacing>0&&spacing<=10){heights[index]=spacing;sectionSources.height.layerSpacing++;}
      else {heights[index]=savedSettings[field]||defaultHeightMm;sectionSources.height[heightFallback(provenance)]++;}
    }
    if(inferredWidths[index]){
      const name=layer===0?'initial':roleWidth[features[index]]||'default',field=savedSettings.fields[`lineWidthsMm.${name}`];
      widths[index]=savedSettings.lineWidthsMm[name]||defaultWidthMm;
      let supportWidth=null;
      if(layer>0&&SUPPORT_FEATURES.has(features[index])){
        const raw=String(rawConfiguration[features[index]===11?'support_interface_line_width':'support_line_width']??rawConfiguration.support_line_width??'').trim();
        const value=Number(raw.replace(/%$/,''));
        if(raw&&Number.isFinite(value)&&value>0&&value<=100)supportWidth=raw.endsWith('%')?value*savedSettings.nozzleDiameterMm/100:value;
      }
      if(supportWidth!==null){widths[index]=supportWidth;sectionSources.width.saved++;}
      else sectionSources.width[field.source==='bambu-default'?'bambuDefault':'saved']++;
    }
  }
  const labeledUnknown = Object.values(unknownFeatureLabels).reduce((sum, value) => sum + value, 0);
  if (unknownExtrusionMoves > labeledUnknown) warnings.push(`${(unknownExtrusionMoves-labeledUnknown).toLocaleString('zh-CN')} 段未标注类型的挤出未作为模型填充；未猜测其用途。`);
  if (labeledUnknown) warnings.push(`有 ${labeledUnknown} 段已标注但无法识别的用途；结果不完整，不得用于真实打印显示。`);
  if (excludedStartupExtrusionMacros) warnings.push(`${excludedStartupExtrusionMacros} 条 G130 机器启动预挤出由固件内部生成，未作为模型路径；后续模型路径在定位重同步后完整保留。`);
  if (inferredWidthSegments || inferredHeightSegments) warnings.push('部分路径未逐段记录截面：优先使用保存的用途线宽、首层参数和实际层间距；缺项层高按工具默认 0.16 mm，首层及其他缺项按拓竹基准参数。路径与工具编号保持完整，截面仍标为近似。');
  reportProgress('index', count * 3, count * 3);
  return { version: 1, source: 'sliced-gcode', coordinates: 'printer-mm-z-up', exactLinearPaths: labeledUnknown === 0, segmentCount: count,
    positions, tools, features, widths, heights, strokes, layers, layerHeights, layerOffsets, layerSegments, bounds,
    featureCounts, rawFeatureCounts, rawConfiguration, toolColors, usedTools: [...usedTools].sort((a, b) => a - b),
    allExtrusionMoves, sampledArcMoves, arcToleranceMm, unknownExtrusionMoves, unknownFeatureLabels, excludedStartupExtrusionMacros, inferredWidthSegments, inferredHeightSegments, sectionSources, warnings };
}

/** Highest completely deposited model layer at an absolute printer Z. */
export function printLayerAtHeight(parsed, heightMm) {
  if (!Number.isFinite(heightMm)) throw new TypeError('打印层高度必须是有限毫米数。');
  const values = parsed.layerHeights;
  let low = 0, high = values.length;
  while (low < high) { const middle = (low + high) >>> 1; if (values[middle] <= heightMm + 1e-6) low = middle + 1; else high = middle; }
  return low - 1;
}

/**
 * Selection is O(paths in selected layers), not O(all paths) per video frame.
 * Historical voids remain voids: only actual extrusion segments are selected.
 */
export function selectPrintLayerSegments(parsed, { layerIndex, historyLayers = 1, includeSupport = false } = {}) {
  if (!Number.isInteger(layerIndex) || layerIndex < -1 || layerIndex >= parsed.layerHeights.length) throw new RangeError('打印层索引无效。');
  if (!Number.isInteger(historyLayers) || historyLayers < 1 || historyLayers > parsed.layerHeights.length + 1) throw new RangeError('打印层历史范围无效。');
  if (layerIndex === -1) return new Uint32Array(0);
  const first = Math.max(0, layerIndex - historyLayers + 1), result = [];
  for (let layer = first; layer <= layerIndex; layer++) {
    for (let i = parsed.layerOffsets[layer]; i < parsed.layerOffsets[layer + 1]; i++) {
      const segment = parsed.layerSegments[i], feature = parsed.features[segment];
      if (MODEL_FEATURES.has(feature) || (includeSupport && SUPPORT_FEATURES.has(feature))) result.push(segment);
    }
  }
  return Uint32Array.from(result);
}

/**
 * Canonical bead is a closed unit cylinder along Y, with diameter 1 in X/Z.
 * Instance columns encode actual width, path length and actual layer height.
 * The upper bead surface is at G-code Z; its center is Z - HEIGHT/2.
 * An explicit known printer→source affine transform is mandatory. It may be
 * identity for an unchanged 3MF build placement. It must never be an auto fit.
 */
export function buildPrintLayerInstances(parsed, { layerIndex, historyLayers = 1, includeSupport = false,
  printerToSource, toolColors = parsed.toolColors, strictColors = true } = {}) {
  const transform = matrixElements(printerToSource);
  const segments = selectPrintLayerSegments(parsed, { layerIndex, historyLayers, includeSupport });
  const matrices = new Float32Array(segments.length * 16), tools = new Uint16Array(segments.length), features = new Uint8Array(segments.length);
  const colors = [], missingColors = new Set();
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i], offset = segment * 6;
    const ax = parsed.positions[offset], ay = parsed.positions[offset + 1], az = parsed.positions[offset + 2];
    const bx = parsed.positions[offset + 3], by = parsed.positions[offset + 4], bz = parsed.positions[offset + 5];
    const dx = bx - ax, dy = by - ay, dz = bz - az, planarLength = Math.hypot(dx, dy);
    const width = parsed.widths[segment], height = parsed.heights[segment];
    const base = [-(dy / planarLength) * width, (dx / planarLength) * width, 0, 0,
      dx, dy, dz, 0, 0, 0, height, 0, (ax + bx) / 2, (ay + by) / 2, (az + bz) / 2 - height / 2, 1];
    const target = i * 16;
    for (let column = 0; column < 4; column++) for (let row = 0; row < 4; row++) {
      matrices[target + column * 4 + row] = transform[row] * base[column * 4] + transform[4 + row] * base[column * 4 + 1] + transform[8 + row] * base[column * 4 + 2] + transform[12 + row] * base[column * 4 + 3];
    }
    const tool = parsed.tools[segment], color = toolColors?.[tool];
    tools[i] = tool; features[i] = parsed.features[segment];
    if (!/^#[\da-f]{6}$/i.test(color || '')) missingColors.add(tool);
    colors.push(/^#[\da-f]{6}$/i.test(color || '') ? color.toLowerCase() : null);
  }
  if (strictColors && missingColors.size) throw new Error(`缺少耗材 ${[...missingColors].map(tool => tool + 1).join('、')} 的原始颜色，不能把所有填充猜成一种颜色。`);
  return { matrices, tools, features, colors, segments, instanceCount: segments.length,
    layerIndex, heightMm: layerIndex < 0 ? null : parsed.layerHeights[layerIndex], coordinates: 'explicit-source-affine',
    missingColors: [...missingColors], source: 'sliced-gcode', exactLinearPaths: true, arcToleranceMm: parsed.arcToleranceMm };
}

/** A deterministic explicit axis conversion; opt in, do not infer from bounds. */
export const PRINTER_MM_TO_THREE_MM = Object.freeze([1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1]);
export const PRINTER_MM_IDENTITY = identity;

/** Transferable view for workers / binary storage, keeping source arrays exact. */
export function printLayerTransferables(parsed) {
  return ['positions', 'tools', 'features', 'widths', 'heights', 'strokes', 'layers', 'layerHeights', 'layerOffsets', 'layerSegments'].map(key => parsed[key].buffer);
}
