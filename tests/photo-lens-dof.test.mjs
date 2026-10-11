import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { photoLensDofReference, photoLensDofEstimate, photoLensSensorRegion, photoLensAperture, thinLensCoCDiameterMm,
  thinLensCoCDiameterPixels, focusFromCompleteModelBounds, resolvePhotoLensDof, photoLensCoCAtDepth } from '../src/photo-lens-dof.js';
import { getPresetDof } from '../src/preset-dof.js';

function sourceCamera() {
  const camera = new THREE.PerspectiveCamera(2*Math.atan(24/(2*24))*180/Math.PI,4/3,.001,20);
  camera.updateProjectionMatrix(); return camera;
}

test('thin lens has zero blur at focus, proportional aperture, squared focal contribution and correct far limit', () => {
  const optics={focalLengthMm:24,fNumber:2.8,focusDistanceMm:500};
  assert.equal(thinLensCoCDiameterMm({...optics,depthMm:500}),0);
  const far=thinLensCoCDiameterMm({...optics,depthMm:1000});
  assert.ok(Math.abs(far-576*500/(2.8*1000*476))<1e-12);
  assert.equal(thinLensCoCDiameterMm({...optics,fNumber:5.6,depthMm:1000}),far/2);
  assert.ok(thinLensCoCDiameterMm({...optics,depthMm:Infinity})>far);
  assert.ok(Math.abs(thinLensCoCDiameterMm({...optics,depthMm:Infinity})-576/(2.8*476))<1e-12);
  assert.throws(()=>thinLensCoCDiameterMm({...optics,focusDistanceMm:20,depthMm:100}),/焦点/);
  assert.throws(()=>thinLensCoCDiameterMm({...optics,depthMm:0}),/深度/);
  assert.throws(()=>thinLensCoCDiameterMm({...optics,fNumber:0,depthMm:100}),/光圈/);
});

test('only exact P1S and A1 assets receive independently accepted visual aperture estimates, never EXIF facts',()=>{
  const projection=sourceCamera().projectionMatrix;
  for(const [photoIdentity,strength] of [['preset:p1s',12],['preset:a1',16]]){
    const estimate=photoLensDofEstimate(photoIdentity),before={...estimate};
    assert.equal(estimate.measured,false);assert.equal(photoLensDofReference(photoIdentity),null);
    const common={projectionMatrix:projection,worldToMm:1000,focusDistanceWorld:.5,imageHeightPx:1080,dofEnabled:true,photoIdentity,dofStrength:strength};
    const lens=resolvePhotoLensDof(common);
    assert.equal(lens.fNumber,4);assert.equal(lens.apertureSource,'visual-estimate');assert.equal(lens.reference,null);
    assert.equal(lens.focusMeasured,false);assert.equal(lens.referenceFocalLengthMm,null);assert.equal(lens.focalMatchesReference,null);
    const adjusted=resolvePhotoLensDof({...common,dofStrength:strength*4});
    assert.equal(adjusted.fNumber,2);assert.equal(adjusted.apertureSource,'virtual-adjustment-from-visual-estimate');
    assert.equal(adjusted.focusDistanceMm,lens.focusDistanceMm);
    assert.deepEqual(estimate,before);
    const custom=resolvePhotoLensDof({...common,photoIdentity:'custom:'+photoIdentity});
    assert.equal(custom.fNumber,18/(1+2*strength/100));assert.equal(custom.estimate,undefined,'a custom photo does not borrow preset estimation');
    estimate.fNumber=50;assert.equal(photoLensDofEstimate(photoIdentity).fNumber,4);
  }
  assert.equal(photoLensDofEstimate('P1S.jpg'),null);
  assert.equal(photoLensDofEstimate('preset:h2c'),null,'known EXIF remains the separate reference branch');
});

test('exact generated table backgrounds use conservative visual apertures without borrowing EXIF or blurring photo pixels', () => {
  const projectionMatrix = sourceCamera().projectionMatrix;
  const lenses = {};
  for (const [key, fNumber] of [['pastel-rug', 8], ['blue-grey', 8], ['teal-room', 5.6]]) {
    const photoIdentity = `preset:${key}`, dof = getPresetDof(key);
    const estimate = photoLensDofEstimate(photoIdentity);
    assert.equal(estimate.sourcePhoto, `assets/backgrounds/${key}.png`);
    assert.equal(estimate.measured, false);
    assert.equal(estimate.apertureSource, 'visual-estimate');
    assert.equal(photoLensDofReference(photoIdentity), null, 'generated photos have no recovered EXIF');
    assert.equal(estimate.referenceStrength, dof.dofStrength, 'preset strength resolves its matching virtual aperture');
    const common = { projectionMatrix, worldToMm: 1000, focusDistanceWorld: .5, imageHeightPx: 1080, photoIdentity, ...dof };
    const lens = resolvePhotoLensDof(common);
    assert.equal(lens.fNumber, fNumber);
    assert.equal(lens.apertureSource, 'visual-estimate');
    assert.equal(lens.sensorSource, 'full-frame-visual-estimate');
    assert.equal(lens.estimated, true);
    assert.equal(lens.focusMeasured, false);
    assert.equal(lens.referenceFocalLengthMm, null);
    assert.equal(lens.photoPixelsProtected, true);
    assert.ok(lens.assumptions.includes('no repeated background blur'));
    for (const depthWorld of [.42, .5, .58]) assert.ok(photoLensCoCAtDepth(lens, depthWorld).diameterPixels < 3, 'a representative full product depth stays readable');
    assert.equal(photoLensCoCAtDepth(lens, .5).diameterPixels, 0, 'focus plane remains sharp');
    const custom = resolvePhotoLensDof({ ...common, photoIdentity: `custom:${key}.png` });
    assert.equal(custom.estimate, undefined, 'custom uploads cannot borrow an exact background preset');
    estimate.fNumber = 1;
    assert.equal(photoLensDofEstimate(photoIdentity).fNumber, fNumber);
    assert.equal(photoLensDofEstimate(`${key}.png`), null);
    lenses[key] = lens;
  }
  assert.ok(photoLensCoCAtDepth(lenses['teal-room'], .7).diameterPixels > photoLensCoCAtDepth(lenses['blue-grey'], .7).diameterPixels);
  assert.equal(photoLensDofReference('preset:h2c').fNumber, 2.8, 'known EXIF reference stays separate and unchanged');
});

test('digital vertical crop preserves the physical focal length and sensor CoC while magnifying its pixel diameter', () => {
  const full=sourceCamera();
  const uncropped=photoLensSensorRegion({projectionMatrix:full.projectionMatrix});
  assert.ok(Math.abs(uncropped.physicalFocalLengthMm-24)<1e-12);
  const crop=full.clone();crop.setViewOffset(4/3,1,.2*(4/3),.15,.5*(4/3),.5);
  const cropped=photoLensSensorRegion({projectionMatrix:crop.projectionMatrix,sourceUV:{repeatX:.5,repeatY:.5,offsetX:.2,offsetY:.35}});
  assert.equal(cropped.effectiveSensorHeightMm,12);
  assert.ok(Math.abs(cropped.physicalFocalLengthMm-24)<1e-12);
  assert.deepEqual(cropped.projectionShift,[crop.projectionMatrix.elements[8],crop.projectionMatrix.elements[9]]);
  assert.ok(Math.abs(2*cropped.physicalFocalLengthMm/cropped.effectiveSensorHeightMm-crop.projectionMatrix.elements[5])<1e-12);
  const optics={focalLengthMm:24,fNumber:2.8,focusDistanceMm:500,depthMm:1000,imageHeightPx:1080};
  const fullPixels=thinLensCoCDiameterPixels({...optics,sensorHeightMm:24});
  const cropPixels=thinLensCoCDiameterPixels({...optics,sensorHeightMm:12});
  assert.equal(cropPixels,fullPixels*2,'same optical disk is magnified by the digital crop');
  const wrong=thinLensCoCDiameterPixels({...optics,focalLengthMm:48,sensorHeightMm:24});
  assert.ok(wrong>cropPixels*2,'old P5 with uncropped sensor falsely changes physical defocus');
  const horizontal=full.clone();horizontal.setViewOffset(4/3,1,.25*(4/3),0,.5*(4/3),1);
  assert.ok(Math.abs(photoLensSensorRegion({projectionMatrix:horizontal.projectionMatrix,sourceUV:{repeatX:.5,repeatY:1}}).physicalFocalLengthMm-24)<1e-12);
});

test('millimetre, metre and normalized scene units yield identical physical CoC, independent of the model display scale parameter', () => {
  const projectionMatrix=sourceCamera().projectionMatrix;
  const common={projectionMatrix,sourceUV:{repeatY:1},dofEnabled:true,dofStrength:10,photoIdentity:'preset:h2c',imageHeightPx:1080};
  const mm=resolvePhotoLensDof({...common,worldToMm:1,focusDistanceWorld:500});
  const metres=resolvePhotoLensDof({...common,worldToMm:1000,focusDistanceWorld:.5});
  const normalized=resolvePhotoLensDof({...common,worldToMm:25,focusDistanceWorld:20,modelScale:.5});
  assert.equal(mm.focusDistanceMm,metres.focusDistanceMm);assert.equal(mm.focusDistanceMm,normalized.focusDistanceMm);
  assert.deepEqual(photoLensCoCAtDepth(mm,700),photoLensCoCAtDepth(metres,.7));
  assert.deepEqual(photoLensCoCAtDepth(mm,700),photoLensCoCAtDepth(normalized,28));
  const coc=photoLensCoCAtDepth(mm,700);
  assert.ok(Math.abs(coc.radiusUvY-mm.cocRadiusUvCoefficient*Math.abs(700-500)/700)<1e-12,'shared shader coefficient uses axis-depth ratio with explicit scene metric');
  assert.ok(Math.abs(coc.diameterPixels-coc.radiusUvY*2*1080)<1e-12);
});

test('focus uses complete camera-axis bounds without tracking growth, support extents or Euclidean camera distance', () => {
  const bounds=new THREE.Box3(new THREE.Vector3(-20,-40,-700),new THREE.Vector3(20,40,-300));
  const worldToCamera=new THREE.Matrix4(), original=bounds.clone();
  const inputs={bounds,worldToCamera,worldToMm:1,focusPercent:40};
  const focus=focusFromCompleteModelBounds(inputs);
  assert.equal(focus.focusDistanceWorld,460);assert.equal(focus.focusDistanceMm,460);
  assert.equal(focus.focusMeasured,false);
  for(const progress of [0,.25,.5,.75,1]) assert.deepEqual(focusFromCompleteModelBounds({...inputs,progress,supportBounds:{min:[-1000,-1000,-1500],max:[1000,1000,-100]}}),focus);
  assert.ok(bounds.equals(original),'focus analysis cannot rewrite the source bounds');
  assert.equal(focusFromCompleteModelBounds({...inputs,focusPercent:0}).focusDistanceMm,300);
  assert.equal(focusFromCompleteModelBounds({...inputs,focusPercent:100}).focusDistanceMm,700);
  assert.throws(()=>focusFromCompleteModelBounds({...inputs,bounds:{min:[0,0,1],max:[1,1,2]}}),/前方/);
});

test('H2C exact-photo reference maps strength10 to f2.8, with estimated focus and honest unknown/mismatch provenance', () => {
  const reference=photoLensDofReference('preset:h2c');
  assert.equal(reference.focalLengthMm,24);assert.equal(reference.fNumber,2.8);assert.equal(reference.defaultFocusPercent,40);
  assert.equal(photoLensDofReference('preset:p1s'),null);assert.equal(photoLensDofReference('preset:a1'),null);
  assert.equal(photoLensDofReference('h2c.jpg'),null);assert.equal(photoLensDofReference('custom:b769'),null);
  assert.equal(photoLensAperture({enabled:true,strength:10,reference}).fNumber,2.8);
  assert.ok(photoLensAperture({enabled:true,strength:40,reference}).fNumber<2.8);
  assert.equal(photoLensAperture({enabled:true,strength:40,reference}).apertureSource,'virtual-adjustment-from-photo-reference');
  assert.equal(photoLensAperture({enabled:true,strength:10}).fNumber,15);
  assert.equal(photoLensAperture({enabled:true,strength:10}).apertureSource,'visual-estimate');
  assert.equal(photoLensAperture({enabled:true,strength:0,reference}).enabled,false);
  const common={projectionMatrix:sourceCamera().projectionMatrix,worldToMm:1000,focusDistanceWorld:.5,imageHeightPx:1080,dofEnabled:true,dofStrength:10};
  const known=resolvePhotoLensDof({...common,photoIdentity:'preset:h2c'});
  assert.equal(known.focalMatchesReference,true);assert.equal(known.apertureSource,'photo-exif-reference');assert.equal(known.focusMeasured,false);
  const unknown=resolvePhotoLensDof({...common,photoIdentity:'custom:b769'});
  assert.equal(unknown.reference,null);assert.equal(unknown.fNumber,15);assert.equal(unknown.focalMatchesReference,null);
  const altered=sourceCamera();altered.fov=30;altered.updateProjectionMatrix();
  const virtual=resolvePhotoLensDof({...common,projectionMatrix:altered.projectionMatrix,photoIdentity:'preset:h2c'});
  assert.equal(virtual.focalMatchesReference,false);assert.ok(virtual.focalReferenceMismatchRatio>.5);
  assert.ok(virtual.physicalFocalLengthMm>24,'helper honors the projection instead of secretly reframing it to EXIF');
  const off=resolvePhotoLensDof({...common,dofEnabled:false,photoIdentity:'preset:h2c'});
  assert.deepEqual(photoLensCoCAtDepth(off,.7),{sensorDiameterMm:0,diameterPixels:0,radiusUvY:0});
});
