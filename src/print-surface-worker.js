import {buildPrintSurfaceLOD,packPrintSurfaceLOD,printSurfaceLODTransferables} from './print-surface-lod.js';
self.onmessage=async({data})=>{
  try{
    const result=await buildPrintSurfaceLOD(data.parsed,{...data.options,onProgress:event=>self.postMessage({type:'progress',...event})});
    const packet=packPrintSurfaceLOD(result);self.postMessage({type:'complete',packet},printSurfaceLODTransferables(packet));
  }catch(error){self.postMessage({type:'error',message:error.message,code:error.name});}
};
