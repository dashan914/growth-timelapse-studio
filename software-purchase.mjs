import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { APP_VERSION, BetaActivationError, growthDataDirectory } from './beta-activation.mjs';

const config = JSON.parse(readFileSync(process.env.GROWTH_BETA_CONFIG || new URL('./beta-config.json', import.meta.url), 'utf8'));
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const recoveryCode = /^GTB1-[A-Z0-9-]{20,64}$/;
const planNames = { YEAR: '一年授权', LIFETIME: '永久授权' };
// A receipt is display/recovery information, never proof of export permission.
function paidReceipt(order, { id, plan, installationId } = {}) {
  if (!order || order.status !== 'PAID' || !uuid.test(order.id || '') || order.id !== id
      || typeof order.code !== 'string' || !recoveryCode.test(order.code)
      || !Object.hasOwn(planNames, plan)) return null;
  const receipt = { id, status: 'PAID', code: order.code, plan, planName: planNames[plan],
    orderNo: typeof order.orderNo === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(order.orderNo) ? order.orderNo : id,
    installationId: uuid.test(order.installationId || '') ? order.installationId : uuid.test(installationId || '') ? installationId : null,
    licenseExpiresAt: order.licenseExpiresAt === null ? null
      : typeof order.licenseExpiresAt === 'string' && order.licenseExpiresAt.length <= 40 && Number.isFinite(Date.parse(order.licenseExpiresAt)) ? order.licenseExpiresAt : null };
  if (Number.isSafeInteger(order.amountCents) && order.amountCents >= 0 && order.amountCents <= 100_000_000) receipt.amountCents = order.amountCents;
  return receipt;
}
export function createSoftwarePurchaseService({ betaService, directory = growthDataDirectory(), fetchImpl = fetch, serverUrl = config.serverUrl } = {}) {
  const origin = new URL(serverUrl);
  if (origin.username || origin.password || origin.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(origin.hostname)) throw new Error('Invalid payment server');
  const file = path.join(directory, 'beta', 'purchase.json');
  let current, loaded = false, busy = false;
  async function initialize() {
    if (!loaded) {
      try {
        const text = await readFile(file, 'utf8');
        if (text.length > 64 * 1024) throw new Error('Purchase record too large');
        current = JSON.parse(text);
        if (current?.receipt) current.receipt = paidReceipt(current.receipt, current);
      } catch { current = null; }
      loaded = true;
    }
  }
  async function save() {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = file + '.' + randomUUID() + '.tmp';
    await writeFile(temporary, JSON.stringify(current), { flag: 'wx', mode: 0o600 });
    await rename(temporary, file);
  }
  async function archiveCurrent() {
    if (!current?.id || !uuid.test(current.id)) return;
    const history = path.join(directory, 'beta', 'purchase-history');
    await mkdir(history, { recursive: true, mode: 0o700 });
    try { await writeFile(path.join(history, current.id + '.json'), JSON.stringify(current), { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  async function request(resource, options = {}) {
    let response;
    try { response = await fetchImpl(new URL('/api/software-beta/payment/' + resource, origin), {
      ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
      redirect: 'error', signal: AbortSignal.timeout(15000)
    }); } catch { throw new BetaActivationError('PAYMENT_NETWORK_ERROR', '暂时无法连接购买服务，请稍后重试。', 503); }
    const text = await response.text();
    let result;
    try { if (text.length > 512 * 1024) throw new Error(); result = JSON.parse(text); }
    catch { throw new BetaActivationError('INVALID_PAYMENT_RESPONSE', '购买入口暂未开放，请稍后重试。', 502); }
    if (!response.ok) throw new BetaActivationError(result?.error?.code || 'PAYMENT_FAILED', result?.error?.message || '购买服务暂不可用。', [400, 403, 404, 409, 429, 503].includes(response.status) ? response.status : 502);
    return result;
  }
  async function create(plan, payMethod) {
    await initialize();
    if (current?.id && ["EXPIRED", "PENDING", "PAID"].includes(current.status)) {
      const previous = await status();
      if (previous.order?.status === "PAID" && current.plan === plan && (!previous.order.licenseExpiresAt || Date.parse(previous.order.licenseExpiresAt) > Date.now())) return previous.order;
    }
    if (!['YEAR', 'LIFETIME'].includes(plan) || !['alipay', 'wx'].includes(payMethod)) throw new BetaActivationError('INVALID_REQUEST', '请选择授权方案和支付方式。', 400);
    if (busy) throw new BetaActivationError('PAYMENT_BUSY', '订单正在创建，请稍候。', 409);
    busy = true;
    try {
      if (!current || current.plan !== plan || current.payMethod !== payMethod || ['CLOSED', 'FAILED', 'EXPIRED'].includes(current.status) || current.status === 'PAID' && current.licenseExpiresAt && Date.parse(current.licenseExpiresAt) <= Date.now()) {
        await archiveCurrent();
        current = { token: randomBytes(32).toString('base64url'), plan, payMethod, status: 'PENDING' };
        await save(); // Persist retry identity before contacting a payment service.
      }
      const status = await betaService.status();
      const order = await request('orders', { method: 'POST', body: JSON.stringify({ plan, payMethod,
        token: current.token, installationId: status.installationId, appVersion: APP_VERSION }) });
      if (!uuid.test(order.id || '')) throw new BetaActivationError('INVALID_PAYMENT_RESPONSE', '购买订单返回无效数据。', 502);
      current = { ...current, id: order.id, status: order.status, installationId: status.installationId, licenseExpiresAt: order.licenseExpiresAt };
      const receipt = paidReceipt(order, current);
      if (receipt) current.receipt = receipt;
      await save();
      return order;
    } finally { busy = false; }
  }
  async function status() {
    await initialize();
    if (!current?.id) return { order: null, ...(await betaService.status()) };
    let order;
    try { order = await request('orders/' + current.id, { headers: { Authorization: 'Bearer ' + current.token } }); }
    catch (error) {
      const receipt = paidReceipt(current.receipt, current);
      if (!receipt) throw error;
      // Offline viewing never activates a code, including after device unbinding.
      return { order: receipt, ...(await betaService.status()), receiptOnly: true,
        paymentError: error.message, unbound: current.status === 'UNBOUND' };
    }
    if (!uuid.test(order?.id || '') || order.id !== current.id) throw new BetaActivationError('INVALID_PAYMENT_RESPONSE', '购买订单返回无效数据。', 502);
    const unbound = current.status === 'UNBOUND';
    current.status = unbound ? 'UNBOUND' : order.status; current.licenseExpiresAt = order.licenseExpiresAt;
    const localStatus = await betaService.status();
    const receipt = paidReceipt(order, { ...current, installationId: current.installationId || localStatus.installationId });
    if (receipt) current.receipt = receipt;
    await save();
    let activationError = null;
    if (!unbound && receipt && (!current.activated || !localStatus.activated)) {
      try { await betaService.activate(order.code); current.activated = true; await save(); } catch (error) { activationError = error.message; }
    }
    return { order, ...(await betaService.status()), activationError, unbound };
  }
  async function unbind() {
    await initialize();
    if (!current?.id) throw new BetaActivationError('ORDER_NOT_FOUND', '没有软件内购买记录，请到购买页面管理设备。', 404);
    const status = await betaService.status();
    await request('orders/' + current.id + '/unbind', { method: 'POST', headers: { Authorization: 'Bearer ' + current.token }, body: JSON.stringify({ installationId: status.installationId }) });
    await betaService.clearActivation();
    // Keep the recovery record for retrieving the paid code after unbinding.
    current.status = 'UNBOUND'; await save();
    return { unbound: true, ...(await betaService.status()) };
  }
  let mutations = Promise.resolve();
  const serialize = work => { const running = mutations.then(work); mutations = running.catch(() => {}); return running; };
  return { products: () => request('product'), create: (plan, method) => serialize(() => create(plan, method)),
    status: () => serialize(status), unbind: () => serialize(unbind) };
}
