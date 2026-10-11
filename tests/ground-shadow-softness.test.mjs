import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { groundShadowRadiusUV, groundContactRadiusUV, GROUND_SHADOW_KERNEL, GROUND_CONTACT_KERNEL, GROUND_SHADOW_GLSL, injectGroundShadowSoftness } from '../src/ground-shadow-softness.js';
import { PHOTO_SHADOW_GLSL } from '../src/photo-shadow.js';

const camera = { left: -14, right: 14, bottom: -14, top: 14, zoom: 1 };
const scale = 8 / 210;
const weightSum = GROUND_SHADOW_KERNEL.reduce((sum, sample) => sum + sample.weight, 0);
// Convolve a hard half-plane using the very same offsets and weights as GLSL.
function edgeCoverage(position, radius) {
  if (!radius) return position >= 0 ? 1 : 0;
  return GROUND_SHADOW_KERNEL.reduce((sum, sample) => sum + (position + sample.x * radius >= 0 ? sample.weight : 0), 0) / weightSum;
}
function edgeWidth(radius) {
  if (!radius) return 0;
  const quantile = target => {
    let left = -radius, right = radius;
    for (let index = 0; index < 50; index++) {
      const mid = (left + right) / 2;
      if (edgeCoverage(mid, radius) < target) left = mid;
      else right = mid;
    }
    return (left + right) / 2;
  };
  return quantile(0.9) - quantile(0.1);
}

test('softness produces a monotonic, physically visible edge width using the rendered Gaussian disk', () => {
  assert.equal(GROUND_SHADOW_KERNEL.length, 64);
  const widths = [1, 2, 3, 5, 8].map(softness => edgeWidth(groundShadowRadiusUV(softness, scale, camera)[0] * 28));
  assert.equal(widths[0], 0);
  for (let index = 1; index < widths.length; index++) assert.ok(widths[index] > widths[index - 1]);
  assert.ok(widths.at(-1) / scale > 16, 'soft endpoint needs a visible 10–90% transition over16mm');
  assert.ok(widths.at(-1) > widths[2] * 5, 'hard/middle/soft endpoints must not collapse to near-identical edges');
  for (const sample of GROUND_SHADOW_KERNEL) {
    assert.ok(sample.x ** 2 + sample.y ** 2 < 1);
    assert.ok(sample.weight > 0 && sample.weight <= 1);
  }
  assert.ok(Math.abs(edgeCoverage(0, widths.at(-1)) - 0.5) < 0.04, 'deterministic disk stays balanced around the edge');
});

test('physical radius uses actual orthographic spans and stays independent of preview/export resolution', () => {
  const original = groundShadowRadiusUV(8, scale, camera);
  assert.deepEqual(original, [18 * scale / 28, 18 * scale / 28]);
  assert.deepEqual(groundShadowRadiusUV(8, scale, { ...camera, width: 842, height: 852, outputWidth: 3840, outputHeight: 2160, mapSize: 4096 }), original);
  assert.deepEqual(groundShadowRadiusUV(8, scale, { ...camera, right: 42, zoom: 2 }), [original[0], original[1] * 2]);
  assert.deepEqual(groundShadowRadiusUV(8, 100, camera), [1.2 / 28, 1.2 / 28]);
  assert.deepEqual(groundShadowRadiusUV(-9, scale, camera), [0, 0]);
  assert.deepEqual(groundShadowRadiusUV(8, 0, camera), [0, 0]);
  assert.ok(groundShadowRadiusUV(NaN, NaN, null).every(Number.isFinite));
  assert.deepEqual(groundShadowRadiusUV(8, scale, { left: 0, right: 0, top: 0, bottom: 0 }), [0, 0]);
});

test('tight sole filter retains its physical size across units, zoom and output resolutions', () => {
  const original = groundContactRadiusUV(scale, camera);
  assert.deepEqual(original, [.45 * scale / 28, .45 * scale / 28]);
  assert.deepEqual(groundContactRadiusUV(scale, { ...camera, width: 842, height: 852, outputWidth: 3840, outputHeight: 2160, mapSize: 4096 }), original);
  assert.deepEqual(groundContactRadiusUV(scale, { ...camera, right: 42, zoom: 2 }), [original[0], original[1] * 2]);
  const factor = 3.75;
  assert.deepEqual(groundContactRadiusUV(scale * factor, {
    left: camera.left * factor, right: camera.right * factor,
    bottom: camera.bottom * factor, top: camera.top * factor, zoom: 1,
  }), original);
  assert.deepEqual(groundContactRadiusUV(100, camera), [1.2 / 28, 1.2 / 28]);
  assert.deepEqual(groundContactRadiusUV(0, camera), [0, 0]);
  assert.deepEqual(groundContactRadiusUV(-2, camera), [0, 0]);
  assert.ok(groundContactRadiusUV(NaN, null).every(Number.isFinite));
  assert.deepEqual(groundContactRadiusUV(scale, { left: 0, right: 0, top: 0, bottom: 0 }), [0, 0]);
});

test('real narrow sole occlusion remains visible without adding a shadow to clear plate pixels', () => {
  assert.equal(GROUND_CONTACT_KERNEL.length, 16);
  assert.ok(Object.isFrozen(GROUND_CONTACT_KERNEL));
  for (const sample of GROUND_CONTACT_KERNEL) {
    assert.ok(Object.isFrozen(sample));
    assert.ok(sample.x ** 2 + sample.y ** 2 < 1);
    assert.ok(sample.weight > 0 && sample.weight <= 1);
  }
  const softRadius = groundShadowRadiusUV(4, scale, camera)[0] * 28;
  const contactRadius = groundContactRadiusUV(scale, camera)[0] * 28;
  const soleHalfWidth = .8 * scale;
  const visibility = (position, radius, kernel) => {
    const total = kernel.reduce((sum, sample) => sum + sample.weight, 0);
    return kernel.reduce((sum, sample) => sum + (Math.abs(position + sample.x * radius) > soleHalfWidth ? sample.weight : 0), 0) / total;
  };
  const broad = visibility(0, softRadius, GROUND_SHADOW_KERNEL);
  const tight = visibility(0, contactRadius, GROUND_CONTACT_KERNEL);
  const combined = broad * .72 + tight * .28;
  assert.ok(broad > .4, 'a broad penumbra filter dilutes this genuinely thin occluding sole');
  assert.equal(tight, 0, 'the submillimetre kernel stays under this real sole');
  assert.ok(combined < broad * .75, 'local sole contact recovers useful contrast');
  const clearPosition = softRadius + soleHalfWidth + scale;
  assert.equal(visibility(clearPosition, softRadius, GROUND_SHADOW_KERNEL), 1);
  assert.equal(visibility(clearPosition, contactRadius, GROUND_CONTACT_KERNEL), 1, 'clear plate pixels remain fully lit');
  assert.equal(0 * (1 - combined), 0, 'zero receiver opacity also hides all contact occlusion');
});

test('ground shader retains pinned PCF guards, frustum, bias, intensity and stable64 tap center fallback', () => {
  assert.match(GROUND_SHADOW_GLSL, /defined\(USE_SHADOWMAP\).*defined\(SHADOWMAP_TYPE_PCF\).*NUM_DIR_LIGHT_SHADOWS > 0/);
  assert.match(GROUND_SHADOW_GLSL, /if \(!receiveShadow\) return 1\.0/);
  assert.match(GROUND_SHADOW_GLSL, /groundCoord\.xyz \/= groundCoord\.w/);
  assert.match(GROUND_SHADOW_GLSL, /groundCoord\.z \+= groundLight\.shadowBias/);
  assert.match(GROUND_SHADOW_GLSL, /groundCoord\.x >= 0\.0.*groundCoord\.z <= 1\.0/);
  assert.match(GROUND_SHADOW_GLSL, /groundIndex < 64/);
  assert.match(GROUND_SHADOW_GLSL, /texture\(directionalShadowMap\[0\], vec3\(groundCoord\.xy, groundCoord\.z\)\)/);
  assert.match(GROUND_SHADOW_GLSL, /mix\(1\.0, groundShadow, groundLight\.shadowIntensity\)/);
  assert.match(GROUND_SHADOW_GLSL, /#else\s+return getShadowMask\(\)/);
  assert.doesNotMatch(GROUND_SHADOW_GLSL, /gl_FragCoord|interleavedGradientNoise|random/);
  // Three's PCF directional map is a comparison sampler in the pinned version.
  assert.match(THREE.ShaderChunk.shadowmap_pars_fragment, /uniform sampler2DShadow directionalShadowMap/);
});

test('disabled contact retains the prior soft visibility and enabled contact uses the same physical caster map', () => {
  assert.match(GROUND_SHADOW_GLSL, /uniform vec2 groundShadowContactRadius/);
  assert.match(GROUND_SHADOW_GLSL, /uniform float groundShadowContactStrength/);
  assert.match(GROUND_SHADOW_GLSL, /groundContactStrength = clamp\(groundShadowContactStrength, 0\.0, 1\.0\)/);
  const contactStart = GROUND_SHADOW_GLSL.indexOf('if (groundContactStrength > 0.0)');
  const blend = GROUND_SHADOW_GLSL.indexOf('groundShadow = mix(groundShadow, groundContactShadow, groundContactStrength)');
  assert.ok(contactStart > GROUND_SHADOW_GLSL.indexOf('groundShadow /= groundWeight'));
  assert.ok(blend > contactStart && blend < GROUND_SHADOW_GLSL.indexOf('return mix(1.0, groundShadow, groundLight.shadowIntensity)'));
  assert.match(GROUND_SHADOW_GLSL.slice(contactStart, blend), /contactIndex < 16/);
  assert.match(GROUND_SHADOW_GLSL.slice(contactStart, blend), /texture\(directionalShadowMap\[0\], vec3\(groundCoord\.xy \+ contactOffset, groundCoord\.z\)\)/);
  assert.doesNotMatch(GROUND_SHADOW_GLSL.slice(contactStart, blend), /modelPosition|ellipse|gl_FragCoord|cameraPosition/);
});

test('only ShadowMaterial opacity mask changes, with uniforms shared and prior photo compensation intact', () => {
  const shader = { uniforms: {}, fragmentShader: THREE.ShaderLib.shadow.fragmentShader };
  shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>\n${PHOTO_SHADOW_GLSL}`)
    .replace('#include <tonemapping_fragment>', 'if (photoShadowScreen > 0.5 && gl_FragColor.a > 0.000001) { gl_FragColor.rgb = photoShadowCompensation(gl_FragColor.a); }\n#include <tonemapping_fragment>');
  const uniforms = {
    groundShadowRadius: { value: new THREE.Vector2(...groundShadowRadiusUV(5, scale, camera)) },
    groundShadowContactRadius: { value: new THREE.Vector2(...groundContactRadiusUV(scale, camera)) },
    groundShadowContactStrength: { value: .28 },
  };
  assert.equal(injectGroundShadowSoftness(shader, uniforms), true);
  assert.equal(shader.uniforms.groundShadowRadius, uniforms.groundShadowRadius);
  assert.equal(shader.uniforms.groundShadowContactRadius, uniforms.groundShadowContactRadius);
  assert.equal(shader.uniforms.groundShadowContactStrength, uniforms.groundShadowContactStrength);
  assert.ok(shader.fragmentShader.indexOf('#include <shadowmask_pars_fragment>') < shader.fragmentShader.indexOf('float getGroundShadowMask()'));
  assert.match(shader.fragmentShader, /opacity \* \(1\.0 - getGroundShadowMask\(\)\)/);
  assert.match(shader.fragmentShader, /gl_FragColor\.rgb = photoShadowCompensation\(gl_FragColor\.a\)/);
  assert.ok(shader.fragmentShader.indexOf('photoShadowCompensation(gl_FragColor.a)') < shader.fragmentShader.indexOf('#include <colorspace_fragment>'));
  assert.equal(injectGroundShadowSoftness(shader, uniforms), false);
  assert.equal(shader.fragmentShader.split('float getGroundShadowMask()').length, 2);
  const pbr = { uniforms: {}, fragmentShader: THREE.ShaderLib.standard.fragmentShader };
  const before = pbr.fragmentShader;
  assert.equal(injectGroundShadowSoftness(pbr, uniforms), false);
  assert.equal(pbr.fragmentShader, before);
  assert.deepEqual(pbr.uniforms, {});
});
