import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createExportUnlockController } from '../src/beta-access.js';
import { parseHTML } from '../vendor/test-dom/worker.mjs';

const turn = () => new Promise(resolve => setImmediate(resolve));
const response = value => Response.json(value);
const locked = { activated: false, configured: true, reason: 'ACTIVATION_REQUIRED' };
function fixture(request = async () => response(locked), options = {}) {
  const nodes = new Map(), doc = { body: { dataset: {} }, activeElement: null };
  const get = id => {
    if (nodes.has(id)) return nodes.get(id);
    const listeners = new Map(), classes = new Set();
    const node = {
      id, value: '', textContent: '', dataset: {}, attrs: {}, disabled: false, hidden: false, checked: false, readOnly: false, open: false, isConnected: true,
      classList: { toggle(name, on) { if (on) classes.add(name); else classes.delete(name); }, contains: name => classes.has(name) },
      setAttribute(name, value) { this.attrs[name] = value; },
      addEventListener(name, listener) { const list = listeners.get(name) || []; list.push(listener); listeners.set(name, list); },
      async dispatch(name, values = {}) {
        const event = { type: name, target: this, prevented: false, preventDefault() { this.prevented = true; }, ...values };
        await Promise.all((listeners.get(name) || []).map(listener => listener(event)));
        return event;
      },
      focus() { doc.activeElement = this; },
      select() { this.selected = true; },
      showModal() { this.open = true; },
      close() { this.open = false; void this.dispatch('close'); },
      querySelectorAll() { return ['beta-close', 'beta-code', 'beta-activate', 'beta-retry', 'beta-dismiss', 'beta-redeem'].map(get).filter(item => !item.disabled); }
    };
    nodes.set(id, node); return node;
  };
  doc.getElementById = get;
  doc.activeElement = get('original-action');
  let loads = 0;
  const controller = createExportUnlockController({ document: doc, request, loadApp() { loads++; }, ...options });
  return { controller, get, doc, get loads() { return loads; } };
}

function pendingPayment(extra = {}) {
  return { id: '00000000-0000-4000-8000-000000000001', plan: 'YEAR', planName: '一年授权', amountCents: 1990,
    orderNo: 'synthetic-year-order', status: 'PENDING', expiresAt: new Date(Date.now() + 60_000).toISOString(),
    licenseExpiresAt: null, qrImage: 'data:image/png;base64,aW1hZ2U=', ...extra };
}
function purchaseFixture(t, options) {
  const state = { order: pendingPayment(), activated: false, lookup: null }, calls = [];
  const f = fixture(async (url, options = {}) => {
    const method = options.method || 'GET'; calls.push({ url, method, ...(options.body ? { body: JSON.parse(options.body) } : {}) });
    if (url === '/api/beta/status') return response({ ...locked, activated: state.activated });
    assert.equal(url, '/api/beta/payment/order');
    if (method === 'POST') {
      const body = JSON.parse(options.body);
      state.order = pendingPayment({ id: '00000000-0000-4000-8000-000000000002', plan: body.plan,
        planName: body.plan === 'LIFETIME' ? '永久授权' : '一年授权', amountCents: body.plan === 'LIFETIME' ? 3990 : 1990,
        orderNo: 'synthetic-new-order', payMethod: body.payMethod });
      return response(state.order);
    }
    if (state.lookup) return state.lookup();
    return response({ ...locked, order: state.order, activated: state.activated });
  }, options);
  t.after(async () => { if (f.get('beta-gate').open) await f.get('beta-close').dispatch('click'); });
  return { ...f, state, calls };
}

test('the free workbench starts exactly once even when the permission service is unavailable', async () => {
  const f = fixture(async () => { throw new Error('offline'); });
  const first = f.controller.start(), second = f.controller.start();
  assert.equal(first, second);
  await first; await turn();
  assert.equal(f.loads, 1); assert.equal(f.doc.body.dataset.betaState, 'ready');
  assert.equal(f.get('beta-gate').open, false);
  assert.equal(f.get('export-unlock-label').textContent, '导出解锁');
});

test('an informational startup status cannot delay loading the free app', async () => {
  let finishStatus;
  const f = fixture(() => new Promise(resolve => { finishStatus = resolve; }));
  await f.controller.start();
  assert.equal(f.loads, 1); assert.equal(f.get('beta-gate').open, false);
  finishStatus(response(locked)); await turn();
});

test('each export checks fresh local status and accepts verified offline permission without a modal', async () => {
  const calls = [];
  const f = fixture(async (url, options) => { calls.push({ url, options }); return response({ activated: true, configured: true }); });
  assert.equal(await f.controller.ensureExportUnlocked(), true);
  assert.equal(await f.controller.ensureExportUnlocked(), true);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.url === '/api/beta/status' && call.options.cache === 'no-store'));
  assert.equal(f.get('beta-gate').open, false);
  assert.equal(f.get('export-unlock-button').dataset.exportState, 'unlocked');
});

test('repeated clicks share one pending permission check; closing cancels and restores focus', async () => {
  let calls = 0;
  const f = fixture(async url => { if (url === "/api/beta/status") calls++; return response(url === "/api/beta/payment/order" ? { order: null, ...locked } : locked); });
  const first = f.controller.ensureExportUnlocked(), second = f.controller.ensureExportUnlocked();
  assert.equal(first, second); await turn();
  assert.equal(calls, 1); assert.equal(f.get('beta-gate').open, true);
  assert.equal(f.doc.activeElement, f.get('beta-buy-year'));
  await f.get('beta-dismiss').dispatch('click');
  assert.equal(await first, false); assert.equal(await second, false);
  assert.equal(f.get('beta-gate').open, false);
  assert.equal(f.doc.activeElement, f.get('original-action'));
});

test('a failed or malformed status never grants permission and a successful retry can continue', async () => {
  for (const failed of [
    () => { throw new Error('local service unavailable'); },
    () => Response.json({ activated: true }, { status: 503 }),
    () => response({ activated: 'true' })
  ]) {
    let recovered = false;
    const f = fixture(async () => recovered ? response({ activated: true }) : failed());
    const operation = f.controller.ensureExportUnlocked(); await turn();
    assert.equal(f.get('beta-gate').open, true);
    assert.equal(f.get('beta-message').classList.contains('error'), true);
    assert.equal(f.get('export-unlock-button').dataset.exportState, 'locked');
    recovered = true;
    await f.get('beta-retry').dispatch('click'); await turn();
    assert.equal(await operation, true); assert.equal(f.get('beta-gate').open, false);
  }
});

test('expiration is checked again after a prior successful export', async () => {
  for (const reason of ['BETA_EXPIRED', 'LICENSE_EXPIRED']) {
    let valid = true;
    const f = fixture(async () => response(valid ? { activated: true } : { ...locked, reason }));
    assert.equal(await f.controller.ensureExportUnlocked(), true);
    valid = false;
    const next = f.controller.ensureExportUnlocked(); await turn();
    assert.match(f.get('beta-message').textContent, /已到期/);
    assert.match(f.get('beta-message').textContent, /查看兑换记录或联系管理员/);
    assert.doesNotMatch(f.get('beta-message').textContent, /新码|重新领取/);
    assert.equal(f.get('export-unlock-button').dataset.exportState, 'locked');
    await f.get('beta-close').dispatch('click'); assert.equal(await next, false);
  }
});

test('verified local credentials explain offline use within the valid period without offering a new code', async () => {
  const f = fixture(async () => response({ activated: true, expiresAt: '2030-01-01T00:00:00Z' }));
  await f.get('export-unlock-button').dispatch('click'); await turn();
  assert.equal(f.get('beta-gate').open, true);
  assert.match(f.get('beta-message').textContent, /当前设备已解锁全部导出/);
  assert.match(f.get('beta-message').textContent, /首次解锁成功后.*有效期内离线使用/);
  assert.doesNotMatch(f.get('beta-message').textContent, /新码|重新领取/);
  await f.get('beta-close').dispatch('click');
});

test('activation failure retains the code; verified activation continues the pending export', async () => {
  const calls = []; let valid = false, activateCalls = 0;
  const f = fixture(async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/activate')) {
      activateCalls++;
      if (activateCalls === 1) return Response.json({ error: { message: '兑换码有误，请重试。' } }, { status: 400 });
      valid = true; return response({ activated: true });
    }
    return response(valid ? { activated: true } : locked);
  });
  const pending = f.controller.ensureExportUnlocked(); await turn();
  await f.get('beta-form').dispatch('submit');
  assert.equal(f.get('beta-code').attrs['aria-invalid'], 'true');
  f.get('beta-code').value = 'GTB1-CODE';
  await f.get('beta-form').dispatch('submit');
  assert.equal(f.get('beta-gate').open, true);
  assert.equal(f.get('beta-code').value, 'GTB1-CODE');
  assert.equal(f.get('beta-activate').disabled, false);
  assert.match(f.get('beta-message').textContent, /兑换码有误/);
  await f.get('beta-form').dispatch('submit');
  assert.equal(await pending, true); assert.equal(f.get('beta-gate').open, false);
  assert.equal(f.get('beta-code').value, '');
  assert.equal(calls.at(-1).url, '/api/beta/status', 'activation must be followed by a fresh status check');
  assert.deepEqual(JSON.parse(calls.find(call => call.url.endsWith('/activate')).options.body), { code: 'GTB1-CODE' });
});

test('an activation response alone does not grant export if the follow-up status is expired or unavailable', async () => {
  for (const followup of [() => response({ ...locked, reason: 'BETA_EXPIRED' }), () => { throw new Error('service stopped'); }]) {
    let activationRequested = false;
    const f = fixture(async url => {
      if (url.endsWith('/activate')) { activationRequested = true; return response({ activated: true }); }
      return activationRequested ? followup() : response(locked);
    });
    const pending = f.controller.ensureExportUnlocked(); await turn();
    f.get('beta-code').value = 'GTB1-CODE'; await f.get('beta-form').dispatch('submit');
    assert.equal(f.get('beta-gate').open, true);
    assert.equal(f.get('beta-message').classList.contains('error'), true);
    await f.get('beta-close').dispatch('click'); assert.equal(await pending, false);
  }
});

test('Escape during activation cancels the operation and a late response cannot resume it', async () => {
  let finishActivation, activationSignal;
  const f = fixture(async (url, options) => {
    if (url.endsWith('/activate')) {
      activationSignal = options.signal;
      return new Promise(resolve => { finishActivation = resolve; });
    }
    return response(locked);
  });
  const pending = f.controller.ensureExportUnlocked(); await turn();
  f.get('beta-code').value = 'GTB1-CODE';
  const submitted = f.get('beta-form').dispatch('submit'); await turn();
  const event = await f.get('beta-gate').dispatch('cancel');
  assert.equal(event.prevented, true); assert.equal(await pending, false); assert.equal(activationSignal.aborted, true);
  finishActivation(response({ activated: true })); await submitted;
  assert.equal(f.get('beta-gate').open, false);
  assert.equal(f.doc.activeElement, f.get('original-action'));
});

test('the modal provides keyboard focus wrapping and remains closable after a service failure', async () => {
  const f = fixture(async () => { throw new Error('offline'); });
  const pending = f.controller.ensureExportUnlocked(); await turn();
  f.get('beta-close').focus();
  const backward = await f.get('beta-gate').dispatch('keydown', { key: 'Tab', shiftKey: true });
  assert.equal(backward.prevented, true); assert.equal(f.doc.activeElement, f.get('beta-redeem'));
  const forward = await f.get('beta-gate').dispatch('keydown', { key: 'Tab', shiftKey: false });
  assert.equal(forward.prevented, true); assert.equal(f.doc.activeElement, f.get('beta-close'));
  await f.get('beta-close').dispatch('click'); assert.equal(await pending, false);
});

test('markup keeps the initial workbench visible and the native dialog shares its dark theme', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const css = await readFile(new URL('../src/beta-access.css', import.meta.url), 'utf8');
  assert.match(html, /<dialog class="beta-gate"/);
  assert.doesNotMatch(html, /<dialog class="beta-gate"[^>]*\sopen(?:\s|>)/);
  assert.match(html, /导入、编辑和预览免费/);
  assert.match(html, /兑换码解锁无水印视频、预览图片和透明序列/);
  assert.match(html, /aria-label="关闭导出解锁窗口"/);
  assert.doesNotMatch(html, /内测码|激活并打开/);
  assert.doesNotMatch(css, /body:not\(\[data-beta-state/);
  assert.match(css, /focus-visible/);
  assert.match(css, /background: var\(--panel\)/);
  assert.match(css, /color: var\(--text\)/);
  assert.match(css, /outline: 2px solid var\(--accent\)/);
  assert.doesNotMatch(html, /beta-brand|山地造物 · 软件工具|shandi-logo/);
  assert.doesNotMatch(css, /--unlock-green|#fff|#0b7c6b/);
});

test('the actual student entry remains visible when purchase choices collapse, and background inputs retain all presets and media types', async () => {
  const { document } = parseHTML(await readFile(new URL('../index.html', import.meta.url), 'utf8'));
  const options = document.getElementById('beta-acquire-options'), student = document.getElementById('beta-student');
  options.hidden = true;
  assert.equal(options.contains(student), false);
  assert.equal(student.closest('[hidden]'), null, 'collapsing the order choices cannot hide student redemption');
  assert.equal(student.getAttribute('href'), 'https://ai3dclass.cn/points');
  assert.equal(document.querySelectorAll('.scene-preset[data-preset]').length, 6);
  const accepts = document.getElementById('background-input').getAttribute('accept');
  assert.match(accepts, /image\/png/); assert.match(accepts, /video\/mp4/); assert.match(accepts, /video\/quicktime/);
});

test('returning from a pending QR verifies the order, keeps choices visible through polling and allows a permanent WeChat order', async t => {
  const f = purchaseFixture(t);
  await f.get('export-unlock-button').dispatch('click'); await turn();
  assert.equal(f.get('beta-acquire-options').hidden, true);
  assert.equal(f.get('beta-order-qr').hidden, false);
  assert.equal(f.get('beta-payment-back').hidden, false);
  let completeLookup;
  f.state.lookup = () => new Promise(resolve => { completeLookup = resolve; });
  const returning = f.get('beta-payment-back').dispatch('click'); await turn();
  assert.equal(f.get('beta-payment-back').disabled, true);
  assert.equal(f.get('beta-acquire-options').hidden, true, 'choices wait for an authoritative payment lookup');
  completeLookup(response({ ...locked, order: f.state.order })); await returning;
  f.state.lookup = null;
  assert.equal(f.calls.filter(call => call.url === '/api/beta/payment/order' && call.method === 'POST').length, 0);
  assert.equal(f.get('beta-acquire-options').hidden, false);
  assert.equal(f.get('beta-order-qr').hidden, true);
  assert.equal(f.get('beta-checkout').hidden, true);
  assert.equal(f.get('beta-payment-choice-note').hidden, false);
  assert.match(f.get('beta-message').textContent, /旧订单未取消/);
  assert.equal(f.doc.activeElement, f.get('beta-buy-year'));
  await f.get('beta-payment-refresh').dispatch('click'); await turn();
  assert.equal(f.get('beta-acquire-options').hidden, false, 'a pending-order poll does not force the QR page back');
  assert.equal(f.get('beta-order-qr').hidden, true);
  f.get('beta-pay-wx').checked = true;
  await f.get('beta-buy-lifetime').dispatch('click'); await turn();
  const orders = f.calls.filter(call => call.method === 'POST');
  assert.deepEqual(orders.map(call => call.body), [{ plan: 'LIFETIME', payMethod: 'wx' }]);
  assert.equal(f.get('beta-acquire-options').hidden, true);
  assert.equal(f.get('beta-checkout').hidden, false);
  assert.equal(f.get('beta-order-qr').hidden, false);
  assert.equal(f.get('beta-payment-choice-note').hidden, true);
  assert.match(f.get('beta-order-title').textContent, /永久授权.*39\.90/);
});

test('return-to-plans continues a newly paid order instead of offering another purchase', async t => {
  const f = purchaseFixture(t);
  await f.get('export-unlock-button').dispatch('click'); await turn();
  f.state.order = { ...f.state.order, status: 'PAID', code: 'GTB1-SYNTHETIC-CODE-ABCDE-FGHJK' };
  f.state.activated = true;
  await f.get('beta-payment-back').dispatch('click');
  assert.equal(f.get('beta-acquire-options').hidden, true);
  assert.equal(f.get('beta-payment-back').hidden, true);
  assert.equal(f.get('beta-order-qr').hidden, true);
  assert.equal(f.get('beta-paid-code').value, 'GTB1-SYNTHETIC-CODE-ABCDE-FGHJK');
  assert.equal(f.get('export-unlock-button').dataset.exportState, 'unlocked');
  assert.match(f.get('beta-order-state').textContent, /当前设备已解锁/);
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 0);
});

test('a paid result received while choosing a replacement still completes the original order', async t => {
  const f = purchaseFixture(t);
  await f.get('export-unlock-button').dispatch('click'); await turn();
  await f.get('beta-payment-back').dispatch('click');
  f.state.order = { ...f.state.order, status: 'PAID', code: 'GTB1-ORIGINAL-PAID-CODE-ABCDE' };
  f.state.activated = true;
  await f.get('beta-payment-refresh').dispatch('click'); await turn();
  assert.equal(f.get('beta-acquire-options').hidden, true);
  assert.equal(f.get('beta-checkout').hidden, false);
  assert.equal(f.get('beta-payment-choice-note').hidden, true);
  assert.equal(f.get('beta-paid-code').value, 'GTB1-ORIGINAL-PAID-CODE-ABCDE');
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 0);
});

test('closed, failed and expired orders offer both plans without retaining a payable QR', async t => {
  for (const status of ['CLOSED', 'FAILED', 'EXPIRED', 'expired-pending']) await t.test(status, async t => {
    const f = purchaseFixture(t);
    f.state.order = { ...f.state.order, status: status === 'expired-pending' ? 'PENDING' : status,
      expiresAt: new Date(Date.now() - 1000).toISOString() };
    await f.get('export-unlock-button').dispatch('click'); await turn();
    assert.equal(f.get('beta-acquire-options').hidden, false);
    assert.equal(f.get('beta-order-qr').hidden, true);
    assert.equal(f.get('beta-payment-back').hidden, true);
    assert.equal(f.get('beta-buy-year').disabled, false); assert.equal(f.get('beta-buy-lifetime').disabled, false);
    assert.equal(f.get('export-unlock-button').dataset.exportState, 'locked');
  });
});

test('failed payment verification keeps the QR page and never creates or cancels an order', async t => {
  const f = purchaseFixture(t);
  await f.get('export-unlock-button').dispatch('click'); await turn();
  f.state.lookup = () => { throw new Error('synthetic verification unavailable'); };
  await f.get('beta-payment-back').dispatch('click');
  assert.equal(f.get('beta-acquire-options').hidden, true);
  assert.equal(f.get('beta-order-qr').hidden, false);
  assert.equal(f.get('beta-payment-back').disabled, false);
  assert.equal(f.get('beta-message').classList.contains('error'), true);
  assert.equal(f.calls.filter(call => call.method !== 'GET').length, 0);
});

test('paid recovery receipt can be copied and saved locally without payment tokens', async t => {
  const copied = [], downloaded = [];
  const f = purchaseFixture(t, { clipboard: { writeText: async value => copied.push(value) }, saveReceipt: async value => downloaded.push(value) });
  const code = 'GTB1-SYNTHETIC-RECOVERY-ABCDE';
  const installationId = '00000000-0000-4000-8000-000000000003', expiresAt = '2030-01-01T00:00:00.000Z';
  f.state.order = pendingPayment({ status: 'PAID', code, installationId, licenseExpiresAt: expiresAt, token: 'synthetic-private-order-token' });
  f.state.activated = true;
  await f.get('export-unlock-button').dispatch('click'); await turn();
  assert.equal(f.get('beta-paid-receipt').hidden, false);
  assert.equal(f.get('beta-paid-order').value, f.state.order.orderNo);
  assert.equal(f.get('beta-paid-device').value, installationId);
  f.get('beta-paid-code').value = 'tampered-field-must-not-be-copied';
  await f.get('beta-copy-code').dispatch('click');
  assert.deepEqual(copied, [code], 'copy uses validated receipt state rather than a mutable form field');
  assert.match(f.get('beta-message').textContent, /授权恢复码已复制/);
  await f.get('beta-save-receipt').dispatch('click');
  assert.equal(downloaded.length, 1); assert.match(downloaded[0].filename, /^打印延时-购买凭据-synthetic-year-order\.txt$/);
  assert.match(downloaded[0].text, /订单号：synthetic-year-order/);
  assert.ok(downloaded[0].text.includes(installationId)); assert.ok(downloaded[0].text.includes(code)); assert.ok(downloaded[0].text.includes(expiresAt));
  assert.match(downloaded[0].text, /联网恢复/); assert.match(downloaded[0].text, /不能单独解锁/);
  assert.doesNotMatch(downloaded[0].text, /synthetic-private-order-token|Bearer|tampered-field/);
});

test('cached PAID receipt is visible offline but cannot satisfy a pending export', async t => {
  const f = purchaseFixture(t);
  f.state.order = pendingPayment({ status: 'PAID', code: 'GTB1-SYNTHETIC-OFFLINE-ABCDE' });
  f.state.lookup = () => response({ ...locked, order: f.state.order, receiptOnly: true, paymentError: 'synthetic offline' });
  let completed = false;
  const operation = f.controller.ensureExportUnlocked().then(value => { completed = true; return value; });
  await turn();
  assert.equal(f.get('beta-paid-receipt').hidden, false); assert.equal(f.get('beta-order-qr').hidden, true);
  assert.equal(f.get('beta-gate').open, true); assert.equal(f.get('export-unlock-button').dataset.exportState, 'locked');
  assert.equal(completed, false); assert.match(f.get('beta-order-state').textContent, /本机保存的购买凭据/);
  await f.get('beta-close').dispatch('click'); assert.equal(await operation, false);
});

test('successful pending purchase continues export and reopening unlocked button exposes its recovery receipt', async t => {
  const f = purchaseFixture(t);
  const operation = f.controller.ensureExportUnlocked(); await turn();
  f.state.order = pendingPayment({ status: 'PAID', code: 'GTB1-SYNTHETIC-REOPEN-ABCDE' }); f.state.activated = true;
  await f.get('beta-payment-refresh').dispatch('click');
  assert.equal(await operation, true); assert.equal(f.get('beta-gate').open, false);
  assert.match(f.get('export-unlock-button').title, /授权恢复码与购买凭据/);
  await f.get('export-unlock-button').dispatch('click'); await turn();
  assert.equal(f.get('beta-paid-receipt').hidden, false);
  assert.equal(f.get('beta-paid-code').value, 'GTB1-SYNTHETIC-REOPEN-ABCDE');
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 0);
});

test('invalid paid codes cannot be copied or downloaded and receipt filenames cannot inject paths', async t => {
  const copied = [], downloaded = [];
  const f = purchaseFixture(t, { clipboard: { writeText: async value => copied.push(value) }, saveReceipt: async value => downloaded.push(value) });
  f.state.order = pendingPayment({ status: 'PAID', code: 'GTB1-SYNTHETIC\nINJECTED-ABCDE' });
  await f.get('export-unlock-button').dispatch('click'); await turn();
  assert.equal(f.get('beta-paid-receipt').hidden, true);
  await f.get('beta-copy-code').dispatch('click'); await f.get('beta-save-receipt').dispatch('click');
  assert.equal(copied.length, 0); assert.equal(downloaded.length, 0);
  f.state.order = pendingPayment({ status: 'PAID', code: 'GTB1-SYNTHETIC-SAFE-CODE-ABCDE', orderNo: '../../spoofed\nreceipt', licenseExpiresAt: null });
  await f.get('beta-payment-refresh').dispatch('click'); await turn();
  await f.get('beta-save-receipt').dispatch('click');
  assert.equal(downloaded.length, 1);
  assert.equal(downloaded[0].filename, `打印延时-购买凭据-${f.state.order.id}.txt`);
  assert.doesNotMatch(downloaded[0].text, /spoofed|授权到期：永久/);
  assert.match(downloaded[0].text, /授权到期：以授权状态为准/, 'a YEAR receipt with missing expiry must not claim permanent access');
});

test('clipboard and receipt download failures preserve a selectable recovery code and show feedback', async t => {
  const f = purchaseFixture(t, { clipboard: { writeText: async () => { throw new Error('clipboard unavailable'); } }, saveReceipt: async () => { throw new Error('download unavailable'); } });
  f.state.order = pendingPayment({ status: 'PAID', code: 'GTB1-SYNTHETIC-FALLBACK-ABCDE' });
  await f.get('export-unlock-button').dispatch('click'); await turn();
  await f.get('beta-copy-code').dispatch('click');
  assert.equal(f.get('beta-paid-code').selected, true); assert.match(f.get('beta-message').textContent, /手动复制/);
  await f.get('beta-save-receipt').dispatch('click');
  assert.match(f.get('beta-message').textContent, /未能下载/); assert.equal(f.get('beta-message').classList.contains('error'), true);
  assert.equal(f.get('beta-paid-code').value, 'GTB1-SYNTHETIC-FALLBACK-ABCDE');
});

test('actual markup labels recovery receipt controls and leaves the original code activation entry available', async () => {
  const { document } = parseHTML(await readFile(new URL('../index.html', import.meta.url), 'utf8'));
  for (const id of ['beta-paid-order', 'beta-paid-device', 'beta-paid-code']) {
    assert.ok(document.querySelector(`label[for="${id}"]`));
    assert.ok(document.getElementById(id).hasAttribute('readonly'));
  }
  assert.equal(document.getElementById('beta-save-receipt').getAttribute('type'), 'button');
  assert.match(document.getElementById('beta-code-entry').textContent, /已有兑换码 \/ 授权恢复码/);
  assert.equal(document.getElementById('beta-code').getAttribute('maxlength'), '80');
});

test('receipt lookup waits beyond the payment backend timeout before showing its offline cached response', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let paymentSignal;
  const f = fixture(async (url, options) => {
    if (url === '/api/beta/status') return response(locked);
    paymentSignal = options.signal;
    return new Promise(resolve => setTimeout(() => resolve(response({ ...locked, receiptOnly: true,
      order: pendingPayment({ status: 'PAID', code: 'GTB1-SYNTHETIC-SLOW-CACHE-ABCDE' }) })), 15001));
  });
  await f.get('export-unlock-button').dispatch('click'); await turn();
  t.mock.timers.tick(10001); await turn();
  assert.equal(paymentSignal.aborted, false, 'the earlier 10 s timeout would discard the backend cache fallback');
  t.mock.timers.tick(5000); await turn();
  assert.equal(paymentSignal.aborted, false); assert.equal(f.get('beta-paid-receipt').hidden, false);
  assert.match(f.get('beta-order-state').textContent, /本机保存的购买凭据/);
  await f.get('beta-close').dispatch('click');
});
