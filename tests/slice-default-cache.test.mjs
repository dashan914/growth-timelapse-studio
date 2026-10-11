import test from 'node:test';
import assert from 'node:assert/strict';
import { sliceLayerDefaultCacheCurrent } from '../src/slice-default-cache.js';
const state=(source,height,reSliced=true)=>({reSliced,sliceSettings:{layerHeightMm:height,fields:{layerHeightMm:{source}}}});
test('new nominal .16 default invalidates old missing-parameter native results only',()=>{
  assert.equal(sliceLayerDefaultCacheCurrent(state('bambu-default',.2)),false);
  assert.equal(sliceLayerDefaultCacheCurrent(state('studio-default',.16)),true);
  assert.equal(sliceLayerDefaultCacheCurrent(state('project',.12)),true);
  assert.equal(sliceLayerDefaultCacheCurrent(state('object',.2)),true);
  assert.equal(sliceLayerDefaultCacheCurrent(state('bambu-default',.2,false)),true,'embedded source paths remain authoritative');
  const embedded=state('bambu-default',.2);embedded.sliceSettings.sourceType='gcode-config';assert.equal(sliceLayerDefaultCacheCurrent(embedded),true);
  assert.equal(sliceLayerDefaultCacheCurrent({}),false);
  assert.equal(sliceLayerDefaultCacheCurrent(state('studio-default',NaN)),false);
});
