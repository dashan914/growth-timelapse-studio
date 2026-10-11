import { findPythonPath } from '../runtime-paths.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createApp } from '../server.mjs';
import { extractSupportPreview } from '../support-jobs.mjs';
import { parseGCode } from '../src/gcode.js';

const execFileAsync = promisify(execFile);
const supportCode = 'G21\nG90\nM83\nG0 X0 Y0 Z0.2\n;TYPE:Outer wall\nG1 X5 Y0 E1\n;TYPE:Support\nG1 X10 Y0 E1\nG1 X15 Y0.01 E1\nG1 X20 Y0 E1\nG0 X25 Y0\nT2\n;TYPE:Support interface\nG1 X30 Y0 E1\nM104 S250\nG28\n';

async function project(root, overrides = {}, metadata = '<config><object id="1"><metadata key="name" value="test"/></object></config>') {
  const filename = path.join(root, 'original.3mf');
  const settings = { enable_support: '1', support_type: 'tree(auto)', support_threshold_angle: '30', sparse_infill_pattern: 'grid',
    skeleton_infill_line_width: '100', skin_infill_line_width: '100', ooze_prevention: '1', enable_prime_tower: '1',
    printer_settings_id: 'Flashforge Creator 5 0.4 nozzle(source.3mf)', print_settings_id: '0.12mm Standard @FF C5(source.3mf)', ...overrides };
  await execFileAsync(findPythonPath(), ['-c',
    'import zipfile,sys; z=zipfile.ZipFile(sys.argv[1],"w",compression=zipfile.ZIP_DEFLATED); z.writestr("Metadata/project_settings.config",sys.argv[2]); z.writestr("Metadata/model_settings.config",sys.argv[3]); z.writestr("3D/3dmodel.model",sys.argv[4]); z.close()',
    filename, JSON.stringify(settings), metadata, '<model unit="millimeter"><resources/></model>']);
  return { filename, bytes: await readFile(filename) };
}

async function fixture(t, { delay = 50, ...options } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'support-backend-'));
  const mock = path.join(root, 'mock-slicer.mjs');
  const proof = path.join(root, 'arguments.json');
  await writeFile(mock, `#!${process.execPath}\nimport {mkdir,writeFile} from 'node:fs/promises';\nimport path from 'node:path';\nconst args=process.argv.slice(2);\nawait writeFile(${JSON.stringify(proof)}, JSON.stringify(args));\nawait new Promise(r=>setTimeout(r,${delay}));\nconst out=args[args.indexOf('--outputdir')+1];\nawait mkdir(out,{recursive:true});\nawait writeFile(path.join(out,'plate_1.gcode'),${JSON.stringify(supportCode)});\n`);
  await chmod(mock, 0o700);
  const app = createApp({ root, ffmpegPath: '/missing-ffmpeg', supportsSlicerPath: mock, ...options });
  await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  return { root, app, base, proof };
}

async function create(base, bytes, type = 'application/octet-stream') {
  const response = await fetch(`${base}/api/supports`, { method: 'POST', headers: { 'Content-Type': type, Origin: base }, body: bytes });
  return { response, body: await response.json() };
}

async function waitFor(base, id, status = 'complete') {
  for (let attempt = 0; attempt < 300; attempt++) {
    const state = await (await fetch(`${base}/api/supports/${id}`)).json();
    if (state.status === status) return state;
    if (['failed', 'cancelled'].includes(state.status)) return state;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('The support test did not settle.');
}

test('support jobs prepare an isolated copy, preserve support settings and return actual support-only geometry', async t => {
  const { root, base, proof } = await fixture(t);
  const original = await project(root);
  const health = await (await fetch(`${base}/api/health`)).json();
  assert.deepEqual(health.supportsSlicer, { available: true });
  const created = await create(base, original.bytes);
  assert.equal(created.response.status, 201);
  const { id } = created.body;
  const running = await (await fetch(`${base}/api/supports/${id}`)).json();
  assert.equal(running.status, 'running');
  assert.ok(['preparing', 'slicing'].includes(running.phase));
  assert.equal((await fetch(`${base}/api/supports/${id}/file`)).status, 409);
  const complete = await waitFor(base, id);
  assert.equal(complete.status, 'complete', complete.message);
  assert.equal(complete.actualSliceSegments, 4);
  assert.equal(complete.segments, 2);
  assert.equal(complete.visualizationToleranceMm, 0.08);
  const response = await fetch(base + complete.url);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-encoding'), 'gzip');
  const preview = await response.json();
  assert.equal(preview.visualizationOnly, true);
  assert.equal(preview.corrections.length, 5);
  assert.equal(preview.supportFieldsPreserved, 3);
  assert.doesNotMatch(preview.gcode, /M104|G28|Outer wall/);
  const parsed = parseGCode(preview.gcode, { supportOnly: true });
  assert.equal(parsed.segmentCount, 2);
  assert.deepEqual([...parsed.positions], [5, 0, 0.20000000298023224, 20, 0, 0.20000000298023224, 25, 0, 0.20000000298023224, 30, 0, 0.20000000298023224]);
  assert.deepEqual([...parsed.tools], [0, 2]);
  const args = JSON.parse(await readFile(proof, 'utf8'));
  for (const flag of ['--no-check', '--slice', '--arrange', '--orient', '--datadir', '--outputdir']) assert.ok(args.includes(flag));
  assert.equal(args[args.indexOf('--arrange') + 1], '0');
  assert.equal(args[args.indexOf('--orient') + 1], '0');
  assert.ok(args[args.indexOf('--datadir') + 1].includes(id));
  assert.deepEqual(await readFile(original.filename), original.bytes, 'the original 3MF was never edited');
  assert.deepEqual(await readdir(path.join(root, '.support-jobs', id)), ['support-preview.json']);
});

test('support upload enforces its content type, byte limit, one active job and local origin', async t => {
  const { root, base } = await fixture(t, { delay: 1000, supportMaximumUploadBytes: 1024 });
  const original = await project(root);
  assert.equal((await create(base, original.bytes, 'model/3mf')).response.status, 415);
  assert.equal((await create(base, Buffer.alloc(1025))).response.status, 413);
  assert.equal((await create(base, Buffer.alloc(0))).response.status, 400);
  const foreign = await fetch(`${base}/api/supports`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', Origin: 'https://example.com' }, body: original.bytes });
  assert.equal(foreign.status, 403);
  const job = await create(base, original.bytes);
  assert.equal(job.response.status, 201);
  assert.equal((await create(base, original.bytes)).response.status, 409);
  assert.equal((await fetch(`${base}/api/supports/${job.body.id}`, { method: 'DELETE' })).status, 200);
  const cancelled = await (await fetch(`${base}/api/supports/${job.body.id}`)).json();
  assert.equal(cancelled.status, 'cancelled');
  assert.deepEqual(await readdir(path.join(root, '.support-jobs')), []);
  assert.equal((await create(base, original.bytes)).response.status, 201, 'cancel releases the active slot');
});

test('invalid 3MF and disabled support fail cleanly without invoking the slicer or changing original files', async t => {
  const { root, base, proof } = await fixture(t);
  const invalid = await create(base, Buffer.from('not a zip'));
  assert.equal(invalid.response.status, 201);
  assert.equal((await waitFor(base, invalid.body.id)).status, 'failed');
  const original = await project(root, { enable_support: '0' });
  const disabled = await create(base, original.bytes);
  assert.equal(disabled.response.status, 201);
  const failed = await waitFor(base, disabled.body.id);
  assert.equal(failed.status, 'failed');
  assert.match(failed.message, /Support is disabled/);
  await assert.rejects(readFile(proof), { code: 'ENOENT' });
  assert.deepEqual(await readdir(path.join(root, '.support-jobs')), []);
  assert.deepEqual(await readFile(original.filename), original.bytes);
});

test('a timed-out slicer is terminated, cleans temporary inputs and frees the job slot', async t => {
  const { root, base } = await fixture(t, { delay: 2000, supportJobTimeoutMs: 250 });
  const original = await project(root);
  const job = await create(base, original.bytes);
  const state = await waitFor(base, job.body.id);
  assert.equal(state.status, 'failed');
  assert.match(state.message, /超时/);
  assert.deepEqual(await readdir(path.join(root, '.support-jobs')), []);
  assert.equal((await create(base, original.bytes)).response.status, 201);
});

test('project post-processing commands are disabled before invoking the local slicer', async t => {
  const {root,base}=await fixture(t);
  const original=await project(root,{post_process:['untrusted-external-command']});
  const created=await create(base,original.bytes);
  const complete=await waitFor(base,created.body.id);
  assert.equal(complete.status,'complete');
  const preview=await (await fetch(base+complete.url)).json();
  assert.deepEqual(preview.corrections.find(item=>item.field==='post_process').after,[]);
  assert.deepEqual(await readFile(original.filename),original.bytes);
});

test('missing local slicer reports unavailable without storing uploaded files', async t => {
  const { root, base } = await fixture(t, { supportsSlicerPath: '/definitely-missing-flash-studio' });
  assert.deepEqual((await (await fetch(`${base}/api/health`)).json()).supportsSlicer, { available: false });
  const result = await create(base, Buffer.from('input'));
  assert.equal(result.response.status, 503);
  assert.equal(result.body.error.code, 'SUPPORT_SLICER_UNAVAILABLE');
  await assert.rejects(readdir(path.join(root, '.support-jobs')), { code: 'ENOENT' });
});

test('support extraction retains G92 physical coordinates, relative modes, tools and discontinuities', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'support-extraction-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source.gcode'), output = path.join(root, 'preview.json');
  await writeFile(source, 'G21\nG90\nM82\nG0 X10 Y20 Z1\nG92 X0 Y0 E0\n;TYPE:Support\nG1 X2 Y0 E1\nG91\nM83\nG1 X0 Y2 E1\nG0 X5 Y5\nT3\n;TYPE:Support interface\nG1 X1 Y0 E1\n;TYPE:Outer wall\nG1 X100 E1\n');
  await extractSupportPreview(source, output);
  const data = JSON.parse(await readFile(output, 'utf8'));
  const geometry = parseGCode(data.gcode, { supportOnly: true });
  assert.deepEqual([...geometry.positions], [10, 20, 1, 12, 20, 1, 12, 20, 1, 12, 22, 1, 17, 27, 1, 18, 27, 1]);
  assert.deepEqual([...geometry.tools], [0, 0, 3]);
  assert.equal(data.actualSliceSegments, 3);
});

test('support extraction rejects curved support commands and emits no fabricated straight chord', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'support-arcs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source.gcode');
  await writeFile(source, 'G90\nM83\nG0 X0 Y0 Z1\n;TYPE:Support\nG2 X1 Y1 I0 J1 E1\n');
  await assert.rejects(extractSupportPreview(source, path.join(root, 'preview.json')), /圆弧/);
});

test('support extraction preserves actual filament slots and width/height boundaries during path simplification', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'support-colors-widths-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source.gcode'), output = path.join(root, 'preview.json');
  await writeFile(source, '; extruder_colour = #111111;#222222;#333333;#444444\n; filament_colour = #F0E8D6;#23599C;#C89E59;#101B2A;#F7F3E8;#FFFFFF\nG21\nG90\nM83\nG0 X0 Y0 Z0.25\n;TYPE:Support\n;WIDTH:0.5\n;HEIGHT:0.25\nG1 X1 Y0 E1\nG1 X2 Y0 E1\n;WIDTH:0.42\nG1 X3 Y0 E1\n;HEIGHT:0.12\nG1 X4 Y0 E1\nT3\nG1 X5 Y0 E1\n; filament_colour = #F0E8D6;#23599C;#C89E59;#101B2A;#F7F3E8;#FFFFFF\n');
  await extractSupportPreview(source, output);
  const preview = JSON.parse(await readFile(output, 'utf8'));
  const geometry = parseGCode(preview.gcode, { supportOnly: true });
  assert.deepEqual(geometry.toolColors, ['#f0e8d6', '#23599c', '#c89e59', '#101b2a', '#f7f3e8', '#ffffff']);
  assert.deepEqual([...geometry.tools], [0, 0, 0, 3]);
  assert.equal(preview.actualSliceSegments, 5);
  assert.equal(preview.segments, 4, 'only the same-width, same-height contiguous pair is simplified');
  assert.equal(preview.strokes, 4, 'width, height and tool changes retain their source boundaries');
  assert.deepEqual(preview.crossSection, { widthMm: { min: 0.42, max: 0.5 }, heightMm: { min: 0.12, max: 0.25 } });
  assert.equal(preview.visualizationToleranceMm, 0.08);
  assert.equal((preview.gcode.match(/; filament_colour =/g) || []).length, 1, 'identical duplicated configuration headers do not add data');
  assert.match(preview.gcode, /;WIDTH:0\.5\n;HEIGHT:0\.25\nG0 X0 Y0 Z0\.25\nG1 X2 Y0 Z0\.25 E1/);
  assert.match(preview.gcode, /;WIDTH:0\.42\n;HEIGHT:0\.25\nG0 X2 Y0 Z0\.25\nG1 X3 Y0 Z0\.25 E1/);
  assert.match(preview.gcode, /;WIDTH:0\.42\n;HEIGHT:0\.12\nG0 X3 Y0 Z0\.25\nG1 X4 Y0 Z0\.25 E1/);
});

test('support extraction preserves supported color-header variants and source palette replacements', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'support-header-variants-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source.gcode'), output = path.join(root, 'preview.json');
  await writeFile(source, '; extruder_colors : ["#111111", "#222222"]\n; filament_colors = ["#ABCDEF", "#123456"]\nG90\nM83\nG0 X0 Y0 Z1\n;TYPE:Support\nT1\nG1 X1 Y0 E1\n; filament_colors = ["#FEDCBA", "#654321"]\n');
  await extractSupportPreview(source, output);
  const preview = JSON.parse(await readFile(output, 'utf8'));
  const geometry = parseGCode(preview.gcode, { supportOnly: true });
  assert.deepEqual(geometry.toolColors, ['#fedcba', '#654321']);
  assert.equal(preview.colorHeaders.filament_colors, '["#FEDCBA", "#654321"]');
  assert.match(preview.gcode, /; extruder_colors = \["#111111", "#222222"\]/);
  assert.equal((preview.gcode.match(/; filament_colors =/g) || []).length, 2);
});

test('preparation preserves invalid widths when an infill override could activate them', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'support-prepare-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const original = await project(root, {}, '<config><object id="1"><metadata key="sparse_infill_pattern" value="lockedzag"/></object></config>');
  const destination = path.join(root, 'copy.3mf'), report = path.join(root, 'report.json');
  await execFileAsync(findPythonPath(), [path.resolve('scripts/prepare-support-project.py'), original.filename, destination, report]);
  const data = JSON.parse(await readFile(report, 'utf8'));
  assert.equal(data.corrections.some(item => item.field === 'skeleton_infill_line_width' || item.field === 'skin_infill_line_width'), false);
  const { stdout } = await execFileAsync(findPythonPath(), ['-c', 'import json,zipfile,sys; c=json.loads(zipfile.ZipFile(sys.argv[1]).read("Metadata/project_settings.config")); print(c["skeleton_infill_line_width"],c["skin_infill_line_width"])', destination]);
  assert.equal(stdout.trim(), '100 100');
});
