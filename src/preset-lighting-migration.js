import { normalizeLighting, getPresetLighting, LIGHTING_PRESET_REVISION } from './preset-lighting.js';

// Snapshot of the original photo presets. Keep this separate from the current
// definitions: migration compares each field with its historical default and
// only upgrades fields the user has apparently left unchanged.
const neutralTones = { tint: 0, shadows: 0, highlights: 0, contrast: 0, saturation: 0 };
const legacy = Object.freeze({
  h2c: Object.freeze({
    ...neutralTones,
    colorTemperature: 6900, keyIntensity: 2.05, ambientIntensity: 0.88, fillIntensity: 0.32,
    exposure: 0.9, lightAzimuth: -35, lightElevation: 58,
    shadowOpacity: 0.25, shadowRadius: 5,
    ambientSkyColor: '#d9e2ee', ambientGroundColor: '#69717c', fillColor: '#c7d8ed',
    fillPosition: Object.freeze([8, 6, -7]),
  }),
  p1s: Object.freeze({
    ...neutralTones,
    colorTemperature: 7300, keyIntensity: 2.55, ambientIntensity: 0.42, fillIntensity: 0.18,
    exposure: 0.88, lightAzimuth: -100, lightElevation: 62,
    shadowOpacity: 0.34, shadowRadius: 3.2,
    ambientSkyColor: '#c9d5e4', ambientGroundColor: '#555861', fillColor: '#bcd0e8',
    fillPosition: Object.freeze([8, 5, 5]),
  }),
  a1: Object.freeze({
    ...neutralTones,
    colorTemperature: 6200, keyIntensity: 1.8, ambientIntensity: 1.2, fillIntensity: 0.48,
    exposure: 0.99, lightAzimuth: -40, lightElevation: 65,
    shadowOpacity: 0.2, shadowRadius: 7,
    ambientSkyColor: '#e4e9f1', ambientGroundColor: '#9b8069', fillColor: '#e8d6c5',
    fillPosition: Object.freeze([8, 6, 6]),
  }),
});

// Shadow-only revisions retain the model's illumination and palette. Explicit
// historical snapshots let each revision upgrade directly to current defaults
// without mistaking an edit equal to a later default for an untouched field.
const revision2Shadows = Object.freeze({
  h2c: Object.freeze({shadowOpacity: .17, shadowRadius: 7}),
  p1s: Object.freeze({shadowOpacity: .2, shadowRadius: 6}),
  a1: Object.freeze({shadowOpacity: .14, shadowRadius: 8}),
  'pastel-rug': Object.freeze({shadowOpacity: .13, shadowRadius: 8}),
  'blue-grey': Object.freeze({shadowOpacity: .16, shadowRadius: 8}),
  'teal-room': Object.freeze({shadowOpacity: .18, shadowRadius: 7}),
});

// Revision 4 matches H2C's reference footprint. The other five backgrounds
// retain their independent shadow settings; their revision-3 snapshots are
// still explicit so future changes cannot rewrite historical comparisons.
const revision3Shadows = Object.freeze({
  h2c: Object.freeze({shadowOpacity: .22, shadowRadius: 4}),
  p1s: Object.freeze({shadowOpacity: .24, shadowRadius: 4}),
  a1: Object.freeze({shadowOpacity: .19, shadowRadius: 4.5}),
  'pastel-rug': Object.freeze({shadowOpacity: .19, shadowRadius: 4.5}),
  'blue-grey': Object.freeze({shadowOpacity: .22, shadowRadius: 4}),
  'teal-room': Object.freeze({shadowOpacity: .24, shadowRadius: 3.8}),
});

const tolerance = 1e-6;
function sameValue(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tolerance;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((value, i) => sameValue(value, b[i]));
  if (typeof a === 'string' && typeof b === 'string') return a.toLowerCase() === b.toLowerCase();
  return false;
}

/**
 * Upgrade untouched fields of an older exact-photo lighting preset. Numeric
 * strings/colors are canonicalized before comparison. Missing old fields,
 * including the original neutral tone controls, mean the historical default.
 * Edited fields stay edited; source palettes and photograph fields are never
 * accepted. The caller saves LIGHTING_PRESET_REVISION with the returned object.
 */
export function migratePresetLighting(input, key, revision = 0) {
  const currentRevision = typeof revision === 'number' || typeof revision === 'string' ? Number(revision) : 0;
  if (Number.isFinite(currentRevision) && currentRevision >= LIGHTING_PRESET_REVISION || !Object.hasOwn(revision2Shadows, key)) return normalizeLighting(input);
  const current = normalizeLighting(getPresetLighting(key));
  const originalPrinterPreset = (!Number.isFinite(currentRevision) || currentRevision < 2) && Object.hasOwn(legacy, key);
  const oldShadows = Number.isFinite(currentRevision) && currentRevision >= 3 ? revision3Shadows[key] : revision2Shadows[key];
  const oldDefault = normalizeLighting(originalPrinterPreset ? legacy[key] : {...current, ...oldShadows});
  const restored = normalizeLighting(input, oldDefault);
  const upgraded = {...restored};
  // Upgrade original presets directly to the current defaults. A two-stage
  // value-only migration would mistake a manual edit which happens to equal
  // an intermediate revision's default for an untouched field and overwrite it.
  const fields = originalPrinterPreset ? Object.keys(restored) : Object.keys(oldShadows);
  for (const field of fields) {
    const value = sameValue(restored[field], oldDefault[field]) ? current[field] : restored[field];
    upgraded[field] = Array.isArray(value) ? [...value] : value;
  }
  return normalizeLighting(upgraded);
}
