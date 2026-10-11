import test from 'node:test';
import assert from 'node:assert/strict';
import { migratePresetLighting } from '../src/preset-lighting-migration.js';
import { normalizeLighting, getPresetLighting, LIGHTING_PRESET_REVISION } from '../src/preset-lighting.js';

// Historical saved-project fixtures, deliberately independent of the module's
// private legacy snapshot. Original caches predate the tonal-control fields.
const old = {
  h2c: {
    colorTemperature: 6900, keyIntensity: 2.05, ambientIntensity: 0.88, fillIntensity: 0.32,
    exposure: 0.9, lightAzimuth: -35, lightElevation: 58, shadowOpacity: 0.25, shadowRadius: 5,
    ambientSkyColor: '#d9e2ee', ambientGroundColor: '#69717c', fillColor: '#c7d8ed', fillPosition: [8, 6, -7],
  },
  p1s: {
    colorTemperature: 7300, keyIntensity: 2.55, ambientIntensity: 0.42, fillIntensity: 0.18,
    exposure: 0.88, lightAzimuth: -100, lightElevation: 62, shadowOpacity: 0.34, shadowRadius: 3.2,
    ambientSkyColor: '#c9d5e4', ambientGroundColor: '#555861', fillColor: '#bcd0e8', fillPosition: [8, 5, 5],
  },
  a1: {
    colorTemperature: 6200, keyIntensity: 1.8, ambientIntensity: 1.2, fillIntensity: 0.48,
    exposure: 0.99, lightAzimuth: -40, lightElevation: 65, shadowOpacity: 0.2, shadowRadius: 7,
    ambientSkyColor: '#e4e9f1', ambientGroundColor: '#9b8069', fillColor: '#e8d6c5', fillPosition: [8, 6, 6],
  },
};
const revision2Shadows={h2c:{shadowOpacity:.17,shadowRadius:7},p1s:{shadowOpacity:.2,shadowRadius:6},a1:{shadowOpacity:.14,shadowRadius:8},
  'pastel-rug':{shadowOpacity:.13,shadowRadius:8},'blue-grey':{shadowOpacity:.16,shadowRadius:8},'teal-room':{shadowOpacity:.18,shadowRadius:7}};

test('original photo defaults, including absent neutral tonal controls, upgrade completely to current presets', () => {
  for (const key of Object.keys(old)) assert.deepEqual(migratePresetLighting(old[key], key), normalizeLighting(getPresetLighting(key)), key);
  assert.deepEqual(migratePresetLighting({}, 'a1', 1), normalizeLighting(getPresetLighting('a1')));
});

test('edited brightness, tint, shadows and vectors stay edited while untouched preset fields upgrade', () => {
  const input = { ...old.h2c, exposure: 0.64, tint: 17, shadows: -22, lightAzimuth: 120, fillPosition: [4, 8, 2], ambientGroundColor: '#123456' };
  const expected = normalizeLighting({ ...getPresetLighting('h2c'), exposure: 0.64, tint: 17, shadows: -22, lightAzimuth: 120, fillPosition: [4, 8, 2], ambientGroundColor: '#123456' });
  assert.deepEqual(migratePresetLighting(input, 'h2c', 1), expected);
  assert.equal(migratePresetLighting(input, 'h2c', 1).keyIntensity, getPresetLighting('h2c').keyIntensity);
});

test('current and future cache revisions normalize their actual values without reapplying presets', () => {
  const current = normalizeLighting({ ...old.p1s, saturation: -30, contrast: 13 });
  for (const revision of [LIGHTING_PRESET_REVISION, LIGHTING_PRESET_REVISION + 1, String(LIGHTING_PRESET_REVISION)]) {
    assert.deepEqual(migratePresetLighting(current, 'p1s', revision), current);
    const once = migratePresetLighting(old.p1s, 'p1s', 0);
    assert.deepEqual(migratePresetLighting(once, 'p1s', revision), once);
  }
});

test('custom and unknown backgrounds preserve user values and exclude source material and photo fields', () => {
  const input = { ...old.a1, tint: -23, color: '#ff0000', toolColors: { 0: '#00ff00' }, background: '#abcdef', backgroundExposure: 0.3 };
  for (const key of ['custom', 'unknown', '', '__proto__']) {
    const result = migratePresetLighting(input, key, 0);
    assert.deepEqual(result, normalizeLighting(input));
    for (const field of ['color', 'toolColors', 'background', 'backgroundExposure']) assert.ok(!(field in result));
  }
});

test('matching is tolerant for numeric storage noise, canonical colors and vectors but preserves real edits', () => {
  const input = { ...old.h2c, exposure: '0.9000005', lightAzimuth: 325, ambientSkyColor: '#D9E2EE', fillPosition: [8.0000005, 6, -7] };
  const result = migratePresetLighting(input, 'h2c');
  assert.equal(result.exposure, getPresetLighting('h2c').exposure);
  assert.equal(result.lightAzimuth, getPresetLighting('h2c').lightAzimuth);
  assert.equal(result.ambientSkyColor, getPresetLighting('h2c').ambientSkyColor);
  assert.deepEqual(result.fillPosition, getPresetLighting('h2c').fillPosition);
  const edited = migratePresetLighting({ ...old.h2c, exposure: 0.900002, fillPosition: [8.000002, 6, -7] }, 'h2c');
  assert.equal(edited.exposure, 0.900002);
  assert.equal(edited.fillPosition[0], 8.000002);
});

test('migration never mutates the input object, its vector or the reusable current preset', () => {
  const vector = Object.freeze([8, 6, -7]);
  const input = Object.freeze({ ...old.h2c, fillPosition: vector, tint: 8 });
  const before = JSON.stringify(input), presetBefore = JSON.stringify(getPresetLighting('h2c'));
  const result = migratePresetLighting(input, 'h2c');
  result.fillPosition[0] = 40; result.tint = 0;
  assert.equal(JSON.stringify(input), before);
  assert.equal(JSON.stringify(getPresetLighting('h2c')), presetBefore);
  assert.notEqual(result.fillPosition, vector);
});

test('revision-2 caches upgrade only untouched contact fields for all six exact background identities',()=>{
  for(const [key,shadows]of Object.entries(revision2Shadows)){
    const input=normalizeLighting({...getPresetLighting(key),...shadows,tint:17,exposure:.69,fillPosition:[3,6,-2]});
    const result=migratePresetLighting(input,key,2),current=getPresetLighting(key);
    for(const field of Object.keys(input))assert.deepEqual(result[field],Object.hasOwn(shadows,field)?current[field]:input[field],key+' '+field);
    assert.deepEqual(migratePresetLighting(input,key,'2'),result,'numeric-string revision behaves consistently');
  }
});

test('manual receiver softness or density stays editable and each untouched neighbour migrates independently',()=>{
  for(const [key,shadows]of Object.entries(revision2Shadows)){
    const current=getPresetLighting(key),input={...current,...shadows};
    const opacityOnly=migratePresetLighting({...input,shadowOpacity:.37},key,2);
    assert.equal(opacityOnly.shadowOpacity,.37);assert.equal(opacityOnly.shadowRadius,current.shadowRadius);
    const radiusOnly=migratePresetLighting({...input,shadowRadius:2.7},key,2);
    assert.equal(radiusOnly.shadowRadius,2.7);assert.equal(radiusOnly.shadowOpacity,current.shadowOpacity);
    const both=migratePresetLighting({...input,shadowOpacity:.37,shadowRadius:2.7},key,2);
    assert.equal(both.shadowRadius,2.7);assert.equal(both.shadowOpacity,.37);
    const noisy=migratePresetLighting({...input,shadowOpacity:String(shadows.shadowOpacity+5e-7),shadowRadius:String(shadows.shadowRadius+5e-7)},key,2);
    assert.equal(noisy.shadowOpacity,current.shadowOpacity);assert.equal(noisy.shadowRadius,current.shadowRadius);
    const edited=normalizeLighting({...both,shadowOpacity:'0.31',shadowRadius:'6.2'});
    assert.equal(edited.shadowOpacity,.31);assert.equal(edited.shadowRadius,6.2,'new defaults do not impose limits on the existing controls');
    assert.deepEqual(migratePresetLighting(edited,key,LIGHTING_PRESET_REVISION),edited,'subsequent restores do not reset edits');
  }
});

test('revision-1 manual edits equal to an intermediate revision-2 default are never mistaken for untouched fields',()=>{
  for(const key of ['h2c','p1s','a1']){
    const input={...old[key],...revision2Shadows[key]};
    const result=migratePresetLighting(input,key,1);
    assert.equal(result.shadowOpacity,revision2Shadows[key].shadowOpacity,key+' manual density survives');
    assert.equal(result.shadowRadius,revision2Shadows[key].shadowRadius,key+' manual softness survives');
    assert.equal(result.keyIntensity,getPresetLighting(key).keyIntensity,'other untouched original fields still upgrade');
  }
});

test('incomplete historical caches use the appropriate old defaults without accepting unrelated photo identities',()=>{
  for(const key of Object.keys(revision2Shadows))assert.deepEqual(migratePresetLighting({},key,2),normalizeLighting(getPresetLighting(key)));
  for(const key of ['pastel-rug','blue-grey','teal-room'])assert.deepEqual(migratePresetLighting({},key,0),normalizeLighting(getPresetLighting(key)));
  for(const key of ['custom','preset:blue-grey','__proto__']){
    const input={...getPresetLighting('blue-grey'),...revision2Shadows['blue-grey']};
    assert.deepEqual(migratePresetLighting(input,key,2),normalizeLighting(input));
  }
});

const revision3Shadows={h2c:{shadowOpacity:.22,shadowRadius:4},p1s:{shadowOpacity:.24,shadowRadius:4},a1:{shadowOpacity:.19,shadowRadius:4.5},
  'pastel-rug':{shadowOpacity:.19,shadowRadius:4.5},'blue-grey':{shadowOpacity:.22,shadowRadius:4},'teal-room':{shadowOpacity:.24,shadowRadius:3.8}};

test('revision-3 H2C restores its reference shadow while retaining every non-shadow edit',()=>{
  const input=normalizeLighting({...getPresetLighting('h2c'),...revision3Shadows.h2c,
    exposure:.63,tint:19,shadows:-21,lightAzimuth:83,lightElevation:61,fillPosition:[3,7,-2]});
  const expected={...input,shadowOpacity:.38,shadowRadius:5.2};
  assert.deepEqual(migratePresetLighting(input,'h2c',3),expected);
  assert.deepEqual(migratePresetLighting(input,'h2c','3'),expected);
  assert.deepEqual(migratePresetLighting({},'h2c',3),normalizeLighting(getPresetLighting('h2c')));
  for(const revision of [4,'4',5])assert.deepEqual(migratePresetLighting(input,'h2c',revision),input,'current or future values stay saved');
});

test('revision-3 H2C migrates untouched density and softness independently and preserves manual values',()=>{
  const input={...getPresetLighting('h2c'),...revision3Shadows.h2c};
  assert.deepEqual(migratePresetLighting({...input,shadowOpacity:.29},'h2c',3),normalizeLighting({...input,shadowOpacity:.29,shadowRadius:5.2}));
  assert.deepEqual(migratePresetLighting({...input,shadowRadius:6.1},'h2c',3),normalizeLighting({...input,shadowOpacity:.38,shadowRadius:6.1}));
  const manual=normalizeLighting({...input,shadowOpacity:.17,shadowRadius:7});
  assert.deepEqual(migratePresetLighting(manual,'h2c',3),manual,'values equal to revision 2 defaults are edits in revision 3');
  const noisy=migratePresetLighting({...input,shadowOpacity:'0.2200005',shadowRadius:'4.0000005'},'h2c',3);
  assert.equal(noisy.shadowOpacity,.38);assert.equal(noisy.shadowRadius,5.2);
  const edited=migratePresetLighting({...input,shadowOpacity:.220002,shadowRadius:4.000002},'h2c',3);
  assert.equal(edited.shadowOpacity,.220002);assert.equal(edited.shadowRadius,4.000002);
});

test('revision-3 lighting in the other five backgrounds remains independent and unchanged',()=>{
  for(const key of ['p1s','a1','pastel-rug','blue-grey','teal-room']){
    const historical=normalizeLighting({...getPresetLighting(key),...revision3Shadows[key]});
    assert.deepEqual(normalizeLighting(getPresetLighting(key)),historical,key+' keeps its previous default shadows');
    assert.deepEqual(migratePresetLighting(historical,key,3),historical,key+' default does not follow H2C');
    const edited=normalizeLighting({...historical,shadowOpacity:.41,shadowRadius:6.7,exposure:.66,lightAzimuth:120,fillPosition:[3,7,-4]});
    assert.deepEqual(migratePresetLighting(edited,key,3),edited,key+' edits remain saved');
    assert.deepEqual(migratePresetLighting({},key,3),historical,key+' incomplete cache uses its own historical defaults');
  }
});

test('older H2C caches upgrade directly without overwriting edits equal to revision-3 shadows',()=>{
  for(const revision of [1,2]){
    const historical=revision===1?old.h2c:{...getPresetLighting('h2c'),...revision2Shadows.h2c};
    const edited={...historical,...revision3Shadows.h2c};
    const result=migratePresetLighting(edited,'h2c',revision);
    assert.equal(result.shadowOpacity,.22,'revision '+revision+' manual density survives');
    assert.equal(result.shadowRadius,4,'revision '+revision+' manual softness survives');
    assert.equal(result.keyIntensity,getPresetLighting('h2c').keyIntensity);
    const untouched=migratePresetLighting(historical,'h2c',revision);
    assert.equal(untouched.shadowOpacity,.38);assert.equal(untouched.shadowRadius,5.2);
  }
});
