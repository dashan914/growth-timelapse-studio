import * as THREE from 'three';
import { surfaceFootprintScale } from './surface-footprint.js';

/** Two proxy triangles per recorded extrusion. The fragment shader intersects
 * its finite, closed cross-section rather than shading a camera-facing line.
 * Source paths, layer height and width are never simplified or resliced. */
export function createPrintPathGeometry(lineGeometry, { heights, features, ratios, roughness, supportMask, roles } = {}) {
  const start = lineGeometry.getAttribute('instanceStart');
  const end = lineGeometry.getAttribute('instanceEnd');
  const width = lineGeometry.getAttribute('instancePrintWidth');
  if (!start || !end || !width || start.count !== end.count || width.count !== start.count) throw new TypeError('完整打印路径需要等长的起点、终点和真实宽度属性。');
  const count = start.count;
  if (!heights?.isBufferAttribute && !(heights instanceof Float32Array)) throw new TypeError('完整打印路径需要逐段真实层高。');
  const height = heights?.isBufferAttribute ? heights : new THREE.InstancedBufferAttribute(heights, 1);
  if (!(height.array instanceof Float32Array) || height.count !== count) throw new TypeError('完整打印路径需要逐段真实层高。');
  let ratio = ratios?.isBufferAttribute ? ratios : ratios ? new THREE.InstancedBufferAttribute(ratios, 1) : null;
  if (!ratio) {
    const values = new Float32Array(count);
    for (let index = 0; index < count; index++) {
      const w = width.getX(index), h = height.getX(index);
      if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) throw new RangeError('打印挤出宽度和层高必须大于零。');
      values[index] = features?.[index] === 7 || w < h ? 1 : h / w;
    }
    ratio = new THREE.InstancedBufferAttribute(values, 1);
  }
  if (ratio.count !== count) throw new TypeError('打印截面属性数量不一致。');
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setIndex([0, 1, 2, 2, 1, 3]);
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([-1,-1,0, 1,-1,0, -1,1,0, 1,1,0], 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute([0,0,1, 0,0,1, 0,0,1, 0,0,1], 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0,0, 1,0, 0,1, 1,1], 2));
  for (const name of ['instanceStart', 'instanceEnd', 'instancePrintWidth', 'instanceColorStart', 'instanceColorEnd']) {
    const attribute = lineGeometry.getAttribute(name); if (attribute) geometry.setAttribute(name, attribute);
  }
  geometry.setAttribute('instancePrintHeight', height);
  geometry.setAttribute('instanceBeadRatio', ratio);
  let support = supportMask?.isBufferAttribute ? supportMask : supportMask ? new THREE.InstancedBufferAttribute(supportMask, 1) : null;
  if (!support) {
    const values = new Uint8Array(count);
    for (let index = 0; index < count; index++) values[index] = features?.[index] === 10 || features?.[index] === 11 ? 1 : 0;
    support = new THREE.InstancedBufferAttribute(values, 1);
  }
  if (support.count !== count) throw new TypeError('打印支撑属性数量不一致。');
  geometry.setAttribute('instancePrintSupport', support);
  const roleValues = roles || (features instanceof Uint8Array ? features : Uint8Array.from(features || new Uint8Array(count)));
  const role = roleValues.isBufferAttribute ? roleValues : new THREE.InstancedBufferAttribute(roleValues, 1);
  if (role.count !== count) throw new TypeError('打印路径类型属性数量不一致。');
  geometry.setAttribute('instancePrintRole', role);
  if (roughness) {
    const attribute = roughness.isBufferAttribute ? roughness : new THREE.InstancedBufferAttribute(roughness, 1);
    if (attribute.count !== count) throw new TypeError('打印路径粗糙度数量不一致。');
    geometry.setAttribute('instancePrintRoughness', attribute);
  }
  geometry.instanceCount = Math.min(count, Number.isFinite(lineGeometry.instanceCount) ? lineGeometry.instanceCount : count);
  geometry.boundingBox = lineGeometry.boundingBox?.clone() || null;
  geometry.boundingSphere = lineGeometry.boundingSphere?.clone() || null;
  geometry.userData = { printPathImpostor: true, sourceSegmentCount: count, trianglesPerSegment: 2,
    crossSection: 'analytic-finite-stadium-with-elliptical-fallback', sourcePathsUnmodified: true,
    sourceAttributesShared: true, centresAlreadyLoweredByHalfHeight: true };
  return geometry;
}

const VERTEX_PARS = /* glsl */`
attribute vec3 instanceStart;
attribute vec3 instanceEnd;
attribute vec3 instanceColorStart;
attribute vec3 instanceColorEnd;
attribute float instancePrintWidth;
attribute float instancePrintHeight;
attribute float instanceBeadRatio;
attribute float instancePrintRoughness;
attribute float instancePrintSupport;
attribute float instancePrintRole;
uniform float pathHideSupport;
uniform float pathInteraction;
uniform float pathMacroSurface;
uniform float pathLayerFilterEnabled;
uniform vec2 pathViewportSize;
uniform mat4 pathProjectionInverse;
varying vec2 vPathNdc;
varying vec3 vPathCentre;
varying vec3 vPathInverseX;
varying vec3 vPathInverseY;
varying vec3 vPathInverseZ;
varying vec4 vPathSection;
varying float vPathRoughness;
varying float vPathSupport;
varying float vPathRole;
varying vec3 vPathPrintAxisView;
`;

const VERTEX_PROJECT = /* glsl */`
vPathSupport = instancePrintSupport;
vPathRole = instancePrintRole;
// Preview interaction may omit only buried wall/infill roads. Return before
// matrix projection; the original geometry and all final-frame paths remain.
if ((pathHideSupport > 0.5 && instancePrintSupport > 0.5) ||
    (pathMacroSurface > 0.5 && (instancePrintRole >= 1.0 && instancePrintRole <= 4.0 || instancePrintRole == 16.0)) ||
    (pathInteraction > 0.5 && instancePrintRole >= 2.0 && instancePrintRole <= 4.0)) {
  gl_Position = vec4(2.0,2.0,0.0,1.0);
  return;
}
vec3 pathDelta = instanceEnd - instanceStart;
float pathLength = max(length(pathDelta.xy), 0.0000001);
vec3 pathRight = vec3(pathDelta.y, -pathDelta.x, 0.0) / pathLength;
vec3 pathForward = pathDelta / pathLength;
vec3 pathUp = vec3(0.0, 0.0, 1.0);
mat3 pathViewBasis = mat3(modelViewMatrix) * mat3(pathRight, pathForward, pathUp);
vec3 pathViewX = pathViewBasis[0], pathViewY = pathViewBasis[1], pathViewZ = pathViewBasis[2];
float pathDet = dot(pathViewX, cross(pathViewY, pathViewZ));
vPathInverseX = cross(pathViewY, pathViewZ) / pathDet;
vPathInverseY = cross(pathViewZ, pathViewX) / pathDet;
vPathInverseZ = cross(pathViewX, pathViewY) / pathDet;
vPathCentre = (modelViewMatrix * vec4((instanceStart + instanceEnd) * 0.5, 1.0)).xyz;
vPathSection = vec4(instancePrintWidth * 0.5, pathLength * 0.5, instancePrintHeight * 0.5, instanceBeadRatio);
vPathRoughness = instancePrintRoughness;
vPathPrintAxisView = pathViewZ;
// The convex road is bounded by its two rectangular end sections. Project
// only their centres; an analytic perspective bound includes every corner.
vec3 pathExtent = abs(pathViewX)*vPathSection.x + abs(pathViewZ)*vPathSection.z;
vec3 pathEndA = vPathCentre-pathViewY*vPathSection.y;
vec3 pathEndB = vPathCentre+pathViewY*vPathSection.y;
vec4 pathClipA = projectionMatrix*vec4(pathEndA,1.0);
vec4 pathClipB = projectionMatrix*vec4(pathEndB,1.0);
vec2 pathFocal = abs(vec2(projectionMatrix[0][0],projectionMatrix[1][1]));
vec2 pathCentreA = pathClipA.xy/pathClipA.w;
vec2 pathCentreB = pathClipB.xy/pathClipB.w;
vec2 pathHalfA, pathHalfB;
bool pathPerspective = isPerspectiveMatrix(projectionMatrix);
bool pathAcrossCamera = false, pathEntirelyBehind = false;
if (pathPerspective) {
  float pathDepthA = -pathEndA.z, pathDepthB = -pathEndB.z;
  pathAcrossCamera = min(pathDepthA,pathDepthB)-pathExtent.z <= 0.0000001;
  pathEntirelyBehind = max(pathDepthA,pathDepthB)+pathExtent.z <= 0.0000001;
  vec2 pathShift = -projectionMatrix[2].xy;
  pathHalfA = (pathFocal*pathExtent.xy + abs(pathCentreA-pathShift)*pathExtent.z)/max(pathDepthA-pathExtent.z,0.0000001);
  pathHalfB = (pathFocal*pathExtent.xy + abs(pathCentreB-pathShift)*pathExtent.z)/max(pathDepthB-pathExtent.z,0.0000001);
} else {
  pathHalfA = pathFocal*pathExtent.xy;
  pathHalfB = pathHalfA;
}
vec2 pathMin = min(pathCentreA-pathHalfA,pathCentreB-pathHalfB);
vec2 pathMax = max(pathCentreA+pathHalfA,pathCentreB+pathHalfB);
if (pathAcrossCamera) { pathMin=vec2(-1.0); pathMax=vec2(1.0); }
// Exact section bounds already contain the whole extrusion. During temporary
// interaction reduce only the antialiasing guard band to avoid shading a wide
// discarded border around millions of subpixel roads. Final frames keep 1px.
vec2 pathPixel = (pathInteraction > 0.5 ? 0.5 : 2.0) / max(pathViewportSize, vec2(1.0));
pathMin = clamp(pathMin-pathPixel,vec2(-1.0),vec2(1.0));
pathMax = clamp(pathMax+pathPixel,vec2(-1.0),vec2(1.0));
// A complete road behind a perspective camera has no visible samples. Avoid
// turning millions of such roads into full-screen discarded fragments.
if (pathEntirelyBehind) { pathMin = vec2(2.0); pathMax = vec2(2.0); }
vPathNdc = mix(pathMin, pathMax, position.xy * 0.5 + 0.5);
gl_Position = vec4(vPathNdc, 0.0, 1.0);
vec4 pathProxyView = pathProjectionInverse * gl_Position;
vec4 mvPosition = vec4(pathProxyView.xyz / pathProxyView.w, 1.0);
`;

const FRAGMENT_PARS = /* glsl */`
uniform mat4 pathProjection;
uniform mat4 pathProjectionInverse;
uniform mat4 pathCameraWorld;
uniform float pathHideSupport;
uniform float pathInteraction;
uniform float pathMacroSurface;
varying vec2 vPathNdc;
varying vec3 vPathCentre;
varying vec3 vPathInverseX;
varying vec3 vPathInverseY;
varying vec3 vPathInverseZ;
varying vec4 vPathSection;
varying float vPathRoughness;
varying float vPathSupport;
varying float vPathRole;
varying vec3 vPathPrintAxisView;
const float PATH_HUGE = 1e20;
bool pathInsideSection(vec2 point, vec4 section) {
  if (section.w >= 0.999999) {
    vec2 q = point / section.xz; return dot(q, q) <= 1.000002;
  }
  float centre = max(0.0, section.x - section.z);
  vec2 q = vec2(max(abs(point.x) - centre, 0.0), point.y);
  return dot(q, q) <= section.z * section.z * 1.000002;
}
void pathCandidate(float t, vec3 normalCandidate, inout float best, inout vec3 hitNormal) {
  if (t >= 0.0 && t < best) { best = t; hitNormal = normalCandidate; }
}
void pathCurvedSide(vec3 origin, vec3 ray, vec4 section, float cx, float side,
  bool ellipse, inout float best, inout vec3 hitNormal) {
  vec2 radii = ellipse ? section.xz : vec2(section.z);
  vec2 o = (origin.xz - vec2(cx, 0.0)) / radii, d = ray.xz / radii;
  float a = dot(d, d);
  if (a <= 1e-20) return;
  // Rebase to the closest point before solving. The ordinary b*b-a*c
  // formula catastrophically cancels for sub-mm roads far from the camera.
  float closestT = -dot(o,d)/a;
  vec2 closest = o+d*closestT;
  float remaining = 1.0-dot(closest,closest);
  if (remaining < 0.0) return;
  float root = sqrt(max(0.0,remaining)/a);
  for (int rootIndex = 0; rootIndex < 2; rootIndex++) {
    float offset = rootIndex == 0 ? -root : root;
    float t = closestT+offset;
    vec2 sidePoint = closest+d*offset;
    float hitY = origin.y+ray.y*t;
    if (abs(hitY) <= section.y * 1.000002 && (ellipse || side*sidePoint.x >= -1e-7)) {
      vec3 n = vec3(sidePoint.x/radii.x, 0.0, sidePoint.y/radii.y);
      pathCandidate(t, normalize(n), best, hitNormal);
    }
  }
}
bool pathIntersect(vec3 origin, vec3 ray, vec4 section, out float best, out vec3 hitNormal) {
  best = PATH_HUGE; hitNormal = vec3(0.0);
  bool ellipse = section.w >= 0.999999;
  if (ellipse) pathCurvedSide(origin, ray, section, 0.0, 0.0, true, best, hitNormal);
  else {
    float centre = max(0.0, section.x - section.z);
    pathCurvedSide(origin, ray, section, centre, 1.0, false, best, hitNormal);
    pathCurvedSide(origin, ray, section, -centre, -1.0, false, best, hitNormal);
    if (abs(ray.z) > 1e-20) for (int faceIndex = 0; faceIndex < 2; faceIndex++) {
      float side = faceIndex == 0 ? -1.0 : 1.0;
      float t = (side * section.z - origin.z) / ray.z;
      vec3 p = origin + ray*t;
      if (abs(p.x) <= centre * 1.000002 && abs(p.y) <= section.y * 1.000002)
        pathCandidate(t, vec3(0.0,0.0,side), best, hitNormal);
    }
  }
  if (abs(ray.y) > 1e-20) for (int capIndex = 0; capIndex < 2; capIndex++) {
    float side = capIndex == 0 ? -1.0 : 1.0;
    float t = (side * section.y - origin.y) / ray.y;
    vec3 p = origin + ray*t;
    if (pathInsideSection(p.xz, section)) pathCandidate(t, vec3(0.0,side,0.0), best, hitNormal);
  }
  return best < PATH_HUGE;
}
`;

const FRAGMENT_HIT = /* glsl */`
if (pathHideSupport > 0.5 && vPathSupport > 0.5) discard;
if (pathInteraction > 0.5 && vPathRole >= 2.0 && vPathRole <= 4.0) discard;
if (pathMacroSurface > 0.5 && (vPathRole >= 1.0 && vPathRole <= 4.0 || vPathRole == 16.0)) discard;
#ifdef USE_REVERSED_DEPTH_BUFFER
  vec4 pathNearH = pathProjectionInverse * vec4(vPathNdc, 1.0, 1.0);
  vec4 pathMidH = pathProjectionInverse * vec4(vPathNdc, 0.5, 1.0);
#else
  vec4 pathNearH = pathProjectionInverse * vec4(vPathNdc, -1.0, 1.0);
  vec4 pathMidH = pathProjectionInverse * vec4(vPathNdc, 0.0, 1.0);
#endif
vec3 pathRayOrigin = pathNearH.xyz/pathNearH.w;
vec3 pathRayDirection = normalize(pathMidH.xyz/pathMidH.w - pathRayOrigin);
vec3 pathLocalOriginView = pathRayOrigin - vPathCentre;
vec3 pathLocalOrigin = vec3(dot(vPathInverseX,pathLocalOriginView),dot(vPathInverseY,pathLocalOriginView),dot(vPathInverseZ,pathLocalOriginView));
vec3 pathLocalRay = vec3(dot(vPathInverseX,pathRayDirection),dot(vPathInverseY,pathRayDirection),dot(vPathInverseZ,pathRayDirection));
float pathHitT; vec3 pathLocalNormal;
if (!pathIntersect(pathLocalOrigin, pathLocalRay, vPathSection, pathHitT, pathLocalNormal)) discard;
vec3 pathHitView = pathRayOrigin + pathRayDirection*pathHitT;
vec3 pathHitNormal = normalize(vPathInverseX*pathLocalNormal.x + vPathInverseY*pathLocalNormal.y + vPathInverseZ*pathLocalNormal.z);
vec4 pathHitClip = pathProjection * vec4(pathHitView,1.0);
#ifdef USE_REVERSED_DEPTH_BUFFER
  float pathHitDepth = pathHitClip.z/pathHitClip.w;
#else
  float pathHitDepth = pathHitClip.z/pathHitClip.w*0.5+0.5;
#endif
if (pathHitDepth < 0.0 || pathHitDepth > 1.0) discard;
vec3 vViewPosition = -pathHitView;
#if NUM_CLIPPING_PLANES > 0
  vec3 vClipPosition = -pathHitView;
#endif
`;

const SHADOW_HIT = /* glsl */`
vec4 pathHitWorld = pathCameraWorld * vec4(pathHitView, 1.0);
vec3 pathHitWorldNormal = normalize(mat3(pathCameraWorld)*pathHitNormal);
#if defined(USE_SHADOWMAP) && NUM_DIR_LIGHT_SHADOWS > 0
  vec4 vDirectionalShadowCoord[NUM_DIR_LIGHT_SHADOWS];
  #pragma unroll_loop_start
  for ( int i = 0; i < NUM_DIR_LIGHT_SHADOWS; i ++ ) {
    vDirectionalShadowCoord[i] = directionalShadowMatrix[i] * vec4(pathHitWorld.xyz + pathHitWorldNormal*directionalLightShadows[i].shadowNormalBias,1.0);
  }
  #pragma unroll_loop_end
#endif
#if defined(USE_SHADOWMAP) && NUM_POINT_LIGHT_SHADOWS > 0
  vec4 vPointShadowCoord[NUM_POINT_LIGHT_SHADOWS];
  #pragma unroll_loop_start
  for ( int i = 0; i < NUM_POINT_LIGHT_SHADOWS; i ++ ) {
    vPointShadowCoord[i] = pointShadowMatrix[i] * vec4(pathHitWorld.xyz + pathHitWorldNormal*pointLightShadows[i].shadowNormalBias,1.0);
  }
  #pragma unroll_loop_end
#endif
#if NUM_SPOT_LIGHT_COORDS > 0
  vec4 vSpotLightCoord[NUM_SPOT_LIGHT_COORDS];
  #pragma unroll_loop_start
  for ( int i = 0; i < NUM_SPOT_LIGHT_COORDS; i ++ ) {
    vSpotLightCoord[i] = spotLightMatrix[i] * pathHitWorld;
  }
  #pragma unroll_loop_end
#endif
`;

const DEPTH_HIT = /* glsl */`
#if defined(USE_LOGARITHMIC_DEPTH_BUFFER)
  gl_FragDepth = isOrthographic ? pathHitDepth : log2(1.0-pathHitView.z)*logDepthBufFC*0.5;
#else
  gl_FragDepth = pathHitDepth;
#endif
`;

const LAYER_FILTER_FRAGMENT = /* glsl */`
uniform float pathLayerFilterEnabled;
uniform vec2 pathFilterViewportSize;
float pathLayerWeight = 0.0;
vec3 pathLayerRawNormal = vec3(0.0,0.0,1.0);
vec3 pathLayerMacroNormal = vec3(0.0,0.0,1.0);
vec3 pathLayerPrintAxisNormal = vec3(0.0,0.0,1.0);
float pathProjectedSideCosine(const in vec3 lightDirection) {
  float rawCosine = saturate(dot(pathLayerRawNormal,lightDirection));
  if (pathLayerWeight <= 0.0) return rawCosine;
  float a = dot(pathLayerMacroNormal,lightDirection);
  float b = abs(dot(pathLayerPrintAxisNormal,lightDirection));
  // Exact projected front-view semicircle Lambert integral used by the
  // existing support filter, not a blanket exposure/brightness increase.
  float meanCosine = abs(a)+b < 0.0000001 ? 0.0 : max(0.0,0.25*(a*(PI-atan(b,a))+b));
  return mix(rawCosine,meanCosine,pathLayerWeight);
}
vec3 pathHemisphereMeanNormal() {
  return mix(pathLayerRawNormal,pathLayerMacroNormal*(PI*0.25),pathLayerWeight);
}
`;

const LAYER_FILTER_MAIN = /* glsl */`
pathLayerRawNormal = normal;
// Preserve end caps, flat top/bottom, bridges, tall/narrow ellipses and
// resolved layers. Only unresolved ordinary rounded lateral faces filter.
if (pathLayerFilterEnabled > 0.5 && vPathSection.w < 0.999999 &&
    abs(pathLocalNormal.y) < 0.0001 && abs(pathLocalNormal.x) > 0.000001) {
  // Evaluate at the exact visible hit. A long extrusion's centre can be much
  // nearer than its far end, incorrectly retaining far-end subpixel normals.
  vec2 pathLayerFocal = vec2(pathProjection[0][0],pathProjection[1][1]);
  vec2 pathLayerStep;
  if (pathProjection[2][3] == -1.0) {
    float pathDepth = max(0.0000001,-pathHitView.z);
    pathLayerStep = pathLayerFocal*(vPathPrintAxisView.xy*pathDepth+pathHitView.xy*vPathPrintAxisView.z)/(pathDepth*pathDepth)*vPathSection.z*2.0;
  } else pathLayerStep = pathLayerFocal*vPathPrintAxisView.xy*vPathSection.z*2.0;
  float pathLayerPixels = length(pathLayerStep*pathFilterViewportSize*0.5);
  // The curved normal has harmonics above the one-cycle layer frequency.
  // Fully average by Nyquist; restore real normals gradually at 2..5 pixels.
  pathLayerWeight = 1.0-smoothstep(2.0,5.0,pathLayerPixels);
  #if NUM_RECT_AREA_LIGHTS > 0 || defined(USE_LIGHT_PROBES)
    pathLayerWeight = 0.0;
  #endif
  if (pathLayerWeight > 0.0) {
    pathLayerMacroNormal = sign(pathLocalNormal.x)*normalize(vPathInverseX);
    pathLayerPrintAxisNormal = normalize(vPathInverseZ);
    normal = normalize(mix(pathLayerRawNormal,pathLayerMacroNormal,pathLayerWeight));
    nonPerturbedNormal = normalize(mix(nonPerturbedNormal,pathLayerMacroNormal,pathLayerWeight));
    roughnessFactor = sqrt(min(1.0,roughnessFactor*roughnessFactor+(1.0-PI*0.25)*pathLayerWeight));
  }
}
// Three's geometryRoughness still handles resolved geometry. Feeding it the
// filtered normal prevents unresolved bead phase from changing roughness.
`;

/** Public patch function also lets render-test fixtures expand/inspect shaders. */
export function patchPrintPathShader(shader, { depth = false, analysis = false, heights = false, uniforms = null } = {}) {
  if (uniforms) Object.assign(shader.uniforms, uniforms);
  shader.vertexShader = VERTEX_PARS + shader.vertexShader;
  shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', VERTEX_PROJECT);
  // Three 0.186 made vColor vec4 for both variants; older supported builds use
  // vec3 for USE_COLOR. Match the installed shader chunk rather than assuming.
  const rgbColor = /varying\s+vec3\s+vColor\b/.test(THREE.ShaderChunk.color_pars_vertex)
    ? '(instanceColorStart+instanceColorEnd)*0.5' : 'vec4((instanceColorStart+instanceColorEnd)*0.5,1.0)';
  shader.vertexShader = shader.vertexShader.replace('#include <color_vertex>', `
#ifdef USE_COLOR_ALPHA
  vColor = vec4((instanceColorStart+instanceColorEnd)*0.5,1.0);
#elif defined(USE_COLOR)
  vColor = ${rgbColor};
#endif`);
  shader.fragmentShader = FRAGMENT_PARS + shader.fragmentShader;
  shader.fragmentShader = shader.fragmentShader.replace('varying vec3 vViewPosition;', 'varying vec3 vProxyViewPosition;');
  // Keep the actual clipping equations, replacing their proxy varying with an
  // exact view-space hit. The local name takes their expected spelling.
  shader.fragmentShader = shader.fragmentShader.replace('#include <clipping_planes_pars_fragment>', THREE.ShaderChunk.clipping_planes_pars_fragment.replaceAll('vClipPosition', 'vProxyClipPosition'));
  if (!depth && !analysis) {
    const shadowPars = THREE.ShaderChunk.shadowmap_pars_fragment
      .replaceAll('vDirectionalShadowCoord', 'vProxyDirectionalShadowCoord')
      .replaceAll('vPointShadowCoord', 'vProxyPointShadowCoord')
      .replaceAll('vSpotLightCoord', 'vProxySpotLightCoord');
    shader.fragmentShader = shader.fragmentShader.replace('#include <shadowmap_pars_fragment>', shadowPars + `
#if defined(USE_SHADOWMAP) && NUM_DIR_LIGHT_SHADOWS > 0
uniform mat4 directionalShadowMatrix[NUM_DIR_LIGHT_SHADOWS];
#endif
#if defined(USE_SHADOWMAP) && NUM_POINT_LIGHT_SHADOWS > 0
uniform mat4 pointShadowMatrix[NUM_POINT_LIGHT_SHADOWS];
#endif
#if NUM_SPOT_LIGHT_COORDS > 0
uniform mat4 spotLightMatrix[NUM_SPOT_LIGHT_COORDS];
#endif`);
  }
  shader.fragmentShader = shader.fragmentShader.replace('void main() {', 'void main() {\n' + (depth ? 'if (vPathRole > 2.5 && vPathRole < 3.5) discard;\n' : '') + FRAGMENT_HIT + (depth || analysis ? '' : SHADOW_HIT));
  shader.fragmentShader = shader.fragmentShader.replace('#include <logdepthbuf_fragment>', DEPTH_HIT);
  if (!depth && !analysis) shader.fragmentShader = shader.fragmentShader.replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nif (vPathRoughness >= 0.0) roughnessFactor = clamp(vPathRoughness, 0.0, 1.0);');
  if (!depth && !analysis) shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_begin>', 'float faceDirection=1.0;\nvec3 normal=pathHitNormal;\nvec3 nonPerturbedNormal=normal;');
  else shader.fragmentShader = shader.fragmentShader
    .replace('vHighPrecisionZW[ 0 ] / vHighPrecisionZW[ 1 ]', 'pathHitDepth')
    .replace('0.5 * vHighPrecisionZW[ 0 ] / vHighPrecisionZW[ 1 ] + 0.5', 'pathHitDepth');
  // Depth's stock branch is replaced wholesale to handle both depth conventions.
  if (depth) shader.fragmentShader = shader.fragmentShader.replace(/#ifdef USE_REVERSED_DEPTH_BUFFER\s+float fragCoordZ[\s\S]*?#endif/, 'float fragCoordZ = pathHitDepth;');
  if (!depth && !analysis) {
    const diffuseTerm='reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseContribution ) * ( 1.0 - F );';
    const hemisphereTerm='getHemisphereLightIrradiance( hemisphereLights[ i ], geometryNormal )';
    if (!THREE.ShaderChunk.lights_physical_pars_fragment.includes(diffuseTerm)||!THREE.ShaderChunk.lights_fragment_begin.includes(hemisphereTerm)) throw new Error('Three PBR 光照接口已变化，打印层纹过滤不能静默改写。');
    shader.fragmentShader=shader.fragmentShader.replace('#include <common>','#include <common>\n'+LAYER_FILTER_FRAGMENT);
    shader.fragmentShader=shader.fragmentShader.replace('#include <normal_fragment_maps>','#include <normal_fragment_maps>\n'+LAYER_FILTER_MAIN);
    shader.fragmentShader=shader.fragmentShader.replace('#include <lights_physical_pars_fragment>',THREE.ShaderChunk.lights_physical_pars_fragment.replace(diffuseTerm,
      'reflectedLight.directDiffuse += directLight.color * pathProjectedSideCosine(directLight.direction) * BRDF_Lambert( material.diffuseContribution ) * ( 1.0 - F );'));
    shader.fragmentShader=shader.fragmentShader.replace('#include <lights_fragment_begin>',THREE.ShaderChunk.lights_fragment_begin.replace(hemisphereTerm,
      'getHemisphereLightIrradiance( hemisphereLights[ i ], pathHemisphereMeanNormal() )'));
  }
  if (analysis && heights) {
    shader.fragmentShader = 'uniform float pathAnalysisMinY;\nuniform float pathAnalysisSpan;\n' + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', `
float pathWorldY = (pathCameraWorld * vec4(pathHitView,1.0)).y;
float packedHeight = floor(clamp((pathWorldY-pathAnalysisMinY)/pathAnalysisSpan,0.0,1.0)*65535.0+0.5);
gl_FragColor = vec4(floor(packedHeight/256.0)/255.0,mod(packedHeight,256.0)/255.0,0.0,1.0);`);
    // Encoded numerical channels must not be altered by output color space.
    shader.fragmentShader = shader.fragmentShader.replace('#include <tonemapping_fragment>', '').replace('#include <colorspace_fragment>', '');
  }
  return shader;
}

export function installPrintPathImpostor(material, { depth = false, analysis = false, heights = false } = {}) {
  if (material.userData.printPathImpostor) return material;
  const uniforms = { pathProjection: { value: new THREE.Matrix4() }, pathProjectionInverse: { value: new THREE.Matrix4() },
    pathCameraWorld: { value: new THREE.Matrix4() }, pathViewportSize: { value: new THREE.Vector2(1,1) }, pathFilterViewportSize: { value: new THREE.Vector2(1,1) }, pathHideSupport: { value: 0 }, pathInteraction: { value:0 }, pathMacroSurface: {value:0}, pathLayerFilterEnabled:{value:depth||analysis?0:1} };
  if (analysis && heights) Object.assign(uniforms,{pathAnalysisMinY:{value:0},pathAnalysisSpan:{value:1}});
  const previousCompile = material.onBeforeCompile, previousRender = material.onBeforeRender;
  const previousKey = material.customProgramCacheKey.bind(material);
  material.onBeforeCompile = function(shader, renderer) { previousCompile.call(this, shader, renderer); patchPrintPathShader(shader, { depth, analysis, heights, uniforms }); };
  material.onBeforeRender = function(renderer, scene, camera, geometry, object, group) {
    previousRender.call(this, renderer, scene, camera, geometry, object, group);
    updatePrintPathCamera(this, renderer, camera);
  };
  material.defaultAttributeValues = { ...(material.defaultAttributeValues || {}), instanceColorStart:[1,1,1], instanceColorEnd:[1,1,1], instancePrintRoughness:[-1], instancePrintSupport:[0], instancePrintRole:[0] };
  material.customProgramCacheKey = () => `${previousKey()}|analytic-print-path-v5-${depth ? 'depth' : analysis ? heights ? 'height' : 'silhouette' : 'pbr'}`;
  material.userData.printPathImpostor = { schemaVersion:1, depth, analysis, heights, uniforms,
    sectionApproximate:true, sourcePathsUnmodified:true, exactWidthHeight:true,
    limitations:['finite flat-ended extrusion approximation; no physical bead fusion', 'SunLight cascade shadow receiver unsupported; project uses DirectionalLight', 'unresolved side diffuse uses a front-view semicircle integral and specular uses a mean-normal roughness approximation; source coverage, color and self-shadow remain sampled'] };
  material.needsUpdate = true;
  return material;
}

const pathCurrentViewport = new THREE.Vector4();
/** Shadow rendering bypasses material.onBeforeRender. Call this from the
 * mesh.onBeforeShadow hook with its actual shadow camera and depth material. */
export function updatePrintPathCamera(material, renderer, camera) {
  const uniforms = material.userData.printPathImpostor?.uniforms;
  if (!uniforms) throw new TypeError('没有找到打印路径的解析材质。');
  uniforms.pathProjection.value.copy(camera.projectionMatrix);
  uniforms.pathProjectionInverse.value.copy(camera.projectionMatrixInverse);
  uniforms.pathCameraWorld.value.copy(camera.matrixWorld);
  renderer.getCurrentViewport(pathCurrentViewport);
  uniforms.pathViewportSize.value.set(pathCurrentViewport.z,pathCurrentViewport.w);
  uniforms.pathFilterViewportSize.value.set(pathCurrentViewport.z,pathCurrentViewport.w).divideScalar(surfaceFootprintScale(renderer));
}

export function createPrintPathMaterial(options = {}) {
  const { prepareMaterial = material => material, ...parameters } = options;
  const material = new THREE.MeshStandardMaterial({ color:'#ffffff', vertexColors:true, roughness:0.64, metalness:0,
    side:THREE.DoubleSide, ...parameters });
  return installPrintPathImpostor(prepareMaterial(material));
}

export function createPrintPathDepthMaterial(options = {}) {
  return installPrintPathImpostor(new THREE.MeshDepthMaterial({ depthPacking:THREE.RGBADepthPacking, side:THREE.FrontSide, ...options }), { depth:true });
}

/** The analysis pass uses the exact intersected surface and depth, never the
 * proxy quad's position. Its white mask / RG16 height channels are ungraded. */
export function createPrintPathAnalysisMaterial(options = {}) {
  const { heights = false, prepareMaterial, prepare, minY = 0, span = 1, ...parameters } = options;
  let material = new THREE.MeshBasicMaterial({ ...parameters, color:'#ffffff', vertexColors:false,
    toneMapped:false, fog:false, side:THREE.DoubleSide });
  material = (prepareMaterial || prepare || (value => value))(material);
  installPrintPathImpostor(material,{analysis:true,heights});
  if (heights) updatePrintPathAnalysisRange(material,{minY,span});
  return material;
}

export function updatePrintPathAnalysisRange(material, { minY, span }) {
  const uniforms=material.userData.printPathImpostor?.uniforms;
  if (!uniforms?.pathAnalysisMinY || !Number.isFinite(minY) || !Number.isFinite(span) || span<=0) throw new TypeError('打印高度分析范围无效。');
  uniforms.pathAnalysisMinY.value=minY;uniforms.pathAnalysisSpan.value=span;
}

/** A uniform toggle keeps both model and support source paths in one geometry.
 * The caller updates its normal/depth/analysis materials independently. */
export function setPrintPathSupportVisibility(material, visible) {
  const uniform=material.userData.printPathImpostor?.uniforms?.pathHideSupport;
  if (!uniform) throw new TypeError('没有找到打印路径的支撑显示参数。');
  uniform.value=visible?0:1;
}

/** Temporary interaction preview only. Restore false before stationary frames,
 * silhouette/height analysis and every exported frame. No source data changes. */
export function setPrintPathInteraction(material, active) {
  const uniform=material.userData.printPathImpostor?.uniforms?.pathInteraction;
  if (!uniform) throw new TypeError('没有找到打印路径的交互预览参数。');
  uniform.value=active?1:0;
}

/** Shading-only anti-aliasing for unresolved ordinary side layers.
 * Geometry, actual hit, silhouette, depth, shadows and tool colors stay exact. */
export function setPrintPathLayerFilter(material, enabled) {
  const metadata=material.userData.printPathImpostor,uniform=metadata?.uniforms?.pathLayerFilterEnabled;
  if (!uniform) throw new TypeError('没有找到打印路径的层纹过滤参数。');
  uniform.value=!metadata.depth&&!metadata.analysis&&enabled?1:0;
}

export function setPrintPathMacroSurface(material, enabled) {
  const metadata=material.userData.printPathImpostor,uniform=metadata?.uniforms?.pathMacroSurface;
  if(!uniform)throw new TypeError('没有找到连续模型表面的路径显示参数。');
  uniform.value=!metadata.analysis&&enabled?1:0;
}

export function printPathLayerFilterWeight({pixels,ratio,localNormal,enabled=true}) {
  if(!Number.isFinite(pixels)||pixels<0||!Number.isFinite(ratio)||ratio<=0||ratio>1||localNormal?.length!==3||!localNormal.every(Number.isFinite)) throw new TypeError('打印层纹过滤参数无效。');
  if(!enabled||ratio>=.999999||Math.abs(localNormal[1])>=.0001||Math.abs(localNormal[0])<=.000001)return 0;
  const t=Math.max(0,Math.min(1,(pixels-2)/3));
  return 1-t*t*(3-2*t);
}

export function printPathSemicircleDiffuseAverage(a,b) {
  if(![a,b].every(Number.isFinite)) throw new TypeError('打印层纹漫反射参数无效。');
  const vertical=Math.abs(b);
  return Math.abs(a)+vertical<1e-7?0:Math.max(0,.25*(a*(Math.PI-Math.atan2(vertical,a))+vertical));
}

/** Pixel-space full deposited layer height, using the centre Jacobian with no
 * projection sampling loop. Off-axis crop shift cancels from the derivative. */
export function printPathLayerPixelHeight({centre,printAxisView,layerHeightMm,projectionMatrix,viewport=[1080,720]}) {
  if(![...centre,...printAxisView,layerHeightMm,...viewport].every(Number.isFinite)||layerHeightMm<=0||viewport.some(value=>value<=0)) throw new TypeError('打印层高投影参数无效。');
  const p=projectionMatrix.elements,perspective=p[11]===-1,depth=Math.max(1e-7,-centre[2]);
  const delta=[0,1].map(axis=>p[axis===0?0:5]*(perspective?(printAxisView[axis]*depth+centre[axis]*printAxisView[2])/(depth*depth):printAxisView[axis])*layerHeightMm*viewport[axis]*.5);
  return Math.hypot(...delta);
}

/** CPU reference of the two-end-section conservative projected bound. Raw
 * bounds permit an exact comparison with the former eight-corner method;
 * viewport bounds additionally include one physical pixel on each side. */
export function printPathProjectedBounds({start,end,width,height,modelViewMatrix,projectionMatrix,viewport=[1080,720],interaction=false}) {
  const a=new THREE.Vector3(...start),b=new THREE.Vector3(...end),delta=b.clone().sub(a),length=Math.hypot(delta.x,delta.y);
  if (!Number.isFinite(length)||length<=0||![width,height,...viewport].every(value=>Number.isFinite(value)&&value>0)) throw new TypeError('打印路径投影边界参数无效。');
  const linear=new THREE.Matrix3().setFromMatrix4(modelViewMatrix);
  const right=new THREE.Vector3(delta.y/length,-delta.x/length,0).applyMatrix3(linear).multiplyScalar(width/2);
  const up=new THREE.Vector3(0,0,1).applyMatrix3(linear).multiplyScalar(height/2);
  const extent=new THREE.Vector3(Math.abs(right.x)+Math.abs(up.x),Math.abs(right.y)+Math.abs(up.y),Math.abs(right.z)+Math.abs(up.z));
  a.applyMatrix4(modelViewMatrix);b.applyMatrix4(modelViewMatrix);
  const p=projectionMatrix.elements,perspective=p[11]===-1,minDepth=Math.min(-a.z,-b.z),maxDepth=Math.max(-a.z,-b.z);
  const entirelyBehind=perspective&&maxDepth+extent.z<=1e-7,acrossCamera=perspective&&minDepth-extent.z<=1e-7;
  const pixels=viewport.map(value=>(interaction ? 0.5 : 2)/value);
  let rawMin=[Infinity,Infinity],rawMax=[-Infinity,-Infinity];
  if(acrossCamera){rawMin=[-1,-1];rawMax=[1,1];}
  else for(const point of[a,b]){
    const clip=new THREE.Vector4(point.x,point.y,point.z,1).applyMatrix4(projectionMatrix),centre=[clip.x/clip.w,clip.y/clip.w];
    for(let axis=0;axis<2;axis++){
      const half=perspective?(Math.abs(p[axis===0?0:5])*extent.getComponent(axis)+Math.abs(centre[axis]+p[axis===0?8:9])*extent.z)/(-point.z-extent.z):Math.abs(p[axis===0?0:5])*extent.getComponent(axis);
      rawMin[axis]=Math.min(rawMin[axis],centre[axis]-half);rawMax[axis]=Math.max(rawMax[axis],centre[axis]+half);
    }
  }
  const clamp=value=>Math.min(1,Math.max(-1,value));
  return {rawMin,rawMax,min:entirelyBehind?[2,2]:rawMin.map((value,i)=>clamp(value-pixels[i])),max:entirelyBehind?[2,2]:rawMax.map((value,i)=>clamp(value+pixels[i])),extent:extent.toArray(),perspective,acrossCamera,entirelyBehind,pixelExpansion:pixels,projectionCount:2};
}

const previewAttributeRecords=new WeakMap();

function staticPreviewAttribute(attribute) {
  // Attribute identity owns a WebGL buffer. Reuse the tiny immutable template
  // array but not its attribute/data object, so disposing a preview never
  // deletes the production geometry's GPU buffer.
  if(attribute.isInterleavedBufferAttribute){
    const source=attribute.data,data=new THREE.InterleavedBuffer(source.array,source.stride);
    data.setUsage(source.usage);return new THREE.InterleavedBufferAttribute(data,attribute.itemSize,attribute.offset,attribute.normalized);
  }
  const result=new THREE.BufferAttribute(attribute.array,attribute.itemSize,attribute.normalized);
  result.setUsage(attribute.usage);result.gpuType=attribute.gpuType;return result;
}

function copyPreviewBuffer(record,source,indices){
  const sourceArray=source.array,target=record.target.array,stride=record.stride;
  for(let i=0;i<indices.length;i++){
    const from=indices[i]*stride,to=i*stride;
    for(let component=0;component<stride;component++)target[to+component]=sourceArray[from+component];
  }
  record.source=source;record.sourceArray=sourceArray;record.version=source.version;
  record.target.needsUpdate=true;
}

function compactPreviewGeometry(full,indices,kind){
  const geometry=new THREE.InstancedBufferGeometry(),records=[],sourceBuffers=new Map();
  if(full.index)geometry.setIndex(staticPreviewAttribute(full.index));
  for(const[name,attribute]of Object.entries(full.attributes)){
    const interleaved=attribute.isInterleavedBufferAttribute===true;
    const source=interleaved?attribute.data:attribute;
    const instanced=interleaved?source.isInstancedInterleavedBuffer:attribute.isInstancedBufferAttribute;
    if(!instanced){geometry.setAttribute(name,staticPreviewAttribute(attribute));continue;}
    if((source.meshPerAttribute||1)!==1)throw new TypeError('交互预览需要每条路径独立的实例属性。');
    let record=sourceBuffers.get(source);
    if(!record){
      const stride=interleaved?source.stride:attribute.itemSize,array=new source.array.constructor(indices.length*stride);
      const target=interleaved?new THREE.InstancedInterleavedBuffer(array,stride,1):new THREE.InstancedBufferAttribute(array,attribute.itemSize,attribute.normalized,1);
      target.setUsage(source.usage);if(!interleaved)target.gpuType=attribute.gpuType;
      record={source,sourceArray:source.array,version:source.version,target,stride,interleaved,names:[]};
      copyPreviewBuffer(record,source,indices);sourceBuffers.set(source,record);records.push(record);
    }
    record.names.push({name,itemSize:attribute.itemSize,offset:interleaved?attribute.offset:0,normalized:attribute.normalized});
    geometry.setAttribute(name,interleaved?new THREE.InterleavedBufferAttribute(record.target,attribute.itemSize,attribute.offset,attribute.normalized):record.target);
  }
  geometry.instanceCount=indices.length;geometry.boundingBox=full.boundingBox?.clone()||null;geometry.boundingSphere=full.boundingSphere?.clone()||null;
  geometry.setDrawRange(full.drawRange.start,full.drawRange.count);
  for(const group of full.groups)geometry.addGroup(group.start,group.count,group.materialIndex);
  geometry.userData={...full.userData,sourceAttributesShared:false,staticTemplateArraysShared:true,printPathPreview:{kind,sourceIndices:indices,sourceGeometryCount:full.attributes.instanceStart.count,sourcePathsUnmodified:true,interactionOnly:true,disposed:false},previewSegmentCount:indices.length};
  geometry.sourceIndices=indices;
  previewAttributeRecords.set(geometry,{full,records,indices,roleSource:full.getAttribute('instancePrintRole'),roleVersion:full.getAttribute('instancePrintRole')?.version,roleArray:full.getAttribute('instancePrintRole')?.array});
  geometry.addEventListener('dispose',()=>{geometry.userData.printPathPreview.disposed=true;previewAttributeRecords.delete(geometry);});
  return geometry;
}

/** A one-time interaction-only compact copy. Source instance indices remain
 * monotonically ordered, so deposited-layer prefixes need no per-frame scan.
 * Production geometry is immutable and never swapped for final/analysis/export. */
export function createPrintPathPreviewGeometries(fullGeometry){
  const start=fullGeometry.getAttribute('instanceStart'),role=fullGeometry.getAttribute('instancePrintRole');
  if(!start||!role||start.count!==role.count)throw new TypeError('交互预览需要完整打印路径及对应类型。');
  const count=start.count;let exteriorCount=0,supportCount=0;
  for(let i=0;i<count;i++){const feature=role.getX(i);if(feature===10||feature===11)supportCount++;else if(feature!==2&&feature!==3&&feature!==4)exteriorCount++;}
  const exteriorIndices=new Uint32Array(exteriorCount),supportIndices=new Uint32Array(supportCount);let e=0,s=0;
  for(let i=0;i<count;i++){const feature=role.getX(i);if(feature===10||feature===11)supportIndices[s++]=i;else if(feature!==2&&feature!==3&&feature!==4)exteriorIndices[e++]=i;}
  let exterior,support;
  try{exterior=compactPreviewGeometry(fullGeometry,exteriorIndices,'exterior');support=compactPreviewGeometry(fullGeometry,supportIndices,'support');}
  catch(error){exterior?.dispose();support?.dispose();throw error;}
  return {exterior,support,sourceSegmentCount:count,exteriorSegmentCount:exteriorCount,supportSegmentCount:supportCount,excludedInteractionSegments:count-exteriorCount-supportCount};
}

/** Compact beauty draw for a bounded historical skin. Masks use the original
 * parsed IDs; sourceOrder maps the layer-sorted GPU instances back to those
 * IDs. Every retained road keeps all original attributes and its exact order.
 * The source geometry remains the shadow/analysis/export authority. */
export function createPrintPathDisplayGeometry(fullGeometry,{sourceOrder,coveredSegmentMask,fallbackSourceIndices=new Uint32Array(),includeSupport=true}={}){
  const start=fullGeometry.getAttribute('instanceStart'),role=fullGeometry.getAttribute('instancePrintRole');
  if(!start||!role||start.count!==role.count||!(sourceOrder instanceof Uint32Array)||sourceOrder.length!==start.count||!(coveredSegmentMask instanceof Uint8Array)||!(fallbackSourceIndices instanceof Uint32Array))throw new TypeError('连续表面绘制缓存需要完整路径及原始段索引映射。');
  const fallback=new Set(fallbackSourceIndices);
  for(const id of fallback)if(id>=coveredSegmentMask.length)throw new RangeError('连续表面后备段索引超出源路径范围。');
  const retained=[];let replacedOuter=0,buried=0,support=0;
  for(let index=0;index<start.count;index++){
    const id=sourceOrder[index],feature=role.getX(index);
    if(id>=coveredSegmentMask.length)throw new RangeError('连续表面原始段索引超出源路径范围。');
    if(feature===2||feature===3||feature===4){buried++;continue;}
    if((feature===1||feature===16)&&(coveredSegmentMask[id]||fallback.has(id))){replacedOuter++;continue;}
    if(!includeSupport&&(feature===10||feature===11)){support++;continue;}
    retained.push(index);
  }
  const geometry=compactPreviewGeometry(fullGeometry,Uint32Array.from(retained),'bounded-historical-display');
  geometry.userData.printPathDisplay={sourcePathsUnmodified:true,beautyOnly:true,requiresBoundedSkin:true,sourceOrder,coveredSegmentMask,fallbackSourceIndices,replacedOuterSegments:replacedOuter,buriedSegments:buried,separateSupportSegments:support};
  return geometry;
}

/** fullPrefixCount is an exclusive prefix of the original layer-sorted
 * instance order. Geometry remains compact; this changes only its draw count. */
export function setPrintPathPreviewCount(geometry,fullPrefixCount){
  const metadata=geometry.userData.printPathPreview;
  if(!metadata||metadata.disposed||!Number.isInteger(fullPrefixCount)||fullPrefixCount<0||fullPrefixCount>metadata.sourceGeometryCount)throw new TypeError('交互预览生长范围无效。');
  const indices=metadata.sourceIndices;let low=0,high=indices.length;
  while(low<high){const middle=(low+high)>>>1;if(indices[middle]<fullPrefixCount)low=middle+1;else high=middle;}
  geometry.instanceCount=low;return low;
}

/** Color/profile edits update only changed compact buffers. No per-frame copy.
 * A changed role/order requires rebuilding the preview instead of showing an
 * incorrectly classified subset. Return count of refreshed GPU buffers. */
export function refreshPrintPathPreviewAttributes(preview,fullGeometry){
  return refreshCompactPrintPathAttributes([preview.exterior,preview.support],fullGeometry);
}

export function refreshPrintPathDisplayAttributes(geometry,fullGeometry){
  if(!geometry?.userData.printPathDisplay)throw new TypeError('没有找到连续表面绘制缓存。');
  return refreshCompactPrintPathAttributes([geometry],fullGeometry);
}

function refreshCompactPrintPathAttributes(geometries,fullGeometry){
  let refreshed=0;
  for(const geometry of geometries){
    const state=previewAttributeRecords.get(geometry);
    if(!state||geometry.userData.printPathPreview.disposed)throw new TypeError('交互预览已释放。');
    const full=fullGeometry||state.full,role=full.getAttribute('instancePrintRole');
    if(full!==state.full||role!==state.roleSource||role.array!==state.roleArray||role.version!==state.roleVersion)throw new TypeError('完整路径顺序或类型已改变，需要重新构建交互预览。');
    for(const record of state.records){
      const first=full.getAttribute(record.names[0].name),source=first?.isInterleavedBufferAttribute?first.data:first;
      if(!source||source.array.length!==record.sourceArray.length||(record.interleaved?source.stride:first.itemSize)!==record.stride)throw new TypeError('完整路径属性布局已改变，需要重新构建交互预览。');
      for(const{name,itemSize,offset,normalized}of record.names){const attribute=full.getAttribute(name),data=attribute?.isInterleavedBufferAttribute?attribute.data:attribute;
        if(data!==source||attribute.itemSize!==itemSize||attribute.normalized!==normalized||(record.interleaved?attribute.offset:0)!==offset)throw new TypeError('完整路径共享属性布局已改变，需要重新构建交互预览。');}
      if(source!==record.source||source.array!==record.sourceArray||source.version!==record.version){copyPreviewBuffer(record,source,state.indices);refreshed++;}
    }
  }
  return refreshed;
}

/** CPU reference of the same finite analytic section; useful for physical
 * cross-section/ray regressions without requiring a renderer or GPU. */
export function intersectPrintBead(origin, ray, { width, height, length, elliptical = false } = {}) {
  if (![width,height,length,...origin,...ray].every(Number.isFinite) || width<=0 || height<=0 || length<=0 || Math.hypot(...ray)===0) throw new TypeError('挤出截面或射线参数无效。');
  const w=width/2,h=height/2,l=length/2,ellipse=elliptical||width<height,c=Math.max(0,w-h);
  let result=null;
  const candidate=(t,n)=>{if(t>=0&&(!result||t<result.distance)){const size=Math.hypot(...n);result={distance:t,point:origin.map((value,i)=>value+ray[i]*t),normal:n.map(value=>value/size)};}};
  const inside=(x,z)=>ellipse?(x/w)**2+(z/h)**2<=1+1e-10:Math.max(0,Math.abs(x)-c)**2+z*z<=h*h+1e-10;
  for(const [cx,side] of ellipse?[[0,0]]:[[c,1],[-c,-1]]){
    const rx=ellipse?w:h,rz=h,ox=(origin[0]-cx)/rx,oz=origin[2]/rz,dx=ray[0]/rx,dz=ray[2]/rz;
    const a=dx*dx+dz*dz,closestT=-(ox*dx+oz*dz)/a,qx=ox+dx*closestT,qz=oz+dz*closestT,remaining=1-qx*qx-qz*qz;
    if(a>1e-20&&remaining>=0)for(const sign of [-1,1]){const offset=sign*Math.sqrt(remaining/a),t=closestT+offset,sx=qx+dx*offset,sz=qz+dz*offset,y=origin[1]+ray[1]*t;
      if(Math.abs(y)<=l+1e-10&&(ellipse||side*sx>=-1e-10))candidate(t,[sx/rx,0,sz/rz]);}
  }
  if(!ellipse&&Math.abs(ray[2])>1e-20)for(const side of [-1,1]){const t=(side*h-origin[2])/ray[2],x=origin[0]+ray[0]*t,y=origin[1]+ray[1]*t;
    if(Math.abs(x)<=c+1e-10&&Math.abs(y)<=l+1e-10)candidate(t,[0,0,side]);}
  if(Math.abs(ray[1])>1e-20)for(const side of [-1,1]){const t=(side*l-origin[1])/ray[1],x=origin[0]+ray[0]*t,z=origin[2]+ray[2]*t;
    if(inside(x,z))candidate(t,[0,side,0]);}
  return result;
}
