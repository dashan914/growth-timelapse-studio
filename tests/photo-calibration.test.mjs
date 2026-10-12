import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPhotoCalibrationService, detectPhotoUprights, photoCalibrationCapability,
  PHOTO_CALIBRATION_MAX_BYTES, validateCalibrationImage, validateUprightSuggestion } from '../photo-calibration.mjs';

const METHOD = 'OpenCV LSD + collinear grouping';
const pngHeader = (width = 640, height = 480) => {
  const buffer = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buffer);
  buffer.writeUInt32BE(13, 8); buffer.write('IHDR', 12); buffer.writeUInt32BE(width, 16); buffer.writeUInt32BE(height, 20);
  return buffer;
};
const jpegHeader = () => Buffer.from([255, 216, 255, 224, 0, 8, 1, 2, 3, 4, 5, 6, 255, 192, 0, 17, 8, 1, 224, 2, 128, 3, 1, 17, 0, 2, 17, 0, 3, 17, 0, 255, 217]);
const validResult = () => ({ method: METHOD, version: '4.12.0', confidence: 'suggested', imageSize: { width: 640, height: 480 },
  lines: [{ a: { x: .2, y: .1 }, b: { x: .23, y: .6 }, weight: 100 }, { a: { x: .8, y: .1 }, b: { x: .75, y: .6 }, weight: 100 }], warnings: ['/private/secrets will not be reflected'] });
const runtime = async () => ({ python: '/trusted/python', directory: '/trusted/runtime' });
function fakeChild() {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = signal => { child.killedWith = signal; setImmediate(() => child.emit('close', null)); return true; };
  return child;
}

test('validates JPEG/PNG dimensions, content type and limits before native decode', () => {
  assert.deepEqual(validateCalibrationImage(pngHeader(), 'image/png; charset=binary'), { width: 640, height: 480, mimeType: 'image/png' });
  assert.deepEqual(validateCalibrationImage(jpegHeader(), 'image/jpeg'), { width: 640, height: 480, mimeType: 'image/jpeg' });
  for (const [buffer, mimeType, code] of [[pngHeader(), 'image/jpeg', 'INVALID_IMAGE'], [jpegHeader(), 'text/html', 'UNSUPPORTED_IMAGE'],
    [Buffer.alloc(20), 'image/png', 'INVALID_IMAGE'], [pngHeader(0, 480), 'image/png', 'INVALID_IMAGE'],
    [pngHeader(12001, 20), 'image/png', 'IMAGE_DIMENSIONS_TOO_LARGE'], [pngHeader(6000, 5000), 'image/png', 'IMAGE_DIMENSIONS_TOO_LARGE'],
    [Buffer.alloc(PHOTO_CALIBRATION_MAX_BYTES + 1), 'image/png', 'IMAGE_TOO_LARGE']]) {
    assert.throws(() => validateCalibrationImage(buffer, mimeType), error => error.code === code);
  }
  const truncated = jpegHeader().subarray(0, 20);
  assert.throws(() => validateCalibrationImage(truncated, 'image/jpeg'), /有效/);
});

test('validates normalized inert results and replaces subprocess warnings with trusted user copy', () => {
  const dimensions = { width: 640, height: 480 };
  const clean = validateUprightSuggestion(validResult(), dimensions);
  assert.equal(clean.lines.length, 2); assert.equal(clean.version, '4.12.0');
  assert.ok(!JSON.stringify(clean).includes('/private/'));
  for (const modify of [r => { r.lines[0].a.x = NaN; }, r => { r.lines[0].b.y = 2; }, r => { r.lines[0].weight = 1; },
    r => { r.lines = []; }, r => { r.lines.push(r.lines[0]); }, r => { r.method = 'untrusted'; },
    r => { r.imageSize.width = 12; }, r => { r.version = 'arbitrary command'; }]) {
    const result = validResult(); modify(result);
    assert.throws(() => validateUprightSuggestion(result, dimensions), error => error.code === 'INVALID_DETECTION_RESULT');
  }
  assert.equal(validateUprightSuggestion({ ...validResult(), confidence: 'low', lines: [] }, dimensions).confidence, 'low');
});

test('missing optional runtime reports capability and clean manual fallback without spawning', async () => {
  let invoked = false;
  const service = createPhotoCalibrationService({ findRuntime: async () => null, spawnProcess: () => { invoked = true; } });
  assert.equal((await service.capability()).available, false);
  await assert.rejects(service.detect(pngHeader(), { mimeType: 'image/png' }), error => error.status === 503 && error.code === 'CALIBRATION_UNAVAILABLE');
  assert.equal(invoked, false);
});

test('uses fixed trusted script/no shell/private temporary photo and cleans after success', async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'uprights-test-'));
  let inspected;
  const service = createPhotoCalibrationService({ findRuntime: runtime, temporaryRoot, spawnProcess: (command, args, options) => {
    const child = fakeChild();
    inspected = { command, args, options };
    setImmediate(async () => {
      inspected.bytes = await readFile(args[1]); inspected.mode = (await stat(args[1])).mode & 0o777;
      child.stdout.write(JSON.stringify(validResult())); child.emit('close', 0);
    }); return child;
  } });
  try {
    const result = await service.detect(pngHeader(), { mimeType: 'image/png', scriptPath: '/bin/sh', pythonPath: '/bin/sh' });
    assert.equal(result.lines.length, 2); assert.equal(inspected.command, '/trusted/python');
    assert.equal(path.basename(inspected.args[0]), 'calibration-uprights.py'); assert.equal(inspected.args.length, 2);
    assert.equal(inspected.options.shell, false); assert.equal(inspected.options.env.PYTHONPATH, '/trusted/runtime');
    if (process.platform !== 'win32') assert.equal(inspected.mode, 0o600); assert.deepEqual(inspected.bytes, pngHeader());
    assert.deepEqual(await readdir(temporaryRoot), []);
  } finally { await rm(temporaryRoot, { recursive: true, force: true }); }
});

test('timeouts kill native process and clean temporary files; invalid timeout never starts', async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'uprights-timeout-'));
  let child;
  const service = createPhotoCalibrationService({ findRuntime: runtime, temporaryRoot, spawnProcess: () => child = fakeChild() });
  try {
    await assert.rejects(service.detect(pngHeader(), { mimeType: 'image/png', timeoutMs: 5 }), error => error.status === 504);
    assert.equal(child.killedWith, 'SIGKILL'); assert.deepEqual(await readdir(temporaryRoot), []);
    for (const timeoutMs of [0, NaN, 30_001, '1']) await assert.rejects(service.detect(pngHeader(), { mimeType: 'image/png', timeoutMs }), error => error.code === 'INVALID_TIMEOUT');
  } finally { await rm(temporaryRoot, { recursive: true, force: true }); }
});

test('bounded output and malformed/native errors do not expose stderr or paths', async () => {
  for (const scenario of ['large', 'json', 'exit', 'spawn']) {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'uprights-errors-'));
    let child;
    const service = createPhotoCalibrationService({ findRuntime: runtime, temporaryRoot, spawnProcess: () => {
      child = fakeChild(); setImmediate(() => {
        if (scenario === 'large') child.stdout.write('x'.repeat(70_000));
        if (scenario === 'json') { child.stdout.write('{'); child.emit('close', 0); }
        if (scenario === 'exit') { child.stderr.write('/private/passwords'); child.emit('close', 1); }
        if (scenario === 'spawn') child.emit('error', new Error('/private/passwords'));
      }); return child;
    } });
    try {
      await assert.rejects(service.detect(pngHeader(), { mimeType: 'image/png' }), error => !error.message.includes('/private') && [422, 502, 503].includes(error.status));
      if (scenario === 'large') assert.equal(child.killedWith, 'SIGKILL');
      assert.deepEqual(await readdir(temporaryRoot), []);
    } finally { await rm(temporaryRoot, { recursive: true, force: true }); }
  }
});

test('limits native concurrency to two and releases capacity after completion', async () => {
  const children = [];
  const service = createPhotoCalibrationService({ findRuntime: runtime, spawnProcess: () => { const child = fakeChild(); children.push(child); return child; } });
  const first = service.detect(pngHeader(), { mimeType: 'image/png' });
  const second = service.detect(pngHeader(), { mimeType: 'image/png' });
  await assert.rejects(service.detect(pngHeader(), { mimeType: 'image/png' }), error => error.status === 429);
  while (children.length < 2) await new Promise(resolve => setImmediate(resolve));
  for (const child of children) { child.stdout.write(JSON.stringify(validResult())); child.emit('close', 0); }
  assert.equal((await first).lines.length, 2); assert.equal((await second).lines.length, 2);
});

test('actual OpenCV module detects bounded suggestions from the optional user fixture', async t => {
  const capability = await photoCalibrationCapability();
  if (!process.env.GROWTH_TEST_CALIBRATION_PHOTO || !capability.available) { t.skip('Set GROWTH_TEST_CALIBRATION_PHOTO and install optional OpenCV in a local Python environment'); return; }
  const result = await detectPhotoUprights(await readFile(process.env.GROWTH_TEST_CALIBRATION_PHOTO), { mimeType: 'image/jpeg' });
  assert.equal(result.version, capability.version); assert.equal(result.confidence, 'suggested'); assert.equal(result.lines.length, 2);
  assert.equal(result.imageSize.width, 1706); assert.equal(result.imageSize.height, 1279);
  assert.ok(result.lines[0].a.x < .5 && result.lines[1].a.x > .8);
  assert.ok(result.warnings.some(warning => warning.includes('确认')));
});

test('actual decoder gives low-confidence empty suggestions for blank image and rejects malformed PNG', async t => {
  if (!(await photoCalibrationCapability()).available) { t.skip('Optional local OpenCV runtime absent'); return; }
  const blank = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAI0lEQVR4nGNsaGhgIAUwkaSaYVQDcYCJSHVwMKqBGEByKAEAyUwBoHKcrY0AAAAASUVORK5CYII=', 'base64');
  const result = await detectPhotoUprights(blank, { mimeType: 'image/png' });
  assert.equal(result.confidence, 'low'); assert.deepEqual(result.lines, []);
  await assert.rejects(detectPhotoUprights(pngHeader(), { mimeType: 'image/png' }), error => error.status === 422 && error.code === 'DETECTION_FAILED');
});
