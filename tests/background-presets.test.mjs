import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {BACKGROUND_PRESETS,isPresetPhotoIdentity} from '../src/background-presets.js';
import {getPresetCalibration} from '../src/preset-calibrations.js';
import {getPresetLighting} from '../src/preset-lighting.js';

const photographIds=['pastel-rug','blue-grey','teal-room'];
const presetIds=Object.keys(BACKGROUND_PRESETS);
const source=await readFile(new URL('../src/app.js',import.meta.url),'utf8');
const start=source.indexOf('async function loadPreset(');
const loadPresetSource=source.slice(start,source.indexOf('\n}',start)+2);
const placementStart=source.indexOf('function applyPresetModelPlacement(');
const placementSource=source.slice(placementStart,source.indexOf('\n}',placementStart)+2);
const cameraStart=source.indexOf('function applyPresetCamera(');
const cameraSource=source.slice(cameraStart,source.indexOf('\n}',cameraStart)+2);
const hintsStart=source.indexOf('function withPresetCameraHints(');
const hintsSource=source.slice(hintsStart,source.indexOf('\n}',hintsStart)+2);

test('photography presets bind production PNGs to matching image dimensions, scale and lighting',async()=>{
  for(const id of photographIds){
    const preset=BACKGROUND_PRESETS[id],calibration=getPresetCalibration(id),lighting=getPresetLighting(id);
    const bytes=await readFile(new URL('..'+preset.url,import.meta.url));
    assert.equal(bytes.subarray(1,4).toString(),'PNG');
    assert.equal(bytes.readUInt32BE(16),calibration.imageSize.width);
    assert.equal(bytes.readUInt32BE(20),calibration.imageSize.height);
    assert.equal(preset.mime,'image/png');assert.equal(preset.extension,'png');
    assert.equal(preset.width,calibration.widthMm);assert.equal(preset.depth,calibration.depthMm);
    assert.equal(lighting.photo,preset.url);assert.equal(calibration.sizeBasis,'virtual-scene-reference');
  }
});

test('actual loading of all six presets retains source metadata and restores the canonical camera before fitting',async()=>{
  for(const id of presetIds){
    const preset=BACKGROUND_PRESETS[id],nodes=new Map(),events=[];
    const previousCalibration={points:[{x:.1,y:.1}],bedWidth:2,bedDepth:3,fov:3};
    const context=vm.createContext({printerPresets:BACKGROUND_PRESETS,backgroundPreset:id,File,activeCalibration:previousCalibration,time:0,restoringProject:false,backgroundLoadSequence:0,posePlacement:null,modelSourceKey:'reference-sha',
      $:key=>{if(!nodes.has(key))nodes.set(key,{value:''});return nodes.get(key);},
      fetch:async url=>{assert.equal(url,preset.url);return{ok:true,blob:async()=>new Blob([await readFile(new URL('..'+url,import.meta.url))],{type:preset.mime})};},
      getPresetCalibration,currentPhotoKey:()=> 'preset:'+id,
      setBackgroundFile:async(file,key)=>{assert.equal(key,id);assert.equal(file.type,preset.mime);assert.equal(file.name,preset.label+'.'+preset.extension);assert.ok(file.size>1000);},
      studio:{hasModel:()=>true,
        applyPhotographyPlacement:profile=>{assert.equal(preset.kind,'photography');assert.equal(profile,preset.placement);events.push('placement');return {modelScale:1};},
        applyPrinterPlacement:profile=>{assert.equal(preset.kind,'printer');assert.equal(profile,preset.placement);events.push('placement');return {modelScale:1};}},
      applyActiveCamera:()=>events.push('camera'),syncCameraFields:()=>events.push('fields'),showTime:()=>events.push('render'),persistSettings:()=>events.push('settings'),queueProjectState:()=>events.push('cache'),
      settings:()=>({duration:8}),say:message=>events.push(message)});
    vm.runInContext(hintsSource+'\n'+cameraSource+'\n'+placementSource+'\n'+loadPresetSource,context);await context.loadPreset(id);
    assert.notEqual(context.activeCalibration,previousCalibration);
    assert.deepEqual(JSON.parse(JSON.stringify(context.activeCalibration.points)),getPresetCalibration(id).points);
    assert.equal(context.activeCalibration.fov,getPresetCalibration(id).fov);
    assert.equal(nodes.get('bed-width').value,preset.width);assert.equal(nodes.get('bed-depth').value,preset.depth);
    assert.deepEqual(events.slice(0,6),['camera','fields','placement','render','settings','cache']);
    assert.match(events[6],preset.kind==='photography'?/模型角度、大小、台面落点/:/底板透视/);
  }
});

test('explicit presets dispatch both photography and printer compositions while restored and custom scenes keep their poses',()=>{
  let placements=0,printerPlacements=0;
  const context=vm.createContext({printerPresets:BACKGROUND_PRESETS,backgroundPreset:'pastel-rug',restoringProject:false,posePlacement:null,modelSourceKey:'reference-sha',
    studio:{hasModel:()=>true,applyPhotographyPlacement(){placements++;return {};},applyPrinterPlacement(){printerPlacements++;return {};}}});
  vm.runInContext(placementSource,context);
  for(const id of ['h2c','p1s','a1'])assert.equal(context.applyPresetModelPlacement(id),true);
  for(const id of ['custom','__proto__'])assert.equal(context.applyPresetModelPlacement(id),false);
  assert.equal(placements,0);assert.equal(printerPlacements,3);
  context.restoringProject=true;assert.equal(context.applyPresetModelPlacement(),false);assert.equal(placements,0);
  assert.equal(context.applyPresetModelPlacement('h2c'),false);assert.equal(printerPlacements,3);
  context.restoringProject=false;assert.equal(context.applyPresetModelPlacement(),true);assert.equal(placements,1);
  // Frame/settings updates have no automatic placement call.
  for(const name of ['showTime','updateSettings','applyActiveCamera']){
    const begin=source.search(new RegExp('function '+name+'\\(')),end=source.indexOf('\n}',begin)+2;
    assert.doesNotMatch(source.slice(begin,end),/applyPresetModelPlacement/);
  }
});

test('canonical camera selection rejects custom and prototype names without altering a manual photograph calibration',()=>{
  for(const id of ['', 'custom', '__proto__', 'constructor']){
    const original={points:[{x:.1,y:.1}],bedWidth:2,bedDepth:3,fov:3};
    const context=vm.createContext({printerPresets:BACKGROUND_PRESETS,backgroundPreset:id,activeCalibration:original,
      getPresetCalibration,currentPhotoKey:()=> 'custom-photo',
      $(){assert.fail('custom calibration must not write preset bed controls');},applyActiveCamera(){assert.fail('custom calibration must not apply a preset camera');}});
    vm.runInContext(hintsSource+'\n'+cameraSource,context);
    assert.equal(context.applyPresetCamera(),false);assert.equal(context.activeCalibration,original);
  }
});

test('a preset fit failure stops loading success and is not persisted as a restored composition',async()=>{
  for(const id of ['pastel-rug','p1s']){
    const preset=BACKGROUND_PRESETS[id],events=[];
    const context=vm.createContext({printerPresets:BACKGROUND_PRESETS,backgroundPreset:id,File,activeCalibration:null,
      time:0,restoringProject:false,backgroundLoadSequence:0,posePlacement:null,modelSourceKey:'reference-sha',
      $:()=>({value:''}),fetch:async()=>({ok:true,blob:async()=>new Blob(['source'],{type:preset.mime})}),
      getPresetCalibration,currentPhotoKey:()=> 'preset:'+id,setBackgroundFile:async()=>{},
      studio:{hasModel:()=>true,applyPhotographyPlacement:()=>null,applyPrinterPlacement:()=>null},
      applyActiveCamera(){},syncCameraFields(){},showTime:()=>events.push('render'),persistSettings:()=>events.push('settings'),
      queueProjectState:()=>events.push('cache'),settings:()=>({duration:8}),say:message=>events.push(message)});
    vm.runInContext(hintsSource+'\n'+cameraSource+'\n'+placementSource+'\n'+loadPresetSource,context);
    await assert.rejects(context.loadPreset(id),/自动构图未完成/);
    assert.deepEqual(events,[]);
  }
});

test('exact photo identities and accessible background buttons cover all presets without accepting custom or prototype names',async()=>{
  const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
  for(const id of Object.keys(BACKGROUND_PRESETS)){
    assert.equal(isPresetPhotoIdentity('preset:'+id),true);
    assert.ok(html.includes('data-preset="'+id+'"'));
  }
  for(const id of [null,{},'pastel-rug','preset:custom','preset:__proto__','preset:constructor','preset:teal-room:other'])assert.equal(isPresetPhotoIdentity(id),false);
});
