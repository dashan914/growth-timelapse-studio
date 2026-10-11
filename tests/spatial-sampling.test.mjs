import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {fixedPixelJitterPattern,composePixelJitterView,pixelJitterProjection,pixelSamplingPlan,LinearPixelCoverageAccumulator} from '../src/spatial-sampling.js';

test('fixed layouts repeat exactly across growth frames, remain centered, and fit one render pixel',()=>{
  for(const count of [4,8,16,32]){
    const first=fixedPixelJitterPattern(count),next=fixedPixelJitterPattern(count);
    assert.deepEqual(first,next);assert.equal(first.length,count);
    assert.equal(first.reduce((sum,value)=>sum+value.x,0),0);assert.equal(first.reduce((sum,value)=>sum+value.y,0),0);
    assert.equal(first.reduce((sum,value)=>sum+value.weight,0),1);assert.ok(first.every(value=>Math.abs(value.x)<.5&&Math.abs(value.y)<.5));
  }
  assert.throws(()=>fixedPixelJitterPattern(7));
});

test('normalized off-center source views and direct projection hooks give the same subpixel rays without changing framing/focal terms',()=>{
  const camera=new THREE.PerspectiveCamera(48,4/3,.1,100);camera.setViewOffset(4/3,1,.2*4/3,.1,.5*4/3,.5);
  const sourceView={...camera.view},sourceProjection=camera.projectionMatrix.toArray();const point=new THREE.Vector3(.3,.2,-2);
  const before=point.clone().applyMatrix4(camera.projectionMatrix);const beforePixel=[(before.x+1)*960/2,(1-before.y)*720/2];
  for(const jitter of fixedPixelJitterPattern(4)){
    const changed=composePixelJitterView(sourceView,960,720,jitter),copy=camera.clone();copy.setViewOffset(changed.fullWidth,changed.fullHeight,changed.offsetX,changed.offsetY,changed.width,changed.height);
    const direct=pixelJitterProjection(sourceProjection,960,720,jitter);
    for(let index=0;index<16;index++)assert.ok(Math.abs(copy.projectionMatrix.elements[index]-direct[index])<1e-12);
    for(const index of [0,5,10,11,14,15])assert.equal(direct[index],sourceProjection[index]);
    const after=point.clone().applyMatrix4(new THREE.Matrix4().fromArray(direct)),pixel=[(after.x+1)*960/2,(1-after.y)*720/2];
    assert.ok(Math.abs(pixel[0]-beforePixel[0]+jitter.x)<1e-10);assert.ok(Math.abs(pixel[1]-beforePixel[1]+jitter.y)<1e-10);
  }
  assert.deepEqual(camera.view,sourceView);assert.deepEqual(camera.projectionMatrix.toArray(),sourceProjection);
});

test('two-times four-pass sampling has16 nominal colors without a four-times source buffer or frame history',()=>{
  const plan=pixelSamplingPlan(1440,1080);assert.equal(plan.nominalColorSamplesPerFinalPixel,16);assert.equal(plan.renderWidth*plan.renderHeight,6220800);assert.equal(plan.passes,4);assert.equal(plan.temporalHistory,false);
  assert.throws(()=>pixelSamplingPlan(1440,1080,{scale:4}),/budget/);
  assert.throws(()=>pixelSamplingPlan(1440,1080,{scale:4,maxSourcePixels:25_000_000}),/budget/,'caller cannot bypass the8Mi source limit');
});

test('linear coverage accumulation retains isolated edge colors, transparent hidden colors and fixed opaque photo pixels',()=>{
  const accumulator=new LinearPixelCoverageAccumulator(pixelSamplingPlan(1,1,{scale:1,passes:4}));
  for(const pixel of [[255,0,0,255],[0,0,255,0],[0,255,0,0],[255,255,255,0]])accumulator.addSample(Uint8Array.from(pixel));
  assert.deepEqual([...accumulator.finish().data],[255,0,0,64]);accumulator.reset();
  const source=Uint8Array.from([235,183,64,255]),before=source.slice();for(let index=0;index<4;index++)accumulator.addSample(source);
  assert.deepEqual([...accumulator.finish().data],[235,183,64,255]);assert.deepEqual(source,before);
  assert.throws(()=>accumulator.finish(source),/immutable/);
  accumulator.reset();for(const pixel of [[0,0,0,255],[255,255,255,255],[255,255,255,255],[0,0,0,255]])accumulator.addSample(Uint8Array.from(pixel));
  assert.deepEqual([...accumulator.finish().data],[188,188,188,255]);
  assert.throws(()=>accumulator.addSample(source),/reset/);
});

test('complete source dimensions are mandatory and cancellation cannot emit partial or previous-frame coverage',()=>{
  const plan=pixelSamplingPlan(2,2),a=new LinearPixelCoverageAccumulator(plan);assert.throws(()=>a.addSample(new Uint8Array(4*4*4),3,4),/framing/);
  assert.throws(()=>a.addSample(new Uint8Array(1)),/Complete/);a.addSample(new Uint8Array(4*4*4));assert.throws(()=>a.finish(),/Incomplete/);
  a.reset();assert.equal(a.count,0);assert.equal(a.sums.some(value=>value!==0),false);assert.throws(()=>a.finish(),/Incomplete/);
});
