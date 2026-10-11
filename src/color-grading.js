import { normalizeLighting } from './preset-lighting.js';

export const COLOR_GRADING_KEYS = Object.freeze(['tint', 'shadows', 'highlights', 'contrast', 'saturation']);
const LUMA = [0.2126, 0.7152, 0.0722];
const clamp01 = value => Math.max(0, Math.min(1, value));
const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);
const smoothstep = (low, high, value) => {
  const x = clamp01((value - low) / (high - low));
  return x * x * (3 - 2 * x);
};

/** Shared CPU/shader settings. Values remain separate from source materials. */
export function colorGradingValues(options = {}) {
  const normalized = normalizeLighting(options);
  const values = Object.fromEntries(COLOR_GRADING_KEYS.map(key => [key, normalized[key] / 100]));
  return { ...values, enabled: COLOR_GRADING_KEYS.some(key => values[key] !== 0) };
}

function contrastChannel(value, amount) {
  // Middle gray is 18% in linear RGB. Both branches preserve black, white and
  // the pivot while remaining monotonic for the entire slider range.
  const exponent = 2 ** (0.8 * amount);
  return value <= 0.18 ? 0.18 * (value / 0.18) ** exponent : 1 - 0.82 * ((1 - value) / 0.82) ** exponent;
}

/** Reference implementation for already tone-mapped, linear RGB (0..1).
 * Neutral settings are exactly identity. Never modifies the supplied palette.
 */
export function gradeLinearRGB(rgb, options = {}) {
  let color = [0, 1, 2].map(index => {
    const value = Number(rgb?.[index]);
    return Number.isFinite(value) ? clamp01(value) : 0;
  });
  const grade = colorGradingValues(options);
  if (!grade.enabled) return color;
  if (grade.tint !== 0) {
    const luminance = dot(color, LUMA);
    const redBlue = 2 ** (grade.tint * 0.5), green = 2 ** (-grade.tint * 0.5);
    color = color.map((value, index) => value * (index === 1 ? green : redBlue));
    if (luminance > 0) {
      const scale = luminance / Math.max(dot(color, LUMA), 1e-6);
      color = color.map(value => clamp01(value * scale));
    }
  }
  if (grade.shadows !== 0 || grade.highlights !== 0) {
    const luminance = dot(color, LUMA);
    const shadows = 1 - smoothstep(0.12, 0.5, luminance);
    const highlights = smoothstep(0.45, 0.9, luminance);
    const gain = 2 ** (2 * (grade.shadows * shadows + grade.highlights * highlights));
    const adjusted = luminance * gain / Math.max(1 - luminance + luminance * gain, 1e-6);
    if (luminance > 0 && gain !== 1) color = color.map(value => clamp01(value * adjusted / Math.max(luminance, 1e-6)));
  }
  if (grade.contrast !== 0) color = color.map(value => contrastChannel(value, grade.contrast));
  if (grade.saturation !== 0) {
    const luminance = dot(color, LUMA);
    color = color.map(value => clamp01(luminance + (value - luminance) * (1 + grade.saturation)));
  }
  return color.map(clamp01);
}

// Applied after the model's ACES tone mapping, in linear RGB before the final
// color-space conversion. Photo textures, floor and editing helpers never use
// this hook. CPU and GLSL use the same order, coefficients and bounded curves.
export const COLOR_GRADING_GLSL = /* glsl */ `
uniform vec4 modelGradeControls;
uniform float modelGradeSaturation;
uniform float modelGradeEnabled;

float modelContrastChannel(float value, float amount) {
  float exponent = exp2(0.8 * amount);
  return value <= 0.18 ? 0.18 * pow(value / 0.18, exponent) : 1.0 - 0.82 * pow((1.0 - value) / 0.82, exponent);
}

vec3 modelGradeLinearRGB(vec3 original) {
  // Also avoids extra per-fragment work for the usual neutral profile.
  if (modelGradeEnabled < 0.5) return original;
  vec3 color = clamp(original, 0.0, 1.0);
  const vec3 luma = vec3(0.2126, 0.7152, 0.0722);
  float tint = modelGradeControls.x;
  if (tint != 0.0) {
    float luminance = dot(color, luma);
    color *= exp2(vec3(tint, -tint, tint) * 0.5);
    if (luminance > 0.0) color = clamp(color * (luminance / max(dot(color, luma), 0.000001)), 0.0, 1.0);
  }
  if (modelGradeControls.y != 0.0 || modelGradeControls.z != 0.0) {
    float luminance = dot(color, luma);
    float darkWeight = 1.0 - smoothstep(0.12, 0.5, luminance);
    float brightWeight = smoothstep(0.45, 0.9, luminance);
    float gain = exp2(2.0 * (modelGradeControls.y * darkWeight + modelGradeControls.z * brightWeight));
    float adjusted = luminance * gain / max(1.0 - luminance + luminance * gain, 0.000001);
    if (luminance > 0.0 && gain != 1.0) color = clamp(color * (adjusted / max(luminance, 0.000001)), 0.0, 1.0);
  }
  if (modelGradeControls.w != 0.0) color = vec3(
    modelContrastChannel(color.r, modelGradeControls.w),
    modelContrastChannel(color.g, modelGradeControls.w),
    modelContrastChannel(color.b, modelGradeControls.w)
  );
  if (modelGradeSaturation != 0.0) {
    float luminance = dot(color, luma);
    color = clamp(vec3(luminance) + (color - vec3(luminance)) * (1.0 + modelGradeSaturation), 0.0, 1.0);
  }
  return clamp(color, 0.0, 1.0);
}
`;
