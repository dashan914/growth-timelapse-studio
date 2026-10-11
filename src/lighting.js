/** Approximate Planckian-locus xy from Kang et al. (2002), as documented by
 * Colour Science: https://colour.readthedocs.io/en/master/_modules/colour/temperature/kang2002.html
 * Converted to linear sRGB and normalized to neutral 6500 K for scene lights. */
function blackbodyRGB(temperature) {
  const t = temperature;
  const x = t <= 4000
    ? -0.2661239e9 / t ** 3 - 0.2343589e6 / t ** 2 + 0.8776956e3 / t + 0.179910
    : -3.0258469e9 / t ** 3 + 2.1070379e6 / t ** 2 + 0.2226347e3 / t + 0.240390;
  const y = t <= 2222
    ? -1.1063814 * x ** 3 - 1.3481102 * x ** 2 + 2.18555832 * x - 0.20219683
    : t <= 4000
    ? -0.9549476 * x ** 3 - 1.37418593 * x ** 2 + 2.09137015 * x - 0.16748867
    : 3.0817580 * x ** 3 - 5.8733867 * x ** 2 + 3.75112997 * x - 0.37001483;
  const X = x / y, Z = (1 - x - y) / y;
  return [3.2406 * X - 1.5372 - 0.4986 * Z, -0.9689 * X + 1.8758 + 0.0415 * Z, 0.0557 * X - 0.2040 + 1.0570 * Z];
}

export function kelvinToLinearRGB(value) {
  const number = Number(value);
  const temperature = Math.max(2000, Math.min(12000, Number.isFinite(number) ? number : 6500));
  const reference = blackbodyRGB(6500);
  const normalized = blackbodyRGB(temperature).map((channel, index) => Math.max(0, channel / reference[index]));
  const peak = Math.max(...normalized);
  return normalized.map(channel => channel / peak);
}

// UI, cache and renderer share one canonical set of bounds/defaults.
export { DEFAULT_LIGHTING, normalizeLighting } from './preset-lighting.js';
