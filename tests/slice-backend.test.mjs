import { findPythonPath } from '../runtime-paths.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { access, chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createSliceService, friendlyNativeFailure, indexSliceGCode, SLICE_SLICER, validateSliceOptions } from '../slice-jobs.mjs';
import { parsePrintLayerGCode } from '../src/print-layer.js';

const execFileAsync = promisify(execFile);
const axis = [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1];
const gcode = '; generated mock visualization\r\n; filament_colour = #F0E8D6;#23599C\r\n; layer_height = 0.12\r\nG21\r\nG90\r\nM83\r\n;LAYER_CHANGE\r\n;Z:0.25\r\n;HEIGHT:0.25\r\nG0 X110 Y120 Z0.25\r\n;TYPE:Outer wall\r\n;WIDTH:0.42\r\nG1 X120 Y120 E1\r\n;TYPE:Inner wall\r\nG1 X120 Y130 E1\r\n;TYPE:Bottom surface\r\nT1\r\nG1 X110 Y130 E1\r\n;LAYER_CHANGE\r\n;Z:0.37\r\n;HEIGHT:0.12\r\nG0 X110 Y120 Z0.37\r\n;TYPE:Sparse infill\r\nG1 X120 Y130 E1\r\n;TYPE:Support\r\nG1 X120 Y140 E1\r\nM104 S220\r\n';
const hash = buffer => createHash('sha256').update(buffer).digest('hex');
const mockEngineProbe = async ({slicerPath}) => ({available:true,engine:'Bambu Studio CLI',version:'02.07.01.57',engineRevision:'bambu-test',executablePath:slicerPath,profileDirectory:'/Applications/BambuStudio.app/Contents/Resources/profiles'});

async function project(root, overrides = {}, metadata = '<config><object id="1"><metadata key="wall_loops" value="4"/><part id="1" subtype="normal_part"><metadata key="sparse_infill_density" value="20%"/></part></object></config>') {
  const filename = path.join(root, 'original.3mf');
  const settings = { printer_model: 'Flashforge Creator 5', printer_settings_id: 'Flashforge Creator 5 0.4 nozzle(source.3mf)',
    print_settings_id: '0.12mm Standard @FF C5(source.3mf)', layer_height: '0.12', initial_layer_print_height: '0.25',
    wall_loops: '2', sparse_infill_density: '15%', sparse_infill_pattern: 'grid', top_shell_layers: '5', top_shell_thickness: '1',
    bottom_shell_layers: '3', enable_support: '0', support_type: 'tree(auto)',
    filament_colour: ['#F0E8D6', '#23599C'], filament_type: ['PLA', 'PLA'], post_process: ['untrusted-cannot-run'], ...overrides };
  const mesh = '<?xml version="1.0"?><model unit="millimeter"><resources><object id="1" type="model"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2" paint_color="4"/></triangles></mesh></object></resources><build><item objectid="1" transform="1 0 0 0 1 0 0 0 1 110 120 0"/></build></model>';
  await execFileAsync(findPythonPath(), ['-c',
    'import zipfile,sys; z=zipfile.ZipFile(sys.argv[1],"w",compression=zipfile.ZIP_DEFLATED); z.writestr("Metadata/project_settings.config",sys.argv[2]); z.writestr("Metadata/model_settings.config",sys.argv[3]); z.writestr("3D/3dmodel.model",sys.argv[4]); z.close()',
    filename, JSON.stringify(settings), metadata, mesh]);
  return { filename, bytes: await readFile(filename), settings, mesh, metadata };
}

function cubeStl(size = 10) {
  const vertices = [[0, 0, 0], [size, 0, 0], [size, size, 0], [0, size, 0], [0, 0, size], [size, 0, size], [size, size, size], [0, size, size]];
  const faces = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const buffer = Buffer.alloc(84 + 50 * faces.length);
  buffer.write('full triangle fixture', 0); buffer.writeUInt32LE(faces.length, 80);
  faces.forEach((face, index) => face.flatMap(i => vertices[i]).forEach((value, offset) => buffer.writeFloatLE(value, 84 + 50 * index + 12 + 4 * offset)));
  return buffer;
}

async function fixture(t, { delay = 15, output = gcode, engineError = null, ...options } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'full-slice-backend-'));
  const mock = path.join(root, 'mock-slicer.mjs'), proof = path.join(root, 'arguments.json');
  await writeFile(mock, `#!${process.execPath}\nimport { mkdir, writeFile } from 'node:fs/promises';\nimport path from 'node:path';\nconst args = process.argv.slice(2);\nawait writeFile(${JSON.stringify(proof)},JSON.stringify(args));\nawait new Promise(resolve=>setTimeout(resolve,${delay}));\n${engineError ? `process.stderr.write(${JSON.stringify(engineError)});process.exit(156);` : ''}\nconst directory=args[args.indexOf('--outputdir')+1];\nawait mkdir(directory,{recursive:true});\nawait writeFile(path.join(directory,'plate_1.gcode'),${JSON.stringify(output)});\n`);
  await chmod(mock, 0o700);
  const service = createSliceService({ root, slicerPath: mock, engineProbe: mockEngineProbe, ...options });
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
  return { root, service, proof };
}

async function waitFor(service, id) {
  for (let attempt = 0; attempt < 800; attempt++) {
    const current = service.snapshot(id);
    if (current.status !== 'running') return current;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Slice service failed to settle.');
}

test('full slicing retains every source G-code byte, project geometry/paint/placements and real parameter provenance', async t => {
  const { root, service, proof } = await fixture(t);
  const source = await project(root);
  const created = await service.create(source.bytes, { format: '3mf', sourceName: '用户工程.3mf' });
  assert.equal(service.snapshot(created.id).status, 'running');
  await assert.rejects(service.gcodeFile(created.id), { code: 'SLICE_NOT_FINISHED' });
  const completed = await waitFor(service, created.id);
  assert.equal(completed.status, 'complete', completed.message);
  assert.equal(completed.progress, 100);
  assert.equal(completed.layerCount, 2);
  assert.equal(completed.gcodeBytes, Buffer.byteLength(gcode));
  assert.equal(completed.gcodeSha256, hash(gcode));
  assert.deepEqual(completed.printerToSource, axis);
  assert.deepEqual(completed.toolColors, ['#f0e8d6', '#23599c']);
  assert.equal(completed.sliceSettings.layerHeightMm, 0.12);
  assert.equal(completed.sliceSettings.wallLoops, 2);
  assert.equal(completed.sliceSettings.sparseInfillDensityPercent, 15);
  assert.equal(completed.sliceSettings.sparseInfillPattern, 'grid');
  assert.equal(completed.sliceSettings.fields.wallLoops.source, 'project');
  assert.equal(completed.sliceSettings.fields.topSurfacePattern.source, 'bambu-default');
  assert.equal(completed.sliceSettings.exactToolpaths, true);
  assert.deepEqual(await readFile(await service.gcodeFile(created.id)), Buffer.from(gcode));
  assert.deepEqual(await readFile(source.filename), source.bytes, 'original archive is untouched');
  const report = await service.provenance(created.id);
  assert.equal(report.sourceSha256, hash(source.bytes));
  assert.equal(report.savedSupportFields.enable_support, '0', 'source support remains disabled');
  assert.equal(report.rawSettings.enable_support, '0');
  assert.deepEqual(report.rawSettings.post_process, []);
  assert.equal(report.preservedMembers['3D/3dmodel.model'].sha256, hash(source.mesh));
  assert.equal(report.preservedMembers['Metadata/model_settings.config'].sha256, hash(source.metadata));
  assert.equal(report.objectSettings['1'].wall_loops, '4');
  assert.equal(report.sliceSettings.overrides[0].parts[0].settings.sparseInfillDensityPercent, 20);
  assert.equal(report.geometrySimplified, false);
  const manifest = JSON.parse(await readFile(await service.file(created.id), 'utf8'));
  assert.equal(manifest.completeFileRetained, true);
  assert.equal(manifest.segmentsSimplified, false);
  assert.deepEqual(await readdir(path.join(root, '.slice-jobs', created.id)), ['full.gcode', 'manifest.json', 'source.json']);
  assert.equal((await stat(path.join(root, '.slice-jobs', created.id))).mode & 0o777, 0o700);
  for (const name of ['full.gcode', 'manifest.json', 'source.json']) assert.equal((await stat(path.join(root, '.slice-jobs', created.id, name))).mode & 0o777, 0o600);
  const args = JSON.parse(await readFile(proof, 'utf8'));
  assert.equal(args[args.indexOf('--arrange') + 1], '0');
  assert.equal(args[args.indexOf('--orient') + 1], '0');
  assert.equal(args.includes('--datadir'),false,'Bambu CLI does not accept the Orca/Flash datadir switch');
  assert.ok(args.includes('--load-settings'),'a foreign machine is staged with explicit Bambu machine/process compatibility');
  assert.ok(args[args.indexOf('--load-settings')+1].endsWith('fallback-process.json'));
  assert.ok(args[args.indexOf('--load-settings')+1].includes('fallback-machine.json'));
  assert.ok(args.includes('--load-filaments'));
  const filamentFiles=args[args.indexOf('--load-filaments')+1].split(';');
  assert.equal(filamentFiles.length,2);assert.ok(filamentFiles[0].endsWith('fallback-filament-1.json'));assert.ok(filamentFiles[1].endsWith('fallback-filament-2.json'));
});

test('streaming index records exact CRLF/UTF-8 byte ranges and never alters source moves', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'slice-index-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filename = path.join(root, 'source.gcode');
  const text = '; 用户原色\r\n' + gcode;
  await writeFile(filename, text);
  const index = await indexSliceGCode(filename);
  assert.equal(index.gcodeSha256, hash(text));
  assert.equal(index.gcodeBytes, Buffer.byteLength(text));
  assert.equal(index.layerCount, 2);
  assert.equal(index.layers[0].heightMm, 0.25);
  assert.equal(index.layers[1].heightMm, 0.37);
  const buffer = Buffer.from(text);
  for (const layer of index.layers) assert.match(buffer.subarray(layer.startByte, layer.endByte).toString(), /^;LAYER_CHANGE\r\n;Z:/);
  assert.equal(index.layers[0].endByte, index.layers[1].startByte);
  assert.equal(index.layers[1].endByte, buffer.length);
  await assert.rejects(indexSliceGCode(filename, { maximumBytes: 50 }), { code: 'SLICE_OUTPUT_TOO_LARGE' });
  await assert.rejects(indexSliceGCode(filename, { isCancelled: () => true }), { code: 'SLICE_CANCELLED' });
});

test('current Bambu CHANGE_LAYER and Z_HEIGHT comments produce the same complete byte index', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'bambu-layer-index-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filename = path.join(root, 'current.gcode');
  const text = gcode.replaceAll(';LAYER_CHANGE', '; CHANGE_LAYER').replaceAll(';Z:', '; Z_HEIGHT:').replaceAll(';HEIGHT:', '; LAYER_HEIGHT:');
  await writeFile(filename, text);
  const index = await indexSliceGCode(filename);
  const parsed = parsePrintLayerGCode(text, { includeSupport: true });
  assert.equal(index.layerCount, parsed.layerHeights.length);
  assert.deepEqual(index.layers.map(layer => layer.heightMm), Array.from(parsed.layerHeights));
  assert.equal(index.gcodeSha256, hash(text));
  assert.equal(index.layers[0].endByte, index.layers[1].startByte);
  assert.equal(index.layers[1].endByte, Buffer.byteLength(text));
  await writeFile(filename, text.replaceAll(/^; Z_HEIGHT:.*\r\n/gm, ''));
  await assert.rejects(indexSliceGCode(filename), { code: 'SLICE_LAYER_INDEX_MISSING' });
});

test('slice option validation rejects paths, implicit Y-up mappings, singular matrices and invalid palette', () => {
  assert.throws(() => validateSliceOptions({ filename: '/etc/passwd' }), { code: 'SLICE_OPTIONS_INVALID' });
  assert.throws(() => validateSliceOptions({ format: 'glb' }), { code: 'SLICE_FORMAT_INVALID' });
  assert.throws(() => validateSliceOptions({ format: 'stl', sourceCoordinateSystem: 'three-y-up' }), { code: 'SLICE_TRANSFORM_INVALID' });
  assert.throws(() => validateSliceOptions({ sourceToPrinter: new Array(16).fill(0) }), { code: 'SLICE_TRANSFORM_INVALID' });
  assert.throws(() => validateSliceOptions({ format: '3mf', sourceToPrinter: axis }), { code: 'SLICE_TRANSFORM_INVALID' });
  assert.throws(() => validateSliceOptions({ toolColors: ['javascript:bad'] }), { code: 'SLICE_PALETTE_INVALID' });
  assert.equal(validateSliceOptions({ sourceName: '../../valid.3mf' }).sourceName, 'valid.3mf');
});

test('body limits, empty upload, concurrent reservation and unavailable engine leave no partial job', async t => {
  const { root, service } = await fixture(t, { delay: 500, maximumProjectBytes: 4096 });
  await assert.rejects(service.create(Buffer.alloc(0)), { code: 'EMPTY_SLICE_INPUT' });
  await assert.rejects(service.create(Buffer.alloc(4097)), { code: 'SLICE_BODY_TOO_LARGE' });
  const source = await project(root);
  const firstPromise = service.create(source.bytes);
  await assert.rejects(service.create(source.bytes), { code: 'SLICE_BUSY' });
  const first = await firstPromise;
  await service.cancel(first.id);
  assert.equal(service.snapshot(first.id).status, 'cancelled');
  assert.deepEqual(await readdir(path.join(root, '.slice-jobs')), []);
  const unavailable = createSliceService({ root: path.join(root, 'unavailable'), slicerPath: '/missing-slicer' });
  assert.equal((await unavailable.health()).available, false);
  await assert.rejects(unavailable.create(cubeStl(), { format: 'stl' }), { code: 'SLICE_SLICER_UNAVAILABLE' });
  await assert.rejects(readdir(path.join(root, 'unavailable', '.slice-jobs')), { code: 'ENOENT' });
  await unavailable.close();
});

test('request uploads enforce content type, declared size, interruption and upload timeout', async t => {
  const { service } = await fixture(t, { uploadTimeoutMs: 35, maximumProjectBytes: 100 });
  const wrong = new PassThrough(); wrong.headers = { 'content-type': 'model/3mf' };
  await assert.rejects(service.create(wrong), { code: 'SLICE_CONTENT_TYPE_INVALID' });
  const oversized = new PassThrough(); oversized.headers = { 'content-type': 'application/octet-stream', 'content-length': '101' };
  await assert.rejects(service.create(oversized), { code: 'SLICE_BODY_TOO_LARGE' });
  const interrupted = new PassThrough(); interrupted.headers = { 'content-type': 'application/octet-stream' };
  const whenAbortHandlerAttached = event => {
    if (event !== 'aborted') return;
    interrupted.off('newListener', whenAbortHandlerAttached);
    queueMicrotask(() => interrupted.emit('aborted'));
  };
  interrupted.on('newListener', whenAbortHandlerAttached);
  const upload = service.create(interrupted);
  await assert.rejects(upload, { code: 'SLICE_UPLOAD_INTERRUPTED' });
  const stalled = new PassThrough(); stalled.headers = { 'content-type': 'application/octet-stream' };
  await assert.rejects(service.create(stalled), { code: 'SLICE_CANCELLED' });
});

test('timed out and oversized native outputs fail without partial paths and release the active slot', async t => {
  const { root, service } = await fixture(t, { delay: 2000, timeoutMs: 100 });
  const source = await project(root);
  const created = await service.create(source.bytes);
  const failed = await waitFor(service, created.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.errorCode, 'SLICE_TIMEOUT');
  assert.match(failed.message, /超时/);
  assert.deepEqual(await readdir(path.join(root, '.slice-jobs')), []);
  const next = await service.create(source.bytes);
  await service.cancel(next.id);
  const tiny = await fixture(t, { maximumGcodeBytes: 100 });
  const tooLarge = await tiny.service.create(source.bytes);
  const rejected = await waitFor(tiny.service, tooLarge.id);
  assert.equal(rejected.status, 'failed');
  assert.equal(rejected.errorCode, 'SLICE_OUTPUT_TOO_LARGE');
  await assert.rejects(tiny.service.gcodeFile(tooLarge.id), { code: 'SLICE_NOT_FINISHED' });
  assert.deepEqual(await readdir(path.join(tiny.root, '.slice-jobs')), []);
});

test('retained whole-file cache evicts explicitly and cancellation releases completed private results', async t => {
  const { root, service } = await fixture(t, { maximumRetainedJobs: 1 });
  const source = await project(root);
  const first = await service.create(source.bytes); assert.equal((await waitFor(service, first.id)).status, 'complete');
  const second = await service.create(source.bytes); assert.equal((await waitFor(service, second.id)).status, 'complete');
  assert.equal(service.snapshot(first.id).status, 'expired');
  await assert.rejects(service.gcodeFile(first.id), { code: 'SLICE_NOT_FINISHED' });
  assert.deepEqual(await readdir(path.join(root, '.slice-jobs')), [second.id]);
  await service.cancel(second.id);
  assert.deepEqual(await readdir(path.join(root, '.slice-jobs')), []);
  await assert.rejects(service.gcodeFile('../../secret'), { code: 'SLICE_NOT_FOUND' });
});

test('invalid archive and untyped outputs fail explicitly instead of presenting invented full infill', async t => {
  const { root, service, proof } = await fixture(t);
  const bad = await service.create(Buffer.from('not zip'));
  assert.equal((await waitFor(service, bad.id)).status, 'failed');
  await assert.rejects(readFile(proof), { code: 'ENOENT' });
  const untyped = await fixture(t, { output: 'G90\nM83\nG0 X0 Y0 Z0.2\nG1 X10 Y10 E1\n' });
  const source = await project(root);
  const created = await untyped.service.create(source.bytes);
  const failed = await waitFor(untyped.service, created.id);
  assert.equal(failed.errorCode, 'SLICE_NO_MODEL_PATHS');
  assert.equal(failed.status, 'failed');
});

test('all STL triangles and explicit source axes survive staging without reduced detail or hidden resize', async t => {
  const { root, service } = await fixture(t, { output: gcode.replace('#F0E8D6;#23599C', '#ABCDEF') });
  const source = cubeStl();
  const toPrinter = [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1];
  const created = await service.create(source, { format: 'stl', preset: 'a1', sourceCoordinateSystem: 'three-y-up', sourceToPrinter: toPrinter, toolColors: ['#ABCDEF'] });
  const complete = await waitFor(service, created.id);
  assert.equal(complete.status, 'complete', complete.message);
  const report = await service.provenance(created.id);
  assert.equal(report.triangleCount, 12);
  assert.equal(report.geometrySimplified, false);
  assert.deepEqual(report.sourceToPrinter, toPrinter);
  assert.deepEqual(report.bedSizeMm, [256, 256]);
  assert.deepEqual(report.stagingTranslationMm, [123, 133, 0]);
  const p = report.printerToSource;
  const printer = [128, 128, 5];
  const mapped = [0, 1, 2].map(row => p[row] * printer[0] + p[4 + row] * printer[1] + p[8 + row] * printer[2] + p[12 + row]);
  assert.deepEqual(mapped, [5, 5, 5]);
  assert.equal(complete.sliceSettings.layerHeightMm, 0.16);
  assert.equal(complete.sliceSettings.firstLayerHeightMm, 0.2);
  assert.equal(complete.sliceSettings.sparseInfillDensityPercent, 15);
  assert.equal(complete.sliceSettings.fields.layerHeightMm.source, 'studio-default');
  assert.equal(complete.sliceSettings.fields.layerHeightMm.defaultPolicy, 'user-preference-0.16');
  const oversized = await service.create(cubeStl(400), { format: 'stl', preset: 'a1' });
  const failed = await waitFor(service, oversized.id);
  assert.equal(failed.status, 'failed');
  assert.match(failed.message, /超出底板.*没有缩放或减面/);
});

test('a native palette substitution fails rather than silently repainting sliced geometry', async t => {
  const { root, service } = await fixture(t, { output: gcode.replace('#F0E8D6;#23599C', '#000000;#FFFFFF') });
  const source = await project(root);
  const created = await service.create(source.bytes);
  const result = await waitFor(service, created.id);
  assert.equal(result.status, 'failed');
  assert.equal(result.errorCode, 'SLICE_PALETTE_MISMATCH');
  await assert.rejects(service.gcodeFile(created.id), { code: 'SLICE_NOT_FINISHED' });
});

test('production always re-slices original model through Bambu even when a stale embedded slice exists', async t => {
  const fresh=gcode.replace('; layer_height = 0.12','; layer_height = 0.12\r\n; wall_loops = 9');
  const { root, service, proof } = await fixture(t, { output: fresh });
  const source = await project(root, { wall_loops: '9' });
  const embedded = gcode.replace('; layer_height = 0.12', '; layer_height = 0.12\r\n; wall_loops = 2');
  await execFileAsync(findPythonPath(), ['-c', 'import zipfile,sys; z=zipfile.ZipFile(sys.argv[1],"a",compression=zipfile.ZIP_DEFLATED); z.writestr("Metadata/plate_1.gcode",sys.argv[2]); z.close()', source.filename, embedded]);
  const originalBytes = await readFile(source.filename);
  const created = await service.create(originalBytes);
  const result = await waitFor(service, created.id);
  assert.equal(result.status, 'complete', result.message);
  assert.equal(result.engine, 'Bambu Studio CLI');
  assert.equal(result.engineRevision,'bambu-test');
  assert.equal(result.reSliced, true);
  assert.equal(result.plateCount, 1);
  assert.equal(result.sliceSettings.wallLoops, 9, 'new paths follow source model settings rather than old cached paths');
  assert.deepEqual(await readFile(await service.gcodeFile(created.id)), Buffer.from(fresh));
  assert.ok(JSON.parse(await readFile(proof,'utf8')).includes('--slice'));
  const report = await service.provenance(created.id);
  assert.equal(report.embeddedGcode,null);assert.equal(report.forceReslice,true);assert.deepEqual(report.removedCachedSliceMembers,['Metadata/plate_1.gcode']);
  assert.equal(report.actualOutput.reSliced, true);
  assert.deepEqual(await readFile(source.filename), originalBytes);
  const extractionOnly = createSliceService({ root: path.join(root, 'explicit-research-extraction'), slicerPath: '/missing-native-slicer',forceReslice:false });
  const capabilities = await extractionOnly.health();
  assert.equal(capabilities.available, false);
  assert.equal(capabilities.embeddedAvailable, true);
  const extracted = await extractionOnly.create(originalBytes);
  assert.equal((await waitFor(extractionOnly, extracted.id)).status, 'complete');
  assert.deepEqual(await readFile(await extractionOnly.gcodeFile(extracted.id)), Buffer.from(embedded));
  await extractionOnly.close();
});

test('multi-plate projects fail clearly before native slicing instead of mixing all models with only plate one paths', async t => {
  const { root, service, proof } = await fixture(t);
  const metadata = '<config><object id="1"><metadata key="extruder" value="1"/></object><plate><metadata key="plater_id" value="1"/><model_instance><metadata key="object_id" value="1"/></model_instance></plate><plate><metadata key="plater_id" value="2"/></plate></config>';
  const source = await project(root, {}, metadata);
  const created = await service.create(source.bytes);
  const result = await waitFor(service, created.id);
  assert.equal(result.status, 'failed');
  assert.match(result.message, /多个打印盘.*只包含一个打印盘/);
  await assert.rejects(readFile(proof), { code: 'ENOENT' });
  await assert.rejects(service.gcodeFile(created.id), { code: 'SLICE_NOT_FINISHED' });
});

test('native failures show short actionable Chinese messages while complete original diagnostics stay private', async t => {
  const raw = 'private source diagnostics /private/tmp/do-not-display-path\n' + 'detailed engine diagnostics\n'.repeat(120) + 'No layers were detected. Model might be too small or invalid.\n';
  const { root, service } = await fixture(t, { engineError: raw });
  const source = await project(root), created = await service.create(source.bytes), result = await waitFor(service, created.id);
  assert.equal(result.status, 'failed'); assert.equal(result.errorCode, 'SLICE_ENGINE_FAILED');
  assert.match(result.message, /可打印层.*模型单位.*闭合实体/);
  assert.ok(result.message.length < 150); assert.doesNotMatch(result.message, /private|tmp|diagnostics|detected/);
  const filename = path.join(root, '.slice-diagnostics', created.id, 'engine.log');
  assert.equal(await readFile(filename, 'utf8'), raw);
  assert.equal((await stat(filename)).mode & 0o777, 0o600);
  assert.equal((await stat(path.dirname(filename))).mode & 0o777, 0o700);
  assert.deepEqual(await readdir(path.join(root, '.slice-jobs')), [], 'temporary source/models and partial paths were removed');
  assert.match(friendlyNativeFailure('0 printable instances; Nothing to be sliced'), /超出底板/);
  assert.match(friendlyNativeFailure('Param values in 3mf/config error: unsupported pattern'), /参数.*不兼容/);
});

test('closing one service never removes a different service instance private running or complete results', async t => {
  const { root, service } = await fixture(t);
  const second = createSliceService({ root, slicerPath: path.join(root, 'mock-slicer.mjs'),engineProbe:mockEngineProbe });
  t.after(() => second.close());
  const source = await project(root);
  const owned = await service.create(source.bytes);
  assert.equal((await waitFor(service, owned.id)).status, 'complete');
  const foreign = await second.create(source.bytes);
  await service.close();
  assert.equal((await waitFor(second, foreign.id)).status, 'complete');
  assert.deepEqual(await readFile(await second.gcodeFile(foreign.id)), Buffer.from(gcode));
  assert.deepEqual(await readdir(path.join(root, '.slice-jobs')), [foreign.id]);
});

test('tiny real native slice uses the Bambu pinned fallback geometry facts and original requested color', async t => {
  if(process.env.GROWTH_NATIVE_SLICER_TESTS!=='1'){t.skip('Native slicing requires explicit GROWTH_NATIVE_SLICER_TESTS=1; ordinary tests use the injected engine.');return;}
  try { await access(SLICE_SLICER, constants.X_OK); } catch { t.skip('Local Bambu Studio CLI is not installed.'); return; }
  const root = await mkdtemp(path.join(tmpdir(), 'slice-native-cube-'));
  const service = createSliceService({ root, timeoutMs: 60_000 });
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
  const created = await service.create(cubeStl(), { format: 'stl', preset: 'h2c', sourceName: '完整方块.stl', toolColors: ['#ABCDEF'] });
  const result = await waitFor(service, created.id);
  assert.equal(result.status, 'complete', result.message);
  assert.ok(result.layerCount >= 62 && result.layerCount <= 63,'10mm cube uses0.16 regular layers with0.20 first, not old50-layer0.20 fallback');
  const text = await readFile(await service.gcodeFile(created.id), 'utf8');
  assert.match(text, /; wall_loops = 2/);
  assert.match(text, /; layer_height = 0\.16/);
  assert.match(text, /; initial_layer_print_height = 0\.2/);
  assert.match(text, /; sparse_infill_density = 15%/);
  assert.match(text, /; sparse_infill_pattern = grid/);
  assert.match(text, /; top_shell_layers = 5/);
  assert.match(text, /; bottom_shell_layers = 3/);
  assert.match(text, /; filament_colour = #ABCDEF/i);
  const parsed = parsePrintLayerGCode(text);
  assert.ok((parsed.featureCounts.sparseInfill ?? 0) > 0, 'native output contains actual sparse-infill extrusion segments, regardless of TYPE/FEATURE comment syntax');
  assert.equal(parsed.layerHeights.length, result.layerCount);
  assert.ok(Math.abs(parsed.layerHeights[0]-.2)<1e-6);
  for(let layer=1;layer<parsed.layerHeights.length;layer++)assert.ok(Math.abs(parsed.layerHeights[layer]-parsed.layerHeights[layer-1]-.16)<1e-4);
  assert.ok(parsed.segmentCount > 100);
  const report = await service.provenance(created.id);
  assert.equal(report.triangleCount, 12);
  assert.deepEqual(report.bedSizeMm, [330, 320]);
  assert.equal(report.fallbackEngineProfiles.bedGeometrySource, 'scene-preset-effective-area');
  assert.deepEqual(report.fallbackEngineProfiles.officialH2CMachineUnionMm, [345, 320]);
  assert.equal(report.rawSettings.enable_support, '0');
  assert.equal(report.sliceSettings.fields.wallLoops.source, 'bambu-default');
  assert.equal(report.sliceSettings.fields.layerHeightMm.source, 'studio-default');
  assert.equal(report.sliceSettings.fields.layerHeightMm.defaultPolicy, 'user-preference-0.16');
});

test('generic two-part 3MF fallback preserves both original part extruders and both real sliced filament colors', async t => {
  if(process.env.GROWTH_NATIVE_SLICER_TESTS!=='1'){t.skip('Native slicing requires explicit GROWTH_NATIVE_SLICER_TESTS=1; ordinary tests use the injected engine.');return;}
  try { await access(SLICE_SLICER, constants.X_OK); } catch { t.skip('Local Bambu Studio CLI is not installed.'); return; }
  const root = await mkdtemp(path.join(tmpdir(), 'slice-native-two-color-'));
  const service = createSliceService({ root, timeoutMs: 60_000 });
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
  const filename = path.join(root, 'two-parts.3mf');
  await execFileAsync(findPythonPath(), ['-c', `import zipfile,sys
v=[(0,0,0),(10,0,0),(10,10,0),(0,10,0),(0,0,10),(10,0,10),(10,10,10),(0,10,10)]
f=[(0,2,1),(0,3,2),(4,5,6),(4,6,7),(0,1,5),(0,5,4),(1,2,6),(1,6,5),(2,3,7),(2,7,6),(3,0,4),(3,4,7)]
mesh='<mesh><vertices>'+''.join('<vertex x="%s" y="%s" z="%s"/>'%p for p in v)+'</vertices><triangles>'+''.join('<triangle v1="%s" v2="%s" v3="%s"/>'%p for p in f)+'</triangles></mesh>'
xml='<?xml version="1.0"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><metadata name="Application">OrcaSlicer-2.4.2</metadata><metadata name="BambuStudio:3mfVersion">1</metadata><resources><object id="1" type="model">'+mesh+'</object><object id="2" type="model">'+mesh+'</object><object id="3" type="model"><components><component objectid="1"/><component objectid="2" transform="1 0 0 0 1 0 0 0 1 20 0 0"/></components></object></resources><build><item objectid="3" transform="1 0 0 0 1 0 0 0 1 100 100 0"/></build></model>'
meta='<config><object id="3"><metadata key="extruder" value="1"/><part id="1" subtype="normal_part"><metadata key="extruder" value="1"/></part><part id="2" subtype="normal_part"><metadata key="extruder" value="2"/></part></object><plate><metadata key="plater_id" value="1"/><model_instance><metadata key="object_id" value="3"/><metadata key="instance_id" value="0"/></model_instance></plate></config>'
with zipfile.ZipFile(sys.argv[1],'w',compression=zipfile.ZIP_DEFLATED) as z:
 z.writestr('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>')
 z.writestr('_rels/.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>')
 z.writestr('3D/3dmodel.model',xml)
 z.writestr('Metadata/model_settings.config',meta)
` , filename]);
  const source = await readFile(filename);
  const created = await service.create(source, { format: '3mf', preset: 'h2c', toolColors: ['#FF3344', '#2244FF'] });
  const result = await waitFor(service, created.id);
  assert.equal(result.status, 'complete', result.message);
  assert.deepEqual(result.toolColors, ['#ff3344', '#2244ff']);
  const report = await service.provenance(created.id);
  assert.equal(report.fallbackEngineProfiles.logicalFilamentCount, 2);
  assert.deepEqual(report.rawSettings.filament_colour, ['#ff3344', '#2244ff']);
  assert.equal(report.objectSettings['3'].parts['1'].extruder, '1');
  assert.equal(report.objectSettings['3'].parts['2'].extruder, '2');
  assert.deepEqual(result.printerToSource, axis, 'saved build placement is not fitted or re-centered');
  const parsed = parsePrintLayerGCode(await readFile(await service.gcodeFile(created.id), 'utf8'));
  assert.deepEqual([...new Set(parsed.tools)].sort(), [0, 1]);
  assert.deepEqual(parsed.toolColors.slice(0, 2), ['#ff3344', '#2244ff']);
  assert.deepEqual(await readFile(filename), source);
});
