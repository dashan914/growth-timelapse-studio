import { createPublicKey, randomUUID, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export const BETA_PRODUCT_ID = 'growth-timelapse-beta';
export const APP_VERSION = '1.2.0-beta.3';
const DEFAULT_CONFIG = JSON.parse(readFileSync(process.env.GROWTH_BETA_CONFIG || new URL('./beta-config.json', import.meta.url), 'utf8'));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class BetaActivationError extends Error {
  constructor(code, message, status = 403) { super(message); this.code = code; this.status = status; }
}

export function growthDataDirectory({ env = process.env, platform = process.platform, home = homedir() } = {}) {
  if (env.GROWTH_DATA_DIR) return path.resolve(env.GROWTH_DATA_DIR);
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'GrowthTimelapseStudio');
  if (platform === 'win32') return path.win32.join(env.LOCALAPPDATA || path.win32.join(home, 'AppData', 'Local'), 'GrowthTimelapseStudio');
  return path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'GrowthTimelapseStudio');
}

function decode(value, limit) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value) || value.length > limit) throw new BetaActivationError('INVALID_LICENSE', '导出授权记录无效，请重新输入兑换码。');
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value) throw new BetaActivationError('INVALID_LICENSE', '导出授权记录无效，请重新输入兑换码。');
  return bytes;
}

export function verifyBetaLicense(license, { publicKeys, installationId, now = Date.now() }) {
  try {
    if (!license || license.version !== 1 || license.algorithm !== 'Ed25519' || typeof license.keyId !== 'string' || !Object.hasOwn(publicKeys, license.keyId)) throw new Error('envelope');
    const payloadBytes = decode(license.payload, 16384), signature = decode(license.signature, 128);
    const key = createPublicKey(publicKeys[license.keyId]);
    if (key.asymmetricKeyType !== 'ed25519' || signature.length !== 64 || !verify(null, payloadBytes, key, signature)) throw new Error('signature');
    const payload = JSON.parse(payloadBytes.toString('utf8'));
    if (!payload || payload.version !== 1 || payload.productId !== BETA_PRODUCT_ID || payload.installationId !== installationId || !UUID.test(installationId) || typeof payload.codeId !== 'string' || !payload.codeId || payload.codeId.length > 128) throw new Error('payload');
    const issuedAt = Date.parse(payload.issuedAt);
    if (!Number.isFinite(issuedAt) || issuedAt > now + 5 * 60_000) throw new Error('issuedAt');
    if (payload.expiresAt !== null) {
      const expiresAt = Date.parse(payload.expiresAt);
      if (!Number.isFinite(expiresAt) || expiresAt <= issuedAt) throw new Error('expiresAt');
      if (expiresAt <= now) throw new BetaActivationError('BETA_EXPIRED', '导出授权已到期，请到山地造物查看兑换记录。');
    }
    return payload;
  } catch (error) {
    if (error instanceof BetaActivationError) throw error;
    throw new BetaActivationError('INVALID_LICENSE', '导出授权记录无效，请重新输入兑换码。');
  }
}

async function readJSON(filename) {
  try { return JSON.parse(await readFile(filename, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function saveJSON(filename, value) {
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx' });
  await rename(temporary, filename);
}

export function createBetaActivationService({ config = DEFAULT_CONFIG, dataDirectory = growthDataDirectory(), fetchImpl = fetch, now = Date.now, timeoutMs = 15_000 } = {}) {
  if (config.productId !== BETA_PRODUCT_ID) throw new Error('导出解锁配置无效。');
  const serverUrl = new URL(config.serverUrl);
  if (serverUrl.username || serverUrl.password || (serverUrl.protocol !== 'https:' && !(serverUrl.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(serverUrl.hostname)))) throw new Error('导出解锁服务地址无效。');
  const redemptionUrl = new URL(config.redemptionUrl);
  if (redemptionUrl.protocol !== 'https:' && !(redemptionUrl.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(redemptionUrl.hostname))) throw new Error('兑换地址无效。');
  const publicKeys = config.publicKeys || {};
  const folder = path.join(dataDirectory, 'beta');
  const installationFile = path.join(folder, 'installation.json'), licenseFile = path.join(folder, 'license.json');
  let initialized, installationId, license = null, activating = false;

  async function initialize() {
    initialized ||= (async () => {
      let saved;
      try { saved = await readJSON(installationFile); } catch { saved = null; }
      installationId = UUID.test(saved?.installationId || '') ? saved.installationId : randomUUID();
      if (!saved || saved.installationId !== installationId) await saveJSON(installationFile, { installationId });
      try { license = await readJSON(licenseFile); } catch { license = null; }
    })();
    return initialized;
  }

  async function status() {
    await initialize();
    const result = { activated: false, configured: Object.keys(publicKeys).length > 0, productId: BETA_PRODUCT_ID, appVersion: APP_VERSION, redemptionUrl: redemptionUrl.href, installationId, expiresAt: null };
    if (!license) return { ...result, reason: 'ACTIVATION_REQUIRED', message: '导出未解锁，请输入兑换码。' };
    try {
      const payload = verifyBetaLicense(license, { publicKeys, installationId, now: now() });
      return { ...result, activated: true, expiresAt: payload.expiresAt, reason: null, message: '导出已解锁。' };
    } catch (error) { return { ...result, reason: error.code || 'INVALID_LICENSE', message: error.message }; }
  }

  async function activate(code) {
    await initialize();
    if (activating) throw new BetaActivationError('ACTIVATION_BUSY', '正在验证兑换码，请稍候。', 409);
    if (typeof code !== 'string' || !/^GTB1-[A-Z0-9-]{20,64}$/.test(code.trim().toUpperCase())) throw new BetaActivationError('INVALID_CODE', '请粘贴山地造物兑换的完整兑换码。', 400);
    if (!Object.keys(publicKeys).length) throw new BetaActivationError('BETA_NOT_READY', '导出解锁入口尚未开放，请稍后再试。', 503);
    activating = true;
    try {
      let response;
      try {
        response = await fetchImpl(new URL('/api/software-beta/activate', serverUrl), { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: code.trim().toUpperCase(), installationId, appVersion: APP_VERSION }), signal: AbortSignal.timeout(timeoutMs) });
      } catch { throw new BetaActivationError('ACTIVATION_NETWORK_ERROR', '暂时无法连接兑换码验证服务，请检查网络后重试。', 503); }
      let result;
      try { result = await response.json(); } catch { throw new BetaActivationError('INVALID_ACTIVATION_RESPONSE', '兑换码验证服务暂时没有返回有效结果，请稍后重试。', 502); }
      if (!response.ok) throw new BetaActivationError(result?.error?.code || 'ACTIVATION_REJECTED', result?.error?.message || '兑换码未通过验证，请检查兑换记录。', [400, 403, 409, 429, 503].includes(response.status) ? response.status : 502);
      verifyBetaLicense(result.license, { publicKeys, installationId, now: now() });
      await saveJSON(licenseFile, result.license);
      license = result.license;
      return status();
    } finally { activating = false; }
  }

  async function requireActivation() {
    const current = await status();
    if (!current.activated) throw new BetaActivationError(current.reason, current.message, 403);
  }
  async function clearActivation() {
    await initialize();
    await rm(licenseFile, { force: true });
    license = null;
    return status();
  }
  return { status, activate, requireActivation, clearActivation };
}
