import {pixelSamplingPlan,LinearPixelCoverageAccumulator} from './spatial-sampling.js';

/** Idle-only refinement of ONE current scene revision, never temporal history.
 * drawSample must synchronously save/jitter/draw/restore both camera projections
 * before it returns. Parent must invalidate on every visible scene mutation.
 * A complete straight-alpha result replaces the visible raw canvas; it is never
 * layered over another partially transparent copy of the same geometry.
 */
export class SpatialPreviewRefiner {
  constructor({canvas,host,active=()=>true,drawSample,delayMs=180,passes=4,
    createCanvas=null,yieldToUI=()=>new Promise(resolve=>setTimeout(resolve,0)),
    setTimer=(callback,delay)=>setTimeout(callback,delay),clearTimer=timer=>clearTimeout(timer),onError=()=>{},
  }={}) {
    if(!canvas||!host||typeof drawSample!=='function'||typeof active!=='function')throw new TypeError('静止预览需要画布、容器和同步绘制回调。');
    pixelSamplingPlan(1,1,{scale:1,passes});
    this.canvas=canvas;this.host=host;this.active=active;this.drawSample=drawSample;
    this.delayMs=Math.max(0,Number.isFinite(delayMs)?delayMs:180);this.passes=passes;
    this.yieldToUI=yieldToUI;this.setTimer=setTimer;this.clearTimer=clearTimer;this.onError=onError;
    this.revision=0;this.lastError=null;this._timer=null;this._running=null;this._queued=false;this._displayRevision=null;this._failedRevision=null;this._disposed=false;this._savedOpacity=null;this._pixels=null;
    const make=createCanvas||(()=> (canvas.ownerDocument||globalThis.document).createElement('canvas'));
    this.overlay=make();this.overlay.setAttribute('aria-hidden','true');
    Object.assign(this.overlay.style,{position:'absolute',inset:'0',width:'100%',height:'100%',pointerEvents:'none',display:'none'});
    this.overlay.hidden=true;host.appendChild(this.overlay);
    this.context=this.overlay.getContext('2d',{alpha:true,colorSpace:'srgb',willReadFrequently:true});
    if(!this.context){this.overlay.remove();throw new Error('无法创建静止预览读取画布。');}
  }

  _active(){try{return !this._disposed&&Boolean(this.active());}catch(error){this._error(error);return false;}}
  _error(error){this.lastError=error instanceof Error?error:new Error(String(error));try{this.onError(this.lastError);}catch{/* A diagnostic callback cannot break the render loop. */}}
  _hide(){this.overlay.hidden=true;this.overlay.style.display='none';this._displayRevision=null;if(this._savedOpacity!==null){this.canvas.style.opacity=this._savedOpacity;this._savedOpacity=null;}}

  invalidate(){if(this._disposed)return;this.revision++;if(this._timer!==null){this.clearTimer(this._timer);this._timer=null;}this._queued=false;this._failedRevision=null;this.lastError=null;this._hide();}

  schedule(){
    if(!this._active()||this._displayRevision===this.revision||this._failedRevision===this.revision||this._timer!==null||this._running?.revision===this.revision)return;
    const revision=this.revision;
    this._timer=this.setTimer(()=>{
      this._timer=null;if(!this._active()||revision!==this.revision)return;
      if(this._running){this._queued=true;return;}
      void this._refine(revision);
    },this.delayMs);
  }

  _current(revision,width,height){return this._active()&&revision===this.revision&&this.canvas.width===width&&this.canvas.height===height;}

  async _refine(revision){
    const width=this.canvas.width,height=this.canvas.height;
    let plan;
    // Large or empty canvases keep the live raw image. No automatic resize.
    try{plan=pixelSamplingPlan(width,height,{scale:1,passes:this.passes,maxSourcePixels:8_000_000});}catch{return;}
    if(!this._current(revision,width,height))return;
    const token={revision};this._running=token;
    let accumulator;
    try{
      this.overlay.width=width;this.overlay.height=height;
      accumulator=new LinearPixelCoverageAccumulator(plan);
      for(const jitter of plan.pattern){
        if(!this._current(revision,width,height))return;
        const result=this.drawSample(jitter);
        if(result&&typeof result.then==='function'){Promise.resolve(result).catch(()=>{});throw new Error('静止预览的绘制回调必须同步恢复相机。');}
        if(!this._current(revision,width,height))return;
        this.context.clearRect(0,0,width,height);this.context.imageSmoothingEnabled=false;
        this.context.drawImage(this.canvas,0,0); // 1:1; no encoded-color resize.
        const rgba=this.context.getImageData(0,0,width,height);
        accumulator.addSample(rgba.data,width,height);
        await this.yieldToUI();
      }
      if(!this._current(revision,width,height))return;
      this._pixels=this.context.createImageData(width,height);
      accumulator.finish(this._pixels.data);this.context.putImageData(this._pixels,0,0);
      if(!this._current(revision,width,height))return;
      this._savedOpacity=this.canvas.style.opacity;
      this.overlay.style.opacity=this._savedOpacity;
      this.canvas.style.opacity='0'; // Still receives pointer events under overlay.
      this.overlay.hidden=false;this.overlay.style.display='block';this._displayRevision=revision;
    }catch(error){if(revision===this.revision&&!this._disposed){this._failedRevision=revision;this._hide();this._error(error);}}
    finally{
      accumulator?.reset();this._pixels=null;
      if(this._running===token)this._running=null;
      if(this._queued){this._queued=false;this.schedule();}
    }
  }

  dispose(){if(this._disposed)return;this.invalidate();this._disposed=true;this._hide();this.overlay.remove();this._pixels=null;}
}
