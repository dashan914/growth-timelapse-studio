import test from 'node:test';
import assert from 'node:assert/strict';
import { cameraMotionScale } from '../src/camera-motion.js';
import { normalizeExportSound } from '../export-sound.mjs';
import { SOUND_EFFECTS } from '../src/sound-effects.js';
import { stat } from 'node:fs/promises';

test('push amplitude and independent speed clamp and hold without cumulative zoom',()=>{
  const config={motion:'push',pushAmount:40,pushDuration:2};
  assert.equal(cameraMotionScale(0,config),1);
  assert.equal(cameraMotionScale(1,config),1.2);
  assert.equal(cameraMotionScale(2,config),1.4);
  assert.equal(cameraMotionScale(8,config),1.4);
  assert.equal(cameraMotionScale(-5,config),1);
  assert.equal(cameraMotionScale(1,{...config,pushDuration:4}),1.1);
  assert.equal(cameraMotionScale(5,{motion:'fixed'}),1);
  assert.equal(cameraMotionScale(2,{...config,pushAmount:0}),1);
  assert.equal(cameraMotionScale(.25,config),1.05);
  assert.equal(cameraMotionScale(.5,config),1.1);
});
test('export sound accepts only catalog identifiers and bounded parameters',()=>{
  assert.equal(normalizeExportSound({},8).soundEffect,'none');
  assert.throws(()=>normalizeExportSound({soundEffect:'../../foo'},8));
  assert.throws(()=>normalizeExportSound({soundVolume:2},8));
});
test('every selectable sound has a non-empty local file',async()=>{
  for(const sound of SOUND_EFFECTS)assert.ok((await stat(new URL('../assets/sounds/'+sound.file,import.meta.url))).size>1000);
});
