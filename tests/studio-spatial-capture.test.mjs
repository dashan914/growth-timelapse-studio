import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { GrowthStudio } from '../src/studio.js';

function fixture({ failure = false, cancelAfter = 0 } = {}) {
  const controller = new AbortController();
  const studio = Object.create(GrowthStudio.prototype);
  const outputs = [], rays = [], width = 16, height = 16;
  const source = new Uint8ClampedArray(width * height * 4).fill(255);
  const document = { createElement() {
    const canvas = { width:0,height:0, toBlob(callback) { callback(new Blob([canvas.image?.data || source])); } };
    canvas.getContext = () => ({ clearRect(){},drawImage(){},getImageData(){return {data:source.slice()};},
      createImageData(w,h){return {data:new Uint8ClampedArray(w*h*4)};},putImageData(image){canvas.image=image;outputs.push(image.data.slice());} });
    return canvas;
  } };
  const canvas = { width,height,ownerDocument:document,toBlob:callback=>callback(new Blob([source])) };
  studio.camera = new THREE.PerspectiveCamera(44,1,.05,1000);
  studio.camera.setViewOffset(4/3,1,.1,.2,.7,.65);
  studio.options = { supportDisplay:'solid' };
  studio._exportState = {};
  studio._indexedSupports = { root:{visible:true} };
  studio.renderer = { shadowMap:{autoUpdate:true},domElement:canvas,
    getSize:target=>target.set(width,height),getPixelRatio:()=>1 };
  studio._seekBackground = async time => { studio.seekTime=time; };
  studio.render = (progress,rotation) => { studio.frame=[progress,rotation]; };
  studio._drawScene = () => {
    rays.push(studio.camera.projectionMatrix.toArray());
    if (failure && rays.length===2) throw new Error('GPU failure');
    if (cancelAfter===rays.length) controller.abort();
  };
  return { studio,controller,rays,outputs,source };
}

test('support capture samples one fixed growth/video time, keeps cropped focal projection, encodes final dimensions once', async()=>{
  const {studio,rays,outputs,source}=fixture();
  const before=studio.camera.projectionMatrix.toArray(), inverse=studio.camera.projectionMatrixInverse.toArray(), view={...studio.camera.view};
  const blob=await studio.captureFrame(.5,.2,3,{outputPlan:{width:8,height:8,renderWidth:16,renderHeight:16,scale:2}});
  assert.equal(rays.length,8); assert.deepEqual(studio.frame,[.5,.2]);assert.equal(studio.seekTime,3);
  assert.equal(outputs.length,1);assert.equal(outputs[0].length,8*8*4);assert.ok(outputs[0].every(v=>v===255));
  assert.ok(blob.size>0);assert.deepEqual(studio.camera.projectionMatrix.toArray(),before);
  assert.deepEqual(studio.camera.projectionMatrixInverse.toArray(),inverse);assert.deepEqual(studio.camera.view,view);
  assert.equal(studio.renderer.shadowMap.autoUpdate,true);assert.equal(studio._exportState.spatial.accumulator.count,0);
  for(const ray of rays) for(const index of [0,5,10,11,14,15]) assert.equal(ray[index],before[index]);
  const first=rays.map(ray=>[ray[8],ray[9]]);rays.length=0;
  await studio.captureFrame(.75,.2,4,{outputPlan:{width:8,height:8,renderWidth:16,renderHeight:16,scale:2}});
  assert.deepEqual(rays.map(ray=>[ray[8],ray[9]]),first,'no frame-index jitter/history');assert.ok(source.every(v=>v===255));
});

for (const scenario of [{failure:true},{cancelAfter:2}]) test(`failed/cancelled support frame restores both projections and shadow state without emitting partial coverage ${JSON.stringify(scenario)}`,async()=>{
  const {studio,controller,outputs}=fixture(scenario);
  const before=studio.camera.projectionMatrix.toArray(),inverse=studio.camera.projectionMatrixInverse.toArray();
  await assert.rejects(studio.captureFrame(.5,0,0,{signal:controller.signal}),scenario.failure?/GPU failure/:{name:'AbortError'});
  assert.deepEqual(studio.camera.projectionMatrix.toArray(),before);assert.deepEqual(studio.camera.projectionMatrixInverse.toArray(),inverse);
  assert.equal(studio.renderer.shadowMap.autoUpdate,true);assert.equal(outputs.length,0);assert.equal(studio._exportState.spatial.accumulator.count,0);
});

test('path view and hidden supports do not trigger extra spatial draws; mismatched framing fails explicitly',async()=>{
  for(const variant of ['paths','hidden']) {
    const {studio,rays}=fixture();if(variant==='paths')studio.options.supportDisplay='paths';else studio._indexedSupports.root.visible=false;
    await studio.captureFrame(1);assert.equal(rays.length,0);
  }
  const {studio}=fixture();await assert.rejects(studio.captureFrame(1,0,0,{outputPlan:{width:8,height:8,renderWidth:32,renderHeight:16,scale:2}}),/尺寸/);
});
