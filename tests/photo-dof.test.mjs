import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { BokehShader } from 'three/addons/shaders/BokehShader.js';
import { OutputShader } from 'three/addons/shaders/OutputShader.js';
import { preservePhotoBokehShader, premultipliedDofOutputShader, PHOTO_BACKGROUND_DEPTH, PHOTO_DOF_DISK } from '../src/photo-dof.js';
import { GrowthStudio, SceneDepthBokehPass } from '../src/studio.js';
import { resolvePhotoLensDof, photoLensCoCAtDepth } from '../src/photo-lens-dof.js';
import { getPresetDof } from '../src/preset-dof.js';
import { createSceneRenderPackage } from '../src/scene-package.js';
import { readFile } from 'node:fs/promises';

globalThis.FileReader ||= class {
  readAsArrayBuffer(blob) { blob.arrayBuffer().then(result=>{this.result=result;this.onloadend?.();}); }
};
const close=(a,b)=>assert.ok(Math.abs(a-b)<1e-10,`${a} ≈ ${b}`);
function fixture() {
  const studio=Object.create(GrowthStudio.prototype);
  studio.options={dofEnabled:true,dofStrength:10,dofFocus:40,modelScale:1};
  studio.camera=new THREE.PerspectiveCamera(2*Math.atan(24/48)*180/Math.PI,4/3,.001,200);
  studio.camera.position.set(0,0,20);studio.camera.updateMatrixWorld(true);
  studio.modelGroup=new THREE.Group();
  studio.normalized=new THREE.Group();studio.normalized.scale.setScalar(.04);
  studio._baseBounds=new THREE.Box3(new THREE.Vector3(-2,-3,-4),new THREE.Vector3(2,3,4));
  studio._bounds=studio._baseBounds.clone();studio._metadata={sourceUnitsToMm:1,sourceUnitsInferred:false};
  studio.controls={target:new THREE.Vector3()};
  studio._backgroundSize={width:400,height:300};studio._backgroundMetadata={type:'image',name:'h2c.jpg'};
  studio._backgroundTexture=new THREE.Texture();studio.scene=new THREE.Scene();studio.scene.background=studio._backgroundTexture;
  let draws=0, clearAlpha=1;const clear=new THREE.Color('#222222');
  studio.renderer={getSize:target=>target.set(1440,1080),getPixelRatio:()=>1,
    getClearColor:target=>target.copy(clear),getClearAlpha:()=>clearAlpha,
    setClearAlpha:value=>{clearAlpha=value;},render:()=>{draws++;}};
  studio._ensureDof=()=>{};
  studio._dofRenderPass={};
  const pass=new SceneDepthBokehPass(studio.scene,studio.camera);
  studio._dofBokehPass=pass;
  studio._dofComposer={render(){draws++;
    if (pass.enabled) { assert.equal(studio.scene.background,null);assert.equal(studio._dofRenderPass.clearAlpha,0); }
    else { assert.equal(studio.scene.background,studio._backgroundTexture);assert.equal(studio._dofRenderPass.clearAlpha,1); }
  }};
  return {studio,pass,draws:()=>draws};
}

test('physical photo shader uses camera-axis thin-lens CoC, bounded source disks and unblurred photo compositing',()=>{
  const shader=preservePhotoBokehShader(BokehShader.fragmentShader);
  assert.equal(PHOTO_BACKGROUND_DEPTH,.9999999);
  assert.equal((shader.match(/uniform float preservePhoto;/g)||[]).length,1);
  assert.match(shader,/cocRadiusUvCoefficient \* abs\(axisDepth - focus\) \/ axisDepth/);
  assert.match(shader,/sourceDepth >= 0\.9999999\) return/,'photo/shadow pixels cannot be gathered as model samples');
  assert.match(shader,/gl_FragColor = over\(blurred, underlay\)/);
  assert.match(shader,/vec4 photo = texture2D\(tPhoto,/);
  assert.doesNotMatch(shader,/factor \* aperture|gl_FragColor\.a = 1\.0|col \/ 41/);
  assert.doesNotMatch(shader,/#include <colorspace_pars_fragment>/,'ShaderMaterial already supplies these transfer functions in its prefix');
  assert.equal(PHOTO_DOF_DISK.length,49);
  assert.ok(PHOTO_DOF_DISK.every(([x,y])=>x*x+y*y<=1));
  assert.throws(()=>preservePhotoBokehShader('void main() {}'),/插入点/);
});

test('linear premultiplied optical edges transfer straight RGB before display encoding and preserve opacity',()=>{
  const shader=premultipliedDofOutputShader(OutputShader.fragmentShader);
  const divide=shader.indexOf('gl_FragColor.rgb / gl_FragColor.a');
  const encode=shader.indexOf('sRGBTransferOETF');
  const multiply=shader.lastIndexOf('gl_FragColor.rgb *= gl_FragColor.a');
  assert.ok(divide>0&&divide<encode&&encode<multiply);
  assert.doesNotMatch(shader,/gl_FragColor\.a\s*=/,'alpha coverage must not be forced opaque');
  // Equal area: an opaque red sample and transparent black are red at 50%
  // coverage. Encoding the averaged premultiplied red directly would be .735,
  // too bright for a premultiplied canvas; correct encoded red is .5.
  const alpha=.5, linearPremultRed=.5;
  const srgb=linear=>linear<=.0031308?12.92*linear:1.055*linear**(1/2.4)-.055;
  close(srgb(linearPremultRed/alpha)*alpha,.5);
  assert.ok(srgb(linearPremultRed)>.73);
  // Composite linear white behind the same edge: [1,.5,.5], never a black rim.
  assert.deepEqual([linearPremultRed+1*(1-alpha),1*(1-alpha),1*(1-alpha)],[1,.5,.5]);
});

test('bokeh pass reuses actual clipped scene depth without a second geometry draw',()=>{
  const camera=new THREE.PerspectiveCamera(45,4/3,.1,200);
  const pass=new SceneDepthBokehPass(new THREE.Scene(),camera,{focus:5});
  const color=new THREE.Texture(),depth=new THREE.DepthTexture(16,16),target={};
  let selected,clears=0,draws=0;
  pass._fsQuad.render=()=>{draws++;};
  pass.render({setRenderTarget:value=>{selected=value;},clear:()=>{clears++;}},target,{texture:color,depthTexture:depth});
  assert.equal(pass.uniforms.tColor.value,color);assert.equal(pass.uniforms.tDepth.value,depth);
  assert.equal(pass.materialBokeh.defines.DEPTH_PACKING,0);assert.equal(selected,target);assert.equal(clears,1);assert.equal(draws,1);
  pass.dispose();color.dispose();depth.dispose();
});

test('actual photo identity switches aperture without changing geometry or focus; custom photo cannot inherit EXIF',()=>{
  const {studio,pass,draws}=fixture();
  studio.setPhotoIdentity('preset:h2c');
  const known=studio.getPhotoLensDof();
  assert.equal(known.fNumber,2.8);close(known.focusDistanceMm,480);assert.equal(known.metricSource,'source-unit-and-normalization');
  studio._drawScene();
  assert.equal(pass.uniforms.preservePhoto.value,1);close(pass.uniforms.focus.value,19.2);
  close(pass.uniforms.cocRadiusUvCoefficient.value,known.cocRadiusUvCoefficient);
  assert.equal(studio.scene.background,studio._backgroundTexture,'one transparent scene pass must restore the actual photo');
  const full=studio._baseBounds.clone();
  for(const progress of [0,.25,.5,1]) {
    studio.options.progress=progress;studio.options.showSupports=progress>.5;
    const next=studio.getPhotoLensDof();assert.equal(next.focusDistanceMm,known.focusDistanceMm);
  }
  assert.ok(studio._baseBounds.equals(full));
  studio.setPhotoIdentity(null);
  const custom=studio.getPhotoLensDof();assert.equal(custom.fNumber,15);assert.equal(custom.apertureSource,'visual-estimate');
  studio.options.transparent=true;studio.scene.background=null;studio._drawScene();
  assert.equal(pass.uniforms.preservePhoto.value,0);assert.equal(pass.uniforms.backgroundLinearRGBA.value.w,0);
  assert.equal(studio.getPhotoLensDof().physicalFocalLengthMm,custom.physicalFocalLengthMm,'transparent output keeps photo lens/crop geometry');
  assert.equal(draws(),2);
  studio._updateFloorFootprint=()=>{};studio._releaseBackground();assert.equal(studio.photoIdentity,null);
  assert.throws(()=>studio.setPhotoIdentity('preset:h2c'),/载入/);
  pass.dispose();
});

test('generated background identities reach studio optics and release without leaking their aperture to same-name custom photos',()=>{
  for(const [key,fNumber] of [['pastel-rug',8],['blue-grey',8],['teal-room',5.6]]) {
    const {studio,pass}=fixture();
    Object.assign(studio.options,getPresetDof(key));
    studio._backgroundMetadata.name=key+'.png';
    const projection=studio.camera.projectionMatrix.toArray(),bounds=studio._baseBounds.clone();
    studio.setPhotoIdentity('preset:'+key);
    const lens=studio.getPhotoLensDof();
    assert.equal(studio.photoIdentity,'preset:'+key);assert.equal(lens.fNumber,fNumber);
    assert.equal(lens.estimate.sourcePhoto,`assets/backgrounds/${key}.png`);
    assert.equal(lens.apertureSource,'visual-estimate');assert.equal(lens.reference,null);
    assert.equal(lens.focusMeasured,false);assert.equal(lens.photoPixelsProtected,true);
    studio._drawScene();
    assert.equal(pass.uniforms.preservePhoto.value,1);
    assert.equal(studio.scene.background,studio._backgroundTexture,'the already photographic backdrop stays outside the optical pass');
    for(const progress of [0,.5,1]) {
      studio.options.progress=progress;
      close(studio.getPhotoLensDof().focusDistanceMm,lens.focusDistanceMm);
    }
    assert.ok(studio._baseBounds.equals(bounds));assert.deepEqual(studio.camera.projectionMatrix.toArray(),projection);
    assert.throws(()=>studio.setPhotoIdentity('custom:'+key+'.png'),/身份/);
    studio.setPhotoIdentity(null);
    const custom=studio.getPhotoLensDof();
    assert.equal(custom.estimate,undefined,'a matching filename is not the exact preset identity');
    assert.notEqual(custom.fNumber,fNumber);close(custom.focusDistanceMm,lens.focusDistanceMm);
    studio._updateFloorFootprint=()=>{};studio._releaseBackground();
    assert.equal(studio.photoIdentity,null);assert.throws(()=>studio.setPhotoIdentity('preset:'+key),/载入/);
    assert.throws(()=>studio.setPhotoIdentity('preset:unknown-scene'),/身份/);
    pass.dispose();
  }
});

test('calibrated bed metric, vertical crop and full bounds match HQ optics after scene conversion to metres',async()=>{
  const {studio,pass}=fixture();
  studio._photoBedSize={width:12,depth:12};studio.options.bedWidthMm=300;studio.options.bedDepthMm=300;
  studio.options.crop={sourceAspect:4/3,x:.2,y:.15,width:.5,height:.5};
  studio.camera.setViewOffset(4/3,1,.2*4/3,.15,.5*4/3,.5);
  studio.setPhotoIdentity('preset:h2c');
  const preview=studio.getPhotoLensDof();
  close(preview.worldToMm,25);assert.equal(preview.effectiveSensorHeightMm,12);close(preview.physicalFocalLengthMm,24);
  const geometry=new THREE.BoxGeometry(4,6,8),material=new THREE.MeshStandardMaterial();
  const root=new THREE.Group();root.add(new THREE.Mesh(geometry,material));
  const snapshot={root,camera:studio.camera,mode:'mesh',settings:{...studio.options,transparent:true,showSupports:false},
    units:{calibratedBed:studio._photoBedSize,normalizedScale:.04,sourceUnitsToMm:1},
    metadata:{format:'3mf'},floor:{width:12,depth:12},photoIdentity:studio.photoIdentity,
    backgroundType:'image',backgroundSize:studio._backgroundSize,focusBoundsWorld:studio._completeModelFocusBounds()};
  const result=await createSceneRenderPackage(snapshot,{output:{width:1440,height:1080,frames:1},bedWidthMm:300,bedDepthMm:300});
  const hq=result.metadata.optics;
  for(const key of ['fNumber','physicalFocalLengthMm','effectiveSensorHeightMm','focusDistanceMm','cocRadiusUvCoefficient'])close(preview[key],hq[key]);
  close(photoLensCoCAtDepth(preview,24).diameterPixels,photoLensCoCAtDepth(hq,.6).diameterPixels);
  studio.options.modelScale=2;studio.modelGroup.scale.setScalar(2);
  const scaled=studio.getPhotoLensDof();close(scaled.worldToMm,25);
  assert.notEqual(scaled.focusDistanceMm,preview.focusDistanceMm,'physical model depth changes at the same fixed camera');
  studio.options.bedDepthMm=250;assert.throws(()=>studio.getPhotoLensDof(),/底板宽深/);
  geometry.dispose();material.dispose();pass.dispose();studio._backgroundTexture.dispose();
});

test('full bounds follow detached user pose and ignore support extents throughout growth',()=>{
  const {studio,pass}=fixture();
  studio.camera.position.set(0,0,5);studio.camera.lookAt(0,0,0);
  studio.modelGroup.position.z=2; // no updateMatrixWorld; read detached pose.
  studio._bounds=new THREE.Box3(new THREE.Vector3(-20,-20,-20),new THREE.Vector3(20,20,20));
  studio._supportOverlay={originalBounds:new THREE.Box3(new THREE.Vector3(-1,-1,-1),new THREE.Vector3(1,1,1))};
  const before=studio.modelGroup.matrixWorld.toArray();
  for(const progress of [.1,.8,1]) {studio.options.progress=progress;assert.deepEqual(studio._dofDepthRange(),{near:2,far:4});}
  assert.deepEqual(studio.modelGroup.matrixWorld.toArray(),before,'reading full bounds must not mutate cached transforms');
  pass.dispose();studio._backgroundTexture.dispose();
});

test('photo shadow receiver cannot replace plate depth or leak exact identity across successful replacement',async()=>{
  const source=await readFile(new URL('../src/studio.js',import.meta.url),'utf8');
  assert.match(source,/new THREE\.ShadowMaterial\(\{ opacity: 0\.28, depthWrite: false \}\)/);
  assert.match(source,/_releaseBackground\(\);\s*this\._backgroundTexture = texture/);
  assert.match(source,/photoIdentity: this\.photoIdentity/);
});


test('impossible optical focus is explicit but preserves raw model preview; disabling DOF clears the error',()=>{
  const {studio,pass,draws}=fixture();
  studio._metadata.sourceUnitsToMm=.001; // camera depth ~0.48mm, virtual lens24mm.
  assert.throws(()=>studio.getPhotoLensDof(),/焦点/);
  studio._drawScene();assert.equal(draws(),1);
  assert.match(studio.photoDofStatus.error,/焦点/);assert.equal(studio.photoDofStatus.lens,null);
  assert.equal(studio.scene.background,studio._backgroundTexture);
  studio.options.dofEnabled=false;studio._drawScene();assert.equal(draws(),2);
  assert.equal(pass.enabled,true,'unblurred linear resolve restores optical pass eligibility');
  assert.deepEqual(studio.photoDofStatus,{error:null,lens:null});
  const off=studio.getPhotoLensDof();assert.equal(off.enabled,false);assert.equal(off.cocRadiusUvCoefficient,0);
  pass.dispose();studio._backgroundTexture.dispose();
});
