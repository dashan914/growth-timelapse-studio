import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BAMBU_REQUIRED_CLI_FLAGS, BAMBU_STUDIO_DEFAULT_PATH, bambuStudioCandidates, probeBambuEngine } from '../bambu-engine.mjs';

const HELP = `BambuStudio-02.07.01.57:\nUsage: bambu-studio [ OPTIONS ] [ file.3mf/file.stl ... ]\n${BAMBU_REQUIRED_CLI_FLAGS.map(flag => ` ${flag} option`).join('\n')}\n`;

async function installation(t, { app = true } = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'bambu-probe-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = app ? path.join(root, 'BambuStudio.app/Contents/MacOS/BambuStudio') : path.join(root, 'bin/bambu-studio');
  const resources = app ? path.join(root, 'BambuStudio.app/Contents/Resources') : path.join(root, 'resources');
  await mkdir(path.dirname(executable), { recursive: true });
  await mkdir(path.join(resources, 'profiles'), { recursive: true });
  await writeFile(executable, 'read-only CLI probe fixture\n');
  await chmod(executable, 0o700);
  return { root, executable, resources };
}

test('defaults and OS candidates select only Bambu; environment override is final', () => {
  assert.ok(BAMBU_STUDIO_DEFAULT_PATH);
  assert.deepEqual(bambuStudioCandidates({ platform: 'darwin', env: { BAMBU_STUDIO_PATH: ' /custom/BambuStudio ' } }), ['/custom/BambuStudio']);
  assert.equal(bambuStudioCandidates({ platform: 'darwin', env: {} })[0], '/Applications/BambuStudio.app/Contents/MacOS/BambuStudio');
  assert.ok(bambuStudioCandidates({ platform: 'win32', env: { ProgramFiles: 'D:\\Apps' } }).includes('D:\\Apps\\Bambu Studio\\bambu-studio.exe'));
  assert.equal(bambuStudioCandidates({ platform: 'linux', env: {} })[0], 'bambu-studio');
  for (const platform of ['darwin', 'win32', 'linux']) assert.ok(bambuStudioCandidates({ platform, env: {} }).every(candidate => !/flash|orca/i.test(candidate)));
});

test('probe executes only --help and reports installed resources and CLI version', async t => {
  const fixture = await installation(t);
  let calls = 0;
  const result = await probeBambuEngine({ slicerPath: fixture.executable, platform: 'darwin', env: {},
    execFileImpl(filename, args, options, callback) {
      calls++;
      assert.equal(filename, fixture.executable);
      assert.deepEqual(args, ['--help']);
      assert.equal(options.shell, false);
      assert.equal(options.timeout, 10000);
      assert.equal(options.windowsHide, true);
      callback(null, HELP, '');
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.available, true);
  assert.equal(result.engine, 'Bambu Studio CLI');
  assert.equal(result.version, '02.07.01.57');
  assert.match(result.engineRevision, /^bambu-studio-02\.07\.01\.57-[a-f0-9]{20}$/);
  assert.equal(result.executablePath, fixture.executable);
  assert.equal(result.resourceDirectory, fixture.resources);
  assert.equal(result.profileDirectory, path.join(fixture.resources, 'profiles'));
  assert.equal(result.profilesAvailable, true);
  assert.equal(result.requiredCliFlagsSupported, true);
  assert.equal(result.reason, null);
});

test('revision changes for a replaced binary even when the reported version stays equal', async t => {
  const fixture = await installation(t);
  const options = { slicerPath: fixture.executable, execFileImpl: async () => ({ stdout: HELP }) };
  const first = await probeBambuEngine(options);
  const again = await probeBambuEngine(options);
  assert.equal(first.engineRevision, again.engineRevision);
  await utimes(fixture.executable, new Date('2024-01-01'), new Date('2024-01-01'));
  const replaced = await probeBambuEngine(options);
  assert.notEqual(first.engineRevision, replaced.engineRevision);
});

test('a missing explicit path returns unavailable without executing or falling back', async () => {
  let calls = 0;
  const result = await probeBambuEngine({ slicerPath: '/missing-bambu-studio-probe', execFileImpl() { calls++; throw new Error('must not execute'); } });
  assert.equal(calls, 0);
  assert.equal(result.available, false);
  assert.equal(result.executablePath, null);
  assert.match(result.reason, /指定路径/);
});

test('a different slicer is rejected even when it advertises the same CLI flags', async t => {
  const fixture = await installation(t);
  const result = await probeBambuEngine({ slicerPath: fixture.executable,
    execFileImpl: async () => ({ stdout: HELP.replace('BambuStudio-02.07.01.57:', 'Flash Studio-1.6.5:') }),
  });
  assert.equal(result.available, false);
  assert.equal(result.version, null);
  assert.match(result.reason, /不是可识别的 Bambu Studio/);
});

test('unsupported CLI versions identify every missing required argument', async t => {
  const fixture = await installation(t);
  const result = await probeBambuEngine({ slicerPath: fixture.executable,
    execFileImpl: async () => ({ stdout: HELP.replace(' --mstpp option', ' --mstpp-extra option').replace(' --orient option', '') }),
  });
  assert.equal(result.available, false);
  assert.equal(result.requiredCliFlagsSupported, false);
  assert.deepEqual(result.missingCliFlags, ['--orient', '--mstpp']);
  assert.match(result.reason, /--orient/);
  assert.equal(result.version, '02.07.01.57');
});

test('startup failures and timeout failures remain explicit unavailable results', async t => {
  const fixture = await installation(t);
  for (const [failure, expected] of [[new Error('cannot launch'), /无法启动/], [Object.assign(new Error('timeout'), { killed: true }), /检测超时/]]) {
    const result = await probeBambuEngine({ slicerPath: fixture.executable, execFileImpl: async () => { throw failure; } });
    assert.equal(result.available, false);
    assert.match(result.reason, expected);
  }
});

test('Linux PATH discovery and explicit resource override do not need a shell', async t => {
  const fixture = await installation(t, { app: false });
  const env = { PATH: path.dirname(fixture.executable), BAMBU_STUDIO_RESOURCES: path.join(fixture.resources, 'profiles') };
  const result = await probeBambuEngine({ platform: 'linux', env, execFileImpl: async () => ({ stderr: HELP }) });
  assert.equal(result.available, true);
  assert.equal(result.executablePath, fixture.executable);
  assert.equal(result.resourceDirectory, fixture.resources);
  assert.equal(result.profileDirectory, path.join(fixture.resources, 'profiles'));
});

test('a complete-project capable CLI can be detected without guessing a missing preset library', async t => {
  const fixture = await installation(t);
  const result = await probeBambuEngine({ slicerPath: fixture.executable, platform: 'darwin',
    env: { BAMBU_STUDIO_RESOURCES: path.join(fixture.root, 'missing-resources') }, execFileImpl: async () => HELP });
  assert.equal(result.available, true);
  assert.equal(result.profilesAvailable, false);
  assert.equal(result.profileDirectory, null);
  assert.equal(result.resourceDirectory, null);
});
