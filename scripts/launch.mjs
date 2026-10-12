import fs from 'node:fs/promises';
import { openSync, closeSync, existsSync } from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { applicationId, dataDirectory, execute } from './install.mjs';

async function health(port, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1200) });
    if (!response.ok) return null;
    const result = await response.json();
    return result.app === applicationId && result.ok === true ? result : null;
  } catch { return null; }
}

async function portAvailable(port) {
  return new Promise(resolve => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

async function openBrowser(url, platform) {
  await execute(platform === 'darwin' ? '/usr/bin/open' : 'explorer.exe', [url]);
}

export async function launch(options = {}, dependencies = {}) {
  const root = path.resolve(options.installRoot || dataDirectory());
  const platform = dependencies.platform || process.platform;
  const log = dependencies.log || console.log;
  const configFile = path.join(root, 'installation.json');
  const config = existsSync(configFile) ? JSON.parse(await fs.readFile(configFile, 'utf8')) : null;
  if (config && config.application !== applicationId) throw new Error('本机安装状态不是打印延时项目。');
  const source = options.source ? path.resolve(options.source) : config?.releaseDirectory;
  if (!source || !existsSync(path.join(source, 'server.mjs'))) throw new Error('尚未安装。请先运行平台安装器。');
  const node = config?.node || process.execPath;
  const desiredVersion = options.source ? JSON.parse(await fs.readFile(path.join(source, 'package.json'), 'utf8')).version : config.version;
  const instanceId = createHash('sha256').update(root).update('\0').update(source).digest('hex').slice(0, 24);
  const env = { ...process.env, ...config?.env, GROWTH_DATA_DIR: root, GROWTH_EXPORT_DIR: path.join(root, 'exports'), GROWTH_INSTANCE_ID: instanceId };
  const basePort = Number(options.port ?? env.PORT ?? 4317);
  if (!Number.isInteger(basePort) || basePort < 1 || basePort > 65535) throw new Error('PORT 须为 1–65535 的整数。');
  let selectedPort = null;
  for (let port = basePort; port <= Math.min(basePort + 9, 65535); port++) {
    const existing = await health(port, dependencies.fetchImpl);
    if (existing?.version === desiredVersion && existing.instanceId === instanceId) {
      const url = `http://127.0.0.1:${port}`;
      log(`工作台已启动：${url}`);
      if (!options.noOpen) await (dependencies.openBrowser || openBrowser)(url, platform);
      return { reused: true, url, pid: existing.pid || null };
    }
    if (await portAvailable(port)) { selectedPort = port; break; }
  }
  if (selectedPort === null) throw new Error(`端口 ${basePort}–${Math.min(basePort + 9, 65535)} 均被占用。请设置其他 PORT。`);
  await fs.mkdir(path.join(root, 'logs'), { recursive: true });
  await fs.mkdir(path.join(root, 'exports'), { recursive: true });
  const logfile = path.join(root, 'logs', 'server.log');
  const fd = openSync(logfile, 'a', 0o600);
  let child;
  try {
    child = spawn(node, [path.join(source, 'server.mjs')], { cwd: source, env: { ...env, PORT: String(selectedPort) }, stdio: ['ignore', fd, fd], detached: true, windowsHide: true, shell: false });
  } finally { closeSync(fd); }
  let failure;
  child.once('error', error => { failure = error; });
  child.once('exit', (code, signal) => { failure = new Error(`本机服务退出（${signal || code}）。`); });
  child.unref();
  const url = `http://127.0.0.1:${selectedPort}`;
  let ready = null;
  for (let attempt = 0; attempt < 80; attempt++) {
    if (failure) throw new Error(`启动失败：${failure.message} 日志：${logfile}`);
    ready = await health(selectedPort, dependencies.fetchImpl);
    if (ready?.version === desiredVersion && ready.instanceId === instanceId) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (!ready || ready.version !== desiredVersion || ready.instanceId !== instanceId) {
    if (child.pid) { try { child.kill(); } catch {} }
    throw new Error(`启动检查未完成。日志：${logfile}`);
  }
  const state = { application: applicationId, version: desiredVersion, source, url, port: selectedPort, pid: child.pid, startedAt: new Date().toISOString() };
  await fs.writeFile(path.join(root, 'service.json'), JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  log(`工作台：http://127.0.0.1:${selectedPort}\n作品目录：${env.GROWTH_EXPORT_DIR}\n日志：${logfile}\n本机服务进程：${child.pid}`);
  if (!options.noOpen) await (dependencies.openBrowser || openBrowser)(url, platform);
  return { reused: false, url, pid: child.pid };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = {};
    const args = process.argv.slice(2);
    for (let index = 0; index < args.length; index++) {
      if (args[index] === '--no-open') options.noOpen = true;
      else if (['--source', '--install-root'].includes(args[index])) {
        if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`${args[index]} 缺少路径。`);
        options[args[index] === '--source' ? 'source' : 'installRoot'] = path.resolve(args[++index]);
      } else throw new Error(`未知启动参数：${args[index]}`);
    }
    await launch(options);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
