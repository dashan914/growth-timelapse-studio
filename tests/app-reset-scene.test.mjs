import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import * as THREE from 'three';
import {GrowthStudio} from '../src/studio.js';
import {BACKGROUND_PRESETS} from '../src/background-presets.js';
import {normalizeLighting} from '../src/preset-lighting.js';
import {outputSize} from '../src/timeline.js';
import {outputFormat} from '../src/output-format.js';
import {getPresetCalibration} from '../src/preset-calibrations.js';
import {solvePlanarCamera} from '../src/calibration.js';
import {printerModelYaw,printerPatternGroundPoint} from '../src/printer-placement.js';
import {selectPresetPlacementSnapshot,needsPresetPlacementUpgrade} from '../src/preset-placement-state.js';

const source=await readFile(new URL('../src/app.js',import.meta.url),'utf8');
function actualFunction(name){
  const start=source.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start>=0,`missing app function ${name}`);
  const end=source.indexOf('\n}',start)+2;
  assert.ok(end>start);return source.slice(start,end);
}
const defaults={modelOffsetX:0,modelOffsetY:0,modelOffsetZ:0,modelRotationX:0,modelRotationY:0,modelRotationZ:0,modelScale:1};
const editedPose={modelOffsetX:2.3,modelOffsetY:-.7,modelOffsetZ:1.4,modelRotationX:.19,modelRotationY:-1.2,modelRotationZ:.08,modelScale:.61};
const clone=value=>JSON.parse(JSON.stringify(value));
const presetIds=Object.keys(BACKGROUND_PRESETS);

function fixture({id='blue-grey',hasModel=true,background=true,calibrated=background,cropEditing=true,calibrationMode=false}={}){
  const nodes=new Map(),events=[],saved=[],queued=[],placements=[];
  function get(key){
    if(!nodes.has(key)){
      const node={value:'',checked:false,hidden:false,disabled:false,textContent:'',innerHTML:'',style:{},attributes:{},
        classList:{toggle(){}},setAttribute(name,value){this.attributes[name]=String(value);},removeAttribute(name){delete this.attributes[name];}};
      Object.defineProperties(node,{clientWidth:{get(){return parseFloat(this.style.width)||900;}},clientHeight:{get(){return parseFloat(this.style.height)||600;}}});
      nodes.set(key,node);
    }
    return nodes.get(key);
  }
  const fields={'growth-duration':'8',hold:'1',fps:'30',ratio:'crop',resolution:'1080',format:'mp4','export-quality':'realistic',
    layers:'1600','model-color':'#bc625b','surface-preset':'silk','surface-detail':'82',
    'shadow-opacity':'27','shadow-radius':'5.3','light-direction':'custom','light-azimuth':'117','light-elevation':'57',
    'dof-strength':'34','dof-focus':'61','bed-width':'180','bed-depth':'140','lighting-exposure':'.83','lighting-temperature':'6700',
    'lighting-tint':'-.1','lighting-shadows':'.23','lighting-highlights':'-.13','lighting-contrast':'.08','lighting-saturation':'.03'};
  for(const [key,value]of Object.entries(fields))get(key).value=value;
  for(const key of ['floor','dof-enabled','stepped','layer-lines'])get(key).checked=true;
  get('preserve-materials').checked=true;get('show-supports').checked=false;
  get('stage').style={width:'900px',height:'506px'};
  get('frame-ratio').textContent='自定义裁剪';
  get('canvas-tools').hidden=true;
  get('crop-overlay').hidden=false;

  // A complete source mesh with asymmetric head and tail coordinates. Fitting
  // uses the actual studio placement methods, with no renderer or GPU fixture.
  const geometry=new THREE.BufferGeometry();
  geometry.setAttribute('position',new THREE.Float32BufferAttribute([
    -4,.6,-2, 4,.6,2, -3,7,-1, 1,5,1, 5,2,-2,
  ],3));
  const mesh=new THREE.Mesh(geometry,new THREE.MeshStandardMaterial());
  const studio=Object.create(GrowthStudio.prototype);
  studio.modelGroup=new THREE.Group();studio.modelGroup.add(mesh);
  studio._meshes=[mesh];studio._supportMeshes=new Set();studio.orientation=new THREE.Group();
  studio.normalized=new THREE.Group();studio.normalized.scale.setScalar(.08);
  studio.orientation.quaternion.setFromEuler(new THREE.Euler(.2,.3,-.4));
  studio._normalize=()=>events.push('normalize');studio._extendSupportBounds=()=>{};
  studio.options={...editedPose,progress:.35};
  Object.defineProperty(studio,'metadata',{value:{name:'reference.3mf',mode:'mesh',sourceUnitsToMm:1}});
  const imageSize=(Object.hasOwn(BACKGROUND_PRESETS,id)?getPresetCalibration(id):null)?.imageSize||{width:1080,height:1440};
  Object.defineProperty(studio,'backgroundMetadata',{value:background?{...imageSize,type:'image'}:null});
  studio._backgroundSize=studio.backgroundMetadata;
  studio._backgroundTexture=background?{}:null;
  studio._photoBedSize=calibrated?{width:12,depth:10}:null;
  studio.host=get('stage');studio.camera=new THREE.PerspectiveCamera(24,16/9,.01,200);
  studio.camera.position.set(8,6,20);studio.camera.lookAt(0,2,0);
  studio.camera.updateMatrixWorld(true);studio.camera.updateProjectionMatrix();
  studio.controls={enableDamping:true,target:new THREE.Vector3(0,2,0),update(){}};
  studio._updateFloorFootprint=()=>{};
  studio.render=()=>{};
  studio.hasModel=()=>hasModel;
  studio.setOptions=options=>{
    events.push('options');Object.assign(studio.options,options);
    const pose=studio.options;
    studio.modelGroup.position.set(pose.modelOffsetX*4,pose.modelOffsetY*4,pose.modelOffsetZ*4);
    studio.modelGroup.rotation.set(pose.modelRotationX,pose.modelRotationY,pose.modelRotationZ,'XYZ');
    studio.modelGroup.scale.setScalar(pose.modelScale);studio.modelGroup.updateMatrixWorld(true);
  };
  const resetModelTransform=studio.resetModelTransform.bind(studio);
  studio.resetModelTransform=()=>{events.push('reset-model');return resetModelTransform();};
  studio.resetCamera=()=>{events.push('reset-camera');studio.camera.position.set(10,7,10);studio.camera.lookAt(0,3,0);studio.camera.updateMatrixWorld(true);};
  const fit=studio.applyPhotographyPlacement.bind(studio),printerFit=studio.applyPrinterPlacement.bind(studio);
  const checkPlacement=profile=>{
    events.push('placement');placements.push(profile);
    assert.equal(context.cropRect,null);assert.equal(context.cropEditing,false);
    assert.equal(context.playing,false);assert.equal(context.transformMode,null);
    assert.equal(get('ratio').value,'source');assert.equal(studio.options.crop,null);
    assert.equal(get('frame-ratio').textContent,'实拍原比例');
    assert.ok(Math.abs(studio.host.clientWidth/studio.host.clientHeight-imageSize.width/imageSize.height)<.002);
  };
  studio.applyPhotographyPlacement=profile=>{checkPlacement(profile);return fit(profile);};
  studio.applyPrinterPlacement=profile=>{checkPlacement(profile);return printerFit(profile);};
  const customDefinition=getPresetCalibration('blue-grey');
  const knownPreset=Object.hasOwn(BACKGROUND_PRESETS,id);
  // Deliberately preserve an old, extreme calibration in the fixture. Preset
  // reset must replace it before fitting, rather than silently fitting to it.
  const originalCalibration=calibrated?{photoKey:background&&id?'preset:'+id:'custom-photo',points:customDefinition.points,
    bedWidth:knownPreset?2:180,bedDepth:knownPreset?3:140,fov:knownPreset?3:28,allowOutside:true,verticalLines:[]}:null;
  const capture=()=>({pose:clone(context.modelPose()),posePlacement:clone(context.posePlacement),modelSourceKey:context.modelSourceKey,
    backgroundPreset:context.backgroundPreset,poseUpdatedAt:Date.now(),crop:clone(context.cropRect),ratio:get('ratio').value,time:context.time});
  const context=vm.createContext({studio,$:get,printerPresets:BACKGROUND_PRESETS,backgroundPreset:id,DEFAULT_MODEL_POSE:defaults,
    SURFACE_PRESETS:['auto','pla','matte','silk','petg'],modelColorFields:['tint','shadows','highlights','contrast','saturation'],
    normalizeLighting,lightingProfile:normalizeLighting({keyIntensity:1.3,ambientIntensity:.8,fillIntensity:.4}),
    scene:'studio',sceneColors:{studio:'#30333a'},customSoundFile:null,toolColors:{0:'#efdb5b',1:'#28517b'},
    time:2,playing:true,transformMode:'rotate',perspectiveMode:true,activeCalibration:originalCalibration,
    cropRect:{x:.12,y:.05,width:.77,height:.81,sourceAspect:3/4},cropBeforeEdit:{x:.2,y:.1,width:.6,height:.7,sourceAspect:3/4},
    cropDrag:{handle:'move'},cropEditing,calibrationMode,exporting:false,restoringProject:false,loading:false,alphaVideoAvailable:true,
    posePlacement:null,modelSourceKey:'reference-sha',restoredSettingsData:null,selectPresetPlacementSnapshot,needsPresetPlacementUpgrade,
    document:{activeElement:null},outputSize,outputFormat,
    getPresetCalibration,solvePlanarCamera,currentPhotoKey:()=>background&&id?'preset:'+id:'custom-photo',
    updateExportQualityUI(){},syncLightingControls(){},drawCalibration(){},drawCrop(){},
    updateReferenceView(){events.push('reference');},
    setModelMode(mode){events.push('edit-mode');context.transformMode=mode;context.perspectiveMode=false;get('canvas-tools').hidden=false;},
    stopCalibration(commit){assert.equal(commit,false);events.push('end-calibration');context.calibrationMode=false;context.playing=true;},
    markView(view){assert.equal(view,'perspective');events.push('view');},syncCameraFields(){events.push('fields');},
    showTime(){events.push('render');studio.options.progress=1;},
    persistSettings(){if(context.restoringProject||context.loading)return;events.push('persist');saved.push(capture());},queueProjectState(){if(context.restoringProject||context.loading)return;events.push('queue');queued.push(capture());},
    say(message,error=false){events.push('message');get('status-line').textContent=message;get('status-line').error=error;}});
  vm.runInContext(['modelPose','surfaceSettings','settings','lightingSettings','renderOptions','updateStageBounds','updateSettings',
    'withPresetCameraHints','calibrationCamera','applyActiveCamera','applyPresetCamera','applyPresetModelPlacement','restoreSavedModelPlacement','upgradeRestoredPresetPlacement','resetScene'].map(actualFunction).join('\n'),context);
  const applyActiveCamera=context.applyActiveCamera;
  context.applyActiveCamera=()=>{events.push('calibration-camera');return applyActiveCamera();};
  studio.setOptions(context.renderOptions());events.length=0;
  return{context,studio,get,events,saved,queued,placements,originalCalibration};
}

test('restoring all six presets replaces cached calibration and reapplies the whole-model composition after the source frame and camera',()=>{
  for(const id of presetIds){
    const f=fixture({id}),before=clone(f.context.renderOptions());
    f.context.resetScene();
    assert.equal(f.placements.length,1);assert.equal(f.placements[0],BACKGROUND_PRESETS[id].placement);
    const pose=clone(f.context.modelPose());
    const preset=BACKGROUND_PRESETS[id],definition=getPresetCalibration(id);
    const sourceCamera=f.studio._framedCameraClone(f.studio.backgroundMetadata.width/f.studio.backgroundMetadata.height);
    sourceCamera.updateMatrixWorld(true);
    const yawDeg=preset.kind==='printer'?printerModelYaw(sourceCamera,preset.placement.relativeYawDeg,printerPatternGroundPoint(sourceCamera,preset.placement)):preset.placement.yawDeg;
    assert.equal(pose.modelRotationY,THREE.MathUtils.degToRad(yawDeg));
    assert.equal(pose.modelRotationX,0);assert.equal(pose.modelRotationZ,0);
    assert.ok(pose.modelScale>0);assert.notEqual(pose.modelScale,1);
    assert.notEqual(pose.modelOffsetZ,0);assert.notDeepEqual(pose,defaults);
    assert.notEqual(f.context.activeCalibration,f.originalCalibration);
    assert.deepEqual(clone(f.context.activeCalibration.points),definition.points);
    assert.deepEqual(clone(f.context.activeCalibration.verticalLines),definition.verticalLines);
    assert.equal(f.context.activeCalibration.bedWidth,definition.widthMm);
    assert.equal(f.context.activeCalibration.bedDepth,definition.depthMm);
    assert.equal(f.context.activeCalibration.fov,definition.fov);
    assert.equal(f.get('bed-width').value,definition.widthMm);assert.equal(f.get('bed-depth').value,definition.depthMm);
    assert.ok(f.studio.orientation.quaternion.equals(new THREE.Quaternion()));
    assert.ok(f.events.indexOf('edit-mode')<f.events.indexOf('reset-model'));
    assert.ok(f.events.indexOf('reset-model')<f.events.indexOf('calibration-camera'));
    assert.ok(f.events.indexOf('calibration-camera')<f.events.indexOf('placement'));
    assert.ok(f.events.indexOf('placement')<f.events.lastIndexOf('render'));
    const after=clone(f.context.renderOptions());
    for(const key of Object.keys(before).filter(key=>!Object.hasOwn(defaults,key)&&!['crop','bedWidthMm','bedDepthMm'].includes(key)))assert.deepEqual(after[key],before[key],`${id}: ${key}`);
    assert.equal(f.get('export-quality').value,'realistic');
    assert.equal(f.get('reset-camera').attributes['aria-label'],'还原预设构图');
    assert.equal(f.context.time,9);assert.equal(f.context.playing,false);
    assert.deepEqual(f.saved.at(-1).pose,pose);assert.deepEqual(f.queued.at(-1).pose,pose);
    assert.equal(f.saved.at(-1).ratio,'source');assert.equal(f.saved.at(-1).crop,null);
    assert.ok(f.events.lastIndexOf('persist')>f.events.lastIndexOf('render'));
    assert.ok(f.events.lastIndexOf('queue')>f.events.lastIndexOf('render'));
  }
});

test('restoration cancels crop and calibration edits and refreshes the source ratio header and stage before fitting',()=>{
  const f=fixture({id:'pastel-rug',calibrationMode:true,cropEditing:true});
  f.context.resetScene();
  assert.equal(f.context.calibrationMode,false);assert.equal(f.context.cropEditing,false);
  assert.equal(f.context.cropRect,null);assert.equal(f.context.cropDrag,null);assert.equal(f.context.cropBeforeEdit,null);
  assert.equal(f.get('ratio').value,'source');assert.equal(f.get('frame-ratio').textContent,'实拍原比例');
  assert.equal(f.get('crop-overlay').attributes.hidden,'');
  assert.equal(f.get('crop-panel').hidden,true);assert.equal(f.get('edit-crop').hidden,true);
  assert.equal(f.get('canvas-tools').hidden,false);
  assert.ok(f.events.indexOf('end-calibration')<f.events.indexOf('reset-model'));
  assert.equal(f.context.settings().ratio,'1087:1447');
  assert.ok(Math.abs(f.get('stage').clientWidth/f.get('stage').clientHeight-1087/1447)<.002);
  assert.equal(f.get('export-summary').textContent,'1080 × 1438 · 9 秒');
});

test('reset recovers a photography preset when the cached manual camera cannot fit even the minimum model scale',()=>{
  const f=fixture({id:'pastel-rug'});
  f.context.activeCalibration={...f.context.activeCalibration,fov:28,bedDepth:2*140/180};
  f.context.applyActiveCamera();
  const rejected=GrowthStudio.prototype.applyPhotographyPlacement.call(f.studio,BACKGROUND_PRESETS['pastel-rug'].placement);
  assert.equal(rejected,null,'the old two-millimetre calibration cannot reach this composition');
  f.context.resetScene();
  assert.equal(f.placements.length,1);
  assert.equal(f.get('status-line').error,false);
  assert.match(f.get('status-line').textContent,/已恢复/);
  assert.equal(f.context.activeCalibration.fov,30);
  assert.equal(f.context.activeCalibration.bedWidth,180);
  assert.equal(f.context.modelPose().modelRotationY,THREE.MathUtils.degToRad(40));
  assert.notDeepEqual(clone(f.context.modelPose()),defaults);
});

test('each printer reset fits real soles on the calibrated sheet and restores a camera-relative angle rather than generic yaw zero',()=>{
  for(const id of ['h2c','p1s','a1']){
    const f=fixture({id});f.context.resetScene();
    assert.equal(f.placements.length,1);
    const pose=clone(f.context.modelPose());
    assert.notEqual(pose.modelRotationY,0);
    assert.ok(Math.abs(pose.modelOffsetY*4+Math.fround(.6)*pose.modelScale)<1e-10);
    assert.ok(f.events.indexOf('calibration-camera')<f.events.indexOf('placement'));
    assert.equal(f.get('reset-camera').attributes['aria-label'],'还原预设构图');
    assert.deepEqual(f.queued.at(-1).pose,pose);
  }
});

test('custom photographs keep their active calibration while resetting the model and original photograph ratio',()=>{
  for(const id of ['', 'custom', '__proto__']){
    const f=fixture({id});f.context.resetScene();
    assert.deepEqual(clone(f.context.modelPose()),defaults);
    assert.deepEqual(clone(f.context.activeCalibration),clone(f.originalCalibration));
    assert.equal(f.placements.length,0);assert.ok(!f.events.includes('settle'));
    assert.ok(f.events.includes('calibration-camera'));assert.ok(!f.events.includes('reset-camera'));
    assert.equal(f.get('ratio').value,'source');assert.equal(f.get('frame-ratio').textContent,'实拍原比例');
    assert.equal(f.get('reset-camera').attributes['aria-label'],'回正模型与视角');
  }
});

test('a scene with no background uses the generic reset without selecting a nonexistent source photograph',()=>{
  const f=fixture({id:'',background:false,calibrated:false,cropEditing:false});
  f.get('ratio').value='16:9';f.context.cropRect=null;f.context.resetScene();
  assert.deepEqual(clone(f.context.modelPose()),defaults);
  assert.equal(f.studio.camera.fov,36);assert.ok(f.events.includes('reset-camera'));
  assert.ok(!f.events.includes('calibration-camera'));assert.equal(f.placements.length,0);
  assert.equal(f.get('ratio').value,'16:9');assert.equal(f.get('frame-ratio').textContent,'16 : 9');
  assert.equal(f.context.settings().ratio,'16:9');assert.equal(f.get('export-quality').value,'realistic');
});

test('an empty preset scene restores its source framing without attempting model placement',()=>{
  const f=fixture({id:'teal-room',hasModel:false,calibrated:false});f.context.resetScene();
  assert.equal(f.placements.length,0);assert.ok(!f.events.includes('settle'));
  assert.ok(f.events.includes('calibration-camera'));assert.deepEqual(clone(f.context.modelPose()),defaults);
  assert.equal(f.get('ratio').value,'source');assert.equal(f.context.playing,false);
});

test('repeated restoration is stable for all six presets and persistence records the final fitted pose',()=>{
  for(const id of presetIds){
    const f=fixture({id});f.context.resetScene();const first=clone(f.context.modelPose());
    // Deliberate arbitrary pose edits are discarded by the next explicit reset.
    f.studio.setOptions({...editedPose,modelScale:2.1});
    f.context.time=.7;f.context.playing=true;f.context.transformMode='translate';
    f.context.resetScene();
    assert.deepEqual(clone(f.context.modelPose()),first);
    assert.equal(f.placements.length,2);assert.equal(f.context.time,9);assert.equal(f.context.playing,false);
    assert.deepEqual(f.saved.at(-1).pose,f.queued.at(-1).pose);assert.deepEqual(f.saved.at(-1).posePlacement,f.queued.at(-1).posePlacement);assert.deepEqual(f.queued.at(-1).pose,first);
  }
});

test('a failed automatic fit reports failure instead of claiming the default pose is a restored preset',()=>{
  for(const id of ['pastel-rug','p1s']){
    const f=fixture({id});
    if(BACKGROUND_PRESETS[id].kind==='printer')f.studio.applyPrinterPlacement=()=>null;
    else f.studio.applyPhotographyPlacement=()=>null;
    f.context.resetScene();
    assert.equal(f.get('status-line').error,true);
    assert.match(f.get('status-line').textContent,/构图未恢复/);
    assert.doesNotMatch(f.get('status-line').textContent,/已恢复/);
    assert.deepEqual(clone(f.context.modelPose()),defaults);
    assert.equal(f.queued.length,0,'failed default pose is not queued as a successful restored composition');
  }
});

function restoringFixture(id){
  const f=fixture({id,cropEditing:false});
  f.context.restoringProject=true;f.context.playing=false;f.context.transformMode=null;f.context.perspectiveMode=false;
  f.context.cropRect=null;f.get('ratio').value='source';f.context.updateSettings();
  f.events.length=0;f.saved.length=0;f.queued.length=0;
  return f;
}

function sourceHeight(studio){
  studio.modelGroup.updateMatrixWorld(true);
  const camera=studio._framedCameraClone(studio.backgroundMetadata.width/studio.backgroundMetadata.height);
  camera.updateMatrixWorld(true);
  let top=Infinity,bottom=-Infinity;
  for(const mesh of studio._meshes){
    const positions=mesh.geometry.attributes.position;
    for(let index=0;index<positions.count;index++){
      const point=new THREE.Vector3().fromBufferAttribute(positions,index).applyMatrix4(mesh.matrixWorld).project(camera);
      const y=(1-point.y)/2;top=Math.min(top,y);bottom=Math.max(bottom,y);
    }
  }
  return bottom-top;
}

test('startup upgrades each legacy oversized printer pose to the actual forty-percent source-frame composition',()=>{
  for(const id of ['h2c','p1s','a1']){
    const f=restoringFixture(id);
    const legacy={backgroundPreset:id,settings:{pose:{...editedPose,modelScale:3},sliceCache:{sourceSha256:f.context.modelSourceKey}}};
    const snapshot=f.context.restoreSavedModelPlacement(legacy);
    assert.equal(snapshot.source,'project');assert.equal(f.studio.options.modelScale,3);assert.equal(f.context.posePlacement,null);
    assert.equal(f.context.upgradeRestoredPresetPlacement(snapshot),true);
    assert.ok(Math.abs(sourceHeight(f.studio)-.40)<1e-7,id+' uses the real source vertices and calibrated camera');
    assert.deepEqual(clone(f.context.posePlacement),{preset:id,revision:BACKGROUND_PRESETS[id].placement.revision,modelSourceKey:'reference-sha'});
    assert.equal(f.placements.length,1);assert.equal(f.saved.length,0,'restoration has not saved an intermediate pose');
    f.context.restoringProject=false;f.context.persistSettings();
    assert.deepEqual(f.saved.at(-1).pose,clone(f.context.modelPose()));
    assert.deepEqual(f.saved.at(-1).posePlacement,clone(f.context.posePlacement));
  }
});

test('after one startup migration, later manual size and position survive the next reopening',()=>{
  const first=restoringFixture('h2c');
  const legacy={backgroundPreset:'h2c',settings:{pose:{...editedPose,modelScale:3},modelSourceKey:'reference-sha'}};
  assert.equal(first.context.upgradeRestoredPresetPlacement(first.context.restoreSavedModelPlacement(legacy)),true);
  first.context.restoringProject=false;
  first.studio.setOptions({modelScale:first.studio.options.modelScale*1.1,modelOffsetX:first.studio.options.modelOffsetX+.04});
  first.context.persistSettings();const manual=first.saved.at(-1);
  const reopened=restoringFixture('h2c');
  const restored=reopened.context.restoreSavedModelPlacement({backgroundPreset:'h2c',settings:manual});
  assert.equal(reopened.context.upgradeRestoredPresetPlacement(restored),false);
  assert.deepEqual(clone(reopened.context.modelPose()),manual.pose);
  assert.deepEqual(clone(reopened.context.posePlacement),manual.posePlacement);
  assert.equal(reopened.placements.length,0);assert.ok(!reopened.events.includes('reset-model'));
});

test('startup selects a newer local pose and its own marker instead of the stale larger IndexedDB pair',()=>{
  const f=restoringFixture('h2c'),revision=BACKGROUND_PRESETS.h2c.placement.revision;
  f.context.restoredSettingsData={backgroundPreset:'h2c',modelSourceKey:'reference-sha',pose:{...editedPose,modelScale:.8},
    posePlacement:{preset:'h2c',revision,modelSourceKey:'reference-sha'},poseUpdatedAt:2000};
  const older={backgroundPreset:'h2c',settings:{modelSourceKey:'reference-sha',pose:{...editedPose,modelScale:3},
    posePlacement:{preset:'h2c',revision:revision-1,modelSourceKey:'reference-sha'},poseUpdatedAt:1000}};
  const snapshot=f.context.restoreSavedModelPlacement(older);
  assert.equal(snapshot.source,'local');assert.equal(f.studio.options.modelScale,.8);
  assert.deepEqual(clone(f.context.posePlacement),f.context.restoredSettingsData.posePlacement);
  assert.equal(f.context.upgradeRestoredPresetPlacement(snapshot),false);assert.equal(f.placements.length,0);
});

test('a failed startup fit keeps the old revision and never records a successful upgrade',()=>{
  const f=restoringFixture('h2c'),oldRevision=BACKGROUND_PRESETS.h2c.placement.revision-1;
  const saved={backgroundPreset:'h2c',settings:{pose:{...editedPose,modelScale:3},modelSourceKey:'reference-sha',
    posePlacement:{preset:'h2c',revision:oldRevision,modelSourceKey:'reference-sha'}}};
  const snapshot=f.context.restoreSavedModelPlacement(saved);f.studio.applyPrinterPlacement=()=>null;
  assert.throws(()=>f.context.upgradeRestoredPresetPlacement(snapshot),/构图更新未完成/);
  assert.equal(f.context.posePlacement.revision,oldRevision);assert.equal(f.saved.length,0);assert.equal(f.queued.length,0);
});

test('custom and photography startup snapshots retain their saved poses without forced printer migration',()=>{
  for(const id of ['', 'custom','pastel-rug','blue-grey','teal-room']){
    const f=restoringFixture(id),saved={backgroundPreset:id,settings:{pose:{...editedPose,modelScale:2.5},modelSourceKey:'reference-sha'}};
    const snapshot=f.context.restoreSavedModelPlacement(saved);
    assert.equal(f.context.upgradeRestoredPresetPlacement(snapshot),false);
    assert.deepEqual(clone(f.context.modelPose()),saved.settings.pose);
    assert.equal(f.placements.length,0);assert.ok(!f.events.includes('reset-model'));
  }
});
