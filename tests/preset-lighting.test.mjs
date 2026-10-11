import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_LIGHTING, LIGHTING_PRESET_REVISION, getPresetLighting, normalizeLighting, presetLightingDefinitions } from '../src/preset-lighting.js';
import { getPresetCalibration } from '../src/preset-calibrations.js';
import { projectWorld, solvePlanarCamera } from '../src/calibration.js';
import {GROUND_SHADOW_KERNEL, groundShadowRadiusUV} from '../src/ground-shadow-softness.js';
import {photoShadowScreenColor, linearToSRGB, sRGBToLinear} from '../src/photo-shadow.js';

test('each exact photograph has an editable estimated-lighting preset without palette or background changes', () => {
  for (const key of ['h2c', 'p1s', 'a1']) {
    const first = getPresetLighting(key), second = getPresetLighting(key);
    assert.equal(first.approximate, true);
    assert.equal(first.photo, `/assets/backgrounds/${key}.jpg`);
    assert.notEqual(first, second);
    assert.notEqual(first.fillPosition, second.fillPosition);
    first.fillPosition[0] = 40;
    first.colorTemperature = 2000;
    assert.notEqual(first.fillPosition[0], second.fillPosition[0]);
    assert.notEqual(first.colorTemperature, second.colorTemperature);
    for (const forbidden of ['color', 'toolColors', 'background', 'backgroundExposure', 'toneMappingExposure']) assert.ok(!(forbidden in first));
  }
  assert.equal(getPresetLighting('custom'), null);
  assert.ok(Object.isFrozen(presetLightingDefinitions.h2c.fillPosition));
});

test('the photographed P1S left-wall LED throws its calibrated plate shadow to screen-right', () => {
  const lighting = getPresetLighting('p1s'), preset = getPresetCalibration('p1s');
  const camera = solvePlanarCamera({ points: preset.points, widthPx: 3776, heightPx: 2832, bedWidth: preset.widthMm, bedDepth: preset.depthMm, allowOutside: true });
  const azimuth = lighting.lightAzimuth * Math.PI / 180;
  const elevation = lighting.lightElevation * Math.PI / 180;
  const shadowLength = 100 / Math.tan(elevation);
  const base = projectWorld([0, 0, 0], camera);
  const shadow = projectWorld([-Math.sin(azimuth) * shadowLength, 0, -Math.cos(azimuth) * shadowLength], camera);
  assert.ok(shadow.x > base.x + 150, 'left-wall lighting must produce a visibly rightward shadow');
  assert.ok(shadow.y > base.y, 'its shadow extends across the photographed front/right plate');
  assert.ok(lighting.ambientIntensity < lighting.keyIntensity / 3, 'ambient should not erase side-light contrast');
  assert.ok(lighting.fillIntensity < lighting.keyIntensity / 4, 'no strong fixed rim should overwhelm the source direction');
});

test('open-room lighting is softer and has a warm ground bounce while enclosed presets remain cooler', () => {
  const room = getPresetLighting('a1'), enclosed = getPresetLighting('p1s'), chamber = getPresetLighting('h2c');
  assert.ok(room.shadowRadius > enclosed.shadowRadius);
  assert.ok(room.shadowOpacity < enclosed.shadowOpacity);
  assert.ok(room.ambientIntensity > enclosed.ambientIntensity * 2);
  assert.ok(chamber.colorTemperature > room.colorTemperature && enclosed.colorTemperature > room.colorTemperature);
  const ground = room.ambientGroundColor.slice(1).match(/../g).map(value => parseInt(value, 16));
  assert.ok(ground[0] > ground[2], 'tabletop bounce is warm without modifying filament colors');
});

test('new tabletop photos use distinct restrained environment bounce and left-source soft shadows', () => {
  const rgb = value => value.slice(1).match(/../g).map(channel => parseInt(channel, 16));
  const rug = getPresetLighting('pastel-rug'), studio = getPresetLighting('blue-grey'), room = getPresetLighting('teal-room');
  const [rugSkyR, rugSkyG, rugSkyB] = rgb(rug.ambientSkyColor);
  const [rugGroundR, rugGroundG, rugGroundB] = rgb(rug.ambientGroundColor);
  assert.ok(rugSkyG > rugSkyR && rugSkyG > rugSkyB, 'sage wall contributes a light green environment');
  assert.ok(rugGroundR > rugGroundG && rugGroundG > rugGroundB, 'peach rug contributes warm lower bounce');
  const [studioGroundR, studioGroundG, studioGroundB] = rgb(studio.ambientGroundColor);
  assert.ok(studioGroundB > studioGroundG && studioGroundG > studioGroundR, 'blue-gray floor retains its gentle cool bounce');
  const [roomSkyR, roomSkyG, roomSkyB] = rgb(room.ambientSkyColor);
  const [roomGroundR, , roomGroundB] = rgb(room.ambientGroundColor);
  assert.ok(roomSkyG > roomSkyR && roomSkyB > roomSkyR, 'cyan room contributes cool ambient fill');
  assert.ok(roomGroundR > roomGroundB, 'taupe tabletop provides warmer lower bounce');
  assert.ok(rug.colorTemperature < studio.colorTemperature);
  assert.ok(room.lightAzimuth < studio.lightAzimuth, 'window key is further to the left than the broad studio key');
  assert.ok(room.shadowOpacity > rug.shadowOpacity && room.shadowRadius < rug.shadowRadius);
  for (const [key, profile] of [['pastel-rug', rug], ['blue-grey', studio], ['teal-room', room]]) {
    assert.equal(profile.photo, `/assets/backgrounds/${key}.png`, 'exact PNG assets must not be silently rewritten to JPEG');
    assert.equal(profile.approximate, true);
    assert.equal(profile.saturation, 0, 'photo matching does not desaturate the imported filament palette');
    assert.ok(profile.lightAzimuth < 0 && profile.lightAzimuth > -90);
    assert.ok(profile.lightElevation >= 55 && profile.lightElevation <= 65);
    assert.ok(profile.shadowRadius >= 3.8 && profile.shadowRadius <= 4.5 && profile.shadowOpacity <= .24);
    assert.ok(profile.fillIntensity < profile.keyIntensity / 4, 'fill must preserve the left-source direction');
    assert.ok(profile.exposure > getPresetLighting('a1').exposure, 'bright scenes avoid the darker printer photo grading');
    for (const forbidden of ['color', 'toolColors', 'background', 'backgroundExposure', 'toneMappingExposure']) assert.ok(!(forbidden in profile));
    profile.fillPosition[0] = -40;
    assert.notEqual(getPresetLighting(key).fillPosition[0], -40, 'editable vectors are independent');
  }
  assert.equal(LIGHTING_PRESET_REVISION, 4, 'reference shadow defaults have a field-aware cache migration');
});

test('all six presets retain a small real foot contact shadow rather than washing it into broad blur',()=>{
  const oldShadows={h2c:[7,.17],p1s:[6,.2],a1:[8,.14],'pastel-rug':[8,.13],'blue-grey':[8,.16],'teal-room':[7,.18]};
  const camera={left:-14,right:14,bottom:-14,top:14},mmToWorld=.04;
  const weightSum=GROUND_SHADOW_KERNEL.reduce((sum,sample)=>sum+sample.weight,0);
  // Numerical counterpart of the rendered 64-tap kernel: a real circular
  // 5 mm contact silhouette, not an extra decorative shadow in the renderer.
  const centreCoverage=softness=>{
    const radius=groundShadowRadiusUV(softness,mmToWorld,camera)[0]*28/mmToWorld;
    return GROUND_SHADOW_KERNEL.reduce((sum,sample)=>sum+(Math.hypot(sample.x*radius,sample.y*radius)<=2.5?sample.weight:0),0)/weightSum;
  };
  const photo=[.32,.5,.17],linear=photo.map(sRGBToLinear);
  for(const [key,[oldRadius,oldOpacity]]of Object.entries(oldShadows)){
    const preset=getPresetLighting(key),oldContact=centreCoverage(oldRadius)*oldOpacity,newContact=centreCoverage(preset.shadowRadius)*preset.shadowOpacity;
    assert.ok(newContact>oldContact*4,key+': contact must be materially stronger');
    assert.ok(newContact>.1&&newContact<.24,key+': the contact remains gentle but readable');
    // The shared photo compensation still darkens the original linear RGB by
    // one scalar. No preset adds a tint or rewrites the source image samples.
    const compensation=photoShadowScreenColor(linear,newContact);
    const output=compensation.map((value,index)=>linearToSRGB(linear[index])*(1-newContact)+linearToSRGB(value)*newContact);
    for(let channel=0;channel<3;channel++)assert.ok(Math.abs(output[channel]-linearToSRGB(linear[channel]*(1-newContact)))<2e-5,key+': contact preserves photo hue');
  }
  assert.deepEqual(photo,[.32,.5,.17]);
});

test('normalization safely handles cached strings, invalid values, out-of-range controls and wrapped azimuths', () => {
  const result = normalizeLighting({
    colorTemperature: '6000', keyIntensity: -1, ambientIntensity: Infinity, fillIntensity: 99,
    exposure: 0, lightElevation: 120, lightAzimuth: 270,
    shadowOpacity: 2, shadowRadius: 0,
    ambientSkyColor: '#CCDDEE', ambientGroundColor: 'not-a-color', fillColor: '#abcdef',
    fillPosition: ['4', 200, -90], color: '#ff0000', backgroundExposure: 0.2,
  });
  assert.equal(result.colorTemperature, 6000);
  assert.equal(result.keyIntensity, 0);
  assert.equal(result.ambientIntensity, DEFAULT_LIGHTING.ambientIntensity);
  assert.equal(result.fillIntensity, 8);
  assert.equal(result.exposure, 0.25);
  assert.equal(result.lightElevation, 85);
  assert.equal(result.lightAzimuth, -90);
  assert.equal(result.shadowOpacity, 0.7);
  assert.equal(result.shadowRadius, 1);
  assert.equal(result.ambientSkyColor, '#ccddee');
  assert.equal(result.ambientGroundColor, DEFAULT_LIGHTING.ambientGroundColor);
  assert.deepEqual(result.fillPosition, [4, 50, -50]);
  assert.ok(!('color' in result) && !('backgroundExposure' in result));
  assert.deepEqual(normalizeLighting({ exposure: NaN, fillPosition: [1, 2] }), normalizeLighting());
});

test('partial edits can use the selected photo as their fallback without sharing its mutable vectors', () => {
  const preset = getPresetLighting('h2c');
  const edited = normalizeLighting({ shadowOpacity: 0.4 }, preset);
  assert.equal(edited.shadowOpacity, 0.4);
  assert.equal(edited.colorTemperature, preset.colorTemperature);
  assert.equal(edited.exposure, preset.exposure);
  edited.fillPosition[0] = -30;
  assert.notEqual(edited.fillPosition[0], preset.fillPosition[0]);
});

test('tonal controls sanitize older caches and keep editable photo presets separate from source colors', () => {
  const fields = ['tint', 'shadows', 'highlights', 'contrast', 'saturation'];
  const palette = Object.freeze({ 0: '#ff3300', 1: '#3399ff' });
  const cached = Object.freeze({ colorTemperature: 6900, exposure: 0.88, color: '#abcdef', toolColors: palette, background: '#123456' });
  const before = JSON.stringify(cached);
  const migrated = normalizeLighting(cached);
  for (const field of fields) assert.equal(migrated[field], 0, `${field} is neutral for an older saved project`);
  assert.equal(migrated.colorTemperature, 6900);
  assert.equal(migrated.exposure, 0.88);
  const edited = normalizeLighting({ tint: '180', shadows: '-140', highlights: NaN, contrast: Infinity, saturation: 'invalid', toolColors: palette }, cached);
  assert.equal(edited.tint, 100);
  assert.equal(edited.shadows, -100);
  for (const field of ['highlights', 'contrast', 'saturation']) assert.equal(edited[field], 0);
  assert.ok(!('color' in edited) && !('toolColors' in edited) && !('background' in edited));
  assert.equal(JSON.stringify(cached), before);
  for (const key of ['h2c', 'p1s', 'a1']) {
    const preset = getPresetLighting(key);
    for (const field of fields) assert.ok(Number.isFinite(preset[field]) && preset[field] >= -100 && preset[field] <= 100, `${key} ${field} is an explicit editable model adjustment`);
    const tint = preset.tint;
    preset.tint = 70;
    assert.equal(getPresetLighting(key).tint, tint);
  }
});

test('H2C reference shadow is denser and broader while its original illumination and tonal controls stay intact',()=>{
  const preset=getPresetLighting('h2c');
  assert.equal(preset.shadowOpacity,.38);assert.equal(preset.shadowRadius,5.2);
  const unchanged={colorTemperature:7400,keyIntensity:1.55,ambientIntensity:.72,fillIntensity:.24,
    exposure:.72,tint:0,shadows:6,highlights:-14,contrast:-8,saturation:-10,
    lightAzimuth:-30,lightElevation:66,ambientSkyColor:'#d6dfe9',ambientGroundColor:'#747a83',
    fillColor:'#d1dfed',fillPosition:[8,6,-7]};
  for(const [field,value]of Object.entries(unchanged))assert.deepEqual(preset[field],value,field+' is independent of contact refinement');
  // Reference neutral ground immediately beside a sole is about 18% darker
  // than the source photo. Linear-correct blending at maximum coverage should
  // be in this range without introducing a green or red tint to the plate.
  const source=[.32,.32,.32],linear=source.map(sRGBToLinear),opacity=preset.shadowOpacity;
  const compensation=photoShadowScreenColor(linear,opacity);
  const output=compensation.map((value,index)=>source[index]*(1-opacity)+linearToSRGB(value)*opacity);
  const darkening=1-output[0]/source[0];
  assert.ok(darkening>.18&&darkening<.23,'full occlusion matches readable reference foot density');
  assert.ok(Math.abs(output[0]-output[1])<1e-12&&Math.abs(output[1]-output[2])<1e-12,'reference shadow keeps photographed gray neutral');
});
