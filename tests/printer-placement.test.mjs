import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {getPresetCalibration} from '../src/preset-calibrations.js';
import {solvePlanarCamera} from '../src/calibration.js';
import {printerModelYaw, printerPatternGroundPoint, fitPrinterModelPose} from '../src/printer-placement.js';

const profile = {maxHeight:.48, maxWidth:.56, plateFill:.72, screenMargin:.06, bottomLimit:.9};
function printerCamera(key, worldScale = 8 / 108.384) {
  const preset = getPresetCalibration(key);
  const calibration = solvePlanarCamera({points:preset.points, widthPx:preset.imageSize.width, heightPx:preset.imageSize.height,
    bedWidth:preset.widthMm * worldScale, bedDepth:preset.depthMm * worldScale, allowOutside:preset.allowOutside,
    fov:preset.fov, photoVerticalLines:preset.verticalLines});
  const camera = new THREE.PerspectiveCamera(calibration.fov, preset.imageSize.width / preset.imageSize.height, .005, 10000);
  camera.position.fromArray(calibration.position); camera.quaternion.fromArray(calibration.quaternion);
  camera.updateMatrixWorld(true);
  return {camera, bedSize:{width:calibration.bedWidth, depth:calibration.bedDepth}};
}
function modelBounds({width=8, height=92.993 / 108.384 * 8, depth=59.803 / 108.384 * 8, centerX=0, centerZ=0, bottom=0} = {}) {
  return new THREE.Box3(new THREE.Vector3(centerX-width/2,bottom,centerZ-depth/2),
    new THREE.Vector3(centerX+width/2,bottom+height,centerZ+depth/2));
}
function frame(bounds, camera, pose, offsetUnit=4) {
  assert.ok(pose, 'printer composition has a reachable pose');
  const world = [], screen = [];
  const offset = new THREE.Vector3(pose.modelOffsetX,pose.modelOffsetY,pose.modelOffsetZ).multiplyScalar(offsetUnit);
  for (const x of [bounds.min.x,bounds.max.x]) for (const y of [bounds.min.y,bounds.max.y]) for (const z of [bounds.min.z,bounds.max.z]) {
    const point = new THREE.Vector3(x,y,z).multiplyScalar(pose.modelScale).add(offset);
    world.push(point.clone()); point.project(camera); screen.push({x:(point.x+1)/2,y:(1-point.y)/2});
  }
  const xs=screen.map(point=>point.x), ys=screen.map(point=>point.y), projected={
    left:Math.min(...xs), right:Math.max(...xs), top:Math.min(...ys), bottom:Math.max(...ys),
    width:Math.max(...xs)-Math.min(...xs), height:Math.max(...ys)-Math.min(...ys), world:new THREE.Box3().setFromPoints(world),
  };
  return projected;
}
function assertFits(bounds, camera, bedSize, pose, desired=profile, offsetUnit=4) {
  const measured = frame(bounds,camera,pose,offsetUnit), center=measured.world.getCenter(new THREE.Vector3()), size=measured.world.getSize(new THREE.Vector3());
  assert.ok(Math.abs(measured.world.min.y)<1e-9, 'complete model soles sit on the calibrated sheet');
  assert.ok(Math.abs(center.x)<1e-9 && Math.abs(center.z-(desired.centerZ||0)*bedSize.depth)<1e-9, 'rotated asymmetric bounds centre on the plate');
  assert.ok(size.x<=bedSize.width*desired.plateFill+1e-8, 'footprint fits the sheet width');
  assert.ok(Math.max(Math.abs(measured.world.min.z),Math.abs(measured.world.max.z))<=bedSize.depth*desired.plateFill/2+1e-8, 'footprint fits the sheet depth');
  assert.ok(measured.left>=desired.screenMargin-1e-8 && measured.right<=1-desired.screenMargin+1e-8 && measured.top>=desired.screenMargin-1e-8 && measured.bottom<=desired.bottomLimit+1e-8, 'the complete model stays in the source photo');
  assert.ok(measured.width<=desired.maxWidth+1e-8 && measured.height<=desired.maxHeight+1e-8, 'model scale respects its printer composition');
  assert.equal(pose.modelRotationX,0); assert.equal(pose.modelRotationY,0); assert.equal(pose.modelRotationZ,0);
  return measured;
}

test('all three calibrated printer photos fit the full reference model on their own physical sheets',()=>{
  for (const key of ['h2c','p1s','a1']) {
    const {camera,bedSize}=printerCamera(key), bounds=modelBounds(), pose=fitPrinterModelPose({bounds,camera,bedSize,profile});
    const measured=assertFits(bounds,camera,bedSize,pose);
    assert.ok(pose.modelScale>1, `${key} uses a useful preview scale instead of inheriting a smaller preceding preset`);
    assert.ok(measured.height>.35, `${key} model has enough presence in the complete photograph`);
    assert.equal(fitPrinterModelPose({bounds,camera,bedSize,profile,minScale:pose.modelScale*1.001,maxScale:5}),null,'the returned pose reaches a frame or sheet limit');
  }
});

test('default yaw faces a -X source front toward the camera across all printer photos',()=>{
  for (const key of ['h2c','p1s','a1']) {
    const {camera}=printerCamera(key), cameraAzimuth=THREE.MathUtils.radToDeg(Math.atan2(camera.position.x,camera.position.z));
    assert.ok(Math.abs(printerModelYaw(camera)-cameraAzimuth-90)<1e-10);
    assert.ok(Math.abs(printerModelYaw(camera,35)-cameraAzimuth-35)<1e-10);
  }
});

test('already-rotated asymmetric complete bounds are centred and grounded without rotating twice',()=>{
  const points=[new THREE.Vector3(-6,-2,-3),new THREE.Vector3(-3,5,2),new THREE.Vector3(2,-1,4),new THREE.Vector3(6,2,0)];
  for (const key of ['h2c','p1s','a1']) {
    const {camera,bedSize}=printerCamera(key), rotation=new THREE.Matrix4().makeRotationY(THREE.MathUtils.degToRad(printerModelYaw(camera)));
    const bounds=new THREE.Box3().setFromPoints(points.map(point=>point.clone().applyMatrix4(rotation)));
    assertFits(bounds,camera,bedSize,fitPrinterModelPose({bounds,camera,bedSize,profile}));
  }
});

test('sheet containment handles very wide, tall, deep, off-centre and below-zero models',()=>{
  const {camera,bedSize}=printerCamera('h2c');
  for (const dimensions of [
    {width:21,height:3,depth:4}, {width:2,height:23,depth:2}, {width:4,height:5,depth:25},
    {width:8,height:7,depth:5,centerX:8,centerZ:-6,bottom:-3},
  ]) {
    const bounds=modelBounds(dimensions);
    assertFits(bounds,camera,bedSize,fitPrinterModelPose({bounds,camera,bedSize,profile}));
  }
});

test('optional depth placement stays on the usable sheet and consumes remaining sheet margin',()=>{
  const {camera,bedSize}=printerCamera('a1'), bounds=modelBounds(), desired={...profile,centerZ:-.08};
  assertFits(bounds,camera,bedSize,fitPrinterModelPose({bounds,camera,bedSize,profile:desired}),desired);
});

test('display pose is fixed for growth progress and obeys explicit scale limits',()=>{
  const {camera,bedSize}=printerCamera('p1s'), bounds=modelBounds();
  const poses=[0,.25,.5,1].map(progress=>fitPrinterModelPose({bounds,camera,bedSize,profile,progress}));
  for (const pose of poses) assert.deepEqual(pose,poses[0]);
  const tiny=modelBounds({width:.1,height:.1,depth:.1});
  assert.equal(fitPrinterModelPose({bounds:tiny,camera,bedSize,minScale:.5,maxScale:2}).modelScale,2);
  assert.equal(fitPrinterModelPose({bounds:modelBounds({width:1e5,height:1e5,depth:1e5}),camera,bedSize}),null);
});

test('world units and offset divisor preserve the same printer composition',()=>{
  const first=printerCamera('a1'), bounds=modelBounds(), pose=fitPrinterModelPose({...first,bounds,profile}), initial=frame(bounds,first.camera,pose);
  const factor=3.75, second=printerCamera('a1',8/108.384*factor), expanded=bounds.clone();expanded.min.multiplyScalar(factor);expanded.max.multiplyScalar(factor);
  const next=fitPrinterModelPose({...second,bounds:expanded,profile,offsetUnit:11}), measured=assertFits(expanded,second.camera,second.bedSize,next,profile,11);
  assert.ok(Math.abs(pose.modelScale-next.modelScale)<1e-8);
  for (const key of ['left','right','top','bottom']) assert.ok(Math.abs(initial[key]-measured[key])<1e-8,key);
});

test('camera parent transforms and stale matrices are read without mutation',()=>{
  const {camera,bedSize}=printerCamera('h2c'), parent=new THREE.Group();parent.add(camera);parent.position.set(.5,.25,-.5);parent.updateMatrixWorld(true);parent.position.x=.75;
  const bounds=modelBounds({centerX:3,centerZ:-4,bottom:-2}), desired={...profile};
  const snapshot=()=>JSON.stringify({camera:camera.toJSON(),parent:parent.toJSON(),projection:camera.projectionMatrix.elements,
    world:camera.matrixWorld.elements,inverse:camera.matrixWorldInverse.elements,bounds:[bounds.min.toArray(),bounds.max.toArray()],bedSize,desired});
  const before=snapshot();
  const yaw=printerModelYaw(camera), worldPosition=camera.position.clone().add(parent.position);
  assert.ok(Math.abs(yaw-THREE.MathUtils.radToDeg(Math.atan2(worldPosition.x,worldPosition.z))-90)<1e-10);
  assert.ok(fitPrinterModelPose({bounds,camera,bedSize,profile:desired}));
  assert.equal(snapshot(),before);
});

test('offscreen plate, clip crossings and invalid inputs fail without fabricating a pose',()=>{
  const valid=printerCamera('h2c'), bounds=modelBounds();
  const inputs={...valid,bounds};
  for (const override of [
    {bounds:null}, {bounds:new THREE.Box3()}, {bounds:modelBounds({height:0})}, {camera:{}},
    {bedSize:{width:0,depth:20}}, {bedSize:{width:20,depth:NaN}}, {offsetUnit:0}, {minScale:-1}, {maxScale:.01},
    {profile:null}, {profile:{maxHeight:NaN}}, {profile:{maxWidth:0}}, {profile:{plateFill:1.1}},
    {profile:{screenMargin:.5}}, {profile:{bottomLimit:.99}}, {profile:{centerZ:.5}},
  ]) assert.equal(fitPrinterModelPose({...inputs,...override}),null,JSON.stringify(override));
  const offscreen=valid.camera.clone();offscreen.lookAt(100,0,0);offscreen.updateMatrixWorld(true);
  assert.equal(fitPrinterModelPose({...inputs,camera:offscreen}),null);
  const clipped=valid.camera.clone();clipped.near=1000;clipped.far=2000;clipped.updateProjectionMatrix();
  assert.equal(fitPrinterModelPose({...inputs,camera:clipped}),null);
  assert.equal(printerModelYaw(null),null); assert.equal(printerModelYaw(valid.camera,NaN),null);
  const overhead=new THREE.PerspectiveCamera();overhead.position.set(0,10,0);assert.equal(printerModelYaw(overhead),null);
});

const patternPixels={h2c:[1900,1740],p1s:[2080,1975],a1:[1970,1740]};
const sourcePatternProfile=key=>({patternCenter:{x:patternPixels[key][0]/3776,y:patternPixels[key][1]/2832}});
function packedFrame(points,camera,pose,offsetUnit=4){
  const rect={left:Infinity,right:-Infinity,top:Infinity,bottom:-Infinity},world=new THREE.Box3();
  const offset=new THREE.Vector3(pose.modelOffsetX,pose.modelOffsetY,pose.modelOffsetZ).multiplyScalar(offsetUnit);
  for(let index=0;index<points.length;index+=3){
    const v=new THREE.Vector3(points[index],points[index+1],points[index+2]).multiplyScalar(pose.modelScale).add(offset);world.expandByPoint(v);
    v.project(camera);const x=(v.x+1)/2,y=(1-v.y)/2;
    rect.left=Math.min(rect.left,x);rect.right=Math.max(rect.right,x);rect.top=Math.min(rect.top,y);rect.bottom=Math.max(rect.bottom,y);
  }
  return {...rect,width:rect.right-rect.left,height:rect.bottom-rect.top,world};
}
const near=(a,b,tolerance=1e-8)=>assert.ok(Math.abs(a-b)<tolerance,`${a} is within ${tolerance} of ${b}`);
function testCamera(){const c=new THREE.PerspectiveCamera(35,4/3,.01,1000);c.position.set(0,8,20);c.lookAt(0,2,0);c.updateMatrixWorld(true);c.updateProjectionMatrix();return c;}

test('each photographed plate-pattern centre ray lands on Y=0 and reprojects to the measured pixels',()=>{
  for(const key of ['h2c','p1s','a1']){
    const {camera}=printerCamera(key),desired=sourcePatternProfile(key),target=printerPatternGroundPoint(camera,desired);
    assert.ok(target?.isVector3);assert.equal(target.y,0);
    const projected=target.clone().project(camera),pixel=[(projected.x+1)/2*3776,(1-projected.y)/2*2832];
    near(pixel[0],patternPixels[key][0],2);near(pixel[1],patternPixels[key][1],2);
    const direction=new THREE.Vector3(-1,0,0).applyAxisAngle(new THREE.Vector3(0,1,0),THREE.MathUtils.degToRad(printerModelYaw(camera,90,target)));
    const towards=camera.position.clone().sub(target);towards.y=0;towards.normalize();near(direction.dot(towards),1,1e-10);
  }
});

test('pattern rays reject horizon/upward rays and malformed centres without moving the camera',()=>{
  const camera=new THREE.PerspectiveCamera(40,4/3,.01,1000);camera.position.set(0,10,10);camera.lookAt(0,10,0);camera.updateMatrixWorld(true);
  const snapshot=JSON.stringify(camera.toJSON());
  for(const patternCenter of [{x:.5,y:.5},{x:.5,y:.2},{x:NaN,y:.8},{x:1.1,y:.8},{x:.5}])assert.equal(printerPatternGroundPoint(camera,{patternCenter}),null);
  assert.ok(printerPatternGroundPoint(camera,{patternCenter:{x:.5,y:.8}}));
  assert.deepEqual(printerPatternGroundPoint(camera).toArray(),[0,0,0]);assert.equal(printerPatternGroundPoint(null),null);
  assert.equal(JSON.stringify(camera.toJSON()),snapshot);
});

test('actual sparse vertices avoid empty upper box corners and allow a larger visible model',()=>{
  const camera=testCamera(),bedSize={width:100,depth:100};
  const points=new Float32Array([-3,0,0,3,0,0,0,9,-6,6,2,6,-6,2,6]),bounds=new THREE.Box3(new THREE.Vector3(-6,0,-6),new THREE.Vector3(6,9,6));
  const desired={maxHeight:.60,maxWidth:.8,plateFill:.9,screenMargin:.03,bottomLimit:.95};
  const boxPose=fitPrinterModelPose({bounds,camera,bedSize,profile:desired}),pose=fitPrinterModelPose({bounds,camera,bedSize,profile:desired,points});
  assert.ok(pose.modelScale>boxPose.modelScale*1.10,'empty near upper corners do not reduce actual mesh scale');
  const measured=packedFrame(points,camera,pose);near(measured.height,.6,1e-8);assert.ok(measured.bottom<=.95+1e-8);
  assert.ok(frame(bounds,camera,pose).height>.6,'the empty enclosing box is allowed to exceed the mesh height limit');
  assert.equal(fitPrinterModelPose({bounds,camera,bedSize,profile:desired,points,minScale:pose.modelScale*1.001}),null);
});

test('contact centre rather than asymmetric body centre anchors the model on the photographed pattern',()=>{
  const {camera,bedSize}=printerCamera('h2c'),bounds=modelBounds({centerX:-2,centerZ:-1,bottom:-3}),desired=sourcePatternProfile('h2c');
  const contactCenter=new THREE.Vector3(1,-3,1.5),target=printerPatternGroundPoint(camera,desired);
  const pose=fitPrinterModelPose({bounds,camera,bedSize,profile:desired,contactCenter});assert.ok(pose);
  const offset=new THREE.Vector3(pose.modelOffsetX,pose.modelOffsetY,pose.modelOffsetZ).multiplyScalar(4);
  const contact=contactCenter.clone().multiplyScalar(pose.modelScale).add(offset);
  near(contact.x,target.x);near(contact.y,0);near(contact.z,target.z);
  const measured=frame(bounds,camera,pose);near(measured.world.min.y,0);
  assert.ok(Math.abs(measured.world.getCenter(new THREE.Vector3()).x-target.x)>1,'the asymmetrical body is not mistaken for its contact anchor');
  for(const value of [[1,-3,1.5],[1,1.5],{x:1,z:1.5}])assert.deepEqual(fitPrinterModelPose({bounds,camera,bedSize,profile:desired,contactCenter:value}),pose);
});

test('asymmetric tails consume only the corresponding sheet edge after shifting the contact anchor',()=>{
  const camera=testCamera(),target=new THREE.Vector3(0,0,3),projected=target.clone().project(camera);
  const desired={patternCenter:{x:(projected.x+1)/2,y:(1-projected.y)/2},maxHeight:.9,maxWidth:.9,plateFill:.9,screenMargin:0,bottomLimit:.98};
  const bounds=new THREE.Box3(new THREE.Vector3(-1,0,-6),new THREE.Vector3(1,3,1));
  const pose=fitPrinterModelPose({bounds,camera,bedSize:{width:20,depth:20},profile:desired,contactCenter:{x:0,z:0}});
  assert.ok(pose.modelScale>1.9,'a rearward tail uses rear sheet space rather than symmetrical front margins');
  const world=frame(bounds,camera,pose).world;assert.ok(world.min.z>=-9-1e-8 && world.max.z<=9+1e-8);near(world.min.z,-9,1e-8);
});

test('actual point extremes still enforce complete footprint and near/far clipping',()=>{
  const camera=testCamera(),bounds=new THREE.Box3(new THREE.Vector3(-1,0,-1),new THREE.Vector3(1,2,1));camera.fov=65;camera.updateProjectionMatrix();
  const points=new Float64Array([-1,0,-1,1,2,1,30,0,0]);
  const pose=fitPrinterModelPose({bounds,camera,bedSize:{width:20,depth:20},points});assert.ok(pose);
  near(pose.modelScale,.3,1e-8);assert.ok(packedFrame(points,camera,pose).world.max.x<=9+1e-8);
  const clipped=camera.clone();clipped.near=100;clipped.far=200;clipped.updateProjectionMatrix();
  assert.equal(fitPrinterModelPose({bounds,camera:clipped,bedSize:{width:20,depth:20},points}),null);
  for(const points of [new Float32Array([0,0,NaN]),new Float64Array([0,0,0,1]),new Int16Array([0,0,0]),[],{}])assert.equal(fitPrinterModelPose({bounds,camera,bedSize:{width:20,depth:20},points}),null);
  assert.equal(fitPrinterModelPose({bounds,camera,bedSize:{width:20,depth:20},contactCenter:{x:NaN,z:0}}),null);
});

test('pattern fit respects a scaled source projection and world-unit changes without input mutation',()=>{
  const first=printerCamera('a1'),bounds=modelBounds(),desired=sourcePatternProfile('a1'),points=new Float32Array([-4,0,-2,4,0,-2,0,6.86,2,1,1,2]);
  const contactCenter={x:0,z:-1};
  const before=JSON.stringify({camera:first.camera.toJSON(),bounds:[bounds.min.toArray(),bounds.max.toArray()],bed:first.bedSize,desired,contactCenter,points:[...points]});
  const pose=fitPrinterModelPose({...first,bounds,points,contactCenter,profile:desired});assert.ok(pose);
  assert.equal(JSON.stringify({camera:first.camera.toJSON(),bounds:[bounds.min.toArray(),bounds.max.toArray()],bed:first.bedSize,desired,contactCenter,points:[...points]}),before);
  const factor=2.5,second=printerCamera('a1',8/108.384*factor),expanded=bounds.clone();expanded.min.multiplyScalar(factor);expanded.max.multiplyScalar(factor);
  const scaledPoints=Float64Array.from(points,value=>value*factor),scaledContact={x:contactCenter.x*factor,z:contactCenter.z*factor};
  const next=fitPrinterModelPose({...second,bounds:expanded,points:scaledPoints,contactCenter:scaledContact,profile:desired,offsetUnit:11});assert.ok(next);near(pose.modelScale,next.modelScale);
  const initial=packedFrame(points,first.camera,pose),measured=packedFrame(scaledPoints,second.camera,next,11);
  for(const key of ['left','right','top','bottom'])near(initial[key],measured[key]);
  const enlargedProjection=first.camera.clone();enlargedProjection.fov=25;enlargedProjection.updateProjectionMatrix();
  const target=printerPatternGroundPoint(enlargedProjection,desired),uv=target.clone().project(enlargedProjection);
  near((uv.x+1)/2,desired.patternCenter.x);near((1-uv.y)/2,desired.patternCenter.y);
  const adjusted=fitPrinterModelPose({bounds,camera:enlargedProjection,bedSize:first.bedSize,points,contactCenter,profile:desired});assert.ok(adjusted);
  assert.notEqual(adjusted.modelOffsetZ,pose.modelOffsetZ,'placement uses the supplied frame projection');
});

test('pattern rays and front yaw read stale transformed camera parents without mutation',()=>{
  const {camera}=printerCamera('h2c'),parent=new THREE.Group();parent.add(camera);parent.position.set(1,2,-3);parent.rotation.y=.1;parent.updateMatrixWorld(true);parent.position.x=2;
  const desired=sourcePatternProfile('h2c'),snapshot=JSON.stringify(parent.toJSON()),target=printerPatternGroundPoint(camera,desired);assert.ok(target);
  const current=parent.clone(true);current.updateMatrixWorld(true);const actual=current.children[0],uv=target.clone().project(actual);
  near((uv.x+1)/2,desired.patternCenter.x);near((1-uv.y)/2,desired.patternCenter.y);
  const worldCamera=new THREE.Vector3().setFromMatrixPosition(actual.matrixWorld),towards=worldCamera.sub(target);towards.y=0;towards.normalize();
  const facing=new THREE.Vector3(-1,0,0).applyAxisAngle(new THREE.Vector3(0,1,0),THREE.MathUtils.degToRad(printerModelYaw(camera,90,target)));
  near(towards.dot(facing),1);assert.equal(JSON.stringify(parent.toJSON()),snapshot);
  assert.equal(printerModelYaw(camera,90,{x:NaN,z:0}),null);
});

test('raised long tails can overhang while the true ground footprint stays on the sheet and the full model stays in frame',()=>{
  const camera=testCamera(),points=new Float64Array([-1,0,-1,1,0,-1,1,0,1,-1,0,1,0,8,0,16,3,0]);
  const bounds=new THREE.Box3(new THREE.Vector3(-1,0,-1),new THREE.Vector3(16,8,1));
  const footprintBounds=new THREE.Box3(new THREE.Vector3(-1,0,-1),new THREE.Vector3(1,.2,1));
  const bedSize={width:12,depth:12},contactCenter={x:0,z:0};
  const full=fitPrinterModelPose({bounds,camera,bedSize,points,contactCenter});
  const pose=fitPrinterModelPose({bounds,camera,bedSize,points,contactCenter,footprintBounds});assert.ok(pose);
  assert.ok(pose.modelScale>full.modelScale*1.5,'a raised tail does not impose a false sheet contact constraint');
  const feet=frame(footprintBounds,camera,pose).world,whole=packedFrame(points,camera,pose);
  assert.ok(Math.abs(feet.min.x)<=5.4+1e-8 && Math.abs(feet.max.x)<=5.4+1e-8 && Math.abs(feet.min.z)<=5.4+1e-8 && Math.abs(feet.max.z)<=5.4+1e-8);
  near(whole.world.min.y,0);assert.ok(whole.world.max.x>5.4,'the raised tail may extend above the sheet edge');
  assert.ok(whole.left>=.035-1e-8 && whole.right<=.965+1e-8 && whole.top>=.035-1e-8 && whole.bottom<=.90+1e-8);
  assert.ok(whole.width<=.64+1e-8 && whole.height<=.60+1e-8);
  const snapshot=JSON.stringify([footprintBounds.min.toArray(),footprintBounds.max.toArray()]);
  assert.deepEqual(fitPrinterModelPose({bounds,camera,bedSize,points,contactCenter,footprintBounds}),pose);assert.equal(JSON.stringify([footprintBounds.min.toArray(),footprintBounds.max.toArray()]),snapshot);
  for(const footprintBounds of [{},new THREE.Box3(),new THREE.Box3(new THREE.Vector3(NaN,0,0),new THREE.Vector3(1,1,1))])assert.equal(fitPrinterModelPose({bounds,camera,bedSize,points,contactCenter,footprintBounds}),null);
});
