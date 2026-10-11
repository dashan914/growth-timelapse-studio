import { unzipSync, zipSync, strFromU8, strToU8 } from 'three/addons/libs/fflate.module.js';

// Mathematical unit facts from the 3MF Core model/transform definitions; the
// Production extension scopes resources and component paths per model file.
export const THREE_MF_UNIT_SOURCES = Object.freeze([
  'https://github.com/3MFConsortium/spec_core/blob/master/3MF%20Core%20Specification.md',
  'https://github.com/3MFConsortium/spec_production/blob/master/3MF%20Production%20Extension.md',
]);
export const THREE_MF_UNIT_TO_MM = Object.freeze({ micron: .001, millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8, meter: 1000 });
const MAX_ARCHIVE = 512 * 1024 * 1024, MAX_MODEL = 350 * 1024 * 1024;
const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const decode = value => value.replace(/&(#x[\da-f]+|#\d+|quot|apos|lt|gt|amp);/gi, (_, entity) => {
  if (entity[0] === '#') { const point = entity[1]?.toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10); if (!point || point > 0x10ffff) throw new Error('3MF XML 字符引用无效。'); return String.fromCodePoint(point); }
  return { quot: '"', apos: "'", lt: '<', gt: '>', amp: '&' }[entity.toLowerCase()];
});
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const local = name => name.split(':').pop();

function packagePath(value, parent = '') {
  if (!value || /^(?:[\w+.-]+:|\/\/)/.test(value) || value.includes('\\') || value.includes('\0')) throw new Error('3MF 模型或纹理路径必须位于原文件包内。');
  const path = value.startsWith('/') ? value.slice(1) : parent.slice(0, parent.lastIndexOf('/') + 1) + value;
  const parts = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (!parts.length) throw new Error('3MF 路径越过文件包。'); parts.pop(); }
    else parts.push(part);
  }
  return parts.join('/');
}
function attributes(raw) {
  const result = new Map();
  for (const match of raw.matchAll(/([^\s=<>/]+)\s*=\s*(["'])([\s\S]*?)\2/g)) {
    if (result.has(match[1])) throw new Error('3MF XML 包含重复属性。');
    result.set(match[1], { value: decode(match[3]), rawName: match[1] });
  }
  return result;
}
function attribute(attrs, name) {
  const match = [...attrs].find(([key]) => local(key) === name);
  return match?.[1].value ?? null;
}
function update(raw, attrs, name, value) {
  const key = [...attrs.keys()].find(key => local(key) === name);
  if (!key) return raw.replace(/\/?\s*>$/, ending => ` ${name}="${escape(value)}"${ending}`);
  const pattern = new RegExp(`(${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=\\s*)(["'])([\\s\\S]*?)\\2`);
  return raw.replace(pattern, (_, prefix) => `${prefix}"${escape(value)}"`);
}
function coordinate(value, factor, label) {
  if (!NUMBER.test(value || '')) throw new Error(`3MF ${label}不是有效有限数。`);
  const scaled = Number(value) * factor;
  if (!Number.isFinite(scaled) || Math.abs(scaled) > 3.4028234663852886e38) throw new Error(`3MF ${label}超出完整 Float32 显示范围，不能丢弃或猜测。`);
  return Object.is(scaled, -0) ? '0' : String(scaled);
}

/** XML tag scanner, with quoted >, comments and CDATA excluded from rewrites.
 * It does not evaluate entities, instructions or any text inside metadata. */
function walkTags(text, visit) {
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error('3MF 不支持 XML 外部文档或实体。');
  const stack = []; let cursor = 0, copied = 0; const output = [];
  while ((cursor = text.indexOf('<', cursor)) >= 0) {
    if (text.startsWith('<!--', cursor) || text.startsWith('<![CDATA[', cursor) || text.startsWith('<?', cursor)) {
      const ending = text.startsWith('<!--', cursor) ? '-->' : text.startsWith('<![CDATA[', cursor) ? ']]>' : '?>';
      const end = text.indexOf(ending, cursor + 2); if (end < 0) throw new Error('3MF XML 注释或声明不完整。'); cursor = end + ending.length; continue;
    }
    let end = cursor + 1, quote = null;
    for (; end < text.length; end++) { const c = text[end]; if (quote) { if (c === quote) quote = null; } else if (c === '"' || c === "'") quote = c; else if (c === '>') break; }
    if (end === text.length) throw new Error('3MF XML 标记不完整。');
    const raw = text.slice(cursor, end + 1), match = /^<\s*(\/?)\s*([\w.-]+(?::[\w.-]+)?)/.exec(raw);
    if (!match) throw new Error('3MF XML 标记无效。');
    const closing = Boolean(match[1]), name = match[2], tag = local(name), empty = /\/\s*>$/.test(raw);
    if (closing) { if (stack.pop() !== name) throw new Error('3MF XML 嵌套损坏。'); }
    const replaced = visit({ raw, name, tag, closing, empty, ancestors: stack.map(local), attrs: closing ? new Map() : attributes(raw) });
    if (replaced !== undefined && replaced !== raw) { output.push(text.slice(copied, cursor), replaced); copied = end + 1; }
    if (!closing && !empty) stack.push(name);
    cursor = end + 1;
  }
  if (stack.length) throw new Error('3MF XML 根节点不完整。');
  if (!output.length) return text;
  output.push(text.slice(copied)); return output.join('');
}

/** Normalize an INTERNAL VIEWER COPY before the fixed ThreeMFLoader. Its loader
 * records unit but does not scale, ignores production p:path, and pools object
 * IDs across all model documents. Here each document becomes physical mm and
 * resource IDs are globally namespaced. Triangle/property indexes, colors, UVs,
 * texture bytes and source ZIP are untouched. Do not export this as the source
 * manufacturing project; upload the original file to the slicer.
 */
export function normalizeThreeMFUnitsForLoader(input) {
  const data = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (!data.byteLength || data.byteLength > MAX_ARCHIVE) throw new Error('3MF 文件为空或超过完整显示上限。');
  let total = 0;
  const archive = unzipSync(data, { filter: entry => { total += entry.originalSize; if (entry.originalSize > MAX_ARCHIVE || total > MAX_ARCHIVE) throw new Error('3MF 展开超过 512 MiB，未删减数据。'); return true; } });
  const models = new Map();
  for (const [path, bytes] of Object.entries(archive)) if (/\.model$/i.test(path)) {
    if (bytes.byteLength > MAX_MODEL) throw new Error('3MF 单模型 XML 过大，未删减网格。');
    const text = strFromU8(bytes), stop = {}; let attrs;
    try { walkTags(text, token => { if (!token.closing && !token.ancestors.length) { if (token.tag !== 'model') throw new Error(`3MF 缺少 model 根节点：${path}`); attrs = token.attrs; throw stop; } }); }
    catch (error) { if (error !== stop) throw error; }
    if (!attrs) throw new Error(`3MF 缺少 model 根节点：${path}`);
    const unit = attribute(attrs, 'unit') ?? 'millimeter';
    if (!Object.hasOwn(THREE_MF_UNIT_TO_MM, unit)) throw new Error(`3MF 单位“${unit}”不受支持，不能按毫米猜测。`);
    models.set(packagePath('/' + path), { sourcePath: path, text, unit, factor: THREE_MF_UNIT_TO_MM[unit], ids: new Map(), objects: new Map(), vertexCount: 0, triangleCount: 0, transforms: 0 });
  }
  if (!models.size) throw new Error('3MF 没有 model 文件。');
  const rels = archive['_rels/.rels']; if (!rels) throw new Error('3MF 缺少原包主模型关系。');
  let primaryPath;
  walkTags(strFromU8(rels), ({ tag, attrs, closing }) => { if (!closing && tag === 'Relationship' && /\/3dmodel$/i.test(attribute(attrs, 'Type') || '')) { if (primaryPath) throw new Error('3MF 主模型关系重复。'); primaryPath = packagePath(attribute(attrs, 'Target')); } });
  if (!models.has(primaryPath)) throw new Error('3MF 主模型关系指向缺失模型。');
  const primary = models.get(primaryPath);
  let nextID = 1, modelIndex = 0;
  for (const [path, model] of models) {
    model.viewerPath = path === primaryPath ? '3D/3dmodel.model' : `3D/UnitModels/unit-${modelIndex}.model`; modelIndex++;
    let activeObject = null;
    walkTags(model.text, ({ tag, attrs, closing, ancestors }) => {
      if (!closing && ancestors.at(-1) === 'resources') {
        const id = attribute(attrs, 'id');
        if (id !== null) { if (!/^\d+$/.test(id) || model.ids.has(id)) throw new Error(`3MF 模型 ${path} 的资源 ID 无效或重复。`); model.ids.set(id, String(nextID++)); }
        if (tag === 'object') { activeObject = id; model.objects.set(id, []); }
      }
      if (!closing && tag === 'vertex' && ancestors.includes('vertices')) model.vertexCount++;
      if (!closing && tag === 'triangle' && ancestors.includes('triangles')) model.triangleCount++;
      if (!closing && tag === 'component') {
        const target = attribute(attrs, 'path'), targetPath = target ? packagePath(target, path) : path;
        if (target && path !== primaryPath && targetPath !== path) throw new Error('3MF 子模型含不支持的跨文件组件引用。');
        model.objects.get(activeObject)?.push({ path: targetPath, id: attribute(attrs, 'objectid') });
      }
      if (closing && tag === 'object') activeObject = null;
    });
  }
  const verifiedObjects = new Map();
  const checkObject = (path, id, parents = new Set()) => {
    const key = `${path}#${id}`, model = models.get(path);
    if (!model?.objects.has(id)) throw new Error(`3MF 缺少引用对象：${key}`);
    if (parents.has(key) || parents.size >= 64) throw new Error('3MF 组件循环或嵌套过深。');
    if (verifiedObjects.has(key)) return verifiedObjects.get(key);
    let depth = 1;
    for (const reference of model.objects.get(id)) depth = Math.max(depth, 1 + checkObject(reference.path, reference.id, new Set([...parents, key])));
    if (depth > 64) throw new Error('3MF 组件嵌套过深。'); verifiedObjects.set(key, depth); return depth;
  };
  for (const [path, model] of models) for (const id of model.objects.keys()) checkObject(path, id);
  const copy = Object.fromEntries(Object.entries(archive).filter(([path]) => !/\.model(?:\.rels)?$/i.test(path) && path !== '_rels/.rels'));
  const textures = new Set(), textureCopies = new Map();
  for (const [path, model] of models) {
    const normalized = walkTags(model.text, token => {
      const { tag, attrs, closing, ancestors } = token; if (closing) return token.raw;
      let raw = token.raw;
      if (tag === 'model') raw = update(raw, attrs, 'unit', 'millimeter');
      if (ancestors.at(-1) === 'resources' && attribute(attrs, 'id') !== null) raw = update(raw, attrs, 'id', model.ids.get(attribute(attrs, 'id')));
      if (tag === 'vertex' && ancestors.includes('vertices')) for (const axis of ['x','y','z']) raw = update(raw, attrs, axis, coordinate(attribute(attrs, axis), model.factor, '顶点 ' + axis));
      if (tag === 'component' || tag === 'item' && ancestors.includes('build') && path === primaryPath) {
        const target = attribute(attrs, 'path'), targetPath = target ? packagePath(target, path) : path, targetModel = models.get(targetPath), id = attribute(attrs, 'objectid');
        if (!targetModel?.objects.has(id)) throw new Error(`3MF 引用对象缺失：${targetPath}#${id}`);
        raw = update(raw, attrs, 'objectid', targetModel.ids.get(id));
        if (target) raw = update(raw, attrs, 'path', '/' + targetModel.viewerPath);
        const transform = attribute(attrs, 'transform');
        if (transform) {
          const values = transform.trim().split(/\s+/);
          if (values.length !== 12 || values.some(value => !NUMBER.test(value) || !Number.isFinite(Number(value)))) throw new Error('3MF 变换矩阵无效。');
          for (let index = 9; index < 12; index++) values[index] = coordinate(values[index], model.factor, '变换平移');
          raw = update(raw, attrs, 'transform', values.join(' ')); model.transforms++;
        }
      }
      for (const name of ['pid','texid','displaypropertiesid','clippingmesh','representationmesh']) {
        const id = attribute(attrs, name);
        if (id !== null) { if (!model.ids.has(id)) throw new Error(`3MF 模型 ${path} 缺少属性资源 ${id}。`); raw = update(raw, attrs, name, model.ids.get(id)); }
      }
      if (tag === 'texture2d') {
        const target = packagePath(attribute(attrs, 'path'), path);
        if (!archive[target]) throw new Error('3MF 纹理文件缺失，不能丢弃原贴图。');
        let viewerTexture = target;
        if (!/^3D\/Textures?\//.test(target)) {
          if (!textureCopies.has(target)) textureCopies.set(target, `3D/Textures/unit-${textureCopies.size}-${target.split('/').pop()}`);
          viewerTexture = textureCopies.get(target); copy[viewerTexture] = archive[target];
        }
        raw = update(raw, attrs, 'path', '/' + viewerTexture); textures.add(viewerTexture);
      }
      if (model.factor !== 1 && ['beamlattice','beam','ball'].includes(tag)) for (const name of ['r','r1','r2','minlength']) {
        const value = attribute(attrs, name); if (value !== null) raw = update(raw, attrs, name, coordinate(value, model.factor, '梁格测量'));
      }
      return raw;
    });
    copy[model.viewerPath] = strToU8(normalized);
  }
  copy['_rels/.rels'] = strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="root" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" Target="/3D/3dmodel.model"/></Relationships>');
  copy['3D/_rels/3dmodel.model.rels'] = strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + [...textures].map((path,index) => `<Relationship Id="texture-${index}" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dtexture" Target="/${escape(path)}"/>`).join('') + '</Relationships>');
  // Native loader discovers children before root; deterministic package order
  // and global resource IDs make production references unambiguous.
  const ordered = { ...Object.fromEntries(Object.entries(copy).filter(([path]) => !/\.model$/.test(path))),
    ...Object.fromEntries([...models.values()].filter(model => model !== primary).map(model => [model.viewerPath,copy[model.viewerPath]])),
    [primary.viewerPath]: copy[primary.viewerPath] };
  if (Object.values(ordered).reduce((sum, bytes) => sum + bytes.byteLength, 0) > MAX_ARCHIVE) throw new Error('标准 3MF 完整显示副本超过 512 MiB，未删减模型或原贴图。');
  const normalizedData = zipSync(ordered, { level: 0 });
  return { data: normalizedData, sourceUnitsToMm: 1, sourceUnitsInferred: false, sourceCoordinateUnit: 'millimeter',
    viewerCopyOnly: true, originalZIPUnchanged: true, resourceIDsNamespaced: models.size > 1,
    mixedUnits: new Set([...models.values()].map(model => model.unit)).size > 1,
    models: [...models.values()].map(model => ({ sourcePath: model.sourcePath, viewerPath: model.viewerPath,
      sourceUnit: model.unit, unitScaleMm: model.factor, vertices: model.vertexCount, triangles: model.triangleCount, transforms: model.transforms })),
  };
}

export const normalizeStandardThreeMFUnits = normalizeThreeMFUnitsForLoader;
