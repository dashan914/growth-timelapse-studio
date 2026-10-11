import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from 'three';
import { unzipSync, strFromU8 } from 'three/addons/libs/fflate.module.js';
import { loadPaintedThreeMF } from '../src/painted-3mf.js';
import { GrowthStudio } from '../src/studio.js';
import { getPresetDof } from '../src/preset-dof.js';
import { getPresetLighting } from '../src/preset-lighting.js';
import { normalizeRenderOutput, renderMetricScale, renderBackgroundUV, detachedWorldMatrix, cloneRenderGeometry, canonicalRenderPhoto, createSceneRenderPackage } from '../src/scene-package.js';

// Official GLTFExporter uses the browser FileReader for its final GLB Blob.
globalThis.FileReader ||= class {
  readAsArrayBuffer(blob) { blob.arrayBuffer().then(result => { this.result = result; this.onloadend?.(); }); }
  readAsDataURL(blob) { blob.arrayBuffer().then(result => { this.result = `data:${blob.type};base64,${Buffer.from(result).toString('base64')}`; this.onloadend?.(); }); }
};
const close = (actual, expected, epsilon = 1e-10) => assert.ok(Math.abs(actual - expected) < epsilon, `${actual} ≠ ${expected}`);
const glbJSON = bytes => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(view.getUint32(0, true), 0x46546c67);
  return JSON.parse(strFromU8(bytes.subarray(20, 20 + view.getUint32(12, true))).trim());
};
function fixture() {
  const parent = new THREE.Group(); parent.position.set(3, 0, -2);
  const root = new THREE.Group(); root.position.set(2, 0, 1); root.rotation.y = 0.3; root.scale.setScalar(1.5); parent.add(root);
  const material = new THREE.MeshStandardMaterial({ color: '#23599c', roughness: 0.64, metalness: 0.07 });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(200, 100, 150), material); mesh.position.y = 50; root.add(mesh);
  const normalized = new THREE.Group(); normalized.scale.setScalar(0.04); root.remove(mesh); normalized.add(mesh); root.add(normalized);
  const camera = new THREE.PerspectiveCamera(42, 4 / 3, 0.05, 1000); camera.position.set(12, 8, 16); camera.lookAt(2, 2, 0); camera.updateMatrixWorld();
  return { root, mesh, material, normalized, camera, units: { normalizedScale: 0.04, sourceUnitsToMm: 1 }, metadata: { format: '3mf', layerHeightMm: 0.12, firstLayerHeightMm: 0.25, lineWidthMm: 0.42 }, floor: { width: 40, depth: 40 }, settings: { progress: 0.2, surfacePreset: 'auto', surfaceDetail: 0.6 }, mode: 'mesh' };
}

test('metric source units retain display scaling; calibrated bed has priority and no hidden unit default', () => {
  assert.deepEqual(renderMetricScale({ normalizedScale: 0.04, sourceUnitsToMm: 1 }), { worldToMetres: 0.025, source: 'source-unit-and-normalization', inferred: false });
  assert.equal(renderMetricScale({ normalizedScale: 40, sourceUnitsToMm: 1000 }).worldToMetres, 0.025);
  assert.equal(renderMetricScale({ calibratedBed: { width: 8, depth: 8 }, bedWidthMm: 350, bedDepthMm: 350, normalizedScale: 0.04, sourceUnitsToMm: 1 }).worldToMetres, 0.04375);
  assert.throws(() => renderMetricScale({ normalizedScale: 0.04 }), /源单位/);
  assert.throws(() => renderMetricScale({ calibratedBed: { width: 8, depth: 8 }, bedWidthMm: 350, bedDepthMm: 256 }), /不一致/);
});

test('expanded photographic shadow receivers reach Cycles without replacing the calibration scale', async () => {
  const snapshot=fixture();
  snapshot.units.calibratedBed={width:12,depth:10};
  snapshot.floor={width:20,depth:24,worldSize:true,matrix:new THREE.Matrix4().makeTranslation(0,-.001,0)};
  const packageOptions={bedWidthMm:180,bedDepthMm:150,output:{width:960,height:720,frames:1}};
  const unpack=async()=>{
    const result=await createSceneRenderPackage(snapshot,packageOptions);
    const files=unzipSync(new Uint8Array(await result.blob.arrayBuffer()));
    return JSON.parse(strFromU8(files['config.json']));
  };
  const expanded=await unpack();
  close(expanded.plane.widthM,.3);close(expanded.plane.depthM,.36);close(expanded.plane.yM,-.000015);
  // Legacy snapshots still use their exact bounded physical printer plate.
  delete snapshot.floor.worldSize;
  const plate=await unpack();close(plate.plane.widthM,.18);close(plate.plane.depthM,.15);
  assert.deepEqual(expanded.camera,plate.camera);assert.deepEqual(expanded.bounds,plate.bounds);
  assert.deepEqual(expanded.surface,plate.surface,'changing shadow coverage cannot resize the source model or its slice beads');
});

test('output caps prohibit runaway frames, dimensions, sampling and arbitrary output directories', () => {
  assert.deepEqual(normalizeRenderOutput({ width: 960, height: 720, fps: 24, frames: 72, growthFrames: 60, samples: 128, directory: '../private' }), { directory: 'frames', width: 960, height: 720, fps: 24, frames: 72, growthFrames: 60, samples: 128 });
  const timing = normalizeRenderOutput({ fps: 24, frames: 72, growthFrames: 49, durationSeconds: 3, growthSeconds: 2 });
  assert.equal(timing.durationSeconds, 3); assert.equal(timing.growthSeconds, 2);
  assert.throws(() => normalizeRenderOutput({ fps: 24, frames: 72, durationSeconds: 4, growthSeconds: 2 }), /帧数不一致/);
  for (const invalid of [{ frames: 1801 }, { width: 4096, height: 4096 }, { samples: 512 }, { fps: 29.97 }, { frames: 10, growthFrames: 11 }]) assert.throws(() => normalizeRenderOutput(invalid));
});

test('current-frame Cycles preview retains only a finite explicit progress with bounded still-frame settings', () => {
  const output = { width: 960, height: 720, fps: 1, frames: 1, growthFrames: 1, samples: 64 };
  for (const previewProgress of [0, .5, 1]) {
    assert.deepEqual(normalizeRenderOutput({ ...output, previewProgress }), { directory: 'frames', ...output, previewProgress });
  }
  for (const previewProgress of [undefined, null, false, '0.5', NaN, Infinity, -.01, 1.01]) {
    assert.throws(() => normalizeRenderOutput({ ...output, previewProgress }), /生长进度/);
  }
  for (const invalid of [{ frames: 2 }, { growthFrames: 2 }, { fps: 30 }, { samples: 128 }, { durationSeconds: 1 }, { growthSeconds: 1 }]) {
    assert.throws(() => normalizeRenderOutput({ ...output, previewProgress: .5, ...invalid }));
  }
  assert.equal(normalizeRenderOutput({ frames: 1 }).previewProgress, undefined, 'ordinary one-frame export keeps its complete-model convention');
});

test('canonical background transforms mirror cover and off-centre crop in texture UV convention', () => {
  assert.deepEqual(renderBackgroundUV({ width: 1600, height: 900, sourceWidth: 4000, sourceHeight: 3000 }).rectangle, { x: 0, y: 0.125, width: 1, height: 0.75 });
  assert.deepEqual(renderBackgroundUV({ width: 900, height: 1600, sourceWidth: 4000, sourceHeight: 3000, crop: { x: 0.2, y: 0.1, width: 0.3, height: 0.5 } }).rectangle, { x: 0.2, y: 0.09999999999999998, width: 0.3, height: 0.5 });
  assert.throws(() => renderBackgroundUV({ width: 100, height: 100, sourceWidth: 400, sourceHeight: 300, crop: { x: 0.9, y: 0, width: 0.2, height: 1 } }));
});

test('canonical PNG uses the exact source rectangle, closes its bitmap, and preserves source input', async () => {
  const calls = []; const source = { name: 'photo.jpg' }; let closed = 0;
  const uv = renderBackgroundUV({ width: 160, height: 90, sourceWidth: 400, sourceHeight: 300 });
  const result = await canonicalRenderPhoto(source, { width: 160, height: 90 }, uv, {
    decode: async file => { assert.equal(file, source); return { width: 400, height: 300, close: () => closed++ }; },
    canvasFactory: () => ({ getContext: () => ({ drawImage: (...args) => calls.push(args.slice(1)) }), toBlob: (callback, type) => { assert.equal(type, 'image/png'); callback(new Blob([new Uint8Array([1, 2, 3])])); } }),
  });
  assert.deepEqual(calls, [[0, 37.5, 400, 225, 0, 0, 160, 90]]); assert.equal(closed, 1); assert.deepEqual(source, { name: 'photo.jpg' }); assert.equal(result.bytes.length, 3);
});

test('full export keeps triangle counts, groups, normals, pose, materials and source ownership intact', async () => {
  const snapshot = fixture(); const source = snapshot.mesh.geometry;
  const stencil = snapshot.mesh.clone(false); stencil.userData.growthStencil = true; snapshot.root.add(stencil);
  const support = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), snapshot.material); support.userData.isSupport = true; snapshot.root.add(support);
  snapshot.root.visible = false; snapshot.settings.showSupports = false;
  const matrixBefore = snapshot.root.matrix.toArray(); const normalsBefore = source.attributes.normal.array.slice();
  const result = await createSceneRenderPackage(snapshot, { output: { width: 960, height: 720, fps: 24, frames: 72 } });
  const files = unzipSync(new Uint8Array(await result.blob.arrayBuffer()));
  assert.deepEqual(Object.keys(files), ['scene.glb', 'config.json']);
  const config = JSON.parse(strFromU8(files['config.json'])); const gltf = glbJSON(files['scene.glb']);
  assert.equal(config.capabilities.triangles, 12); assert.equal(config.capabilities.meshes, 1); assert.equal(config.capabilities.decimated, false);
  assert.equal(gltf.meshes.length, 1); assert.equal(gltf.accessors[gltf.meshes[0].primitives[0].indices].count, 36);
  close(config.surface.layerHeightM, 0.00012); close(config.surface.firstLayerHeightM, 0.00025); close(config.surface.lineWidthM, 0.00042);
  const originalPoint = new THREE.Vector3(10, 25, -30);
  const metricPoint = originalPoint.clone().applyMatrix4(detachedWorldMatrix(snapshot.mesh)).multiplyScalar(0.025);
  const printPoint = metricPoint.applyMatrix4(new THREE.Matrix4().fromArray(config.surface.printCoordinatesMatrix));
  close(printPoint.x, originalPoint.x / 1000); close(printPoint.y, (originalPoint.y + 50) / 1000); close(printPoint.z, originalPoint.z / 1000);
  assert.equal(gltf.accessors[gltf.meshes[0].primitives[0].attributes.NORMAL].count, source.attributes.normal.count);
  assert.deepEqual(gltf.materials[0].pbrMetallicRoughness.baseColorFactor, [...snapshot.material.color.toArray(), 1]);
  close(gltf.materials[0].pbrMetallicRoughness.roughnessFactor, 0.64); close(gltf.materials[0].pbrMetallicRoughness.metallicFactor, 0.07);
  const fullWorld = detachedWorldMatrix(snapshot.mesh); const expected = new THREE.Box3().copy(source.boundingBox || (source.computeBoundingBox(), source.boundingBox)).applyMatrix4(fullWorld).applyMatrix4(new THREE.Matrix4().makeScale(0.025, 0.025, 0.025));
  for (let axis = 0; axis < 3; axis++) { close(config.bounds.min[axis], expected.min.toArray()[axis]); close(config.bounds.max[axis], expected.max.toArray()[axis]); }
  assert.equal(snapshot.root.visible, false); assert.equal(snapshot.mesh.geometry, source); assert.equal(snapshot.mesh.material, snapshot.material);
  assert.deepEqual(snapshot.root.matrix.toArray(), matrixBefore); assert.deepEqual(source.attributes.normal.array, normalsBefore);
  assert.equal(snapshot.root.children.includes(stencil), true); assert.equal(snapshot.root.children.includes(support), true);
});

test('current-frame preview packages preserve full source mesh, pose and camera at empty, half and complete growth', async () => {
  const snapshot = fixture(), source = snapshot.mesh.geometry;
  const positions = source.attributes.position.array.slice(), normals = source.attributes.normal.array.slice();
  const pose = detachedWorldMatrix(snapshot.root).toArray(), camera = snapshot.camera.projectionMatrix.toArray();
  const settings = structuredClone(snapshot.settings);
  let reference;
  for (const previewProgress of [0, .5, 1]) {
    snapshot.root.visible = previewProgress > 0;
    const result = await createSceneRenderPackage(snapshot, { output: { width: 960, height: 720, fps: 1, frames: 1, growthFrames: 1, samples: 64, previewProgress } });
    const files = unzipSync(new Uint8Array(await result.blob.arrayBuffer()));
    const config = JSON.parse(strFromU8(files['config.json'])), gltf = glbJSON(files['scene.glb']);
    assert.equal(config.output.previewProgress, previewProgress);
    assert.equal(config.capabilities.triangles, 12);
    assert.equal(gltf.accessors[gltf.meshes[0].primitives[0].indices].count, 36);
    assert.equal(snapshot.root.visible, previewProgress > 0);
    assert.equal(snapshot.mesh.geometry, source); assert.equal(snapshot.mesh.material, snapshot.material);
    assert.deepEqual(source.attributes.position.array, positions); assert.deepEqual(source.attributes.normal.array, normals);
    assert.deepEqual(detachedWorldMatrix(snapshot.root).toArray(), pose);
    assert.deepEqual(snapshot.camera.projectionMatrix.toArray(), camera); assert.deepEqual(snapshot.settings, settings);
    const stable = { camera: config.camera, bounds: config.bounds, gltf };
    if (reference) assert.deepEqual(stable, reference); else reference = stable;
  }
});

test('ordinary PBR texture properties are retained on detached materials and unsupported features are explicit', () => {
  const snapshot = fixture(); const map = new THREE.Texture({ width: 8, height: 8 }); snapshot.material.map = map;
  const { scene } = cloneRenderGeometry(snapshot.root, 0.025); let material;
  scene.traverse(node => { if (node.isMesh) material = node.material; });
  assert.notEqual(material, snapshot.material); assert.equal(material.map, map); assert.equal(material.roughness, 0.64);
  snapshot.material.bumpMap = map; assert.throws(() => cloneRenderGeometry(snapshot.root, 0.025), /凹凸/); snapshot.material.bumpMap = null;
  const instance = new THREE.InstancedMesh(snapshot.mesh.geometry, snapshot.material, 1); instance.count = 30001; snapshot.root.add(instance);
  assert.throws(() => cloneRenderGeometry(snapshot.root, 0.025), /完整实例上限/);
});

test('disabled vertex colors cannot tint a uniform HQ display; shared geometry variants preserve the original color buffer', async () => {
  const snapshot=fixture(),geometry=snapshot.mesh.geometry;
  const colors=new Float32Array(geometry.attributes.position.count*3);for(let index=0;index<colors.length;index+=3)colors[index+1]=1;
  geometry.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));
  const coloredMaterial=snapshot.material.clone();coloredMaterial.vertexColors=true;
  const colored=new THREE.Mesh(geometry,coloredMaterial);colored.position.set(220,50,0);snapshot.normalized.add(colored);
  const source=geometry.attributes.color.array.slice();
  const result=await createSceneRenderPackage(snapshot,{output:{width:960,height:720,frames:1}});
  const files=unzipSync(new Uint8Array(await result.blob.arrayBuffer())),gltf=glbJSON(files['scene.glb']);
  const primitives=gltf.meshes.flatMap(mesh=>mesh.primitives);
  assert.equal(primitives.length,2);assert.equal(primitives.filter(primitive=>primitive.attributes.COLOR_0!==undefined).length,1);
  assert.equal(result.capabilities.triangles,24);assert.deepEqual(geometry.attributes.color.array,source);
  assert.equal(snapshot.mesh.geometry,geometry);assert.equal(colored.geometry,geometry);assert.equal(snapshot.material.vertexColors,false);assert.equal(coloredMaterial.vertexColors,true);
  snapshot.mesh.material=[snapshot.material,coloredMaterial];
  assert.throws(()=>cloneRenderGeometry(snapshot.root,.025),/混用了顶点色/);
});

test('colored mesh instances are exactly grouped into materials Blender preserves, with no _COLOR_0 loss', async () => {
  const snapshot = fixture(); snapshot.root.remove(snapshot.normalized);
  const material = new THREE.MeshStandardMaterial({ color: 'white' });
  const instances = new THREE.InstancedMesh(new THREE.BoxGeometry(2, 2, 2), material, 3);
  const colors = [new THREE.Color('#23599c'), new THREE.Color('#c89e59'), new THREE.Color('#23599c')];
  for (let index = 0; index < 3; index++) { instances.setColorAt(index, colors[index]); instances.setMatrixAt(index, new THREE.Matrix4().makeTranslation(index * 3, 1, 0)); }
  snapshot.root.add(instances);
  const matrixBefore = instances.instanceMatrix.array.slice(); const colorBefore = instances.instanceColor.array.slice();
  const result = await createSceneRenderPackage(snapshot, { output: { width: 960, height: 720, frames: 1 } });
  const files = unzipSync(new Uint8Array(await result.blob.arrayBuffer())); const gltf = glbJSON(files['scene.glb']);
  assert.equal(result.capabilities.instances, 3); assert.equal(result.capabilities.triangles, 36); assert.equal(gltf.meshes.length, 2);
  const exported = new Set(gltf.materials.map(item => item.pbrMetallicRoughness.baseColorFactor.slice(0, 3).map(value => Math.round(value * 1e7)).join(',')));
  assert.deepEqual(exported, new Set(colors.map((_, index) => new THREE.Color().fromBufferAttribute(instances.instanceColor, index).toArray().map(value => Math.round(value * 1e7)).join(','))));
  const nodes = gltf.nodes.filter(node => node.extensions?.EXT_mesh_gpu_instancing);
  assert.equal(nodes.length, 2); assert.equal(nodes.every(node => node.extensions.EXT_mesh_gpu_instancing.attributes._COLOR_0 === undefined), true);
  assert.deepEqual(instances.instanceMatrix.array, matrixBefore); assert.deepEqual(instances.instanceColor.array, colorBefore); assert.equal(instances.material, material);
});

test('morphs and current skeleton pose survive GLB instead of being dropped', async () => {
  const snapshot = fixture(); snapshot.root.remove(snapshot.normalized);
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  geometry.morphAttributes.position = [geometry.attributes.position.clone()];
  geometry.morphAttributes.position[0].array[0] += 0.1;
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(geometry.attributes.position.count * 4), 4));
  const weights = new Float32Array(geometry.attributes.position.count * 4); for (let i = 0; i < weights.length; i += 4) weights[i] = 1;
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weights, 4));
  const mesh = new THREE.SkinnedMesh(geometry, snapshot.material); const bone = new THREE.Bone(); mesh.add(bone); snapshot.root.add(mesh);
  mesh.bind(new THREE.Skeleton([bone])); bone.rotation.z = 0.2; mesh.morphTargetInfluences[0] = 0.6;
  const result = await createSceneRenderPackage(snapshot, { output: { width: 960, height: 720, frames: 1 } });
  const files = unzipSync(new Uint8Array(await result.blob.arrayBuffer())); const gltf = glbJSON(files['scene.glb']);
  assert.equal(result.capabilities.skins, 1); assert.equal(result.capabilities.morphTargets, 1);
  assert.equal(gltf.skins.length, 1); assert.equal(gltf.meshes[0].primitives[0].targets.length, 1); assert.deepEqual(gltf.meshes[0].weights, [0.6]);
  assert.equal(mesh.skeleton.bones[0], bone); close(bone.rotation.z, 0.2); assert.equal(mesh.morphTargetInfluences[0], 0.6);
});

test('path-only model, visible line supports, missing photo and camera animation fail explicitly', async () => {
  const snapshot = fixture();
  await assert.rejects(createSceneRenderPackage({ ...snapshot, mode: 'gcode' }), /打印路径/);
  await assert.rejects(createSceneRenderPackage(snapshot, { cameraMode: 'orbit' }), /固定镜头/);
  await assert.rejects(createSceneRenderPackage({ ...snapshot, backgroundType: 'video' }), /静态照片/);
  await assert.rejects(createSceneRenderPackage({ ...snapshot, backgroundType: 'image', backgroundSize: { width: 400, height: 300 } }), /背景照片未提供/);
  snapshot.root.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(1, 1, 1)]), new THREE.LineBasicMaterial()));
  assert.throws(() => cloneRenderGeometry(snapshot.root, 0.025), /路径线段/);
});

test('transparent HQ sequence omits photo pixels while preserving calibrated camera, illumination and full model',async()=>{
  const snapshot=fixture();snapshot.backgroundType='image';snapshot.backgroundSize={width:400,height:300};snapshot.settings={...snapshot.settings,transparent:true,dofEnabled:true};
  let encodes=0;
  const result=await createSceneRenderPackage(snapshot,{output:{width:320,height:240,frames:2}},{photoEncoder:()=>{encodes++;throw new Error('photo must not be composited');}});
  const files=unzipSync(new Uint8Array(await result.blob.arrayBuffer())),config=JSON.parse(strFromU8(files['config.json']));
  assert.equal(encodes,0);assert.equal(files['photo.png'],undefined);assert.equal(config.background.transparent,true);assert.equal(config.background.type,'color');
  assert.equal(config.camera.projectionMatrix.length,16);assert.equal(config.dof.backgroundAlreadyPhotographic,true);assert.equal(result.capabilities.triangles,12);
});

test('public studio package method reproduces final crop camera without changing renderer or cache', async () => {
  const snapshot = fixture();
  const studio = Object.create(GrowthStudio.prototype);
  Object.assign(studio, { options: { ...snapshot.settings, crop: { sourceAspect: 4 / 3, x: 0.2, y: 0.1, width: 0.5, height: 0.5 } }, _metadata: { ...snapshot.metadata, mode: 'mesh', sourceUnitsToMm: 1 }, modelGroup: snapshot.root, normalized: snapshot.normalized, camera: snapshot.camera, _fullSourceFov: 48, floor: new THREE.Mesh(new THREE.PlaneGeometry(40, 40)), _backgroundSize: null });
  const pose = studio.camera.position.toArray(); const projection = studio.camera.projectionMatrix.toArray(); const opts = JSON.stringify(studio.options);
  const result = await studio.createRenderPackage({ output: { width: 960, height: 720, frames: 1 } });
  const camera = studio.camera.clone(); camera.fov = 48; camera.setViewOffset(4 / 3, 1, 0.2 * 4 / 3, 0.1, 0.5 * 4 / 3, 0.5);
  for (const index of [0, 5, 8, 9]) close(result.metadata.camera.projectionMatrix[index], camera.projectionMatrix.elements[index]);
  assert.deepEqual(studio.camera.position.toArray(), pose); assert.deepEqual(studio.camera.projectionMatrix.toArray(), projection); assert.equal(JSON.stringify(studio.options), opts);
});

test('HQ shares physical aperture/sensor crop without borrowing H2C identity for custom photos or changing calibrated projection', async () => {
  const snapshot = fixture(); const fullP5 = snapshot.camera.projectionMatrix.elements[5];
  snapshot.photoIdentity = 'preset:h2c'; snapshot.backgroundType = 'image'; snapshot.backgroundSize = { width: 4000, height: 3000 };
  snapshot.settings = { ...snapshot.settings, transparent: true, dofEnabled: true, dofStrength: 10, dofFocus: 40, crop: { x: .2, y: .1, width: .5, height: .5 } };
  snapshot.camera.setViewOffset(4 / 3, 1, .2 * 4 / 3, .1, .5 * 4 / 3, .5);
  const projection = snapshot.camera.projectionMatrix.toArray();
  const known = await createSceneRenderPackage(snapshot, { output: { width: 960, height: 720, frames: 1 } });
  assert.equal(known.metadata.camera.effectiveSensorHeightMm, 12);
  close(known.metadata.camera.physicalFocalLengthMm, fullP5 * 12);
  for (const index of [0, 5, 8, 9]) close(known.metadata.camera.projectionMatrix[index], projection[index]);
  assert.equal(known.metadata.dof.fStop, 2.8); assert.equal(known.metadata.dof.apertureSource, 'photo-exif-reference'); assert.equal(known.metadata.dof.focusMeasured, false);
  assert.equal(known.metadata.background.type, 'color'); assert.equal(known.metadata.optics.sourceRegionHeightFraction, .5);
  const custom = await createSceneRenderPackage({ ...snapshot, photoIdentity: 'custom:h2c-named.jpg' }, { output: { width: 960, height: 720, frames: 1 } });
  assert.equal(custom.metadata.dof.fStop, 15); assert.equal(custom.metadata.optics.reference, null);
  close(custom.metadata.dof.focusDistanceM, known.metadata.dof.focusDistanceM);
  assert.deepEqual(snapshot.camera.projectionMatrix.toArray(), projection);
});

test('generated PNG scene packages retain the canonical photo, matching visual aperture and protected background pixels',async()=>{
  for(const [key,fNumber] of [['pastel-rug',8],['blue-grey',8],['teal-room',5.6]]) {
    const snapshot=fixture();snapshot.photoIdentity='preset:'+key;snapshot.backgroundType='image';
    snapshot.backgroundSize={width:2048,height:1536};
    snapshot.settings={...snapshot.settings,...getPresetLighting(key),...getPresetDof(key),transparent:false,
      crop:{x:.1,y:.2,width:.5,height:.5}};
    snapshot.camera.setViewOffset(4/3,1,.1*4/3,.2,.5*4/3,.5);
    const projection=snapshot.camera.projectionMatrix.toArray(),pose=detachedWorldMatrix(snapshot.root).toArray();
    const backgroundFile=new File(['exact source PNG'],key+'.png',{type:'image/png'});
    const pngBytes=new Uint8Array([137,80,78,71,13,10,26,10]);
    let encodes=0;
    const photoEncoder=async(file,output,uv)=>{
      encodes++;assert.equal(file,backgroundFile);assert.equal(file.type,'image/png');
      assert.deepEqual({width:output.width,height:output.height},{width:320,height:240});
      assert.deepEqual(uv.rectangle,renderBackgroundUV({width:320,height:240,sourceWidth:2048,sourceHeight:1536,crop:snapshot.settings.crop}).rectangle);
      return{bytes:pngBytes,sourceWidth:2048,sourceHeight:1536};
    };
    const result=await createSceneRenderPackage(snapshot,{output:{width:320,height:240,frames:1},backgroundFile},{photoEncoder});
    const files=unzipSync(new Uint8Array(await result.blob.arrayBuffer())),config=JSON.parse(strFromU8(files['config.json']));
    assert.equal(encodes,1);assert.deepEqual(files['photo.png'],pngBytes);assert.ok(files['scene.glb']);
    assert.equal(config.background.file,'photo.png');assert.equal(config.background.canonical,true);
    assert.equal(config.background.type,'photo');assert.equal(config.background.transparent,false);
    assert.equal(config.optics.photoIdentity,'preset:'+key);assert.equal(config.optics.estimate.sourcePhoto,`assets/backgrounds/${key}.png`);
    assert.equal(config.dof.fStop,fNumber);assert.equal(config.dof.apertureSource,'visual-estimate');assert.equal(config.optics.reference,null);
    assert.equal(config.dof.backgroundAlreadyPhotographic,true);assert.equal(config.optics.photoPixelsProtected,true);
    assert.equal(config.dof.focusMeasured,false);assert.equal(config.capabilities.triangles,12);
    for(const index of [0,5,8,9])close(config.camera.projectionMatrix[index],projection[index]);
    const custom=await createSceneRenderPackage({...snapshot,photoIdentity:'custom:'+key+'.png'},
      {output:{width:320,height:240,frames:1},backgroundFile},{photoEncoder});
    assert.equal(custom.metadata.optics.estimate,undefined,'same-name uploads cannot borrow the preset aperture');
    assert.notEqual(custom.metadata.dof.fStop,fNumber);close(custom.metadata.dof.focusDistanceM,config.dof.focusDistanceM);
    assert.deepEqual(snapshot.camera.projectionMatrix.toArray(),projection);assert.deepEqual(detachedWorldMatrix(snapshot.root).toArray(),pose);
    snapshot.mesh.geometry.dispose();snapshot.material.dispose();
  }
});

test('user painted 3MF retains every face, material group, palette and normal in physical export', { skip: !process.env.GROWTH_TEST_3MF }, async () => {
  const data = await loadPaintedThreeMF(fs.readFileSync(process.env.GROWTH_TEST_3MF));
  const root = data.root; root.rotation.x = -Math.PI / 2; root.updateMatrixWorld(true);
  const sourceMeshes = []; root.traverse(node => { if (node.isMesh) sourceMeshes.push(node); });
  const expectedFaces = sourceMeshes.reduce((sum, node) => sum + (node.geometry.index?.count ?? node.geometry.attributes.position.count) / 3, 0);
  const expectedMaterials = new Set(sourceMeshes.flatMap(node => (Array.isArray(node.material) ? node.material : [node.material]).filter((_, i) => node.geometry.groups.some(group => group.materialIndex === i)).map(material => material.color.getHexString())));
  const camera = new THREE.PerspectiveCamera(40, 4 / 3, 1, 10000); camera.position.set(300, 300, 300); camera.lookAt(0, 100, 0);
  const result = await createSceneRenderPackage({ root, camera, mode: 'mesh', units: { normalizedScale: 1, sourceUnitsToMm: 1 }, metadata: { ...data.metadata, format: '3mf' }, floor: { width: 350, depth: 350 }, settings: {} }, { output: { width: 960, height: 720, frames: 1 } });
  const files = unzipSync(new Uint8Array(await result.blob.arrayBuffer())); const gltf = glbJSON(files['scene.glb']);
  const faces = gltf.meshes.reduce((sum, mesh) => sum + mesh.primitives.reduce((subsum, primitive) => subsum + gltf.accessors[primitive.indices ?? primitive.attributes.POSITION].count / 3, 0), 0);
  assert.equal(expectedFaces, 1541408); assert.equal(faces, expectedFaces); assert.equal(result.capabilities.triangles, expectedFaces); assert.equal(result.capabilities.meshes, 14);
  const exportedPalette = new Set(gltf.meshes.flatMap(mesh => mesh.primitives.map(primitive => { const rgb = gltf.materials[primitive.material].pbrMetallicRoughness.baseColorFactor; return new THREE.Color().setRGB(rgb[0], rgb[1], rgb[2], THREE.LinearSRGBColorSpace).getHexString(); })));
  assert.deepEqual(exportedPalette, expectedMaterials);
  assert.equal(gltf.meshes.every(mesh => mesh.primitives.every(primitive => primitive.attributes.NORMAL !== undefined)), true);
});
