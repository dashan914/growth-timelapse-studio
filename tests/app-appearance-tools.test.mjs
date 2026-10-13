import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { parseHTML } from '../vendor/test-dom/worker.mjs';
import { DEFAULT_LIGHTING, getPresetLighting, normalizeLighting } from '../src/preset-lighting.js';
import { getPresetDof, normalizeDof } from '../src/preset-dof.js';

const source = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const fields = ['tint', 'shadows', 'highlights', 'contrast', 'saturation'];
const colorIds = ['lighting-exposure', 'lighting-temperature', ...fields.map(key => 'lighting-' + key)];
const shadowIds = ['canvas-floor', 'canvas-shadow-opacity', 'canvas-shadow-radius', 'canvas-light-direction', 'canvas-light-azimuth', 'canvas-light-elevation'];
const dofIds = ['dof-enabled', 'dof-strength', 'dof-focus'];
const clone = value => JSON.parse(JSON.stringify(value));
function actualFunction(name) {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}
function actualBlock(startText, endText) {
  const start = source.indexOf(startText), end = source.indexOf(endText, start);
  assert.ok(start >= 0 && end > start);
  return source.slice(start, end);
}
function fixture() {
  const { document, window: domWindow } = parseHTML(html), calls = [], writes = [], keyListeners = [];
  const get = id => { const node = document.getElementById(id); assert.ok(node, id); return node; };
  // The bundled DOM parser omits select.value's browser setter and checkbox defaults.
  for (const node of document.querySelectorAll('select')) {
    let value = node.value || node.querySelector('option[selected]')?.value || node.querySelector('option')?.value || '';
    Object.defineProperty(node, 'value', { configurable: true, get: () => value, set: next => { value = String(next); } });
  }
  for (const node of document.querySelectorAll('input[type=checkbox]')) node.checked = node.hasAttribute('checked');
  const state = { hasModel: true, sliced: true, shadowEdit: false, mode: null };
  const studio = {
    options: { modelScale: 1.7, modelOffsetX: .3 }, metadata: {}, canvas: {},
    backgroundMetadata: { type: 'image' },
    hasModel: () => state.hasModel, getPrintLayerData: () => state.sliced ? {} : null,
    setTransformMode(mode) { state.mode = mode; }, setShadowEditMode(value) { state.shadowEdit = value; },
    lockPreviewCamera() { calls.push('lock-camera'); }, setOptions() {},
  };
  const context = vm.createContext({ document, $: get, studio,
    window: { addEventListener(name, callback) { if (name === 'keydown') keyListeners.push(callback); } },
    normalizeLighting, DEFAULT_LIGHTING, getPresetLighting, normalizeDof, getPresetDof,
    modelColorFields: fields, lightingProfile: normalizeLighting(DEFAULT_LIGHTING), backgroundPreset: '', printerPresets: {},
    playing: true, transformMode: null, perspectiveMode: false, dragPerspective: null, loading: false, exporting: false,
    snapshotting: false, alignBusy: false, calibrationMode: false, cropEditing: false, referenceAnalysis: null, importProgressUI: null,
    renderOptions: () => ({}), showTime() { calls.push('render'); }, syncCameraFields() {}, syncDofStatus() { calls.push('dof-status'); },
    beginCrop() {}, finishCrop() {}, drawCrop() {}, stopCalibration() {}, changeCameraFromFields() {}, changeLensFromFields() {},
    updateExportQualityUI() {}, touchPreviewInteraction() { calls.push('interaction'); }, resetScene() { calls.push('reset-scene'); },
    say(message) { calls.push(message); }, updateReferenceView() { calls.push('reference-view'); }, updateStageBounds() {},
    settings: () => ({ duration: 9.5 }), time: 0, backgroundFile: null, referenceFile: null, referencePixels: null,
    readPhoto: async () => ({ width: 4, height: 4, originalWidth: 4, originalHeight: 4, rgba: new Uint8ClampedArray(64) }),
    analysePhotoPair: () => ({ usable: true, warnings: [], translation: { x: 0, y: 0 } }),
    ImageData: class { constructor(data, width, height) { Object.assign(this, { data, width, height }); } },
    cachePatch(value) { calls.push(['cache', value.referenceFile?.name]); },
  });
  context.updateSettings = () => {
    context.syncLightingControls();
    writes.push({ lighting: clone(context.lightingSettings()), dof: clone(context.dofSettings()) });
  };
  get('reference-layer').getContext = () => ({ putImageData() { calls.push('reference-image'); } });
  vm.runInContext(['lightingSettings', 'syncLightingControls', 'applyLighting', 'applyPresetLighting', 'resetPresetColorMatch',
    'dofSettings', 'applyDof', 'applyPresetDof', 'clearPreviewGesture', 'syncPreviewLock', 'setModelMode', 'setPlacementMode',
    'setPerspectiveMode', 'setAppearancePanel', 'setReferencePanel', 'loadReference', 'lockWorkspace'].map(actualFunction).join('\n'), context);
  vm.runInContext(actualBlock("  $('canvas-dof').addEventListener", "  $('calibrate-button').addEventListener"), context);
  for (const line of source.split('\n').filter(line => line.includes("$('canvas-compare').addEventListener") || line.includes("$('close-reference-popup').addEventListener"))) vm.runInContext(line, context);
  vm.runInContext(source.split('\n').find(line => line.startsWith('const settingIds =')), context);
  vm.runInContext(source.split('\n').find(line => line.includes("for (const id of settingIds) if(id!=='export-quality')")), context);
  vm.runInContext(actualBlock("  window.addEventListener('keydown',event=>{", '  try{'), context);
  const click = id => get(id).dispatchEvent(new domWindow.Event('click'));
  const input = id => get(id).dispatchEvent(new domWindow.Event('input'));
  const key = (value, target = get('viewport')) => {
    const event = { key: value, target, preventDefault() { this.prevented = true; } };
    for (const callback of keyListeners) callback(event);
    return event;
  };
  return { document, get, context, state, studio, calls, writes, click, input, key };
}

test('each actual toolbar entry owns one directly accessible panel with the original unique controls', () => {
  const { document } = parseHTML(html);
  for (const [kind, label, ids] of [['shadow', '阴影调节', shadowIds], ['color', '色彩匹配', colorIds], ['dof', '镜头虚化', dofIds]]) {
    const button = document.getElementById('canvas-' + kind), panel = document.getElementById(kind + '-popup');
    assert.equal(button.textContent.trim(), label); assert.equal(button.getAttribute('aria-controls'), panel.id);
    for (const id of ids) {
      assert.equal(document.querySelectorAll('#' + id).length, 1, id);
      assert.equal(panel.contains(document.getElementById(id)), true, id);
      assert.equal(document.getElementById(id).closest('details'), null, 'a second disclosure click is not required');
    }
  }
  assert.equal(document.getElementById('shadow-popup').querySelector('[id^=lighting-]'), null);
  assert.equal(document.getElementById('color-popup').querySelector('[id^=canvas-shadow-]'), null);
});

test('appearance buttons stay unavailable without a ready sliced model and during locked work', () => {
  const f = fixture();
  for (const patch of [{ hasModel: false, sliced: false }, { hasModel: true, sliced: false }]) {
    Object.assign(f.state, patch); f.context.lockWorkspace(false);
    for (const kind of ['shadow', 'color', 'dof']) assert.equal(f.get('canvas-' + kind).disabled, true);
  }
  Object.assign(f.state, { hasModel: true, sliced: true }); f.context.lockWorkspace(false);
  for (const kind of ['shadow', 'color', 'dof']) assert.equal(f.get('canvas-' + kind).disabled, false);
  f.context.lockWorkspace(true);
  for (const kind of ['shadow', 'color', 'dof']) assert.equal(f.get('canvas-' + kind).disabled, true);
});

test('three appearance panels are mutually exclusive and only shadow editing enables canvas handles', () => {
  const f = fixture();
  f.click('canvas-shadow'); assert.equal(f.state.shadowEdit, true); assert.equal(f.get('canvas-lock').getAttribute('aria-pressed'), 'false');
  for (const kind of ['color', 'dof', 'shadow']) {
    f.click('canvas-' + kind);
    for (const other of ['shadow', 'color', 'dof']) {
      assert.equal(f.get(other + '-popup').hidden, other !== kind);
      assert.equal(f.get('canvas-' + other).getAttribute('aria-expanded'), String(other === kind));
    }
    assert.equal(f.state.shadowEdit, kind === 'shadow'); assert.equal(f.context.transformMode, null); assert.equal(f.context.playing, false);
    assert.equal(f.get('canvas-lock').getAttribute('aria-pressed'), String(kind !== 'shadow'));
    f.click('close-' + kind); assert.equal(f.get(kind + '-popup').hidden, true); assert.equal(f.state.shadowEdit, false);
  }
});

test('moving color controls preserves their existing settings path and does not rewrite edited shadows or blur', () => {
  const f = fixture();
  f.get('lighting-exposure').value = '.83'; f.get('lighting-temperature').value = '6700';
  f.get('shadow-opacity').value = '37'; f.get('shadow-radius').value = '6.2'; f.get('light-azimuth').value = '117';
  f.get('dof-enabled').checked = true; f.get('dof-strength').value = '77'; f.get('dof-focus').value = '28';
  const before = { lighting: clone(f.context.lightingSettings()), dof: clone(f.context.dofSettings()) };
  for (const kind of ['shadow', 'color', 'dof']) { f.click('canvas-' + kind); f.click('close-' + kind); }
  assert.deepEqual({ lighting: clone(f.context.lightingSettings()), dof: clone(f.context.dofSettings()) }, before);
  f.click('canvas-color'); f.get('lighting-tint').value = '23'; f.input('lighting-tint');
  assert.equal(f.writes.at(-1).lighting.tint, 23); assert.equal(f.writes.at(-1).lighting.exposure, .83);
  assert.equal(f.writes.at(-1).lighting.shadowOpacity, .37); assert.equal(f.writes.at(-1).lighting.shadowRadius, 6.2);
  assert.deepEqual(f.writes.at(-1).dof, before.dof);
});

test('restore preset color touches only seven visible fields while complete preset restore still includes shadows and blur', () => {
  const f = fixture(), preset = normalizeLighting(getPresetLighting('h2c'));
  f.context.backgroundPreset = 'h2c'; f.context.printerPresets = { h2c: { label: 'H2C' } };
  for (const id of colorIds) f.get(id).value = id === 'lighting-temperature' ? '7800' : '1';
  f.get('shadow-opacity').value = '37'; f.get('shadow-radius').value = '6.2'; f.get('light-azimuth').value = '117';
  f.get('dof-enabled').checked = true; f.get('dof-strength').value = '77'; f.get('dof-focus').value = '28';
  const shadows = ['shadow-opacity', 'shadow-radius', 'light-azimuth', 'light-elevation'].map(id => f.get(id).value);
  const blur = clone(f.context.dofSettings()), originalProfile = clone(f.context.lightingProfile);
  f.click('reset-preset-lighting');
  assert.equal(Number(f.get('lighting-exposure').value), preset.exposure);
  assert.equal(Number(f.get('lighting-temperature').value), preset.colorTemperature);
  for (const field of fields) assert.equal(Number(f.get('lighting-' + field).value), preset[field]);
  assert.deepEqual(['shadow-opacity', 'shadow-radius', 'light-azimuth', 'light-elevation'].map(id => f.get(id).value), shadows);
  assert.deepEqual(clone(f.context.dofSettings()), blur); assert.deepEqual(clone(f.context.lightingProfile), originalProfile);
  f.context.applyPresetLighting(); f.context.applyPresetDof();
  assert.equal(Number(f.get('shadow-opacity').value), preset.shadowOpacity * 100);
  assert.equal(Number(f.get('shadow-radius').value), preset.shadowRadius);
  assert.deepEqual(clone(f.context.dofSettings()), getPresetDof('h2c'));
});

test('Escape and W/E/R retain preview locking and close the color panel without invoking shortcuts inside a slider', () => {
  const f = fixture();
  for (const [key, mode] of [['w', 'translate'], ['e', 'rotate'], ['r', 'scale']]) {
    f.click('canvas-color'); f.key(key);
    assert.equal(f.get('color-popup').hidden, true); assert.equal(f.state.mode, mode);
  }
  f.click('canvas-color'); f.key('w', f.get('lighting-exposure'));
  assert.equal(f.state.mode, null); assert.equal(f.get('color-popup').hidden, false);
  const escape = f.key('Escape'); assert.equal(escape.prevented, true);
  assert.equal(f.get('color-popup').hidden, true); assert.equal(f.get('canvas-lock').getAttribute('aria-pressed'), 'true');
});

test('reference toggle and asynchronous reference loading close other panels while preserving photo completion', async () => {
  const f = fixture();
  f.click('canvas-color'); f.click('canvas-compare');
  assert.equal(f.get('color-popup').hidden, true); assert.equal(f.get('reference-popup').hidden, false);
  f.click('canvas-compare'); assert.equal(f.get('reference-popup').hidden, true);
  f.click('canvas-shadow');
  await f.context.loadReference({ name: 'synthetic-reference.png' });
  assert.equal(f.get('shadow-popup').hidden, true); assert.equal(f.state.shadowEdit, false);
  assert.equal(f.get('reference-popup').hidden, false); assert.equal(f.get('canvas-compare').getAttribute('aria-pressed'), 'true');
  assert.equal(f.context.time, 9.5); assert.equal(f.get('reference-layer').width, 4);
  assert.ok(f.calls.includes('reference-image')); assert.ok(f.calls.some(call => Array.isArray(call) && call[0] === 'cache'));
  f.click('canvas-dof'); assert.equal(f.get('reference-popup').hidden, true);
});
