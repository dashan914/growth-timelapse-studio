import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {PreviewSoundPlayer} from '../src/preview-sound-player.js';

const settle=()=>new Promise(resolve=>setImmediate(resolve));
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}
function fixture({slowDecode=false,failFirstFetch=false}={}){
  const sources=[],errors=[],states=[],decode=deferred();let fetches=0,decodes=0,resumes=0;
  const context={state:'suspended',currentTime:100,destination:{},
    createGain:()=>({gain:{value:1},connect(){}}),
    resume(){resumes++;this.state='running';return Promise.resolve();},close(){this.state='closed';return Promise.resolve();},
    decodeAudioData(){decodes++;return slowDecode?decode.promise:Promise.resolve({duration:7.64});},
    createBufferSource(){const node={starts:[],stops:0,disconnects:0,connect(){},disconnect(){this.disconnects++;},start(...args){this.starts.push(args);},stop(){this.stops++;}};sources.push(node);return node;}};
  const player=new PreviewSoundPlayer({url:'/reference.wav',createContext:()=>context,
    fetchAudio:async()=>{fetches++;if(failFirstFetch&&fetches===1)throw new Error('offline');return{ok:true,arrayBuffer:async()=>new ArrayBuffer(16)};},
    onError:error=>errors.push(error),onState:state=>states.push(state)});
  const update=(time,playing=true,enabled=true)=>player.update({time,playing,enabled,volume:1});
  return{player,context,sources,errors,states,decode,update,get fetches(){return fetches;},get decodes(){return decodes;},get resumes(){return resumes;}};
}

test('cold loading starts at the latest timeline offset, never the stale initial offset',async()=>{
  const f=fixture({slowDecode:true});f.update(2);const unlocking=f.player.unlock();await settle();
  f.update(5);f.update(1);f.decode.resolve({duration:7.64});await unlocking;await settle();
  assert.equal(f.sources.length,1);assert.deepEqual(f.sources[0].starts,[[0,1]]);assert.equal(f.fetches,1);
});
test('closing or pausing before decode completes cannot start an old request',async()=>{
  for(const enabled of [true,false]){
    const f=fixture({slowDecode:true});f.update(3);await f.player.unlock();await settle();
    f.update(4,false,enabled);f.decode.resolve({duration:7.64});await settle();
    assert.equal(f.sources.length,0);assert.equal(f.player.snapshot().active,false);assert.equal(f.fetches,1);
  }
});
test('rapid sound toggles and pause/seek/resume reuse one decoded buffer and one active source',async()=>{
  const f=fixture();f.update(3,false);await f.player.unlock();await settle();
  f.update(3);assert.deepEqual(f.sources[0].starts,[[0,3]]);
  f.update(3,false);f.update(5,false,false);f.update(1,false,true);f.update(1);
  assert.equal(f.sources[0].stops,1);assert.equal(f.sources.length,2);assert.deepEqual(f.sources[1].starts,[[0,1]]);
  assert.equal(f.fetches,1);assert.equal(f.decodes,1);
  f.update(1,true,false);assert.equal(f.sources[1].stops,1);assert.equal(f.player.snapshot().active,false);
});
test('ordinary frame updates do not repeatedly recreate a source; a real discontinuity does',async()=>{
  const f=fixture();f.update(2,false);await f.player.unlock();await settle();f.update(2);
  for(let i=1;i<30;i++){f.context.currentTime=100+i/30;f.update(2+i/30);}
  assert.equal(f.sources.length,1);
  f.update(4);assert.equal(f.sources.length,2);assert.equal(f.sources[0].stops,1);assert.deepEqual(f.sources[1].starts,[[0,4]]);
});
test('the once-only track is silent after its end, and seeking back uses the correct offset',async()=>{
  const f=fixture();f.update(6,false);await f.player.unlock();await settle();f.update(6);
  f.update(9);assert.equal(f.sources[0].stops,1);assert.equal(f.player.snapshot().status,'ended');
  f.update(10);assert.equal(f.sources.length,1);
  f.update(3);assert.deepEqual(f.sources[1].starts,[[0,3]]);assert.equal(f.fetches,1);
});
test('a loading failure can retry on the next explicit user play without retrying every frame',async()=>{
  const f=fixture({failFirstFetch:true});f.update(3);await settle();assert.equal(f.fetches,1);
  f.update(4);f.update(5);assert.equal(f.fetches,1);assert.equal(f.errors.length,1);
  await f.player.unlock();await settle();assert.equal(f.fetches,2);assert.deepEqual(f.sources[0].starts,[[0,5]]);
});
test('disposing before decode completes never starts a source',async()=>{
  const f=fixture({slowDecode:true});f.update(3);await f.player.unlock();await settle();f.player.dispose();
  f.decode.resolve({duration:7.64});await settle();assert.equal(f.sources.length,0);assert.equal(f.player.snapshot().status,'closed');
});
test('prepared model playback unlocks audio directly in the click callback',()=>{
  const source=readFile(new URL('../src/app.js',import.meta.url),'utf8');
  return source.then(text=>{
    const start=text.indexOf('async function playGrowth('),body=text.slice(start,text.indexOf('\n}',start)+2),order=[];
    const context=vm.createContext({playing:false,loading:false,modelRevision:1,time:8,
      studio:{getPrintLayerData:()=>({})},validatePlaybackColors:()=>true,settings:()=>({duration:8}),
      setModelMode(){order.push('framing');},showTime(){order.push('play');},unlockPreviewSound(){order.push('unlock');},ensureModelSlice:async()=>{order.push('async-slice');return true;}});
    vm.runInContext(body,context);context.playGrowth();assert.deepEqual(order,['framing','unlock','play']);assert.equal(context.time,0);
  });
});
