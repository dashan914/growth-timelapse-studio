export function preparePrintSurfaceLOD(parsed,{signal,onProgress,...options}={}) {
  if(signal?.aborted)return Promise.reject(new DOMException('Aborted','AbortError'));
  const worker=new Worker(new URL('./print-surface-worker.js',import.meta.url),{type:'module'});
  return new Promise((resolve,reject)=>{
    const finish=(value,error)=>{worker.terminate();signal?.removeEventListener('abort',abort);error?reject(error):resolve(value);};
    const abort=()=>finish(null,new DOMException('Aborted','AbortError'));signal?.addEventListener('abort',abort,{once:true});
    worker.onerror=()=>finish(null,new Error('连续模型表面处理失败，原始切片已保留。'));
    worker.onmessage=({data})=>{if(data.type==='progress')onProgress?.(data);else if(data.type==='complete')finish(data.packet);else if(data.type==='error')finish(null,new Error(data.message));};
    // Keep original typed source ownership; only one worker copy is staged.
    worker.postMessage({parsed,options});
  });
}
