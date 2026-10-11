import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LOCAL_SLICER_IDS, LOCAL_SLICER_REQUIRED_CLI_FLAGS, localSlicerCandidates, probeLocalSlicers, probeSlicerEngine } from '../slicer-engine.mjs';

const HEADER = { bambu: 'BambuStudio-02.07.01.57:', flash: 'Orca-Flashforge-2.4.2:', orca: 'OrcaSlicer-2.4.2:' };
const help = id => `${HEADER[id]}\n${LOCAL_SLICER_REQUIRED_CLI_FLAGS.map(flag => ` ${flag} option`).join('\n')}\n`;

async function installations(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'local-slicer-probe-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const slicerPaths = {}, resources = {};
  for (const id of LOCAL_SLICER_IDS) {
    slicerPaths[id] = path.join(root, `${id}.app/Contents/MacOS/${id}`);
    resources[id] = path.join(root, `${id}.app/Contents/Resources`);
    await mkdir(path.dirname(slicerPaths[id]), { recursive: true });
    await mkdir(path.join(resources[id], 'profiles'), { recursive: true });
    await writeFile(slicerPaths[id], 'only --help is mocked for the capability tests\n');
    await chmod(slicerPaths[id], 0o700);
  }
  const execFileImpl = async filename => ({ stdout: help(LOCAL_SLICER_IDS.find(id => slicerPaths[id] === filename)) });
  return { root, slicerPaths, resources, execFileImpl };
}

test('registry has explicit platform paths and environment overrides per software', () => {
  assert.deepEqual(LOCAL_SLICER_IDS, ['bambu', 'flash', 'orca']);
  assert.equal(localSlicerCandidates('flash', { platform: 'darwin', env: {} })[0], '/Applications/Flash Studio.app/Contents/MacOS/Flash Studio');
  assert.equal(localSlicerCandidates('orca', { platform: 'darwin', env: {} })[0], '/Applications/OrcaSlicer.app/Contents/MacOS/OrcaSlicer');
  assert.deepEqual(localSlicerCandidates('flash', { env: { FLASH_STUDIO_PATH: ' /configured/flash ' } }), ['/configured/flash']);
  assert.deepEqual(localSlicerCandidates('orca', { env: { ORCA_SLICER_PATH: '/configured/orca' } }), ['/configured/orca']);
  assert.ok(localSlicerCandidates('orca', { platform: 'win32', env: { ProgramFiles: 'D:\\Apps' } }).includes('D:\\Apps\\OrcaSlicer\\orca-slicer.exe'));
  assert.equal(localSlicerCandidates('flash', { platform: 'linux', env: {} })[0], 'orca-flashforge');
  assert.deepEqual(localSlicerCandidates('invalid'), []);
});

test('each engine preserves its own identity, profile vendor and resource directory', async t => {
  const fixture = await installations(t);
  for (const engineId of LOCAL_SLICER_IDS) {
    const result = await probeSlicerEngine({ engineId, slicerPath: fixture.slicerPaths[engineId], platform: 'darwin', env: {}, execFileImpl: fixture.execFileImpl });
    assert.equal(result.id, engineId);
    assert.equal(result.available, true);
    assert.equal(result.profileVendor, engineId === 'flash' ? 'Flashforge' : 'BBL');
    assert.equal(result.resourceDirectory, fixture.resources[engineId]);
    assert.equal(result.profileDirectory, path.join(fixture.resources[engineId], 'profiles'));
    assert.equal(result.version, engineId === 'bambu' ? '02.07.01.57' : '2.4.2');
    assert.ok(result.engineRevision.startsWith(engineId === 'bambu' ? 'bambu-studio-' : `${engineId}-`));
    assert.equal(result.requiredCliFlagsSupported, true);
  }
});

test('discovery probes independently in parallel and prefers Bambu when available', async t => {
  const fixture = await installations(t);
  let active = 0, maximumActive = 0;
  const registry = await probeLocalSlicers({ slicerPaths: fixture.slicerPaths, platform: 'darwin', env: {},
    execFileImpl: async (filename, args, options) => {
      assert.deepEqual(args, ['--help']);
      assert.equal(options.shell, false);
      active++; maximumActive = Math.max(maximumActive, active);
      await new Promise(resolve => setTimeout(resolve, 10));
      active--;
      return fixture.execFileImpl(filename);
    },
  });
  assert.equal(maximumActive, 3);
  assert.equal(registry.engines.length, 3);
  assert.deepEqual(Object.keys(registry.availableRegistry), LOCAL_SLICER_IDS);
  assert.equal(registry.preferredEngineId, 'bambu');
  assert.equal(registry.defaultEngineId, 'bambu');
});

test('automatic selection prefers Orca, then Flash, when Bambu is absent', async t => {
  const fixture = await installations(t);
  const slicerPaths = { ...fixture.slicerPaths, bambu: path.join(fixture.root, 'missing-bambu') };
  const options = { slicerPaths, platform: 'darwin', env: {}, execFileImpl: fixture.execFileImpl };
  assert.equal((await probeLocalSlicers(options)).preferredEngineId, 'orca');
  assert.equal((await probeSlicerEngine(options)).id, 'orca');
  slicerPaths.orca = path.join(fixture.root, 'missing-orca');
  assert.equal((await probeLocalSlicers(options)).preferredEngineId, 'flash');
  assert.equal((await probeSlicerEngine({ engineId: 'auto', ...options })).id, 'flash');
  slicerPaths.flash = path.join(fixture.root, 'missing-flash');
  const registry = await probeLocalSlicers(options);
  assert.equal(registry.preferredEngineId, null);
  assert.equal(registry.defaultEngineId, null);
  assert.deepEqual(registry.availableRegistry, {});
  const unavailable = await probeSlicerEngine(options);
  assert.equal(unavailable.available, false);
  assert.match(unavailable.reason, /未找到可用的本机切片器/);
});

test('an explicitly selected missing software never executes another installed engine', async t => {
  const fixture = await installations(t);
  let calls = 0;
  const result = await probeSlicerEngine({ engineId: 'flash', slicerPath: path.join(fixture.root, 'missing-flash'),
    env: { BAMBU_STUDIO_PATH: fixture.slicerPaths.bambu, ORCA_SLICER_PATH: fixture.slicerPaths.orca },
    execFileImpl: async () => { calls++; return { stdout: help('bambu') }; },
  });
  assert.equal(result.available, false);
  assert.equal(result.id, 'flash');
  assert.equal(calls, 0);
  assert.match(result.reason, /指定路径/);
});

test('a software cannot borrow the identity of another engine with identical flags', async t => {
  const fixture = await installations(t);
  for (const [selected, actual] of [['flash', 'bambu'], ['orca', 'flash'], ['bambu', 'orca']]) {
    const result = await probeSlicerEngine({ engineId: selected, slicerPath: fixture.slicerPaths[selected], execFileImpl: async () => ({ stdout: help(actual) }) });
    assert.equal(result.available, false);
    assert.match(result.reason, /不是可识别/);
    assert.equal(result.version, null);
  }
});

test('auto recognizes a configured executable from one --help call without a fallback', async t => {
  const fixture = await installations(t);
  let calls = 0;
  const selected = await probeSlicerEngine({ engineId: 'auto', slicerPath: fixture.slicerPaths.flash, platform: 'darwin', env: {},
    execFileImpl: async filename => { calls++; return fixture.execFileImpl(filename); },
  });
  assert.equal(calls, 1);
  assert.equal(selected.available, true);
  assert.equal(selected.id, 'flash');
  assert.equal(selected.profileVendor, 'Flashforge');
});

test('unsupported flags, start failure and invalid engine selection report unavailable', async t => {
  const fixture = await installations(t);
  const options = { engineId: 'flash', slicerPath: fixture.slicerPaths.flash };
  const missing = await probeSlicerEngine({ ...options, execFileImpl: async () => help('flash').replace(' --mstpp option', ' --mstpp-extra option') });
  assert.equal(missing.available, false);
  assert.deepEqual(missing.missingCliFlags, ['--mstpp']);
  const failed = await probeSlicerEngine({ ...options, execFileImpl: async () => { throw Object.assign(new Error('timeout'), { killed: true }); } });
  assert.equal(failed.available, false);
  assert.match(failed.reason, /检测超时/);
  const invalid = await probeSlicerEngine({ engineId: '../unknown', execFileImpl() { assert.fail('must not execute'); } });
  assert.equal(invalid.available, false);
  assert.match(invalid.reason, /选项无效/);
});

test('engine revision changes when a Flash binary changes without changing its version', async t => {
  const fixture = await installations(t);
  const options = { engineId: 'flash', slicerPath: fixture.slicerPaths.flash, execFileImpl: fixture.execFileImpl };
  const before = await probeSlicerEngine(options);
  await utimes(fixture.slicerPaths.flash, new Date('2024-01-01'), new Date('2024-01-01'));
  const after = await probeSlicerEngine(options);
  assert.equal(before.version, after.version);
  assert.notEqual(before.engineRevision, after.engineRevision);
});

test('each resource environment override stays specific to its selected software', async t => {
  const fixture = await installations(t);
  const result = await probeSlicerEngine({ engineId: 'flash', slicerPath: fixture.slicerPaths.flash, platform: 'darwin',
    env: { FLASH_STUDIO_RESOURCES: path.join(fixture.resources.flash, 'profiles'), BAMBU_STUDIO_RESOURCES: '/missing-bambu-resources' }, execFileImpl: fixture.execFileImpl });
  assert.equal(result.available, true);
  assert.equal(result.resourceDirectory, fixture.resources.flash);
  assert.equal(result.profileDirectory, path.join(fixture.resources.flash, 'profiles'));
});
