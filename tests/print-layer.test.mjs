import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePrintLayerGCode, classifyPrintFeature, PRINT_FEATURE, buildPrintLayerInstances, PRINTER_MM_TO_THREE_MM, selectPrintLayerSegments } from '../src/print-layer.js';

const fixture = `; filament_colour = #f0e8d6;#23599c
G21
G90
M82
G1 X0 Y0 Z0.2
;TYPE:Outer wall
;WIDTH:0.42
;HEIGHT:0.2
G1 X10 Y0 E1
;TYPE:Inner wall
;WIDTH:0.45
G1 X10 Y10 E2
T1
;TYPE:Internal infill
G1 X0 Y10 E3
;TYPE:Overhang wall
G1 X0 Y0 E4
;TYPE:Support
G1 X5 Y5 E5
G1 Z0.4
;TYPE:Top surface
G1 X10 Y5 E6
`;

test('real wall/infill/overhang paths retain widths, tool colors, layer heights and sparse topology', () => {
  const parsed = parsePrintLayerGCode(fixture);
  assert.equal(parsed.segmentCount, 5);
  assert.deepEqual([...parsed.layerHeights], [.2, .4]);
  assert.equal(classifyPrintFeature('Overhang wall'), PRINT_FEATURE.overhangWall);
  assert.equal(parsed.featureCounts.overhangWall, 1);
  assert.equal(parsed.unknownExtrusionMoves, 0);
  const layer = buildPrintLayerInstances(parsed, { layerIndex: 0, printerToSource: PRINTER_MM_TO_THREE_MM });
  assert.equal(layer.instanceCount, 4, 'only the four deposited paths exist, no solid fake face');
  assert.deepEqual(layer.colors, ['#f0e8d6','#f0e8d6','#23599c','#23599c']);
  assert.equal(layer.features[3], PRINT_FEATURE.overhangWall);
  assert.ok(Math.abs(parsed.widths[0]-.42)<1e-6 && Math.abs(parsed.widths[1]-.45)<1e-6);
  assert.ok(Math.abs(layer.matrices[13]-.1)<1e-6, 'bead centre maps printer Z minus half height into world Y');
  assert.equal(selectPrintLayerSegments(parsed, { layerIndex: 1, historyLayers: 1 }).length, 1);
  assert.equal(selectPrintLayerSegments(parsed, { layerIndex: 1, historyLayers: 2 }).length, 5);
  assert.throws(() => buildPrintLayerInstances(parsed, { layerIndex: 0 }), /明确/);
});

test('unhandled extrusion/spline motion is rejected instead of silently dropping genuine deposited paths', () => {
  for (const command of ['G5 X5 Y5 I1 J1 P1 Q1 E7','G6 X5 Y5 E7','G33 X5 Y5 E7','G38.2 X5 Y5 E7']) {
    assert.throws(() => parsePrintLayerGCode(fixture+command+'\n'), /不支持的/);
  }
  const parsed = parsePrintLayerGCode(fixture+'G4 P100\nG10\nG11\n');
  assert.equal(parsed.segmentCount, 5);
});

test('Bambu Z-trim and ABL setup preserve actual path coordinates, extrusion, dimensions and colors', () => {
  const original = parsePrintLayerGCode(fixture, { includeSupport: true });
  const setup = 'G29.1 Z0\nG29.2 S0\nG29.2 S1\nG29.1 Z-0.04\n';
  const candidate = parsePrintLayerGCode(setup + fixture.replace('G1 X10 Y0 E1\n', 'G1 X10 Y0 E1\n'+setup), { includeSupport: true });
  for (const name of ['positions','tools','features','widths','heights','layers','layerHeights','layerOffsets','layerSegments']) {
    assert.deepEqual(candidate[name], original[name], name);
  }
  assert.deepEqual(candidate.toolColors, original.toolColors);
  assert.equal(candidate.exactLinearPaths, true);
  assert.ok(candidate.strokes[1] > candidate.strokes[0], 'machine calibration interrupts a connected stroke');
});

test('official bare A1 G29.4 startup preserves all model paths and does not retain modal motion', () => {
  const setup = 'M211 X0 Y0 Z0\nM1007 S1\nG29.4\n';
  const original = parsePrintLayerGCode(fixture, { includeSupport: true });
  const result = parsePrintLayerGCode(setup + fixture.replace('G1 X10 Y0 E1\n', 'G1 X10 Y0 E1\n' + setup), { includeSupport: true });
  for (const name of ['positions','tools','features','widths','heights','layers','layerHeights','layerOffsets','layerSegments']) {
    assert.deepEqual(result[name], original[name], name);
  }
  assert.deepEqual(result.toolColors, original.toolColors);
  assert.equal(result.exactLinearPaths, true);
  assert.equal(parsePrintLayerGCode(fixture + 'G29.4\nX99 Y99 E7\n').segmentCount, 5);
  for (const command of ['G29.4 E7', 'G29.4 X5', 'G29.4 Z0', 'G29.4 S1', 'G29.40']) {
    assert.throws(() => parsePrintLayerGCode(fixture + command + '\n'), /不支持的/);
  }
});

test('machine calibration parameters cannot become modal extrusion or permit unknown G29 variants', () => {
  for (const command of ['G29.1 Z-0.04 E7','G29.2 S1 E7','G29.3 Z0','G29.3 S1','G29.3 X5 Y5 E7','G29.10 Z0','G383.70 J0']) {
    assert.throws(() => parsePrintLayerGCode(fixture + command + '\n'), /不支持的/);
  }
  for (const command of ['G29.1 Z-0.04','G29.2 S1']) {
    const candidate = parsePrintLayerGCode(fixture + command + '\nX99 Y99 E7\n');
    assert.equal(candidate.segmentCount, 5, 'coordinate words after a calibration are not inherited G1 paths');
  }
});

test('native H2C startup and service tools preserve actual colored model/support after absolute positioning', () => {
  const startup='G90\nM83\nG28.140 D0\nG150.3\nG151 P0\nG91\nG380 S2 Z42 F1200\nG380 S2 Z-12 F1200\nG90\nG3811 Z190\nG383.3 U140 L0\nG383 O2 U140 L0\nG383.7 U140 J0\nG29.20 A3\nG39.1\nG29.7 S1\nG28.14 R0\nG29.9\nG29.99\nT1001\n';
  const finish='T65279\nT65535\nG392 S0\n';
  const result=parsePrintLayerGCode(startup+fixture+finish,{includeSupport:true});
  const original=parsePrintLayerGCode(fixture,{includeSupport:true});
  for(const name of ['positions','tools','features','widths','heights','layers','layerHeights','layerOffsets','layerSegments'])assert.deepEqual(result[name],original[name],name);
  assert.deepEqual(result.usedTools,original.usedTools);
  assert.deepEqual(result.toolColors,original.toolColors);
  assert.equal(result.exactLinearPaths,true);
});

test('official X2D and A1 machine startup macros do not hide the following real model paths',()=>{
  const startup='G90\nM83\nG383.4\nG28 X\nG1 X0 Y0 Z0.2\nG2814 Z0.32\n';
  const result=parsePrintLayerGCode(startup+fixture);
  const original=parsePrintLayerGCode(fixture);
  assert.deepEqual(result.positions,original.positions);
  assert.deepEqual(result.tools,original.tools);
  assert.deepEqual(result.features,original.features);
  assert.equal(result.exactLinearPaths,true);
  assert.throws(()=>parsePrintLayerGCode(fixture+'G383.4 E7\n'),/不支持的/);
  assert.throws(()=>parsePrintLayerGCode(fixture+'G2814 Z0.32 E7\n'),/不支持的/);
  assert.throws(()=>parsePrintLayerGCode(fixture+'G383.40\n'),/不支持的/);
});

test('conditional H2C wiping requires absolute resynchronization before a retained deposition', () => {
  const wipe='G387 Y320 J1 F10000\nG1 X10 F30000\nG387 Y295 J1\nG387 Y265 J1\nG1 Y0 F30000\n';
  const result=parsePrintLayerGCode(fixture.replace('G1 X10 Y0 E1\n','G1 X10 Y0 E1\n'+wipe));
  const original=parsePrintLayerGCode(fixture);
  assert.deepEqual(result.positions,original.positions);
  assert.deepEqual(result.tools,original.tools);
  assert.deepEqual(result.widths,original.widths);
  for(const commands of ['G387 Y320 J1\nG1 X5 Y5 E7\n','G387 Y320 J1\nG91\nG1 Y-320\nG90\nG1 X5 Y5 E7\n','G150.1\nG1 X5 Y5 Z0.4 E7\n']) {
    assert.throws(()=>parsePrintLayerGCode(fixture+commands),/缺少明确的绝对定位/);
  }
  assert.throws(()=>parsePrintLayerGCode(fixture+'G387 Y320 J1 E7\n'),/不支持的/);
});

test('Bambu Floating vertical shell retains real paths as solid infill rather than unknown or bridge', () => {
  assert.equal(classifyPrintFeature('Floating vertical shell'), PRINT_FEATURE.solidInfill);
  const result=parsePrintLayerGCode(fixture.replace(';TYPE:Internal infill',';TYPE:Floating vertical shell'));
  assert.equal(result.features[2],PRINT_FEATURE.solidInfill);
  assert.equal(result.segmentCount,5);
  assert.equal(result.unknownExtrusionMoves,0);
  assert.equal(result.exactLinearPaths,true);
  assert.deepEqual(result.positions,parsePrintLayerGCode(fixture).positions);
});

test('Bambu SYNC wait parameters never override the selected filament or nominal path', () => {
  for(const wait of ['SYNC T0','SYNC T7 R1','SYNC T2.5 R0','sync T0','N12 SYNC T0*99']) {
    const result=parsePrintLayerGCode(fixture.replace('T1\n','T1\n'+wait+'\n'));
    const original=parsePrintLayerGCode(fixture);
    for(const name of ['positions','tools','features','widths','heights','strokes','layers','layerHeights','layerOffsets','layerSegments'])assert.deepEqual(result[name],original[name],`${wait}: ${name}`);
    assert.deepEqual(result.usedTools,[0,1]);
    assert.deepEqual(result.toolColors,original.toolColors);
  }
});

test('standalone Bambu virtual-filament tags select the source color without selecting a physical nozzle', () => {
  const result=parsePrintLayerGCode(fixture.replace('T1\n','   ;VT1 H-1\nSYNC T0\n'));
  const original=parsePrintLayerGCode(fixture);
  assert.deepEqual(result.tools,original.tools);
  assert.deepEqual(result.positions,original.positions);
  assert.deepEqual(result.toolColors,original.toolColors);
  assert.throws(()=>parsePrintLayerGCode(fixture+';VT255 H0\n'),/虚拟耗材编号无效/);
});

test('real-path limits fail rather than truncate and missing tool colors never become one guessed fill color', () => {
  assert.throws(() => parsePrintLayerGCode(fixture,{maxSegments:2}), /超过|限制/);
  const parsed = parsePrintLayerGCode(fixture);
  assert.throws(() => buildPrintLayerInstances(parsed,{layerIndex:0,printerToSource:PRINTER_MM_TO_THREE_MM,toolColors:['#ffffff']}), /缺少耗材/);
});

test('unknown annotated model roles cannot masquerade as complete real paths',()=>{
  const text=fixture+';TYPE:Unimplemented spline infill\nG1 X10 Y10 E8\n';
  assert.throws(()=>parsePrintLayerGCode(text),/无法识别切片用途/);
  const parsed=parsePrintLayerGCode(text,{strictFeatures:false});
  assert.equal(parsed.exactLinearPaths,false);
  assert.deepEqual(parsed.unknownFeatureLabels,{'Unimplemented spline infill':1});
  assert.equal(parsePrintLayerGCode(fixture,{includeSupport:true}).featureCounts.support,1);
});

test('unannotated sections use saved role widths and actual variable layer spacing even with trailing config',()=>{
  const text=`G21\nG90\nM82\nG1 X0 Y0 Z0.25\n;TYPE:Outer wall\nG1 X10 Y0 E1\nG1 Z0.37\nG1 X10 Y10 E2\nG1 Z0.55\n;TYPE:Inner wall\nG1 X0 Y10 E3\n;CONFIG_BLOCK_START\n; layer_height = 0.12\n; initial_layer_print_height = 0.25\n; initial_layer_line_width = 0.6\n; outer_wall_line_width = 0.5\n; inner_wall_line_width = 0.55\n;CONFIG_BLOCK_END\n`;
  const parsed=parsePrintLayerGCode(text);
  for(const [index,expected] of [[0,.25],[1,.12],[2,.18]])assert.ok(Math.abs(parsed.heights[index]-expected)<1e-6);
  for(const [index,expected] of [[0,.6],[1,.5],[2,.55]])assert.ok(Math.abs(parsed.widths[index]-expected)<1e-6);
  assert.equal(parsed.sectionSources.width.saved,3);assert.equal(parsed.sectionSources.height.layerSpacing,2);
});

test('parse progress measures source characters and indexed segments without changing any path arrays',()=>{
  const progress=[];
  const withProgress=parsePrintLayerGCode(fixture,{includeSupport:true,onProgress:event=>progress.push(event)});
  const original=parsePrintLayerGCode(fixture,{includeSupport:true});
  for(const name of ['positions','tools','features','widths','heights','strokes','layers','layerHeights','layerOffsets','layerSegments']) {
    assert.deepEqual(withProgress[name],original[name],name);
  }
  for(const phase of ['parse','index']) {
    const events=progress.filter(event=>event.phase===phase);
    assert.ok(events.length>=2);
    assert.equal(events[0].completed,0);
    assert.equal(events.at(-1).progress,1);
    assert.equal(events.at(-1).completed,phase==='parse'?fixture.length:withProgress.segmentCount*3);
    for(let index=1;index<events.length;index++)assert.ok(events[index].completed>=events[index-1].completed);
  }
  assert.equal(progress.find(event=>event.phase==='configuration').progress,null);
});
