import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {prepareCADDisplayLODs,beginCADDisplayFrame,disposeCADDisplayLOD} from '../src/cad-display-controller.js';

function fixture(t,{shared=false}={}){
  const source=new THREE.PlaneGeometry(10,10,12,12),material=new THREE.MeshStandardMaterial(),root=new THREE.Group();
  source.userData={source:'unaltered CAD'};
  const mesh=new THREE.Mesh(source,material);mesh.name='body';mesh.userData={name:'original'};root.add(mesh);
  const meshes=[mesh];if(shared){const second=new THREE.Mesh(source,material);second.name='second body';root.add(second);meshes.push(second);}
  root.updateMatrixWorld(true);
  const camera=new THREE.PerspectiveCamera(50,1,.1,1000);camera.position.z=100;camera.updateMatrixWorld();
  const options={sourceUnitScale:1,yieldControl:()=>Promise.resolve()};
  t.after(()=>{root.traverse(node=>disposeCADDisplayLOD(node));source.dispose();material.dispose();});
  return{source,root,mesh,meshes,camera,options};
}

test('CAD preparation keeps source geometry and attributes; hidden cache does not leak through Object3D cloning',async t=>{
  const f=fixture(t),positions=f.source.attributes.position.array.slice(),normals=f.source.attributes.normal.array.slice(),bounds=f.source.boundingBox;
  const result=await prepareCADDisplayLODs(f.root,f.options),metadata=f.mesh.userData.meshDisplayLOD;
  assert.equal(result.simplifiedMeshes,1);assert.equal(result.meshes[0],f.mesh);assert.ok(result.displayTriangles<result.sourceTriangles);
  assert.equal(f.mesh.geometry,f.source);assert.equal(metadata.sourceGeometry,f.source);assert.equal(metadata.ownsGeometry,true);
  assert.deepEqual(f.source.attributes.position.array,positions);assert.deepEqual(f.source.attributes.normal.array,normals);assert.equal(f.source.boundingBox,bounds);
  assert.deepEqual(Object.keys(f.mesh.userData),['name']);assert.equal(Object.getOwnPropertyDescriptor(f.mesh.userData,'meshDisplayLOD').enumerable,false);
  const clone=f.mesh.clone(false);assert.equal(clone.userData.meshDisplayLOD,undefined);assert.equal(clone.geometry,f.source);
});

test('shared original geometry gets one prepared LOD and repeated preparation reuses it',async t=>{
  const f=fixture(t,{shared:true});let starts=0;
  const result=await prepareCADDisplayLODs(f.root,{...f.options,onProgress:event=>{if(event.detailPhase==='initialize')starts++;}});
  assert.equal(result.uniqueGeometries,1);assert.equal(starts,1);
  const first=f.meshes[0].userData.meshDisplayLOD.geometry;assert.equal(f.meshes[1].userData.meshDisplayLOD.geometry,first);
  const repeat=await prepareCADDisplayLODs(f.root,{...f.options,onProgress:event=>{assert.equal(event.detailPhase,undefined,'no repeated WASM work');}});
  assert.equal(repeat.uniqueGeometries,1);assert.equal(f.meshes[0].userData.meshDisplayLOD.geometry,first);
});

test('frame swap obeys actual pixel error, world scale and output dimensions, then restores full CAD idempotently',async t=>{
  const f=fixture(t);await prepareCADDisplayLODs(f.root,f.options);
  const restore=beginCADDisplayFrame(f.meshes,{camera:f.camera,width:400,height:400});
  assert.equal(restore.swappedMeshes,1);assert.equal(f.mesh.geometry,f.mesh.userData.meshDisplayLOD.geometry);
  restore();restore();assert.equal(f.mesh.geometry,f.source);
  const finalResolution=beginCADDisplayFrame(f.meshes,{camera:f.camera,width:4000,height:4000});assert.equal(finalResolution.swappedMeshes,0);finalResolution();
  f.root.scale.setScalar(10);f.root.updateMatrixWorld(true);
  const close=beginCADDisplayFrame(f.meshes,{camera:f.camera,width:400,height:400});assert.equal(close.swappedMeshes,0);close();assert.equal(f.mesh.geometry,f.source);
  const disabled=beginCADDisplayFrame(f.meshes,{enabled:false});assert.equal(disabled.swappedMeshes,0);disabled();
});

test('caller draw exceptions and nested frame calls cannot leave CAD in its display-only geometry',async t=>{
  const f=fixture(t);await prepareCADDisplayLODs(f.root,f.options);
  const restore=beginCADDisplayFrame(f.meshes,{camera:f.camera,width:400,height:400});
  const nested=beginCADDisplayFrame(f.meshes,{camera:f.camera,width:400,height:400});assert.equal(nested.swappedMeshes,0);nested();
  assert.throws(()=>{try{throw new Error('controlled GPU draw failure');}finally{restore();}},/controlled GPU/);
  assert.equal(f.mesh.geometry,f.source);
  const again=beginCADDisplayFrame(f.meshes,{camera:f.camera,width:400,height:400});
  const external=new THREE.BoxGeometry();f.mesh.geometry=external;again();assert.equal(f.mesh.geometry,external,'does not overwrite an externally replaced geometry');
  f.mesh.geometry=f.source;external.dispose();
});

test('a gate exception after an earlier swap restores every mesh before propagating the error',async t=>{
  const f=fixture(t,{shared:true});await prepareCADDisplayLODs(f.root,f.options);
  f.meshes[1].matrixWorld.elements[0]=NaN;
  assert.throws(()=>beginCADDisplayFrame(f.meshes,{camera:f.camera,width:400,height:400}),/像素误差参数/);
  for(const mesh of f.meshes)assert.equal(mesh.geometry,f.source);
});

test('changed original colors or topology never render stale cached attributes and can be explicitly re-prepared',async t=>{
  const f=fixture(t);f.source.setAttribute('color',new THREE.BufferAttribute(new Float32Array(f.source.attributes.position.count*3).fill(.5),3));
  await prepareCADDisplayLODs(f.root,f.options);const old=f.mesh.userData.meshDisplayLOD.geometry;let disposed=0;old.addEventListener('dispose',()=>disposed++);
  f.source.attributes.color.array.fill(.2);f.source.attributes.color.needsUpdate=true;
  const stale=beginCADDisplayFrame(f.meshes,{camera:f.camera,width:400,height:400});assert.equal(stale.swappedMeshes,0);stale();
  await prepareCADDisplayLODs(f.root,f.options);assert.equal(disposed,1);assert.notEqual(f.mesh.userData.meshDisplayLOD.geometry,old);
  assert.ok(f.mesh.userData.meshDisplayLOD.geometry.attributes.color.array.every(value=>Math.abs(value-.2)<1e-7));
  const fresh=beginCADDisplayFrame(f.meshes,{camera:f.camera,width:400,height:400});assert.equal(fresh.swappedMeshes,1);fresh();
  f.source.setDrawRange(3,3);const partial=beginCADDisplayFrame(f.meshes,{camera:f.camera,width:400,height:400});assert.equal(partial.swappedMeshes,0);partial();
});

test('shared LOD release disposes its owned geometry exactly once and never disposes original CAD',async t=>{
  const f=fixture(t,{shared:true});await prepareCADDisplayLODs(f.root,f.options);
  const lod=f.mesh.userData.meshDisplayLOD.geometry;let lodDisposes=0,sourceDisposes=0;
  lod.addEventListener('dispose',()=>lodDisposes++);f.source.addEventListener('dispose',()=>sourceDisposes++);
  assert.equal(disposeCADDisplayLOD(f.meshes[0]),null);assert.equal(lodDisposes,0);
  assert.equal(disposeCADDisplayLOD(f.meshes[1]),lod);assert.equal(lodDisposes,1);assert.equal(sourceDisposes,0);
  assert.equal(disposeCADDisplayLOD(f.meshes[1]),null);assert.equal(lodDisposes,1);
  for(const mesh of f.meshes){assert.equal(mesh.geometry,f.source);assert.equal(mesh.userData.meshDisplayLOD,undefined);}
});

test('disposeTree collection receives only the last owned shared LOD without disposing it early',async t=>{
  const f=fixture(t,{shared:true});await prepareCADDisplayLODs(f.root,f.options);const lod=f.mesh.userData.meshDisplayLOD.geometry;let disposed=0;lod.addEventListener('dispose',()=>disposed++);
  assert.equal(disposeCADDisplayLOD(f.meshes[0],{dispose:false}),null);
  assert.equal(disposeCADDisplayLOD(f.meshes[1],{dispose:false}),lod);assert.equal(disposed,0);
  lod.dispose();assert.equal(disposed,1);
});

test('optional low-memory fallback owns no geometry and never changes the source during frame/release',async t=>{
  const f=fixture(t);const result=await prepareCADDisplayLODs(f.root,{...f.options,maxWorkingBytes:1});
  assert.equal(result.simplifiedMeshes,0);assert.equal(f.mesh.userData.meshDisplayLOD.ownsGeometry,false);
  const restore=beginCADDisplayFrame(f.meshes,{camera:f.camera,width:400,height:400});assert.equal(restore.swappedMeshes,0);restore();
  assert.equal(disposeCADDisplayLOD(f.mesh),null);assert.equal(f.mesh.geometry,f.source);
});

test('instanced, animated, support, native proxy and translucent nodes are excluded from CAD preparation',async t=>{
  const f=fixture(t),instanced=new THREE.InstancedMesh(f.source,f.mesh.material,1),skinned=new THREE.SkinnedMesh(f.source,f.mesh.material);
  const support=new THREE.Group();support.userData.isSupport=true;support.add(new THREE.Mesh(f.source,f.mesh.material));
  const native=new THREE.Mesh(f.source,f.mesh.material);native.userData.printPathImpostor=true;
  const translucent=new THREE.Mesh(f.source,new THREE.MeshStandardMaterial({transparent:true,opacity:.5}));
  f.root.add(instanced,skinned,support,native,translucent);t.after(()=>{instanced.dispose();translucent.material.dispose();});
  const result=await prepareCADDisplayLODs(f.root,f.options);assert.deepEqual(result.meshes,[f.mesh]);
  for(const node of[instanced,skinned,support.children[0],native,translucent])assert.equal(node.userData.meshDisplayLOD,undefined);
});

test('cancelled preparation is atomic and releases newly created LODs without touching prior CAD',async t=>{
  const f=fixture(t),secondSource=new THREE.PlaneGeometry(8,8,10,10),second=new THREE.Mesh(secondSource,f.mesh.material);f.root.add(second);t.after(()=>secondSource.dispose());
  const originalDispose=THREE.BufferGeometry.prototype.dispose;let lodDisposes=0;
  t.mock.method(THREE.BufferGeometry.prototype,'dispose',function(){if(this.userData.meshDisplayLOD?.displayOnly)lodDisposes++;originalDispose.call(this);});
  const abort=new AbortController();
  await assert.rejects(prepareCADDisplayLODs(f.root,{...f.options,signal:abort.signal,onProgress:event=>{if(event.completed===1&&!event.detailPhase)abort.abort();}}),{name:'AbortError'});
  assert.equal(lodDisposes,1);assert.equal(f.mesh.geometry,f.source);assert.equal(second.geometry,secondSource);
  assert.equal(f.mesh.userData.meshDisplayLOD,undefined);assert.equal(second.userData.meshDisplayLOD,undefined);
});

test('source edits during asynchronous preparation reject mixed-state caches and retain source geometry',async t=>{
  const f=fixture(t);let edited=false;
  await assert.rejects(prepareCADDisplayLODs(f.root,{...f.options,chunkSize:27,onProgress:event=>{
    if(event.detailPhase==='weld'&&!edited){edited=true;f.source.attributes.position.needsUpdate=true;}
  }}),/原始 CAD/);
  assert.equal(f.mesh.geometry,f.source);assert.equal(f.mesh.userData.meshDisplayLOD,undefined);
});

test('reserved unowned metadata and frozen userData are preserved instead of causing a partial cache commit',async t=>{
  const f=fixture(t),unowned={external:true};f.mesh.userData.meshDisplayLOD=unowned;
  const conflict=await prepareCADDisplayLODs(f.root,f.options);assert.equal(conflict.skippedMeshes,1);assert.equal(f.mesh.userData.meshDisplayLOD,unowned);
  delete f.mesh.userData.meshDisplayLOD;Object.preventExtensions(f.mesh.userData);
  const frozen=await prepareCADDisplayLODs(f.root,f.options);assert.equal(frozen.skippedMeshes,1);assert.equal(f.mesh.geometry,f.source);
});
