import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import * as THREE from 'three';
import {LineSegmentsGeometry} from 'three/addons/lines/LineSegmentsGeometry.js';
import {GrowthStudio} from '../src/studio.js';
import {createPrintPathGeometry,createPrintPathMaterial,createPrintPathDepthMaterial,createPrintPathPreviewGeometries} from '../src/print-path-material.js';

const digest=array=>createHash('sha256').update(Buffer.from(array.buffer,array.byteOffset,array.byteLength)).digest('hex');
const uniform=material=>material.userData.printPathImpostor.uniforms.pathInteraction.value;

function clock(t){
  const timers=new Map();let now=0,id=0;
  t.mock.method(globalThis,'setTimeout',(callback,delay)=>{timers.set(++id,{callback,due:now+delay,delay});return id;});
  t.mock.method(globalThis,'clearTimeout',key=>timers.delete(key));
  return{timers,advance(ms){now+=ms;for(const [key,timer]of [...timers])if(timer.due<=now){timers.delete(key);timer.callback();}}};
}

function fixture(t,{pixelRatio=2}={}){
  const timer=clock(t),studio=Object.create(GrowthStudio.prototype),calls=[];
  const line=new LineSegmentsGeometry().setPositions(new Float32Array([0,0,.08,0,10,.08,0,0,.16,10,0,.16,2,1,.12,8,1,.12]));
  line.setColors(new Float32Array([1,0,0,1,0,0,0,0,1,0,0,1,0,1,0,0,1,0]));
  line.setAttribute('instancePrintWidth',new THREE.InstancedBufferAttribute(new Float32Array([.42,.5,.3]),1));
  const sourceHeights=new Float32Array([.16,.2,.25]),features=new Uint8Array([1,2,7]);
  const geometry=createPrintPathGeometry(line,{heights:sourceHeights,features});
  const material=createPrintPathMaterial(),depth=createPrintPathDepthMaterial();
  const path=new THREE.Mesh(geometry,material);path.userData.printPathImpostor=true;path.customDepthMaterial=depth;
  const ordinary=new THREE.Mesh(new THREE.BoxGeometry(1,1,1),new THREE.MeshStandardMaterial({color:'#eddaaf'}));
  studio._meshes=[path,ordinary];studio._metadata={name:'sliced.3mf',historicalPathSurface:'analytic-pbr-extrusion'};
  studio.options={progress:.6,turntable:0,dofEnabled:true,dofStrength:30,dofFocus:50,surfacePreset:'matte',surfaceDetail:.7,shadowRadius:6,shadowOpacity:.2};
  studio.scene=new THREE.Scene();studio.scene.background=new THREE.Color('#30333a');studio.scene.add(path,ordinary);
  studio.camera=new THREE.PerspectiveCamera(37,4/3,.1,100);studio.camera.position.set(3,4,5);
  studio.controls={target:new THREE.Vector3(1,2,1),enabled:false,update(){calls.push('controls-update');}};
  studio.transform={enabled:false};studio.transformHelper=new THREE.Group();studio.transformHelper.visible=false;
  studio.shadowHelper=new THREE.Group();studio.shadowHelper.visible=false;
  studio._spatialPreview={invalidate(){calls.push('invalidate');}};
  let currentPixelRatio=pixelRatio,throwRender=null;
  studio.renderer={shadowMap:{enabled:true},getPixelRatio:()=>currentPixelRatio,
    setPixelRatio(value){calls.push(['pixelRatio',value]);currentPixelRatio=value;},
    getSize:target=>target.set(800,600),getClearAlpha:()=>1,getClearColor:target=>target.set('#30333a'),
    render(scene,camera){assert.equal(scene,studio.scene);assert.equal(camera,studio.camera);
      calls.push(['raw-render',this.shadowMap.enabled,uniform(material),uniform(depth)]);if(throwRender)throw throwRender;}};
  studio._dofComposer={setPixelRatio(value){calls.push(['dofPixelRatio',value]);},render(){
    calls.push(['dof-render',studio.renderer.shadowMap.enabled,uniform(material),uniform(depth)]);
    if(throwRender)throw throwRender;
  }};
  studio._dofRenderPass={};
  studio._dofBokehPass={enabled:true,uniforms:{preservePhoto:{value:0},tPhoto:{value:null},photoUvTransform:{value:new THREE.Matrix3()},
    photoVideo:{value:0},photoIntensity:{value:1},backgroundLinearRGBA:{value:new THREE.Vector4()},focus:{value:0},cocRadiusUvCoefficient:{value:0},maxblur:{value:0},aspect:{value:0}}};
  studio.getPhotoLensDof=()=>{calls.push('lens-dof');return{enabled:true,fNumber:6,focusDistanceWorld:10,cocRadiusUvCoefficient:.01,preview:{maxRadiusUv:.02}};};
  const sources=[line.attributes.instanceStart.data.array,line.attributes.instanceColorStart.data.array,line.attributes.instancePrintWidth.array,sourceHeights,features];
  const hashes=sources.map(digest),options=structuredClone(studio.options),camera=studio.camera.projectionMatrix.toArray();
  const dispose=()=>{studio.endPreviewInteraction();geometry.dispose();line.dispose();material.dispose();depth.dispose();ordinary.geometry.dispose();ordinary.material.dispose();};
  t.after(dispose);
  return{studio,path,ordinary,material,depth,calls,timer,options,
    failRender(error){throwRender=error;},get pixelRatio(){return currentPixelRatio;},
    assertSourceIntact(){assert.deepEqual(sources.map(digest),hashes);assert.equal(geometry.instanceCount,3);
      assert.equal(geometry.attributes.instanceStart,line.attributes.instanceStart);assert.equal(geometry.attributes.instancePrintHeight.array,sourceHeights);
      assert.deepEqual(studio.options,options);assert.deepEqual(studio.camera.projectionMatrix.toArray(),camera);}};
}

function compactFixture(t){
  const f=fixture(t),features=new Uint8Array([1,2,3,4,5,10,11,6,16,9]),count=features.length;
  const positions=new Float32Array(count*6),colors=new Float32Array(count*6),widths=new Float32Array(count),heights=new Float32Array(count);
  for(let i=0;i<count;i++){
    positions.set([i,0,.08+i*.16,i,10,.08+i*.16],i*6);
    colors.set([.2+i*.03,.5,.1,.2+i*.03,.5,.1],i*6);widths[i]=.42;heights[i]=.16;
  }
  const line=new LineSegmentsGeometry().setPositions(positions).setColors(colors);
  line.setAttribute('instancePrintWidth',new THREE.InstancedBufferAttribute(widths,1));
  const full=createPrintPathGeometry(line,{features,heights}),preview=createPrintPathPreviewGeometries(full);
  preview.supportMesh=new THREE.Mesh(preview.support,f.material);
  preview.supportMesh.matrixAutoUpdate=false;preview.supportMesh.frustumCulled=false;
  f.path.geometry=full;f.path.userData.printPathPreview=preview;
  const parent=new THREE.Group();parent.position.set(-1,3,2);parent.rotation.set(.04,-.12,.02);parent.scale.setScalar(.85);
  f.studio.scene.add(parent);parent.add(f.path);
  f.path.position.set(1,2,3);f.path.rotation.set(.13,.4,-.1);f.path.scale.setScalar(1.3);f.path.updateMatrix();
  f.studio.options.showSupports=true;
  const arrays=[...new Set(Object.values(full.attributes).map(attribute=>attribute.data?.array||attribute.array))],hashes=arrays.map(digest);
  const pathIdentity=f.path,rootIdentity=f.studio.scene,materialIdentity=f.material;
  t.after(()=>{preview.exterior.dispose();preview.support.dispose();full.dispose();line.dispose();});
  return{...f,full,preview,parent,
    assertFullIntact(prefix){
      assert.equal(f.path.geometry,full);assert.equal(full.instanceCount,prefix);assert.deepEqual(arrays.map(digest),hashes);
      assert.equal(f.path,pathIdentity);assert.equal(f.studio._meshes[0],pathIdentity);assert.equal(f.studio.scene,rootIdentity);
      assert.equal(f.path.material,materialIdentity);assert.equal(preview.supportMesh.parent,null);
      assert.deepEqual(parent.children,[f.path]);
    }};
}

test('actual Studio begin/end preserves retina resolution and restores full path uniforms without resizing draw targets',t=>{
  const f=fixture(t);f.studio.beginPreviewInteraction({hold:true});
  assert.equal(f.pixelRatio,2);
  assert.equal(f.studio._renderPending,true);assert.equal(f.calls.filter(value=>value==='invalidate').length,1);
  f.studio._drawScene();assert.equal(uniform(f.material),1);assert.equal(uniform(f.depth),1);
  f.calls.length=0;f.studio._renderPending=false;f.studio.endPreviewInteraction();
  assert.equal(f.pixelRatio,2);assert.equal(f.studio._previewInteraction,null);
  assert.equal(uniform(f.material),0);assert.equal(uniform(f.depth),0);
  assert.equal(f.studio._renderPending,true);
  assert.deepEqual(f.calls,['invalidate']);
  f.assertSourceIntact();f.calls.length=0;f.studio.endPreviewInteraction();assert.deepEqual(f.calls,[],'release is idempotent');
});

test('ordinary interaction restores 320 ms after the latest input, with no stale timer restoring a newer frame',t=>{
  const f=fixture(t);f.studio.beginPreviewInteraction();
  assert.equal(f.timer.timers.size,1);assert.equal([...f.timer.timers.values()][0].delay,320);
  f.timer.advance(200);f.studio.beginPreviewInteraction();assert.equal(f.timer.timers.size,1);
  f.timer.advance(120);assert.ok(f.studio._previewInteraction,'the first input timer was cancelled');assert.equal(f.pixelRatio,2);
  f.timer.advance(199);assert.ok(f.studio._previewInteraction);assert.equal(f.pixelRatio,2);
  f.timer.advance(1);assert.equal(f.pixelRatio,2);assert.equal(f.studio._previewInteraction,null);assert.equal(f.timer.timers.size,0);
  assert.equal(f.calls.filter(value=>value==='invalidate').length,2,'only activation and final full-frame request invalidate');
  f.assertSourceIntact();
});

test('held drag cancels a pending timer and remains held through ordinary updates until explicit release',t=>{
  const f=fixture(t);f.studio.beginPreviewInteraction();f.timer.advance(100);
  f.studio.beginPreviewInteraction({hold:true});assert.equal(f.timer.timers.size,0);
  f.studio.beginPreviewInteraction();f.timer.advance(5000);
  assert.equal(f.pixelRatio,2);assert.equal(f.studio._previewInteraction.hold,true);assert.equal(f.timer.timers.size,0);
  assert.equal(f.calls.filter(value=>Array.isArray(value)&&['pixelRatio','dofPixelRatio'].includes(value[0])).length,0,'interaction never resizes renderer or linear draw targets');
  f.studio.endPreviewInteraction();assert.equal(f.pixelRatio,2);f.assertSourceIntact();
});

test('non-retina ratio is never increased during interaction',t=>{
  const f=fixture(t,{pixelRatio:.75});f.studio.beginPreviewInteraction({hold:true});assert.equal(f.pixelRatio,.75);
  f.studio.endPreviewInteraction();assert.equal(f.pixelRatio,.75);
});

test('large cached path populations and support switches preserve retina resolution during interaction',t=>{
  const f=fixture(t);
  // Only the scalar population metadata is large. The source fixture remains
  // three real roads, so this exercises budgeting without allocating millions.
  f.path.userData.printPathPreview={exteriorSegmentCount:1_364_595,supportSegmentCount:1_717_108};
  for(const showSupports of [false,true]){
    f.studio.options.showSupports=showSupports;const before=structuredClone(f.studio.options);
    f.studio.beginPreviewInteraction({hold:true});
    assert.equal(f.pixelRatio,2,'path population metadata cannot reduce display sampling resolution');
    f.studio.endPreviewInteraction();assert.equal(f.pixelRatio,2);assert.deepEqual(f.studio.options,before);
  }
  delete f.studio.options.showSupports;f.assertSourceIntact();
});

test('large-cache interaction preserves an already low pixel ratio and restores it exactly without changing user options',t=>{
  const f=fixture(t,{pixelRatio:.6});
  f.path.userData.printPathPreview={exteriorSegmentCount:1_000_000,supportSegmentCount:5_000_000};
  for(const showSupports of [true,false]){
    f.studio.options.showSupports=showSupports;const before=structuredClone(f.studio.options);
    f.studio.beginPreviewInteraction();assert.equal(f.pixelRatio,.6);
    f.timer.advance(320);assert.equal(f.pixelRatio,.6);assert.equal(f.studio._previewInteraction,null);
    assert.deepEqual(f.studio.options,before);
  }
  delete f.studio.options.showSupports;f.assertSourceIntact();
});

test('no model, ordinary CAD and ongoing export do not activate interactive preview or allocate timers',t=>{
  const f=fixture(t);
  for(const mode of ['no-model','ordinary-cad','export']){
    f.studio._metadata=mode==='no-model'?null:mode==='ordinary-cad'?{name:'cad.3mf'}:{name:'paths.3mf',historicalPathSurface:'analytic-pbr-extrusion'};
    f.studio._exportState=mode==='export'?{}:null;f.studio.beginPreviewInteraction({hold:true});
    assert.equal(f.studio._previewInteraction,undefined,mode);assert.equal(f.pixelRatio,2,mode);
    assert.equal(f.timer.timers.size,0,mode);assert.deepEqual(f.calls,[],mode);
  }
});

test('actual interactive draw uses the linear composer, bypasses blur temporarily and preserves lens status',t=>{
  const f=fixture(t),photoStatus={enabled:true,error:null},lens={enabled:true};
  f.studio._photoDofStatus=photoStatus;f.studio._lastPhotoLensDof=lens;
  const composerRender=f.studio._dofComposer.render;
  f.studio._dofComposer.render=function(...args){
    assert.equal(f.studio._dofBokehPass.enabled,false,'interactive frames retain linear sampling without the expensive blur pass');
    assert.equal(f.studio._dofRenderPass.preserveDepth,false,'unblurred interaction skips the unused central depth draw');
    assert.equal(f.studio._dofRenderPass.samples,4,'the optimization retains the four actual spatial color samples');
    return composerRender.apply(this,args);
  };
  f.studio.beginPreviewInteraction({hold:true});f.calls.length=0;f.studio._drawScene();
  assert.deepEqual(f.calls,[['dof-render',false,1,1]]);
  assert.equal(f.pixelRatio,2);assert.equal(f.studio._dofBokehPass.enabled,true);
  assert.equal(f.studio.renderer.shadowMap.enabled,true);assert.equal(f.studio._photoDofStatus,photoStatus);assert.equal(f.studio._lastPhotoLensDof,lens);
  f.studio._dofComposer.render=composerRender;
  f.studio.endPreviewInteraction();f.calls.length=0;f.studio._drawScene();
  assert.equal(f.calls[0],'lens-dof');assert.ok(f.calls.some(value=>Array.isArray(value)&&value[0]==='dof-render'&&value[1]===true&&value[2]===0&&value[3]===0));
  assert.equal(f.studio._dofRenderPass.preserveDepth,true,'actual depth of field restores its centered depth draw');
  assert.equal(f.studio._dofBokehPass.enabled,true);f.assertSourceIntact();
});

test('linear draw exception propagates while shadow and blur enablement are restored in every prior state',t=>{
  const f=fixture(t),failure=new Error('GPU draw failed');f.studio.beginPreviewInteraction({hold:true});f.failRender(failure);
  for(const shadowEnabled of [true,false])for(const blurEnabled of [true,false]){
    f.studio.renderer.shadowMap.enabled=shadowEnabled;
    f.studio._dofBokehPass.enabled=blurEnabled;
    assert.throws(()=>f.studio._drawScene(),error=>error===failure);
    assert.equal(f.studio.renderer.shadowMap.enabled,shadowEnabled);
    assert.equal(f.studio._dofBokehPass.enabled,blurEnabled);
    assert.equal(f.pixelRatio,2);
    assert.equal(f.studio.options.dofEnabled,true);assert.equal(f.studio.options.dofStrength,30);
  }
  f.studio.endPreviewInteraction();assert.equal(uniform(f.material),0);assert.equal(uniform(f.depth),0);f.assertSourceIntact();
});

test('export-state draw uses complete paths and normal DOF even if an interactive state is left present',t=>{
  const f=fixture(t);f.studio.beginPreviewInteraction({hold:true});f.studio._drawScene();
  f.studio._exportState={};f.calls.length=0;f.studio._drawScene();
  assert.equal(f.calls[0],'lens-dof');assert.ok(f.calls.some(value=>Array.isArray(value)&&value[0]==='dof-render'));
  assert.equal(uniform(f.material),0);assert.equal(uniform(f.depth),0);
  assert.equal(f.studio.renderer.shadowMap.enabled,true);f.assertSourceIntact();
});

test('actual startExport restores complete preview before recording original retina state and beginning export',t=>{
  const f=fixture(t);f.studio.beginPreviewInteraction({hold:true});f.studio._drawScene();f.calls.length=0;
  f.studio._flushEnvironment=()=>{assert.equal(f.pixelRatio,2);assert.equal(uniform(f.material),0);assert.equal(uniform(f.depth),0);f.calls.push('flush-environment');};
  f.studio._endShadowDrag=()=>{};
  f.studio._resize=(width,height)=>f.calls.push(['export-resize',width,height]);
  f.studio.render=()=>{assert.ok(f.studio._exportState);assert.equal(f.studio._previewInteraction,null);f.calls.push('export-render');};
  f.studio.startExport(480,360);
  assert.equal(f.studio._exportState.pixelRatio,2,'endExport will restore the original retina quality');
  assert.equal(f.studio._previewInteraction,null);assert.equal(f.pixelRatio,1,'offscreen exports use requested pixel dimensions');
  assert.deepEqual(f.calls.filter(value=>Array.isArray(value)&&value[0]==='pixelRatio'),[['pixelRatio',1]]);
  assert.ok(f.calls.indexOf('flush-environment')<f.calls.indexOf('export-render'));f.assertSourceIntact();
});

test('invalid export dimensions still release held preview and its timer before raising the input error',t=>{
  const f=fixture(t);f.studio.beginPreviewInteraction();f.studio._drawScene();
  assert.throws(()=>f.studio.startExport(0,360),/导出尺寸/);
  assert.equal(f.pixelRatio,2);assert.equal(f.studio._previewInteraction,null);assert.equal(f.timer.timers.size,0);
  assert.equal(uniform(f.material),0);assert.equal(uniform(f.depth),0);f.assertSourceIntact();
});

test('production interactive draw swaps only the exterior geometry and creates no extra scene mesh when supports are hidden',t=>{
  const f=compactFixture(t);f.full.instanceCount=8;f.studio.options.showSupports=false;
  const originalRender=f.studio._dofComposer.render;let inspected=0;
  f.studio._dofComposer.render=function(...args){
    inspected++;assert.equal(f.path.geometry,f.preview.exterior);assert.equal(f.path.geometry.instanceCount,3);
    assert.equal(f.preview.support.instanceCount,2,'growth prefix is current even when this support bucket stays detached');
    assert.equal(f.preview.supportMesh.parent,null);assert.deepEqual(f.parent.children,[f.path]);
    return originalRender.apply(this,args);
  };
  f.studio.beginPreviewInteraction({hold:true});f.studio._drawScene();
  assert.equal(inspected,1);assert.equal(f.studio.renderer.shadowMap.enabled,true);f.assertFullIntact(8);
});

test('support preview reuses one mesh under the same parent and matrix, with fresh counts from every full growth prefix',t=>{
  const f=compactFixture(t),support=f.preview.supportMesh,originalRender=f.studio._dofComposer.render;
  let expectedPrefix=0,inspected=0;
  f.studio._dofComposer.render=function(...args){
    inspected++;const exterior=[0,4,7,8,9].filter(index=>index<expectedPrefix).length,supportCount=[5,6].filter(index=>index<expectedPrefix).length;
    assert.equal(f.path.geometry,f.preview.exterior);assert.equal(f.path.geometry.instanceCount,exterior);
    assert.equal(f.preview.support.instanceCount,supportCount);assert.equal(f.preview.supportMesh,support,'no per-frame mesh allocation');
    if(supportCount){
      assert.equal(support.parent,f.parent);assert.equal(support.material,f.path.material);assert.equal(support.geometry,f.preview.support);
      assert.deepEqual(support.matrix.toArray(),f.path.matrix.toArray());assert.equal(support.matrixAutoUpdate,false);
      f.studio.scene.updateMatrixWorld(true);assert.deepEqual(support.matrixWorld.toArray(),f.path.matrixWorld.toArray());
      assert.deepEqual(f.parent.children,[f.path,support]);
    }else{assert.equal(support.parent,null);assert.deepEqual(f.parent.children,[f.path]);}
    return originalRender.apply(this,args);
  };
  f.studio.beginPreviewInteraction({hold:true});
  for(const prefix of [0,5,6,7,9,10]){expectedPrefix=prefix;f.full.instanceCount=prefix;f.studio._drawScene();f.assertFullIntact(prefix);}
  assert.equal(inspected,6);assert.equal(f.studio.renderer.shadowMap.enabled,true);
});

test('compact geometry and temporarily attached support are restored after a real draw exception',t=>{
  const f=compactFixture(t),failure=new Error('compact GPU failure'),originalRender=f.studio._dofComposer.render;
  f.full.instanceCount=10;let inspected=false;
  f.studio._dofComposer.render=function(...args){
    inspected=true;assert.equal(f.path.geometry,f.preview.exterior);assert.equal(f.preview.supportMesh.parent,f.parent);
    return originalRender.apply(this,args);
  };
  f.studio.beginPreviewInteraction({hold:true});f.failRender(failure);
  assert.throws(()=>f.studio._drawScene(),error=>error===failure);
  assert.equal(inspected,true);assert.equal(f.studio.renderer.shadowMap.enabled,true);f.assertFullIntact(10);
  f.studio.endPreviewInteraction();assert.equal(uniform(f.material),0);assert.equal(uniform(f.depth),0);
});

test('stationary and export draws retain full geometry and never refresh or attach the interaction cache',t=>{
  const f=compactFixture(t);f.full.instanceCount=5;let completeDraws=0;
  f.studio._dofComposer.render=()=>{
    if(f.studio._previewInteraction&&!f.studio._exportState){
      assert.equal(f.path.geometry,f.preview.exterior);assert.equal(f.studio._dofBokehPass.enabled,false);
      return;
    }
    completeDraws++;assert.equal(f.path.geometry,f.full);assert.equal(f.preview.supportMesh.parent,null);
    assert.deepEqual(f.parent.children,[f.path]);assert.equal(uniform(f.material),0);assert.equal(uniform(f.depth),0);
  };
  f.studio._drawScene();
  assert.equal(f.preview.exterior.instanceCount,5);assert.equal(f.preview.support.instanceCount,2,'stationary frame must not update preview counts');
  f.studio.beginPreviewInteraction({hold:true});f.studio._drawScene();f.studio.endPreviewInteraction();
  assert.equal(f.preview.exterior.instanceCount,2);assert.equal(f.preview.support.instanceCount,0);f.assertFullIntact(5);
  f.full.instanceCount=10;f.studio.beginPreviewInteraction({hold:true});f.studio._exportState={};f.studio._drawScene();
  assert.equal(completeDraws,2);assert.equal(f.preview.exterior.instanceCount,2);assert.equal(f.preview.support.instanceCount,0,'export must not touch the compact cache');
  f.assertFullIntact(10);
});
