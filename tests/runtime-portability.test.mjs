import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { findBlenderPath, findFFmpegPath, findPythonPath, resolveExecutablePath } from '../runtime-paths.mjs';
import { createPhotoCalibrationService, resolvePhotoCalibrationRuntime } from '../photo-calibration.mjs';

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'growth-runtime-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bin = path.join(directory, 'bin');
  await mkdir(bin);
  async function executable(name) {
    const filename = path.join(bin, name);
    await writeFile(filename, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    return await realpath(filename);
  }
  return { directory, bin, executable, env: { PATH: bin } };
}

test('external executables are discovered from PATH without bundled research runtimes', async t => {
  const { directory, env, executable } = await fixture(t);
  const ffmpeg = await executable('ffmpeg'), python = await executable('python3'), blender = await executable('blender');
  assert.equal(findFFmpegPath({ env }), ffmpeg);
  assert.equal(findPythonPath({ root: directory, env }), python);
  assert.equal(findBlenderPath({ root: directory, env }), blender);
});

test('Windows project virtualenv takes precedence over an unconfigured PATH Python', async t => {
  if (process.platform !== 'win32') { t.skip('Windows virtualenv layout'); return; }
  const { directory, env, executable } = await fixture(t);
  await executable('python3');
  const python = path.join(directory, '.venv', 'Scripts', 'python.exe');
  await mkdir(path.dirname(python), { recursive: true });
  await writeFile(python, 'fixture python');
  assert.equal(findPythonPath({ root: directory, env }), await realpath(python));
});

test('explicit missing runtime overrides stay missing instead of silently changing installs', async t => {
  const { directory, env, executable } = await fixture(t);
  await executable('ffmpeg'); await executable('python3'); await executable('blender');
  for (const [variable, find] of [['FFMPEG_PATH', findFFmpegPath], ['PYTHON_PATH', findPythonPath], ['BLENDER_PATH', findBlenderPath]]) {
    const missing = path.join(directory, 'missing');
    assert.equal(find({ root: directory, env: { ...env, [variable]: missing } }), missing);
    assert.equal(resolveExecutablePath(missing), null);
  }
});

test('executable discovery rejects directories and nonexecutable files', async t => {
  const { directory, env } = await fixture(t);
  const file = path.join(directory, 'ordinary-file');
  await writeFile(file, 'not executable', { mode: 0o600 });
  assert.equal(resolveExecutablePath(directory, { env }), null);
  if (process.platform !== 'win32') assert.equal(resolveExecutablePath(file, { env }), null);
  assert.equal(resolveExecutablePath('not-a-command', { env }), null);
});

test('optional local Blender research install remains a fallback after PATH', async t => {
  const { directory, env, executable } = await fixture(t);
  const legacy = path.join(directory, 'research/runtime/blender/Blender.app/Contents/MacOS/Blender');
  await mkdir(path.dirname(legacy), { recursive: true });
  await writeFile(legacy, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  // Use linux candidate rules to isolate the fallback from this test host's apps.
  assert.equal(findBlenderPath({ root: directory, env, platform: 'linux' }), await realpath(legacy));
  const installed = await executable('blender');
  assert.equal(findBlenderPath({ root: directory, env, platform: 'linux' }), installed);
});

test('OpenCV uses a configured external Python and reports its actual version', async t => {
  const { directory, env, executable } = await fixture(t);
  const python = await executable('python3');
  await mkdir(path.join(directory, 'scripts'));
  await writeFile(path.join(directory, 'scripts/calibration-uprights.py'), '# fixture\n');
  let inspected;
  const installed = await resolvePhotoCalibrationRuntime({ root: directory, env: { ...env, PYTHON_PATH: python }, execute: async (command, args, options) => {
    inspected = { command, args, options };
    return { stdout: JSON.stringify({ version: '4.13.0' }) };
  } });
  assert.deepEqual(installed, { python, directory: null, version: '4.13.0' });
  assert.equal(inspected.command, python); assert.equal(inspected.options.shell, false);
  assert.ok(inspected.args[1].includes('import json, cv2, numpy'));
  assert.equal(inspected.options.env.PYTHONPATH, undefined);
  assert.equal(inspected.options.env.PYTHONNOUSERSITE, undefined);
  assert.ok(inspected.options.timeout <= 3_000);
  assert.equal((await createPhotoCalibrationService({ findRuntime: async () => installed }).capability()).version, '4.13.0');
});

test('missing optional OpenCV falls back cleanly without blocking model features', async t => {
  const { directory, env, executable } = await fixture(t);
  const python = await executable('python3');
  await mkdir(path.join(directory, 'scripts'));
  await writeFile(path.join(directory, 'scripts/calibration-uprights.py'), '# fixture\n');
  const installed = await resolvePhotoCalibrationRuntime({ root: directory, env: { ...env, PYTHON_PATH: python }, execute: async () => { throw new Error('cv2 absent'); } });
  assert.equal(installed, null);
  const service = createPhotoCalibrationService({ findRuntime: async () => installed });
  assert.equal((await service.capability()).available, false);
});

test('OpenCV library override is trusted process configuration and keeps imports isolated', async t => {
  const { directory, env, executable } = await fixture(t);
  const python = await executable('python3');
  await mkdir(path.join(directory, 'scripts'));
  await writeFile(path.join(directory, 'scripts/calibration-uprights.py'), '# fixture\n');
  const library = path.join(directory, 'cv-libraries');
  const installed = await resolvePhotoCalibrationRuntime({ root: directory, env: { ...env, PHOTO_CALIBRATION_PYTHON: python, OPENCV_PYTHONPATH: library }, execute: async (command, args, options) => {
    assert.equal(options.env.PYTHONPATH, library);
    assert.equal(options.env.PYTHONNOUSERSITE, '1');
    return { stdout: JSON.stringify({ version: '4.12.0' }) };
  } });
  assert.equal(installed.directory, library);
});
