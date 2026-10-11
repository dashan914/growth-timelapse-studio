import { parseSlicedThreeMF, validateSlicedThreeMFFile } from './sliced-3mf.js';
import { printLayerTransferables } from './print-layer.js';
import { buildPrintSurfaceLOD, packPrintSurfaceLOD, printSurfaceLODTransferables } from './print-surface-lod.js';

self.onmessage=async({data})=>{
  const report=event=>self.postMessage({type:'progress',...event});
  try{
    const file=data.file;validateSlicedThreeMFFile(file);
    report({phase:'reading',completed:0,total:file.size,unit:'bytes',progress:0});
    const bytes=new Uint8Array(file.size);
    if(file.stream){
      const reader=file.stream().getReader();let offset=0;
      try{for(;;){const {value,done}=await reader.read();if(done)break;if(offset+value.length>bytes.length)throw new Error('原文件读取大小发生变化。');bytes.set(value,offset);offset+=value.length;report({phase:'reading',completed:offset,total:file.size,unit:'bytes',progress:offset/file.size});}if(offset!==bytes.length)throw new Error('原文件未完整读取。');}
      finally{reader.releaseLock();}
    }else{bytes.set(new Uint8Array(await file.arrayBuffer()));report({phase:'reading',completed:file.size,total:file.size,unit:'bytes',progress:1});}
    const result=await parseSlicedThreeMF(bytes,{fileName:file.name,onProgress:report});
    let displayTransfer=[];
    if(!result.hasCad){
      report({phase:'surface',completed:0,total:1,unit:'steps',progress:0,message:'正在生成抗摩尔纹连续表面…'});
      try {
        const surface=await buildPrintSurfaceLOD(result.parsed,{onProgress:event=>report({...event,phase:'surface',progress:event.total?event.completed/event.total:null,message:'正在生成连续表面，保护边角和颜色边界…'})});
        result.displaySurfaceLOD=packPrintSurfaceLOD(surface);displayTransfer=printSurfaceLODTransferables(result.displaySurfaceLOD);
      }catch(error){
        result.displaySurfaceError=error.message;
        report({phase:'surface',message:'已保留原始切片显示，连续表面优化将在模型载入后重试。'});
      }
    }
    self.postMessage({type:'complete',result},[...printLayerTransferables(result.parsed),...displayTransfer]);
  }catch(error){self.postMessage({type:'error',code:error.code||'SLICED_3MF_READ_FAILED',message:error.message||'原切片读取失败，未重新切片。'});}
};
