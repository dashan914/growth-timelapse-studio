import test from 'node:test';
import assert from 'node:assert/strict';
import {solvePlanarCamera} from '../src/calibration.js';
import {CAMERA_METRIC_REVISION,migratePhotoCameraMetric} from '../src/camera-cache.js';

const settings={points:[{x:.18,y:.48},{x:.66,y:.43},{x:1.05,y:.81},{x:-.1,y:1.15}],widthPx:1706,heightPx:1279,bedWidth:13.2,bedDepth:12.8,allowOutside:true};

test('identified legacy camera uses the source bed metric while preserving display scale and original cache',()=>{
  const base=solvePlanarCamera(settings);
  for(const scale of [.5,2,4]){
    const legacy=solvePlanarCamera({...settings,bedWidth:settings.bedWidth*scale,bedDepth:settings.bedDepth*scale});
    const camera={position:legacy.position,target:legacy.target,up:legacy.up,fov:legacy.fov,imageSize:legacy.imageSize};
    const before=structuredClone(camera),result=migratePhotoCameraMetric(camera,{modelScale:scale,calibratedCamera:base});
    assert.equal(result.migrated,true);
    for(const field of ['position','target'])for(let i=0;i<3;i++)assert.ok(Math.abs(result.camera[field][i]-base[field][i])<1e-5);
    assert.deepEqual(result.camera.up,camera.up);assert.deepEqual(camera,before);
    assert.equal(migratePhotoCameraMetric(result.camera,{revision:CAMERA_METRIC_REVISION,modelScale:scale,calibratedCamera:base}).camera,result.camera);
  }
});

test('manual orbit, lens, current revision and missing calibration survive exactly',()=>{
  const base=solvePlanarCamera(settings),legacy=solvePlanarCamera({...settings,bedWidth:26.4,bedDepth:25.6});
  const camera={position:legacy.position,target:legacy.target,up:legacy.up,fov:legacy.fov};
  for(const changed of [{...camera,position:camera.position.map((v,i)=>v+(i===0?.2:0))},{...camera,fov:camera.fov+1},{...camera,target:[1,2,3]},{...camera,up:[0,0,1]}]){
    assert.deepEqual(migratePhotoCameraMetric(changed,{modelScale:2,calibratedCamera:base}),{camera:changed,migrated:false});
  }
  for(const extra of [{revision:CAMERA_METRIC_REVISION},{modelScale:1},{calibratedCamera:null},{modelScale:NaN}])assert.equal(migratePhotoCameraMetric(camera,{modelScale:2,calibratedCamera:base,...extra}).migrated,false);
});
