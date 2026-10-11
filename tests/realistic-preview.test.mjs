import test from 'node:test';
import assert from 'node:assert/strict';
import { RealisticPreviewRenderer } from '../src/realistic-preview.js';

const id1='12345678-1111-4111-8111-111111111111',id2='12345678-2222-4222-8222-222222222222';
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};};
const tick=()=>new Promise(r=>setTimeout(r,5));
async function until(predicate){for(let i=0;i<200;i++){if(predicate())return;await tick();}throw new Error('Preview did not settle');}
function fixture({prepare,post,decode,snapshot}={}){
  const calls=[],states=[],revoked=[],image={hidden:false,src:'',decode:decode||(async()=>{})};
  let count=0;
  const renderer=new RealisticPreviewRenderer({image,debounceMs:0,intervalMs:1,
    prepare:async desired=>{calls.push(['prepare',desired.progress]);return prepare?prepare(desired):{blob:new Blob(['scene'])};},
    request:async(route,options={})=>{
      calls.push([options.method||'GET',route,options.signal?.aborted]);
      if(options.method==='POST'){const id=++count===1?id1:id2;return post?post(id):{id};}
      if(options.method==='DELETE')return{status:'cancelled'};
      return snapshot?snapshot(route):{id:route.endsWith(id1)?id1:id2,status:'complete',total:1,rendered:1,encoded:1,url:route+'/file'};
    },
    readImage:async(route,{signal})=>{calls.push(['image',route,signal.aborted]);return new Blob(['png'],{type:'image/png'});},
    createURL:()=>`blob:frame-${count}`,revokeURL:url=>revoked.push(url),onState:state=>states.push(state)});
  const update=(key='one',progress=.5,enabled=true)=>renderer.update({enabled,key,width:320,height:180,progress});
  return{renderer,image,calls,states,revoked,update};
}

test('current growth frame becomes a decoded image and its local native file is cleaned up',async()=>{
  const f=fixture();f.update();await until(()=>f.states.some(s=>s.status==='complete'));
  await f.renderer._work;
  assert.equal(f.image.hidden,false);assert.equal(f.image.src,'blob:frame-1');
  assert.deepEqual(f.calls[0],['prepare',.5]);
  assert.ok(f.calls.some(c=>c[0]==='DELETE'&&c[1].endsWith(id1)));
  f.update();await tick();assert.equal(f.calls.filter(c=>c[0]==='POST').length,1);
  await f.renderer.dispose();assert.equal(f.image.hidden,true);assert.deepEqual(f.revoked,['blob:frame-1']);
});

test('an edit immediately hides the old image and replaces it only after decoding the new frame',async()=>{
  const second=deferred();let n=0;const f=fixture({decode:async()=>{if(++n===2)await second.promise;}});
  f.update();await until(()=>!f.image.hidden);f.update('moved',.75);
  assert.equal(f.image.hidden,true);await until(()=>n===2);assert.equal(f.image.hidden,true);
  second.resolve();await until(()=>!f.image.hidden);assert.deepEqual(f.revoked,['blob:frame-1']);
  assert.equal(f.image.src,'blob:frame-2');await f.renderer.dispose();
});

test('switching to realtime during POST obtains and cancels the native job without displaying a stale frame',async()=>{
  const submit=deferred(),f=fixture({post:async id=>{await submit.promise;return{id};}});
  f.update();await until(()=>f.calls.some(c=>c[0]==='POST'));f.update('one',.5,false);
  assert.equal(f.image.hidden,true);submit.resolve();await f.renderer._work;
  assert.ok(f.calls.some(c=>c[0]==='DELETE'&&c[1].endsWith(id1)&&c[2]===undefined));
  assert.equal(f.calls.some(c=>c[0]==='image'),false);await f.renderer.dispose();
});

test('obsolete packaging does not submit and the newest request is the only displayed image',async()=>{
  const pack=deferred();let n=0;const f=fixture({prepare:async()=>{if(++n===1)await pack.promise;return{blob:new Blob(['scene'])};}});
  f.update();await until(()=>n===1);f.update('new',1);pack.resolve();
  await until(()=>f.states.some(s=>s.status==='complete'));await f.renderer._work;
  assert.equal(f.calls.filter(c=>c[0]==='POST').length,1);
  assert.deepEqual(f.calls.filter(c=>c[0]==='prepare').map(c=>c[1]),[.5,1]);await f.renderer.dispose();
});

test('an obsolete decoded image never appears after a model edit',async()=>{
  const decode=deferred();let n=0;const f=fixture({decode:async()=>{if(++n===1)await decode.promise;}});
  f.update();await until(()=>n===1);f.update('edited',0);decode.resolve();
  await until(()=>f.states.some(s=>s.status==='complete'));await f.renderer._work;
  assert.equal(f.image.src,'blob:frame-2');assert.deepEqual(f.revoked,['blob:frame-1']);await f.renderer.dispose();
});

test('invalid completion URLs and incomplete frames never appear and are cleaned up',async()=>{
  for(const patch of [{url:'https://external.test/frame.png'},{total:2},{encoded:0},{rendered:0}]){
    const f=fixture({snapshot:async route=>({id:id1,status:'complete',total:1,rendered:1,encoded:1,url:route+'/file',...patch})});
    f.update();await until(()=>f.states.some(s=>s.status==='error'));await f.renderer._work;
    assert.equal(f.image.hidden,true);assert.equal(f.calls.some(c=>c[0]==='image'),false);
    assert.ok(f.calls.some(c=>c[0]==='DELETE'));await f.renderer.dispose();
  }
});

test('playback hides a completed frame and pausing at the same state reuses its bounded image cache',async()=>{
  const f=fixture();f.update();await until(()=>!f.image.hidden);await f.renderer._work;
  f.update('one',.5,false);assert.equal(f.image.hidden,true);f.update();assert.equal(f.image.hidden,false);
  await tick();assert.equal(f.calls.filter(c=>c[0]==='POST').length,1);await f.renderer.dispose();
});
