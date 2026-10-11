import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { growthSlice, visibleSegmentCount, coverTexture } from '../src/growth-math.js';
import { GrowthStudio, inspectThreeMFArchive, normalizeCrop } from '../src/studio.js';
import { zipSync, strToU8 } from 'three/addons/libs/fflate.module.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { parseGCode } from '../src/gcode.js';
import { focalLengthToFov, fovToFocalLength } from '../src/camera-lens.js';
import { PrintEnvironmentCache, printEnvironmentDescriptor } from '../src/print-environment.js';

test('stepped growth reveals complete layers and preserves empty/full endpoints', () => {
  assert.deepEqual(growthSlice(0, { min: 10, max: 30, layerCount: 4 }), { fraction: 0, visibleLayers: 0, height: 10, empty: true, complete: false });
  assert.equal(growthSlice(0.2499, { layerCount: 4 }).visibleLayers, 0);
  assert.equal(growthSlice(0.25, { layerCount: 4 }).height, 0.25);
  assert.deepEqual(growthSlice(1, { min: 10, max: 30, layerCount: 4 }), { fraction: 1, visibleLayers: 4, height: 30, empty: false, complete: true });
});

test('top-down growth uses actual translated/scaled bounds', () => {
  assert.equal(growthSlice(0.25, { min: -4, max: 12, direction: 'down', layerCount: 4 }).height, 8);
  assert.equal(growthSlice(1, { min: -4, max: 12, direction: 'down' }).height, -4);
  assert.equal(growthSlice(0.123, { min: 0, max: 100, stepped: false }).height, 12.3);
});

test('invalid progress is safely clamped and large layers keep exact boundaries', () => {
  assert.equal(growthSlice(-1).empty, true);
  assert.equal(growthSlice(2).complete, true);
  assert.equal(growthSlice(NaN).empty, true);
  assert.equal(growthSlice(29 / 238, { layerCount: 238 }).visibleLayers, 29);
});

test('G-code growth reveals all segments of a layer, in either direction', () => {
  assert.equal(visibleSegmentCount(new Uint32Array([0, 0, 1, 2, 2, 3]), 2, 4), 3);
  assert.equal(visibleSegmentCount(new Uint32Array([3, 2, 2, 1, 0, 0]), 2, 4, 'down'), 3);
  assert.equal(visibleSegmentCount(new Uint32Array([0, 2]), 0, 3), 0);
  assert.equal(visibleSegmentCount(new Uint32Array([0, 2]), 3, 3), 2);
});

test('background cover crops centrally without distortion', () => {
  assert.deepEqual(coverTexture(1920, 1080, 1920, 1080), { repeatX: 1, repeatY: 1, offsetX: 0, offsetY: 0 });
  const portrait = coverTexture(1920, 1080, 1080, 1920);
  assert.equal(portrait.repeatY, 1);
  assert.ok(portrait.repeatX < 1);
  assert.equal(portrait.offsetX, (1 - portrait.repeatX) / 2);
  const wide = coverTexture(1080, 1920, 1920, 1080);
  assert.equal(wide.repeatX, 1);
  assert.ok(wide.repeatY < 1);
});

// Exercise import ownership without starting a browser or requiring a GPU.
function importFixture() {
  const studio = Object.create(GrowthStudio.prototype);
  studio.options = { color: '#82b9a0' };
  studio.clipPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 8);
  studio.layerUniforms = { enabled: { value: 1 }, count: { value: 240 }, min: { value: 0 }, max: { value: 8 } };
  studio.scene = new THREE.Scene();
  studio.modelGroup = new THREE.Group();
  studio.scene.add(studio.modelGroup);
  studio._sourceMaterials = new Map();
  studio._retainedMaterials = new Set();
  studio._turnRadians = 0;
  studio.cap = new THREE.Mesh(new THREE.PlaneGeometry(100, 100), new THREE.MeshStandardMaterial());
  studio.setOptions = () => {};
  studio.resetCamera = () => {};
  // These import/geometry fixtures have no WebGL context. The linear resolve
  // contract is covered separately by photo-dof and actual browser captures.
  studio._drawUnblurredScene = () => studio.renderer?.render(studio.scene, studio.camera);
  return studio;
}

test('demo contact rim keeps side normals outward and sealed-base normals downward without losing faces or colors', () => {
  let vase;
  GrowthStudio.prototype.loadDemo.call({ _adopt(root) { vase = root; } });
  const geometry = vase.geometry, positions = geometry.attributes.position, normals = geometry.attributes.normal;
  assert.equal(geometry.index.count / 3, 56832);
  assert.equal(geometry.userData.creaseNormals.sourceVertices, 28640);
  geometry.computeBoundingBox();
  assert.equal(geometry.boundingBox.min.y, 0);
  assert.equal(geometry.boundingBox.max.y, 120);
  const position = new THREE.Vector3(), normal = new THREE.Vector3(), color = new THREE.Color('#76aa91');
  let bottomWallCorners = 0;
  // First half of the wall triangles belongs to the outer wall.
  for (let corner = 0; corner < 28160 * 3; corner++) {
    const id = geometry.index.getX(corner);
    position.fromBufferAttribute(positions, id);
    if (position.y !== 0) continue;
    normal.fromBufferAttribute(normals, id);
    assert.ok(Math.abs(normal.y) < 0.5, 'the side must not inherit the nearly -Y normal of the large sealed bottom');
    assert.ok(normal.x * position.x + normal.z * position.z > 0, 'the wall still faces outward');
    const actual = geometry.attributes.color;
    assert.ok(Math.abs(actual.getX(id) - color.r) < 1e-7 && Math.abs(actual.getY(id) - color.g) < 1e-7 && Math.abs(actual.getZ(id) - color.b) < 1e-7);
    bottomWallCorners++;
  }
  assert.equal(bottomWallCorners, 384);
  // The outer/inner bottom faces are interleaved at the end of the source mesh.
  for (let face = 56576; face < 56832; face += 2) for (let corner = 0; corner < 3; corner++) {
    normal.fromBufferAttribute(normals, geometry.index.getX(face * 3 + corner));
    assert.ok(normal.distanceTo(new THREE.Vector3(0, -1, 0)) < 1e-6);
  }
  geometry.dispose(); vase.material.dispose();
});

test('invalid model preserves the current import; replacement frees recolored source textures', () => {
  const studio = importFixture();
  const counts = { texture: 0, material: 0, geometry: 0, prepared: 0, bitmap: 0 };
  const texture = new THREE.Texture({ close: () => counts.bitmap++ });
  const material = new THREE.MeshStandardMaterial({ map: texture });
  const geometry = new THREE.BoxGeometry();
  texture.addEventListener('dispose', () => counts.texture++);
  material.addEventListener('dispose', () => counts.material++);
  geometry.addEventListener('dispose', () => counts.geometry++);
  studio._adopt(new THREE.Mesh(geometry, material), 'first', 'obj', { mode: 'mesh' });
  const prepared = studio._meshes[0].material;
  prepared.addEventListener('dispose', () => counts.prepared++);
  prepared.map = null; // The user's recolor temporarily hides the imported map.
  const previous = studio.orientation;
  assert.throws(() => studio._adopt(new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial()), 'invalid', 'stl', { mode: 'mesh' }));
  assert.equal(studio.orientation, previous);
  assert.equal(studio.metadata.name, 'first');
  assert.equal(counts.texture, 0);
  studio._adopt(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial()), 'second', 'stl', { mode: 'mesh' });
  assert.deepEqual(counts, { texture: 1, material: 1, geometry: 1, prepared: 1, bitmap: 1 });
});

test('automatic normalization includes all instances of an imported mesh', () => {
  const studio = importFixture();
  const model = new THREE.InstancedMesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial(), 2);
  model.setMatrixAt(1, new THREE.Matrix4().makeTranslation(10, 0, 0));
  studio._adopt(model, 'instances', 'glb', { mode: 'mesh' });
  assert.equal(studio.metadata.dimensions.x, 11);
  assert.ok(Math.abs(studio._baseHeight - 8 / 11) < 1e-12);
  assert.equal(studio._baseBounds.min.y, 0);
});

test('video background timing loops and never seeks to the undecodable end boundary', () => {
  const studio = importFixture();
  studio._backgroundMetadata = { type: 'video', duration: 2 };
  assert.equal(studio._backgroundTime(-1), 0);
  assert.equal(studio._backgroundTime(2), 0);
  assert.equal(studio._backgroundTime(6.75), 0.75);
  assert.equal(studio._backgroundTime(Infinity), 0);
  assert.ok(studio._backgroundTime(1.999999) < 2);
});

test('video export waits for its requested decoded frame before texture upload', async () => {
  const studio = importFixture();
  const video = new EventTarget();
  video.readyState = 2;
  video.seeking = false;
  let current = 0;
  let decoded = 0;
  Object.defineProperty(video, 'currentTime', {
    get: () => current,
    set: value => {
      current = value;
      video.seeking = true;
      setTimeout(() => {
        decoded = value;
        video.seeking = false;
        video.dispatchEvent(new Event('seeked'));
      }, 1);
    },
  });
  studio._backgroundVideo = video;
  studio._backgroundMetadata = { type: 'video', duration: 2 };
  studio._backgroundTexture = { needsUpdate: false };
  await studio._seekBackground(2.5);
  assert.equal(decoded, 0.5);
  assert.equal(video.seeking, false);
  assert.equal(studio._backgroundTexture.needsUpdate, true);
  studio.options.transparent = true;
  await studio._seekBackground(1);
  assert.equal(decoded, 0.5);
});

function cameraFixture() {
  const studio = importFixture();
  studio._metadata = { name: 'model' };
  studio.camera = new THREE.PerspectiveCamera(36, 16 / 9, 0.05, 200);
  studio.camera.position.set(10, 10, 15);
  studio.controls = { target: new THREE.Vector3(0, 4, 0), enableDamping: true, enabled: true, update() { studio.camera.lookAt(this.target); studio.camera.updateMatrixWorld(true); } };
  studio.controls.update();
  studio.options.progress = 1;
  studio._bounds = new THREE.Box3(new THREE.Vector3(-4, 0, -4), new THREE.Vector3(4, 8, 4));
  studio.render = () => {};
  return studio;
}

test('manual perspective preserves target and distance while recovering yaw, pitch and roll', () => {
  const studio = cameraFixture();
  const target = studio.controls.target.clone();
  const distance = studio.camera.position.distanceTo(target);
  studio.setCameraOptions({ fov: 48, pitch: 32, yaw: -72, roll: 24 });
  const result = studio.getCameraOptions();
  for (const [key, value] of Object.entries({ fov: 48, pitch: 32, yaw: -72, roll: 24 })) assert.ok(Math.abs(result[key] - value) < 1e-9, key);
  assert.ok(studio.controls.target.equals(target));
  assert.ok(Math.abs(studio.camera.position.distanceTo(target) - distance) < 1e-9);
});

test('photo calibration applies off-center optical target and validates complete pose data', () => {
  const studio = cameraFixture();
  studio.applyCalibration({ position: [8, 12, 18], target: [4, 3, -2], up: [0, 1, 0], fov: 32 });
  assert.deepEqual(studio.camera.position.toArray(), [8, 12, 18]);
  assert.deepEqual(studio.controls.target.toArray(), [4, 3, -2]);
  assert.equal(studio.camera.fov, 32);
  assert.throws(() => studio.applyCalibration({ target: [0, 0, 0], up: [0, 1, 0], fov: 32 }), /校准结果无效/);
});

test('a known photo bed clips ground shadows to its fixed nominal world rectangle', () => {
  const studio = cameraFixture();
  studio.floor = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.ShadowMaterial());
  studio.floor.rotation.x = -Math.PI / 2;
  studio._backgroundTexture = new THREE.Texture();
  studio._backgroundSize = { width: 1200, height: 900 };
  const calibration = { position: [8, 12, 18], target: [4, 3, -2], up: [0, 1, 0], fov: 32, bedWidth: 12, bedDepth: 10 };
  studio.applyCalibration(calibration);
  studio.floor.updateMatrixWorld(true);
  const floorBox = new THREE.Box3().setFromObject(studio.floor);
  assert.ok(Math.abs(floorBox.min.x + 6) < 1e-10 && Math.abs(floorBox.max.x - 6) < 1e-10);
  assert.ok(Math.abs(floorBox.min.z + 5) < 1e-10 && Math.abs(floorBox.max.z - 5) < 1e-10);
  assert.ok(Math.abs(floorBox.min.y + 0.001) < 1e-10);
  studio.modelGroup.position.set(4, 3, -2); studio.modelGroup.scale.setScalar(1.8); studio.modelGroup.rotation.y = 0.7;
  studio._updateFloorFootprint();
  assert.deepEqual(studio.floor.scale.toArray(), [12 / 200, 10 / 200, 1]);
  assert.deepEqual(studio.floor.position.toArray(), [0, -0.001, 0]);
  studio.applyCalibration({ position: [7, 11, 17], target: [3, 2, -3], up: [0, 1, 0], fov: 34 });
  assert.deepEqual(studio._photoBedSize, { width: 12, depth: 10 }, 'cached pose-only camera restore retains known dimensions for the same photo');
  studio._releaseBackground();
  assert.equal(studio._photoBedSize, null);
  assert.deepEqual(studio.floor.scale.toArray(), [1, 1, 1]);
});

test('cancelling a first or subsequent calibration restores the original photo receiver dimensions', () => {
  const studio = cameraFixture();
  studio.floor = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.ShadowMaterial());
  studio._backgroundTexture = new THREE.Texture();
  const absent = studio.getCalibrationBedSize();
  assert.equal(absent, null);
  studio.applyCalibration({ position: [8,12,18], target: [0,0,0], up: [0,1,0], fov: 32, bedWidth: 12, bedDepth: 10 });
  const original = studio.getCalibrationBedSize();
  original.width = 999;
  assert.equal(studio.getCalibrationBedSize().width, 12, 'the editor snapshot cannot mutate live dimensions');
  const saved = studio.getCalibrationBedSize();
  studio.restoreCalibrationBedSize({ width: 8, depth: 8 });
  studio.restoreCalibrationBedSize(saved);
  assert.deepEqual(studio.getCalibrationBedSize(), { width: 12, depth: 10 });
  assert.deepEqual(studio.floor.scale.toArray(), [12/200, 10/200, 1]);
  studio.restoreCalibrationBedSize(absent);
  assert.equal(studio.getCalibrationBedSize(), null);
  assert.deepEqual(studio.floor.scale.toArray(), [1,1,1]);
  assert.throws(() => studio.restoreCalibrationBedSize({ width: 0, depth: 10 }), /尺寸恢复/);
});

test('source PBR stays intact and body shadow bias is independent of loading or hiding supports', () => {
  const studio = cameraFixture();
  const material = new THREE.MeshStandardMaterial({ color: '#23599c', roughness: 0.24, metalness: 0.76 });
  studio._adopt(new THREE.Mesh(new THREE.BoxGeometry(80, 120, 40), material), 'source-pbr', 'glb', { mode: 'mesh' });
  Object.assign(studio.options, { modelScale: 1, progress: 1, direction: 'up', layerCount: 240, stepped: true });
  studio.floor = new THREE.Mesh();
  studio.keyLight = new THREE.DirectionalLight();
  studio._updateLightPosition = studio._updateShadowHelper = studio._drawScene = () => {};
  studio.render = GrowthStudio.prototype.render;
  studio.render(1);
  const bias = studio.keyLight.shadow.normalBias;
  assert.ok(Math.abs(bias / studio.modelMillimetresToWorld - 0.08) < 1e-10);
  studio._supportOverlay = { root: { material: {} } };
  studio.render(1);
  assert.equal(studio.keyLight.shadow.normalBias, bias);
  studio.options.showSupports = false; studio.render(1);
  assert.equal(studio.keyLight.shadow.normalBias, bias);
  assert.equal(studio._meshes[0].material.roughness, 0.24);
  assert.equal(studio._meshes[0].material.metalness, 0.76);
});

test('physical FDM surfaces use source millimetres, per-filament finish and pose-locked texture instead of black stripes', () => {
  const studio = cameraFixture();
  const material = new THREE.MeshStandardMaterial({ color: '#23599c' });
  material.userData.toolIndex = 1;
  const body = new THREE.Mesh(new THREE.BoxGeometry(80, 120, 40), material);
  studio._adopt(body, 'fdm-source', '3mf', { mode: 'mesh', layerHeightMm: 0.12, firstLayerHeightMm: 0.25, lineWidthMm: 0.42, materialProfiles: [{ tool: 1, profile: 'matte' }] });
  Object.assign(studio.options, { surfacePreset: 'auto', surfaceDetail: 0.6, layerLines: true });
  studio._updateFDMSurfaces(); studio.scene.updateMatrixWorld(true); studio._updatePrintMatrix();
  const prepared = studio._meshes[0].material;
  const handle = studio._surfaceMaterials.get(prepared);
  assert.equal(handle.uniforms.fdmLayerHeight.value, 0.12);
  assert.equal(handle.uniforms.fdmFirstLayerHeight.value, 0.25);
  assert.equal(handle.uniforms.fdmLineWidth.value, 0.42);
  assert.equal(prepared.roughness, 0.88); assert.equal(prepared.metalness, 0);
  const point = new THREE.Vector3(1, 12, 3);
  const before = body.localToWorld(point.clone()).applyMatrix4(studio._printMatrix);
  studio.modelGroup.position.set(4, 3, -2); studio.modelGroup.rotation.set(0.3, 0.7, 0.1); studio.modelGroup.scale.setScalar(2);
  studio.scene.updateMatrixWorld(true); studio._updatePrintMatrix();
  const after = body.localToWorld(point.clone()).applyMatrix4(studio._printMatrix);
  assert.ok(after.distanceTo(before) < 1e-9, 'display scale must be removed once rather than dividing it out twice');
  const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader };
  prepared.onBeforeCompile(shader, {});
  assert.match(shader.fragmentShader, /normal = fdmPerturbNormal/);
  assert.doesNotMatch(shader.fragmentShader, /growthPhase|0\.87 \+ 0\.13/);
  assert.equal(prepared.color.getHexString(), '23599c');
  studio.options.layerLines = false; studio._updateFDMSurfaces();
  assert.equal(handle.uniforms.fdmDetail.value, 0);
});

test('replacing a model cannot dispose a shared cached PMREM reflection texture', () => {
  const studio = importFixture();
  const texture = new THREE.Texture(); let disposed = 0; texture.addEventListener('dispose', () => disposed++);
  const cache = new PrintEnvironmentCache({}, { generatorFactory: () => ({ fromScene() { return { texture, dispose() { texture.dispose(); } }; }, dispose() {} }) });
  cache.get(printEnvironmentDescriptor());
  studio._adopt(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ envMap: texture })), 'reflected', 'glb', { mode: 'mesh' });
  studio._adopt(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial()), 'replacement', 'glb', { mode: 'mesh' });
  assert.equal(disposed, 0);
  cache.dispose(); assert.equal(disposed, 1);
});

test('explicit GLB finish overrides preserve PBR maps, restore auto faithfully and use metre-to-mm print spacing', () => {
  const studio = cameraFixture();
  const map = new THREE.Texture(), normalMap = new THREE.Texture(), roughnessMap = new THREE.Texture(), metalnessMap = new THREE.Texture(), envMap = new THREE.Texture();
  const material = new THREE.MeshStandardMaterial({ color: '#23599c', roughness: 1, metalness: 0.76, map, normalMap, roughnessMap, metalnessMap, envMap, envMapIntensity: 0.8 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.2, 0.4), material);
  studio._adopt(body, 'pbr-source', 'glb', { mode: 'mesh' });
  studio._updateFDMSurfaces();
  const prepared = studio._meshes[0].material;
  assert.equal(studio._surfaceMaterials.has(prepared), false, 'default auto does not inject printing detail into source PBR');
  assert.equal(prepared.roughness, 1); assert.equal(prepared.metalness, 0.76);
  Object.assign(studio.options, { surfacePreset: 'silk', surfaceDetail: 0.6, layerLines: true });
  studio._updateFDMSurfaces(); studio.scene.updateMatrixWorld(true); studio._updatePrintMatrix();
  const handle = studio._surfaceMaterials.get(prepared);
  assert.equal(prepared.roughness, 0.3); assert.equal(prepared.metalness, 0);
  const top = body.localToWorld(new THREE.Vector3(0, 0.6, 0)).applyMatrix4(studio._printMatrix);
  const bottom = body.localToWorld(new THREE.Vector3(0, -0.6, 0)).applyMatrix4(studio._printMatrix);
  assert.ok(Math.abs(top.y - bottom.y - 1200) < 1e-9);
  assert.equal(studio.metadata.sourceUnitsToMm, 1000);
  assert.equal(studio.metadata.sourceUnitsInferred, false);
  assert.equal(studio.metadata.surfaceOverrideSupported, true);
  for (const [key, texture] of Object.entries({ map, normalMap, roughnessMap, metalnessMap, envMap })) assert.equal(prepared[key], texture);
  studio.options.surfacePreset = 'auto'; studio._updateFDMSurfaces();
  assert.equal(handle.uniforms.fdmDetail.value, 0);
  assert.equal(prepared.roughness, 1); assert.equal(prepared.metalness, 0.76);
  assert.equal(prepared.envMap, envMap); assert.equal(prepared.envMapIntensity, 0.8);
  assert.equal(prepared.color.getHexString(), '23599c');
  for (const [key, texture] of Object.entries({ map, normalMap, roughnessMap, metalnessMap })) assert.equal(prepared[key], texture);
  const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader };
  prepared.onBeforeCompile(shader, {});
  assert.match(shader.fragmentShader, /if\s*\(\s*fdmDetail\s*>\s*0(?:\.0)?\s*\)\s*roughnessFactor/, 'auto detail0 must preserve source roughness1 rather than clamp it to.98');
});

test('lens changes preserve the posed model reference plane and roll while changing near/far perspective', () => {
  const studio = cameraFixture();
  studio.setCameraOptions({ pitch: 28, yaw: 37, roll: 19 });
  studio._baseBounds = new THREE.Box3(new THREE.Vector3(-2, 0, -1), new THREE.Vector3(3, 8, 1));
  studio.modelGroup.position.set(1.3, 0.7, -0.8);
  studio.modelGroup.scale.setScalar(1.25);
  studio.modelGroup.rotation.set(0.1, 0.35, 0.2);
  studio.modelGroup.updateMatrixWorld(true);
  const matrix = [...studio.modelGroup.matrixWorld.elements];
  const anchor = studio._baseBounds.clone().applyMatrix4(studio.modelGroup.matrixWorld).getCenter(new THREE.Vector3());
  const quaternion = studio.camera.quaternion.clone(), up = studio.camera.up.clone();
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(quaternion);
  const vertical = new THREE.Vector3(0, 1, 0).applyQuaternion(quaternion);
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(quaternion);
  const planePoints = [anchor, anchor.clone().addScaledVector(right, 1.3), anchor.clone().addScaledVector(vertical, 2.1)];
  const depthPoints = [anchor.clone().addScaledVector(right, 1.3).addScaledVector(forward, -2), anchor.clone().addScaledVector(right, 1.3).addScaledVector(forward, 2)];
  const projectedBefore = planePoints.map(point => point.clone().project(studio.camera));
  const depthBefore = depthPoints.map(point => point.clone().project(studio.camera));
  const beforeFocal = studio.getLensOptions().focalLength;
  let renders = 0; studio.render = () => renders++;
  assert.ok(Math.abs(studio.setLensOptions({ focalLength: 100 }).focalLength - 100) < 1e-10);
  assert.equal(renders, 1);
  planePoints.forEach((point, i) => {
    const projected = point.clone().project(studio.camera);
    assert.ok(Math.hypot(projected.x - projectedBefore[i].x, projected.y - projectedBefore[i].y) < 1e-10);
  });
  depthPoints.forEach((point, i) => {
    const projected = point.clone().project(studio.camera);
    assert.ok(Math.hypot(projected.x - depthBefore[i].x, projected.y - depthBefore[i].y) > 0.001);
  });
  assert.ok(studio.camera.quaternion.angleTo(quaternion) < 1e-7);
  assert.ok(studio.camera.up.equals(up));
  assert.deepEqual(studio.modelGroup.matrixWorld.elements, matrix);
  assert.ok(Math.abs(studio.camera.fov - focalLengthToFov(100)) < 1e-10);
  studio.setLensOptions({ focalLength: beforeFocal });
  planePoints.forEach((point, i) => {
    const projected = point.clone().project(studio.camera);
    assert.ok(Math.hypot(projected.x - projectedBefore[i].x, projected.y - projectedBefore[i].y) < 1e-10);
  });
});

test('physical lens remains tied to the source frame through cover, custom crops and calibrated reset', () => {
  const studio = cameraFixture();
  studio._backgroundSize = { width: 1200, height: 900 };
  studio._fullSourceFov = 52;
  studio._viewportAspect = 16 / 9;
  studio._applyCameraFraming();
  const anchor = studio._bounds.getCenter(new THREE.Vector3());
  const coverBefore = anchor.clone().project(studio.camera);
  studio.setLensOptions({ focalLength: 85 });
  const coverAfter = anchor.clone().project(studio.camera);
  assert.ok(Math.hypot(coverAfter.x - coverBefore.x, coverAfter.y - coverBefore.y) < 1e-10);
  assert.ok(Math.abs(studio.getLensOptions().focalLength - 85) < 1e-10);
  assert.ok(studio.camera.fov < studio._fullSourceFov, 'wide output cover uses a narrower visible FOV');
  studio._applyCameraFraming(9 / 16);
  assert.ok(Math.abs(studio.getLensOptions().focalLength - 85) < 1e-10);
  studio.options.crop = normalizeCrop({ x: 0.12, y: 0.08, width: 0.6, height: 0.75 }, 4 / 3);
  studio._viewportAspect = studio.options.crop.width * 4 / 3 / studio.options.crop.height;
  studio._applyCameraFraming();
  const cropBefore = anchor.clone().project(studio.camera);
  const view = { ...studio.camera.view };
  studio.setLensOptions({ focalLength: 135 });
  const cropAfter = anchor.clone().project(studio.camera);
  assert.ok(Math.hypot(cropAfter.x - cropBefore.x, cropAfter.y - cropBefore.y) < 1e-10);
  assert.deepEqual(studio.camera.view, view);
  assert.ok(Math.abs(studio.getLensOptions().focalLength - 135) < 1e-10);
  studio.setCameraOptions({ yaw: studio.getCameraOptions().yaw + 3 });
  assert.ok(Math.abs(studio.getLensOptions().focalLength - 135) < 1e-10, 'editing an angle must not clamp the 135mm FOV back to 15 degrees');
  studio.applyCalibration({ position: [8, 12, 18], target: [4, 3, -2], up: [0, 1, 0], fov: 32, imageSize: { width: 1200, height: 900 } });
  assert.deepEqual(studio.camera.position.toArray(), [8, 12, 18]);
  assert.deepEqual(studio.controls.target.toArray(), [4, 3, -2]);
  assert.ok(Math.abs(studio.getLensOptions().focalLength - fovToFocalLength(32)) < 1e-10);
  assert.equal(studio.camera.fov, 32);
});

test('clearing a covered photo reads the actual model-only lens and preserves subsequent framing', () => {
  const studio = cameraFixture();
  studio._backgroundSize = { width: 1200, height: 900 };
  studio._fullSourceFov = 52;
  studio._viewportAspect = 16 / 9;
  studio._applyCameraFraming();
  studio.setLensOptions({ focalLength: 85 });
  const anchor = studio._bounds.getCenter(new THREE.Vector3());
  const sample = anchor.clone().addScaledVector(new THREE.Vector3(1, 0, 0).applyQuaternion(studio.camera.quaternion), 1.5);
  const before = sample.clone().project(studio.camera);
  const visibleFov = studio.camera.fov;
  studio._updateBackground = () => {};
  studio.clearBackground();
  assert.ok(studio._cropFullFov, 'the former source FOV can remain cached, but cannot govern a source-free camera');
  assert.equal(studio.camera.fov, visibleFov);
  assert.ok(Math.abs(studio.getLensOptions().focalLength - fovToFocalLength(visibleFov)) < 1e-10);
  assert.ok(Math.abs(studio.getLensOptions().focalLength - 113.33333333333333) < 1e-10);
  studio.setLensOptions({ focalLength: 100 });
  const after = sample.clone().project(studio.camera);
  assert.ok(Math.hypot(after.x - before.x, after.y - before.y) < 1e-10, 'switching lenses after removing the photo must not shrink the model by the former cover factor');
  studio.resetCamera(); studio.setView('front');
  assert.ok(Math.abs(studio.getLensOptions().focalLength - 100) < 1e-10);
  studio.setCameraOptions({ fov: 36 });
  assert.ok(Math.abs(studio.getLensOptions().focalLength - fovToFocalLength(36)) < 1e-10);
});

test('screen drag converts normalized movement into camera-aligned world offsets', () => {
  const studio = cameraFixture();
  studio.setCameraOptions({ pitch: 40, yaw: 35, roll: 20 });
  const center = studio._bounds.getCenter(new THREE.Vector3());
  const before = center.clone().project(studio.camera);
  const delta = studio.offsetForScreenDelta(0.001, -0.002);
  const after = center.add(new THREE.Vector3(delta.modelOffsetX * 4, delta.modelOffsetY * 4, 0)).project(studio.camera);
  assert.ok(Math.abs((after.x - before.x) / 2 - 0.001) < 1e-5);
  assert.ok(Math.abs(-(after.y - before.y) / 2 + 0.002) < 1e-5);
  const bounds = studio.getScreenBounds();
  assert.ok(bounds.width > 0 && bounds.height > 0);
});

test('3MF archive inspection distinguishes standard colors from proprietary paint', () => {
  const standard = zipSync({ '3D/3dmodel.model': strToU8('<model><resources><m:basematerials><m:base displaycolor="#FF0000"/></m:basematerials></resources></model>') });
  assert.deepEqual(inspectThreeMFArchive(standard), { standardColors: true, proprietaryPaint: false,hasSavedSliceSettings:false,hasEmbeddedGCode:false });
  const proprietary = zipSync({ '3D/3dmodel.model': strToU8('<model><triangle v1="0" v2="1" v3="2" slic3rpe:mmu_segmentation="1"/></model>') });
  assert.deepEqual(inspectThreeMFArchive(proprietary), { standardColors: false, proprietaryPaint: true,hasSavedSliceSettings:false,hasEmbeddedGCode:false });
  const engineered=zipSync({'3D/3dmodel.model':strToU8('<model/>'),'Metadata/project_settings.config':strToU8('{"wall_loops":2}'),'Metadata/plate_1.gcode':strToU8('G1 X10 E1')});
  const properties=inspectThreeMFArchive(engineered);assert.equal(properties.hasSavedSliceSettings,true);assert.equal(properties.hasEmbeddedGCode,true);
  const rootSlice=zipSync({'3D/3dmodel.model':strToU8('<model/>'),'plate_1.gcode':strToU8('G1 X10 E1')});
  assert.equal(inspectThreeMFArchive(rootSlice).hasEmbeddedGCode,true);
});

test('gizmo maintains uniform scale and separates model pose from playback rotation', () => {
  const studio = importFixture();
  studio._adopt(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial()), 'model', 'stl', { mode: 'mesh' });
  studio.transform = { getMode: () => 'scale' };
  studio._turnRadians = 0.7;
  studio._gizmoScaleStart = 1;
  studio.options.modelScale = 1;
  studio.modelGroup.position.set(4, 8, -4);
  studio.modelGroup.scale.set(1, 1.6, 1);
  const pose = new THREE.Euler(0.2, 0.3, 0.4);
  studio.modelGroup.quaternion.setFromEuler(pose).premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.7));
  studio.render = () => {};
  let changed;
  studio.onTransformChange = options => { changed = options; };
  studio._handleTransformChange();
  assert.deepEqual(studio.modelGroup.scale.toArray(), [1.6, 1.6, 1.6]);
  assert.deepEqual([changed.modelOffsetX, changed.modelOffsetY, changed.modelOffsetZ], [1, 2, -1]);
  for (const [key, value] of Object.entries({ modelRotationX: 0.2, modelRotationY: 0.3, modelRotationZ: 0.4 })) assert.ok(Math.abs(changed[key] - value) < 1e-9);
});

test('export hides the editing gizmo and restores it afterward', () => {
  const studio = cameraFixture();
  studio.transform = { enabled: true };
  studio.transformHelper = { visible: true };
  studio.shadowHelper = { visible: true };
  studio._shadowEditMode = true;
  studio.renderer = { getSize: () => new THREE.Vector2(320, 180), getPixelRatio: () => 2, setPixelRatio: () => {} };
  studio._resize = () => {};
  studio.startExport(640, 360);
  assert.equal(studio.transform.enabled, false);
  assert.equal(studio.transformHelper.visible, false);
  assert.equal(studio.shadowHelper.visible, false);
  assert.equal(studio._shadowEditMode, false);
  studio.endExport();
  assert.equal(studio.transform.enabled, true);
  assert.equal(studio.transformHelper.visible, true);
  assert.equal(studio.shadowHelper.visible, true);
  assert.equal(studio._shadowEditMode, true);
});

test('separate closed uniform-color parts retain different growth cap colors', () => {
  const studio = importFixture();
  const model = new THREE.Group();
  const red = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ color: '#ff0000' }));
  const blue = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ color: '#0000ff' }));
  red.position.x = -1; blue.position.x = 1;
  model.add(red, blue);
  studio._adopt(model, 'parts', '3mf', { mode: 'mesh' });
  assert.equal(studio.metadata.capColors, 'per-part');
  assert.deepEqual(studio._partCaps.map(cap => cap.material.color.getHexString()), ['ff0000', '0000ff']);
  assert.deepEqual(studio._stencils.map(mesh => mesh.renderOrder), [20, 21, 23, 24]);
  assert.deepEqual(studio._partCaps.map(cap => cap.renderOrder), [22, 25]);
});

test('G-code retains file colors, color overrides and segment-by-segment growing shadows', () => {
  const studio = importFixture();
  const data = parseGCode('; filament_colour = #FF0000;#00FF00\nM83\nG0Z.2\nG1X10E1\nT1\nG0Z.4\nG1Y10E1');
  const geometry = new LineSegmentsGeometry().setPositions(data.positions);
  const line = new LineSegments2(geometry, new LineMaterial({ worldUnits: true }));
  line.rotation.x = -Math.PI / 2;
  studio._adopt(line, 'paths', 'gcode', { mode: 'gcode' });
  Object.assign(studio.options, { preserveMaterials: true, direction: 'up', modelScale: 1, stepped: true });
  studio._gcode = data;
  studio._createGCodeShadow();
  studio._prepareGCode();
  assert.deepEqual(studio.metadata.materialColors.map(item => [item.color, item.source]), [['#ff0000', 'file'], ['#00ff00', 'file']]);
  assert.equal(geometry.attributes.instanceColorStart.getX(0), 1);
  assert.equal(geometry.attributes.instanceColorStart.getY(1), 1);
  const matrixVersion = studio._gcodeShadow.instanceMatrix.version;
  studio.options.toolColors = { 0: '#0000ff' };
  studio._prepareGCode();
  assert.equal(geometry.attributes.instanceColorStart.getZ(0), 1);
  assert.equal(studio._gcodeShadow.instanceMatrix.version, matrixVersion);
  studio.floor = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.ShadowMaterial());
  studio.keyLight = new THREE.DirectionalLight();
  studio._bounds = new THREE.Box3();
  studio.renderer = { render() {}, getSize: target => target.set(320, 180), getPixelRatio: () => 1 };
  GrowthStudio.prototype.render.call(studio, 0.5);
  assert.equal(line.geometry.instanceCount, 1);
  assert.equal(studio._gcodeShadow.count, 1);
  studio._gcodeShadow.onBeforeRender();
  assert.equal(studio._gcodeShadow.count, 0);
  studio._gcodeShadow.onAfterRender();
  assert.equal(studio._gcodeShadow.count, 1);
  studio.options.direction = 'down';
  studio._prepareGCode();
  const matrix = new THREE.Matrix4();
  studio._gcodeShadow.getMatrixAt(0, matrix);
  assert.ok(Math.abs(new THREE.Vector3().setFromMatrixPosition(matrix).z - 0.4) < 1e-6);
  GrowthStudio.prototype.render.call(studio, 1);
  assert.equal(studio._gcodeShadow.count, 2);
});

test('real support geometry toggles with its caps and shadows; per-filament 3MF edits retain source colors', () => {
  const studio = importFixture();
  const bodyMaterial = new THREE.MeshStandardMaterial({ color: '#ff0000' });
  bodyMaterial.userData.toolIndex = 0;
  const supportMaterial = new THREE.MeshStandardMaterial({ color: '#00ff00' });
  supportMaterial.userData.toolIndex = 1;
  const body = new THREE.Mesh(new THREE.BoxGeometry(), bodyMaterial);
  const support = new THREE.Mesh(new THREE.BoxGeometry(), supportMaterial);
  support.position.x = 2;
  const supportGroup = new THREE.Group();
  supportGroup.userData.isSupport = true;
  supportGroup.add(support);
  const model = new THREE.Group();
  model.add(body, supportGroup);
  studio._adopt(model, 'supported', '3mf', { mode: 'mesh', materialColors: [{ tool: 0, color: '#ff0000', source: 'file' }, { tool: 1, color: '#00ff00', source: 'file' }] });
  assert.equal(studio.metadata.supportsAvailable, true);
  assert.equal(studio.metadata.supportMeshes, 1);
  studio._floorShadowMaterial = new THREE.ShadowMaterial();
  studio.floor = new THREE.Mesh(new THREE.PlaneGeometry(), studio._floorShadowMaterial);
  studio.grid = new THREE.GridHelper();
  studio.keyLight = new THREE.DirectionalLight();
  studio._bounds = new THREE.Box3();
  studio.renderer = { render() {}, getSize: target => target.set(800, 450), getPixelRatio: () => 1 };
  studio._updateBackground = () => {};
  studio.render = (progress, turn) => GrowthStudio.prototype.render.call(studio, progress, turn);
  GrowthStudio.prototype.setOptions.call(studio, { progress: 0.5, showSupports: false, preserveMaterials: true, toolColors: { 0: '#0000ff' }, shadowOpacity: 0, shadowRadius: 20, lightDirection: 'right' });
  assert.equal(body.material.color.getHexString(), '0000ff');
  assert.equal(support.material.color.getHexString(), '00ff00');
  assert.equal(support.visible, false);
  assert.ok(studio._stencils.filter(mesh => mesh._growthSource === support).every(mesh => !mesh.visible));
  assert.ok(studio._partCaps.filter(cap => cap._growthSource === support).every(cap => !cap.visible));
  assert.equal(studio._floorShadowMaterial.opacity, 0);
  assert.equal(studio.options.shadowRadius, 8, 'the selected ground softness remains clamped and available to its physical kernel');
  assert.equal(studio.keyLight.shadow.radius, 1, 'ground softness cannot widen model self-shadow samples');
  assert.deepEqual(studio.keyLight.position.toArray(), [9, 16, 10]);
  GrowthStudio.prototype.setOptions.call(studio, { showSupports: true });
  assert.equal(support.visible, true);
});

test('sliced support overlays preserve the mesh, physical source coordinates and camera placement', async () => {
  const studio = cameraFixture();
  const body = new THREE.Mesh(new THREE.BoxGeometry().translate(0.5, 0.5, 0.5), new THREE.MeshStandardMaterial({ color: '#ff0000' }));
  body.rotation.x = -Math.PI / 2;
  studio._adopt(body, 'painted', '3mf', { mode: 'mesh', materialColors: [{ tool: 0, color: '#ff0000', source: 'file' }], warnings: ['工程未包含生成后的支撑几何'] });
  const scale = studio.modelWorldScale;
  const normalizedPosition = studio.normalized.position.clone();
  const camera = studio.camera.position.clone();
  const target = studio.controls.target.clone();
  const result = await studio.loadSupportGCode('M83\n;FEATURE:Outer wall\nG1X100E1\nG0X.1Y.1Z.2\n;FEATURE:Support\nG1X.2E1\nG0Z.4\n;FEATURE:Support interface\nG1Y.2E1');
  assert.deepEqual(result, { segments: 2, source: 'sliced-gcode', warnings: [] });
  assert.equal(studio._meshes[0], body);
  assert.equal(studio.modelWorldScale, scale);
  assert.ok(studio.normalized.position.equals(normalizedPosition));
  assert.ok(studio.camera.position.equals(camera));
  assert.ok(studio.controls.target.equals(target));
  assert.equal(studio._supportOverlay.root.material.clippingPlanes[0], studio.clipPlane);
  assert.equal(studio._supportOverlay.shadow.material.clipShadows, true);
  assert.equal(studio._supportOverlay.shadow.count, 2);
  assert.equal(studio.metadata.supportsAvailable, true);
  assert.equal(studio.metadata.warnings.length, 0);
  assert.equal(studio._gcode, null);
});

test('ground shadow drag changes the real light through all directions and disables competing controls', () => {
  const studio = cameraFixture();
  const canvas = new EventTarget();
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 450 });
  canvas.setPointerCapture = () => {};
  canvas.hasPointerCapture = () => false;
  studio.renderer = { domElement: canvas, getSize: target => target.set(800, 450), getPixelRatio: () => 1 };
  studio.floor = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.ShadowMaterial());
  studio.floor.position.y = -0.015;
  studio.keyLight = new THREE.DirectionalLight();
  studio.keyLight.position.set(-9, 16, 10);
  studio.transform = { enabled: true };
  studio.transformHelper = { visible: true };
  studio._shadowRaycaster = new THREE.Raycaster();
  studio._shadowPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  studio._createShadowHelper();
  studio.setShadowEditMode(true);
  assert.equal(studio.transform.enabled, false);
  assert.equal(studio.transformHelper.visible, false);
  const changes = [];
  studio.onShadowChange = value => changes.push(value);
  const point = new THREE.Vector3(8, -0.015, 0).project(studio.camera);
  const event = new Event('pointerdown', { cancelable: true });
  Object.assign(event, { button: 0, pointerId: 1, clientX: (point.x + 1) * 400, clientY: (1 - point.y) * 225 });
  canvas.dispatchEvent(event);
  assert.equal(studio.controls.enabled, false);
  assert.ok(Math.abs(changes.at(-1).lightAzimuth + 90) < 1e-8);
  assert.ok(Math.abs(changes.at(-1).lightElevation - 45) < 1e-8);
  assert.ok(studio.keyLight.position.x < studio.keyLight.target.position.x);
  const released = new Event('pointerup', { cancelable: true });
  Object.assign(released, { pointerId: 1 });
  canvas.dispatchEvent(released);
  assert.equal(studio.controls.enabled, true);
  for (const [x, z, expected] of [[0, 8, -180], [-8, 0, 90], [0, -8, 0]]) {
    studio._applyShadowPoint(new THREE.Vector3(x, 0, z));
    assert.ok(Math.abs(changes.at(-1).lightAzimuth - expected) < 1e-8);
  }
  studio.setShadowEditMode(false);
  assert.equal(studio.shadowHelper.visible, false);
  assert.equal(studio.transform.enabled, true);
  assert.equal(studio.transformHelper.visible, true);
});

test('idle preview avoids rerendering while controls, media and resize changes trigger one fresh frame', () => {
  const studio = cameraFixture();
  let frames = 0, moved = false;
  studio.renderer = { render() { frames++; }, getSize: target => target.set(800, 450), getPixelRatio: () => 1 };
  studio.controls.update = () => { const changed = moved; moved = false; return changed; };
  for (let index = 0; index < 10; index++) studio._renderPreview();
  assert.equal(frames, 0);
  studio._requestRender();
  studio._renderPreview(); studio._renderPreview();
  assert.equal(frames, 1);
  moved = true;
  studio._renderPreview(); studio._renderPreview();
  assert.equal(frames, 2);
  studio._exportState = {};
  studio._requestRender(); studio._renderPreview();
  assert.equal(frames, 2);
  studio._exportState = null;
  studio._renderPreview();
  assert.equal(frames, 3);
});

test('support defaults to continuous colored extrusion with actual layer dimensions', async () => {
  const studio = cameraFixture();
  const body = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
  studio._adopt(body, 'model', '3mf', { mode: 'mesh', filamentPalette: ['#ff0000', '#00ff00'], materialColors: [{ tool: 0, color: '#ff0000', source: 'file' }] });
  await studio.loadSupportGCode('M83\nT1\n;TYPE:Support\n;WIDTH:0.5\n;HEIGHT:0.25\nG0Z.25\nG1X1E1');
  const overlay = studio._supportOverlay;
  assert.equal(overlay.root.material.visible, false);
  assert.equal(overlay.shadow.userData.solidSupport, true);
  assert.equal(overlay.shadow.material.isMeshStandardMaterial, true);
  assert.deepEqual(overlay.shadow.instanceColor.array, new Float32Array([0, 1, 0]));
  const matrix = new THREE.Matrix4();
  overlay.shadow.getMatrixAt(0, matrix);
  const center = new THREE.Vector3().setFromMatrixPosition(matrix);
  assert.ok(Math.abs(center.z - 0.125) < 1e-6);
  assert.equal(overlay.shadow.geometry.parameters.radialSegments, 6);
  assert.equal(overlay.shadow.geometry.parameters.openEnded, true);
  assert.equal(overlay.shadow.geometry.index.count / 3, 12);
  assert.equal(overlay.caps.count, 2);
  const points = new THREE.Box3().setFromBufferAttribute(overlay.shadow.geometry.attributes.position).applyMatrix4(matrix);
  assert.ok(Math.abs(points.max.z - 0.25) < 1e-6);
  assert.ok(Math.abs(points.min.z) < 1e-6);
  studio.options.supportDisplay = 'paths'; studio._updateSupportDisplay();
  assert.equal(overlay.root.material.visible, true);
  assert.equal(overlay.shadow.userData.solidSupport, false);
  assert.equal(overlay.root.geometry.attributes.instanceColorStart.getY(0), 1);
});

test('continuous and closed support strokes remove interior caps without losing segments', async () => {
  const studio = cameraFixture();
  studio._adopt(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial()), 'model', '3mf', { mode: 'mesh' });
  await studio.loadSupportGCode('M83\n;TYPE:Support\nG0Z.2\nG1X1E1\nG1Y1E1\nG1X0E1\nG1Y0E1\nG0X3Y0\nG1X4E1\nG1Y1E1');
  assert.equal(studio._supportOverlay.shadow.count, 6);
  assert.equal(studio._supportOverlay.caps.count, 2);
  assert.equal(studio.metadata.supportSurfaceTriangles, 6 * 12 + 2 * 6);
});

test('photo cover crop keeps camera optics tied to the full source image', () => {
  const studio = cameraFixture();
  studio._backgroundSize = { width: 4, height: 3 };
  studio._fullSourceFov = 36;
  const wide = studio._visiblePhotoFov(16 / 9);
  assert.ok(Math.abs(Math.tan(THREE.MathUtils.degToRad(wide) / 2) / Math.tan(THREE.MathUtils.degToRad(36) / 2) - 0.75) < 1e-12);
  assert.equal(studio._visiblePhotoFov(9 / 16), 36);
  studio._setPhotoFovFromVisible(wide, 16 / 9);
  assert.ok(Math.abs(studio._fullSourceFov - 36) < 1e-12);
});

test('silhouette and RG16 height readback are top-left and restore scene, pose and optics', () => {
  const studio = cameraFixture();
  const body = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
  studio._adopt(body, 'model', 'stl', { mode: 'mesh' });
  studio.modelGroup.visible = false;
  studio._backgroundSize = { width: 4, height: 3 };
  studio._fullSourceFov = 36;
  studio.camera.fov = studio._visiblePhotoFov();
  studio.camera.updateProjectionMatrix();
  studio.options.crop = normalizeCrop({ x: 0.1, y: 0.2, width: 0.6, height: 0.5 }, 4 / 3);
  studio._applyCameraFraming(1.6);
  const originalView = { ...studio.camera.view };
  const originalFov = studio.camera.fov;
  const originalBackground = new THREE.Color('#345678');
  studio.scene.background = originalBackground;
  let target = null, clear = new THREE.Color('#123456'), alpha = 0.7;
  let draws = 0, expectedFov = 36, sampledProjection;
  const samplePoint = new THREE.Vector3(0.7, 2.9, 1.5);
  studio.renderer = {
    autoClear: true, shadowMap: { enabled: true },
    getSize: value => value.set(800, 450), getPixelRatio: () => 1,
    getRenderTarget: () => target, setRenderTarget: value => { target = value; },
    getClearColor: value => value.copy(clear), getClearAlpha: () => alpha,
    setClearColor: (color, value) => { clear = new THREE.Color(color); alpha = value; },
    getViewport: value => value.set(0, 0, 800, 450), getScissor: value => value.set(0, 0, 800, 450), getScissorTest: () => false,
    setViewport() {}, setScissor() {}, setScissorTest() {},
    render(scene, camera) {
      draws++;
      assert.equal(scene.background, null);
      assert.equal(studio.renderer.shadowMap.enabled, false);
      assert.equal(studio.modelGroup.visible, true);
      assert.ok(Math.abs(camera.fov - expectedFov) < 1e-10);
      sampledProjection = samplePoint.clone().project(camera);
    },
    readRenderTargetPixels(_target, _x, _y, width, height, values) {
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) values.set([y, x, 0, x < 4 ? 255 : 0], (y * width + x) * 4);
    },
  };
  const mask = studio.renderSilhouette(8, 8, { pose: { modelOffsetY: 1, modelScale: 1.3 } });
  assert.equal(mask.data[0], 255);
  assert.equal(mask.data[4], 0);
  studio._baseBounds.max.y = 12; // A support or another part extends the growth range.
  const rotatedPose = new THREE.Matrix4().compose(new THREE.Vector3(0, 4, 0), new THREE.Quaternion().setFromEuler(new THREE.Euler(0.55, 0, 0)), new THREE.Vector3(1.3, 1.3, 1.3));
  const growthBounds = studio._baseBounds.clone().applyMatrix4(rotatedPose);
  const map = studio.renderHeightMap(8, 8, { pose: { modelOffsetY: 1, modelScale: 1.3, modelRotationX: 0.55 }, supports: false });
  assert.ok(map.data instanceof Uint16Array);
  assert.equal(map.data[0], 7 * 256);
  assert.equal(map.data[57], 1);
  assert.ok(Math.abs(map.minY - growthBounds.min.y) < 1e-9);
  assert.ok(Math.abs(map.maxY - growthBounds.max.y) < 1e-9);
  assert.equal(draws, 2);
  assert.equal(studio._analysisTargets.size, 1);
  assert.equal(studio.modelGroup.visible, false);
  assert.deepEqual(studio.modelGroup.position.toArray(), [0, 0, 0]);
  assert.deepEqual(studio.modelGroup.scale.toArray(), [1, 1, 1]);
  assert.equal(studio.camera.fov, originalFov);
  assert.equal(studio.camera.aspect, 4 / 3);
  assert.deepEqual(studio.camera.view, originalView);
  assert.equal(studio.scene.background, originalBackground);
  assert.equal(studio.scene.overrideMaterial, null);
  assert.equal(target, null);
  assert.equal(studio.renderer.shadowMap.enabled, true);
  const sourceCamera = studio.camera.clone();
  sourceCamera.clearViewOffset(); sourceCamera.aspect = 4 / 3; sourceCamera.fov = 36; sourceCamera.updateProjectionMatrix();
  const fullProjection = samplePoint.clone().project(sourceCamera);
  expectedFov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(36) / 2) * 2 / 3));
  studio.renderHeightMap(16, 8, { frame: 'output' });
  assert.ok(Math.abs((sampledProjection.x + 1) / 2 - (fullProjection.x + 1) / 2) < 1e-10);
  assert.ok(Math.abs((1 - sampledProjection.y) / 2 - ((1 - fullProjection.y) / 2 - 1 / 6) / (2 / 3)) < 1e-10);
  assert.deepEqual(studio.camera.view, originalView);
  studio.options.crop = null;
  studio._applyCameraFraming(16 / 9);
  expectedFov = studio.camera.fov;
  const modelOnlyProjection = samplePoint.clone().project(studio.camera);
  studio._cropFullFov = 36;
  studio._releaseBackground();
  studio.renderSilhouette(16, 9, { frame: 'output' });
  assert.ok(Math.hypot(sampledProjection.x - modelOnlyProjection.x, sampledProjection.y - modelOnlyProjection.y) < 1e-10);
  studio.renderHeightMap(16, 9, { frame: 'output' });
  assert.ok(Math.hypot(sampledProjection.x - modelOnlyProjection.x, sampledProjection.y - modelOnlyProjection.y) < 1e-10);
  assert.equal(studio.camera.fov, expectedFov);
});

test('empty preview draws directly; captured-photo appearance uses unblurred linear coverage without model depth-of-field', () => {
  const studio = cameraFixture();
  let direct = 0, linear = 0;
  studio._metadata = null;
  studio._drawUnblurredScene = GrowthStudio.prototype._drawUnblurredScene;
  studio.renderer = { render() { direct++; }, getClearColor: target => target.set('#222222'), getClearAlpha: () => 1,
    getSize: target => target.set(800, 450), getPixelRatio: () => 1 };
  studio._ensureDof = () => {
    studio._dofRenderPass = {};
    studio._dofBokehPass = { enabled: true };
    studio._dofComposer = { render() { linear++; assert.equal(studio._dofBokehPass.enabled, false); assert.equal(studio._dofRenderPass.clearAlpha, 1); } };
  };
  studio.options.dofEnabled = true;
  studio.options.dofStrength = 50;
  studio.options.transparent = true;
  studio._drawScene();
  studio._metadata = {mode:'mesh'};
  studio.options.transparent = false; studio.options.outputAppearance = 'photo';
  studio._drawScene();
  assert.equal(direct, 1);
  assert.equal(linear, 1);
  assert.equal(studio._dofBokehPass.enabled, true);
  assert.deepEqual(studio.photoDofStatus, { error: null, lens: null });
});

test('custom source crop validates normalized rectangles and preserves exact camera projection', () => {
  assert.equal(normalizeCrop(null), null);
  for (const crop of [{ x: -0.1, y: 0, width: 1, height: 1 }, { x: 0.5, y: 0, width: 0.6, height: 1 }, { x: 0, y: 0, width: 0, height: 1 }]) assert.throws(() => normalizeCrop(crop), /裁剪范围/);
  const studio = cameraFixture();
  studio._backgroundSize = { width: 4, height: 3 };
  studio._fullSourceFov = 36;
  studio.camera.aspect = 4 / 3;
  studio.camera.fov = 36;
  studio.camera.updateProjectionMatrix();
  const point = new THREE.Vector3(0.7, 2.9, 1.5);
  const full = point.clone().project(studio.camera);
  const crop = normalizeCrop({ x: 0.15, y: 0.12, width: 0.6, height: 0.5 }, 4 / 3);
  studio.options.crop = crop;
  studio._applyCameraFraming(crop.width * crop.sourceAspect / crop.height);
  const projected = point.clone().project(studio.camera);
  assert.ok(Math.abs((projected.x + 1) / 2 - ((full.x + 1) / 2 - crop.x) / crop.width) < 1e-10);
  assert.ok(Math.abs((1 - projected.y) / 2 - ((1 - full.y) / 2 - crop.y) / crop.height) < 1e-10);
  assert.equal(studio.camera.aspect, 4 / 3);
  assert.equal(studio.camera.fov, 36);
  assert.equal(studio.camera.view.enabled, true);
  studio.options.crop = null; studio._applyCameraFraming(4 / 3);
  assert.equal(studio.camera.view.enabled, false);
  assert.equal(studio.camera.fov, 36);
});

test('background custom crop uses identical source UVs with correct top-left Y orientation', () => {
  const studio = cameraFixture();
  studio.options.crop = normalizeCrop({ x: 0.15, y: 0.12, width: 0.6, height: 0.5 }, 4 / 3);
  studio._backgroundSize = { width: 400, height: 300 };
  studio._backgroundTexture = new THREE.Texture();
  studio.floor = new THREE.Mesh();
  studio._floorShadowMaterial = new THREE.ShadowMaterial();
  studio.renderer = { getSize: target => target.set(800, 500), getPixelRatio: () => 1, setClearAlpha() {} };
  studio._updateBackground();
  assert.deepEqual(studio._backgroundTexture.repeat.toArray(), [0.6, 0.5]);
  assert.deepEqual(studio._backgroundTexture.offset.toArray(), [0.15, 0.38]);
});

test('photo bed unit conversion stays fixed when the display model is resized', () => {
  const conversions=[];
  for(const [normalizedScale,sourceUnitsToMm] of [[.04,1],[40,1000],[.4,10]]){
    const studio=Object.create(GrowthStudio.prototype);
    studio.normalized={scale:new THREE.Vector3(normalizedScale,normalizedScale,normalizedScale)};
    studio._metadata={sourceUnitsToMm};studio.options={modelScale:1};
    const bedScale=studio.sourceMillimetresToWorld;
    conversions.push(bedScale);
    const camera=new THREE.PerspectiveCamera(48,4/3,.01,1000);
    camera.position.set(160*bedScale,230*bedScale,410*bedScale);camera.lookAt(0,50*bedScale,0);camera.updateMatrixWorld(true);
    const initial=new THREE.Vector3(30*bedScale,70*bedScale,0).project(camera);
    const before=camera.matrixWorld.clone();
    studio.options.modelScale=2;
    assert.equal(studio.sourceMillimetresToWorld,bedScale,'photographed bed/camera does not grow with the model');
    assert.equal(studio.modelMillimetresToWorld,bedScale*2,'actual geometry still follows explicit display resizing');
    const enlarged=new THREE.Vector3(30*studio.modelMillimetresToWorld,70*studio.modelMillimetresToWorld,0).project(camera);
    assert.ok(initial.distanceTo(enlarged)>.1,'resizing is visible in the fixed photo camera');
    assert.deepEqual(camera.matrixWorld.toArray(),before.toArray());
  }
  assert.deepEqual(conversions,[.04,.04,.04],'equivalent mm, metres and centimetres sources share one bed metric');
});
