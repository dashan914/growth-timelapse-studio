import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { photographicModelBounds,photographicModelGeometry } from '../src/photography-model-bounds.js';
import { GrowthStudio } from '../src/studio.js';
import { fitPhotographicModelPose } from '../src/photography-placement.js';

const close = (actual, expected, tolerance = 1e-6) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} ≈ ${expected}`);
function closeVector(actual, expected) {
  actual.toArray().forEach((value, index) => close(value, expected[index]));
}
function sourceMesh(points) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(points.flat(), 3));
  return new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
}
function localPose(object) {
  return { position: object.position.toArray(), quaternion: object.quaternion.toArray(), scale: object.scale.toArray(), matrixAutoUpdate: object.matrixAutoUpdate };
}
function cameraFixture() {
  const camera = new THREE.PerspectiveCamera(32, 3 / 4, .01, 200);
  camera.position.set(0, 4, 15);
  camera.lookAt(0, 2, 0);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  return camera;
}
const composition = { yawDeg: 35, centerX: .5, footY: .83, maxHeight: .52, maxWidth: .66 };

test('printer geometry frames real vertices while the feet anchor excludes a raised asymmetric tail',()=>{
  const group=new THREE.Group(),mesh=sourceMesh([[-1,0,-1],[1,0,1],[20,5,0],[0,8,0]]);
  const supports=sourceMesh([[-90,-50,-90],[90,50,90]]);group.add(mesh,supports);
  mesh.visible=false;mesh.geometry.setDrawRange(0,1);
  const data=photographicModelGeometry([mesh,supports],group,0,new Set([supports]));
  assert.equal(data.points.length,12);closeVector(data.contactCenter,[0,0,0]);
  closeVector(data.bounds.min,[-1,0,-1]);closeVector(data.bounds.max,[20,8,1]);
  assert.ok(data.bounds.getCenter(new THREE.Vector3()).x>9,'the full tail would otherwise move the feet');
  group.position.set(20,30,-12);group.rotation.set(.2,.9,-.3);group.scale.setScalar(2);
  const moved=photographicModelGeometry([mesh,supports],group,0,new Set([supports]));
  for(let i=0;i<data.points.length;i++)close(moved.points[i],data.points[i]);
  closeVector(moved.contactCenter,[0,0,0]);
});

test('photographic measurement rotates actual asymmetric vertices rather than the empty corners of the old AABB', () => {
  const group = new THREE.Group();
  const mesh = sourceMesh([[0, 0, 0], [10, 0, 0], [0, 4, 10]]);
  group.add(mesh);
  const result = photographicModelBounds([mesh], group, 45);
  const diagonal = 10 / Math.sqrt(2);
  closeVector(result.min, [0, 0, -diagonal]);
  closeVector(result.max, [diagonal, 4, diagonal]);
  close(result.getCenter(new THREE.Vector3()).x, diagonal / 2);
  mesh.geometry.computeBoundingBox();
  const rotatedOldBox = mesh.geometry.boundingBox.clone().applyMatrix4(new THREE.Matrix4().makeRotationY(Math.PI / 4));
  assert.ok(rotatedOldBox.max.x - result.max.x > 7, 'the missing [10,*,10] source corner must not shift centering');
  assert.ok(rotatedOldBox.getCenter(new THREE.Vector3()).x - result.getCenter(new THREE.Vector3()).x > 3.5);
});

test('normalized and assembly transforms remain, while existing model pose and transformed parents are removed', () => {
  const scene = new THREE.Group();
  scene.position.set(90, -12, 30);
  scene.rotation.set(.2, -.5, .3);
  scene.scale.set(2, 3, 4);
  const modelGroup = new THREE.Group();
  modelGroup.position.set(-8, 14, 9);
  modelGroup.rotation.set(.1, .9, -.4);
  modelGroup.scale.setScalar(1.7);
  scene.add(modelGroup);
  const normalized = new THREE.Group();
  normalized.position.set(-2, 1, 3);
  normalized.scale.setScalar(.5);
  modelGroup.add(normalized);
  const assembly = new THREE.Group();
  assembly.position.set(10, 2, -4);
  normalized.add(assembly);
  const mesh = sourceMesh([[0, 0, 0], [2, 4, 6]]);
  assembly.add(mesh);
  const before = [scene, modelGroup, normalized, assembly, mesh].map(localPose);
  const result = photographicModelBounds([mesh], modelGroup, 90);
  closeVector(result.min, [1, 2, -4]);
  closeVector(result.max, [4, 4, -3]);
  assert.deepEqual([scene, modelGroup, normalized, assembly, mesh].map(localPose), before);
  modelGroup.position.set(100, -50, 23);
  modelGroup.rotation.set(-.3, -1, .4);
  modelGroup.scale.setScalar(.3);
  const differentlyPosed = photographicModelBounds([mesh], modelGroup, 90);
  closeVector(differentlyPosed.min, result.min.toArray());
  closeVector(differentlyPosed.max, result.max.toArray());
});

test('source assembly mesh transforms and explicit matrices contribute to a single whole-model measurement', () => {
  const group = new THREE.Group();
  const build = new THREE.Group();
  build.position.set(2, 0, 0);
  group.add(build);
  const body = sourceMesh([[0, 0, 0], [2, 4, 1]]);
  const tail = sourceMesh([[0, 0, 0], [1, 1, 3]]);
  tail.matrixAutoUpdate = false;
  tail.matrix.makeTranslation(7, 1, -3);
  build.add(body, tail);
  const result = photographicModelBounds([body, tail], group);
  closeVector(result.min, [2, 0, -3]);
  closeVector(result.max, [10, 4, 1]);
  assert.equal(tail.matrixAutoUpdate, false);
  closeVector(new THREE.Vector3().setFromMatrixPosition(tail.matrix), [7, 1, -3]);
});

test('full source vertices are measured despite growth visibility, clipping and draw range; supports are excluded', () => {
  const group = new THREE.Group();
  const mesh = sourceMesh([[-2, 0, -1], [3, 6, 2], [8, 2, -4]]);
  mesh.visible = false;
  mesh.geometry.setDrawRange(0, 1);
  mesh.material.clippingPlanes = [new THREE.Plane(new THREE.Vector3(0, -1, 0), 1)];
  const support = sourceMesh([[-200, -100, -100], [200, 200, 100]]);
  group.add(mesh, support);
  const source = Array.from(mesh.geometry.attributes.position.array);
  const oldDrawRange = { ...mesh.geometry.drawRange };
  const pose = localPose(mesh);
  const result = photographicModelBounds([mesh, support], group, 0, new Set([support]));
  closeVector(result.min, [-2, 0, -4]);
  closeVector(result.max, [8, 6, 2]);
  assert.deepEqual(Array.from(mesh.geometry.attributes.position.array), source);
  assert.deepEqual(mesh.geometry.drawRange, oldDrawRange);
  assert.deepEqual(localPose(mesh), pose);
  assert.equal(mesh.visible, false);
  assert.equal(mesh.material.clippingPlanes[0].constant, 1);
});

test('instanced source geometry includes each active instance with its matrix exactly once', () => {
  const group = new THREE.Group();
  const geometry = sourceMesh([[0, 0, 0], [1, 2, 3]]).geometry;
  const mesh = new THREE.InstancedMesh(geometry, new THREE.MeshBasicMaterial(), 3);
  mesh.position.set(2, 0, 0);
  mesh.setMatrixAt(0, new THREE.Matrix4().makeTranslation(-4, 0, 0));
  mesh.setMatrixAt(1, new THREE.Matrix4().makeTranslation(5, 3, -2));
  mesh.setMatrixAt(2, new THREE.Matrix4().makeTranslation(500, 500, 500));
  mesh.count = 2;
  group.add(mesh);
  const before = Array.from(mesh.instanceMatrix.array);
  const result = photographicModelBounds([mesh], group, 90);
  closeVector(result.min, [-2, 0, -8]);
  closeVector(result.max, [3, 5, 2]);
  assert.deepEqual(Array.from(mesh.instanceMatrix.array), before);
  assert.equal(mesh.count, 2);
});

test('empty geometry, non-finite vertices, missing model group and non-finite yaw cannot provide bounds', () => {
  const group = new THREE.Group();
  const empty = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
  const invalid = sourceMesh([[NaN, 0, 0], [0, Infinity, 0], [0, 0, -Infinity]]);
  const support = sourceMesh([[0, 0, 0], [1, 1, 1]]);
  group.add(empty, invalid, support);
  assert.equal(photographicModelBounds([], group), null);
  assert.equal(photographicModelBounds(null, group), null);
  assert.equal(photographicModelBounds([support], null), null);
  assert.equal(photographicModelBounds([support], group, NaN), null);
  assert.equal(photographicModelBounds([support], group, Infinity), null);
  assert.equal(photographicModelBounds([empty, invalid, support], group, 0, new Set([support])), null);
  const mixed = sourceMesh([[NaN, 0, 0], [2, 3, 4], [-1, 0, 1]]);
  group.add(mixed);
  const result = photographicModelBounds([mixed], group);
  closeVector(result.min, [-1, 0, 1]);
  closeVector(result.max, [2, 3, 4]);
});

test('studio photography placement explicitly fits full mesh and not growth or support bounds, without editing source or camera', () => {
  const studio = Object.create(GrowthStudio.prototype);
  studio.modelGroup = new THREE.Group();
  studio.modelGroup.position.set(20, 10, -9);
  studio.modelGroup.rotation.y = 1;
  studio.modelGroup.scale.setScalar(2);
  const mesh = sourceMesh([[-1, 0, -1], [2, 3, 1], [4, 1, -1]]);
  mesh.visible = false;
  const support = sourceMesh([[-100, -20, -20], [100, 100, 20]]);
  studio.modelGroup.add(mesh, support);
  studio._meshes = [mesh, support];
  studio._supportMeshes = new Set([support]);
  studio._bounds = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(.01, .01, .01));
  studio._baseBounds = new THREE.Box3(new THREE.Vector3(-100, -20, -20), new THREE.Vector3(100, 100, 20));
  studio.options = { progress: .1, showSupports: true, modelRotationY: 1, modelScale: 2 };
  studio.camera = cameraFixture();
  studio.hasModel = () => true;
  const calls = [];
  studio.setOptions = pose => calls.push({ ...pose });
  const source = Array.from(mesh.geometry.attributes.position.array);
  const poseBefore = localPose(studio.modelGroup);
  const cameraBefore = { pose: localPose(studio.camera), projection: studio.camera.projectionMatrix.toArray(), world: studio.camera.matrixWorld.toArray() };
  const bounds = photographicModelBounds(studio._meshes, studio.modelGroup, composition.yawDeg, studio._supportMeshes);
  assert.equal(calls.length, 0, 'read-only measurement must not start automatic placement');
  const expected = fitPhotographicModelPose({ bounds, camera: studio.camera, profile: { ...composition, yawDeg: 0 }, offsetUnit: 4 });
  assert.ok(expected);
  expected.modelRotationY = THREE.MathUtils.degToRad(composition.yawDeg);
  const actual = studio.applyPhotographyPlacement(composition);
  assert.deepEqual(actual, expected);
  assert.deepEqual(calls, [expected]);
  assert.deepEqual(Array.from(mesh.geometry.attributes.position.array), source);
  assert.deepEqual(localPose(studio.modelGroup), poseBefore, 'measurement relies on setOptions to apply the pose, without mutating it itself');
  assert.deepEqual({ pose: localPose(studio.camera), projection: studio.camera.projectionMatrix.toArray(), world: studio.camera.matrixWorld.toArray() }, cameraBefore);
  studio.options.progress = 1;
  studio.options.showSupports = false;
  assert.deepEqual(studio.applyPhotographyPlacement(composition), expected, 'growing the object and hiding support must not move the completed composition');
  assert.equal(calls.length, 2);
});

function placementStudioWithStaleProjection() {
  const studio = Object.create(GrowthStudio.prototype);
  studio.modelGroup = new THREE.Group();
  const mesh = sourceMesh([[-2, 0, -1], [2, 5, 1], [5, 1, -2]]);
  studio.modelGroup.add(mesh);
  studio._meshes = [mesh];
  studio._supportMeshes = new Set();
  studio.hasModel = () => true;
  studio.host = { clientWidth: 540, clientHeight: 720 };
  studio._viewportAspect = 4 / 3;
  studio._backgroundSize = { width: 1080, height: 1440 };
  studio._fullSourceFov = 40;
  studio.options = { progress: .5, crop: null };
  studio.camera = cameraFixture();
  studio.camera.aspect = 4 / 3;
  // The ResizeObserver has not yet replaced the previous landscape cover.
  studio.camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(40) / 2) * (3 / 4) / (4 / 3)));
  studio.camera.updateProjectionMatrix();
  studio.placementCalls = [];
  studio.setOptions = pose => studio.placementCalls.push({ ...pose });
  return studio;
}

function cameraOptics(camera) {
  return {
    pose: localPose(camera), aspect: camera.aspect, fov: camera.fov,
    view: camera.view && { ...camera.view },
    projection: camera.projectionMatrix.toArray(), inverseProjection: camera.projectionMatrixInverse.toArray(),
    world: camera.matrixWorld.toArray(), inverseWorld: camera.matrixWorldInverse.toArray(),
  };
}

function expectedStudioPlacement(studio, camera) {
  const bounds = photographicModelBounds(studio._meshes, studio.modelGroup, composition.yawDeg, studio._supportMeshes);
  const pose = fitPhotographicModelPose({ bounds, camera, profile: { ...composition, yawDeg: 0 }, offsetUnit: 4 });
  assert.ok(pose);
  pose.modelRotationY = THREE.MathUtils.degToRad(composition.yawDeg);
  return pose;
}

function closePlacement(actual, expected) {
  assert.ok(actual);
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort());
  for (const key of Object.keys(expected)) close(actual[key], expected[key], 1e-8);
}

test('photographic placement fits the current portrait host before ResizeObserver replaces a stale landscape projection', () => {
  const studio = placementStudioWithStaleProjection();
  const before = cameraOptics(studio.camera);
  const target = studio.camera.clone();
  target.clearViewOffset();
  target.aspect = 3 / 4;
  target.fov = 40;
  target.updateProjectionMatrix();
  target.updateMatrixWorld(true);
  const expected = expectedStudioPlacement(studio, target);
  const stale = expectedStudioPlacement(studio, studio.camera);
  assert.ok(Math.abs(stale.modelScale - expected.modelScale) > .1,
    'the old cover projection would materially shrink the model after the portrait host catches up');
  const actual = studio.applyPhotographyPlacement(composition);
  closePlacement(actual, expected);
  assert.deepEqual(studio.placementCalls, [actual]);
  assert.deepEqual(cameraOptics(studio.camera), before, 'fitting must not resize or edit the live camera');
  assert.equal(studio._viewportAspect, 4 / 3, 'the eventual observer still owns live viewport framing');
});

test('photographic placement also fits a new landscape cover before a stale portrait camera catches up', () => {
  const studio = placementStudioWithStaleProjection();
  studio.host = { clientWidth: 720, clientHeight: 540 };
  studio._viewportAspect = 3 / 4;
  studio.camera.aspect = 3 / 4;
  studio.camera.fov = 40;
  studio.camera.updateProjectionMatrix();
  const before = cameraOptics(studio.camera);
  const target = studio.camera.clone();
  target.clearViewOffset();
  target.aspect = 4 / 3;
  target.fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(40) / 2) * (3 / 4) / (4 / 3)));
  target.updateProjectionMatrix();
  target.updateMatrixWorld(true);
  const expected = expectedStudioPlacement(studio, target);
  const stale = expectedStudioPlacement(studio, studio.camera);
  assert.ok(Math.abs(stale.modelScale - expected.modelScale) > .1,
    'the portrait lens would materially oversize the model after landscape cover catches up');
  const actual = studio.applyPhotographyPlacement(composition);
  closePlacement(actual, expected);
  assert.deepEqual(studio.placementCalls, [actual]);
  assert.deepEqual(cameraOptics(studio.camera), before);
  assert.equal(studio._viewportAspect, 3 / 4);
});

test('photographic placement preserves cropped framing on its clone using the source lens rather than stale visible FOV', () => {
  for (const sourceLensAvailable of [true, false]) {
    const studio = placementStudioWithStaleProjection();
    const crop = { sourceAspect: 3 / 4, x: .1, y: .05, width: .75, height: .85 };
    studio.options.crop = crop;
    studio._fullSourceFov = sourceLensAvailable ? 44 : null;
    studio._cropFullFov = 48;
    // Keep an existing different live crop to expose accidental live mutation
    // and fitting against yesterday's projection instead of the active crop.
    studio.camera.setViewOffset(4 / 3, 1, .1, .1, 1, .8);
    const before = cameraOptics(studio.camera);
    const target = studio.camera.clone();
    target.fov = sourceLensAvailable ? 44 : 48;
    target.setViewOffset(crop.sourceAspect, 1, crop.x * crop.sourceAspect, crop.y, crop.width * crop.sourceAspect, crop.height);
    target.updateMatrixWorld(true);
    const expected = expectedStudioPlacement(studio, target);
    const stale = expectedStudioPlacement(studio, studio.camera);
    assert.ok(Math.abs(stale.modelScale - expected.modelScale) > .1,
      'fitting a stale visible lens would materially change the cropped model size');
    const actual = studio.applyPhotographyPlacement(composition);
    closePlacement(actual, expected);
    assert.deepEqual(studio.placementCalls, [actual]);
    assert.deepEqual(cameraOptics(studio.camera), before, 'live crop and lens remain untouched');
    assert.deepEqual(studio.options.crop, crop);
  }
});

test('studio placement does not call setOptions when model, bounds or composition is invalid', () => {
  const studio = Object.create(GrowthStudio.prototype);
  studio.modelGroup = new THREE.Group();
  studio.camera = cameraFixture();
  studio._meshes = [];
  studio._supportMeshes = new Set();
  let calls = 0;
  studio.setOptions = () => calls++;
  studio.hasModel = () => false;
  assert.equal(studio.applyPhotographyPlacement(composition), null);
  studio.hasModel = () => true;
  assert.equal(studio.applyPhotographyPlacement(composition), null);
  const mesh = sourceMesh([[0, 0, 0], [1, 3, 1]]);
  studio.modelGroup.add(mesh);
  studio._meshes = [mesh];
  assert.equal(studio.applyPhotographyPlacement(null), null);
  assert.equal(studio.applyPhotographyPlacement({ ...composition, yawDeg: NaN }), null);
  assert.equal(studio.applyPhotographyPlacement({ ...composition, footY: -.1 }), null);
  assert.equal(calls, 0);
});

test('an explicit XYZ rotation measures real source contact vertices instead of empty old-box corners', () => {
  const group = new THREE.Group();
  const points = [[0, 0, 0], [8, 0, 0], [0, 4, 5]];
  const mesh = sourceMesh(points);
  group.add(mesh);
  const euler = new THREE.Euler(.4, .6, -.5, 'XYZ');
  const rotation = new THREE.Matrix4().makeRotationFromEuler(euler);
  const result = photographicModelBounds([mesh], group, 0, new Set(), rotation);
  const actual = new THREE.Box3().setFromPoints(points.map(point => new THREE.Vector3(...point).applyEuler(euler)));
  closeVector(result.min, actual.min.toArray()); closeVector(result.max, actual.max.toArray());
  mesh.geometry.computeBoundingBox();
  const emptyCorners = mesh.geometry.boundingBox.clone().applyMatrix4(rotation);
  assert.ok(emptyCorners.min.y < result.min.y - .5, 'an unoccupied tilted source box corner is below the real model sole');
  const original = rotation.toArray();
  photographicModelBounds([mesh], group, 123, new Set(), rotation);
  assert.deepEqual(rotation.toArray(), original);
  assert.equal(photographicModelBounds([mesh], group, 0, new Set(), {}), null);
  const invalid = new THREE.Matrix4(); invalid.elements[3] = NaN;
  assert.equal(photographicModelBounds([mesh], group, 0, new Set(), invalid), null);
});

test('settling a tilted source model puts its actual sole at y=0 and preserves size, facing and XZ placement across growth', () => {
  const studio = Object.create(GrowthStudio.prototype);
  studio.modelGroup = new THREE.Group();
  const normalized = new THREE.Group();
  normalized.scale.setScalar(.5);
  normalized.position.set(-1, 0, 1);
  studio.modelGroup.add(normalized);
  const mesh = sourceMesh([[0, 0, 0], [8, 0, 0], [0, 4, 5]]);
  const support = sourceMesh([[-100, -100, -100], [100, 100, 100]]);
  normalized.add(mesh, support);
  mesh.visible = false;
  studio._meshes = [mesh, support]; studio._supportMeshes = new Set([support]);
  studio._backgroundTexture = new THREE.Texture(); studio._photoBedSize = { width: 12, depth: 10 };
  studio._bounds = new THREE.Box3(new THREE.Vector3(-100, -100, -100), new THREE.Vector3(100, 100, 100));
  studio._baseBounds = studio._bounds.clone();
  studio.options = { modelOffsetX: .3, modelOffsetY: 8, modelOffsetZ: -.5, modelRotationX: .4, modelRotationY: .6, modelRotationZ: -.5, modelScale: 1.7, progress: 0, showSupports: true };
  studio.hasModel = () => true;
  const preserved = { ...studio.options }; delete preserved.modelOffsetY;
  const source = Array.from(mesh.geometry.attributes.position.array), calls = [];
  studio.setOptions = pose => {
    calls.push({ ...pose }); Object.assign(studio.options, pose);
    studio.modelGroup.position.set(studio.options.modelOffsetX * 4, studio.options.modelOffsetY * 4, studio.options.modelOffsetZ * 4);
    studio.modelGroup.rotation.set(studio.options.modelRotationX, studio.options.modelRotationY, studio.options.modelRotationZ, 'XYZ');
    studio.modelGroup.scale.setScalar(studio.options.modelScale);
    studio.modelGroup.updateWorldMatrix(true, true);
  };
  studio.setOptions({}); calls.length = 0;
  const settled = studio.settleModelOnPhotoFloor();
  assert.deepEqual(Object.keys(settled), ['modelOffsetY']);
  const after = { ...studio.options }; delete after.modelOffsetY;
  assert.deepEqual(after, preserved);
  let minY = Infinity;
  const point = new THREE.Vector3();
  for (let index = 0; index < mesh.geometry.attributes.position.count; index++) {
    point.fromBufferAttribute(mesh.geometry.attributes.position, index).applyMatrix4(mesh.matrixWorld);
    minY = Math.min(minY, point.y);
  }
  close(minY, 0);
  for (const progress of [.2, .5, 1]) {
    studio.options.progress = progress; studio.options.showSupports = progress < .5;
    close(studio.settleModelOnPhotoFloor().modelOffsetY, settled.modelOffsetY, 1e-12);
  }
  assert.equal(calls.length, 4);
  assert.deepEqual(Array.from(mesh.geometry.attributes.position.array), source);
  assert.equal(mesh.visible, false);
  assert.equal(studio.options.modelOffsetX, preserved.modelOffsetX);
  assert.equal(studio.options.modelOffsetZ, preserved.modelOffsetZ);
  assert.equal(studio.options.modelScale, preserved.modelScale);
  assert.equal(studio.options.modelRotationX, preserved.modelRotationX);
  assert.equal(studio.options.modelRotationY, preserved.modelRotationY);
  assert.equal(studio.options.modelRotationZ, preserved.modelRotationZ);
});

test('floor settling requires a model, background and calibrated plane and cannot write options when bounds are missing', () => {
  const studio = Object.create(GrowthStudio.prototype);
  studio.modelGroup = new THREE.Group(); studio._meshes = []; studio._supportMeshes = new Set();
  studio.options = { modelScale: 1, modelRotationX: .2, modelRotationY: 1, modelRotationZ: 0 };
  studio.hasModel = () => true;
  let writes = 0; studio.setOptions = () => writes++;
  assert.equal(studio.settleModelOnPhotoFloor(), null);
  studio._backgroundTexture = new THREE.Texture();
  assert.equal(studio.settleModelOnPhotoFloor(), null);
  studio._photoBedSize = { width: 12, depth: 10 };
  assert.equal(studio.settleModelOnPhotoFloor(), null);
  const mesh = sourceMesh([[0, 0, 0], [1, 1, 1]]);
  studio.modelGroup.add(mesh); studio._meshes = [mesh]; studio.hasModel = () => false;
  assert.equal(studio.settleModelOnPhotoFloor(), null);
  assert.equal(writes, 0);
});
