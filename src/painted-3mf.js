import * as THREE from 'three';
import { unzipSync, strFromU8 } from 'three/addons/libs/fflate.module.js';
import { parseFDMSlicerSettings, resolveFDMSurfaceProfile } from './fdm-surface.js';
import { withCreaseNormals } from './crease-normals.js';

// The format below is the slicers' persistent format, not a face-color guess:
// bambulab/BambuStudio src/libslic3r/Model.cpp: FacetsAnnotation string conversion
// and TriangleSelector.cpp: serialize, deserialize, perform_split. Prusa's
// mmu_segmentation and Bambu/Orca's paint_color use the same triangle tree.
export const PAINT_FORMAT_SOURCES = [
  'https://github.com/bambulab/BambuStudio/blob/master/src/libslic3r/Model.cpp',
  'https://github.com/bambulab/BambuStudio/blob/master/src/libslic3r/TriangleSelector.cpp',
  'https://github.com/bambulab/BambuStudio/blob/master/src/libslic3r/Format/bbs_3mf.cpp',
  'https://github.com/OrcaSlicer/OrcaSlicer/blob/main/src/libslic3r/TriangleSelector.cpp',
  'https://github.com/CrealityOfficial/CrealityPrint/blob/master/src/libslic3r/TriangleSelector.cpp',
];

const MAX_XML_BYTES = 350 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 500 * 1024 * 1024;
const MAX_TRIANGLES = 6_000_000;
const MAX_PAINT_NODES = 100_000;
const tag = name => new RegExp(`<(?:[\\w.-]+:)?${name}\\b([^>]*?)(?:\\/>|>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${name}\\s*>)`, 'gi');
const unescapeXML = value => String(value ?? '').replace(/&(#x[\da-f]+|#\d+|quot|apos|lt|gt|amp);/gi, (_, entity) => {
  if (entity[0] === '#') {
    const point = entity[1]?.toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : '';
  }
  return { quot: '"', apos: "'", lt: '<', gt: '>', amp: '&' }[entity.toLowerCase()];
});
const attrExpressions = new Map();
function attr(attributes, name) {
  if (!attrExpressions.has(name)) attrExpressions.set(name, new RegExp(`(?:^|\\s)(?:[\\w.-]+:)?${name}\\s*=\\s*(["'])(.*?)\\1`, 'i'));
  return unescapeXML(attributes.match(attrExpressions.get(name))?.[2] ?? '');
}
const entries = (text, name) => [...text.matchAll(tag(name))];
const normalizedPath = path => {
  const result = [];
  for (const part of path.replaceAll('\\', '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') result.pop(); else result.push(part);
  }
  return result.join('/');
};
const asHex = color => /^#[\da-f]{6}(?:[\da-f]{2})?$/i.test(String(color)) ? String(color).slice(0, 7).toLowerCase() : null;
const midpoint = (a, b) => a.map((coordinate, i) => (coordinate + b[i]) / 2);
const nextTask = () => new Promise(resolve => setTimeout(resolve, 0));

function validateXML(text, label) {
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error(`${label} 包含不支持的 XML 文档类型。`);
  if (typeof DOMParser === 'undefined') return;
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error(`${label} 的 XML 格式损坏。`);
}

function splitChildren(triangle, sides, special) {
  if (special > 2 || (sides === 3 && special !== 0)) throw new Error('涂色三角形包含无效的细分方向。');
  const a = triangle[special], b = triangle[(special + 1) % 3], c = triangle[(special + 2) % 3];
  if (sides === 1) {
    const bc = midpoint(b, c);
    return [[a, b, bc], [bc, c, a]];
  }
  const ab = midpoint(a, b), ac = midpoint(a, c);
  if (sides === 2) return [[a, ab, ac], [ab, b, ac], [b, c, ac]];
  const bc = midpoint(b, c);
  return [[a, ab, ac], [ab, b, bc], [bc, c, ac], [ab, bc, ac]];
}

function readLeafState(readNibble, code, extendedStates = 'chain') {
  if (code !== 12) return code >> 2;
  if (extendedStates === 'orca') {
    const nibble = readNibble();
    return nibble === 15 ? readNibble() + 18 : nibble + 3;
  }
  let state = 3, part;
  do { part = readNibble(); state += part; } while (part === 15);
  if (state > 255) throw new Error('涂色耗材编号超出支持范围。');
  return state;
}

/** Decode one painted original face into its exact midpoint-subdivided leaves.
 * Returned states are slicer states: 0 inherits the object's extruder; 1 is
 * filament 1. No colors are averaged across a painted boundary. */
export function decodePaintedTriangle(encoded, triangle, { maxNodes = MAX_PAINT_NODES, extendedStates = 'chain' } = {}) {
  if (triangle.length !== 3 || triangle.some(vertex => vertex.length !== 3 || vertex.some(value => !Number.isFinite(value)))) throw new Error('三角形顶点无效。');
  if (!encoded) return [{ vertices: triangle, state: 0 }];
  if (!/^[\da-f]+$/i.test(encoded) || encoded.length > maxNodes * 3) throw new Error('涂色编码不是有效的十六进制数据。');
  let offset = encoded.length - 1;
  const readNibble = () => {
    if (offset < 0) throw new Error('涂色细分数据被截断。');
    return parseInt(encoded[offset--], 16);
  };
  const stack = [{ vertices: triangle, depth: 0 }], leaves = [];
  let nodes = 0;
  while (stack.length) {
    const node = stack.pop();
    if (++nodes > maxNodes || node.depth > 64) throw new Error('涂色细分过于复杂，请简化模型后重新导入。');
    const code = readNibble(), sides = code & 3;
    if (!sides) leaves.push({ vertices: node.vertices, state: readLeafState(readNibble, code, extendedStates) });
    else {
      const children = splitChildren(node.vertices, sides, code >> 2);
      // Slicer serialization visits the last child first. Pushing in ascending
      // order makes the stack visit children in that same reverse order.
      children.forEach(vertices => stack.push({ vertices, depth: node.depth + 1 }));
    }
  }
  if (offset !== -1) throw new Error('涂色数据包含多余的节点，无法准确还原。');
  return leaves;
}

function uniformPaintState(encoded, extendedStates) {
  if (!encoded) return 0;
  if (!/^[\da-f]+$/i.test(encoded) || (parseInt(encoded.at(-1), 16) & 3)) return null;
  let offset = encoded.length - 1;
  const read = () => {
    if (offset < 0) throw new Error('涂色耗材数据被截断。');
    return parseInt(encoded[offset--], 16);
  };
  const state = readLeafState(read, read(), extendedStates);
  if (offset !== -1) throw new Error('涂色数据包含多余的节点。');
  return state;
}

function metadata(text) {
  const result = {};
  for (const match of entries(text, 'metadata')) {
    const key = attr(match[1], 'key') || attr(match[1], 'name');
    if (key) result[key] = attr(match[1], 'value') || unescapeXML(match[2] ?? '');
  }
  return result;
}

export function parseSlicerSettings(projectText = '', modelText = '') {
  let project = {};
  if (projectText.trim().startsWith('{')) {
    try { project = JSON.parse(projectText); } catch { throw new Error('3MF 工程的耗材设置 JSON 损坏。'); }
  } else {
    // PrusaSlicer older project archives store a serialized config instead.
    for (const line of projectText.split(/\r?\n/)) {
      const match = line.match(/^\s*(?:;\s*)?([\w]+)\s*=\s*(.*?)\s*$/);
      if (match) project[match[1]] = match[2];
    }
  }
  const value = project.filament_colour ?? project.filament_color ?? project.extruder_colour ?? project.extruder_color;
  const colors = (Array.isArray(value) ? value : String(value ?? '').split(/[;,]/)).map(asHex);
  if (colors.some(color => color === null)) {
    if (value) throw new Error('工程中有无法读取的耗材颜色，请在切片软件中保存六位十六进制颜色。');
    colors.length = 0;
  }
  if (modelText) validateXML(modelText, '工程对象设置');
  const objects = new Map();
  for (const match of entries(modelText, 'object')) {
    const objectBody = match[2] ?? '';
    const parts = new Map();
    for (const part of [...entries(objectBody, 'part'), ...entries(objectBody, 'volume')]) {
      const data = metadata(part[2] ?? '');
      const first = attr(part[1], 'firstid'), last = attr(part[1], 'lastid');
      const id = attr(part[1], 'id');
      parts.set(id || `range:${first}`, {
        ...data, subtype: attr(part[1], 'subtype') || attr(part[1], 'type') || data.volume_type || 'normal_part',
        first: first === '' ? null : Number(first), last: last === '' ? null : Number(last),
      });
    }
    // Part extruder must not overwrite the containing object's default.
    const withoutParts = objectBody.replace(tag('part'), '').replace(tag('volume'), '');
    objects.set(attr(match[1], 'id'), { ...metadata(withoutParts), parts });
  }
  return { project, colors, objects, ...parseFDMSlicerSettings(project, colors.length) };
}

function transformMatrix(text, unitScale = 1) {
  const matrix = new THREE.Matrix4();
  if (!text) return matrix;
  const values = text.trim().split(/\s+/).map(Number);
  if (values.length !== 12 || values.some(value => !Number.isFinite(value))) throw new Error('3MF 的模型变换矩阵无效。');
  matrix.set(values[0], values[3], values[6], values[9] * unitScale,
    values[1], values[4], values[7], values[10] * unitScale,
    values[2], values[5], values[8], values[11] * unitScale, 0, 0, 0, 1);
  return matrix;
}

function modelDefinition(text, path) {
  // Do not give DOMParser a million-face mesh. Validate the small envelope and
  // parse geometry directly into typed arrays; the user's 150 MB model needs
  // hundreds of MB less memory this way.
  validateXML(text.replace(tag('mesh'), '<mesh/>'), path);
  const root = text.match(/<(?:[\w.-]+:)?model\b([^>]*)>/i);
  if (!root) throw new Error(`缺少 3MF 模型根节点：${path}`);
  const unit = attr(root[1], 'unit') || 'millimeter';
  const unitScale = { micron: .001, millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8, meter: 1000 }[unit];
  if (!unitScale) throw new Error(`暂不支持模型单位：${unit}`);
  const objects = new Map();
  for (const match of entries(text, 'object')) {
    objects.set(attr(match[1], 'id'), {
      path, id: attr(match[1], 'id'), name: attr(match[1], 'name'), type: attr(match[1], 'type') || 'model',
      body: match[2] ?? '', unitScale,
    });
  }
  const buildBody = entries(text, 'build')[0]?.[2] ?? '';
  const resourceIndex = text.search(/<(?:[\w.-]+:)?resources\b/i);
  const application = metadata(text.slice(0, resourceIndex === -1 ? 4000 : resourceIndex)).Application ?? '';
  return { path, unitScale, objects, application, build: entries(buildBody, 'item').map(match => match[1]) };
}

function readVertices(body, unitScale) {
  const verticesBody = entries(body, 'vertices')[0]?.[2];
  if (verticesBody === undefined) throw new Error('3MF 网格缺少顶点。');
  let count = 0;
  const expression = /<(?:[\w.-]+:)?vertex\b([^>]*)\/?\s*>/gi;
  while (expression.exec(verticesBody)) count++;
  if (!count || count > MAX_TRIANGLES * 3) throw new Error('模型顶点数量为空或超过本机预览上限。');
  const positions = new Float32Array(count * 3);
  expression.lastIndex = 0;
  let match, index = 0;
  while ((match = expression.exec(verticesBody))) {
    for (const axis of ['x', 'y', 'z']) {
      const coordinate = Number(attr(match[1], axis)) * unitScale;
      if (!Number.isFinite(coordinate)) throw new Error('3MF 顶点包含无效坐标。');
      positions[index++] = coordinate;
    }
  }
  return positions;
}

function meshGeometry(definition, defaultExtruder, parts, paletteSize, counters, extendedStates) {
  const positions = readVertices(definition.body, definition.unitScale);
  const trianglesBody = entries(definition.body, 'triangles')[0]?.[2];
  if (trianglesBody === undefined) throw new Error('3MF 网格缺少三角形。');
  const expression = /<(?:[\w.-]+:)?triangle\b([^>]*)\/?\s*>/gi;
  const ranges = [...(parts?.values() ?? [])].filter(part => part.first !== null && part.last !== null);
  const bucketCounts = new Uint32Array(paletteSize);
  let count = 0, addedVertexCount = 0, match;
  const vertex = index => [positions[index * 3], positions[index * 3 + 1], positions[index * 3 + 2]];
  const readFace = attributes => {
    const ids = [Number(attr(attributes, 'v1')), Number(attr(attributes, 'v2')), Number(attr(attributes, 'v3'))];
    if (ids.some(id => !Number.isInteger(id) || id < 0 || id >= positions.length / 3)) throw new Error('3MF 三角形引用了不存在的顶点。');
    const encoded = attr(attributes, 'paint_color') || attr(attributes, 'mmu_segmentation');
    const part = ranges.find(part => count >= part.first && count <= part.last);
    const inherited = Number(part?.extruder || defaultExtruder);
    const tool = state => {
      const result = state ? state - 1 : inherited - 1;
      if (!Number.isInteger(result) || result < 0 || result >= paletteSize) throw new Error(`模型使用耗材 ${result + 1}，但工程没有保存对应颜色。`);
      return result;
    };
    const uniform = uniformPaintState(encoded, extendedStates);
    if (uniform !== null) return { ids, tool: tool(uniform), painted: !!encoded };
    return { leaves: decodePaintedTriangle(encoded, ids.map(vertex), { extendedStates }).map(leaf => ({ ...leaf, tool: tool(leaf.state) })), painted: true };
  };
  // Two passes retain original indexed vertices for unsplit facets and reserve
  // precise index ranges. There is no JS array per face and no material group
  // per face. Paint boundaries use separate material ranges, without blending.
  while ((match = expression.exec(trianglesBody))) {
    const face = readFace(match[1]);
    if (face.leaves) {
      addedVertexCount += face.leaves.length * 3;
      for (const leaf of face.leaves) bucketCounts[leaf.tool] += 3;
    } else bucketCounts[face.tool] += 3;
    count++;
    if (face.painted) counters.paintedFaces++;
    if (count + addedVertexCount / 3 > MAX_TRIANGLES) throw new Error('涂色模型展开后超过 600 万面，请分开导入模型；工具会保留完整网格，不会自动减面。');
  }
  if (!count) throw new Error('模型没有可显示的三角形。');
  counters.sourceFaces += count;
  counters.renderedFaces += bucketCounts.reduce((sum, size) => sum + size, 0) / 3;
  if (counters.renderedFaces > MAX_TRIANGLES) throw new Error('工程超过 600 万面，请分开导入模型。');
  const indexCount = bucketCounts.reduce((sum, size) => sum + size, 0);
  const indices = new Uint32Array(indexCount);
  const outputPositions = addedVertexCount ? new Float32Array(positions.length + addedVertexCount * 3) : positions;
  if (addedVertexCount) outputPositions.set(positions);
  const offsets = new Uint32Array(paletteSize);
  for (let i = 1; i < paletteSize; i++) offsets[i] = offsets[i - 1] + bucketCounts[i - 1];
  const cursors = offsets.slice();
  let appendedVertex = positions.length / 3;
  count = 0;
  expression.lastIndex = 0;
  while ((match = expression.exec(trianglesBody))) {
    const face = readFace(match[1]);
    if (face.leaves) {
      for (const leaf of face.leaves) {
        for (const position of leaf.vertices) {
          outputPositions.set(position, appendedVertex * 3);
          indices[cursors[leaf.tool]++] = appendedVertex++;
        }
      }
    } else {
      indices.set(face.ids, cursors[face.tool]);
      cursors[face.tool] += 3;
    }
    count++;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(outputPositions, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  for (let i = 0; i < paletteSize; i++) if (bucketCounts[i]) geometry.addGroup(offsets[i], bucketCounts[i], i);
  geometry.computeBoundingBox();
  geometry.userData.painted3MF = true;
  // 3MF carries facet positions, not authored shading normals. Smooth only
  // connected gentle curves; retain wall, bevel and stair hard edges exactly.
  const shaded = withCreaseNormals(geometry);
  geometry.dispose();
  return shaded;
}

/** Loads actual Bambu / Orca / compatible Creality project colors. Standard
 * 3MFs with no slicer-specific color information return root:null so the native
 * loader retains standard materials, textures, and vertex colors. Incomplete
 * or unknown proprietary paint is rejected explicitly rather than recolored. */
export async function loadPaintedThreeMF(data, _options = {}) {
  let total = 0;
  const archive = unzipSync(data instanceof Uint8Array ? data : new Uint8Array(data), { filter: entry => {
    if (!/\.(model|config|rels|ini)$/i.test(entry.name)) return false;
    total += entry.originalSize;
    if (entry.originalSize > MAX_XML_BYTES || total > MAX_ARCHIVE_BYTES) throw new Error('3MF 解压后过大，请拆分工程后导入。');
    return true;
  } });
  const texts = new Map(Object.entries(archive).map(([path, bytes]) => [normalizedPath(path), strFromU8(bytes)]));
  const findText = pattern => [...texts].find(([path]) => pattern.test(path))?.[1] ?? '';
  const settings = parseSlicerSettings(
    findText(/(?:project_settings\.config|PrusaSlicer\.ini|Slic3r_PE\.config)$/i),
    findText(/(?:model_settings\.config|Slic3r_PE_model\.config)$/i),
  );
  // A slicer's negative volume changes the manufactured shape at slice time.
  // Merely hiding it would leave the uncut CAD shell in the completed frame.
  // Check before standard-material fallback too; unknown paint is unrelated.
  const negativeVolume = [...settings.objects.values()].some(object =>
    [...object.parts.values()].some(part => /^(?:negative_part|negative_volume|NegativeVolume)$/i.test(part.subtype)));
  if (negativeVolume) throw new Error('工程包含尚未应用的减料体，无法保证完成模型与真实切片重合。请先在建模或切片软件中应用布尔减料，再导出完整模型；也可直接导入原 G-code 查看打印路径。');
  let hasPaint = false;
  for (const [path, text] of texts) if (/\.model$/i.test(path) && /\b(?:paint_color|mmu_segmentation)\s*=/.test(text)) hasPaint = true;
  const hasExtruders = [...settings.objects.values()].some(object => object.extruder || [...object.parts.values()].some(part => part.extruder));
  const recognized = hasPaint || hasExtruders;
  const supportEnabled = /^(?:1|true)$/i.test(String(settings.project.enable_support ?? settings.project.support_material ?? ''));
  const warnings = [];
  const surfaceMetadata = Object.fromEntries(['layerHeightMm','firstLayerHeightMm','lineWidthMm','surfaceSettingsInferred','materialProfiles','surfaceApproximate'].map(key => [key, settings[key]]));
  const result = { root: null, recognized, warnings, materialColors: settings.colors, colorSupport: 'none', supportsAvailable: false, supportEnabled, ...surfaceMetadata };
  if (!recognized) return result;
  if (!settings.colors.length) throw new Error('检测到切片工程涂色，但工程没有保存耗材颜色；请在切片软件中重新保存完整的 3MF 工程。');
  const definitions = new Map();
  for (const [path, text] of texts) if (/\.model$/i.test(path)) definitions.set(path, modelDefinition(text, path));
  const relationships = findText(/^_rels\/\.rels$/i);
  const rootTarget = entries(relationships, 'Relationship').find(match => /3dmodel$/i.test(attr(match[1], 'Type')))?.[1];
  const rootPath = rootTarget ? normalizedPath(attr(rootTarget, 'Target')) : [...definitions.keys()].find(path => /^3d\/3dmodel\.model$/i.test(path)) ?? [...definitions.keys()][0];
  const rootDefinition = definitions.get(rootPath);
  if (!rootDefinition) throw new Error('3MF 工程找不到主模型。');
  // Current Orca encodes its final state 33 as FFC, whereas current Bambu
  // uses a continuation chain (0FFC). Their states 0..32 are identical.
  const extendedStates = /OrcaSlicer/i.test(rootDefinition.application) ? 'orca' : 'chain';
  const materialColors = settings.colors;
  const materials = materialColors.map((color, toolIndex) => {
    const filament = settings.materialProfiles[toolIndex];
    const profile = resolveFDMSurfaceProfile('auto', filament?.profile ?? 'pla');
    const material = new THREE.MeshStandardMaterial({ color, roughness: profile.roughness, metalness: 0 });
    material.name = `耗材 ${toolIndex + 1}`;
    material.userData.toolIndex = toolIndex;
    material.userData.fdmProfile = profile.name;
    material.userData.filamentType = filament?.type ?? '';
    material.userData.filamentName = filament?.name ?? '';
    material.userData.fdmLayerHeightMm = settings.layerHeightMm;
    material.userData.fdmLineWidthMm = settings.lineWidthMm;
    return material;
  });
  const counters = { sourceFaces: 0, renderedFaces: 0, paintedFaces: 0, supportMeshes: 0 };
  const geometryCache = new Map();
  const hiddenPartTypes = new Set(['modifier_part', 'parameter_modifier', 'support_blocker', 'support_enforcer', 'other']);
  const instantiate = async (path, objectID, inherited = null, visited = new Set()) => {
    const key = `${path}#${objectID}`;
    if (visited.has(key) || visited.size > 64) throw new Error('3MF 组件包含循环引用或嵌套过深。');
    const definition = definitions.get(path)?.objects.get(String(objectID));
    if (!definition) throw new Error(`3MF 缺少组件：${key}`);
    const info = settings.objects.get(String(objectID)) ?? inherited;
    const part = inherited?.parts.get(String(objectID));
    const group = new THREE.Group();
    group.name = part?.name || info?.name || definition.name || `模型 ${objectID}`;
    group.userData.sourceObjectID = String(objectID);
    if (hiddenPartTypes.has(part?.subtype) || !['model', 'support'].includes(definition.type)) {
      group.userData.isSlicerModifier = true;
      return group;
    }
    group.userData.isSupport = definition.type === 'support';
    const extruder = Number(part?.extruder || info?.extruder || inherited?.extruder || 1);
    if (/<(?:[\w.-]+:)?mesh\b/i.test(definition.body)) {
      const geometryKey = `${key}:${extruder}`;
      if (!geometryCache.has(geometryKey)) {
        await nextTask();
        geometryCache.set(geometryKey, meshGeometry(definition, extruder, info?.parts, materialColors.length, counters, extendedStates));
      }
      const mesh = new THREE.Mesh(geometryCache.get(geometryKey), materials);
      mesh.name = group.name;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData.painted3MF = true;
      mesh.userData.isSupport = group.userData.isSupport;
      if (mesh.userData.isSupport) counters.supportMeshes++;
      group.add(mesh);
    }
    for (const component of entries(definition.body, 'component')) {
      const target = attr(component[1], 'path');
      const componentPath = target ? normalizedPath(target.startsWith('/') ? target : `${path.slice(0, path.lastIndexOf('/') + 1)}${target}`) : path;
      const child = await instantiate(componentPath, attr(component[1], 'objectid'), info, new Set([...visited, key]));
      child.applyMatrix4(transformMatrix(attr(component[1], 'transform'), definition.unitScale));
      group.add(child);
    }
    return group;
  };
  const root = new THREE.Group();
  root.name = '3MF 多色工程';
  try {
    for (const item of rootDefinition.build) {
      if (/^(?:0|false)$/i.test(attr(item, 'printable'))) continue;
      const target = attr(item, 'path');
      const itemPath = target ? normalizedPath(target.startsWith('/') ? target : `${rootPath.slice(0, rootPath.lastIndexOf('/') + 1)}${target}`) : rootPath;
      const group = await instantiate(itemPath, attr(item, 'objectid'));
      group.applyMatrix4(transformMatrix(attr(item, 'transform'), rootDefinition.unitScale));
      root.add(group);
    }
    if (!root.children.length) throw new Error('3MF 工程没有可打印的模型。');
  } catch (error) {
    for (const geometry of geometryCache.values()) geometry.dispose();
    materials.forEach(material => material.dispose());
    throw error;
  }
  result.supportsAvailable = counters.supportMeshes > 0;
  if (supportEnabled && !result.supportsAvailable) warnings.push('工程保存了自动支撑设置，未包含生成后的支撑几何；请导入切片后的支撑路径或导出的支撑模型。');
  root.userData.painted3MF = { ...counters, filamentColors: materialColors, supportEnabled, supportsAvailable: result.supportsAvailable, ...surfaceMetadata };
  result.root = root;
  result.colorSupport = hasPaint ? 'painted' : 'extruders';
  result.stats = counters;
  return result;
}
