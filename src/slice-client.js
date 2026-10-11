export function parsePrintLayersInWorker(input,{signal,onPhase=()=>{},WorkerClass=globalThis.Worker}={}) {
  return new Promise((resolve,reject)=>{
    if(signal?.aborted){reject(new DOMException('Aborted','AbortError'));return;}
    const worker=new WorkerClass(new URL('./print-layer-worker.js',import.meta.url),{type:'module'});
    const stop=()=>{worker.terminate();signal?.removeEventListener('abort',abort);};
    const abort=()=>{stop();reject(new DOMException('Aborted','AbortError'));};
    signal?.addEventListener('abort',abort,{once:true});
    worker.onerror=event=>{stop();reject(new Error(event.message||'切片路径读取失败。'));};
    worker.onmessage=({data})=>{
      if(data.phase==='complete'){stop();resolve(data.parsed);}
      else if(data.phase==='error'){stop();reject(new Error(data.message));}
      else onPhase(data.phase);
    };
    worker.postMessage(typeof input==='string'?{url:input}:{file:input});
  });
}

export async function waitForSlice({id,request,signal,onSnapshot=()=>{},intervalMs=750}) {
  while(true){
    if(signal?.aborted)throw new DOMException('Aborted','AbortError');
    const state=await request(`/api/slices/${id}`);
    onSnapshot(state);
    if(['complete','cancelled','failed','error'].includes(state.status))return state;
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},intervalMs);
      const abort=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(new DOMException('Aborted','AbortError'));};
      signal?.addEventListener('abort',abort,{once:true});
      if(signal?.aborted)abort();
    });
  }
}
