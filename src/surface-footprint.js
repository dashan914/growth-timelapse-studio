/** Shader derivatives measure the render target, while periodic surface detail
 * must be band-limited to the final displayed/exported image. Supersampling
 * callers provide the render-target/output pixel ratio for the current pass. */
export function surfaceFootprintScale(renderer) {
  const scale = renderer?.userData?.printSurfaceFootprintScale;
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

export function bindSurfaceFootprintScale(material, uniform) {
  const before = material.onBeforeRender;
  material.onBeforeRender = function(renderer, ...args) {
    before.call(this, renderer, ...args);
    uniform.value = surfaceFootprintScale(renderer);
  };
}

/** Projected semicircle E[n] = (pi/4, 0). The discarded mean-normal length
 * broadens the filtered specular lobe, instead of keeping phase-dependent
 * derivatives from a normal which the output image can no longer resolve.
 * This is a roughness approximation; source filament roughness is unchanged. */
export function filteredSemicircleRoughness(roughness, weight) {
  if (![roughness, weight].every(Number.isFinite) || roughness < 0 || roughness > 1 || weight < 0 || weight > 1) throw new TypeError('层纹高光过滤参数无效。');
  return Math.sqrt(Math.min(1, roughness * roughness + (1 - Math.PI / 4) * weight));
}
