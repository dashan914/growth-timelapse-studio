const clamp01 = value => Math.max(0, Math.min(1, value));
// Match the transfer functions in the pinned Three.js color-space chunk.
export const linearToSRGB = value => value <= 0.0031308 ? value * 12.92 : 1.055 * value ** 0.41666 - 0.055;
export const sRGBToLinear = value => value <= 0.04045 ? value * 0.0773993808 : (value * 0.9478672986 + 0.0521327014) ** 2.4;

/** Linear RGB to emit before output conversion so screen-space alpha blending
 * darkens a photo exactly as black alpha blending in a linear render target.
 * The supplied photo samples are decoded linear RGB, not their JPEG bytes.
 */
export function photoShadowScreenColor(photoLinear, opacity) {
  const number = Number(opacity);
  const alpha = clamp01(Number.isFinite(number) ? number : 0);
  if (alpha < 1e-6) return [0, 0, 0];
  return [0, 1, 2].map(index => {
    const value = Number(photoLinear?.[index]);
    const channel = Number.isFinite(value) ? clamp01(value) : 0;
    const original = linearToSRGB(channel);
    const shaded = linearToSRGB(channel * (1 - alpha));
    return sRGBToLinear(clamp01((shaded - original * (1 - alpha)) / alpha));
  });
}

/** Follow the same bottom-left viewport UV and Matrix3 as Scene.background. */
export function photoShadowUV(fragCoord, viewport, matrix) {
  const u = (fragCoord[0] - viewport[0]) / viewport[2];
  const v = (fragCoord[1] - viewport[1]) / viewport[3];
  const elements = matrix.elements || matrix;
  return [elements[0] * u + elements[3] * v + elements[6], elements[1] * u + elements[4] * v + elements[7]];
}

/** A small physical receiver offset, independent of loaded support geometry. */
export function contactShadowNormalBias(modelWorldScale) {
  const number = Number(modelWorldScale);
  return Math.min(0.035, 0.08 * (Number.isFinite(number) && number > 0 ? number : 1));
}

export const PHOTO_SHADOW_GLSL = /* glsl */ `
uniform sampler2D photoShadowMap;
uniform mat3 photoShadowUvTransform;
uniform vec4 photoShadowViewport;
uniform float photoShadowScreen;
uniform float photoShadowVideo;
uniform float photoShadowIntensity;

vec3 photoShadowCompensation(float opacity) {
  vec2 screenUv = (gl_FragCoord.xy - photoShadowViewport.xy) / max(photoShadowViewport.zw, vec2(1.0));
  vec2 photoUv = (photoShadowUvTransform * vec3(screenUv, 1.0)).xy;
  vec3 photoLinear = texture2D(photoShadowMap, photoUv).rgb;
  // Image textures are hardware-decoded. Three's VideoTexture background uses
  // an inline decode; mirror that path instead of decoding a video twice.
  if (photoShadowVideo > 0.5) photoLinear = sRGBTransferEOTF(vec4(photoLinear, 1.0)).rgb;
  photoLinear *= photoShadowIntensity;
  vec3 original = sRGBTransferOETF(vec4(photoLinear, 1.0)).rgb;
  vec3 shaded = sRGBTransferOETF(vec4(photoLinear * (1.0 - opacity), 1.0)).rgb;
  vec3 encodedCompensation = clamp((shaded - original * (1.0 - opacity)) / opacity, 0.0, 1.0);
  return sRGBTransferEOTF(vec4(encodedCompensation, 1.0)).rgb;
}
`;
