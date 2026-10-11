import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { createMeshDisplayLOD, projectedMeshDisplayErrorPx, isMeshDisplayLODWithinScreenError } from '../src/mesh-display-lod.js';

const hash = array => createHash('sha256').update(Buffer.from(array.buffer,array.byteOffset,array.byteLength)).digest('hex');
const snapshot = geometry => ({ index:geometry.index&&hash(geometry.index.array),groups:structuredClone(geometry.groups),range:{...geometry.drawRange},
  attributes:Object.fromEntries(Object.entries(geometry.attributes).map(([name,a])=>[name,hash(a.isInterleavedBufferAttribute?a.data.array:a.array)])),userData:structuredClone(geometry.userData) });
const fastYield = () => Promise.resolve();

function paintedHole() {
  const positions=[],normals=[],colors=[],tools=[],parts=[[],[]],vertices=new Map();
  const vertex=(x,y,tool)=>{
    const key=`${x},${y},${tool}`;if(vertices.has(key))return vertices.get(key);
    const id=positions.length/3;vertices.set(key,id);positions.push(x,y,0);normals.push(0,0,1);
    colors.push(...(tool===0?[240,232,214]:[35,89,156]));tools.push(tool);return id;
  };
  for(let y=0;y<20;y++)for(let x=0;x<20;x++){
    if(x>=8&&x<12&&y>=8&&y<12)continue;
    const tool=x<10?0:1,a=vertex(x,y,tool),b=vertex(x+1,y,tool),c=vertex(x+1,y+1,tool),d=vertex(x,y+1,tool);
    parts[tool].push(a,b,c,a,c,d);
  }
  const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
  geometry.setAttribute('normal',new THREE.Float32BufferAttribute(normals,3));
  geometry.setAttribute('color',new THREE.Uint8BufferAttribute(colors,3,true));geometry.setAttribute('toolIndex',new THREE.Uint16BufferAttribute(tools,1));
  geometry.setIndex([...parts[0],...parts[1]]);geometry.addGroup(0,parts[0].length,2);geometry.addGroup(parts[0].length,parts[1].length,7);
  geometry.userData={source:'painted-CAD',keep:'original'};return geometry;
}

function inspectSurface(geometry) {
  const p=geometry.attributes.position,index=geometry.index;let area=0,holeCovered=0;
  const cross=(a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
  for(let i=0;i<index.count;i+=3){
    const points=[index.getX(i),index.getX(i+1),index.getX(i+2)].map(id=>[p.getX(id),p.getY(id)]);
    area+=Math.abs(cross(...points))/2;
    const signs=[cross(points[0],points[1],[10,10]),cross(points[1],points[2],[10,10]),cross(points[2],points[0],[10,10])];
    if(signs.every(value=>value>1e-8)||signs.every(value=>value< -1e-8))holeCovered++;
  }
  return{area,holeCovered};
}

test('actual bundled WASM reduces CAD display while retaining a hole, painted colors and independent material groups',async()=>{
  const source=paintedHole(),before=snapshot(source);
  const result=await createMeshDisplayLOD(source,{targetTriangleBudget:40,maxDeviationMm:.04,yieldControl:fastYield});
  try{
    assert.equal(result.ownsGeometry,true);assert.notEqual(result.geometry,source);assert.equal(result.sourceTriangles,768);
    assert.ok(result.displayTriangles<384);assert.ok(result.displayTriangles>40,'a soft budget cannot force away locked boundaries');
    assert.equal(result.targetReached,false);assert.ok(result.errorMm<=.04);assert.equal(result.normalsRecomputed,false);
    assert.deepEqual(snapshot(source),before);
    assert.deepEqual(inspectSurface(result.geometry),{area:384,holeCovered:0});
    assert.deepEqual(result.geometry.groups.map(group=>group.materialIndex),[2,7]);
    assert.equal(result.geometry.attributes.color.array.constructor,Uint8Array);assert.equal(result.geometry.attributes.color.normalized,true);
    for(const group of result.geometry.groups)for(let i=group.start;i<group.start+group.count;i+=3){
      const ids=[result.geometry.index.getX(i),result.geometry.index.getX(i+1),result.geometry.index.getX(i+2)];
      assert.equal(new Set(ids.map(id=>result.geometry.attributes.toolIndex.getX(id))).size,1);
      assert.equal(result.geometry.attributes.toolIndex.getX(ids[0]),group.materialIndex===2?0:1);
      const color=group.materialIndex===2?[240,232,214]:[35,89,156];
      for(const id of ids)assert.deepEqual([...result.geometry.attributes.color.array.slice(id*3,id*3+3)],color);
    }
  }finally{if(result.ownsGeometry)result.geometry.dispose();source.dispose();}
});

test('nonindexed CAD is welded only across identical streams and preserves original normals, UV and custom data',async()=>{
  const source=new THREE.PlaneGeometry(20,20,20,20).toNonIndexed();
  const custom=new Uint16Array(source.attributes.position.count).fill(19);source.setAttribute('manufacturingID',new THREE.BufferAttribute(custom,1));
  const before=snapshot(source),result=await createMeshDisplayLOD(source,{targetTriangleBudget:50,yieldControl:fastYield});
  try{
    assert.ok(result.displayTriangles<result.sourceTriangles);assert.deepEqual(snapshot(source),before);
    assert.deepEqual(Object.keys(result.geometry.attributes).sort(),Object.keys(source.attributes).sort());
    for(let i=0;i<result.geometry.attributes.normal.count;i++)assert.deepEqual([result.geometry.attributes.normal.getX(i),result.geometry.attributes.normal.getY(i),result.geometry.attributes.normal.getZ(i)],[0,0,1]);
    assert.ok(result.geometry.attributes.manufacturingID.array.every(value=>value===19));
    const p=result.geometry.attributes.position,uv=result.geometry.attributes.uv;
    for(let i=0;i<p.count;i++){assert.ok(Math.abs(uv.getX(i)-(p.getX(i)+10)/20)<1e-6);assert.ok(Math.abs(uv.getY(i)-(p.getY(i)+10)/20)<1e-6);}
  }finally{if(result.ownsGeometry)result.geometry.dispose();source.dispose();}
});

test('nonsequential material group draw order survives while progress remains monotonic',async()=>{
  const source=paintedHole();source.groups.reverse();const before=snapshot(source),events=[];
  const result=await createMeshDisplayLOD(source,{chunkSize:27,yieldControl:fastYield,onProgress:event=>events.push(event)});
  try{
    assert.deepEqual(result.geometry.groups.map(group=>group.materialIndex),[7,2]);assert.deepEqual(snapshot(source),before);
    assert.deepEqual(inspectSurface(result.geometry),{area:384,holeCovered:0});
    const weld=events.filter(event=>event.phase==='weld');for(let i=1;i<weld.length;i++)assert.ok(weld[i].completed>=weld[i-1].completed);
  }finally{if(result.ownsGeometry)result.geometry.dispose();source.dispose();}
});

test('sharp cube corners and original face normals cannot become rounded by a very small display budget',async()=>{
  const source=new THREE.BoxGeometry(10,10,10,5,5,5),before=snapshot(source);
  const result=await createMeshDisplayLOD(source,{targetTriangleBudget:4,maxDeviationMm:.04,yieldControl:fastYield});
  try{
    assert.equal(result.targetReached,false);assert.ok(result.lockedVertices>0);assert.deepEqual(snapshot(source),before);
    const p=result.geometry.attributes.position,n=result.geometry.attributes.normal;
    for(let i=0;i<n.count;i++)assert.equal([n.getX(i),n.getY(i),n.getZ(i)].filter(value=>Math.abs(value)===1).length,1);
    for(const x of[-5,5])for(const y of[-5,5])for(const z of[-5,5])assert.ok(Array.from({length:p.count},(_,i)=>i).some(i=>p.getX(i)===x&&p.getY(i)===y&&p.getZ(i)===z),'every original sharp corner remains');
  }finally{if(result.ownsGeometry)result.geometry.dispose();source.dispose();}
});

test('mixed per-corner colors and tools are conservatively kept, never changed to a uniform material',async()=>{
  const source=new THREE.PlaneGeometry(2,2,3,3),count=source.attributes.position.count;
  source.setAttribute('color',new THREE.BufferAttribute(Float32Array.from({length:count*3},(_,i)=>i%3===0?(i/3)%4/3:0),3));
  source.setAttribute('toolIndex',new THREE.BufferAttribute(Uint8Array.from({length:count},(_,i)=>i%4),1));
  const before=snapshot(source),result=await createMeshDisplayLOD(source,{targetTriangleBudget:1,yieldControl:fastYield});
  try{assert.equal(result.displayTriangles,result.sourceTriangles);assert.equal(result.targetReached,false);assert.deepEqual(snapshot(source),before);}
  finally{if(result.ownsGeometry)result.geometry.dispose();source.dispose();}
});

test('interleaved position/normal/UV data retain their decoded values and empty source groups remain empty',async()=>{
  const plane=new THREE.PlaneGeometry(10,10,8,8),source=new THREE.BufferGeometry(),count=plane.attributes.position.count;
  const values=new Float32Array(count*8);
  for(let i=0;i<count;i++)values.set([plane.attributes.position.getX(i),plane.attributes.position.getY(i),0,0,0,1,plane.attributes.uv.getX(i),plane.attributes.uv.getY(i)],i*8);
  const data=new THREE.InterleavedBuffer(values,8);
  source.setAttribute('position',new THREE.InterleavedBufferAttribute(data,3,0));source.setAttribute('normal',new THREE.InterleavedBufferAttribute(data,3,3));source.setAttribute('uv',new THREE.InterleavedBufferAttribute(data,2,6));source.setIndex(plane.index.clone());
  const before=snapshot(source),result=await createMeshDisplayLOD(source,{yieldControl:fastYield});
  try{
    assert.ok(result.displayTriangles<result.sourceTriangles);assert.deepEqual(snapshot(source),before);assert.deepEqual(result.geometry.groups,[]);
    const p=result.geometry.attributes.position,uv=result.geometry.attributes.uv,n=result.geometry.attributes.normal;
    for(let i=0;i<p.count;i++){assert.ok(Math.abs(uv.getX(i)-(p.getX(i)+5)/10)<1e-6);assert.ok(Math.abs(uv.getY(i)-(p.getY(i)+5)/10)<1e-6);assert.deepEqual([n.getX(i),n.getY(i),n.getZ(i)],[0,0,1]);}
  }finally{if(result.ownsGeometry)result.geometry.dispose();source.dispose();plane.dispose();}
});

test('source unit conversion expresses the error in millimetres without rescaling source or output positions',async()=>{
  const mm=new THREE.PlaneGeometry(10,10,12,12),metres=mm.clone();metres.scale(.001,.001,.001);
  const before=snapshot(metres),result=await createMeshDisplayLOD(metres,{sourceUnitScale:1000,maxDeviationMm:.04,yieldControl:fastYield});
  try{assert.deepEqual(snapshot(metres),before);assert.equal(result.sourceUnitScale,1000);assert.ok(result.errorMm<=.04);assert.ok(result.geometry.boundingBox.max.x<.01);}
  finally{if(result.ownsGeometry)result.geometry.dispose();mm.dispose();metres.dispose();}
});

test('progress yields during preparation and bounded WASM chunks; cancellation keeps source CAD intact',async()=>{
  const source=new THREE.PlaneGeometry(10,10,12,12),before=snapshot(source),events=[];let yielded=0;
  const result=await createMeshDisplayLOD(source,{chunkSize:27,simplifyChunkTriangles:40,yieldControl:async()=>{yielded++;},onProgress:event=>events.push(event)});
  try{
    assert.ok(yielded>10);assert.ok(events.filter(event=>event.phase==='simplify').length>4);
    assert.equal(events.at(-1).phase,'complete');assert.deepEqual(snapshot(source),before);
    const abort=new AbortController();
    await assert.rejects(createMeshDisplayLOD(source,{signal:abort.signal,chunkSize:27,yieldControl:fastYield,onProgress:event=>{if(event.phase==='weld'&&event.completed>0)abort.abort();}}),{name:'AbortError'});
    assert.deepEqual(snapshot(source),before);
    const between=new AbortController();
    await assert.rejects(createMeshDisplayLOD(source,{signal:between.signal,simplifyChunkTriangles:40,yieldControl:fastYield,onProgress:event=>{if(event.phase==='simplify'&&event.completed===1)between.abort();}}),{name:'AbortError'});
    assert.deepEqual(snapshot(source),before);
  }finally{if(result.ownsGeometry)result.geometry.dispose();source.dispose();}
});

test('memory, deformation and partial/group-layout fallbacks return explicit source ownership without mutation',async()=>{
  const source=new THREE.BoxGeometry(),before=snapshot(source);
  const memory=await createMeshDisplayLOD(source,{maxWorkingBytes:1});assert.equal(memory.geometry,source);assert.equal(memory.ownsGeometry,false);assert.equal(memory.skippedReason,'working-memory-budget');
  assert.deepEqual(snapshot(source),before);
  source.setDrawRange(3,3);const partial=await createMeshDisplayLOD(source);assert.equal(partial.skippedReason,'partial-draw-range');
  source.setDrawRange(0,Infinity);source.groups[1].start=0;
  assert.equal((await createMeshDisplayLOD(source)).skippedReason,'incomplete-or-overlapping-material-groups');
  source.clearGroups();source.morphAttributes.position=[source.attributes.position.clone()];
  assert.equal((await createMeshDisplayLOD(source)).skippedReason,'deformed-or-instanced');source.dispose();
});

test('invalid coordinates, source scale and budgets fail rather than silently substituting geometry',async()=>{
  const source=new THREE.PlaneGeometry();
  await assert.rejects(createMeshDisplayLOD(source,{sourceUnitScale:0}),/毫米比例/);
  await assert.rejects(createMeshDisplayLOD(source,{targetTriangleBudget:0}),/预算/);
  source.attributes.position.array[0]=NaN;await assert.rejects(createMeshDisplayLOD(source,{yieldControl:fastYield}),/非有限/);source.dispose();
});

test('screen gate uses actual cropped projection, scale and viewport without mutating source camera/geometry',()=>{
  const geometry=new THREE.BoxGeometry(1,1,1),camera=new THREE.PerspectiveCamera(50,4/3,.1,1000);
  camera.position.set(0,0,100);camera.setViewOffset(4/3,1,.1,.2,.6,.6);
  const before={projection:camera.projectionMatrix.toArray(),inverse:camera.projectionMatrixInverse.toArray(),position:camera.position.toArray(),bounds:geometry.boundingBox};
  const parameters={errorMm:.04,geometry,camera,width:800,height:600},small=projectedMeshDisplayErrorPx(parameters);
  assert.ok(small>0);assert.ok(Math.abs(projectedMeshDisplayErrorPx({...parameters,width:1600,height:1200})-small*2)<1e-8);
  assert.ok(projectedMeshDisplayErrorPx({...parameters,worldMatrix:new THREE.Matrix4().makeScale(2,2,2)})>small);
  assert.equal(isMeshDisplayLODWithinScreenError({...parameters,maxPixels:.5}),small<=.5);
  assert.throws(()=>isMeshDisplayLODWithinScreenError({...parameters,maxPixels:1}),/0.5/);
  assert.deepEqual(camera.projectionMatrix.toArray(),before.projection);assert.deepEqual(camera.projectionMatrixInverse.toArray(),before.inverse);assert.deepEqual(camera.position.toArray(),before.position);assert.equal(geometry.boundingBox,before.bounds);
  camera.position.set(0,0,.2);assert.equal(projectedMeshDisplayErrorPx(parameters),Infinity);geometry.dispose();
});

test('orthographic, off-axis and unit-scaled error bounds are finite and conservative',()=>{
  const geometry=new THREE.BoxGeometry(1,1,1),camera=new THREE.OrthographicCamera(-10,10,10,-10,.1,100);camera.position.z=20;
  const p={errorMm:.01,geometry,camera,width:400,height:400},a=projectedMeshDisplayErrorPx(p);
  assert.ok(a>0);assert.ok(Math.abs(projectedMeshDisplayErrorPx({...p,sourceUnitScale:1000})-a/1000)<1e-9);
  const perspective=new THREE.PerspectiveCamera(50,1,.1,1000);perspective.position.z=100;
  const centre=projectedMeshDisplayErrorPx({...p,camera:perspective});
  assert.ok(projectedMeshDisplayErrorPx({...p,camera:perspective,worldMatrix:new THREE.Matrix4().makeTranslation(40,0,0)})>centre);
  geometry.dispose();
});

test('uniform rotations do not inflate the physical error by sqrt3 and shear keeps a conservative bound',()=>{
  const geometry=new THREE.BoxGeometry(1,1,1),camera=new THREE.OrthographicCamera(-10,10,10,-10,.1,100);camera.position.z=20;
  const p={errorMm:.01,geometry,camera,width:400,height:400},expected=.2;
  assert.ok(Math.abs(projectedMeshDisplayErrorPx(p)-expected)<1e-12);
  const rotation=new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(.3,.7,-.2));
  assert.ok(Math.abs(projectedMeshDisplayErrorPx({...p,worldMatrix:rotation})-expected)<1e-12);
  const shear=new THREE.Matrix4().makeShear(1,0,0,0,0,0);
  assert.ok(projectedMeshDisplayErrorPx({...p,worldMatrix:shear})>=expected*1.618,'operator bound covers the golden-ratio shear singular value');
  const perspective=new THREE.PerspectiveCamera(50,1,.1,1000);perspective.position.z=100;
  const centre=projectedMeshDisplayErrorPx({...p,camera:perspective});
  assert.ok(Math.abs(projectedMeshDisplayErrorPx({...p,camera:perspective,worldMatrix:new THREE.Matrix4().makeRotationZ(Math.PI/4)})-centre)<1e-10);
  geometry.dispose();
});
