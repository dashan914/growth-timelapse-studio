/**
 * Parse the straight extrusion paths in a textual G-code file.
 * Coordinates and layer heights are returned in millimetres, with Z pointing up.
 * Each segment occupies six entries in positions and one in layers/tools.
 * Layers are indexed by increasing printed Z height, irrespective of travel Z hops.
 */
export function parseGCode(text, { maxSegments = 500000, supportOnly = false } = {}) {
  if (typeof text !== 'string') throw new TypeError('G-code 必须是文本。');
  const textLimitMB = supportOnly ? 256 : 64;
  if (text.length > textLimitMB * 1024 * 1024) {
    throw new RangeError(`G-code 超过 ${textLimitMB} MB 文本限制，请导出较小的文件。`);
  }
  if (!Number.isSafeInteger(maxSegments) || maxSegments < 1 || maxSegments > 2000000) {
    throw new RangeError('maxSegments 必须是 1 至 2000000 之间的整数。');
  }

  const warnings = [];
  const warningKeys = new Set();
  const warn = (key, message) => {
    if (!warningKeys.has(key)) {
      warningKeys.add(key);
      warnings.push(message);
    }
  };

  let capacity = Math.min(8192, maxSegments);
  let positions = new Float32Array(capacity * 6);
  let tools = new Uint16Array(capacity);
  let support = new Uint8Array(capacity);
  let widths = new Float32Array(capacity);
  let heights = new Float32Array(capacity);
  let printedHeights = new Float64Array(capacity);
  let segmentCount = 0;
  let highestPrintedTool = -1;
  const usedTools = new Set();
  const colorHeaders = new Map();
  const printedLayerKeys = new Set();
  const point = [0, 0, 0];
  const coordinateOffset = [0, 0, 0];
  let e = 0;
  let unit = 1;
  let absoluteCoordinates = true;
  let absoluteExtrusion = true;
  let tool = 0;
  let motion = null;
  let supportFeature = false;
  let supportSegmentCount = 0;
  let currentWidth = 0.42;
  let currentHeight = 0.12;
  let atLimit = false;
  const axisLetters = ['X', 'Y', 'Z'];

  const appendSegment = (start, end) => {
    if (segmentCount === maxSegments) {
      atLimit = true;
      warn('limit', `打印路径超过 ${maxSegments.toLocaleString('en-US')} 段限制，后续路径未读取，结果不完整。`);
      return;
    }
    if (segmentCount === capacity) {
      capacity = Math.min(maxSegments, capacity * 2);
      const grownPositions = new Float32Array(capacity * 6);
      const grownTools = new Uint16Array(capacity);
      const grownSupport = new Uint8Array(capacity);
      const grownWidths = new Float32Array(capacity);
      const grownHeightsPerSegment = new Float32Array(capacity);
      const grownHeights = new Float64Array(capacity);
      grownPositions.set(positions);
      grownTools.set(tools);
      grownSupport.set(support);
      grownWidths.set(widths);
      grownHeightsPerSegment.set(heights);
      grownHeights.set(printedHeights);
      positions = grownPositions;
      tools = grownTools;
      support = grownSupport;
      widths = grownWidths;
      heights = grownHeightsPerSegment;
      printedHeights = grownHeights;
    }
    const offset = segmentCount * 6;
    positions.set(start, offset);
    positions.set(end, offset + 3);
    tools[segmentCount] = tool;
    support[segmentCount] = supportFeature ? 1 : 0;
    widths[segmentCount] = currentWidth;
    heights[segmentCount] = currentHeight;
    if (supportFeature) supportSegmentCount++;
    // A tiny rounding tolerance merges numerical noise, without using travel heights.
    const layerKey = Math.round(Math.max(start[2], end[2]) * 10000);
    printedHeights[segmentCount] = layerKey;
    printedLayerKeys.add(layerKey);
    highestPrintedTool = Math.max(highestPrintedTool, tool);
    usedTools.add(tool);
    segmentCount += 1;
  };

  const execute = (command, parameters) => {
    if (command?.letter === 'T') {
      if (Number.isInteger(command.value) && command.value >= 0 && command.value <= 65535) {
        tool = command.value;
      } else {
        warn('tool', '文件含超出 0–65535 范围的工具编号，该工具切换已忽略。');
      }
      return;
    }
    if (command?.letter === 'M') {
      if (command.value === 82) absoluteExtrusion = true;
      if (command.value === 83) absoluteExtrusion = false;
      // T parameters on M commands, such as M104 T1, do not switch tools.
      return;
    }
    if (command?.letter === 'G') {
      switch (command.value) {
        case 20: unit = 25.4; return;
        case 21: unit = 1; return;
        case 90: absoluteCoordinates = true; return;
        case 91: absoluteCoordinates = false; return;
        case 92:
          for (let axis = 0; axis < 3; axis += 1) {
            if (parameters[axisLetters[axis]] !== undefined) {
              coordinateOffset[axis] = point[axis] - parameters[axisLetters[axis]] * unit;
            }
          }
          if (parameters.E !== undefined) e = parameters.E * unit;
          return;
        case 0:
        case 1:
        case 2:
        case 3:
          motion = command.value;
          break;
        default:
          return;
      }
    } else if (command) {
      return;
    }
    if (motion === null) return;

    const start = point.slice();
    for (let axis = 0; axis < 3; axis += 1) {
      const value = parameters[axisLetters[axis]];
      if (value !== undefined) {
        point[axis] = absoluteCoordinates
          ? value * unit + coordinateOffset[axis]
          : point[axis] + value * unit;
      }
    }
    const previousE = e;
    if (parameters.E !== undefined) {
      e = absoluteExtrusion ? parameters.E * unit : e + parameters.E * unit;
    }
    // Arc endpoints and E state still advance, so following straight paths do not
    // accidentally draw a chord across a skipped arc.
    if (motion === 2 || motion === 3) {
      warn('arc', '文件含 G2/G3 圆弧：当前仅显示 G0/G1 直线挤出，圆弧已跳过，结果不完整。建议关闭切片器的圆弧拟合后重新导出。');
      return;
    }
    if (e - previousE > 1e-9 && Math.hypot(point[0] - start[0], point[1] - start[1]) > 1e-9) {
      if (point.some(value => !Number.isFinite(value) || Math.abs(value) > 1e7)) {
        warn('coordinate', '文件含异常坐标，对应打印路径已忽略。');
        return;
      }
      if (!supportOnly || supportFeature) appendSegment(start, point);
    }
  };

  // G-code E words are extrusion, not scientific notation: compact X1E2 is X=1,E=2.
  const wordPattern = /([A-Z])\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))/g;
  let lineStart = 0;
  while (lineStart < text.length && !atLimit) {
    let lineEnd = text.indexOf('\n', lineStart);
    if (lineEnd < 0) lineEnd = text.length;
    if (lineEnd - lineStart > 65536) {
      warn('line', '文件含超过 64 KB 的单行，该行已忽略。');
      lineStart = lineEnd + 1;
      continue;
    }
    let line = text.slice(lineStart, lineEnd);
    lineStart = lineEnd + 1;
    // Orca/Bambu/Prusa configs preserve zero-based filament order. Read the
    // original comment before removing ';', including quoted JSON-style lists.
    const colorHeader = line.match(/^\s*;\s*((?:filament|extruder)_colou?rs?)\s*[:=]\s*(.*)$/i);
    if (colorHeader) {
      const raw = colorHeader[2].trim().replace(/^\[/, '').replace(/\]$/, '');
      const tokens = /[;,]/.test(raw) ? raw.split(/[;,]/) : raw.match(/#[\da-f]{6}(?:[\da-f]{2})?\b/gi) || [raw];
      colorHeaders.set(colorHeader[1].toLowerCase().replace('colour', 'color'), tokens.map(value => {
        const match = value.match(/#([\da-f]{6})(?:[\da-f]{2})?\b/i);
        return match ? `#${match[1].toLowerCase()}` : null;
      }));
    }
    const commentIndex = line.indexOf(';');
    if (commentIndex >= 0) {
      const feature = line.slice(commentIndex + 1).match(/^\s*(?:TYPE|FEATURE)\s*:\s*(.*)$/i);
      if (feature) supportFeature = /\bsupport\b/i.test(feature[1]);
      const dimension = line.slice(commentIndex + 1).match(/^\s*(WIDTH|HEIGHT)\s*:\s*([\d.]+)/i);
      if (dimension) {
        const size = Number(dimension[2]);
        if (Number.isFinite(size) && size > 0 && size <= 10) {
          if (dimension[1].toUpperCase() === 'WIDTH') currentWidth = size;
          else currentHeight = size;
        }
      }
    }
    if (commentIndex >= 0) line = line.slice(0, commentIndex);
    const checksumIndex = line.indexOf('*');
    if (checksumIndex >= 0) line = line.slice(0, checksumIndex);
    line = line.replace(/\([^)]*\)/g, '').toUpperCase();
    wordPattern.lastIndex = 0;
    let command = null;
    let parameters = Object.create(null);
    let matched;
    while ((matched = wordPattern.exec(line)) !== null) {
      const letter = matched[1];
      const value = Number(matched[2]);
      if (!Number.isFinite(value)) continue;
      if (letter === 'N') continue;
      const isCommand = letter === 'G' || letter === 'M' || (letter === 'T' && command === null);
      if (isCommand) {
        if (command !== null) execute(command, parameters);
        command = { letter, value };
        parameters = Object.create(null);
      } else {
        parameters[letter] = value;
      }
    }
    execute(command, parameters);
  }

  if (segmentCount === 0) {
    const detail = warningKeys.has('arc') ? ' 文件中的 G2/G3 圆弧尚不支持，请关闭圆弧拟合后重新导出。' : '';
    if (supportOnly) throw new Error(`切片结果中没有标记为 Support 的实际支撑挤出路径。${detail}`);
    throw new Error(`未找到可用的打印路径：需要带正挤出量的 G0/G1 XY 移动。${detail}`);
  }
  positions = positions.slice(0, segmentCount * 6);
  tools = tools.slice(0, segmentCount);
  support = support.slice(0, segmentCount);
  widths = widths.slice(0, segmentCount);
  heights = heights.slice(0, segmentCount);
  const sortedKeys = [...printedLayerKeys].sort((a, b) => a - b);
  const layerHeights = sortedKeys.map(key => key / 10000);
  const layerIds = new Map(sortedKeys.map((key, index) => [key, index]));
  const layers = new Uint32Array(segmentCount);
  const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (let segment = 0; segment < segmentCount; segment += 1) {
    layers[segment] = layerIds.get(printedHeights[segment]);
    for (let endpoint = 0; endpoint < 2; endpoint += 1) {
      for (let axis = 0; axis < 3; axis += 1) {
        const value = positions[segment * 6 + endpoint * 3 + axis];
        bounds.min[axis] = Math.min(bounds.min[axis], value);
        bounds.max[axis] = Math.max(bounds.max[axis], value);
      }
    }
  }
  const toolColors = [];
  // Filament colors describe AMS/MMU tools more faithfully than a printer's
  // generic extruder color. Missing entries may still use the latter.
  for (const key of ['extruder_color', 'extruder_colors', 'filament_colors', 'filament_color']) {
    colorHeaders.get(key)?.forEach((color, index) => { if (color) toolColors[index] = color; });
  }
  return { positions, layers, tools, support, widths, heights, supportSegmentCount, layerHeights, bounds, segmentCount, toolCount: highestPrintedTool + 1, usedTools: [...usedTools].sort((a, b) => a - b), toolColors, warnings };
}
