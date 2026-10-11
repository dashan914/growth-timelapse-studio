import test from 'node:test';
import assert from 'node:assert/strict';
import { BACKGROUND_PRESETS } from '../src/background-presets.js';
import { backgroundAppearanceKey, defaultBackgroundAppearance, normalizeBackgroundAppearance, normalizeBackgroundAppearances } from '../src/background-appearance.js';
import { DEFAULT_LIGHTING, getPresetLighting, normalizeLighting, LIGHTING_PRESET_REVISION } from '../src/preset-lighting.js';
import { DEFAULT_DOF, getPresetDof, DOF_PRESET_REVISION } from '../src/preset-dof.js';

test('each preset starts with its own light and focus while unrelated photographs and empty scenes use neutral defaults', () => {
  for (const preset of Object.keys(BACKGROUND_PRESETS)) {
    const key = backgroundAppearanceKey({ preset, file: { name: 'ignored.jpg' } });
    assert.equal(key, `preset:${preset}`);
    const defaults = defaultBackgroundAppearance(key);
    assert.deepEqual(defaults.lighting, normalizeLighting(getPresetLighting(preset)));
    assert.deepEqual(defaults.dof, getPresetDof(preset));
    assert.equal(defaults.lightingPresetRevision, LIGHTING_PRESET_REVISION);
    assert.equal(defaults.dofPresetRevision, DOF_PRESET_REVISION);
    assert.equal(defaults.surfacePreset, 'auto');
    assert.equal(defaults.surfaceDetail, .6);
    assert.equal(defaults.floor, true);
    assert.equal(defaults.grid, false);
  }
  const rug = defaultBackgroundAppearance('preset:pastel-rug'), blue = defaultBackgroundAppearance('preset:blue-grey'), teal = defaultBackgroundAppearance('preset:teal-room');
  assert.notDeepEqual(rug.lighting, blue.lighting);
  assert.notDeepEqual(blue.lighting, teal.lighting);
  assert.notEqual(rug.dof.dofStrength, blue.dof.dofStrength);
  assert.notEqual(blue.dof.dofStrength, teal.dof.dofStrength);
  for (const key of ['photo:["a.jpg",123,456,"image/jpeg"]', 'scene:studio', 'scene:paper', 'scene:blue', 'preset:unknown']) {
    const defaults = defaultBackgroundAppearance(key);
    assert.deepEqual(defaults.lighting, normalizeLighting(DEFAULT_LIGHTING));
    assert.deepEqual(defaults.dof, DEFAULT_DOF);
  }
});

test('custom-photo keys remain stable after serializing and restoring file metadata and distinguish individual backgrounds', () => {
  const photo = { name: '房间.png', size: 123456, lastModified: 1789012345678, type: 'image/png' };
  const key = backgroundAppearanceKey({ file: photo });
  assert.equal(key, 'photo:["房间.png",123456,1789012345678,"image/png"]');
  assert.equal(backgroundAppearanceKey({ file: JSON.parse(JSON.stringify(photo)), preset: 'unknown' }), key);
  for (const field of ['name', 'size', 'lastModified', 'type']) {
    const altered = { ...photo, [field]: typeof photo[field] === 'number' ? photo[field] + 1 : photo[field] + 'x' };
    assert.notEqual(backgroundAppearanceKey({ file: altered }), key, field);
  }
  assert.equal(backgroundAppearanceKey({ file: {} }), 'photo:["",0,0,""]');
  assert.equal(backgroundAppearanceKey(), 'scene:studio');
  assert.equal(backgroundAppearanceKey({ scene: 'paper' }), 'scene:paper');
  assert.equal(backgroundAppearanceKey({ scene: 'blue' }), 'scene:blue');
  assert.equal(backgroundAppearanceKey({ scene: 'unknown', preset: '__proto__' }), 'scene:studio');
});

test('serializable appearance maps retain independent manual lighting, depth of field, surface and ground settings', () => {
  const customKey = backgroundAppearanceKey({ file: { name: 'custom.png', size: 40, lastModified: 50, type: 'image/png' } });
  const raw = Object.fromEntries(['preset:blue-grey', 'preset:teal-room', customKey, 'scene:studio', 'scene:paper'].map(key => [key, defaultBackgroundAppearance(key)]));
  Object.assign(raw['preset:blue-grey'].lighting, { exposure: .42, tint: 17, fillPosition: [3, 5, -2], ambientSkyColor: '#123456' });
  Object.assign(raw['preset:blue-grey'], { surfacePreset: 'silk', surfaceDetail: .21, floor: false, grid: true, dof: { dofEnabled: false, dofStrength: 67, dofFocus: 14 } });
  raw[customKey].lighting.exposure = 1.72;
  raw['scene:paper'].surfacePreset = 'matte';
  const restored = normalizeBackgroundAppearances(JSON.parse(JSON.stringify(raw)));
  assert.deepEqual(restored, raw);
  assert.equal(restored['preset:teal-room'].lighting.exposure, getPresetLighting('teal-room').exposure);
  assert.equal(restored['scene:studio'].surfacePreset, 'auto');
  assert.equal(restored[customKey].lighting.exposure, 1.72);
  const repeated = normalizeBackgroundAppearances(restored);
  assert.deepEqual(repeated, restored);
  repeated['preset:blue-grey'].lighting.fillPosition[0] = 40;
  repeated['preset:blue-grey'].dof.dofFocus = 99;
  assert.equal(restored['preset:blue-grey'].lighting.fillPosition[0], 3);
  assert.equal(restored['preset:blue-grey'].dof.dofFocus, 14);
});

test('each returned default and normalized record owns its nested objects and arrays', () => {
  const first = defaultBackgroundAppearance('preset:teal-room'), second = defaultBackgroundAppearance('preset:teal-room');
  first.lighting.fillPosition[0] = 40; first.lighting.exposure = .3; first.dof.dofFocus = 1;
  assert.deepEqual(second, defaultBackgroundAppearance('preset:teal-room'));
  const input = Object.freeze({ lighting: Object.freeze({ ...second.lighting, fillPosition: Object.freeze([1, 2, 3]) }), lightingPresetRevision: LIGHTING_PRESET_REVISION, dof: Object.freeze(second.dof), dofPresetRevision: DOF_PRESET_REVISION });
  const before = JSON.stringify(input), normalized = normalizeBackgroundAppearance(input, 'preset:teal-room');
  normalized.lighting.fillPosition[0] = 48; normalized.dof.dofFocus = 2;
  assert.equal(JSON.stringify(input), before);
});

test('malformed records sanitize only appearance fields and never introduce geometry, source colors or output preferences', () => {
  const key = 'preset:blue-grey', defaults = defaultBackgroundAppearance(key);
  const restored = normalizeBackgroundAppearance({
    lighting: { exposure: '100', shadowOpacity: '-1', fillPosition: ['4', 5, '6'], ambientSkyColor: 'bad', modelScale: 3 },
    lightingPresetRevision: LIGHTING_PRESET_REVISION,
    dof: { dofEnabled: 'true', dofStrength: 200, dofFocus: '-20' }, dofPresetRevision: DOF_PRESET_REVISION,
    surfacePreset: 'unknown', surfaceDetail: '9', floor: 'false', grid: 1,
    pose: { modelScale: 3 }, toolColors: { 0: '#ff0000' }, quality: 'realistic', ratio: '16:9', background: '#ff0000',
  }, key);
  assert.equal(restored.lighting.exposure, 2.5);
  assert.equal(restored.lighting.shadowOpacity, 0);
  assert.deepEqual(restored.lighting.fillPosition, [4, 5, 6]);
  assert.equal(restored.lighting.ambientSkyColor, defaults.lighting.ambientSkyColor);
  assert.equal(restored.lighting.keyIntensity, defaults.lighting.keyIntensity);
  assert.deepEqual(restored.dof, { dofEnabled: defaults.dof.dofEnabled, dofStrength: 100, dofFocus: 0 });
  assert.equal(restored.surfacePreset, 'auto'); assert.equal(restored.surfaceDetail, 1);
  assert.equal(restored.floor, true); assert.equal(restored.grid, false);
  assert.deepEqual(Object.keys(restored).sort(), Object.keys(defaults).sort());
  for (const input of [null, undefined, 'bad', 12, [], { lighting: [], dof: [] }, { surfaceDetail: true }]) assert.deepEqual(normalizeBackgroundAppearance(input, key), defaults);
  assert.equal(normalizeBackgroundAppearance({ surfaceDetail: -3, surfacePreset: 'petg', floor: false, grid: true }, key).surfaceDetail, 0);
});

test('appearance maps reject unknown namespaces, unknown presets, inherited entries and prototype-pollution keys', () => {
  const polluted = JSON.parse('{"__proto__":{"polluted":true},"constructor":{},"prototype":{},"preset:unknown":{},"scene:unknown":{},"photo:":{},"lighting":{},"preset:blue-grey":{},"scene:paper":{},"photo:custom":{}}');
  const result = normalizeBackgroundAppearances(polluted);
  assert.deepEqual(Object.keys(result).sort(), ['photo:custom', 'preset:blue-grey', 'scene:paper']);
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
  assert.equal({}.polluted, undefined);
  const inherited = Object.create({ 'preset:a1': defaultBackgroundAppearance('preset:a1') });
  inherited['preset:h2c'] = {};
  assert.deepEqual(Object.keys(normalizeBackgroundAppearances(inherited)), ['preset:h2c']);
  const inheritedFields = Object.create({ lighting: { exposure: .3 }, floor: false });
  assert.deepEqual(normalizeBackgroundAppearance(inheritedFields, 'preset:h2c'), defaultBackgroundAppearance('preset:h2c'));
  for (const input of [null, undefined, [], 'bad', 1]) assert.deepEqual(normalizeBackgroundAppearances(input), {});
});

test('historical defaults upgrade per background while deliberate light and focus edits survive independently', () => {
  const raw = {
    'preset:blue-grey': {
      lighting: { ...getPresetLighting('blue-grey'), shadowOpacity: .16, shadowRadius: 8, exposure: .64, tint: 17, fillPosition: [2, 4, -7] }, lightingPresetRevision: 2,
      dof: DEFAULT_DOF, dofPresetRevision: 0,
    },
    'preset:teal-room': {
      lighting: { ...getPresetLighting('teal-room'), shadowOpacity: .37, shadowRadius: 7 }, lightingPresetRevision: '2',
      dof: { dofEnabled: false, dofStrength: 53, dofFocus: 65 }, dofPresetRevision: 0,
    },
    'preset:h2c': {
      lighting: { colorTemperature: 6900, keyIntensity: 2.05, ambientIntensity: .88, fillIntensity: .32, exposure: .9, lightAzimuth: -35, lightElevation: 58, shadowOpacity: .25, shadowRadius: 5, ambientSkyColor: '#d9e2ee', ambientGroundColor: '#69717c', fillColor: '#c7d8ed', fillPosition: [8, 6, -7] },
    },
  };
  const upgraded = normalizeBackgroundAppearances(raw), blue = upgraded['preset:blue-grey'], teal = upgraded['preset:teal-room'];
  assert.equal(blue.lighting.shadowOpacity, getPresetLighting('blue-grey').shadowOpacity);
  assert.equal(blue.lighting.shadowRadius, getPresetLighting('blue-grey').shadowRadius);
  assert.equal(blue.lighting.exposure, .64); assert.equal(blue.lighting.tint, 17); assert.deepEqual(blue.lighting.fillPosition, [2, 4, -7]);
  assert.deepEqual(blue.dof, getPresetDof('blue-grey'));
  assert.equal(teal.lighting.shadowOpacity, .37);
  assert.equal(teal.lighting.shadowRadius, getPresetLighting('teal-room').shadowRadius);
  assert.deepEqual(teal.dof, raw['preset:teal-room'].dof);
  assert.deepEqual(upgraded['preset:h2c'].lighting, normalizeLighting(getPresetLighting('h2c')));
  assert.deepEqual(upgraded['preset:h2c'].dof, getPresetDof('h2c'));
  assert.deepEqual(normalizeBackgroundAppearances(JSON.parse(JSON.stringify(upgraded))), upgraded);
  const manualOff = { ...defaultBackgroundAppearance('preset:blue-grey'), dof: DEFAULT_DOF };
  assert.deepEqual(normalizeBackgroundAppearance(manualOff, 'preset:blue-grey').dof, DEFAULT_DOF);
});
