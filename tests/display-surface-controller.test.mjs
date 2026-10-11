import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {LineSegmentsGeometry} from 'three/addons/lines/LineSegmentsGeometry.js';
import {DisplaySurfaceController} from '../src/display-surface-controller.js';
import {buildPrintSurfaceLOD,packPrintSurfaceLOD} from '../src/print-surface-lod.js';
import {parsePrintLayerGCode,PRINTER_MM_TO_THREE_MM} from '../src/print-layer.js';
import {PrintLayerRenderer} from '../src/print-layer-renderer.js';
import {createPrintPathGeometry,createPrintPathMaterial,createPrintPathDepthMaterial} from '../src/print-path-material.js';
import {GrowthStudio} from '../src/studio.js';

async function fixture(){
  const lines=[';filament_colour=#efeadb','G21','G90','M82'];let e=0;
  for(let layer=1;layer<=8;layer++){lines.push(';LAYER_CHANGE',';TYPE:Outer wall',';WIDTH:0.42',';HEIGHT:0.16',`G0 X0 Y0 Z${layer*.16}`);for(const[x,y]of[[10,0],[10,10],[0,10],[0,0]])lines.push(`G1 X${x} Y${y} E${++e}`);}
  const parsed=parsePrintLayerGCode(lines.join('\n')),data=await buildPrintSurfaceLOD(parsed,{useMeshoptimizer:false});
  const orientation=new THREE.Group(),scene=new THREE.Scene();scene.add(orientation);
  const order=Uint32Array.from(parsed.layerSegments),positions=new Float32Array(order.length*6),widths=new Float32Array(order.length),heights=new Float32Array(order.length),features=new Uint8Array(order.length);
  for(const[index,id]of order.entries()){
    positions.set(parsed.positions.subarray(id*6,id*6+6),index*6);positions[index*6+2]-=parsed.heights[id]*.5;positions[index*6+5]-=parsed.heights[id]*.5;
    widths[index]=parsed.widths[id];heights[index]=parsed.heights[id];features[index]=parsed.features[id];
  }
  const roads=new LineSegmentsGeometry().setPositions(positions);roads.setAttribute('instancePrintWidth',new THREE.InstancedBufferAttribute(widths,1));
  const geometry=createPrintPathGeometry(roads,{heights,features});geometry.boundingBox=new THREE.Box3(new THREE.Vector3(-.21,-.21,0),new THREE.Vector3(10.21,10.21,parsed.layerHeights.at(-1)));geometry.boundingSphere=geometry.boundingBox.getBoundingSphere(new THREE.Sphere());
  // Production draws only historical roads here. The recent three layers are
  // owned by PrintLayerRenderer, and the mask addresses original parsed IDs.
  geometry.instanceCount=parsed.layerOffsets[parsed.layerHeights.length-3];
  const source=new THREE.Mesh(geometry,createPrintPathMaterial());source.customDepthMaterial=createPrintPathDepthMaterial();source.rotation.x=-Math.PI/2;orientation.add(source);
  const print=new PrintLayerRenderer(parsed,{printerToSource:PRINTER_MM_TO_THREE_MM});print.update(1,{keepCompleteLayers:true});orientation.add(print.root);
  const camera=new THREE.PerspectiveCamera(40,1,.05,1000);camera.position.set(30,30,30);camera.lookAt(5,1,-5);camera.updateMatrixWorld();
  const options={progress:1,preserveMaterials:true,color:'#ffffff',toolColors:{},surfacePreset:'auto',surfaceDetail:.6,layerLines:true,showSupports:false};
  const studio={orientation,scene,camera,options,_gcodeOrder:order,metadata:{materialProfiles:[],layerHeightMm:.16},renderer:{getSize:target=>target.set(128,128)},_printMatrix:new THREE.Matrix4(),_surfaceOptions:tool=>({layerHeightMm:.16,lineWidthMm:.42,tool}),_prepareModelTone:material=>material};
  const controller=new DisplaySurfaceController(studio,packPrintSurfaceLOD(data),parsed,source,print);
  return {studio,controller,parsed,source,print,data};
}

test('production surface scope follows actual source transforms/history, uses screen error and restores source state',async()=>{
  const{studio,controller,source,parsed}=await fixture(),geometry=source.geometry,count=geometry.index.count;
  const finish=controller.begin();assert.equal(controller.status.active,true);assert.equal(controller.root.visible,true);
  assert.ok(source.userData.printPathDisplayActive);
  assert.equal(source.userData.printPathDisplayActive.sourcePrefixCount,20);
  assert.equal(source.userData.printPathDisplayActive.geometry.instanceCount,0,'all twenty historical outer roads are represented by the bounded skin');
  assert.equal(source.material.userData.printPathImpostor.uniforms.pathMacroSurface.value,0);
  assert.equal(source.customDepthMaterial.userData.printPathImpostor.uniforms.pathMacroSurface.value,0,'original depth/shadow paths remain complete');
  const worldPoint=new THREE.Vector3(0,0,parsed.layerHeights[4]).applyMatrix4(source.matrixWorld);
  assert.ok(Math.abs(controller.skinClipPlane.distanceToPoint(worldPoint))<1e-6,'historical clip ends at layer5, recent3 remain actual source');
  finish();assert.equal(controller.root.visible,false);assert.equal(source.material.userData.printPathImpostor.uniforms.pathMacroSurface.value,0);assert.equal(source.geometry,geometry);assert.equal(geometry.index.count,count);
  controller.setVariant('source');const restore=controller.begin();assert.equal(controller.status.active,false);restore();
  controller.setVariant('auto');studio._displayOutputSize={width:100000,height:100000};const near=controller.begin();assert.equal(controller.status.active,false,'large final output rejects too-coarse display');near();
  controller.dispose();assert.equal(source.geometry,geometry);assert.ok(source.parent,'source model survives display disposal');
});

test('appearance updates share scene profile/color and environment without touching source geometry',async()=>{
  const{studio,controller,source}=await fixture(),positions=source.geometry.attributes.position.array.slice();
  studio.options.toolColors={0:'#235599'};controller.updateAppearance();assert.equal(controller.materials[0].color.getHexString(),'235599');
  studio.options.preserveMaterials=false;studio.options.color='#aa4422';controller.updateAppearance();assert.equal(controller.materials[0].color.getHexString(),'aa4422');
  const texture=new THREE.Texture();studio._environmentTexture=texture;controller.applyEnvironment();assert.equal(controller.materials[0].envMap,texture);
  assert.deepEqual(source.geometry.attributes.position.array,positions);controller.dispose();
});

test('GrowthStudio draw wrapper restores display uniforms even when a renderer/postprocess throws',()=>{
  let restored=0;const fake={_displaySurfaceController:{begin:()=>()=>restored++},_drawSceneWithSurface:()=>{throw new Error('GPU failed');}};
  assert.throws(()=>GrowthStudio.prototype._drawScene.call(fake),/GPU failed/);assert.equal(restored,1);
});

test('capture gate uses final output size and restores it after any asynchronous failure',async()=>{
  const old={width:640,height:480},plan={width:1440,height:1080},fake={_displayOutputSize:old,renderer:{getSize:target=>target.set(2880,2160)},_captureFrameAtDisplaySize:async function(){assert.deepEqual(this._displayOutputSize,plan);throw new Error('cancelled');}};
  await assert.rejects(GrowthStudio.prototype.captureFrame.call(fake,.5,0,0,{outputPlan:plan}),/cancelled/);assert.equal(fake._displayOutputSize,old);
});
