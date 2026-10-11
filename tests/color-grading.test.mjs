import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { COLOR_GRADING_KEYS, colorGradingValues, gradeLinearRGB } from '../src/color-grading.js';
import { GrowthStudio } from '../src/studio.js';

const luminance = rgb => rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;

test('neutral model grading preserves exact pixels and never edits source RGB or cached settings', () => {
  const source = Object.freeze([0.043, 0.18, 0.817]);
  const options = Object.freeze(Object.fromEntries(COLOR_GRADING_KEYS.map(key => [key, 0])));
  assert.deepEqual(gradeLinearRGB(source, options), [...source]);
  assert.deepEqual(gradeLinearRGB(source), [...source]);
  assert.equal(colorGradingValues({}).enabled, false);
  assert.deepEqual(source, [0.043, 0.18, 0.817]);
});

test('tint moves neutral tones toward magenta or green while preserving unclipped luminance', () => {
  const gray = [0.25, 0.25, 0.25];
  const magenta = gradeLinearRGB(gray, { tint: 100 });
  const green = gradeLinearRGB(gray, { tint: -100 });
  assert.ok(magenta[0] > magenta[1] && magenta[2] > magenta[1]);
  assert.ok(green[1] > green[0] && green[1] > green[2]);
  assert.ok(Math.abs(luminance(magenta) - 0.25) < 1e-12);
  assert.ok(Math.abs(luminance(green) - 0.25) < 1e-12);
  assert.deepEqual(gray, [0.25, 0.25, 0.25]);
});

test('shadow and highlight sliders adjust different tone ranges without moving black or white', () => {
  const dark = [0.08, 0.08, 0.08], light = [0.8, 0.8, 0.8];
  assert.ok(gradeLinearRGB(dark, { shadows: 100 })[0] > dark[0]);
  assert.ok(gradeLinearRGB(dark, { shadows: -100 })[0] < dark[0]);
  assert.deepEqual(gradeLinearRGB(light, { shadows: 100 }), light);
  assert.ok(gradeLinearRGB(light, { highlights: 100 })[0] > light[0]);
  assert.ok(gradeLinearRGB(light, { highlights: -100 })[0] < light[0]);
  assert.deepEqual(gradeLinearRGB(dark, { highlights: -100 }), dark);
  for (const shadows of [-100, 100]) for (const highlights of [-100, 100]) {
    assert.deepEqual(gradeLinearRGB([0, 0, 0], { shadows, highlights }), [0, 0, 0]);
    assert.deepEqual(gradeLinearRGB([1, 1, 1], { shadows, highlights }), [1, 1, 1]);
  }
});

test('contrast changes separation around linear middle gray, and saturation can remove all chroma', () => {
  const dark = [0.05, 0.05, 0.05], light = [0.6, 0.6, 0.6];
  assert.ok(gradeLinearRGB(dark, { contrast: 100 })[0] < dark[0]);
  assert.ok(gradeLinearRGB(light, { contrast: 100 })[0] > light[0]);
  assert.ok(gradeLinearRGB(dark, { contrast: -100 })[0] > dark[0]);
  assert.ok(gradeLinearRGB(light, { contrast: -100 })[0] < light[0]);
  assert.deepEqual(gradeLinearRGB([0.18, 0.18, 0.18], { contrast: 100 }), [0.18, 0.18, 0.18]);
  const color = [0.18, 0.4, 0.65];
  const gray = gradeLinearRGB(color, { saturation: -100 });
  assert.ok(gray.every(channel => Math.abs(channel - luminance(color)) < 1e-12));
  const saturated = gradeLinearRGB(color, { saturation: 100 });
  assert.ok(Math.max(...saturated) - Math.min(...saturated) > Math.max(...color) - Math.min(...color));
});

test('all endpoint combinations, invalid settings, black, white and HDR inputs remain finite and bounded', () => {
  const samples = [[0, 0, 0], [1, 1, 1], [0.001, 0.02, 0.9], [3, -2, 9], [NaN, Infinity, -Infinity]];
  for (let flags = 0; flags < 32; flags++) {
    const options = Object.fromEntries(COLOR_GRADING_KEYS.map((key, i) => [key, flags & 1 << i ? 100 : -100]));
    for (const rgb of samples) assert.ok(gradeLinearRGB(rgb, options).every(value => Number.isFinite(value) && value >= 0 && value <= 1));
  }
  const sanitized = colorGradingValues({ tint: 1000, shadows: -1000, highlights: '50', contrast: Infinity, saturation: NaN });
  assert.deepEqual(sanitized, { tint: 1, shadows: -1, highlights: 0.5, contrast: 0, saturation: 0, enabled: true });
});

test('body, caps, solid supports and paths share model-only grading before direct/DOF color conversion', () => {
  const studio = Object.create(GrowthStudio.prototype);
  studio.options = { exposure: 1, tint: 0, shadows: 0, highlights: 0, contrast: 0, saturation: 0 };
  studio.keyLight = new THREE.DirectionalLight();
  studio.scene = new THREE.Scene();
  const photo = new THREE.Texture();
  studio.scene.background = photo;
  studio.renderer = { toneMapping: THREE.NoToneMapping, toneMappingExposure: 1 };
  const materials = [new THREE.MeshStandardMaterial({ color: '#23599c' }), new THREE.MeshBasicMaterial({ color: '#f0e8d6' }), new LineMaterial({ color: '#c89e59' })];
  const colors = materials.map(material => material.color.clone());
  const shaders = materials.map(material => {
    studio._prepareModelTone(material);
    const fragmentShader = material.isLineMaterial ? material.fragmentShader : material.isMeshBasicMaterial ? THREE.ShaderLib.basic.fragmentShader : THREE.ShaderLib.standard.fragmentShader;
    const shader = { uniforms: {}, fragmentShader };
    material.onBeforeCompile(shader, studio.renderer);
    assert.match(shader.fragmentShader, /modelGradeLinearRGB\(ACESFilmicToneMapping\(gl_FragColor\.rgb \* modelExposure\)\)/);
    assert.ok(shader.fragmentShader.indexOf('modelGradeLinearRGB(ACES') < shader.fragmentShader.indexOf('#include <colorspace_fragment>'));
    assert.equal(shader.uniforms.modelGradeEnabled.value, 0);
    return shader;
  });
  Object.assign(studio.options, { tint: 70, shadows: -30, highlights: 20, contrast: 15, saturation: -10 });
  studio._applyLighting();
  for (let index = 0; index < materials.length; index++) {
    assert.ok(materials[index].color.equals(colors[index]));
    assert.equal(shaders[index].uniforms.modelGradeEnabled.value, 1);
    assert.deepEqual(shaders[index].uniforms.modelGradeControls.value.toArray(), [0.7, -0.3, 0.2, 0.15]);
    assert.equal(shaders[index].uniforms.modelGradeSaturation.value, -0.1);
    assert.equal(shaders[index].uniforms.modelGradeControls, shaders[0].uniforms.modelGradeControls);
  }
  assert.equal(studio.scene.background, photo);
  assert.equal(studio.renderer.toneMapping, THREE.NoToneMapping);
  assert.equal(studio.renderer.toneMappingExposure, 1);
});
