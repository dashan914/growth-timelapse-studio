import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { File } from 'node:buffer';
import { zipSync, unzipSync, strToU8 } from 'three/addons/libs/fflate.module.js';
import { parseSlicedThreeMF, loadSlicedThreeMF, validateSlicedThreeMFFile } from '../src/sliced-3mf.js';

const gcode='; filament_colour = #F0E8D6;#23599C\r\nG21\r\nG90\r\nM82\r\nG0 X0 Y0 Z0.25\r\n;TYPE:Outer wall\r\n;WIDTH:0.42\r\n;HEIGHT:0.25\r\nG1 X10 Y0 E1\r\nG1 Z0.37\r\n;HEIGHT:0.12\r\nT1\r\n;TYPE:Support\r\nG1 X10 Y10 E2\r\nG1 Z0.55\r\n;HEIGHT:0.18\r\n;TYPE:Sparse infill\r\nG1 X0 Y10 E3\r\n;CONFIG_BLOCK_START\r\n; layer_height = 0.12\r\n; initial_layer_print_height = 0.25\r\n; post_process = inert-only\r\n;CONFIG_BLOCK_END\r\n';
const model='<model><resources><object><mesh><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object></resources></model>';
const archive=entries=>zipSync(Object.fromEntries(Object.entries(entries).map(([name,value])=>[name,typeof value==='string'?strToU8(value):value])),{level:6});
const hash=value=>createHash('sha256').update(value).digest('hex');
const assertCode=code=>error=>{assert.equal(error.code,code,error.message);return true;};

test('single original plate1 at root/Metadata keeps every raw byte and actual palette/variable HEIGHT without re-slicing', async()=>{
  for(const entry of ['plate_1.gcode','Metadata/plate_1.gcode']){
    const bytes=archive({[entry]:gcode,'3D/3dmodel.model':model}),before=bytes.slice(),progress=[];
    const result=await parseSlicedThreeMF(bytes,{onProgress:event=>progress.push(event)});
    assert.equal(result.archiveEntry,entry);assert.equal(result.hasCad,true);assert.equal(result.pathOnly,false);
    assert.equal(result.reSliced,false);assert.equal(result.pathSource,'original-embedded-text-gcode');
    assert.equal(result.sourceHash,hash(bytes));assert.equal(result.gcodeHash,hash(strToU8(gcode)));
    assert.deepEqual(new Uint8Array(await result.gcodeFile.arrayBuffer()),strToU8(gcode));
    assert.deepEqual(bytes,before);assert.equal(result.zipCRCValidated,true);
    assert.equal(result.parsed.segmentCount,3);assert.deepEqual([...result.parsed.tools],[0,1,1]);
    assert.deepEqual(result.toolColors,['#f0e8d6','#23599c']);assert.equal(result.colorConfirmationRequired,false);
    assert.deepEqual([...result.parsed.layerHeights],[.25,.37,.55]);
    for(const [index,height] of [[0,.25],[1,.12],[2,.18]])assert.ok(Math.abs(result.parsed.heights[index]-height)<1e-6);
    assert.equal(result.parsed.rawConfiguration.layer_height,'0.12');assert.equal(result.parsed.rawConfiguration.post_process,'inert-only');
    assert.ok(result.cadPreviewFile);const preview=unzipSync(new Uint8Array(await result.cadPreviewFile.arrayBuffer()));
    assert.deepEqual(Object.keys(preview),['3D/3dmodel.model']);assert.deepEqual(preview['3D/3dmodel.model'],strToU8(model));
    assert.ok(progress.some(event=>event.phase==='unpacking'&&event.unit==='bytes'&&event.completed===event.total));
    assert.ok(progress.some(event=>event.phase==='parse'&&event.unit==='characters'&&event.completed===event.total));
    assert.ok(progress.some(event=>event.phase==='index'&&event.unit==='segments'&&event.progress===1));
  }
});

test('ordinary sliced output without CAD is supported as exact pathOnly; comments/CDATA/quoted tags are not CAD',async()=>{
  for(const extra of [{},{'3D/3dmodel.model':'<model><resources/><build/></model>'},
    {'3D/3dmodel.model':'<model><!--<triangle v1="0"/>--><![CDATA[<triangle/>]]><metadata value="&lt;triangle&gt;">inert text</metadata></model>'}]){
    const result=await parseSlicedThreeMF(archive({'Metadata/plate_1.gcode':gcode,...extra}));
    assert.equal(result.hasCad,false);assert.equal(result.pathOnly,true);assert.equal(result.parsed.segmentCount,3);
    assert.equal(result.cadPreviewFile,null);
  }
});

test('Bambu machine Z-trim and ABL commands are accepted inside original sliced 3MF without rewriting paths or source bytes', async()=>{
  const calibrated='G29.1 Z0\nG29.2 S0\n'+gcode.replace('G0 X0 Y0 Z0.25\r\n','G29.1 Z-0.04\r\nG29.2 S1\r\nG0 X0 Y0 Z0.25\r\n');
  const bytes=archive({'Metadata/plate_1.gcode':calibrated,'3D/3dmodel.model':model});
  const candidate=await parseSlicedThreeMF(bytes);
  const original=await parseSlicedThreeMF(archive({'Metadata/plate_1.gcode':gcode,'3D/3dmodel.model':model}));
  assert.equal(candidate.sourceHash,hash(bytes));assert.equal(candidate.gcodeHash,hash(strToU8(calibrated)));
  assert.deepEqual(new Uint8Array(await candidate.gcodeFile.arrayBuffer()),strToU8(calibrated));
  for(const name of ['positions','tools','features','widths','heights','layers','layerHeights','layerOffsets','layerSegments'])assert.deepEqual(candidate.parsed[name],original.parsed[name],name);
  assert.deepEqual(candidate.toolColors,original.toolColors);assert.equal(candidate.reSliced,false);
});

test('separate CAD preview omits actual paths but preserves every model/config/texture member byte exactly',async()=>{
  const entries={'Metadata/plate_1.gcode':gcode,'3D/3dmodel.model':model,'Metadata/project_settings.config':'{"layer_height":"0.12"}',
    'Metadata/model_settings.config':'<config><plate id="1"/></config>','3D/Textures/color.png':new Uint8Array([137,80,78,71,0,1,2]),'_rels/.rels':'<Relationships/>'};
  const bytes=archive(entries),result=await parseSlicedThreeMF(bytes),preview=unzipSync(new Uint8Array(await result.cadPreviewFile.arrayBuffer()));
  assert.equal(preview['Metadata/plate_1.gcode'],undefined);
  for(const [name,value]of Object.entries(entries))if(name!=='Metadata/plate_1.gcode')assert.deepEqual(preview[name],typeof value==='string'?strToU8(value):value);
  assert.equal(result.cadPreviewMembers.length,Object.keys(entries).length-1);assert.equal(result.sourceHash,hash(bytes));
  assert.deepEqual(new Uint8Array(await result.gcodeFile.arrayBuffer()),strToU8(gcode));
});

test('unsliced, multi-plate, duplicate plate1 and wrong plate packages fail instead of invoking a native fallback',async()=>{
  await assert.rejects(parseSlicedThreeMF(archive({'3D/3dmodel.model':model})),assertCode('SLICED_3MF_NO_PATHS'));
  await assert.rejects(parseSlicedThreeMF(archive({'plate_2.gcode':gcode})),assertCode('SLICED_3MF_WRONG_PLATE'));
  for(const entries of [{'plate_1.gcode':gcode,'Metadata/plate_2.gcode':gcode},{'plate_1.gcode':gcode,'Metadata/plate_1.gcode':gcode},
    {'plate_1.gcode':gcode,'Metadata/model_settings.config':'<config><plate id="1"/><plate id="2"/></config>'}]){
    await assert.rejects(parseSlicedThreeMF(archive(entries)),assertCode('SLICED_3MF_MULTIPLATE'));
  }
});

test('binary slice names or disguised binary content are explicitly rejected, including mixed text/binary caches',async()=>{
  for(const name of ['Metadata/plate_1.gcode.bin','Metadata/plate_1.bgcode']){
    for(const plain of [false,true])await assert.rejects(parseSlicedThreeMF(archive({[name]:new Uint8Array([0,1,2]),...(plain?{'plate_1.gcode':gcode}:{})})),assertCode('SLICED_3MF_BINARY_UNSUPPORTED'));
  }
  await assert.rejects(parseSlicedThreeMF(archive({'plate_1.gcode':strToU8(gcode+'\u0000binary')})),assertCode('SLICED_3MF_BINARY_UNSUPPORTED'));
  await assert.rejects(parseSlicedThreeMF(archive({'plate_1.gcode':new Uint8Array([...strToU8(gcode),255,255])})),assertCode('SLICED_3MF_BINARY_UNSUPPORTED'));
});

test('ZIP path/CRC/encryption/overlap budgets fail before a partial print table can become ready',async()=>{
  for(const name of ['../plate_1.gcode','/plate_1.gcode','Metadata\\plate_1.gcode','C:/plate_1.gcode'])await assert.rejects(parseSlicedThreeMF(archive({[name]:gcode})),assertCode('SLICED_3MF_UNSAFE_ARCHIVE'));
  await assert.rejects(parseSlicedThreeMF(archive({'plate_1.gcode':gcode}),{limits:{expandedBytes:32}}),assertCode('SLICED_3MF_TOO_LARGE'));
  const original=archive({'plate_1.gcode':gcode}),view=new DataView(original.buffer,original.byteOffset,original.byteLength);
  let central=-1;for(let at=0;at<original.length-4;at++)if(view.getUint32(at,true)===0x02014b50){central=at;break;}
  const corrupted=original.slice(),cv=new DataView(corrupted.buffer);cv.setUint32(central+16,cv.getUint32(central+16,true)^1,true);cv.setUint32(14,cv.getUint32(14,true)^1,true);
  await assert.rejects(parseSlicedThreeMF(corrupted),assertCode('SLICED_3MF_BAD_ZIP'));
  const encrypted=original.slice(),ev=new DataView(encrypted.buffer);ev.setUint16(central+8,ev.getUint16(central+8,true)|1,true);
  await assert.rejects(parseSlicedThreeMF(encrypted),assertCode('SLICED_3MF_BAD_ZIP'));
  await assert.rejects(parseSlicedThreeMF(archive({'plate_1.gcode':gcode,'bad.model':'<!DOCTYPE model SYSTEM "file:///etc/passwd"><model/>'})),assertCode('SLICED_3MF_UNSAFE_ARCHIVE'));
});

test('unknown extrusion and segment excess fail; missing actual colors stay unknown rather than guessed',async()=>{
  await assert.rejects(parseSlicedThreeMF(archive({'plate_1.gcode':gcode+'G5 X2 Y2 I1 J1 E4\n'})),assertCode('SLICED_3MF_BAD_GCODE'));
  await assert.rejects(parseSlicedThreeMF(archive({'plate_1.gcode':gcode}),{limits:{segments:1}}),assertCode('SLICED_3MF_BAD_GCODE'));
  const result=await parseSlicedThreeMF(archive({'plate_1.gcode':gcode.replace(/^; filament_colour[^\n]*\n/,'')}));
  assert.deepEqual(result.toolColors,[]);assert.equal(result.colorConfirmationRequired,true);
});

class LocalWorker {
  static created=0;
  constructor(){LocalWorker.created++;this.terminated=false;}
  async postMessage({file}){
    try{
      const result=await parseSlicedThreeMF(new Uint8Array(await file.arrayBuffer()),{fileName:file.name,onProgress:event=>this.onmessage?.({data:{type:'progress',...event}})});
      if(!this.terminated)this.onmessage?.({data:{type:'complete',result}});
    }catch(error){if(!this.terminated)this.onmessage?.({data:{type:'error',message:error.message,code:error.code}});}
  }
  terminate(){this.terminated=true;}
}
test('public Worker entry keeps exactly the original File, posts no source-geometry transfer, and accepts progress/cancel',async()=>{
  const bytes=archive({'plate_1.gcode':gcode}),file=new File([bytes],'original.gcode.3mf'),events=[];
  const result=await loadSlicedThreeMF(file,{WorkerClass:LocalWorker,onProgress:event=>events.push(event)});
  assert.equal(result.sourceModelBlob,file);assert.equal(result.sourceModelFile,file);assert.equal(result.pathOnly,true);
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()),bytes);assert.ok(events.length>3);
  const abort=new AbortController();abort.abort();const created=LocalWorker.created;
  await assert.rejects(loadSlicedThreeMF(file,{WorkerClass:LocalWorker,signal:abort.signal}),{name:'AbortError'});
  assert.equal(LocalWorker.created,created);
  assert.throws(()=>validateSlicedThreeMFFile(new File([bytes],'unsliced.stl')),assertCode('SLICED_3MF_REQUIRED'));
  assert.throws(()=>validateSlicedThreeMFFile([file,file]),assertCode('SLICED_3MF_REQUIRED'));
});
