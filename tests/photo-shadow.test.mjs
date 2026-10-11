import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { linearToSRGB, sRGBToLinear, photoShadowScreenColor, photoShadowUV, contactShadowNormalBias } from '../src/photo-shadow.js';
import { coverTexture } from '../src/growth-math.js';
import { GrowthStudio } from '../src/studio.js';

test('photo-aware screen shadows match linear-target darkening without modifying background samples', () => {
  const photo = Object.freeze([128 / 255, 74 / 255, 206 / 255]);
  const linear = Object.freeze(photo.map(sRGBToLinear));
  for (const alpha of [0.01, 0.15, 0.25, 0.7, 1]) {
    const color = photoShadowScreenColor(linear, alpha);
    color.forEach((channel, i) => {
      const screen = linearToSRGB(linear[i]) * (1 - alpha) + linearToSRGB(channel) * alpha;
      const target = linearToSRGB(linear[i] * (1 - alpha));
      assert.ok(Math.abs(screen - target) < 2e-5, `channel${i}, alpha${alpha}`);
    });
  }
  assert.deepEqual(photo, [128 / 255, 74 / 255, 206 / 255]);
  assert.deepEqual(photoShadowScreenColor(linear, 0), [0, 0, 0]);
  assert.ok(Math.abs(linearToSRGB(sRGBToLinear(128 / 255) * 0.75) * 255 - 112) < 0.5);
});

test('shadow compensation stays finite at black, white, colored and opaque endpoints', () => {
  for (const alpha of [0, 1e-7, 0.001, 0.25, 0.7, 1, NaN, Infinity]) {
    for (const photo of [[0, 0, 0], [1, 1, 1], [1, 0.1, 0.4], [NaN, Infinity, -1]]) {
      assert.ok(photoShadowScreenColor(photo, alpha).every(value => Number.isFinite(value) && value >= 0 && value <= 1));
    }
  }
});

test('photo-shadow sampling reuses exact cover/crop matrices and current pixel viewport', () => {
  const texture = new THREE.Texture();
  for (const framing of [coverTexture(1200, 900, 1920, 1080), { repeatX: 0.6, repeatY: 0.5, offsetX: 0.15, offsetY: 0.38 }]) {
    texture.repeat.set(framing.repeatX, framing.repeatY); texture.offset.set(framing.offsetX, framing.offsetY); texture.updateMatrix();
    const viewport = [12, 24, 1920, 1080];
    for (const [u, v] of [[0, 0], [1, 1], [0.31, 0.77]]) {
      const sampled = photoShadowUV([viewport[0] + u * viewport[2], viewport[1] + v * viewport[3]], viewport, texture.matrix);
      const backgroundUv = new THREE.Vector3(u, v, 1).applyMatrix3(texture.matrix);
      assert.ok(Math.hypot(sampled[0] - backgroundUv.x, sampled[1] - backgroundUv.y) < 1e-12);
    }
  }
});

test('ground shader compensates only the photo/sRGB screen and mirrors image/video decoding', () => {
  const studio = Object.create(GrowthStudio.prototype);
  studio._floorShadowMaterial = new THREE.ShadowMaterial({ opacity: 0.25 });
  studio._preparePhotoShadowMaterial();
  const shader = { uniforms: {}, fragmentShader: THREE.ShaderLib.shadow.fragmentShader };
  studio._floorShadowMaterial.onBeforeCompile(shader, {});
  assert.match(shader.fragmentShader, /photoShadowUvTransform \* vec3\(screenUv, 1.0\)/);
  assert.match(shader.fragmentShader, /if \(photoShadowVideo > 0.5\) photoLinear = sRGBTransferEOTF/);
  assert.match(shader.fragmentShader, /photoShadowScreen > 0.5 && gl_FragColor.a > 0.000001/);
  assert.ok(shader.fragmentShader.indexOf('gl_FragColor.rgb = photoShadowCompensation') < shader.fragmentShader.indexOf('#include <colorspace_fragment>'));
  assert.doesNotMatch(shader.fragmentShader, /modelExposure|ACESFilmicToneMapping/);
  const texture = new THREE.Texture(); texture.colorSpace = THREE.SRGBColorSpace;
  texture.repeat.set(0.6, 0.5); texture.offset.set(0.15, 0.38); texture.updateMatrix();
  const matrix = [...texture.matrix.elements];
  studio._backgroundTexture = texture;
  const scene = new THREE.Scene(); scene.background = texture;
  let target = null;
  const renderer = { outputColorSpace: THREE.SRGBColorSpace, getRenderTarget: () => target, getCurrentViewport: value => value.set(12, 24, 1920, 1080) };
  const bind = () => studio._floorShadowMaterial.onBeforeRender(renderer, scene);
  bind();
  assert.equal(shader.uniforms.photoShadowScreen.value, 1);
  assert.equal(shader.uniforms.photoShadowMap.value, texture);
  assert.deepEqual(shader.uniforms.photoShadowUvTransform.value.elements, matrix);
  assert.deepEqual(shader.uniforms.photoShadowViewport.value.toArray(), [12, 24, 1920, 1080]);
  assert.equal(shader.uniforms.photoShadowVideo.value, 0);
  target = new THREE.WebGLRenderTarget(1920, 1080); bind();
  assert.equal(shader.uniforms.photoShadowScreen.value, 0, 'linear DOF/analysis targets keep black shadow blending');
  target = null; renderer.outputColorSpace = THREE.LinearSRGBColorSpace; bind();
  assert.equal(shader.uniforms.photoShadowScreen.value, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const video = new THREE.VideoTexture({}); video.colorSpace = THREE.SRGBColorSpace;
  studio._backgroundTexture = video; scene.background = video; bind();
  assert.equal(shader.uniforms.photoShadowVideo.value, 1);
  studio._backgroundTexture = null; scene.background = null; bind();
  assert.equal(shader.uniforms.photoShadowScreen.value, 0);
  assert.equal(shader.uniforms.photoShadowMap.value, null);
  assert.deepEqual(texture.matrix.elements, matrix);
  assert.equal(studio._floorShadowMaterial.color.getHexString(), '000000');
});

test('physical shadow bias scales in millimetres with a bounded scene-unit fallback', () => {
  assert.ok(Math.abs(contactShadowNormalBias(8 / 210) / (8 / 210) - 0.08) < 1e-12);
  assert.ok(Math.abs(contactShadowNormalBias(8 / 120) / (8 / 120) - 0.08) < 1e-12);
  assert.equal(contactShadowNormalBias(1), 0.035);
  assert.equal(contactShadowNormalBias(NaN), 0.035);
});

test('plate softness updates the receiver kernel in physical units through direct, DOF and export targets', () => {
  const studio = Object.create(GrowthStudio.prototype);
  studio.options = { shadowRadius: 1, modelScale: 1 };
  studio.normalized = new THREE.Group(); studio.normalized.scale.setScalar(8 / 210);
  studio.keyLight = new THREE.DirectionalLight();
  Object.assign(studio.keyLight.shadow.camera, { left: -14, right: 14, top: 14, bottom: -14 });
  studio._floorShadowMaterial = new THREE.ShadowMaterial({ opacity: 0.17 });
  studio._preparePhotoShadowMaterial();
  const shader = { uniforms: {}, fragmentShader: THREE.ShaderLib.shadow.fragmentShader };
  studio._floorShadowMaterial.onBeforeCompile(shader, {});
  const texture = new THREE.Texture(); texture.colorSpace = THREE.SRGBColorSpace;
  studio._backgroundTexture = texture;
  const scene = new THREE.Scene(); scene.background = texture;
  let target = null, width = 640, height = 480;
  const renderer = { outputColorSpace: THREE.SRGBColorSpace, getRenderTarget: () => target, getCurrentViewport: v => v.set(0, 0, width, height) };
  const bind = () => studio._floorShadowMaterial.onBeforeRender(renderer, scene);
  bind();
  assert.deepEqual(shader.uniforms.groundShadowRadius.value.toArray(), [0, 0]);
  studio.options.shadowRadius = 8; bind();
  const soft = shader.uniforms.groundShadowRadius.value.toArray();
  assert.ok(soft[0] > 0.02 && soft[0] === soft[1], 'the maximum is visibly wider than the old 8/2048 texel radius');
  width = 2880; height = 2160; bind();
  assert.deepEqual(shader.uniforms.groundShadowRadius.value.toArray(), soft, 'supersampling must preserve the physical blur width');
  target = new THREE.WebGLRenderTarget(width, height); bind();
  assert.deepEqual(shader.uniforms.groundShadowRadius.value.toArray(), soft, 'DOF uses the same mask as direct rendering');
  assert.equal(shader.uniforms.photoShadowScreen.value, 0);
  assert.equal(studio._floorShadowMaterial.opacity, 0.17, 'softness leaves the selected density untouched');
  assert.match(shader.fragmentShader, /getGroundShadowMask\(\)/);
  assert.match(shader.fragmentShader, /photoShadowCompensation\(gl_FragColor.a\)/);
  target.dispose();
});

test('tight contact filtering is scoped to printer photos and keeps their selected opacity and physical scale',()=>{
  const studio=Object.create(GrowthStudio.prototype);
  studio.options={shadowRadius:4,modelScale:2};studio.normalized=new THREE.Group();studio.normalized.scale.setScalar(.08);
  studio._metadata={sourceUnitsToMm:1};studio.keyLight=new THREE.DirectionalLight();
  Object.assign(studio.keyLight.shadow.camera,{left:-14,right:14,top:14,bottom:-14});
  studio._floorShadowMaterial=new THREE.ShadowMaterial({opacity:.24});studio._preparePhotoShadowMaterial();
  const shader={uniforms:{},fragmentShader:THREE.ShaderLib.shadow.fragmentShader};studio._floorShadowMaterial.onBeforeCompile(shader,{});
  studio._backgroundTexture=new THREE.Texture();const scene=new THREE.Scene();scene.background=studio._backgroundTexture;
  const renderer={outputColorSpace:THREE.SRGBColorSpace,getRenderTarget:()=>null,getCurrentViewport:value=>value.set(0,0,1440,1080)};
  for(const name of ['h2c','p1s','a1']){
    studio._photoIdentity='preset:'+name;studio._floorShadowMaterial.onBeforeRender(renderer,scene);
    assert.equal(shader.uniforms.groundShadowContactStrength.value,.28);
    assert.ok(Math.abs(shader.uniforms.groundShadowContactRadius.value.x-.45*.08*2/28)<1e-12);
    assert.equal(studio._floorShadowMaterial.opacity,.24);
  }
  for(const identity of ['preset:pastel-rug','preset:blue-grey','preset:teal-room',null,'custom']){
    studio._photoIdentity=identity;studio._floorShadowMaterial.onBeforeRender(renderer,scene);
    assert.equal(shader.uniforms.groundShadowContactStrength.value,0);
  }
  studio._floorShadowMaterial.opacity=0;studio._photoIdentity='preset:h2c';studio._floorShadowMaterial.onBeforeRender(renderer,scene);
  assert.equal(studio._floorShadowMaterial.opacity,0,'contact filtering never overrides a disabled shadow');
});
