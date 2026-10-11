import test from 'node:test';
import assert from 'node:assert/strict';
import { modelSourceUnits, millimetresToWorld } from '../src/model-units.js';
import { contactShadowNormalBias } from '../src/photo-shadow.js';
import { GrowthStudio } from '../src/studio.js';
import * as THREE from 'three';

test('declared glTF and FBX units retain equal physical lengths in photo calibration and shadow bias', () => {
  for (const [format, factor, length, expected] of [['glb',null,.12,1000],['fbx',1,12,10],['fbx',.1,120,1],['fbx',100,.12,1000]]) {
    const units=modelSourceUnits(format,{userData:{unitScaleFactor:factor}});
    assert.equal(units.sourceUnitsToMm,expected); assert.equal(units.sourceUnitsInferred,false);
    const mmWorld=millimetresToWorld(8/length,units.sourceUnitsToMm);
    assert.ok(Math.abs(mmWorld-8/120)<1e-12);
    assert.ok(Math.abs(contactShadowNormalBias(mmWorld)-.08*8/120)<1e-12);
  }
});

test('unknown mesh units remain estimates and invalid dimensions do not become silent geometry edits', () => {
  for(const format of ['fbx','obj','stl']) assert.deepEqual(modelSourceUnits(format),{sourceUnitsToMm:1,sourceUnitsInferred:true});
  assert.deepEqual(modelSourceUnits('3mf'),{sourceUnitsToMm:1,sourceUnitsInferred:false});
  for(const value of [0,-1,Infinity,NaN]) assert.throws(()=>millimetresToWorld(value,1),/单位无效/);
});

test('manual mesh-unit correction invalidates stale slicing without changing original geometry or pose',()=>{
  const studio=Object.create(GrowthStudio.prototype),geometry=new THREE.BoxGeometry(.1,.2,.3),before=geometry.attributes.position.array.slice();
  studio._metadata={sourceUnitsInferred:true,sourceUnitsToMm:1,triangles:12,printLayer:{layers:1},sliceSettings:{wallLoops:2},supportSource:'sliced-gcode-indexed',supportSegments:100};
  let disposed=0;studio._printLayers={dispose:()=>disposed++};studio._supportMeshes=new Set();
  studio._clearIndexedSupports=()=>{};studio._updateFDMSurfaces=()=>{};studio.options={progress:1};studio.render=()=>{};studio._turnRadians=0;
  studio.setSourceUnitMillimetres(1000);
  assert.equal(studio.metadata.sourceUnitsToMm,1000);assert.equal(studio.metadata.sourceUnitsUserConfirmed,true);assert.equal(disposed,1);
  assert.equal(studio.metadata.printLayer,undefined);assert.equal(studio.metadata.supportSource,undefined);
  assert.deepEqual(geometry.attributes.position.array,before);assert.equal(studio.metadata.triangles,12);
  assert.throws(()=>studio.setSourceUnitMillimetres(100),/毫米/);
  studio.metadata.sourceUnitsInferred=false;assert.throws(()=>studio.setSourceUnitMillimetres(10),/已声明/);
});
