import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {GrowthStudio} from '../src/studio.js';
import {IndexedSupportRenderer} from '../src/print-layer-renderer.js';
import {parsePrintLayerGCode,PRINTER_MM_TO_THREE_MM} from '../src/print-layer.js';
const hash=a=>createHash('sha256').update(Buffer.from(a.buffer,a.byteOffset,a.byteLength)).digest('hex');

class FakeCanvas extends EventTarget {
  constructor(document){super();this.ownerDocument=document;this.style={};this.width=1;this.height=1;this.clientWidth=320;this.clientHeight=180;}
  getRootNode(){return this.ownerDocument;}
  setPointerCapture(){}releasePointerCapture(){}
  getBoundingClientRect(){return {left:0,top:0,width:this.clientWidth,height:this.clientHeight};}
  getContext(){return {clearRect(){},drawImage(){},getImageData:(x,y,w,h)=>({data:new Uint8ClampedArray(w*h*4).fill(255)}),createImageData:(w,h)=>({data:new Uint8ClampedArray(w*h*4)}),putImageData:image=>{this.image=image;}};}
  toBlob(callback){queueMicrotask(()=>callback(new Blob([this.image?.data||new Uint8Array([1])])));}
}
function fixture(yaw=.5,{crop=false}={}) {
  const document=new EventTarget();document.createElement=name=>{assert.equal(name,'canvas');return new FakeCanvas(document);};
  const canvas=new FakeCanvas(document),studio=Object.create(GrowthStudio.prototype),controller=new AbortController();
  const camera=new THREE.PerspectiveCamera(44,16/9,.05,200),target=new THREE.Vector3(2,3,-1);
  camera.position.copy(target).add(new THREE.Vector3(Math.sin(yaw)*16,8,Math.cos(yaw)*16));camera.lookAt(target);
  const controls=new OrbitControls(camera,canvas);controls.target.copy(target);controls.enableDamping=true;controls.dampingFactor=.1;controls.update();
  // Real pending rotation and pan, as left by a just-finished pointer drag.
  controls._sphericalDelta.theta=.5;controls._sphericalDelta.phi=-.1;controls._panOffset.set(.2,-.1,.15);
  const geometry=new THREE.BoxGeometry(4,4,4);geometry.translate(0,2,0);
  const material=new THREE.MeshStandardMaterial({color:'#23599c'}),mesh=new THREE.Mesh(geometry,material);
  const scene=new THREE.Scene(),modelGroup=new THREE.Group(),normalized=new THREE.Group(),orientation=new THREE.Group();orientation.add(mesh);normalized.add(orientation);modelGroup.add(normalized);scene.add(modelGroup);
  const parsed=parsePrintLayerGCode(`; filament_colour = #f0e8d6
G21
G90
M82
G0 X0 Y0 Z0.25
;TYPE:Support
;WIDTH:0.42
;HEIGHT:0.25
G1 X20 Y0 E1
G0 X0 Y0 Z0.37
;HEIGHT:0.12
G1 X20 Y0 E2
G0 X0 Y0 Z0.49
G1 X20 Y0 E3`,{includeSupport:true});
  const supports=new IndexedSupportRenderer(parsed,{printerToSource:new THREE.Matrix4().fromArray(PRINTER_MM_TO_THREE_MM)});orientation.add(supports.root);
  let ratio=2,size=new THREE.Vector2(320,180),draws=0,abortAfter=0;
  const renderer={domElement:canvas,shadowMap:{autoUpdate:true,enabled:true},getSize:out=>out.copy(size),getPixelRatio:()=>ratio,setPixelRatio:v=>{ratio=v;},setSize(w,h){size.set(w,h);canvas.width=Math.round(w*ratio);canvas.height=Math.round(h*ratio);}};
  Object.assign(studio,{host:{clientWidth:320,clientHeight:180},renderer,scene,camera,controls,modelGroup,normalized,orientation,_indexedSupports:supports,
    _metadata:{sourceUnitsToMm:1,mode:'mesh',materialProfiles:[]},_meshes:[mesh],_baseBounds:new THREE.Box3(new THREE.Vector3(-2,0,-2),new THREE.Vector3(2,4,2)),_bounds:new THREE.Box3(),
    options:{progress:.2,turntable:20,modelScale:1.3,modelOffsetX:.15,modelOffsetY:0,modelOffsetZ:-.07,modelRotationX:.1,modelRotationY:.3,modelRotationZ:.2,direction:'up',layerCount:240,supportDisplay:'solid',showSupports:true,
      crop:crop?{sourceAspect:4/3,x:.1,y:.08,width:.75,height:.5625}:null},
    floor:new THREE.Mesh(new THREE.PlaneGeometry(20,20)),cap:new THREE.Mesh(new THREE.PlaneGeometry(20,20)),clipPlane:new THREE.Plane(),layerUniforms:{min:{value:0},max:{value:4}},
    _partCaps:[],_stencils:[],keyLight:{shadow:{}},transform:{enabled:true},transformHelper:{visible:true},shadowHelper:{visible:true},_shadowEditMode:true,
    _flushEnvironment(){},_endShadowDrag(){},_updateBackground(){},_updatePrintMatrix(){},_updateLightPosition(){},_updateShadowHelper(){},_scheduleEnvironment(){},
    _seekBackground:async()=>{},_drawScene(){draws++;if(abortAfter&&draws===abortAfter)controller.abort();}});
  if(crop){studio._fullSourceFov=44;studio._applyCameraFraming();}
  renderer.setSize(320,180);studio.render(.2,20*Math.PI/180);
  return {studio,controls,controller,geometry,material,parsed,resetDraws(value=0){draws=0;abortAfter=value;},dispose(){controls.dispose();supports.dispose();geometry.dispose();material.dispose();studio.floor.geometry.dispose();studio.cap.geometry.dispose();}};
}
function snapshot(studio){return {position:studio.camera.position.clone(),quaternion:studio.camera.quaternion.clone(),target:studio.controls.target.clone(),projection:studio.camera.projectionMatrix.toArray(),inverse:studio.camera.projectionMatrixInverse.toArray(),up:studio.camera.up.toArray(),matrix:studio.modelGroup.matrix.clone(),progress:studio.options.progress,turnRadians:studio._turnRadians};}
function restored(studio,before){assert.ok(studio.camera.position.distanceTo(before.position)<1e-10,'camera position moved after exact export-state restore');assert.ok(studio.camera.quaternion.angleTo(before.quaternion)<1e-7,'camera yaw/roll moved after restore');assert.ok(studio.controls.target.distanceTo(before.target)<1e-10,'orbit target moved after restore');assert.deepEqual(studio.camera.projectionMatrix.toArray(),before.projection);assert.deepEqual(studio.camera.projectionMatrixInverse.toArray(),before.inverse);assert.deepEqual(studio.camera.up.toArray(),before.up);assert.equal(studio.options.progress,before.progress);assert.equal(studio._turnRadians,before.turnRadians);assert.deepEqual(studio.modelGroup.matrix.toArray(),before.matrix.toArray());assert.equal(studio.controls.enableDamping,true);assert.equal(studio.controls.enabled,true);assert.equal(studio.transform.enabled,true);assert.equal(studio.transformHelper.visible,true);assert.equal(studio.shadowHelper.visible,true);assert.equal(studio._shadowEditMode,true);}

for(const yaw of [-1.2,.3,1.6])test(`real OrbitControls pending damping cannot nudge restored export/cancel camera at yaw ${yaw}`,()=>{
 const f=fixture(yaw);try {
  f.studio.startExport(640,360);const expected=snapshot(f.studio);
  f.studio.render(.75,.7);f.studio.endExport();restored(f.studio,expected);
  const still=snapshot(f.studio);f.controls.update();restored(f.studio,still);
 }finally{f.dispose();}
});

test('actual aborted spatial capture restores crop optics, model pose, support/CAD bytes and settled controls after endExport',async()=>{
 const f=fixture(-.8,{crop:true});try {
  const bytes={positions:hash(f.geometry.attributes.position.array),indices:hash(f.geometry.index.array),paths:hash(f.parsed.positions),widths:hash(f.parsed.widths),heights:hash(f.parsed.heights),tools:hash(f.parsed.tools),color:f.material.color.getHexString()};
  f.studio.startExport(640,360);const expected=snapshot(f.studio),view={...f.studio.camera.view};f.resetDraws(3);
  await assert.rejects(f.studio.captureFrame(.8,.4,2,{samples:4,signal:f.controller.signal,outputPlan:{width:320,height:180,renderWidth:640,renderHeight:360,scale:2}}),{name:'AbortError'});
  assert.deepEqual(f.studio.camera.projectionMatrix.toArray(),expected.projection);assert.deepEqual(f.studio.camera.projectionMatrixInverse.toArray(),expected.inverse);assert.equal(f.studio.renderer.shadowMap.autoUpdate,true);
  f.studio.endExport();restored(f.studio,expected);assert.deepEqual(f.studio.camera.view,view);
  assert.deepEqual({positions:hash(f.geometry.attributes.position.array),indices:hash(f.geometry.index.array),paths:hash(f.parsed.positions),widths:hash(f.parsed.widths),heights:hash(f.parsed.heights),tools:hash(f.parsed.tools),color:f.material.color.getHexString()},bytes);
  const still=snapshot(f.studio);f.controls.update();restored(f.studio,still);
 }finally{f.dispose();}
});
