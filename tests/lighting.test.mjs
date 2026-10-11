import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { kelvinToLinearRGB } from '../src/lighting.js';
import { GrowthStudio } from '../src/studio.js';

test('light temperature is neutral at 6500K, warmer below and cooler above', () => {
  assert.deepEqual(kelvinToLinearRGB(6500), [1, 1, 1]);
  const warm = kelvinToLinearRGB(3000), cool = kelvinToLinearRGB(9000);
  assert.ok(warm[0] > warm[2]);
  assert.ok(cool[2] > cool[0]);
  for (const temperature of [0, 3000, 6500, 9000, 99999, NaN]) assert.ok(kelvinToLinearRGB(temperature).every(channel => Number.isFinite(channel) && channel >= 0 && channel <= 1));
});

test('model-only exposure leaves imported material colors and photo/output pipeline unchanged', () => {
  const studio = Object.create(GrowthStudio.prototype);
  studio.options = { exposure: 1, colorTemperature: 7300, keyIntensity: 2.55, ambientIntensity: 0.42, fillIntensity: 0.18, fillPosition: [8, 5, 5], lightAzimuth: 92 };
  studio.keyLight = new THREE.DirectionalLight();
  studio.hemisphereLight = new THREE.HemisphereLight();
  studio.fillLight = new THREE.DirectionalLight();
  studio.rimLight = new THREE.DirectionalLight();
  studio.renderer = { toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 8 };
  const photo = new THREE.Texture();
  studio.scene = new THREE.Scene(); studio.scene.background = photo;
  const material = new THREE.MeshStandardMaterial({ color: '#23599c' });
  const original = material.color.clone();
  studio._prepareModelTone(material);
  const shader = { uniforms: {}, fragmentShader: THREE.ShaderLib.standard.fragmentShader, vertexShader: THREE.ShaderLib.standard.vertexShader };
  material.onBeforeCompile(shader, studio.renderer);
  studio.options.exposure = 0.88; studio._applyLighting();
  assert.ok(material.color.equals(original));
  assert.equal(shader.uniforms.modelExposure.value, 0.88);
  assert.match(shader.fragmentShader, /ACESFilmicToneMapping\(gl_FragColor\.rgb \* modelExposure\)/);
  assert.doesNotMatch(shader.fragmentShader, /uniform float toneMappingExposure;/);
  assert.equal(studio.renderer.toneMapping, THREE.NoToneMapping);
  assert.equal(studio.renderer.toneMappingExposure, 1);
  assert.equal(studio.scene.background, photo);
  assert.equal(studio.options.lightAzimuth, 92);
  assert.equal(studio.rimLight.intensity, 0);
  assert.equal(studio.fillLight.intensity, 0.18);
  assert.deepEqual(studio.fillLight.position.toArray(), [8, 5, 5]);
});

test('model tone shader uses the same linear color path before direct or DOF output', () => {
  const studio = Object.create(GrowthStudio.prototype);
  studio.options = { exposure: 1 };
  const material = new THREE.MeshStandardMaterial();
  studio._prepareModelTone(material);
  const shader = { uniforms: {}, fragmentShader: THREE.ShaderLib.standard.fragmentShader, vertexShader: THREE.ShaderLib.standard.vertexShader };
  material.onBeforeCompile(shader, {});
  const position = shader.fragmentShader.indexOf('ACESFilmicToneMapping(gl_FragColor.rgb * modelExposure)');
  assert.ok(position > 0 && position < shader.fragmentShader.indexOf('#include <colorspace_fragment>'));
  assert.equal(material.transparent, false);
});
