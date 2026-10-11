import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { SpatialSceneRenderPass } from './spatial-scene-pass.js';
import { BokehPass } from 'three/addons/postprocessing/BokehPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { ThreeMFLoader } from 'three/addons/loaders/3MFLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { unzipSync, strFromU8 } from 'three/addons/libs/fflate.module.js';
import { clamp01, growthSlice, visibleSegmentCount, coverTexture } from './growth-math.js';
import { DEFAULT_LIGHTING, kelvinToLinearRGB, normalizeLighting } from './lighting.js';
import { COLOR_GRADING_GLSL, COLOR_GRADING_KEYS, colorGradingValues } from './color-grading.js';
import { focalLengthToFov, fovToFocalLength, compensateLensChange, MIN_FOCAL_LENGTH_MM, MAX_FOCAL_LENGTH_MM } from './camera-lens.js';
import { PHOTO_SHADOW_GLSL, contactShadowNormalBias } from './photo-shadow.js';
import { groundShadowRadiusUV,groundContactRadiusUV,injectGroundShadowSoftness } from './ground-shadow-softness.js';
import { preservePhotoBokehShader, premultipliedDofOutputShader, PHOTO_DOF_MAX_RADIUS_UV } from './photo-dof.js';
import { resolvePhotoLensDof, photoLensCoCAtDepth, focusFromCompleteModelBounds } from './photo-lens-dof.js';
import { BACKGROUND_PRESETS, isPresetPhotoIdentity } from './background-presets.js';
import { photographicModelBounds,photographicModelGeometry } from './photography-model-bounds.js';
import { fitPhotographicModelPose } from './photography-placement.js';
import { fitPrinterModelPose,printerModelYaw,printerPatternGroundPoint } from './printer-placement.js';
import { photographicReceiverSize } from './photo-shadow-receiver.js';
import { withCreaseNormals } from './crease-normals.js';
import { modelSourceUnits, millimetresToWorld } from './model-units.js';
import { installFDMSurface, resolveFDMSurfaceProfile, parseFDMSlicerSettings } from './fdm-surface.js';
import { createPrintPathGeometry, createPrintPathMaterial, createPrintPathDepthMaterial, updatePrintPathCamera, createPrintPathAnalysisMaterial, updatePrintPathAnalysisRange, setPrintPathSupportVisibility, setPrintPathInteraction, createPrintPathPreviewGeometries, setPrintPathPreviewCount, refreshPrintPathPreviewAttributes } from './print-path-material.js';
import { DisplaySurfaceController } from './display-surface-controller.js';
import { preparePrintSurfaceLOD } from './print-surface-loader.js';
import { PrintEnvironmentCache, printEnvironmentDescriptor, printEnvironmentKey, printReflectionIntensity, installPrintReflections, isManagedPrintEnvironmentTexture } from './print-environment.js';
import { createSceneRenderPackage, normalizeRenderOutput, detachedWorldMatrix, renderMetricScale, renderBackgroundUV } from './scene-package.js';
import { parsePrintLayerGCode, PRINTER_MM_TO_THREE_MM, PRINT_FEATURE } from './print-layer.js';
import { PrintLayerRenderer, IndexedSupportRenderer, validatePrintLayerData, installPrintLineWidth, installStadiumExtrusion } from './print-layer-renderer.js';
import { normalizeSliceSettings, DEFAULT_LAYER_HEIGHT_MM, DEFAULT_FIRST_LAYER_HEIGHT_MM } from './slice-settings.js';
import { pixelSamplingPlan, pixelJitterProjection, LinearPixelCoverageAccumulator } from './spatial-sampling.js';
import { downsampleExportFrame } from './export-quality.js';

const MODEL_SIZE = 8;
const TOOL_COLORS = ['#82b9a0', '#d29473', '#869fce', '#ccb979', '#a88ec1', '#72b5ba'];
const extension = name => name.toLowerCase().split('.').pop();
const hexColor = value => typeof value === 'string' && /^#[\da-f]{6}$/i.test(value) ? value.toLowerCase() : null;

export function normalizeCrop(value, sourceAspect = 1) {
  if (value === null) return null;
  const result = { x: Number(value?.x), y: Number(value?.y), width: Number(value?.width), height: Number(value?.height), sourceAspect: Number(value?.sourceAspect ?? sourceAspect) };
  if (!Object.values(result).every(Number.isFinite) || result.x < 0 || result.y < 0 || result.width <= 0 || result.height <= 0 || result.sourceAspect <= 0 || result.x + result.width > 1 + 1e-10 || result.y + result.height > 1 + 1e-10) throw new Error('裁剪范围需在整张画面的 0–100% 内，并保留非零宽高。');
  result.width = Math.min(result.width, 1 - result.x);
  result.height = Math.min(result.height, 1 - result.y);
  return result;
}

export function inspectThreeMFArchive(data) {
  let hasSavedSliceSettings=false,hasEmbeddedGCode=false;
  unzipSync(new Uint8Array(data),{filter:entry=>{
    hasSavedSliceSettings ||= /(?:^|\/)Metadata\/(?:project_settings|Slic3r_PE)\.config$/i.test(entry.name);
    hasEmbeddedGCode ||= /^(?:Metadata\/)?plate_\d+\.gcode$/i.test(entry.name);
    return false;
  }});
  const entries = unzipSync(new Uint8Array(data), { filter: entry => /\.(model|config)$/i.test(entry.name) });
  let standardColors = false;
  let proprietaryPaint = false;
  for (const bytes of Object.values(entries)) {
    const text = strFromU8(bytes);
    standardColors ||= /<(?:[\w.-]+:)?(?:basematerials|colorgroup|texture2dgroup)\b/i.test(text);
    proprietaryPaint ||= /mmu_segmentation|paint_color|painted[_-]color|<metadata\b[^>]*\bkey\s*=\s*["']extruder["']/i.test(text);
  }
  return { standardColors, proprietaryPaint, hasSavedSliceSettings, hasEmbeddedGCode };
}

function closedGeometry(geometry) {
  const positions = geometry.attributes.position;
  const count = geometry.index?.count ?? positions?.count ?? 0;
  if (!positions || !count || count % 3 || count > 300000 || positions.count > 300000) return false;
  const bounds = geometry.boundingBox;
  const tolerance = Math.max(1e-8, bounds?.getSize(new THREE.Vector3()).length() * 1e-6 || 1e-6);
  const vertices = new Map();
  const vertexIds = new Uint32Array(positions.count);
  for (let index = 0; index < positions.count; index++) {
    const key = `${Math.round(positions.getX(index) / tolerance)},${Math.round(positions.getY(index) / tolerance)},${Math.round(positions.getZ(index) / tolerance)}`;
    if (!vertices.has(key)) vertices.set(key, vertices.size);
    vertexIds[index] = vertices.get(key);
  }
  const edges = new Map();
  for (let index = 0; index < count; index += 3) {
    const ids = [0, 1, 2].map(offset => vertexIds[geometry.index ? geometry.index.getX(index + offset) : index + offset]);
    if (new Set(ids).size < 3) return false;
    for (let edge = 0; edge < 3; edge++) {
      const a = ids[edge], b = ids[(edge + 1) % 3];
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      const used = (edges.get(key) || 0) + 1;
      if (used > 2) return false;
      edges.set(key, used);
    }
  }
  return [...edges.values()].every(used => used === 2);
}

function localFiles(files) {
  const entries = [...files];
  const urls = new Map();
  const fileURLs = new Map();
  const urlList = [];
  const names = new Map();
  for (const file of entries) names.set(file.name.toLowerCase(), (names.get(file.name.toLowerCase()) || 0) + 1);
  for (const file of entries) {
    const url = URL.createObjectURL(file);
    urlList.push(url);
    fileURLs.set(file, url);
    for (const path of [names.get(file.name.toLowerCase()) === 1 ? file.name : null, file.webkitRelativePath]) {
      if (path) urls.set(path.replaceAll('\\', '/').toLowerCase(), url);
    }
  }
  const manager = new THREE.LoadingManager();
  let pending = 0;
  const errors = [];
  const waiting = [];
  const start = manager.itemStart.bind(manager);
  const end = manager.itemEnd.bind(manager);
  manager.itemStart = path => { pending += 1; start(path); };
  manager.itemEnd = path => {
    end(path);
    pending -= 1;
    if (pending === 0) waiting.splice(0).forEach(resolve => resolve());
  };
  manager.onError = path => errors.push(path);
  manager.setURLModifier(path => {
    if (/^(data:|blob:)/i.test(path)) return path;
    let clean;
    try { clean = decodeURIComponent(path).replaceAll('\\', '/').replace(/^\.\//, '').split(/[?#]/)[0].toLowerCase(); }
    catch { clean = path.toLowerCase(); }
    const exact = urls.get(clean);
    const leaf = clean.split('/').pop();
    const byLeaf = entries.filter(file => file.name.toLowerCase() === leaf);
    const result = exact || (byLeaf.length === 1 ? fileURLs.get(byLeaf[0]) : null);
    if (!result) throw new Error(`缺少本地关联文件：${path}。请将模型、纹理和 .bin 文件一起选择。`);
    return result;
  });
  return {
    entries, manager,
    async settled() { if (pending > 0) await new Promise(resolve => waiting.push(resolve)); },
    async ready() {
      await this.settled();
      if (errors.length) throw new Error('关联纹理或数据文件无法读取，请检查文件是否损坏。');
    },
    dispose: () => urlList.forEach(url => URL.revokeObjectURL(url)),
  };
}

function meshBounds(meshes) {
  const bounds = new THREE.Box3();
  for (const mesh of meshes) {
    // Instanced and skinned meshes own bounds which include their actual instances
    // or static pose. Geometry bounds alone would fit only the unposed source mesh.
    if (mesh.isInstancedMesh || mesh.isSkinnedMesh) {
      mesh.computeBoundingBox();
      if (mesh.boundingBox) bounds.union(mesh.boundingBox.clone().applyMatrix4(mesh.matrixWorld));
    } else {
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      if (mesh.geometry.boundingBox) bounds.union(mesh.geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld));
    }
  }
  return bounds;
}

function disposeTree(root, retainedMaterials = []) {
  if (!root && !retainedMaterials.size && !retainedMaterials.length) return;
  const geometries = new Set();
  const materials = new Set();
  const textures = new Set();
  const disposables = new Set();
  root?.traverse(node => {
    if (node.geometry) geometries.add(node.geometry);
    if (node.userData.printPathPreview) {
      geometries.add(node.userData.printPathPreview.exterior);
      geometries.add(node.userData.printPathPreview.support);
    }
    if (node.isInstancedMesh || node.isLight) disposables.add(node);
    if (node.skeleton) disposables.add(node.skeleton);
    for (const material of Array.isArray(node.material) ? node.material : node.material ? [node.material] : []) {
      materials.add(material);
      for (const value of Object.values(material)) if (value?.isTexture && !isManagedPrintEnvironmentTexture(value)) textures.add(value);
    }
    if (node.customDepthMaterial) materials.add(node.customDepthMaterial);
  });
  for (const material of retainedMaterials) {
    materials.add(material);
    for (const value of Object.values(material)) if (value?.isTexture && !isManagedPrintEnvironmentTexture(value)) textures.add(value);
  }
  geometries.forEach(item => item.dispose());
  materials.forEach(item => item.dispose());
  const images = new Set();
  textures.forEach(item => { item.dispose(); if (item.image) images.add(item.image); });
  images.forEach(item => item.close?.());
  disposables.forEach(item => item.dispose?.());
}

function waitForVideo(video, event, ready, message, timeout = 20000) {
  return new Promise((resolve, reject) => {
    let timer;
    const clean = () => {
      clearTimeout(timer);
      video.removeEventListener(event, done);
      video.removeEventListener('error', failed);
    };
    const done = () => { if (!ready()) return; clean(); resolve(); };
    const failed = () => { clean(); reject(new Error(message)); };
    video.addEventListener(event, done);
    video.addEventListener('error', failed);
    timer = setTimeout(failed, timeout);
    done();
  });
}

function pathShadow(parent, segmentCount, clippingPlanes = []) {
  const geometry = new THREE.CylinderGeometry(0.21, 0.21, 1, 3, 1, false);
  const material = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, clippingPlanes, clipShadows: true });
  const shadow = new THREE.InstancedMesh(geometry, material, segmentCount);
  shadow.name = '打印路径阴影';
  shadow.castShadow = true;
  shadow.frustumCulled = false;
  shadow.count = 0;
  let count = 0;
  shadow.onBeforeRender = () => { if (!shadow.userData.solidSupport) { count = shadow.count; shadow.count = 0; } };
  shadow.onAfterRender = () => { if (!shadow.userData.solidSupport) shadow.count = count; };
  parent.add(shadow);
  return shadow;
}

function printPathModelBounds(source) {
  const bounds = new THREE.Box3();
  for (let index = 0; index < source.segmentCount; index++) {
    const feature = source.features[index];
    if (!(feature >= 1 && feature <= 9 || feature === 16)) continue;
    const at = index * 6, radius = source.widths[index] / 2, height = source.heights[index];
    for (let end = 0; end < 6; end += 3) {
      const x = source.positions[at + end], y = source.positions[at + end + 1], z = source.positions[at + end + 2];
      bounds.min.x = Math.min(bounds.min.x, x-radius); bounds.max.x = Math.max(bounds.max.x, x+radius);
      bounds.min.y = Math.min(bounds.min.y, y-radius); bounds.max.y = Math.max(bounds.max.y, y+radius);
      bounds.min.z = Math.min(bounds.min.z, z-height); bounds.max.z = Math.max(bounds.max.z, z);
    }
  }
  if (bounds.isEmpty()) throw new Error('切片没有可显示的模型挤出表面。');
  return bounds;
}

function pathShadowMatrices(shadow, positions, order, bead = null) {
  const matrix = new THREE.Matrix4();
  const start = new THREE.Vector3();
  const end = new THREE.Vector3();
  const center = new THREE.Vector3();
  const direction = new THREE.Vector3();
  const scale = new THREE.Vector3(1, 1, 1);
  const rotation = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  for (let index = 0; index < order.length; index++) {
    const offset = order[index] * 6;
    start.fromArray(positions, offset); end.fromArray(positions, offset + 3);
    center.addVectors(start, end).multiplyScalar(0.5);
    direction.subVectors(end, start);
    scale.y = direction.length();
    if (bead) {
      const width = bead.widths[order[index]] || 0.42;
      const height = bead.heights[order[index]] || 0.12;
      // FDM Z is the top of the new layer. Extrusion is a flattened bead whose
      // lower surface joins the preceding layer, rather than a dotted line.
      center.z -= height / 2;
      scale.x = width / 0.42 / Math.cos(Math.PI / 6);
      scale.z = height / 0.42;
    }
    rotation.setFromUnitVectors(up, direction.normalize());
    matrix.compose(center, rotation, scale);
    shadow.setMatrixAt(index, matrix);
  }
  shadow.instanceMatrix.needsUpdate = true;
}

function extrusionEnds(positions, tools, widths, heights) {
  const count = tools.length;
  const result = [];
  const samePoint = (a, b) => Math.abs(positions[a] - positions[b]) < 1e-5 && Math.abs(positions[a + 1] - positions[b + 1]) < 1e-5 && Math.abs(positions[a + 2] - positions[b + 2]) < 1e-5;
  const sameStyle = (a, b) => tools[a] === tools[b] && Math.abs(widths[a] - widths[b]) < 1e-6 && Math.abs(heights[a] - heights[b]) < 1e-6;
  let start = 0;
  const close = end => {
    if (samePoint(start * 6, end * 6 + 3) && sameStyle(start, end)) return;
    result.push({ segment: start, end: false }, { segment: end, end: true });
  };
  for (let index = 1; index < count; index++) {
    if (samePoint((index - 1) * 6 + 3, index * 6) && sameStyle(index - 1, index)) continue;
    close(index - 1); start = index;
  }
  if (count) close(count - 1);
  return result;
}

function extrusionCapGeometry() {
  const positions = [0, 0, 0], normals = [0, 1, 0], indices = [];
  for (let index = 0; index <= 6; index++) {
    const angle = index / 6 * Math.PI * 2;
    positions.push(Math.sin(angle) * 0.21, 0, Math.cos(angle) * 0.21);
    normals.push(0, 1, 0);
    if (index < 6) indices.push(0, index + 1, index + 2);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setIndex(indices);
  return geometry;
}

function extrusionCapMatrices(mesh, positions, ends, widths, heights) {
  const matrix = new THREE.Matrix4(), rotation = new THREE.Quaternion();
  const reverse = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI);
  const up = new THREE.Vector3(0, 1, 0), direction = new THREE.Vector3(), center = new THREE.Vector3(), scale = new THREE.Vector3();
  for (let index = 0; index < ends.length; index++) {
    const item = ends[index], segment = item.segment;
    const start = segment * 6, end = start + 3;
    direction.set(positions[end] - positions[start], positions[end + 1] - positions[start + 1], positions[end + 2] - positions[start + 2]).normalize();
    rotation.setFromUnitVectors(up, direction);
    if (!item.end) rotation.multiply(reverse);
    center.fromArray(positions, item.end ? end : start);
    center.z -= heights[segment] / 2;
    scale.set(widths[segment] / 0.42 / Math.cos(Math.PI / 6), 1, heights[segment] / 0.42);
    mesh.setMatrixAt(index, matrix.compose(center, rotation, scale));
  }
  mesh.instanceMatrix.needsUpdate = true;
}

export class SceneDepthBokehPass extends BokehPass {
  constructor(scene, camera, parameters = {}) {
    super(scene, camera, parameters);
    this.uniforms.preservePhoto = { value: 0 };
    this.uniforms.cocRadiusUvCoefficient = { value: 0 };
    this.uniforms.tPhoto = { value: null };
    this.uniforms.photoUvTransform = { value: new THREE.Matrix3() };
    this.uniforms.photoVideo = { value: 0 };
    this.uniforms.photoIntensity = { value: 1 };
    this.uniforms.backgroundLinearRGBA = { value: new THREE.Vector4(0, 0, 0, 0) };
    this.materialBokeh.fragmentShader = preservePhotoBokehShader(this.materialBokeh.fragmentShader);
  }

  render(renderer, writeBuffer, readBuffer) {
    // The color pass already writes real depth, including clipped meshes and
    // stencil-limited caps. Reusing it avoids a second 2M-support depth draw and
    // never turns a cap's infinite construction plane into background depth.
    this.uniforms.tColor.value = readBuffer.texture;
    this.uniforms.tDepth.value = readBuffer.depthTexture;
    this.uniforms.nearClip.value = this.camera.near;
    this.uniforms.farClip.value = this.camera.far;
    this.materialBokeh.defines.DEPTH_PACKING = 0;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    if (!this.renderToScreen) renderer.clear();
    this._fsQuad.render(renderer);
  }
}

function demoVase() {
  // A closed, ribbed vessel with actual inner walls and a sealed base.
  const rings = 110;
  const segments = 128;
  const height = 10;
  const positions = [];
  const colors = [];
  const indices = [];
  const colorA = new THREE.Color('#76aa91');
  const colorB = new THREE.Color('#c5dcc5');
  const radius = (t, angle) => 2.45 + 0.55 * Math.sin(t * Math.PI * 1.25 - 0.45) + 0.16 * Math.sin(angle * 12 + t * 5.4);
  for (let wall = 0; wall < 2; wall++) {
    for (let ring = 0; ring <= rings; ring++) {
      const t = ring / rings;
      for (let segment = 0; segment <= segments; segment++) {
        const angle = segment / segments * Math.PI * 2;
        const r = radius(t, angle) - wall * 0.24;
        positions.push(r * Math.cos(angle), wall ? 0.26 + t * (height - 0.26) : t * height, r * Math.sin(angle));
        const c = colorA.clone().lerp(colorB, t * 0.68);
        colors.push(c.r, c.g, c.b);
      }
    }
  }
  const stride = segments + 1;
  const wallSize = (rings + 1) * stride;
  for (let wall = 0; wall < 2; wall++) {
    for (let ring = 0; ring < rings; ring++) {
      for (let segment = 0; segment < segments; segment++) {
        const a = wall * wallSize + ring * stride + segment;
        const b = a + 1;
        const c = a + stride;
        const d = c + 1;
        if (wall === 0) indices.push(a, c, b, b, c, d);
        else indices.push(a, b, c, b, d, c);
      }
    }
  }
  for (let segment = 0; segment < segments; segment++) {
    const a = rings * stride + segment;
    const b = a + 1;
    const c = wallSize + a;
    const d = c + 1;
    indices.push(a, c, b, b, c, d);
  }
  const outerCenter = positions.length / 3;
  positions.push(0, 0, 0); colors.push(colorA.r, colorA.g, colorA.b);
  const innerCenter = positions.length / 3;
  positions.push(0, 0.26, 0); colors.push(colorA.r, colorA.g, colorA.b);
  for (let segment = 0; segment < segments; segment++) {
    indices.push(outerCenter, segment, segment + 1);
    indices.push(innerCenter, wallSize + segment + 1, wallSize + segment);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  // The demo is a plausible 120 mm print, while scene normalization keeps its
  // appearance unchanged and metric printer-photo calibration stays useful.
  geometry.scale(12, 12, 12);
  // The large sealed bottom must not pull the adjacent side-wall normals
  // downward: that creates a dark outline at the photo contact edge.
  const shaded = withCreaseNormals(geometry);
  geometry.dispose();
  const material = new THREE.MeshStandardMaterial({ color: '#ffffff', vertexColors: true, roughness: 0.74, metalness: 0.05 });
  const mesh = new THREE.Mesh(shaded, material);
  mesh.name = '螺旋花瓶';
  return mesh;
}

export class GrowthStudio {
  constructor(host) {
    if (!host) throw new Error('缺少 3D 预览容器。');
    this.host = host;
    this.options = {
      progress: 1, direction: 'up', layerCount: 240, stepped: true, layerLines: true,
      color: '#82b9a0', preserveMaterials: true, background: '#1c2128', floor: true,
      grid: false, turntable: 0, modelOffsetX: 0, modelOffsetY: 0, modelScale: 1, transparent: false,
      modelOffsetZ: 0, modelRotationX: 0, modelRotationY: 0, modelRotationZ: 0,
      showSupports: true,
      supportDisplay: 'solid',
      surfacePreset: 'auto', surfaceDetail: 0.6,
      dofEnabled: false, dofStrength: 30, dofFocus: 50,
      crop: null,
      toolColors: {}, shadowOpacity: 0.28, shadowRadius: 3, lightDirection: 'left',
      ...DEFAULT_LIGHTING,
    };
    this._modelToneMaterials = new WeakSet();
    this._modelExposure = { value: this.options.exposure };
    this._surfaceMaterials = new Map();
    this._printMatrix = new THREE.Matrix4();
    this.scene = new THREE.Scene();
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, stencil: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.toneMappingExposure = 1;
    this.renderer.localClippingEnabled = true;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.domElement.setAttribute('aria-label', '可拖动旋转和缩放的模型生长预览');
    host.appendChild(this.renderer.domElement);
    this.camera = new THREE.PerspectiveCamera(36, 1, 0.05, 1000);
    this.camera.position.set(13, 10, 13);
    this.controls = this._createPreviewControls();
    this._renderPending = true;
    this._controlsRenderListener = () => this._requestRender();
    this.controls.addEventListener('change', this._controlsRenderListener);
    this.clipPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 8);
    this.layerUniforms = { enabled: { value: 1 }, count: { value: 240 }, min: { value: 0 }, max: { value: 8 } };
    this.modelGroup = new THREE.Group();
    this.scene.add(this.modelGroup);
    this._turnRadians = 0;
    this._transformMode = null;
    this.transform = new TransformControls(this.camera, this.renderer.domElement);
    this.transformHelper = this.transform.getHelper();
    this.transformHelper.visible = false;
    this.transform.enabled = false;
    this.transform.setSize(0.85);
    this.scene.add(this.transformHelper);
    this.transform.addEventListener('dragging-changed', event => this._handleGizmoDraggingChange(event));
    this.transform.addEventListener('objectChange', () => this._handleTransformChange());
    this.transform.addEventListener('change', this._controlsRenderListener);
    this.cap = new THREE.Mesh(new THREE.PlaneGeometry(100, 100), new THREE.MeshStandardMaterial({
      color: this.options.color, roughness: 0.82, side: THREE.DoubleSide,
      stencilWrite: true, stencilRef: 0, stencilFunc: THREE.NotEqualStencilFunc,
      stencilFail: THREE.ReplaceStencilOp, stencilZFail: THREE.ReplaceStencilOp, stencilZPass: THREE.ReplaceStencilOp,
    }));
    this.cap.rotation.x = -Math.PI / 2;
    this.cap.renderOrder = 30;
    this.cap.visible = false;
    this.cap.onAfterRender = renderer => renderer.clearStencil();
    this._capSurface = installFDMSurface(this.cap.material, { topSurface: true, surfaceDetail: this.options.surfaceDetail });
    installPrintReflections(this.cap.material);
    this._prepareModelTone(this.cap.material);
    this.scene.add(this.cap);
    this._floorSolidMaterial = new THREE.MeshStandardMaterial({ color: '#303740', roughness: 1, metalness: 0 });
    // The photograph's plate is not a reconstructed depth surface. Its shadow
    // receiver must not replace background depth across the entire plate.
    this._floorShadowMaterial = new THREE.ShadowMaterial({ opacity: 0.28, depthWrite: false });
    this._preparePhotoShadowMaterial();
    this.floor = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), this._floorSolidMaterial);
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.position.y = -0.015;
    this.floor.receiveShadow = true;
    this.scene.add(this.floor);
    this.grid = new THREE.GridHelper(40, 40, '#647080', '#3e4754');
    this.grid.position.y = 0.002;
    this.grid.material.transparent = true;
    this.grid.material.opacity = 0.35;
    this.scene.add(this.grid);
    this.hemisphereLight = new THREE.HemisphereLight('#f3f5f9', '#5d626b', 2.1);
    this.scene.add(this.hemisphereLight);
    const key = new THREE.DirectionalLight('#fff2dc', 3.5);
    this.keyLight = key;
    key.position.set(9, 16, 10);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.left = key.shadow.camera.bottom = -14;
    key.shadow.camera.right = key.shadow.camera.top = 14;
    key.shadow.camera.near = 0.5;
    key.shadow.camera.far = 50;
    key.shadow.bias = -0.00025;
    key.shadow.normalBias = 0.035;
    this.scene.add(key);
    this.scene.add(key.target);
    const rim = new THREE.DirectionalLight('#b5d8f2', 2.3);
    this.rimLight = rim;
    rim.position.set(-10, 10, -8);
    this.scene.add(rim);
    const fill = new THREE.DirectionalLight('#fffaf2', 1.1);
    this.fillLight = fill;
    fill.position.set(-8, 5, 8);
    this.scene.add(fill);
    this._meshes = [];
    this._stencils = [];
    this._partCaps = [];
    this._sourceMaterials = new Map();
    this._retainedMaterials = new Set();
    this._bounds = new THREE.Box3();
    this._metadata = null;
    this._printLayers = null;
    this._indexedSupports = null;
    this._exportState = null;
    this._backgroundTexture = null;
    this._backgroundSize = null;
    this._backgroundVideo = null;
    this._backgroundURL = null;
    this._backgroundMetadata = null;
    this._photoIdentity = null;
    this._lastPhotoLensDof = null;
    this._photoDofStatus = { enabled: false, error: null };
    this._backgroundSeekListener = null;
    this._previewBackgroundTime = null;
    this._shadowEditMode = false;
    this._shadowDrag = null;
    this._shadowRaycaster = new THREE.Raycaster();
    this._shadowPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this._createShadowHelper();
    // Every live frame is integrated on the GPU, including drag and playback.
    // An idle CPU overlay would switch quality whenever the scene moves.
    this._spatialPreview = null;
    this._spatialPointerListener = () => {
      if (!(this._transformMode || this._shadowEditMode || this.controls.enabled)) return;
      this._canvasInteractionHeld = true; this.beginPreviewInteraction({ hold: true }); this._requestRender();
    };
    this._spatialPointerEndListener = () => { if(this._canvasInteractionHeld){this._canvasInteractionHeld=false;this.endPreviewInteraction();} };
    this.canvas.addEventListener('pointerdown', this._spatialPointerListener, { capture: true, passive: true });
    for(const event of ['pointerup','pointercancel','lostpointercapture'])this.canvas.addEventListener(event,this._spatialPointerEndListener,{capture:true,passive:true});
    this._resizeObserver = new ResizeObserver(() => { if (!this._exportState) this._resize(); });
    this._resizeObserver.observe(host);
    this._resize();
    this._animation = () => {
      this._raf = requestAnimationFrame(this._animation);
      this._renderPreview();
    };
    this._animation();
  }

  get canvas() { return this.renderer.domElement; }
  get metadata() { return this._metadata; }

  setSourceUnitMillimetres(value) {
    if(!this._metadata?.sourceUnitsInferred) throw new Error('该模型已声明真实单位，无需覆盖。');
    const units=Number(value);
    if(![1,10,1000].includes(units)) throw new Error('请选择毫米、厘米或米。');
    if(units===this._metadata.sourceUnitsToMm){this._metadata.sourceUnitsUserConfirmed=true;return;}
    this._printLayers?.dispose();this._printLayers=null;
    this._clearIndexedSupports();
    this._metadata.sourceUnitsToMm=units;this._metadata.sourceUnitsUserConfirmed=true;
    delete this._metadata.printLayer;delete this._metadata.sliceSettings;
    this._metadata.surfaceTopMode='slice-required';
    this._metadata.supportsAvailable=this._supportMeshes.size>0;
    if(!this._metadata.supportsAvailable)for(const key of ['supportSource','supportSegments','supportRawSegments','supportSurfaceMode','supportMaterialColors'])delete this._metadata[key];
    this._updateFDMSurfaces();this.render(this.options.progress,this._turnRadians);
  }
  get backgroundMetadata() { return this._backgroundMetadata && { ...this._backgroundMetadata }; }
  get photoIdentity() { return this._photoIdentity || null; }
  get photoDofStatus() { return { error: this._photoDofStatus?.error || null, lens: this._lastPhotoLensDof || null }; }
  setPhotoIdentity(identity = null) {
    if (identity !== null && !isPresetPhotoIdentity(identity)) throw new Error('照片镜头参考身份无效。');
    if (identity !== null && this._backgroundMetadata?.type !== 'image') throw new Error('请先成功载入对应的预设照片。');
    this._photoIdentity = identity;
    this._requestRender();
  }
  get modelWorldScale() { return (this.normalized?.scale.x || 1) * (this.options.modelScale || 1); }
  // Photograph/bed coordinates keep the source unit conversion. A display
  // resize belongs only to the model, never to the camera or photographed bed.
  get sourceMillimetresToWorld() { return millimetresToWorld(this.normalized?.scale.x || 1, this._metadata?.sourceUnitsToMm || 1); }
  get modelMillimetresToWorld() { return millimetresToWorld(this.modelWorldScale, this._metadata?.sourceUnitsToMm || 1); }

  /** Restore the source-bound world metric saved with a model's pose/camera.
   * Source vertices and camera coordinates stay intact; display scale is a
   * separate transform. The app validates the matching source identity first.
   */
  restoreSourceSceneScale(worldPerMm) {
    if (typeof worldPerMm !== 'number' || !Number.isFinite(worldPerMm) || worldPerMm <= 0 || !this.normalized || !this._metadata) return false;
    const current = this.sourceMillimetresToWorld;
    if (!Number.isFinite(current) || current <= 0 || !this._scaleSourceScene(worldPerMm / current)) return false;
    this.render(this.options.progress, this._turnRadians);
    return true;
  }

  _scaleSourceScene(factor) {
    if (!Number.isFinite(factor) || factor <= 0 || !this.normalized) return false;
    const bounds = new Set([this._baseBounds,this._indexedSupports?.originalBounds,this._supportOverlay?.originalBounds].filter(Boolean));
    const values = [...this.normalized.scale.toArray(),...this.normalized.position.toArray(),
      ...[...bounds].flatMap(box => [...box.min.toArray(),...box.max.toArray()]),this._baseHeight];
    if (!values.every(value => Number.isFinite(value) && Number.isFinite(value * factor))) return false;
    this.normalized.scale.multiplyScalar(factor);
    this.normalized.position.multiplyScalar(factor);
    for (const box of bounds) { box.min.multiplyScalar(factor); box.max.multiplyScalar(factor); }
    this._baseHeight *= factor;
    return true;
  }
  hasModel() { return Boolean(this._metadata); }
  // Scene updates can span model decoding and background loading. Keep the
  // preceding canvas frame until the app has committed its final composition.
  beginSceneUpdate() {
    const depth = this._sceneUpdateDepth || 0;
    this._sceneUpdateDepth = depth + 1;
    // Cancel any in-flight refinement of the preceding scene. Further model
    // mutations remain computational only until the outermost batch ends.
    if (!depth) this._spatialPreview?.invalidate();
    return this._sceneUpdateDepth;
  }

  endSceneUpdate() {
    if (!this._sceneUpdateDepth) return 0;
    this._sceneUpdateDepth--;
    if (!this._sceneUpdateDepth) this._requestRender();
    return this._sceneUpdateDepth;
  }

  _requestRender() {
    if (!(this._sceneUpdateDepth > 0 && !this._exportState)) this._spatialPreview?.invalidate();
    this._renderPending = true;
  }

  beginPreviewInteraction({ hold = false } = {}) {
    if (this._exportState || this._metadata?.historicalPathSurface !== 'analytic-pbr-extrusion') return;
    if (!this._previewInteraction) {
      this._previewInteraction = { pixelRatio: this.renderer.getPixelRatio(), hold: false };
      this._spatialPreview?.invalidate();
    }
    this._previewInteraction.hold ||= Boolean(hold);
    clearTimeout(this._previewInteractionTimer);
    if (!this._previewInteraction.hold) this._previewInteractionTimer = setTimeout(() => this.endPreviewInteraction(), 320);
    this._renderPending = true;
  }

  endPreviewInteraction() {
    clearTimeout(this._previewInteractionTimer);
    const state = this._previewInteraction;
    if (!state) return;
    this._previewInteraction = null;
    for (const mesh of this._meshes || []) if (mesh.userData.printPathImpostor) {
      setPrintPathInteraction(mesh.material, false);
      setPrintPathInteraction(mesh.customDepthMaterial, false);
    }
    this._requestRender();
  }
  _renderPreview() {
    if (this._exportState || this._sceneUpdateDepth > 0) return;
    const changed = this.controls.update();
    if (changed || this._renderPending) {
      this._spatialPreview?.invalidate();
      this._drawScene();
      this._renderPending = false;
    }
    this._spatialPreview?.schedule();
  }

  _ensureDof() {
    if (this._dofComposer) return;
    const size = this.renderer.getSize(new THREE.Vector2());
    // Canvas antialiasing does not apply to offscreen scene/depth targets.
    // Resolve coverage before the physical model-only depth-of-field pass.
    const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, depthBuffer: true, stencilBuffer: true,
      samples: Math.min(4, this.renderer.capabilities.maxSamples) });
    target.depthTexture = new THREE.DepthTexture(size.x, size.y, THREE.UnsignedInt248Type);
    target.depthTexture.format = THREE.DepthStencilFormat;
    this._dofComposer = new EffectComposer(this.renderer, target);
    this._dofRenderPass = new SpatialSceneRenderPass(this.scene, this.camera);
    this._dofBokehPass = new SceneDepthBokehPass(this.scene, this.camera, { focus: 20, aperture: 0.001, maxblur: 0.01 });
    this._dofBokehPass._materialDepth.clippingPlanes = [this.clipPlane];
    this._dofBokehPass.materialBokeh.defines.DEPTH_PACKING = 0;
    this._dofOutputPass = new OutputPass();
    this._dofOutputPass.material.fragmentShader = premultipliedDofOutputShader(this._dofOutputPass.material.fragmentShader);
    this._dofComposer.addPass(this._dofRenderPass);
    this._dofComposer.addPass(this._dofBokehPass);
    this._dofComposer.addPass(this._dofOutputPass);
    this._dofComposer.setPixelRatio(this.renderer.getPixelRatio());
    this._dofComposer.setSize(size.x, size.y);
  }

  _completeModelFocusBounds() {
    const original = this._indexedSupports?.originalBounds || this._supportOverlay?.originalBounds || this._baseBounds;
    return original ? original.clone().applyMatrix4(detachedWorldMatrix(this.modelGroup)) : this._bounds?.clone();
  }

  _dofDepthRange(camera = this.camera) {
    // Complete model, camera-axis depth, independent of support extents/growth.
    // Use the same pure focus helper as HQ and read detached live camera pose.
    const bounds = this._completeModelFocusBounds();
    if (bounds && !bounds.isEmpty()) {
      const focus = focusFromCompleteModelBounds({ bounds, worldToCamera: detachedWorldMatrix(camera).invert(),
        worldToMm: 1, focusPercent: this.options?.dofFocus ?? 50, nearClipWorld: camera.near });
      return { near: focus.nearDepthWorld, far: focus.farDepthWorld };
    }
    const distance = camera.position.distanceTo(this.controls.target);
    const near = Math.max(camera.near, distance * .75);
    return { near, far: Math.max(near, distance * 1.25) };
  }

  /** Same physical metric and final crop projection as the HQ package. Only
   * output pixel count differs; model display scaling remains inside the world. */
  getPhotoLensDof({ camera = this.camera, width, height } = {}) {
    if (!this.hasModel()) throw new Error('请先导入模型，再设置模型景深。');
    const size = this.renderer.getSize(new THREE.Vector2());
    width ??= size.x; height ??= size.y;
    const metric = renderMetricScale({ calibratedBed: this._photoBedSize,
      bedWidthMm: this.options.bedWidthMm, bedDepthMm: this.options.bedDepthMm,
      normalizedScale: this.normalized?.scale.x, sourceUnitsToMm: this._metadata?.sourceUnitsToMm,
      sourceUnitsInferred: this._metadata?.sourceUnitsInferred });
    const sourceUV = this._backgroundSize ? renderBackgroundUV({ width, height,
      sourceWidth: this._backgroundSize.width, sourceHeight: this._backgroundSize.height, crop: this.options.crop })
      : this.options.crop ? { repeatY: this.options.crop.height } : null;
    const range = this._dofDepthRange(camera);
    const lens = resolvePhotoLensDof({ projectionMatrix: camera.projectionMatrix, sourceUV,
      worldToMm: metric.worldToMetres * 1000,
      focusDistanceWorld: THREE.MathUtils.lerp(range.near, range.far, this.options.dofFocus / 100),
      imageHeightPx: height * this.renderer.getPixelRatio(), dofEnabled: Boolean(this.options.dofEnabled),
      dofStrength: this.options.dofStrength, photoIdentity: this.photoIdentity });
    const requestedRadiusUv = Math.max(photoLensCoCAtDepth(lens, range.near).radiusUvY, photoLensCoCAtDepth(lens, range.far).radiusUvY);
    return { ...lens, metricSource: metric.source, metricInferred: metric.inferred,
      nearDepthWorld: range.near, farDepthWorld: range.far,
      preview: { renderer: 'screen-space-circular-disk', samples: 49, requestedRadiusUv,
        maxRadiusUv: Math.min(PHOTO_DOF_MAX_RADIUS_UV, requestedRadiusUv),
        radiusLimited: requestedRadiusUv > PHOTO_DOF_MAX_RADIUS_UV, depthDiscontinuitiesApproximate: true } };
  }

  _drawScene() {
    if (this._sceneUpdateDepth > 0 && !this._exportState) {
      this._renderPending = true;
      return;
    }
    const resize = !this._exportState && this._pendingSceneResize;
    if (resize) {
      this._pendingSceneResize = null;
      // Resizing clears the drawing buffer. Apply it immediately before the
      // first final draw, whether reached by the rAF or a synchronous render.
      this._resize(resize.width, resize.height, resize.adjustCamera, false);
    }
    const restoreSurface=this._displaySurfaceController?.begin();
    try{return this._drawSceneWithSurface();}finally{restoreSurface?.();}
  }

  _drawSceneWithSurface() {
    const rasterSize = this.renderer.getSize(new THREE.Vector2());
    const outputWidth = this._displayOutputSize?.width ?? this._displayOutputSize?.x ?? rasterSize.x;
    this.renderer.userData ||= {};
    this.renderer.userData.printSurfaceFootprintScale = rasterSize.x * this.renderer.getPixelRatio() / Math.max(1, outputWidth);
    const interactive = Boolean(this._previewInteraction && !this._exportState);
    for (const mesh of this._meshes || []) if (mesh.userData.printPathImpostor) {
      setPrintPathInteraction(mesh.material, interactive);
      setPrintPathInteraction(mesh.customDepthMaterial, interactive);
    }
    if (interactive) {
      // User camera/material/lighting values stay intact. Temporary drag frames
      // skip only expensive postprocessing and hidden historical interior work.
      const shadow = this.renderer.shadowMap.enabled;
      const swapped = [], attached = [];
      this.renderer.shadowMap.enabled = false;
      try {
        for (const mesh of this._meshes || []) {
          if (mesh.userData.printPathDisplayActive) continue;
          const preview = mesh.userData.printPathPreview;
          if (!preview) continue;
          const full = mesh.geometry;
          setPrintPathPreviewCount(preview.exterior, full.instanceCount);
          setPrintPathPreviewCount(preview.support, full.instanceCount);
          swapped.push([mesh, full]); mesh.geometry = preview.exterior;
          if (this.options.showSupports !== false && preview.support.instanceCount && mesh.visible && mesh.parent) {
            const support = preview.supportMesh;
            support.material = mesh.material;
            support.matrix.copy(mesh.matrix);
            support.matrixWorldNeedsUpdate = true;
            mesh.parent.add(support); attached.push(support);
          }
        }
        this._drawUnblurredScene();
      } finally {
        attached.forEach(mesh => mesh.removeFromParent());
        for (const [mesh, geometry] of swapped) mesh.geometry = geometry;
        this.renderer.shadowMap.enabled = shadow;
      }
      return;
    }
    if (!this.hasModel() || !this.options.dofEnabled || !this.options.dofStrength || this.options.outputAppearance === 'photo') {
      this._photoDofStatus = { enabled: false, error: null };
      this._lastPhotoLensDof = null;
      this._drawUnblurredScene();
      return;
    }
    let lens;
    try { lens = this.getPhotoLensDof(); }
    catch (error) {
      if (!(error instanceof Error)) throw error;
      this._lastPhotoLensDof = null;
      this._photoDofStatus = { enabled: false, error: error.message, errorCode: /焦点|焦距/.test(error.message) ? 'invalid-focus' : 'invalid-optics' };
      this._drawUnblurredScene();
      return;
    }
    this._lastPhotoLensDof = lens;
    this._photoDofStatus = { enabled: lens.enabled, error: null, fNumber: lens.fNumber,
      apertureSource: lens.apertureSource, estimated: Boolean(lens.estimated),
      radiusLimited: lens.preview.radiusLimited };
    this._ensureDof();
    this._dofRenderPass.samples = !this._exportState && this._metadata?.historicalPathSurface === 'analytic-pbr-extrusion' ? 4 : 1;
    this._dofRenderPass.preserveDepth = true;
    const uniforms = this._dofBokehPass.uniforms;
    const background = this.scene.background;
    const photo = Boolean(this._backgroundTexture && background === this._backgroundTexture && !this.options.transparent);
    uniforms.preservePhoto.value = photo ? 1 : 0;
    uniforms.tPhoto.value = photo ? this._backgroundTexture : null;
    if (photo) uniforms.photoUvTransform.value.copy(this._backgroundTexture.matrix);
    uniforms.photoVideo.value = photo && this._backgroundTexture.isVideoTexture ? 1 : 0;
    uniforms.photoIntensity.value = this.scene.backgroundIntensity ?? 1;
    const clearColor = this.renderer.getClearColor(new THREE.Color()).clone();
    const clearAlpha = this.renderer.getClearAlpha();
    const base = background?.isColor ? background : clearColor;
    uniforms.backgroundLinearRGBA.value.set(base.r * clearAlpha, base.g * clearAlpha, base.b * clearAlpha, this.options.transparent ? 0 : clearAlpha);
    if (this.options.transparent) uniforms.backgroundLinearRGBA.value.set(0, 0, 0, 0);
    uniforms.focus.value = lens.focusDistanceWorld;
    uniforms.cocRadiusUvCoefficient.value = lens.cocRadiusUvCoefficient;
    uniforms.maxblur.value = lens.preview.maxRadiusUv;
    const viewport = this.renderer.getSize(new THREE.Vector2());
    uniforms.aspect.value = viewport.x / viewport.y;
    const helpers = [this.transformHelper, this.shadowHelper].filter(Boolean);
    const helperVisibility = helpers.map(helper => helper.visible);
    helpers.forEach(helper => { helper.visible = false; });
    // Render the same real geometry/depth once, on transparent linear black.
    // Photo/shadow compositing follows the premultiplied model-only blur.
    this.scene.background = null;
    this._dofRenderPass.clearColor = new THREE.Color(0, 0, 0);
    this._dofRenderPass.clearAlpha = 0;
    try { this._dofComposer.render(); }
    finally {
      this.scene.background = background;
      helpers.forEach((helper, index) => { helper.visible = helperVisibility[index]; });
    }
    if (helperVisibility.some(Boolean)) {
      const hidden = [this.modelGroup, this.floor, this.grid, this.cap, ...this._partCaps];
      const visible = hidden.map(object => object.visible);
      const background = this.scene.background;
      const autoClear = this.renderer.autoClear;
      const shadowEnabled = this.renderer.shadowMap.enabled;
      try {
        hidden.forEach(object => { object.visible = false; });
        this.scene.background = null;
        this.renderer.autoClear = false;
        this.renderer.shadowMap.enabled = false;
        this.renderer.clearDepth();
        this.renderer.render(this.scene, this.camera);
      } finally {
        hidden.forEach((object, index) => { object.visible = visible[index]; });
        this.scene.background = background;
        this.renderer.autoClear = autoClear;
        this.renderer.shadowMap.enabled = shadowEnabled;
      }
    }
  }

  _drawUnblurredScene() {
    if (!this.hasModel()) { this.renderer.render(this.scene, this.camera); return; }
    // Resolve fine ivory/navy geometry in LINEAR light even when blur is off.
    // A canvas MSAA resolve happens after material sRGB encoding and would bake
    // a dark encoded-space mixture into each spatial sample.
    this._ensureDof();
    this._dofRenderPass.samples = !this._exportState && this._metadata?.historicalPathSurface === 'analytic-pbr-extrusion' ? 4 : 1;
    this._dofRenderPass.preserveDepth = false;
    this._dofRenderPass.clearColor = this.renderer.getClearColor(new THREE.Color()).clone();
    this._dofRenderPass.clearAlpha = this.renderer.getClearAlpha();
    const bokehEnabled = this._dofBokehPass.enabled;
    this._dofBokehPass.enabled = false;
    try { this._dofComposer.render(); }
    finally { this._dofBokehPass.enabled = bokehEnabled; }
  }

  _createPreviewControls() {
    const controls = new OrbitControls(this.camera, this.renderer.domElement);
    controls.enabled = false;
    controls.enableDamping = true;
    controls.dampingFactor = 0.085;
    controls.minDistance = 0.5;
    controls.maxDistance = 150;
    controls.target.set(0, 3, 0);
    return controls;
  }

  /** End residual orbit motion without changing the selected camera framing.
   * enabled=false alone does not stop OrbitControls.update applying old deltas.
   * Flush them with damping off, then restore the complete camera and target. */
  lockPreviewCamera() {
    const camera = this.camera.clone(), target = this.controls.target.clone();
    const damping = this.controls.enableDamping;
    this.controls.enabled = false;
    this.controls.enableDamping = false;
    try { this.controls.update(); }
    finally {
      this.camera.copy(camera, false);
      this.controls.target.copy(target);
      this.controls.enableDamping = damping;
      this.controls.enabled = false;
    }
  }

  _handleGizmoDraggingChange(event) {
    this.lockPreviewCamera();
    if (event.value) { this._gizmoScaleStart = this.options.modelScale; this.beginPreviewInteraction({hold:true}); }
    else this.endPreviewInteraction();
  }

  setTransformMode(mode) {
    if (mode !== null && !['translate', 'rotate', 'scale'].includes(mode)) throw new Error('请选择移动、旋转或缩放。');
    if (mode === null && this.transform.dragging) this.transform.pointerUp(null);
    this.lockPreviewCamera();
    this._transformMode = mode;
    if (mode && this._shadowEditMode) this.setShadowEditMode(false);
    if (!mode || !this.hasModel()) {
      this.transform.detach();
      this.transform.enabled = false;
      this.transformHelper.visible = false;
      return;
    }
    this.transform.attach(this.modelGroup);
    this.transform.setMode(mode);
    this.transform.setSpace(mode === 'translate' ? 'world' : 'local');
    this.transform.enabled = !this._exportState;
    this.transformHelper.visible = !this._exportState;
    this.render(this.options.progress, this._turnRadians);
  }

  _handleTransformChange() {
    if (this._exportState || !this.hasModel()) return;
    if (this.transform.getMode() === 'scale') {
      const values = this.modelGroup.scale.toArray();
      const original = this._gizmoScaleStart || this.options.modelScale || 1;
      const edited = values.reduce((best, value) => Math.abs(value - original) > Math.abs(best - original) ? value : best, values[0]);
      this.modelGroup.scale.setScalar(THREE.MathUtils.clamp(Math.abs(edited), 0.1, 5));
    }
    const animationInverse = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -this._turnRadians);
    const rotation = new THREE.Euler().setFromQuaternion(animationInverse.multiply(this.modelGroup.quaternion.clone()), 'XYZ');
    Object.assign(this.options, {
      modelOffsetX: this.modelGroup.position.x / (MODEL_SIZE / 2),
      modelOffsetY: this.modelGroup.position.y / (MODEL_SIZE / 2),
      modelOffsetZ: this.modelGroup.position.z / (MODEL_SIZE / 2),
      modelRotationX: rotation.x, modelRotationY: rotation.y, modelRotationZ: rotation.z,
      modelScale: this.modelGroup.scale.x,
    });
    this.render(this.options.progress, this._turnRadians);
    this.onTransformChange?.({ ...this.options, toolColors: { ...this.options.toolColors } });
  }

  async loadFiles(files, { parsedPrintGCode = null, parsePrintGCode = null, signal = null, preserveScene = false, ...printOptions } = {}) {
    const checkCancelled = () => { if (signal?.aborted) throw new DOMException('Aborted', 'AbortError'); };
    checkCancelled();
    const local = localFiles(files);
    const supported = local.entries.filter(file => ['stl', '3mf', 'obj', 'glb', 'gltf', 'fbx', 'gcode', 'gco'].includes(extension(file.name)));
    if (supported.length !== 1) {
      local.dispose();
      throw new Error(supported.length ? '每次请选择一个主模型文件；纹理、MTL 和 BIN 可以同时选择。' : '请选择 STL、3MF、OBJ、GLB、GLTF、FBX 或 G-code 文件。');
    }
    const file = supported[0];
    const format = extension(file.name);
    let root;
    let preparedPrint = null;
    const importMetadata = {};
    const retainedMaterials = new Set();
    try {
      const warnings = [];
      if (format === 'gcode' || format === 'gco') {
        const result = parsedPrintGCode || (parsePrintGCode
          ? await parsePrintGCode(file)
          : parsePrintLayerGCode(await file.text(), { includeSupport: true }));
        validatePrintLayerData(result);
        if (!result.segmentCount) throw new Error('G-code 中没有可显示的挤出打印路径。');
        const displaySurface = printOptions.displaySurfaceLOD === false ? null : printOptions.displaySurfaceLOD || (typeof Worker==='function' ? await preparePrintSurfaceLOD(result,{signal,onProgress:printOptions.onProgress}) : null);
        checkCancelled();
        const lineGeometry = new LineSegmentsGeometry().setPositions(result.positions);
        lineGeometry.setAttribute('instancePrintWidth', new THREE.InstancedBufferAttribute(result.widths, 1));
        const geometry = createPrintPathGeometry(lineGeometry, { heights: result.heights, features: result.features });
        geometry.boundingBox = printPathModelBounds(result);
        geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(new THREE.Sphere());
        const material = createPrintPathMaterial({ prepareMaterial: value => this._prepareModelTone(value) });
        root = new THREE.Mesh(geometry, material);
        root.userData.printPathImpostor = true;
        root.customDepthMaterial = createPrintPathDepthMaterial({ clippingPlanes: [this.clipPlane], clipShadows: true });
        root.onBeforeShadow = (renderer, object, camera, shadowCamera, shadowGeometry, depthMaterial) => updatePrintPathCamera(depthMaterial, renderer, shadowCamera);
        root.frustumCulled = false;
        root.rotation.x = -Math.PI / 2;
        const materialColors = result.usedTools.map(tool => ({ tool, color: result.toolColors[tool] || this.options.color, source: result.toolColors[tool] ? 'file' : 'fallback' }));
        const missing = materialColors.filter(item => item.source === 'fallback');
        const colorWarnings = missing.length ? [`G-code 没有记录 ${missing.map(item => `T${item.tool}`).join('、')} 的实际耗材颜色，请在“耗材颜色”中确认。`] : [];
        const metadata = { mode: 'gcode', layers: result.layerHeights.length, segments: result.segmentCount, toolCount: materialColors.length, materialColors,
          supportsAvailable: Boolean(result.featureCounts?.support || result.featureCounts?.supportInterface),
          sourcePathsComplete: true, historicalPathSurface: 'analytic-pbr-extrusion', surfaceOverrideSupported: true, colorConfirmationRequired: missing.length > 0,
          ...parseFDMSlicerSettings(result.rawConfiguration || {}, result.toolColors?.length || 0),
          warnings: [...result.warnings, ...colorWarnings] };
        const options = {
          printerToSource: PRINTER_MM_TO_THREE_MM,
          toolColors: materialColors.map(item => item.color),
          sourceName: file.name, coordinateSource: 'original-printer-mm-z-up',
          ...printOptions,
        };
        preparedPrint = this._preparePrintGCode(result, options, metadata);
        checkCancelled();
        this._beginModelImport({ preserveScene });
        this._adopt(root, file.name, format, metadata);
        this._gcode = result;
        this._gcodeDirection = null;
        this._prepareGCode();
        this._commitPrintGCode(preparedPrint, options);preparedPrint = null;
        if(displaySurface){
          this._displaySurfaceController=new DisplaySurfaceController(this,displaySurface,result,this._meshes[0],this._printLayers);
          this._metadata.displaySurfaceLOD={...this._displaySurfaceController.data.stats,automatic:true,screenErrorPixels:.5};
          this._applyEnvironmentTexture();
        }
        this._finishModelImport();
        return this._metadata;
      }
      if (format === 'stl') {
        const geometry = new STLLoader().parse(await file.arrayBuffer());
        if (!geometry.attributes.normal) geometry.computeVertexNormals();
        const material = new THREE.MeshStandardMaterial({ color: geometry.hasColors ? '#ffffff' : this.options.color, roughness: 0.72, metalness: 0.03, vertexColors: Boolean(geometry.hasColors) });
        if (geometry.hasColors) { material.opacity = geometry.alpha ?? 1; material.transparent = material.opacity < 1; }
        root = new THREE.Mesh(geometry, material);
        root.rotation.x = -Math.PI / 2;
      } else if (format === '3mf') {
        const data = await file.arrayBuffer();
        const { loadPaintedThreeMF } = await import('./painted-3mf.js');
        const painted = await loadPaintedThreeMF(data, { manager: local.manager });
        const nativeSupport = inspectThreeMFArchive(data);
        if(painted.root)root=painted.root;
        else{
          const {normalizeThreeMFUnitsForLoader}=await import('./three-mf-units.js');
          const normalized=normalizeThreeMFUnitsForLoader(data);
          root=new ThreeMFLoader(local.manager).parse(normalized.data);
          Object.assign(importMetadata,{sourceUnitsToMm:1,sourceUnitsInferred:false,threeMFUnitModels:normalized.models,viewerUnitNormalization:true});
        }
        root.rotation.x = -Math.PI / 2;
        warnings.push(...(painted.warnings || []));
        importMetadata.colorSupport = painted.root ? painted.colorSupport : nativeSupport.standardColors ? 'standard' : 'none';
        importMetadata.sliceSourceMode=nativeSupport.hasSavedSliceSettings||nativeSupport.hasEmbeddedGCode?'saved-engineering':'generic-model';
        for (const key of ['layerHeightMm','lineWidthMm','firstLayerHeightMm','surfaceSettingsInferred','materialProfiles','surfaceApproximate']) if (painted[key] !== undefined) importMetadata[key] = painted[key];
        if (painted.root) {
          importMetadata.filamentPalette = [...(painted.materialColors || [])];
          const usedTools = new Set();
          painted.root.traverse(node => {
            if (!node.isMesh) return;
            if (Array.isArray(node.material)) {
              for (const group of node.geometry.groups) if (group.count > 0) {
                const tool = node.material[group.materialIndex]?.userData?.toolIndex;
                if (Number.isInteger(tool)) usedTools.add(tool);
              }
            } else if ((node.geometry.index?.count || node.geometry.attributes.position?.count || 0) > 0) {
              const tool = node.material?.userData?.toolIndex;
              if (Number.isInteger(tool)) usedTools.add(tool);
            }
            const tools = node.geometry.attributes.toolIndex;
            if (tools) for (let index = 0; index < tools.count; index++) usedTools.add(tools.getX(index));
          });
          importMetadata.materialColors = (painted.materialColors || []).map((color, tool) => ({ tool, color, source: 'file' })).filter(item => hexColor(item.color) && usedTools.has(item.tool));
        }
        else if (nativeSupport.proprietaryPaint && !painted.recognized) warnings.push('文件含尚未识别的专用涂色编码，当前只显示基础网格，请检查原色是否一致。');
      } else if (format === 'obj') {
        const loader = new OBJLoader(local.manager);
        const mtl = local.entries.find(item => extension(item.name) === 'mtl');
        if (mtl) {
          const materials = new MTLLoader(local.manager).parse(await mtl.text(), '');
          try { materials.preload(); }
          finally { Object.values(materials.materials).forEach(material => retainedMaterials.add(material)); }
          loader.setMaterials(materials);
        }
        root = loader.parse(await file.text());
        warnings.push('OBJ 使用 Y 轴向上；若方向不同，可用旋转按钮调整。');
      } else if (format === 'fbx') {
        root = new FBXLoader(local.manager).parse(await file.arrayBuffer(), '');
        warnings.push('FBX 显示导入时的静态姿态；骨骼动画不会参与生长动画。');
      } else {
        const loader = new GLTFLoader(local.manager);
        const data = format === 'gltf' ? await file.text() : await file.arrayBuffer();
        try { root = (await loader.parseAsync(data, '')).scene; }
        catch (error) {
          if (/draco|ktx|basis|meshopt/i.test(error.message)) throw new Error('这个 glTF 使用了压缩扩展。请导出不含 Draco、Meshopt 或 KTX2 的普通 GLB 再导入。');
          throw error;
        }
      }
      if (!root) throw new Error('没有找到可显示的模型。');
      Object.assign(importMetadata, modelSourceUnits(format, root));
      if (format === 'stl' && printOptions.sourceUnitMillimetres !== undefined) {
        if (![1, 10, 1000].includes(printOptions.sourceUnitMillimetres)) throw new Error('请选择毫米、厘米或米。');
        Object.assign(importMetadata, { sourceUnitsToMm: printOptions.sourceUnitMillimetres, sourceUnitsUserConfirmed: true, sourceUnitsInferred: true });
      }
      // OBJ/FBX parsing is synchronous, while their texture loaders are not.
      // Wait for the actual loader requests before committing the new model.
      await local.ready();
      if (signal) await new Promise(resolve => setTimeout(resolve, 0));
      const metadata = { mode: 'mesh', warnings, ...importMetadata };
      if (parsedPrintGCode) preparedPrint = this._preparePrintGCode(parsedPrintGCode, {
        printerToSource: PRINTER_MM_TO_THREE_MM, sourceName: file.name,
        coordinateSource: 'original-embedded-sliced-3mf-printer-build', ...printOptions,
      }, metadata);
      checkCancelled();
      if (preparedPrint) this._beginModelImport({ preserveScene });
      this._adopt(root, file.name, format, metadata, retainedMaterials);
      if (preparedPrint) {
        this._commitPrintGCode(preparedPrint, {
          printerToSource: PRINTER_MM_TO_THREE_MM, sourceName: file.name,
          coordinateSource: 'original-embedded-sliced-3mf-printer-build', ...printOptions,
        });preparedPrint = null;
        this._finishModelImport();
      }
      return this._metadata;
    } catch (error) {
      preparedPrint?.nextSupports?.dispose();preparedPrint?.next?.dispose();
      this._rollbackModelImport();
      await local.settled();
      if (root && this.orientation?.children[0] !== root) disposeTree(root, retainedMaterials);
      else if (!root) disposeTree(null, retainedMaterials);
      if (error.name === 'AbortError') throw error;
      throw new Error(`导入失败：${error.message || String(error)}`);
    } finally {
      local.dispose();
    }
  }

  loadDemo() {
    this._adopt(demoVase(), '螺旋花瓶 · 内置示例', 'demo', { mode: 'mesh', warnings: [] });
    return this._metadata;
  }

  // Only the final synchronous adoption runs inside this transaction. No await,
  // rAF or cancellation check occurs after it starts: callers receive a complete
  // model+paths commit, or the previous usable model with its resources intact.
  _beginModelImport({ preserveScene = false } = {}) {
    if (this._modelImportTransaction) throw new Error('模型提交正在进行。');
    const fields = ['orientation','normalized','_metadata','_meshes','_supportMeshes','_stencils','_partCaps',
      '_sourceMaterials','_surfaceMaterials','_retainedMaterials','_gcode','_gcodeShadow','_supportOverlay',
      '_indexedSupports','_printLayers','_displaySurfaceController','_baseBounds','_baseHeight','_capSourceColor','_capSourceTool',
      '_gcodeColorKey','_gcodeSurfaceKey','_gcodeOrder','_gcodeDirection','_sortedLayers','_meshColorKey','_fullSourceFov','_cropFullFov'];
    this._modelImportTransaction = {
      preserveScene: Boolean(preserveScene && this.normalized && this._metadata),
      fields: Object.fromEntries(fields.map(key => [key, this[key]])),
      options: { ...this.options, toolColors: { ...this.options.toolColors } },
      pose: { position:this.modelGroup.position.clone(),quaternion:this.modelGroup.quaternion.clone(),scale:this.modelGroup.scale.clone(),visible:this.modelGroup.visible },
      bounds:this._bounds?.clone(),clipPlane:this.clipPlane?.clone(),
      camera:this.camera?.clone(),target:this.controls?.target?.clone(),
      layerUniforms:Object.fromEntries(Object.entries(this.layerUniforms || {}).map(([key,value])=>[key,value.value])),
    };
  }

  _disposeModelState(state) {
    state._displaySurfaceController?.dispose();
    state._indexedSupports?.dispose();state._printLayers?.dispose();
    disposeTree(state.orientation, [...(state._retainedMaterials || []), ...(state._supportOverlay?.retainedMaterials || [])]);
    for (const cap of state._partCaps || []) { this.scene.remove(cap);disposeTree(cap); }
  }

  _finishModelImport() {
    const transaction = this._modelImportTransaction;
    if (transaction.preserveScene) {
      // Retain the scene's physical scale, not a fresh MODEL_SIZE fit. Otherwise
      // copied camera and pose fields would still move the model on the bed.
      const oldUnits = transaction.fields._metadata?.sourceUnitsToMm || 1;
      const newUnits = this._metadata?.sourceUnitsToMm || 1;
      const worldPerMm = transaction.fields.normalized.scale.x / oldUnits;
      const factor = worldPerMm * newUnits / this.normalized.scale.x;
      if (!this._scaleSourceScene(factor)) throw new Error('模型场景比例无效。');
      this._fullSourceFov = transaction.fields._fullSourceFov;
      this._cropFullFov = transaction.fields._cropFullFov;
    }
    this.setOptions(this.options);
    if (transaction.preserveScene && transaction.camera) {
      this.camera.copy(transaction.camera, false);
      if (transaction.target && this.controls?.target) this.controls.target.copy(transaction.target);
      this.camera.updateMatrixWorld(true);
    } else {
      // First import fits only after complete paths/support adoption.
      this.resetCamera();
    }
    if (this.transform && this._transformMode) this.setTransformMode(this._transformMode);
    this.render(this.options.progress, this._turnRadians);
    this._modelImportTransaction = null;
    this._disposeModelState(transaction.fields);
  }

  _rollbackModelImport() {
    const transaction = this._modelImportTransaction;
    if (!transaction) return;
    if (this.orientation !== transaction.fields.orientation) this._disposeModelState(this);
    this.modelGroup.clear();Object.assign(this,transaction.fields);this.options=transaction.options;
    if(this.normalized)this.modelGroup.add(this.normalized);
    for(const cap of this._partCaps || [])this.scene.add(cap);
    this.modelGroup.position.copy(transaction.pose.position);this.modelGroup.quaternion.copy(transaction.pose.quaternion);this.modelGroup.scale.copy(transaction.pose.scale);this.modelGroup.visible=transaction.pose.visible;
    if(transaction.bounds&&this._bounds)this._bounds.copy(transaction.bounds);
    if(transaction.clipPlane&&this.clipPlane)this.clipPlane.copy(transaction.clipPlane);
    if(transaction.camera&&this.camera)this.camera.copy(transaction.camera,false);
    if(transaction.target&&this.controls?.target)this.controls.target.copy(transaction.target);
    for(const [key,value]of Object.entries(transaction.layerUniforms))this.layerUniforms[key].value=value;
    this._modelImportTransaction=null;this._requestRender();
  }

  _adopt(root, name, format, extra, retainedMaterials = new Set()) {
    const meshes = [];
    root.traverse(node => { if (node.isMesh || node.isLineSegments2) meshes.push(node); });
    if (!meshes.length) { disposeTree(root); throw new Error('文件中没有网格或路径。'); }
    const supportMeshes = new Set(meshes.filter(mesh => {
      let node = mesh;
      while (node) {
        if (node.userData?.isSupport) return true;
        if (node === root) break;
        node = node.parent;
      }
      return false;
    }));
    root.updateMatrixWorld(true);
    const initial = meshBounds(meshes);
    const size = initial.getSize(new THREE.Vector3());
    if (initial.isEmpty() || ![size.x, size.y, size.z].every(Number.isFinite) || Math.max(size.x, size.y, size.z) <= 0) {
      disposeTree(root); throw new Error('模型尺寸无效或为空。');
    }
    const sourceMaterials = new Map();
    const surfaceMaterials = new Map();
    const originals = new Set(retainedMaterials);
    const staged = new Map();
    // Stage material preparation first. A malformed material must not remove the
    // model which the user is currently previewing.
    try {
      for (const mesh of meshes) {
        if (mesh.isLineSegments2) continue;
        if (mesh.userData.printPathImpostor) {
          this._prepareMaterial(mesh.material, sourceMaterials, surfaceMaterials, null);
          continue;
        }
        const source = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        const prepared = source.map(material => {
          if (!material?.isMaterial) throw new Error('模型包含无效材质。');
          originals.add(material);
          return this._prepareMaterial(material.clone(), sourceMaterials, surfaceMaterials, ['3mf', 'stl', 'demo'].includes(format) ? extra : null);
        });
        staged.set(mesh, { prepared, array: Array.isArray(mesh.material) });
      }
    } catch (error) {
      for (const material of sourceMaterials.keys()) material.dispose();
      throw error;
    }
    if (!this._modelImportTransaction) this._indexedSupports?.dispose();
    this._indexedSupports = null;
    if(!this._modelImportTransaction)this._displaySurfaceController?.dispose();
    this._displaySurfaceController=null;
    if (!this._modelImportTransaction) this._printLayers?.dispose();
    this._printLayers = null;
    if (!this._modelImportTransaction) disposeTree(this.orientation, [...this._retainedMaterials, ...(this._supportOverlay?.retainedMaterials || [])]);
    for (const cap of this._partCaps || []) { this.scene.remove(cap); if (!this._modelImportTransaction) disposeTree(cap); }
    this._partCaps = [];
    this.modelGroup.clear();
    this._sourceMaterials = sourceMaterials;
    this._surfaceMaterials = surfaceMaterials;
    this._retainedMaterials = originals;
    this._gcode = null;
    this._gcodeShadow = null;
    this._supportOverlay = null;
    this.options.toolColors = {};
    this._gcodeColorKey = null;
    this._gcodeSurfaceKey = null;
    this._gcodeOrder = null;
    this._meshColorKey = null;
    this._meshes = meshes;
    this._supportMeshes = supportMeshes;
    this._stencils = [];
    this.orientation = new THREE.Group();
    this.orientation.add(root);
    this.normalized = new THREE.Group();
    this.normalized.add(this.orientation);
    this.modelGroup.add(this.normalized);
    let triangles = 0;
    // Uniform, closed parts can each keep their own cross-section color. An open
    // color patch or a textured/vertex-painted part needs the shared volume cap.
    const partCaps = meshes.length > 1 && meshes.length <= 8 && meshes.every(mesh => !mesh.isLineSegments2 && !Array.isArray(mesh.material) && !mesh.material.vertexColors && !mesh.material.map && closedGeometry(mesh.geometry));
    let partIndex = 0;
    for (const mesh of meshes) {
      if (mesh.isLineSegments2) continue;
      if (mesh.userData.printPathImpostor) {
        mesh.castShadow = mesh.receiveShadow = true; mesh.renderOrder = 10;
        continue;
      }
      triangles += (mesh.geometry.index?.count ?? mesh.geometry.attributes.position?.count ?? 0) / 3;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.renderOrder = 10;
      // Keep imported materials independent of application clipping and recoloring.
      const { prepared, array } = staged.get(mesh);
      mesh.material = array ? prepared : prepared[0];
      for (const side of [THREE.BackSide, THREE.FrontSide]) {
        const stencilMaterial = new THREE.MeshBasicMaterial({
          side, colorWrite: false, depthWrite: false, depthTest: false,
          clippingPlanes: [this.clipPlane], stencilWrite: true,
          stencilFunc: THREE.AlwaysStencilFunc,
          stencilFail: side === THREE.BackSide ? THREE.IncrementWrapStencilOp : THREE.DecrementWrapStencilOp,
          stencilZFail: side === THREE.BackSide ? THREE.IncrementWrapStencilOp : THREE.DecrementWrapStencilOp,
          stencilZPass: side === THREE.BackSide ? THREE.IncrementWrapStencilOp : THREE.DecrementWrapStencilOp,
        });
        const stencil = mesh.clone(false);
        stencil.material = stencilMaterial;
        stencil.castShadow = stencil.receiveShadow = false;
        stencil.renderOrder = (partCaps ? 20 + partIndex * 3 : 20) + (side === THREE.BackSide ? 0 : 1);
        stencil.frustumCulled = false;
        stencil.userData.growthStencil = true;
        stencil._growthSource = mesh;
        mesh.parent.add(stencil);
        this._stencils.push(stencil);
      }
      if (partCaps) {
        const cap = new THREE.Mesh(new THREE.PlaneGeometry(100, 100), this.cap.material.clone());
        cap.rotation.x = -Math.PI / 2;
        cap.renderOrder = 22 + partIndex * 3;
        cap.visible = false;
        cap.userData.sourceColor = mesh.material.color?.clone() || new THREE.Color(this.options.color);
        cap.userData.toolIndex = mesh.material.userData?.toolIndex;
        cap._growthSource = mesh;
        cap.material.color.copy(cap.userData.sourceColor);
        cap.onAfterRender = renderer => renderer.clearStencil();
        cap._fdmSurface = installFDMSurface(cap.material, { topSurface: true, materialProfile: mesh.material.userData.fdmProfile || 'pla' });
        installPrintReflections(cap.material);
        this._prepareModelTone(cap.material);
        this.scene.add(cap);
        this._partCaps.push(cap);
      }
      partIndex += 1;
    }
    this._metadata = { name, format, meshes: meshes.filter(mesh => mesh.isMesh).length, triangles: Math.round(triangles), dimensions: { x: size.x, y: size.y, z: size.z }, capColors: partCaps ? 'per-part' : 'reference', supportsAvailable: supportMeshes.size > 0, supportMeshes: supportMeshes.size, layerHeightMm: DEFAULT_LAYER_HEIGHT_MM, firstLayerHeightMm: DEFAULT_FIRST_LAYER_HEIGHT_MM, lineWidthMm: 0.42, surfaceSettingsInferred: { layerHeight: true, lineWidth: true }, surfaceTopMode: 'slice-required', sourceUnitsToMm: ['glb','gltf'].includes(format) ? 1000 : 1, sourceUnitsInferred: ['obj','fbx','stl'].includes(format), surfaceOverrideSupported: meshes.every(mesh => (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).every(material => material.isMeshStandardMaterial)), ...extra };
    const firstMesh = meshes.find(mesh => mesh.isMesh);
    const firstMaterial = firstMesh && (Array.isArray(firstMesh.material) ? firstMesh.material[0] : firstMesh.material);
    this._capSourceColor = firstMaterial?.color?.clone() || new THREE.Color(this.options.color);
    this._capSourceTool = firstMaterial?.userData?.toolIndex;
    const colorAttribute = firstMesh?.geometry.attributes.color;
    if (firstMaterial?.vertexColors && colorAttribute?.count) this._capSourceColor.multiply(new THREE.Color().fromBufferAttribute(colorAttribute, Math.floor(colorAttribute.count / 2)));
    this._normalize();
    if (!this._modelImportTransaction) {
      this.setOptions(this.options);
      this.resetCamera();
      if (this.transform && this._transformMode) this.setTransformMode(this._transformMode);
    }
  }

  _prepareMaterial(material, sourceMaterials = this._sourceMaterials, surfaceMaterials = this._surfaceMaterials, surfaceSettings = null) {
    material.clippingPlanes = [this.clipPlane];
    material.clipShadows = true;
    material.side = THREE.DoubleSide;
    sourceMaterials.set(material, { color: material.color?.clone(), map: material.map, vertexColors: material.vertexColors, toolIndex: material.userData?.toolIndex, envMap: material.envMap, envMapIntensity: material.envMapIntensity, roughness: material.roughness, metalness: material.metalness, printable: Boolean(surfaceSettings) });
    if (surfaceSettings && material.isMeshStandardMaterial) {
      const handle = installFDMSurface(material, { ...surfaceSettings, firstLayerHeightMm: surfaceSettings.firstLayerHeightMm ?? material.userData.fdmFirstLayerHeightMm, materialProfile: material.userData.fdmProfile || 'pla', surfacePreset: this.options.surfacePreset || 'auto', surfaceDetail: this.options.layerLines === false ? 0 : this.options.surfaceDetail ?? 0.6 });
      surfaceMaterials?.set(material, handle);
    }
    if (!material.envMap) installPrintReflections(material);
    return this._prepareModelTone(material);
  }

  _prepareModelTone(material) {
    this._modelToneMaterials ||= new WeakSet();
    this._modelExposure ||= { value: this.options.exposure ?? DEFAULT_LIGHTING.exposure };
    this._updateModelGrading();
    if (this._modelToneMaterials.has(material)) return material;
    this._modelToneMaterials.add(material);
    const previous = material.onBeforeCompile;
    const previousKey = material.customProgramCacheKey.bind(material);
    material.onBeforeCompile = (shader, renderer) => {
      previous.call(material, shader, renderer);
      shader.uniforms.modelExposure = this._modelExposure;
      Object.assign(shader.uniforms, this._modelGradingUniforms);
      const toneFunctions = THREE.ShaderChunk.tonemapping_pars_fragment.replace('uniform float toneMappingExposure;', 'const float toneMappingExposure = 1.0;');
      shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\n' + toneFunctions + '\nuniform float modelExposure;\n' + COLOR_GRADING_GLSL);
      shader.fragmentShader = shader.fragmentShader.replace('#include <tonemapping_fragment>', 'gl_FragColor.rgb = modelGradeLinearRGB(ACESFilmicToneMapping(gl_FragColor.rgb * modelExposure));');
    };
    material.customProgramCacheKey = () => `${previousKey()}|model-tone-grade-v2`;
    return material;
  }

  _updateModelGrading() {
    const grade = colorGradingValues(this.options);
    this._modelGradingUniforms ||= {
      modelGradeControls: { value: new THREE.Vector4() },
      modelGradeSaturation: { value: 0 },
      modelGradeEnabled: { value: 0 },
    };
    this._modelGradingUniforms.modelGradeControls.value.set(grade.tint, grade.shadows, grade.highlights, grade.contrast);
    this._modelGradingUniforms.modelGradeSaturation.value = grade.saturation;
    this._modelGradingUniforms.modelGradeEnabled.value = grade.enabled ? 1 : 0;
  }

  _surfaceOptions(tool, fallback = 'pla') {
    const metadata = this._metadata || {};
    return {
      layerHeightMm: metadata.layerHeightMm ?? DEFAULT_LAYER_HEIGHT_MM,
      firstLayerHeightMm: metadata.firstLayerHeightMm ?? DEFAULT_FIRST_LAYER_HEIGHT_MM,
      lineWidthMm: metadata.lineWidthMm ?? 0.42,
      surfacePreset: this.options.surfacePreset || 'auto',
      surfaceDetail: this.options.layerLines === false ? 0 : this.options.surfaceDetail ?? 0.6,
      materialProfile: metadata.materialProfiles?.find(item => item.tool === tool)?.profile || fallback,
    };
  }

  _updateFDMSurfaces() {
    this._surfaceMaterials ||= new Map();
    const preset = this.options.surfacePreset || 'auto';
    for (const [material, source] of this._sourceMaterials || []) {
      if (material.userData.printPathImpostor) continue;
      if (!material.isMeshStandardMaterial) continue;
      if (!source.printable && preset === 'auto') {
        const handle = this._surfaceMaterials.get(material);
        if (handle) handle.uniforms.fdmDetail.value = 0;
        material.roughness = source.roughness;
        material.metalness = source.metalness;
        if (material.envMap?.mapping !== source.envMap?.mapping) material.needsUpdate = true;
        material.envMap = source.envMap;
        material.envMapIntensity = source.envMapIntensity;
        continue;
      }
      let handle = this._surfaceMaterials.get(material);
      if (!handle) {
        handle = installFDMSurface(material, this._surfaceOptions(material.userData.toolIndex, material.userData.fdmProfile || 'pla'));
        this._surfaceMaterials.set(material, handle);
      }
      handle.update(this._surfaceOptions(material.userData.toolIndex, material.userData.fdmProfile || 'pla'));
    }
    this._capSurface?.update(this._surfaceOptions(this._capSourceTool));
    for (const cap of this._partCaps || []) cap._fdmSurface?.update(this._surfaceOptions(cap.userData.toolIndex));
    if (this._supportOverlay?.solidMaterial) {
      // Support beads already have their actual extruded geometry; do not add
      // a second set of artificial layer ridges over those toolpaths.
      const profile = resolveFDMSurfaceProfile(this.options.surfacePreset || 'auto', this._surfaceOptions(this._metadata?.supportMaterialColors?.[0]?.tool).materialProfile);
      this._supportOverlay.solidMaterial.roughness = profile.roughness;
      this._supportOverlay.solidMaterial.metalness = 0;
    }
  }

  _updatePrintMatrix() {
    this._printMatrix ||= new THREE.Matrix4();
    const scale = this.normalized?.scale.x || 1;
    const sourceToMm = this._metadata?.sourceUnitsToMm || 1;
    this._printMatrix.makeScale(sourceToMm / scale, sourceToMm / scale, sourceToMm / scale).multiply(this.modelGroup.matrixWorld.clone().invert());
    for (const handle of this._surfaceMaterials?.values() || []) handle.uniforms.fdmPrintMatrix.value.copy(this._printMatrix);
    if (this._capSurface) this._capSurface.uniforms.fdmPrintMatrix.value.copy(this._printMatrix);
    for (const cap of this._partCaps || []) if (cap._fdmSurface) cap._fdmSurface.uniforms.fdmPrintMatrix.value.copy(this._printMatrix);
    this._displaySurfaceController?.updatePrintMatrix();
  }

  _applyEnvironmentTexture() {
    if (!this._environmentTexture) return;
    const intensity = printReflectionIntensity(this.options);
    const assign = material => {
      if (!material?.isMeshStandardMaterial) return;
      const mappingChanged = material.envMap?.mapping !== this._environmentTexture.mapping;
      material.envMap = this._environmentTexture;
      material.envMapIntensity = intensity;
      if (mappingChanged) material.needsUpdate = true;
    };
    for (const [material, source] of this._sourceMaterials || []) if (!source.envMap && (source.printable || this.options.surfacePreset && this.options.surfacePreset !== 'auto')) assign(material);
    assign(this.cap?.material);
    for (const cap of this._partCaps || []) assign(cap.material);
    assign(this._supportOverlay?.solidMaterial);
    for (const record of this._indexedSupports?.records.values() || []) assign(record.solidMaterial);
    for (const mesh of this._meshes || []) if (mesh.userData.printPathImpostor) assign(mesh.material);
    for (const mesh of this._printLayers?.meshes.values() || []) assign(mesh.material);
    this._displaySurfaceController?.applyEnvironment();
  }

  _buildEnvironment(descriptor) {
    if (!this.renderer?.isWebGLRenderer || this._environmentUnavailable) return;
    try {
      this._environmentCache ||= new PrintEnvironmentCache(this.renderer);
      this._environmentTexture = this._environmentCache.get(descriptor);
      this._environmentKey = printEnvironmentKey(descriptor);
      this._applyEnvironmentTexture();
      this._requestRender();
    } catch (error) {
      this._environmentUnavailable = true;
      this._environmentCache?.dispose();
      this._environmentCache = null;
      if (this._metadata) this._metadata.environmentWarning = '当前图形设备无法生成环境反射，已保留直接灯光。';
    }
  }

  _scheduleEnvironment() {
    if (!this.hasModel() || !this.renderer?.isWebGLRenderer || this._environmentUnavailable) return;
    const descriptor = printEnvironmentDescriptor(this.options, this._backgroundMetadata?.name);
    const key = printEnvironmentKey(descriptor);
    this._environmentDescriptor = descriptor;
    this._applyEnvironmentTexture();
    if (key === this._environmentKey || key === this._environmentRequestedKey && this._environmentTimer) return;
    clearTimeout(this._environmentTimer);
    this._environmentRequestedKey = key;
    if (!this._environmentTexture) this._buildEnvironment(descriptor);
    else if (!this._exportState) this._environmentTimer = setTimeout(() => {
      this._environmentTimer = null;
      if (!this._exportState) this._buildEnvironment(this._environmentDescriptor);
    }, 180);
  }

  _flushEnvironment() {
    clearTimeout(this._environmentTimer); this._environmentTimer = null;
    if (this._environmentDescriptor && this._environmentKey !== printEnvironmentKey(this._environmentDescriptor)) this._buildEnvironment(this._environmentDescriptor);
  }

  _preparePhotoShadowMaterial() {
    const material = this._floorShadowMaterial;
    this._photoShadowUniforms = {
      photoShadowMap: { value: null },
      photoShadowUvTransform: { value: new THREE.Matrix3() },
      photoShadowViewport: { value: new THREE.Vector4(0, 0, 1, 1) },
      photoShadowScreen: { value: 0 },
      photoShadowVideo: { value: 0 },
      photoShadowIntensity: { value: 1 },
      groundShadowRadius: { value: new THREE.Vector2() },
      groundShadowContactRadius: { value: new THREE.Vector2() },
      groundShadowContactStrength: { value: 0 },
    };
    const previous = material.onBeforeCompile;
    const previousKey = material.customProgramCacheKey.bind(material);
    material.toneMapped = false;
    material.onBeforeCompile = (shader, renderer) => {
      previous.call(material, shader, renderer);
      Object.assign(shader.uniforms, this._photoShadowUniforms);
      injectGroundShadowSoftness(shader, this._photoShadowUniforms);
      shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\n' + PHOTO_SHADOW_GLSL);
      shader.fragmentShader = shader.fragmentShader.replace('#include <tonemapping_fragment>', `
if (photoShadowScreen > 0.5 && gl_FragColor.a > 0.000001) {
  gl_FragColor.rgb = photoShadowCompensation(gl_FragColor.a);
}
#include <tonemapping_fragment>`);
    };
    material.customProgramCacheKey = () => `${previousKey()}|photo-ground-shadow-contact-v3`;
    material.onBeforeRender = (renderer, scene) => {
      const uniforms = this._photoShadowUniforms;
      const photo = this._backgroundTexture;
      // Millimetres on the calibrated plate, rather than a few shadow-map
      // texels. Keep this independent of preview/export resolution and DOF.
      const sourceToMm = this._metadata?.sourceUnitsToMm || 1;
      const mmToWorld = (this.normalized?.scale.x || 1) * (this.options?.modelScale || 1) / sourceToMm;
      uniforms.groundShadowRadius.value.fromArray(groundShadowRadiusUV(this.options?.shadowRadius ?? 3, mmToWorld, this.keyLight?.shadow.camera));
      uniforms.groundShadowContactRadius.value.fromArray(groundContactRadiusUV(mmToWorld,this.keyLight?.shadow.camera));
      const preset=this._photoIdentity?.startsWith('preset:')?BACKGROUND_PRESETS[this._photoIdentity.slice(7)]:null;
      uniforms.groundShadowContactStrength.value=preset?.kind==='printer' ? .28 : 0;
      uniforms.photoShadowMap.value = photo;
      uniforms.photoShadowScreen.value = photo && scene.background === photo && !renderer.getRenderTarget() && renderer.outputColorSpace === THREE.SRGBColorSpace ? 1 : 0;
      uniforms.photoShadowVideo.value = photo?.isVideoTexture && photo.colorSpace === THREE.SRGBColorSpace ? 1 : 0;
      uniforms.photoShadowIntensity.value = scene.backgroundIntensity;
      if (photo) uniforms.photoShadowUvTransform.value.copy(photo.matrix);
      renderer.getCurrentViewport(uniforms.photoShadowViewport.value);
    };
  }

  _updateFloorFootprint() {
    if (!this.floor) return;
    const bed = this._backgroundTexture && this._photoBedSize;
    // PlaneGeometry's local XY becomes world XZ after the ground rotation.
    // The calibrated printable rectangle belongs to the photo, not the model.
    const photographic = BACKGROUND_PRESETS[this._photoIdentity?.slice(7)]?.kind === 'photography';
    const receiver = bed && photographic ? photographicReceiverSize({bed, bounds:this._bounds,
      lightAzimuth:this.options?.lightAzimuth, lightElevation:this.options?.lightElevation,
      softness:this.options?.shadowRadius, mmToWorld:this.modelMillimetresToWorld, floorY:-.001}) : bed;
    this.floor.scale.set(receiver ? receiver.width / 200 : 1, receiver ? receiver.depth / 200 : 1, 1);
    this.floor.position.x = this.floor.position.z = 0;
    if (bed) this.floor.position.y = -0.001;
  }

  _applyLighting() {
    const lighting = normalizeLighting(this.options);
    for (const key of ['colorTemperature','keyIntensity','ambientIntensity','fillIntensity','exposure','ambientSkyColor','ambientGroundColor','fillColor','fillPosition',...COLOR_GRADING_KEYS]) this.options[key] = lighting[key];
    this._modelExposure ||= { value: lighting.exposure };
    this._modelExposure.value = lighting.exposure;
    this._updateModelGrading();
    const temperature = new THREE.Color().fromArray(kelvinToLinearRGB(lighting.colorTemperature));
    this.keyLight.color.copy(temperature);
    this.keyLight.intensity = lighting.keyIntensity;
    if (this.hemisphereLight) {
      this.hemisphereLight.color.set(lighting.ambientSkyColor);
      this.hemisphereLight.groundColor.set(lighting.ambientGroundColor);
      this.hemisphereLight.intensity = lighting.ambientIntensity;
    }
    if (this.fillLight) {
      this.fillLight.color.set(lighting.fillColor);
      this.fillLight.intensity = lighting.fillIntensity;
      this.fillLight.position.fromArray(lighting.fillPosition);
    }
    if (this.rimLight) this.rimLight.intensity = 0;
    if (this.renderer) { this.renderer.toneMapping = THREE.NoToneMapping; this.renderer.toneMappingExposure = 1; }
    this._scheduleEnvironment();
  }

  _normalize() {
    this.normalized.position.set(0, 0, 0);
    this.normalized.scale.setScalar(1);
    this.modelGroup.position.set(0, 0, 0);
    this.modelGroup.scale.setScalar(1);
    this.modelGroup.rotation.set(0, 0, 0);
    this.scene.updateMatrixWorld(true);
    const bounds = meshBounds(this._meshes);
    const size = bounds.getSize(new THREE.Vector3());
    const scale = MODEL_SIZE / Math.max(size.x, size.y, size.z);
    const center = bounds.getCenter(new THREE.Vector3());
    this.normalized.scale.setScalar(scale);
    this.normalized.position.set(-center.x * scale, -bounds.min.y * scale, -center.z * scale);
    this._baseHeight = size.y * scale;
    this._baseBounds = new THREE.Box3(new THREE.Vector3(-size.x * scale / 2, 0, -size.z * scale / 2), new THREE.Vector3(size.x * scale / 2, this._baseHeight, size.z * scale / 2));
  }

  _prepareGCode() {
    if (!this._gcode) return;
    if (this._gcode.source === 'sliced-gcode') { this._prepareIndexedGCode(); return; }
    const direction = this.options.direction;
    const source = this._gcode;
    const materialColors = source.usedTools.map(tool => {
      const override = hexColor(this.options.toolColors?.[tool]);
      const file = hexColor(source.toolColors?.[tool]);
      return { tool, color: override || file || this.options.color, source: file ? 'file' : 'fallback', confirmed: Boolean(override) };
    });
    const colorKey = materialColors.map(item => `${item.tool}:${item.color}`).join('|');
    if (this._gcodeDirection === direction && this._gcodeColorKey === colorKey) return;
    const reorder = this._gcodeDirection !== direction || !this._gcodeOrder;
    const order = reorder ? Array.from({ length: source.segmentCount }, (_, index) => index) : this._gcodeOrder;
    if (reorder) order.sort((a, b) => direction === 'down' ? source.layers[b] - source.layers[a] || a - b : source.layers[a] - source.layers[b] || a - b);
    const positions = reorder ? new Float32Array(source.positions.length) : null;
    const colors = new Float32Array(source.positions.length);
    if (reorder) this._sortedLayers = new Uint32Array(source.segmentCount);
    const palette = new Map(materialColors.map(item => [item.tool, new THREE.Color(item.color)]));
    for (let index = 0; index < order.length; index++) {
      const sourceIndex = order[index];
      if (reorder) {
        positions.set(source.positions.subarray(sourceIndex * 6, sourceIndex * 6 + 6), index * 6);
        this._sortedLayers[index] = source.layers[sourceIndex];
      }
      const color = palette.get(source.tools[sourceIndex]);
      colors.set([color.r, color.g, color.b, color.r, color.g, color.b], index * 6);
    }
    const geometry = this._meshes[0].geometry;
    // The direction can be changed repeatedly. Release buffers belonging to the
    // previous ordering before replacing their instanced attributes.
    geometry.dispose();
    if (positions) geometry.setPositions(positions);
    geometry.setColors(colors);
    if (reorder && this._gcodeShadow) this._updateGCodeShadow(order);
    this._gcodeDirection = direction;
    this._gcodeOrder = order;
    this._gcodeColorKey = colorKey;
    this._metadata.materialColors = materialColors;
    const material = this._meshes[0].material;
    material.color.set(this.options.preserveMaterials ? '#ffffff' : this.options.color);
    material.vertexColors = this.options.preserveMaterials;
    material.needsUpdate = true;
  }

  _prepareIndexedGCode() {
    const source = this._gcode;
    const includeSupport = this.options.showSupports !== false;
    const modelFeatures = new Set([PRINT_FEATURE.outerWall, PRINT_FEATURE.innerWall, PRINT_FEATURE.sparseInfill,
      PRINT_FEATURE.solidInfill, PRINT_FEATURE.topSurface, PRINT_FEATURE.bottomSurface, PRINT_FEATURE.bridge,
      PRINT_FEATURE.gapInfill, PRINT_FEATURE.ironing, PRINT_FEATURE.overhangWall]);
    const proxy = this._meshes[0].userData.printPathImpostor === true;
    const selected = feature => modelFeatures.has(feature) || (proxy || includeSupport) && (feature === PRINT_FEATURE.support || feature === PRINT_FEATURE.supportInterface);
    if (proxy) {
      setPrintPathSupportVisibility(this._meshes[0].material, includeSupport);
      setPrintPathSupportVisibility(this._meshes[0].customDepthMaterial, includeSupport);
      this._metadata.displayedPathSegments = source.segmentCount - (includeSupport ? 0 : (source.featureCounts.support || 0) + (source.featureCounts.supportInterface || 0));
      this._metadata.hiddenSupportSegments = includeSupport ? 0 : (source.featureCounts.support || 0) + (source.featureCounts.supportInterface || 0);
    }
    const materialColors = source.usedTools.map(tool => {
      const override = hexColor(this.options.toolColors?.[tool]), file = hexColor(source.toolColors?.[tool]);
      return { tool, color: override || file || this.options.color, source: file ? 'file' : 'fallback', confirmed: Boolean(override) };
    });
    const colorKey = materialColors.map(item => `${item.tool}:${item.color}`).join('|');
    const key = `up/${proxy ? 'complete-paths' : includeSupport}`;
    const reorder = this._gcodeDirection !== key || !this._gcodeOrder;
    const roughnessByTool = new Map(source.usedTools.map(tool => [tool, resolveFDMSurfaceProfile(this.options.surfacePreset || 'auto', this._metadata.materialProfiles?.find(item => item.tool === tool)?.profile || 'pla').roughness]));
    const surfaceKey = [...roughnessByTool].map(([tool,value]) => `${tool}:${value}`).join('|');
    if (!reorder && this._gcodeColorKey === colorKey && (!proxy || this._gcodeSurfaceKey === surfaceKey)) return;
    let order = this._gcodeOrder;
    if (reorder) {
      let count = 0;
      for (let index = 0; index < source.segmentCount; index++) if (selected(source.features[index])) count++;
      order = new Uint32Array(count);
      let target = 0;
      // Existing layer index is stable and complete. No million-element JS sort
      // and no arbitrary body/support path count limit.
      for (let index = 0; index < source.layerSegments.length; index++) {
        const segment = source.layerSegments[index];
        if (selected(source.features[segment])) order[target++] = segment;
      }
    }
    const positions = reorder ? new Float32Array(order.length * 6) : null;
    const widths = reorder ? new Float32Array(order.length) : null;
    const heights = proxy && reorder ? new Float32Array(order.length) : null;
    const features = proxy && reorder ? new Uint8Array(order.length) : null;
    const roughness = proxy ? new Float32Array(order.length) : null;
    const recolor = reorder || this._gcodeColorKey !== colorKey;
    const colors = recolor ? new Float32Array(order.length * 6) : null;
    const palette = new Map(materialColors.map(item => [item.tool, new THREE.Color(item.color)]));
    if (reorder) this._sortedLayers = new Uint32Array(order.length);
    for (let index = 0; index < order.length; index++) {
      const segment = order[index];
      if (reorder) {
        positions.set(source.positions.subarray(segment * 6, segment * 6 + 6), index * 6);
        positions[index * 6 + 2] -= source.heights[segment] / 2;
        positions[index * 6 + 5] -= source.heights[segment] / 2;
        widths[index] = source.widths[segment];
        if (proxy) { heights[index] = source.heights[segment]; features[index] = source.features[segment]; }
        this._sortedLayers[index] = source.layers[segment];
      }
      const color = palette.get(source.tools[segment]);
      if (colors) colors.set([color.r, color.g, color.b, color.r, color.g, color.b], index * 6);
      if (proxy) roughness[index] = roughnessByTool.get(source.tools[segment]);
    }
    let geometry = this._meshes[0].geometry;
    if (proxy && reorder) {
      const lines = new LineSegmentsGeometry().setPositions(positions).setColors(colors);
      lines.setAttribute('instancePrintWidth', new THREE.InstancedBufferAttribute(widths, 1));
      const next = createPrintPathGeometry(lines, { heights, features, roughness });
      next.boundingBox = geometry.boundingBox.clone(); next.boundingSphere = geometry.boundingSphere.clone();
      const previousPreview = this._meshes[0].userData.printPathPreview;
      previousPreview?.exterior.dispose(); previousPreview?.support.dispose();
      delete this._meshes[0].userData.printPathPreview;
      geometry.dispose(); geometry = next; this._meshes[0].geometry = next;
      try {
        const preview = createPrintPathPreviewGeometries(next);
        preview.supportMesh = new THREE.Mesh(preview.support, this._meshes[0].material);
        preview.supportMesh.matrixAutoUpdate = false;
        preview.supportMesh.frustumCulled = false;
        preview.supportMesh.receiveShadow = true;
        preview.supportMesh.renderOrder = this._meshes[0].renderOrder;
        Object.defineProperty(this._meshes[0].userData, 'printPathPreview', { value: preview, writable: true, configurable: true, enumerable: false });
        this._metadata.previewAcceleration = 'compact-exterior-cache';
      } catch (error) {
        // Additional interaction buffers are optional: a low-memory device
        // must retain the complete imported source and the uniform fallback.
        if (!(error instanceof RangeError)) throw error;
        this._metadata.previewAcceleration = 'full-path-fallback';
        this._metadata.warnings ||= [];
        this._metadata.warnings.push('交互缓存内存不足，已保留完整模型并使用常规预览。');
      }
    } else if (proxy) {
      if (colors) {
        const attribute = geometry.getAttribute('instanceColorStart');
        attribute.data.array.set(colors); attribute.data.needsUpdate = true;
      }
      const attribute = geometry.getAttribute('instancePrintRoughness');
      attribute.array.set(roughness); attribute.needsUpdate = true;
      if (this._meshes[0].userData.printPathPreview) refreshPrintPathPreviewAttributes(this._meshes[0].userData.printPathPreview, geometry);
    } else {
      geometry.dispose();
      if (positions) {
        geometry.setPositions(positions);
        geometry.setAttribute('instancePrintWidth', new THREE.InstancedBufferAttribute(widths, 1));
      }
      geometry.setColors(colors);
    }
    if (reorder && this._gcodeShadow) {
      this._gcodeShadow.removeFromParent(); disposeTree(this._gcodeShadow); this._gcodeShadow = null;
    }
    this._gcodeDirection = key; this._gcodeOrder = order; this._gcodeColorKey = colorKey;
    this._gcodeSurfaceKey = surfaceKey;
    if (!proxy) {
      if (!this._gcodeShadow) this._createGCodeShadow();
      if (reorder) this._updateGCodeShadow(order);
    }
    this._metadata.materialColors = materialColors;
    this._metadata.displayedPathSegments = proxy && !includeSupport ? order.length - (source.featureCounts.support || 0) - (source.featureCounts.supportInterface || 0) : order.length;
    this._metadata.hiddenAuxiliarySegments = source.segmentCount - order.length;
    this._metadata.colorConfirmationRequired = materialColors.some(item => item.source === 'fallback' && !item.confirmed);
    const material = this._meshes[0].material;
    material.color.set(this.options.preserveMaterials ? '#ffffff' : this.options.color);
    if (material.vertexColors !== this.options.preserveMaterials) { material.vertexColors = this.options.preserveMaterials; material.needsUpdate = true; }
  }

  _createGCodeShadow() {
    // Shadow passes call onBeforeShadow, while the regular image calls these
    // hooks. Skip all main-image vertices without hiding the shadow caster.
    this._gcodeShadow = pathShadow(this._meshes[0], this._gcodeOrder?.length ?? this._gcode.segmentCount);
  }

  _updateGCodeShadow(order) {
    pathShadowMatrices(this._gcodeShadow, this._gcode.positions, order,
      this._gcode.source === 'sliced-gcode' ? { widths: this._gcode.widths, heights: this._gcode.heights } : null);
  }

  /** Attach complete slicer paths without changing, reducing or rebuilding the
   * imported CAD model. The caller must provide the known coordinate mapping.
   * printerToSource maps printer mm / Z-up into orientation-group coordinates,
   * before normalized/modelGroup transforms. For unchanged 3MF build placement
   * use PRINTER_MM_TO_THREE_MM; slicer relocation needs its explicit inverse. */
  async loadPrintGCode(textOrParsed, options = {}) {
    if (!this.hasModel() || !['mesh', 'gcode'].includes(this._metadata.mode)) throw new Error('请先导入完整模型网格或切片路径，再载入真实模型切片层。');
    if (this._exportState) throw new Error('请等待当前导出完成后更换模型切片。');
    const parsed = typeof textOrParsed === 'string' ? parsePrintLayerGCode(textOrParsed, {
      maxSegments: options.maxSegments ?? 10_000_000,
      includeAuxiliary: options.includeAuxiliary === true,
      includeSupport: options.includeSupport === true,
      defaultWidthMm: options.defaultWidthMm ?? this._metadata.lineWidthMm ?? 0.42,
      defaultHeightMm: options.defaultHeightMm ?? this._metadata.layerHeightMm ?? DEFAULT_LAYER_HEIGHT_MM,
    }) : textOrParsed;
    const prepared = this._preparePrintGCode(parsed, options, this._metadata);
    return this._commitPrintGCode(prepared, options);
  }

  _preparePrintGCode(parsed, options, metadata) {
    const newImport = metadata !== this._metadata;
    const palette = [...(metadata.filamentPalette || [])];
    for (const item of metadata.materialColors || []) if (hexColor(item.color)) palette[item.tool] = item.color;
    for (let tool = 0; tool < (parsed.toolColors?.length || 0); tool++) if (hexColor(parsed.toolColors[tool])) palette[tool] = parsed.toolColors[tool];
    for (const [tool, color] of Object.entries(options.toolColors || {})) if (hexColor(color)) palette[tool] = color;
    let next, nextSupports, settings;
    try {
      next = new PrintLayerRenderer(parsed, {
        printerToSource: options.printerToSource, toolColors: palette,
        historyLayers: options.historyLayers ?? Math.min(3, parsed.layerHeights.length),
        prepareMaterial: material => {
          installPrintReflections(material);
          if (this._environmentTexture) {
            material.envMap = this._environmentTexture;
            material.envMapIntensity = printReflectionIntensity(this.options);
          }
          return this._prepareModelTone(material);
        },
      });
      next.update(this.options.progress, {
        ...this.options, ...(newImport ? { toolColors: {} } : {}), materialProfiles: metadata.materialProfiles,
        includeSupport: this.options.showSupports !== false && (newImport || !this._supportOverlay),
        keepCompleteLayers: metadata.mode === 'gcode',
      });
      if (metadata.mode === 'mesh' && (parsed.featureCounts?.support || parsed.featureCounts?.supportInterface)) {
        nextSupports = this._buildIndexedSupports(parsed, { ...options, toolColors: palette });
      }
      settings = options.sliceSettings || normalizeSliceSettings(parsed.rawConfiguration || {}, { source: 'gcode-config', preset: options.preset || 'h2c' });
    } catch (error) { nextSupports?.dispose(); next?.dispose(); throw error; }
    return { parsed, next, nextSupports, settings };
  }

  _commitPrintGCode({ parsed, next, nextSupports, settings }, options) {
    const previous = this._printLayers;
    this.orientation.add(next.root);
    this._printLayers = next;
    previous?.dispose();
    if (nextSupports) this._commitIndexedSupports(nextSupports, options);
    else if (this._indexedSupports) this._clearIndexedSupports();
    this._metadata.surfaceTopMode = 'sliced-gcode';
    this._metadata.layers = parsed.layerHeights.length;
    this._metadata.sliceSettings = settings;
    this._metadata.layerHeightMm = settings.layerHeightMm;
    this._metadata.firstLayerHeightMm = settings.firstLayerHeightMm;
    this._metadata.lineWidthMm = settings.lineWidthsMm?.outerWall || this._metadata.lineWidthMm;
    this._metadata.surfaceSettingsInferred = {layerHeight:false,lineWidth:parsed.inferredWidthSegments>0};
    this._updateFDMSurfaces();
    this._metadata.printLayer = {
      source: 'sliced-gcode', sourceName: options.sourceName || '真实切片', exactLinearPaths: true,
      sourceTrianglesPreserved: this._metadata.triangles,
      segmentCount: parsed.segmentCount, layers: parsed.layerHeights.length,
      firstHeightMm: parsed.layerHeights[0], lastHeightMm: parsed.layerHeights.at(-1),
      featureCounts: { ...parsed.featureCounts }, rawFeatureCounts: { ...parsed.rawFeatureCounts },
      toolColors: [...next.palette], usedTools: [...(parsed.usedTools || [])],
      printerToSource: [...next.printerToSource.elements], coordinateSource: options.coordinateSource || 'explicit-caller-mapping',
      sampledArcMoves: parsed.sampledArcMoves || 0, arcToleranceMm: parsed.arcToleranceMm,
      unknownExtrusionMoves: parsed.unknownExtrusionMoves || 0,
      inferredWidthSegments: parsed.inferredWidthSegments || 0, inferredHeightSegments: parsed.inferredHeightSegments || 0,
      historyLayers: next.historyLayers, crossSectionApproximate: true,
      warnings: [...(parsed.warnings || [])],
    };
    this._metadata.warnings = [...(this._metadata.warnings || []).filter(warning => !/单色实心|填充面仅为估计/.test(warning)), ...(parsed.warnings || [])];
    this._applyEnvironmentTexture();
    if (!this._modelImportTransaction) this.render(this.options.progress, this._turnRadians);
    return this._metadata.printLayer;
  }

  _buildIndexedSupports(parsed, options) {
    return new IndexedSupportRenderer(parsed, {
      printerToSource: options.printerToSource, toolColors: options.toolColors,
      prepareMaterial: material => {
        material.clippingPlanes = [this.clipPlane]; material.clipShadows = true;
        if (material.isMeshStandardMaterial) {
          installPrintReflections(material);
          if (this._environmentTexture) {
            material.envMap = this._environmentTexture;
            material.envMapIntensity = printReflectionIntensity(this.options);
          }
        }
        return this._prepareModelTone(material);
      },
      createShadow: (line, source, order) => {
        const shadow = pathShadow(line, order.length, [this.clipPlane]);
        shadow.userData.growthTransient = true; shadow.userData.growthPrintLayer = true;
        return shadow;
      },
    });
  }

  _clearIndexedSupports() {
    const previous = this._indexedSupports;
    if (!previous) return;
    this._supportMeshes.delete(previous.root);
    previous.dispose();
    this._baseBounds.copy(previous.originalBounds);
    this._indexedSupports = null;
  }

  _commitIndexedSupports(next, options = {}) {
    const originalBounds = (this._indexedSupports?.originalBounds || this._supportOverlay?.originalBounds || this._baseBounds).clone();
    this._clearIndexedSupports();
    if (this._supportOverlay) {
      const old = this._supportOverlay;
      this._supportMeshes.delete(old.root); old.root.removeFromParent();
      disposeTree(old.root, old.retainedMaterials); this._supportOverlay = null;
    }
    this._baseBounds.copy(originalBounds);
    this._indexedSupports = next;
    next.originalBounds = originalBounds;
    this.orientation.add(next.root);
    this._supportMeshes.add(next.root);
    this._extendSupportBounds();
    this._metadata.supportsAvailable = true;
    this._metadata.supportMeshes = this._supportMeshes.size;
    this._metadata.supportSegments = next.segmentCount;
    this._metadata.supportRawSegments = next.segmentCount;
    this._metadata.supportSource = 'sliced-gcode-indexed';
    this._metadata.supportTolerance = 0;
    this._metadata.supportSurfaceMode = 'closed-stadium-beads-with-elliptical-fallback-and-path-view';
    this._metadata.supportCrossSectionApproximate = true;
    this._metadata.supportCrossSectionToleranceMm = next.crossSectionToleranceMm;
    this._metadata.supportCrossSectionErrorMm = next.maximumCrossSectionErrorMm;
    this._metadata.supportSurfaceTriangles = next.surfaceTriangles;
    this._metadata.supportSourceName = options.sourceName || '完整真实切片';
    this._metadata.supportMaterialColors = [...next.records.keys()].map(tool => ({ tool, color: next.palette[tool], source: 'slice' }));
  }

  /** Complete previously parsed support paths, with explicit coordinates and no
   * simplification/count cap. Prefer loadPrintGCode to attach body+support in one
   * atomic operation; this method also accepts an independent support-only index. */
  async loadIndexedSupportData(parsed, options = {}) {
    if (!this.hasModel() || this._metadata.mode !== 'mesh') throw new Error('请先导入完整模型网格。');
    if (this._exportState) throw new Error('请等待当前导出完成后更换支撑。');
    const palette = [...(this._metadata.filamentPalette || [])];
    for (const item of this._metadata.materialColors || []) palette[item.tool] = item.color;
    for (let tool = 0; tool < (parsed.toolColors?.length || 0); tool++) if (hexColor(parsed.toolColors[tool])) palette[tool] = parsed.toolColors[tool];
    for (const [tool, color] of Object.entries(options.toolColors || {})) if (hexColor(color)) palette[tool] = color;
    const next = this._buildIndexedSupports(parsed, { ...options, toolColors: palette });
    this._commitIndexedSupports(next, options);
    this.render(this.options.progress, this._turnRadians);
    return { source: 'sliced-gcode-indexed', segments: next.segmentCount, crossSectionApproximate: true };
  }

  /** A detached typed packet in explicit source coordinates. sourceToWorld
   * preserves normalization and current XYZ pose for HQ renderer conversion. */
  getPrintLayerPacket(options = {}) {
    if (!this._printLayers) throw new Error('模型没有完整的真实切片数据。');
    const packet = this._printLayers.exportPacket({ ...options, toolColors: { ...this.options.toolColors, ...(options.toolColors || {}) } });
    return { ...packet, sourceToWorld: Float64Array.from(detachedWorldMatrix(this.orientation).elements) };
  }

  /** Source arrays are immutable by contract; consumers may structuredClone or
   * transfer a clone to a worker. Never detach these live rendering buffers. */
  getPrintLayerData() {
    if (!this._printLayers) return null;
    return {
      parsed: this._printLayers.data,
      printerToSource: Float64Array.from(this._printLayers.printerToSource.elements),
      sourceToWorld: Float64Array.from(detachedWorldMatrix(this.orientation).elements),
      toolColors: this._printLayers.palette.map((color, tool) => hexColor(this.options.toolColors?.[tool]) || color), historyLayers: this._printLayers.historyLayers,
      provenance: { ...this._metadata.printLayer },
    };
  }

  setResearchSurfaceVariant(value='auto') {
    if(!this._displaySurfaceController)throw new Error('当前模型没有连续显示表面对照。');
    this._displaySurfaceController.setVariant(value);this._requestRender();
  }

  researchSurfaceStats() {return this._displaySurfaceController?{...this._displaySurfaceController.status}:null;}

  async loadSupportGCode(text, options = {}) {
    if (!this.hasModel() || this._metadata.mode !== 'mesh') throw new Error('请先导入模型网格，再生成或导入支撑路径。');
    if (this._exportState) throw new Error('请等待当前导出完成后添加支撑。');
    const { parseGCode } = await import('./gcode.js');
    // Keep processing all modal moves while storing only support extrusion;
    // millions of body paths must not truncate the upper support geometry.
    const parsed = parseGCode(text, { supportOnly: true, maxSegments: options.maxSegments ?? 2000000 });
    if (parsed.warnings.some(warning => /后续路径未读取/.test(warning))) throw new Error('支撑路径超过完整显示上限，请继续优化可视化路径后再加载；当前模型和支撑保持不变。');
    if (!parsed.supportSegmentCount) throw new Error('切片结果中没有标记为 Support 的实际支撑挤出路径。');
    const positions = new Float32Array(parsed.supportSegmentCount * 6);
    const tools = new Uint16Array(parsed.supportSegmentCount);
    const widths = new Float32Array(parsed.supportSegmentCount);
    const heights = new Float32Array(parsed.supportSegmentCount);
    let target = 0;
    for (let index = 0; index < parsed.segmentCount; index++) {
      if (!parsed.support[index]) continue;
      positions.set(parsed.positions.subarray(index * 6, index * 6 + 6), target * 6);
      tools[target] = parsed.tools[index];
      widths[target] = parsed.widths[index];
      heights[target] = parsed.heights[index];
      target++;
    }
    const geometry = new LineSegmentsGeometry().setPositions(positions);
    const material = new LineMaterial({ color: '#ffffff', linewidth: 0.42 * this.modelWorldScale, worldUnits: true, vertexColors: true, alphaToCoverage: true, clippingPlanes: [this.clipPlane], clipShadows: true });
    const root = new LineSegments2(geometry, material);
    root.name = '切片生成的真实支撑';
    root.userData.isSupport = true;
    root.rotation.x = -Math.PI / 2;
    const shadow = pathShadow(root, parsed.supportSegmentCount, [this.clipPlane]);
    shadow.geometry.dispose();
    shadow.geometry = new THREE.CylinderGeometry(0.21, 0.21, 1, 6, 1, true);
    pathShadowMatrices(shadow, positions, Array.from({ length: parsed.supportSegmentCount }, (_, index) => index), { widths, heights });
    const shadowMaterial = shadow.material;
    const solidMaterial = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.82, metalness: 0, clippingPlanes: [this.clipPlane], clipShadows: true });
    installPrintReflections(solidMaterial);
    this._prepareModelTone(solidMaterial);
    this._prepareModelTone(material);
    shadow.receiveShadow = true;
    const ends = extrusionEnds(positions, tools, widths, heights);
    const caps = new THREE.InstancedMesh(extrusionCapGeometry(), solidMaterial, ends.length);
    caps.name = '支撑真实端点封口';
    caps.castShadow = caps.receiveShadow = true;
    caps.frustumCulled = false;
    let capCount = 0;
    caps.onBeforeRender = () => { if (!caps.userData.solidSupport) { capCount = caps.count; caps.count = 0; } };
    caps.onAfterRender = () => { if (!caps.userData.solidSupport) caps.count = capCount; };
    extrusionCapMatrices(caps, positions, ends, widths, heights);
    root.add(caps);
    shadow.count = parsed.supportSegmentCount;
    if (this._supportOverlay) {
      const old = this._supportOverlay;
      this._supportMeshes.delete(old.root);
      old.root.removeFromParent();
      disposeTree(old.root, old.retainedMaterials);
      this._baseBounds.copy(old.originalBounds);
    }
    const originalBounds = this._baseBounds.clone();
    this.orientation.add(root);
    this.modelGroup.updateMatrixWorld(true);
    const relative = this.modelGroup.matrixWorld.clone().invert().multiply(root.matrixWorld);
    this._baseBounds.union(geometry.boundingBox.clone().applyMatrix4(relative));
    this._supportOverlay = { root, shadow, caps, ends, tools, widths, heights, originalBounds, toolColors: parsed.toolColors, colorKey: null, shadowMaterial, solidMaterial, retainedMaterials: [shadowMaterial, solidMaterial] };
    this._supportMeshes.add(root);
    this._metadata.supportsAvailable = true;
    this._metadata.supportMeshes = this._supportMeshes.size;
    this._metadata.supportSegments = parsed.supportSegmentCount;
    this._metadata.supportSource = 'sliced-gcode';
    this._metadata.supportRawSegments = options.rawSegments ?? parsed.supportSegmentCount;
    this._metadata.supportTolerance = options.tolerance ?? 0;
    this._metadata.supportSurfaceTriangles = parsed.supportSegmentCount * 12 + ends.length * 6;
    this._metadata.warnings = [...(this._metadata.warnings || []).filter(warning => !/未包含生成后的支撑几何/.test(warning)), ...parsed.warnings];
    this._updateSupportColors();
    this._updateSupportDisplay();
    root.visible = this.options.showSupports !== false;
    this.render(this.options.progress, this._turnRadians);
    return { segments: parsed.supportSegmentCount, source: 'sliced-gcode', warnings: parsed.warnings };
  }

  _updateSupportColors() {
    const overlay = this._supportOverlay;
    if (!overlay) return;
    const used = [...new Set(overlay.tools)];
    const sourcePalette = new Map((this._metadata.filamentPalette || []).map((color, tool) => [tool, color]));
    for (const item of this._metadata.materialColors || []) if (!sourcePalette.has(item.tool)) sourcePalette.set(item.tool, item.color);
    const colors = new Map(used.map(tool => [tool, this.options.toolColors?.[tool] || overlay.toolColors[tool] || sourcePalette.get(tool) || '#b7bec8']));
    const key = [...colors].map(([tool, color]) => `${tool}:${color}`).join('|');
    if (overlay.colorKey === key) return;
    const palette = new Map([...colors].map(([tool, color]) => [tool, new THREE.Color(color)]));
    const values = new Float32Array(overlay.tools.length * 3);
    for (let index = 0; index < overlay.tools.length; index++) {
      const color = palette.get(overlay.tools[index]);
      values.set([color.r, color.g, color.b], index * 3);
    }
    if (overlay.shadow.instanceColor?.array.length === values.length) overlay.shadow.instanceColor.array.set(values);
    else overlay.shadow.instanceColor = new THREE.InstancedBufferAttribute(values, 3);
    overlay.shadow.instanceColor.needsUpdate = true;
    const capColors = new Float32Array(overlay.ends.length * 3);
    for (let index = 0; index < overlay.ends.length; index++) {
      const color = palette.get(overlay.tools[overlay.ends[index].segment]);
      capColors.set([color.r, color.g, color.b], index * 3);
    }
    if (overlay.caps.instanceColor?.array.length === capColors.length) overlay.caps.instanceColor.array.set(capColors);
    else overlay.caps.instanceColor = new THREE.InstancedBufferAttribute(capColors, 3);
    overlay.caps.instanceColor.needsUpdate = true;
    overlay.solidMaterial.needsUpdate = true;
    overlay.pathColorsDirty = true;
    this._metadata.supportMaterialColors = [...colors].map(([tool, color]) => ({ tool, color, source: overlay.toolColors[tool] ? 'slice' : sourcePalette.has(tool) ? 'file' : 'fallback' }));
    overlay.colorKey = key;
  }

  _updateSupportDisplay() {
    const overlay = this._supportOverlay;
    if (!overlay) return;
    const solid = this.options.supportDisplay !== 'paths';
    overlay.root.material.visible = !solid;
    overlay.shadow.userData.solidSupport = solid;
    overlay.shadow.material = solid ? overlay.solidMaterial : overlay.shadowMaterial;
    overlay.caps.material = solid ? overlay.solidMaterial : overlay.shadowMaterial;
    overlay.caps.userData.solidSupport = solid;
    if (!solid && overlay.pathColorsDirty) {
      const colors = overlay.shadow.instanceColor.array;
      const values = new Float32Array(overlay.tools.length * 6);
      for (let index = 0; index < overlay.tools.length; index++) {
        const color = colors.subarray(index * 3, index * 3 + 3);
        values.set(color, index * 6); values.set(color, index * 6 + 3);
      }
      overlay.root.geometry.dispose();
      overlay.root.geometry.setColors(values);
      overlay.pathColorsDirty = false;
    }
  }

  setOptions(options = {}) {
    const crop = options.crop !== undefined ? normalizeCrop(options.crop, this._backgroundSize ? this._backgroundSize.width / this._backgroundSize.height : this.camera?.aspect || 1) : this.options.crop;
    if (crop && !this.options.crop) this._cropFullFov = this._fullSourceFov || this.camera?.fov;
    const toolColors = { ...this.options.toolColors, ...(options.toolColors || {}) };
    Object.assign(this.options, options);
    this.options.crop = crop;
    this.options.toolColors = Object.fromEntries(Object.entries(toolColors).filter(([, color]) => hexColor(color)));
    this.options.progress = clamp01(this.options.progress);
    this.options.modelScale = Math.max(0.1, Math.min(5, Number(this.options.modelScale) || 1));
    if (!['auto','pla','matte','silk','petg'].includes(this.options.surfacePreset)) this.options.surfacePreset = 'auto';
    const detail = Number(this.options.surfaceDetail);
    this.options.surfaceDetail = THREE.MathUtils.clamp(Number.isFinite(detail) ? detail : 0.6, 0, 1);
    this.options.dofStrength = THREE.MathUtils.clamp(Number(this.options.dofStrength) || 0, 0, 100);
    this.options.dofFocus = THREE.MathUtils.clamp(Number(this.options.dofFocus) || 0, 0, 100);
    this._applyLighting();
    this._updateFDMSurfaces();
    this.layerUniforms.enabled.value = this.options.layerLines ? 1 : 0;
    this.layerUniforms.count.value = Math.max(1, Number(this.options.layerCount) || 240);
    this.floor.visible = this.options.floor && !this.options.transparent;
    this.grid.visible = this.options.grid && !this.options.transparent;
    for (const mesh of this._supportMeshes || []) mesh.visible = this.options.showSupports !== false;
    const opacity = Number(this.options.shadowOpacity);
    const radius = Number(this.options.shadowRadius);
    this.options.shadowOpacity = THREE.MathUtils.clamp(Number.isFinite(opacity) ? opacity : 0.28, 0, 0.7);
    this.options.shadowRadius = THREE.MathUtils.clamp(Number.isFinite(radius) ? radius : 3, 1, 8);
    this._floorShadowMaterial.opacity = this.options.shadowOpacity;
    // The photographed plane has its own physical soft-shadow kernel. A wide
    // PBR PCF kernel samples sloped receivers as their own occluders; keep
    // model self-shadows local while the plane follows the softness control.
    this.keyLight.shadow.radius = 1;
    this._updateLightPosition();
    const capOverride = this.options.preserveMaterials && hexColor(this.options.toolColors?.[this._capSourceTool]);
    this.cap.material.color.copy(capOverride ? new THREE.Color(capOverride) : this.options.preserveMaterials && this._capSourceColor ? this._capSourceColor : new THREE.Color(this.options.color));
    for (const cap of this._partCaps) {
      const override = this.options.preserveMaterials && hexColor(this.options.toolColors?.[cap.userData.toolIndex]);
      cap.material.color.copy(override ? new THREE.Color(override) : this.options.preserveMaterials ? cap.userData.sourceColor : new THREE.Color(this.options.color));
    }
    for (const [material, source] of this._sourceMaterials) {
      const preserve = this.options.preserveMaterials;
      const override = preserve && hexColor(this.options.toolColors?.[source.toolIndex]);
      if (material.color) material.color.copy(override ? new THREE.Color(override) : preserve && source.color ? source.color : new THREE.Color(this.options.color));
      const vertexColors = preserve ? source.vertexColors : false;
      const map = preserve ? source.map : null;
      if (material.vertexColors !== vertexColors || material.map !== map) {
        material.vertexColors = vertexColors;
        material.map = map;
        material.needsUpdate = true;
      }
    }
    const meshColorKey = Object.entries(this.options.toolColors).sort(([a], [b]) => Number(a) - Number(b)).map(([tool, color]) => `${tool}:${color}`).join('|');
    if (this._meshColorKey !== meshColorKey && this._metadata?.materialColors?.length) {
      const palette = new Map(this._metadata.materialColors.map(item => [item.tool, new THREE.Color(this.options.toolColors[item.tool] || item.color)]));
      for (const mesh of this._meshes) {
        const tools = mesh.geometry.attributes.toolIndex;
        const colors = mesh.geometry.attributes.color;
        if (!tools || !colors) continue;
        for (let index = 0; index < colors.count; index++) {
          const color = palette.get(tools.getX(index));
          if (color) colors.setXYZ(index, color.r, color.g, color.b);
        }
        colors.needsUpdate = true;
      }
      this._meshColorKey = meshColorKey;
    }
    if (this._gcode) {
      this._prepareGCode();
      const material = this._meshes[0].material;
      material.color.set(this.options.preserveMaterials ? '#ffffff' : this.options.color);
      if (material.vertexColors !== this.options.preserveMaterials) { material.vertexColors = this.options.preserveMaterials; material.needsUpdate = true; }
    }
    this._updateSupportColors();
    this._updateSupportDisplay();
    if (this._printLayers) this._printLayers.update(this.options.progress, {
      ...this.options, materialProfiles: this._metadata.materialProfiles,
      includeSupport: this.options.showSupports !== false && !this._supportOverlay,
      keepCompleteLayers: this._metadata.mode === 'gcode',
    });
    this._applyEnvironmentTexture();
    this._applyCameraFraming();
    this._updateBackground();
    this.render(this.options.progress, Number(this.options.turntable || 0) * Math.PI / 180);
  }

  render(progress = this.options.progress, turnRadians = 0) {
    const updating = this._sceneUpdateDepth > 0 && !this._exportState;
    if (!updating) this._spatialPreview?.invalidate();
    this.options.progress = clamp01(progress);
    this._turnRadians = Number(turnRadians) || 0;
    this.modelGroup.scale.setScalar(this.options.modelScale);
    this.modelGroup.position.set((Number(this.options.modelOffsetX) || 0) * MODEL_SIZE / 2, (Number(this.options.modelOffsetY) || 0) * MODEL_SIZE / 2, (Number(this.options.modelOffsetZ) || 0) * MODEL_SIZE / 2);
    this.modelGroup.quaternion.setFromEuler(new THREE.Euler(Number(this.options.modelRotationX) || 0, Number(this.options.modelRotationY) || 0, Number(this.options.modelRotationZ) || 0, 'XYZ'));
    this.modelGroup.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), this._turnRadians));
    this.scene.updateMatrixWorld(true);
    this._updatePrintMatrix();
    if (this.hasModel()) {
      // Transform the full model box once, including the user's XYZ pose and
      // scale. Playback needs no mesh traversal or vertex reskinning per frame.
      this._bounds.copy(this._baseBounds).applyMatrix4(this.modelGroup.matrixWorld);
      this.floor.position.y = this._backgroundTexture && this._photoBedSize ? -0.001 : this._bounds.min.y - 0.015;
      if (this._backgroundTexture && BACKGROUND_PRESETS[this._photoIdentity?.slice(7)]?.kind === 'photography') this._updateFloorFootprint();
      if (this._supportOverlay) this._supportOverlay.root.material.linewidth = 0.42 * this.modelWorldScale;
      const print = this._printLayers?.update(progress, {
        ...this.options, materialProfiles: this._metadata.materialProfiles,
        includeSupport: this.options.showSupports !== false && !this._supportOverlay,
        keepCompleteLayers: this._metadata.mode === 'gcode',
      });
      if (this._indexedSupports) {
        const mapping = this.orientation.matrixWorld.clone().multiply(this._indexedSupports.printerToSource);
        const widthScale = new THREE.Vector3().setFromMatrixColumn(mapping, 0).length();
        const support = this._indexedSupports.update(progress, {
          ...this.options, widthScale, materialProfiles: this._metadata.materialProfiles || [],
          historyLayers: this._printLayers?.data === this._indexedSupports.data ? this._printLayers.historyLayers : 0,
        });
        this._metadata.visibleSupportSegments = support.visibleSegments + (this.options.showSupports !== false && print && !print.complete
          ? (this._printLayers.packet.roleCounts.support || 0) + (this._printLayers.packet.roleCounts.supportInterface || 0) : 0);
      }
      const slice = print || growthSlice(progress, { min: this._bounds.min.y, max: this._bounds.max.y, direction: this.options.direction, layerCount: this._gcode?.layerHeights.length || this.options.layerCount, stepped: this.options.stepped });
      this.modelGroup.visible = !slice.empty;
      const upward = this.options.direction !== 'down';
      if (print) {
        const printToWorld = this.orientation.matrixWorld.clone().multiply(this._printLayers.printerToSource);
        this.clipPlane.set(new THREE.Vector3(0, 0, -1), print.heightMm ?? this._printLayers.data.layerHeights[0]).applyMatrix4(printToWorld);
        if (print.complete) this.clipPlane.constant = 1e20;
        this._metadata.printLayer.currentLayer = print.layerIndex;
        this._metadata.printLayer.currentHeightMm = print.heightMm;
        this._metadata.printLayer.visibleWindowSegments = print.instanceCount;
      } else {
        this.clipPlane.normal.set(0, upward ? -1 : 1, 0);
        this.clipPlane.constant = upward ? slice.height : -slice.height;
        if (slice.complete) this.clipPlane.constant += 0.02;
      }
      this.layerUniforms.min.value = this._bounds.min.y;
      this.layerUniforms.max.value = this._bounds.max.y;
      this.cap.position.set(this._bounds.getCenter(new THREE.Vector3()).x, slice.height ?? this._bounds.min.y, this._bounds.getCenter(new THREE.Vector3()).z);
      // Synthetic solid cross-section caps cannot represent wall loops, infill
      // density/pattern or tool assignments. Keep cuts open until real slice
      // data is available, then show only its actual extruded strips.
      const capVisible = false;
      this.cap.visible = capVisible && this._partCaps.length === 0;
      for (const cap of this._partCaps) { cap.position.copy(this.cap.position); cap.visible = capVisible && cap._growthSource.visible; }
      for (const stencil of this._stencils) stencil.visible = capVisible && stencil._growthSource.visible;
      if (this._gcode) {
        const visibleLayers = print ? Math.max(0, print.visibleLayerCount - this._printLayers.historyLayers)
          : slice.complete ? this._gcode.layerHeights.length : Math.floor(clamp01(progress) * this._gcode.layerHeights.length + 1e-10);
        this._meshes[0].geometry.instanceCount = visibleSegmentCount(this._sortedLayers, visibleLayers, this._gcode.layerHeights.length,
          this._gcode.source === 'sliced-gcode' ? 'up' : this.options.direction);
        if (this._gcodeShadow) this._gcodeShadow.count = this._meshes[0].geometry.instanceCount;
        if (!this._meshes[0].userData.printPathImpostor) this._meshes[0].material.linewidth = this._gcode.source === 'sliced-gcode'
          ? this.modelMillimetresToWorld : 0.42 * this.normalized.scale.x * this.options.modelScale;
        this.modelGroup.visible = this._meshes[0].geometry.instanceCount > 0 || this._printLayers?.root.visible;
      }
      this.keyLight.shadow.normalBias = contactShadowNormalBias(this.modelMillimetresToWorld);
      this._updateLightPosition();
      this._updateShadowHelper();
    }
    if (updating) {
      this._renderPending = true;
    } else {
      this._drawScene();
      this._renderPending = false;
      this._spatialPreview?.schedule();
    }
  }

  rotateModel(axis) {
    if (!this.orientation || !['x', 'y', 'z'].includes(axis)) return;
    this.orientation.rotateOnWorldAxis(new THREE.Vector3(axis === 'x' ? 1 : 0, axis === 'y' ? 1 : 0, axis === 'z' ? 1 : 0), Math.PI / 2);
    this._normalize();
    this._extendSupportBounds();
    this.setOptions(this.options);
    this.resetCamera();
  }

  resetModelTransform() {
    if (!this.orientation) return;
    this.orientation.quaternion.identity();
    Object.assign(this.options, { modelOffsetX: 0, modelOffsetY: 0, modelOffsetZ: 0, modelRotationX: 0, modelRotationY: 0, modelRotationZ: 0, modelScale: 1 });
    this._normalize();
    this._extendSupportBounds();
    this.setOptions(this.options);
    this.onTransformChange?.({ ...this.options, toolColors: { ...this.options.toolColors } });
  }

  _extendSupportBounds() {
    if (this._indexedSupports) {
      this._indexedSupports.originalBounds = this._baseBounds.clone();
      const mapping = detachedWorldMatrix(this.modelGroup).invert().multiply(detachedWorldMatrix(this._indexedSupports.root));
      this._baseBounds.union(this._indexedSupports.bounds.clone().applyMatrix4(mapping));
      return;
    }
    if (!this._supportOverlay) return;
    this._supportOverlay.originalBounds = this._baseBounds.clone();
    this.modelGroup.updateMatrixWorld(true);
    const relative = this.modelGroup.matrixWorld.clone().invert().multiply(this._supportOverlay.root.matrixWorld);
    this._baseBounds.union(this._supportOverlay.root.geometry.boundingBox.clone().applyMatrix4(relative));
  }

  _updateLightPosition() {
    const center = this.hasModel() && this._bounds && !this._bounds.isEmpty() ? this._bounds.getCenter(new THREE.Vector3()) : new THREE.Vector3();
    const azimuth = Number(this.options.lightAzimuth);
    const elevation = Number(this.options.lightElevation);
    if (Number.isFinite(azimuth) && Number.isFinite(elevation)) {
      this.options.lightAzimuth = THREE.MathUtils.clamp(azimuth, -180, 180);
      this.options.lightElevation = THREE.MathUtils.clamp(elevation, 10, 85);
      const angle = THREE.MathUtils.degToRad(this.options.lightAzimuth);
      const height = THREE.MathUtils.degToRad(this.options.lightElevation);
      this.keyLight.position.set(Math.sin(angle) * Math.cos(height) * 12, Math.sin(height) * 12, Math.cos(angle) * Math.cos(height) * 12).add(center);
      this.keyLight.target.position.copy(center);
    } else {
      const positions = { left: [-9, 16, 10], right: [9, 16, 10], front: [0, 16, 14] };
      this.keyLight.position.fromArray(positions[this.options.lightDirection] || positions.left);
      this.keyLight.target.position.set(0, 0, 0);
    }
    this.keyLight.updateMatrixWorld(true);
    this.keyLight.target.updateMatrixWorld(true);
  }

  _createShadowHelper() {
    this.shadowHelper = new THREE.Group();
    this.shadowHelper.name = '地面阴影方向控制';
    this.shadowHelper.renderOrder = 10000;
    this.shadowHelper.visible = false;
    const points = Array.from({ length: 96 }, (_, index) => new THREE.Vector3(Math.sin(index / 96 * Math.PI * 2), 0, Math.cos(index / 96 * Math.PI * 2)));
    this._shadowRing = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(points), new THREE.LineBasicMaterial({ color: '#3688ff', transparent: true, opacity: 0.7, depthTest: false, depthWrite: false }));
    this._shadowArrow = new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), new THREE.Vector3(), 2, '#3688ff', 0.28, 0.15);
    for (const node of [this._shadowArrow.line, this._shadowArrow.cone]) { node.material.depthTest = false; node.material.depthWrite = false; }
    this._shadowHandle = new THREE.Mesh(new THREE.SphereGeometry(0.12, 16, 8), new THREE.MeshBasicMaterial({ color: '#ffffff', depthTest: false, depthWrite: false }));
    this._shadowHandle.renderOrder = 10001;
    this.shadowHelper.add(this._shadowRing, this._shadowArrow, this._shadowHandle);
    this.scene.add(this.shadowHelper);
    this._shadowPointerHandlers = {
      pointerdown: event => {
        if (!this._shadowEditMode || this._exportState || event.button !== 0) return;
        const point = this._shadowGroundPoint(event);
        if (!point) return;
        event.preventDefault(); event.stopImmediatePropagation();
        this._shadowDrag = { pointerId: event.pointerId, controlsEnabled: this.controls.enabled };
        this.controls.enabled = false;
        this.canvas.setPointerCapture(event.pointerId);
        this._applyShadowPoint(point);
      },
      pointermove: event => {
        if (!this._shadowDrag || event.pointerId !== this._shadowDrag.pointerId) return;
        event.preventDefault(); event.stopImmediatePropagation();
        const point = this._shadowGroundPoint(event);
        if (point) this._applyShadowPoint(point);
      },
      pointerup: event => this._endShadowDrag(event),
      pointercancel: event => this._endShadowDrag(event),
      lostpointercapture: event => this._endShadowDrag(event),
    };
    for (const [name, handler] of Object.entries(this._shadowPointerHandlers)) this.canvas.addEventListener(name, handler, true);
  }

  setShadowEditMode(enabled) {
    enabled = Boolean(enabled) && this.hasModel() && !this._exportState;
    if (enabled === this._shadowEditMode) return;
    this._endShadowDrag();
    this._shadowEditMode = enabled;
    this.shadowHelper.visible = enabled;
    if (enabled) {
      this._shadowTransformState = { enabled: this.transform.enabled, visible: this.transformHelper.visible };
      this.transform.enabled = false; this.transformHelper.visible = false;
    } else if (this._shadowTransformState) {
      this.transform.enabled = this._shadowTransformState.enabled;
      this.transformHelper.visible = this._shadowTransformState.visible;
      this._shadowTransformState = null;
    }
    this._updateShadowHelper();
    this.render(this.options.progress, this._turnRadians);
  }

  _shadowGroundPoint(event) {
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    this.camera.updateMatrixWorld(true);
    this._shadowRaycaster.setFromCamera(new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, 1 - (event.clientY - rect.top) / rect.height * 2), this.camera);
    this._shadowPlane.constant = -this.floor.position.y;
    return this._shadowRaycaster.ray.intersectPlane(this._shadowPlane, new THREE.Vector3());
  }

  _applyShadowPoint(point) {
    const center = this._bounds.getCenter(new THREE.Vector3());
    const dx = point.x - center.x, dz = point.z - center.z;
    const distance = Math.hypot(dx, dz);
    if (distance < 0.02) return;
    this.options.lightAzimuth = THREE.MathUtils.radToDeg(Math.atan2(-dx, -dz));
    this.options.lightElevation = THREE.MathUtils.clamp(THREE.MathUtils.radToDeg(Math.atan2(Math.max(0.1, this._bounds.max.y - this._bounds.min.y), distance)), 10, 85);
    this._updateLightPosition();
    this._updateShadowHelper();
    const values = { lightAzimuth: this.options.lightAzimuth, lightElevation: this.options.lightElevation };
    if (this.onShadowChange) this.onShadowChange(values);
    else this.render(this.options.progress, this._turnRadians);
  }

  _endShadowDrag(event) {
    if (!this._shadowDrag || event && event.pointerId !== this._shadowDrag.pointerId) return;
    const drag = this._shadowDrag;
    this._shadowDrag = null;
    this.controls.enabled = drag.controlsEnabled && !this._exportState;
    if (this.canvas.hasPointerCapture?.(drag.pointerId)) this.canvas.releasePointerCapture(drag.pointerId);
    if (event) { event.preventDefault(); event.stopImmediatePropagation(); }
  }

  _updateShadowHelper() {
    if (!this.shadowHelper || !this.hasModel() || !this._bounds || this._bounds.isEmpty()) return;
    const center = this._bounds.getCenter(new THREE.Vector3());
    const size = this._bounds.getSize(new THREE.Vector3());
    const ground = new THREE.Vector3(center.x, this.floor.position.y + 0.005, center.z);
    const source = this.keyLight.position.clone().sub(this.keyLight.target.position);
    const horizontal = Math.max(0.001, Math.hypot(source.x, source.z));
    const length = Math.max(0.25, Math.max(0.1, size.y) * horizontal / Math.max(0.001, source.y));
    const direction = new THREE.Vector3(-source.x / horizontal, 0, -source.z / horizontal);
    this._shadowRing.position.copy(ground);
    this._shadowRing.scale.setScalar(Math.max(1, Math.max(size.x, size.z) * 0.7));
    this._shadowArrow.position.copy(ground);
    this._shadowArrow.setDirection(direction);
    this._shadowArrow.setLength(length, 0.28, 0.15);
    this._shadowHandle.position.copy(ground).addScaledVector(direction, length);
  }

  _fitCamera(direction) {
    this.modelGroup.updateMatrixWorld(true);
    const bounds = this._baseBounds
      ? this._baseBounds.clone().applyMatrix4(this.modelGroup.matrixWorld)
      : new THREE.Box3(new THREE.Vector3(-4, 0, -4), new THREE.Vector3(4, 8, 4));
    const center = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3());
    const radius = size.length() / 2;
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    const horizontalFov = 2 * Math.atan(Math.tan(fov / 2) * this.camera.aspect);
    const distance = radius / Math.sin(Math.min(fov, horizontalFov) / 2) * 1.14;
    this.camera.position.copy(center).add(direction.normalize().multiplyScalar(distance));
    this.controls.target.copy(center);
    this.camera.near = Math.max(0.02, distance / 1000);
    this.camera.far = Math.max(200, distance * 20);
    this.camera.updateProjectionMatrix();
    this.camera.lookAt(center);
    this.controls.maxDistance = Math.max(150, distance * 5);
    this.controls.update();
  }

  resetCamera() { this._setPhotoFovFromVisible(this.camera.fov); this.camera.up.set(0, 1, 0); this._fitCamera(new THREE.Vector3(1, 0.7, 1)); }

  setView(view) {
    this.camera.up.set(0, 1, 0);
    const directions = { perspective: new THREE.Vector3(1, 0.7, 1), front: new THREE.Vector3(0, 0.08, 1), side: new THREE.Vector3(1, 0.08, 0), top: new THREE.Vector3(0, 1, 0.001) };
    if (view === 'top') this.camera.up.set(0, 0, -1);
    this._fitCamera(directions[view] || directions.perspective);
    this.render(this.options.progress, Number(this.options.turntable || 0) * Math.PI / 180);
  }

  getCameraOptions() {
    const offset = this.camera.position.clone().sub(this.controls.target);
    const distance = Math.max(0.0001, offset.length());
    const forward = offset.clone().negate().normalize();
    const naturalUp = new THREE.Vector3(0, 1, 0).addScaledVector(forward, -forward.y).normalize();
    const actualUp = new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion).normalize();
    const roll = naturalUp.lengthSq() > 0.5 ? Math.atan2(forward.dot(naturalUp.clone().cross(actualUp)), naturalUp.dot(actualUp)) : 0;
    return {
      fov: this.camera.fov,
      pitch: THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(offset.y / distance, -1, 1))),
      yaw: THREE.MathUtils.radToDeg(Math.atan2(offset.x, offset.z)),
      roll: THREE.MathUtils.radToDeg(roll),
    };
  }

  getLensOptions() {
    return { focalLength: fovToFocalLength(this._cameraSourceFov()) };
  }

  _cameraSourceFov(fallback = this.camera.fov) {
    // Removing a covered photo leaves the current visible camera projection in
    // place. With no photo/crop source frame, an old crop FOV is no longer its
    // physical lens reference (also important for silhouette/height analysis).
    return this._backgroundSize || this.options.crop ? this._fullSourceFov || this._cropFullFov || fallback : fallback;
  }

  setLensOptions({ focalLength } = {}) {
    const current = this.getLensOptions().focalLength;
    const number = Number(focalLength ?? current);
    const next = THREE.MathUtils.clamp(Number.isFinite(number) ? number : current, MIN_FOCAL_LENGTH_MM, MAX_FOCAL_LENGTH_MM);
    let bounds = null;
    if (this.hasModel()) {
      if (this._baseBounds) {
        this.modelGroup.updateWorldMatrix(true, false);
        bounds = this._baseBounds.clone().applyMatrix4(this.modelGroup.matrixWorld);
      } else if (this._bounds) bounds = this._bounds.clone();
    }
    if (bounds && !bounds.isEmpty()) {
      const slice = growthSlice(this.options.progress, {
        min: bounds.min.y, max: bounds.max.y, direction: this.options.direction,
        layerCount: this._gcode?.layerHeights.length || this.options.layerCount, stepped: this.options.stepped,
      });
      if (!slice.empty) {
        if (this.options.direction === 'down') bounds.min.y = slice.height;
        else bounds.max.y = slice.height;
      }
    }
    const anchor = bounds && !bounds.isEmpty() ? bounds.getCenter(new THREE.Vector3()) : this.controls.target.clone();
    const pose = compensateLensChange({
      position: this.camera.position.toArray(), target: this.controls.target.toArray(), anchor: anchor.toArray(),
      oldFocalLength: current, newFocalLength: next,
    });
    const fov = focalLengthToFov(next);
    this._fullSourceFov = fov;
    this._cropFullFov = fov;
    this._applyCameraFraming(this._viewportAspect || this.camera.aspect);
    this._applyCameraPose(new THREE.Vector3(...pose.position), new THREE.Vector3(...pose.target), this.camera.up.clone(), this._backgroundSize || this.options.crop ? this.camera.fov : fov);
    return this.getLensOptions();
  }

  _applyCameraPose(position, target, up, fov) {
    // Flush any queued OrbitControls drag damping before assigning a calibrated
    // pose, otherwise the next frame would nudge it away from the photo.
    const damping = this.controls.enableDamping;
    this.controls.enableDamping = false;
    this.controls.update();
    this.controls.target.copy(target);
    this.camera.position.copy(position);
    this.camera.up.copy(up).normalize();
    this.camera.fov = fov;
    const distance = position.distanceTo(target);
    this.camera.near = Math.max(0.001, distance / 1000);
    this.camera.far = Math.max(200, distance * 20);
    this.controls.maxDistance = Math.max(150, distance * 5);
    this.controls.minDistance = Math.min(0.5, distance * 0.1);
    this.camera.updateProjectionMatrix();
    this.camera.lookAt(target);
    this.controls.update();
    this.controls.enableDamping = damping;
    this.render(this.options.progress, this._turnRadians);
  }

  _photoCropFactor(aspect = this.camera.aspect) {
    return this._backgroundSize ? Math.min(1, this._backgroundSize.width / this._backgroundSize.height / aspect) : 1;
  }

  _visiblePhotoFov(aspect = this.camera.aspect) {
    if (this.options.crop) return this._fullSourceFov || this._cropFullFov || this.camera.fov;
    if (!this._backgroundSize || !this._fullSourceFov) return this.camera.fov;
    return THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(this._fullSourceFov) / 2) * this._photoCropFactor(aspect)));
  }

  _setPhotoFovFromVisible(fov, aspect = this.camera.aspect) {
    if (this.options.crop) {
      this._cropFullFov = fov;
      if (this._backgroundSize) this._fullSourceFov = fov;
      return;
    }
    if (!this._backgroundSize) { this._fullSourceFov = fov; this._cropFullFov = null; return; }
    this._fullSourceFov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(fov) / 2) / this._photoCropFactor(aspect)));
  }

  _applyCameraFraming(aspect = this._viewportAspect || this.camera?.aspect) {
    if (!this.camera) return;
    const crop = this.options.crop;
    if (crop) {
      this.camera.fov = this._fullSourceFov || this._cropFullFov || this.camera.fov;
      this.camera.setViewOffset(crop.sourceAspect, 1, crop.x * crop.sourceAspect, crop.y, crop.width * crop.sourceAspect, crop.height);
    } else {
      this.camera.clearViewOffset();
      this.camera.aspect = aspect;
      this.camera.fov = this._visiblePhotoFov(aspect);
      this.camera.updateProjectionMatrix();
    }
  }

  setCameraOptions(values = {}) {
    const current = this.getCameraOptions();
    const value = (key, low, high) => {
      const number = Number(values[key] ?? current[key]);
      return THREE.MathUtils.clamp(Number.isFinite(number) ? number : current[key], low, high);
    };
    // Lens controls can produce a valid source FOV outside the former manual
    // FOV slider range. Editing pose alone must not alter that focal length.
    const fov = values.fov === undefined ? current.fov : value('fov', 15, 90);
    const pitch = THREE.MathUtils.degToRad(value('pitch', 5, 85));
    const yaw = THREE.MathUtils.degToRad(value('yaw', -180, 180));
    const roll = THREE.MathUtils.degToRad(value('roll', -45, 45));
    const target = this.controls.target.clone();
    const distance = Math.max(0.01, this.camera.position.distanceTo(target));
    const offset = new THREE.Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)).multiplyScalar(distance);
    const forward = offset.clone().negate().normalize();
    const up = new THREE.Vector3(0, 1, 0).addScaledVector(forward, -forward.y).normalize().applyAxisAngle(forward, roll);
    this._setPhotoFovFromVisible(fov);
    this._applyCameraPose(target.clone().add(offset), target, up, fov);
    return this.getCameraOptions();
  }

  getCalibrationBedSize() {
    return this._photoBedSize ? { ...this._photoBedSize } : null;
  }

  restoreCalibrationBedSize(size) {
    if (size !== null && (!Number.isFinite(size?.width) || size.width <= 0 || !Number.isFinite(size?.depth) || size.depth <= 0)) throw new Error('底板尺寸恢复数据无效。');
    this._photoBedSize = size ? { width: size.width, depth: size.depth } : null;
    this._updateFloorFootprint();
    this._requestRender();
  }

  applyCalibration(result) {
    const vector = value => {
      const components = Array.isArray(value) || ArrayBuffer.isView(value) ? [value[0], value[1], value[2]] : [value?.x, value?.y, value?.z];
      return new THREE.Vector3(...components.map(component => typeof component === 'number' ? component : NaN));
    };
    const position = vector(result?.position);
    const target = vector(result?.target);
    const up = vector(result?.up);
    const fov = Number(result?.fov);
    if (![...position.toArray(), ...target.toArray(), ...up.toArray(), fov].every(Number.isFinite) || up.lengthSq() < 1e-8 || position.distanceToSquared(target) < 1e-8 || fov < 3 || fov > 145) throw new Error('透视校准结果无效，请重新标出平台四角。');
    if (Number.isFinite(result.bedWidth) && result.bedWidth > 0 && Number.isFinite(result.bedDepth) && result.bedDepth > 0) {
      this._photoBedSize = { width: result.bedWidth, depth: result.bedDepth };
      this._updateFloorFootprint();
    }
    const aspect = result.imageSize?.width && result.imageSize?.height ? result.imageSize.width / result.imageSize.height : this.camera.aspect;
    this._setPhotoFovFromVisible(fov, aspect);
    this._applyCameraPose(position, target, up, this._backgroundSize ? this._visiblePhotoFov() : fov);
    return this.getCameraOptions();
  }

  applyPhotographyPlacement(profile) {
    if (!this.hasModel() || !profile || !Number.isFinite(profile.yawDeg)) return null;
    const bounds = photographicModelBounds(this._meshes, this.modelGroup, profile.yawDeg, this._supportMeshes);
    if (!bounds) return null;
    // The app has already laid out the new photo frame, but ResizeObserver may
    // still hold the preceding preset's aspect. Fit the next visible projection
    // synchronously so a landscape-to-portrait switch cannot move the footpoint.
    const width = this.host?.clientWidth, height = this.host?.clientHeight;
    const camera = width > 0 && height > 0
      ? this._framedCameraClone(width / height) : this.camera.clone();
    camera.updateMatrixWorld(true);
    const pose = fitPhotographicModelPose({bounds, camera, profile:{...profile, yawDeg:0}, offsetUnit:MODEL_SIZE / 2});
    if (!pose) return null;
    pose.modelRotationY = THREE.MathUtils.degToRad(profile.yawDeg);
    this.setOptions(pose);
    return pose;
  }

  applyPrinterPlacement(profile) {
    if(!this.hasModel()||!profile||!this._photoBedSize)return null;
    const width=this.host?.clientWidth,height=this.host?.clientHeight;
    // Printed marks are defined in the complete source photograph. A rounded
    // preview size must not move their ground anchor or change the facing.
    const aspect=this._backgroundSize?.width/this._backgroundSize?.height;
    const camera=Number.isFinite(aspect)&&aspect>0?this._framedCameraClone(aspect):width>0&&height>0?this._framedCameraClone(width/height):this.camera.clone();
    camera.updateMatrixWorld(true);
    const target=printerPatternGroundPoint(camera,profile);
    if(!target)return null;
    const yawDeg=printerModelYaw(camera,profile.relativeYawDeg,target);
    if(yawDeg===null)return null;
    const geometry=photographicModelGeometry(this._meshes,this.modelGroup,yawDeg,this._supportMeshes);
    if(!geometry)return null;
    const pose=fitPrinterModelPose({...geometry,footprintBounds:geometry.contactBounds,camera,bedSize:this._photoBedSize,profile,offsetUnit:MODEL_SIZE/2});
    if(!pose)return null;
    pose.modelRotationY=THREE.MathUtils.degToRad(yawDeg);
    this.setOptions(pose);return pose;
  }

  settleModelOnPhotoFloor() {
    if (!this.hasModel() || !this._backgroundTexture || !this._photoBedSize) return null;
    const rotation = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(
      Number(this.options.modelRotationX) || 0, Number(this.options.modelRotationY) || 0,
      Number(this.options.modelRotationZ) || 0, 'XYZ'));
    const bounds = photographicModelBounds(this._meshes, this.modelGroup, 0, this._supportMeshes, rotation);
    if (!bounds) return null;
    // Keep the chosen size, facing and XZ position. Evaluate the actual full
    // model soles, including tilted source geometry, rather than empty AABB
    // corners or the current growth cut. Y=0 is the calibrated physical plane.
    const pose = {modelOffsetY:-bounds.min.y * this.options.modelScale / (MODEL_SIZE / 2)};
    this.setOptions(pose);
    return pose;
  }

  _renderModelData(width, height, { supports = false, pose = null, crop = null, frame = 'source' } = {}, heights = false) {
    if (!this.hasModel()) throw new Error('请先导入模型。');
    width = Math.round(width); height = Math.round(height);
    if (![width, height].every(value => Number.isFinite(value) && value >= 8 && value <= 4096)) throw new Error('分析图像尺寸需在 8 至 4096 像素之间。');
    const renderer = this.renderer;
    const state = {
      target: renderer.getRenderTarget(), clear: renderer.getClearColor(new THREE.Color()), alpha: renderer.getClearAlpha(),
      autoClear: renderer.autoClear, shadowEnabled: renderer.shadowMap.enabled,
      background: this.scene.background, overrideMaterial: this.scene.overrideMaterial,
      aspect: this.camera.aspect, fov: this.camera.fov, view: this.camera.view && { ...this.camera.view }, position: this.modelGroup.position.clone(), quaternion: this.modelGroup.quaternion.clone(), scale: this.modelGroup.scale.clone(),
      viewport: renderer.getViewport(new THREE.Vector4()), scissor: renderer.getScissor(new THREE.Vector4()), scissorTest: renderer.getScissorTest(),
    };
    const visibility = new Map();
    const materialVisibility = new Map();
    const instances = new Map();
    const pathMaterials = new Map();
    const hide = object => { if (object) { visibility.set(object, object.visible); object.visible = false; } };
    try {
    for (const object of [this.floor, this.grid, this.cap, this._printLayers?.root, this.transformHelper, this.shadowHelper, ...(this._partCaps || []), ...this._stencils]) hide(object);
    for (const object of this._supportMeshes || []) {
      visibility.set(object, object.visible);
      object.visible = supports;
    }
    visibility.set(this.modelGroup, this.modelGroup.visible);
    this.modelGroup.visible = true;
    if (pose) {
      const values = { ...this.options, ...pose };
      this.modelGroup.position.set((Number(values.modelOffsetX) || 0) * MODEL_SIZE / 2, (Number(values.modelOffsetY) || 0) * MODEL_SIZE / 2, (Number(values.modelOffsetZ) || 0) * MODEL_SIZE / 2);
      this.modelGroup.scale.setScalar(Math.max(0.1, Math.min(5, Number(values.modelScale) || 1)));
      this.modelGroup.quaternion.setFromEuler(new THREE.Euler(Number(values.modelRotationX) || 0, Number(values.modelRotationY) || 0, Number(values.modelRotationZ) || 0));
      this.modelGroup.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), this._turnRadians));
    }
    this.scene.updateMatrixWorld(true);
    // Normalize heights in the same range as production clipping. Excluding
    // support pixels must not change the physical plane revealed at progress p.
    const bounds = this._baseBounds.clone().applyMatrix4(this.modelGroup.matrixWorld);
    const low = bounds.min.y, span = Math.max(0.0001, bounds.max.y - bounds.min.y);
    this._analysisMaterials ||= {};
    const pathAnalysis = this._meshes.some(mesh => mesh.userData.printPathImpostor);
    const key = (pathAnalysis ? 'path-' : '') + (heights ? 'height' : 'silhouette');
    let material = this._analysisMaterials[key];
    if (!material) {
      material = pathAnalysis ? createPrintPathAnalysisMaterial({ heights }) : installStadiumExtrusion(new THREE.MeshBasicMaterial({ color: '#ffffff', toneMapped: false, fog: false, side: THREE.DoubleSide }));
      this._analysisMaterials[key] = material;
    }
    if (heights && !pathAnalysis && !this._heightUniforms) {
      this._heightUniforms = { maskMinY: { value: low }, maskHeight: { value: span } };
      const previousCompile = material.onBeforeCompile, previousKey = material.customProgramCacheKey.bind(material);
      material.onBeforeCompile = (shader, renderer) => {
        previousCompile.call(material, shader, renderer);
        Object.assign(shader.uniforms, this._heightUniforms);
        shader.vertexShader = 'varying float maskWorldY;\n' + shader.vertexShader;
        shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', `#include <project_vertex>
vec4 maskPosition = vec4(transformed, 1.0);
#ifdef USE_BATCHING
maskPosition = batchingMatrix * maskPosition;
#endif
#ifdef USE_INSTANCING
maskPosition = instanceMatrix * maskPosition;
#endif
maskWorldY = (modelMatrix * maskPosition).y;`);
        shader.fragmentShader = 'varying float maskWorldY;\nuniform float maskMinY;\nuniform float maskHeight;\n' + shader.fragmentShader;
        shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', `float packedHeight = floor(clamp((maskWorldY - maskMinY) / maskHeight, 0.0, 1.0) * 65535.0 + 0.5);
gl_FragColor = vec4(floor(packedHeight / 256.0) / 255.0, mod(packedHeight, 256.0) / 255.0, 0.0, 1.0);`);
      };
      material.customProgramCacheKey = () => previousKey() + '|growth-model-height-rg16-v1';
    }
    if (heights) {
      if (pathAnalysis) updatePrintPathAnalysisRange(material, { minY: low, span });
      else { this._heightUniforms.maskMinY.value = low; this._heightUniforms.maskHeight.value = span; }
    }
    if (pathAnalysis) setPrintPathSupportVisibility(material, supports);
    this.modelGroup.traverse(node => {
      if (node.userData.printPathImpostor) {
        pathMaterials.set(node, { material: node.material, count: node.geometry.instanceCount });
        node.material = material;
        node.geometry.instanceCount = node.geometry.getAttribute('instanceStart').count;
      }
      if (node.isLineSegments2) { materialVisibility.set(node.material, node.material.visible); node.material.visible = false; }
      if (!node.isInstancedMesh) return;
      instances.set(node, { color: node.instanceColor, count: node.count, solid: node.userData.solidSupport });
      node.instanceColor = null;
      node.userData.solidSupport = true;
      if (node === this._gcodeShadow) node.count = this._gcode.segmentCount;
    });
    this._analysisTargets ||= new Map();
    const targetKey = `${width}:${height}`;
    let target = this._analysisTargets.get(targetKey);
    if (!target) {
      target = new THREE.WebGLRenderTarget(width, height, { depthBuffer: true, stencilBuffer: false });
      target.texture.colorSpace = THREE.NoColorSpace;
      this._analysisTargets.set(targetKey, target);
      if (this._analysisTargets.size > 3) { const first = this._analysisTargets.keys().next().value; this._analysisTargets.get(first).dispose(); this._analysisTargets.delete(first); }
    }
    const rgba = new Uint8Array(width * height * 4);
      this.scene.background = null;
      this.scene.overrideMaterial = pathAnalysis ? null : material;
      renderer.shadowMap.enabled = false;
      renderer.autoClear = true;
      this.camera.clearViewOffset();
      const sourceAspect = this._backgroundSize ? this._backgroundSize.width / this._backgroundSize.height : this.options.crop?.sourceAspect || width / height;
      this.camera.aspect = frame === 'output' ? width / height : sourceAspect;
      const fullFov = this._cameraSourceFov(state.fov);
      const cropFactor = frame === 'output' && this._backgroundSize ? Math.min(1, sourceAspect / (width / height)) : 1;
      this.camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(fullFov) / 2) * cropFactor));
      if (crop) {
        const rectangle = normalizeCrop(crop, sourceAspect);
        this.camera.fov = fullFov;
        this.camera.setViewOffset(rectangle.sourceAspect, 1, rectangle.x * rectangle.sourceAspect, rectangle.y, rectangle.width * rectangle.sourceAspect, rectangle.height);
      }
      this.camera.updateProjectionMatrix();
      renderer.setRenderTarget(target);
      renderer.setScissorTest(false);
      renderer.setClearColor(0x000000, 0);
      renderer.render(this.scene, this.camera);
      renderer.readRenderTargetPixels(target, 0, 0, width, height, rgba);
      const mask = new Uint8Array(width * height);
      const values = heights ? new Uint16Array(width * height) : mask;
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const from = ((height - y - 1) * width + x) * 4;
        const to = y * width + x;
        mask[to] = rgba[from + 3] >= 128 ? 255 : 0;
        if (heights) values[to] = rgba[from] * 256 + rgba[from + 1];
      }
      return { data: values, mask, width, height, w: width, h: height, minY: low, maxY: low + span, modelHeight: span };
    } finally {
      this.scene.background = state.background;
      this.scene.overrideMaterial = state.overrideMaterial;
      renderer.shadowMap.enabled = state.shadowEnabled;
      renderer.autoClear = state.autoClear;
      this.camera.aspect = state.aspect;
      this.camera.fov = state.fov;
      this.camera.view = state.view;
      this.camera.updateProjectionMatrix();
      this.modelGroup.position.copy(state.position);
      this.modelGroup.quaternion.copy(state.quaternion);
      this.modelGroup.scale.copy(state.scale);
      for (const [object, visible] of visibility) object.visible = visible;
      for (const [item, visible] of materialVisibility) item.visible = visible;
      for (const [object, previous] of instances) { object.instanceColor = previous.color; object.count = previous.count; object.userData.solidSupport = previous.solid; }
      for (const [object, previous] of pathMaterials) { object.material = previous.material; object.geometry.instanceCount = previous.count; }
      this.scene.updateMatrixWorld(true);
      renderer.setRenderTarget(state.target);
      renderer.setViewport(state.viewport);
      renderer.setScissor(state.scissor);
      renderer.setScissorTest(state.scissorTest);
      renderer.setClearColor(state.clear, state.alpha);
    }
  }

  renderSilhouette(width = 192, height = 192, options = {}) {
    return this._renderModelData(width, height, options, false);
  }

  renderHeightMap(width = 192, height = 192, options = {}) {
    return this._renderModelData(width, height, options, true);
  }

  getScreenBounds() {
    if (!this.hasModel() || !this._bounds || this._bounds.isEmpty()) return null;
    this.camera.updateMatrixWorld(true);
    const { min, max } = this._bounds;
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (const x of [min.x, max.x]) for (const y of [min.y, max.y]) for (const z of [min.z, max.z]) {
      const point = new THREE.Vector3(x, y, z).project(this.camera);
      const screenX = (point.x + 1) / 2;
      const screenY = (1 - point.y) / 2;
      left = Math.min(left, screenX); right = Math.max(right, screenX);
      top = Math.min(top, screenY); bottom = Math.max(bottom, screenY);
    }
    return { x: left, y: top, width: right - left, height: bottom - top };
  }

  offsetForScreenDelta(dxNorm, dyNorm) {
    const current = { modelOffsetX: Number(this.options.modelOffsetX) || 0, modelOffsetY: Number(this.options.modelOffsetY) || 0 };
    if (!this.hasModel() || !this._bounds || ![dxNorm, dyNorm].every(Number.isFinite)) return current;
    this.camera.updateMatrixWorld(true);
    const center = this._bounds.getCenter(new THREE.Vector3());
    const origin = center.clone().project(this.camera);
    const step = 0.01;
    const horizontal = center.clone().add(new THREE.Vector3(step, 0, 0)).project(this.camera);
    const vertical = center.clone().add(new THREE.Vector3(0, step, 0)).project(this.camera);
    const a = (horizontal.x - origin.x) / (2 * step);
    const b = (vertical.x - origin.x) / (2 * step);
    const c = -(horizontal.y - origin.y) / (2 * step);
    const d = -(vertical.y - origin.y) / (2 * step);
    const determinant = a * d - b * c;
    if (Math.abs(determinant) < 1e-8) return current;
    return {
      modelOffsetX: current.modelOffsetX + (dxNorm * d - dyNorm * b) / determinant / (MODEL_SIZE / 2),
      modelOffsetY: current.modelOffsetY + (a * dyNorm - c * dxNorm) / determinant / (MODEL_SIZE / 2),
    };
  }

  async loadBackground(file, { beforeCommit = null } = {}) {
    const image = file && (/^image\//.test(file.type) || /\.(png|jpe?g|webp|bmp|gif)$/i.test(file.name));
    const movie = file && (/^video\//.test(file.type) || /\.(mp4|mov|m4v|webm|ogv)$/i.test(file.name));
    if (!image && !movie) throw new Error('背景请选择照片或 MP4、MOV、WebM 视频。');
    if (beforeCommit !== null && (typeof beforeCommit !== 'function' || beforeCommit.constructor?.name === 'AsyncFunction')) throw new Error('背景切换回调必须是同步函数。');
    let texture, bitmap = null, video = null, url = null, metadata;
    try {
      if (movie) {
        video = document.createElement('video');
        video.muted = true;
        video.playsInline = true;
        video.preload = 'auto';
        video.loop = true;
        url = URL.createObjectURL(file);
        const loaded = waitForVideo(video, 'loadeddata', () => video.readyState >= 2, '这个视频暂时无法读取，请换用普通 H.264 MP4 视频。');
        video.src = url;
        video.load();
        await loaded;
        if (!Number.isFinite(video.duration) || video.duration <= 0) throw new Error('视频没有可读取的时长。');
        video.pause();
        metadata = { type: 'video', name: file.name, duration: video.duration, width: video.videoWidth, height: video.videoHeight };
      } else {
        // Decode may allocate before dimensions become available. Reject the
        // staged bitmap before texture upload and close it on every failure.
        bitmap = await createImageBitmap(file, { imageOrientation: 'flipY' });
        metadata = { type: 'image', name: file.name, duration: null, width: bitmap.width, height: bitmap.height };
      }
      const { width, height } = metadata;
      if (![width, height].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('背景没有有效的画面尺寸。');
      const textureLimit = this.renderer?.capabilities?.maxTextureSize;
      if (!Number.isSafeInteger(textureLimit) || textureLimit < 1) throw new Error('无法读取显卡纹理尺寸上限，旧背景已保留。');
      if (width > textureLimit || height > textureLimit) throw new Error(`背景为 ${width} × ${height}，超过显卡 ${textureLimit} 像素纹理尺寸上限。请降低背景分辨率后重试。`);
      if (width * height > 64_000_000) throw new Error('背景超过 6400 万像素处理上限，请降低背景分辨率后重试。');
      texture = video ? new THREE.VideoTexture(video) : new THREE.Texture(bitmap);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.needsUpdate = true;
      // Let the app cancel its old calibration editor and clear matching A/B
      // state only once this source has passed all staged validation. A default
      // stopCalibration() must run before the new photo camera is committed.
      if (beforeCommit) {
        const result = beforeCommit();
        if (result && typeof result.then === 'function') {
          Promise.resolve(result).catch(() => {});
          throw new Error('背景切换回调必须同步完成。');
        }
      }
    } catch (error) {
      try { texture?.dispose(); } catch { /* Release the other staged resources. */ }
      try { bitmap?.close?.(); } catch { /* The old source has not been touched. */ }
      if (video) {
        try { video.pause(); video.removeAttribute('src'); video.load(); } catch { /* Staged decoder only. */ }
      }
      if (url) URL.revokeObjectURL(url);
      throw error;
    }
    this._releaseBackground();
    this._backgroundTexture = texture;
    this._backgroundSize = { width: metadata.width, height: metadata.height };
    this.options.crop = null;
    this._fullSourceFov = this.camera.fov;
    this.camera.fov = this._visiblePhotoFov();
    this._applyCameraFraming();
    this._backgroundMetadata = metadata;
    this._backgroundVideo = video;
    this._backgroundURL = url;
    if (video) {
      this._backgroundSeekListener = () => {
        if (this._backgroundVideo !== video) return;
        texture.needsUpdate = true;
        this._requestRender();
        // Preview can skip stale requested times while decoding. Export waits
        // explicitly for each frame and must never start a queued preview seek.
        if (!this._exportState && this._previewBackgroundTime !== null) this.syncBackground(this._previewBackgroundTime);
      };
      video.addEventListener('seeked', this._backgroundSeekListener);
      if (video.requestVideoFrameCallback) {
        const ready = () => {
          this._backgroundFrameCallback = video.requestVideoFrameCallback(() => {
            if (this._backgroundVideo !== video) return;
            texture.needsUpdate = true;
            this._requestRender();
            ready();
          });
        };
        ready();
      }
    }
    this._updateBackground();
    this.render(this.options.progress);
    return this.backgroundMetadata;
  }

  _releaseBackground() {
    if (this._backgroundVideo) {
      if (this._backgroundFrameCallback !== undefined) this._backgroundVideo.cancelVideoFrameCallback?.(this._backgroundFrameCallback);
      if (this._backgroundSeekListener) this._backgroundVideo.removeEventListener('seeked', this._backgroundSeekListener);
      this._backgroundVideo.pause();
      this._backgroundVideo.removeAttribute('src');
      this._backgroundVideo.load();
    }
    if (this._backgroundURL) URL.revokeObjectURL(this._backgroundURL);
    if (this._backgroundTexture) { this._backgroundTexture.image?.close?.(); this._backgroundTexture.dispose(); }
    this._backgroundVideo = null;
    this._backgroundURL = null;
    this._backgroundTexture = null;
    if (this._photoShadowUniforms) this._photoShadowUniforms.photoShadowMap.value = null;
    this._photoBedSize = null;
    this._updateFloorFootprint();
    this._backgroundSize = null;
    this._fullSourceFov = null;
    this._backgroundMetadata = null;
    this._photoIdentity = null;
    this._lastPhotoLensDof = null;
    this._photoDofStatus = { enabled: false, error: null };
    this._backgroundSeekListener = null;
    this._backgroundFrameCallback = undefined;
    this._previewBackgroundTime = null;
  }

  clearBackground() {
    this._releaseBackground();
    this._updateBackground();
    this._requestRender();
    this.render(this.options.progress);
  }

  _backgroundTime(time) {
    const duration = this._backgroundMetadata?.duration || 0;
    const number = Number(time);
    const seconds = Number.isFinite(number) ? Math.max(0, number) : 0;
    if (!duration) return 0;
    // Short source videos repeat automatically; seeking exactly to the end can
    // return an empty decoded frame, so keep the target inside the media range.
    return Math.min(seconds % duration, Math.max(0, duration - 0.0001));
  }

  syncBackground(time) {
    const video = this._backgroundVideo;
    if (!video || this._exportState || this.options.transparent) return;
    const target = this._backgroundTime(time);
    this._previewBackgroundTime = target;
    if (video.seeking || Math.abs(video.currentTime - target) < 0.0005) return;
    try { video.currentTime = target; }
    catch { /* A new source may still be settling; the next preview tick retries. */ }
  }

  async _seekBackground(time) {
    const video = this._backgroundVideo;
    if (!video || this.options.transparent) return;
    const target = this._backgroundTime(time);
    if (video.seeking) await waitForVideo(video, 'seeked', () => !video.seeking && video.readyState >= 2, '背景视频定位失败，请换用普通 H.264 MP4 视频。');
    if (Math.abs(video.currentTime - target) >= 0.0005) {
      const sought = waitForVideo(video, 'seeked', () => !video.seeking && video.readyState >= 2 && Math.abs(video.currentTime - target) < 0.0005, '背景视频定位失败，请换用普通 H.264 MP4 视频。');
      video.currentTime = target;
      await sought;
    }
    if (this._backgroundVideo !== video) throw new Error('背景视频已更换，请重新导出。');
    this._backgroundTexture.needsUpdate = true;
  }

  _updateBackground() {
    // Real backgrounds keep their pixels visible and receive only the model's
    // contact shadow. The regular studio retains its solid ground surface.
    this.floor.material = this._backgroundTexture ? this._floorShadowMaterial : this._floorSolidMaterial;
    this._updateFloorFootprint();
    if (this.options.transparent) {
      this.scene.background = null;
      this.renderer.setClearColor(0x000000, 0);
    } else if (this._backgroundTexture) {
      const size = this.renderer.getSize(new THREE.Vector2());
      const crop = this.options.crop;
      const cover = crop ? { repeatX: crop.width, repeatY: crop.height, offsetX: crop.x, offsetY: 1 - crop.y - crop.height } : coverTexture(this._backgroundSize.width, this._backgroundSize.height, size.x, size.y);
      this._backgroundTexture.repeat.set(cover.repeatX, cover.repeatY);
      this._backgroundTexture.offset.set(cover.offsetX, cover.offsetY);
      this._backgroundTexture.updateMatrix();
      this.scene.background = this._backgroundTexture;
      this.renderer.setClearAlpha(1);
    } else {
      this.scene.background = new THREE.Color(this.options.background);
      this.renderer.setClearAlpha(1);
    }
  }

  _resize(width, height, adjustCamera = true, requestRender = true) {
    width = Math.max(1, Math.round(width ?? this.host.clientWidth));
    height = Math.max(1, Math.round(height ?? this.host.clientHeight));
    if (this._sceneUpdateDepth > 0 && !this._exportState) {
      this._pendingSceneResize = { width, height, adjustCamera };
      // Fitters and calibrated camera updates still need the final projection.
      if (adjustCamera) { this._viewportAspect = width / height; this._applyCameraFraming(width / height); }
      this._renderPending = true;
      return;
    }
    this.renderer.setSize(width, height, !this._exportState);
    if (adjustCamera) { this._viewportAspect = width / height; this._applyCameraFraming(width / height); }
    for (const mesh of this._meshes) if (mesh.isLineSegments2) mesh.material.resolution.set(width, height);
    this._indexedSupports?.setResolution(width, height);
    this._updateBackground();
    if (requestRender) this._requestRender();
    if (this._dofComposer) { this._dofComposer.setPixelRatio(this.renderer.getPixelRatio()); this._dofComposer.setSize(width, height); }
  }

  /** Share the final photo/crop projection without changing the live camera. */
  _framedCameraClone(aspect) {
    const camera = this.camera.clone();
    if (this.options.crop) {
      const crop = this.options.crop;
      camera.fov = this._fullSourceFov || this._cropFullFov || camera.fov;
      camera.setViewOffset(crop.sourceAspect, 1, crop.x * crop.sourceAspect, crop.y, crop.width * crop.sourceAspect, crop.height);
    } else {
      camera.clearViewOffset(); camera.aspect = aspect;
      camera.fov = this._visiblePhotoFov(aspect); camera.updateProjectionMatrix();
    }
    return camera;
  }

  /** Complete, detached metric scene for the local physical renderer. */
  async createRenderPackage(options = {}) {
    if (!this.hasModel()) throw new Error('请先导入模型。');
    if (this._exportState) throw new Error('请等待当前导出完成。');
    const output = normalizeRenderOutput(options.output);
    // Mirror final-size framing on a clone. Do not resize the live renderer,
    // advance growth, change the camera, or write the project's cache.
    const camera = this._framedCameraClone(output.width / output.height);
    const size = this.floor.geometry.parameters;
    return createSceneRenderPackage({
      root: this.modelGroup, camera, mode: this._metadata.mode,
      metadata: { ...this._metadata }, settings: { ...this.options },
      units: { calibratedBed: this._photoBedSize && { ...this._photoBedSize }, normalizedScale: this.normalized?.scale.x, sourceUnitsToMm: this._metadata.sourceUnitsToMm, sourceUnitsInferred: this._metadata.sourceUnitsInferred },
      floor: { object: this.floor, width: size.width * this.floor.scale.x, depth: size.height * this.floor.scale.y, worldSize:true },
      backgroundType: this._backgroundMetadata?.type || null,
      photoIdentity: this.photoIdentity,
      backgroundSize: this._backgroundSize && { ...this._backgroundSize },
      focusBoundsWorld: this._completeModelFocusBounds(),
      printLayer: this.getPrintLayerData(),
    }, { ...options, output });
  }

  startExport(width, height) {
    this.endPreviewInteraction();
    if (this._exportState) throw new Error('已有导出任务正在进行。');
    if (!this.hasModel()) throw new Error('请先导入模型。');
    this._spatialPreview?.invalidate();
    width = Math.round(width); height = Math.round(height);
    if (![width, height].every(value => Number.isFinite(value) && value >= 16 && value <= 8192)) throw new Error('导出尺寸必须介于 16 和 8192 像素。');
    this._flushEnvironment();
    this._endShadowDrag();
    this.controls.update();
    this._exportState = { size: this.renderer.getSize(new THREE.Vector2()), pixelRatio: this.renderer.getPixelRatio(), aspect: this.camera.aspect, position: this.camera.position.clone(), quaternion: this.camera.quaternion.clone(), target: this.controls.target.clone(), progress: this.options.progress, turntable: this.options.turntable, turnRadians: this._turnRadians, controlsEnabled: this.controls.enabled, transformEnabled: this.transform.enabled, transformVisible: this.transformHelper.visible, shadowEditMode: this._shadowEditMode, shadowHelperVisible: this.shadowHelper?.visible };
    this.controls.enabled = false;
    this.transform.enabled = false;
    this.transformHelper.visible = false;
    this._shadowEditMode = false;
    if (this.shadowHelper) this.shadowHelper.visible = false;
    this._previewBackgroundTime = null;
    this.renderer.setPixelRatio(1);
    // Vertical framing stays fixed; the changed aspect crops or expands horizontally,
    // exactly as the preview's camera does when its viewport aspect changes.
    this._resize(width, height);
    this.render(this.options.progress, Number(this.options.turntable || 0) * Math.PI / 180);
  }

  async captureFrame(progress, turnRadians = 0, backgroundTime = 0, { outputPlan = null, samples = null, signal = null } = {}) {
    const previousDisplayOutput=this._displayOutputSize;
    this._displayOutputSize=outputPlan?{width:outputPlan.width,height:outputPlan.height}:this.renderer.getSize(new THREE.Vector2());
    try{return await this._captureFrameAtDisplaySize(progress,turnRadians,backgroundTime,{outputPlan,samples,signal});}
    finally{this._displayOutputSize=previousDisplayOutput;}
  }

  async _captureFrameAtDisplaySize(progress, turnRadians = 0, backgroundTime = 0, { outputPlan = null, samples = null, signal = null } = {}) {
    if (!this._exportState) throw new Error('请先调用 startExport。');
    const cancelled = () => { if (signal?.aborted) throw new DOMException('Aborted', 'AbortError'); };
    cancelled();
    await this._seekBackground(backgroundTime);
    cancelled();
    this.render(progress, turnRadians);
    const sourceWidth = this.canvas.width, sourceHeight = this.canvas.height;
    const plan = outputPlan || { width: sourceWidth, height: sourceHeight, renderWidth: sourceWidth, renderHeight: sourceHeight, scale: 1 };
    if (![1, 2, 4].includes(plan.scale) || ![plan.width, plan.height].every(value => Number.isInteger(value) && value > 0)
      || plan.renderWidth !== sourceWidth || plan.renderHeight !== sourceHeight || plan.width * plan.scale !== sourceWidth || plan.height * plan.scale !== sourceHeight) throw new Error('空间采样尺寸必须与当前完整渲染画面一致。');
    const passes = samples ?? (this._metadata?.historicalPathSurface === 'analytic-pbr-extrusion' || this._indexedSupports?.root.visible && this.options.supportDisplay !== 'paths' ? 8 : 1);
    const blobFrom = canvas => new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('无法生成 PNG 帧，请检查模型纹理是否来自本地。')), 'image/png'));
    if (passes === 1) {
      const blob = await blobFrom(this.canvas);
      cancelled();
      if (plan.scale === 1) return blob;
      this._exportState.finalCanvas ||= this.canvas.ownerDocument.createElement('canvas');
      const finalBlob = await downsampleExportFrame(blob, plan, this._exportState.finalCanvas);
      cancelled();
      return finalBlob;
    }
    const sampling = pixelSamplingPlan(plan.width, plan.height, { scale: plan.scale, passes });
    const state = this._exportState;
    if (!state.spatial || state.spatial.plan.width !== sampling.width || state.spatial.plan.height !== sampling.height || state.spatial.plan.passes !== passes || state.spatial.plan.scale !== sampling.scale) {
      const readCanvas = this.canvas.ownerDocument.createElement('canvas');
      readCanvas.width = sourceWidth; readCanvas.height = sourceHeight;
      const read = readCanvas.getContext('2d', { alpha: true, colorSpace: 'srgb', willReadFrequently: true });
      const finalCanvas = this.canvas.ownerDocument.createElement('canvas');
      finalCanvas.width = plan.width; finalCanvas.height = plan.height;
      const final = finalCanvas.getContext('2d', { alpha: true, colorSpace: 'srgb' });
      if (!read || !final) throw new Error('无法分配支撑空间采样画布。');
      state.spatial = { plan: sampling, readCanvas, read, finalCanvas, final, image: final.createImageData(plan.width, plan.height), accumulator: new LinearPixelCoverageAccumulator(sampling) };
    }
    const spatial = state.spatial;
    spatial.accumulator.reset();
    const projection = this.camera.projectionMatrix.clone(), inverse = this.camera.projectionMatrixInverse.clone();
    const shadowAutoUpdate = this.renderer.shadowMap.autoUpdate;
    try {
      // All samples belong to this exact growth frame. No temporal history,
      // color substitution, geometry simplification or image-space blur.
      // The ordinary render above has already refreshed this frame's shadows.
      this.renderer.shadowMap.autoUpdate = false;
      for (const jitter of sampling.pattern) {
        cancelled();
        this.camera.projectionMatrix.fromArray(pixelJitterProjection(projection, sourceWidth, sourceHeight, jitter));
        this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert();
        this._drawScene();
        spatial.read.clearRect(0, 0, sourceWidth, sourceHeight);
        spatial.read.imageSmoothingEnabled = false;
        spatial.read.drawImage(this.canvas, 0, 0); // 1:1, straight sRGB RGBA8.
        spatial.accumulator.addSample(spatial.read.getImageData(0, 0, sourceWidth, sourceHeight).data);
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      cancelled();
      spatial.accumulator.finish(spatial.image.data);
      spatial.final.putImageData(spatial.image, 0, 0);
      const blob = await blobFrom(spatial.finalCanvas);
      cancelled();
      return blob;
    } finally {
      this.camera.projectionMatrix.copy(projection);
      this.camera.projectionMatrixInverse.copy(inverse);
      this.renderer.shadowMap.autoUpdate = shadowAutoUpdate;
      spatial.accumulator.reset();
    }
  }

  endExport() {
    if (!this._exportState) return;
    const state = this._exportState;
    this._exportState = null;
    this.renderer.setPixelRatio(state.pixelRatio);
    this._resize();
    // OrbitControls retains a damped mouse delta while export freezes updates.
    // Clear it before restoring the saved pose, so cancel/completion cannot
    // rotate the view again on the first preview tick.
    const damping = this.controls.enableDamping;
    this.controls.enableDamping = false;
    this.controls.update();
    this.camera.position.copy(state.position);
    this.camera.quaternion.copy(state.quaternion);
    this.controls.target.copy(state.target);
    this.controls.enabled = state.controlsEnabled;
    this.transform.enabled = state.transformEnabled;
    this.transformHelper.visible = state.transformVisible;
    this._shadowEditMode = state.shadowEditMode;
    if (this.shadowHelper) this.shadowHelper.visible = state.shadowHelperVisible;
    this.options.progress = state.progress;
    this.options.turntable = state.turntable;
    this.controls.update();
    this.camera.position.copy(state.position);
    this.camera.quaternion.copy(state.quaternion);
    this.controls.enableDamping = damping;
    this.render(state.progress, state.turnRadians);
    this._scheduleEnvironment();
  }

  dispose() {
    this._spatialPreview?.dispose();
    this.canvas.removeEventListener('pointerdown',this._spatialPointerListener,true);
    for(const event of ['pointerup','pointercancel','lostpointercapture'])this.canvas.removeEventListener(event,this._spatialPointerEndListener,true);
    clearTimeout(this._previewInteractionTimer);
    clearTimeout(this._environmentTimer);
    cancelAnimationFrame(this._raf);
    this._resizeObserver.disconnect();
    this.controls.dispose();
    this.controls.removeEventListener('change', this._controlsRenderListener);
    this.transform.removeEventListener('change', this._controlsRenderListener);
    for (const [name, handler] of Object.entries(this._shadowPointerHandlers || {})) this.canvas.removeEventListener(name, handler, true);
    this.scene.remove(this.transformHelper);
    this.transform.dispose();
    for (const material of Object.values(this._analysisMaterials || {})) material.dispose();
    for (const target of this._analysisTargets?.values() || []) target.dispose();
    this._dofComposer?.dispose();
    this._dofRenderPass?.dispose();
    this._dofBokehPass?.dispose();
    this._dofOutputPass?.dispose();
    this._indexedSupports?.dispose();
    this._printLayers?.dispose();
    disposeTree(this.scene, [...this._retainedMaterials, ...(this._supportOverlay?.retainedMaterials || []), this._floorSolidMaterial, this._floorShadowMaterial]);
    this._environmentCache?.dispose();
    this._releaseBackground();
    this._sourceMaterials.clear();
    this._retainedMaterials.clear();
    this.renderer.dispose();
    this.canvas.remove();
  }
}
