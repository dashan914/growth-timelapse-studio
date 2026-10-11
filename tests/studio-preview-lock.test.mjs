import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { GrowthStudio } from '../src/studio.js';

class Canvas extends EventTarget {
  constructor(){super();this.style={};this.ownerDocument=new EventTarget();this.clientWidth=640;this.clientHeight=480;}
  getRootNode(){return this.ownerDocument;}
  getBoundingClientRect(){return {left:0,top:0,width:640,height:480};}
  setPointerCapture(){}releasePointerCapture(){}
}
function fixture(){
  const studio=Object.create(GrowthStudio.prototype),canvas=new Canvas();
  studio.camera=new THREE.PerspectiveCamera(48,4/3,.07,320);studio.camera.position.set(6,8,12);
  studio.renderer={domElement:canvas};studio.controls=studio._createPreviewControls();
  studio.options={modelScale:1.4,progress:1};studio._metadata={name:'model'};studio.modelGroup=new THREE.Group();
  studio.transform=new TransformControls(studio.camera,canvas);studio.transformHelper=studio.transform.getHelper();
  studio.transform.enabled=false;studio.transformHelper.visible=false;studio._transformMode=null;studio.render=()=>{};
  studio.transform.addEventListener('dragging-changed',event=>studio._handleGizmoDraggingChange(event));
  return {studio,dispose(){studio.controls.dispose();studio.transform.dispose();}};
}
function cameraState(studio){
  return {position:studio.camera.position.toArray(),quaternion:studio.camera.quaternion.toArray(),up:studio.camera.up.toArray(),target:studio.controls.target.toArray(),
    zoom:studio.camera.zoom,fov:studio.camera.fov,view:studio.camera.view&&{...studio.camera.view},projection:studio.camera.projectionMatrix.toArray(),inverse:studio.camera.projectionMatrixInverse.toArray()};
}

test('actual OrbitControls residual rotation/pan/zoom cannot drift after preview lock; crop, roll, zoom and target are preserved',()=>{
  const f=fixture();try{
    const {studio}=f;assert.equal(studio.controls.enabled,false,'constructor control factory starts locked');
    studio.controls.target.set(2,3,-1);studio.camera.up.set(.1,.97,-.2).normalize();studio.camera.lookAt(studio.controls.target);
    studio.camera.zoom=1.7;studio.camera.setViewOffset(1440,1080,80,40,1100,900);studio.controls.update();
    const before=cameraState(studio);
    studio.controls.enabled=true;studio.controls._sphericalDelta.theta=.45;studio.controls._sphericalDelta.phi=-.12;studio.controls._panOffset.set(.2,-.3,.1);studio.controls._scale=.85;
    studio.lockPreviewCamera();assert.deepEqual(cameraState(studio),before);assert.equal(studio.controls.enabled,false);assert.equal(studio.controls.enableDamping,true);
    // Real updates continue during idle preview even when controls are disabled.
    for(let i=0;i<6;i++)studio.controls.update();
    const after=cameraState(studio);
    for(const key of ['position','quaternion','target'])for(let i=0;i<before[key].length;i++)assert.ok(Math.abs(after[key][i]-before[key][i])<1e-12,`${key} drifted on idle tick`);
    for(const key of ['up','zoom','fov','view','projection','inverse'])assert.deepEqual(after[key],before[key]);
  }finally{f.dispose();}
});

test('model gizmos leave orbit disabled, release remains locked, and deselection ends real dragging without undoing the edited model',()=>{
  const f=fixture();try{
    const {studio}=f;
    for(const mode of ['translate','rotate','scale']){
      studio.setTransformMode(mode);assert.equal(studio.controls.enabled,false);assert.equal(studio.transform.enabled,true);assert.equal(studio.transformHelper.visible,true);
      assert.equal(studio.transform.object,studio.modelGroup);assert.equal(studio.transform.mode,mode);
      studio.transform.axis='X';studio.transform.dragging=true;assert.equal(studio.controls.enabled,false);
      studio.transform.pointerUp(null);assert.equal(studio.controls.enabled,false);
    }
    studio.modelGroup.position.set(3,4,5);studio.modelGroup.scale.setScalar(1.8);const edited=studio.modelGroup.position.toArray();
    studio.transform.axis='X';studio.transform.dragging=true;studio.setTransformMode(null);
    assert.equal(studio.transform.dragging,false);assert.equal(studio.transform.axis,null);assert.equal(studio.transform.object,undefined);
    assert.equal(studio.transform.enabled,false);assert.equal(studio.transformHelper.visible,false);assert.equal(studio.controls.enabled,false);
    assert.deepEqual(studio.modelGroup.position.toArray(),edited);assert.equal(studio.modelGroup.scale.x,1.8);
    studio.setTransformMode('translate');assert.equal(studio.transform.dragging,false);assert.equal(studio.controls.enabled,false);
  }finally{f.dispose();}
});
