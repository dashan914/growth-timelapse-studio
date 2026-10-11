import {parsePrintLayerGCode,printLayerTransferables} from './print-layer.js';

self.onmessage = async ({data}) => {
  try {
    self.postMessage({phase:'reading'});
    let text;
    if(data.file instanceof Blob) text=await data.file.text();
    else {
      const url=new URL(data.url,self.location.href);
      if(url.origin!==self.location.origin || !/^\/api\/slices\/[\da-f-]{36}\/gcode$/.test(url.pathname)) throw new Error('真实切片只能从本机任务读取。');
      const response=await fetch(url);
      if(!response.ok)throw new Error('切片路径读取失败，请重新准备。');
      text=await response.text();
    }
    self.postMessage({phase:'parsing'});
    const parsed=parsePrintLayerGCode(text,{includeSupport:true,maxTextBytes:768*1024*1024});
    self.postMessage({phase:'complete',parsed},printLayerTransferables(parsed));
  }catch(error){self.postMessage({phase:'error',message:error.message});}
};
