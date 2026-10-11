import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {GrowthStudio} from '../src/studio.js';

// Use actual update/draw entry points. Renderer calls stand in for presenting
// pixels so a test can inspect the preceding frame without creating a WebGL UI.
function fixture() {
  const studio=Object.create(GrowthStudio.prototype),calls=[],frames=[],samples=[];
  let width=800,height=600,invalidations=0,requests=0;
  studio.host={clientWidth:800,clientHeight:600};
  studio.options={progress:1,modelScale:1,modelOffsetX:0,modelOffsetY:0,modelOffsetZ:0,modelRotationX:0,modelRotationY:0,modelRotationZ:0,crop:null};
  studio.scene=new THREE.Scene();studio.modelGroup=new THREE.Group();studio.scene.add(studio.modelGroup);
  studio.camera=new THREE.PerspectiveCamera(36,4/3,.1,100);studio._metadata=null;studio._meshes=[];
  studio.controls={update(){calls.push('controls');return false;}};
  studio._updatePrintMatrix=()=>{calls.push('model-matrices');};
  studio._updateBackground=()=>{calls.push('background');};
  studio.renderer={getSize:target=>target.set(width,height),getPixelRatio:()=>1,
    setSize(w,h,style){width=w;height=h;calls.push(['resize',w,h,style]);},
    render(scene,camera){assert.equal(scene,studio.scene);assert.equal(camera,studio.camera);
      const frame={position:studio.modelGroup.position.toArray(),scale:studio.modelGroup.scale.x,progress:studio.options.progress,width,height};
      frames.push(frame);calls.push('present');}};
  studio._spatialPreview={invalidate(){invalidations++;samples.length=0;calls.push('invalidate');},schedule(){samples.push(frames.at(-1));calls.push('accumulate');}};
  studio._displaySurfaceController={begin(){calls.push('surface-begin');return()=>calls.push('surface-end');}};
  const request=studio._requestRender;
  studio._requestRender=function(){requests++;return request.call(this);};
  return{studio,calls,frames,samples,get invalidations(){return invalidations;},get requests(){return requests;},get size(){return[width,height];}};
}

test('nested scene updates compute final model matrices while all draw paths retain the preceding canvas frame',()=>{
  const f=fixture(),s=f.studio;s.render(1);const old=structuredClone(f.frames.at(-1));
  f.calls.length=0;const initialFrames=f.frames.length,initialInvalidations=f.invalidations,initialRequests=f.requests;
  assert.equal(s.beginSceneUpdate(),1);assert.equal(s.beginSceneUpdate(),2);
  assert.equal(f.invalidations,initialInvalidations+1,'only the outer begin cancels prior refinement');
  s.options.modelScale=1.8;s.options.modelOffsetX=.5;s.options.modelOffsetZ=-.25;
  s.render(.4);s._drawScene();s._renderPreview();s._requestRender();
  assert.deepEqual(s.modelGroup.position.toArray(),[2,0,-1]);assert.equal(s.modelGroup.scale.x,1.8);assert.equal(s.options.progress,.4);
  assert.deepEqual(f.frames.at(-1),old);assert.equal(f.frames.length,initialFrames);
  assert.equal(f.invalidations,initialInvalidations+1,'intermediate mutations do not restart refinement');
  assert.equal(f.samples.length,0,'the accumulator cannot collect intermediate scene frames');
  assert.ok(!f.calls.includes('surface-begin')&&!f.calls.includes('present')&&!f.calls.includes('controls'));
  assert.equal(s.endSceneUpdate(),1);assert.equal(f.requests,initialRequests+1,'nested release does not queue a frame');
  assert.equal(s.endSceneUpdate(),0);assert.equal(f.requests,initialRequests+2,'outer release queues exactly once');
  assert.equal(f.invalidations,initialInvalidations+2);assert.equal(s._renderPending,true);
  assert.equal(s.endSceneUpdate(),0);assert.equal(f.requests,initialRequests+2,'extra release is harmless');
  assert.equal(f.frames.length,initialFrames,'release itself does not draw');
  s._renderPreview();
  assert.equal(f.frames.length,initialFrames+1);assert.deepEqual(f.frames.at(-1),{position:[2,0,-1],scale:1.8,progress:.4,width:800,height:600});
  assert.deepEqual(f.samples,[f.frames.at(-1)]);assert.equal(s._renderPending,false);
});

test('a failed update released through finally queues a usable final preview and can start another batch',()=>{
  const f=fixture(),s=f.studio;s.render(1);const before=f.frames.length;
  assert.throws(()=>{s.beginSceneUpdate();try{s.options.modelScale=.42;s.render(.7);throw new Error('staged background rejected');}finally{s.endSceneUpdate();}},/staged background rejected/);
  assert.equal(s._sceneUpdateDepth,0);assert.equal(f.frames.length,before);assert.equal(f.requests,1);
  s._renderPreview();assert.equal(f.frames.length,before+1);assert.equal(f.frames.at(-1).scale,.42);
  s.beginSceneUpdate();s.options.modelScale=.9;s.render(1);s.endSceneUpdate();s._renderPreview();
  assert.equal(f.frames.at(-1).scale,.9);assert.equal(f.frames.at(-1).progress,1);
});

test('deferred viewport resizes update the camera internally but leave canvas pixels intact until one final frame',()=>{
  const f=fixture(),s=f.studio;s.render(1);const before=f.frames.length;
  s.beginSceneUpdate();s._resize(1080,1440);s._resize(1440,1080);
  assert.deepEqual(f.size,[800,600]);assert.equal(s.camera.aspect,4/3);assert.equal(s._viewportAspect,4/3);
  assert.deepEqual(s._pendingSceneResize,{width:1440,height:1080,adjustCamera:true});
  assert.ok(!f.calls.some(call=>Array.isArray(call)&&call[0]==='resize'));
  s.endSceneUpdate();assert.deepEqual(f.size,[800,600]);assert.equal(f.requests,1);
  s._renderPreview();assert.deepEqual(f.size,[1440,1080]);assert.equal(f.frames.length,before+1);assert.equal(s._pendingSceneResize,null);
  assert.equal(f.calls.filter(call=>Array.isArray(call)&&call[0]==='resize').length,1,'only the final dimensions allocate a draw buffer');
  const resize=f.calls.findIndex(call=>Array.isArray(call)&&call[0]==='resize'),present=f.calls.lastIndexOf('present');
  assert.ok(resize<present,'the new buffer and its final scene are presented together');
  assert.equal(f.requests,1,'applying the deferred size does not queue a second update');
});

test('a synchronous final render also consumes deferred dimensions before drawing the finished composition',()=>{
  const f=fixture(),s=f.studio;s.render(1);s.beginSceneUpdate();s.host.clientWidth=360;s.host.clientHeight=480;s._resize();
  assert.equal(s.camera.aspect,.75);assert.deepEqual(f.size,[800,600]);
  s.endSceneUpdate();s.render(.3);assert.deepEqual(f.size,[360,480]);assert.equal(f.frames.at(-1).progress,.3);
  assert.equal(s._pendingSceneResize,null);
});

test('the model import transaction may update pose and camera while presentation is held',()=>{
  const f=fixture(),s=f.studio;s.render(1);const before=f.frames.length;
  s.beginSceneUpdate();s.options.modelScale=.4;
  // Camera commits use the real renderer path. They must remain computational
  // while the containing import will still fit the completed model afterwards.
  s.controls.target=new THREE.Vector3();s.controls.enableDamping=true;
  s.applyCalibration({position:[6,8,10],target:[0,0,0],up:[0,1,0],fov:44});
  assert.deepEqual(s.camera.position.toArray(),[6,8,10]);assert.equal(s.camera.fov,44);assert.equal(s.modelGroup.scale.x,.4);
  assert.equal(f.frames.length,before);assert.equal(f.samples.length,0);
  s.endSceneUpdate();s._renderPreview();assert.equal(f.frames.length,before+1);
});

test('export rendering and explicit output dimensions bypass a held preview and retain pending preview dimensions',()=>{
  const f=fixture(),s=f.studio;s.render(1);s.beginSceneUpdate();s._resize(360,480);
  const pending=structuredClone(s._pendingSceneResize);s._exportState={};
  s._resize(1920,1080);s.render(.65);assert.deepEqual(f.size,[1920,1080]);assert.equal(f.frames.at(-1).progress,.65);
  assert.deepEqual(s._pendingSceneResize,pending,'an export draw cannot consume the deferred preview size');
  const before=f.frames.length;s._renderPreview();assert.equal(f.frames.length,before,'the independent preview never competes with export');
  s._exportState=null;s.endSceneUpdate();s._renderPreview();assert.deepEqual(f.size,[360,480]);
});
