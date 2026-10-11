import { validateSlicedThreeMFFile } from './sliced-3mf.js';

export function loadSlicedThreeMFInWorker(file,{signal,onProgress=()=>{},WorkerClass=globalThis.Worker}={}){
  return new Promise((resolve,reject)=>{
    let worker,settled=false;
    const stop=()=>{worker?.terminate();signal?.removeEventListener('abort',abort);};
    const fail=error=>{if(settled)return;settled=true;stop();reject(error);};
    const abort=()=>fail(new DOMException('Aborted','AbortError'));
    try{
      if(signal?.aborted){abort();return;}
      validateSlicedThreeMFFile(file);
      if(typeof WorkerClass!=='function')throw new Error('当前浏览器无法后台读取完整切片，请使用支持 Web Worker 的本机浏览器。');
      worker=new WorkerClass(new URL('./sliced-3mf-worker.js',import.meta.url),{type:'module'});
      signal?.addEventListener('abort',abort,{once:true});
      worker.onerror=event=>fail(new Error(event.message||'完整切片后台读取失败。'));
      worker.onmessage=({data})=>{
        if(settled)return;
        if(data.type==='error'){const error=new Error(data.message);error.code=data.code;fail(error);}
        else if(data.type==='complete'){
          settled=true;stop();
          // Keep exactly the File supplied by the user. No browser source mesh
          // buffer is posted/transferred and no original archive is rewritten.
          resolve({...data.result,sourceModelBlob:file,sourceModelFile:file});
        }else if(data.type==='progress'){try{const {type,...event}=data;onProgress(event);}catch(error){fail(error);}}
      };
      worker.postMessage({file}); // Blob clone, deliberately no transfer list.
    }catch(error){fail(error);}
  });
}
