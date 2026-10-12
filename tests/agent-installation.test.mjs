import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { applicationId, install, validateManifest, downloadVerified, dataDirectory, parseArguments } from '../scripts/install.mjs';
import { launch } from '../scripts/launch.mjs';
import { finalizeInstallManifest } from '../scripts/finalize-install-manifest.mjs';

const executeFile = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await fs.readFile(path.join(projectRoot, 'install-manifest.json'), 'utf8'));

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'growth installer 空格 '));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, '源码 with spaces');
  await fs.mkdir(path.join(source, 'scripts'), { recursive: true });
  await fs.writeFile(path.join(source, 'package.json'), JSON.stringify({ name: applicationId, version: manifest.release.version }));
  await fs.writeFile(path.join(source, 'package-lock.json'), '{}');
  await fs.writeFile(path.join(source, 'scripts', 'check-runtime.mjs'), 'console.log("fixture doctor")');
  await fs.writeFile(path.join(source, 'scripts', 'launch.mjs'), '// fixture launcher');
  await fs.writeFile(path.join(source, 'server.mjs'), '// fixture server');
  const data = path.join(root, '用户 data with spaces');
  return { root, source, data };
}

function mockedInstall(calls = []) {
  return {
    platform: 'darwin', manifest, log: () => {}, npmCli: '/fixture/npm-cli.js',
    ensureRuntime: async () => ({ node: process.execPath, python: '/fixture/python3', ffmpeg: '/fixture/ffmpeg', slicer: { id: 'bambu', executablePath: '/fixture/Bambu Studio' } }),
    run: async (filename, args, options) => { calls.push({ filename, args, options }); },
  };
}

test('dry run never provisions a runtime or writes a data directory', async t => {
  const { source, data } = await fixture(t);
  const deps = mockedInstall();
  deps.ensureRuntime = async () => { throw new Error('must not install'); };
  const result = await install({ source, installRoot: data, dryRun: true }, deps);
  assert.equal(result.dryRun, true);
  await assert.rejects(fs.stat(data), { code: 'ENOENT' });
});

test('repeat install reuses source and preserves exports and beta authorization', async t => {
  const { source, data } = await fixture(t);
  await fs.mkdir(path.join(data, 'beta'), { recursive: true });
  await fs.mkdir(path.join(data, 'exports'));
  await fs.writeFile(path.join(data, 'beta', 'license.json'), 'keep signed authorization');
  await fs.writeFile(path.join(data, 'exports', 'student film.mp4'), 'keep video');
  await fs.mkdir(path.join(source, 'node_modules'));
  await fs.writeFile(path.join(source, 'node_modules', 'do-not-copy.txt'), 'local dependency');
  await fs.writeFile(path.join(source, '.env'), 'must not copy local settings');
  await fs.mkdir(path.join(source, 'private-beta'));
  await fs.writeFile(path.join(source, 'private-beta', 'codes.json'), 'must not copy private inventory');
  await fs.mkdir(path.join(source, 'docs', 'integration-work'), { recursive: true });
  await fs.writeFile(path.join(source, 'docs', 'integration-work', 'receipt.json'), 'must not copy integration data');
  await fs.writeFile(path.join(source, 'scripts', 'signing.pem'), 'must not copy private key');
  await fs.writeFile(path.join(source, 'scripts', 'inventory-1000.json'), 'must not copy private inventory');
  await fs.writeFile(path.join(source, 'unknown-personal.json'), 'unknown root file');
  const calls = [], deps = mockedInstall(calls);
  const first = await install({ source, installRoot: data, noLaunch: true }, deps);
  const second = await install({ source, installRoot: data, noLaunch: true }, deps);
  assert.equal(second.releaseDirectory, first.releaseDirectory);
  assert.equal(second.reused, true);
  assert.equal(calls.filter(call => call.args.includes('ci')).length, 1);
  assert.equal(calls.filter(call => call.args.some(arg => arg.endsWith('check-runtime.mjs'))).length, 2);
  assert.equal(await fs.readFile(path.join(data, 'beta', 'license.json'), 'utf8'), 'keep signed authorization');
  assert.equal(await fs.readFile(path.join(data, 'exports', 'student film.mp4'), 'utf8'), 'keep video');
  await assert.rejects(fs.stat(path.join(first.releaseDirectory, '.env')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(first.releaseDirectory, 'node_modules')), { code: 'ENOENT' });
  for (const filename of ['private-beta/codes.json', 'docs/integration-work/receipt.json', 'scripts/signing.pem', 'scripts/inventory-1000.json', 'unknown-personal.json']) await assert.rejects(fs.stat(path.join(first.releaseDirectory, filename)), { code: 'ENOENT' });
  const shortcut = await fs.readFile(path.join(data, '打开打印延时.command'), 'utf8');
  assert.ok(shortcut.includes("'" + data + "'"), 'space-containing path must be quoted');
});

test('changing local source creates a new release and keeps the previous usable release', async t => {
  const { source, data } = await fixture(t);
  const deps = mockedInstall();
  const first = await install({ source, installRoot: data, noLaunch: true }, deps);
  await fs.writeFile(path.join(source, 'server.mjs'), '// new fixture server');
  const second = await install({ source, installRoot: data, noLaunch: true }, deps);
  assert.notEqual(second.releaseDirectory, first.releaseDirectory);
  assert.equal(await fs.readFile(path.join(first.releaseDirectory, 'server.mjs'), 'utf8'), '// fixture server');
});

test('failed npm installation does not replace the selected version or touch user data', async t => {
  const { source, data } = await fixture(t);
  await install({ source, installRoot: data, noLaunch: true }, mockedInstall());
  const old = await fs.readFile(path.join(data, 'installation.json'), 'utf8');
  await fs.writeFile(path.join(source, 'server.mjs'), '// failing upgrade');
  const deps = mockedInstall();
  deps.run = async (_filename, args) => { if (args.includes('ci')) throw new Error('simulated npm failure'); };
  await assert.rejects(install({ source, installRoot: data, noLaunch: true }, deps), /simulated npm failure/);
  assert.equal(await fs.readFile(path.join(data, 'installation.json'), 'utf8'), old);
  await assert.rejects(fs.stat(path.join(data, '.install.lock')), { code: 'ENOENT' });
  const third = await install({ source, installRoot: data, noLaunch: true }, mockedInstall());
  assert.equal(third.reused, false);
});

test('unpublished or mutable release URLs fail before runtime provisioning', async t => {
  const { data } = await fixture(t);
  await assert.rejects(install({ installRoot: data }, mockedInstall()), /尚未发布/);
  await assert.rejects(fs.stat(data), { code: 'ENOENT' });
  const published = structuredClone(manifest);
  published.release.published = true;
  published.release.sha256 = 'a'.repeat(64);
  published.release.url = 'https://github.com/dashan914/growth-timelapse-studio/archive/refs/heads/main.zip';
  assert.throws(() => validateManifest(published), /固定 GitHub Release/);
  published.release.url = `https://github.com/${published.release.repository}/releases/download/${published.release.tag}/source.zip`;
  assert.doesNotThrow(() => validateManifest(published));
});

test('download verifies hashes, reuses cache, and discards failed payloads', async t => {
  const { root } = await fixture(t);
  const payload = Buffer.from('fixed release bytes');
  const asset = { url: 'https://github.com/dashan914/growth-timelapse-studio/releases/download/v1.1.0-beta.1/source.zip', sha256: createHash('sha256').update(payload).digest('hex') };
  const file = path.join(root, 'cache with space', 'source.zip');
  let requests = 0;
  const fetchImpl = async () => { requests++; return new Response(payload); };
  await downloadVerified(asset, file, { fetchImpl });
  await downloadVerified(asset, file, { fetchImpl });
  assert.equal(requests, 1);
  await fs.writeFile(file, 'broken cache');
  await assert.rejects(downloadVerified(asset, file, { fetchImpl: async () => new Response('untrusted bytes') }), /SHA256/);
  assert.equal(await fs.readFile(file, 'utf8'), 'broken cache');
  assert.deepEqual(await fs.readdir(path.dirname(file)), ['source.zip']);
});

test('installer rejects writing its data root inside source and rejects symlinks', async t => {
  const { source, data } = await fixture(t);
  await assert.rejects(install({ source, installRoot: path.join(source, 'userdata'), dryRun: true }, mockedInstall()), /源码内部/);
  await fs.mkdir(path.join(source, 'src'));
  await fs.symlink(path.join(source, 'server.mjs'), path.join(source, 'src', 'shortcut.mjs'));
  await assert.rejects(install({ source, installRoot: data, noLaunch: true }, mockedInstall()), /符号链接/);
});

test('macOS bootstrap handles a space-containing source and remains read-only in dry run', async t => {
  if (process.platform !== 'darwin') { t.skip('macOS bootstrap'); return; }
  const { source, data } = await fixture(t);
  const result = await executeFile('/bin/bash', [path.join(projectRoot, 'scripts', 'install.sh'), '--source', source, '--install-root', data, '--dry-run']);
  assert.ok(result.stdout.includes('DRY RUN'));
  await assert.rejects(fs.stat(data), { code: 'ENOENT' });
});

test('launcher skips a foreign occupied port, persists after its caller, and reuses only its own instance', async t => {
  const { source, data } = await fixture(t);
  const foreign = net.createServer();
  const sockets = new Set();
  foreign.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise(resolve => foreign.listen(0, '127.0.0.1', resolve));
  const port = foreign.address().port;
  t.after(() => { for (const socket of sockets) socket.destroy(); return new Promise(resolve => foreign.close(resolve)); });
  await fs.writeFile(path.join(source, 'server.mjs'), `import http from 'node:http';
const server=http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({app:'${applicationId}',ok:true,version:'${manifest.release.version}',instanceId:process.env.GROWTH_INSTANCE_ID,pid:process.pid}));});
server.listen(Number(process.env.PORT),'127.0.0.1');
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));\n`);
  const result = await launch({ source, installRoot: data, port, noOpen: true }, { platform: 'darwin', log: () => {} });
  t.after(() => { try { process.kill(result.pid); } catch {} });
  assert.equal(result.reused, false);
  assert.ok(result.url.endsWith(`:${port + 1}`));
  const reuse = await launch({ source, installRoot: data, port, noOpen: true }, { platform: 'darwin', log: () => {} });
  assert.equal(reuse.reused, true);
  assert.equal(reuse.pid, result.pid);
  const anotherRoot = path.join(path.dirname(data), 'other data');
  const other = await launch({ source, installRoot: anotherRoot, port, noOpen: true }, { platform: 'darwin', log: () => {} });
  t.after(() => { try { process.kill(other.pid); } catch {} });
  assert.equal(other.reused, false);
  assert.notEqual(other.url, result.url);
});

test('data roots use OS application storage and accept isolated overrides', () => {
  assert.equal(dataDirectory({ platform: 'darwin', env: {}, home: '/Users/student' }), '/Users/student/Library/Application Support/GrowthTimelapseStudio');
  assert.equal(dataDirectory({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\student\\AppData\\Local' }, home: 'C:\\Users\\student' }), 'C:\\Users\\student\\AppData\\Local\\GrowthTimelapseStudio');
  assert.equal(dataDirectory({ env: { GROWTH_DATA_DIR: '/private/tmp/isolated growth' } }), '/private/tmp/isolated growth');
  assert.deepEqual(parseArguments(['--manifest', '/private/tmp/external manifest.json', '--no-runtime-install']), { manifestFile: '/private/tmp/external manifest.json', noRuntimeInstall: true });
});

test('external manifest hashes an already-built ZIP without modifying either the ZIP or repository template', async t => {
  const { root, source, data } = await fixture(t);
  const template = path.join(root, 'template.json');
  await fs.writeFile(template, JSON.stringify(manifest, null, 2));
  const before = await fs.readFile(template, 'utf8');
  const archive = path.join(root, `${applicationId}-${manifest.release.version}-source.zip`);
  // A real small ZIP made locally; this never accesses download URLs.
  await executeFile('python3', ['-c', 'import sys,zipfile\nwith zipfile.ZipFile(sys.argv[1], "w") as z:z.writestr("growth-timelapse-studio/fixture.txt", "fixture")', archive]);
  const bytes = await fs.readFile(archive);
  const result = await finalizeInstallManifest({ archive, template });
  assert.equal(result.manifest.release.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(await fs.readFile(template, 'utf8'), before);
  assert.deepEqual(await fs.readFile(archive), bytes);
  assert.ok(result.manifest.release.url.includes(`/releases/download/${manifest.release.tag}/`));
  await assert.rejects(finalizeInstallManifest({ archive, template, output: template }), /不能覆盖仓库内模板/);
  await assert.rejects(finalizeInstallManifest({ archive, template, repository: 'someone/unknown-repo' }), /固定允许范围/);
  const deps = mockedInstall();
  delete deps.manifest;
  const dryRun = await install({ source, installRoot: data, manifestFile: result.path, dryRun: true }, deps);
  assert.equal(dryRun.version, manifest.release.version);
  await assert.rejects(fs.stat(data), { code: 'ENOENT' });
});
