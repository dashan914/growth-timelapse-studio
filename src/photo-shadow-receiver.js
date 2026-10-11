import { groundShadowRadiusUV } from './ground-shadow-softness.js';

const finiteNumber = (value, fallback) => {
  const number = typeof value === 'number' || typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(number) ? number : fallback;
};
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

/** The photographic tabletop is a virtual plane. Keep the calibrated rectangle
 * as its minimum size, then cover the complete moved model and its directional
 * ground projection. The symmetric receiver remains centred at the photo's
 * origin; neither calibration scale nor source geometry is changed.
 */
export function photographicReceiverSize({ bed, bounds, lightAzimuth, lightElevation, softness, mmToWorld, floorY = 0 } = {}) {
  const width = finiteNumber(bed?.width, NaN), depth = finiteNumber(bed?.depth, NaN);
  if (!(width > 0 && depth > 0)) return null;
  const original = { width, depth };
  if (!bounds?.isBox3 || bounds.isEmpty()
    || ![bounds.min.x, bounds.min.y, bounds.min.z, bounds.max.x, bounds.max.y, bounds.max.z].every(Number.isFinite)) return original;
  const azimuth = ((finiteNumber(lightAzimuth, -45) + 180) % 360 + 360) % 360 - 180;
  const elevation = clamp(finiteNumber(lightElevation, 65), 10, 85) * Math.PI / 180;
  const angle = azimuth * Math.PI / 180;
  const slopeX = Math.sin(angle) / Math.tan(elevation), slopeZ = Math.cos(angle) / Math.tan(elevation);
  const groundY = finiteNumber(floorY, 0);
  const scale = Math.max(0, finiteNumber(mmToWorld, 1));
  // A unit-span orthographic camera returns the existing kernel's physical
  // radius directly, including its 1.2 world-unit cap. Add half a millimetre
  // for contact offsets and numerical edges independently of camera/output.
  const blur = groundShadowRadiusUV(softness, scale, { left: 0, right: 1, bottom: 0, top: 1 })[0];
  const margin = blur + .5 * scale;
  let extentX = 0, extentZ = 0;
  for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) {
    const height = y - groundY;
    extentX = Math.max(extentX, Math.abs(x), Math.abs(x - height * slopeX));
    extentZ = Math.max(extentZ, Math.abs(z), Math.abs(z - height * slopeZ));
  }
  const result = { width: Math.max(width, 2 * (extentX + margin)), depth: Math.max(depth, 2 * (extentZ + margin)) };
  return Number.isFinite(result.width) && Number.isFinite(result.depth) ? result : original;
}
