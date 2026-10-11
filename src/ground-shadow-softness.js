const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const GOLDEN_ANGLE = 2.399963229728653;
const SAMPLE_COUNT = 64;
const CONTACT_SAMPLE_COUNT = 16;

function radiusUV(radius, shadowCamera) {
  const zoom = Math.max(1e-6, finite(shadowCamera?.zoom, 1));
  const width = Math.abs(finite(shadowCamera?.right, 14) - finite(shadowCamera?.left, -14)) / zoom;
  const height = Math.abs(finite(shadowCamera?.top, 14) - finite(shadowCamera?.bottom, -14)) / zoom;
  return [width > 0 ? radius / width : 0, height > 0 ? radius / height : 0];
}

/** Physical blur radius projected into a directional light's orthographic map.
 * The existing 1–8 UI range represents hard through soft, not texture pixels.
 * No viewport or output dimensions enter this calculation, so export and
 * preview retain the same shadow footprint. The cap bounds unitless demos.
 */
export function groundShadowRadiusUV(softness, mmToWorld, shadowCamera) {
  const t = (clamp(finite(softness, 3), 1, 8) - 1) / 7;
  const scale = Math.max(0, finite(mmToWorld, 1));
  const radius = Math.min(1.2, 18 * t ** 1.8 * scale);
  return radiusUV(radius, shadowCamera);
}

/** Preserve small sole shadows with a submillimetre physical filter using the
 * same directional occlusion map. This does not invent a contact footprint;
 * pixels without a real caster remain clear. Resolution never enters its size.
 */
export function groundContactRadiusUV(mmToWorld, shadowCamera) {
  const scale = Math.max(0, finite(mmToWorld, 1));
  return radiusUV(Math.min(1.2, .45 * scale), shadowCamera);
}

/** The shader's fixed disk samples, exposed for numerical filter verification. */
export const GROUND_SHADOW_KERNEL = Object.freeze(Array.from({ length: SAMPLE_COUNT }, (_, index) => {
  const radiusSquared = (index + 0.5) / SAMPLE_COUNT;
  const radius = Math.sqrt(radiusSquared);
  const angle = index * GOLDEN_ANGLE;
  return Object.freeze({ x: Math.cos(angle) * radius, y: Math.sin(angle) * radius, weight: Math.exp(-3 * radiusSquared) });
}));

export const GROUND_CONTACT_KERNEL = Object.freeze(Array.from({ length: CONTACT_SAMPLE_COUNT }, (_, index) => {
  const radiusSquared = (index + 0.5) / CONTACT_SAMPLE_COUNT;
  const radius = Math.sqrt(radiusSquared), angle = index * GOLDEN_ANGLE;
  return Object.freeze({ x: Math.cos(angle) * radius, y: Math.sin(angle) * radius, weight: Math.exp(-3 * radiusSquared) });
}));

export const GROUND_SHADOW_GLSL = /* glsl */ `
uniform vec2 groundShadowRadius;
uniform vec2 groundShadowContactRadius;
uniform float groundShadowContactStrength;

float getGroundShadowMask() {
  #if defined(USE_SHADOWMAP) && defined(SHADOWMAP_TYPE_PCF) && NUM_DIR_LIGHT_SHADOWS > 0
    if (!receiveShadow) return 1.0;
    DirectionalLightShadow groundLight = directionalLightShadows[0];
    vec4 groundCoord = vDirectionalShadowCoord[0];
    groundCoord.xyz /= groundCoord.w;
    groundCoord.z += groundLight.shadowBias;
    bool groundInFrustum = groundCoord.x >= 0.0 && groundCoord.x <= 1.0 && groundCoord.y >= 0.0 && groundCoord.y <= 1.0 && groundCoord.z <= 1.0;
    if (!groundInFrustum) return 1.0;

    // The hard endpoint retains hardware's center comparison and filtering.
    float groundShadow = 0.0;
    if (max(groundShadowRadius.x, groundShadowRadius.y) <= 0.0000001) {
      groundShadow = texture(directionalShadowMap[0], vec3(groundCoord.xy, groundCoord.z));
    } else {
      float groundWeight = 0.0;
      // Fixed sampling avoids screen-space noise changing on resize/export.
      for (int groundIndex = 0; groundIndex < 64; groundIndex++) {
        float groundR2 = (float(groundIndex) + 0.5) / 64.0;
        float groundTheta = float(groundIndex) * 2.399963229728653;
        vec2 groundOffset = vec2(cos(groundTheta), sin(groundTheta)) * sqrt(groundR2) * groundShadowRadius;
        float groundSampleWeight = exp(-3.0 * groundR2);
        groundShadow += texture(directionalShadowMap[0], vec3(groundCoord.xy + groundOffset, groundCoord.z)) * groundSampleWeight;
        groundWeight += groundSampleWeight;
      }
      groundShadow /= groundWeight;
    }
    // Only printer presets enable this tighter occlusion filter. It retains
    // local foot contact that the broad penumbra filter otherwise dilutes.
    // A zero strength takes exactly the previous 64-tap visibility path.
    float groundContactStrength = clamp(groundShadowContactStrength, 0.0, 1.0);
    if (groundContactStrength > 0.0) {
      float groundContactShadow = 0.0;
      if (max(groundShadowContactRadius.x, groundShadowContactRadius.y) <= 0.0000001) {
        groundContactShadow = texture(directionalShadowMap[0], vec3(groundCoord.xy, groundCoord.z));
      } else {
        float groundContactWeight = 0.0;
        for (int contactIndex = 0; contactIndex < 16; contactIndex++) {
          float contactR2 = (float(contactIndex) + 0.5) / 16.0;
          float contactTheta = float(contactIndex) * 2.399963229728653;
          vec2 contactOffset = vec2(cos(contactTheta), sin(contactTheta)) * sqrt(contactR2) * groundShadowContactRadius;
          float contactSampleWeight = exp(-3.0 * contactR2);
          groundContactShadow += texture(directionalShadowMap[0], vec3(groundCoord.xy + contactOffset, groundCoord.z)) * contactSampleWeight;
          groundContactWeight += contactSampleWeight;
        }
        groundContactShadow /= groundContactWeight;
      }
      groundShadow = mix(groundShadow, groundContactShadow, groundContactStrength);
    }
    return mix(1.0, groundShadow, groundLight.shadowIntensity);
  #else
    return getShadowMask();
  #endif
}
`;

/** Patch only ShadowMaterial's opacity mask; existing photo compensation and
 * standard shadow declarations remain in place. A PBR shader is untouched.
 */
export function injectGroundShadowSoftness(shader, uniforms) {
  const source = shader.fragmentShader;
  const include = '#include <shadowmask_pars_fragment>';
  const mask = /opacity\s*\*\s*\(\s*1\.0\s*-\s*getShadowMask\(\)\s*\)/;
  if (!source.includes(include) || !mask.test(source) || source.includes('float getGroundShadowMask()')) return false;
  Object.assign(shader.uniforms, uniforms);
  shader.fragmentShader = source.replace(include, `${include}\n${GROUND_SHADOW_GLSL}`).replace(mask, 'opacity * (1.0 - getGroundShadowMask())');
  return true;
}
