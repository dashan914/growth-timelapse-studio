import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSoftwarePurchaseService } from '../software-purchase.mjs';
import { BETA_PRODUCT_ID, createBetaActivationService } from '../beta-activation.mjs';

const code = 'GTB1-ABCDE-FGHJK-LMNPQ-RSTUV-WXY23-4';

async function fixture(t, fetchImpl) {
  const directory = await mkdtemp(path.join(tmpdir(), 'growth-purchase-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const state = { activated: false, installationId: randomUUID(), activations: [], cleared: 0 };
  const betaService = {
    status: async () => ({ activated: state.activated, installationId: state.installationId }),
    activate: async value => { state.activations.push(value); state.activated = true; },
    clearActivation: async () => { state.cleared++; state.activated = false; },
  };
  const settings = { directory, betaService, fetchImpl, serverUrl: 'https://payments.example.test' };
  return { directory, state, betaService, settings, service: createSoftwarePurchaseService(settings) };
}

test('request timeout keeps a private durable retry identity across app restarts', async t => {
  const calls = [], id = randomUUID();
  const f = await fixture(t, async (url, options) => {
    assert.equal(String(url), 'https://payments.example.test/api/software-beta/payment/orders');
    assert.equal(options.redirect, 'error'); assert.ok(options.signal instanceof AbortSignal);
    const body = JSON.parse(options.body); calls.push(body);
    if (calls.length === 1) throw new Error('synthetic connection failure after server accepted order');
    return Response.json({ id, status: 'PENDING' });
  });
  await assert.rejects(f.service.create('YEAR', 'alipay'), { code: 'PAYMENT_NETWORK_ERROR', status: 503 });
  const file = path.join(f.directory, 'beta', 'purchase.json');
  const before = JSON.parse(await readFile(file, 'utf8'));
  assert.match(before.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(before.id, undefined);
  const restarted = createSoftwarePurchaseService(f.settings);
  const order = await restarted.create('YEAR', 'alipay');
  assert.equal(order.id, id);
  assert.equal(calls.length, 2); assert.equal(calls[0].token, calls[1].token);
  assert.equal(calls[0].installationId, f.state.installationId);
  assert.ok(!Object.hasOwn(calls[0], 'price'), 'client cannot set the price');
  assert.equal(calls[0].plan, 'YEAR'); assert.equal(calls[0].payMethod, 'alipay');
  if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
  await assert.rejects(stat(path.join(f.directory, 'beta', 'purchase-history')), { code: 'ENOENT' }, 'an unknown request without a server order ID must keep its original token rather than archive and replace it');
});

test('changing a pending purchase archives its complete private recovery receipt before creating the new plan', async t => {
  const ids = [randomUUID(), randomUUID()], posts = [];
  let f, original;
  f = await fixture(t, async (url, options) => {
    if (options.method !== 'POST') {
      assert.equal(new URL(url).pathname, `/api/software-beta/payment/orders/${ids[0]}`);
      assert.equal(options.headers.Authorization, 'Bearer ' + original.token);
      return Response.json({ id: ids[0], status: 'PENDING', licenseExpiresAt: null });
    }
    const body = JSON.parse(options.body); posts.push(body);
    if (posts.length === 2) {
      const archived = JSON.parse(await readFile(path.join(f.directory, 'beta', 'purchase-history', ids[0] + '.json'), 'utf8'));
      assert.deepEqual(archived, original, 'all existing receipt fields must survive before contacting the server for another purchase');
      const saved = JSON.parse(await readFile(path.join(f.directory, 'beta', 'purchase.json'), 'utf8'));
      assert.equal(saved.token, body.token, 'the new retry identity is persisted only after archiving the old receipt');
    }
    return Response.json({ id: ids[posts.length - 1], status: 'PENDING', plan: body.plan,
      amountCents: body.plan === 'YEAR' ? 1990 : 3990, licenseExpiresAt: null });
  });
  await f.service.create('YEAR', 'alipay');
  const file = path.join(f.directory, 'beta', 'purchase.json');
  original = JSON.parse(await readFile(file, 'utf8'));
  const next = await f.service.create('LIFETIME', 'wx');
  assert.equal(next.id, ids[1]); assert.equal(next.plan, 'LIFETIME'); assert.equal(next.amountCents, 3990);
  assert.equal(posts.length, 2); assert.notEqual(posts[0].token, posts[1].token);
  assert.equal(posts[1].plan, 'LIFETIME'); assert.equal(posts[1].payMethod, 'wx');
  assert.equal(Object.hasOwn(posts[1], 'amountCents'), false, 'the software must still leave payment amounts to the server');
  const history = path.join(f.directory, 'beta', 'purchase-history');
  const archivedFile = path.join(history, ids[0] + '.json');
  assert.deepEqual(JSON.parse(await readFile(archivedFile, 'utf8')), original);
  const current = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(current.id, ids[1]); assert.equal(current.token, posts[1].token);
  assert.equal(current.plan, 'LIFETIME'); assert.equal(current.payMethod, 'wx');
  assert.equal(f.state.activated, false);
  if (process.platform !== 'win32') {
    assert.equal((await stat(history)).mode & 0o777, 0o700);
    assert.equal((await stat(archivedFile)).mode & 0o777, 0o600);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
  }
});

test('replacing an order never overwrites an existing archived recovery receipt', async t => {
  const ids = [randomUUID(), randomUUID()], posts = [];
  const f = await fixture(t, async (_url, options) => {
    if (options.method !== 'POST') return Response.json({ id: ids[0], status: 'PENDING', licenseExpiresAt: null });
    posts.push(JSON.parse(options.body));
    return Response.json({ id: ids[posts.length - 1], status: 'PENDING', licenseExpiresAt: null });
  });
  await f.service.create('YEAR', 'alipay');
  const original = JSON.parse(await readFile(path.join(f.directory, 'beta', 'purchase.json'), 'utf8'));
  const history = path.join(f.directory, 'beta', 'purchase-history');
  const archivedFile = path.join(history, ids[0] + '.json');
  await mkdir(history, { mode: 0o700 });
  const existing = JSON.stringify({ ...original, durableNote: 'synthetic previously archived receipt' }, null, 2) + '\n';
  await writeFile(archivedFile, existing, { flag: 'wx', mode: 0o600 });
  const next = await f.service.create('LIFETIME', 'alipay');
  assert.equal(next.id, ids[1]);
  assert.equal(await readFile(archivedFile, 'utf8'), existing, 'an existing recovery file must remain byte-for-byte unchanged');
  assert.equal(JSON.parse(await readFile(path.join(f.directory, 'beta', 'purchase.json'), 'utf8')).id, ids[1]);
});

test('double clicks cannot make concurrent payment requests and changed purchase options get a fresh identity', async t => {
  let release, entered;
  const waiting = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const bodies = [], id = randomUUID();
  const f = await fixture(t, async (_url, options) => {
    if (options.method !== 'POST') return Response.json({ id, status: 'PENDING' });
    bodies.push(JSON.parse(options.body)); entered();
    if (bodies.length === 1) await waiting;
    return Response.json({ id, status: 'PENDING' });
  });
  const first = f.service.create('YEAR', 'wx'); await started;
  const second = f.service.create('YEAR', 'wx');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(bodies.length, 1, 'a second click cannot send a concurrent request');
  release(); await Promise.all([first, second]);
  await f.service.create('LIFETIME', 'alipay');
  assert.equal(bodies[0].token, bodies[1].token);
  assert.notEqual(bodies[1].token, bodies[2].token);
  assert.equal(bodies[2].plan, 'LIFETIME');
});

test('invalid options fail locally and malformed or rejected payment responses never activate', async t => {
  let calls = 0, mode = 'rejected';
  const f = await fixture(t, async () => {
    calls++;
    if (mode === 'rejected') return Response.json({ error: { code: 'PAYMENT_DISABLED', message: '购买尚未开放。' } }, { status: 503 });
    if (mode === 'html') return new Response('<html>not an order</html>');
    return Response.json({ id: 'not-a-valid-order', status: 'PAID', code });
  });
  for (const [plan, payMethod] of [['YEAR', 'card'], ['FREE', 'alipay'], ['year', 'wx'], [null, 'wx']]) {
    await assert.rejects(f.service.create(plan, payMethod), { code: 'INVALID_REQUEST', status: 400 });
  }
  assert.equal(calls, 0);
  await assert.rejects(f.service.create('YEAR', 'alipay'), { code: 'PAYMENT_DISABLED', status: 503 });
  mode = 'html'; await assert.rejects(f.service.create('YEAR', 'alipay'), { code: 'INVALID_PAYMENT_RESPONSE', status: 502 });
  mode = 'badid'; await assert.rejects(f.service.create('YEAR', 'alipay'), { code: 'INVALID_PAYMENT_RESPONSE', status: 502 });
  assert.equal(f.state.activated, false); assert.deepEqual(f.state.activations, []);
  assert.throws(() => createSoftwarePurchaseService({ ...f.settings, serverUrl: 'http://payments.example.test' }), /Invalid payment server/);
  assert.throws(() => createSoftwarePurchaseService({ ...f.settings, serverUrl: 'https://name:password@payments.example.test' }), /Invalid payment server/);
});

test('pending orders do not unlock and paid orders activate once through the existing activation service', async t => {
  const id = randomUUID(); let paid = false, token;
  const f = await fixture(t, async (url, options) => {
    if (options.method === 'POST') { token = JSON.parse(options.body).token; return Response.json({ id, status: 'PENDING' }); }
    assert.equal(String(url), `https://payments.example.test/api/software-beta/payment/orders/${id}`);
    assert.equal(options.headers.Authorization, 'Bearer ' + token);
    return Response.json({ id, status: paid ? 'PAID' : 'PENDING', ...(paid ? { code } : {}) });
  });
  await f.service.create('LIFETIME', 'wx');
  assert.equal((await f.service.status()).activated, false); assert.deepEqual(f.state.activations, []);
  paid = true;
  assert.equal((await f.service.status()).activated, true);
  assert.deepEqual(f.state.activations, [code]);
  await f.service.status(); await createSoftwarePurchaseService(f.settings).status();
  assert.deepEqual(f.state.activations, [code], 'polling and restarting do not reactivate a valid local license');
});

test('a paid order whose credential is rejected remains locked and reports the activation failure', async t => {
  const id = randomUUID();
  const f = await fixture(t, async (_url, options) => Response.json({ id, status: options.method === 'POST' ? 'PENDING' : 'PAID', code }));
  f.betaService.activate = async () => { throw new Error('synthetic invalid signature'); };
  await f.service.create('YEAR', 'alipay');
  const result = await f.service.status();
  assert.equal(result.activated, false); assert.equal(result.activationError, 'synthetic invalid signature');
});

test('successful device unbinding clears the license, preserves recovery and never auto-activates again after restart', async t => {
  const id = randomUUID(), calls = []; let token;
  const f = await fixture(t, async (url, options) => {
    const resource = new URL(url).pathname; calls.push(resource);
    if (resource.endsWith('/orders')) { token = JSON.parse(options.body).token; return Response.json({ id, status: 'PENDING' }); }
    assert.equal(options.headers.Authorization, 'Bearer ' + token);
    if (resource.endsWith('/unbind')) {
      assert.equal(options.method, 'POST'); assert.equal(JSON.parse(options.body).installationId, f.state.installationId);
      return Response.json({ unbound: true });
    }
    return Response.json({ id, status: 'PAID', code });
  });
  await f.service.create('LIFETIME', 'alipay'); await f.service.status();
  const result = await f.service.unbind();
  assert.equal(result.unbound, true); assert.equal(result.activated, false); assert.equal(f.state.cleared, 1);
  assert.equal((await f.service.status()).activated, false);
  const restarted = createSoftwarePurchaseService(f.settings);
  const recovered = await restarted.status();
  assert.equal(recovered.activated, false); assert.equal(recovered.order.code, code, 'the paid code remains available for manual recovery');
  assert.deepEqual(f.state.activations, [code]);
  const saved = JSON.parse(await readFile(path.join(f.directory, 'beta', 'purchase.json'), 'utf8'));
  assert.equal(saved.status, 'UNBOUND'); assert.equal(saved.id, id); assert.equal(saved.token, token);
  assert.equal(calls.filter(value => value.endsWith('/unbind')).length, 1);
});

test('failed unbinding preserves the already valid offline activation', async t => {
  const id = randomUUID(); let fail = false;
  const f = await fixture(t, async (url, options) => {
    if (new URL(url).pathname.endsWith('/unbind') && fail) throw new Error('synthetic offline network');
    return Response.json({ id, status: options.method === 'POST' ? 'PENDING' : 'PAID', code });
  });
  await assert.rejects(f.service.unbind(), { code: 'ORDER_NOT_FOUND', status: 404 });
  await f.service.create('YEAR', 'wx'); await f.service.status(); fail = true;
  await assert.rejects(f.service.unbind(), { code: 'PAYMENT_NETWORK_ERROR' });
  assert.equal(f.state.activated, true); assert.equal(f.state.cleared, 0);
});

test('unbinding while paid-order polling is activating cannot restore the old device license', async t => {
  const id = randomUUID();
  const f = await fixture(t, async (url, options) => {
    if (new URL(url).pathname.endsWith('/unbind')) return Response.json({ unbound: true });
    return Response.json({ id, status: options.method === 'POST' ? 'PENDING' : 'PAID', code });
  });
  let entered, release;
  const activating = new Promise(resolve => { entered = resolve; });
  const delayed = new Promise(resolve => { release = resolve; });
  f.betaService.activate = async value => {
    f.state.activations.push(value); entered();
    await delayed; f.state.activated = true;
  };
  await f.service.create('LIFETIME', 'wx');
  const polling = f.service.status(); await activating;
  let unbound = false;
  const unbinding = f.service.unbind().then(result => { unbound = true; return result; });
  // Let the request reach the unbind service while the previous activation finishes.
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(unbound, false, 'unbinding waits for the in-flight activation');
  release();
  await Promise.all([polling, unbinding]);
  assert.equal(f.state.activated, false, 'a poll already in progress cannot undo device unbinding');
  assert.equal((await createSoftwarePurchaseService(f.settings).status()).activated, false);
});

test('annual payment records its server expiry, avoids duplicate active purchases and uses a new retry token after expiry', async t => {
  const posts = [], ids = [randomUUID(), randomUUID()];
  let expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
  const f = await fixture(t, async (url, options) => {
    if (options.method === 'POST') {
      posts.push(JSON.parse(options.body));
      return Response.json({ id: ids[posts.length - 1], status: 'PENDING', licenseExpiresAt: null });
    }
    assert.equal(new URL(url).pathname, `/api/software-beta/payment/orders/${ids[0]}`);
    assert.equal(options.headers.Authorization, 'Bearer ' + posts[0].token);
    return Response.json({ id: ids[0], status: 'PAID', code, licenseExpiresAt: expiresAt });
  });
  await f.service.create('YEAR', 'alipay'); await f.service.status();
  const file = path.join(f.directory, 'beta', 'purchase.json');
  assert.equal(JSON.parse(await readFile(file, 'utf8')).licenseExpiresAt, expiresAt, 'payment polling persists the actual license expiry');
  assert.equal((await f.service.create('YEAR', 'wx')).id, ids[0]);
  assert.equal(posts.length, 1, 'changing payment method does not recharge an active annual license');
  expiresAt = new Date(Date.now() - 1000).toISOString();
  f.state.activated = false;
  f.betaService.activate = async () => { throw new Error('synthetic expired annual license'); };
  const renewal = await createSoftwarePurchaseService(f.settings).create('YEAR', 'alipay');
  assert.equal(renewal.id, ids[1]); assert.equal(renewal.status, 'PENDING');
  assert.equal(posts.length, 2); assert.notEqual(posts[0].token, posts[1].token);
  assert.equal(posts[1].plan, 'YEAR'); assert.equal(posts[1].installationId, f.state.installationId);
  assert.equal(f.state.activated, false, 'an unpaid renewal cannot restore an expired local license');
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(saved.id, ids[1]); assert.equal(saved.token, posts[1].token);
});

test('permanent purchases with no expiry reuse the paid order across payment-method changes and restarts', async t => {
  const id = randomUUID(), posts = [];
  const f = await fixture(t, async (url, options) => {
    if (options.method === 'POST') {
      posts.push(JSON.parse(options.body));
      return Response.json({ id, status: 'PENDING', licenseExpiresAt: null });
    }
    assert.equal(new URL(url).pathname, `/api/software-beta/payment/orders/${id}`);
    assert.equal(options.headers.Authorization, 'Bearer ' + posts[0].token);
    return Response.json({ id, status: 'PAID', code, licenseExpiresAt: null });
  });
  await f.service.create('LIFETIME', 'alipay'); await f.service.status();
  assert.equal((await f.service.create('LIFETIME', 'wx')).id, id);
  assert.equal((await createSoftwarePurchaseService(f.settings).create('LIFETIME', 'alipay')).id, id);
  assert.equal(posts.length, 1, 'a permanent purchase never creates another payment order');
  assert.deepEqual(f.state.activations, [code]);
  const saved = JSON.parse(await readFile(path.join(f.directory, 'beta', 'purchase.json'), 'utf8'));
  assert.equal(saved.id, id); assert.equal(saved.token, posts[0].token); assert.equal(saved.licenseExpiresAt, null);
});

test('paid year and permanent receipts survive restart offline without becoming authorization', async t => {
  for (const plan of ['YEAR', 'LIFETIME']) await t.test(plan, async t => {
    const id = randomUUID(), expiresAt = plan === 'YEAR' ? new Date(Date.now() + 86400000).toISOString() : null;
    const f = await fixture(t, async (_url, options) => Response.json({ id, status: options.method === 'POST' ? 'PENDING' : 'PAID',
      code, orderNo: 'GT-SYNTHETIC-RECEIPT', plan, amountCents: plan === 'YEAR' ? 1990 : 3990, licenseExpiresAt: expiresAt }));
    await f.service.create(plan, 'alipay'); await f.service.status();
    const file = path.join(f.directory, 'beta', 'purchase.json'), saved = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(saved.receipt.code, code); assert.equal(saved.receipt.licenseExpiresAt, expiresAt);
    assert.equal(saved.receipt.installationId, f.state.installationId);
    const offlineSettings = { ...f.settings, fetchImpl: async () => { throw new Error('synthetic offline'); } };
    const offline = createSoftwarePurchaseService(offlineSettings);
    const available = await offline.status();
    assert.equal(available.receiptOnly, true); assert.equal(available.order.orderNo, 'GT-SYNTHETIC-RECEIPT');
    assert.equal(available.activated, true); assert.equal(available.order.code, code);
    assert.equal(available.order.licenseExpiresAt, expiresAt); assert.equal(Object.hasOwn(available.order, 'token'), false);
    f.state.activated = false;
    const missingLicense = await createSoftwarePurchaseService(offlineSettings).status();
    assert.equal(missingLicense.activated, false, 'a PAID cache does not substitute for a signed certificate');
    assert.deepEqual(f.state.activations, [code], 'offline receipt viewing never attempts activation');
    if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
  });
});

test('unbound cached paid receipt remains visible offline without rebinding the old device', async t => {
  const id = randomUUID();
  const f = await fixture(t, async (url, options) => new URL(url).pathname.endsWith('/unbind') ? Response.json({ unbound: true })
    : Response.json({ id, status: options.method === 'POST' ? 'PENDING' : 'PAID', code, orderNo: 'GT-SYNTHETIC-UNBOUND', licenseExpiresAt: null }));
  await f.service.create('LIFETIME', 'wx'); await f.service.status(); await f.service.unbind();
  const offline = createSoftwarePurchaseService({ ...f.settings, fetchImpl: async () => { throw new Error('offline'); } });
  const result = await offline.status();
  assert.equal(result.unbound, true); assert.equal(result.activated, false); assert.equal(result.order.code, code);
  assert.deepEqual(f.state.activations, [code]);
});

test('invalid or oversized cached receipt codes cannot be returned as recovery information', async t => {
  for (const changed of [{ code: 'GTB1-' + 'A'.repeat(1000) }, { code: 'GTB1-VALID-LOOKING\nINJECTED-RECEIPT' }, { id: randomUUID() }]) await t.test(Object.keys(changed)[0], async t => {
    const id = randomUUID();
    const f = await fixture(t, async (_url, options) => Response.json({ id, status: options.method === 'POST' ? 'PENDING' : 'PAID', code, licenseExpiresAt: null }));
    await f.service.create('LIFETIME', 'alipay'); await f.service.status();
    const file = path.join(f.directory, 'beta', 'purchase.json'), saved = JSON.parse(await readFile(file, 'utf8'));
    Object.assign(saved.receipt, changed); await writeFile(file, JSON.stringify(saved));
    const restarted = createSoftwarePurchaseService({ ...f.settings, fetchImpl: async () => { throw new Error('offline'); } });
    await assert.rejects(restarted.status(), { code: 'PAYMENT_NETWORK_ERROR' });
    assert.deepEqual(f.state.activations, [code]);
  });
});

test('a paid response for another order cannot replace the current receipt or activate', async t => {
  const id = randomUUID();
  const f = await fixture(t, async (_url, options) => Response.json({ id: options.method === 'POST' ? id : randomUUID(),
    status: options.method === 'POST' ? 'PENDING' : 'PAID', code }));
  await f.service.create('YEAR', 'wx');
  await assert.rejects(f.service.status(), { code: 'INVALID_PAYMENT_RESPONSE' });
  assert.deepEqual(f.state.activations, []);
  const saved = JSON.parse(await readFile(path.join(f.directory, 'beta', 'purchase.json'), 'utf8'));
  assert.equal(saved.id, id); assert.equal(saved.receipt, undefined);
});

test('same-device receipt recovery reinstalls a verified signed license with its original annual expiry', async t => {
  const id = randomUUID(), keyId = 'synthetic-recovery', keys = generateKeyPairSync('ed25519');
  const directory = await mkdtemp(path.join(tmpdir(), 'growth-signed-recovery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const expiresAt = new Date(Date.now() + 86400000).toISOString();
  const config = { productId: BETA_PRODUCT_ID, serverUrl: 'https://synthetic-license.invalid', redemptionUrl: 'https://synthetic-license.invalid/points',
    publicKeys: { [keyId]: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() } };
  const installations = [];
  const licenseFetch = async (_url, options) => {
    const input = JSON.parse(options.body); assert.equal(input.code, code); installations.push(input.installationId);
    const payload = Buffer.from(JSON.stringify({ version: 1, productId: BETA_PRODUCT_ID, codeId: id, installationId: input.installationId,
      issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt }));
    return Response.json({ license: { version: 1, algorithm: 'Ed25519', keyId,
      payload: payload.toString('base64url'), signature: sign(null, payload, keys.privateKey).toString('base64url') } });
  };
  const betaService = createBetaActivationService({ config, dataDirectory: directory, fetchImpl: licenseFetch });
  const paymentFetch = async (_url, options) => Response.json({ id, status: options.method === 'POST' ? 'PENDING' : 'PAID',
    code, orderNo: 'GT-SIGNED-RECOVERY', licenseExpiresAt: expiresAt });
  const purchase = createSoftwarePurchaseService({ directory, betaService, fetchImpl: paymentFetch, serverUrl: config.serverUrl });
  await purchase.create('YEAR', 'alipay'); assert.equal((await purchase.status()).activated, true);
  const original = await betaService.status();
  await rm(path.join(directory, 'beta', 'license.json'));
  const recoveredService = createBetaActivationService({ config, dataDirectory: directory, fetchImpl: licenseFetch });
  const offline = createSoftwarePurchaseService({ directory, betaService: recoveredService, serverUrl: config.serverUrl, fetchImpl: async () => { throw new Error('offline'); } });
  const receipt = await offline.status(); assert.equal(receipt.activated, false); assert.equal(receipt.order.code, code);
  const recovered = await recoveredService.activate(receipt.order.code);
  assert.equal(recovered.activated, true); assert.equal(recovered.installationId, original.installationId);
  assert.equal(recovered.expiresAt, original.expiresAt); assert.deepEqual(installations, [original.installationId, original.installationId]);
  const restarted = createBetaActivationService({ config, dataDirectory: directory, fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal((await restarted.status()).activated, true); assert.equal((await restarted.status()).expiresAt, expiresAt);
});
