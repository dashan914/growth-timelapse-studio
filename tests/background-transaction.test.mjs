import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as THREE from 'three';
import { GrowthStudio } from '../src/studio.js';
import { BACKGROUND_PRESETS } from '../src/background-presets.js';

function replaceGlobal(t,key,value) {
  const previous=Object.getOwnPropertyDescriptor(globalThis,key);
  Object.defineProperty(globalThis,key,{value,writable:true,configurable:true});
  t.after(()=>previous?Object.defineProperty(globalThis,key,previous):delete globalThis[key]);
}
function bitmap(width=400,height=300) {return {width,height,closed:0,close(){this.closed++;}};}
function fixture(maxTextureSize=16384) {
  const studio=Object.create(GrowthStudio.prototype),trace=[];
  const oldBitmap=bitmap(),old=new THREE.Texture(oldBitmap);let oldDisposed=0;
  old.addEventListener('dispose',()=>{oldDisposed++;trace.push('release-old-texture');});
  const crop={x:.2,y:.1,width:.5,height:.5};
  Object.assign(studio,{_backgroundTexture:old,_backgroundMetadata:{name:'old.jpg',type:'image',width:400,height:300},
    _backgroundSize:{width:400,height:300},_photoIdentity:'preset:h2c',_photoBedSize:{width:12,depth:12},
    _backgroundVideo:null,_backgroundURL:null,options:{crop,progress:1},scene:{background:old},
    camera:new THREE.PerspectiveCamera(60,4/3,.1,200),renderer:{capabilities:{maxTextureSize}},
    _updateFloorFootprint(){},_requestRender(){},_applyCameraFraming(){trace.push('frame-new');},
    _updateBackground(){this.scene.background=this._backgroundTexture;},render(){trace.push('render-new');}});
  return {studio,old,oldBitmap,crop,trace,oldDisposed:()=>oldDisposed};
}
function oldIntact(f) {
  assert.equal(f.studio._backgroundTexture,f.old);assert.equal(f.studio.scene.background,f.old);
  assert.equal(f.oldBitmap.closed,0);assert.equal(f.oldDisposed(),0);
  assert.equal(f.studio.options.crop,f.crop);assert.equal(f.studio.photoIdentity,'preset:h2c');
  assert.deepEqual(f.studio._photoBedSize,{width:12,depth:12});assert.equal(f.studio.backgroundMetadata.name,'old.jpg');
}
const file={name:'new.jpg',type:'image/jpeg'};

test('actual loader keeps old photo/crop/bed/identity when bitmap decode rejects and never invokes the commit hook',async t=>{
  const f=fixture();let hooks=0;
  replaceGlobal(t,'createImageBitmap',async()=>{throw new Error('decoder rejected bad JPEG');});
  await assert.rejects(f.studio.loadBackground(file,{beforeCommit(){hooks++;}}),/bad JPEG/);
  assert.equal(hooks,0);oldIntact(f);
});

test('actual loader rejects hardware and 64MP excess without resizing or disposing the old photo',async t=>{
  let next=bitmap(4097,4);replaceGlobal(t,'createImageBitmap',async()=>next);
  const hardware=fixture(4096);let hooks=0;
  await assert.rejects(hardware.studio.loadBackground(file,{beforeCommit(){hooks++;}}),/显卡 4096.*分辨率.*重试/);
  assert.equal(next.closed,1);oldIntact(hardware);
  next=bitmap(8000,8001);const pixels=fixture();
  await assert.rejects(pixels.studio.loadBackground(file,{beforeCommit(){hooks++;}}),/6400 万.*分辨率.*重试/);
  assert.equal(next.closed,1);assert.equal(hooks,0);oldIntact(pixels);
  next=bitmap(8000,8000);const boundary=fixture();
  await boundary.studio.loadBackground(file);
  assert.equal(boundary.studio._backgroundTexture.image,next,'full decoded bitmap must be retained, not a resized replacement');
  assert.deepEqual(boundary.studio._backgroundSize,{width:8000,height:8000});assert.equal(next.closed,0);
  boundary.studio._releaseBackground();assert.equal(next.closed,1);
});

test('invalid decoder metadata is rejected and staged image memory closes before hook or commit',async t=>{
  let next;replaceGlobal(t,'createImageBitmap',async()=>next);
  for(const [width,height] of [[0,400],[400,0],[NaN,400],[400.5,300],[-1,300]]) {
    next=bitmap(width,height);const f=fixture();let hooks=0;
    await assert.rejects(f.studio.loadBackground(file,{beforeCommit(){hooks++;}}),/有效的画面尺寸/);
    assert.equal(next.closed,1);assert.equal(hooks,0);oldIntact(f);
  }
});

test('a throwing synchronous hook disposes its staged texture/bitmap but old resources and framing remain untouched',async t=>{
  const f=fixture(),next=bitmap();let stagedDisposals=0;
  replaceGlobal(t,'createImageBitmap',async()=>next);
  const original=THREE.Texture.prototype.dispose;
  t.mock.method(THREE.Texture.prototype,'dispose',function(){if(this!==f.old)stagedDisposals++;return original.call(this);});
  await assert.rejects(f.studio.loadBackground(file,{beforeCommit(){oldIntact(f);throw new Error('editor cleanup failed');}}),/editor cleanup failed/);
  assert.equal(stagedDisposals,1);assert.equal(next.closed,1);assert.equal(f.trace.length,0);oldIntact(f);
});

test('async callbacks are rejected before decode and returned promises cannot postpone the old-source release',async t=>{
  const f=fixture(),next=bitmap();let decoded=0;
  replaceGlobal(t,'createImageBitmap',async()=>{decoded++;return next;});
  await assert.rejects(f.studio.loadBackground(file,{beforeCommit:async()=>{throw new Error('never called');}}),/同步函数/);
  assert.equal(decoded,0);oldIntact(f);
  await assert.rejects(f.studio.loadBackground(file,{beforeCommit:()=>Promise.reject(new Error('async rejection'))}),/同步完成/);
  assert.equal(next.closed,1);oldIntact(f);
});

class DecodedVideo extends EventTarget {
  constructor({width=640,height=480,duration=5,decodeError=false,frameCallbacks=false}={}) {
    super();Object.assign(this,{videoWidth:width,videoHeight:height,duration,decodeError,readyState:0,src:'',pauses:0,loads:0,cancelled:[],requested:0});
    if(frameCallbacks){this.requestVideoFrameCallback=()=>++this.requested;this.cancelVideoFrameCallback=id=>this.cancelled.push(id);}
  }
  pause(){this.pauses++;}
  removeAttribute(key){if(key==='src')this.src='';}
  load(){this.loads++;if(this.src)queueMicrotask(()=>{if(!this.decodeError)this.readyState=2;this.dispatchEvent(new Event(this.decodeError?'error':'loadeddata'));});}
}
function videoEnvironment(t,video) {
  replaceGlobal(t,'document',{createElement(name){assert.equal(name,'video');return video;}});
  let revoked=[];t.mock.method(URL,'createObjectURL',()=> 'blob:staged-video');t.mock.method(URL,'revokeObjectURL',url=>revoked.push(url));
  return revoked;
}

test('video decode/budget/hook rejection releases staged decoder, URL and scheduled texture callback only',async t=>{
  for(const variant of ['decode','hardware','pixels','duration','hook']) {
    const video=new DecodedVideo(variant==='decode'?{decodeError:true}:variant==='hardware'?{width:16385}:variant==='pixels'?{width:8000,height:8001}:variant==='duration'?{duration:0}:{frameCallbacks:true});
    const revoked=videoEnvironment(t,video),f=fixture();let hooks=0;
    await assert.rejects(f.studio.loadBackground({name:'new.mp4',type:'video/mp4'},{beforeCommit(){hooks++;throw new Error('video hook failure');}}));
    assert.deepEqual(revoked,['blob:staged-video']);assert.equal(video.src,'');assert.equal(video.loads,2);assert.ok(video.pauses>=1);
    assert.equal(hooks,variant==='hook'?1:0);assert.equal(video.requested,variant==='hook'?1:0);
    assert.deepEqual(video.cancelled,variant==='hook'?[1]:[]);oldIntact(f);
  }
});

test('successful commit keeps full source pixels and invokes hook before old editor camera/bed release',async t=>{
  const f=fixture(),next=bitmap();replaceGlobal(t,'createImageBitmap',async()=>{f.trace.push('decoded');return next;});
  const metadata=await f.studio.loadBackground(file,{beforeCommit(){f.trace.push('hook');oldIntact(f);f.studio.camera.fov=24;}});
  assert.deepEqual(metadata,{type:'image',name:'new.jpg',duration:null,width:400,height:300});
  assert.deepEqual(f.trace,['decoded','hook','release-old-texture','frame-new','render-new']);
  assert.equal(f.studio._fullSourceFov,24);assert.equal(f.studio._backgroundTexture.image,next);
  assert.equal(f.oldBitmap.closed,1);assert.equal(f.oldDisposed(),1);assert.equal(next.closed,0);
  assert.equal(f.studio.options.crop,null);assert.equal(f.studio.photoIdentity,null);assert.equal(f.studio._photoBedSize,null);
  f.studio._releaseBackground();
});

const appSource=await readFile(new URL('../src/app.js',import.meta.url),'utf8');
function actualFunction(name) {
  const start=appSource.indexOf(name==='setBackgroundFile'?"async function setBackgroundFile(":"function "+name+'(');
  assert.ok(start>=0);const end=appSource.indexOf('\n}',start)+2;assert.ok(end>start);
  return appSource.slice(start,end);
}
function appFixture(f,{hookFail=false}={}) {
  const nodes=new Map(),get=id=>{if(!nodes.has(id))nodes.set(id,{hidden:false,value:id==='output-appearance'?'photo':'',options:[{}, {disabled:false}],attrs:{},setAttribute(name,value){this.attrs[name]=value;}});return nodes.get(id);};
  const oldReference={name:'printed-B.jpg'},oldCalibration={points:[1,2,3,4],bedWidth:300},oldCrop={...f.crop};
  f.studio.setOptions=()=>{};
  f.studio.applyCalibration=previous=>{assert.equal(f.studio._backgroundTexture,f.old,'old editor restoration must precede replacement');f.trace.push('restore-old-camera');f.studio.camera.fov=previous.fov;};
  const context=vm.createContext({studio:f.studio,$:get,printerPresets:BACKGROUND_PRESETS,say(){},settings:()=>({duration:8}),
    updateSettings(){},markPreset(){},setPlacementMode(){},cachePatch(){},localStorage:{getItem:()=>null},backgroundLoadSequence:0,DOMException,rememberBackgroundAppearance(){},applyBackgroundAppearance(){},
    calibrationStorageKey:()=> 'key',calibrationMode:true,calibrationDetectionController:{abort(){if(hookFail)throw new Error('editor abort failed');}},calibrationSessionId:0,
    calibrationSnapshot:{pose:{},appearance:'photo',bedWidth:300,bedDepth:300,camera:{fov:24},bedSize:{width:12,depth:12},time:3,playing:true,transformMode:'translate',perspectiveMode:false},
    calibrationDragIndex:null,calibrationUprightDrag:null,gridDrag:null,calibrationPreviousTime:2,
    setModelMode(){},setPerspectiveMode(){},showTime(){},updateReferenceView(){},persistSettings(){},
    time:3,playing:true,alignCancelled:false,referenceFile:oldReference,referenceAnalysis:{usable:true},referencePixels:new Uint8Array([1,2,3]),
    activeCalibration:oldCalibration,cropRect:oldCrop,cropEditing:true,backgroundFile:{name:'old.jpg'},backgroundPreset:'h2c',posePlacement:null});
  vm.runInContext([actualFunction('clearReference'),actualFunction('stopCalibration'),actualFunction('setBackgroundFile')].join('\n'),context);
  return {context,get,oldReference,oldCalibration,oldCrop};
}

test('actual app functions plus actual loader preserve A/B, crop, calibration editor and old photo on decode/oversize/hook failure',async t=>{
  let next,decodeFail=false;replaceGlobal(t,'createImageBitmap',async()=>{if(decodeFail)throw new Error('bad JPEG');return next;});
  for(const variant of ['decode','oversize','hook']) {
    decodeFail=variant==='decode';next=bitmap(variant==='oversize'?16385:400,300);
    const f=fixture(),a=appFixture(f,{hookFail:variant==='hook'});
    await assert.rejects(a.context.setBackgroundFile(file));oldIntact(f);
    assert.equal(a.context.referenceFile,a.oldReference);assert.equal(a.context.activeCalibration,a.oldCalibration);assert.equal(a.context.cropRect,a.oldCrop);
    assert.equal(a.context.calibrationMode,true);assert.equal(a.context.cropEditing,true);assert.equal(a.get('output-appearance').value,'photo');
    assert.equal(a.context.backgroundFile.name,'old.jpg');assert.equal(a.context.backgroundPreset,'h2c');
    assert.equal(next.closed,variant==='decode'?0:1);
  }
});

test('actual successful app replacement restores the old editor before new camera commit and clears only committed paired state',async t=>{
  const f=fixture(),a=appFixture(f),next=bitmap();replaceGlobal(t,'createImageBitmap',async()=>next);
  await a.context.setBackgroundFile(file);
  assert.ok(f.trace.indexOf('restore-old-camera')<f.trace.indexOf('release-old-texture'));
  assert.equal(f.studio._fullSourceFov,24);assert.equal(a.context.referenceFile,null);assert.equal(a.context.activeCalibration,null);assert.equal(a.context.cropRect,null);
  assert.equal(a.context.calibrationMode,false);assert.equal(a.context.backgroundFile,file);assert.equal(a.context.backgroundPreset,'');
  assert.equal(f.studio._backgroundTexture.image,next);assert.equal(a.get('output-appearance').value,'model');assert.equal(f.oldBitmap.closed,1);
  f.studio._releaseBackground();
});
