import * as THREE from 'three';
import { bindSurfaceFootprintScale } from './surface-footprint.js';
import { DEFAULT_LAYER_HEIGHT_MM, DEFAULT_FIRST_LAYER_HEIGHT_MM, DEFAULT_LAYER_HEIGHT_POLICY } from './slice-settings.js';

// Finish approximations for nonmetallic FDM filament. They are not measured
// BRDFs. Imported colors are never modified by this surface treatment.
export const FDM_SURFACE_PROFILES = Object.freeze({
  pla: Object.freeze({ roughness: 0.64, beadDepth: 0.04, grain: 0.035 }),
  matte: Object.freeze({ roughness: 0.88, beadDepth: 0.025, grain: 0.055 }),
  silk: Object.freeze({ roughness: 0.30, beadDepth: 0.055, grain: 0.015 }),
  petg: Object.freeze({ roughness: 0.38, beadDepth: 0.045, grain: 0.022 }),
});
const profiles = new Set(Object.keys(FDM_SURFACE_PROFILES));
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const finite = (value, fallback) => Number.isFinite(Number(value)) && value !== null && value !== '' ? Number(value) : fallback;

export function inferFilamentProfile({ type = '', name = '' } = {}) {
  const text = `${type} ${name}`.toLowerCase();
  if (/matte|matt\b|哑光|亞光|亚光/.test(text)) return 'matte';
  if (/silk|丝绸|絲綢/.test(text)) return 'silk';
  if (/petg|pet-g/.test(text)) return 'petg';
  return 'pla';
}

export function resolveFDMSurfaceProfile(preset = 'auto', materialProfile = 'pla') {
  const key = preset === 'auto' ? materialProfile : preset;
  const name = profiles.has(key) ? key : 'pla';
  return { name, ...FDM_SURFACE_PROFILES[name], metalness: 0 };
}

/** Read nominal physical print settings; absent dimensions are explicitly estimated. */
export function parseFDMSlicerSettings(project = {}, colorCount = 0) {
  const list = value => Array.isArray(value) ? value : String(value ?? '').split(';');
  const millimetres = (value, min, max) => {
    for (const item of list(value)) {
      if (!/^\s*\d*\.?\d+(?:e[+-]?\d+)?\s*(?:mm)?\s*$/i.test(String(item))) continue;
      const parsed = parseFloat(item);
      if (Number.isFinite(parsed) && parsed >= min && parsed <= max) return parsed;
    }
    return null;
  };
  const layer = millimetres(project.layer_height, 0.01, 2);
  const first = millimetres(project.initial_layer_print_height ?? project.first_layer_height, 0.01, 2);
  let width = millimetres(project.line_width, 0.05, 5);
  if (width === null) width = millimetres(project.outer_wall_line_width ?? project.external_perimeter_extrusion_width, 0.05, 5);
  const nozzle = millimetres(project.nozzle_diameter, 0.05, 3);
  if (width === null && nozzle !== null) {
    const percentage = String(list(project.line_width)[0]).match(/^\s*(\d+(?:\.\d+)?)\s*%\s*$/);
    const computed = percentage ? nozzle * Number(percentage[1]) / 100 : 0;
    if (computed >= 0.05 && computed <= 5) width = computed;
  }
  const types = list(project.filament_type), names = list(project.filament_name ?? project.filament_settings_id);
  const count = Math.max(colorCount, types.filter(Boolean).length, names.filter(Boolean).length);
  const materialProfiles = Array.from({ length: count }, (_, tool) => {
    const type = String(types[tool] ?? (types.length === 1 ? types[0] : '') ?? '').trim();
    const name = String(names[tool] ?? (names.length === 1 ? names[0] : '') ?? '').trim();
    return { tool, type, name, profile: inferFilamentProfile({ type, name }), inferred: !/pla|pet[- ]?g|matte|matt\b|silk|哑光|亚光|絲綢|丝绸/i.test(`${type} ${name}`) };
  });
  return {
    layerHeightMm: layer ?? DEFAULT_LAYER_HEIGHT_MM,
    firstLayerHeightMm: first ?? DEFAULT_FIRST_LAYER_HEIGHT_MM,
    lineWidthMm: width ?? 0.42,
    surfaceSettingsInferred: { layerHeight: layer === null, firstLayerHeight: first === null, lineWidth: width === null },
    surfaceSettingSources: {
      layerHeight: layer === null ? { source: 'studio-default', defaultPolicy: DEFAULT_LAYER_HEIGHT_POLICY } : { source: 'project' },
      firstLayerHeight: { source: first === null ? 'bambu-default' : 'project' },
      lineWidth: { source: width === null ? 'bambu-default' : 'project' },
    },
    materialProfiles,
    surfaceApproximate: true,
  };
}

export function fdmLayerVisibility(mmPerPixel, layerHeightMm = DEFAULT_LAYER_HEIGHT_MM) {
  const cycles = Math.max(0, finite(mmPerPixel, Infinity)) / Math.max(0.01, finite(layerHeightMm, DEFAULT_LAYER_HEIGHT_MM));
  const t = clamp((cycles - 0.15) / 0.35, 0, 1);
  return 1 - t * t * (3 - 2 * t);
}

export function createFDMSurfaceUniforms(options = {}) {
  const uniforms = {
    fdmPrintMatrix: { value: new THREE.Matrix4() },
    fdmLayerHeight: { value: DEFAULT_LAYER_HEIGHT_MM }, fdmFirstLayerHeight: { value: DEFAULT_FIRST_LAYER_HEIGHT_MM }, fdmLineWidth: { value: 0.42 },
    fdmDetail: { value: 0.6 }, fdmBeadDepth: { value: 0.04 },
    fdmGrain: { value: 0.035 }, fdmTopOnly: { value: 0 },
    fdmFootprintScale: { value: 1 },
  };
  updateFDMSurfaceUniforms(uniforms, options);
  return uniforms;
}

export function updateFDMSurfaceUniforms(uniforms, options = {}) {
  const profile = resolveFDMSurfaceProfile(options.surfacePreset ?? 'auto', options.materialProfile ?? 'pla');
  uniforms.fdmLayerHeight.value = clamp(finite(options.layerHeightMm, uniforms.fdmLayerHeight.value), 0.01, 2);
  if (options.firstLayerHeightMm !== undefined) uniforms.fdmFirstLayerHeight.value = clamp(finite(options.firstLayerHeightMm, 0), 0, 2);
  uniforms.fdmLineWidth.value = clamp(finite(options.lineWidthMm, uniforms.fdmLineWidth.value), 0.05, 5);
  uniforms.fdmDetail.value = clamp(finite(options.surfaceDetail, uniforms.fdmDetail.value), 0, 1);
  uniforms.fdmBeadDepth.value = profile.beadDepth;
  uniforms.fdmGrain.value = profile.grain;
  if (options.topSurface !== undefined) uniforms.fdmTopOnly.value = options.topSurface ? 1 : 0;
  if (options.printMatrix?.isMatrix4) uniforms.fdmPrintMatrix.value.copy(options.printMatrix);
  else if (Array.isArray(options.printMatrix) && options.printMatrix.length === 16 && options.printMatrix.every(Number.isFinite)) uniforms.fdmPrintMatrix.value.fromArray(options.printMatrix);
  return profile;
}

const vertexDeclarations = /* glsl */`
uniform mat4 fdmPrintMatrix;
varying vec3 vFDMPrintPosition;
`;
const vertexPosition = /* glsl */`
// fdmPrintMatrix maps world positions into the imported printer's millimetres.
// Y is printing height. Undoing the user's pose locks the texture to the object.
vec4 fdmSurfaceWorld = vec4( transformed, 1.0 );
#ifdef USE_BATCHING
  fdmSurfaceWorld = batchingMatrix * fdmSurfaceWorld;
#endif
#ifdef USE_INSTANCING
  fdmSurfaceWorld = instanceMatrix * fdmSurfaceWorld;
#endif
vFDMPrintPosition = ( fdmPrintMatrix * modelMatrix * fdmSurfaceWorld ).xyz;
`;

export const FDM_SURFACE_GLSL = /* glsl */`
uniform float fdmLayerHeight;
uniform float fdmFirstLayerHeight;
uniform float fdmLineWidth;
uniform float fdmDetail;
uniform float fdmBeadDepth;
uniform float fdmGrain;
uniform float fdmTopOnly;
uniform float fdmFootprintScale;
varying vec3 vFDMPrintPosition;

float fdmFrequencyVisibility( float cyclesPerPixel ) {
  // Fade before the Nyquist boundary, rather than drawing unresolved black bands.
  return 1.0 - smoothstep( 0.15, 0.5, cyclesPerPixel * fdmFootprintScale );
}
vec3 fdmSurfaceGradient( vec3 p, vec3 dx, vec3 dy ) {
  vec3 printNormal = normalize( cross( dx, dy ) );
  float top = smoothstep( 0.72, 0.94, abs( printNormal.y ) );
  top = mix( top, 1.0, fdmTopOnly );
  float firstHeight = fdmFirstLayerHeight > 0.0 ? fdmFirstLayerHeight : fdmLayerHeight;
  float localHeight = p.y < firstHeight ? firstHeight : fdmLayerHeight;
  float layerCoordinate = p.y < firstHeight ? p.y : p.y - firstHeight;
  float layerPhase = 6.28318530718 * layerCoordinate / localHeight;
  float sideVisibility = fdmFrequencyVisibility( ( abs( dx.y ) + abs( dy.y ) ) / localHeight );
  float sideSlope = -6.28318530718 * fdmBeadDepth * sin( layerPhase ) * sideVisibility * ( 1.0 - top );
  // Parallel top grooves are an APPROXIMATE surface finish, not a slicer's
  // actual perimeter/infill path. Their direction stays in printing XZ space.
  vec3 grooveDirection = vec3( 0.70710678, 0.0, 0.70710678 );
  float groove = dot( p, grooveDirection ) / fdmLineWidth;
  float grooveVisibility = fdmFrequencyVisibility( ( abs( dot( dx, grooveDirection ) ) + abs( dot( dy, grooveDirection ) ) ) / fdmLineWidth );
  float topSlope = -0.10 * sin( 6.28318530718 * groove ) * grooveVisibility * top;
  return fdmDetail * ( vec3( 0.0, sideSlope, 0.0 ) + grooveDirection * topSlope );
}
vec3 fdmPerturbNormal( vec3 n, vec3 printGradient, vec3 printDx, vec3 printDy ) {
  if ( fdmDetail <= 0.0 ) return n;
  vec3 viewDx = dFdx( -vViewPosition );
  vec3 viewDy = dFdy( -vViewPosition );
  // Convert a physical mm displacement into view-space units. This ratio
  // includes the model's uniform display scale, so bump strength stays correct
  // when its size changes rather than accidentally becoming millimetres/world.
  float mmToView = sqrt( ( dot( viewDx, viewDx ) + dot( viewDy, viewDy ) ) / max( dot( printDx, printDx ) + dot( printDy, printDy ), 1e-12 ) );
  float dhdx = dot( printGradient, printDx ) * mmToView;
  float dhdy = dot( printGradient, printDy ) * mmToView;
  vec3 r1 = cross( viewDy, n );
  vec3 r2 = cross( n, viewDx );
  float determinant = dot( viewDx, r1 );
  if ( abs( determinant ) < 1e-12 ) return n;
  return normalize( abs( determinant ) * n - sign( determinant ) * ( dhdx * r1 + dhdy * r2 ) );
}
float fdmRoughnessVariation( vec3 p, vec3 dx, vec3 dy ) {
  vec3 frequency = vec3( 31.7, 47.3, 29.9 );
  float phase = dot( p, frequency );
  float visible = fdmFrequencyVisibility( ( abs( dot( dx, frequency ) ) + abs( dot( dy, frequency ) ) ) / 6.28318530718 );
  return fdmDetail * fdmGrain * sin( phase ) * visible;
}
`;

export function injectFDMSurfaceShader(shader, uniforms) {
  Object.assign(shader.uniforms, uniforms);
  // A cloned material can inherit a pre-existing hook. Rebind its uniforms,
  // but do not insert duplicate varying declarations or surface functions.
  if (shader.fragmentShader.includes('vec3 fdmSurfaceGradient(') || shader.fragmentShader.includes('vec3 fdmSurfaceGradient( ')) return shader;
  if (!shader.vertexShader.includes('#include <project_vertex>') || !shader.fragmentShader.includes('varying vec3 vViewPosition;') || !shader.fragmentShader.includes('#include <common>') || !shader.fragmentShader.includes('#include <normal_fragment_maps>') || !shader.fragmentShader.includes('#include <roughnessmap_fragment>')) {
    throw new Error('此材质着色器不支持 FDM 表面细节，请保留原材质。');
  }
  shader.vertexShader = vertexDeclarations + shader.vertexShader.replace('#include <project_vertex>', vertexPosition + '\n#include <project_vertex>');
  // Standard/physical shaders declare vViewPosition before their common chunk.
  // The derivative helper must appear after that declaration, not before it.
  shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\n' + FDM_SURFACE_GLSL);
  shader.fragmentShader = shader.fragmentShader.replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
if ( fdmDetail > 0.0 ) roughnessFactor = clamp( roughnessFactor + fdmRoughnessVariation( vFDMPrintPosition, dFdx( vFDMPrintPosition ), dFdy( vFDMPrintPosition ) ), 0.05, 0.98 );`);
  shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
vec3 fdmPrintDx = dFdx( vFDMPrintPosition );
vec3 fdmPrintDy = dFdy( vFDMPrintPosition );
normal = fdmPerturbNormal( normal, fdmSurfaceGradient( vFDMPrintPosition, fdmPrintDx, fdmPrintDy ), fdmPrintDx, fdmPrintDy );`);
  return shader;
}

const installed = new WeakMap();
/** Install on intentionally FDM materials only; preserve supplied GLB/FBX PBR. */
export function installFDMSurface(material, options = {}) {
  if (!material?.isMeshStandardMaterial) throw new TypeError('FDM 表面需要标准或物理网格材质。');
  if (installed.has(material)) { const handle = installed.get(material); handle.update(options); return handle; }
  const previousCompile = material.onBeforeCompile;
  const previousKey = material.customProgramCacheKey;
  const uniforms = createFDMSurfaceUniforms({ ...options, materialProfile: options.materialProfile ?? material.userData.fdmProfile ?? 'pla' });
  bindSurfaceFootprintScale(material, uniforms.fdmFootprintScale);
  let state = { ...options, materialProfile: options.materialProfile ?? material.userData.fdmProfile ?? 'pla' };
  const handle = { uniforms, update(values = {}) {
    state = { ...state, ...values };
    const profile = updateFDMSurfaceUniforms(uniforms, state);
    material.roughness = profile.roughness; material.metalness = 0;
    material.userData.fdmSurfaceApproximate = true;
    return profile;
  } };
  material.onBeforeCompile = function(shader, renderer) { previousCompile.call(this, shader, renderer); injectFDMSurfaceShader(shader, uniforms); };
  material.customProgramCacheKey = function() { return `${previousKey.call(this)}|fdm-mm-surface-v2`; };
  installed.set(material, handle); handle.update(); material.needsUpdate = true;
  return handle;
}
