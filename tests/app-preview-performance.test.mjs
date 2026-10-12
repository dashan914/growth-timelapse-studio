import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {timelineState,outputSize} from '../src/timeline.js';
import {exportRenderPlan} from '../src/export-quality.js';
import {outputFormat} from '../src/output-format.js';

const source=await readFile(new URL('../src/app.js',import.meta.url),'utf8');
function actualFunction(name){
  const start=source.search(new RegExp(`(?:async )?function ${name}\\(`));assert.ok(start>=0);
  return source.slice(start,source.indexOf('\n}',start)+2);
}
function actualBlock(startText,endText){
  const start=source.indexOf(startText),end=source.indexOf(endText,start);assert.ok(start>=0&&end>start);
  return source.slice(start,end);
}
class Target{
  constructor(){this.listeners=new Map();}
  addEventListener(name,listener){const listeners=this.listeners.get(name)||[];listeners.push(listener);this.listeners.set(name,listeners);}
  dispatch(name,values={}){
    const event={type:name,target:this,button:0,pointerId:7,clientX:10,clientY:20,deltaY:30,prevented:false,preventDefault(){this.prevented=true;},...values};
    const pending=(this.listeners.get(name)||[]).map(listener=>listener(event));
    return{event,done:Promise.all(pending)};
  }
}
function fixture(){
  const nodes=new Map(),calls=[];
  const get=id=>{
    if(!nodes.has(id)){const node=new Target();Object.assign(node,{id,value:'',type:'range',checked:false,style:{},dataset:{},attrs:{},children:[],
      setAttribute(key,value){this.attrs[key]=value;},replaceChildren(...children){this.children=children;},append(...children){this.children.push(...children);},
      querySelector:()=>({setAttribute(){}})});nodes.set(id,node);}
    return nodes.get(id);
  };
  const canvas=new Target(),captured=new Set();
  Object.assign(canvas,{clientWidth:800,clientHeight:600,style:{},setPointerCapture:id=>captured.add(id),hasPointerCapture:id=>captured.has(id),
    releasePointerCapture(id){captured.delete(id);this.dispatch('lostpointercapture',{pointerId:id});}});
  const config={duration:8,hold:0,motion:'fixed',ratio:'4:3',resolution:1080,format:'mp4',appearance:'model',quality:'realistic',fps:30};
  const document={hidden:false,createTextNode:text=>({textContent:text}),createElement:()=>({textContent:''})};
  const camera={pitch:22,yaw:-30,roll:0},lens={focalLength:35};let fast=false;
  const studio={canvas,metadata:{name:'model.3mf'},options:{surfacePreset:'matte',surfaceDetail:.7},controls:{enabled:false},transform:{enabled:false},
    hasModel:()=>true,getPrintLayerData:()=>({}),getCameraOptions:()=>({...camera}),getLensOptions:()=>({...lens}),
    setCameraOptions(value){calls.push('camera');Object.assign(camera,value);},
    setLensOptions(value){calls.push('lens');Object.assign(lens,value);},
    beginPreviewInteraction(options){calls.push(['begin',options.hold]);fast=true;},
    endPreviewInteraction(){calls.push('end');fast=false;},
    render(){calls.push(['render',fast]);},setOptions(){},syncBackground(){},
    startExport(){calls.push(['startExport',fast]);},async captureFrame(){calls.push(['capture',fast]);return new Blob(['png']);},
    endExport(){},lockPreviewCamera(){}};
  const context=vm.createContext({studio,$:get,window:new Target(),document,timelineState,outputSize,exportRenderPlan,outputFormat,alphaVideoAvailable:true,
    playing:false,previewPlaybackActive:false,exporting:false,exportAuthorizing:false,loading:false,snapshotting:false,alignBusy:false,calibrationMode:false,cropEditing:false,
    perspectiveMode:false,dragPerspective:null,time:3,photoPreview:null,modelRevision:1,calibrationDragIndex:null,calibrationUprightDrag:null,gridDrag:null,cropDrag:null,
    settings:()=>({...config}),syncCameraFields(){},queueProjectState(){},syncDofStatus(){},syncRealisticPreview(){},lastRealisticPreviewCheck:0,say(){},lockWorkspace(){},
    updateSettings(){calls.push('updateSettings');},ensureExportUnlocked:async()=>true,settingIds:['lighting-exposure','dof-strength','floor','export-quality'],
    syncLightingControls(){},updateStageBounds(){},ensureModelSlice:async()=>true,ffmpegAvailable:true,
    setModelMode(){context.playing=false;},renderOptions:()=>({...studio.options}),downloadBlob(){calls.push('download');},
    exportRealisticVideo(){calls.push(['realisticPackage',fast]);},
    lastTick:0,previewFrameIntervals:[],requestAnimationFrame(){}});
  vm.runInContext(['syncPreviewPlaybackInteraction','touchPreviewInteraction','showTime','clearPreviewGesture','changeCameraFromFields','applyLensChange','changeLensFromFields','saveSnapshot','exportVideo','tick'].map(actualFunction).join('\n'),context);
  vm.runInContext(actualBlock('  const perspectiveGestureAllowed=','  $(\'play-button\').addEventListener'),context);
  vm.runInContext(source.split('\n').find(line=>line.includes("for(const name of ['pointerup','pointercancel'])window.addEventListener")),context);
  vm.runInContext(source.split('\n').find(line=>line.includes("for (const id of settingIds) if(id!=='export-quality')")),context);
  vm.runInContext(actualBlock("  for(const id of ['shadow-opacity','shadow-radius','light-direction','light-azimuth','light-elevation'])$('canvas-'+id).addEventListener", "  $('calibrate-button').addEventListener"),context);
  vm.runInContext(source.split('\n').find(line=>line.includes("$('timeline').addEventListener('input', async")),context);
  return{context,studio,canvas,get,calls,camera,lens,config,document,get fast(){return fast;}};
}

test('locked canvas and non-left pointers cause no low-quality work or camera edits',()=>{
  const f=fixture(),before={...f.camera};
  f.canvas.dispatch('pointerdown');f.canvas.dispatch('pointermove');const wheel=f.canvas.dispatch('wheel');
  assert.deepEqual(f.calls,[]);assert.deepEqual(f.camera,before);assert.equal(wheel.event.prevented,false);
  f.context.perspectiveMode=true;f.canvas.dispatch('pointerdown',{button:2});
  assert.deepEqual(f.calls,[]);assert.equal(f.context.dragPerspective,null);
});

test('allowed perspective drag holds responsive preview before changing the camera and releases once',()=>{
  const f=fixture();f.context.perspectiveMode=true;
  f.canvas.dispatch('pointerdown');assert.deepEqual(f.calls,[['begin',true]]);
  f.canvas.dispatch('pointermove',{clientX:90,clientY:80});
  assert.deepEqual(f.calls.slice(1,4),[['begin',true],'camera',['render',true]]);
  assert.equal(f.camera.yaw,-12);assert.equal(f.camera.pitch,13);
  f.context.window.dispatch('pointerup');
  assert.equal(f.context.dragPerspective,null);assert.equal(f.fast,false);
  assert.equal(f.calls.filter(call=>call==='end').length,1);
  f.canvas.dispatch('pointermove',{clientX:200});assert.equal(f.calls.at(-1),'end');
});

test('pointer cancellation and lost capture restore the complete preview',()=>{
  for(const event of ['pointercancel','lostpointercapture']){
    const f=fixture();f.context.perspectiveMode=true;f.canvas.dispatch('pointerdown');
    (event==='pointercancel'?f.context.window:f.canvas).dispatch(event);
    assert.equal(f.fast,false);assert.equal(f.context.dragPerspective,null);
    assert.equal(f.calls.filter(call=>call==='end').length,1);
  }
});

test('export/import/calibration blockers prevent perspective fast-preview activation',()=>{
  for(const key of ['exporting','loading','snapshotting','alignBusy','calibrationMode','cropEditing']){
    const f=fixture();f.context.perspectiveMode=true;f.context[key]=true;
    f.canvas.dispatch('pointerdown');f.canvas.dispatch('pointermove');f.canvas.dispatch('wheel');
    assert.deepEqual(f.calls,[],key);
  }
});

test('wheel and valid camera/lens input begin brief responsive rendering before their mutations',()=>{
  const f=fixture();f.context.perspectiveMode=true;
  const wheel=f.canvas.dispatch('wheel');assert.equal(wheel.event.prevented,true);
  assert.deepEqual(f.calls.slice(0,3),[['begin',false],'lens',['render',true]]);
  assert.equal(f.calls.includes('end'),false,'showTime must not cancel a non-playback wheel interaction');
  f.calls.length=0;
  f.context.changeCameraFromFields({target:{id:'camera-pitch',value:'31'}});
  assert.deepEqual(f.calls.slice(0,3),[['begin',false],'camera',['render',true]]);
  f.calls.length=0;
  f.context.changeCameraFromFields({target:{id:'camera-pitch',value:''}});
  f.context.changeLensFromFields({target:{value:'5'}});assert.deepEqual(f.calls,[]);
});

test('range changes touch interaction before updating settings; checkbox changes do not',()=>{
  const f=fixture();f.get('lighting-exposure').dispatch('input');
  assert.deepEqual(f.calls,[['begin',false],'updateSettings']);
  f.calls.length=0;f.get('floor').type='checkbox';f.get('floor').dispatch('input');
  assert.deepEqual(f.calls,['updateSettings']);
  f.calls.length=0;f.get('canvas-shadow-radius').value='7';f.get('canvas-shadow-radius').dispatch('input');
  assert.deepEqual(f.calls,[['begin',false],'updateSettings']);assert.equal(f.get('shadow-radius').value,'7');
});

test('playback holds responsiveness and pause, completion or hidden tab restores full quality',()=>{
  for(const stop of ['pause','completion','hidden']){
    const f=fixture();f.context.playing=true;f.context.showTime();
    assert.deepEqual(f.calls,[['begin',true],['render',true]]);
    f.calls.length=0;
    if(stop==='pause'){f.context.playing=false;f.context.showTime();}
    else if(stop==='completion'){f.context.time=7.95;f.context.lastTick=100;f.context.tick(200);}
    else {f.document.hidden=true;f.context.tick(200);}
    assert.equal(f.fast,false,stop);assert.equal(f.context.previewPlaybackActive,false,stop);
    assert.equal(f.calls[0],'end');assert.equal(f.calls.some(call=>Array.isArray(call)&&call[0]==='begin'),false);
    if(stop!=='hidden')assert.deepEqual(f.calls.at(-1),['render',false]);
  }
});

test('scrubbing interrupts held playback, then keeps the short slider interaction until it settles',async()=>{
  const f=fixture();f.context.playing=true;f.context.showTime();f.calls.length=0;
  f.get('timeline').value='400';await f.get('timeline').dispatch('input').done;
  assert.equal(f.context.playing,false);assert.equal(f.context.time,3.2);
  assert.deepEqual(f.calls,['end',['begin',false],['render',true]]);
});

test('single-frame and realistic exports explicitly restore complete quality before capture or scene packaging',async()=>{
  const frame=fixture();frame.context.touchPreviewInteraction();frame.calls.length=0;
  await frame.context.saveSnapshot();
  assert.equal(frame.calls[0],'end');assert.ok(frame.calls.some(call=>Array.isArray(call)&&call[0]==='capture'&&call[1]===false));
  assert.equal(frame.calls.some(call=>Array.isArray(call)&&call[0]==='begin'),false);
  assert.equal(frame.calls.includes('download'),true);
  const video=fixture();video.context.touchPreviewInteraction();video.calls.length=0;
  await video.context.exportVideo();assert.deepEqual(video.calls,['end',['realisticPackage',false]]);
});

test('locked exports cannot capture, download or submit a render job and retain model settings',async()=>{
  for(const action of ['saveSnapshot','exportVideo']){
    const f=fixture(),settings={...f.config},model=f.studio;
    f.context.ensureExportUnlocked=async()=>false;
    await f.context[action]();
    assert.deepEqual(f.calls,[],action);
    assert.equal(f.context.exportAuthorizing,false);
    assert.equal(f.context.studio,model);assert.deepEqual(f.config,settings);
    f.context.ensureExportUnlocked=async()=>true;
    await f.context[action]();
    assert.ok(f.calls.length>0,'closing an unlock window must allow a later export');
  }
});

test('concurrent export clicks share one pending operation and do not perform parallel captures',async()=>{
  const f=fixture();let resolve,checks=0;
  f.context.ensureExportUnlocked=()=>{checks++;return checks===1?new Promise(done=>{resolve=done;}):Promise.resolve(true);};
  const first=f.context.saveSnapshot();
  await f.context.saveSnapshot();await f.context.exportVideo();
  assert.equal(checks,1);assert.deepEqual(f.calls,[]);
  resolve(true);await first;
  assert.equal(checks,2,'a snapshot rechecks before downloading');
  assert.equal(f.calls.filter(call=>Array.isArray(call)&&call[0]==='capture').length,1);
  assert.equal(f.calls.filter(call=>Array.isArray(call)&&call[0]==='realisticPackage').length,0);
  assert.equal(f.context.exportAuthorizing,false);
});

test('a snapshot rechecks permission after rendering and never downloads with expired permission',async()=>{
  for(const allowedAtDownload of [false,true]){
    const f=fixture(),locks=[],settings={...f.config};let checks=0,endExports=0;
    f.studio.transform.enabled=true;
    f.studio.endExport=()=>{endExports++;};
    f.context.lockWorkspace=value=>{locks.push(value);};
    f.context.ensureExportUnlocked=async()=>++checks===1||allowedAtDownload;
    await f.context.saveSnapshot();
    assert.equal(checks,2);
    assert.equal(f.calls.filter(call=>Array.isArray(call)&&call[0]==='capture').length,1);
    assert.equal(f.calls.includes('download'),allowedAtDownload);
    assert.deepEqual(locks,[true,false]);assert.equal(endExports,1);
    assert.equal(f.context.snapshotting,false);assert.equal(f.context.exportAuthorizing,false);
    assert.equal(f.studio.transform.enabled,true);assert.deepEqual(f.config,settings);
  }
});

test('canceling the post-render permission check restores the workspace without starting another export',async()=>{
  const f=fixture(),locks=[];let checks=0,finishCheck;
  f.context.lockWorkspace=value=>{locks.push(value);};
  f.context.ensureExportUnlocked=()=>++checks===1?Promise.resolve(true):new Promise(done=>{finishCheck=done;});
  const first=f.context.saveSnapshot();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.context.snapshotting,true);assert.equal(f.context.exportAuthorizing,true);
  await f.context.exportVideo();await f.context.saveSnapshot();
  assert.equal(checks,2);
  finishCheck(false);await first;
  assert.equal(f.calls.includes('download'),false);
  assert.equal(f.calls.some(call=>Array.isArray(call)&&call[0]==='realisticPackage'),false);
  assert.deepEqual(locks,[true,false]);assert.equal(f.context.snapshotting,false);
  assert.equal(f.context.exporting,false);assert.equal(f.context.exportAuthorizing,false);
});

test('authorization remains exclusive through asynchronous realistic rendering',async()=>{
  const f=fixture();let finishRender;
  f.context.exportRealisticVideo=()=>new Promise(done=>{finishRender=done;});
  const first=f.context.exportVideo();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.context.exportAuthorizing,true);
  await f.context.saveSnapshot();assert.equal(f.calls.includes('download'),false);
  finishRender();await first;assert.equal(f.context.exportAuthorizing,false);
});

test('transparent MOV captures every growth frame with alpha and restores the background preview',async()=>{
  const f=fixture(),requests=[],frames=[];
  Object.assign(f.config,{format:'mov-alpha',quality:'realtime',duration:.1});
  f.studio.options.transparent=false;
  const previewOptions={...f.studio.options};
  f.context.renderOptions=()=>({...previewOptions});
  f.studio.setOptions=options=>Object.assign(f.studio.options,options);
  f.studio.captureFrame=async(progress,rotation,time)=>{
    frames.push({progress,rotation,time,transparent:f.studio.options.transparent});
    return new Blob(['rgba']);
  };
  Object.assign(f.context,{AbortController,DOMException,performance,backgroundFile:null,updateReferenceView(){},
    api:async(url,options)=>{
      requests.push({url,options});
      return url==='/api/exports'?{id:'alpha-test'}:url.endsWith('/finish')?{url:'/alpha.mov',filename:'alpha.mov',bytes:1024}:{};
    }});
  Object.assign(f.get('export-dialog'),{showModal(){},removeAttribute(){}});
  await f.context.exportVideo();
  assert.equal(JSON.parse(requests[0].options.body).format,'mov-alpha');
  assert.equal(frames.length,3);
  assert.deepEqual(frames.map(frame=>frame.progress),[0,.5,1]);
  assert.ok(frames.every(frame=>frame.transparent===true));
  assert.equal(f.studio.options.transparent,false);
  assert.equal(f.get('export-result').children[0].textContent,'下载透明 MOV 视频');
});

test('unsupported transparent codec refuses export before capturing or creating a job',async()=>{
  const f=fixture();f.config.format='mov-alpha';f.context.alphaVideoAvailable=false;
  let requested=false;f.context.api=async()=>{requested=true;};
  await f.context.exportVideo();
  assert.equal(requested,false);
  assert.equal(f.calls.some(call=>Array.isArray(call)&&['startExport','capture','realisticPackage'].includes(call[0])),false);
});

test('older test fixtures without performance hooks remain compatible',()=>{
  const f=fixture();delete f.studio.beginPreviewInteraction;delete f.studio.endPreviewInteraction;
  f.context.touchPreviewInteraction();f.context.playing=true;f.context.showTime();f.context.playing=false;f.context.showTime();
  assert.equal(f.context.previewPlaybackActive,false);
});
