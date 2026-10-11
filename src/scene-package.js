import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';
import { zipSync, strToU8, strFromU8 } from 'three/addons/libs/fflate.module.js';
import { coverTexture } from './growth-math.js';
import { normalizeLighting } from './lighting.js';
import { normalizeDof } from './preset-dof.js';
import { resolvePhotoLensDof, focusFromCompleteModelBounds } from './photo-lens-dof.js';
import { isManagedPrintEnvironmentTexture } from './print-environment.js';
import { validatePrintLayerData, validatePrintLayerMapping, resolvePrintLayerPalette } from './print-layer-renderer.js';
import { DEFAULT_LAYER_HEIGHT_MM, DEFAULT_FIRST_LAYER_HEIGHT_MM } from './slice-settings.js';

export const RENDER_PACKAGE_LIMITS = Object.freeze({ maxPixels: 8388608, maxFrames: 1800, maxBytes: 536870912, maxTextureSize: 8192, maxInstances: 4096, maxInstanceColors: 256, maxPrintSegments: 10000000, maxPrintLayers: 100000, maxPrintWindowSegments: 100000 });
const fail = message => { throw new Error(message); };
const bounded = (value, low, high, label, integer = false) => {
  const number = Number(value);
  if (!Number.isFinite(number) || number < low || number > high || integer && !Number.isInteger(number)) fail(`${label}需介于 ${low} 和 ${high}。`);
  return number;
};

export function normalizeRenderOutput(input = {}) {
  const width = bounded(input.width ?? 1920, 64, 4096, '渲染宽度', true);
  const height = bounded(input.height ?? 1080, 64, 4096, '渲染高度', true);
  if (width * height > RENDER_PACKAGE_LIMITS.maxPixels) fail('单帧像素超过高清渲染上限，请降低分辨率。');
  const fps = bounded(input.fps ?? 30, 1, 60, '帧率', true);
  const frames = bounded(input.frames ?? 240, 1, RENDER_PACKAGE_LIMITS.maxFrames, '总帧数', true);
  const growthFrames = bounded(input.growthFrames ?? frames, 1, frames, '生长帧数', true);
  const samples = Number(input.samples ?? 64);
  if (![64, 128].includes(samples)) fail('高清采样只支持 64 或 128。');
  const preview = {};
  if ('previewProgress' in input) {
    const progress = input.previewProgress;
    if (typeof progress !== 'number' || !Number.isFinite(progress) || progress < 0 || progress > 1) fail('写实预览的生长进度需介于 0 和 1。');
    if (frames !== 1 || growthFrames !== 1 || fps !== 1 || samples !== 64 || 'durationSeconds' in input || 'growthSeconds' in input) fail('写实预览需使用 1 帧、1 生长帧、1 帧每秒及 64 采样，不包含视频用时。');
    preview.previewProgress = progress;
  }
  const timing = {};
  if (input.durationSeconds !== undefined || input.growthSeconds !== undefined) {
    timing.durationSeconds = bounded(input.durationSeconds, 0.01, 610, '视频用时');
    timing.growthSeconds = bounded(input.growthSeconds, 0.01, timing.durationSeconds, '生长用时');
    if (Math.round(timing.durationSeconds * fps) !== frames) fail('视频用时与帧数不一致。');
  }
  return { directory: 'frames', width, height, fps, frames, growthFrames, samples, ...timing, ...preview };
}

/** Read transforms without updating the live object, scene, or its caches. */
export function detachedWorldMatrix(object) {
  const local = object.matrixAutoUpdate
    ? new THREE.Matrix4().compose(object.position, object.quaternion, object.scale)
    : object.matrix.clone();
  return object.parent ? detachedWorldMatrix(object.parent).multiply(local) : local;
}

export function renderMetricScale({ calibratedBed = null, bedWidthMm, bedDepthMm, normalizedScale, sourceUnitsToMm, sourceUnitsInferred = false } = {}) {
  if (calibratedBed && Number.isFinite(Number(bedWidthMm)) && Number(bedWidthMm) > 0) {
    const width = bounded(calibratedBed.width, 1e-8, 1e8, '校准底板宽度');
    const worldToMetres = bounded(bedWidthMm, 1, 10000, '底板实际宽度') / 1000 / width;
    if (bedDepthMm !== undefined) {
      const depth = bounded(calibratedBed.depth, 1e-8, 1e8, '校准底板深度');
      const otherScale = bounded(bedDepthMm, 1, 10000, '底板实际深度') / 1000 / depth;
      if (Math.abs(otherScale / worldToMetres - 1) > 0.02) fail('底板宽深的实际尺寸与透视校准比例不一致，请重新校准。');
    }
    return { worldToMetres, source: 'calibrated-bed', inferred: false };
  }
  const scale = bounded(normalizedScale, 1e-12, 1e12, '模型归一化比例');
  const units = bounded(sourceUnitsToMm, 1e-9, 1e9, '模型源单位');
  // User pose/display scaling remains inside the exported hierarchy. Cancelling
  // modelGroup.scale here would alter both its photographed size and framing.
  return { worldToMetres: units / scale / 1000, source: 'source-unit-and-normalization', inferred: Boolean(sourceUnitsInferred) };
}

/** Matches GrowthStudio._updateBackground at the final output aspect. */
export function renderBackgroundUV({ width, height, sourceWidth, sourceHeight, crop = null } = {}) {
  if (![width, height, sourceWidth, sourceHeight].every(value => Number.isFinite(value) && value > 0)) fail('背景照片尺寸无效。');
  const uv = crop ? { repeatX: crop.width, repeatY: crop.height, offsetX: crop.x, offsetY: 1 - crop.y - crop.height } : coverTexture(sourceWidth, sourceHeight, width, height);
  if (!Object.values(uv).every(Number.isFinite) || uv.repeatX <= 0 || uv.repeatY <= 0 || uv.offsetX < -1e-8 || uv.offsetY < -1e-8 || uv.offsetX + uv.repeatX > 1 + 1e-8 || uv.offsetY + uv.repeatY > 1 + 1e-8) fail('背景裁剪范围无效。');
  return { ...uv, rectangle: { x: uv.offsetX, y: 1 - uv.offsetY - uv.repeatY, width: uv.repeatX, height: uv.repeatY } };
}

function inspectMaterials(mesh, capabilities) {
  for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
    if (!material?.isMaterial || !(material.isMeshStandardMaterial || material.isMeshBasicMaterial)) fail(`“${mesh.name || '模型'}”材质暂不支持高清导出，请使用标准 PBR 或单色材质。`);
    if (material.bumpMap || material.displacementMap) fail('模型使用了无法无损传递的凹凸或位移贴图，请转换为法线贴图后使用高清渲染。');
    if (material.alphaHash || material.alphaToCoverage) capabilities.warnings.add('透明边缘在离线渲染中使用 glTF alphaMode，可能与实时预览略有差异。');
    if (material.envMap && !isManagedPrintEnvironmentTexture(material.envMap)) capabilities.warnings.add('环境照明按当前光影重建，源材质的环境反射贴图不属于 glTF 可传递的表面贴图。');
    for (const value of Object.values(material)) if (value?.isTexture && value !== material.envMap) {
      if (value.isCompressedTexture || value.isCubeTexture || value.isVideoTexture || value.isRenderTargetTexture) fail('高清导出暂不支持压缩、立方体、视频或动态渲染贴图，请使用普通本地图片贴图。');
      const image = value.image;
      if (image?.width > RENDER_PACKAGE_LIMITS.maxTextureSize || image?.height > RENDER_PACKAGE_LIMITS.maxTextureSize) fail('贴图超过 8192 像素；为避免自动缩小丢失细节，请先调整源贴图。');
      capabilities.textures.add(value);
    }
    capabilities.materials.add(material);
  }
}

function visibleMaterial(node) {
  return (Array.isArray(node.material) ? node.material : [node.material]).some(material => material?.visible !== false && material?.colorWrite !== false);
}

function isExcluded(node) {
  return Boolean(node.userData?.growthStencil || node.userData?.growthCap || node.userData?.growthTransient || node.userData?.growthPrintLayer || node.isLight || node.isCamera || node.isHelper || /Helper$/.test(node.type));
}

const PRINT_ARRAYS = Object.freeze({ positions: ['float32', 6], tools: ['uint16', 1], features: ['uint8', 1], widths: ['float32', 1], heights: ['float32', 1], strokes: ['uint32', 1], layers: ['uint32', 1], layerHeights: ['float64', 1], layerOffsets: ['uint32', 1], layerSegments: ['uint32', 1] });

/** Complete immutable slice table, never a snapshot of transient preview beads.
 * Both transforms are explicit; no bounding-box fit or hidden axis inference. */
export function packRenderPrintLayer(layer, worldToMetres, { includeSupport = false, preserveMaterials = true, color = '#b7bec8' } = {}) {
  const parsed = validatePrintLayerData(layer?.parsed);
  if (parsed.segmentCount > RENDER_PACKAGE_LIMITS.maxPrintSegments || parsed.layerHeights.length > RENDER_PACKAGE_LIMITS.maxPrintLayers) fail('真实切片超过高清完整段数或层数上限，不能删除路径；请使用实时导出。');
  if (new Uint8Array(new Uint32Array([1]).buffer)[0] !== 1) fail('当前平台不支持小端真实切片封装。');
  const historyLayers = bounded(layer.historyLayers ?? 3, 1, 32, '显示打印层数', true);
  const activePrefix = new Uint32Array(parsed.layerHeights.length + 1);
  for (let index = 0; index < parsed.segmentCount; index++) {
    const feature = parsed.features[index];
    if (feature >= 1 && feature <= 9 || feature === 16 || includeSupport && (feature === 10 || feature === 11)) activePrefix[parsed.layers[index] + 1]++;
  }
  for (let index = 1; index < activePrefix.length; index++) activePrefix[index] += activePrefix[index - 1];
  let maxWindowSegments = 0;
  for (let index = 0; index < parsed.layerHeights.length; index++) maxWindowSegments = Math.max(maxWindowSegments, activePrefix[index + 1] - activePrefix[Math.max(0, index - historyLayers + 1)]);
  if (maxWindowSegments > RENDER_PACKAGE_LIMITS.maxPrintWindowSegments) fail('真实切片单个显示层窗超过 100000 段，不能删减填充；请使用实时导出。');
  const printerToSource = validatePrintLayerMapping(layer.printerToSource);
  const sourceToWorld = validatePrintLayerMapping(layer.sourceToWorld);
  const printerToMetres = new THREE.Matrix4().makeScale(worldToMetres, worldToMetres, worldToMetres).multiply(sourceToWorld).multiply(printerToSource);
  const usedTools = [...new Set(parsed.tools)].sort((a, b) => a - b);
  if (!preserveMaterials && !/^#[\da-f]{6}$/i.test(color)) fail('统一渲染颜色无效，不会改变切片工具或路径。');
  const colors = resolvePrintLayerPalette(parsed, preserveMaterials ? layer.toolColors : Object.fromEntries(usedTools.map(tool => [tool, color])));
  const palette = usedTools.map(tool => ({ tool, color: colors[tool] }));
  let modelSegments = 0, supportSegments = 0;
  for (const feature of parsed.features) {
    if (feature >= 1 && feature <= 9 || feature === 16) modelSegments++;
    else if (feature === 10 || feature === 11) supportSegments++;
    else fail('真实切片含未支持用途，不能丢弃后称为完整。');
  }
  if (includeSupport && supportSegments) fail('高清渲染暂不能完整重建全部历史支撑路径，请关闭“显示支撑”或使用实时画质；不会省略支撑。');
  const arrays = {}; let size = 0;
  for (const [name, [type, itemSize]] of Object.entries(PRINT_ARRAYS)) {
    size = Math.ceil(size / 8) * 8;
    const value = parsed[name]; arrays[name] = { type, itemSize, count: value.length / itemSize, byteOffset: size, byteLength: value.byteLength };
    size += value.byteLength;
  }
  if (size > RENDER_PACKAGE_LIMITS.maxBytes) fail('真实切片完整数据超过 512 MiB，不会截断。');
  const bytes = new Uint8Array(size);
  for (const [name, spec] of Object.entries(arrays)) bytes.set(new Uint8Array(parsed[name].buffer, parsed[name].byteOffset, parsed[name].byteLength), spec.byteOffset);
  const manifest = { schemaVersion: 1, file: 'print-layer.bin', source: 'sliced-gcode', coordinates: 'printer-mm-z-up', endianness: 'little', exactLinearPaths: true, segmentCount: parsed.segmentCount, modelSegments, supportSegments, includeSupport: Boolean(includeSupport), layerCount: parsed.layerHeights.length, historyLayers, maxWindowSegments, arcToleranceMm: bounded(parsed.arcToleranceMm ?? 0.01, 1e-6, 0.1, '圆弧误差'), printerToMetres: printerToMetres.toArray(), palette, colorMode: preserveMaterials ? 'source-or-tool-overrides' : 'uniform-display', ...(preserveMaterials ? {} : { uniformColor: color.toLowerCase() }), arrays, crossSection: 'stadium-with-elliptical-fallback', originalPathsUnmodified: true };
  return { bytes, manifest };
}

// Blender 4.5 reads instance transforms but ignores the _COLOR_0 attribute of
// EXT_mesh_gpu_instancing. A material-colored group per exact source color
// preserves those colors without merging, reducing, or quantizing geometry.
function splitColoredInstances(node) {
  if (!node.isInstancedMesh || !node.instanceColor) return node;
  if (node.count > RENDER_PACKAGE_LIMITS.maxInstances) fail('实体支撑超过高清渲染的完整实例上限（4096），请使用实时导出；不会自动省略支撑或减面。');
  if (node.morphTexture) fail('逐实例形变无法在高清渲染中完整保留，请使用实时导出。');
  const colors = new Map();
  for (let index = 0; index < node.count; index++) {
    const color = new THREE.Color().fromBufferAttribute(node.instanceColor, index);
    const key = color.toArray().join(',');
    if (!colors.has(key)) colors.set(key, { color, indices: [] });
    colors.get(key).indices.push(index);
    if (colors.size > RENDER_PACKAGE_LIMITS.maxInstanceColors) fail('逐实例颜色超过完整保留上限（256），请使用实时导出；不会将颜色量化。');
  }
  const group = new THREE.Group(); group.name = node.name;
  group.position.copy(node.position); group.quaternion.copy(node.quaternion); group.scale.copy(node.scale);
  group.matrix.copy(node.matrix); group.matrixAutoUpdate = node.matrixAutoUpdate; group.visible = node.visible;
  group.userData = { ...node.userData, instanceColorsGrouped: true };
  const matrix = new THREE.Matrix4();
  for (const { color, indices } of colors.values()) {
    const materials = (Array.isArray(node.material) ? node.material : [node.material]).map(source => {
      const material = source.clone(); material.color?.multiply(color); return material;
    });
    const instances = new THREE.InstancedMesh(node.geometry, Array.isArray(node.material) ? materials : materials[0], indices.length);
    instances.name = `${node.name || '实体支撑'} · 保留源色`; instances.visible = node.visible;
    instances.userData = { ...node.userData }; instances.castShadow = node.castShadow; instances.receiveShadow = node.receiveShadow;
    for (let index = 0; index < indices.length; index++) { node.getMatrixAt(indices[index], matrix); instances.setMatrixAt(index, matrix); }
    group.add(instances);
  }
  for (const child of [...node.children]) group.add(child);
  return group;
}

export function cloneRenderGeometry(root, worldToMetres, { showSupports = true } = {}) {
  if (!root?.isObject3D) fail('缺少可渲染的模型。');
  const descendants = new Set(); root.traverse(node => descendants.add(node));
  const capabilities = { meshes: 0, triangles: 0, instances: 0, skins: 0, morphTargets: 0, materials: new Set(), textures: new Set(), warnings: new Set() };
  // Validate skeleton membership before SkeletonUtils.clone dereferences bones.
  root.traverse(node => {
    if (node.isSkinnedMesh && node.skeleton?.bones.some(bone => !descendants.has(bone))) fail('骨骼位于模型之外，无法完整保留当前姿态，请先将骨骼和网格放进同一模型文件。');
  });
  let cloned = cloneSkeleton(root);
  cloned.matrix.copy(detachedWorldMatrix(root)); cloned.matrixAutoUpdate = false;
  cloned.visible = true; // progress=0 hides the live model, but the source remains full.
  const regroup = (node, visible = true, support = false) => {
    visible &&= node.visible; support ||= Boolean(node.userData?.isSupport);
    if (!visible || support && !showSupports || isExcluded(node)) return node;
    for (const child of [...node.children]) {
      const replacement = regroup(child, visible, support);
      if (replacement !== child) { node.remove(child); node.add(replacement); }
    }
    return splitColoredInstances(node);
  };
  cloned = regroup(cloned);
  const geometries = new Map(), materials = new Map();
  const strip = (node, ancestorVisible = true, ancestorSupport = false) => {
    const support = ancestorSupport || Boolean(node.userData?.isSupport);
    const visible = ancestorVisible && node.visible && !(support && !showSupports);
    for (const child of [...node.children]) {
      if (!visible || isExcluded(child) || child.visible === false || !showSupports && child.userData?.isSupport) node.remove(child);
      else strip(child, visible, support);
    }
    if (!visible || isExcluded(node)) return;
    if (node.userData.printPathImpostor) fail('此模型只有真实打印路径，解析挤出表面使用实时画质；不能把代理平面当作原网格导出。');
    const line = node.isLine || node.isLineSegments2 || node.isPoints;
    if (line) {
      if (visibleMaterial(node)) fail('当前显示的是打印路径线段。高清渲染需使用网格模型与实体支撑，不能把路径静默转换为其他形状。');
      // Solid support meshes can be children of a hidden LineSegments2 drawing.
      node.isMesh = false; node.isLine = false; node.isLineSegments = false; node.isLineSegments2 = false; node.isPoints = false;
      node.type = 'Group'; node.material = undefined; node.geometry = undefined;
      return;
    }
    if (!node.isMesh) return;
    if (!visibleMaterial(node)) { node.parent?.remove(node); return; }
    const geometry = node.geometry;
    if (!geometry?.attributes.position) fail('模型网格缺少顶点位置。');
    const count = geometry.index?.count ?? geometry.attributes.position.count;
    if (count % 3) fail('模型包含非三角形网格，无法完整导出。');
    const morphs = Object.keys(geometry.morphAttributes).filter(key => geometry.morphAttributes[key]?.length);
    if (morphs.some(key => !['position', 'normal'].includes(key))) fail('模型包含无法保留的形变属性；高清导出仅支持位置和法线形变。');
    if (node.isInstancedMesh && node.count > RENDER_PACKAGE_LIMITS.maxInstances) fail('实体实例超过高清渲染的完整实例上限（4096），请使用实时导出；不会自动省略或减面。');
    inspectMaterials(node, capabilities);
    capabilities.meshes += 1;
    capabilities.triangles += count / 3 * (node.isInstancedMesh ? node.count : 1);
    capabilities.instances += node.isInstancedMesh ? node.count : 0;
    if (capabilities.instances > RENDER_PACKAGE_LIMITS.maxInstances) fail('实体实例总数超过高清完整渲染上限（4096），请使用实时导出；不会自动省略或减面。');
    capabilities.skins += node.isSkinnedMesh ? 1 : 0;
    capabilities.morphTargets += node.morphTargetInfluences?.length || 0;
    const sourceMaterials = Array.isArray(node.material) ? node.material : [node.material];
    const usesVertexColors = sourceMaterials.map(material => material.vertexColors === true);
    if (geometry.attributes.color && new Set(usesVertexColors).size > 1) fail('同一网格的材质混用了顶点色开关，无法忠实传递到 glTF；请按材质拆成独立网格后使用高清画质。');
    const colorEnabled = Boolean(geometry.attributes.color && usesVertexColors[0]);
    if (!geometries.has(geometry)) geometries.set(geometry, new Map());
    const variants = geometries.get(geometry);
    if (!variants.has(colorEnabled)) {
      const detached = geometry.clone();
      // glTF COLOR_0 always multiplies base color. GLTFExporter writes the
      // attribute even when Three's material.vertexColors is false, so omit
      // only that inactive attribute on this detached display variant. The
      // original geometry and its stored colors remain untouched.
      if (!colorEnabled) detached.deleteAttribute('color');
      variants.set(colorEnabled, detached);
    }
    node.geometry = variants.get(colorEnabled);
    // GLTFExporter can temporarily add an index or normalize a normal attribute.
    // Independent geometry ensures those operations never touch the live mesh.
    node.geometry.setDrawRange(0, Infinity);
    node.material = (Array.isArray(node.material) ? node.material : [node.material]).map(material => {
      if (!materials.has(material)) {
        const copy = material.clone(); copy.clippingPlanes = []; copy.stencilWrite = false;
        materials.set(material, copy);
      }
      return materials.get(material);
    });
    if (node.material.length === 1) node.material = node.material[0];
  };
  strip(cloned);
  if (!capabilities.meshes) fail('模型没有可见网格。');
  const scene = new THREE.Scene();
  const metricRoot = new THREE.Group(); metricRoot.name = 'PhysicalMetres'; metricRoot.scale.setScalar(worldToMetres);
  scene.add(metricRoot); metricRoot.add(cloned); scene.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(metricRoot, true);
  if (bounds.isEmpty() || ![...bounds.min.toArray(), ...bounds.max.toArray()].every(Number.isFinite)) fail('模型完整姿态的范围无效。');
  return { scene, bounds, capabilities: { ...capabilities, materials: capabilities.materials.size, textures: capabilities.textures.size, warnings: [...capabilities.warnings], fullGeometry: true, decimated: false, animations: 'static-current-pose' } };
}

export async function canonicalRenderPhoto(file, output, uv, { decode = globalThis.createImageBitmap, canvasFactory = () => document.createElement('canvas') } = {}) {
  if (!file || typeof decode !== 'function') fail('高清合成需要一张可读取的静态背景照片。');
  const bitmap = await decode(file);
  try {
    const canvas = canvasFactory(); canvas.width = output.width; canvas.height = output.height;
    const context = canvas.getContext('2d'); if (!context) fail('无法创建照片合成画布。');
    const r = uv.rectangle;
    context.drawImage(bitmap, r.x * bitmap.width, r.y * bitmap.height, r.width * bitmap.width, r.height * bitmap.height, 0, 0, output.width, output.height);
    const blob = await new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('无法封装背景照片。')), 'image/png'));
    return { bytes: new Uint8Array(await blob.arrayBuffer()), sourceWidth: bitmap.width, sourceHeight: bitmap.height };
  } finally { bitmap.close?.(); }
}

export async function createSceneRenderPackage(snapshot, options = {}, dependencies = {}) {
  if (snapshot.backgroundType === 'video' || options.backgroundFile?.type?.startsWith('video/')) fail('高清渲染目前支持固定机位与静态照片，请使用实时导出处理背景视频。');
  if (snapshot.mode && snapshot.mode !== 'mesh') fail('打印路径模式需使用实时导出，高清渲染不会静默改变路径。');
  if ((options.cameraMode ?? snapshot.cameraMode ?? 'fixed') !== 'fixed') fail('高清渲染只支持固定镜头，请关闭旋转动画。');
  const output = normalizeRenderOutput(options.output);
  const metric = renderMetricScale({ ...snapshot.units, bedWidthMm: options.bedWidthMm, bedDepthMm: options.bedDepthMm });
  const { scene, bounds, capabilities } = cloneRenderGeometry(snapshot.root, metric.worldToMetres, { showSupports: snapshot.settings?.showSupports !== false });
  const camera = snapshot.camera.clone();
  const cameraWorld = detachedWorldMatrix(snapshot.camera); cameraWorld.decompose(camera.position, camera.quaternion, camera.scale);
  camera.position.multiplyScalar(metric.worldToMetres); camera.scale.setScalar(1); camera.near *= metric.worldToMetres; camera.far *= metric.worldToMetres;
  camera.updateProjectionMatrix(); camera.updateMatrixWorld(true);
  const m = snapshot.floor?.matrix ? snapshot.floor.matrix : snapshot.floor?.object ? detachedWorldMatrix(snapshot.floor.object) : new THREE.Matrix4();
  const floorY = new THREE.Vector3().setFromMatrixPosition(m).y * metric.worldToMetres;
  const bed = snapshot.units?.calibratedBed;
  // Calibration rectangles establish metric scale. The actual shadow receiver
  // can be wider for a virtual photographic table and must match live preview.
  const width = snapshot.floor?.worldSize ? snapshot.floor.width : bed?.width ?? snapshot.floor?.width;
  const depth = snapshot.floor?.worldSize ? snapshot.floor.depth : bed?.depth ?? snapshot.floor?.depth;
  const plane = { widthM: bounded(width, 1e-8, 1e8, '承影平面宽度') * metric.worldToMetres, depthM: bounded(depth, 1e-8, 1e8, '承影平面深度') * metric.worldToMetres, yM: floorY, shadowEnabled: snapshot.settings?.floor !== false };
  const settings = snapshot.settings || {};
  const lighting = normalizeLighting(settings);
  lighting.fillPosition = lighting.fillPosition.map(value => value * metric.worldToMetres);
  const surface = {
    enabled: settings.layerLines !== false && (settings.surfaceDetail ?? 0.6) > 0 && (['demo', 'stl', '3mf'].includes(snapshot.metadata?.format) || !['auto', undefined].includes(settings.surfacePreset)),
    preset: ['auto', 'pla', 'matte', 'silk', 'petg'].includes(settings.surfacePreset) ? settings.surfacePreset : 'auto',
    detail: bounded(settings.surfaceDetail ?? 0.6, 0, 1, '表面细节'),
    layerHeightM: bounded(snapshot.metadata?.layerHeightMm ?? DEFAULT_LAYER_HEIGHT_MM, 0.001, 10, '层高') / 1000,
    firstLayerHeightM: bounded(snapshot.metadata?.firstLayerHeightMm ?? DEFAULT_FIRST_LAYER_HEIGHT_MM, 0.001, 10, '首层层高') / 1000,
    lineWidthM: bounded(snapshot.metadata?.lineWidthMm ?? 0.42, 0.001, 100, '挤出线宽') / 1000,
  };
  const printScale = Number(snapshot.units.sourceUnitsToMm) / Number(snapshot.units.normalizedScale) / 1000;
  if (Number.isFinite(printScale) && printScale > 0) {
    surface.printCoordinatesMatrix = new THREE.Matrix4().makeScale(printScale, printScale, printScale)
      .multiply(detachedWorldMatrix(snapshot.root).invert())
      .multiply(new THREE.Matrix4().makeScale(1 / metric.worldToMetres, 1 / metric.worldToMetres, 1 / metric.worldToMetres)).toArray();
  } else {
    surface.printCoordinatesMatrix = new THREE.Matrix4().toArray();
    capabilities.warnings.push('原始打印坐标单位未知，表面纹理以校准后的场景米制坐标估计。');
  }
  const dof = normalizeDof(settings);
  const cameraInverse = camera.matrixWorld.clone().invert();
  const focusBounds = snapshot.focusBoundsWorld?.clone().applyMatrix4(new THREE.Matrix4().makeScale(metric.worldToMetres, metric.worldToMetres, metric.worldToMetres)) || bounds;
  const focus = focusFromCompleteModelBounds({ bounds: focusBounds, worldToCamera: cameraInverse, worldToMm: 1000, focusPercent: dof.dofFocus, nearClipWorld: camera.near });
  dof.focusDistanceM = focus.focusDistanceWorld;
  dof.backgroundAlreadyPhotographic = Boolean(snapshot.backgroundType);
  // Transparent export still uses the source photo's calibrated sensor region.
  const sourceUV = snapshot.backgroundType ? renderBackgroundUV({ width: output.width, height: output.height, sourceWidth: snapshot.backgroundSize?.width, sourceHeight: snapshot.backgroundSize?.height, crop: settings.crop }) : settings.crop ? { repeatY: settings.crop.height } : null;
  const optics = resolvePhotoLensDof({ projectionMatrix: camera.projectionMatrix, sourceUV, sourceSensorHeightMm: 24, worldToMm: 1000, focusDistanceWorld: dof.focusDistanceM, imageHeightPx: output.height, dofEnabled: dof.dofEnabled, dofStrength: dof.dofStrength, photoIdentity: snapshot.photoIdentity || null });
  dof.enabled = optics.enabled;
  if (optics.enabled) dof.fStop = optics.fNumber;
  dof.apertureSource = optics.apertureSource; dof.focusMeasured = false;
  const config = {
    schemaVersion: 1, coordinateSystem: 'three-y-up', matrixConvention: 'column-major-column-vectors',
    scene: 'scene.glb', units: { ...metric, geometry: 'metres' },
    camera: { position: camera.position.toArray(), quaternion: camera.quaternion.toArray(), fov: camera.fov, aspect: output.width / output.height, projectionMatrix: camera.projectionMatrix.toArray(), near: camera.near, far: camera.far, effectiveSensorHeightMm: optics.effectiveSensorHeightMm, physicalFocalLengthMm: optics.physicalFocalLengthMm },
    plane, bounds: { min: bounds.min.toArray(), max: bounds.max.toArray(), minY: bounds.min.y, maxY: bounds.max.y },
    output, lighting, grading: { scope: 'model-only', exposure: lighting.exposure, ...Object.fromEntries(['tint', 'shadows', 'highlights', 'contrast', 'saturation'].map(key => [key, lighting[key]])) },
    surface, dof, optics, growth: { direction: 'up', stepped: Boolean(settings.stepped), layerCount: Math.max(1, Math.round(Number(settings.layerCount) || 240)) },
    background: { type: snapshot.backgroundType && !settings.transparent ? 'photo' : 'color', color: settings.background || '#1c2128', transparent: Boolean(settings.transparent) },
    capabilities,
  };
  if (metric.inferred) capabilities.warnings.push('模型格式没有固定单位，使用当前工程估计单位；几何和相机比例保持一致。');
  const entries = {};
  if (snapshot.printLayer) {
    const print = packRenderPrintLayer(snapshot.printLayer, metric.worldToMetres, { includeSupport: settings.showSupports !== false, preserveMaterials: settings.preserveMaterials !== false, color: settings.color || '#b7bec8' });
    entries['print-layer.bin'] = print.bytes; config.printLayer = print.manifest;
    config.growth.mode = 'sliced-gcode';
  } else config.growth.mode = 'slice-required-open-section';
  if (snapshot.backgroundType && !settings.transparent) {
    if (!options.backgroundFile) fail('背景照片未提供，高清合成不能静默替换当前实景。');
    const uv = sourceUV;
    const photo = await (dependencies.photoEncoder || canonicalRenderPhoto)(options.backgroundFile, output, uv);
    entries['photo.png'] = photo.bytes;
    config.background = { ...config.background, file: 'photo.png', canonical: true, width: output.width, height: output.height, sourceWidth: photo.sourceWidth, sourceHeight: photo.sourceHeight, sourceUV: uv };
  }
  const exporter = dependencies.exporter || new GLTFExporter();
  const glb = await exporter.parseAsync(scene, { binary: true, onlyVisible: true, includeCustomExtensions: true, maxTextureSize: RENDER_PACKAGE_LIMITS.maxTextureSize });
  entries['scene.glb'] = new Uint8Array(glb);
  const glbView = new DataView(glb);
  const gltf = JSON.parse(strFromU8(entries['scene.glb'].subarray(20, 20 + glbView.getUint32(12, true))).trim());
  capabilities.requiredExtensions = gltf.extensionsRequired || [];
  capabilities.usedExtensions = gltf.extensionsUsed || [];
  entries['config.json'] = strToU8(JSON.stringify(config));
  const totalBytes = Object.values(entries).reduce((sum, bytes) => sum + bytes.byteLength, 0);
  if (totalBytes > RENDER_PACKAGE_LIMITS.maxBytes) fail('完整渲染数据超过 512 MiB，不能自动减面或丢失纹理；请缩短模型工程或使用实时导出。');
  const zip = zipSync(entries, { level: 0 });
  return { blob: new Blob([zip], { type: 'application/zip' }), metadata: { ...config, bytes: zip.byteLength }, capabilities };
}
