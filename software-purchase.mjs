import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { APP_VERSION, BetaActivationError, growthDataDirectory } from './beta-activation.mjs';

const config = JSON.parse(readFileSync(process.env.GROWTH_BETA_CONFIG || new URL('./beta-config.json', import.meta.url), 'utf8'));
const uuid = /^[0-9a-f-]{36}$/i;
export function createSoftwarePurchaseService({ betaService, directory = growthDataDirectory(), fetchImpl = fetch, serverUrl = config.serverUrl } = {}) {
  const origin = new URL(serverUrl);
  if (origin.username || origin.password || origin.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(origin.hostname)) throw new Error('Invalid payment server');
  const file = path.join(directory, 'beta', 'purchase.json');
  let current, loaded = false, busy = false;
  async function initialize() {
    if (!loaded) {
      try { current = JSON.parse(await readFile(file, 'utf8')); } catch { current = null; }
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
      current = { ...current, id: order.id, status: order.status, licenseExpiresAt: order.licenseExpiresAt }; await save();
      return order;
    } finally { busy = false; }
  }
  async function status() {
    await initialize();
    if (!current?.id) return { order: null, ...(await betaService.status()) };
    const order = await request('orders/' + current.id, { headers: { Authorization: 'Bearer ' + current.token } });
    const unbound = current.status === 'UNBOUND';
    current.status = unbound ? 'UNBOUND' : order.status; current.licenseExpiresAt = order.licenseExpiresAt; await save();
    let activationError = null;
    if (!unbound && order.status === 'PAID' && order.code && (!current.activated || !(await betaService.status()).activated)) {
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
