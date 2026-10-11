import test from 'node:test';
import assert from 'node:assert/strict';
import {timelineState, outputSize} from '../src/timeline.js';

test('growth finishes before final hold while camera continues moving', () => {
  assert.deepEqual(timelineState(0, 8, 1.5), {progress:0, rotation:0});
  assert.equal(timelineState(3.25, 8, 1.5).progress, 0.5);
  assert.equal(timelineState(6.5, 8, 1.5).progress, 1);
  assert.equal(timelineState(7, 8, 1.5, 'turntable').progress, 1);
  assert.equal(timelineState(8, 8, 1.5, 'turntable').rotation, Math.PI * 2);
  assert.equal(timelineState(8, 8, 1.5, 'half').rotation, Math.PI);
});
test('timeline clamps outside duration and handles zero growth interval', () => {
  assert.equal(timelineState(-2, 8, 1).progress, 0);
  assert.equal(timelineState(99, 8, 1).progress, 1);
  assert.equal(timelineState(2, 2, 5).progress, 1);
});
test('output sizes have encoder-compatible even dimensions', () => {
  assert.deepEqual(outputSize('16:9',1080), {width:1920,height:1080});
  assert.deepEqual(outputSize('9:16',720), {width:720,height:1280});
  assert.deepEqual(outputSize('1:1',2160), {width:2160,height:2160});
});

test('custom aspect and resolution honor per-axis and pixel-budget limits', () => {
  assert.deepEqual(outputSize('2:1',2160), {width:4096,height:2048});
  assert.deepEqual(outputSize('1:1',4096), {width:2896,height:2896});
  assert.deepEqual(outputSize('4:1',1080), {width:4096,height:1024});
  for (const ratio of ['17:9','9:17','9999:1','1:9999','1e300:1e-300','1e-300:1e300','bad','0:0']) {
    for (const resolution of [719,1080,2160,4096,1000000,0,NaN]) {
      const {width,height} = outputSize(ratio,resolution);
      assert.ok(width > 0 && height > 0 && width % 2 === 0 && height % 2 === 0);
      assert.ok(width <= 4096 && height <= 4096);
      assert.ok(width * height <= 8388608);
    }
  }
  const custom = outputSize('17:9',2160);
  assert.ok(Math.abs(custom.width/custom.height - 17/9) / (17/9) < 0.001);
});
