import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { findFFmpegPath, findPythonPath } from '../runtime-paths.mjs';
import { finalizeInstallManifest } from '../scripts/finalize-install-manifest.mjs';
import { sourceFiles } from '../scripts/install.mjs';

const executeFile = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const python = findPythonPath(), ffmpeg = findFFmpegPath();
const code = 'GTB1-ABCDE-FGHJK-LMNPQ-RSTUV-WXY23-4';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
let directory, built, runtimeRoot, entries, sourceArchive, originalHashes, packageInfo;
let activation, purchase, server;

async function sourceHashes() {
  const selected = [];
  for (const entry of await fs.readdir(projectRoot, { withFileTypes: true })) {
    if (entry.isFile() && /\.(?:mjs|js)$/.test(entry.name)) selected.push(entry.name);
  }
  async function walk(folder) {
    for (const entry of await fs.readdir(path.join(projectRoot, folder), { withFileTypes: true })) {
      const relative = path.join(folder, entry.name);
      if (entry.isDirectory() && entry.name !== '__pycache__') await walk(relative);
      else if (entry.isFile() && /\.(?:mjs|js|py)$/.test(entry.name)) selected.push(relative);
    }
  }
  await walk('src'); await walk('scripts');
  selected.push('package.json', 'package-lock.json', 'beta-config.json', 'install-manifest.json');
  return Object.fromEntries(await Promise.all(selected.sort().map(async relative => [relative, hash(await fs.readFile(path.join(projectRoot, relative)))])));
}

before(async () => {
  directory = await fs.mkdtemp(path.join(tmpdir(), 'growth-runtime-release-'));
  originalHashes = await sourceHashes();
  packageInfo = JSON.parse(await fs.readFile(path.join(projectRoot, 'package.json'), 'utf8'));
  const { buildRuntimeRelease } = await import('../scripts/build-runtime-release.mjs');
  built = await buildRuntimeRelease({ root: projectRoot, output: path.join(directory, 'packages'), python });
  const unpack = path.join(directory, 'unpacked');
  const inspected = await executeFile(python, ['-B', '-c', `import sys,json,zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
 names=z.namelist()
 assert all(name.startswith('growth-timelapse-studio/') and '..' not in name.split('/') and not name.startswith('/') for name in names)
 assert all((item.external_attr >> 16) & 0o170000 != 0o120000 for item in z.infolist())
 z.extractall(sys.argv[2])
 print(json.dumps(names))`, built.archive, unpack]);
  entries = JSON.parse(inspected.stdout);
  runtimeRoot = path.join(unpack, packageInfo.name);
  await executeFile(python, ['-B', path.join(projectRoot, 'scripts', 'package-release.py'), '--output', path.join(directory, 'source-package')]);
  sourceArchive = path.join(directory, 'source-package', `${packageInfo.name}-${packageInfo.version}-source.zip`);
});

after(async () => {
  if (directory) await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function runtimeModules() {
  if (!server) {
    // Use an already-installed production dependency, without running npm or
    // contacting any registry. It is not part of the release ZIP under test.
    await fs.mkdir(path.join(runtimeRoot, 'node_modules'), { recursive: true });
    await fs.cp(await fs.realpath(path.join(projectRoot, 'node_modules', 'three')), path.join(runtimeRoot, 'node_modules', 'three'), { recursive: true });
    activation = await import(pathToFileURL(path.join(runtimeRoot, 'beta-activation.mjs')));
    purchase = await import(pathToFileURL(path.join(runtimeRoot, 'software-purchase.mjs')));
    server = await import(pathToFileURL(path.join(runtimeRoot, 'server.mjs')));
  }
  return { activation, purchase, server };
}

function signer(productId) {
  const keys = generateKeyPairSync('ed25519'), keyId = 'synthetic-runtime-test';
  return {
    publicKeys: { [keyId]: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() },
    mint(installationId, extra = {}) {
      const payload = Buffer.from(JSON.stringify({ version: 1, productId, codeId: randomUUID(), installationId,
        issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: null, ...extra }));
      return { version: 1, algorithm: 'Ed25519', keyId, payload: payload.toString('base64url'), signature: sign(null, payload, keys.privateKey).toString('base64url') };
    },
  };
}

test('the official runtime ZIP excludes development material and secrets without changing local source', async () => {
  assert.equal(path.basename(built.archive), `${packageInfo.name}-${packageInfo.version}-runtime.zip`);
  assert.equal(hash(await fs.readFile(built.archive)), built.sha256);
  assert.deepEqual(await sourceHashes(), originalHashes, 'release transformation must occur only in its staging directory');
  const relative = entries.map(name => name.slice(packageInfo.name.length + 1));
  for (const name of relative) {
    assert.equal(/(^|\/)(?:tests|test-results|research|node_modules|private-beta|\.git|\.codex|\.agents|\.aws)(?:\/|$)/.test(name), false, name);
    assert.equal(name.startsWith('vendor/test-dom/'), false, name);
    assert.equal(/\.(?:map|pem|key|p12|pfx|db|sqlite|sqlite3)$/i.test(name), false, name);
    assert.equal(name.split('/').some(part => part.startsWith('.env')), false, name);
    assert.equal(/(?:build-runtime-release|package-release|finalize-install-manifest|test-native-slicing)/.test(name), false, name);
  }
  for (const required of ['index.html', 'package.json', 'package-lock.json', 'server.mjs', 'beta-activation.mjs', 'software-purchase.mjs',
    'free-watermark.mjs', 'beta-config.json', 'assets/free-watermark.png', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'RUNTIME_MANIFEST.json',
    'scripts/install.mjs', 'scripts/launch.mjs', 'scripts/check-runtime.mjs', 'scripts/windows-runtime.mjs',
    'scripts/render-cycles.py', 'scripts/prepare-slice-project.py', 'scripts/zip-png-sequence.py']) assert.ok(relative.includes(required), `runtime retains ${required}`);
  for (const name of relative.filter(name => /\.(?:mjs|js|py|json|html|css)$/.test(name))) {
    const text = await fs.readFile(path.join(runtimeRoot, name), 'utf8');
    assert.equal(/sourceMappingURL\s*=|-----BEGIN (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----/.test(text), false, name);
  }
  const runtimePackage = JSON.parse(await fs.readFile(path.join(runtimeRoot, 'package.json'), 'utf8'));
  const lock = JSON.parse(await fs.readFile(path.join(runtimeRoot, 'package-lock.json'), 'utf8'));
  assert.equal(Object.keys(runtimePackage.devDependencies || {}).length, 0);
  assert.equal(Object.keys(lock.packages?.['']?.devDependencies || {}).length, 0);
  assert.notEqual(await fs.readFile(path.join(runtimeRoot, 'src', 'app.js'), 'utf8'), await fs.readFile(path.join(projectRoot, 'src', 'app.js'), 'utf8'));
  assert.notEqual(await fs.readFile(path.join(runtimeRoot, 'beta-activation.mjs'), 'utf8'), await fs.readFile(path.join(projectRoot, 'beta-activation.mjs'), 'utf8'));
  const copiedByInstaller = await sourceFiles(runtimeRoot);
  assert.ok(copiedByInstaller.includes('RUNTIME_MANIFEST.json'));
  assert.ok(copiedByInstaller.includes(path.join('assets', 'free-watermark.png')), 'installed free exports must retain the brand image required by FFmpeg');
  for (const document of relative.filter(name => name.endsWith('.md'))) {
    const content = await fs.readFile(path.join(runtimeRoot, document), 'utf8');
    for (const [, target] of content.matchAll(/\]\(([^)]+)\)/g)) {
      if (/^(?:https?:|mailto:|#)/.test(target)) continue;
      const local = decodeURIComponent(target.split('#')[0]);
      await assert.doesNotReject(fs.access(path.resolve(runtimeRoot, path.dirname(document), local)), `${document} links to ${local}`);
    }
  }
});

test('fixed runtime and legacy source ZIPs can both finalize an installation manifest', async () => {
  const template = path.join(projectRoot, 'install-manifest.json'), before = await fs.readFile(template);
  for (const [kind, archive] of [['runtime', built.archive], ['source', sourceArchive]]) {
    const result = await finalizeInstallManifest({ archive, template, output: path.join(directory, `${kind}-install-manifest.json`) });
    assert.equal(result.manifest.release.sha256, hash(await fs.readFile(archive)));
    assert.equal(result.manifest.release.archiveRoot, packageInfo.name);
    assert.ok(result.manifest.release.url.endsWith(`-${kind}.zip`));
    assert.ok(result.manifest.release.url.includes(`/releases/download/v${packageInfo.version}/`));
  }
  assert.deepEqual(await fs.readFile(template), before);
  const { stdout } = await executeFile(python, ['-B', '-c', `import sys,json,zipfile,hashlib
with zipfile.ZipFile(sys.argv[1]) as z:
 print(json.dumps({'hasTests':any('/tests/' in name for name in z.namelist()),'serverHash':hashlib.sha256(z.read('growth-timelapse-studio/server.mjs')).hexdigest()}))`, sourceArchive]);
  const source = JSON.parse(stdout);
  assert.equal(source.hasTests, true);
  assert.equal(source.serverHash, originalHashes['server.mjs'], 'the public source ZIP still contains unmodified source');
});

test('transformed activation code keeps signatures, expiry, installation binding and offline recovery', async () => {
  const { activation } = await runtimeModules(), signing = signer(activation.BETA_PRODUCT_ID);
  const config = { productId: activation.BETA_PRODUCT_ID, serverUrl: 'https://synthetic-license.invalid', redemptionUrl: 'https://synthetic-license.invalid/points', publicKeys: signing.publicKeys };
  const dataDirectory = path.join(directory, 'synthetic-license');
  let calls = 0;
  const service = activation.createBetaActivationService({ config, dataDirectory, fetchImpl: async (_url, options) => {
    calls++; const input = JSON.parse(options.body);
    assert.equal(input.code, code); assert.equal(input.appVersion, packageInfo.version);
    return Response.json({ license: signing.mint(input.installationId) });
  } });
  const { installationId } = await service.status();
  const valid = signing.mint(installationId);
  assert.equal(activation.verifyBetaLicense(valid, { ...signing, installationId }).installationId, installationId);
  assert.throws(() => activation.verifyBetaLicense({ ...valid, signature: 'A'.repeat(86) }, { ...signing, installationId }), { code: 'INVALID_LICENSE' });
  assert.throws(() => activation.verifyBetaLicense(valid, { ...signing, installationId: randomUUID() }), { code: 'INVALID_LICENSE' });
  assert.throws(() => activation.verifyBetaLicense(signing.mint(installationId, { productId: 'wrong-product' }), { ...signing, installationId }), { code: 'INVALID_LICENSE' });
  assert.throws(() => activation.verifyBetaLicense(signing.mint(installationId, {
    issuedAt: new Date(Date.now() - 2000).toISOString(), expiresAt: new Date(Date.now() - 500).toISOString(),
  }), { ...signing, installationId }), { code: 'BETA_EXPIRED' });
  assert.equal((await service.activate(code)).activated, true);
  assert.equal(calls, 1);
  const offline = activation.createBetaActivationService({ config, dataDirectory, fetchImpl: async () => { throw new Error('synthetic offline'); } });
  assert.equal((await offline.status()).installationId, installationId);
  assert.equal((await offline.status()).activated, true);
  await offline.requireActivation();
});

test('transformed purchase code preserves durable idempotency and the year/permanent plan contract', async () => {
  const { purchase } = await runtimeModules();
  const dataDirectory = path.join(directory, 'synthetic-purchase'), installationId = randomUUID();
  const ids = [randomUUID(), randomUUID()], requests = [];
  const betaService = { status: async () => ({ activated: false, installationId }), activate: async () => {}, clearActivation: async () => {} };
  const settings = { directory: dataDirectory, betaService, serverUrl: 'https://synthetic-payment.invalid', fetchImpl: async (url, options) => {
    if (options.method !== 'POST') return Response.json({ id: ids[0], status: 'PENDING', licenseExpiresAt: null });
    const body = JSON.parse(options.body); requests.push(body);
    assert.equal(String(url), 'https://synthetic-payment.invalid/api/software-beta/payment/orders');
    assert.equal(body.installationId, installationId); assert.equal(body.appVersion, packageInfo.version);
    assert.equal(Object.hasOwn(body, 'amountCents'), false);
    if (requests.length === 1) throw new Error('synthetic response lost after acceptance');
    return Response.json({ id: body.plan === 'YEAR' ? ids[0] : ids[1], status: 'PENDING', plan: body.plan,
      amountCents: body.plan === 'YEAR' ? 1990 : 3990, licenseExpiresAt: null });
  } };
  const first = purchase.createSoftwarePurchaseService(settings);
  await assert.rejects(first.create('YEAR', 'alipay'), { code: 'PAYMENT_NETWORK_ERROR' });
  const recovered = purchase.createSoftwarePurchaseService(settings);
  const annual = await recovered.create('YEAR', 'alipay');
  assert.equal(annual.amountCents, 1990);
  assert.equal(requests[0].token, requests[1].token);
  const lifetime = await recovered.create('LIFETIME', 'wx');
  assert.equal(lifetime.amountCents, 3990); assert.equal(lifetime.plan, 'LIFETIME');
  assert.notEqual(requests[1].token, requests[2].token);
  const receipt = JSON.parse(await fs.readFile(path.join(dataDirectory, 'beta', 'purchase-history', ids[0] + '.json'), 'utf8'));
  assert.equal(receipt.id, ids[0]); assert.equal(receipt.token, requests[0].token); assert.equal(receipt.plan, 'YEAR');
});

test('the unpacked transformed server starts and retains free preview, branded free export and unbranded paid export', async t => {
  const { activation, server } = await runtimeModules(), signing = signer(activation.BETA_PRODUCT_ID);
  const dataDirectory = path.join(directory, 'synthetic-server-license');
  const config = { productId: activation.BETA_PRODUCT_ID, serverUrl: 'https://synthetic-license.invalid', redemptionUrl: 'https://synthetic-license.invalid/points', publicKeys: signing.publicKeys };
  const betaService = activation.createBetaActivationService({ config, dataDirectory, fetchImpl: async (_url, options) => Response.json({ license: signing.mint(JSON.parse(options.body).installationId) }) });
  const realisticCalls = [];
  const app = server.createApp({ root: runtimeRoot, exportDirectory: path.join(directory, 'synthetic-exports'), ffmpegPath: ffmpeg,
    supportsSlicerPath: '/missing-synthetic-slicer', betaService, paymentService: {},
    photoCalibrationService: { capability: async () => ({ available: false }), detect: async () => ({}) },
    sliceService: { health: async () => ({ available: false }), close: async () => {} },
    alphaEncoderProbe: async () => ({ available: false }),
    realisticRenderService: { active: false, close: async () => {}, health: async () => ({ available: true }),
      create: async (_body, options) => { realisticCalls.push(options); return { id: randomUUID(), status: 'complete', format: options.format }; },
    },
  });
  await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); });
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = (resource, method = 'GET', body, contentType = 'application/json') => fetch(base + resource, {
    method, headers: { Origin: base, ...(body === undefined ? {} : { 'Content-Type': contentType }) },
    ...(body === undefined ? {} : { body: Buffer.isBuffer(body) ? body : JSON.stringify(body) }),
  });
  const page = await request('/'); assert.equal(page.status, 200);
  assert.equal(/free-watermark(?:-preview|\.png)/.test(await page.text()), false);
  assert.equal((await request('/src/beta-access.js')).status, 200);
  assert.equal((await request('/assets/free-watermark.png')).status, 200);
  const health = await (await request('/api/health')).json();
  assert.equal(health.version, packageInfo.version); assert.equal(health.app, packageInfo.name);
  const preview = await request('/api/realistic-previews?exportMode=watermarked', 'POST', Buffer.from('synthetic-scene'), 'application/zip');
  assert.equal(preview.status, 201); assert.equal((await preview.json()).watermarked, false);
  assert.equal(realisticCalls[0].format, 'preview'); assert.equal(realisticCalls[0].watermarked, false);
  const settings = { width: 320, height: 240, fps: 5, frames: 2, format: 'mp4', name: 'runtime-contract' };
  const locked = await request('/api/exports', 'POST', { ...settings, exportMode: 'unlocked' });
  assert.equal(locked.status, 403); assert.equal((await locked.json()).error.code, 'ACTIVATION_REQUIRED');
  for (const format of ['mov-alpha', 'png-sequence']) {
    const denied = await request('/api/exports', 'POST', { ...settings, format, exportMode: 'watermarked' });
    assert.equal(denied.status, 403); assert.equal((await denied.json()).error.code, 'FREE_EXPORT_FORMAT');
  }
  const black = await executeFile(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=320x240:r=5',
    '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', 'pipe:1'], { encoding: 'buffer', maxBuffer: 2 * 1024 * 1024 });
  async function exportVideo(exportMode) {
    const response = await request('/api/exports', 'POST', { ...settings, exportMode });
    assert.equal(response.status, 201, await response.clone().text());
    const job = await response.json();
    for (let frame = 0; frame < settings.frames; frame++) assert.equal((await request(`/api/exports/${job.id}/frames?index=${frame}`, 'POST', black.stdout, 'image/png')).status, 200);
    const completed = await request(`/api/exports/${job.id}/finish`, 'POST'); assert.equal(completed.status, 200);
    const result = await completed.json(), file = await request(result.url); assert.equal(file.status, 200);
    const filename = path.join(directory, `${exportMode}.mp4`); await fs.writeFile(filename, Buffer.from(await file.arrayBuffer()));
    const decoded = await executeFile(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', filename, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { encoding: 'buffer', maxBuffer: 4 * 1024 * 1024 });
    assert.equal(decoded.stdout.length, settings.width * settings.height * 3 * settings.frames);
    return { job, frames: decoded.stdout };
  }
  const free = await exportVideo('watermarked'); assert.equal(free.job.watermarked, true);
  const frameBytes = settings.width * settings.height * 3;
  for (let frame = 0; frame < settings.frames; frame++) assert.ok(free.frames.subarray(frame * frameBytes, (frame + 1) * frameBytes).some(value => value > 10), 'the transformed free encoder still burns branding into every requested frame');
  const activated = await request('/api/beta/activate', 'POST', { code });
  assert.equal(activated.status, 200); assert.equal((await activated.json()).activated, true);
  const paid = await exportVideo('unlocked'); assert.equal(paid.job.watermarked, false);
  assert.equal(paid.frames.some(value => value > 10), false, 'the transformed paid encoder remains free of branding');
});
