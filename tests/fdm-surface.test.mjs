import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createFDMSurfaceUniforms, injectFDMSurfaceShader, installFDMSurface, fdmLayerVisibility, resolveFDMSurfaceProfile, inferFilamentProfile, parseFDMSlicerSettings } from '../src/fdm-surface.js';

const shader = () => ({ vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader, uniforms: {} });

test('standard material surface perturbs normals and roughness after their source chunks without recoloring', () => {
  const source = shader(), uniforms = createFDMSurfaceUniforms({ layerHeightMm: 0.12, firstLayerHeightMm: 0.25, lineWidthMm: 0.42 });
  injectFDMSurfaceShader(source, uniforms);
  const fragment = source.fragmentShader;
  assert.ok(fragment.indexOf('varying vec3 vViewPosition;') < fragment.indexOf('vec3 fdmPerturbNormal('));
  assert.ok(fragment.indexOf('#include <roughnessmap_fragment>') < fragment.indexOf('roughnessFactor = clamp( roughnessFactor + fdmRoughnessVariation'));
  assert.match(fragment, /if \( fdmDetail > 0\.0 \) roughnessFactor = clamp/, 'disabling the finish must preserve original PBR roughness, including its maps');
  assert.ok(fragment.indexOf('#include <normal_fragment_maps>') < fragment.indexOf('normal = fdmPerturbNormal('));
  assert.ok(source.vertexShader.indexOf('fdmPrintMatrix * modelMatrix * fdmSurfaceWorld') < source.vertexShader.indexOf('#include <project_vertex>'));
  assert.match(source.vertexShader, /USE_INSTANCING[\s\S]*instanceMatrix/);
  assert.match(source.vertexShader, /USE_BATCHING[\s\S]*batchingMatrix/);
  assert.ok(!fragment.includes('diffuseColor.rgb *='), 'there are no painted black stripes or palette modifications');
  assert.equal(uniforms.fdmLayerHeight.value, 0.12);
  assert.equal(uniforms.fdmFirstLayerHeight.value, 0.25);
  assert.equal(uniforms.fdmLineWidth.value, 0.42);
  assert.throws(() => injectFDMSurfaceShader({ vertexShader: '', fragmentShader: '', uniforms: {} }, uniforms), /不支持/);
});

test('subpixel .12mm layers disappear before aliasing and resolved macro layers retain surface detail', () => {
  assert.equal(fdmLayerVisibility(0.005, 0.12), 1);
  assert.equal(fdmLayerVisibility(0.12, 0.12), 0);
  assert.equal(fdmLayerVisibility(0.6, 0.12), 0, 'a 190mm model at normal preview size must not show fake large black bands');
  const transition = fdmLayerVisibility(0.04, 0.12);
  assert.ok(transition > 0 && transition < 1);
  assert.ok(fdmLayerVisibility(0.02, 0.12) > transition);
});

test('millimetre texture coordinates follow translation, rotation and user display scale without drifting', () => {
  const printerPosition = new THREE.Vector3(10, 30, -5), normalizedScale = 0.02;
  const pose = new THREE.Matrix4().compose(new THREE.Vector3(4, 2, -1), new THREE.Quaternion().setFromEuler(new THREE.Euler(0.2, 0.8, -0.1)), new THREE.Vector3(1.8, 1.8, 1.8));
  const world = printerPosition.clone().multiplyScalar(normalizedScale).applyMatrix4(pose);
  const worldToPrint = new THREE.Matrix4().makeScale(1 / normalizedScale, 1 / normalizedScale, 1 / normalizedScale).multiply(pose.clone().invert());
  const uniforms = createFDMSurfaceUniforms({ printMatrix: worldToPrint });
  assert.ok(world.clone().applyMatrix4(uniforms.fdmPrintMatrix.value).distanceTo(printerPosition) < 1e-10);
  worldToPrint.elements[12] += 99;
  assert.notDeepEqual(uniforms.fdmPrintMatrix.value.elements, worldToPrint.elements, 'uniform matrices are copied instead of sharing mutable caller state');
});

test('auto filament finish and explicit global overrides remain nonmetallic and keep source colors', () => {
  assert.equal(inferFilamentProfile({ type: 'PLA', name: 'Bambu PLA Matte' }), 'matte');
  assert.equal(inferFilamentProfile({ type: 'PLA', name: '丝绸双色' }), 'silk');
  assert.equal(inferFilamentProfile({ type: 'PETG', name: 'Generic' }), 'petg');
  const material = new THREE.MeshStandardMaterial({ color: '#23599c' });
  material.userData.fdmProfile = 'silk';
  const original = material.color.clone(), handle = installFDMSurface(material, { surfaceDetail: 0.6 });
  assert.equal(material.roughness, resolveFDMSurfaceProfile('auto', 'silk').roughness);
  handle.update({ surfacePreset: 'matte', surfaceDetail: 0 });
  assert.equal(material.roughness, resolveFDMSurfaceProfile('matte').roughness);
  assert.equal(handle.uniforms.fdmDetail.value, 0);
  assert.equal(material.metalness, 0);
  assert.ok(material.color.equals(original));
});

test('surface hooks preserve existing grading hooks and cloned materials get independent uniforms without double injection', () => {
  const material = new THREE.MeshStandardMaterial();
  material.onBeforeCompile = source => { source.fragmentShader += '\n// existing-model-grading'; };
  const first = installFDMSurface(material, { topSurface: true });
  assert.equal(installFDMSurface(material), first, 'installing twice is idempotent');
  assert.equal(first.uniforms.fdmTopOnly.value, 1);
  const clone = material.clone();
  clone.onBeforeCompile = material.onBeforeCompile;
  clone.customProgramCacheKey = material.customProgramCacheKey;
  const second = installFDMSurface(clone, { surfaceDetail: 0.2 });
  const compiled = shader(); clone.onBeforeCompile(compiled, {});
  assert.match(compiled.fragmentShader, /existing-model-grading/);
  assert.equal((compiled.fragmentShader.match(/vec3 fdmSurfaceGradient\(/g) || []).length, 1);
  assert.equal(compiled.uniforms.fdmDetail, second.uniforms.fdmDetail);
  assert.notEqual(first.uniforms.fdmDetail, second.uniforms.fdmDetail);
});

test('physical slicer dimensions and per-filament finish names distinguish metadata from fallback estimates', () => {
  const actual = parseFDMSlicerSettings({ layer_height: '0.12', initial_layer_print_height: '0.25', line_width: '0.42', filament_type: ['PLA', 'PLA', 'PETG'], filament_settings_id: ['Generic HS PLA', 'PLA Matte', 'PETG clear'] }, 3);
  assert.equal(actual.layerHeightMm, 0.12); assert.equal(actual.firstLayerHeightMm, 0.25); assert.equal(actual.lineWidthMm, 0.42);
  assert.deepEqual(actual.surfaceSettingsInferred, { layerHeight: false, firstLayerHeight: false, lineWidth: false });
  assert.deepEqual(actual.materialProfiles.map(item => item.profile), ['pla', 'matte', 'petg']);
  const missing = parseFDMSlicerSettings({}, 2);
  assert.equal(missing.layerHeightMm, 0.16); assert.equal(missing.firstLayerHeightMm, 0.2); assert.equal(missing.lineWidthMm, 0.42);
  assert.equal(missing.surfaceSettingSources.layerHeight.source, 'studio-default');
  assert.ok(missing.surfaceSettingsInferred.layerHeight && missing.surfaceSettingsInferred.lineWidth);
  assert.ok(missing.materialProfiles.every(item => item.inferred));
  const percentage = parseFDMSlicerSettings({ line_width: '105%', nozzle_diameter: ['0.4'] });
  assert.ok(Math.abs(percentage.lineWidthMm - 0.42) < 1e-12);
  assert.equal(parseFDMSlicerSettings({layer_height:'0.12'}).firstLayerHeightMm,0.2,'missing first layer is independent of saved regular layer');
});
