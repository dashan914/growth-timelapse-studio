import { PreviewSoundPlayer } from './preview-sound-player.js';
import { cameraMotionScale, applyFramePush } from './camera-motion.js';
import { soundEffect, soundUrl, validateCustomSound, CUSTOM_SOUND_DURATION } from './sound-effects.js';
import {GrowthStudio} from './studio.js';
import {timelineState, outputSize} from './timeline.js';
import {solvePlanarCamera} from './calibration.js';
import {calibrationGridLines,calibrationFitFeedback,normalizeUprightLines,uprightModelPose} from './calibration-editor.js';
import {focalLengthToFov} from './camera-lens.js';
import {CAMERA_METRIC_REVISION,migratePhotoCameraMetric} from './camera-cache.js';
import {detectBedCandidate} from './bed-detection.js';
import {analysePhotoPair,autoAlignModel} from './photo-registration.js';
import {preparePhotoReveal,composePhotoReveal} from './photo-reveal.js';
import {loadProjectFiles,saveProjectFiles} from './project-cache.js';
import * as THREE from 'three';
import {readPhoto,resizeMaskCover} from './photo-io.js';
import {getPresetCalibration} from './preset-calibrations.js';
import {PhotoPreviewRenderer} from './photo-preview.js';
import {DEFAULT_LIGHTING,getPresetLighting,normalizeLighting,LIGHTING_PRESET_REVISION} from './preset-lighting.js';
import {migratePresetLighting} from './preset-lighting-migration.js';
import {DOF_PRESET_REVISION,getPresetDof,normalizeDof,migratePresetDof} from './preset-dof.js';
import {exportRenderPlan} from './export-quality.js';
import {realisticExportAvailability,realisticFramePlan,realisticProgress,waitForRealisticExport,realisticDownloadResult} from './realistic-export.js';
import {waitForSlice,parsePrintLayersInWorker} from './slice-client.js';
import {createImportProgressUI} from './import-progress.js';
import {RealisticPreviewRenderer} from './realistic-preview.js';
import {initializeStyledSelects} from './styled-select.js';
import {outputFormat} from './output-format.js';
import {BACKGROUND_PRESETS} from './background-presets.js';
import {selectPresetPlacementSnapshot,needsPresetPlacementUpgrade} from './preset-placement-state.js';
import {backgroundAppearanceKey,normalizeBackgroundAppearance,normalizeBackgroundAppearances} from './background-appearance.js';
import {ensureExportUnlocked} from './beta-access.js';

const $ = id => document.getElementById(id);
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const sceneColors = {studio:'#30333a', paper:'#eceff3', blue:'#171b24'};
let studio;
let scene = 'studio';
let time = 8;
let playing = false;
let previewPlaybackActive = false;
let lastTick = 0;
const previewFrameIntervals=[];
let exporting = false;
let exportAuthorizing = false;
let snapshotting = false;
let loading = false;
let importController = null, importSequence = 0, importProgressUI = null;
let sliceController = null, slicingRuntime = null;
let importInteractionState = null;
let exportId = null;
let controller = null;
let cancelled = false;
let ffmpegAvailable = true;
let alphaVideoAvailable = false;
let realisticRuntime = null;
let qualityPreference = 'realtime';
let exportBackend = 'realtime';
let exportCancellation = null;
let backgroundFile = null;
let customSoundFile=null,customSoundUrl='',soundImportSequence=0,pendingSoundImport=null,soundRestoreComplete=false;
let perspectiveMode=false;
let dragPerspective=null;
let calibrationMode=false;
let calibrationPoints=[];
let calibrationDragIndex=null;
let toolColors={};
let transformMode=null;
let modelFile=null;
let manualSupportFile=null,manualSupportMapping=null;
let supportsJobId=null;
let modelRevision=0,sliceReadyJob=null,modelSourceKey='';
let activeCalibration=null;
let backgroundPreset='';
let backgroundAppearances={},restoredSettingsData=null,backgroundLoadSequence=0;
let referenceFile=null, referenceAnalysis=null, referencePixels=null;
let alignBusy=false, alignCancelled=false, restoringProject=false;
let calibrationPreviousTime=0;
let cacheTimer=null;
let cropRect=null,cropEditing=false,cropDrag=null,cropBeforeEdit=null,gridDrag=null;
let calibrationInitialPoints=[];
let calibrationLayoutExtents=null;
let calibrationStep=0,calibrationUprights=[],calibrationUprightConfirmed=[],calibrationUprightDrag=null;
let calibrationSnapshot=null,calibrationPreviewResult=null,calibrationSelectedHandle='corner-0';
let calibrationDetectionController=null,calibrationSessionId=0,calibrationUprightNotice='';
let photoPreview=null;
let realisticPreview=null, lastRealisticPreviewCheck=0;
let lightingProfile=normalizeLighting(DEFAULT_LIGHTING);
const printerPresets=BACKGROUND_PRESETS;
const modelColorFields=['tint','shadows','highlights','contrast','saturation'];
const DEFAULT_MODEL_POSE={modelOffsetX:0,modelOffsetY:0,modelOffsetZ:0,modelRotationX:0,modelRotationY:0,modelRotationZ:0,modelScale:1};
let posePlacement=null;
const SURFACE_PRESETS=['auto','pla','matte','silk','petg'];
const LOCAL_SLICE_CLIENT_REVISION='local-slicer-original-mesh-v2';
let restoredSurfaceSettings=null;
let restoredDofSettings=null;

function dofSettings(){
  return normalizeDof({dofEnabled:$('dof-enabled').checked,dofStrength:$('dof-strength').value,dofFocus:$('dof-focus').value});
}

function applyDof(values){
  const profile=normalizeDof(values);
  $('dof-enabled').checked=profile.dofEnabled;
  $('dof-strength').value=profile.dofStrength;
  $('dof-focus').value=profile.dofFocus;
}

function applyPresetDof(id=backgroundPreset){applyDof(getPresetDof(id)||normalizeDof());}

function syncDofStatus(){
  if($('dof-popup').hidden)return;
  const state=studio?.photoDofStatus,lens=state?.lens;
  const message=state?.error?`${state.error} 请调整焦点或关闭虚化。`
    :lens?.enabled?`${lens.apertureSource==='photo-exif-reference'?'照片参考':'估计光圈'} f/${Number(lens.fNumber.toFixed(1))} · 焦点按完整模型估计。${lens.preview?.radiusLimited?'预览强虚化已限制，写实导出仍按光学参数计算。':'照片景深保持不变。'}`
    :'照片保留实拍景深；这里只调整模型的近远虚化。';
  if($('dof-status').textContent!==message)$('dof-status').textContent=message;
  $('dof-status').classList.toggle('error',Boolean(state?.error));
}

function modelPose(source=studio?.options){
  const pose={...DEFAULT_MODEL_POSE};
  for(const key of Object.keys(pose)){
    const value=Number(source?.[key]);
    if(source?.[key]!=null&&Number.isFinite(value)&&(key!=='modelScale'||value>0))pose[key]=value;
  }
  return pose;
}

function modelSceneCamera(){
  if(!studio?.camera||!studio?.controls)return null;
  const sourceAspect=studio.backgroundMetadata?studio.backgroundMetadata.width/studio.backgroundMetadata.height:studio.camera.aspect;
  const fov=2*Math.atan(Math.tan(studio.camera.fov*Math.PI/360)/Math.min(1,sourceAspect/studio.camera.aspect))*180/Math.PI;
  return {position:studio.camera.position.toArray(),target:studio.controls.target.toArray(),up:studio.camera.up.toArray(),
    fov,imageSize:{width:sourceAspect*1000,height:1000}};
}

function surfaceSettings(){
  const raw=Number($('surface-detail').value);
  return {surfacePreset:SURFACE_PRESETS.includes($('surface-preset').value)?$('surface-preset').value:'auto',surfaceDetail:Number.isFinite(raw)?Math.min(1,Math.max(0,raw/100)):.6};
}

function restoreSurfaceControls(values){
  if(SURFACE_PRESETS.includes(values?.surfacePreset))$('surface-preset').value=values.surfacePreset;
  if(values?.surfaceDetail!=null&&Number.isFinite(Number(values.surfaceDetail)))$('surface-detail').value=Math.round(Math.min(1,Math.max(0,Number(values.surfaceDetail)))*100);
}

function say(message, error = false) {
  $('status-line').textContent = message;
  $('status-line').classList.toggle('error', error);
}

function settings() {
  const rawGrowth=Number($('growth-duration').value);
  const growth=Math.min(600,Math.max(.1,Number.isFinite(rawGrowth)?rawGrowth:8));
  const hold=Math.min(10,Math.max(0,Number($('hold').value)||0));
  return {
    growth,duration:growth+hold,hold,
    fps: Number($('fps').value),
    ratio: calibrationMode&&studio?.backgroundMetadata?`${studio.backgroundMetadata.width}:${studio.backgroundMetadata.height}`:$('ratio').value==='crop'?(cropEditing||!cropRect?`${studio?.backgroundMetadata?.width||1600}:${studio?.backgroundMetadata?.height||900}`:`${cropRect.width*cropRect.sourceAspect}:${cropRect.height}`):$('ratio').value === 'source' && studio?.backgroundMetadata ? `${studio.backgroundMetadata.width}:${studio.backgroundMetadata.height}` : $('ratio').value === 'source' ? '16:9' : $('ratio').value,
    resolution: Number($('resolution').value),
    format: $('format').value,
    motion:$('camera-motion').value,
    pushAmount:Number($('push-amount').value),pushDuration:Number($('push-duration').value),
    soundEffect:$('sound-enabled').checked?'reference':customSoundFile?'custom':'none',soundVolume:1,
    appearance:'model',
    quality:$('export-quality').value,
  };
}

function renderOptions() {
  return {
    ...lightingSettings(),
    ...modelPose(),
    ...surfaceSettings(),
    direction:'up',
    layerCount: Number($('layers').value),
    stepped: $('stepped').checked,
    layerLines: $('layer-lines').checked,
    color: $('model-color').value,
    preserveMaterials: $('preserve-materials').checked,
    background: sceneColors[scene],
    floor: $('floor').checked,
    grid: $('grid').checked,
    transparent: false,
    shadowOpacity:Number($('shadow-opacity').value)/100,
    shadowRadius:Number($('shadow-radius').value),
    lightDirection:$('light-direction').value,
    toolColors,
    showSupports:$('show-supports').checked,
    lightAzimuth:Number($('light-azimuth').value),
    lightElevation:Number($('light-elevation').value),
    supportDisplay:'solid',
    dofEnabled:$('dof-enabled').checked,
    dofStrength:Number($('dof-strength').value),dofFocus:Number($('dof-focus').value),
    bedWidthMm:Number($('bed-width').value),bedDepthMm:Number($('bed-depth').value),
    outputAppearance:'model',
    crop:$('ratio').value==='crop'&&!cropEditing&&!calibrationMode?cropRect:null,
  };
}

function lightingSettings(){
  return normalizeLighting({...lightingProfile,
    ...Object.fromEntries(modelColorFields.map(key=>[key,Number($('lighting-'+key).value)])),
    exposure:Number($('lighting-exposure').value),colorTemperature:Number($('lighting-temperature').value),
    shadowOpacity:Number($('shadow-opacity').value)/100,shadowRadius:Number($('shadow-radius').value),
    lightAzimuth:Number($('light-azimuth').value),lightElevation:Number($('light-elevation').value),
  });
}

function syncLightingControls(){
  $('lighting-exposure-value').textContent=`${Math.round(Number($('lighting-exposure').value)*100)}%`;
  $('lighting-temperature-value').textContent=`${Math.round(Number($('lighting-temperature').value))} K`;
  for(const key of modelColorFields){const value=Number($('lighting-'+key).value);$('lighting-'+key+'-value').textContent=`${value>=0?'+':''}${value}`;}
  const azimuth=Number($('light-azimuth').value);
  $('light-direction').value=Math.abs(azimuth)<20?'front':azimuth<0?'left':'right';
  $('canvas-floor').checked=$('floor').checked;
  for(const id of ['shadow-opacity','shadow-radius','light-direction','light-azimuth','light-elevation'])$('canvas-'+id).value=$(id).value;
}

function applyLighting(values){
  lightingProfile=normalizeLighting(values);
  for(const key of modelColorFields)$('lighting-'+key).value=lightingProfile[key];
  for(const [id,key,multiplier] of [['lighting-exposure','exposure',1],['lighting-temperature','colorTemperature',1],['shadow-opacity','shadowOpacity',100],['shadow-radius','shadowRadius',1],['light-azimuth','lightAzimuth',1],['light-elevation','lightElevation',1]])$(id).value=lightingProfile[key]*multiplier;
  $('light-direction').value=Math.abs(lightingProfile.lightAzimuth)<20?'front':lightingProfile.lightAzimuth<0?'left':'right';
  syncLightingControls();
}

function applyPresetLighting(id=backgroundPreset){applyLighting(getPresetLighting(id)||DEFAULT_LIGHTING);}

function resetPresetColorMatch(){
  const profile=normalizeLighting(getPresetLighting(backgroundPreset)||DEFAULT_LIGHTING);
  $('lighting-exposure').value=profile.exposure;
  $('lighting-temperature').value=profile.colorTemperature;
  for(const key of modelColorFields)$('lighting-'+key).value=profile[key];
  updateSettings();
  say(backgroundPreset?printerPresets[backgroundPreset].label+' 色彩已恢复':'默认色彩已恢复');
}

function currentBackgroundAppearanceKey(){
  return backgroundAppearanceKey({preset:backgroundPreset,file:backgroundFile,scene});
}

function captureBackgroundAppearance(){
  return normalizeBackgroundAppearance({lighting:lightingSettings(),lightingPresetRevision:LIGHTING_PRESET_REVISION,
    dof:dofSettings(),dofPresetRevision:DOF_PRESET_REVISION,...surfaceSettings(),floor:$('floor').checked,grid:$('grid').checked},currentBackgroundAppearanceKey());
}

function rememberBackgroundAppearance(){
  if(restoringProject||calibrationMode)return;
  backgroundAppearances[currentBackgroundAppearanceKey()]=captureBackgroundAppearance();
}

function applyBackgroundAppearance(){
  const key=currentBackgroundAppearanceKey(),profile=normalizeBackgroundAppearance(backgroundAppearances[key],key);
  applyLighting(profile.lighting);applyDof(profile.dof);restoreSurfaceControls(profile);
  $('floor').checked=profile.floor;$('grid').checked=profile.grid;
}

function restoreBackgroundAppearanceCache(saved){
  backgroundAppearances={...normalizeBackgroundAppearances(saved?.settings?.backgroundAppearances),...backgroundAppearances};
  // The former single record belongs only to the background that saved it.
  // Never use it as the starting appearance for every unvisited background.
  for(const [data,key] of [
    [saved?.settings,saved?.settings?.backgroundAppearanceKey||backgroundAppearanceKey({preset:saved?.backgroundPreset,file:saved?.backgroundFile,scene:restoredSettingsData?.scene||scene})],
    [restoredSettingsData,restoredSettingsData?.backgroundAppearanceKey||backgroundAppearanceKey({preset:restoredSettingsData?.backgroundPreset,file:!restoredSettingsData?.backgroundPreset&&!saved?.backgroundPreset?saved?.backgroundFile:null,scene:restoredSettingsData?.scene||scene})],
  ]){
    if(!data||data.backgroundAppearances)continue;
    const sliderLighting=Object.fromEntries([['exposure','lighting-exposure'],['colorTemperature','lighting-temperature'],['shadowRadius','shadow-radius'],['lightAzimuth','light-azimuth'],['lightElevation','light-elevation'],...modelColorFields.map(field=>[field,'lighting-'+field])].filter(([,id])=>data[id]!=null).map(([field,id])=>[field,Number(data[id])]));
    if(data['shadow-opacity']!=null)sliderLighting.shadowOpacity=Number(data['shadow-opacity'])/100;
    const legacy={lighting:data.lighting||sliderLighting,lightingPresetRevision:data.lightingPresetRevision,dof:data.dof||{dofEnabled:data['dof-enabled'],dofStrength:data['dof-strength'],dofFocus:data['dof-focus']},
      dofPresetRevision:data.dofPresetRevision,surfacePreset:data.surfacePreset??data['surface-preset'],surfaceDetail:data.surfaceDetail??(data['surface-detail']!=null?Number(data['surface-detail'])/100:undefined),floor:data.floor,grid:data.grid};
    // Local settings are newer than the debounced project snapshot.
    const entry=normalizeBackgroundAppearances({[key]:legacy});
    if(data===restoredSettingsData||!Object.hasOwn(backgroundAppearances,key))Object.assign(backgroundAppearances,entry);
  }
}

function syncPreviewPlaybackInteraction(){
  const active=playing&&!exporting&&!loading&&!snapshotting&&!document.hidden;
  if(active){studio?.beginPreviewInteraction?.({hold:true});previewPlaybackActive=true;}
  else if(previewPlaybackActive){previewPlaybackActive=false;studio?.endPreviewInteraction?.();}
}

function touchPreviewInteraction({hold=false}={}){
  if(exporting||loading||snapshotting||alignBusy||calibrationMode||cropEditing)return;
  // A scrub can interrupt playback. Release its held mode before starting the
  // brief interaction, so the final complete frame returns after input stops.
  if(previewPlaybackActive&&!playing){previewPlaybackActive=false;studio?.endPreviewInteraction?.();}
  studio?.beginPreviewInteraction?.({hold});
}

let previewSoundPlayer=null;
function createPreviewSoundPlayer(url){
  const player=new PreviewSoundPlayer({url,
    createContext:()=>new (window.AudioContext||window.webkitAudioContext)(),
    onError:()=>{if(player===previewSoundPlayer)say('音效暂时无法播放，请点击播放重试。',true);},
    onState:state=>{
      if(player!==previewSoundPlayer)return;
      $('play-button').dataset.soundState=state.status;
      $('play-button').dataset.soundTime=state.position.toFixed(3);
      $('play-button').dataset.soundDuration=state.duration.toFixed(3);
    }});
  return player;
}
function getPreviewSoundPlayer(){
  if(!soundRestoreComplete||settings().soundEffect==='none')return null;
  if(!previewSoundPlayer){
    previewSoundPlayer=createPreviewSoundPlayer(customSoundFile?customSoundUrl:soundUrl(soundEffect('reference')));
  }
  return previewSoundPlayer;
}
function stopEffectAudio(){previewSoundPlayer?.pause();}
function unlockPreviewSound(){
  if(settings().soundEffect!=='none')getPreviewSoundPlayer()?.unlock().catch(()=>{});
}
function syncEffectAudio(config){
  const player=getPreviewSoundPlayer();
  if(player)player.update({enabled:config.soundEffect!=='none',playing:playing&&!exporting&&!document.hidden,time,volume:1});
  else{previewSoundPlayer?.pause();$('play-button').dataset.soundState='muted';}
}

function updateSoundSourceUI(){
  $('custom-sound-name').textContent=customSoundFile?.name||'';
  $('custom-sound-row').hidden=!customSoundFile;
  $('sound-import-button').setAttribute('aria-busy',String(Boolean(pendingSoundImport)));
}
function releaseSoundImport(record){
  if(!record||record.released)return;
  record.released=true;record.player.dispose();URL.revokeObjectURL(record.url);
}
function cancelSoundImport(){
  soundImportSequence++;releaseSoundImport(pendingSoundImport);pendingSoundImport=null;updateSoundSourceUI();
  return soundImportSequence;
}
function clearCustomSound({cache=true}={}){
  cancelSoundImport();
  if(customSoundFile){const old=previewSoundPlayer;previewSoundPlayer=null;old?.dispose();}
  if(customSoundUrl)URL.revokeObjectURL(customSoundUrl);
  customSoundUrl='';customSoundFile=null;updateSoundSourceUI();
  if(cache)cachePatch({customSoundFile:null,soundMode:$('sound-enabled').checked?'reference':'none'});
}
async function importCustomSound(file,{restoring=false}={}){
  if(exporting||snapshotting)return false;
  const sequence=cancelSoundImport();
  let record;
  try{
    validateCustomSound(file);
    record={url:URL.createObjectURL(file),player:null,released:false};
    record.player=createPreviewSoundPlayer(record.url);pendingSoundImport=record;updateSoundSourceUI();
    // Resume in the file-input gesture before decoding or reading the cache.
    if(!restoring)record.player.unlock().catch(()=>{});
    const buffer=await record.player.preload();
    if(sequence!==soundImportSequence)return false;
    if(!buffer||buffer.duration>CUSTOM_SOUND_DURATION)throw new Error('音效最长支持 10 分钟。');
    const old=previewSoundPlayer,oldUrl=customSoundUrl;
    customSoundFile=file;customSoundUrl=record.url;previewSoundPlayer=record.player;
    pendingSoundImport=null;record.released=true;old?.dispose();if(oldUrl)URL.revokeObjectURL(oldUrl);
    $('sound-enabled').checked=false;soundRestoreComplete=true;updateSoundSourceUI();
    if(!restoring){cachePatch({customSoundFile:file,soundMode:'custom'});persistSettings();}
    updateSettings();syncEffectAudio(settings());
    if(!restoring)say('已导入自定义音效。');
    return true;
  }catch(error){
    if(sequence===soundImportSequence)say('自定义音效未能载入：'+error.message+' 已保留原音效。',true);
    return false;
  }finally{
    if(pendingSoundImport===record)pendingSoundImport=null;
    releaseSoundImport(record);updateSoundSourceUI();
  }
}
async function restoreProjectSound(saved){
  if(soundImportSequence)return;
  const mode=saved?.soundMode||restoredSettingsData?.soundSource||($('sound-enabled').checked?'reference':'none');
  if(mode==='custom'&&saved?.customSoundFile){
    await importCustomSound(saved.customSoundFile,{restoring:true});
  }else if(mode==='reference')$('sound-enabled').checked=true;
  else $('sound-enabled').checked=false;
  soundRestoreComplete=true;updateSoundSourceUI();
}


function showTime() {
  const config=settings();
  const {duration, hold, motion} = config;
  time = Math.min(duration, Math.max(0, time));
  const state = timelineState(time, duration, hold, motion);
  const scale = calibrationMode || cropEditing || transformMode || perspectiveMode ? 1 : cameraMotionScale(time,config);
  for (const id of ['stage','realistic-preview-layer','photo-growth-layer','reference-layer']) {
    $(id).style.transform = scale === 1 ? '' : `scale(${scale})`;
    $(id).style.clipPath = scale === 1 ? '' : `inset(${(1-1/scale)*50}%)`;
  }
  syncEffectAudio(config);
  syncPreviewPlaybackInteraction();
  studio?.syncBackground?.(time);
  studio?.render(state.progress, state.rotation);
  syncRealisticPreview(state.progress);
  syncDofStatus();
  $('timeline').value = Math.round(time / duration * 1000);
  $('current-time').textContent = time.toFixed(2);
  $('growth-percentage').replaceChildren(document.createTextNode(String(Math.round(state.progress * 100))));
  const suffix = document.createElement('span');
  suffix.textContent = '%';
  $('growth-percentage').append(suffix);
  $('play-button').querySelector('use').setAttribute('href', playing ? '#i-pause' : '#i-play');
  $('play-button').setAttribute('aria-label', playing ? '暂停动画' : '播放动画');
  if(photoPreview){
    const options=studio.options,keys=['modelOffsetX','modelOffsetY','modelOffsetZ','modelScale','modelRotationX','modelRotationY','modelRotationZ','showSupports'];
    const key=JSON.stringify([backgroundFile?.name,backgroundFile?.lastModified,referenceFile?.name,referenceFile?.lastModified,studio.metadata?.name,keys.map(key=>options[key]),studio.orientation?.quaternion.toArray(),studio.camera.position.toArray(),studio.camera.quaternion.toArray(),studio.camera.fov,settings().ratio,cropRect]);
    photoPreview.update({enabled:$('output-appearance').value==='photo'&&Boolean(referenceAnalysis?.usable)&&!loading&&!exporting&&!cropEditing&&!calibrationMode&&!alignBusy,key,width:$('stage').clientWidth,height:$('stage').clientHeight,progress:growthProgress(state.progress)});
  }
}

function updateStageBounds() {
  if (exporting) return;
  const viewport = $('viewport');
  const host = $('stage');
  const [rw,rh] = settings().ratio.split(':').map(Number);
  const aspect = rw / rh;
  let w = viewport.clientWidth, h = w / aspect, left, top;
  if (calibrationMode) {
    // Fit the actual photograph plus its observed off-photo handles. Keep the
    // layout still during a pointer drag instead of making the target chase it.
    if (!calibrationLayoutExtents || calibrationDragIndex === null && !gridDrag) {
      const observed = [{x:0,y:0},{x:1,y:1},...calibrationPoints];
      calibrationLayoutExtents = { minX:Math.min(...observed.map(p=>p.x)),maxX:Math.max(...observed.map(p=>p.x)),minY:Math.min(...observed.map(p=>p.y)),maxY:Math.max(...observed.map(p=>p.y)) };
    }
    const e=calibrationLayoutExtents,pad=32,rangeX=e.maxX-e.minX,rangeY=e.maxY-e.minY;
    h=Math.max(1,Math.min((viewport.clientHeight-pad*2)/rangeY,(viewport.clientWidth-pad*2)/(rangeX*aspect)));w=h*aspect;
    left=(viewport.clientWidth-rangeX*w)/2-e.minX*w;top=(viewport.clientHeight-rangeY*h)/2-e.minY*h;
  } else {
    if(h>viewport.clientHeight){h=viewport.clientHeight;w=h*aspect;}
    left=(viewport.clientWidth-w)/2;top=(viewport.clientHeight-h)/2;
  }
  Object.assign(host.style, {width:`${Math.round(w)}px`,height:`${Math.round(h)}px`,left:`${Math.round(left)}px`,top:`${Math.round(top)}px`});
  drawCalibration();
  drawCrop();
  const ref=$('reference-layer');Object.assign(ref.style,{width:host.style.width,height:host.style.height,left:host.style.left,top:host.style.top});
  Object.assign($('photo-growth-layer').style,{width:host.style.width,height:host.style.height,left:host.style.left,top:host.style.top});
  Object.assign($('realistic-preview-layer').style,{width:host.style.width,height:host.style.height,left:host.style.left,top:host.style.top});
}

function realisticEligibility(config=settings()) {
  if(config.motion==='push'||config.soundEffect&&config.soundEffect!=='none')return {available:false,reason:'运镜和音效使用实时画质导出。关闭两者后可选择写实画质。'};
  return realisticExportAvailability({runtime:realisticRuntime,metadata:studio?.metadata,backgroundType:studio?.backgroundMetadata?.type,appearance:config.appearance,showSupports:$('show-supports').checked,supportDisplay:'solid',frames:Math.round(config.duration*config.fps)});
}

function updateExportQualityUI() {
  const eligibility=realisticEligibility();
  $('realistic-quality-option').disabled=!eligibility.available;
  $('export-quality').value=eligibility.available?(qualityPreference||'realtime'):'realtime';
  $('export-quality').disabled=exporting||loading;
  $('export-quality-help').textContent=!eligibility.available?eligibility.reason:$('export-quality').value==='realistic'?'静止时计算当前帧写实预览；调整和播放时实时响应。写实导出较慢。':'画面即时更新，视频生成更快，使用相同的原模型与真实切片。';
}

function syncRealisticPreview(progress=studio?.options.progress??1) {
  if(!realisticPreview||!studio)return;
  const selected=$('export-quality').value==='realistic';
  const editing=Boolean(transformMode||perspectiveMode||studio._shadowEditMode||studio.transform.dragging);
  const busy=playing||editing||loading||exporting||snapshotting||restoringProject||calibrationMode||cropEditing||alignBusy||document.hidden;
  const enabled=selected&&studio.hasModel()&&!busy;
  if(!enabled){
    realisticPreview.update({enabled:false});
    $('preview-mode').textContent=selected&&studio.hasModel()?(playing?'写实模式 · 实时播放':busy?'写实模式 · 实时调整':'实时预览'):'实时预览';
    return;
  }
  const host=$('stage'),scale=Math.min(1.5,960/Math.max(host.clientWidth,host.clientHeight,1));
  const width=Math.max(64,Math.round(host.clientWidth*scale/2)*2),height=Math.max(64,Math.round(host.clientHeight*scale/2)*2);
  const key=JSON.stringify([modelRevision,sliceReadyJob?.id,studio.metadata.supportSource,studio.metadata.supportSegments,studio.metadata.supportSurfaceTriangles,
    backgroundPreset,backgroundFile?.name,backgroundFile?.size,backgroundFile?.lastModified,renderOptions(),
    studio.orientation?.quaternion.toArray(),studio.camera.position.toArray(),studio.camera.quaternion.toArray(),studio.camera.projectionMatrix.toArray()]);
  realisticPreview.update({enabled:true,key,width,height,progress});
}

function showRealisticPreviewState({status,error}) {
  const labels={waiting:'写实预览 · 等待计算',preparing:'写实预览 · 准备画面',queued:'写实预览 · 等待渲染',rendering:'写实预览 · 计算光影',complete:'写实预览',error:'写实预览失败 · 当前为实时画面'};
  if(labels[status])$('preview-mode').textContent=labels[status];
  $('stage').dataset.realisticPreview=status;
  $('realistic-preview-layer').setAttribute('aria-busy',String(['waiting','preparing','queued','rendering'].includes(status)));
  if(error)$('export-quality-help').textContent=`${error.message} 当前可继续实时调整，切换画质可重试。`;
}

function nativeSliceProgress(state={}){
  const native=state.nativeProgress;
  return {phase:state.phase||'slicing',message:state.message||'本机切片器正在计算真实打印路径…',
    progress:typeof native==='number'&&Number.isFinite(native)&&native>=0&&native<=100?native/100:null,
    completed:state.completed,total:state.total};
}

function syncDetectedSlicer(){
  if(!slicingRuntime)return;
  $('detected-slicer').textContent=slicingRuntime.available?`已检测到 ${slicingRuntime.label||slicingRuntime.engine.replace(/\s*CLI$/,'')}，导入后自动切片。`:'未检测到本机切片器，请安装 Bambu Studio、OrcaSlicer 或 Flash Studio。';
}

async function prepareLocalModelSlice(file,{signal,preset='h2c',sourceUnits=1,onProgress=()=>{}}={}){
  const abort=()=>{if(signal?.aborted)throw new DOMException('Aborted','AbortError');};
  let id=null,cancellation=null;
  const cancelNative=()=>{if(id)cancellation ||= api(`/api/slices/${id}`,{method:'DELETE'}).catch(()=>{});};
  signal?.addEventListener('abort',cancelNative,{once:true});
  try{
    abort();onProgress({phase:'slicer',message:'正在检查本机切片器…'});
    const health=await api('/api/health',{signal});slicingRuntime=health.slicing;
    syncDetectedSlicer();
    if(!slicingRuntime?.available)throw new Error('未找到可用的本机切片器，请在运行本机服务的电脑安装 Bambu Studio、OrcaSlicer 或 Flash Studio 后重试。');
    const format=file.name.toLowerCase().split('.').pop();
    const options={format,preset,engineId:'auto',sourceName:file.name,sourceCoordinateSystem:'printer-z-up',
      sourceToPrinter:new THREE.Matrix4().makeScale(format==='stl'?sourceUnits:1,format==='stl'?sourceUnits:1,format==='stl'?sourceUnits:1).toArray(),
      ...(format==='stl'?{toolColors:[$('model-color').value]}:{})};
    onProgress({phase:'upload',message:`正在将完整原模型交给本机 ${slicingRuntime.engine}…`});
    const created=await api('/api/slices?options='+encodeURIComponent(JSON.stringify(options)),{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:file,signal});
    id=created.id;
    if(typeof id!=='string'||! /^[\da-f-]{36}$/i.test(id))throw new Error('本机切片任务返回了无效标识。');
    abort();
    const job=await waitForSlice({id,signal,request:route=>api(route,{signal}),onSnapshot:state=>onProgress(nativeSliceProgress(state))});
    abort();
    if(job.status==='cancelled')throw new DOMException('Aborted','AbortError');
    if(job.status!=='complete')throw new Error(job.message||'本机切片器未完成切片，原项目已保留。');
    if(job.reSliced!==true||!['bambu','orca','flash'].includes(job.engineId)||typeof job.engineRevision!=='string'||!job.engineRevision)throw new Error('本机服务未返回支持的切片器的新切片结果，请重新启动本机服务后重试。');
    if(!Array.isArray(job.printerToSource)||job.printerToSource.length!==16||job.printerToSource.some(value=>!Number.isFinite(value)))throw new Error('切片结果缺少明确的模型坐标映射，原项目已保留。');
    const parsed=await parsePrintLayersInWorker(`/api/slices/${id}/gcode`,{signal,onPhase:phase=>onProgress({phase,message:phase==='reading'?'正在读取本机切片器的完整结果…':'正在解析真实层高、墙线、填充和支撑…'})});
    abort();return {job,parsed};
  }catch(error){
    cancelNative();if(cancellation)await cancellation;
    if(signal?.aborted)throw new DOMException('Aborted','AbortError');
    throw error;
  }finally{signal?.removeEventListener('abort',cancelNative);}
}

async function ensureModelSlice(){
  if (loading) { say('模型正在准备，完成后即可播放或导出。'); return false; }
  if (!studio?.getPrintLayerData?.()) {
    if(!modelFile||!studio?.hasModel()||studio.metadata.mode!=='mesh'){
      say('请选择包含原始模型网格的 3MF 或 STL；只有打印路径的文件无法重新切片。',true);return false;
    }
    if(!await loadModel([modelFile],false,{sourceUnits:studio.metadata.sourceUnitsToMm,resliceExisting:true}))return false;
  }
  return validatePlaybackColors();
}

function validatePlaybackColors(){
  const missing=(studio.metadata.materialColors||[]).filter(item=>item.source==='fallback'&&!/^#[\da-f]{6}$/i.test(toolColors[item.tool]||''));
  if($('preserve-materials').checked&&missing.length){
    const message=`切片未记录耗材 ${missing.map(item=>item.tool+1).join('、')} 的颜色，请在右侧确认后播放或导出。`;
    say(message,true);return false;
  }
  return true;
}

async function playGrowth(restart=false){
  if(playing&&!restart){playing=false;showTime();return;}
  const revision=modelRevision;
  const begin=()=>{
    setModelMode(null);if(restart||time>=settings().duration)time=0;
    unlockPreviewSound();
    playing=true;showTime();
  };
  // The prepared scene can start sound directly in the click callback. Waiting
  // for metadata or even the resolved async slice check loses that gesture in
  // some browsers. The cached buffer starts at the latest timeline position
  // after decoding completes.
  if(!loading&&studio?.getPrintLayerData?.()){
    if(validatePlaybackColors())begin();
    return;
  }
  if(await ensureModelSlice()&&revision===modelRevision)begin();
}

function updateSettings() {
  updateExportQualityUI();
  const config = settings();
  const formatInfo=outputFormat(config.format);
  $('push-controls').hidden=config.motion!=='push';$('push-amount-value').textContent=`${config.pushAmount}%`;
  syncLightingControls();
  $('surface-detail-value').textContent=`${Math.round(surfaceSettings().surfaceDetail*100)}%`;
  $('duration').value=config.duration;
  if(document.activeElement!==$('growth-duration'))$('growth-duration').value=config.growth;
  const {width, height} = outputSize(config.ratio, config.resolution);
  $('export-summary').textContent = `${width} × ${height} · ${config.duration} 秒`;
  $('total-time').textContent = config.duration.toFixed(2);
  $('mid-time').textContent = `${(config.duration/2).toFixed(1)}s`;
  $('frame-ratio').textContent = calibrationMode?'底板对齐':$('ratio').value==='crop'?'自定义裁剪':$('ratio').value==='source' ? '实拍原比例' : config.ratio.replace(':',' : ');
  const resetLabel=printerPresets[backgroundPreset]?.placement?'还原预设构图':'回正模型与视角';
  $('reset-camera').setAttribute('aria-label',resetLabel);$('reset-camera').title=resetLabel+' · Home';
  $('layers-value').textContent = studio?.metadata?.mode === 'gcode' ? `${studio.metadata.layers} 个真实层` : `${$('layers').value} 层`;
  $('export-format-label').innerHTML = `${formatInfo.badge} <b>${formatInfo.detail}</b>`;
  $('export-button-bottom').innerHTML = `<svg aria-hidden="true"><use href="#i-download"/></svg>${formatInfo.action}`;
  $('export-hint').textContent=formatInfo.help;
  $('format-help').textContent=config.format==='mov-alpha'&&!alphaVideoAvailable?'本机透明视频编码器尚未就绪，可先导出透明 PNG 序列。':formatInfo.help;
  if (!exporting) { updateStageBounds(); studio?.setOptions(renderOptions()); showTime(); }
  persistSettings();
  updateReferenceView();
}

const settingIds = ['camera-motion','push-amount','push-duration','sound-enabled','layers','stepped','layer-lines','model-color','preserve-materials','surface-preset','surface-detail','growth-duration','hold','ratio','resolution','fps','format','export-quality','floor','grid','shadow-opacity','shadow-radius','light-direction','light-azimuth','light-elevation','show-supports','dof-enabled','dof-strength','dof-focus','lighting-exposure','lighting-temperature',...modelColorFields.map(key=>'lighting-'+key)];
function persistSettings() {
  if(restoringProject||calibrationMode||loading)return;
  rememberBackgroundAppearance();
  const data = {scene,backgroundPreset,modelSourceKey,posePlacement,poseUpdatedAt:Date.now(),sourceSceneScale:studio?.sourceMillimetresToWorld,poseCamera:modelSceneCamera(),cameraMetricRevision:CAMERA_METRIC_REVISION,backgroundAppearanceKey:currentBackgroundAppearanceKey(),backgroundAppearances,lighting:lightingSettings(),lightingPresetRevision:LIGHTING_PRESET_REVISION,dof:dofSettings(),dofPresetRevision:DOF_PRESET_REVISION,pose:modelPose(),...surfaceSettings()};
  for (const id of settingIds) data[id] = $(id).type === 'checkbox' ? $(id).checked : $(id).value;
  data.soundSource=$('sound-enabled').checked?'reference':customSoundFile?'custom':'none';
  data.exportQualityPreference=qualityPreference||'realtime';data['export-quality']=data.exportQualityPreference;
  try { localStorage.setItem('growth-studio-settings-v4',JSON.stringify(data)); } catch {}
  queueProjectState();
}

function cachePatch(patch){if(!restoringProject)saveProjectFiles(patch).catch(error=>say(error.message,true));}

function queueProjectState(){
  if(restoringProject || !studio?.hasModel() || !studio.metadata || loading || exporting || alignBusy||calibrationMode)return;
  clearTimeout(cacheTimer);cacheTimer=setTimeout(()=>{
    if(restoringProject || !studio?.hasModel() || !studio.metadata || loading || exporting || alignBusy || calibrationMode)return;
    rememberBackgroundAppearance();
    const poseCamera=modelSceneCamera();
    const cachedSettings={backgroundPreset,modelSourceKey,posePlacement,poseUpdatedAt:Date.now(),sourceSceneScale:studio.sourceMillimetresToWorld,poseCamera,backgroundAppearanceKey:currentBackgroundAppearanceKey(),backgroundAppearances,activeCalibration,manualSupportMapping:manualSupportMapping?{key:modelSourceKey,matrix:manualSupportMapping}:null,sourceUnits:studio.metadata.sourceUnitsUserConfirmed?{key:modelSourceKey,value:studio.metadata.sourceUnitsToMm}:null,sliceCache:sliceReadyJob,cameraCalibrationRevision:getPresetCalibration(backgroundPreset)?.calibrationRevision||0,cameraMetricRevision:CAMERA_METRIC_REVISION,toolColors,cropRect,lighting:lightingSettings(),lightingPresetRevision:LIGHTING_PRESET_REVISION,dof:dofSettings(),dofPresetRevision:DOF_PRESET_REVISION,outputAppearance:'model',exportQualityPreference:qualityPreference||'realtime',pose:modelPose(),...surfaceSettings()};
    cachePatch({settings:cachedSettings,camera:poseCamera,backgroundPreset:backgroundPreset||null,
      soundMode:$('sound-enabled').checked?'reference':customSoundFile?'custom':'none'});
  },350);
}

function markPreset(){for(const button of document.querySelectorAll('[data-preset]')){const active=button.dataset.preset===backgroundPreset;button.classList.toggle('active',active);button.setAttribute('aria-pressed',active);}}

async function setBackgroundFile(file,preset='',{sequence=++backgroundLoadSequence}={}){
  if(!Object.hasOwn(printerPresets,preset))preset='';
  say('载入背景');
  try{await studio.loadBackground(file,{beforeCommit:()=>{
    if(sequence!==backgroundLoadSequence)throw new DOMException('背景切换已更新','AbortError');
    if(calibrationMode)stopCalibration();
    rememberBackgroundAppearance();
    clearReference();activeCalibration=null;
    cropRect=null;cropEditing=false;$('crop-overlay').setAttribute('hidden','');$('crop-panel').hidden=true;$('edit-crop').hidden=true;
  }});}catch(error){if(sequence!==backgroundLoadSequence)return false;throw error;}
  backgroundFile=file;backgroundPreset=preset;
  if(posePlacement?.preset!==preset)posePlacement=null;
  studio.setPhotoIdentity(preset?`preset:${preset}`:null);
  applyBackgroundAppearance();
  $('floor-label').textContent='接触阴影';
  $('composite-options').hidden=false;$('calibrate-button').hidden=false;$('auto-bed-button').hidden=true;$('reference-button').hidden=studio.backgroundMetadata.type!=='image';
  $('calibrate-button-label').textContent='调整底板，矫正透视';
  $('source-ratio').hidden=false;$('ratio').value='source';$('audio-row').hidden=studio.backgroundMetadata.type!=='video';
  if(studio.backgroundMetadata.type==='video'&&studio.backgroundMetadata.duration>=2)$('growth-duration').value=Math.min(600,studio.backgroundMetadata.duration);
  $('bed-width').value=preset?printerPresets[preset].width:256;$('bed-depth').value=preset?printerPresets[preset].depth:256;
  $('preview-mode').textContent='实景';time=settings().duration;playing=false;
  markPreset();setModelMode(null);updateSettings();cachePatch({backgroundFile:file,backgroundPreset:preset||null,referenceFile:null});
  try{const saved=JSON.parse(localStorage.getItem(calibrationStorageKey())||'null');if(saved&&(!saved.photoKey||saved.photoKey===currentPhotoKey())){activeCalibration=withPresetCameraHints(saved,preset);applyActiveCamera();}}catch{}
  say('背景已载入');
  return true;
}

async function loadPreset(id){
  const preset=printerPresets[id];if(!preset)return;
  const sequence=++backgroundLoadSequence;
  const response=await fetch(preset.url);if(!response.ok)throw new Error('背景预设读取失败');
  const blob=await response.blob();if(sequence!==backgroundLoadSequence)return;
  if(await setBackgroundFile(new File([blob],preset.label+'.'+preset.extension,{type:preset.mime}),id,{sequence})===false)return;
  if(!restoringProject&&studio.hasModel())studio.resetModelTransform?.();
  applyPresetCamera(id);syncCameraFields();
  const placed=applyPresetModelPlacement(id);
  if(!restoringProject&&studio.hasModel()&&preset.placement&&!placed)throw new Error(preset.label+' 自动构图未完成，请检查模型尺寸与台面透视。');
  time=settings().duration;showTime();persistSettings();queueProjectState();
  say(preset.label+(preset.kind==='photography'?' 已匹配模型角度、大小、台面落点及光影，可继续微调。':' 已匹配底板透视、模型角度、大小和居中落点，可继续微调。'));
}

function applyPresetModelPlacement(id=backgroundPreset,{restore=false}={}){
  if(restoringProject&&!restore||!studio.hasModel()||!Object.hasOwn(printerPresets,id))return false;
  const profile=printerPresets[id].placement;if(!profile)return false;
  const placed=printerPresets[id].kind==='printer'?studio.applyPrinterPlacement?.(profile):studio.applyPhotographyPlacement?.(profile);
  if(placed)posePlacement={preset:id,revision:profile.revision,modelSourceKey};
  return Boolean(placed);
}

function restoreSavedModelPlacement(saved){
  const snapshot=selectPresetPlacementSnapshot({local:restoredSettingsData,
    project:saved?.settings?{...saved.settings,poseCamera:saved.settings.poseCamera||saved.camera,backgroundPreset:saved.backgroundPreset||''}:null,
    preset:backgroundPreset,modelSourceKey});
  posePlacement=snapshot?.posePlacement||null;
  if(snapshot?.sourceSceneScale)studio.restoreSourceSceneScale?.(snapshot.sourceSceneScale);
  if(snapshot)studio.setOptions(modelPose(snapshot.pose));
  return snapshot;
}

function upgradeRestoredPresetPlacement(snapshot){
  if(!studio.hasModel()||!needsPresetPlacementUpgrade({preset:backgroundPreset,snapshot}))return false;
  applyPresetCamera();
  studio.resetModelTransform?.();
  if(!applyPresetModelPlacement(backgroundPreset,{restore:true}))throw new Error('旧项目的预设构图更新未完成，请检查模型与底板透视。');
  return true;
}

function applyPresetCamera(id=backgroundPreset){
  if(!Object.hasOwn(printerPresets,id))return false;
  const definition=getPresetCalibration(id);if(!definition)return false;
  activeCalibration=withPresetCameraHints({points:definition.points,bedWidth:definition.widthMm,bedDepth:definition.depthMm,
    allowOutside:true,fov:definition.fov,verticalLines:definition.verticalLines},id);
  $('bed-width').value=activeCalibration.bedWidth;$('bed-depth').value=activeCalibration.bedDepth;
  applyActiveCamera();return true;
}

function withPresetCameraHints(calibration,id=backgroundPreset){
  const definition=getPresetCalibration(id);
  if(!calibration)return null;
  if(calibration.photoKey&&calibration.photoKey!==currentPhotoKey())return null;
  if(!definition)return {...calibration,photoKey:currentPhotoKey()};
  return {...calibration,photoKey:currentPhotoKey(),verticalLines:calibration.verticalLines??definition.verticalLines,fov:calibration.fov??definition.fov,calibrationRevision:definition.calibrationRevision};
}

function currentPhotoKey(){
  if(backgroundPreset)return 'preset:'+backgroundPreset;
  const meta=studio?.backgroundMetadata;
  return backgroundFile?JSON.stringify([backgroundFile.name,backgroundFile.size,backgroundFile.lastModified,meta?.width,meta?.height]):'';
}
function calibrationStorageKey(){return backgroundPreset?'growth-calibration-'+backgroundPreset:'growth-calibration-photo-'+currentPhotoKey();}

function calibrationCamera(calibration,widthPx,heightPx){
  const scale=studio.sourceMillimetresToWorld;
  return solvePlanarCamera({points:calibration.points,widthPx,heightPx,bedWidth:calibration.bedWidth*scale,bedDepth:calibration.bedDepth*scale,allowOutside:calibration.allowOutside!==false,fov:calibration.fov,photoVerticalLines:calibration.verticalLines});
}

function applyActiveCamera(){
  if(!activeCalibration||!studio.hasModel())return;
  activeCalibration=withPresetCameraHints(activeCalibration);
  const meta=studio.backgroundMetadata;
  const result=calibrationCamera(activeCalibration,meta?.width||$('stage').clientWidth,meta?.height||$('stage').clientHeight);
  studio.applyCalibration(result);
}

function clearReference(){
  alignCancelled=true;referenceFile=null;referenceAnalysis=null;referencePixels=null;
  $('reference-layer').hidden=true;$('reference-info').hidden=true;$('reference-popup').hidden=true;$('canvas-compare').hidden=true;
  $('output-appearance').value='model';$('output-appearance').options[1].disabled=true;
}

function updateReferenceView(){
  const visible=Boolean(referenceFile)&&$('show-reference').checked&&!calibrationMode&&!exporting;
  $('reference-layer').hidden=!visible;
  $('reference-layer').style.opacity=Number($('reference-opacity').value)/100;
  $('reference-layer').style.mixBlendMode=$('reference-difference').checked?'difference':'normal';
  if(referencePixels){
    const crop=$('ratio').value==='crop'&&!cropEditing?cropRect:null,key=JSON.stringify([crop,settings().ratio]);
    if($('reference-layer').dataset.cropKey!==key){
      const src=referencePixels.canvas,canvas=$('reference-layer');
      const x=(crop?.x||0)*src.width,y=(crop?.y||0)*src.height,w=(crop?.width||1)*src.width,h=(crop?.height||1)*src.height;
      const aspect=settings().ratio.split(':').map(Number).reduce((a,b)=>a/b);canvas.width=Math.min(2048,Math.round(w));canvas.height=Math.round(canvas.width/aspect);
      const scale=Math.max(canvas.width/w,canvas.height/h);canvas.getContext('2d').clearRect(0,0,canvas.width,canvas.height);canvas.getContext('2d').drawImage(src,x,y,w,h,(canvas.width-w*scale)/2,(canvas.height-h*scale)/2,w*scale,h*scale);canvas.dataset.cropKey=key;
    }
  }
}

async function loadReference(file){
  if(studio.backgroundMetadata?.type!=='image')throw new Error('先导入同机位的空场景照片，再导入成品照片。');
  referenceFile=file;$('reference-name').textContent=file.name;$('reference-info').hidden=false;$('canvas-compare').hidden=false;
  const empty=await readPhoto(backgroundFile,{maxWidth:256});
  const target=await readPhoto(file,{width:empty.width,height:empty.height});
  const aspectMismatch=Math.abs(target.originalWidth/target.originalHeight-empty.originalWidth/empty.originalHeight)>.01;
  referenceAnalysis=analysePhotoPair({emptyRGBA:empty.rgba,targetRGBA:target.rgba,width:empty.width,height:empty.height});
  if(aspectMismatch){referenceAnalysis.usable=false;referenceAnalysis.warnings.unshift('两张照片比例不同，请使用同机位、未经不同裁切的照片；仍可手动对照。');}
  referencePixels=await readPhoto(file,{maxWidth:Math.min(empty.originalWidth,2048),translation:referenceAnalysis.translation,translationSize:referenceAnalysis});
  const canvas=$('reference-layer');canvas.width=referencePixels.width;canvas.height=referencePixels.height;
  canvas.dataset.cropKey='';
  canvas.getContext('2d').putImageData(new ImageData(referencePixels.rgba,canvas.width,canvas.height),0,0);
  $('reference-status').textContent=referenceAnalysis.warnings[0] || '拖动模型重合，或点击自动重合。';
  $('auto-reference-align').disabled=!referenceAnalysis.usable;$('output-appearance').options[1].disabled=!referenceAnalysis.usable;
  setReferencePanel(true);playing=false;time=settings().duration;showTime();updateStageBounds();updateReferenceView();
  cachePatch({referenceFile:file});
}

async function autoReferenceAlign(){
  if(alignBusy){alignCancelled=true;return;}
  if(!referenceAnalysis?.usable)return;
  setModelMode(null);
  alignBusy=true;alignCancelled=false;playing=false;time=settings().duration;showTime();
  const keys=['modelOffsetX','modelOffsetY','modelOffsetZ','modelScale','modelRotationY'];
  const initial=Object.fromEntries(keys.map(key=>[key,Number(studio.options[key])|| (key==='modelScale'?1:0)]));
  const bounds={modelOffsetX:[initial.modelOffsetX-2,initial.modelOffsetX+2],modelOffsetY:[initial.modelOffsetY-.5,initial.modelOffsetY+.5],modelOffsetZ:[initial.modelOffsetZ-2,initial.modelOffsetZ+2],modelScale:[Math.max(.1,initial.modelScale*.25),Math.min(5,initial.modelScale*3)],modelRotationY:[initial.modelRotationY-Math.PI,initial.modelRotationY+Math.PI]};
  lockWorkspace(true);$('auto-reference-align').disabled=false;$('auto-reference-align').textContent='取消重合';
  try{
    const result=await autoAlignModel({targetMask:referenceAnalysis.mask,width:referenceAnalysis.width,height:referenceAnalysis.height,initialParams:initial,bounds,
      renderMask:(pose,w,h)=>studio.renderSilhouette(w,h,{pose,supports:false}),shouldCancel:()=>alignCancelled,
      onProgress:state=>{$('reference-status').textContent=`计算重合 ${state.evaluations}/${state.maxEvaluations} · 轮廓 ${Math.round(state.iou*100)}%`;}});
    const pose=result.cancelled?initial:result.params;studio.setOptions(pose);
    $('reference-status').textContent=result.cancelled?'已取消':result.warnings[0]||`轮廓重合 ${Math.round(result.iou*100)}%，请核对边缘和底面。`;
    showTime();
  }catch(error){studio.setOptions(initial);$('reference-status').textContent=error.message;}
  finally{alignBusy=false;lockWorkspace(false);$('auto-reference-align').textContent='自动重合';updateReferenceView();persistSettings();}
}

async function detectBed(){
  if(studio.backgroundMetadata?.type!=='image')return;
  say('识别底板边缘');const image=await readPhoto(backgroundFile,{maxWidth:320});
  const candidate=detectBedCandidate({rgba:image.rgba,width:image.width,height:image.height});
  startCalibration(candidate.points);
  say('已放置底板候选角点，请核对尺寸、四角和竖直立柱。');
}

function beginCrop(){
  if(calibrationMode)stopCalibration();playing=false;cropBeforeEdit=cropRect?{...cropRect}:null;
  const meta=studio.backgroundMetadata;cropRect=cropRect||{x:.05,y:.05,width:.9,height:.9,sourceAspect:meta?meta.width/meta.height:studio.camera.aspect};
  cropEditing=true;setModelMode(null);studio.controls.enabled=false;$('crop-overlay').removeAttribute('hidden');$('crop-panel').hidden=false;$('canvas-tools').hidden=true;
  updateSettings();drawCrop();updateReferenceView();
}

function finishCrop(apply=true){
  if(!apply){cropRect=cropBeforeEdit;$('ratio').value=cropRect?'crop':studio.backgroundMetadata?'source':'16:9';}
  cropEditing=false;cropDrag=null;$('crop-overlay').setAttribute('hidden','');$('crop-panel').hidden=true;$('canvas-tools').hidden=false;
  setModelMode(null);$('edit-crop').hidden=$('ratio').value!=='crop';updateSettings();queueProjectState();updateReferenceView();
}

function drawCrop(){
  if(!cropEditing||!cropRect)return;
  const host=$('stage'),viewport=$('viewport'),svg=$('crop-overlay');svg.setAttribute('viewBox',`0 0 ${viewport.clientWidth} ${viewport.clientHeight}`);
  const x=host.offsetLeft+cropRect.x*host.clientWidth,y=host.offsetTop+cropRect.y*host.clientHeight,w=cropRect.width*host.clientWidth,h=cropRect.height*host.clientHeight;
  $('crop-shade').setAttribute('d',`M0 0H${viewport.clientWidth}V${viewport.clientHeight}H0Z M${x} ${y}V${y+h}H${x+w}V${y}Z`);
  for(const[key,value]of Object.entries({x,y,width:w,height:h}))$('crop-rectangle').setAttribute(key,value);
  $('crop-handles').replaceChildren();for(const[key,px,py]of [['tl',x,y],['tr',x+w,y],['br',x+w,y+h],['bl',x,y+h]]){
    const circle=document.createElementNS('http://www.w3.org/2000/svg','circle');circle.dataset.crophandle=key;circle.setAttribute('cx',px);circle.setAttribute('cy',py);circle.setAttribute('r',8);$('crop-handles').append(circle);
  }
}

function moveCrop(event){
  if(!cropDrag)return;const point=calibrationPoint(event),dx=point.x-cropDrag.origin.x,dy=point.y-cropDrag.origin.y,start=cropDrag.rect;
  const clamp=(v,a,b)=>Math.min(b,Math.max(a,v)),minimum=.04;
  if(cropDrag.handle==='move'){cropRect.x=clamp(start.x+dx,0,1-start.width);cropRect.y=clamp(start.y+dy,0,1-start.height);}
  else{
    let left=start.x,top=start.y,right=start.x+start.width,bottom=start.y+start.height;
    if(cropDrag.handle.includes('l'))left=clamp(start.x+dx,0,right-minimum);else right=clamp(right+dx,left+minimum,1);
    if(cropDrag.handle.includes('t'))top=clamp(start.y+dy,0,bottom-minimum);else bottom=clamp(bottom+dy,top+minimum,1);
    Object.assign(cropRect,{x:left,y:top,width:right-left,height:bottom-top});
  }
  drawCrop();
}

async function preparePhotoFrames(width,height){
  if(!referenceFile||!referenceAnalysis?.usable)throw new Error('实拍外观需要同机位的空场景与成品照片，并先把模型重合。');
  const crop=$('ratio').value==='crop'?cropRect:null;
  const empty=await readPhoto(backgroundFile,{width,height,crop});
  const target=await readPhoto(referenceFile,{width,height,crop,translation:referenceAnalysis.translation,translationSize:referenceAnalysis,fallbackRGBA:empty.rgba});
  const targetMask=resizeMaskCover(referenceAnalysis.mask,referenceAnalysis.width,referenceAnalysis.height,width,height,crop);
  const heightMap=studio.renderHeightMap(width,height,{crop,supports:false,frame:'output'});
  const state=preparePhotoReveal({emptyRGBA:empty.rgba,targetRGBA:target.rgba,targetMask,heightMap,width,height,maxFillDistancePx:Math.max(6,Math.round(width*.008))});
  if(state.warnings.length)say(state.warnings[0]);
  const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
  return{state,canvas,context:canvas.getContext('2d',{willReadFrequently:true}),out:new Uint8ClampedArray(width*height*4)};
}

async function composePhotoBlob(baseBlob,progress,prepared){
  const image=await createImageBitmap(baseBlob);prepared.context.drawImage(image,0,0);image.close();
  const base=prepared.context.getImageData(0,0,prepared.canvas.width,prepared.canvas.height);
  composePhotoReveal({state:prepared.state,progress,baseRGBA:base.data,out:prepared.out});
  prepared.context.putImageData(new ImageData(prepared.out,prepared.canvas.width,prepared.canvas.height),0,0);
  return new Promise((resolve,reject)=>prepared.canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('无法生成实拍合成画面')),'image/png'));
}
function growthProgress(progress){return $('stepped').checked?Math.floor(progress*Number($('layers').value)+1e-7)/Number($('layers').value):progress;}
function restoreSettings() {
  try {
    const raw=localStorage.getItem('growth-studio-settings-v4');
    const data = JSON.parse(raw||localStorage.getItem('growth-studio-settings-v3')||'null');
    if (!data) return;
    if(data['sound-enabled']===undefined&&data['sound-effect']!==undefined)data['sound-enabled']=data['sound-effect']!=='none';
    restoredSettingsData=data;backgroundAppearances=normalizeBackgroundAppearances(data.backgroundAppearances);
    if(!raw)data.hold=0;
    // Opening the workbench always starts in its responsive default. A saved
    // project must not launch a physical render before the user requests it.
    // Pose restoration waits for the source model and background, then chooses
    // one complete, source-bound snapshot with its placement revision.
    for (const id of settingIds) {
      if(id==='export-quality')continue;
      if (data[id] === undefined) continue;
      const el = $(id);
      if (el.type === 'checkbox') el.checked = Boolean(data[id]);
      else if (el.type === 'color' && !/^#[\da-f]{6}$/i.test(data[id])) continue;
      else el.value = data[id];
    }
    if (sceneColors[data.scene]) scene = data.scene;
    if(printerPresets[data.backgroundPreset])backgroundPreset=data.backgroundPreset;
    if(data.dof||data['dof-enabled']!==undefined||data['dof-strength']!==undefined||data['dof-focus']!==undefined){
      const previous=data.dof||{dofEnabled:data['dof-enabled'],dofStrength:data['dof-strength'],dofFocus:data['dof-focus']};
      restoredDofSettings=migratePresetDof(previous,backgroundPreset,data.dofPresetRevision);applyDof(restoredDofSettings);
    }
    if(data.surfacePreset!==undefined||data.surfaceDetail!==undefined||data['surface-preset']!==undefined||data['surface-detail']!==undefined){restoreSurfaceControls(data);restoredSurfaceSettings=surfaceSettings();}
    if(data.lighting){applyLighting(migratePresetLighting(data.lighting,backgroundPreset,data.lightingPresetRevision));return lightingSettings();}
    if(data['lighting-exposure']!==undefined&&data['lighting-temperature']!==undefined){lightingProfile=normalizeLighting(getPresetLighting(backgroundPreset)||DEFAULT_LIGHTING);return lightingSettings();}
  } catch {}
}

function lockWorkspace(locked) {
  for (const element of document.querySelectorAll('.workspace button,.workspace input,.workspace select,.header-actions #export-button')) {
    element.disabled = element.id === 'cancel-import' ? !importProgressUI?.cancelEnabled : locked;
  }
  const exportButton=$('export-button');
  exportButton.innerHTML=`<svg aria-hidden="true"><use href="#i-download"/></svg>${loading?'模型准备中…':'导出视频'}`;
  const importButton=$('import-button');
  importButton.innerHTML=`<svg aria-hidden="true"><use href="#i-upload"/></svg>${loading?'正在导入…':'导入模型'}`;
  importButton.setAttribute('aria-busy',String(loading));
  exportButton.setAttribute('aria-busy',String(loading));
  exportButton.title=loading?'模型正在准备，完成后即可导出。':!studio?.hasModel()?'请先导入 3MF 或 STL 模型。':'导出视频';
  exportButton.setAttribute('aria-label',loading?'模型准备中，暂不能导出':'导出视频');
  if (!locked) {
    const ready=Boolean(studio?.hasModel()&&studio?.getPrintLayerData?.());
    for(const id of ['export-button','play-button','restart-button','timeline','snapshot-button','reset-camera','canvas-lock','canvas-move','canvas-rotate','canvas-scale','canvas-shadow','canvas-color','canvas-dof','lens-camera-drag'])$(id).disabled=!ready;
    const gcode = studio?.metadata?.mode === 'gcode';
    $('layers').disabled = gcode;
    $('layer-lines').disabled = gcode;
    $('show-supports').disabled=!ready||!studio?.metadata?.supportsAvailable;
    $('auto-reference-align').disabled=!referenceAnalysis?.usable;
    const surfaceUnsupported = studio?.metadata?.surfaceOverrideSupported === false;
    $('surface-preset').disabled = surfaceUnsupported;
    $('surface-detail').disabled = surfaceUnsupported || gcode;
    updateExportQualityUI();
  }
}

function showMetadata(metadata) {
  $('model-name').textContent = metadata.name;
  $('project-title').textContent=metadata.name;
  $('model-type').textContent = metadata.mode === 'gcode' ? `${metadata.layers} 层` : metadata.materialColors?.length ? `${metadata.materialColors.length} 色 · ${metadata.meshes} 部件` : `${metadata.format.toUpperCase()} · ${metadata.meshes} 部件`;
  syncSourceUnitControls();
  const layerHeight=Number(metadata.layerHeightMm);
  $('surface-profile-info').hidden=!(Number.isFinite(layerHeight)&&layerHeight>0);
  const inferredLayer=Boolean(metadata.surfaceSettingsInferred?.layerHeight);
  $('surface-profile-info').textContent=Number.isFinite(layerHeight)&&layerHeight>0?`${inferredLayer?'估计层高':'层高'} ${Number(layerHeight.toFixed(3))} mm · 表面按${inferredLayer?'模型':'实际'}比例`:'';
  if (metadata.mode === 'gcode' || metadata.surfaceOverrideSupported === false) {
    $('surface-profile-info').hidden = false;
    $('surface-profile-info').textContent = metadata.mode === 'gcode' ? '按实际挤出路径显示表面。' : '保留原材质，此模型暂不支持表面预设。';
  }
  $('ready-note').hidden = true;
  toolColors=Object.fromEntries((metadata.materialColors||[]).filter(item=>item.source!=='fallback').map(item=>[item.tool,item.color]));
  $('material-color-list').replaceChildren();
  $('material-colors').hidden=!metadata.materialColors?.length;
  for(const material of metadata.materialColors || []) {
    const row=document.createElement('label');row.className='material-color-row';
    const title=document.createElement('span');title.textContent=`耗材 ${material.tool+1}${material.source==='fallback'?' · 确认颜色':''}`;
    const input=document.createElement('input');input.type='color';input.value=material.color;input.setAttribute('aria-label',`耗材 ${material.tool+1} 颜色`);
    input.addEventListener('input',()=>{toolColors[material.tool]=input.value;$('preserve-materials').checked=true;updateSettings();});
    row.append(title,input);$('material-color-list').append(row);
  }
  lockWorkspace(loading || exporting || snapshotting);
  updateSupportUI();
  studio.setOptions({toolColors});
  if (metadata.warnings?.length) say(metadata.warnings.join(' '));
  else say('模型已载入');
}

function syncSourceUnitControls(){
  const metadata=studio?.metadata;const units=Number(metadata?.sourceUnitsToMm)||1;
  $('source-unit-controls').hidden=!metadata?.sourceUnitsInferred;
  $('source-unit').value=String(units);
  $('source-unit-summary').textContent=`模型单位 · ${metadata?.sourceUnitsUserConfirmed?'已确认':'估计'}${({1:'毫米',10:'厘米',1000:'米'})[units]||'毫米'}`;
}

function resetScene() {
  if(calibrationMode)stopCalibration(false);
  playing=false;
  setModelMode(null);
  cropRect=null;cropEditing=false;cropDrag=null;cropBeforeEdit=null;
  $('crop-overlay').setAttribute('hidden','');$('crop-panel').hidden=true;$('edit-crop').hidden=true;
  $('canvas-tools').hidden=false;
  if(studio.backgroundMetadata)$('ratio').value='source';
  studio.resetModelTransform?.();
  updateSettings();
  // Explicit restoration discards the edited/cached preset camera as well.
  if(!applyPresetCamera()){
    if(activeCalibration)applyActiveCamera();
    else {studio.camera.fov=36;studio.resetCamera();}
  }
  // Use the same whole-model composition as the selected background preset;
  // source aspect alone does not restore its yaw, scale or table footpoint.
  const placed=applyPresetModelPlacement();
  if(studio.hasModel()&&printerPresets[backgroundPreset]?.placement&&!placed){
    showTime();say('预设构图未恢复，请检查模型尺寸与台面透视。',true);return;
  }
  time=settings().duration;markView('perspective');syncCameraFields();showTime();
  persistSettings();queueProjectState();
  say(printerPresets[backgroundPreset]?.placement?'已恢复 '+printerPresets[backgroundPreset].label+' 的预设构图与实拍原比例。':'已回正');
}

function updateSupportUI() {
  const metadata=studio?.metadata;
  const available=Boolean(metadata?.supportsAvailable);
  $('show-supports').disabled=loading||exporting||snapshotting||!available;
  $('support-status').textContent=available?'':metadata?.format==='3mf'?'此切片未包含支撑':'';
  $('generate-supports').hidden=true;
  $('generate-supports').textContent=supportsJobId?'取消生成':'生成支撑';
  $('import-supports').hidden=true;
}

function setPlacementMode(enabled) {
  setModelMode(enabled?'translate':null);
}

function clearPreviewGesture(){
  const pointerId=dragPerspective?.pointerId;dragPerspective=null;
  if(pointerId!==undefined){
    studio.endPreviewInteraction?.();
    if(studio.canvas.hasPointerCapture?.(pointerId))studio.canvas.releasePointerCapture(pointerId);
  }
}

function syncPreviewLock(){
  const locked=!transformMode&&!perspectiveMode&&!$('canvas-shadow').classList.contains('active');
  $('canvas-lock').classList.toggle('active',locked);$('canvas-lock').setAttribute('aria-pressed',String(locked));
  $('viewport').dataset.interaction=locked?'locked':perspectiveMode?'perspective':transformMode||'shadow';
}

function setModelMode(mode) {
  if(mode&&$('output-appearance').value==='photo'){$('output-appearance').value='model';studio.setOptions(renderOptions());}
  playing=false;transformMode=mode;clearPreviewGesture();
  studio.setShadowEditMode?.(false);$('shadow-popup').hidden=true;$('canvas-shadow').classList.remove('active');$('canvas-shadow').setAttribute('aria-pressed',false);$('canvas-shadow').setAttribute('aria-expanded',false);
  perspectiveMode=false;$('lens-camera-drag').checked=false;
  $('color-popup').hidden=true;$('canvas-color').classList.remove('active');$('canvas-color').setAttribute('aria-pressed',false);$('canvas-color').setAttribute('aria-expanded',false);
  $('motion-popup').hidden=true;$('canvas-motion').classList.remove('active');$('canvas-motion').setAttribute('aria-pressed',false);$('canvas-motion').setAttribute('aria-expanded',false);
  $('dof-popup').hidden=true;$('reference-popup').hidden=true;
  $('canvas-compare').classList.remove('active');$('canvas-compare').setAttribute('aria-pressed',false);
  $('canvas-dof').classList.remove('active');$('canvas-dof').setAttribute('aria-pressed',false);$('canvas-dof').setAttribute('aria-expanded',false);
  studio.setTransformMode?.(mode);studio.lockPreviewCamera();
  for(const [id,value] of [['canvas-move','translate'],['canvas-rotate','rotate'],['canvas-scale','scale']]) {const active=mode===value;$(id).classList.toggle('active',active);$(id).setAttribute('aria-pressed',active);}
  $('gesture-hint').textContent=mode==='translate'?'拖动彩色手柄移动 · Esc 锁定':mode==='rotate'?'拖动彩色圆环旋转 · Esc 锁定':mode==='scale'?'拖动彩色手柄缩放 · Esc 锁定':'预览已锁定 · 选择下方工具开始调整';
  syncPreviewLock();
  showTime();
}

function setAppearancePanel(kind,open){
  setModelMode(null);
  const button=$('canvas-'+kind),popup=$(kind+'-popup');
  popup.hidden=!open;button.classList.toggle('active',open);
  button.setAttribute('aria-pressed',open);button.setAttribute('aria-expanded',open);
  if(kind==='shadow'){
    studio.setShadowEditMode?.(open);studio.lockPreviewCamera();syncPreviewLock();
    $('gesture-hint').textContent=open?'拖动底部阴影手柄 · Esc 锁定':'预览已锁定 · 选择下方工具开始调整';
    syncLightingControls();
  }else if(kind==='color')syncLightingControls();
  else if(kind==='dof'){syncCameraFields();syncDofStatus();}
}

function setReferencePanel(open){
  setModelMode(null);
  $('reference-popup').hidden=!open;
  $('canvas-compare').classList.toggle('active',open);$('canvas-compare').setAttribute('aria-pressed',open);
}

function syncCameraFields() {
  const camera=studio.getCameraOptions?.();if(!camera)return;
  for(const [key,id] of [['pitch','camera-pitch'],['yaw','camera-yaw'],['roll','camera-roll']]) {$(id).value=camera[key];$(key+'-value').textContent=`${Math.round(camera[key])}°`;}
  const lens=studio.getLensOptions?.();
  if(lens){$('camera-focal-length').value=lens.focalLength;if(document.activeElement!==$('camera-focal-length-number'))$('camera-focal-length-number').value=lens.focalLength.toFixed(1);$('focal-length-value').textContent=`${lens.focalLength.toFixed(1)} mm`;}
}

function setPerspectiveMode(enabled) {
  setAppearancePanel('dof',true);perspectiveMode=enabled;
  $('lens-camera-drag').checked=enabled;
  studio.lockPreviewCamera();
  $('gesture-hint').textContent=enabled?'拖动调整机位 · 滚轮调整焦段 · Esc 锁定':'预览已锁定 · 选择下方工具开始调整';
  syncPreviewLock();
  syncCameraFields();
}

function changeCameraFromFields(event) {
  const key={'camera-pitch':'pitch','camera-yaw':'yaw','camera-roll':'roll'}[event.target.id];
  const raw=event.target.value,value=Number(raw);
  if(!key||raw.trim()===''||!Number.isFinite(value))return;
  touchPreviewInteraction();
  studio.setCameraOptions?.({[key]:value});
  syncCameraFields();showTime();queueProjectState();
}

function applyLensChange(focalLength){
  try{touchPreviewInteraction();studio.setLensOptions({focalLength});syncCameraFields();showTime();queueProjectState();}
  catch(error){syncCameraFields();$('camera-focal-length-number').value=studio.getLensOptions().focalLength.toFixed(1);say(error.message,true);}
}

function changeLensFromFields(event){
  const raw=event.target.value,value=Number(raw);
  if(raw.trim()===''||!Number.isFinite(value)||value<18||value>135)return;
  applyLensChange(value);
}

function calibrationDraft(){
  return {points:calibrationPoints.map(point=>({...point})),bedWidth:Number($('bed-width').value),bedDepth:Number($('bed-depth').value),allowOutside:true,
    verticalLines:normalizeUprightLines(calibrationUprights.filter((_,index)=>calibrationUprightConfirmed[index])),photoKey:currentPhotoKey(),
    fov:activeCalibration?.fov};
}

function calibrationScreenPoint(point){
  const host=$('stage');return{x:host.offsetLeft+point.x*host.clientWidth,y:host.offsetTop+point.y*host.clientHeight};
}

function calibrationHandle(groupId,attributes,point,label,text){
  const p=calibrationScreenPoint(point),group=document.createElementNS('http://www.w3.org/2000/svg','g');
  for(const[key,value]of Object.entries(attributes))group.dataset[key]=value;
  group.setAttribute('tabindex','0');group.setAttribute('role','button');group.setAttribute('aria-label',label+'，方向键微调');
  const hit=document.createElementNS(group.namespaceURI,'circle');hit.setAttribute('cx',p.x);hit.setAttribute('cy',p.y);hit.setAttribute('r','22');hit.style.fill='transparent';hit.style.stroke='none';hit.style.filter='none';hit.style.pointerEvents='all';
  const circle=document.createElementNS(group.namespaceURI,'circle');circle.setAttribute('cx',p.x);circle.setAttribute('cy',p.y);circle.setAttribute('r','14');
  const title=document.createElementNS(group.namespaceURI,'text');title.setAttribute('x',p.x);title.setAttribute('y',p.y+4);title.textContent=text;
  group.append(hit,circle,title);$(groupId).append(group);return group;
}

function drawCalibration() {
  const overlay=$('calibration-overlay');if(!overlay || !calibrationMode)return;
  const viewport=$('viewport');overlay.setAttribute('viewBox',`0 0 ${viewport.clientWidth} ${viewport.clientHeight}`);
  const points=calibrationPoints.map(calibrationScreenPoint);
  $('calibration-polygon').setAttribute('points',points.map(p=>`${p.x},${p.y}`).join(' '));
  $('calibration-polygon').classList.toggle('muted',calibrationStep===1);
  $('calibration-grid').replaceChildren();calibrationPreviewResult=null;
  try{
    const meta=studio.backgroundMetadata;
    const result=calibrationCamera(calibrationDraft(),meta?.width||$('stage').clientWidth,meta?.height||$('stage').clientHeight);
    for(const segment of calibrationGridLines(result)){
      const a=calibrationScreenPoint(segment.a),b=calibrationScreenPoint(segment.b),line=document.createElementNS(overlay.namespaceURI,'line');
      for(const[key,value]of Object.entries({x1:a.x,y1:a.y,x2:b.x,y2:b.y}))line.setAttribute(key,value);
      if(segment.boundary)line.classList.add('boundary');$('calibration-grid').append(line);
    }
    calibrationPreviewResult=result;studio.applyCalibration(result);
    const feedback=calibrationFitFeedback(result,calibrationPoints);
    $('calibration-status').textContent=feedback.message;
    $('calibration-status').dataset.quality=feedback.quality;
  }catch(error){$('calibration-status').textContent=error.message;$('calibration-status').dataset.quality='needs-adjustment';}
  $('calibration-points').replaceChildren();$('calibration-points').style.display=calibrationStep===0?'':'none';
  points.forEach((_,index)=>calibrationHandle('calibration-points',{point:index},calibrationPoints[index],['底板后左角','底板后右角','底板前右角','底板前左角'][index],index+1));
  $('calibration-uprights').replaceChildren();$('calibration-uprights').style.display=calibrationStep===1?'':'none';
  calibrationUprights.forEach((cue,index)=>{
    const a=calibrationScreenPoint(cue.a),b=calibrationScreenPoint(cue.b),line=document.createElementNS(overlay.namespaceURI,'line');
    for(const[key,value]of Object.entries({x1:a.x,y1:a.y,x2:b.x,y2:b.y}))line.setAttribute(key,value);
    line.classList.toggle('confirmed',Boolean(calibrationUprightConfirmed[index]));$('calibration-uprights').append(line);
    for(const endpoint of ['a','b'])calibrationHandle('calibration-uprights',{upright:index,endpoint},cue[endpoint],`竖直参考线 ${index+1} ${endpoint==='a'?'上':'下'}端点`,`${index+1}${endpoint==='a'?'A':'B'}`);
  });
  const count=calibrationUprightConfirmed.filter(Boolean).length;
  $('use-upright-guides').checked=Boolean(calibrationUprights.length)&&count===calibrationUprights.length;
  $('use-upright-guides').indeterminate=count>0&&count<calibrationUprights.length;
  $('upright-guide-status').textContent=calibrationUprightNotice||(count?`已使用 ${count} 条竖直参考；拖动端点可继续微调。`:'绿线是待确认草稿，尚未用于对齐。请贴住真实立柱，再勾选确认。');
  $('apply-calibration').disabled=!calibrationPreviewResult;
}

function calibrationPoint(event) {
  const rect=$('stage').getBoundingClientRect();return{x:(event.clientX-rect.left)/rect.width,y:(event.clientY-rect.top)/rect.height};
}

function syncCalibrationStep(){
  for(const button of document.querySelectorAll('[data-calibration-step]')){
    const selected=Number(button.dataset.calibrationStep)===calibrationStep;button.classList.toggle('active',selected);button.setAttribute('aria-selected',selected);button.tabIndex=selected?0:-1;
  }
  $('upright-guide-controls').hidden=calibrationStep!==1;
  $('calibration-floor-controls').hidden=calibrationStep!==0;
  $('calibration-instruction').textContent=calibrationStep===0?'蓝点依次贴住后左、后右、前右、前左角。虚框是标记，实线网格是模型实际透视；画外角只能估计。':'把绿线两端贴住照片中确定竖直的立柱或导轨，勿按屏幕竖直方向拉直。拖端点即确认该线，也可勾选两条一起确认。';
  $('calibration-handle-select').replaceChildren();
  const handles=calibrationStep===0?['后左角','后右角','前右角','前左角'].map((label,index)=>({value:'corner-'+index,label}))
    :calibrationUprights.flatMap((_,index)=>['a','b'].map(endpoint=>({value:`upright-${index}-${endpoint}`,label:`竖线${index+1} ${endpoint==='a'?'上端':'下端'}`})));
  for(const handle of handles){const option=document.createElement('option');option.value=handle.value;option.textContent=handle.label;$('calibration-handle-select').append(option);}
  if(!handles.some(handle=>handle.value===calibrationSelectedHandle))calibrationSelectedHandle=handles[0]?.value||'';
  $('calibration-handle-select').value=calibrationSelectedHandle;
  drawCalibration();
}

function selectCalibrationHandle(value){calibrationSelectedHandle=value;$('calibration-handle-select').value=value;}
function nudgeCalibrationHandle(value,dx,dy){
  if(value.startsWith('corner-')){
    const point=calibrationPoints[Number(value.split('-')[1])];if(!point)return;
    point.x=Math.max(-.5,Math.min(1.5,point.x+dx));point.y=Math.max(-.5,Math.min(1.5,point.y+dy));
  }else{
    const[,index,endpoint]=value.split('-'),line=calibrationUprights[Number(index)];if(!line)return;
    line[endpoint]={x:Math.max(0,Math.min(1,line[endpoint].x+dx)),y:Math.max(0,Math.min(1,line[endpoint].y+dy))};
    calibrationUprightConfirmed[Number(index)]=true;calibrationUprightNotice='';
  }
  drawCalibration();
}

function cameraSnapshot(){
  const meta=studio.backgroundMetadata,scale=studio.sourceMillimetresToWorld;
  return {position:studio.camera.position.toArray(),target:studio.controls.target.toArray(),up:studio.camera.up.toArray(),
    fov:focalLengthToFov(studio.getLensOptions().focalLength),imageSize:{width:meta?.width||$('stage').clientWidth,height:meta?.height||$('stage').clientHeight},
    ...(activeCalibration?{bedWidth:activeCalibration.bedWidth*scale,bedDepth:activeCalibration.bedDepth*scale}:{})};
}

function startCalibration(suggested=null) {
  if(calibrationMode)return;
  if(cropEditing)finishCrop(false);
  clearTimeout(cacheTimer);
  calibrationSnapshot={camera:cameraSnapshot(),bedSize:studio.getCalibrationBedSize(),pose:modelPose(),appearance:$('output-appearance').value,time,playing,transformMode,perspectiveMode,
    bedWidth:$('bed-width').value,bedDepth:$('bed-depth').value};
  calibrationPreviousTime=time;playing=false;setPerspectiveMode(false);setPlacementMode(false);calibrationMode=true;calibrationSessionId++;
  calibrationPoints=Array.isArray(suggested)&&suggested.length===4?suggested.map(p=>({...p})):activeCalibration?.points?.map(p=>({...p}))||[{x:.2,y:.45},{x:.8,y:.45},{x:.9,y:.9},{x:.1,y:.9}];
  calibrationInitialPoints=calibrationPoints.map(p=>({...p}));
  const confirmed=normalizeUprightLines(activeCalibration?.verticalLines||[]).slice(0,2);
  const seeds=[{a:{x:.28,y:.2},b:{x:.28,y:.65}},{a:{x:.75,y:.2},b:{x:.75,y:.65}}];
  calibrationUprights=normalizeUprightLines([...confirmed,...seeds.slice(confirmed.length)]);
  calibrationUprightConfirmed=calibrationUprights.map((_,index)=>index<confirmed.length);calibrationUprightNotice='';
  $('bed-width').value=activeCalibration?.bedWidth||(backgroundPreset?printerPresets[backgroundPreset].width:256);
  $('bed-depth').value=activeCalibration?.bedDepth||(backgroundPreset?printerPresets[backgroundPreset].depth:256);
  calibrationSnapshot.editorInitial={points:calibrationPoints.map(point=>({...point})),uprights:normalizeUprightLines(calibrationUprights),confirmed:[...calibrationUprightConfirmed],bedWidth:$('bed-width').value,bedDepth:$('bed-depth').value};
  syncBedDimensionChoice();calibrationStep=0;calibrationSelectedHandle='corner-0';
  studio.controls.enabled=false;$('calibration-panel').hidden=false;$('calibration-overlay').removeAttribute('hidden');$('canvas-tools').hidden=true;
  $('detect-uprights').disabled=false;$('detect-uprights').textContent='自动找立柱';
  time=settings().duration;updateSettings();syncCalibrationStep();updateReferenceView();
}

function stopCalibration(commit=false) {
  if(!calibrationMode)return;
  calibrationDetectionController?.abort();calibrationDetectionController=null;calibrationSessionId++;
  const previous=calibrationSnapshot;calibrationSnapshot=null;calibrationMode=false;calibrationDragIndex=null;calibrationUprightDrag=null;gridDrag=null;
  $('calibration-panel').hidden=true;$('calibration-overlay').setAttribute('hidden','');$('canvas-tools').hidden=false;
  if(!commit&&previous){studio.setOptions(previous.pose);$('output-appearance').value=previous.appearance;$('bed-width').value=previous.bedWidth;$('bed-depth').value=previous.bedDepth;}
  time=commit?settings().duration:previous?.time??calibrationPreviousTime;updateSettings();
  if(!commit&&previous){studio.applyCalibration(previous.camera);studio.restoreCalibrationBedSize(previous.bedSize);}
  setModelMode(null);
  playing=!commit&&Boolean(previous?.playing);
  showTime();updateReferenceView();persistSettings();
}

function applyCalibration() {
  try {
    const calibration=withPresetCameraHints(calibrationDraft());
    const meta=studio.backgroundMetadata,result=calibrationCamera(calibration,meta?.width||$('stage').clientWidth,meta?.height||$('stage').clientHeight);
    activeCalibration=calibration;studio.setOptions(renderOptions());studio.applyCalibration(result);stopCalibration(true);showTime();
    try{localStorage.setItem(calibrationStorageKey(),JSON.stringify(activeCalibration));}catch{}
    queueProjectState();say(calibrationFitFeedback(result,calibrationPoints).message);
  }catch(error){$('calibration-status').textContent=error.message;}
}

function syncBedDimensionChoice(){
  const width=Number($('bed-width').value),depth=Number($('bed-depth').value);
  $('bed-size-preset').value=width===330&&depth===320?'h2c':width===256&&depth===256?'256':'custom';
}

async function detectCalibrationUprights(){
  if(!calibrationMode||studio.backgroundMetadata?.type!=='image'||!backgroundFile)return;
  const session=calibrationSessionId,file=backgroundFile,button=$('detect-uprights');
  calibrationDetectionController?.abort();const request=new AbortController();calibrationDetectionController=request;
  button.disabled=true;button.textContent='寻找立柱…';calibrationUprightNotice='正在本机寻找直线，仅作为待确认建议。';drawCalibration();
  try{
    // Decode with the same browser path as photo composition, then submit an
    // orientation-free PNG. JPEG EXIF rotation must not move normalized guides.
    const decoded=await readPhoto(file,{maxWidth:1600});
    const canvas=document.createElement('canvas');canvas.width=decoded.width;canvas.height=decoded.height;
    canvas.getContext('2d').putImageData(new ImageData(decoded.rgba,decoded.width,decoded.height),0,0);
    const png=await new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('照片读取失败')),'image/png'));
    if(!calibrationMode||session!==calibrationSessionId||file!==backgroundFile)return;
    const candidate=await api('/api/calibration/uprights',{method:'POST',headers:{'Content-Type':'image/png'},body:png,signal:request.signal});
    if(!calibrationMode||session!==calibrationSessionId||file!==backgroundFile)return;
    const lines=normalizeUprightLines(candidate.lines||[]).slice(0,2);
    if(!lines.length){calibrationUprightNotice='未找到可靠立柱，请手动把绿线贴住真实竖直边缘。';return;}
    calibrationUprights=normalizeUprightLines(lines.length===2?lines:[lines[0],calibrationUprights[1]]);calibrationUprightConfirmed=calibrationUprights.map(()=>false);
    calibrationUprightNotice=(candidate.confidence==='low'?'候选可信度较低。':'已找到候选直线。')+'请核对确实是竖直立柱后勾选确认。'+(candidate.warnings?.[0]?' '+candidate.warnings[0]:'');
    syncCalibrationStep();
  }catch(error){if(error.name!=='AbortError'&&calibrationMode&&session===calibrationSessionId)calibrationUprightNotice='自动查找不可用；仍可手动拖动绿线贴住立柱。';}
  finally{if(calibrationMode&&session===calibrationSessionId){button.disabled=false;button.textContent='自动找立柱';calibrationDetectionController=null;drawCalibration();}}
}

function clearBackgroundUI(nextScene=scene) {
  ++backgroundLoadSequence;
  if(calibrationMode)stopCalibration();
  rememberBackgroundAppearance();scene=nextScene;
  studio.clearBackground();backgroundFile=null;posePlacement=null;
  cropRect=null;cropEditing=false;$('crop-overlay').setAttribute('hidden','');$('crop-panel').hidden=true;backgroundPreset='';markPreset();clearReference();
  activeCalibration=null;
  applyBackgroundAppearance();
  $('composite-options').hidden=true;$('calibrate-button').hidden=true;$('auto-bed-button').hidden=true;$('reference-button').hidden=true;
  $('source-ratio').hidden=true;if(['source','crop'].includes($('ratio').value))$('ratio').value='16:9';$('edit-crop').hidden=true;
  $('preview-mode').textContent='实时预览';$('floor-label').textContent='显示地面';setPlacementMode(false);
  cachePatch({backgroundFile:null,backgroundPreset:null,referenceFile:null});
}

async function restoreProjectBackground(saved){
  if(saved?.backgroundFile)await setBackgroundFile(saved.backgroundFile,saved.backgroundPreset||'');
  else if(saved&&Object.hasOwn(saved,'backgroundFile')&&saved.backgroundFile===null&&!saved.backgroundPreset)clearBackgroundUI();
  else await loadPreset(backgroundPreset||'h2c');
}

async function loadModel(files, demo = false, {sourceUnits=null,preset=null,resliceExisting=false} = {}) {
  if(exporting || snapshotting || calibrationMode || cropEditing){say('完成当前操作后再更换模型。');return false;}
  if(loading){say('正在导入模型；请先点击“取消导入”，再选择其他文件。');return false;}
  const selected=[...(files||[])];
  if(demo || selected.length!==1 || !/\.(3mf|stl)$/i.test(selected[0]?.name||'')){
    const message='请选择一个包含原始模型网格的 3MF 或 STL。只有 G-code 路径的文件无法重新切片。';
    importProgressUI?.fail(message);say(message,true);$('model-input').value='';return false;
  }
  importController?.abort();
  const generation=++importSequence,abort=new AbortController();importController=abort;sliceController=abort;
  // Background lighting/camera stay with the scene. A new model on a printer
  // preset is fitted again instead of inheriting the old model's display size.
  const previousModelSettings=studio.hasModel()?{pose:modelPose(),surface:surfaceSettings(),preserveMaterials:$('preserve-materials').checked,toolColors:{...toolColors}}:null;
  const fitPrinterOnImport=!restoringProject&&!resliceExisting&&printerPresets[backgroundPreset]?.kind==='printer';
  const previousInteraction=importInteractionState||{controls:studio.controls.enabled,transform:studio.transform.enabled,pointerEvents:studio.canvas.style.pointerEvents};
  importInteractionState=previousInteraction;
  studio.controls.enabled=false;studio.transform.enabled=false;studio.canvas.style.pointerEvents='none';
  const file=selected[0];clearTimeout(cacheTimer);loading=true;playing=false;importProgressUI?.begin(file.name);lockWorkspace(true);
  studio.beginSceneUpdate?.();
  $('slice-feedback').hidden=false;$('slice-action').textContent='取消切片';$('slice-action').disabled=false;
  const check=()=>{if(abort.signal.aborted||generation!==importSequence)throw new DOMException('Aborted','AbortError');};
  const paint=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  let ready=false,prepared=null;
  try {
    await paint();check();
    const format=file.name.toLowerCase().split('.').pop(),units=format==='stl'&&[1,10,1000].includes(Number(sourceUnits))?Number(sourceUnits):1;
    const selectedPreset=['h2c','p1s','a1'].includes(preset)?preset:['h2c','p1s','a1'].includes(backgroundPreset)?backgroundPreset:'h2c';
    prepared=await prepareLocalModelSlice(file,{signal:abort.signal,preset:selectedPreset,sourceUnits:units,onProgress:event=>{
      if(generation===importSequence&&!abort.signal.aborted){importProgressUI?.update(event);$('slice-status').textContent=event.message||'正在准备真实切片…';}
    }});
    check();
    const {job,parsed}=prepared;
    importProgressUI?.update({phase:'model',message:'正在载入完整原模型，并附上本机切片器的真实打印路径…'});
    await paint();check();
    const options={parsedPrintGCode:parsed,signal:abort.signal,onDisplayProgress:event=>importProgressUI?.update({...event,phase:'surface',progress:event.total?event.completed/event.total:null}),
      printerToSource:job.printerToSource,toolColors:job.toolColors,sliceSettings:job.sliceSettings,sourceName:file.name,
      coordinateSource:'native-slicer-explicit-source-mapping',preserveScene:Boolean(previousModelSettings),
      ...(format==='stl'&&sourceUnits!==null?{sourceUnitMillimetres:units}:{})};
    await studio.loadFiles([file],options);
    // loadFiles commits model, paths and support together. After this point a
    // delivered cancellation must not turn a successful commit into a failure.
    const materials=new Map((studio.metadata.materialColors||[]).map(item=>[item.tool,item]));
    for(const tool of parsed.usedTools||[]){
      const color=job.toolColors?.[tool]||parsed.toolColors?.[tool]||materials.get(tool)?.color||studio.metadata.filamentPalette?.[tool];
      materials.set(tool,{tool,color:color||$('model-color').value,source:job.toolColors?.[tool]||parsed.toolColors?.[tool]?'slice':materials.get(tool)?.source||(/^#[\da-f]{6}$/i.test(studio.metadata.filamentPalette?.[tool]||'')?'file':'fallback')});
    }
    const provenance={clientRevision:LOCAL_SLICE_CLIENT_REVISION,engineId:job.engineId,engineRevision:job.engineRevision,engine:job.engine,
      sourceSha256:job.sourceSha256,gcodeSha256:job.gcodeSha256,format,preset:selectedPreset,sourceUnits:units,
      printerToSource:[...job.printerToSource],reSliced:true,originalGeometryRetained:true};
    Object.assign(studio.metadata,{name:file.name,format,sliceSourceMode:'local-native-slicer',originalCadAvailable:true,
      materialColors:[...materials.values()].sort((a,b)=>a.tool-b.tool),localSlice:provenance});
    modelRevision++;sliceReadyJob=provenance;modelSourceKey=job.sourceSha256;modelFile=file;manualSupportFile=null;manualSupportMapping=null;toolColors={};
    posePlacement=!fitPrinterOnImport&&posePlacement?.preset===backgroundPreset?{...posePlacement,modelSourceKey}:null;
    studio.setOptions(fitPrinterOnImport?DEFAULT_MODEL_POSE:previousModelSettings?.pose||DEFAULT_MODEL_POSE);setModelMode(null);
    $('preserve-materials').checked=previousModelSettings?.preserveMaterials??true;
    if(previousModelSettings)restoreSurfaceControls(previousModelSettings.surface);
    showMetadata(studio.metadata);
    if(resliceExisting&&previousModelSettings){toolColors={...toolColors,...previousModelSettings.toolColors};studio.setOptions({toolColors});}
    time=settings().duration;updateSettings();
    if(!previousModelSettings){
      studio.resetCamera();markView('perspective');
      if(activeCalibration){$('bed-width').value=activeCalibration.bedWidth;$('bed-depth').value=activeCalibration.bedDepth;applyActiveCamera();}
      const placed=applyPresetModelPlacement();
      if(fitPrinterOnImport&&!placed)throw new Error('模型构图未完成，请检查模型尺寸与底板透视。');
    }
    else if(fitPrinterOnImport&&!applyPresetModelPlacement())throw new Error('模型构图未完成，请检查模型尺寸与底板透视。');
    syncCameraFields();
    if(!restoringProject)cachePatch({modelFiles:[file],supportGcode:null,supportFile:null});
    $('slice-feedback').hidden=true;
    importProgressUI?.complete('已完成本机切片，原模型与真实打印路径已就绪。');
    say(`${job.engine} 切片已完成，可以摆放模型、预览生长或导出。`);ready=true;
  } catch(error) {
    if(prepared?.job?.id)await api(`/api/slices/${prepared.job.id}`,{method:'DELETE'}).catch(()=>{});
    if(generation===importSequence){
      const message=error.name==='AbortError'?'已取消切片，原项目已保留。':error.message;
      if(error.name==='AbortError')importProgressUI?.cancelled(message);else importProgressUI?.fail(message);
      $('slice-feedback').hidden=true;syncSourceUnitControls();
      say(message,error.name!=='AbortError');
    }
  } finally {
    if(generation===importSequence){loading=false;importController=null;sliceController=null;importInteractionState=null;studio.setTransformMode(transformMode);studio.lockPreviewCamera();studio.canvas.style.pointerEvents=previousInteraction.pointerEvents;lockWorkspace(false);$('model-input').value='';if(ready){persistSettings();queueProjectState();}}
    studio.endSceneUpdate?.();
  }
  if(ready&&!restoringProject&&!reducedMotion&&!calibrationMode&&!cropEditing&&studio.metadata.materialColors.every(item=>item.source!=='fallback')){time=0;playing=true;showTime();}
  return ready;
}

function markView(view) {
  for (const button of document.querySelectorAll('[data-view]')) {
    const active = button.dataset.view === view;
    button.classList.toggle('active', active); button.setAttribute('aria-pressed',active);
  }
}

async function api(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || `请求失败（${response.status}），请重试。`);
  return data;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a'); link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

async function saveSnapshot() {
  if (exporting || exportAuthorizing || loading || snapshotting || alignBusy || !studio?.hasModel()) return;
  exportAuthorizing=true;
  try {
    if(!await ensureExportUnlocked())return;
    if (exporting || loading || snapshotting || alignBusy || !studio?.hasModel()) return;
    if(studio.metadata.colorConfirmationRequired&&!await ensureModelSlice())return;
    if(calibrationMode||cropEditing){say('先点击画面下方的“完成”，再保存画面。');return;}
    setModelMode(null);
    playing = false;
    studio.endPreviewInteraction?.();previewPlaybackActive=false;
    const config = settings();
    const {width,height} = outputSize(config.ratio,config.resolution);
    const plan=exportRenderPlan(width,height);
    snapshotting=true;lockWorkspace(true);
    const previousTransform=studio.transform.enabled;
    studio.controls.enabled=false;studio.transform.enabled=false;
    try {
      if(config.appearance==='photo'&&outputFormat(config.format).transparent)throw new Error('实拍外观包含完整背景，请选择 MP4 格式。');
      const photo=config.appearance==='photo'?await preparePhotoFrames(width,height):null;
      studio.startExport(plan.renderWidth,plan.renderHeight);
      studio.setOptions({...renderOptions(),transparent:outputFormat(config.format).transparent});
      const state = timelineState(time,config.duration,config.hold,config.motion);
      let blob=await studio.captureFrame(state.progress,state.rotation,time,{outputPlan:plan});
      if(photo)blob=await composePhotoBlob(blob,growthProgress(state.progress),photo);
      if(!await ensureExportUnlocked()){say('画面未保存，可以继续调整。');return;}
      blob=await applyFramePush(blob,cameraMotionScale(time,config));
    downloadBlob(blob,'模型生长-画面.png');
      say('当前画面已保存。');
    } catch(error) { say(error.message,true); }
    finally { studio.endExport(); studio.setOptions(renderOptions());snapshotting=false;studio.lockPreviewCamera();studio.transform.enabled=previousTransform;lockWorkspace(false);showTime(); }
  } finally { exportAuthorizing=false; }
}

async function cancelExport() {
  if (!exporting) { $('export-dialog').close(); return; }
  cancelled = true;
  controller?.abort();
  $('cancel-export').disabled = true;
  $('export-detail').textContent = '正在取消并清理…';
  if (exportId) {
    const route=exportBackend==='realistic'?'realistic-exports':'exports';
    exportCancellation ||= api(`/api/${route}/${exportId}`,{method:'DELETE'});
    await exportCancellation.catch(() => {});
  }
}

function showRealisticExportResult(snapshot,config,id) {
  const result=realisticDownloadResult(snapshot,id);
  $('export-title').textContent='完成，可以下载了。';
  $('export-detail').textContent=outputFormat(config.format).success;
  $('export-progress').value=100;$('export-percent').textContent='100%';
  $('export-frame-count').textContent=`${snapshot.total} / ${snapshot.total} 帧`;
  const link=document.createElement('a');link.href=result.url;link.download=result.filename;link.className='button primary';
  link.textContent=outputFormat(config.format).download;
  const info=document.createElement('small');info.textContent=`${result.filename} · ${(result.bytes/1024/1024).toFixed(1)} MB`;
  $('export-result').replaceChildren(link,info);$('export-result').hidden=false;
  $('cancel-export').textContent='返回工作台';
  say('写实导出完成。模型面数、完整帧数与相机透视已验证。');
}

async function exportRealisticVideo(config) {
  const eligibility=realisticEligibility(config);
  if(!eligibility.available){say(eligibility.reason,true);return;}
  const {width,height}=outputSize(config.ratio,config.resolution),plan=realisticFramePlan(config);
  if(plan.frames>(realisticRuntime?.limits?.maxFrames||1800)){say('当前时长超过写实范围。可选择实时画质导出完整时长。',true);return;}
  exporting=true;playing=false;cancelled=false;exportId=null;exportBackend='realistic';exportCancellation=null;controller=new AbortController();
  const signal=controller.signal;
  const preview={controlsEnabled:studio.controls.enabled,damping:studio.controls.enableDamping,transformEnabled:studio.transform.enabled,pointerEvents:studio.canvas.style.pointerEvents,position:studio.camera.position.clone(),quaternion:studio.camera.quaternion.clone(),target:studio.controls.target.clone()};
  lockWorkspace(true);studio.canvas.style.pointerEvents='none';studio.transform.enabled=false;studio.controls.enabled=false;
  // Drain any leftover orbit damping, then restore the captured fixed pose.
  // The detached scene exporter never advances or resizes this preview.
  studio.controls.enableDamping=false;studio.controls.update();studio.camera.position.copy(preview.position);studio.camera.quaternion.copy(preview.quaternion);studio.controls.target.copy(preview.target);
  $('export-title').textContent=outputFormat(config.format).realisticTitle;
  $('export-detail').textContent='正在准备完整模型与当前实景…';
  $('export-progress').value=0;$('export-percent').textContent='0%';$('export-frame-count').textContent=`0 / ${plan.frames} 帧`;
  $('export-result').replaceChildren();$('export-result').hidden=true;$('cancel-export').disabled=false;$('cancel-export').textContent='取消导出';
  $('export-dialog').setAttribute('aria-busy','true');$('export-dialog').showModal();
  try {
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    if(cancelled)throw new DOMException('Aborted','AbortError');
    studio.setOptions({...renderOptions(),transparent:outputFormat(config.format).transparent});
    const packageResult=await studio.createRenderPackage({output:{width,height,fps:config.fps,...plan,samples:64},backgroundFile,bedWidthMm:Number($('bed-width').value),bedDepthMm:Number($('bed-depth').value),cameraMode:'fixed'});
    if(cancelled)throw new DOMException('Aborted','AbortError');
    $('export-detail').textContent='正在提交完整写实任务…';
    const parameters=new URLSearchParams({name:studio.metadata.name.replace(/\.[^.]+$/,'')+'-写实生长',format:config.format,exportMode:config.watermarked?'watermarked':'unlocked'});
    // Keep POST un-aborted so a cancellation can always receive and clean its ID.
    const job=await api(`/api/realistic-exports?${parameters}`,{method:'POST',headers:{'Content-Type':'application/zip'},body:packageResult.blob});
    exportId=job.id;
    if(cancelled)throw new DOMException('Aborted','AbortError');
    const result=await waitForRealisticExport({id:job.id,request:api,signal,onSnapshot:snapshot=>{
      const progress=realisticProgress(snapshot);
      $('export-progress').value=progress.percent;$('export-percent').textContent=`${progress.percent}%`;$('export-frame-count').textContent=`${progress.encoded} / ${progress.total} 帧`;
      if($('export-detail').textContent!==progress.detail)$('export-detail').textContent=progress.detail;
    }});
    if(result.status==='cancelled')throw new DOMException('Aborted','AbortError');
    if(result.status==='error')throw new Error(result.failure||'写实导出未完成。');
    showRealisticExportResult(result,config,job.id);exportId=null;
  } catch(error) {
    const id=exportId;
    const outcome=id?await (exportCancellation||api(`/api/realistic-exports/${id}`,{method:'DELETE'})).catch(()=>null):null;
    exportId=null;
    // A cancellation arriving during verified atomic save may return complete.
    // Keep that successful file visible instead of closing or deleting it.
    if(outcome?.status==='complete')showRealisticExportResult(outcome,config,id);
    else if(cancelled||error.name==='AbortError'){$('export-dialog').close();say(outcome||!id?'已取消导出，可以继续调整。':'取消请求暂未确认；连接恢复后再试。',Boolean(id&&!outcome));}
    else {$('export-title').textContent='这次写实导出没有完成';$('export-detail').textContent=error.message+' 可选择实时画质重试，模型不会减面。';$('cancel-export').textContent='返回工作台';say(error.message,true);}
  } finally {
    exporting=false;controller=null;exportCancellation=null;exportBackend='realtime';
    studio.setOptions(renderOptions());studio.canvas.style.pointerEvents=preview.pointerEvents;studio.transform.enabled=preview.transformEnabled;studio.controls.enableDamping=preview.damping;studio.lockPreviewCamera();
    $('export-dialog').removeAttribute('aria-busy');$('cancel-export').disabled=false;
    updateStageBounds();lockWorkspace(false);showTime();updateReferenceView();queueProjectState();
  }
}

async function exportVideo() {
  if (exporting || exportAuthorizing || snapshotting || loading || alignBusy || !studio?.hasModel()) return;
  if(pendingSoundImport){say('自定义音效正在载入，请完成后再导出。');return;}
  exportAuthorizing=true;
  try {
    const exportPermission=await ensureExportUnlocked({allowWatermarked:settings().format==='mp4'});
    if(!exportPermission)return;
    if (exporting || snapshotting || loading || alignBusy || !studio?.hasModel()) return;
    if(calibrationMode||cropEditing){say('先点击画面下方的“完成”，再导出视频。');return;}
    if(!await ensureModelSlice())return;
    if(pendingSoundImport){say('自定义音效正在载入，请完成后再导出。');return;}
    setModelMode(null);
    studio.endPreviewInteraction?.();previewPlaybackActive=false;
    const config = {...settings(),watermarked:exportPermission==='watermarked'};
    const exportSoundFile=config.soundEffect==='custom'?customSoundFile:null;
    if (outputFormat(config.format).video && !ffmpegAvailable) {
      say('本机缺少视频编码器。可在“导出格式”选择透明 PNG 序列，或按使用说明安装 FFmpeg。',true); return;
    }
    if(config.format==='mov-alpha'&&!alphaVideoAvailable){say('本机编码器不支持透明 MOV 视频，可先导出透明 PNG 序列。',true);return;}
    if(config.quality==='realistic')return await exportRealisticVideo(config);
    exportBackend='realtime';exportCancellation=null;
    stopEffectAudio();
    exporting = true; playing = false; cancelled = false; exportId = null; controller = new AbortController();
    const {width,height} = outputSize(config.ratio,config.resolution);
    const plan=exportRenderPlan(width,height);
    const frames = Math.round(config.duration*config.fps);
    const signal = controller.signal;
    lockWorkspace(true);
    $('export-title').textContent = outputFormat(config.format).title;
    $('export-detail').textContent = '准备渲染…';
    $('export-progress').value = 0; $('export-percent').textContent = '0%';
    $('export-frame-count').textContent = `0 / ${frames} 帧`;
    $('export-result').replaceChildren(); $('export-result').hidden = true;
    $('cancel-export').disabled = false; $('cancel-export').textContent = '取消导出';
    $('export-dialog').showModal();
    const started = performance.now();
    try {
      if(config.appearance==='photo'&&outputFormat(config.format).transparent)throw new Error('实拍外观包含完整背景，请选择 MP4 格式。');
      const photo=config.appearance==='photo'?await preparePhotoFrames(width,height):null;
      // Keep creation uncancelled so its ID is always known and a cancelled job is cleaned up.
      const job = await api('/api/exports',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({width,height,fps:config.fps,frames,format:config.format,soundEffect:config.soundEffect,soundVolume:config.soundVolume,exportMode:config.watermarked?'watermarked':'unlocked',name:studio.metadata.name.replace(/\.[^.]+$/,'')+'-生长延时'})});
      exportId = job.id;
      if (cancelled) throw new DOMException('Aborted','AbortError');
      if(config.soundEffect==='custom'&&outputFormat(config.format).video){
        $('export-detail').textContent='正在准备自定义音效…';
        await api(`/api/exports/${exportId}/sound`,{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:exportSoundFile,signal});
      }
      if (config.format === 'mp4' && backgroundFile && studio.backgroundMetadata?.type === 'video' && $('background-audio').checked) {
        $('export-detail').textContent = '正在准备实拍视频原声…';
        await api(`/api/exports/${exportId}/background`,{method:'POST',headers:{'Content-Type':backgroundFile.type || 'video/mp4'},body:backgroundFile,signal});
      }
      studio.startExport(plan.renderWidth,plan.renderHeight);
      studio.setOptions({...renderOptions(),transparent:outputFormat(config.format).transparent});
      const pushCanvas=document.createElement('canvas');
      for (let index = 0; index < frames; index++) {
        if (cancelled) throw new DOMException('Aborted','AbortError');
        const frameTime = index / Math.max(1,frames-1) * config.duration;
        const state = timelineState(frameTime,config.duration,config.hold,config.motion);
        let blob = await studio.captureFrame(state.progress,state.rotation,index/config.fps,{outputPlan:plan,signal});
        if(photo)blob=await composePhotoBlob(blob,growthProgress(state.progress),photo);
        blob=await applyFramePush(blob,cameraMotionScale(frameTime,config),pushCanvas);
        await api(`/api/exports/${exportId}/frames?index=${index}`,{method:'POST',headers:{'Content-Type':'image/png'},body:blob,signal});
        const pct = Math.round((index+1)/frames*95);
        $('export-progress').value = pct; $('export-percent').textContent = `${pct}%`;
        $('export-frame-count').textContent = `${index+1} / ${frames} 帧`;
        const elapsed = (performance.now()-started)/1000;
        const remaining = (frames-index-1)*elapsed/(index+1);
        $('export-detail').textContent = index < 3 ? '正在逐帧生成画面…' : `正在生成画面，预计还需 ${remaining >= 60 ? Math.ceil(remaining/60)+' 分钟' : Math.max(1,Math.ceil(remaining))+' 秒'}`;
      }
      $('export-detail').textContent = outputFormat(config.format).video ? '画面已完成，正在保存视频…' : '画面已完成，正在打包图片…';
      const result = await api(`/api/exports/${exportId}/finish`,{method:'POST',signal});
      if (cancelled) throw new DOMException('Aborted','AbortError');
      exportId = null;
      $('export-title').textContent = '完成，可以下载了。';
      $('export-detail').textContent = outputFormat(config.format).success;
      $('export-progress').value = 100; $('export-percent').textContent = '100%';
      const link = document.createElement('a'); link.href = result.url; link.download = result.filename; link.className = 'button primary';
      link.textContent = outputFormat(config.format).download;
      const info = document.createElement('small'); info.textContent = `${result.filename} · ${(result.bytes/1024/1024).toFixed(1)} MB`;
      $('export-result').append(link,info); $('export-result').hidden = false;
      $('cancel-export').textContent = '返回工作台';
      say('导出完成。可以下载文件，也可以继续制作下一个视频。');
    } catch (error) {
      if (exportId) await api(`/api/exports/${exportId}`,{method:'DELETE'}).catch(() => {});
      exportId = null;
      if (cancelled || error.name === 'AbortError') { $('export-dialog').close(); say('已取消导出，可以继续调整。'); }
      else { $('export-title').textContent = '这次导出没有完成'; $('export-detail').textContent = error.message; $('cancel-export').textContent = '返回工作台'; say(error.message,true); }
    } finally {
      studio.endExport(); exporting = false; controller = null;
      studio.setOptions(renderOptions()); studio.lockPreviewCamera();updateStageBounds(); lockWorkspace(false); showTime();
      $('cancel-export').disabled = false;updateReferenceView();
    }
  } finally { exportAuthorizing=false; }
}

function tick(timestamp) {
  if(lastTick&&timestamp>lastTick){
    previewFrameIntervals.push(timestamp-lastTick);if(previewFrameIntervals.length>60)previewFrameIntervals.shift();
    if(previewFrameIntervals.length===60){const sorted=[...previewFrameIntervals].sort((a,b)=>a-b);$('stage').dataset.previewFrameMs=sorted[30].toFixed(1);$('stage').dataset.previewFps=(1000/sorted[30]).toFixed(1);}
  }
  const delta = lastTick ? Math.min((timestamp-lastTick)/1000,0.2) : 0;
  lastTick = timestamp;
  if (playing && !exporting && !loading && !document.hidden) {
    time += delta;
    if (time >= settings().duration) {
      if ($('loop').checked) time %= settings().duration;
      else { time = settings().duration; playing = false; }
    }
    showTime();
  }else if(previewPlaybackActive)syncPreviewPlaybackInteraction();
  if(timestamp-lastRealisticPreviewCheck>=100){lastRealisticPreviewCheck=timestamp;syncRealisticPreview();}
  requestAnimationFrame(tick);
}

async function init() {
  restoringProject=true;restoreSettings();const desiredRatio=$('ratio').value,desiredSupports=$('show-supports').checked;time = settings().duration;updateStageBounds();
  if($('ratio').value==='source')$('ratio').value='16:9';
  const styledSelects=initializeStyledSelects(document);
  window.addEventListener('pagehide',event=>{if(!event.persisted)for(const select of styledSelects)select.dispose();});
  try { studio = new GrowthStudio($('stage')); }
  catch(error) { say(`预览启动失败：${error.message}。请使用支持 WebGL 的 Chrome 或 Safari。`,true); lockWorkspace(true); return; }
  studio.beginSceneUpdate?.();
  importProgressUI=createImportProgressUI({document,onCancel:()=>{importController?.abort();importProgressUI?.canceling();}});
  $('slice-action').addEventListener('click',()=>{sliceController?.abort();importProgressUI?.canceling();$('slice-action').disabled=true;});
  $('source-unit').addEventListener('change',async()=>{
    const units=Number($('source-unit').value);
    if(!loading&&modelFile&&/\.stl$/i.test(modelFile.name)&&[1,10,1000].includes(units))await loadModel([modelFile],false,{sourceUnits:units,resliceExisting:true});
  });
  photoPreview=new PhotoPreviewRenderer({canvas:$('photo-growth-layer'),studio,prepare:preparePhotoFrames,renderBase:(progress,{afterPrepare})=>{if(afterPrepare)studio.render(progress,0);return studio.canvas;},onError:error=>say(error.message,true)});
  realisticPreview=new RealisticPreviewRenderer({image:$('realistic-preview-layer'),request:api,onState:showRealisticPreviewState,
    prepare:({width,height,progress})=>studio.createRenderPackage({output:{width,height,fps:1,frames:1,growthFrames:1,samples:64,previewProgress:progress},backgroundFile,bedWidthMm:Number($('bed-width').value),bedDepthMm:Number($('bed-depth').value),cameraMode:'fixed'}),
    readImage:async(url,{signal})=>{const response=await fetch(url,{signal});if(!response.ok)throw new Error('写实预览画面读取失败。');const blob=await response.blob();if(blob.type!=='image/png'||!blob.size)throw new Error('写实预览画面格式无效。');return blob;}});
  window.addEventListener('pagehide',event=>{realisticPreview.dispose();if(event.persisted)previewSoundPlayer?.pause();else{cancelSoundImport();previewSoundPlayer?.dispose();if(customSoundUrl)URL.revokeObjectURL(customSoundUrl);}});
  new ResizeObserver(updateStageBounds).observe($('viewport'));
  new ResizeObserver(()=>{$('viewport').style.setProperty('--canvas-tools-height',`${Math.max(54,$('canvas-tools').getBoundingClientRect().height)}px`);}).observe($('canvas-tools'));
  document.querySelector('.center-panel').insertBefore($('calibration-panel'),document.querySelector('.timeline'));
  document.querySelector('.center-panel').insertBefore($('crop-panel'),document.querySelector('.timeline'));
  studio.onTransformChange=()=>{
    playing=false;
    persistSettings();showTime();
  };
  studio.onShadowChange=options=>{
    $('light-azimuth').value=options.lightAzimuth;$('light-elevation').value=options.lightElevation;
    $('canvas-light-azimuth').value=options.lightAzimuth;$('canvas-light-elevation').value=options.lightElevation;
    syncLightingControls();persistSettings();showTime();
  };
  $('canvas-tools').hidden=false;
  $('sound-enabled').addEventListener('input',()=>{
    if($('sound-enabled').checked){clearCustomSound();soundRestoreComplete=true;unlockPreviewSound();}
    else cachePatch({soundMode:customSoundFile?'custom':'none'});
  });
  $('sound-import-button').addEventListener('click',()=>$('custom-sound-input').click());
  $('custom-sound-input').addEventListener('change',()=>{
    const file=$('custom-sound-input').files[0];$('custom-sound-input').value='';
    if(file)void importCustomSound(file);
  });
  $('remove-custom-sound').addEventListener('click',()=>{
    $('sound-enabled').checked=false;clearCustomSound();updateSettings();
  });
  for (const id of settingIds) if(id!=='export-quality')$(id).addEventListener('input',event=>{if(event.target.type==='range')touchPreviewInteraction();updateSettings();});
  $('export-quality').addEventListener('change',()=>{qualityPreference=$('export-quality').value;if(qualityPreference==='realistic')setModelMode(null);updateSettings();});
  $('ratio').addEventListener('change',()=>{if($('ratio').value==='crop')beginCrop();else{cropEditing=false;cropRect=null;$('crop-overlay').setAttribute('hidden','');$('crop-panel').hidden=true;$('edit-crop').hidden=true;updateSettings();updateReferenceView();}});
  $('growth-duration').addEventListener('blur',()=>{$('growth-duration').value=settings().growth;updateSettings();});
  $('import-button').addEventListener('click', () => $('model-input').click());
  $('model-input').addEventListener('change', () => {if ($('model-input').files.length) loadModel($('model-input').files);});
  $('background-button').addEventListener('click', () => $('background-input').click());
  $('background-input').addEventListener('change',async()=>{const file=$('background-input').files[0];if(!file)return;try{await setBackgroundFile(file);}catch(error){say(error.message,true);}finally{$('background-input').value='';}});
  for(const button of document.querySelectorAll('[data-preset]'))button.addEventListener('click',()=>loadPreset(button.dataset.preset).catch(error=>say(error.message,true)));
  $('auto-bed-button').addEventListener('click',()=>detectBed().catch(error=>say(error.message,true)));
  $('reference-button').addEventListener('click',()=>$('reference-input').click());
  $('reference-input').addEventListener('change',async()=>{const file=$('reference-input').files[0];if(!file)return;try{await loadReference(file);}catch(error){say(error.message,true);}finally{$('reference-input').value='';}});
  $('clear-reference').addEventListener('click',()=>{clearReference();cachePatch({referenceFile:null});});
  $('canvas-compare').addEventListener('click',()=>{setReferencePanel($('reference-popup').hidden);updateReferenceView();});
  $('close-reference-popup').addEventListener('click',()=>setReferencePanel(false));
  for(const id of ['show-reference','reference-opacity','reference-difference'])$(id).addEventListener('input',updateReferenceView);
  $('reference-blink').addEventListener('pointerdown',()=>{$('reference-layer').style.opacity=1;});
  for(const name of ['pointerup','pointerleave','pointercancel'])$('reference-blink').addEventListener(name,updateReferenceView);
  $('auto-reference-align').addEventListener('click',autoReferenceAlign);
  $('canvas-motion').addEventListener('click',()=>setAppearancePanel('motion',$('motion-popup').hidden));
  $('close-motion').addEventListener('click',()=>{setAppearancePanel('motion',false);$('canvas-motion').focus();});
  $('motion-popup').addEventListener('keydown',event=>{if(event.key==='Escape'&&!event.defaultPrevented){event.preventDefault();event.stopPropagation();setAppearancePanel('motion',false);$('canvas-motion').focus();}});
  document.addEventListener('visibilitychange',()=>{if(document.hidden)stopEffectAudio();});
  $('canvas-dof').addEventListener('click',()=>setAppearancePanel('dof',$('dof-popup').hidden));
  $('close-dof').addEventListener('click',()=>setAppearancePanel('dof',false));
  $('lens-camera-drag').addEventListener('change',event=>setPerspectiveMode(event.target.checked));
  $('canvas-color').addEventListener('click',()=>setAppearancePanel('color',$('color-popup').hidden));
  $('close-color').addEventListener('click',()=>setAppearancePanel('color',false));
  $('edit-crop').addEventListener('click',beginCrop);
  $('reset-crop').addEventListener('click',()=>{Object.assign(cropRect,{x:0,y:0,width:1,height:1});drawCrop();});
  $('apply-crop').addEventListener('click',()=>finishCrop(true));$('cancel-crop').addEventListener('click',()=>finishCrop(false));
  $('crop-overlay').addEventListener('pointerdown',event=>{if(!cropEditing)return;cropDrag={handle:event.target.closest('[data-crophandle]')?.dataset.crophandle||'move',origin:calibrationPoint(event),rect:{...cropRect}};event.preventDefault();});
  $('canvas-lock').addEventListener('click',()=>setModelMode(null));
  $('canvas-move').addEventListener('click',()=>setModelMode(transformMode==='translate'?null:'translate'));
  $('canvas-rotate').addEventListener('click',()=>setModelMode(transformMode==='rotate'?null:'rotate'));
  $('canvas-scale').addEventListener('click',()=>setModelMode(transformMode==='scale'?null:'scale'));
  for(const id of ['camera-pitch','camera-yaw','camera-roll'])$(id).addEventListener('input',changeCameraFromFields);
  for(const id of ['camera-focal-length','camera-focal-length-number'])$(id).addEventListener('input',changeLensFromFields);
  $('camera-focal-length-number').addEventListener('blur',event=>{const raw=event.target.value,value=Number(raw);event.target.value=raw.trim()&&Number.isFinite(value)?Math.max(18,Math.min(135,value)).toFixed(1):studio.getLensOptions().focalLength.toFixed(1);changeLensFromFields(event);});
  $('canvas-shadow').addEventListener('click',()=>setAppearancePanel('shadow',$('shadow-popup').hidden));
  $('close-shadow').addEventListener('click',()=>setAppearancePanel('shadow',false));
  $('reset-preset-lighting').addEventListener('click',resetPresetColorMatch);
  $('canvas-floor').addEventListener('change',()=>{$('floor').checked=$('canvas-floor').checked;updateSettings();});
  for(const id of ['shadow-opacity','shadow-radius','light-direction','light-azimuth','light-elevation'])$('canvas-'+id).addEventListener('input',()=>{
    if($('canvas-'+id).type==='range')touchPreviewInteraction();
    $(id).value=$('canvas-'+id).value;
    if(id==='light-direction'){$('light-azimuth').value={left:-45,right:45,front:0}[$(id).value];$('canvas-light-azimuth').value=$('light-azimuth').value;}
    updateSettings();
  });
  $('calibrate-button').addEventListener('click',()=>{if(!activeCalibration&&studio.backgroundMetadata?.type==='image')detectBed().catch(error=>say(error.message,true));else startCalibration();});
  $('restart-calibration').addEventListener('click',()=>{
    const initial=calibrationSnapshot?.editorInitial;if(!initial)return;
    calibrationPoints=initial.points.map(point=>({...point}));calibrationUprights=normalizeUprightLines(initial.uprights);calibrationUprightConfirmed=[...initial.confirmed];calibrationUprightNotice='';
    $('bed-width').value=initial.bedWidth;$('bed-depth').value=initial.bedDepth;syncBedDimensionChoice();drawCalibration();
  });
  $('cancel-calibration').addEventListener('click',()=>stopCalibration(false));
  $('apply-calibration').addEventListener('click',applyCalibration);
  for(const button of document.querySelectorAll('[data-calibration-step]'))button.addEventListener('click',()=>{calibrationStep=Number(button.dataset.calibrationStep);syncCalibrationStep();});
  document.querySelector('.calibration-step-tabs').addEventListener('keydown',event=>{
    if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();event.stopPropagation();
    calibrationStep=event.key==='Home'?0:event.key==='End'?1:1-calibrationStep;syncCalibrationStep();document.querySelector(`[data-calibration-step="${calibrationStep}"]`).focus();
  });
  $('use-upright-guides').addEventListener('change',()=>{calibrationUprightConfirmed=calibrationUprights.map(()=>$('use-upright-guides').checked);calibrationUprightNotice='';drawCalibration();});
  $('detect-uprights').addEventListener('click',detectCalibrationUprights);
  $('calibration-stand-upright').addEventListener('click',()=>{studio.setOptions(uprightModelPose(studio.options));drawCalibration();});
  $('bed-size-preset').addEventListener('change',()=>{
    const value=$('bed-size-preset').value;
    if(value!=='custom'){$('bed-width').value=value==='h2c'?330:256;$('bed-depth').value=value==='h2c'?320:256;}
    else $('bed-width').focus();
    drawCalibration();
  });
  for(const id of ['bed-width','bed-depth'])$(id).addEventListener('input',()=>{syncBedDimensionChoice();drawCalibration();});
  $('calibration-handle-select').addEventListener('change',event=>selectCalibrationHandle(event.target.value));
  for(const button of document.querySelectorAll('[data-calibration-nudge]'))button.addEventListener('click',()=>nudgeCalibrationHandle(calibrationSelectedHandle,Number(button.dataset.dx)*.002,Number(button.dataset.dy)*.002));
  $('calibration-overlay').addEventListener('pointerdown',event=>{
    if(!calibrationMode||event.button!==0)return;
    const uprightGroup=event.target.closest('[data-upright]');
    const pointGroup=event.target.closest('[data-point]');
    if(uprightGroup){calibrationUprightDrag={index:Number(uprightGroup.dataset.upright),endpoint:uprightGroup.dataset.endpoint};selectCalibrationHandle(`upright-${calibrationUprightDrag.index}-${calibrationUprightDrag.endpoint}`);}
    else if(pointGroup){calibrationDragIndex=Number(pointGroup.dataset.point);selectCalibrationHandle('corner-'+calibrationDragIndex);}
    else if(calibrationStep===0&&event.target.id==='calibration-polygon')gridDrag={origin:calibrationPoint(event),points:calibrationPoints.map(p=>({...p}))};
    event.preventDefault();
    drawCalibration();
  });
  $('calibration-overlay').addEventListener('keydown',event=>{
    const group=event.target.closest('[data-point],[data-upright]');if(!group||!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key))return;
    event.preventDefault();event.stopPropagation();const step=event.shiftKey?.01:.002;
    const value=group.dataset.upright!==undefined?`upright-${group.dataset.upright}-${group.dataset.endpoint}`:'corner-'+group.dataset.point;
    selectCalibrationHandle(value);nudgeCalibrationHandle(value,event.key==='ArrowLeft'?-step:event.key==='ArrowRight'?step:0,event.key==='ArrowUp'?-step:event.key==='ArrowDown'?step:0);
    const target=group.dataset.upright!==undefined?$(`calibration-uprights`).querySelector(`[data-upright="${group.dataset.upright}"][data-endpoint="${group.dataset.endpoint}"]`):$('calibration-points').querySelector(`[data-point="${group.dataset.point}"]`);
    target?.focus();
  });
  window.addEventListener('pointermove',event=>{
    if(calibrationMode&&calibrationUprightDrag){const point=calibrationPoint(event),{index,endpoint}=calibrationUprightDrag;calibrationUprights[index][endpoint]={x:Math.max(0,Math.min(1,point.x)),y:Math.max(0,Math.min(1,point.y))};calibrationUprightConfirmed[index]=true;calibrationUprightNotice='';drawCalibration();}
    else if(calibrationMode&&calibrationDragIndex!==null){const point=calibrationPoint(event);calibrationPoints[calibrationDragIndex]={x:Math.max(-.5,Math.min(1.5,point.x)),y:Math.max(-.5,Math.min(1.5,point.y))};drawCalibration();}
    else if(calibrationMode&&gridDrag){const p=calibrationPoint(event);calibrationPoints=gridDrag.points.map(old=>({x:Math.max(-.5,Math.min(1.5,old.x+p.x-gridDrag.origin.x)),y:Math.max(-.5,Math.min(1.5,old.y+p.y-gridDrag.origin.y))}));drawCalibration();}
    if(cropEditing)moveCrop(event);
  });
  for(const name of ['pointerup','pointercancel'])window.addEventListener(name,()=>{const refit=calibrationMode&&(calibrationDragIndex!==null||gridDrag);calibrationDragIndex=null;calibrationUprightDrag=null;clearPreviewGesture();gridDrag=null;cropDrag=null;if(refit)updateStageBounds();});
  for (const button of document.querySelectorAll('[data-view]')) button.addEventListener('click', () => {setModelMode(null);studio.setView(button.dataset.view);markView(button.dataset.view);showTime();});
  $('reset-camera').addEventListener('click',resetScene);
  for (const button of document.querySelectorAll('[data-scene]')) button.addEventListener('click', () => {
    clearBackgroundUI(button.dataset.scene);
    for (const el of document.querySelectorAll('[data-scene]')) {const active=el.dataset.scene===scene;el.classList.toggle('active',active);el.setAttribute('aria-pressed',active);}
    updateSettings();
  });
  for (const button of document.querySelectorAll('[data-color]')) button.addEventListener('click', () => {
    $('model-color').value = button.dataset.color;$('preserve-materials').checked = false;
    for (const el of document.querySelectorAll('[data-color]')) {const active=el===button;el.classList.toggle('active',active);el.setAttribute('aria-pressed',active);}
    updateSettings();
  });
  $('model-color').addEventListener('input', () => {$('preserve-materials').checked=false;document.querySelectorAll('[data-color]').forEach(el => {el.classList.remove('active');el.setAttribute('aria-pressed',false);});updateSettings();});
  const perspectiveGestureAllowed=()=>perspectiveMode&&!exporting&&!loading&&!snapshotting&&!alignBusy&&!calibrationMode&&!cropEditing;
  studio.canvas.addEventListener('pointerdown',event=>{if(perspectiveGestureAllowed()&&event.button===0){touchPreviewInteraction({hold:true});dragPerspective={pointerId:event.pointerId,x:event.clientX,y:event.clientY,camera:studio.getCameraOptions()};studio.canvas.setPointerCapture(event.pointerId);}});
  studio.canvas.addEventListener('pointermove',event=>{
    if(!dragPerspective||!perspectiveGestureAllowed())return;
    touchPreviewInteraction({hold:true});
    studio.setCameraOptions({...dragPerspective.camera,yaw:dragPerspective.camera.yaw+(event.clientX-dragPerspective.x)/studio.canvas.clientWidth*180,pitch:dragPerspective.camera.pitch-(event.clientY-dragPerspective.y)/studio.canvas.clientHeight*90});syncCameraFields();showTime();
  });
  studio.canvas.addEventListener('wheel',event => {
    if(!perspectiveGestureAllowed())return;
    event.preventDefault();const lens=studio.getLensOptions();applyLensChange(lens.focalLength*Math.exp(event.deltaY*.0015));
  },{passive:false});
  studio.canvas.addEventListener('lostpointercapture',clearPreviewGesture);
  $('play-button').addEventListener('click', () => playGrowth());
  $('restart-button').addEventListener('click', () => playGrowth(true));
  $('timeline').addEventListener('input', async () => {playing=false;touchPreviewInteraction();const wanted=Number($('timeline').value)/1000*settings().duration,revision=modelRevision;if(wanted<settings().duration&&!studio.getPrintLayerData?.()){time=settings().duration;showTime();if(!await ensureModelSlice()||revision!==modelRevision)return;}time=wanted;showTime();});
  $('export-button').addEventListener('click',exportVideo);$('export-button-bottom').addEventListener('click',exportVideo);
  $('snapshot-button').addEventListener('click',saveSnapshot);$('cancel-export').addEventListener('click',cancelExport);
  $('export-dialog').addEventListener('cancel',event => {if(exporting){event.preventDefault();cancelExport();}});
  $('help-button').addEventListener('click', () => $('help-dialog').showModal());
  for(const id of ['close-help','help-done']) $(id).addEventListener('click', () => $('help-dialog').close());
  let dragDepth=0;
  window.addEventListener('dragenter',event => {if(event.dataTransfer?.types.includes('Files')&&!exporting){event.preventDefault();dragDepth++;$('drop-overlay').classList.add('visible');}});
  window.addEventListener('dragover',event => {if(event.dataTransfer?.types.includes('Files')){event.preventDefault();event.dataTransfer.dropEffect=exporting?'none':'copy';}});
  window.addEventListener('dragleave',event => {if(event.dataTransfer?.types.includes('Files')){dragDepth=Math.max(0,dragDepth-1);if(!dragDepth)$('drop-overlay').classList.remove('visible');}});
  window.addEventListener('drop',event => {event.preventDefault();dragDepth=0;$('drop-overlay').classList.remove('visible');if(!exporting&&event.dataTransfer?.files.length)loadModel(event.dataTransfer.files);});
  window.addEventListener('beforeunload',event => {if(exporting){event.preventDefault();event.returnValue='';}});
  window.addEventListener('keydown',event=>{
    if(calibrationMode){if(event.key==='Escape'){event.preventDefault();stopCalibration(false);}return;}
    if(cropEditing){if(event.key==='Escape'){event.preventDefault();finishCrop(false);}return;}
    if(exporting||loading||snapshotting||alignBusy||!studio.hasModel()||document.querySelector('dialog[open]')||/^(INPUT|SELECT|TEXTAREA)$/.test(event.target.tagName)||event.target.closest?.('[role="combobox"]')||event.target.isContentEditable||event.metaKey||event.ctrlKey||event.repeat)return;
    if(event.key==='Escape'){event.preventDefault();setModelMode(null);}
    else if(event.key==='Home'){event.preventDefault();resetScene();}
    else if(event.key.toLowerCase()==='w')setModelMode('translate');
    else if(event.key.toLowerCase()==='e')setModelMode('rotate');
    else if(event.key.toLowerCase()==='r')setModelMode('scale');
  });
  try{
    const saved=await loadProjectFiles();
    await restoreProjectSound(saved);
    restoreBackgroundAppearanceCache(saved);
    if(saved?.modelFiles?.length)await loadModel(saved.modelFiles,false,{sourceUnits:saved.settings?.sourceUnits?.value??null,
      preset:saved.settings?.sliceCache?.clientRevision===LOCAL_SLICE_CLIENT_REVISION?saved.settings.sliceCache.preset:null});
    else { $('model-name').textContent='尚未导入模型';$('model-type').textContent='选择 3MF 或 STL'; }
    await restoreProjectBackground(saved);
    $('show-supports').checked=desiredSupports;
    if(saved?.referenceFile)await loadReference(saved.referenceFile);
    if(saved?.settings){
      if(saved.settings.sourceUnits?.key===modelSourceKey&&studio.metadata?.sourceUnitsInferred){studio.setSourceUnitMillimetres(saved.settings.sourceUnits.value);syncSourceUnitControls();}
      activeCalibration=withPresetCameraHints(saved.settings.activeCalibration||activeCalibration);toolColors={...toolColors,...saved.settings.toolColors};cropRect=saved.settings.cropRect||null;
      for(const input of document.querySelectorAll('#material-color-list input')){const tool=Number(input.getAttribute('aria-label').match(/\d+/)?.[0])-1;if(toolColors[tool])input.value=toolColors[tool];}
    }
    const savedPlacement=restoreSavedModelPlacement(saved);
    if(activeCalibration){$('bed-width').value=activeCalibration.bedWidth;$('bed-depth').value=activeCalibration.bedDepth;applyActiveCamera();}
    const presetCameraRevision=getPresetCalibration(backgroundPreset)?.calibrationRevision||0;
    const savedCamera=savedPlacement?.poseCamera||saved?.camera;
    if(savedCamera&&(!saved.settings?.activeCalibration?.photoKey||saved.settings.activeCalibration.photoKey===currentPhotoKey())&&(!presetCameraRevision||saved.settings?.cameraCalibrationRevision===presetCameraRevision)){
      const meta=studio.backgroundMetadata;
      const fitted=activeCalibration?calibrationCamera(activeCalibration,meta?.width||$('stage').clientWidth,meta?.height||$('stage').clientHeight):null;
      const restored=migratePhotoCameraMetric(savedCamera,{revision:savedPlacement?.poseCamera?savedPlacement.cameraMetricRevision:saved.settings?.cameraMetricRevision,modelScale:studio.options.modelScale,calibratedCamera:fitted});
      studio.applyCalibration(restored.camera);
    }
    const upgradedPlacement=upgradeRestoredPresetPlacement(savedPlacement);
    if(upgradedPlacement){cropRect=null;$('ratio').value='source';}
    else if(desiredRatio!=='crop'||cropRect)$('ratio').value=desiredRatio;
    $('edit-crop').hidden=$('ratio').value!=='crop';
    playing=false;time=settings().duration;syncCameraFields();if(studio.hasModel())say(upgradedPlacement?'旧项目已应用新的模型大小和预设构图。':'已恢复模型与场景，并重新完成本机切片。');else if(!saved?.modelFiles?.length)say('导入 3MF 或 STL，自动调用本机切片器生成生长路径。');
  }catch(error){say('本地项目恢复未完成：'+error.message,true);}
  finally{restoringProject=false;soundRestoreComplete=true;updateSoundSourceUI();}
  for(const el of document.querySelectorAll('[data-scene]')) {const active=el.dataset.scene===scene;el.classList.toggle('active',active);el.setAttribute('aria-pressed',active);}
  updateSettings();studio.endSceneUpdate?.();lockWorkspace(false);requestAnimationFrame(tick);
  try {const health=await api('/api/health');ffmpegAvailable=health.ffmpeg.available;alphaVideoAvailable=health.ffmpeg.alphaAvailable===true;$('alpha-video-option').disabled=!alphaVideoAvailable;realisticRuntime=health.realisticRender||{available:false};slicingRuntime=health.slicing||null;syncDetectedSlicer();updateSupportUI();updateExportQualityUI();updateSettings();persistSettings();if(!ffmpegAvailable)say('缺少 FFmpeg，可导出 PNG 序列');}
  catch {realisticRuntime={available:false};updateExportQualityUI();say('模型预览已就绪。导出服务连接失败，请重新打开启动工具。',true);}
}

init().catch(error => say(error.message,true));
