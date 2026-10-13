import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {normalizeBackgroundAppearances} from '../src/background-appearance.js';
import {isBambuPrinterModel} from '../src/printer-presets.js';

const source=await readFile(new URL('../src/app.js',import.meta.url),'utf8');
const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
function actualFunction(name){const start=source.indexOf(`function ${name}(`);assert.ok(start>=0);return source.slice(start,source.indexOf('\n}',start)+2);}
function fixture(saved=null){
  const nodes=new Map();const get=id=>{if(!nodes.has(id))nodes.set(id,{value:id==='export-quality'?'realtime':'',type:'select',checked:false,textContent:''});return nodes.get(id);};
  const context=vm.createContext({$:get,exporting:false,loading:false,scene:'studio',sceneColors:{studio:'#123456'},backgroundPreset:'',printerPresets:{},isBambuPrinterModel,
    settingIds:['export-quality','ratio'],SURFACE_PRESETS:[],modelPose:()=>({modelScale:1}),normalizeBackgroundAppearances,backgroundAppearances:{},restoredSettingsData:null,
    localStorage:{getItem:()=>saved?JSON.stringify(saved):null},realisticEligibility:()=>({available:true,reason:''})});
  const declaration=source.match(/^let qualityPreference = .*;$/m)?.[0];assert.ok(declaration);vm.runInContext(declaration,context);
  vm.runInContext(actualFunction('restoreSettings')+'\n'+actualFunction('updateExportQualityUI'),context);
  return{context,get};
}

test('opening the workbench defaults to realtime in HTML and after renderer health becomes available',()=>{
  assert.match(html,/<option value="realtime" selected>实时 · 快速生成<\/option>/);
  const f=fixture();f.context.updateExportQualityUI();assert.equal(f.get('export-quality').value,'realtime');
});

test('restoring an older realistic project does not start a physical preview and still restores other settings',()=>{
  const f=fixture({'export-quality':'realistic',exportQualityPreference:'realistic',ratio:'9:16',hold:0});
  f.context.restoreSettings();f.context.updateExportQualityUI();
  assert.equal(f.get('export-quality').value,'realtime');assert.equal(f.get('ratio').value,'9:16');
});

test('explicit quality changes work during the session and unavailable rendering temporarily uses realtime',()=>{
  const f=fixture();vm.runInContext("qualityPreference='realistic'",f.context);f.context.updateExportQualityUI();
  assert.equal(f.get('export-quality').value,'realistic');
  f.context.realisticEligibility=()=>({available:false,reason:'暂不可用'});f.context.updateExportQualityUI();
  assert.equal(f.get('export-quality').value,'realtime');assert.equal(f.get('realistic-quality-option').disabled,true);
  f.context.realisticEligibility=()=>({available:true,reason:''});f.context.updateExportQualityUI();assert.equal(f.get('export-quality').value,'realistic');
});
