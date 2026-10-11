import test from 'node:test';
import assert from 'node:assert/strict';
import { exportRenderPlan, downsampleExportFrame, linearLightDownsample2x } from '../src/export-quality.js';

test('supersampling keeps framing and requested output size, within a GPU budget', () => {
  for (const [width, height] of [[1440, 1080], [1920, 1080], [1080, 1920], [1080, 1080]]) {
    const plan = exportRenderPlan(width, height);
    assert.equal(plan.scale, 2);
    assert.equal(plan.renderWidth / plan.renderHeight, width / height);
    assert.ok(plan.renderWidth * plan.renderHeight <= 8_388_608);
    assert.equal(plan.width, width); assert.equal(plan.height, height);
  }
  for (const [width, height] of [[3840, 2160], [2160, 2160], [8192, 16]]) assert.equal(exportRenderPlan(width, height).scale, 1);
  assert.equal(exportRenderPlan(1920, 1080, { maxPixels: 2_000_000 }).scale, 1);
  for (const [width, height] of [[NaN, 100], [16.1, 32], [8, 200], [8193, 100]]) assert.throws(() => exportRenderPlan(width, height));
});

test('equal black/white area integrates to sRGB 188 rather than the incorrect encoded-space 128', () => {
  const source = new Uint8ClampedArray([0,0,0,255, 255,255,255,255, 255,255,255,255, 0,0,0,255]);
  const before = source.slice(), result = linearLightDownsample2x(source, 2, 2);
  assert.deepEqual([...result.data], [188,188,188,255]);
  assert.deepEqual([result.width,result.height], [1,1]);
  assert.deepEqual(source,before, 'rendered source colors stay unmodified');
});

test('premultiplied linear coverage preserves transparent edge color and ignores hidden transparent colors', () => {
  const source = new Uint8ClampedArray([255,0,0,255, 0,0,255,0, 0,255,0,0, 255,255,255,0]);
  assert.deepEqual([...linearLightDownsample2x(source,2,2).data], [255,0,0,64], 'an isolated opaque red sample has no black, green or blue fringe');
  source.fill(0); source[0]=source[4]=source[8]=source[12]=255;
  assert.deepEqual([...linearLightDownsample2x(source,2,2).data], [0,0,0,0], 'zero coverage has no hidden colored output');
  const partial = new Uint8ClampedArray([255,0,0,255, 0,0,255,128, 0,255,0,0, 255,255,255,0]);
  const result = linearLightDownsample2x(partial,2,2).data;
  assert.deepEqual([...result], [213,0,156,96]);
  const linear = byte => { const c=byte/255; return c<=.04045?c/12.92:((c+.055)/1.055)**2.4; };
  assert.ok(Math.abs(linear(result[0])*result[3]/255-.25)<.002, 'red composited radiance follows one full sample of four');
  assert.ok(Math.abs(linear(result[2])*result[3]/255-128/255/4)<.002, 'blue composited radiance follows its actual half coverage');
});

test('area reduction keeps flat colors and neighboring 2×2 footprints, never mixes unrelated blocks', () => {
  for(let value=0;value<=255;value++) {
    const source=new Uint8ClampedArray(16);
    for(let pixel=0;pixel<4;pixel++)source.set([value,value,value,255],pixel*4);
    assert.deepEqual([...linearLightDownsample2x(source,2,2).data],[value,value,value,255]);
  }
  const source=new Uint8ClampedArray(4*2*4);
  for(let y=0;y<2;y++)for(let x=0;x<4;x++)source.set(x<2?[255,0,0,255]:[0,0,255,255],(y*4+x)*4);
  const target=new Uint8ClampedArray(8);
  assert.equal(linearLightDownsample2x(source,4,2,target).data,target);
  assert.deepEqual([...target],[255,0,0,255,0,0,255,255]);
  assert.throws(()=>linearLightDownsample2x(source,3,2),/偶数/);
  assert.throws(()=>linearLightDownsample2x(source.slice(1),4,2),/完整/);
  assert.throws(()=>linearLightDownsample2x(source,4,2,new Uint8ClampedArray(source.buffer,0,8)),/覆盖/);
});

function canvasFixture(plan,{failedEncode=false,failedRead=false}={}) {
  const blob={},output={},calls=[];
  const pixels=new Uint8ClampedArray(plan.renderWidth*plan.renderHeight*4);
  for(let y=0;y<plan.renderHeight;y++)for(let x=0;x<plan.renderWidth;x++)pixels.set((x+y)%2?[255,255,255,255]:[0,0,0,255],(y*plan.renderWidth+x)*4);
  const read={clearRect:(...args)=>calls.push(['clear',...args]),drawImage:(...args)=>calls.push(['read-1:1',...args]),getImageData:(...args)=>{
    calls.push(['pixels',...args]);if(failedRead)throw new Error('readback failure');return{data:pixels};
  }};
  const context={createImageData:(w,h)=>({data:new Uint8ClampedArray(w*h*4),width:w,height:h}),putImageData:(image,x,y)=>calls.push(['write',image,x,y])};
  const canvas={width:0,height:0,getContext:()=>context,toBlob:(callback,format)=>{calls.push(['encode',format]);callback(failedEncode?null:output);}};
  let created=0,closed=0;
  const bitmap={width:plan.renderWidth,height:plan.renderHeight,close:()=>closed++};
  const options={createScratch:(w,h)=>{created++;calls.push(['scratch',w,h]);return{getContext:()=>read};},yieldToUI:async()=>calls.push(['yield'])};
  return{blob,output,calls,canvas,bitmap,options,read,get created(){return created;},get closed(){return closed;}};
}

test('downsample reuses buffers, reads full-size pixels without browser resize, preserves framing and closes bitmap', async () => {
  const plan=exportRenderPlan(32,32),f=canvasFixture(plan);
  assert.equal(await downsampleExportFrame(f.blob,plan,f.canvas,async()=>f.bitmap,f.options),f.output);
  assert.deepEqual([f.canvas.width,f.canvas.height],[32,32]);
  assert.equal(f.read.imageSmoothingEnabled,false);
  const drawn=f.calls.find(call=>call[0]==='read-1:1');
  assert.deepEqual(drawn,['read-1:1',f.bitmap,0,0], 'source is drawn at 1:1, not resized in gamma-encoded canvas space');
  const write=f.calls.find(call=>call[0]==='write');
  assert.deepEqual([...write[1].data.slice(0,4)],[188,188,188,255]);
  const firstImage=write[1];
  await downsampleExportFrame(f.blob,plan,f.canvas,async()=>f.bitmap,f.options);
  assert.equal(f.created,1);assert.equal(f.closed,2);
  assert.equal(f.calls.filter(call=>call[0]==='write')[1][1],firstImage, 'same-size frames reuse final image data');
  assert.equal(await downsampleExportFrame(f.blob, exportRenderPlan(3840, 2160), null, () => { throw new Error('must not decode'); }), f.blob);
});

test('encoding/readback/source-size failures release resources and never silently distort the source', async () => {
  const plan=exportRenderPlan(32,32);
  for(const settings of [{failedEncode:true},{failedRead:true}]) {
    const f=canvasFixture(plan,settings);
    await assert.rejects(downsampleExportFrame(f.blob,plan,f.canvas,async()=>f.bitmap,f.options),/高清|readback/);
    assert.equal(f.closed,1);
  }
  const f=canvasFixture(plan);f.bitmap.width=63;
  await assert.rejects(downsampleExportFrame(f.blob,plan,f.canvas,async()=>f.bitmap,f.options),/尺寸/);
  assert.equal(f.closed,1);
});
