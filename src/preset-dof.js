// Mild visual matches for these exact photographs, not recovered lens/focus
// measurements. Keep the full mesh; this adjusts only the rendered focus.
export const DOF_PRESET_REVISION = 1;
export const DEFAULT_DOF = Object.freeze({ dofEnabled: false, dofStrength: 35, dofFocus: 50 });
export const presetDofDefinitions = Object.freeze({
  h2c: Object.freeze({ dofEnabled: true, dofStrength: 10, dofFocus: 40 }),
  p1s: Object.freeze({ dofEnabled: true, dofStrength: 12, dofFocus: 40 }),
  a1: Object.freeze({ dofEnabled: true, dofStrength: 16, dofFocus: 35 }),
  // The background already contains its own depth of field. Only the full
  // inserted model receives mild optical defocus; focus never follows growth.
  'pastel-rug': Object.freeze({ dofEnabled: true, dofStrength: 14, dofFocus: 45 }),
  'blue-grey': Object.freeze({ dofEnabled: true, dofStrength: 10, dofFocus: 45 }),
  'teal-room': Object.freeze({ dofEnabled: true, dofStrength: 22, dofFocus: 45 }),
});

const number = (value, fallback) => value != null && value !== '' && Number.isFinite(Number(value))
  ? Math.min(100, Math.max(0, Number(value))) : fallback;

export function normalizeDof(input = {}, fallback = DEFAULT_DOF) {
  const source = input && typeof input === 'object' ? input : {};
  return {
    dofEnabled: typeof source.dofEnabled === 'boolean' ? source.dofEnabled : fallback.dofEnabled,
    dofStrength: number(source.dofStrength, fallback.dofStrength),
    dofFocus: number(source.dofFocus, fallback.dofFocus),
  };
}

export function getPresetDof(key) {
  return Object.hasOwn(presetDofDefinitions, key) ? { ...presetDofDefinitions[key] } : null;
}

/** Old untouched off/35/50 defaults adopt photo focus. Any deliberate setting
 * is preserved as a coherent focus group; current caches also keep manual off.
 */
export function migratePresetDof(input, key, revision = 0) {
  const restored = normalizeDof(input);
  if (Number(revision) >= DOF_PRESET_REVISION || !Object.hasOwn(presetDofDefinitions, key)) return restored;
  const untouched = Object.keys(DEFAULT_DOF).every(field => restored[field] === DEFAULT_DOF[field]);
  return untouched ? getPresetDof(key) : restored;
}
