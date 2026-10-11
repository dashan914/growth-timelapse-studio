// Independent sampling helper; no scene, exporter, frame history or geometry
// mutation. Fixed 4/8/16/32 rotated layouts reference installed Three.js
// SSAARenderPass (MIT; three.js authors; node_modules/three/LICENSE).
const ROTATED_LAYOUTS = Object.freeze({
  4: [[-2,-6],[6,-2],[-6,2],[2,6]],
  8: [[1,-3],[-1,3],[5,1],[-3,-5],[-5,5],[-7,-1],[3,7],[7,-7]],
  16: [[1,1],[-1,-3],[-3,2],[4,-1],[-5,-2],[2,5],[5,3],[3,-5],[-2,6],[0,-7],[-4,-6],[-6,4],[-8,0],[7,-4],[6,7],[-7,-8]],
  32: [[-4,-7],[-7,-5],[-3,-5],[-5,-4],[-1,-4],[-2,-2],[-6,-1],[-4,0],[-7,1],[-1,2],[-6,3],[-3,3],[-7,6],[-3,6],[-5,7],[-1,7],[5,-7],[1,-6],[6,-5],[4,-4],[2,-3],[7,-2],[1,-1],[4,-1],[2,1],[6,2],[0,4],[4,4],[2,5],[7,5],[5,6],[3,7]],
});
const finite = (value,label) => { if (typeof value!=='number'||!Number.isFinite(value)) throw new TypeError(label+' must be finite');return value; };
const dimension = value => { if (!Number.isInteger(value)||value<1||value>8192) throw new RangeError('Pixel dimensions must be integers in1..8192');return value; };

/** Offsets are in RENDER pixels, not final pixels or camera.view units.
 * Pattern and equal weights never depend on animation time/frame index.
 * Center the integer16 layout's tiny lattice bias without enlarging half-pixel
 * extent; other patterns are already centered. */
export function fixedPixelJitterPattern(samples=4) {
  const layout=ROTATED_LAYOUTS[samples];if (!layout) throw new RangeError('Fixed jitter supports4,8,16 or32 passes');
  const centroid=layout.reduce((sum,value)=>[sum[0]+value[0]/layout.length,sum[1]+value[1]/layout.length],[0,0]);
  return Object.freeze(layout.map(value=>Object.freeze({ x:(value[0]-centroid[0])/16,y:(value[1]-centroid[1])/16,weight:1/layout.length })));
}

/** Compose a pixel jitter with normalized or pixel-unit off-center views.
 * A view.offset unit may describe one whole photo height. Convert the jitter
 * through view.width/renderWidth, rather than adding a raw pixel to it. */
export function composePixelJitterView(originalView,renderWidth,renderHeight,jitter) {
  dimension(renderWidth);dimension(renderHeight);const x=finite(jitter.x,'jitter.x'),y=finite(jitter.y,'jitter.y');
  if (Math.abs(x)>.5||Math.abs(y)>.5) throw new RangeError('Jitter must stay within half a render pixel');
  const view=originalView?.enabled?{...originalView}:{enabled:true,fullWidth:renderWidth,fullHeight:renderHeight,offsetX:0,offsetY:0,width:renderWidth,height:renderHeight};
  for (const key of ['fullWidth','fullHeight','offsetX','offsetY','width','height']) finite(view[key],'camera.view.'+key);
  if (view.fullWidth<=0||view.fullHeight<=0||view.width<=0||view.height<=0) throw new RangeError('Invalid camera source view');
  return {...view,enabled:true,offsetX:view.offsetX+x*view.width/renderWidth,offsetY:view.offsetY+y*view.height/renderHeight};
}

/** Alternative hook AFTER the exporter has set its final camera projection.
 * This creates an independent projection; P0/P5/near/far and source pose stay
 * unchanged. Positive x samples to the pixel right, positive y downward.
 * Caller must update its camera.projectionMatrixInverse and restore both in
 * finally; calling updateProjectionMatrix afterwards would erase this jitter. */
export function pixelJitterProjection(base,renderWidth,renderHeight,jitter) {
  dimension(renderWidth);dimension(renderHeight);const values=base?.elements||base;
  if (!(Array.isArray(values)||ArrayBuffer.isView(values))||values.length!==16||Array.from(values).some(value=>!Number.isFinite(value))) throw new TypeError('Complete perspective projection required');
  if (Math.abs(values[11]+1)>1e-8||Math.abs(values[15])>1e-8) throw new TypeError('Only perspective projection supported by this hook');
  const x=finite(jitter.x,'jitter.x'),y=finite(jitter.y,'jitter.y');if (Math.abs(x)>.5||Math.abs(y)>.5) throw new RangeError('Jitter exceeds half a render pixel');
  const result=Float64Array.from(values);result[8]+=2*x/renderWidth;result[9]-=2*y/renderHeight;return result;
}

export function pixelSamplingPlan(width,height,{scale=2,passes=4,maxSourcePixels=8_388_608,maxSize=8192}={}) {
  dimension(width);dimension(height);if (![1,2,4].includes(scale)) throw new RangeError('Explicit scale1,2 or4 required');
  const pattern=fixedPixelJitterPattern(passes),renderWidth=width*scale,renderHeight=height*scale;
  finite(maxSourcePixels,'maxSourcePixels');finite(maxSize,'maxSize');
  if (maxSourcePixels<=0||maxSize<=0||renderWidth>Math.min(8192,maxSize)||renderHeight>Math.min(8192,maxSize)||renderWidth*renderHeight>Math.min(8_388_608,maxSourcePixels)) throw new RangeError('Sampling source exceeds pixel budget; choose explicit smaller scale rather than deleting geometry');
  return Object.freeze({width,height,renderWidth,renderHeight,scale,passes,pattern,nominalColorSamplesPerFinalPixel:scale*scale*passes,sourcePixelsPerPass:renderWidth*renderHeight,totalRasterPixelsPerFrame:renderWidth*renderHeight*passes,accumulatorBytes:width*height*4*4,sourceRgbaReadbackBytes:renderWidth*renderHeight*4,finalRgbaBytes:width*height*4,temporalHistory:false});
}

const SRGB_TO_LINEAR=Float64Array.from({length:256},(_,byte)=>{const value=byte/255;return value<=.04045?value/12.92:((value+.055)/1.055)**2.4;});
const LINEAR_TO_SRGB=Uint8Array.from({length:65536},(_,value)=>{const linear=value/65535;return Math.round(255*(linear<=.0031308?12.92*linear:1.055*linear**(1/2.4)-.055));});
const encode=value=>LINEAR_TO_SRGB[Math.round(value*65535)];

/** One animation-frame accumulator of NEW scene samples, not a PNG blur.
 * Input contract: straight-alpha sRGB RGBA8, same complete source rectangle in
 * every sample. Decode RGB once per source texel, average premultiplied LINEAR
 * light/coverage, unpremultiply and encode only after all passes are present.
 * This has no knowledge of tool colors, source meshes or path tables.
 */
export class LinearPixelCoverageAccumulator {
  constructor(plan) {
    this.plan=pixelSamplingPlan(plan.width,plan.height,{scale:plan.scale,passes:plan.passes,maxSourcePixels:plan.renderWidth*plan.renderHeight});
    this.sums=new Float32Array(plan.width*plan.height*4);this.count=0;this.sourceRanges=new WeakMap();
  }
  addSample(source,sourceWidth=this.plan.renderWidth,sourceHeight=this.plan.renderHeight) {
    if (this.count>=this.plan.passes) throw new Error('This frame already has all samples; reset before next growth frame');
    if (sourceWidth!==this.plan.renderWidth||sourceHeight!==this.plan.renderHeight) throw new Error('Sample framing/dimensions differ from the frozen plan');
    if (!(source instanceof Uint8Array||source instanceof Uint8ClampedArray)||source.length!==sourceWidth*sourceHeight*4) throw new TypeError('Complete straight-alpha sRGB RGBA8 sample required');
    if(source.buffer===this.sums.buffer)throw new TypeError('Source sample cannot alias accumulation memory');
    const ranges=this.sourceRanges.get(source.buffer)||[];ranges.push([source.byteOffset,source.byteOffset+source.byteLength]);this.sourceRanges.set(source.buffer,ranges);
    const scale=this.plan.scale,width=this.plan.width,height=this.plan.height;
    for(let y=0,index=0;y<height;y++) for(let x=0;x<width;x++,index+=4) {
      let r=0,g=0,b=0,alpha=0;
      for(let sy=0;sy<scale;sy++) for(let sx=0;sx<scale;sx++) {
        const sourceIndex=((y*scale+sy)*sourceWidth+x*scale+sx)*4,a=source[sourceIndex+3]/255;
        r+=SRGB_TO_LINEAR[source[sourceIndex]]*a;g+=SRGB_TO_LINEAR[source[sourceIndex+1]]*a;b+=SRGB_TO_LINEAR[source[sourceIndex+2]]*a;alpha+=a;
      }
      this.sums[index]+=r;this.sums[index+1]+=g;this.sums[index+2]+=b;this.sums[index+3]+=alpha;
    }
    this.count++;return this.count;
  }
  finish(target=null) {
    if (this.count!==this.plan.passes) throw new Error('Incomplete spatial coverage samples; no final frame can be emitted');
    target||=new Uint8ClampedArray(this.plan.width*this.plan.height*4);
    if (!(target instanceof Uint8Array||target instanceof Uint8ClampedArray)||target.length!==this.sums.length) throw new TypeError('Output dimensions differ from requested frame');
    if(target.buffer===this.sums.buffer||(this.sourceRanges.get(target.buffer)||[]).some(([first,end])=>target.byteOffset<end&&first<target.byteOffset+target.byteLength))throw new TypeError('Output cannot overwrite immutable source samples or accumulation memory');
    const denominator=this.plan.passes*this.plan.scale*this.plan.scale;
    for(let index=0;index<target.length;index+=4) {
      const alpha=this.sums[index+3];target[index+3]=Math.round(255*alpha/denominator);
      if (target[index+3]===0) {target[index]=target[index+1]=target[index+2]=0;continue;}
      for(let channel=0;channel<3;channel++) target[index+channel]=encode(Math.max(0,Math.min(1,this.sums[index+channel]/alpha)));
    }
    return {data:target,width:this.plan.width,height:this.plan.height};
  }
  reset() {this.sums.fill(0);this.count=0;this.sourceRanges=new WeakMap();}
}
