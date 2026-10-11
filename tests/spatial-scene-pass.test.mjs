import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { SpatialSceneRenderPass } from '../src/spatial-scene-pass.js';
import { fixedPixelJitterPattern, pixelJitterProjection } from '../src/spatial-sampling.js';

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} differs from ${expected}`);
const samplePixels = [[1, 0, 0, 1], [0, 0, .5, .5], [0, .25, 0, .25], [.125, .125, .125, .125]];

function fixture(t, { samples = 4, preserveDepth = true, autoClear = true, shadowAutoUpdate = true } = {}) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, 4 / 3, .1, 500);
  camera.position.set(3, 5, 7); camera.lookAt(0, 2, 0); camera.updateMatrixWorld(true);
  camera.setViewOffset(4 / 3, 1, .13, .21, .8, .67);
  const originalOverride = new THREE.MeshBasicMaterial(), passOverride = new THREE.MeshDepthMaterial();
  scene.overrideMaterial = originalOverride;
  const pass = new SpatialSceneRenderPass(scene, camera, { samples });
  pass.preserveDepth = preserveDepth;
  pass.overrideMaterial = passOverride; pass.clearColor = new THREE.Color('#769ac3'); pass.clearAlpha = .37;
  const read = new THREE.WebGLRenderTarget(960, 720, { type: THREE.HalfFloatType, depthBuffer: true, stencilBuffer: true, samples: 4 });
  const write = new THREE.WebGLRenderTarget(960, 720);
  const savedTarget = new THREE.WebGLRenderTarget(64, 48);
  const values = new WeakMap(), log = [];
  let target = savedTarget, color = new THREE.Color('#ab4e71'), alpha = .63;
  let sampleDraw = 0, quadDraw = 0, frame = 0, failure = null, failPhase = null, disposed = false;
  let pixels = samplePixels;
  const value = buffer => {
    if (!values.has(buffer)) values.set(buffer, { rgba: [0, 0, 0, 0], depth: null });
    return values.get(buffer);
  };
  const initial = { projection: camera.projectionMatrix.toArray(), inverse: camera.projectionMatrixInverse.toArray(),
    view: { ...camera.view }, viewIdentity: camera.view, position: camera.position.toArray(), quaternion: camera.quaternion.toArray(),
    clearColor: color.toArray(), clearAlpha: alpha, autoClear, shadowAutoUpdate };
  const renderer = {
    autoClear, autoClearColor: true, autoClearDepth: true, autoClearStencil: true,
    shadowMap: { autoUpdate: shadowAutoUpdate, enabled: true },
    getRenderTarget: () => target,
    setRenderTarget(buffer) { target = buffer; log.push({ kind: 'target', target }); },
    getClearColor: result => result.copy(color), getClearAlpha: () => alpha,
    setClearColor(next, nextAlpha) { color.set(next); if (nextAlpha !== undefined) alpha = nextAlpha; },
    setClearAlpha(next) { alpha = next; },
    clear(clearColor = true, clearDepth = true, clearStencil = true) {
      log.push({ kind: 'clear', target, color: clearColor, depth: clearDepth, stencil: clearStencil });
      const output = value(target);
      if (clearColor) output.rgba = [...color.toArray().map(channel => channel * alpha), alpha];
      if (clearDepth) output.depth = null;
    },
    clearDepth() { log.push({ kind: 'clear-depth', target }); value(target).depth = null; },
    render(object, drawCamera) {
      assert.equal(this.autoClear, false, 'every scene and fullscreen draw is explicitly cleared');
      if (object === scene) {
        assert.equal(drawCamera, camera);
        const centered = target === read, phase = centered ? 'center' : `sample-${++sampleDraw}`;
        const inverseProduct = camera.projectionMatrix.clone().multiply(camera.projectionMatrixInverse).elements;
        for (let at = 0; at < 16; at++) close(inverseProduct[at], at % 5 === 0 ? 1 : 0);
        log.push({ kind: 'scene', phase, target, projection: camera.projectionMatrix.toArray(),
          inverse: camera.projectionMatrixInverse.toArray(), view: { ...camera.view }, override: scene.overrideMaterial,
          color: color.toArray(), alpha, shadowAutoUpdate: this.shadowMap.autoUpdate });
        if (phase === failPhase) throw failure;
        value(target).rgba = centered ? [.9, .1, .4, 1] : [...pixels[(sampleDraw - 1) % pixels.length]];
        value(target).depth = `${phase}-depth-${frame}`;
        return;
      }
      assert.ok(object.isMesh && object.material.isShaderMaterial && drawCamera.isOrthographicCamera,
        'the other renderer entry point is the actual Three FullScreenQuad');
      const material = object.material, texture = material.uniforms.image.value, weight = material.uniforms.weight.value;
      const accumulating = texture === pass._sampleTarget?.texture;
      const phase = accumulating ? `accumulate-${++quadDraw}` : 'copy';
      const inputTarget = accumulating ? pass._sampleTarget : pass._sumTarget;
      assert.equal(texture, inputTarget?.texture);
      assert.equal(material.depthTest, false); assert.equal(material.depthWrite, false);
      assert.equal(material.toneMapped, false);
      log.push({ kind: 'quad', phase, target, inputTarget, weight, blending: material.blending });
      if (phase === failPhase) throw failure;
      const weighted = value(inputTarget).rgba.map(channel => channel * weight);
      if (material.blending === THREE.CustomBlending) {
        assert.equal(material.blendEquation, THREE.AddEquation);
        assert.equal(material.blendEquationAlpha, THREE.AddEquation);
        assert.equal(material.blendSrc, THREE.OneFactor); assert.equal(material.blendDst, THREE.OneFactor);
        assert.equal(material.blendSrcAlpha, THREE.OneFactor); assert.equal(material.blendDstAlpha, THREE.OneFactor);
        value(target).rgba = value(target).rgba.map((channel, at) => channel + weighted[at]);
      } else {
        assert.equal(material.blending, THREE.NoBlending); value(target).rgba = weighted;
      }
    },
  };
  const dispose = ({ passAlreadyDisposed = false } = {}) => {
    if (disposed) return; disposed = true;
    if (!passAlreadyDisposed) pass.dispose();
    read.dispose(); write.dispose(); savedTarget.dispose(); originalOverride.dispose(); passOverride.dispose();
  };
  t.after(dispose);
  return { scene, camera, pass, renderer, read, write, savedTarget, initial, log, value, dispose,
    run() { sampleDraw = quadDraw = 0; frame++; pass.render(renderer, write, read); },
    failAt(phase) { failPhase = phase; failure = new Error(`draw failed at ${phase}`); return failure; },
    setPixels(next) { pixels = next; },
    assertRestored() {
      assert.deepEqual(camera.projectionMatrix.toArray(), initial.projection);
      assert.deepEqual(camera.projectionMatrixInverse.toArray(), initial.inverse);
      assert.deepEqual(camera.view, initial.view); assert.equal(camera.view, initial.viewIdentity);
      assert.deepEqual(camera.position.toArray(), initial.position); assert.deepEqual(camera.quaternion.toArray(), initial.quaternion);
      assert.equal(scene.overrideMaterial, originalOverride); assert.equal(renderer.getRenderTarget(), savedTarget);
      assert.equal(renderer.autoClear, initial.autoClear); assert.equal(renderer.shadowMap.autoUpdate, initial.shadowAutoUpdate);
      assert.equal(renderer.shadowMap.enabled, true);
      assert.deepEqual(renderer.getClearColor(new THREE.Color()).toArray(), initial.clearColor);
      assert.equal(renderer.getClearAlpha(), initial.clearAlpha);
      assert.equal(renderer.autoClearColor, true); assert.equal(renderer.autoClearDepth, true); assert.equal(renderer.autoClearStencil, true);
    },
  };
}

test('current-frame color integrates four fixed subpixel samples while retaining centered depth and normalized crop optics', t => {
  const f = fixture(t); f.run(); f.assertRestored();
  assert.equal(f.pass.needsSwap, false);
  const scenes = f.log.filter(item => item.kind === 'scene'), quads = f.log.filter(item => item.kind === 'quad');
  assert.equal(scenes.length, 5); assert.equal(quads.length, 5);
  assert.equal(scenes[0].phase, 'center'); assert.equal(scenes[0].target, f.read);
  assert.deepEqual(scenes[0].projection, f.initial.projection); assert.equal(scenes[0].shadowAutoUpdate, true);
  const pattern = fixedPixelJitterPattern(4);
  for (let index = 0; index < pattern.length; index++) {
    assert.deepEqual(scenes[index + 1].projection, [...pixelJitterProjection(f.initial.projection, 960, 720, pattern[index])]);
    assert.deepEqual(scenes[index + 1].view, f.initial.view);
    assert.equal(scenes[index + 1].target, f.pass._sampleTarget); assert.equal(scenes[index + 1].shadowAutoUpdate, false);
    assert.equal(quads[index].target, f.pass._sumTarget); assert.equal(quads[index].inputTarget, f.pass._sampleTarget);
    close(quads[index].weight, .25); assert.equal(quads[index].blending, THREE.CustomBlending);
  }
  for (const draw of scenes) {
    assert.equal(draw.override, f.pass.overrideMaterial);
    assert.deepEqual(draw.color, f.pass.clearColor.toArray()); assert.equal(draw.alpha, .37);
  }
  assert.deepEqual(f.value(f.read).rgba, [.28125, .09375, .15625, .46875]);
  assert.equal(f.value(f.read).depth, 'center-depth-1');
  assert.equal(quads.at(-1).target, f.read); assert.equal(quads.at(-1).weight, 1);
  assert.equal(quads.at(-1).blending, THREE.NoBlending);
  assert.equal(f.log.filter(item => item.kind === 'clear' && item.target === f.read).length, 1,
    'the color-only final copy never clears the centered scene depth');
  assert.equal(f.log.some(item => item.target === f.write), false);
  assert.equal(f.pass._sampleTarget.texture.type, THREE.HalfFloatType);
  assert.equal(f.pass._sumTarget.texture.type, THREE.HalfFloatType);
  assert.equal(f.pass._sumTarget.depthBuffer, false); assert.equal(f.pass._sumTarget.stencilBuffer, false);
  assert.equal(f.pass._sumTarget.texture.colorSpace, THREE.NoColorSpace);
});

test('later growth frames repeat sample positions and start with empty color accumulation rather than previous-frame history', t => {
  const f = fixture(t); f.run(); const first = f.log.filter(item => item.kind === 'scene').map(item => item.projection);
  f.log.length = 0; f.setPixels(Array.from({ length: 4 }, () => [.2, .3, .4, .5])); f.run();
  assert.deepEqual(f.log.filter(item => item.kind === 'scene').map(item => item.projection), first);
  f.value(f.read).rgba.forEach((channel, index) => close(channel, [.2, .3, .4, .5][index]));
  assert.equal(f.value(f.read).depth, 'center-depth-2'); f.assertRestored();
});

test('unblurred preview retains all four color samples and equal weights while skipping central depth and refreshing shadows only once', t => {
  for (const shadowAutoUpdate of [true, false]) {
    const f = fixture(t, { preserveDepth: false, shadowAutoUpdate });
    f.value(f.read).depth = 'unused-prior-depth';
    f.run(); f.assertRestored();
    const scenes = f.log.filter(item => item.kind === 'scene'), quads = f.log.filter(item => item.kind === 'quad');
    assert.equal(scenes.length, 4); assert.equal(quads.length, 5);
    assert.equal(scenes.some(item => item.phase === 'center'), false);
    const pattern = fixedPixelJitterPattern(4);
    for (let index = 0; index < 4; index++) {
      assert.equal(scenes[index].phase, `sample-${index + 1}`);
      assert.equal(scenes[index].target, f.pass._sampleTarget);
      assert.deepEqual(scenes[index].projection, [...pixelJitterProjection(f.initial.projection, 960, 720, pattern[index])]);
      assert.equal(scenes[index].shadowAutoUpdate, index === 0 ? shadowAutoUpdate : false);
      close(quads[index].weight, .25); assert.equal(quads[index].blending, THREE.CustomBlending);
    }
    assert.equal(scenes.filter(item => item.shadowAutoUpdate).length, shadowAutoUpdate ? 1 : 0);
    assert.deepEqual(f.value(f.read).rgba, [.28125, .09375, .15625, .46875]);
    assert.equal(f.value(f.read).depth, 'unused-prior-depth');
    assert.equal(f.log.some(item => item.kind === 'clear' && item.target === f.read), false);
    f.dispose();
  }
});

for (const phase of ['center', 'sample-1', 'sample-2', 'sample-3', 'sample-4', 'accumulate-1', 'accumulate-2', 'accumulate-3', 'accumulate-4', 'copy']) {
  test(`camera, clear color/alpha, override, shadow updates and render target restore after ${phase} draw fails`, t => {
    for (const autoClear of [true, false]) for (const shadowAutoUpdate of [true, false]) {
      const f = fixture(t, { autoClear, shadowAutoUpdate }), failure = f.failAt(phase);
      assert.throws(() => f.run(), error => error === failure); f.assertRestored(); f.dispose();
    }
  });
}

test('unblurred sample and fullscreen failures restore all state without a central draw', t => {
  for (const phase of ['sample-1', 'sample-3', 'sample-4', 'accumulate-1', 'accumulate-4', 'copy']) {
    for (const autoClear of [true, false]) for (const shadowAutoUpdate of [true, false]) {
      const f = fixture(t, { preserveDepth: false, autoClear, shadowAutoUpdate }), failure = f.failAt(phase);
      assert.throws(() => f.run(), error => error === failure); f.assertRestored();
      assert.equal(f.log.some(item => item.kind === 'scene' && item.phase === 'center'), false);
      f.dispose();
    }
  }
});

test('single-sample export draws only the unchanged center without allocating spatial targets or changing caller state', t => {
  const f = fixture(t, { samples: 1, preserveDepth: false, autoClear: false, shadowAutoUpdate: false });
  f.run(); f.assertRestored();
  assert.equal(f.pass._sampleTarget, null); assert.equal(f.pass._sumTarget, null);
  assert.equal(f.log.filter(item => item.kind === 'scene').length, 1);
  assert.equal(f.log.filter(item => item.kind === 'quad').length, 0);
  assert.deepEqual(f.value(f.read).rgba, [.9, .1, .4, 1]); assert.equal(f.value(f.read).depth, 'center-depth-1');
  const failure = f.failAt('center'); assert.throws(() => f.run(), error => error === failure); f.assertRestored();
  assert.equal(f.pass._sampleTarget, null); assert.equal(f.pass._sumTarget, null);
});

test('target reuse, resize, MSAA changes and dispose release only owned sampling resources', t => {
  const f = fixture(t); f.run();
  const sample = f.pass._sampleTarget, sum = f.pass._sumTarget;
  let sampleDisposes = 0, sumDisposes = 0, copyDisposes = 0, quadDisposes = 0;
  sample.addEventListener('dispose', () => sampleDisposes++); sum.addEventListener('dispose', () => sumDisposes++);
  f.pass._copy.addEventListener('dispose', () => copyDisposes++);
  const geometry = f.pass._quad._mesh.geometry, geometryDisposed = () => quadDisposes++;
  geometry.addEventListener('dispose', geometryDisposed);
  t.after(() => geometry.removeEventListener('dispose', geometryDisposed));
  f.run(); assert.equal(f.pass._sampleTarget, sample); assert.equal(f.pass._sumTarget, sum);
  assert.equal(sampleDisposes, 0); assert.equal(sumDisposes, 0);
  f.read.setSize(1200, 800); f.run();
  assert.equal(f.pass._sampleTarget, sample); assert.equal(f.pass._sumTarget, sum);
  assert.equal(sample.width, 1200); assert.equal(sample.height, 800);
  assert.equal(sum.width, 1200); assert.equal(sum.height, 800);
  assert.equal(sampleDisposes, 1); assert.equal(sumDisposes, 1);
  f.pass.samples = 1; f.log.length = 0; f.run();
  assert.equal(f.pass._sampleTarget, sample); assert.equal(f.pass._sumTarget, sum);
  assert.equal(sampleDisposes, 1); assert.equal(sumDisposes, 1);
  assert.equal(f.log.some(item => item.target === sample || item.target === sum), false);
  f.pass.samples = 4; f.read.samples = 0; f.run();
  const nextSample = f.pass._sampleTarget;
  assert.notEqual(nextSample, sample); assert.equal(sampleDisposes, 2);
  assert.equal(nextSample.samples, 0); assert.equal(f.pass._sumTarget, sum);
  let nextSampleDisposes = 0; nextSample.addEventListener('dispose', () => nextSampleDisposes++);
  let readDisposes = 0; f.read.addEventListener('dispose', () => readDisposes++);
  f.pass.dispose();
  assert.equal(nextSampleDisposes, 1); assert.equal(sumDisposes, 2);
  assert.equal(copyDisposes, 1); assert.equal(quadDisposes, 1); assert.equal(readDisposes, 0);
  assert.equal(f.pass._sampleTarget, null); assert.equal(f.pass._sumTarget, null);
  f.dispose({ passAlreadyDisposed: true });
});
