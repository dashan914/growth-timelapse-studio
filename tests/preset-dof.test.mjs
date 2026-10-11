import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_DOF, DOF_PRESET_REVISION, getPresetDof, migratePresetDof, normalizeDof } from '../src/preset-dof.js';

test('exact photo presets use mild editable model focus without changing full geometry or photo settings', () => {
  for (const key of ['h2c', 'p1s', 'a1']) {
    const profile = getPresetDof(key);
    assert.equal(profile.dofEnabled, true);
    assert.ok(profile.dofStrength >= 5 && profile.dofStrength <= 20);
    assert.ok(profile.dofFocus >= 30 && profile.dofFocus <= 50);
    assert.deepEqual(Object.keys(profile).sort(), ['dofEnabled', 'dofFocus', 'dofStrength']);
    profile.dofStrength = 100;
    assert.notEqual(getPresetDof(key).dofStrength, 100);
  }
  assert.equal(getPresetDof('custom'), null);
});

test('old untouched defaults acquire the photo preset while manual focus, strength and enabled choices survive', () => {
  assert.deepEqual(migratePresetDof(DEFAULT_DOF, 'h2c'), getPresetDof('h2c'));
  for (const edited of [{ ...DEFAULT_DOF, dofStrength: 20 }, { ...DEFAULT_DOF, dofFocus: 65 }, { ...DEFAULT_DOF, dofEnabled: true }]) {
    assert.deepEqual(migratePresetDof(edited, 'h2c'), edited);
  }
  assert.deepEqual(migratePresetDof(DEFAULT_DOF, 'h2c', DOF_PRESET_REVISION), DEFAULT_DOF, 'manual off in a new project is respected');
  assert.deepEqual(migratePresetDof(DEFAULT_DOF, 'h2c', DOF_PRESET_REVISION + 1), DEFAULT_DOF);
  assert.deepEqual(migratePresetDof(DEFAULT_DOF, 'custom'), DEFAULT_DOF);
});

test('new tabletop focus stays on complete models while teal-room permits stronger estimated defocus', () => {
  const rug = getPresetDof('pastel-rug'), studio = getPresetDof('blue-grey'), room = getPresetDof('teal-room');
  assert.ok(room.dofStrength > rug.dofStrength && rug.dofStrength > studio.dofStrength);
  for (const key of ['pastel-rug', 'blue-grey', 'teal-room']) {
    const profile = getPresetDof(key);
    assert.equal(profile.dofEnabled, true);
    assert.ok(profile.dofStrength <= 25, 'default defocus remains mild enough for a whole product');
    assert.equal(profile.dofFocus, 45, 'focus remains close to the middle of the full depth bounds');
    assert.deepEqual(Object.keys(profile).sort(), ['dofEnabled', 'dofFocus', 'dofStrength']);
    assert.deepEqual(migratePresetDof(DEFAULT_DOF, key), profile);
    const manualOff = { dofEnabled: false, dofStrength: profile.dofStrength, dofFocus: 60 };
    assert.deepEqual(migratePresetDof(manualOff, key), manualOff);
    assert.deepEqual(migratePresetDof(DEFAULT_DOF, key, DOF_PRESET_REVISION), DEFAULT_DOF);
    profile.dofFocus = 100;
    assert.equal(getPresetDof(key).dofFocus, 45);
  }
  assert.equal(DOF_PRESET_REVISION, 1, 'new assets must not remigrate existing focus settings');
});

test('cached focus sanitizes numeric inputs without accepting geometry or photograph controls', () => {
  assert.deepEqual(normalizeDof({ dofEnabled: true, dofStrength: '12', dofFocus: '40', modelScale: 2 }), getPresetDof('p1s'));
  assert.deepEqual(normalizeDof({ dofStrength: NaN, dofFocus: 200, dofEnabled: 'false' }), { ...DEFAULT_DOF, dofFocus: 100 });
  const input = Object.freeze({ dofEnabled: false, dofStrength: 35, dofFocus: 50 });
  migratePresetDof(input, 'a1');
  assert.deepEqual(input, DEFAULT_DOF);
});
