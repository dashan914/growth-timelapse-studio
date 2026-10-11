import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {fitPhotographicModelPose} from '../src/photography-placement.js';

const profile = {yawDeg:45, centerX:.5, footY:.86, maxHeight:.54, maxWidth:.74};
function cameraFor({aspect=.75, pitch=21, yaw=0, distance=32, fov=30, roll=0} = {}) {
  const camera = new THREE.PerspectiveCamera(fov, aspect, .005, 10000);
  const angle = pitch * Math.PI / 180, heading = yaw * Math.PI / 180;
  const q = (.83 - .5) * 2 * Math.tan(fov * Math.PI / 360);
  const targetHeight = q * distance / (Math.cos(angle) - q * Math.sin(angle));
  camera.position.set(Math.sin(heading) * Math.cos(angle) * distance,
    Math.sin(angle) * distance + targetHeight, Math.cos(heading) * Math.cos(angle) * distance);
  camera.lookAt(0, targetHeight, 0);
  if (roll) camera.rotateZ(roll * Math.PI / 180);
  camera.updateMatrixWorld(true);
  return camera;
}
function box({width=8, height=92.993 / 108.384 * 8, depth=59.803 / 108.384 * 8, centerX=0, bottom=0, centerZ=0} = {}) {
  return new THREE.Box3(new THREE.Vector3(centerX - width / 2, bottom, centerZ - depth / 2),
    new THREE.Vector3(centerX + width / 2, bottom + height, centerZ + depth / 2));
}
function projected(bounds, camera, pose, offsetUnit=4) {
  assert.ok(pose, 'a reachable photographic composition has a pose');
  assert.deepEqual(Object.keys(pose).sort(), ['modelOffsetX','modelOffsetY','modelOffsetZ','modelRotationX','modelRotationY','modelRotationZ','modelScale'].sort());
  const transform = new THREE.Matrix4().compose(new THREE.Vector3(pose.modelOffsetX,pose.modelOffsetY,pose.modelOffsetZ).multiplyScalar(offsetUnit),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(pose.modelRotationX,pose.modelRotationY,pose.modelRotationZ)), new THREE.Vector3().setScalar(pose.modelScale));
  const world = [], screen = [];
  for (const x of [bounds.min.x,bounds.max.x]) for (const y of [bounds.min.y,bounds.max.y]) for (const z of [bounds.min.z,bounds.max.z]) {
    const vertex = new THREE.Vector3(x,y,z).applyMatrix4(transform);
    world.push(vertex.clone());
    const clip = vertex.project(camera);
    screen.push({x:(clip.x+1)/2,y:(1-clip.y)/2});
  }
  const xs=screen.map(point=>point.x), ys=screen.map(point=>point.y);
  return {left:Math.min(...xs),right:Math.max(...xs),top:Math.min(...ys),bottom:Math.max(...ys),
    width:Math.max(...xs)-Math.min(...xs),height:Math.max(...ys)-Math.min(...ys),minY:Math.min(...world.map(point=>point.y))};
}
function assertComposition(bounds,camera,pose,desired=profile,offsetUnit=4) {
  const frame=projected(bounds,camera,pose,offsetUnit);
  assert.ok(Math.abs((frame.left+frame.right)/2-desired.centerX)<3e-7,'complete projected model is horizontally centred');
  assert.ok(Math.abs(frame.bottom-desired.footY)<3e-7,'complete projected feet align with the photographic surface');
  assert.ok(frame.width<=desired.maxWidth+2e-9,'width stays within usable composition');
  assert.ok(frame.height<=desired.maxHeight+2e-9,'height stays within usable composition');
  assert.ok(Math.abs(frame.minY)<1e-10,'lowest original corner stays on the ground');
  assert.ok(frame.left>=-1e-8&&frame.right<=1+1e-8&&frame.top>=-1e-8,'complete model stays in frame');
  return frame;
}

test('reference 108.384 × 92.993 × 59.803 mm model fills a grounded three-quarter product composition',()=>{
  const bounds=box(),camera=cameraFor();
  const pose=fitPhotographicModelPose({bounds,camera,profile});
  const frame=assertComposition(bounds,camera,pose);
  assert.equal(pose.modelRotationX,0);assert.equal(pose.modelRotationZ,0);assert.equal(pose.modelRotationY,Math.PI/4);
  assert.ok(Math.min(Math.abs(frame.height-profile.maxHeight),Math.abs(frame.width-profile.maxWidth))<1e-7,'the fit uses available width or height');
  assert.ok(pose.modelScale>=.1&&pose.modelScale<=5);
});

test('wide, tall, off-centre and below-zero full bounds fit independently of their original dimensions',()=>{
  for(const dimensions of [
    {width:15,height:2.5,depth:4}, {width:3,height:17,depth:3},
    {width:8,height:7,depth:5,centerX:5,bottom:-3,centerZ:-4},
    {width:.8,height:.7,depth:.5}, {width:25,height:23,depth:15},
  ]) {
    const bounds=box(dimensions),camera=cameraFor();
    const pose=fitPhotographicModelPose({bounds,camera,profile});
    assertComposition(bounds,camera,pose);
  }
});

test('world scale and offset units change pose values while preserving the same photographic projection',()=>{
  const originalBounds=box(),originalCamera=cameraFor();
  const first=fitPhotographicModelPose({bounds:originalBounds,camera:originalCamera,profile});
  const firstFrame=assertComposition(originalBounds,originalCamera,first);
  const factor=3.75,bounds=originalBounds.clone();bounds.min.multiplyScalar(factor);bounds.max.multiplyScalar(factor);
  const camera=cameraFor({distance:32*factor}),offsetUnit=11;
  const second=fitPhotographicModelPose({bounds,camera,profile,offsetUnit});
  const secondFrame=assertComposition(bounds,camera,second,profile,offsetUnit);
  assert.ok(Math.abs(first.modelScale-second.modelScale)<1e-8);
  for(const key of ['left','right','top','bottom'])assert.ok(Math.abs(firstFrame[key]-secondFrame[key])<1e-7,key);
});

test('final portrait, landscape and shifted crop projections keep complete bounds visible',()=>{
  const bounds=box();
  for(const settings of [{aspect:9/16},{aspect:4/5,yaw:22,pitch:18,fov:30},{aspect:16/9,pitch:25,roll:4}]) {
    const camera=cameraFor(settings);
    assertComposition(bounds,camera,fitPhotographicModelPose({bounds,camera,profile}));
  }
  const camera=cameraFor();
  camera.setViewOffset(1086,1448,120,260,820,1040);camera.updateMatrixWorld(true);
  const shifted={...profile,centerX:.58,footY:.88,maxHeight:.58,maxWidth:.7};
  assertComposition(bounds,camera,fitPhotographicModelPose({bounds,camera,profile:shifted}),shifted);
});

test('exact rotated original-vertex AABB can supply asymmetric bounds without applying yaw twice',()=>{
  const points=[new THREE.Vector3(-4,0,-2),new THREE.Vector3(1,5,2),new THREE.Vector3(6,2,-1),new THREE.Vector3(-2,7,1)];
  const rotation=new THREE.Matrix4().makeRotationY(Math.PI/4);
  const bounds=new THREE.Box3().setFromPoints(points.map(point=>point.clone().applyMatrix4(rotation)));
  const camera=cameraFor(),desired={...profile,yawDeg:0};
  const pose=fitPhotographicModelPose({bounds,camera,profile:desired});
  assertComposition(bounds,camera,pose,desired);assert.equal(pose.modelRotationY,0);
});

test('complete bounds produce one pose for every growth progress and respect maximum display scale',()=>{
  const bounds=box(),camera=cameraFor();
  const poses=[0,.25,.5,1].map(progress=>fitPhotographicModelPose({bounds,camera,profile,progress}));
  for(const pose of poses)assert.deepEqual(pose,poses[0]);
  const small=box({width:.15,height:.2,depth:.1});
  const pose=fitPhotographicModelPose({bounds:small,camera,profile,minScale:.5,maxScale:2});
  assert.equal(pose.modelScale,2);assertComposition(small,camera,pose);
  assert.equal(fitPhotographicModelPose({bounds:box({width:1000,height:1000,depth:1000}),camera,profile}),null,'a model that cannot fit even at minimum scale has no solution');
});

test('fitting never updates camera, its parents, bounds or the profile',()=>{
  const bounds=box({centerX:3,bottom:-2,centerZ:5}),camera=cameraFor();
  const parent=new THREE.Group();parent.position.set(1,0,-2);parent.add(camera);parent.updateMatrixWorld(true);
  parent.position.x=2; // Even stale caller matrices must remain untouched.
  const snapshot=()=>JSON.stringify({camera:camera.toJSON(),parentMatrix:parent.matrix.toArray(),parentWorld:parent.matrixWorld.toArray(),
    cameraMatrix:camera.matrix.toArray(),cameraWorld:camera.matrixWorld.toArray(),cameraInverse:camera.matrixWorldInverse.toArray(),bounds:bounds.toArray?.()||[bounds.min.toArray(),bounds.max.toArray()],profile});
  const before=snapshot();
  const pose=fitPhotographicModelPose({bounds,camera,profile});
  assert.ok(pose);assert.equal(snapshot(),before);
});

test('behind-camera ground, degenerate cameras and invalid input return null',()=>{
  const bounds=box(),camera=cameraFor();
  const away=cameraFor();away.lookAt(0,50,100);away.updateMatrixWorld(true);
  assert.equal(fitPhotographicModelPose({bounds,camera:away,profile}),null);
  const singular=camera.clone();singular.scale.setScalar(0);
  assert.equal(fitPhotographicModelPose({bounds,camera:singular,profile}),null);
  const invalidBounds=bounds.clone();invalidBounds.min.x=NaN;
  for(const input of [undefined,{}, {bounds:new THREE.Box3(),camera,profile}, {bounds:invalidBounds,camera,profile},
    {bounds,camera:new THREE.OrthographicCamera(),profile},{bounds,camera,profile:{...profile,yawDeg:NaN}},
    {bounds,camera,profile:{...profile,centerX:1}}, {bounds,camera,profile:{...profile,footY:0}},
    {bounds,camera,profile:{...profile,maxWidth:2}}, {bounds,camera,profile:{...profile,maxHeight:.99}},
    {bounds,camera,profile,offsetUnit:0},{bounds,camera,profile,minScale:2,maxScale:1}]) {
    assert.equal(fitPhotographicModelPose(input),null);
  }
});
