import test from 'node:test';
import assert from 'node:assert/strict';
import { windowsInstalledExecutables, execFileWithConsoleCapture } from '../scripts/windows-runtime.mjs';
import { probeBambuEngine } from '../bambu-engine.mjs';

test('registered custom application locations stay engine-specific and executable-only', () => {
  const readRegistry = () => [
    { DisplayName: 'Bambu Studio', DisplayIcon: '"D:\\Custom Apps\\Bambu Studio\\bambu-studio.exe",0' },
    { DisplayName: 'Blender', InstallLocation: 'D:\\Steam Games\\Blender', DisplayIcon: 'D:\\Steam\\icons\\blender.ico' },
    { DisplayName: 'Orca-Flashforge', InstallLocation: 'D:\\Flash' },
  ];
  const options = { platform: 'win32', env: {}, readRegistry };
  assert.deepEqual(windowsInstalledExecutables('bambu', options), ['D:\\Custom Apps\\Bambu Studio\\bambu-studio.exe']);
  assert.deepEqual(windowsInstalledExecutables('blender', options), ['D:\\Steam Games\\Blender\\blender.exe']);
  assert.deepEqual(windowsInstalledExecutables('orca', options), []);
  assert.deepEqual(windowsInstalledExecutables('bambu', { ...options, platform: 'linux' }), []);
});

test('console capture preserves real stdout, stderr, arguments and nonzero exit status', async () => {
  const execute = (filename, args, options) => new Promise((resolve, reject) => execFileWithConsoleCapture(filename, args, options, (error, stdout, stderr) => {
    if (error) reject(Object.assign(error, { stdout, stderr })); else resolve({ stdout, stderr });
  }));
  const argument = '中文 空格 & literal';
  const result = await execute(process.execPath, ['-e', 'process.stdout.write(process.argv[1]); process.stderr.write("stderr sentinel")', argument], { timeout: 3000, maxBuffer: 65536 });
  assert.equal(result.stdout, argument);
  assert.equal(result.stderr, 'stderr sentinel');
  await assert.rejects(execute(process.execPath, ['-e', 'process.stderr.write("failed sentinel"); process.exit(7)'], { timeout: 3000, maxBuffer: 65536 }), error => error.code === 7 && error.stderr === 'failed sentinel');
});

test('Windows real Bambu help is captured from a console-free parent', { skip: process.platform !== 'win32' || !process.env.GROWTH_NATIVE_SLICER_TESTS }, async () => {
  const result = await probeBambuEngine();
  assert.equal(result.available, true, result.reason);
  assert.equal(result.requiredCliFlagsSupported, true);
  assert.ok(result.version);
});
