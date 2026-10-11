import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { zipSync, strToU8 } from 'three/addons/libs/fflate.module.js';
import { GrowthStudio } from '../src/studio.js';
import { parsePrintLayerGCode, PRINTER_MM_TO_THREE_MM } from '../src/print-layer.js';

const code = `; filament_colour = #f0e8d6;#23599c
; layer_height = 0.12
; initial_layer_print_height = 0.25
G21
G90
M83
;LAYER_CHANGE
;Z:0.25
;HEIGHT:0.25
;TYPE:Outer wall
;WIDTH:0.42
G0 X0 Y0 Z0.25
G1 X10 Y0 E1
;LAYER_CHANGE
;Z:0.37
;HEIGHT:0.12
;TYPE:Support
T1
G0 X0 Y0 Z0.37
G1 X10 Y10 E1
`;
const sha = array => createHash('sha256').update(Buffer.from(array.buffer,array.byteOffset,array.byteLength)).digest('hex');
const cadFile = () => new File([zipSync(Object.fromEntries(Object.entries({
  '3D/3dmodel.model':'<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="10" y="0" z="0"/><vertex x="0" y="10" z="1"/></vertices><triangles><triangle v1="0" v2="1" v3="2" paint_color="4"/></triangles></mesh></object></resources><build><item objectid="1"/></build></model>',
  'Metadata/project_settings.config':JSON.stringify({filament_colour:['#f0e8d6','#23599c'],layer_height:'0.12',initial_layer_print_height:'0.25'}),
  'Metadata/model_settings.config':'<config/>'
}).map(([name,text])=>[name,strToU8(text)])))],'source.3mf');
const stlFile = () => new File([`solid original
facet normal 0 -0.70710678 0.70710678
outer loop
vertex 0 0 0
vertex 1 0 0
vertex 0 1 1
endloop
endfacet
endsolid original
`],'original.stl',{type:'model/stl'});

async function fixture() {
  const studio=Object.create(GrowthStudio.prototype);
  studio.options={progress:.5,preserveMaterials:true,color:'#b7bec8',modelScale:1,toolColors:{},showSupports:true,surfacePreset:'auto',surfaceDetail:.6};
  studio.clipPlane=new THREE.Plane(new THREE.Vector3(0,-1,0),8);
  studio.layerUniforms={enabled:{value:1},count:{value:240},min:{value:0},max:{value:8}};
  studio.scene=new THREE.Scene();studio.modelGroup=new THREE.Group();studio.scene.add(studio.modelGroup);
  studio._sourceMaterials=new Map();studio._retainedMaterials=new Set();studio._turnRadians=0;
  studio.cap=new THREE.Mesh(new THREE.PlaneGeometry(100,100),new THREE.MeshStandardMaterial());
  studio.floor=new THREE.Mesh(new THREE.PlaneGeometry(),new THREE.MeshBasicMaterial());
  studio.keyLight={shadow:{}};studio._bounds=new THREE.Box3();
  studio.camera=new THREE.PerspectiveCamera(37,4/3,.1,100);studio.camera.position.set(3,4,5);studio.controls={target:new THREE.Vector3(1,2,1)};
  studio.setOptions=()=>{};studio.resetCamera=()=>{};studio._drawScene=()=>{};studio._updateLightPosition=()=>{};studio._updateShadowHelper=()=>{};
  const old=new THREE.Mesh(new THREE.BoxGeometry(20,10,20),new THREE.MeshStandardMaterial({color:'#f0e8d6'}));
  studio._adopt(old,'old.3mf','3mf',{mode:'mesh',materialColors:[{tool:0,color:'#f0e8d6'},{tool:1,color:'#23599c'}]});
  await studio.loadPrintGCode(parsePrintLayerGCode(code,{includeSupport:true}),{printerToSource:PRINTER_MM_TO_THREE_MM});
  let disposed=0;old.geometry.addEventListener('dispose',()=>disposed++);
  return {studio,old,original:studio.orientation,paths:studio._printLayers,supports:studio._indexedSupports,get disposed(){return disposed;}};
}

function assertOld(f) {
  assert.equal(f.studio.orientation,f.original);assert.equal(f.studio._printLayers,f.paths);assert.equal(f.studio._indexedSupports,f.supports);
  assert.equal(f.studio.metadata.name,'old.3mf');assert.equal(f.disposed,0);assert.equal(f.studio.normalized.parent,f.studio.modelGroup);
  assert.equal(f.studio.getPrintLayerData().parsed,f.paths.data);
}

test('CAD and complete paths/support commit together without changing source arrays; old resources release only on success',async()=>{
  const f=await fixture(),parsed=parsePrintLayerGCode(code,{includeSupport:true});
  const hashes=Object.fromEntries(['positions','tools','features','widths','heights','layers','layerSegments'].map(key=>[key,sha(parsed[key])]));
  const metadata=await f.studio.loadFiles([cadFile()],{parsedPrintGCode:parsed,printerToSource:PRINTER_MM_TO_THREE_MM});
  assert.equal(metadata.triangles,1);assert.equal(metadata.surfaceTopMode,'sliced-gcode');assert.equal(metadata.firstLayerHeightMm,.25);
  assert.equal(f.studio.getPrintLayerData().parsed,parsed);assert.equal(f.studio._indexedSupports.data,parsed);assert.equal(f.studio._indexedSupports.segmentCount,1);
  for(const [key,value]of Object.entries(hashes))assert.equal(sha(parsed[key]),value);
  assert.equal(f.disposed,1);assert.equal(f.paths.root.parent,null);assert.equal(f.studio._modelImportTransaction,null);
});

test('support allocation failure happens before adopting CAD and retains old source geometry and usable paths',async()=>{
  const f=await fixture();f.studio._buildIndexedSupports=()=>{throw new Error('display resource budget');};
  await assert.rejects(f.studio.loadFiles([cadFile()],{parsedPrintGCode:parsePrintLayerGCode(code,{includeSupport:true})}),/display resource budget/);
  assertOld(f);
});

test('cancellation after complete staging retains AbortError type and old scene, and the same file can be retried',async()=>{
  const f=await fixture(),abort=new AbortController(),original=f.studio._buildIndexedSupports;
  f.studio._buildIndexedSupports=function(...args){const next=original.apply(this,args);abort.abort();return next;};
  await assert.rejects(f.studio.loadFiles([cadFile()],{parsedPrintGCode:parsePrintLayerGCode(code,{includeSupport:true}),signal:abort.signal}),error=>error.name==='AbortError');
  assertOld(f);f.studio._buildIndexedSupports=original;
  await f.studio.loadFiles([cadFile()],{parsedPrintGCode:parsePrintLayerGCode(code,{includeSupport:true})});
  assert.equal(f.studio.metadata.name,'source.3mf');assert.equal(f.disposed,1);
});

test('path-only failure during historical geometry adoption restores old CAD, paths, model pose and camera',async()=>{
  const f=await fixture(),position=f.studio.camera.position.clone(),modelPose=f.studio.modelGroup.position.clone();
  f.studio._prepareGCode=()=>{f.studio.camera.position.set(99,99,99);throw new Error('historical allocation failure');};
  await assert.rejects(f.studio.loadFiles([new File(['already parsed'],'slice.gcode')],{parsedPrintGCode:parsePrintLayerGCode(code,{includeSupport:true})}),/historical allocation failure/);
  assertOld(f);assert.ok(f.studio.camera.position.equals(position));assert.ok(f.studio.modelGroup.position.equals(modelPose));
});

test('replacement retains calibrated camera, physical mm scale and user scene values',async()=>{
  const f=await fixture(),s=f.studio;
  s.options.modelScale=1.4;s.options.modelOffsetX=.2;s.options.modelOffsetY=.1;s.options.modelRotationZ=.12;
  s.options.surfacePreset='matte';s.options.surfaceDetail=.32;s.options.colorTemperature=7800;s.options.exposure=.76;
  s._fullSourceFov=43;s._cropFullFov=43;
  s.camera.fov=43;s.camera.up.set(.1,1,.03).normalize();s.camera.lookAt(s.controls.target);s.camera.updateProjectionMatrix();
  const before={position:s.camera.position.toArray(),quaternion:s.camera.quaternion.toArray(),projection:s.camera.projectionMatrix.toArray(),target:s.controls.target.toArray(),mm:s.normalized.scale.x/s.metadata.sourceUnitsToMm};
  let fits=0;s.resetCamera=()=>{fits++;};
  const parsed=parsePrintLayerGCode(code,{includeSupport:true}),positions=sha(parsed.positions);
  await s.loadFiles([cadFile()],{parsedPrintGCode:parsed,printerToSource:PRINTER_MM_TO_THREE_MM,preserveScene:true});
  assert.equal(fits,0);
  assert.deepEqual(s.camera.position.toArray(),before.position);assert.deepEqual(s.camera.quaternion.toArray(),before.quaternion);
  assert.deepEqual(s.camera.projectionMatrix.toArray(),before.projection);assert.deepEqual(s.controls.target.toArray(),before.target);
  assert.equal(s.normalized.scale.x/s.metadata.sourceUnitsToMm,before.mm);
  assert.equal(s.options.modelScale,1.4);assert.equal(s.options.surfacePreset,'matte');assert.equal(s.options.exposure,.76);
  assert.equal(s._fullSourceFov,43);assert.equal(sha(parsed.positions),positions);
});

test('explicit new-scene import retains the default camera fit',async()=>{
  const f=await fixture();let fits=0;f.studio.resetCamera=()=>{fits++;};
  await f.studio.loadFiles([cadFile()],{parsedPrintGCode:parsePrintLayerGCode(code,{includeSupport:true}),printerToSource:PRINTER_MM_TO_THREE_MM,preserveScene:false});
  assert.equal(fits,1);
});

test('actual STL import keeps confirmed cm/m units through native-path preparation and atomic adoption',async()=>{
  for(const units of [10,1000]){
    const f=await fixture(),s=f.studio,file=stlFile(),parsed=parsePrintLayerGCode(code,{includeSupport:true});
    const originalBytes=sha(new Uint8Array(await file.arrayBuffer())),pathsHash=sha(parsed.positions);
    const worldPerMm=s.normalized.scale.x/s.metadata.sourceUnitsToMm;
    const mapping=new THREE.Matrix4().fromArray(PRINTER_MM_TO_THREE_MM).multiply(new THREE.Matrix4().makeScale(1/units,1/units,1/units));
    const prepare=s._preparePrintGCode,observed=[];
    s._preparePrintGCode=function(data,options,metadata){
      observed.push({units:metadata.sourceUnitsToMm,confirmed:metadata.sourceUnitsUserConfirmed,inferred:metadata.sourceUnitsInferred});
      return prepare.call(this,data,options,metadata);
    };
    const metadata=await s.loadFiles([file],{sourceUnitMillimetres:units,parsedPrintGCode:parsed,printerToSource:mapping,preserveScene:true});
    assert.deepEqual(observed,[{units,confirmed:true,inferred:true}]);
    assert.equal(metadata.sourceUnitsToMm,units);assert.equal(metadata.sourceUnitsUserConfirmed,true);
    assert.equal(metadata.sourceUnitsInferred,true);assert.equal(metadata.format,'stl');assert.equal(metadata.mode,'mesh');
    assert.equal(metadata.triangles,1);assert.equal(metadata.surfaceTopMode,'sliced-gcode');
    assert.equal(s.getPrintLayerData().parsed,parsed);assert.deepEqual([...s.getPrintLayerData().printerToSource],mapping.elements);
    assert.ok(Math.abs(s.normalized.scale.x/units-worldPerMm)<1e-12);
    assert.equal(sha(parsed.positions),pathsHash);assert.equal(sha(new Uint8Array(await file.arrayBuffer())),originalBytes);
    assert.equal(f.disposed,1);assert.equal(s._modelImportTransaction,null);
  }
});

test('failed STL path preparation and invalid cm/m overrides preserve the old project and all live source buffers',async()=>{
  for(const units of [10,1000,0,-1,2,100,NaN,Infinity,'10',null]){
    const f=await fixture(),s=f.studio,parsed=parsePrintLayerGCode(code,{includeSupport:true});
    const oldGeometry=f.old.geometry,positionHash=sha(oldGeometry.attributes.position.array),normalHash=sha(oldGeometry.attributes.normal.array);
    const oldPathsHash=sha(f.paths.data.positions),camera=s.camera.projectionMatrix.toArray(),transaction=s._modelImportTransaction;
    const prepare=s._preparePrintGCode;let preparedUnits=null,calls=0;
    s._preparePrintGCode=function(data,options,metadata){calls++;preparedUnits=metadata.sourceUnitsToMm;return prepare.call(this,data,options,metadata);};
    s._buildIndexedSupports=()=>{throw new Error('STL support allocation failed');};
    const valid=[10,1000].includes(units);
    await assert.rejects(s.loadFiles([stlFile()],{sourceUnitMillimetres:units,parsedPrintGCode:parsed,printerToSource:PRINTER_MM_TO_THREE_MM,preserveScene:true}),valid?/STL support allocation failed/:/请选择毫米、厘米或米/);
    assert.equal(calls,valid?1:0);if(valid)assert.equal(preparedUnits,units);
    assertOld(f);assert.equal(f.old.geometry,oldGeometry);
    assert.equal(sha(oldGeometry.attributes.position.array),positionHash);assert.equal(sha(oldGeometry.attributes.normal.array),normalHash);
    assert.equal(sha(f.paths.data.positions),oldPathsHash);assert.deepEqual(s.camera.projectionMatrix.toArray(),camera);
    assert.equal(s.metadata.sourceUnitsToMm,1);assert.equal(s._modelImportTransaction,transaction);
  }
});

test('path-only source uses compact lit surfaces and reuses GPU attributes when material/color choices change',async()=>{
  const f=await fixture(),s=f.studio,parsed=parsePrintLayerGCode(code,{includeSupport:true});
  const original=sha(parsed.positions);
  await s.loadFiles([new File(['already parsed'],'slice.gcode')],{parsedPrintGCode:parsed,preserveScene:true});
  assert.equal(s.metadata.historicalPathSurface,'analytic-pbr-extrusion');
  const mesh=s._meshes[0],geometry=mesh.geometry;
  assert.equal(geometry.index.count,6);assert.equal(mesh.material.isMeshStandardMaterial,true);
  assert.ok(mesh.customDepthMaterial.userData.printPathImpostor);assert.equal(s._gcodeShadow,null);
  const endpoints=geometry.getAttribute('instanceStart'),colors=geometry.getAttribute('instanceColorStart'),roughness=geometry.getAttribute('instancePrintRoughness');
  s.options.surfacePreset='matte';s._prepareIndexedGCode();
  assert.equal(mesh.geometry,geometry);assert.equal(geometry.getAttribute('instanceStart'),endpoints);
  assert.equal(geometry.getAttribute('instanceColorStart'),colors);assert.equal(geometry.getAttribute('instancePrintRoughness'),roughness);
  assert.ok(Math.abs(roughness.array[0]-.88)<1e-6);
  s.options.toolColors={1:'#ff0000'};s._prepareIndexedGCode();
  assert.equal(geometry.getAttribute('instanceColorStart'),colors);
  assert.deepEqual([...colors.data.array.slice(6,9)],[1,0,0]);
  assert.equal(sha(parsed.positions),original);
});

const thirtyMillimetreStl=()=>new File([`solid reference30
facet normal 0 -0.70710678 0.70710678
outer loop
vertex 0 0 0
vertex 30 0 0
vertex 0 30 30
endloop
endfacet
endsolid reference30
`],'reference30.stl',{type:'model/stl'});
const sourceWorldPoints=studio=>{
  studio.scene.updateMatrixWorld(true);
  const mesh=studio._meshes[0],positions=mesh.geometry.attributes.position;
  return Array.from({length:positions.count},(_,index)=>new THREE.Vector3().fromBufferAttribute(positions,index).applyMatrix4(mesh.matrixWorld));
};
const projectedSourcePoints=studio=>{
  studio.camera.updateMatrixWorld(true);
  return sourceWorldPoints(studio).map(point=>point.project(studio.camera).toArray());
};
const cameraValues=studio=>({position:studio.camera.position.toArray(),quaternion:studio.camera.quaternion.toArray(),up:studio.camera.up.toArray(),
  target:studio.controls.target.toArray(),projection:studio.camera.projectionMatrix.toArray(),fov:studio.camera.fov});

test('source scene metric restores a differently sized replacement to the same saved projection after a fresh reimport',async()=>{
  const before=await fixture(),s=before.studio,parsed=parsePrintLayerGCode(code,{includeSupport:true}),file=thirtyMillimetreStl();
  assert.equal(s.sourceMillimetresToWorld,.4,'the preceding 20 mm model normalizes into 8 world units');
  const pose={modelScale:.55,modelOffsetX:.31,modelOffsetY:.02,modelOffsetZ:-.18,modelRotationX:.13,modelRotationY:-.4,modelRotationZ:.02};
  Object.assign(s.options,pose);s.camera.up.set(.12,1,.02).normalize();s.camera.lookAt(s.controls.target);s.camera.updateProjectionMatrix();
  await s.loadFiles([file],{parsedPrintGCode:parsed,printerToSource:PRINTER_MM_TO_THREE_MM,preserveScene:true});
  assert.ok(Math.abs(s.sourceMillimetresToWorld-.4)<1e-12,'replacement retains the 20 mm scene metric');
  s.render(1);
  const expected=projectedSourcePoints(s),savedCamera=cameraValues(s),savedMetric=s.sourceMillimetresToWorld;
  const fresh=await fixture(),r=fresh.studio;
  await r.loadFiles([file],{parsedPrintGCode:parsed,printerToSource:PRINTER_MM_TO_THREE_MM,preserveScene:false});
  assert.ok(Math.abs(r.sourceMillimetresToWorld-8/30)<1e-12,'a new session starts from the 30 mm normalization baseline');
  Object.assign(r.options,pose);r.camera.copy(s.camera,false);r.controls.target.copy(s.controls.target);r.render(1);
  const wrong=projectedSourcePoints(r);
  assert.ok(wrong.some((point,index)=>point.some((value,axis)=>Math.abs(value-expected[index][axis])>.02)),'pose and camera alone cannot preserve the saved composition');
  const geometry=r._meshes[0].geometry,sourceHash=sha(geometry.attributes.position.array),pathHash=sha(parsed.positions);
  const bytesHash=sha(new Uint8Array(await file.arrayBuffer()));
  const supportBounds=r._indexedSupports.originalBounds.clone(),freshBounds=r._baseBounds.clone(),freshHeight=r._baseHeight;
  const worldCameraBefore=cameraValues(r);
  r.beginSceneUpdate();
  try{assert.equal(r.restoreSourceSceneScale(savedMetric),true);assert.equal(r._renderPending,true,'metric restoration computes inside the presentation batch');}
  finally{r.endSceneUpdate();}
  const actual=projectedSourcePoints(r);
  for(let index=0;index<actual.length;index++)for(let axis=0;axis<3;axis++)assert.ok(Math.abs(actual[index][axis]-expected[index][axis])<1e-10,'every original vertex retains its saved projection');
  assert.deepEqual(cameraValues(r),worldCameraBefore);assert.deepEqual(cameraValues(r),savedCamera,'the world-space camera is never rescaled');
  assert.deepEqual(Object.fromEntries(Object.keys(pose).map(key=>[key,r.options[key]])),pose,'saved XYZ offsets, rotation and display size remain independent');
  assert.ok(r._baseBounds.min.distanceTo(freshBounds.min.multiplyScalar(1.5))<1e-12);assert.ok(r._baseBounds.max.distanceTo(freshBounds.max.multiplyScalar(1.5))<1e-12);
  assert.ok(Math.abs(r._baseHeight-freshHeight*1.5)<1e-12);
  assert.ok(r._indexedSupports.originalBounds.min.distanceTo(supportBounds.min.multiplyScalar(1.5))<1e-12);
  assert.ok(r._indexedSupports.originalBounds.max.distanceTo(supportBounds.max.multiplyScalar(1.5))<1e-12);
  assert.equal(sha(geometry.attributes.position.array),sourceHash);assert.equal(sha(parsed.positions),pathHash);assert.equal(sha(new Uint8Array(await file.arrayBuffer())),bytesHash);
});

test('source metric restoration scales both support focus bounds, handles shared bounds once, and rejects invalid requests without changes',()=>{
  const s=Object.create(GrowthStudio.prototype),shared=new THREE.Box3(new THREE.Vector3(-4,0,-4),new THREE.Vector3(4,8,4));
  s.normalized=new THREE.Group();s.normalized.scale.setScalar(.4);s.normalized.position.set(-4,-2,3);
  s._metadata={sourceUnitsToMm:1};s.options={progress:.6,modelScale:1.3};s._turnRadians=.2;s._baseBounds=shared;s._baseHeight=8;
  s._indexedSupports={originalBounds:shared};s._supportOverlay={originalBounds:new THREE.Box3(new THREE.Vector3(-2,0,-1),new THREE.Vector3(3,7,2))};
  let renders=0;s.render=()=>{renders++;};
  const boxValues=box=>[...box.min.toArray(),...box.max.toArray()];
  const state=()=>({scale:s.normalized.scale.toArray(),position:s.normalized.position.toArray(),base:boxValues(s._baseBounds),height:s._baseHeight,
    support:boxValues(s._supportOverlay.originalBounds),options:structuredClone(s.options)});
  const before=state();
  for(const input of [NaN,Infinity,-Infinity,0,-1,null,undefined,'0.8',{},1e308]){
    assert.equal(s.restoreSourceSceneScale(input),false);assert.deepEqual(state(),before);assert.equal(renders,0);
  }
  assert.equal(s.restoreSourceSceneScale(.8),true);assert.equal(renders,1);assert.equal(s.sourceMillimetresToWorld,.8);
  assert.deepEqual(s.normalized.scale.toArray(),[.8,.8,.8]);assert.deepEqual(s.normalized.position.toArray(),[-8,-4,6]);assert.equal(s._baseHeight,16);
  assert.deepEqual(boxValues(s._baseBounds),[-8,0,-8,8,16,8],'shared bounds are scaled once');
  assert.deepEqual(boxValues(s._supportOverlay.originalBounds),[-4,0,-2,6,14,4]);assert.deepEqual(s.options,before.options);
  delete s._metadata;const restored=state();assert.equal(s.restoreSourceSceneScale(.4),false);assert.deepEqual(state(),restored);assert.equal(renders,1);
});
