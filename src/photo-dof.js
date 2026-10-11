// The photo is composited AFTER optical blur. The scene pass supplies linear,
// premultiplied RGBA on clear transparent black plus its actual geometry depth.
// This is a bounded screen-space circular-disk proxy, not lens ray tracing.
export const PHOTO_BACKGROUND_DEPTH = 0.9999999;
export const PHOTO_DOF_MAX_RADIUS_UV = 0.05;
export const PHOTO_DOF_DISK_SAMPLES = 49;

const disk = Array.from({ length: PHOTO_DOF_DISK_SAMPLES }, (_, index) => {
  if (!index) return [0, 0];
  const radius = Math.sqrt((index - .5) / (PHOTO_DOF_DISK_SAMPLES - 1));
  const angle = index * Math.PI * (3 - Math.sqrt(5));
  return [Math.cos(angle) * radius, Math.sin(angle) * radius];
});
export const PHOTO_DOF_DISK = Object.freeze(disk.map(point => Object.freeze(point)));

/** Replace only the stock main function. Keep Three's camera-depth decoding,
 * with no depth override/re-render and no dependence on scene normalization. */
export function preservePhotoBokehShader(fragmentShader) {
  const declaration = 'uniform float maxblur;';
  const main = fragmentShader.indexOf('void main()');
  const depthRead = 'float viewZ = getViewZ( getDepth( vUv ) );';
  if (!fragmentShader.includes(declaration) || !fragmentShader.includes(depthRead) || main < 0) throw new Error('景深着色器缺少照片保留插入点。');
  const declarations = `
    uniform float preservePhoto;
    uniform float cocRadiusUvCoefficient;
    uniform sampler2D tPhoto;
    uniform mat3 photoUvTransform;
    uniform float photoVideo;
    uniform float photoIntensity;
    uniform vec4 backgroundLinearRGBA;
  `;
  const sampleStatements = disk.map(([x, y]) => `gatherDisk(vec2(${x.toFixed(9)}, ${y.toFixed(9)}), radius, centreDepth, sum);`).join('\n');
  return fragmentShader.slice(0, main).replace(declaration, declarations + '\n' + declaration) + /* glsl */`
    float radiusAtDepth(const in float depth) {
      float axisDepth = max(nearClip, -getViewZ(depth));
      return min(maxblur, cocRadiusUvCoefficient * abs(axisDepth - focus) / axisDepth);
    }
    vec4 over(const in vec4 front, const in vec4 back) {
      return front + back * (1.0 - front.a);
    }
    // Equal-area gather. Source radius, not destination background depth,
    // determines whether a model sample's optical disk covers this pixel.
    void gatherDisk(const in vec2 point, const in float radius,
      const in float centreDepth, inout vec4 sum) {
      vec2 offset = point * radius * vec2(1.0 / aspect, 1.0);
      vec2 uv = vUv + offset;
      if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return;
      float sourceDepth = getDepth(uv);
      if (sourceDepth >= ${PHOTO_BACKGROUND_DEPTH}) return;
      float sourceRadius = radiusAtDepth(sourceDepth);
      float distanceUv = length(point) * radius;
      if (sourceRadius <= 0.0000001 || distanceUv > sourceRadius) return;
      float weight = radius * radius / (sourceRadius * sourceRadius);
      sum += texture2D(tColor, uv) * weight;
    }
    vec4 backdrop() {
      if (preservePhoto < 0.5) return backgroundLinearRGBA;
      vec4 photo = texture2D(tPhoto, (photoUvTransform * vec3(vUv, 1.0)).xy);
      if (photoVideo > 0.5) photo = sRGBTransferEOTF(photo);
      photo.rgb *= photoIntensity * photo.a;
      return photo;
    }
    void main() {
      float centreDepth = getDepth(vUv);
      vec4 centre = texture2D(tColor, vUv);
      vec4 background = backdrop();
      float radius = centreDepth >= ${PHOTO_BACKGROUND_DEPTH} ? maxblur : radiusAtDepth(centreDepth);
      if (radius <= 0.0000001) { gl_FragColor = over(centre, background); return; }
      vec4 sum = vec4(0.0);
      ${sampleStatements}
      vec4 blurred = sum / ${PHOTO_DOF_DISK_SAMPLES.toFixed(1)};
      // Optical coverage may overshoot one at depth discontinuities. Scale RGB
      // with alpha together; never clip the color channels or invent gray edges.
      blurred /= max(1.0, blurred.a);
      // Depth-free shadow catcher stays sharp and never supplies model samples.
      vec4 underlay = centreDepth >= ${PHOTO_BACKGROUND_DEPTH} ? over(centre, background) : background;
      gl_FragColor = over(blurred, underlay);
    }
  `;
}

/** The intermediate is premultiplied LINEAR RGB. Transfer functions must operate
 * on straight color, then re-premultiply in the display color space for WebGL's
 * premultiplied canvas; OETF(alpha*RGB) would create a bright transparent fringe. */
export function premultipliedDofOutputShader(fragmentShader) {
  const read = 'gl_FragColor = texture2D( tDiffuse, vUv );';
  const end = fragmentShader.lastIndexOf('}');
  if (!fragmentShader.includes(read) || end < 0) throw new Error('景深输出着色器缺少透明色彩转换插入点。');
  return fragmentShader.slice(0, end).replace(read, `${read}
      gl_FragColor.rgb = gl_FragColor.a > 0.0000001 ? gl_FragColor.rgb / gl_FragColor.a : vec3(0.0);`) + '\n gl_FragColor.rgb *= gl_FragColor.a;\n' + fragmentShader.slice(end);
}
