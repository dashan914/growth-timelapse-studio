import test from 'node:test';
import assert from 'node:assert/strict';
import {waitForSlice,parsePrintLayersInWorker} from '../src/slice-client.js';

test('slice polling exposes all phases, propagates failure and aborts cleanly',async()=>{
  const phases=[],states=[{status:'queued'},{status:'slicing'},{status:'complete',gcodeUrl:'/actual'}];
  const result=await waitForSlice({id:'example',request:async()=>states.shift(),intervalMs:1,onSnapshot:state=>phases.push(state.status)});
  assert.equal(result.gcodeUrl,'/actual');assert.deepEqual(phases,['queued','slicing','complete']);
  const abort=new AbortController();
  const pending=waitForSlice({id:'example',request:async()=>{abort.abort();return{status:'slicing'};},signal:abort.signal,intervalMs:10000});
  await assert.rejects(pending,{name:'AbortError'});
});

test('worker result is transferred to caller and cancelled workers stop without retaining source data',async()=>{
  let instance;
  class WorkerMock{
    constructor(url,options){instance=this;assert.equal(options.type,'module');assert.match(url.pathname,/print-layer-worker.js$/);}
    postMessage(message){this.input=message;queueMicrotask(()=>this.onmessage({data:{phase:'complete',parsed:{source:'sliced-gcode'}}}));}
    terminate(){this.stopped=true;}
  }
  const parsed=await parsePrintLayersInWorker('/api/slices/example/gcode',{WorkerClass:WorkerMock});
  assert.equal(parsed.source,'sliced-gcode');assert.equal(instance.stopped,true);
  class PendingWorker extends WorkerMock{postMessage() {}}
  const abort=new AbortController(),pending=parsePrintLayersInWorker(new Blob(['full']),{WorkerClass:PendingWorker,signal:abort.signal});
  abort.abort();await assert.rejects(pending,{name:'AbortError'});assert.equal(instance.stopped,true);
});
