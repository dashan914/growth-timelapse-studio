import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { GrowthStudio } from '../src/studio.js';
import { createPrintPathGeometry, createPrintPathMaterial, createPrintPathDepthMaterial, setPrintPathInteraction } from '../src/print-path-material.js';

const WIDTH = 8, HEIGHT = 8;
const analysisOptions = { supports: true, pose: { modelOffsetX: .3, modelOffsetY: .1, modelScale: 1.2 }, crop: { x: .1, y: .1, width: .7, height: .8, sourceAspect: 4/3 }, frame: 'output' };

function fixture({ failure = null } = {}) {
  const lines = new LineSegmentsGeometry().setPositions(new Float32Array([0,0,.08,10,0,.08, 0,1,.08,10,1,.08]));
  lines.setAttribute('instancePrintWidth', new THREE.InstancedBufferAttribute(new Float32Array([.42,.42]), 1));
  const geometry = createPrintPathGeometry(lines, { heights: new Float32Array([.16,.16]), features: new Uint8Array([1,10]) });
  geometry.instanceCount = 0;
  const material = createPrintPathMaterial();
  setPrintPathInteraction(material, true);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.userData.printPathImpostor = true;
  mesh.customDepthMaterial = createPrintPathDepthMaterial();
  const studio = Object.create(GrowthStudio.prototype);
  studio._metadata = { mode: 'gcode' }; studio.options = { progress: 0, modelScale: .8 };
  studio._meshes = [mesh]; studio._stencils = [];
  studio.modelGroup = new THREE.Group(); studio.modelGroup.add(mesh); studio.modelGroup.visible = false;
  studio.modelGroup.position.set(.2,.3,.4); studio.modelGroup.scale.setScalar(.8); studio.modelGroup.rotation.y = .3;
  studio.scene = new THREE.Scene(); studio.scene.add(studio.modelGroup);
  studio.scene.background = new THREE.Color('#334455');
  studio.scene.overrideMaterial = new THREE.MeshBasicMaterial();
  studio.camera = new THREE.PerspectiveCamera(47, 4/3, .1, 100);
  studio.camera.setViewOffset(4/3, 1, .05, .1, .8, .7);
  studio._baseBounds = new THREE.Box3(new THREE.Vector3(0,0,0), new THREE.Vector3(10,1,1));
  studio._turnRadians = .2;
  const support = new THREE.Group(); support.visible = false; studio._supportMeshes = new Set([support]);
  const objects = ['floor','grid','cap','transformHelper','shadowHelper'].map(key => studio[key] = new THREE.Group());
  const top = new THREE.Group(); studio._partCaps = [top];
  studio._printLayers = { root: new THREE.Group() };
  const state = { target: { oldTarget: true }, clear: new THREE.Color('#112233'), alpha: .6,
    viewport: new THREE.Vector4(2,3,20,21), scissor: new THREE.Vector4(4,5,17,18), scissorTest: true };
  const draws = [];
  studio.renderer = {
    autoClear: false, shadowMap: { enabled: true },
    getRenderTarget: () => state.target, setRenderTarget: value => state.target = value,
    getClearColor: target => target.copy(state.clear), getClearAlpha: () => state.alpha,
    setClearColor: (value, alpha) => { state.clear.set(value); state.alpha = alpha; },
    getViewport: target => target.copy(state.viewport), setViewport: value => state.viewport.copy(value),
    getScissor: target => target.copy(state.scissor), setScissor: value => state.scissor.copy(value),
    getScissorTest: () => state.scissorTest, setScissorTest: value => state.scissorTest = value,
    render() {
      const uniforms = mesh.material.userData.printPathImpostor.uniforms;
      draws.push({ count: mesh.geometry.instanceCount, interaction: uniforms.pathInteraction.value,
        supports: uniforms.pathHideSupport.value, analysis: mesh.material.userData.printPathImpostor.analysis });
      assert.equal(studio.scene.overrideMaterial, null);
      if (failure === 'render') throw new Error('controlled renderer failure');
    },
    readRenderTargetPixels(target, x, y, width, height, rgba) {
      if (failure === 'readback') throw new Error('controlled readback failure');
      rgba.fill(255);
    },
  };
  const before = {
    material, count: geometry.instanceCount, source: Array.from(geometry.attributes.instanceStart.data.array),
    visible: studio.modelGroup.visible, pose: studio.modelGroup.position.toArray(), quaternion: studio.modelGroup.quaternion.toArray(), scale: studio.modelGroup.scale.toArray(),
    camera: { aspect: studio.camera.aspect, fov: studio.camera.fov, view: { ...studio.camera.view }, projection: studio.camera.projectionMatrix.toArray() },
    background: studio.scene.background, override: studio.scene.overrideMaterial, target: state.target,
    clear: state.clear.toArray(), alpha: state.alpha, viewport: state.viewport.toArray(), scissor: state.scissor.toArray(), scissorTest: state.scissorTest,
  };
  function assertRestored() {
    assert.equal(mesh.material, before.material); assert.equal(geometry.instanceCount, before.count);
    assert.deepEqual(Array.from(geometry.attributes.instanceStart.data.array), before.source);
    assert.equal(studio.modelGroup.visible, before.visible);
    assert.deepEqual(studio.modelGroup.position.toArray(), before.pose); assert.deepEqual(studio.modelGroup.quaternion.toArray(), before.quaternion); assert.deepEqual(studio.modelGroup.scale.toArray(), before.scale);
    assert.equal(studio.camera.aspect, before.camera.aspect); assert.equal(studio.camera.fov, before.camera.fov);
    assert.deepEqual(studio.camera.view, before.camera.view); assert.deepEqual(studio.camera.projectionMatrix.toArray(), before.camera.projection);
    assert.equal(studio.scene.background, before.background); assert.equal(studio.scene.overrideMaterial, before.override);
    assert.equal(studio.renderer.autoClear, false); assert.equal(studio.renderer.shadowMap.enabled, true);
    assert.equal(state.target, before.target); assert.deepEqual(state.clear.toArray(), before.clear); assert.equal(state.alpha, before.alpha);
    assert.deepEqual(state.viewport.toArray(), before.viewport); assert.deepEqual(state.scissor.toArray(), before.scissor); assert.equal(state.scissorTest, before.scissorTest);
    assert.equal(support.visible, false); for (const item of [...objects, top, studio._printLayers.root]) assert.equal(item.visible, true);
    assert.equal(material.userData.printPathImpostor.uniforms.pathInteraction.value, 1, 'analysis does not overwrite the active preview material');
  }
  function dispose() {
    for (const target of studio._analysisTargets?.values() || []) target.dispose();
    for (const item of Object.values(studio._analysisMaterials || {})) item.dispose();
    geometry.dispose(); material.dispose(); mesh.customDepthMaterial.dispose(); before.override.dispose();
  }
  return { studio, mesh, draws, assertRestored, dispose };
}

for (const method of ['renderSilhouette', 'renderHeightMap']) {
  test(`${method} restores the scene when analysis RGBA allocation fails before rendering`, () => {
    const f = fixture(), originalUint8Array = globalThis.Uint8Array;
    try {
      globalThis.Uint8Array = new Proxy(originalUint8Array, { construct(target, args, newTarget) {
        if (args[0] === WIDTH * HEIGHT * 4) throw new RangeError('controlled analysis RGBA allocation failure');
        return Reflect.construct(target, args, newTarget);
      } });
      assert.throws(() => f.studio[method](WIDTH, HEIGHT, analysisOptions), /controlled analysis RGBA allocation failure/);
    } finally { globalThis.Uint8Array = originalUint8Array; }
    try { f.assertRestored(); assert.equal(f.draws.length, 0); }
    finally { f.dispose(); }
  });

  for (const failure of ['render','readback']) test(`${method} restores material, full-count override, optics and target after ${failure} failure`, () => {
    const f = fixture({ failure });
    try {
      assert.throws(() => f.studio[method](WIDTH, HEIGHT, analysisOptions), new RegExp(`controlled ${failure === 'render' ? 'renderer' : failure} failure`));
      f.assertRestored(); assert.equal(f.draws[0].count, 2); assert.equal(f.draws[0].interaction, 0);
      assert.equal(f.draws[0].supports, 0);
    } finally { f.dispose(); }
  });

  test(`${method} analyzes complete paths through its dedicated material and restores the existing partial preview`, () => {
    const f = fixture();
    try {
      const result = f.studio[method](WIDTH, HEIGHT, analysisOptions);
      assert.equal(result.mask.length, WIDTH * HEIGHT); assert.ok(result.mask.every(value => value === 255));
      assert.equal(result.data instanceof (method === 'renderHeightMap' ? Uint16Array : Uint8Array), true);
      assert.equal(f.draws[0].count, 2); assert.equal(f.draws[0].interaction, 0); assert.equal(f.draws[0].supports, 0);
      f.assertRestored();
    } finally { f.dispose(); }
  });
}
