import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import * as THREE from 'three';
import {LineSegmentsGeometry} from 'three/addons/lines/LineSegmentsGeometry.js';
import {createPrintPathGeometry,createPrintPathDisplayGeometry,createPrintPathMaterial,createPrintPathDepthMaterial,createPrintPathPreviewGeometries,setPrintPathPreviewCount,refreshPrintPathDisplayAttributes} from '../src/print-path-material.js';
import {DisplaySurfaceController} from '../src/display-surface-controller.js';

const digest = array => createHash('sha256').update(new Uint8Array(array.buffer,array.byteOffset,array.byteLength)).digest('hex');
function fixture(){
  const roles=new Uint8Array([1,2,3,4,5,6,7,8,10,11,16,1]),count=roles.length,positions=new Float32Array(count*6),colors=new Float32Array(count*6),heights=new Float32Array(count).fill(.16),widths=new Float32Array(count).fill(.42);
  for(let i=0;i<count;i++){positions.set([i,0,.08,i+1,0,.08],i*6);colors.set([i/count,.2,.3,i/count,.2,.3],i*6);}
  const line=new LineSegmentsGeometry().setPositions(positions).setColors(colors);line.setAttribute('instancePrintWidth',new THREE.InstancedBufferAttribute(widths,1));
  const full=createPrintPathGeometry(line,{heights,features:roles});
  full.boundingBox=new THREE.Box3(new THREE.Vector3(0,0,0),new THREE.Vector3(count,1,1));full.boundingSphere=full.boundingBox.getBoundingSphere(new THREE.Sphere());
  const order=new Uint32Array([10,4,1,7,3,11,9,5,6,0,8,2]),mask=new Uint8Array(count);mask[10]=1;
  return{full,order,mask,fallback:new Uint32Array([8])};
}

test('bounded display maps parsed IDs to sorted GPU instances and keeps all tops, bridges, gaps and support attributes exact',()=>{
  const f=fixture(),snapshots=new Map(Object.entries(f.full.attributes).map(([name,a])=>[name,digest(a.data?.array||a.array)]));
  const cache=createPrintPathDisplayGeometry(f.full,{sourceOrder:f.order,coveredSegmentMask:f.mask,fallbackSourceIndices:f.fallback});
  assert.deepEqual([...cache.sourceIndices],[4,5,6,7,8,9,11], 'only covered outer 0, fallback overhang 10 and buried instances 1..3 disappear');
  for(const[name,a]of Object.entries(cache.attributes))if(a.isInstancedBufferAttribute||a.data?.isInstancedInterleavedBuffer){const source=f.full.getAttribute(name);for(const[i,id]of cache.sourceIndices.entries())for(let component=0;component<a.itemSize;component++)assert.equal(a.getComponent(i,component),source.getComponent(id,component));}
  for(let prefix=0;prefix<=f.order.length;prefix++)assert.equal(setPrintPathPreviewCount(cache,prefix),[4,5,6,7,8,9,11].filter(id=>id<prefix).length);
  for(const[name,a]of Object.entries(f.full.attributes))assert.equal(digest(a.data?.array||a.array),snapshots.get(name));
  assert.equal(digest(f.order),digest(new Uint32Array([10,4,1,7,3,11,9,5,6,0,8,2])));assert.equal(f.mask[10],1);
  const color=f.full.getAttribute('instanceColorStart');color.setXYZ(4,.91,.82,.73);color.data.needsUpdate=true;
  assert.equal(refreshPrintPathDisplayAttributes(cache,f.full),1);assert.equal(cache.getAttribute('instanceColorStart').getX(0),color.getX(4));assert.equal(refreshPrintPathDisplayAttributes(cache,f.full),0);
  cache.dispose();assert.equal(f.full.getAttribute('instanceStart').count,12);
  assert.throws(()=>createPrintPathDisplayGeometry(f.full,{sourceOrder:new Uint32Array([99]),coveredSegmentMask:f.mask}),/索引映射/);
});

function controllerFixture(){
  const f=fixture(),source=new THREE.Mesh(f.full,createPrintPathMaterial());source.customDepthMaterial=createPrintPathDepthMaterial();source.castShadow=source.receiveShadow=true;
  const scene=new THREE.Scene(),orientation=new THREE.Group();scene.add(orientation);orientation.add(source);
  source.userData.printPathPreview=createPrintPathPreviewGeometries(f.full);
  const studio={scene,orientation,camera:new THREE.PerspectiveCamera(),_gcodeOrder:f.order,_printMatrix:new THREE.Matrix4(),options:{showSupports:true,progress:1,color:'#ffffff'},metadata:{materialProfiles:[]},renderer:{getSize:v=>v.set(800,600),capabilities:{getMaxAnisotropy:()=>8}},_prepareModelTone:m=>m,_surfaceOptions:()=>({})};
  const packet={geometry:new THREE.PlaneGeometry(1,1),tools:[0],stats:{maxDeviationMm:.08},coveredSegmentMask:f.mask,fallbackSourceIndices:f.fallback};
  const parsed={layerHeights:new Float32Array([.16,.32,.48,.64]),toolColors:['#ffffff']};
  const printLayers={printerToSource:new THREE.Matrix4(),palette:['#ffffff'],historyLayers:1,state:{visibleLayerCount:4,layerIndex:3,empty:false},meshes:new Map()};
  const controller=new DisplaySurfaceController(studio,packet,parsed,source,printLayers);controller._error=()=>.25;
  return{...f,source,studio,controller};
}

test('beauty cache leaves source shadow/depth counts intact and restores source, borrowed support and resources after each render',()=>{
  const f=controllerFixture(),support=f.source.userData.printPathPreview.support,originalSupportCount=support.instanceCount;
  f.full.instanceCount=10;const finish=f.controller.begin(),draw=f.source.userData.printPathDisplayActive;
  assert.ok(draw);assert.equal(draw.sourcePrefixCount,10);assert.equal(draw.geometry.instanceCount,4);assert.equal(draw.supportGeometry.instanceCount,2);
  assert.equal(draw.mesh.castShadow,false);assert.equal(draw.supportMesh.castShadow,false);assert.equal(f.source.castShadow,true);assert.ok(f.controller.meshes.every(mesh=>mesh.castShadow===false));
  assert.equal(f.source.customDepthMaterial.userData.printPathImpostor.uniforms.pathMacroSurface.value,0,'shadow material must not suppress original outer/interior roads');
  assert.equal(f.full.instanceCount,10,'full source is available during shadow rendering');
  f.source.onBeforeRender(null,f.studio.scene,null,f.full,f.source.material,null);assert.equal(f.full.instanceCount,0,'only main beauty draw is suppressed');
  f.source.onAfterRender();assert.equal(f.full.instanceCount,10);
  f.studio.scene.overrideMaterial=new THREE.MeshBasicMaterial();f.source.onBeforeRender(null,f.studio.scene,null,f.full,f.source.material,null);assert.equal(f.full.instanceCount,10,'numerical override sees full source');f.source.onAfterRender();f.studio.scene.overrideMaterial=null;
  f.source.onBeforeRender(null,f.studio.scene,null,f.full,f.source.material,null);assert.equal(f.full.instanceCount,0);finish();
  assert.equal(f.full.instanceCount,10,'finish also restores after an interrupted shader draw');assert.equal(support.instanceCount,originalSupportCount);assert.equal(f.source.userData.printPathDisplayActive,undefined);assert.equal(draw.mesh.parent,null);assert.equal(draw.supportMesh.parent,null);
  f.controller._error=()=>.51;const nearFinish=f.controller.begin();assert.equal(f.source.userData.printPathDisplayActive,undefined);assert.equal(f.full.instanceCount,10);nearFinish();
  f.controller._error=()=>.25;f.controller.setVariant('source');const sourceFinish=f.controller.begin();assert.equal(f.source.userData.printPathDisplayActive,undefined);sourceFinish();
  f.controller.dispose();assert.equal(f.full.getAttribute('instanceStart').count,12);assert.equal(support.userData.printPathPreview.disposed,false,'borrowed interaction resources remain owned by studio');
});
