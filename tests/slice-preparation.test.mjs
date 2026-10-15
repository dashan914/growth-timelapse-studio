import { findPythonPath } from '../runtime-paths.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {zipSync,unzipSync,strToU8,strFromU8} from 'three/addons/libs/fflate.module.js';

const run=promisify(execFile),script=path.resolve('scripts/prepare-slice-project.py');
const presets={h2c:['Bambu Lab H2C 0.4 nozzle','0.20mm Standard @BBL H2C','Generic PLA @BBL H2C 0.4 nozzle'],p1s:['Bambu Lab P1S 0.4 nozzle','0.20mm Standard @BBL X1C','Bambu PLA Basic @BBL P1S 0.4 nozzle'],a1:['Bambu Lab A1 0.4 nozzle','0.20mm Standard @BBL A1','Generic PLA @BBL A1']};
async function resources(directory){
  const root=path.join(directory,'mock-bambu-resources','profiles');
  for(const type of ['machine','process','filament'])await fs.mkdir(path.join(root,'BBL',type),{recursive:true});
  for(const[preset,[machine,process,filament]]of Object.entries(presets)){
    const values={machine:{name:machine,type:'machine',printer_model:machine.replace(' 0.4 nozzle',''),nozzle_diameter:['0.4'],default_print_profile:process,printable_height:preset==='h2c'?'320':'256'},
      process:{name:process,type:'process',layer_height:'0.2',initial_layer_print_height:'0.2',wall_loops:'2',enable_support:'0'},
      filament:{name:filament,type:'filament',filament_type:['PLA'],nozzle_temperature:['220'],filament_flow_ratio:['1']}};
    for(const[type,name]of [['machine',machine],['process',process],['filament',filament]])await fs.writeFile(path.join(root,'BBL',type,name+'.json'),JSON.stringify(values[type]));
  }
  return root;
}
async function flashResources(directory){
  const root=path.join(directory,'mock-flash-resources','profiles');
  const profiles={machine:['Flashforge Creator 5 0.4 nozzle',{type:'machine',name:'Flashforge Creator 5 0.4 nozzle',printer_model:'Flashforge Creator 5',nozzle_diameter:['0.4'],printable_height:'220'}],
    process:['0.20mm Standard @FF C5',{type:'process',name:'0.20mm Standard @FF C5',layer_height:'0.2',initial_layer_print_height:'0.2',wall_loops:'2',enable_support:'0',tree_support_wall_count:'0'}],
    filament:['Generic PLA @FF C5',{type:'filament',name:'Generic PLA @FF C5',filament_type:['PLA'],nozzle_temperature:['220']} ]};
  for(const[type,[name,data]]of Object.entries(profiles)){const target=path.join(root,'Flashforge',type);await fs.mkdir(target,{recursive:true});await fs.writeFile(path.join(target,name+'.json'),JSON.stringify(data));}
  return root;
}
const model='<model unit="centimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="1"/></vertices><triangles><triangle v1="0" v2="1" v3="2" paint_color="8843"/></triangles></mesh></object></resources><build><item objectid="1" transform="1 0 0 0 1 0 0 0 1 11 12 0"/></build></model>';
const meta='<config><object id="1"><metadata key="extruder" value="1"/><metadata key="layer_height" value="0.18"/><part id="1" subtype="normal_part"><metadata key="extruder" value="2"/><metadata key="layer_height" value="0.08"/></part></object><plate><metadata key="plater_id" value="1"/></plate></config>';
async function stage(directory,name,bytes,options){
  const root=path.join(directory,name);await fs.mkdir(root);const source=path.join(root,'source.'+(options.format||'3mf')),prepared=path.join(root,'prepared.3mf'),report=path.join(root,'report.json'),settings=path.join(root,'options.json');
  await fs.writeFile(source,bytes);await fs.writeFile(settings,JSON.stringify({preset:'h2c',format:'3mf',...options}));
  await run(findPythonPath(),[script,source,prepared,report,settings]);
  return{root,source,bytes:await fs.readFile(source),archive:unzipSync(new Uint8Array(await fs.readFile(prepared))),report:JSON.parse(await fs.readFile(report,'utf8'))};
}

test('missing H2C prime tower position lies inside the shared nozzle area and explicit coordinates remain authoritative',async t=>{
  const directory=await fs.mkdtemp(path.join(tmpdir(),'h2c-prime-position-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const native=await resources(directory),machinePath=path.join(native,'BBL','machine',presets.h2c[0]+'.json');
  const machine=JSON.parse(await fs.readFile(machinePath,'utf8'));
  machine.extruder_printable_area=['0x0,325x0,325x320,0x320','25x0,330x0,330x320,25x320'];
  await fs.writeFile(machinePath,JSON.stringify(machine));
  const encode=settings=>zipSync({'3D/3dmodel.model':strToU8(model),'Metadata/model_settings.config':strToU8(meta),'Metadata/project_settings.config':strToU8(JSON.stringify(settings))});
  const base={filament_colour:['#ff3344','#2244ff']};
  const result=await stage(directory,'missing',encode(base),{forceReslice:true,slicerResources:native});
  const process=JSON.parse(await fs.readFile(path.join(result.root,'fallback-process.json'),'utf8'));
  assert.deepEqual(process.wipe_tower_x,['40']);assert.deepEqual(process.wipe_tower_y,['220']);
  assert.ok(result.report.corrections.some(change=>change.field==='wipe_tower_x'));
  assert.equal(strFromU8(result.archive['3D/3dmodel.model']),model);
  assert.equal(strFromU8(result.archive['Metadata/model_settings.config']),meta);
  const explicit={...base,wipe_tower_x:['73'],wipe_tower_y:['187']};
  const preserved=await stage(directory,'explicit',encode(explicit),{forceReslice:true,slicerResources:native});
  assert.deepEqual(preserved.report.rawSettings.wipe_tower_x,explicit.wipe_tower_x);
  assert.deepEqual(preserved.report.rawSettings.wipe_tower_y,explicit.wipe_tower_y);
  assert.ok(!preserved.report.corrections.some(change=>change.field==='wipe_tower_x'||change.field==='wipe_tower_y'));
});

test('Bambu staging uses injected native resources, explicit per-tool profiles and complete STL coordinate inversion',async t=>{
  const directory=await fs.mkdtemp(path.join(tmpdir(),'bambu-preparation-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));const native=await resources(directory);
  const stl='solid source\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 10 0 0\nvertex 0 10 2\nendloop\nendfacet\nendsolid source\n';
  for(const[preset,[machine,,filament]]of Object.entries(presets)){
    const r=await stage(directory,preset,stl,{format:'stl',preset,slicerResources:native,forceReslice:true,toolColors:['#123456','#123456'],sourceToPrinter:[1,0,0,0,0,0,1,0,0,-1,0,0,4,7,9,1],sourceCoordinateSystem:'three-y-up'});
    const profile=r.report.fallbackEngineProfiles;
    assert.equal(profile.machine,machine);assert.equal(profile.filament,filament);assert.equal(profile.resourcesDirectory,native);assert.equal(profile.logicalFilamentCount,2);assert.deepEqual(profile.toolColorsPreserved,['#123456','#123456']);
    assert.deepEqual(profile.loadSettings,['fallback-machine.json','fallback-process.json']);assert.deepEqual(profile.loadFilaments,['fallback-filament-1.json','fallback-filament-2.json']);
    const machineConfig=JSON.parse(await fs.readFile(path.join(r.root,'fallback-machine.json'),'utf8')),processConfig=JSON.parse(await fs.readFile(path.join(r.root,'fallback-process.json'),'utf8'));
    assert.equal(machineConfig.from,'user');assert.equal(machineConfig.inherits,machine);assert.notEqual(machineConfig.name,machineConfig.inherits);
    assert.equal(processConfig.from,'user');assert.equal(processConfig.inherits,presets[preset][1]);assert.notEqual(processConfig.name,processConfig.inherits);
    assert.ok(processConfig.compatible_printers.includes(machineConfig.inherits),'official CLI checks a loaded process list against the loaded user printer system parent');
    for(const file of profile.loadFilaments){const slot=JSON.parse(await fs.readFile(path.join(r.root,file),'utf8'));assert.deepEqual(slot.filament_colour,['#123456']);assert.equal(slot.from,'user');assert.equal(slot.inherits,filament);assert.ok(slot.compatible_printers.includes(machineConfig.inherits));if(process.platform!=='win32')assert.equal((await fs.stat(path.join(r.root,file))).mode&0o777,0o600);}
    const raw=JSON.parse(strFromU8(r.archive['Metadata/project_settings.config']));assert.equal(raw.layer_height,'0.16');assert.equal(raw.initial_layer_print_height,'0.2');assert.equal(r.report.triangleCount,1);assert.equal(r.report.forceReslice,true);assert.equal(r.report.geometrySimplified,false);
    const matrix=r.report.sourceToPrinter,shift=r.report.stagingTranslationMm,p=r.report.printerToSource,source=[3,4,1];
    const placed=[0,1,2].map(i=>matrix[i]*source[0]+matrix[4+i]*source[1]+matrix[8+i]*source[2]+matrix[12+i]+shift[i]);
    const restored=[0,1,2].map(i=>p[i]*placed[0]+p[4+i]*placed[1]+p[8+i]*placed[2]+p[12+i]);assert.deepEqual(restored,source);assert.equal(r.bytes.toString(),stl);
  }
});

test('forced Bambu re-slicing preserves original complex 3MF members/settings and removes cached paths only from the copy',async t=>{
  const directory=await fs.mkdtemp(path.join(tmpdir(),'bambu-forced-copy-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));const native=await resources(directory);
  const sourceSettings={printer_model:'Third-party machine',printer_settings_id:'Third-party 0.4 nozzle(source.3mf)',layer_height:'0.12',initial_layer_print_height:'0.25',enable_support:'1',support_type:'tree(auto)',filament_colour:['#123456','#123456'],filament_type:['PLA','PETG'],post_process:['do not run']};
  const bytes=zipSync({'3D/3dmodel.model':strToU8(model),'Metadata/model_settings.config':strToU8(meta),'Metadata/project_settings.config':strToU8(JSON.stringify(sourceSettings)),'Metadata/plate_1.gcode':strToU8('old complete paths'),'Metadata/plate_1.gcode.md5':strToU8('old hash'),'Metadata/thumbnail.png':new Uint8Array([1,2,3])});
  const r=await stage(directory,'forced',bytes,{forceReslice:true,slicerResources:native});
  assert.equal(r.report.embeddedGcode,null);assert.deepEqual(r.report.removedCachedSliceMembers,['Metadata/plate_1.gcode','Metadata/plate_1.gcode.md5']);assert.equal(r.archive['Metadata/plate_1.gcode'],undefined);await assert.rejects(fs.readFile(path.join(r.root,'embedded.gcode')),{code:'ENOENT'});
  assert.equal(strFromU8(r.archive['3D/3dmodel.model']),model);assert.equal(strFromU8(r.archive['Metadata/model_settings.config']),meta);assert.deepEqual(r.archive['Metadata/thumbnail.png'],new Uint8Array([1,2,3]));assert.deepEqual(r.bytes,Buffer.from(bytes));
  const raw=JSON.parse(strFromU8(r.archive['Metadata/project_settings.config']));assert.equal(raw.printer_model,'Bambu Lab H2C');assert.equal(raw.layer_height,'0.12');assert.equal(raw.initial_layer_print_height,'0.25');assert.equal(raw.enable_support,'1');assert.equal(raw.support_type,'tree(auto)');assert.deepEqual(raw.filament_colour,sourceSettings.filament_colour);assert.deepEqual(raw.filament_type,sourceSettings.filament_type);assert.deepEqual(raw.post_process,[]);
  assert.equal(r.report.objectSettings['1'].parts['1'].extruder,'2');assert.equal(r.report.objectSettings['1'].parts['1'].layer_height,'0.08');assert.ok(r.report.corrections.some(c=>c.field==='printer_model'&&c.before==='Third-party machine'&&c.after==='Bambu Lab H2C'));assert.deepEqual(r.report.printerToSource,[1,0,0,0,0,0,-1,0,0,1,0,0,0,0,0,1]);
});

test('complete saved Bambu configuration remains authoritative and actual multiple plates still reject before any engine',async t=>{
  const directory=await fs.mkdtemp(path.join(tmpdir(),'bambu-native-project-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const settings={printer_model:'Bambu Lab A1',printer_settings_id:'Saved Bambu custom 0.4 nozzle',layer_height:'0.12',initial_layer_print_height:'0.25',filament_colour:['#13579b'],enable_support:'0'};
  const entries={'3D/3dmodel.model':strToU8(model),'Metadata/model_settings.config':strToU8(meta),'Metadata/project_settings.config':strToU8(JSON.stringify(settings)),'Metadata/plate_2.gcode':strToU8('stale paths')};
  const r=await stage(directory,'native',zipSync(entries),{forceReslice:true,slicerResources:'/missing-unused-profile-resources'});assert.equal(r.report.fallbackEngineProfiles,null);assert.equal(r.report.rawSettings.printer_settings_id,settings.printer_settings_id);assert.equal(r.report.rawSettings.printer_model,settings.printer_model);assert.equal(r.report.embeddedGcode,null);assert.equal(strFromU8(r.archive['3D/3dmodel.model']),model);
  entries['Metadata/model_settings.config']=strToU8(meta.replace('</config>','<plate><metadata key="plater_id" value="2"/></plate></config>'));
  await assert.rejects(stage(directory,'multiple',zipSync(entries),{forceReslice:true}),error=>/多个打印盘/.test(error.stderr));
});

test('selected Flash registry uses its native profiles and identity with an explicit scene bed, while preserving original paint and support facts',async t=>{
  const directory=await fs.mkdtemp(path.join(tmpdir(),'flash-preparation-registry-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));const native=await flashResources(directory);
  const settings={printer_model:'Bambu Lab H2C',printer_settings_id:'Bambu Lab H2C 0.4 nozzle',layer_height:'0.12',initial_layer_print_height:'0.25',enable_support:'0',support_type:'tree(auto)',filament_colour:['#123456','#234567']};
  const bytes=zipSync({'3D/3dmodel.model':strToU8(model),'Metadata/model_settings.config':strToU8(meta),'Metadata/project_settings.config':strToU8(JSON.stringify(settings))});
  const r=await stage(directory,'flash',bytes,{engineId:'flash',profileVendor:'Flashforge',slicerResources:native,forceReslice:true});
  const profile=r.report.fallbackEngineProfiles;assert.equal(r.report.engineId,'flash');assert.equal(r.report.slicingEngine,'installed Flash Studio CLI');assert.equal(profile.profileVendor,'Flashforge');assert.equal(profile.machine,'Flashforge Creator 5 0.4 nozzle');assert.equal(profile.nativeProcessBaseProfile,'0.20mm Standard @FF C5');assert.equal(profile.filament,'Generic PLA @FF C5');assert.deepEqual(r.report.bedSizeMm,[330,320]);assert.deepEqual(profile.loadFilaments,['fallback-filament-1.json','fallback-filament-2.json']);assert.ok(profile.process.includes('@FF C5'));
  assert.equal(r.report.rawSettings.printer_model,'Flashforge Creator 5');assert.equal(r.report.rawSettings.layer_height,'0.12');assert.equal(r.report.rawSettings.initial_layer_print_height,'0.25');assert.equal(r.report.rawSettings.enable_support,'0');assert.equal(r.report.rawSettings.support_type,'tree(auto)');assert.deepEqual(r.report.rawSettings.filament_colour,settings.filament_colour);assert.equal(r.report.rawSettings.tree_support_wall_count,'0');assert.equal(strFromU8(r.archive['3D/3dmodel.model']),model);assert.equal(strFromU8(r.archive['Metadata/model_settings.config']),meta);assert.deepEqual(r.bytes,Buffer.from(bytes));
  const originalFlash=zipSync({'3D/3dmodel.model':strToU8(model),'Metadata/model_settings.config':strToU8(meta),'Metadata/project_settings.config':strToU8(JSON.stringify({...settings,printer_model:'Flashforge Creator 5',printer_settings_id:'Saved Flash custom'}))});
  const preserved=await stage(directory,'native-flash',originalFlash,{engineId:'flash',profileVendor:'Flashforge',slicerResources:'/unused-complete-project-resources',forceReslice:true});assert.equal(preserved.report.fallbackEngineProfiles,null);assert.equal(preserved.report.rawSettings.printer_settings_id,'Saved Flash custom');assert.equal(preserved.report.rawSettings.printer_model,'Flashforge Creator 5');
});

test('extruder_offset is normalized to 0x0 for re-slicing and compensated in printerToSource for embedded gcode',async t=>{
  const directory=await fs.mkdtemp(path.join(tmpdir(),'extruder-offset-alignment-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const settings={printer_model:'Bambu Lab P1S',printer_settings_id:'Bambu Lab P1S 0.4 nozzle',layer_height:'0.2',extruder_offset:['0x2'],filament_colour:['#112233']};
  const entriesReslice={'3D/3dmodel.model':strToU8(model),'Metadata/model_settings.config':strToU8(meta),'Metadata/project_settings.config':strToU8(JSON.stringify(settings))};
  const rReslice=await stage(directory,'reslice',zipSync(entriesReslice),{forceReslice:true,slicerResources:'/missing-unused'});
  assert.deepEqual(rReslice.report.rawSettings.extruder_offset,['0x0']);
  assert.deepEqual(rReslice.report.printerToSource,[1,0,0,0,0,0,-1,0,0,1,0,0,0,0,0,1]);
  assert.ok(rReslice.report.corrections.some(c=>c.field==='extruder_offset'&&c.after[0]==='0x0'));

  const entriesEmbedded={'3D/3dmodel.model':strToU8(model),'Metadata/model_settings.config':strToU8(meta),'Metadata/project_settings.config':strToU8(JSON.stringify(settings)),'Metadata/plate_1.gcode':strToU8('G1 X10 Y20 Z0.2 E1\n')};
  const rEmbedded=await stage(directory,'embedded',zipSync(entriesEmbedded),{forceReslice:false,slicerResources:'/missing-unused'});
  assert.deepEqual(rEmbedded.report.printerToSource,[1,0,0,0,0,0,-1,0,0,1,0,0,0,0,-2,1]);
});
