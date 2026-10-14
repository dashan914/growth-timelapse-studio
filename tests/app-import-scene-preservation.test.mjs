import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {normalizeBackgroundAppearances} from '../src/background-appearance.js';
import * as THREE from 'three';
import {normalizeLighting,getPresetLighting} from '../src/preset-lighting.js';
import {getPresetDof} from '../src/preset-dof.js';
import {BACKGROUND_PRESETS} from '../src/background-presets.js';
import {selectPresetPlacementSnapshot} from '../src/preset-placement-state.js';

const appSource=await readFile(new URL('../src/app.js',import.meta.url),'utf8');
const appHtml=await readFile(new URL('../index.html',import.meta.url),'utf8');
function actualFunction(name){
  const pattern=new RegExp(`(?:async )?function ${name}\\(`),start=appSource.search(pattern);
  assert.ok(start>=0,`missing app function ${name}`);
  const end=appSource.indexOf('\n}',start)+2;
  assert.ok(end>start);return appSource.slice(start,end);
}
const defaults={modelOffsetX:0,modelOffsetY:0,modelOffsetZ:0,modelRotationX:0,modelRotationY:0,modelRotationZ:0,modelScale:1};
const customPose={modelOffsetX:2.4,modelOffsetY:-.8,modelOffsetZ:1.1,modelRotationX:.14,modelRotationY:.53,modelRotationZ:-.09,modelScale:.73};
const fittedPose={...defaults,modelOffsetX:.13,modelOffsetZ:-.2,modelRotationY:.24,modelScale:1.05};
const lighting={exposure:.83,colorTemperature:6700,keyIntensity:1.3,ambientIntensity:.8,fillIntensity:.4,
  tint:-.1,shadows:.23,highlights:-.13,contrast:.08,saturation:.03,
  shadowOpacity:.22,shadowRadius:6,lightAzimuth:117,lightElevation:57};
const serialized=value=>JSON.parse(JSON.stringify(value));

function fixture({existing=true,mode='mesh',failure=null,cancel=false,engineFailure=null,parseFailure=null,cancelAt=null}={}){
  const nodes=new Map();
  const makeNode=()=>({value:'',checked:false,hidden:false,disabled:false,textContent:'',style:{},attrs:{},children:[],
    classList:{toggle(){}},setAttribute(key,value){this.attrs[key]=value;},addEventListener(){},
    replaceChildren(...children){this.children=children;},append(...children){this.children.push(...children);}});
  const get=id=>{if(!nodes.has(id))nodes.set(id,makeNode());return nodes.get(id);};
  const values={'growth-duration':'8',hold:'0',fps:'30',ratio:'crop',resolution:'1080',format:'mp4','output-appearance':'model','export-quality':'realtime',
    layers:'1600','model-color':'#93aabd','surface-preset':'silk','surface-detail':'82',
    'shadow-opacity':'22','shadow-radius':'6','light-direction':'custom','light-azimuth':'117','light-elevation':'57',
    'dof-strength':'34','dof-focus':'61','bed-width':'330','bed-depth':'320','lighting-exposure':'.83','lighting-temperature':'6700'};
  for(const key of ['tint','shadows','highlights','contrast','saturation'])values['lighting-'+key]=String(lighting[key]);
  for(const [id,value]of Object.entries(values))get(id).value=value;
  for(const id of ['floor','dof-enabled','show-supports','stepped','layer-lines'])get(id).checked=true;
  get('preserve-materials').checked=false;
  const oldMetadata={name:'old.3mf',mode:'mesh',materialColors:[{tool:0,color:'#abcdef',source:'file'}]};
  const camera={position:[3,4,5],target:[1,2,1],up:[.02,.99,.01],fov:47};
  const calls={resets:0,calibration:0,views:[],renders:[],cached:[],queued:0,complete:0,failed:0,cancelled:0,loadOptions:[],loadFiles:[],requests:[],phases:[],order:[],messages:[],placements:[],presentation:[],visibleFrames:[],persisted:[]};
  let presentationDepth=0;
  let committed=false;
  const studio={options:{...customPose},metadata:oldMetadata,camera,backgroundMetadata:{width:4000,height:3000},
    controls:{enabled:false},transform:{enabled:false},canvas:{style:{pointerEvents:'auto'}},
    hasModel:()=>existing||committed,
    beginSceneUpdate(){presentationDepth++;calls.presentation.push('begin');},
    endSceneUpdate(){assert.ok(presentationDepth>0);presentationDepth--;calls.presentation.push('end');if(!presentationDepth)calls.visibleFrames.push(serialized(this.options));},
    async loadFiles(files,options){
      assert.equal(presentationDepth,1,'source adoption is hidden until the final scene is composed');
      calls.loadOptions.push(options);
      calls.loadFiles.push(files);calls.order.push('adopt-original');
      if(cancel)context.importController.abort();
      if(failure)throw new Error(failure);
      if(cancel)throw new DOMException('Aborted','AbortError');
      committed=true;
      this.metadata={name:'new.3mf',mode,format:'3mf',meshes:14,layers:1580,layerHeightMm:.16,surfaceOverrideSupported:true,
        materialColors:[{tool:0,color:'#f0e8d6',source:'file'},{tool:1,color:'#23599c',source:'file'}]};
    },
    applyPrinterPlacement(profile){
      assert.equal(profile,BACKGROUND_PRESETS[context.backgroundPreset].placement);
      assert.equal(presentationDepth,1,'placement finishes before revealing the committed model');
      calls.placements.push(profile);this.setOptions(fittedPose);return {...fittedPose};
    },
    setOptions(options){Object.assign(this.options,options);},resetCamera(){calls.resets++;camera.fov=36;},
    setTransformMode(){},lockPreviewCamera(){this.controls.enabled=false;}};
  const crop={x:.12,y:.05,width:.77,height:.81,sourceAspect:4/3};
  const calibration={points:[{x:.1,y:.4},{x:.7,y:.3},{x:.9,y:.8},{x:.05,y:.95}],bedWidth:330,bedDepth:320};
  const source={hasCad:true,cadPreviewFile:new File(['cad'],'new.3mf'),parsed:{sentinel:'new native paths',usedTools:[0,1],toolColors:['#f0e8d6','#23599c']},
    usedTools:[0,1],toolColors:{0:'#f0e8d6',1:'#23599c'},sourceHash:'new-source-sha',gcodeHash:'original-gcode-sha',gcodeBytesLength:99,archiveEntry:'Metadata/plate_1.gcode'};
  const job={id:'01234567-89ab-cdef-0123-456789abcdef',status:'complete',sourceSha256:source.sourceHash,gcodeSha256:source.gcodeHash,
    gcodeBytes:99,engineId:'bambu',engine:'Bambu Studio CLI',engineRevision:'bambu-studio-test-original-v1',reSliced:true,printerToSource:[...new THREE.Matrix4().makeRotationX(-Math.PI/2).elements],
    toolColors:['#f0e8d6','#23599c'],sliceSettings:{layerHeightMm:.16},sourceCoordinateSystem:'printer-z-up'};
  const context=vm.createContext({studio,$:get,document:{createElement:makeNode},THREE,LOCAL_SLICE_CLIENT_REVISION:'local-slicer-original-mesh-v2',
    DEFAULT_MODEL_POSE:defaults,printerPresets:BACKGROUND_PRESETS,SURFACE_PRESETS:['auto','pla','matte','silk','petg'],
    modelColorFields:['tint','shadows','highlights','contrast','saturation'],normalizeLighting,lightingProfile:normalizeLighting(lighting),
    sceneColors:{studio:'#30333a'},scene:'studio',cropRect:crop,customSoundFile:null,exporting:false,snapshotting:false,calibrationMode:false,cropEditing:false,
    loading:false,playing:false,time:3,importController:null,sliceController:null,slicingRuntime:null,importInteractionState:null,importSequence:0,cacheTimer:null,restoringProject:false,reducedMotion:true,
    importProgressUI:{begin(){},update(event){calls.phases.push(serialized(event));},complete(){calls.complete++;},fail(){calls.failed++;},cancelled(){calls.cancelled++;}},
    AbortController,DOMException,clearTimeout,requestAnimationFrame:fn=>fn(),PRINTER_MM_TO_THREE_MM:{},
    modelRevision:7,sliceReadyJob:{old:true},modelSourceKey:'old-source',posePlacement:null,modelFile:{name:'old.3mf'},backgroundPreset:'h2c',
    async api(route,options){calls.requests.push({route,options});
      if(route==='/api/health')return{slicing:{available:true,engineId:'bambu',engine:'Bambu Studio CLI',engineRevision:job.engineRevision}};
      if(route.startsWith('/api/slices?')){calls.order.push('native-slice');return{id:job.id,status:'running'};}
      if(options?.method==='DELETE')return{status:'cancelled'};
      throw new Error('unexpected route '+route);
    },
    async waitForSlice({id,signal,onSnapshot}){
      assert.equal(id,job.id);assert.equal(signal,context.importController.signal);
      onSnapshot({phase:'slicing',progress:89,nativeProgress:null,message:'本机计算…'});
      if(cancelAt==='slice'){context.importController.abort();throw new DOMException('Aborted','AbortError');}
      return engineFailure?{status:'failed',message:engineFailure}:job;
    },
    async parsePrintLayersInWorker(route,{signal,onPhase}){
      calls.order.push('parse-native');assert.equal(route,`/api/slices/${job.id}/gcode`);assert.equal(signal,context.importController.signal);
      onPhase('parsing');
      if(cancelAt==='parse'){context.importController.abort();throw new DOMException('Aborted','AbortError');}
      if(parseFailure)throw new Error(parseFailure);return source.parsed;
    },
    manualSupportFile:{name:'old-support'},manualSupportMapping:{old:true},toolColors:{0:'#ff00ff',3:'#00ff00'},transformMode:'rotate',activeCalibration:calibration,
    lockWorkspace(){},say(message){calls.messages.push(message);},setModelMode(value){context.transformMode=value;},syncSourceUnitControls(){},updateSupportUI(){},
    syncCameraFields(){},markView(view){calls.views.push(view);},applyActiveCamera(){calls.calibration++;camera.fov=52;},
    cachePatch(value){calls.cached.push(value);},queueProjectState(){calls.queued++;},showTime(){},
    persistSettings(){
      if(context.loading||context.restoringProject)return;
      calls.presentation.push('persist');calls.persisted.push({pose:serialized(context.modelPose()),posePlacement:serialized(context.posePlacement),modelSourceKey:context.modelSourceKey});
    },
    updateSettings(){const options=context.renderOptions();calls.renders.push(serialized(options));studio.setOptions(options);context.persistSettings();}});
  vm.runInContext(['modelPose','surfaceSettings','restoreSurfaceControls','settings','lightingSettings','renderOptions','showMetadata','nativeSliceProgress','syncDetectedSlicer','prepareLocalModelSlice','applyPresetModelPlacement','loadModel'].map(actualFunction).join('\n'),context);
  return{context,studio,get,calls,crop,calibration,oldMetadata,source,job};
}

test('printer replacement refits the new model while preserving camera, crop, material preference, lighting and optical controls',async()=>{
  const f=fixture(),before=serialized(f.context.renderOptions()),camera=serialized(f.studio.camera);
  assert.equal(await f.context.loadModel([new File(['slice'],'new.3mf')]),true);
  const after=serialized(f.context.renderOptions());
  for(const key of Object.keys(before).filter(key=>key!=='toolColors'&&!Object.hasOwn(defaults,key)))assert.deepEqual(after[key],before[key],key);
  assert.deepEqual(serialized(f.context.modelPose()),fittedPose);
  assert.equal(f.calls.placements.length,1);
  assert.deepEqual(serialized(f.context.posePlacement),{preset:'h2c',revision:BACKGROUND_PRESETS.h2c.placement.revision,modelSourceKey:f.job.sourceSha256});
  assert.deepEqual(serialized(f.studio.camera),camera);
  assert.equal(f.context.cropRect,f.crop);assert.equal(f.context.activeCalibration,f.calibration);
  assert.equal(f.calls.resets,0);assert.equal(f.calls.calibration,0);assert.deepEqual(f.calls.views,[]);
  assert.equal(f.calls.loadOptions[0].preserveScene,true,'studio receives the same replacement policy');
  assert.equal(f.get('preserve-materials').checked,false);
  assert.equal(f.get('surface-preset').value,'silk');assert.equal(f.get('surface-detail').value,82);
  assert.deepEqual(after.toolColors,{'0':'#f0e8d6','1':'#23599c'},'old-file overrides must not leak into the new palette');
  assert.deepEqual(serialized(f.studio.options.toolColors),after.toolColors);
  assert.equal(f.calls.complete,1);assert.equal(f.calls.failed,0);assert.equal(f.calls.queued,1);
  assert.equal(f.studio.canvas.style.pointerEvents,'auto');
});

test('all printer replacements fit the current preset and reveal only the final pose',async()=>{
  for(const id of ['h2c','p1s','a1']){
    const f=fixture();f.context.backgroundPreset=id;
    assert.equal(await f.context.loadModel([new File(['complete original'],'replacement.3mf')]),true);
    assert.equal(f.calls.placements[0],BACKGROUND_PRESETS[id].placement);
    assert.deepEqual(f.calls.presentation,['begin','persist','end']);
    assert.equal(f.calls.visibleFrames.length,1);
    assert.deepEqual(serialized(f.context.modelPose(f.calls.visibleFrames[0])),fittedPose);
    assert.equal(f.calls.persisted.length,1,'temporary default pose during loading is not saved');
    assert.deepEqual(f.calls.persisted[0].pose,fittedPose);
    assert.deepEqual(f.calls.persisted[0].posePlacement,{preset:id,revision:BACKGROUND_PRESETS[id].placement.revision,modelSourceKey:f.job.sourceSha256});
    assert.equal(f.calls.persisted[0].modelSourceKey,f.job.sourceSha256);
  }
});

test('replacement in a custom photograph or plain scene retains the composed pose',async()=>{
  for(const id of ['', 'custom']){
    const f=fixture();f.context.backgroundPreset=id;
    f.context.posePlacement={preset:'h2c',revision:BACKGROUND_PRESETS.h2c.placement.revision,modelSourceKey:'old-source'};
    const before=serialized(f.context.renderOptions()),camera=serialized(f.studio.camera);
    assert.equal(await f.context.loadModel([new File(['complete original'],'replacement.3mf')]),true);
    assert.deepEqual(serialized(f.context.modelPose()),customPose);assert.equal(f.calls.placements.length,0);
    assert.equal(f.context.posePlacement,null,'an old printer marker must not misidentify the preserved custom-scene pose');
    assert.deepEqual(serialized(f.studio.camera),camera);assert.equal(f.context.cropRect,f.crop);
    const after=serialized(f.context.renderOptions());
    for(const field of Object.keys(before).filter(field=>field!=='toolColors'))assert.deepEqual(after[field],before[field],field);
  }
});

test('production persistence refuses temporary loading poses before touching local storage or appearance state',()=>{
  const f=fixture();vm.runInContext(actualFunction('persistSettings'),f.context);
  f.context.loading=true;
  f.context.rememberBackgroundAppearance=()=>assert.fail('loading must not capture a temporary appearance');
  f.context.localStorage={setItem(){assert.fail('loading must not write a temporary local pose');}};
  f.studio.setOptions(defaults);f.context.updateSettings();
  assert.equal(f.calls.queued,0);
});

test('a failed printer fit on first import or replacement releases presentation without saving a false success',async()=>{
  for(const existing of [false,true]){
    const f=fixture({existing});
    if(existing)f.context.posePlacement={preset:'h2c',revision:BACKGROUND_PRESETS.h2c.placement.revision,modelSourceKey:'old-source'};
    f.studio.applyPrinterPlacement=()=>null;
    assert.equal(await f.context.loadModel([new File(['complete original'],'replacement.3mf')]),false);
    assert.equal(f.calls.complete,0);assert.equal(f.calls.failed,1);
    assert.equal(f.calls.cached.length,0);assert.equal(f.calls.persisted.length,0);assert.equal(f.calls.queued,0);
    assert.notEqual(f.context.posePlacement?.modelSourceKey,f.job.sourceSha256,'failed fit cannot mark this source as successfully composed');
    assert.match(f.calls.messages.at(-1),/模型构图未完成/);
    assert.deepEqual(f.calls.presentation,['begin','end']);assert.equal(f.context.loading,false);
    assert.equal(f.studio.canvas.style.pointerEvents,'auto');
  }
});

test('photography backgrounds survive model imports while native slicing receives a real printer preset',async t=>{
  for(const key of ['pastel-rug','blue-grey','teal-room'])for(const format of ['3mf','stl'])await t.test(key+' / '+format,async()=>{
    const f=fixture(),preset=BACKGROUND_PRESETS[key],dof=getPresetDof(key),profile=getPresetLighting(key);
    f.context.backgroundPreset=key;
    f.context.posePlacement={preset:key,revision:preset.placement.revision,modelSourceKey:'old-source'};
    f.context.backgroundFile=new File(['background PNG'],key+'.png',{type:'image/png'});
    f.context.activeCalibration={...f.calibration,bedWidth:preset.width,bedDepth:preset.depth,photoKey:'preset:'+key};
    f.context.lightingProfile=normalizeLighting(profile);
    f.get('bed-width').value=String(preset.width);f.get('bed-depth').value=String(preset.depth);
    f.get('lighting-exposure').value=String(profile.exposure);f.get('lighting-temperature').value=String(profile.colorTemperature);
    f.get('shadow-opacity').value=String(profile.shadowOpacity*100);f.get('shadow-radius').value=String(profile.shadowRadius);
    f.get('light-azimuth').value=String(profile.lightAzimuth);f.get('light-elevation').value=String(profile.lightElevation);
    for(const field of ['tint','shadows','highlights','contrast','saturation'])f.get('lighting-'+field).value=String(profile[field]);
    f.get('dof-enabled').checked=dof.dofEnabled;f.get('dof-strength').value=String(dof.dofStrength);f.get('dof-focus').value=String(dof.dofFocus);
    const before=serialized(f.context.renderOptions()),camera=serialized(f.studio.camera),background=f.context.backgroundFile,calibration=f.context.activeCalibration;
    const file=new File(['complete original model'],'replacement.'+format);
    // A cached scene ID is not a supported native machine/profile selection.
    assert.equal(await f.context.loadModel([file],false,format==='stl'?{preset:key,resliceExisting:true}:{}),true);
    const upload=f.calls.requests.find(item=>item.options?.method==='POST');
    const options=JSON.parse(new URL(upload.route,'http://localhost').searchParams.get('options'));
    assert.equal(options.preset,'h2c');assert.equal(options.format,format);assert.equal(upload.options.body,file);
    assert.equal(f.context.sliceReadyJob.preset,'h2c');assert.equal(f.context.backgroundPreset,key);
    assert.equal(f.context.backgroundFile,background);assert.equal(background.type,'image/png');
    assert.equal(f.context.cropRect,f.crop);assert.equal(f.context.activeCalibration,calibration);
    assert.deepEqual(serialized(f.studio.camera),camera);assert.equal(f.calls.resets,0);assert.equal(f.calls.calibration,0);
    const after=serialized(f.context.renderOptions());
    for(const field of Object.keys(before).filter(field=>field!=='toolColors'))assert.deepEqual(after[field],before[field],field);
    assert.equal(f.calls.loadOptions[0].preserveScene,true);assert.equal(f.calls.complete,1);assert.equal(f.calls.failed,0);
    assert.deepEqual(serialized(f.context.posePlacement),{preset:key,revision:preset.placement.revision,modelSourceKey:f.job.sourceSha256});
    const snapshot=selectPresetPlacementSnapshot({local:{...f.calls.persisted.at(-1),backgroundPreset:key,poseUpdatedAt:200},
      preset:key,modelSourceKey:f.job.sourceSha256});
    assert.ok(snapshot,'preserved photo pose remains restorable after its source model changes');
    assert.deepEqual(snapshot.pose,customPose);
  });
});

test('support appearance stays solid after restoring a legacy paths preference without losing the filament palette or visibility choice',()=>{
  const f=fixture();
  Object.assign(f.context,{normalizeBackgroundAppearances,backgroundAppearances:{},restoredSettingsData:null});
  assert.doesNotMatch(appHtml,/id=["']support-display["']/);
  assert.match(appHtml,/id=["']show-supports["']/);
  const settingDeclaration=appSource.match(/^const settingIds = .*;$/m)?.[0];
  assert.ok(settingDeclaration);
  vm.runInContext(settingDeclaration+'\n'+actualFunction('restoreSettings')+'\n'+actualFunction('realisticEligibility'),f.context);
  f.context.localStorage={getItem:key=>key==='growth-studio-settings-v4'?JSON.stringify({'support-display':'paths','show-supports':false}):null};
  f.context.printerPresets={};
  f.context.realisticRuntime={available:true};
  f.context.realisticExportAvailability=options=>options;
  f.get('show-supports').type='checkbox';
  f.context.$=id=>{assert.notEqual(id,'support-display','removed control must not be read or restored');return f.get(id);};
  const originalPalette=serialized(f.context.toolColors);
  f.context.restoreSettings();
  assert.equal(vm.runInContext("settingIds.includes('support-display')",f.context),false);
  assert.equal(f.context.renderOptions().supportDisplay,'solid');
  assert.equal(f.context.realisticEligibility().supportDisplay,'solid');
  assert.equal(f.context.renderOptions().showSupports,false);
  assert.deepEqual(serialized(f.context.renderOptions().toolColors),originalPalette);
  assert.equal(f.context.renderOptions().preserveMaterials,false,'global color preference is preserved');
});

test('model rendering is fixed even when a legacy photo appearance survives in an internal control',()=>{
  const f=fixture();
  assert.doesNotMatch(appHtml,/<label[^>]+for=["']output-appearance["']/);
  assert.match(appHtml,/<select id="output-appearance" hidden aria-hidden="true" tabindex="-1">/);
  assert.doesNotMatch(appSource,/saved\.settings\.outputAppearance==='photo'/,'old project photo appearance is not adopted');
  f.get('output-appearance').value='photo';
  assert.equal(f.context.settings().appearance,'model');
  assert.equal(f.context.renderOptions().outputAppearance,'model');
  assert.equal(f.context.renderOptions().dofEnabled,true,'obsolete appearance cannot disable model depth of field');
  assert.equal(f.get('show-supports').checked,true);
});

test('path-only 3MF cannot replace the source model or reuse its embedded G-code',async()=>{
  const f=fixture({engineFailure:'3MF 只有打印路径，没有可重新切片的原模型网格。'});
  assert.equal(await f.context.loadModel([new File(['paths-only'],'new.3mf')]),false);
  assert.equal(f.studio.metadata,f.oldMetadata);assert.equal(f.calls.loadFiles.length,0);
  assert.equal(f.calls.cached.length,0);assert.equal(f.calls.complete,0);
});

test('first successful import still initializes pose, source colors and the selected bed calibration',async()=>{
  const f=fixture({existing:false});
  f.get('surface-preset').value='auto';
  assert.equal(await f.context.loadModel([new File(['slice'],'first.3mf')]),true);
  assert.deepEqual(serialized(f.context.modelPose()),fittedPose);
  assert.equal(f.calls.placements.length,1);
  assert.equal(f.get('preserve-materials').checked,true);assert.equal(f.get('surface-preset').value,'auto');
  assert.equal(f.calls.resets,1);assert.equal(f.calls.calibration,1);assert.deepEqual(f.calls.views,['perspective']);
  assert.equal(f.calls.loadOptions[0].preserveScene,false);
  assert.equal(f.get('bed-width').value,330);assert.equal(f.get('bed-depth').value,320);
});

test('first photography import places the completed model after camera calibration; cache restoration preserves saved pose',async()=>{
  for(const restoring of [false,true]){
    const f=fixture({existing:false});f.context.backgroundPreset='pastel-rug';f.context.restoringProject=restoring;
    let placements=0;
    f.studio.applyPhotographyPlacement=profile=>{
      assert.equal(profile,BACKGROUND_PRESETS['pastel-rug'].placement);assert.equal(f.calls.calibration,1);
      placements++;f.studio.setOptions({modelScale:1.4,modelRotationY:.7});return {};
    };
    assert.equal(await f.context.loadModel([new File(['original'],'reference.3mf')]),true);
    assert.equal(placements,restoring?0:1);assert.equal(f.studio.options.modelScale,restoring?1:1.4);
  }
});

test('surface choice made before a first import is retained for the original mesh',async()=>{
  const f=fixture({existing:false});
  assert.equal(await f.context.loadModel([new File(['slice'],'first.3mf')]),true);
  assert.equal(f.get('surface-preset').value,'silk');
});

test('actual workspace lock exposes supported path material presets without adding duplicate surface detail',()=>{
  const f=fixture();
  f.context.document.querySelectorAll=()=>[];
  f.context.referenceAnalysis=null;
  f.context.updateExportQualityUI=()=>{};
  f.studio.getPrintLayerData=()=>({});
  vm.runInContext(actualFunction('lockWorkspace'),f.context);
  f.studio.metadata={mode:'gcode',surfaceOverrideSupported:true};
  f.context.lockWorkspace(false);
  assert.equal(f.get('surface-preset').disabled,false);
  assert.equal(f.get('surface-detail').disabled,true);
  f.studio.metadata={mode:'gcode',surfaceOverrideSupported:false};
  f.context.lockWorkspace(false);
  assert.equal(f.get('surface-preset').disabled,true);
  assert.equal(f.get('surface-detail').disabled,true);
  f.studio.metadata={mode:'mesh',surfaceOverrideSupported:true};
  f.context.lockWorkspace(false);
  assert.equal(f.get('surface-preset').disabled,false);
  assert.equal(f.get('surface-detail').disabled,false);
  assert.equal(f.get('surface-preset').value,'silk','locking only changes availability, not the chosen preset');
});

test('failed and cancelled replacement keep the old scene and palette and never persist a new model',async t=>{
  for(const options of [{failure:'unsupported source'},{cancel:true}])await t.test(options.cancel?'cancellation':'failure',async()=>{
    const f=fixture(options),before=serialized(f.context.renderOptions()),camera=serialized(f.studio.camera);
    assert.equal(await f.context.loadModel([new File(['slice'],'new.3mf')]),false);
    assert.deepEqual(serialized(f.context.renderOptions()),before);assert.deepEqual(serialized(f.studio.camera),camera);
    assert.equal(f.studio.metadata,f.oldMetadata);assert.equal(f.context.modelFile.name,'old.3mf');
    assert.equal(f.context.modelSourceKey,'old-source');assert.equal(f.context.modelRevision,7);
    assert.equal(f.calls.complete,0);assert.equal(f.calls.cached.length,0);assert.equal(f.calls.queued,0);
    assert.equal(f.calls.failed,options.cancel?0:1);assert.equal(f.calls.cancelled,options.cancel?1:0);
    assert.equal(f.context.loading,false);assert.equal(f.studio.canvas.style.pointerEvents,'auto');
    assert.deepEqual(f.calls.presentation,['begin','end']);assert.equal(f.calls.persisted.length,0);
    assert.equal(f.calls.visibleFrames.length,1);assert.deepEqual(serialized(f.context.modelPose(f.calls.visibleFrames[0])),customPose);
  });
});

test('original 3MF bytes are sliced by the local Bambu bridge before original mesh and new parsed paths commit atomically',async()=>{
  const f=fixture(),file=new File(['original mesh, paint, settings and stale embedded G-code'],'engineering.3mf');
  assert.equal(await f.context.loadModel([file]),true);
  assert.deepEqual(f.calls.order,['native-slice','parse-native','adopt-original']);
  const upload=f.calls.requests.find(item=>item.options?.method==='POST');
  assert.equal(upload.options.body,file);assert.equal(upload.options.headers['Content-Type'],'application/octet-stream');
  const options=JSON.parse(new URL(upload.route,'http://localhost').searchParams.get('options'));
  assert.equal(options.format,'3mf');assert.equal(options.sourceName,file.name);assert.equal(options.preset,'h2c');
  assert.equal(options.engineId,'auto','the user never has to pick an installed engine');
  assert.equal(options.sourceCoordinateSystem,'printer-z-up');assert.deepEqual(options.sourceToPrinter,new THREE.Matrix4().elements);
  assert.equal(Object.hasOwn(options,'toolColors'),false,'original project paint is not overwritten with display overrides');
  assert.equal(f.calls.loadFiles.length,1);assert.equal(f.calls.loadFiles[0][0],file,'G-code never replaces the source mesh');
  assert.equal(f.calls.loadOptions[0].parsedPrintGCode,f.source.parsed);
  assert.equal(f.calls.loadOptions[0].printerToSource,f.job.printerToSource,'native mapping already includes the source axis conversion');
  assert.equal(f.calls.loadOptions[0].sliceSettings,f.job.sliceSettings);
  assert.equal(f.context.sliceReadyJob.engineRevision,f.job.engineRevision);
  assert.equal(f.context.sliceReadyJob.clientRevision,'local-slicer-original-mesh-v2');
  assert.equal(f.context.sliceReadyJob.engineId,'bambu');
  assert.equal(f.context.sliceReadyJob.reSliced,true);assert.equal(f.context.sliceReadyJob.old,undefined);
  assert.equal(f.studio.metadata.originalCadAvailable,true);assert.equal(f.studio.metadata.sliceSourceMode,'local-native-slicer');
});

test('STL unit overrides and source coordinates are explicit while source bytes, current camera and material choices survive reslicing',async()=>{
  const f=fixture(),file=new File(['full raw STL'],'model.stl'),before=serialized(f.context.renderOptions());
  assert.equal(await f.context.loadModel([file],false,{sourceUnits:10,preset:'p1s',resliceExisting:true}),true);
  const upload=f.calls.requests.find(item=>item.options?.method==='POST');
  const options=JSON.parse(new URL(upload.route,'http://localhost').searchParams.get('options'));
  assert.equal(upload.options.body,file);assert.equal(options.format,'stl');assert.equal(options.preset,'p1s');
  assert.deepEqual(options.sourceToPrinter,new THREE.Matrix4().makeScale(10,10,10).elements);
  assert.deepEqual(options.toolColors,['#93aabd']);
  assert.equal(f.calls.loadFiles[0][0],file);assert.equal(f.calls.loadOptions[0].sourceUnitMillimetres,10);
  assert.deepEqual(serialized(f.context.toolColors),{'0':'#ff00ff','1':'#23599c','3':'#00ff00'});
  assert.deepEqual(serialized(f.context.modelPose()),customPose);assert.equal(f.calls.resets,0);
  assert.equal(f.calls.placements.length,0,'unit correction reslices the existing model without resetting its composition');
  assert.equal(f.get('preserve-materials').checked,before.preserveMaterials);
});

test('native progress reports only measured engine or byte counts, ignoring historical weighted progress estimates',()=>{
  const f=fixture();
  assert.equal(f.context.nativeSliceProgress({phase:'slicing',progress:89}).progress,null);
  assert.equal(f.context.nativeSliceProgress({phase:'slicing',nativeProgress:42}).progress,.42);
  assert.equal(f.context.nativeSliceProgress({phase:'indexing',completed:10,total:20}).completed,10);
  for(const nativeProgress of [null,NaN,Infinity,-1,101,'42'])assert.equal(f.context.nativeSliceProgress({nativeProgress}).progress,null);
});

test('native and parser failure or cancellation cannot replace the current project or cache partial results',async t=>{
  for(const options of [{engineFailure:'Bambu切片失败'},{parseFailure:'路径损坏'},{cancelAt:'slice'},{cancelAt:'parse'}]){
    await t.test(JSON.stringify(options),async()=>{
      const f=fixture(options),before=serialized(f.context.renderOptions());
      assert.equal(await f.context.loadModel([new File(['mesh'],'replacement.3mf')]),false);
      assert.equal(f.studio.metadata,f.oldMetadata);assert.equal(f.calls.loadFiles.length,0);
      assert.deepEqual(serialized(f.context.renderOptions()),before);assert.equal(f.context.modelRevision,7);
      assert.equal(f.context.modelFile.name,'old.3mf');assert.equal(f.context.modelSourceKey,'old-source');
      assert.equal(f.calls.cached.length,0);assert.equal(f.calls.queued,0);
      assert.equal(f.calls.requests.filter(item=>item.options?.method==='DELETE').length,1,'native cleanup uses a separate non-aborted request');
      assert.equal(f.context.importController,null);assert.equal(f.context.sliceController,null);assert.equal(f.context.loading,false);
      assert.equal(f.studio.canvas.style.pointerEvents,'auto');
      assert.deepEqual(f.calls.presentation,['begin','end']);assert.equal(f.calls.persisted.length,0);
      assert.equal(f.calls.visibleFrames.length,1);assert.deepEqual(serialized(f.context.modelPose(f.calls.visibleFrames[0])),customPose);
    });
  }
});

test('busy imports require cancellation; a late cancelled native result cannot commit before the next source import',async()=>{
  const f=fixture();let firstResolve=null,posts=0;
  const firstId='01234567-89ab-cdef-0123-456789abcde1',secondId='01234567-89ab-cdef-0123-456789abcde2';
  f.context.api=async(route,options)=>{
    f.calls.requests.push({route,options});
    if(route==='/api/health')return{slicing:{available:true,engineId:'bambu',engine:'Bambu Studio CLI',engineRevision:f.job.engineRevision}};
    if(route.startsWith('/api/slices?'))return{id:++posts===1?firstId:secondId,status:'running'};
    return{status:'cancelled'};
  };
  f.context.waitForSlice=async({id})=>id===firstId?new Promise(resolve=>{firstResolve=resolve;}):{...f.job,id};
  f.context.parsePrintLayersInWorker=async()=>f.source.parsed;
  const older=f.context.loadModel([new File(['first'],'first.3mf')]);
  for(let i=0;i<20&&!firstResolve;i++)await Promise.resolve();assert.ok(firstResolve);
  const latest=new File(['second'],'second.3mf');assert.equal(await f.context.loadModel([latest]),false);
  assert.equal(posts,1,'a busy import cannot spawn a second native process');
  f.context.importController.abort();firstResolve({...f.job,id:firstId});assert.equal(await older,false);
  assert.equal(f.calls.loadFiles.length,0);assert.equal(f.studio.canvas.style.pointerEvents,'auto');
  assert.equal(await f.context.loadModel([latest]),true,f.calls.messages.join('\n'));
  assert.equal(f.calls.loadFiles.length,1);assert.equal(f.calls.loadFiles[0][0],latest);
  assert.equal(f.context.modelFile,latest);assert.equal(f.context.modelRevision,8);
  assert.equal(f.calls.cached.length,1);assert.equal(f.studio.canvas.style.pointerEvents,'auto');
  assert.ok(f.calls.requests.some(item=>item.route===`/api/slices/${firstId}`&&item.options?.method==='DELETE'));
  assert.equal(f.calls.requests.some(item=>item.route===`/api/slices/${secondId}`&&item.options?.method==='DELETE'),false);
});

test('unsupported mesh formats are rejected clearly without importing arbitrary G-code or starting a native task',async()=>{
  for(const name of ['model.gcode','model.obj','model.glb','model.gltf','model.fbx']){
    const f=fixture();assert.equal(await f.context.loadModel([new File(['bytes'],name)]),false);
    assert.equal(f.calls.requests.length,0);assert.equal(f.studio.metadata,f.oldMetadata);
  }
});

test('automatic detection records the engine actually used, including an installation change after preflight',async()=>{
  const f=fixture();f.job.engineId='flash';f.job.engine='Flash Studio CLI';f.job.engineRevision='flash-test-original-v1';
  const originalApi=f.context.api;
  f.context.api=async(route,options)=>route==='/api/health'?{slicing:{available:true,engineId:'bambu',engine:'Bambu Studio CLI',engineRevision:'bambu-before-installation-change'}}:originalApi(route,options);
  assert.equal(await f.context.loadModel([new File(['original'],'original.3mf')]),true);
  assert.equal(f.context.sliceReadyJob.engineId,'flash');assert.equal(f.context.sliceReadyJob.engineRevision,'flash-test-original-v1');
  assert.equal(f.studio.metadata.localSlice.engine,'Flash Studio CLI');
  const upload=f.calls.requests.find(item=>item.options?.method==='POST');
  assert.equal(JSON.parse(new URL(upload.route,'http://localhost').searchParams.get('options')).engineId,'auto');
});

test('no installed engine or stale embedded results cannot masquerade as a new native slice',async()=>{
  for(const invalid of ['unavailable','embedded','unknown-engine','missing-revision']){
    const f=fixture();
    if(invalid==='unavailable')f.context.api=async()=>({slicing:{available:false,engineId:null,engines:[]}});
    if(invalid==='embedded')f.job.reSliced=false;
    if(invalid==='unknown-engine')f.job.engineId='remote-wasm';
    if(invalid==='missing-revision')delete f.job.engineRevision;
    assert.equal(await f.context.loadModel([new File(['original'],'original.3mf')]),false,invalid);
    assert.equal(f.studio.metadata,f.oldMetadata);assert.equal(f.calls.loadFiles.length,0);assert.equal(f.calls.cached.length,0);
  }
});
