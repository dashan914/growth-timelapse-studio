import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {BACKGROUND_PRESETS} from '../src/background-presets.js';
import {backgroundAppearanceKey,normalizeBackgroundAppearance,normalizeBackgroundAppearances} from '../src/background-appearance.js';
import {DEFAULT_LIGHTING,getPresetLighting,normalizeLighting,LIGHTING_PRESET_REVISION} from '../src/preset-lighting.js';
import {migratePresetLighting} from '../src/preset-lighting-migration.js';
import {getPresetDof,normalizeDof,migratePresetDof,DOF_PRESET_REVISION} from '../src/preset-dof.js';
import {getPresetCalibration} from '../src/preset-calibrations.js';
import {isBambuPrinterModel} from '../src/printer-presets.js';

const source=await readFile(new URL('../src/app.js',import.meta.url),'utf8');
const copy=value=>JSON.parse(JSON.stringify(value));
const ids=Object.keys(BACKGROUND_PRESETS);
const colorFields=['tint','shadows','highlights','contrast','saturation'];
const poseDefaults={modelOffsetX:0,modelOffsetY:0,modelOffsetZ:0,modelRotationX:0,modelRotationY:0,modelRotationZ:0,modelScale:1};

// Execute the production app functions, including their commit and persistence
// boundaries. DOM, decoding and rendering are replaced; appearance code is not.
function actualFunction(name){
  const start=source.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start>=0,`missing app function ${name}`);
  let depth=0,quote=null,lineComment=false,blockComment=false,parameters=0,bodyStart=start;
  for(let i=source.indexOf('(',start);i<source.length;i++){
    const character=source[i];
    if(quote){if(character==='\\'){i++;continue;}if(character===quote)quote=null;continue;}
    if(character==='\''||character==='"'||character==='`'){quote=character;continue;}
    if(character==='(')parameters++;
    if(character===')'&&--parameters===0){bodyStart=i+1;break;}
  }
  const opening=source.indexOf('{',bodyStart);
  for(let i=opening;i<source.length;i++){
    const character=source[i],next=source[i+1];
    if(lineComment){if(character==='\n')lineComment=false;continue;}
    if(blockComment){if(character==='*'&&next==='/'){blockComment=false;i++;}continue;}
    if(quote){if(character==='\\'){i++;continue;}if(character===quote)quote=null;continue;}
    if(character==='/'&&next==='/'){lineComment=true;i++;continue;}
    if(character==='/'&&next==='*'){blockComment=true;i++;continue;}
    if(character==='\''||character==='"'||character==='`'){quote=character;continue;}
    if(character==='{')depth++;
    if(character==='}'&&--depth===0)return source.slice(start,i+1);
  }
  throw new Error(`unfinished app function ${name}`);
}

function fixture({savedLocal=null,restoring=false}={}){
  const nodes=new Map(),storage=new Map(),writes=[],patches=[],renders=[],timers=new Map(),pending=[];
  if(savedLocal)storage.set('growth-studio-settings-v4',JSON.stringify(savedLocal));
  const checkboxIds=new Set(['floor','grid','stepped','layer-lines','preserve-materials','show-supports','dof-enabled']);
  const get=id=>{
    if(!nodes.has(id))nodes.set(id,{value:'',checked:false,type:checkboxIds.has(id)?'checkbox':'text',hidden:false,textContent:'',
      setAttribute(){},classList:{toggle(){}}});
    return nodes.get(id);
  };
  for(const [id,value]of Object.entries({'surface-preset':'auto','surface-detail':'60','lighting-exposure':'1',
    'lighting-temperature':'6500','shadow-opacity':'28','shadow-radius':'4','light-azimuth':'-45','light-elevation':'55',
    'dof-strength':'35','dof-focus':'50',ratio:'16:9','growth-duration':'8',hold:'0',format:'mov-alpha',resolution:'2160',
    fps:'60','export-quality':'realistic','model-color':'#84aabb',layers:'180'}))get(id).value=value;
  for(const key of colorFields)get('lighting-'+key).value=0;
  get('floor').checked=true;get('preserve-materials').checked=true;get('layer-lines').checked=true;
  const vector=values=>({toArray:()=>[...values]});
  const studio={metadata:{name:'reference.3mf'},options:{...poseDefaults},backgroundMetadata:null,
    hasModel:()=>true,camera:{aspect:16/9,fov:36,position:vector([1,2,3]),up:vector([0,1,0])},controls:{target:vector([0,0,0])},
    setPhotoIdentity(identity){this.photoIdentity=identity;},setOptions(options){Object.assign(this.options,options);},
    clearBackground(){this.backgroundMetadata=null;},
    async loadBackground(file,{beforeCommit}){
      if(f.fail){const error=f.fail;f.fail=null;throw error;}
      if(f.defer)await new Promise(resolve=>pending.push({file,resolve}));
      beforeCommit();
      this.backgroundMetadata={type:'image',width:1080,height:1440,name:file.name};
    }};
  let timerSequence=0;
  const context=vm.createContext({File,Blob,DOMException,studio,$:get,printerPresets:BACKGROUND_PRESETS,isBambuPrinterModel,
    backgroundAppearanceKey,normalizeBackgroundAppearance,normalizeBackgroundAppearances,
    DEFAULT_LIGHTING,getPresetLighting,normalizeLighting,LIGHTING_PRESET_REVISION,migratePresetLighting,
    getPresetDof,normalizeDof,migratePresetDof,DOF_PRESET_REVISION,getPresetCalibration,
    SURFACE_PRESETS:['auto','pla','matte','silk','petg'],modelColorFields:colorFields,DEFAULT_MODEL_POSE:poseDefaults,
    lightingProfile:normalizeLighting(DEFAULT_LIGHTING),backgroundAppearances:{},restoredSettingsData:null,backgroundLoadSequence:0,
    backgroundPreset:'',backgroundFile:null,scene:'studio',sceneColors:{studio:'#30333a',paper:'#eceff3',blue:'#171b24'},
    restoringProject:restoring,calibrationMode:false,loading:false,exporting:false,alignBusy:false,cacheTimer:null,
    activeCalibration:null,manualSupportMapping:null,modelSourceKey:'model-source',posePlacement:null,sliceReadyJob:null,
    CAMERA_METRIC_REVISION:2,toolColors:{0:'#eebd32',1:'#245699'},cropRect:null,cropEditing:false,time:8,playing:false,
    restoredModelPose:null,restoredDofSettings:null,restoredSurfaceSettings:null,qualityPreference:'realistic',
    localStorage:{getItem:key=>storage.get(key)||null,setItem(key,value){storage.set(key,value);writes.push(JSON.parse(value));}},
    setTimeout(callback){const id=++timerSequence;timers.set(id,callback);return id;},clearTimeout(id){timers.delete(id);},
    clearReference(){},markPreset(){},setModelMode(){},setPlacementMode(){},say(){},showTime(){},
    syncLightingControls(){},applyActiveCamera(){},withPresetCameraHints:value=>value,
    stopCalibration(){context.calibrationMode=false;},
    updateSettings(){renders.push(copy(context.captureBackgroundAppearance()));context.persistSettings();},
    cachePatch(patch){patches.push(patch);},
    fetch:async url=>({ok:true,blob:async()=>new Blob([url],{type:BACKGROUND_PRESETS[ids.find(id=>BACKGROUND_PRESETS[id].url===url)].mime})}),
    syncCameraFields(){},applyPresetModelPlacement(){return true;},settings:()=>({duration:8})});
  vm.runInContext(source.match(/^const settingIds = .*;$/m)[0]+'\n'+[
    'dofSettings','applyDof','applyPresetDof','surfaceSettings','restoreSurfaceControls','modelPose','modelSceneCamera','lightingSettings','applyLighting','applyPresetLighting',
    'currentBackgroundAppearanceKey','captureBackgroundAppearance','rememberBackgroundAppearance','applyBackgroundAppearance',
    'restoreBackgroundAppearanceCache','currentPhotoKey','calibrationStorageKey','setBackgroundFile','applyPresetCamera','loadPreset',
    'clearBackgroundUI','restoreProjectBackground','persistSettings','queueProjectState','restoreSettings',
  ].map(actualFunction).join('\n'),context);
  const f={context,studio,get,writes,patches,renders,pending,fail:null,defer:false,
    snapshot:()=>copy(context.captureBackgroundAppearance()),key:()=>context.currentBackgroundAppearanceKey(),
    map:()=>copy(context.backgroundAppearances),
    async preset(id){await context.loadPreset(id);},
    async photo(file){await context.setBackgroundFile(file);},
    flush(){const callbacks=[...timers.values()];timers.clear();for(const callback of callbacks)callback();},
    edit(index){
      context.applyLighting({...normalizeLighting(getPresetLighting(context.backgroundPreset)||DEFAULT_LIGHTING),
        exposure:.61+index*.1,colorTemperature:5100+index*100,lightAzimuth:-130+index*21,lightElevation:30+index*5,
        shadowOpacity:.1+index*.045,shadowRadius:2+index*.6,tint:index*3,shadows:index*4,highlights:-index*5,
        contrast:-index*2,saturation:index*6,ambientSkyColor:'#abc'+index+'12',ambientGroundColor:'#321'+index+'ab',
        fillColor:'#a1b'+index+'cd',fillPosition:[index,index+1,index+2],keyIntensity:.7+index*.3,
        ambientIntensity:.4+index*.15,fillIntensity:.1+index*.07});
      context.applyDof({dofEnabled:index%2===0,dofStrength:20+index*7,dofFocus:35+index*5});
      context.restoreSurfaceControls({surfacePreset:['pla','matte','silk','petg','auto'][index%5],surfaceDetail:(21+index*11)/100});
      get('floor').checked=index%2===0;get('grid').checked=index%3===0;
      return f.snapshot();
    }};
  return f;
}

test('unvisited presets apply their own complete defaults before the first settings/render update',async()=>{
  const f=fixture();
  for(const [index,id]of ids.entries()){
    f.edit(index+1);
    await f.preset(id);
    const expected=normalizeBackgroundAppearance(undefined,'preset:'+id);
    assert.deepEqual(f.snapshot(),expected);
    assert.deepEqual(f.renders.at(-1),expected,'incoming appearance must precede updateSettings');
  }
});

test('all six backgrounds retain independent lighting, shadows, DOF and surface edits when revisited',async()=>{
  const f=fixture(),expected=new Map();
  for(const [index,id]of ids.entries()){await f.preset(id);expected.set(id,f.edit(index+1));}
  for(const id of [...ids].reverse()){
    await f.preset(id);
    assert.deepEqual(f.snapshot(),expected.get(id),id);
    assert.deepEqual(f.renders.at(-1),expected.get(id));
    assert.equal(f.get('format').value,'mov-alpha');assert.equal(f.get('resolution').value,'2160');
    assert.equal(f.get('fps').value,'60');assert.equal(f.get('export-quality').value,'realistic');
    assert.equal(f.get('model-color').value,'#84aabb');assert.equal(f.get('preserve-materials').checked,true);
    assert.deepEqual(copy(f.context.toolColors),{0:'#eebd32',1:'#245699'});
  }
});

test('custom photos and all plain backgrounds have independent records with stable file identities',async()=>{
  const f=fixture(),photoA=new File(['a'],'table.jpg',{type:'image/jpeg',lastModified:100}),
    photoB=new File(['bbbb'],'table.jpg',{type:'image/jpeg',lastModified:101});
  const studioAppearance=f.edit(1);await f.photo(photoA);const keyA=f.key(),a=f.edit(2);
  await f.photo(photoB);const keyB=f.key();assert.notEqual(keyA,keyB);
  assert.deepEqual(f.snapshot(),normalizeBackgroundAppearance(undefined,keyB),'custom photo must not inherit A');
  const b=f.edit(3);f.context.clearBackgroundUI('paper');
  assert.deepEqual(f.snapshot(),normalizeBackgroundAppearance(undefined,'scene:paper'));
  const paper=f.edit(4);f.context.clearBackgroundUI('blue');const blue=f.edit(5);
  f.context.clearBackgroundUI('studio');assert.deepEqual(f.snapshot(),studioAppearance);
  f.context.clearBackgroundUI('paper');assert.deepEqual(f.snapshot(),paper);
  f.context.clearBackgroundUI('blue');assert.deepEqual(f.snapshot(),blue);
  await f.photo(new File(['a'],'table.jpg',{type:'image/jpeg',lastModified:100}));
  assert.equal(f.key(),keyA);assert.deepEqual(f.snapshot(),a);
  await f.photo(photoB);assert.deepEqual(f.snapshot(),b);
});

test('failed background decode retains the old record, controls, identity and persistence state',async()=>{
  const f=fixture();await f.preset('blue-grey');f.edit(4);f.context.persistSettings();
  const before={appearance:f.snapshot(),map:f.map(),file:f.context.backgroundFile,writes:f.writes.length,renders:f.renders.length};
  f.fail=new Error('invalid photo');
  await assert.rejects(f.photo(new File(['bad'],'bad.png',{type:'image/png'})),/invalid photo/);
  assert.equal(f.key(),'preset:blue-grey');assert.equal(f.context.backgroundFile,before.file);
  assert.deepEqual(f.snapshot(),before.appearance);assert.deepEqual(f.map(),before.map);
  assert.equal(f.writes.length,before.writes);assert.equal(f.renders.length,before.renders);
});

test('an older decode finishing after a newer background cannot commit or corrupt either appearance',async()=>{
  const f=fixture();await f.preset('h2c');const original=f.edit(1);f.defer=true;
  const oldLoad=f.context.setBackgroundFile(new File(['old'],'old.png',{type:'image/png'}),'blue-grey');
  const newLoad=f.context.setBackgroundFile(new File(['new'],'new.png',{type:'image/png'}),'teal-room');
  assert.equal(f.pending.length,2);
  f.pending[1].resolve();assert.equal(await newLoad,true);const latest=f.edit(5);
  f.pending[0].resolve();assert.equal(await oldLoad,false);
  assert.equal(f.key(),'preset:teal-room');assert.deepEqual(f.snapshot(),latest);
  assert.deepEqual(f.map()['preset:h2c'],original);
  assert.equal(Object.hasOwn(f.map(),'preset:blue-grey'),false);
});

test('an older preset fetch completing last cannot start a decode or replace the latest preset',async()=>{
  const f=fixture(),requests=[],decodes=[];await f.preset('h2c');const original=f.edit(2);
  f.context.fetch=url=>new Promise(resolve=>requests.push({url,resolve}));
  const originalLoader=f.studio.loadBackground.bind(f.studio);
  f.studio.loadBackground=async(file,options)=>{decodes.push(file.name);return originalLoader(file,options);};
  const oldLoad=f.context.loadPreset('blue-grey'),newLoad=f.context.loadPreset('teal-room');
  const response=url=>({ok:true,blob:async()=>new Blob([url],{type:'image/png'})});
  requests[1].resolve(response(requests[1].url));await newLoad;const latest=f.edit(5);
  requests[0].resolve(response(requests[0].url));await oldLoad;
  assert.deepEqual(decodes,[BACKGROUND_PRESETS['teal-room'].label+'.png']);
  assert.equal(f.key(),'preset:teal-room');assert.deepEqual(f.snapshot(),latest);
  assert.deepEqual(f.map()['preset:h2c'],original);
  assert.equal(Object.hasOwn(f.map(),'preset:blue-grey'),false);
});

test('clearing a background cancels pending decode and remembers the outgoing scene before changing its key',async()=>{
  const f=fixture();const studioAppearance=f.edit(3);f.defer=true;
  const pendingLoad=f.context.setBackgroundFile(new File(['late'],'late.png',{type:'image/png'}),'p1s');
  f.context.clearBackgroundUI('paper');const paper=f.edit(2);
  f.pending[0].resolve();assert.equal(await pendingLoad,false);
  assert.equal(f.key(),'scene:paper');assert.deepEqual(f.snapshot(),paper);
  assert.deepEqual(f.map()['scene:studio'],studioAppearance);
  assert.equal(Object.hasOwn(f.map(),'preset:p1s'),false);
});

test('local settings and debounced project snapshots both persist the complete background map',async()=>{
  const f=fixture(),expected=new Map();
  for(const [index,id]of ids.entries()){await f.preset(id);expected.set(id,f.edit(index+1));f.context.persistSettings();}
  f.flush();
  const local=f.writes.at(-1),project=f.patches.filter(patch=>patch.settings).at(-1);
  assert.equal(local.backgroundAppearanceKey,'preset:teal-room');
  assert.equal(project.settings.backgroundAppearanceKey,'preset:teal-room');
  for(const id of ids){
    assert.deepEqual(copy(local.backgroundAppearances['preset:'+id]),expected.get(id));
    assert.deepEqual(copy(project.settings.backgroundAppearances['preset:'+id]),expected.get(id));
  }
  const restored=fixture({savedLocal:local,restoring:true});
  restored.context.restoreSettings();restored.context.restoreBackgroundAppearanceCache({...project,backgroundPreset:'teal-room'});
  for(const id of ids){await restored.preset(id);assert.deepEqual(restored.snapshot(),expected.get(id));}
  assert.equal(restored.writes.length,0,'restoration must not capture a transient background appearance');
});

test('the selected slice target persists independently from the chosen background',()=>{
  const saved=fixture();saved.context.backgroundPreset='a1';saved.get('target-printer').value='x2d';
  saved.context.persistSettings();saved.context.queueProjectState();saved.flush();
  const local=saved.writes.at(-1),project=saved.patches.filter(patch=>patch.settings).at(-1);
  assert.equal(local.targetPrinterPreset,'x2d');assert.equal(project.settings.targetPrinterPreset,'x2d');
  assert.equal(local.backgroundPreset,'a1');assert.equal(project.settings.backgroundPreset,'a1');
  const restored=fixture({savedLocal:local,restoring:true});restored.context.restoreSettings();
  assert.equal(restored.get('target-printer').value,'x2d');assert.equal(restored.context.backgroundPreset,'a1');
});

test('loading never persists the temporary pose, then both stores capture the same finished placement marker',()=>{
  const f=fixture();
  f.context.backgroundPreset='h2c';f.context.loading=true;
  f.studio.options.modelScale=3;
  f.context.persistSettings();f.context.queueProjectState();f.flush();
  assert.equal(f.writes.length,0);assert.equal(f.patches.length,0);
  f.context.loading=false;f.studio.options.modelScale=.85;
  f.context.posePlacement={preset:'h2c',revision:BACKGROUND_PRESETS.h2c.placement.revision,modelSourceKey:f.context.modelSourceKey};
  f.context.persistSettings();f.flush();
  assert.equal(f.writes.length,1);assert.equal(f.patches.length,1);
  const local=f.writes[0],project=f.patches[0].settings;
  for(const record of [local,project]){
    assert.equal(record.pose.modelScale,.85);assert.deepEqual(record.posePlacement,copy(f.context.posePlacement));
    assert.equal(record.backgroundPreset,'h2c');assert.equal(record.modelSourceKey,'model-source');
    assert.ok(Number.isFinite(record.poseUpdatedAt)&&record.poseUpdatedAt>0);
  }
  assert.deepEqual(local.pose,copy(project.pose));
});

test('committing a custom photo or clearing the background removes the previous preset pose marker',async()=>{
  const f=fixture();await f.preset('h2c');
  const previousMarker={preset:'h2c',revision:BACKGROUND_PRESETS.h2c.placement.revision,modelSourceKey:'model-source'};
  f.context.posePlacement={...previousMarker};
  const custom=new File(['custom tabletop'],'own-photo.jpg',{type:'image/jpeg',lastModified:123});
  await f.photo(custom);
  assert.equal(f.context.posePlacement,null);assert.equal(f.writes.at(-1).posePlacement,null);
  assert.equal(f.context.backgroundPreset,'');
  await f.preset('h2c');f.context.posePlacement={...previousMarker};
  f.context.clearBackgroundUI();f.context.persistSettings();
  assert.equal(f.context.posePlacement,null);assert.equal(f.writes.at(-1).posePlacement,null);
});

test('a rejected photo decode cannot discard the active scene placement marker',async()=>{
  const f=fixture();await f.preset('h2c');
  f.context.posePlacement={preset:'h2c',revision:BACKGROUND_PRESETS.h2c.placement.revision,modelSourceKey:'model-source'};
  const marker=copy(f.context.posePlacement);f.fail=new Error('image decode failed');
  await assert.rejects(f.photo(new File(['broken'],'broken.jpg',{type:'image/jpeg'})),/image decode failed/);
  assert.deepEqual(copy(f.context.posePlacement),marker);assert.equal(f.context.backgroundPreset,'h2c');
});

test('startup merges maps per key, preferring newer local entries while retaining IndexedDB-only scenes',()=>{
  const f=fixture({restoring:true}),local=normalizeBackgroundAppearance({lighting:{exposure:.64},lightingPresetRevision:3},'preset:blue-grey'),
    older=normalizeBackgroundAppearance({lighting:{exposure:1.2},lightingPresetRevision:3},'preset:blue-grey'),
    other=normalizeBackgroundAppearance({surfacePreset:'silk',surfaceDetail:.9,floor:false},'preset:p1s');
  f.context.backgroundAppearances={'preset:blue-grey':local};
  f.context.restoredSettingsData={backgroundAppearances:{'preset:blue-grey':local},backgroundPreset:'blue-grey'};
  f.context.restoreBackgroundAppearanceCache({backgroundPreset:'p1s',settings:{backgroundAppearances:{'preset:blue-grey':older,'preset:p1s':other}}});
  assert.deepEqual(f.map(),{'preset:blue-grey':local,'preset:p1s':other});
});

test('startup preserves an explicitly cleared background and restores each plain scene appearance',async()=>{
  for(const [index,scene]of ['studio','paper','blue'].entries()){
    const original=fixture();original.context.scene=scene;const expected=original.edit(index+2);original.context.persistSettings();
    const local=original.writes.at(-1),saved={backgroundFile:null,backgroundPreset:null,settings:{...local,
      lighting:{...getPresetLighting('h2c'),exposure:1.6},floor:!expected.floor}};
    const restored=fixture({savedLocal:local,restoring:true});
    restored.context.restoreSettings();restored.context.restoreBackgroundAppearanceCache(saved);
    restored.context.fetch=async()=>{throw new Error('cleared background must not load a printer preset');};
    await restored.context.restoreProjectBackground(saved);
    assert.equal(restored.key(),'scene:'+scene);assert.equal(restored.context.backgroundFile,null);
    assert.equal(restored.studio.backgroundMetadata,null);assert.deepEqual(restored.snapshot(),expected);
    assert.equal(restored.writes.length,0);assert.equal(Object.hasOwn(restored.map(),'preset:h2c'),false);
    assert.equal(restored.get('floor').checked,expected.floor,'restored floor visibility must remain scoped');
  }
});

test('startup without a saved background selects the default H2C and its own appearance',async()=>{
  for(const saved of [null,{modelFiles:[]}]){
    const f=fixture({restoring:true}),requests=[],fetch=f.context.fetch;
    f.edit(4);f.context.fetch=async url=>{requests.push(url);return fetch(url);};
    f.context.restoreBackgroundAppearanceCache(saved);await f.context.restoreProjectBackground(saved);
    assert.deepEqual(requests,[BACKGROUND_PRESETS.h2c.url]);assert.equal(f.key(),'preset:h2c');
    assert.deepEqual(f.snapshot(),normalizeBackgroundAppearance(undefined,'preset:h2c'));
    assert.equal(f.writes.length,0);
  }
});

test('startup restores saved preset files or custom photos using the matching map instead of foreign legacy settings',async()=>{
  const custom=new File(['custom photo'],'own-photo.jpg',{type:'image/jpeg',lastModified:119});
  const cases=[...ids.map(id=>({id,file:new File([id],BACKGROUND_PRESETS[id].label+'.'+BACKGROUND_PRESETS[id].extension,
    {type:BACKGROUND_PRESETS[id].mime,lastModified:100})})),{id:'',file:custom}];
  for(const [index,{id,file}]of cases.entries()){
    const seed=fixture();await seed.context.setBackgroundFile(file,id);const expected=seed.edit(index%5+1),key=seed.key();
    const foreignId=id==='p1s'?'a1':'p1s';
    const local={backgroundPreset:foreignId,scene:'studio',lighting:{...getPresetLighting(foreignId),exposure:1.7},lightingPresetRevision:3,
      dof:{dofEnabled:false,dofStrength:91,dofFocus:83},dofPresetRevision:1,surfacePreset:'petg',surfaceDetail:.1,floor:true};
    const saved={backgroundFile:file,backgroundPreset:id||null,settings:{backgroundAppearances:{[key]:expected}}};
    const restored=fixture({savedLocal:local,restoring:true});
    restored.context.restoreSettings();restored.context.restoreBackgroundAppearanceCache(saved);
    restored.context.fetch=async()=>{throw new Error('saved file should not be fetched again');};
    await restored.context.restoreProjectBackground(saved);
    assert.equal(restored.context.backgroundFile,file);assert.equal(restored.key(),key);
    assert.deepEqual(restored.snapshot(),expected,key+' must ignore legacy settings belonging to '+foreignId);
    assert.equal(restored.writes.length,0);
  }
});

test('legacy global records migrate only to their original preset or custom photo, never unvisited backgrounds',async()=>{
  const f=fixture({restoring:true}),photo=new File(['custom'],'custom.jpg',{type:'image/jpeg',lastModified:88}),
    cachedLegacy={lighting:{...getPresetLighting('p1s'),exposure:.53},lightingPresetRevision:3,
      dof:{dofEnabled:false,dofStrength:47,dofFocus:63},dofPresetRevision:1,surfacePreset:'silk',surfaceDetail:.84,floor:false,grid:true},
    localLegacy={backgroundPreset:'blue-grey',lighting:{...getPresetLighting('blue-grey'),exposure:.71},lightingPresetRevision:3,
      'dof-enabled':true,'dof-strength':'19','dof-focus':'57',dofPresetRevision:1,'surface-preset':'petg','surface-detail':'72',floor:true};
  f.context.restoredSettingsData=localLegacy;
  f.context.restoreBackgroundAppearanceCache({backgroundPreset:'p1s',settings:cachedLegacy});
  assert.deepEqual(Object.keys(f.map()).sort(),['preset:blue-grey','preset:p1s']);
  assert.equal(f.map()['preset:p1s'].lighting.exposure,.53);assert.equal(f.map()['preset:blue-grey'].lighting.exposure,.71);
  await f.preset('teal-room');assert.deepEqual(f.snapshot(),normalizeBackgroundAppearance(undefined,'preset:teal-room'));
  const custom=fixture({restoring:true});custom.context.restoredSettingsData={...localLegacy,backgroundPreset:''};
  custom.context.restoreBackgroundAppearanceCache({backgroundPreset:null,backgroundFile:photo,settings:cachedLegacy});
  const key=backgroundAppearanceKey({file:photo});assert.deepEqual(Object.keys(custom.map()),[key]);
  await custom.photo(photo);assert.equal(custom.snapshot().lighting.exposure,.71);
  custom.context.clearBackgroundUI('paper');assert.deepEqual(custom.snapshot(),normalizeBackgroundAppearance(undefined,'scene:paper'));
});

test('restoring preset lighting updates only the active background record and leaves other manual profiles intact',async()=>{
  const f=fixture();await f.preset('pastel-rug');const original=f.edit(2);
  await f.preset('blue-grey');f.edit(4);
  f.context.applyPresetLighting();f.context.applyPresetDof();f.context.persistSettings();
  assert.deepEqual(f.map()['preset:pastel-rug'],original);
  assert.deepEqual(f.snapshot().lighting,normalizeLighting(getPresetLighting('blue-grey')));
  await f.preset('pastel-rug');assert.deepEqual(f.snapshot(),original);
});

test('restoring custom-photo or plain-background lighting clears its edited DOF without changing other scenes',async()=>{
  const f=fixture();await f.preset('teal-room');const original=f.edit(4);
  const custom=new File(['table'],'table.png',{type:'image/png',lastModified:444});await f.photo(custom);
  f.edit(2);assert.equal(f.snapshot().dof.dofEnabled,true);
  f.context.applyPresetLighting();f.context.applyPresetDof();f.context.persistSettings();
  const expected=normalizeBackgroundAppearance(undefined,f.key());
  assert.deepEqual(f.snapshot().lighting,expected.lighting);assert.deepEqual(f.snapshot().dof,expected.dof);
  assert.deepEqual(f.map()['preset:teal-room'],original);
  f.context.clearBackgroundUI('paper');f.edit(4);assert.equal(f.snapshot().dof.dofEnabled,true);
  f.context.applyPresetLighting();f.context.applyPresetDof();f.context.persistSettings();
  assert.deepEqual(f.snapshot().dof,normalizeDof());
  await f.preset('teal-room');assert.deepEqual(f.snapshot(),original);
});
