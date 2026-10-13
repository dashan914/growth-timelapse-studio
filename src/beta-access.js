// The workbench opens freely; explicit exports verify the local signed license.
export function createExportUnlockController({ document, request = globalThis.fetch, loadApp = () => import('./app.js') }) {
  const $ = id => document.getElementById(id);
  const dialog = $('beta-gate'), form = $('beta-form'), input = $('beta-code');
  const activate = $('beta-activate'), retry = $('beta-retry'), message = $('beta-message');
  const toolbar = $('export-unlock-button'), label = $('export-unlock-label');
  let workspacePromise, pending = null, busy = false, verified = false;
  let session = 0, statusRevision = 0, activeRequest = null, returnFocus = null;
  let paymentTimer = null, paymentBusy = false, paymentBackBusy = false, paymentChoosing = false;

  function feedback(text, { error = false, fieldError = false } = {}) {
    message.textContent = text;
    message.classList.toggle('error', error);
    input.setAttribute('aria-invalid', String(fieldError));
    retry.hidden = !error;
  }

  function setBusy(value, activating = false) {
    busy = value;
    activate.disabled = value || verified;
    retry.disabled = value;
    input.readOnly = value || verified;
    activate.textContent = value && activating ? '正在解锁…' : '解锁全部导出';
    retry.textContent = value && !activating ? '正在检查…' : '重新检查权限';
    form.setAttribute('aria-busy', String(value));
  }

  function updateToolbar(status) {
    verified = status?.activated === true;
    document.body.dataset.exportState = verified ? 'unlocked' : 'free';
    toolbar.dataset.exportState = verified ? 'unlocked' : 'locked';
    label.textContent = verified ? '导出已解锁' : '导出解锁';
    toolbar.title = verified ? '查看导出权限；每次导出前会重新验证。' : '免费可导出水印视频；兑换码解锁无水印图片与视频。';
    if (/^https?:\/\//i.test(status?.redemptionUrl || '')) $('beta-redeem').href = status.redemptionUrl;
  }

  async function requestJson(url, options = {}, abortController = new AbortController()) {
    const timeout = setTimeout(() => abortController.abort(), url.endsWith('/activate') ? 25000 : 10000);
    try {
      const response = await request(url, { ...options, signal: abortController.signal });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result?.error?.message || '权限服务连接失败，请重试或重新打开启动工具。');
      if (['/api/beta/status', '/api/beta/activate'].includes(url) && typeof result.activated !== 'boolean') throw new Error('权限服务返回了无效状态，请重新检查。');
      return result;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('权限检查未完成，请检查连接后重试。');
      throw error;
    } finally { clearTimeout(timeout); }
  }

  async function readStatus(abortController) {
    const revision = ++statusRevision;
    try {
      const result = await requestJson('/api/beta/status', { cache: 'no-store' }, abortController);
      if (revision === statusRevision) updateToolbar(result);
      return result;
    } catch (error) {
      if (revision === statusRevision) updateToolbar(null);
      throw error;
    }
  }

  function statusMessage(status) {
    if (status.activated === true) return '当前设备已解锁全部导出。首次解锁成功后，可在有效期内离线使用。';
    if (['BETA_EXPIRED', 'LICENSE_EXPIRED'].includes(status.reason)) return '导出权限已到期，请查看兑换记录或联系管理员。导入、编辑和预览仍可免费使用。';
    if (status.configured === false) return '兑换服务尚未配置，请稍后重试。你可以关闭窗口，继续免费导入、编辑和预览。';
    if (status.reason && status.reason !== 'ACTIVATION_REQUIRED') return status.message || '导出权限暂不可用，请查看兑换记录、重新检查，或联系管理员。';
    return '输入兑换码解锁无水印视频、图片和透明序列导出。首次解锁需联网，成功后有效期内可离线导出。';
  }

  function finish(allowed) {
    clearTimeout(paymentTimer); paymentTimer = null;
    session++;
    activeRequest?.abort(); activeRequest = null;
    const operation = pending; pending = null;
    const focus = returnFocus; returnFocus = null;
    if (dialog.open) dialog.close();
    input.value = '';
    setBusy(false);
    if (focus?.isConnected !== false) focus?.focus();
    operation?.resolve(allowed);
  }

  function showDialog(text, error = false) {
    if (!dialog.open) {
      returnFocus ||= document.activeElement;
      dialog.showModal();
      void refreshPayment().catch(() => {});
    }
    feedback(text, { error });
    if ($('beta-free-export')) $('beta-free-export').hidden = !pending?.allowWatermarked;
    if (!busy) (verified ? $('beta-close') : $('beta-code-entry')?.open === false ? $('beta-buy-year') : input).focus();
  }

  async function checkDialog() {
    if (busy) return;
    const current = session;
    activeRequest = new AbortController();
    setBusy(true); feedback('正在检查本机导出权限…');
    try {
      const result = await readStatus(activeRequest);
      if (current !== session) return;
      if (result.activated === true && pending) { finish(true); return; }
      feedback(statusMessage(result));
    } catch (error) {
      if (current === session) feedback(error.message || '权限检查失败，请重试。', { error: true });
    } finally {
      if (current === session) { activeRequest = null; setBusy(false); }
    }
  }

  // Browser state only labels the toolbar; every export reads fresh service status.
  function ensureExportUnlocked({ allowWatermarked = false } = {}) {
    if (pending) return pending.promise;
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    pending = { promise, resolve, allowWatermarked };
    const current = ++session;
    returnFocus = document.activeElement;
    activeRequest = new AbortController();
    setBusy(true);
    toolbar.setAttribute('aria-busy', 'true');
    label.textContent = '检查导出权限…';
    readStatus(activeRequest).then(result => {
      if (current !== session) return;
      if (result.activated === true) { finish(true); return; }
      setBusy(false); showDialog(statusMessage(result));
    }).catch(error => {
      if (current === session) { setBusy(false); showDialog(error.message || '权限检查失败，请重试。', true); }
    }).finally(() => {
      toolbar.setAttribute('aria-busy', 'false');
      if (current === session) { activeRequest = null; setBusy(false); }
    });
    return promise;
  }

  toolbar.addEventListener('click', () => {
    if (pending) { if (!dialog.open) showDialog('正在检查本机导出权限…'); return; }
    session++;
    showDialog('正在检查本机导出权限…');
    void checkDialog();
  });
  retry.addEventListener('click', () => { void checkDialog(); });
  $('beta-free-export')?.addEventListener('click', () => { if (pending?.allowWatermarked) finish('watermarked'); });
  function setPaymentBusy(value) {
    paymentBusy = value;
    for (const id of ['beta-buy-year', 'beta-buy-lifetime', 'beta-pay-method']) if ($(id)) $(id).disabled = value;
    if ($('beta-payment-back')) $('beta-payment-back').disabled = value || paymentBackBusy;
  }
  function showOrder(order) {
    const panel = $('beta-checkout');
    if (!panel || !order) return;
    const expired = order.status === 'EXPIRED' || order.status === 'PENDING' && Date.parse(order.expiresAt) <= Date.now();
    if (order.status === 'PAID' || expired || ['CLOSED', 'FAILED'].includes(order.status)) paymentChoosing = false;
    panel.hidden = paymentChoosing;
    if ($('beta-acquire-options')) $('beta-acquire-options').hidden = !paymentChoosing && (order.status === 'PENDING' && !expired || order.status === 'PAID' && (!order.licenseExpiresAt || Date.parse(order.licenseExpiresAt) > Date.now()));
    if ($('beta-payment-choice-note')) $('beta-payment-choice-note').hidden = !paymentChoosing;
    if ($('beta-payment-back')) $('beta-payment-back').hidden = paymentChoosing || order.status !== 'PENDING' || expired;
    $('beta-order-title').textContent = `${order.planName} · ¥${(order.amountCents / 100).toFixed(2)} · 订单 ${order.orderNo}`;
    const image = $('beta-order-qr');
    image.hidden = paymentChoosing || expired || order.status !== 'PENDING' || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(order.qrImage || '');
    if (!image.hidden) image.src = order.qrImage;
    $('beta-order-state').textContent = order.status === 'PAID' ? '支付成功，正在确认导出权限…' : ['CLOSED', 'FAILED'].includes(order.status) ? '订单已关闭或未完成付款，请重新选择授权方案。' : expired ? '支付二维码已超时。若已付款，请点击查询支付结果，勿重复付款。' : '请使用手机扫码付款。支付成功后会自动解锁。';
    $('beta-unbind').hidden = order.status !== 'PAID' || !verified;
    if ($('beta-paid-receipt')) $('beta-paid-receipt').hidden = order.status !== 'PAID' || !order.code;
    if (order.code && $('beta-paid-code')) $('beta-paid-code').value = order.code;
  }
  async function applyPaymentResult(result) {
    if (!dialog.open) return;
    if (!result.order) return;
    showOrder(result.order);
    if (result.unbound) $('beta-order-state').textContent = '已解除当前设备绑定。复制下方兑换码后，在新设备激活。';
    if (result.activated === true) {
      const fresh = await readStatus();
      if (!dialog.open || fresh.activated !== true) return;
      updateToolbar(fresh); setBusy(false);
      $('beta-unbind').hidden = Boolean(result.unbound);
      if (result.order) $('beta-order-state').textContent = '支付成功，当前设备已解锁无水印导出。';
      if (pending) { finish(true); return; }
      feedback(statusMessage(result));
    } else if (result.activationError) feedback('支付成功，但自动激活未完成：' + result.activationError, { error: true });
    schedulePaymentCheck(result.order);
  }
  function schedulePaymentCheck(order) {
    clearTimeout(paymentTimer); paymentTimer = null;
    if (dialog.open && order?.status === 'PENDING') paymentTimer = setTimeout(() => { void refreshPayment().catch(error => feedback(error.message, { error: true })); }, 5000);
  }
  async function refreshPayment() {
    clearTimeout(paymentTimer); paymentTimer = null;
    if (!dialog.open || !$('beta-checkout')) return;
    const result = await requestJson('/api/beta/payment/order', { cache: 'no-store' });
    await applyPaymentResult(result);
  }
  async function returnToPlans() {
    if (paymentBusy || paymentBackBusy) return;
    const current = session, button = $('beta-payment-back');
    paymentBackBusy = true;
    if (button) { button.disabled = true; button.textContent = '正在确认支付状态…'; }
    clearTimeout(paymentTimer); paymentTimer = null;
    try {
      const result = await requestJson('/api/beta/payment/order', { cache: 'no-store' });
      if (!dialog.open || current !== session) return;
      if (result.order?.status === 'PAID') { await applyPaymentResult(result); return; }
      paymentChoosing = true;
      if (result.order) { showOrder(result.order); schedulePaymentCheck(result.order); }
      else {
        $('beta-checkout').hidden = true; $('beta-order-qr').hidden = true;
        if ($('beta-acquire-options')) $('beta-acquire-options').hidden = false;
        if ($('beta-payment-choice-note')) $('beta-payment-choice-note').hidden = false;
      }
      feedback('可以重新选择授权方案和支付方式。旧二维码在有效期内仍可支付，请只支付新订单；旧订单未取消。');
      $('beta-buy-year')?.focus();
    } catch (error) {
      if (dialog.open && current === session) feedback(error.message, { error: true });
    } finally {
      paymentBackBusy = false;
      if (button) { button.disabled = paymentBusy; button.textContent = '返回选择套餐'; }
    }
  }
  async function buy(plan) {
    if (paymentBusy) return;
    const wasChoosing = paymentChoosing;
    paymentChoosing = false;
    if ($('beta-payment-choice-note')) $('beta-payment-choice-note').hidden = true;
    setPaymentBusy(true); feedback('正在创建支付订单…');
    try {
      const order = await requestJson('/api/beta/payment/order', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plan, payMethod: $('beta-pay-wx').checked ? 'wx' : 'alipay' }) });
      showOrder(order); feedback('订单已创建，请扫码付款。');
      void refreshPayment().catch(error => feedback(error.message, { error: true }));
    } catch (error) {
      paymentChoosing = wasChoosing;
      if ($('beta-payment-choice-note')) $('beta-payment-choice-note').hidden = !paymentChoosing;
      feedback(error.message, { error: true });
    }
    finally { setPaymentBusy(false); }
  }
  $('beta-buy-year')?.addEventListener('click', () => { void buy('YEAR'); });
  $('beta-buy-lifetime')?.addEventListener('click', () => { void buy('LIFETIME'); });
  $('beta-payment-refresh')?.addEventListener('click', () => { void refreshPayment().catch(error => feedback(error.message, { error: true })); });
  $('beta-payment-back')?.addEventListener('click', returnToPlans);
  $('beta-copy-code')?.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('beta-paid-code').value); feedback('兑换码已复制，请保留购买记录；换机前先解除旧设备绑定。'); }
    catch { $('beta-paid-code').select(); feedback('请手动复制已选中的兑换码。'); }
  });
  $('beta-unbind')?.addEventListener('click', async () => {
    if (!globalThis.confirm('解除绑定后，本机将恢复免费水印导出。确认要换机并解除当前设备绑定？')) return;
    try {
      const result = await requestJson('/api/beta/payment/unbind', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      updateToolbar(result); $('beta-unbind').hidden = true;
      feedback('当前设备已解除绑定。请保留购买记录和兑换码，在新设备激活。');
    } catch (error) { feedback(error.message, { error: true }); }
  });
  $('beta-close').addEventListener('click', () => finish(false));
  $('beta-dismiss').addEventListener('click', () => finish(false));
  dialog.addEventListener('cancel', event => { event.preventDefault(); finish(false); });
  dialog.addEventListener('close', () => { if (pending || returnFocus) finish(false); });
  // Native dialog contains keyboard focus; wrap at its visible endpoints too.
  dialog.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return;
    const controls = [...dialog.querySelectorAll('button:not(:disabled),input:not(:disabled),a[href]')];
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  });
  input.addEventListener('input', () => { input.setAttribute('aria-invalid', 'false'); });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || verified) return;
    if ($('beta-code-entry')) $('beta-code-entry').open = true;
    if (!input.value.trim()) { feedback('请先粘贴兑换码。', { error: true, fieldError: true }); input.focus(); return; }
    const current = session;
    activeRequest = new AbortController();
    setBusy(true, true); feedback('正在验证兑换码…');
    try {
      const result = await requestJson('/api/beta/activate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: input.value.trim() })
      }, activeRequest);
      if (current !== session) return;
      if (result.activated !== true) throw new Error('兑换码未通过验证，请检查后重试。');
      const status = await readStatus(activeRequest);
      if (current !== session) return;
      if (status.activated !== true) throw new Error(statusMessage(status));
      input.value = '';
      if (pending) finish(true);
      else feedback(statusMessage(status));
    } catch (error) {
      if (current === session) { feedback(error.message || '解锁未完成，请重试。', { error: true }); input.focus(); }
    } finally {
      if (current === session) { activeRequest = null; setBusy(false); }
    }
  });

  function start() {
    if (!workspacePromise) {
      document.body.dataset.betaState = 'ready';
      workspacePromise = Promise.resolve().then(loadApp);
      // An unavailable permission service cannot delay the free workbench.
      void readStatus().catch(() => {});
    }
    return workspacePromise;
  }
  return { start, ensureExportUnlocked };
}

const controller = typeof document !== 'undefined' ? createExportUnlockController({ document }) : null;
export function ensureExportUnlocked(options) { return controller ? controller.ensureExportUnlocked(options) : Promise.resolve(false); }
if (controller) controller.start().catch(error => {
  const status = document.getElementById('status-line');
  if (status) status.textContent = `工作台启动失败：${error.message}。请重新打开启动工具。`;
});
