// The workbench opens freely; explicit exports verify the local signed license.
export function createExportUnlockController({ document, request = globalThis.fetch, loadApp = () => import('./app.js') }) {
  const $ = id => document.getElementById(id);
  const dialog = $('beta-gate'), form = $('beta-form'), input = $('beta-code');
  const activate = $('beta-activate'), retry = $('beta-retry'), message = $('beta-message');
  const toolbar = $('export-unlock-button'), label = $('export-unlock-label');
  let workspacePromise, pending = null, busy = false, verified = false;
  let session = 0, statusRevision = 0, activeRequest = null, returnFocus = null;

  function feedback(text, { error = false, fieldError = false } = {}) {
    message.textContent = text;
    message.classList.toggle('error', error);
    input.setAttribute('aria-invalid', String(fieldError));
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
    toolbar.dataset.exportState = verified ? 'unlocked' : 'locked';
    label.textContent = verified ? '导出已解锁' : '导出解锁';
    toolbar.title = verified ? '查看导出权限；每次导出前会重新验证。' : '导入、编辑和预览免费；兑换码解锁全部导出。';
    if (/^https?:\/\//i.test(status?.redemptionUrl || '')) $('beta-redeem').href = status.redemptionUrl;
  }

  async function requestJson(url, options = {}, abortController = new AbortController()) {
    const timeout = setTimeout(() => abortController.abort(), url.endsWith('/activate') ? 25000 : 10000);
    try {
      const response = await request(url, { ...options, signal: abortController.signal });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result?.error?.message || '权限服务连接失败，请重试或重新打开启动工具。');
      if (typeof result.activated !== 'boolean') throw new Error('权限服务返回了无效状态，请重新检查。');
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
    return '输入兑换码解锁图片、视频和透明序列导出。首次解锁需联网，成功后有效期内可离线导出。';
  }

  function finish(allowed) {
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
    }
    feedback(text, { error });
    if (!busy) (verified ? $('beta-close') : input).focus();
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
  function ensureExportUnlocked() {
    if (pending) return pending.promise;
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    pending = { promise, resolve };
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
export function ensureExportUnlocked() { return controller ? controller.ensureExportUnlocked() : Promise.resolve(false); }
if (controller) controller.start().catch(error => {
  const status = document.getElementById('status-line');
  if (status) status.textContent = `工作台启动失败：${error.message}。请重新打开启动工具。`;
});
