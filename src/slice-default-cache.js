import { DEFAULT_LAYER_HEIGHT_MM } from './slice-settings.js';

/** Embedded source G-code and explicit saved heights are authoritative.
 * Only an already-generated missing-parameter fallback can be out of date. */
export function sliceLayerDefaultCacheCurrent(snapshot) {
  if (snapshot?.reSliced === false || snapshot?.sliceSettings?.sourceType === 'gcode-config') return true;
  const profile = snapshot?.sliceSettings;
  const field = profile?.fields?.layerHeightMm;
  if (!field) return false;
  if (!['bambu-default', 'bambu-default-staged', 'studio-default'].includes(field.source)) return true;
  return Number.isFinite(profile.layerHeightMm) && Math.abs(profile.layerHeightMm - DEFAULT_LAYER_HEIGHT_MM) < 1e-9;
}
