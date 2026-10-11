import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {deflateSync,inflateSync} from 'node:zlib';

const script=path.resolve('scripts/render-cycles.py');
const fixture=path.resolve('tests/fixtures/cycles');
const python=process.env.GROWTH_TEST_PYTHON||'python3';
const validate=(filename)=>spawnSync(python,['-B','-c',`import runpy,sys\nf=runpy.run_path(sys.argv[1])\nf['validate_config'](sys.argv[2])\nprint('valid')`,script,filename],{encoding:'utf8'});
function simpleGlb(json={asset:{version:'2.0'}}){let content=Buffer.from(JSON.stringify(json));const size=Math.ceil(content.length/4)*4;content=Buffer.concat([content,Buffer.alloc(size-content.length,32)]);const header=Buffer.alloc(20);header.write('glTF');header.writeUInt32LE(2,4);header.writeUInt32LE(20+content.length,8);header.writeUInt32LE(content.length,12);header.write('JSON',16);return Buffer.concat([header,content]);}
const basic=()=>({schemaVersion:1,scene:'scene.glb',coordinateSystem:'three-y-up',output:{directory:'frames',width:320,height:240,fps:24,frames:3,growthFrames:3,samples:64},camera:{position:[.2,.15,.3],quaternion:[0,0,0,1],fov:46},plane:{widthM:.33,depthM:.32,yM:-.00001},bounds:{minY:0,maxY:.1},background:{transparent:true}});

test('Cycles package validation accepts canonical schema and rejects escaped paths, nonfinite pose and resource limits',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'growth-cycles-validate-'));try{
    await fs.writeFile(path.join(dir,'scene.glb'),simpleGlb());
    const filename=path.join(dir,'config.json');await fs.writeFile(filename,JSON.stringify(basic()));assert.equal(validate(filename).status,0);
    for(const mutate of [c=>c.scene='../scene.glb',c=>c.output.directory='../outside',c=>c.output.width=9000,c=>c.camera.quaternion=[0,0,0,0],c=>c.bounds.maxY=0,c=>c.output.samples=1024,c=>c.output.growthFrames=4]){
      const config=basic();mutate(config);await fs.writeFile(filename,JSON.stringify(config));assert.notEqual(validate(filename).status,0);
    }
    await fs.writeFile(filename,JSON.stringify(basic()));await fs.symlink(path.dirname(dir),path.join(dir,'escape'));
    const escaped=basic();escaped.output.directory='escape/leaked';await fs.writeFile(filename,JSON.stringify(escaped));assert.notEqual(validate(filename).status,0);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('Cycles GLB rejects external resources and per-instance colors unsupported by the verified importer',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'growth-cycles-resources-'));try{
    const filename=path.join(dir,'config.json');await fs.writeFile(filename,JSON.stringify(basic()));
    for(const gltf of [{asset:{version:'2.0'},images:[{uri:'../private.jpg'}]},{asset:{version:'2.0'},images:[{uri:'https://example.com/image.png'}]},{asset:{version:'2.0'},nodes:[{extensions:{EXT_mesh_gpu_instancing:{attributes:{TRANSLATION:1,_COLOR_0:2}}}}]}]){
      await fs.writeFile(path.join(dir,'scene.glb'),simpleGlb(gltf));assert.notEqual(validate(filename).status,0);
    }
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('HQ time sampling matches duration and growth seconds including complete hold frames',()=>{
  const run=spawnSync(python,['-B','-c',`import runpy,sys,json\nf=runpy.run_path(sys.argv[1])\no={'frames':5,'growthFrames':3,'durationSeconds':2,'growthSeconds':1}\nprint(json.dumps([f['growth_at_frame'](i,o) for i in range(5)]))`,script],{encoding:'utf8'});
  assert.equal(run.status,0,run.stderr);assert.deepEqual(JSON.parse(run.stdout),[0,.5,1,1,1]);
});

test('Cycles validates current-frame previews and uses their exact requested growth instead of completing a still export', async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'growth-cycles-preview-'));try{
    await fs.writeFile(path.join(dir,'scene.glb'),simpleGlb());
    const filename=path.join(dir,'config.json');
    const preview=()=>({...basic(),output:{directory:'frames',width:320,height:240,fps:1,frames:1,growthFrames:1,samples:64,previewProgress:.5}});
    for(const progress of [0,.5,1]){
      const config=preview();config.output.previewProgress=progress;await fs.writeFile(filename,JSON.stringify(config));
      assert.equal(validate(filename).status,0);
    }
    for(const mutate of [c=>c.output.previewProgress=null,c=>c.output.previewProgress=false,c=>c.output.previewProgress='0.5',c=>c.output.previewProgress=-.01,c=>c.output.previewProgress=1.01,c=>c.output.frames=2,c=>c.output.growthFrames=2,c=>c.output.fps=30,c=>c.output.samples=128,c=>c.output.durationSeconds=1,c=>c.output.growthSeconds=1]){
      const config=preview();mutate(config);await fs.writeFile(filename,JSON.stringify(config));assert.notEqual(validate(filename).status,0);
    }
    for(const invalid of ['NaN','Infinity','-Infinity']){
      await fs.writeFile(filename,JSON.stringify(preview()).replace('"previewProgress":0.5','"previewProgress":'+invalid));assert.notEqual(validate(filename).status,0);
    }
    const run=spawnSync(python,['-B','-c',`import runpy,sys,json\nf=runpy.run_path(sys.argv[1])\nbase={'frames':1,'growthFrames':1,'fps':1,'samples':64}\nprint(json.dumps([f['growth_at_frame'](0,dict(base,previewProgress=p)) for p in (0,.5,1)]+[f['growth_at_frame'](0,base)]))`,script],{encoding:'utf8'});
    assert.equal(run.status,0,run.stderr);assert.deepEqual(JSON.parse(run.stdout),[0,.5,1,1]);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('Cycles completion event and saved statistics report preview progress only for a current-frame preview', async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'growth-cycles-preview-stats-'));try{
    for(const progress of [null,0,.5,1]){
      const output=progress===null?{frames:1}:{frames:1,previewProgress:progress};
      const run=spawnSync(python,['-B','-c',`import runpy,sys,json,pathlib\nf=runpy.run_path(sys.argv[1])\nstats={'frames':1,'sourceGeometryUnchanged':True}\nf['write_completion_stats'](pathlib.Path(sys.argv[2]),stats,json.loads(sys.argv[3]))\nassert 'previewProgress' not in stats`,script,dir,JSON.stringify(output)],{encoding:'utf8'});
      assert.equal(run.status,0,run.stderr);
      const event=JSON.parse(run.stdout),saved=JSON.parse(await fs.readFile(path.join(dir,'stats.json'),'utf8'));
      assert.equal(event.type,'complete');assert.deepEqual(event.stats,saved);assert.equal(saved.sourceGeometryUnchanged,true);
      if(progress===null)assert.equal(Object.hasOwn(saved,'previewProgress'),false);else assert.equal(saved.previewProgress,progress);
    }
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});

function crc32(bytes){let crc=-1;for(const byte of bytes){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return(crc^-1)>>>0;}
function chunk(type,data){const header=Buffer.alloc(8);header.writeUInt32BE(data.length);header.write(type,4);const crc=Buffer.alloc(4);crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type),data])));return Buffer.concat([header,data,crc]);}
function solidPng(width,height,color){const info=Buffer.alloc(13);info.writeUInt32BE(width);info.writeUInt32BE(height,4);info[8]=8;info[9]=6;const scan=Buffer.alloc(height*(width*4+1));for(let y=0;y<height;y++)for(let x=0;x<width;x++)scan.set(color,y*(width*4+1)+1+x*4);return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',info),chunk('IDAT',deflateSync(scan)),chunk('IEND',Buffer.alloc(0))]);}
function decodePng(bytes){let offset=8,info,idat=[];while(offset<bytes.length){const size=bytes.readUInt32BE(offset),type=bytes.toString('ascii',offset+4,offset+8),data=bytes.subarray(offset+8,offset+8+size);if(type==='IHDR')info=data;if(type==='IDAT')idat.push(data);offset+=12+size;}const width=info.readUInt32BE(),height=info.readUInt32BE(4),bpp=info[9]===6?4:3;assert.equal(info[8],8);const raw=inflateSync(Buffer.concat(idat)),pixels=Buffer.alloc(width*height*bpp),stride=width*bpp;const paeth=(a,b,c)=>{const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);return pa<=pb&&pa<=pc?a:pb<=pc?b:c;};for(let y=0;y<height;y++){const filter=raw[y*(stride+1)];for(let x=0;x<stride;x++){const a=x>=bpp?pixels[y*stride+x-bpp]:0,b=y?pixels[(y-1)*stride+x]:0,c=y&&x>=bpp?pixels[(y-1)*stride+x-bpp]:0;const predictor=[0,a,b,Math.floor((a+b)/2),paeth(a,b,c)][filter];pixels[y*stride+x]=(raw[y*(stride+1)+1+x]+predictor)&255;}}return{width,height,bpp,pixels};}

test('actual Cycles cropped/rolled camera preserves background pixels, empty/half/complete states and full source colors/triangles',{skip:!process.env.GROWTH_TEST_BLENDER,timeout:120000},async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'growth-cycles-render-'));try{
    const config=JSON.parse(await fs.readFile(path.join(fixture,'config.json'),'utf8'));
    await fs.copyFile(path.join(fixture,'scene.glb'),path.join(dir,'scene.glb'));await fs.writeFile(path.join(dir,'photo.png'),solidPng(320,240,[50,60,80,255]));
    delete config.photoFile;config.scene='scene.glb';config.background={file:'photo.png',transparent:false,color:'#30333a'};config.output={...config.output,directory:'frames',frames:5,growthFrames:3,durationSeconds:2,growthSeconds:1};config.lighting.shadowOpacity=.7;
    const filename=path.join(dir,'config.json');await fs.writeFile(filename,JSON.stringify(config));
    const run=spawnSync(process.env.GROWTH_TEST_BLENDER,['--background','--factory-startup','--disable-autoexec','--python-exit-code','1','--python',script,'--',filename],{encoding:'utf8',timeout:100000,maxBuffer:8*1024*1024,env:{...process.env,BLENDER_USER_CONFIG:path.join(dir,'config'),BLENDER_USER_SCRIPTS:path.join(dir,'scripts'),BLENDER_USER_DATAFILES:path.join(dir,'data')}});
    assert.equal(run.status,0,run.stdout.slice(-4000)+run.stderr);
    const events=run.stdout.split('\n').filter(line=>line.startsWith('{')).map(line=>JSON.parse(line));assert.deepEqual(events.filter(event=>event.type==='progress').map(event=>event.growth),[0,.5,1,1,1]);
    const stats=events.find(event=>event.type==='complete').stats;assert.equal(stats.originalTriangles,24);assert.equal(stats.completeTriangles,24);assert.equal(stats.sourceGeometryUnchanged,true);assert.equal(stats.decimation,false);assert.ok(stats.projectionError<1e-5);assert.equal(stats.gradingScope,'model-only');assert.equal(stats.shadowMode,'independent-rgb-catcher-times-linear-background');
    const empty=decodePng(await fs.readFile(path.join(dir,'frames/frames000000.png')));
    for(let index=0;index<empty.pixels.length;index+=empty.bpp){const message='Empty background pixel '+[...empty.pixels.subarray(index,index+empty.bpp)].join(',');assert.ok(Math.abs(empty.pixels[index]-50)<=1,message);assert.ok(Math.abs(empty.pixels[index+1]-60)<=1,message);assert.ok(Math.abs(empty.pixels[index+2]-80)<=1,message);}
    const half=decodePng(await fs.readFile(path.join(dir,'frames/frames000001.png'))),full=decodePng(await fs.readFile(path.join(dir,'frames/frames000002.png')));assert.notDeepEqual(half.pixels,full.pixels);const held=decodePng(await fs.readFile(path.join(dir,'frames/frames000004.png')));assert.deepEqual(held.pixels,full.pixels,'Complete hold keeps exactly the same geometry, focus and noise realization');
    let red=0,blue=0;for(let index=0;index<full.pixels.length;index+=full.bpp){const[r,g,b]=full.pixels.subarray(index,index+3);if(r>g*1.3&&r>b*1.3)red++;if(b>r*1.3&&b>g*1.3&&b>100)blue++;}assert.ok(red>30&&blue>30,'Both original source material colors remain visible');
    const repeat=variant=>{const name=variant.output.directory;const destination=path.join(dir,name+'.json');return fs.writeFile(destination,JSON.stringify(variant)).then(()=>{const result=spawnSync(process.env.GROWTH_TEST_BLENDER,['--background','--factory-startup','--disable-autoexec','--python-exit-code','1','--python',script,'--',destination],{encoding:'utf8',timeout:35000,maxBuffer:8*1024*1024,env:{...process.env,BLENDER_USER_CONFIG:path.join(dir,'config'),BLENDER_USER_SCRIPTS:path.join(dir,'scripts'),BLENDER_USER_DATAFILES:path.join(dir,'data')}});assert.equal(result.status,0,result.stdout.slice(-3000)+result.stderr);});};
    const noShadow=structuredClone(config);noShadow.output={...config.output,directory:'zero-shadow',frames:1,growthFrames:1};noShadow.lighting.shadowOpacity=0;await repeat(noShadow);
    const clear=decodePng(await fs.readFile(path.join(dir,'zero-shadow/frames000000.png')));let shadowChanged=0;for(let index=0;index<clear.pixels.length;index+=clear.bpp){if(Math.abs(clear.pixels[index]-50)<=1&&Math.abs(clear.pixels[index+1]-60)<=1&&Math.abs(clear.pixels[index+2]-80)<=1&&[0,1,2].some(channel=>Math.abs(full.pixels[index+channel]-clear.pixels[index+channel])>2))shadowChanged++;}assert.ok(shadowChanged>20,'Shadow opacity changes actual ground pixels independently of model grading');
    const transparent=structuredClone(config);delete transparent.photoFile;transparent.background={color:'#336699',transparent:true,file:'photo.png'};transparent.output={...config.output,directory:'transparent',frames:2,growthFrames:2};await repeat(transparent);
    const emptyAlpha=decodePng(await fs.readFile(path.join(dir,'transparent/frames000000.png'))),fullAlpha=decodePng(await fs.readFile(path.join(dir,'transparent/frames000001.png')));assert.equal(emptyAlpha.bpp,4);let solid=0;for(let index=3;index<emptyAlpha.pixels.length;index+=4){assert.equal(emptyAlpha.pixels[index],0);if(fullAlpha.pixels[index]>200)solid++;}assert.ok(solid>30,'No-photo export keeps transparent alpha and complete mesh silhouette');
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
