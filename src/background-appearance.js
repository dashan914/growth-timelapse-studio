import { BACKGROUND_PRESETS } from './background-presets.js';
import { getPresetLighting, normalizeLighting, LIGHTING_PRESET_REVISION } from './preset-lighting.js';
import { migratePresetLighting } from './preset-lighting-migration.js';
import { getPresetDof, normalizeDof, migratePresetDof, DOF_PRESET_REVISION } from './preset-dof.js';

const scenes = new Set(['studio', 'paper', 'blue']);
const surfaces = new Set(['auto', 'pla', 'matte', 'silk', 'petg']);
const record = value => value && typeof value === 'object' && !Array.isArray(value)
  ? Object.fromEntries(Object.entries(value)) : {};
const presetId = key => typeof key === 'string' && key.startsWith('preset:') && Object.hasOwn(BACKGROUND_PRESETS, key.slice(7))
  ? key.slice(7) : '';
const hasRevision = (value, current) => (typeof value === 'number' || typeof value === 'string' && value.trim())
  && Number.isFinite(Number(value)) && Number(value) >= current;

/** Photo metadata survives file restoration; the current model is deliberately
 * absent from this identity so importing a new model keeps the scene's light. */
export function backgroundAppearanceKey({ preset = '', file = null, scene = 'studio' } = {}) {
  if (Object.hasOwn(BACKGROUND_PRESETS, preset)) return `preset:${preset}`;
  if (file) return `photo:${JSON.stringify([file.name || '', file.size || 0, file.lastModified || 0, file.type || ''])}`;
  return `scene:${scenes.has(scene) ? scene : 'studio'}`;
}

/** Always return new editable records, including a fresh fill-position vector. */
export function defaultBackgroundAppearance(key) {
  const preset = presetId(key);
  return {
    lighting: normalizeLighting(getPresetLighting(preset)),
    lightingPresetRevision: LIGHTING_PRESET_REVISION,
    dof: normalizeDof(getPresetDof(preset)),
    dofPresetRevision: DOF_PRESET_REVISION,
    surfacePreset: 'auto',
    surfaceDetail: .6,
    floor: true,
    grid: false,
  };
}

/** Sanitize one background's appearance without accepting geometry, imported
 * filament colors, the photograph itself, or output-format settings. */
export function normalizeBackgroundAppearance(input, key) {
  const source = record(input), defaults = defaultBackgroundAppearance(key), preset = presetId(key);
  const result = { ...defaults };
  if (source.lighting && typeof source.lighting === 'object' && !Array.isArray(source.lighting)) {
    const lighting = record(source.lighting);
    // Historical preset migrations supply their historical missing defaults.
    // Current partial records instead fall back to this background's defaults.
    result.lighting = migratePresetLighting(hasRevision(source.lightingPresetRevision, LIGHTING_PRESET_REVISION)
      ? normalizeLighting(lighting, defaults.lighting) : lighting, preset, source.lightingPresetRevision);
  }
  if (source.dof && typeof source.dof === 'object' && !Array.isArray(source.dof)) {
    const dof = record(source.dof);
    result.dof = migratePresetDof(hasRevision(source.dofPresetRevision, DOF_PRESET_REVISION)
      ? normalizeDof(dof, defaults.dof) : dof, preset, source.dofPresetRevision);
  }
  if (surfaces.has(source.surfacePreset)) result.surfacePreset = source.surfacePreset;
  if ((typeof source.surfaceDetail === 'number' || typeof source.surfaceDetail === 'string' && source.surfaceDetail.trim())
    && Number.isFinite(Number(source.surfaceDetail))) result.surfaceDetail = Math.min(1, Math.max(0, Number(source.surfaceDetail)));
  if (typeof source.floor === 'boolean') result.floor = source.floor;
  if (typeof source.grid === 'boolean') result.grid = source.grid;
  return result;
}

function isAppearanceKey(key) {
  return !!presetId(key) || key.startsWith('photo:') && key.length > 6
    || key.startsWith('scene:') && scenes.has(key.slice(6));
}

/** Only known background namespaces are persisted. Object.entries excludes
 * inherited records and the accepted prefixes exclude prototype keys. */
export function normalizeBackgroundAppearances(input) {
  const result = {};
  for (const [key, value] of Object.entries(record(input))) {
    if (isAppearanceKey(key)) result[key] = normalizeBackgroundAppearance(value, key);
  }
  return result;
}
