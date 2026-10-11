// Photo-specific artistic starting points, not measured illumination data.
// White balance, reflective steel, PEI and colored tabletop bounce make physical
// Kelvin values unrecoverable from these photographs alone. No material/tool colors are
// included here: the model keeps its imported filament palette.
// Azimuth 0 lights from +Z (plate front), -90 from -X (plate left). Elevation
// follows studio.js. Fill positions use its normalized scene units. Exposure
// is a MODEL lighting multiplier; never apply it to the photograph itself.
// Tonal controls also affect only the displayed model. `shadows` adjusts its
// dark tones and is distinct from the ground-shadow opacity/softness controls.

export const DEFAULT_LIGHTING = Object.freeze({
  colorTemperature: 6500,
  keyIntensity: 2.6,
  ambientIntensity: 1.4,
  fillIntensity: 0.6,
  exposure: 1,
  tint: 0, shadows: 0, highlights: 0, contrast: 0, saturation: 0,
  lightAzimuth: -45,
  lightElevation: 55,
  shadowOpacity: 0.28,
  shadowRadius: 4,
  ambientSkyColor: '#e6ebf4',
  ambientGroundColor: '#68656a',
  fillColor: '#e2eafa',
  fillPosition: Object.freeze([8, 6, 8]),
});

export const LIGHTING_PRESET_REVISION = 4;

const definitions = {
  h2c: {
    // Match the baked cool-gray JPEG: lower the broad front key and highlight
    // ceiling instead of painting the filament palette the plate's gray.
    colorTemperature: 7400,
    keyIntensity: 1.55, ambientIntensity: 0.72, fillIntensity: 0.24,
    exposure: 0.72, shadows: 6, highlights: -14, contrast: -8, saturation: -10,
    lightAzimuth: -30, lightElevation: 66,
    shadowOpacity: 0.38, shadowRadius: 5.2,
    ambientSkyColor: '#d6dfe9', ambientGroundColor: '#747a83',
    fillColor: '#d1dfed', fillPosition: [8, 6, -7],
    description: '冷灰机舱，柔和前侧光，脚底较浓、外围柔和的接触阴影。',
  },
  p1s: {
    // Visible LED on the physical -X wall is the strongest directional cue.
    // Its key throws a shadow toward the opposite/right-front part of the
    // calibrated plate. Its long emitter and reflected cabin light soften the
    // model: lower the key and lift fill so faces are not almost black.
    colorTemperature: 7800,
    keyIntensity: 1.85, ambientIntensity: 0.6, fillIntensity: 0.28,
    exposure: 0.76, shadows: 12, highlights: -18, contrast: -10, saturation: -12,
    lightAzimuth: -100, lightElevation: 55,
    shadowOpacity: 0.24, shadowRadius: 4,
    ambientSkyColor: '#d1dce9', ambientGroundColor: '#6b7580',
    fillColor: '#cbdcec', fillPosition: [8, 5, 5],
    description: '左侧冷白灯，压低顶面亮部，补亮暗侧与柔化投影。',
  },
  a1: {
    // Actual white body/wall pixels have a blue bias. A brown table does not
    // justify the previous strong amber fill. Use broad cool-neutral room
    // illumination, a restrained warm bounce and a short low-opacity shadow.
    colorTemperature: 6900,
    keyIntensity: 1.1, ambientIntensity: 1.35, fillIntensity: 0.22,
    exposure: 0.82, shadows: 5, highlights: -10, contrast: -12, saturation: -10,
    lightAzimuth: -25, lightElevation: 72,
    shadowOpacity: 0.19, shadowRadius: 4.5,
    ambientSkyColor: '#dfe5ed', ambientGroundColor: '#82817f',
    fillColor: '#dfe6ec', fillPosition: [8, 6, 6],
    description: '冷中性的室内漫射光，浅柔接触阴影与少量地面反光。',
  },
  'pastel-rug': {
    // The bright upper-left area suggests a large warm-neutral source. Keep
    // the wall and peach rug bounce subtle: they illuminate the mesh without
    // recoloring its imported material palette or grading the photograph.
    photo: '/assets/backgrounds/pastel-rug.png',
    colorTemperature: 5900,
    keyIntensity: 2, ambientIntensity: 1.3, fillIntensity: 0.24,
    exposure: 0.95, shadows: 6, highlights: -8, contrast: -6, saturation: 0,
    lightAzimuth: -45, lightElevation: 65,
    shadowOpacity: 0.19, shadowRadius: 4.5,
    ambientSkyColor: '#e7eee0', ambientGroundColor: '#ae9988',
    fillColor: '#edf0e8', fillPosition: [8, 6, 6],
    description: '左上柔和日光，少量浅绿环境光与桃色绒面反光，宽柔接触阴影。',
  },
  'blue-grey': {
    // Seamless matte studio: broad neutral key and fill, with a gentle cool
    // floor reflection. Bright enough for the plate without hard speculars.
    photo: '/assets/backgrounds/blue-grey.png',
    colorTemperature: 6500,
    keyIntensity: 1.7, ambientIntensity: 1.25, fillIntensity: 0.38,
    exposure: 0.95, shadows: 5, highlights: -8, contrast: -7, saturation: 0,
    lightAzimuth: -45, lightElevation: 65,
    shadowOpacity: 0.22, shadowRadius: 4,
    ambientSkyColor: '#e6ebf1', ambientGroundColor: '#939cab',
    fillColor: '#e3e9f0', fillPosition: [8, 6, 6],
    description: '左上中性柔光与宽幅补光，轻微蓝灰地面反光，浅柔摄影棚投影。',
  },
  'teal-room': {
    // White window light enters from the left; the cyan interior is ambient
    // fill, not a saturated key. Taupe tabletop contributes a restrained warm
    // lower bounce. Existing background bokeh is never blurred again.
    photo: '/assets/backgrounds/teal-room.png',
    colorTemperature: 6100,
    keyIntensity: 2, ambientIntensity: 0.9, fillIntensity: 0.38,
    exposure: 0.95, shadows: 5, highlights: -8, contrast: -4, saturation: 0,
    lightAzimuth: -70, lightElevation: 55,
    shadowOpacity: 0.24, shadowRadius: 3.8,
    ambientSkyColor: '#d8e9ec', ambientGroundColor: '#a39386',
    fillColor: '#c7dfe6', fillPosition: [8, 6, -4],
    description: '左侧窗光、轻微青蓝室内补光与暖灰台面反光，柔和右向投影。',
  },
};

const ranges = {
  colorTemperature: [2000, 12000],
  keyIntensity: [0, 8], ambientIntensity: [0, 8], fillIntensity: [0, 8],
  exposure: [0.25, 2.5], lightElevation: [10, 85],
  tint: [-100, 100], shadows: [-100, 100], highlights: [-100, 100],
  contrast: [-100, 100], saturation: [-100, 100],
  shadowOpacity: [0, 0.7], shadowRadius: [1, 8],
};
const colors = ['ambientSkyColor', 'ambientGroundColor', 'fillColor'];
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const numeric = value => (typeof value === 'number' || typeof value === 'string' && value.trim()) && Number.isFinite(Number(value)) ? Number(value) : null;
const hexColor = value => typeof value === 'string' && /^#[\da-f]{6}$/i.test(value) ? value.toLowerCase() : null;

/** Sanitize user/cache overrides without accepting material or photo fields. */
export function normalizeLighting(input = {}, fallback = DEFAULT_LIGHTING) {
  const source = input && typeof input === 'object' ? input : {};
  const base = fallback && typeof fallback === 'object' ? fallback : DEFAULT_LIGHTING;
  const result = {};
  for (const [key, [minimum, maximum]] of Object.entries(ranges)) {
    const value = numeric(source[key]) ?? numeric(base[key]) ?? DEFAULT_LIGHTING[key];
    result[key] = clamp(value, minimum, maximum);
  }
  const azimuth = numeric(source.lightAzimuth) ?? numeric(base.lightAzimuth) ?? DEFAULT_LIGHTING.lightAzimuth;
  result.lightAzimuth = ((azimuth + 180) % 360 + 360) % 360 - 180;
  for (const key of colors) result[key] = hexColor(source[key]) || hexColor(base[key]) || DEFAULT_LIGHTING[key];
  const validPosition = value => Array.isArray(value) && value.length === 3 && value.every(component => numeric(component) !== null);
  const position = validPosition(source.fillPosition) ? source.fillPosition : validPosition(base.fillPosition) ? base.fillPosition : DEFAULT_LIGHTING.fillPosition;
  result.fillPosition = position.map(component => clamp(Number(component), -50, 50));
  return result;
}

export const presetLightingDefinitions = Object.freeze(Object.fromEntries(Object.entries(definitions).map(([key, values]) => [key, Object.freeze({
  ...normalizeLighting(values),
  fillPosition: Object.freeze([...values.fillPosition]),
  approximate: true,
  photo: values.photo ?? `/assets/backgrounds/${key}.jpg`,
  description: values.description,
})])));

/** Return a fresh, editable preset; unrelated photos have no implicit preset. */
export function getPresetLighting(key) {
  const definition = presetLightingDefinitions[key];
  return definition ? { ...definition, fillPosition: [...definition.fillPosition] } : null;
}
