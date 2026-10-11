import test from 'node:test';
import assert from 'node:assert/strict';
import {SpatialPreviewRefiner} from '../src/spatial-preview.js';

const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
function fixture({active=()=>true,draw=null,yieldToUI=()=>Promise.resolve(),pixels=[[255,0,0,255]],opacity='.7',width=1,height=1}={}){
  const timers=new Map();let id=0,draws=0,attached=0,removed=0,puts=0,readCalls=0,lastImage=null;
  const source={width,height,style:{opacity},rgba:Uint8ClampedArray.from(pixels[0])};
  const context={clearRect(){},drawImage(canvas,x,y){assert.equal(canvas,source);assert.equal(x,0);assert.equal(y,0);},getImageData(){readCalls++;return {data:source.rgba.slice()};},createImageData(w,h){return {data:new Uint8ClampedArray(w*h*4)};},putImageData(image){puts++;lastImage=image.data.slice();}};
  const overlay={style:{},hidden:false,width:0,height:0,attrs:{},setAttribute(name,value){this.attrs[name]=value;},getContext:()=>context,remove(){removed++;}};
  const refiner=new SpatialPreviewRefiner({canvas:source,host:{appendChild(value){assert.equal(value,overlay);attached++;}},active,
    drawSample(jitter){if(draw)draw(jitter,draws,source);else source.rgba=Uint8ClampedArray.from(pixels[draws%pixels.length]);draws++;},
    createCanvas:()=>overlay,yieldToUI,setTimer(callback){timers.set(++id,callback);return id;},clearTimer(key){timers.delete(key);},onError(){},delayMs:180});
  return {refiner,source,overlay,timers,runTimer(){const [key,callback]=timers.entries().next().value||[];assert.ok(callback);timers.delete(key);callback();},get draws(){return draws;},get attached(){return attached;},get removed(){return removed;},get puts(){return puts;},get readCalls(){return readCalls;},get lastImage(){return lastImage;}};
}

test('one complete fixed four-sample image replaces raw canvas and preserves premultiplied linear alpha/color',async()=>{
  const f=fixture({pixels:[[255,0,0,255],[0,0,255,0],[0,255,0,0],[255,255,255,0]]});
  assert.equal(f.overlay.attrs['aria-hidden'],'true');assert.equal(f.overlay.style.pointerEvents,'none');assert.equal(f.overlay.style.display,'none');assert.equal(f.attached,1);
  f.refiner.schedule();f.refiner.schedule();assert.equal(f.timers.size,1);f.runTimer();await flush();
  assert.equal(f.draws,4);assert.equal(f.puts,1);assert.deepEqual([...f.lastImage],[255,0,0,64]);
  assert.equal(f.source.style.opacity,'0');assert.equal(f.overlay.style.opacity,'.7');assert.equal(f.overlay.hidden,false);assert.equal(f.overlay.style.display,'block');
  f.refiner.schedule();assert.equal(f.timers.size,0,'same scene never accumulates temporal history or rerenders completed result');
  f.refiner.invalidate();assert.equal(f.source.style.opacity,'.7');assert.equal(f.overlay.hidden,true);assert.equal(f.overlay.style.display,'none');
  f.refiner.dispose();assert.equal(f.removed,1);
});

test('invalidating a partial set cannot display old frame or conceal new live canvas',async()=>{
  let resume;const f=fixture({yieldToUI:()=>new Promise(resolve=>{resume=resolve;})});
  f.refiner.schedule();f.runTimer();assert.equal(f.draws,1);assert.equal(f.puts,0);
  const oldRevision=f.refiner.revision;f.refiner.invalidate();assert.equal(f.refiner.revision,oldRevision+1);assert.equal(f.source.style.opacity,'.7');
  resume();await flush();assert.equal(f.draws,1);assert.equal(f.puts,0);assert.equal(f.overlay.hidden,true);f.refiner.dispose();
});

test('new revision is queued safely behind a stale finite job and uses four NEW samples',async()=>{
  let resume;let block=true;const f=fixture({yieldToUI:()=>block?new Promise(resolve=>{resume=resolve;}):Promise.resolve()});
  f.refiner.schedule();f.runTimer();assert.equal(f.draws,1);f.refiner.invalidate();f.refiner.schedule();f.runTimer();
  assert.equal(f.draws,1,'jobs must not concurrently change the parent projection');
  block=false;resume();await flush();assert.equal(f.timers.size,1);f.runTimer();await flush();
  assert.equal(f.draws,5);assert.equal(f.puts,1);f.refiner.dispose();
});

test('dimensions and active state are checked before further draws and publication',async()=>{
  for(const change of ['dimensions','inactive']){
    let resume,active=true;const f=fixture({active:()=>active,yieldToUI:()=>new Promise(resolve=>{resume=resolve;})});
    f.refiner.schedule();f.runTimer();if(change==='dimensions')f.source.width=2;else active=false;
    resume();await flush();assert.equal(f.draws,1);assert.equal(f.puts,0);assert.equal(f.source.style.opacity,'.7');f.refiner.dispose();
  }
  const large=fixture({width:4000,height:3000});large.refiner.schedule();large.runTimer();await flush();assert.equal(large.draws,0,'over8M canvas keeps raw image without resizing');large.refiner.dispose();
});

test('draw/readback/yield errors and async draw callbacks are contained without publishing partial frame',async()=>{
  const original=new Error('GPU/readback failed');
  for(const mode of ['throw','async','yield']){
    const f=fixture({draw:mode==='throw'?()=>{throw original;}:mode==='async'?()=>Promise.reject(original):null,yieldToUI:mode==='yield'?()=>Promise.reject(original):()=>Promise.resolve()});
    if(mode==='async')f.refiner.drawSample=()=>Promise.reject(original);
    f.refiner.schedule();f.runTimer();await flush();assert.ok(f.refiner.lastError);assert.equal(f.puts,0);assert.equal(f.source.style.opacity,'.7');assert.equal(f.overlay.hidden,true);
    f.refiner.schedule();assert.equal(f.timers.size,0,'failed revision is not retried indefinitely');f.refiner.dispose();
  }
});

test('dispose clears delayed work and rejects publication from already running samples',async()=>{
  const waiting=fixture();waiting.refiner.schedule();waiting.refiner.dispose();assert.equal(waiting.timers.size,0);assert.equal(waiting.source.style.opacity,'.7');
  let resume;const running=fixture({yieldToUI:()=>new Promise(resolve=>{resume=resolve;})});running.refiner.schedule();running.runTimer();running.refiner.dispose();resume();await flush();assert.equal(running.puts,0);assert.equal(running.overlay.hidden,true);assert.equal(running.removed,1);
});


test('revision changes after the fourth sample still reject publication and readback errors remain contained',async()=>{
  let f,yields=0;
  f=fixture({yieldToUI:()=>{if(++yields===4)f.refiner.invalidate();return Promise.resolve();}});
  f.refiner.schedule();f.runTimer();await flush();assert.equal(f.draws,4);assert.equal(f.puts,0);assert.equal(f.source.style.opacity,'.7');f.refiner.dispose();
  const bad=fixture();bad.refiner.context.getImageData=()=>{throw new Error('readback failure');};
  bad.refiner.schedule();bad.runTimer();await flush();assert.match(bad.refiner.lastError.message,/readback/);assert.equal(bad.puts,0);assert.equal(bad.source.style.opacity,'.7');bad.refiner.dispose();
});
