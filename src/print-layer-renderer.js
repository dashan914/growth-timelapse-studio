import * as THREE from 'three';
import { bindSurfaceFootprintScale } from './surface-footprint.js';
import { buildPrintLayerInstances, PRINT_FEATURE_NAMES } from './print-layer.js';
import { clamp01 } from './growth-math.js';
import { resolveFDMSurfaceProfile } from './fdm-surface.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

const COLOR = /^#[\da-f]{6}$/i;
const ARRAY_TYPES = {
  positions: Float32Array, tools: Uint16Array, features: Uint8Array,
  widths: Float32Array, heights: Float32Array, strokes: Uint32Array,
  layers: Uint32Array, layerHeights: Float64Array, layerOffsets: Uint32Array,
  layerSegments: Uint32Array,
};

export function printBeadRatio(width, height, feature) {
  // Bridge flow and W < H cannot be treated as ordinary flattened FDM roads.
  // Keep both recorded dimensions; their elliptical fallback is explicit.
  return feature === 7 || width < height ? 1 : height / width;
}

/** A circle template with duplicated upper/lower semicircle endpoints and
 * explicit left/right tags. The vertex shader moves the semicircle centres,
 * leaving true flat top/bottom contact regions of width W-H. */
export function createStadiumGeometry(semiSteps = 6) {
  if (!Number.isInteger(semiSteps) || semiSteps < 3 || semiSteps > 64) throw new RangeError('打印挤出半圆精度无效。');
  const ring = [];
  for (const side of [1, -1]) for (let step = 0; step <= semiSteps; step++) {
    const angle = (side === 1 ? -Math.PI / 2 : Math.PI / 2) + step * Math.PI / semiSteps;
    ring.push({ x: step === 0 || step === semiSteps ? 0 : Math.cos(angle) * .5, z: Math.sin(angle) * .5, side });
  }
  const positions = [], normals = [], sides = [], indices = [], count = ring.length;
  const add = (point, y, normal) => {
    positions.push(point.x, y, point.z); normals.push(...normal); sides.push(point.side);
    return sides.length - 1;
  };
  for (const y of [-.5, .5]) for (const point of ring) add(point, y, [point.x * 2, 0, point.z * 2]);
  for (let index = 0; index < count; index++) {
    const next = (index + 1) % count;
    indices.push(index, count + index, count + next, index, count + next, next);
  }
  for (const y of [-.5, .5]) {
    const start = sides.length;
    for (const point of ring) add(point, y, [0, Math.sign(y), 0]);
    const center = add({ x: 0, z: 0, side: 0 }, y, [0, Math.sign(y), 0]);
    for (let index = 0; index < count; index++) {
      const next = (index + 1) % count;
      if (y < 0) indices.push(center, start + index, start + next);
      else indices.push(center, start + next, start + index);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.name = 'Ordinary FDM stadium cross-section';
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('beadCrossSide', new THREE.Float32BufferAttribute(sides, 1));
  geometry.setAttribute('beadCrossEnabled', new THREE.Float32BufferAttribute(new Float32Array(sides.length).fill(1), 1));
  geometry.setIndex(indices); geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  geometry.userData.printCrossSection = { shape: 'stadium-with-elliptical-fallback', semiSteps, closed: true, flatContact: true };
  return geometry;
}

export function installStadiumExtrusion(material) {
  const before = material.onBeforeCompile, key = material.customProgramCacheKey.bind(material);
  material.defaultAttributeValues = { ...(material.defaultAttributeValues || {}), beadCrossEnabled: [0], beadCrossSide: [0], instanceBeadRatio: [1] };
  material.onBeforeCompile = (shader, renderer) => {
    before.call(material, shader, renderer);
    shader.vertexShader = 'attribute float beadCrossEnabled;\nattribute float beadCrossSide;\nattribute float instanceBeadRatio;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader
      .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\nif (beadCrossEnabled > 0.5) objectNormal.x /= max(instanceBeadRatio, 0.00000001);')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nif (beadCrossEnabled > 0.5) {\nfloat beadRatio = clamp(instanceBeadRatio, 0.00000001, 1.0);\ntransformed.x = 0.5 * (1.0 - beadRatio) * beadCrossSide + transformed.x * beadRatio;\n}');
  };
  material.customProgramCacheKey = () => `${key()}|fdm-stadium-flat-contact-v1`;
  material.needsUpdate = true;
  return material;
}

export function installPrintLayerDepthLighting(material) {
  const before = material.onBeforeCompile, key = material.customProgramCacheKey.bind(material);
  material.defaultAttributeValues = { ...(material.defaultAttributeValues || {}), instanceDepth: [0] };
  material.onBeforeCompile = (shader, renderer) => {
    before.call(material, shader, renderer);
    shader.vertexShader = 'attribute float instanceDepth;\nvarying float vBeadDepth;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvBeadDepth = instanceDepth;\n');
    shader.fragmentShader = 'varying float vBeadDepth;\n' + shader.fragmentShader;
    const lightHook = '#include <lights_fragment_end>';
    if (shader.fragmentShader.includes(lightHook)) {
      shader.fragmentShader = shader.fragmentShader.replace(lightHook, lightHook + `
      float beadDepthMm = max(0.0, vBeadDepth);
      if (beadDepthMm > 0.02) {
        float depthNorm = clamp(beadDepthMm / 5.0, 0.0, 1.0);
        float directFactor = pow(1.0 - depthNorm, 1.35);
        float ambientFactor = mix(1.0, 0.28, pow(depthNorm, 0.7));
        float upLight = max(0.0, normal.y) * 0.16 * (1.0 - depthNorm);
        reflectedLight.directDiffuse *= directFactor;
        reflectedLight.directSpecular *= directFactor * directFactor;
        reflectedLight.indirectDiffuse = reflectedLight.indirectDiffuse * ambientFactor + diffuseColor.rgb * upLight;
        reflectedLight.indirectSpecular *= directFactor;
      }
      `);
    }
  };
  material.customProgramCacheKey = () => `${key()}|print-layer-depth-light-v1`;
  material.needsUpdate = true;
  return material;
}

/** Fully average at Nyquist (2 pixels/layer); retain all original normals once
 * the output resolves 5 pixels/layer, including the bead profile's harmonics. */
export function supportLayerFilterWeight(layerHeight, heightPerPixel, eligible = true) {
  if (!Number.isFinite(layerHeight) || layerHeight <= 0 || !Number.isFinite(heightPerPixel) || heightPerPixel < 0) throw new TypeError('支撑着色过滤需要有效的真实层高和像素足迹。');
  if (!eligible) return 0;
  const t = Math.max(0, Math.min(1, (heightPerPixel / layerHeight - .2) / .3));
  return t * t * (3 - 2 * t);
}

/** Projected front-view semicircular side average of max(0,a*cos(t)+b*sin(t))
 * with projected-height measure cos(t)dt/2, t in [-pi/2,pi/2]. This is an
 * unoccluded cross-section model, not an exact average for every viewing angle. */
export function supportSemicircleDiffuseAverage(a, b) {
  if (![a, b].every(Number.isFinite)) throw new TypeError('支撑解析漫反射需要有限方向分量。');
  if (Math.abs(a) + Math.abs(b) < 1e-12) return 0;
  const vertical = Math.abs(b);
  return Math.max(0, .25 * (a * (Math.PI - Math.atan2(vertical, a)) + vertical));
}

const SUPPORT_LAYER_FILTER_GLSL = /* glsl */`
uniform float supportLayerFilterEnabled;
uniform float supportFootprintScale;
varying vec3 vSupportMacroNormal;
varying vec3 vSupportPrintAxisNormal;
varying float vSupportLayerCoordinate;
varying float vSupportSideEligible;
float supportLayerFilter = 0.0;
vec3 supportRawNormal = vec3(0.0,0.0,1.0);
vec3 supportMacroNormal = vec3(0.0,0.0,1.0);
vec3 supportPrintAxisNormal = vec3(0.0,1.0,0.0);
float supportProjectedSideCosine(const in vec3 lightDirection) {
  float original = saturate(dot(supportRawNormal, lightDirection));
  if (supportLayerFilter <= 0.0) return original;
  float a = dot(supportMacroNormal, lightDirection);
  float b = abs(dot(supportPrintAxisNormal, lightDirection));
  float averaged = abs(a) + b < 0.0000001 ? 0.0 : max(0.0, 0.25 * (a * (PI - atan(b, a)) + b));
  return mix(original, averaged, supportLayerFilter);
}
vec3 supportHemisphereMeanNormal() {
  return mix(supportRawNormal, supportMacroNormal * (PI * 0.25), supportLayerFilter);
}
`;

/** Filter for ordinary rounded bead sides. Production support and recent-layer
 * renderers enable it; the installer itself remains explicitly switchable.
 * It carries no new per-path buffers and never changes source geometry/depth,
 * height/width/position/tool or material palette. Diffuse uses its phase
 * average and specular uses the same filtered normal/mean-normal roughness.
 * Flat tops, end caps, W<H fallbacks and resolved layers stay unchanged.
 */
export function installSupportLayerFilter(material) {
  if (!material?.isMeshStandardMaterial) throw new TypeError('支撑解析着色过滤需要标准 PBR 材质。');
  if (material.userData.supportLayerFilter) return material;
  const before = material.onBeforeCompile, key = material.customProgramCacheKey.bind(material);
  const enabled = { value: 0 };
  material.userData.supportLayerFilter = { enabled, mode: 'none', approximate: true,
    model: 'unresolved ordinary semicircle side; projected front-view diffuse average',
    limitations: ['branch envelope slope/view obliquity approximate', 'specular mean-normal roughness is approximate', 'geometry coverage, tool-color alias and self-shadow sampling unchanged'] };
  const footprintScale = { value: 1 };
  bindSurfaceFootprintScale(material, footprintScale);
  material.onBeforeCompile = (shader, renderer) => {
    before.call(material, shader, renderer);
    // Off compiles the original stadium shader, with no extra vertex/varying
    // work on the 153M-face baseline. update() recompiles only on mode changes.
    if (enabled.value <= 0.5) return;
    const vertexHook = '#include <project_vertex>', normalHook = '#include <normal_fragment_maps>';
    const physicalHook = '#include <lights_physical_pars_fragment>', lightHook = '#include <lights_fragment_begin>';
    if (!shader.vertexShader.includes(vertexHook) || ![normalHook, physicalHook, lightHook, '#include <common>'].every(hook => shader.fragmentShader.includes(hook))) throw new Error('标准 PBR 着色器缺少支撑解析过滤插入点。');
    shader.uniforms.supportLayerFilterEnabled = enabled;
    shader.uniforms.supportFootprintScale = footprintScale;
    shader.vertexShader = `uniform float supportLayerFilterEnabled;\nvarying vec3 vSupportMacroNormal;
varying vec3 vSupportPrintAxisNormal;
varying float vSupportLayerCoordinate;
varying float vSupportSideEligible;
` + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace(vertexHook, `${vertexHook}
vSupportMacroNormal = vec3(0.0); vSupportPrintAxisNormal = vec3(0.0,1.0,0.0);
vSupportLayerCoordinate = 0.0; vSupportSideEligible = 0.0;
#ifdef USE_INSTANCING
 if (supportLayerFilterEnabled > 0.5) {
  mat3 supportInstance = mat3(instanceMatrix);
  vec3 supportScaleSquared = vec3(dot(supportInstance[0],supportInstance[0]), dot(supportInstance[1],supportInstance[1]), dot(supportInstance[2],supportInstance[2]));
  float supportHeight = instanceMatrix[2].z;
  float supportWidth = sqrt(supportScaleSquared.x);
  if (beadCrossEnabled > 0.5 && instanceBeadRatio < 0.999999 && supportHeight > 0.0 && supportWidth >= supportHeight) {
    vec3 supportLateralObjectNormal = vec3(objectNormal.xy, 0.0);
    vSupportMacroNormal = normalMatrix * (supportInstance * (supportLateralObjectNormal / max(supportScaleSquared,vec3(0.0000000001))));
    vSupportPrintAxisNormal = normalMatrix * (supportInstance * (vec3(0.0,0.0,1.0) / max(supportScaleSquared,vec3(0.0000000001))));
    // Relative printer Z avoids subtracting enormous absolute layer indices.
    vSupportLayerCoordinate = (instanceMatrix * vec4(transformed,0.0)).z / supportHeight;
    vSupportSideEligible = abs(objectNormal.y) < 0.5 ? 1.0 : 0.0;
  }
 }
#endif`);
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\n' + SUPPORT_LAYER_FILTER_GLSL);
    shader.fragmentShader = shader.fragmentShader.replace(normalHook, `${normalHook}
supportRawNormal = normal;
float supportMacroLength = length(vSupportMacroNormal);
float supportCyclesPerPixel = fwidth(vSupportLayerCoordinate)*supportFootprintScale;
supportLayerFilter = supportLayerFilterEnabled * vSupportSideEligible * smoothstep(0.2,0.5,supportCyclesPerPixel) * step(0.000001,supportMacroLength);
// Rect-area/probe diffuse need different integrals: leave those cases exact.
#if NUM_RECT_AREA_LIGHTS > 0 || defined(USE_LIGHT_PROBES)
  supportLayerFilter = 0.0;
#endif
if (supportLayerFilter > 0.0) {
  supportMacroNormal = vSupportMacroNormal / supportMacroLength;
  #ifdef DOUBLE_SIDED
    supportMacroNormal *= faceDirection;
  #endif
  supportPrintAxisNormal = normalize(vSupportPrintAxisNormal);
  normal = normalize(mix(normal,supportMacroNormal,supportLayerFilter));
  nonPerturbedNormal = normalize(mix(nonPerturbedNormal,supportMacroNormal,supportLayerFilter));
  roughnessFactor = sqrt(min(1.0,roughnessFactor*roughnessFactor+(1.0-PI*0.25)*supportLayerFilter));
}
// Resolved layers still use Three's geometryRoughness. Unresolved ones use a
// phase-independent mean-normal lobe rather than fluctuating derivatives.
`);
    const diffuseTerm = 'reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseContribution ) * ( 1.0 - F );';
    const hemisphereTerm = 'getHemisphereLightIrradiance( hemisphereLights[ i ], geometryNormal )';
    if (!THREE.ShaderChunk.lights_physical_pars_fragment.includes(diffuseTerm) || !THREE.ShaderChunk.lights_fragment_begin.includes(hemisphereTerm)) throw new Error('Three PBR 光照接口已变化，支撑层纹过滤不能静默改写。');
    shader.fragmentShader = shader.fragmentShader.replace(physicalHook, THREE.ShaderChunk.lights_physical_pars_fragment.replace(diffuseTerm,
      'reflectedLight.directDiffuse += directLight.color * supportProjectedSideCosine(directLight.direction) * BRDF_Lambert( material.diffuseContribution ) * ( 1.0 - F );'));
    shader.fragmentShader = shader.fragmentShader.replace(lightHook, THREE.ShaderChunk.lights_fragment_begin.replace(hemisphereTerm,
      'getHemisphereLightIrradiance( hemisphereLights[ i ], supportHemisphereMeanNormal() )'));
  };
  material.customProgramCacheKey = () => `${key()}|support-analytic-layer-shading-v2:${enabled.value > .5 ? 'on' : 'off'}`;
  material.needsUpdate = true;
  return material;
}

function stadiumDepthMaterial(material) {
  const depthMaterial = installStadiumExtrusion(new THREE.MeshDepthMaterial({
    depthPacking: THREE.RGBADepthPacking, side: THREE.FrontSide,
    clippingPlanes: material.clippingPlanes, clipShadows: material.clipShadows,
  }));
  const before = depthMaterial.onBeforeCompile, key = depthMaterial.customProgramCacheKey.bind(depthMaterial);
  depthMaterial.defaultAttributeValues = { ...(depthMaterial.defaultAttributeValues || {}), instanceFeature: [0] };
  depthMaterial.onBeforeCompile = (shader, renderer) => {
    before.call(depthMaterial, shader, renderer);
    shader.vertexShader = 'attribute float instanceFeature;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
if (instanceFeature > 2.5 && instanceFeature < 3.5) {
  transformed = vec3(0.0);
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}`);
  };
  depthMaterial.customProgramCacheKey = () => `${key()}|sparse-infill-shadow-filter-v1`;
  return depthMaterial;
}

/** Coordinates are explicit. Source means the GrowthStudio orientation group's
 * coordinate system, before its normalization or the user's pose. A 3MF whose
 * original build placement is retained uses the known printer-Z → Three-Y axis
 * conversion. Moving a build in the slicer requires its known inverse placement.
 * Neither this function nor the renderer guesses from two bounding boxes. */
export function validatePrintLayerMapping(value) {
  const elements = value?.elements || value;
  if (!elements || elements.length !== 16 || [...elements].some(number => !Number.isFinite(number))) {
    throw new TypeError('printerToSource 必须明确指定打印坐标到源模型坐标的 4×4 仿射矩阵，不能按包围盒猜测对齐。');
  }
  if (Math.abs(elements[3]) + Math.abs(elements[7]) + Math.abs(elements[11]) > 1e-10 || Math.abs(elements[15] - 1) > 1e-10) {
    throw new TypeError('打印坐标映射必须是仿射矩阵。');
  }
  const matrix = new THREE.Matrix4().fromArray(elements);
  if (!Number.isFinite(matrix.determinant()) || Math.abs(matrix.determinant()) < 1e-16) {
    throw new TypeError('打印坐标映射不可逆，无法保持真实层高和模型对齐。');
  }
  return matrix;
}

export function validatePrintLayerData(parsed) {
  const count = parsed?.segmentCount;
  if (parsed?.version !== 1 || parsed?.source !== 'sliced-gcode' || parsed.coordinates !== 'printer-mm-z-up' ||
      parsed.exactLinearPaths !== true || !Number.isInteger(count) || count < 1) {
    throw new TypeError('需要完整解析的真实模型切片数据；不能用估计填充替代。');
  }
  for (const [key, constructor] of Object.entries(ARRAY_TYPES)) {
    if (!(parsed[key] instanceof constructor)) throw new TypeError(`真实切片缺少有效的 ${key} 数据。`);
  }
  if (parsed.positions.length !== count * 6 || ['tools', 'features', 'widths', 'heights', 'strokes', 'layers', 'layerSegments'].some(key => parsed[key].length !== count)) {
    throw new TypeError('真实切片段数和数据长度不一致；不会截断读取。');
  }
  const layers = parsed.layerHeights.length;
  if (!layers || parsed.layerOffsets.length !== layers + 1 || parsed.layerOffsets[0] !== 0 || parsed.layerOffsets[layers] !== count) {
    throw new TypeError('真实切片层索引不完整。');
  }
  for (let index = 0; index < layers; index++) {
    if (!Number.isFinite(parsed.layerHeights[index]) || (index && parsed.layerHeights[index] <= parsed.layerHeights[index - 1]) || parsed.layerOffsets[index + 1] < parsed.layerOffsets[index]) {
      throw new TypeError('真实切片层索引或层高无效。');
    }
  }
  return parsed;
}

export function resolvePrintLayerPalette(parsed, overrides = null) {
  const tools = parsed.usedTools || [...new Set(parsed.tools)];
  const palette = [];
  const missing = [];
  for (const tool of tools) {
    const value = overrides?.[tool] ?? parsed.toolColors?.[tool];
    if (!COLOR.test(value || '')) missing.push(tool + 1);
    else palette[tool] = value.toLowerCase();
  }
  if (missing.length) throw new Error(`真实切片缺少耗材 ${missing.join('、')} 的颜色，请确认耗材色；不会把填充猜成单色。`);
  return palette;
}

/** Animation steps at actual deposited layer Z, including variable layer height.
 * The completed frame uses the untouched complete CAD mesh. */
export function printLayerProgressState(parsed, progress) {
  const value = clamp01(progress), count = parsed.layerHeights.length;
  const visibleLayerCount = value === 1 ? count : Math.min(count, Math.floor(value * count + 1e-10));
  const layerIndex = visibleLayerCount - 1;
  return {
    progress: value, visibleLayerCount, layerIndex,
    heightMm: layerIndex < 0 ? null : parsed.layerHeights[layerIndex],
    empty: layerIndex < 0, complete: value === 1,
  };
}

/** Transferable packet for a single exact layer window. Matrices are in explicit
 * source coordinates. Original path IDs, widths, heights, tools and roles stay
 * unmodified and permit a physical renderer to reproduce the same window.
 * No path merging, simplification, polygon decimation or color quantization. */
export function buildPrintLayerPacket(parsed, {
  layerIndex, historyLayers = 3, infillDepthMm = 0, includeSupport = false,
  includeOuterWall = true, historicalOuterWall = true, historicalInnerWall = true, printerToSource,
  toolColors = parsed.toolColors,
} = {}) {
  validatePrintLayerData(parsed);
  const mapping = validatePrintLayerMapping(printerToSource);
  const paletteHex = resolvePrintLayerPalette(parsed, toolColors);
  const instance = buildPrintLayerInstances(parsed, {
    layerIndex, historyLayers, infillDepthMm, includeSupport,
    includeOuterWall, historicalOuterWall, historicalInnerWall, printerToSource: mapping.elements,
    toolColors: paletteHex, strictColors: true,
  });
  const count = instance.instanceCount;
  const positions = new Float32Array(count * 6), widths = new Float32Array(count), heights = new Float32Array(count);
  const layers = new Uint32Array(count), strokes = new Uint32Array(count), sectionRatios = new Float32Array(count);
  const depths = new Float32Array(count);
  const crossSectionFallbacks = { bridge: 0, widthBelowHeight: 0 };
  const palette = (parsed.usedTools || [...new Set(parsed.tools)]).map(tool => ({
    tool, color: paletteHex[tool], linearRGB: new THREE.Color(paletteHex[tool]).toArray(),
  }));
  const paletteIds = new Map(palette.map((item, index) => [item.tool, index]));
  const colorIndices = new Uint16Array(count), roleCounts = {};
  const matrix = new THREE.Matrix4();
  const currentZ = instance.heightMm ?? (layerIndex >= 0 ? parsed.layerHeights[layerIndex] : 0);
  for (let index = 0; index < count; index++) {
    const segment = instance.segments[index];
    if (segment >= parsed.segmentCount) throw new TypeError('真实切片的层段索引超出范围。');
    positions.set(parsed.positions.subarray(segment * 6, segment * 6 + 6), index * 6);
    widths[index] = parsed.widths[segment]; heights[index] = parsed.heights[segment];
    layers[index] = parsed.layers[segment]; strokes[index] = parsed.strokes[segment];
    sectionRatios[index] = printBeadRatio(widths[index], heights[index], instance.features[index]);
    depths[index] = Math.max(0, currentZ - parsed.layerHeights[parsed.layers[segment]]);
    if (instance.features[index] === 7) crossSectionFallbacks.bridge++;
    else if (widths[index] < heights[index]) crossSectionFallbacks.widthBelowHeight++;
    colorIndices[index] = paletteIds.get(instance.tools[index]);
    const role = PRINT_FEATURE_NAMES[instance.features[index]];
    roleCounts[role] = (roleCounts[role] || 0) + 1;
    matrix.fromArray(instance.matrices, index * 16);
    if (matrix.elements.some(number => !Number.isFinite(number)) || !Number.isFinite(widths[index]) || !Number.isFinite(heights[index]) || widths[index] <= 0 || heights[index] <= 0) {
      throw new TypeError('真实打印层存在无效路径或截面，无法完整显示。');
    }
    // The parser's perpendicular basis is left-handed. A circular bead is
    // unchanged by reversing that diameter, while positive determinants avoid
    // inverted Three.js instance normals and unsupported negative instance scale.
    if (matrix.determinant() < 0) {
      const offset = index * 16;
      for (let axis = 0; axis < 3; axis++) instance.matrices[offset + axis] *= -1;
    }
  }
  return {
    version: 1, source: 'sliced-gcode', exactLinearPaths: true,
    coordinates: 'explicit-source-affine', printerCoordinates: 'printer-mm-z-up',
    printerToSource: Float64Array.from(mapping.elements),
    layerIndex, heightMm: instance.heightMm, historyLayers, infillDepthMm,
    includeSupport, includeOuterWall, historicalOuterWall, historicalInnerWall,
    instanceCount: count, sourceSegmentCount: parsed.segmentCount,
    matrices: instance.matrices, segments: instance.segments, tools: instance.tools,
    features: instance.features, positions, widths, heights, layers, strokes, sectionRatios, depths,
    palette, colorIndices, roleCounts, arcToleranceMm: parsed.arcToleranceMm,
    crossSection: { shape: 'stadium-with-elliptical-fallback', semiSteps: 6, flatContact: true, approximate: true, fallbacks: crossSectionFallbacks },
  };
}

export function printLayerPacketTransferables(packet) {
  return ['printerToSource', 'matrices', 'segments', 'tools', 'features', 'positions', 'widths', 'heights', 'layers', 'strokes', 'colorIndices', 'sectionRatios', 'depths'].map(key => packet[key].buffer);
}

export class PrintLayerRenderer {
  constructor(parsed, {
    printerToSource, toolColors, historyLayers = 3, infillDepthMm = 0,
    includeOuterWall = true, historicalOuterWall = true, historicalInnerWall = true, prepareMaterial = material => material,
  } = {}) {
    this.data = validatePrintLayerData(parsed);
    this.printerToSource = validatePrintLayerMapping(printerToSource);
    this.palette = resolvePrintLayerPalette(parsed, toolColors);
    if (!Number.isInteger(historyLayers) || historyLayers < 1 || historyLayers > parsed.layerHeights.length + 1) throw new RangeError('真实打印层的历史显示范围无效。');
    if (infillDepthMm !== undefined && (!Number.isFinite(infillDepthMm) || infillDepthMm < 0)) throw new RangeError('真实打印层的填充深度必须是非负数。');
    this.historyLayers = historyLayers;
    this.infillDepthMm = Number.isFinite(infillDepthMm) ? infillDepthMm : 0;
    this.includeOuterWall = includeOuterWall !== false;
    this.historicalOuterWall = historicalOuterWall !== false;
    this.historicalInnerWall = historicalInnerWall !== false;
    this.prepareMaterial = prepareMaterial;
    this.root = new THREE.Group();
    this.root.name = '真实切片表面';
    this.root.userData = { growthPrintLayer: true, growthTransient: true };
    this.geometry = createStadiumGeometry(12);
    this.meshes = new Map();
    this.packet = null;
    this._key = null;
    this.root.visible = false;
  }

  update(progress, options = {}) {
    const state = printLayerProgressState(this.data, progress);
    const includeSupport = options.includeSupport === true;
    const includeOuterWall = options.includeOuterWall ?? this.includeOuterWall;
    const historicalOuterWall = options.historicalOuterWall ?? this.historicalOuterWall;
    const historicalInnerWall = options.historicalInnerWall ?? this.historicalInnerWall;
    const infillDepthMm = options.infillDepthMm ?? this.infillDepthMm;
    const historyLayers = options.historyLayers ?? this.historyLayers;
    const colors = resolvePrintLayerPalette(this.data, { ...this.palette, ...(options.toolColors || {}) });
    const preserve = options.preserveMaterials !== false;
    const colorKey = colors.map((color, tool) => `${tool}:${color}`).join('|');
    const key = `${state.layerIndex}/${historyLayers}/${infillDepthMm}/${historicalOuterWall}/${historicalInnerWall}/${includeSupport}/${includeOuterWall}/${colorKey}`;
    if (key !== this._key) {
      const packet = buildPrintLayerPacket(this.data, {
        layerIndex: state.layerIndex, historyLayers, infillDepthMm,
        includeSupport, includeOuterWall, historicalOuterWall, historicalInnerWall,
        printerToSource: this.printerToSource, toolColors: colors,
      });
      const byTool = new Map();
      for (let index = 0; index < packet.instanceCount; index++) {
        const tool = packet.tools[index];
        if (!byTool.has(tool)) byTool.set(tool, []);
        byTool.get(tool).push(index);
      }
      for (const [tool, mesh] of this.meshes) if (!byTool.has(tool)) { mesh.visible = false; mesh.count = 0; }
      const matrix = new THREE.Matrix4();
      for (const [tool, indices] of byTool) {
        let mesh = this.meshes.get(tool);
        if (!mesh || mesh.instanceMatrix.count < indices.length) {
          if (mesh) { mesh.removeFromParent(); mesh.dispose(); mesh.geometry.dispose(); mesh.material.dispose(); mesh.customDepthMaterial?.dispose(); }
          const material = installPrintLayerDepthLighting(installSupportLayerFilter(installStadiumExtrusion(this.prepareMaterial(new THREE.MeshStandardMaterial({ color: colors[tool], roughness: 0.64, metalness: 0, side: THREE.DoubleSide })))));
          material.userData.printToolIndex = tool;
          const geometry = this.geometry.clone();
          geometry.setAttribute('instanceBeadRatio', new THREE.InstancedBufferAttribute(new Float32Array(indices.length), 1));
          geometry.setAttribute('instanceFeature', new THREE.InstancedBufferAttribute(new Float32Array(indices.length), 1));
          geometry.setAttribute('instanceDepth', new THREE.InstancedBufferAttribute(new Float32Array(indices.length), 1));
          mesh = new THREE.InstancedMesh(geometry, material, indices.length);
          mesh.customDepthMaterial = stadiumDepthMaterial(material);
          mesh.name = `真实墙与填充 · 耗材 ${tool + 1}`;
          mesh.userData = { growthPrintLayer: true, growthTransient: true, printToolIndex: tool };
          mesh.castShadow = mesh.receiveShadow = true;
          mesh.frustumCulled = false;
          mesh.renderOrder = 12;
          this.meshes.set(tool, mesh);
          this.root.add(mesh);
        }
        for (let index = 0; index < indices.length; index++) {
          mesh.setMatrixAt(index, matrix.fromArray(packet.matrices, indices[index] * 16));
          mesh.geometry.attributes.instanceBeadRatio.array[index] = packet.sectionRatios[indices[index]];
          mesh.geometry.attributes.instanceFeature.array[index] = packet.features[indices[index]];
          mesh.geometry.attributes.instanceDepth.array[index] = packet.depths ? packet.depths[indices[index]] : 0;
        }
        mesh.geometry.attributes.instanceBeadRatio.needsUpdate = true;
        mesh.geometry.attributes.instanceFeature.needsUpdate = true;
        mesh.geometry.attributes.instanceDepth.needsUpdate = true;
        mesh.instanceMatrix.needsUpdate = true;
        mesh.count = indices.length; mesh.visible = true;
      }
      this.packet = packet;
      this._key = key;
    }
    for (const [tool, mesh] of this.meshes) {
      mesh.material.color.set(preserve ? colors[tool] : options.color || '#b7bec8');
      const profile = resolveFDMSurfaceProfile(options.surfacePreset || 'auto', options.materialProfiles?.find(item => item.tool === tool)?.profile || 'pla');
      mesh.material.roughness = profile.roughness;
      mesh.material.metalness = 0;
      const filter = mesh.material.userData.supportLayerFilter;
      const filterValue = options.printNormalFilter === 'none' ? 0 : 1;
      filter.mode = filterValue ? 'analytic' : 'none';
      if (filter.enabled.value !== filterValue) { filter.enabled.value = filterValue; mesh.material.needsUpdate = true; }
    }
    this.root.visible = !state.empty && (!state.complete || options.keepCompleteLayers === true) && this.packet.instanceCount > 0;
    this.state = { ...state, instanceCount: this.root.visible ? this.packet.instanceCount : 0 };
    return this.state;
  }

  /** Detached packet creation does not move or recolor the live preview. */
  exportPacket(options = {}) {
    const state = printLayerProgressState(this.data, options.progress ?? this.state?.progress ?? 0);
    return buildPrintLayerPacket(this.data, {
      layerIndex: options.layerIndex ?? state.layerIndex,
      historyLayers: options.historyLayers ?? this.historyLayers,
      infillDepthMm: options.infillDepthMm ?? this.infillDepthMm,
      includeSupport: options.includeSupport === true,
      includeOuterWall: options.includeOuterWall ?? this.includeOuterWall,
      historicalOuterWall: options.historicalOuterWall ?? this.historicalOuterWall,
      historicalInnerWall: options.historicalInnerWall ?? this.historicalInnerWall,
      printerToSource: this.printerToSource,
      toolColors: resolvePrintLayerPalette(this.data, { ...this.palette, ...(options.toolColors || {}) }),
    });
  }

  dispose() {
    this.root.removeFromParent();
    for (const mesh of this.meshes.values()) { mesh.dispose(); mesh.geometry.dispose(); mesh.material.dispose(); mesh.customDepthMaterial?.dispose(); }
    this.geometry.dispose(); this.root.clear(); this.meshes.clear(); this.packet = null;
  }
}

/** Each historical support segment keeps its actual physical WIDTH. Three's
 * continuous analytic line raster is a rendering approximation of the section,
 * while source endpoints, layer Z, tools, roles and segment counts stay exact. */
export function installPrintLineWidth(material) {
  const before = material.onBeforeCompile, key = material.customProgramCacheKey.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    before.call(material, shader, renderer);
    shader.vertexShader = shader.vertexShader
      .replace('uniform float linewidth;', 'uniform float linewidth;\nattribute float instancePrintWidth;\nvarying float vPrintLinewidth;')
      .replace('void main() {', 'void main() {\nfloat printLinewidth = linewidth * instancePrintWidth;\nvPrintLinewidth = printLinewidth;')
      .replace(/float hw = linewidth \* 0\.5;/g, 'float hw = printLinewidth * 0.5;')
      .replace(/offset \*= linewidth;/g, 'offset *= printLinewidth;');
    shader.fragmentShader = shader.fragmentShader
      .replace('uniform float linewidth;', 'uniform float linewidth;\nvarying float vPrintLinewidth;')
      .replace(/float norm = len \/ linewidth;/g, 'float norm = len / vPrintLinewidth;');
  };
  material.customProgramCacheKey = () => `${key()}|exact-print-width-v1`;
  material.needsUpdate = true;
  return material;
}

function prefixLayers(layers, limit) {
  let low = 0, high = layers.length;
  while (low < high) { const mid = (low + high) >>> 1; if (layers[mid] < limit) low = mid + 1; else high = mid; }
  return low;
}

/** Complete indexed supports. No old 2M limit, RDP or random path sampling.
 * Stable per-tool layer prefixes make animation O(tool count), independent of
 * millions of deposited paths. Current bead layers are owned by PrintLayerRenderer.
 * A resource allocation failure throws and leaves the caller's prior state intact. */
export class IndexedSupportRenderer {
  constructor(parsed, {
    printerToSource, toolColors, prepareMaterial = material => material,
    createShadow = null,
  } = {}) {
    this.data = validatePrintLayerData(parsed);
    this.printerToSource = validatePrintLayerMapping(printerToSource);
    this.palette = resolvePrintLayerPalette(parsed, toolColors);
    this.root = new THREE.Group();
    this.root.name = '全部真实切片支撑';
    this.root.userData = { isSupport: true, growthTransient: true, growthPrintLayer: true };
    this.root.matrix.copy(this.printerToSource); this.root.matrixAutoUpdate = false;
    this.records = new Map(); this.bounds = new THREE.Box3(); this.segmentCount = 0;
    this.crossSectionToleranceMm = 0.02;
    const counts = new Map(), cursors = new Map();
    const supported = feature => feature === 10 || feature === 11;
    for (let index = 0; index < parsed.segmentCount; index++) if (supported(parsed.features[index])) {
      const tool = parsed.tools[index]; counts.set(tool, (counts.get(tool) || 0) + 1); this.segmentCount++;
    }
    if (!this.segmentCount) throw new Error('切片中没有真实支撑或支撑接触层路径。');
    try {
      for (const [tool, count] of counts) {
        this.records.set(tool, { tool, sourceIds: new Uint32Array(count), positions: new Float32Array(count * 6), widths: new Float32Array(count), layers: new Uint32Array(count) });
        cursors.set(tool, 0);
      }
      let maxSectionHeight = 0;
      for (let index = 0; index < parsed.layerSegments.length; index++) {
        const source = parsed.layerSegments[index];
        if (!supported(parsed.features[source])) continue;
        const tool = parsed.tools[source], target = cursors.get(tool), record = this.records.get(tool);
        record.sourceIds[target] = source; record.widths[target] = parsed.widths[source]; record.layers[target] = parsed.layers[source];
        const height = parsed.heights[source], from = source * 6, to = target * 6;
        maxSectionHeight = Math.max(maxSectionHeight, height);
        record.positions.set(parsed.positions.subarray(from, from + 6), to);
        record.positions[to + 2] -= height / 2; record.positions[to + 5] -= height / 2;
        cursors.set(tool, target + 1);
      }
      const radius = maxSectionHeight / 2;
      this.semiSteps = Math.max(4, radius > this.crossSectionToleranceMm
        ? Math.ceil(Math.PI / (2 * Math.acos(1 - this.crossSectionToleranceMm / radius))) : 4);
      this.radialSegments = this.semiSteps * 2;
      this.maximumCrossSectionErrorMm = radius * (1 - Math.cos(Math.PI / (this.semiSteps * 2)));
      this.solidGeometry = createStadiumGeometry(this.semiSteps);
      this.surfaceTriangles = this.segmentCount * this.solidGeometry.index.count / 3;
      if (this.semiSteps > 64 || this.surfaceTriangles > 200_000_000) throw new RangeError('完整实体支撑超过 2 亿显示面预算，不能删减或降低精度；请保留完整路径模式或缩小源工程。');
      for (const [tool, record] of this.records) {
        const geometry = new LineSegmentsGeometry().setPositions(record.positions);
        record.geometry = geometry;
        geometry.setAttribute('instancePrintWidth', new THREE.InstancedBufferAttribute(record.widths, 1));
        this.bounds.union(geometry.boundingBox);
        const material = installPrintLineWidth(new LineMaterial({ color: this.palette[tool], linewidth: 1, worldUnits: true, alphaToCoverage: true }));
        record.material = material;
        prepareMaterial(material);
        const line = new LineSegments2(geometry, material);
        line.name = `完整连续支撑 · 耗材 ${tool + 1}`;
        line.userData = { isSupport: true, growthTransient: true, growthPrintLayer: true };
        line.frustumCulled = false; line.renderOrder = 11;
        record.line = line; this.root.add(line);
        record.shadow = createShadow ? createShadow(line, parsed, record.sourceIds)
          : new THREE.InstancedMesh(this.solidGeometry, new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }), record.sourceIds.length);
        if (!createShadow) {
          let count = 0;
          record.shadow.onBeforeRender = () => { if (!record.shadow.userData.solidSupport) { count = record.shadow.count; record.shadow.count = 0; } };
          record.shadow.onAfterRender = () => { if (!record.shadow.userData.solidSupport) record.shadow.count = count; };
          line.add(record.shadow);
        } else record.shadow.geometry.dispose();
        record.surfaceGeometry = this.solidGeometry.clone();
        record.surfaceGeometry.setAttribute('instanceBeadRatio', new THREE.InstancedBufferAttribute(new Float32Array(record.sourceIds.length), 1));
        record.shadow.geometry = record.surfaceGeometry;
        record.shadow.castShadow = record.shadow.receiveShadow = true;
        record.shadow.frustumCulled = false;
        record.shadow.name = `完整闭合支撑实体 · 耗材 ${tool + 1}`;
        record.shadow.userData.growthTransient = record.shadow.userData.growthPrintLayer = true;
        record.shadowMaterial = record.shadow.material;
        record.solidMaterial = installSupportLayerFilter(installStadiumExtrusion(new THREE.MeshStandardMaterial({ color: this.palette[tool], roughness: .64, metalness: 0, side: THREE.DoubleSide }))); 
        prepareMaterial(record.solidMaterial);
        record.depthMaterial = stadiumDepthMaterial(record.solidMaterial);
        record.shadow.customDepthMaterial = record.depthMaterial;
        const matrices = record.shadow.instanceMatrix.array;
        for (let index = 0; index < record.sourceIds.length; index++) {
          const segment = record.sourceIds[index], offset = segment * 6, target = index * 16;
          const ax = parsed.positions[offset], ay = parsed.positions[offset + 1], az = parsed.positions[offset + 2];
          const bx = parsed.positions[offset + 3], by = parsed.positions[offset + 4], bz = parsed.positions[offset + 5];
          const dx = bx - ax, dy = by - ay, dz = bz - az, length = Math.hypot(dx, dy);
          const width = parsed.widths[segment], height = parsed.heights[segment];
          record.surfaceGeometry.attributes.instanceBeadRatio.array[index] = printBeadRatio(width, height, parsed.features[segment]);
          if (!Number.isFinite(length) || length <= 0) throw new TypeError('支撑路径存在无效平面长度，不能省略。');
          // Right-handed printer-space basis: exact WIDTH, actual path length,
          // and HEIGHT. Top of each closed bead is the source deposited Z.
          matrices[target] = dy / length * width; matrices[target + 1] = -dx / length * width;
          matrices[target + 2] = matrices[target + 3] = 0;
          matrices[target + 4] = dx; matrices[target + 5] = dy; matrices[target + 6] = dz; matrices[target + 7] = 0;
          matrices[target + 8] = matrices[target + 9] = 0; matrices[target + 10] = height; matrices[target + 11] = 0;
          matrices[target + 12] = (ax + bx) / 2; matrices[target + 13] = (ay + by) / 2;
          matrices[target + 14] = (az + bz) / 2 - height / 2; matrices[target + 15] = 1;
        }
        record.shadow.instanceMatrix.needsUpdate = true;
        record.surfaceGeometry.attributes.instanceBeadRatio.needsUpdate = true;
      }
      // Centreline bounds include the real width for lighting/camera footprints,
      // never to fit the support geometry onto the CAD model.
      let maxWidth = 0;
      for (const record of this.records.values()) for (const width of record.widths) maxWidth = Math.max(maxWidth, width);
      this.bounds.expandByScalar(maxWidth / 2);
    } catch (error) { this.dispose(); throw new Error(`完整支撑无法分配显示资源，未删减任何路径：${error.message}`); }
    this.root.visible = false;
  }

  update(progress, {
    showSupports = true, historyLayers = 0, widthScale = 1,
    toolColors = {}, preserveMaterials = true, color = '#b7bec8',
    supportDisplay = 'solid', surfacePreset = 'auto', materialProfiles = [], supportNormalFilter = 'analytic',
  } = {}) {
    const state = printLayerProgressState(this.data, progress);
    const visibleLayers = state.complete ? this.data.layerHeights.length : Math.max(0, state.visibleLayerCount - historyLayers);
    let count = 0;
    for (const [tool, record] of this.records) {
      const active = prefixLayers(record.layers, visibleLayers);
      record.geometry.instanceCount = active;
      if (record.shadow) record.shadow.count = active;
      record.material.linewidth = widthScale;
      const chosenColor = preserveMaterials ? toolColors[tool] || this.palette[tool] : color;
      record.material.color.set(chosenColor); record.solidMaterial.color.set(chosenColor);
      const profile = resolveFDMSurfaceProfile(surfacePreset, materialProfiles.find(item => item.tool === tool)?.profile || 'pla');
      record.solidMaterial.roughness = profile.roughness; record.solidMaterial.metalness = 0;
      const filter = record.solidMaterial.userData.supportLayerFilter;
      filter.mode = supportNormalFilter === 'analytic' ? 'analytic' : 'none';
      const filterValue = filter.mode === 'analytic' ? 1 : 0;
      if (filter.enabled.value !== filterValue) { filter.enabled.value = filterValue; record.solidMaterial.needsUpdate = true; }
      const solid = supportDisplay !== 'paths';
      record.material.visible = !solid;
      record.shadow.userData.solidSupport = solid;
      record.shadow.material = solid ? record.solidMaterial : record.shadowMaterial;
      count += active;
    }
    this.root.visible = showSupports !== false && !state.empty && count > 0;
    this.state = { ...state, visibleLayers, visibleSegments: this.root.visible ? count : 0, supportNormalFilter: supportNormalFilter === 'analytic' ? 'analytic' : 'none' };
    return this.state;
  }

  setResolution(width, height) {
    for (const record of this.records.values()) record.material.resolution.set(width, height);
  }

  dispose() {
    this.root.removeFromParent();
    for (const record of this.records.values()) {
      if (record.shadow?.geometry !== this.solidGeometry) record.shadow?.geometry?.dispose();
      record.shadowMaterial?.dispose(); record.solidMaterial?.dispose(); record.shadow?.dispose();
      record.depthMaterial?.dispose();
      record.geometry?.dispose(); record.material?.dispose();
    }
    this.root.clear(); this.records.clear();
    this.solidGeometry?.dispose();
  }
}
