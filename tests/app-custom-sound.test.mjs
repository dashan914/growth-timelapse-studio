import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { PreviewSoundPlayer } from '../src/preview-sound-player.js';
import { soundEffect, soundUrl, validateCustomSound, CUSTOM_SOUND_LIMIT, CUSTOM_SOUND_DURATION } from '../src/sound-effects.js';

const source=await readFile(new URL('../src/app.js',import.meta.url),'utf8');
const settle=()=>new Promise(resolve=>setImmediate(resolve));
const audio=(name,options={})=>new File([JSON.stringify({name,duration:30,...options})],name,{type:'audio/wav'});
function actual(name){const start=source.search(new RegExp(`(?:async )?function ${name}\\(`));assert.ok(start>=0);return source.slice(start,source.indexOf('\n}',start)+2);}
function fixture({restoring=false}={}){
  const nodes=new Map(),contexts=[],fetches=[],patches=[],messages=[],revoked=[],waiting=new Map();let resumes=0;
  const get=id=>{if(!nodes.has(id))nodes.set(id,{value:'',checked:false,hidden:false,textContent:'',dataset:{},setAttribute(){}});return nodes.get(id);};
  get('sound-enabled').checked=true;
  for(const[id,value]of Object.entries({'growth-duration':8,hold:0,fps:30,ratio:'16:9',resolution:720,format:'mp4','camera-motion':'fixed','export-quality':'realtime'}))get(id).value=value;
  class AudioContext {
    constructor(){this.state='suspended';this.currentTime=100;this.destination={};this.sources=[];contexts.push(this);}
    createGain(){return{gain:{value:1},connect(){}};}
    resume(){resumes++;this.state='running';return Promise.resolve();}
    close(){this.state='closed';return Promise.resolve();}
    async decodeAudioData(bytes){const data=JSON.parse(new TextDecoder().decode(bytes));if(data.fail)throw new Error('unsupported codec');if(data.slow)await new Promise(resolve=>waiting.set(data.name,resolve));return data;}
    createBufferSource(){const node={starts:[],stops:0,connect(){},disconnect(){},start(...args){this.starts.push(args);},stop(){this.stops++;}};this.sources.push(node);return node;}
  }
  class SoundPlayer extends PreviewSoundPlayer {
    constructor(options){super({...options,fetchAudio:async url=>{fetches.push(url);return url.startsWith('blob:')?fetch(url):Response.json({name:'reference',duration:7.64});}});}
  }
  const context=vm.createContext({$:get,PreviewSoundPlayer:SoundPlayer,soundEffect,soundUrl,validateCustomSound,CUSTOM_SOUND_DURATION,
    window:{AudioContext},document:{hidden:false},URL:{createObjectURL:file=>URL.createObjectURL(file),revokeObjectURL:url=>{revoked.push(url);URL.revokeObjectURL(url);}},
    soundRestoreComplete:!restoring,customSoundFile:null,customSoundUrl:'',pendingSoundImport:null,soundImportSequence:0,previewSoundPlayer:null,
    restoringProject:restoring,restoredSettingsData:null,exporting:false,snapshotting:false,playing:true,time:2,calibrationMode:false,cropEditing:false,studio:null,
    cachePatch:patch=>patches.push(patch),persistSettings(){},say:(text,error)=>messages.push({text,error}),
    updateSettings(){context.syncEffectAudio(context.settings());}});
  vm.runInContext(['settings','createPreviewSoundPlayer','getPreviewSoundPlayer','stopEffectAudio','unlockPreviewSound','syncEffectAudio',
    'updateSoundSourceUI','releaseSoundImport','cancelSoundImport','clearCustomSound','importCustomSound','restoreProjectSound'].map(actual).join('\n'),context);
  return{context,get,contexts,fetches,patches,messages,revoked,waiting,get resumes(){return resumes;},
    async cleanup(){context.cancelSoundImport();context.previewSoundPlayer?.dispose();if(context.customSoundUrl)URL.revokeObjectURL(context.customSoundUrl);await settle();}};
}

test('supported common audio formats are size bounded before decoding',()=>{
  for(const name of ['sample.wav','sample.MP3','sample.m4a','sample.aac','sample.ogg','sample.flac'])assert.equal(validateCustomSound(audio(name)).name,name);
  assert.throws(()=>validateCustomSound(new File([],'empty.wav')),/有声音/);
  assert.throws(()=>validateCustomSound(new File(['x'],'wrong.stl',{type:'application/octet-stream'})),/WAV/);
  const huge=audio('huge.wav');Object.defineProperty(huge,'size',{value:CUSTOM_SOUND_LIMIT+1});
  assert.throws(()=>validateCustomSound(huge),/50 MiB/);
});

test('file import unlocks in the gesture and commits the decoded audio at the latest playback offset',async t=>{
  const f=fixture();t.after(()=>f.cleanup());
  const file=audio('slow.wav',{slow:true});const importing=f.context.importCustomSound(file);
  assert.equal(f.resumes,1,'resume must happen before any awaited file read or decode');
  while(!f.waiting.has(file.name))await settle();
  f.context.time=6;f.waiting.get(file.name)();assert.equal(await importing,true);
  assert.equal(f.context.settings().soundEffect,'custom');assert.equal(f.get('sound-enabled').checked,false);
  assert.equal(f.get('custom-sound-name').textContent,file.name);assert.equal(f.get('custom-sound-row').hidden,false);
  assert.equal(f.patches[0].customSoundFile,file);assert.equal(f.patches[0].soundMode,'custom');
  const active=f.context.previewSoundPlayer;assert.deepEqual(f.contexts[0].sources[0].starts,[[0,6]]);
  f.context.time=32;f.context.syncEffectAudio(f.context.settings());assert.equal(active.snapshot().status,'ended');
  f.context.time=3;f.context.syncEffectAudio(f.context.settings());assert.equal(active.snapshot().status,'playing');
  assert.equal(f.fetches.length,1,'seek and resume reuse the decoded custom buffer');
});

test('unsupported and overlong imports retain the previous valid source and project cache',async t=>{
  const f=fixture();t.after(()=>f.cleanup());
  const original=audio('original.wav');assert.equal(await f.context.importCustomSound(original),true);
  const player=f.context.previewSoundPlayer,url=f.context.customSoundUrl,count=f.patches.length;
  for(const bad of [audio('bad.wav',{fail:true}),audio('long.wav',{duration:601})])assert.equal(await f.context.importCustomSound(bad),false);
  assert.equal(f.context.customSoundFile,original);assert.equal(f.context.previewSoundPlayer,player);
  assert.equal(f.patches.length,count);assert.equal(f.revoked.includes(url),false);assert.equal(player.disposed,false);
  assert.ok(f.messages.some(item=>item.text.includes('10 分钟')));
});

test('a newer import cancels older pending decode and prevents stale source or filename commits',async t=>{
  const f=fixture();t.after(()=>f.cleanup());
  const first=audio('older.wav',{slow:true}),last=audio('latest.wav');const old=f.context.importCustomSound(first);
  while(!f.waiting.has(first.name))await settle();
  assert.equal(await f.context.importCustomSound(last),true);
  f.waiting.get(first.name)();assert.equal(await old,false);
  assert.equal(f.context.customSoundFile,last);assert.equal(f.get('custom-sound-name').textContent,last.name);
  assert.equal(f.patches.length,1);assert.equal(f.contexts[0].state,'closed');
  assert.equal(f.contexts[0].sources.length,0);
});

test('checking default cancels custom import and removing a custom file leaves preview silent',async t=>{
  const f=fixture();t.after(()=>f.cleanup());
  f.context.syncEffectAudio(f.context.settings());await f.context.unlockPreviewSound();await settle();
  const original=f.context.previewSoundPlayer;
  const file=audio('cancelled.wav',{slow:true}),importing=f.context.importCustomSound(file);
  while(!f.waiting.has(file.name))await settle();
  f.get('sound-enabled').checked=true;f.context.clearCustomSound();f.context.unlockPreviewSound();
  f.waiting.get(file.name)();assert.equal(await importing,false);
  assert.equal(f.context.previewSoundPlayer,original,'the default buffer remains cached through cancellation');
  assert.equal(f.context.settings().soundEffect,'reference');
  assert.equal(await f.context.importCustomSound(audio('selected.wav')),true);
  f.get('sound-enabled').checked=false;f.context.clearCustomSound();f.context.syncEffectAudio(f.context.settings());
  assert.equal(f.context.settings().soundEffect,'none');assert.equal(f.context.previewSoundPlayer,null);
  assert.equal(f.patches.at(-1).customSoundFile,null);assert.equal(f.patches.at(-1).soundMode,'none');
});

test('restored custom Blob fetches only its local URL and waits for a play gesture',async t=>{
  const f=fixture({restoring:true});t.after(()=>f.cleanup());
  f.context.syncEffectAudio(f.context.settings());assert.equal(f.fetches.length,0);
  await f.context.restoreProjectSound({soundMode:'custom',customSoundFile:audio('saved.wav')});
  assert.equal(f.context.settings().soundEffect,'custom');assert.equal(f.get('sound-enabled').checked,false);
  assert.ok(f.fetches.every(url=>url.startsWith('blob:')));assert.equal(f.resumes,0);
  assert.equal(f.patches.length,0,'restoration does not rewrite the cached source');
  await f.context.unlockPreviewSound();assert.equal(f.context.previewSoundPlayer.snapshot().status,'playing');
});
