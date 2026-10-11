import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { PrintEnvironmentCache, createPrintEnvironmentScene, printEnvironmentDescriptor, printEnvironmentKey, printReflectionIntensity, installPrintReflections, isManagedPrintEnvironmentTexture } from '../src/print-environment.js';
import { GrowthStudio } from '../src/studio.js';

test('procedural reflection descriptor ignores animation, tone edits and intensity, retaining physical light orientation', () => {
  const options = { colorTemperature: 7300, lightAzimuth: -100, lightElevation: 55, keyIntensity: 1.3 };
  const descriptor = printEnvironmentDescriptor(options, 'P1S.jpg');
  assert.equal(descriptor.kind, 'p1s');
  assert.equal(descriptor.azimuth, -100);
  assert.equal(descriptor.elevation, 55);
  assert.equal(printEnvironmentKey(printEnvironmentDescriptor({ ...options, exposure: 1.5, tint: 60, progress: 0.5, keyIntensity: 2 }, 'P1S.jpg')), printEnvironmentKey(descriptor));
  const scene = createPrintEnvironmentScene(descriptor);
  assert.equal(scene.userData.source, 'procedural-lighting-proxy');
  assert.ok(scene.children.every(node => !node.material.map && !node.material.toneMapped));
  assert.ok(scene.children.some(node => node.material.color.r > 1 || node.material.color.g > 1 || node.material.color.b > 1), 'panels retain HDR radiance for PMREM');
  assert.ok(printReflectionIntensity(options) < 0.2);
  assert.equal(printReflectionIntensity({ keyIntensity: 99 }), 0.25);
});

test('additional room reflection keeps hemisphere diffuse light and source colors/PBR unchanged', () => {
  const material = new THREE.MeshStandardMaterial({ color: '#23599c', roughness: 0.24, metalness: 0.76 });
  const source = material.color.clone();
  installPrintReflections(material);
  const shader = { uniforms: {}, fragmentShader: THREE.ShaderLib.standard.fragmentShader };
  material.onBeforeCompile(shader, {});
  assert.doesNotMatch(shader.fragmentShader, /iblIrradiance \+= getIBLIrradiance/);
  assert.match(shader.fragmentShader, /radiance \+= iblRadiance/);
  assert.ok(material.color.equals(source));
  assert.equal(material.roughness, 0.24); assert.equal(material.metalness, 0.76);
});

test('PMREM cache reuses textures, evicts bounded targets and owns their disposal exactly once', () => {
  let builds = 0, disposed = 0, generatorDisposed = 0;
  const cache = new PrintEnvironmentCache({}, { maxEntries: 2, generatorFactory: () => ({
    fromScene(scene) { builds++; assert.equal(scene.userData.source, 'procedural-lighting-proxy'); return { texture: new THREE.Texture(), dispose() { disposed++; } }; },
    dispose() { generatorDisposed++; },
  }) });
  const first = printEnvironmentDescriptor({ colorTemperature: 6500 });
  const texture = cache.get(first);
  assert.equal(cache.get(first), texture);
  assert.ok(isManagedPrintEnvironmentTexture(texture));
  assert.equal(builds, 1);
  cache.get(printEnvironmentDescriptor({ colorTemperature: 6900 }));
  cache.get(printEnvironmentDescriptor({ colorTemperature: 7300 }));
  assert.equal(builds, 3); assert.equal(disposed, 1); assert.equal(cache.entries.size, 2);
  cache.dispose(); assert.equal(disposed, 3); assert.equal(generatorDisposed, 1);
});

test('studio schedules lighting-only refresh, flushes export before frame one and leaves photo untouched', () => {
  const studio = Object.create(GrowthStudio.prototype);
  studio.options = { colorTemperature: 6500, lightAzimuth: -45, lightElevation: 55, keyIntensity: 1.3, progress: 1 };
  studio._metadata = { name: 'model' };
  studio._sourceMaterials = new Map(); studio._partCaps = [];
  studio.renderer = { isWebGLRenderer: true };
  studio.scene = new THREE.Scene(); const photo = new THREE.Texture(); studio.scene.background = photo;
  let builds = 0;
  const texture = new THREE.Texture(); texture.mapping = THREE.CubeUVReflectionMapping;
  studio._environmentCache = { get() { builds++; return texture; } };
  studio._scheduleEnvironment();
  for (let frame = 0; frame < 30; frame++) {
    Object.assign(studio.options, { progress: frame / 30, exposure: 1 + frame / 100, tint: frame }); studio._scheduleEnvironment();
  }
  assert.equal(builds, 1);
  studio.options.lightAzimuth = 20; studio._scheduleEnvironment();
  assert.equal(builds, 1, 'dragging the light defers the costly environment capture');
  studio._flushEnvironment(); assert.equal(builds, 2);
  assert.equal(studio._environmentTimer, null);
  assert.equal(studio.scene.background, photo);
});
