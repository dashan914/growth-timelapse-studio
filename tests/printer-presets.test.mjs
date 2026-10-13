import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {BAMBU_PRINTER_MODELS,DEFAULT_BAMBU_PRINTER_MODEL_ID,isBambuPrinterModel} from '../src/printer-presets.js';
import {defaultSliceSettings} from '../src/slice-settings.js';

const expectedIds=['a1','a1-mini','a2l','h2c','h2d','h2d-pro','h2s','p1p','p1s','p2s','x1','x1-carbon','x1e','x2d'];

test('Bambu slice targets cover every model family in the pinned 0.4 mm profile catalog',()=>{
  assert.deepEqual(BAMBU_PRINTER_MODELS.map(model=>model.id),expectedIds);
  assert.equal(DEFAULT_BAMBU_PRINTER_MODEL_ID,'h2c');
  assert.equal(new Set(BAMBU_PRINTER_MODELS.map(model=>model.machineProfile)).size,expectedIds.length);
  for(const model of BAMBU_PRINTER_MODELS){
    assert.equal(model.nozzleDiameterMm,.4,model.id);
    assert.ok(model.machineProfile.endsWith('0.4 nozzle'),model.machineProfile);
    assert.ok(model.processProfile,`${model.id} process profile`);
    assert.ok(model.filamentProfile,`${model.id} filament profile`);
    assert.equal(isBambuPrinterModel(model.id),true);
    const settings=defaultSliceSettings(model.id);
    assert.equal(settings.preset,model.id);
    assert.equal(settings.fallbackProfile.name,model.processProfile);
  }
  assert.equal(isBambuPrinterModel('not-a-bambu-printer'),false);
});

test('target machine selector is independent from the three photographed printer backgrounds',async()=>{
  const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
  const select=html.match(/<select id="target-printer"[^>]*>([\s\S]*?)<\/select>/);
  assert.ok(select,'the import panel exposes a separate target-printer control');
  const optionIds=[...select[1].matchAll(/<option value="([^"]+)"/g)].map(match=>match[1]);
  assert.deepEqual(optionIds,expectedIds);
  const backgrounds=[...html.matchAll(/class="scene-preset" data-preset="([^"]+)"/g)].map(match=>match[1]);
  assert.deepEqual(backgrounds,['h2c','p1s','a1','pastel-rug','blue-grey','teal-room']);
});
