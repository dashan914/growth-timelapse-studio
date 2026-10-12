import { findPythonPath } from '../runtime-paths.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'three/addons/libs/fflate.module.js';
import { defaultSliceSettings, normalizeSliceSettings, DEFAULT_LAYER_HEIGHT_MM, DEFAULT_FIRST_LAYER_HEIGHT_MM } from '../src/slice-settings.js';
import { parseFDMSlicerSettings, createFDMSurfaceUniforms } from '../src/fdm-surface.js';
import { parsePrintLayerGCode } from '../src/print-layer.js';
import { createSlicerProfiles } from './helpers/slicer-profiles.mjs';

const run = promisify(execFile);

test('missing regular height is the user 0.16 preference with independent Bambu first-layer/base facts', () => {
  assert.equal(DEFAULT_LAYER_HEIGHT_MM,.16);assert.equal(DEFAULT_FIRST_LAYER_HEIGHT_MM,.2);
  for (const preset of ['h2c','p1s','a1']) {
    const settings=defaultSliceSettings(preset);
    assert.equal(settings.layerHeightMm,.16);assert.equal(settings.firstLayerHeightMm,.2);
    assert.equal(settings.fields.layerHeightMm.source,'studio-default');
    assert.equal(settings.fields.layerHeightMm.defaultPolicy,'user-preference-0.16');
    assert.equal(settings.fields.firstLayerHeightMm.source,'bambu-default');
    assert.equal(settings.fields.wallLoops.source,'bambu-default');
    assert.equal(settings.wallLoops,2);assert.equal(settings.sparseInfillDensityPercent,15);
    assert.equal(settings.topShellLayers,5);assert.equal(settings.bottomShellLayers,3);
    assert.equal(settings.minimumTopShellLayers,7,'same 1mm minimum thickness, new missing layer preference');
    assert.match(settings.profileName,/Growth Studio 0\.16mm/);
    assert.match(settings.fallbackProfile.name,/0\.20mm Standard/);
    assert.equal(settings.fallbackProfile.parameterOverrides.layer_height.source,'studio-default');
  }
  const surface=parseFDMSlicerSettings({});
  const uniforms=createFDMSurfaceUniforms();
  assert.equal(surface.layerHeightMm,.16);assert.equal(surface.firstLayerHeightMm,.2);
  assert.equal(uniforms.fdmLayerHeight.value,.16);assert.equal(uniforms.fdmFirstLayerHeight.value,.2);
});

test('saved regular/first layer and part overrides retain their own provenance instead of 0.16', () => {
  const settings=normalizeSliceSettings({layer_height:'.12',initial_layer_print_height:'.25',print_settings_id:'Original0.12'},
    {objects:new Map([['1',{layer_height:'.18',parts:new Map([['2',{layer_height:'.08'}]])}]])});
  assert.equal(settings.layerHeightMm,.12);assert.equal(settings.firstLayerHeightMm,.25);
  assert.equal(settings.profileName,'Original0.12');assert.equal(settings.fields.layerHeightMm.source,'project');
  assert.deepEqual(settings.fallbackProfile.parameterOverrides,{});
  assert.equal(settings.overrides[0].settings.layerHeightMm,.18);
  assert.equal(settings.overrides[0].parts[0].settings.layerHeightMm,.08);
  assert.equal(parseFDMSlicerSettings({layer_height:'.12',initial_layer_print_height:'.25'}).firstLayerHeightMm,.25);
});

test('unannotated real Z sections stay authoritative, with 0.20 first and 0.16 spacing for an unstated source', () => {
  const text='G21\nG90\nM82\nG1 X0 Y0 Z0.2\n;TYPE:Outer wall\nG1 X10 Y0 E1\nG1 Z0.36\nG1 X10 Y10 E2\nG1 Z0.54\nG1 X0 Y10 E3\n';
  const parsed=parsePrintLayerGCode(text);
  assert.deepEqual([...parsed.layerHeights],[.2,.36,.54]);
  for(const [index,expected] of [[0,.2],[1,.16],[2,.18]])assert.ok(Math.abs(parsed.heights[index]-expected)<1e-6);
  assert.equal(parsed.sectionSources.height.layerSpacing,3);
  assert.deepEqual([...parsed.tools],[0,0,0]);assert.equal(parsed.segmentCount,3);
});

test('explicit 0.12 sections and saved 0.25 first height remain unchanged under new defaults', () => {
  const text='G21\nG90\nM82\nG1 X0 Y0 Z0.25\n;TYPE:Support\n;WIDTH:0.45\n;HEIGHT:0.25\nG1 X10 Y0 E1\nG1 Z0.37\n;HEIGHT:0.12\nT3\nG1 X10 Y10 E2\n;CONFIG_BLOCK_START\n; layer_height = 0.12\n; initial_layer_print_height = 0.25\n;CONFIG_BLOCK_END\n';
  const parsed=parsePrintLayerGCode(text,{includeSupport:true});
  assert.equal(parsed.segmentCount,2);assert.deepEqual([...parsed.tools],[0,3]);
  for(const [index,expected] of [[0,.25],[1,.12]])assert.ok(Math.abs(parsed.heights[index]-expected)<1e-6);
  assert.ok([...parsed.widths].every(w=>Math.abs(w-.45)<1e-6));
  assert.equal(parsed.sectionSources.height.annotation,2);assert.equal(parsed.sectionSources.height.studioDefault,0);
});

test('actual native preparation emits missing0.16 for all three beds without invoking a slicer', async t => {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'growth-default016-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const source=path.join(directory,'source.stl');
  const stl='solid source\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 10 0 0\nvertex 0 10 2\nendloop\nendfacet\nendsolid source\n';
  await fs.writeFile(source,stl);
  for (const preset of ['h2c','p1s','a1']) {
    const stage=path.join(directory,preset);await fs.mkdir(stage);
    const options=path.join(stage,'options.json'),prepared=path.join(stage,'prepared.3mf'),reportPath=path.join(stage,'report.json');
    await fs.writeFile(options,JSON.stringify({format:'stl',preset,toolColors:['#123456'],slicerResources:await createSlicerProfiles(directory)}));
    await run(findPythonPath(),['scripts/prepare-slice-project.py',source,prepared,reportPath,options]);
    const report=JSON.parse(await fs.readFile(reportPath,'utf8'));
    const files=unzipSync(new Uint8Array(await fs.readFile(prepared)));
    const raw=JSON.parse(strFromU8(files['Metadata/project_settings.config']));
    const process=JSON.parse(await fs.readFile(path.join(stage,'fallback-process.json'),'utf8'));
    assert.equal(Number(raw.layer_height),.16);assert.equal(Number(process.layer_height),.16);
    assert.equal(Number(raw.initial_layer_print_height),.2);assert.equal(Number(process.initial_layer_print_height),.2);
    assert.equal(report.fieldSources.layer_height.source,'studio-default');
    assert.equal(report.fieldSources.layer_height.defaultPolicy,'user-preference-0.16');
    assert.equal(report.fieldSources.initial_layer_print_height.source,'bambu-default');
    assert.equal(report.fallbackEngineProfiles.effectiveLayerHeightMm,.16);
    assert.match(process.name,/Growth Studio 0\.16mm/);
    assert.deepEqual(report.toolColors,['#123456']);assert.equal(report.triangleCount,1);assert.equal(report.geometrySimplified,false);
    const settings=normalizeSliceSettings(raw,{preset});
    assert.equal(settings.layerHeightMm,.16);assert.equal(settings.firstLayerHeightMm,.2);
  }
  assert.equal(await fs.readFile(source,'utf8'),stl);
});

test('saved0.12/0.25 and object/part heights survive actual staging byte-for-byte for geometry and overrides', async t => {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'growth-saved012-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const model='<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="10" y="0" z="0"/><vertex x="0" y="10" z="2"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object></resources><build><item objectid="1"/></build></model>';
  const override='<config><object id="1"><metadata key="layer_height" value="0.18"/><part id="1" subtype="normal_part"><metadata key="layer_height" value="0.08"/></part></object></config>';
  const bytes=zipSync({'3D/3dmodel.model':strToU8(model),'Metadata/model_settings.config':strToU8(override),
    'Metadata/project_settings.config':strToU8(JSON.stringify({layer_height:'0.12',initial_layer_print_height:'0.25',filament_colour:['#123456']}))});
  const source=path.join(directory,'source.3mf'),prepared=path.join(directory,'prepared.3mf'),reportPath=path.join(directory,'report.json'),options=path.join(directory,'options.json');
  await fs.writeFile(source,bytes);await fs.writeFile(options,JSON.stringify({format:'3mf',preset:'a1',slicerResources:await createSlicerProfiles(directory)}));
  await run(findPythonPath(),['scripts/prepare-slice-project.py',source,prepared,reportPath,options]);
  const report=JSON.parse(await fs.readFile(reportPath,'utf8'));
  const files=unzipSync(new Uint8Array(await fs.readFile(prepared)));
  const raw=JSON.parse(strFromU8(files['Metadata/project_settings.config']));
  const process=JSON.parse(await fs.readFile(path.join(directory,'fallback-process.json'),'utf8'));
  assert.equal(raw.layer_height,'0.12');assert.equal(raw.initial_layer_print_height,'0.25');
  assert.equal(process.layer_height,'0.12');assert.equal(process.initial_layer_print_height,'0.25');
  assert.equal(report.fieldSources.layer_height.source,'project');assert.equal(report.fieldSources.initial_layer_print_height.source,'project');
  assert.equal(report.objectSettings['1'].layer_height,'0.18');assert.equal(report.objectSettings['1'].parts['1'].layer_height,'0.08');
  assert.equal(strFromU8(files['3D/3dmodel.model']),model);assert.equal(strFromU8(files['Metadata/model_settings.config']),override);
  assert.deepEqual(await fs.readFile(source),Buffer.from(bytes));
});
