import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createExportUnlockController } from '../src/beta-access.js';

const turn = () => new Promise(resolve => setImmediate(resolve));
const response = value => Response.json(value);
const locked = { activated: false, configured: true, reason: 'ACTIVATION_REQUIRED' };
function fixture(request = async () => response(locked)) {
  const nodes = new Map(), doc = { body: { dataset: {} }, activeElement: null };
  const get = id => {
    if (nodes.has(id)) return nodes.get(id);
    const listeners = new Map(), classes = new Set();
    const node = {
      id, value: '', textContent: '', dataset: {}, attrs: {}, disabled: false, readOnly: false, open: false, isConnected: true,
      classList: { toggle(name, on) { if (on) classes.add(name); else classes.delete(name); }, contains: name => classes.has(name) },
      setAttribute(name, value) { this.attrs[name] = value; },
      addEventListener(name, listener) { const list = listeners.get(name) || []; list.push(listener); listeners.set(name, list); },
      async dispatch(name, values = {}) {
        const event = { type: name, target: this, prevented: false, preventDefault() { this.prevented = true; }, ...values };
        await Promise.all((listeners.get(name) || []).map(listener => listener(event)));
        return event;
      },
      focus() { doc.activeElement = this; },
      showModal() { this.open = true; },
      close() { this.open = false; void this.dispatch('close'); },
      querySelectorAll() { return ['beta-close', 'beta-code', 'beta-activate', 'beta-retry', 'beta-dismiss', 'beta-redeem'].map(get).filter(item => !item.disabled); }
    };
    nodes.set(id, node); return node;
  };
  doc.getElementById = get;
  doc.activeElement = get('original-action');
  let loads = 0;
  const controller = createExportUnlockController({ document: doc, request, loadApp() { loads++; } });
  return { controller, get, doc, get loads() { return loads; } };
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
  const f = fixture(async () => { calls++; return response(locked); });
  const first = f.controller.ensureExportUnlocked(), second = f.controller.ensureExportUnlocked();
  assert.equal(first, second); await turn();
  assert.equal(calls, 1); assert.equal(f.get('beta-gate').open, true);
  assert.equal(f.doc.activeElement, f.get('beta-code'));
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
  assert.match(html, /保存预览图片、视频和透明序列导出/);
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
