import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { findFFmpegPath, findPythonPath, resolveExecutablePath } from '../runtime-paths.mjs';
import { probeLocalSlicers } from '../slicer-engine.mjs';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const omitted = new Set(['.git', '.aws', '.agents', '.codex', '.ssh', '.auth', 'node_modules', 'exports', 'release', 'research', 'samples', 'test-results', '__pycache__', '.venv', 'venv', 'private-beta', 'integration-work']);
const sourceDirectories = new Set(['src', 'scripts', 'tests', 'docs', 'examples', 'vendor', 'assets']);
const sourceRootFiles = new Set(['index.html', 'package.json', 'package-lock.json', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', '.gitignore', 'start.command', '启动生长延时.command', 'start.cmd', 'INSTALL_AGENT.md', 'install-manifest.json', 'SOURCE_MANIFEST.json', 'server.mjs', 'runtime-paths.mjs', 'bambu-engine.mjs', 'slicer-engine.mjs', 'slice-jobs.mjs', 'support-jobs.mjs', 'realistic-render.mjs', 'photo-calibration.mjs', 'export-codecs.mjs', 'beta-activation.mjs', 'beta-config.json']);
const backgrounds = new Set(['h2c.jpg', 'p1s.jpg', 'a1.jpg', 'pastel-rug.png', 'blue-grey.png', 'teal-room.png']);
export const applicationId = 'growth-timelapse-studio';

export function dataDirectory({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  if (env.GROWTH_DATA_DIR) return path.resolve(env.GROWTH_DATA_DIR);
  if (platform === 'darwin') return path.posix.join(home, 'Library', 'Application Support', 'GrowthTimelapseStudio');
  if (platform === 'win32') return path.win32.join(env.LOCALAPPDATA || path.win32.join(home, 'AppData', 'Local'), 'GrowthTimelapseStudio');
  return path.posix.join(home, '.local', 'share', 'GrowthTimelapseStudio');
}

export function parseArguments(args) {
  const result = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--dry-run') result.dryRun = true;
    else if (arg === '--no-launch') result.noLaunch = true;
    else if (arg === '--no-runtime-install') result.noRuntimeInstall = true;
    else if (['--source', '--install-root', '--manifest'].includes(arg)) {
      if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`${arg} 缺少路径。`);
      result[{ '--source': 'source', '--install-root': 'installRoot', '--manifest': 'manifestFile' }[arg]] = path.resolve(args[++index]);
    } else if (arg === '--help') result.help = true;
    else throw new Error(`未知安装参数：${arg}`);
  }
  return result;
}

export function validateManifest(manifest, local = false) {
  const release = manifest?.release;
  if (manifest?.application !== applicationId || !release || !/^[A-Za-z0-9][A-Za-z0-9.+-]{0,79}$/.test(release.version) || release.tag !== `v${release.version}`) {
    throw new Error('安装版本清单无效。');
  }
  if (local) return;
  if (!release.published || !release.url || !/^[a-f0-9]{64}$/.test(release.sha256 || '')) {
    throw new Error('内测安装包尚未发布或缺少 SHA256。请使用正式发行清单；维护者可用 --source 验证本地源码。');
  }
  const url = new URL(release.url);
  if (!['dashan914/growth-timelapse-studio', 'dashan914/growth-timelapse-studio-beta'].includes(release.repository)
    || url.protocol !== 'https:' || url.host !== 'github.com' || !url.pathname.startsWith(`/${release.repository}/releases/download/${release.tag}/`) || release.archiveRoot !== applicationId) {
    throw new Error('安装包必须来自指定固定 GitHub Release，不能使用 main / latest 分支。');
  }
}

export async function sha256File(filename) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(filename)) digest.update(chunk);
  return digest.digest('hex');
}

export async function downloadVerified(asset, filename, { fetchImpl = fetch } = {}) {
  if (!asset || !/^[a-f0-9]{64}$/.test(asset.sha256 || '')) throw new Error('下载项目缺少有效 SHA256。');
  const url = new URL(asset.url);
  if (url.protocol !== 'https:' || !['github.com', 'raw.githubusercontent.com', 'nodejs.org'].includes(url.host)) throw new Error('下载来源不在固定官方清单中。');
  if (existsSync(filename) && await sha256File(filename) === asset.sha256) return filename;
  await fs.mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.part-${randomUUID()}`;
  try {
    const response = await fetchImpl(asset.url, { signal: AbortSignal.timeout(15 * 60 * 1000), redirect: 'follow' });
    if (!response.ok || !response.body) throw new Error(`下载失败：HTTP ${response.status}。`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { mode: 0o600 }));
    if (await sha256File(temporary) !== asset.sha256) throw new Error('SHA256 校验失败，未执行下载文件。');
    await fs.rename(temporary, filename);
    return filename;
  } finally { await fs.rm(temporary, { force: true }); }
}

export function execute(filename, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(filename, args, { stdio: 'inherit', shell: false, windowsHide: false, ...options });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`${path.basename(filename)} 未完成（${signal || code}）。`)));
  });
}

async function output(filename, args) {
  return new Promise(resolve => {
    let value = '';
    const child = spawn(filename, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true });
    const timeout = setTimeout(() => child.kill(), 5000);
    child.stdout.on('data', chunk => { if (value.length < 65536) value += chunk; });
    child.stderr.on('data', chunk => { if (value.length < 65536) value += chunk; });
    child.once('error', () => { clearTimeout(timeout); resolve(null); });
    child.once('exit', code => { clearTimeout(timeout); resolve(code === 0 ? value : null); });
  });
}

async function findInTree(root, predicate, depth = 4) {
  if (depth < 0 || !existsSync(root)) return null;
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const filename = path.join(root, entry.name);
    if (entry.isFile() && predicate(entry.name)) return filename;
    if (entry.isDirectory()) { const found = await findInTree(filename, predicate, depth - 1); if (found) return found; }
  }
  return null;
}

async function detectRuntime(env, platform, installRoot) {
  const python = resolveExecutablePath(findPythonPath({ env, platform }), { env, platform });
  const ffmpeg = resolveExecutablePath(findFFmpegPath({ env, platform }), { env, platform });
  const pythonVersion = python && await output(python, ['--version']);
  const ffmpegVersion = ffmpeg && await output(ffmpeg, ['-version']);
  const slicers = await probeLocalSlicers({ env, platform, timeoutMs: 5000 });
  return {
    node: process.execPath,
    python: /^Python 3\./.test(pythonVersion || '') ? python : null,
    ffmpeg: ffmpegVersion?.startsWith('ffmpeg version') ? ffmpeg : null,
    slicer: slicers.preferredEngineId ? slicers.availableRegistry[slicers.preferredEngineId] : null,
  };
}

const unzipScript = `import pathlib,stat,sys,zipfile
archive,destination=sys.argv[1:3]
root=pathlib.Path(destination)
with zipfile.ZipFile(archive) as z:
 members=z.infolist()
 if len(members)>15000 or sum(m.file_size for m in members)>3*1024**3: raise ValueError('Archive is too large')
 for m in members:
  name=m.filename.replace('\\\\','/')
  parts=pathlib.PurePosixPath(name).parts
  if not parts or name.startswith('/') or '..' in parts or ':' in parts[0] or stat.S_ISLNK(m.external_attr>>16): raise ValueError('Unsafe archive entry')
 z.extractall(root)
`;

async function ensureRuntime({ manifest, installRoot, platform, env, installMissing = true, run = execute, log = console.log }) {
  const cache = path.join(installRoot, 'cache');
  const portableBambu = path.join(installRoot, 'runtimes', 'bambu', manifest.bambuStudio.version);
  if (platform === 'darwin') {
    const portable = path.join(portableBambu, 'BambuStudio.app', 'Contents', 'MacOS', 'BambuStudio');
    if (existsSync(portable) && !env.BAMBU_STUDIO_PATH) env.BAMBU_STUDIO_PATH = portable;
    env.PATH = `/opt/homebrew/bin:/usr/local/bin:${env.PATH || ''}`;
  } else {
    const portable = await findInTree(portableBambu, name => /^(bambu-studio|BambuStudio)\.exe$/i.test(name));
    if (portable && !env.BAMBU_STUDIO_PATH) env.BAMBU_STUDIO_PATH = portable;
    if (!env.PYTHON_PATH && env.LOCALAPPDATA) {
      const python = path.join(env.LOCALAPPDATA, 'Programs', 'Python', 'Python313', 'python.exe');
      if (existsSync(python)) env.PYTHON_PATH = python;
    }
    if (!env.FFMPEG_PATH && env.LOCALAPPDATA) {
      const ffmpeg = await findInTree(path.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages'), name => name.toLowerCase() === 'ffmpeg.exe');
      if (ffmpeg) env.FFMPEG_PATH = ffmpeg;
    }
  }
  let runtime = await detectRuntime(env, platform, installRoot);
  if (!installMissing && (!runtime.python || !runtime.ffmpeg || !runtime.slicer)) throw new Error('缺少运行时；--no-runtime-install 已禁止安装本机依赖。');
  if (!runtime.python || !runtime.ffmpeg) {
    if (platform === 'darwin') {
      let brew = resolveExecutablePath('brew', { env, platform });
      if (!brew) {
        log('安装 Homebrew：终端中的权限与系统工具提示需由本人确认。');
        const script = await downloadVerified(manifest.homebrew, path.join(cache, 'homebrew-install.sh'));
        await run('/bin/bash', [script], { env });
        brew = resolveExecutablePath('brew', { env, platform });
        if (!brew) throw new Error('Homebrew 尚未可用。完成官方安装提示后重新运行安装器。');
      }
      if (!runtime.python) await run(brew, ['install', manifest.packageManagers.darwin.python], { env });
      if (!runtime.ffmpeg) await run(brew, ['install', manifest.packageManagers.darwin.ffmpeg], { env });
      if (!runtime.python) {
        const prefix = (await output(brew, ['--prefix', manifest.packageManagers.darwin.python]))?.trim();
        if (prefix) env.PYTHON_PATH = path.join(prefix, 'bin', 'python3.13');
      }
    } else {
      const winget = resolveExecutablePath('winget.exe', { env, platform });
      if (!winget) throw new Error('未找到 WinGet。请通过 Microsoft App Installer 安装 WinGet 后重试。');
      const manager = manifest.packageManagers.win32;
      for (const name of ['python', 'ffmpeg']) if (!runtime[name]) {
        log(`安装 ${name}：请在安装器中确认许可和权限提示。`);
        await run(winget, ['install', '--id', manager[name], '--exact', '--source', manager.source, '--interactive', '--no-upgrade'], { env });
      }
      if (!runtime.python) env.PYTHON_PATH = await findInTree(path.join(env.LOCALAPPDATA, 'Programs', 'Python'), name => name.toLowerCase() === 'python.exe');
      if (!runtime.ffmpeg) env.FFMPEG_PATH = await findInTree(path.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages'), name => name.toLowerCase() === 'ffmpeg.exe');
    }
    runtime = await detectRuntime(env, platform, installRoot);
  }
  if (!runtime.python || !runtime.ffmpeg) throw new Error('Python 3 / FFmpeg 检查未通过。请完成安装后重试；已有文件与授权会保留。');
  if (!runtime.slicer) {
    log(`安装官方 Bambu Studio ${manifest.bambuStudio.version}。`);
    const asset = manifest.bambuStudio[platform];
    const archive = await downloadVerified(asset, path.join(cache, path.basename(new URL(asset.url).pathname)));
    await fs.mkdir(path.dirname(portableBambu), { recursive: true });
    const stage = await fs.mkdtemp(path.join(path.dirname(portableBambu), '.stage-'));
    try {
      if (platform === 'darwin') {
        const mount = path.join(stage, 'mount');
        await fs.mkdir(mount);
        await run('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, archive], { env });
        try {
          const entries = await fs.readdir(mount);
          const app = entries.find(name => /^Bambu ?Studio\.app$/.test(name));
          if (!app) throw new Error('官方 DMG 中未找到 Bambu Studio。');
          await run('/usr/bin/ditto', [path.join(mount, app), path.join(stage, 'BambuStudio.app')], { env });
        } finally { await run('/usr/bin/hdiutil', ['detach', mount], { env }); }
        await fs.rmdir(mount);
      } else await run(runtime.python, ['-c', unzipScript, archive, stage], { env });
      // An interrupted previous attempt is retained rather than overwritten.
      if (existsSync(portableBambu)) throw new Error('已有切片器目录未通过检查。请查看日志或指定兼容切片器路径，安装器不会覆盖它。');
      await fs.rename(stage, portableBambu);
    } finally { await fs.rm(stage, { recursive: true, force: true }); }
    env.BAMBU_STUDIO_PATH = platform === 'darwin'
      ? path.join(portableBambu, 'BambuStudio.app', 'Contents', 'MacOS', 'BambuStudio')
      : await findInTree(portableBambu, name => /^(bambu-studio|BambuStudio)\.exe$/i.test(name));
    runtime = await detectRuntime(env, platform, installRoot);
  }
  if (!runtime.slicer) throw new Error('切片器 CLI 能力检查未通过。macOS 如有首次打开提示，请本人确认官方应用后重试。');
  return runtime;
}

function selected(relative) {
  const parts = relative.split(path.sep);
  if (!sourceDirectories.has(parts[0]) && !sourceRootFiles.has(relative)) return false;
  if (parts[0] === 'assets' && !(parts.length === 2 && parts[1] === 'shandi-logo.svg') && (parts.length > 1 && parts[1] !== 'backgrounds' || parts.length > 2 && !backgrounds.has(parts[2]))) return false;
  return !parts.some(part => omitted.has(part) || part.startsWith('.slice-') || part.startsWith('.support-') || part.startsWith('.realistic-') || part.startsWith('.env') || part.startsWith('._'))
    && !/\.(?:log|pyc|zip|pem|key|p12|pfx)$/i.test(relative) && !/^inventory.*\.json$/i.test(parts.at(-1))
    && !['.DS_Store', 'Thumbs.db', 'result.json'].includes(parts.at(-1));
}

export async function sourceFiles(root) {
  const results = [];
  async function walk(folder) {
    for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
      const filename = path.join(folder, entry.name), relative = path.relative(root, filename);
      if (!selected(relative)) continue;
      if (entry.isSymbolicLink()) throw new Error(`源码不应包含符号链接：${relative}`);
      if (entry.isDirectory()) await walk(filename);
      else if (entry.isFile()) results.push(relative);
    }
  }
  await walk(root);
  return results.sort();
}

async function validateSource(root) {
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  if (pkg.name !== applicationId) throw new Error('源码不是本项目。');
  for (const filename of ['server.mjs', 'package-lock.json', 'scripts/check-runtime.mjs', 'scripts/launch.mjs']) {
    if (!(await fs.stat(path.join(root, filename))).isFile()) throw new Error(`源码缺少 ${filename}。`);
  }
}

function npmCli(node) {
  const folder = path.dirname(node);
  const candidates = [path.join(folder, 'node_modules', 'npm', 'bin', 'npm-cli.js'), path.join(folder, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')];
  const found = candidates.find(existsSync);
  if (!found) throw new Error('Node.js 安装中缺少 npm。请使用完整官方 Node.js 发行包。');
  return found;
}

export async function install(options = {}, dependencies = {}) {
  const platform = dependencies.platform || process.platform;
  const log = dependencies.log || console.log;
  if (!['darwin', 'win32'].includes(platform)) throw new Error('安装器目前支持 macOS 与 Windows x64。');
  if (platform === 'win32' && (dependencies.arch || process.arch) !== 'x64') throw new Error('Windows 安装器目前仅提供 x64 方案。');
  const manifest = dependencies.manifest || JSON.parse(await fs.readFile(options.manifestFile || path.join(sourceRoot, 'install-manifest.json'), 'utf8'));
  validateManifest(manifest, !!options.source);
  const root = path.resolve(options.installRoot || dataDirectory());
  if (/[\r\n]/.test(root)) throw new Error('安装路径不能包含换行。');
  if (options.source) {
    const source = path.resolve(options.source);
    const relativeRoot = path.relative(source, root);
    if (!relativeRoot || (!relativeRoot.startsWith(`..${path.sep}`) && relativeRoot !== '..' && !path.isAbsolute(relativeRoot))) throw new Error('用户数据目录不能放在待安装源码内部。');
    await validateSource(source);
  }
  const plan = { application: applicationId, version: manifest.release.version, source: options.source || manifest.release.url, installRoot: root, exports: path.join(root, 'exports'), authorization: path.join(root, 'beta'), dryRun: !!options.dryRun };
  log(JSON.stringify(plan, null, 2));
  if (options.dryRun) { log('DRY RUN: 检测并补齐缺失运行时，校验版本包，npm ci，doctor，创建启动入口；不修改电脑。'); return plan; }
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('安装器需要 Node.js 24+。请使用平台 bootstrap。');
  const run = dependencies.run || execute;
  await fs.mkdir(root, { recursive: true });
  const lockPath = path.join(root, '.install.lock');
  let lock;
  try { lock = await fs.open(lockPath, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('另一个安装进程正在运行，或上次安装被强行中断。确认没有安装进程后删除 .install.lock 再重试。'); throw error; }
  await lock.writeFile(String(process.pid));
  let stage;
  try {
    // Verify that the actual pinned artifact is accessible before provisioning
    // Python, FFmpeg or a slicer. The external release manifest is not inside
    // the ZIP, so its SHA256 never creates a self-reference.
    const releaseArchive = options.source ? null : await downloadVerified(manifest.release, path.join(root, 'cache', `${manifest.release.tag}.zip`));
    const env = { ...process.env, GROWTH_DATA_DIR: root, GROWTH_EXPORT_DIR: path.join(root, 'exports'), npm_config_cache: path.join(root, 'cache', 'npm') };
    const runtime = await (dependencies.ensureRuntime || ensureRuntime)({ manifest, installRoot: root, platform, env, installMissing: !options.noRuntimeInstall, run, log });
    env.PYTHON_PATH = runtime.python;
    env.FFMPEG_PATH = runtime.ffmpeg;
    if (runtime.slicer?.executablePath) {
      env[{ bambu: 'BAMBU_STUDIO_PATH', orca: 'ORCA_SLICER_PATH', flash: 'FLASH_STUDIO_PATH' }[runtime.slicer.id]] = runtime.slicer.executablePath;
      if (runtime.slicer.resourceDirectory) env[{ bambu: 'BAMBU_STUDIO_RESOURCES', orca: 'ORCA_SLICER_RESOURCES', flash: 'FLASH_STUDIO_RESOURCES' }[runtime.slicer.id]] = runtime.slicer.resourceDirectory;
    }
    const releases = path.join(root, 'releases');
    await fs.mkdir(releases, { recursive: true });
    let source = options.source && path.resolve(options.source);
    if (!source) {
      stage = await fs.mkdtemp(path.join(releases, '.unpack-'));
      await run(runtime.python, ['-c', unzipScript, releaseArchive, stage], { env });
      source = path.join(stage, manifest.release.archiveRoot);
      await validateSource(source);
    }
    const files = await sourceFiles(source);
    const digest = createHash('sha256');
    for (const relative of files) digest.update(relative).update('\0').update(await sha256File(path.join(source, relative))).update('\0');
    const sourceHash = digest.digest('hex');
    const releaseName = `${manifest.release.version}-${options.source ? 'local-' : ''}${sourceHash.slice(0, 16)}`;
    const releaseDirectory = path.join(releases, releaseName);
    const marker = path.join(releaseDirectory, '.installed.json');
    const reused = existsSync(marker) && JSON.parse(await fs.readFile(marker, 'utf8')).sourceHash === sourceHash;
    if (!reused) {
      const prepared = await fs.mkdtemp(path.join(releases, '.prepare-'));
      try {
        for (const relative of files) {
          await fs.mkdir(path.dirname(path.join(prepared, relative)), { recursive: true });
          await fs.copyFile(path.join(source, relative), path.join(prepared, relative));
        }
        const copiedDigest = createHash('sha256');
        for (const relative of files) copiedDigest.update(relative).update('\0').update(await sha256File(path.join(prepared, relative))).update('\0');
        if (copiedDigest.digest('hex') !== sourceHash) throw new Error('源码在安装复制期间发生变化，请在保存完成后重试。');
        await run(runtime.node, [dependencies.npmCli || npmCli(runtime.node), 'ci', '--no-audit', '--no-fund'], { cwd: prepared, env });
        await run(runtime.node, [path.join(prepared, 'scripts', 'check-runtime.mjs')], { cwd: prepared, env });
        await fs.writeFile(path.join(prepared, '.installed.json'), JSON.stringify({ sourceHash, version: manifest.release.version }), { mode: 0o600 });
        if (existsSync(releaseDirectory)) throw new Error('目标版本目录已存在但尚未通过安装检查，未覆盖它。');
        await fs.rename(prepared, releaseDirectory);
      } finally { await fs.rm(prepared, { recursive: true, force: true }); }
    } else {
      log('复用已安装的同一源码版本，重新执行 doctor。');
      await run(runtime.node, [path.join(releaseDirectory, 'scripts', 'check-runtime.mjs')], { cwd: releaseDirectory, env });
    }
    await fs.mkdir(path.join(root, 'exports'), { recursive: true });
    const executableVariables = ['PYTHON_PATH', 'FFMPEG_PATH', 'BAMBU_STUDIO_PATH', 'BAMBU_STUDIO_RESOURCES', 'ORCA_SLICER_PATH', 'ORCA_SLICER_RESOURCES', 'FLASH_STUDIO_PATH', 'FLASH_STUDIO_RESOURCES', 'BLENDER_PATH', 'PHOTO_CALIBRATION_PYTHON', 'OPENCV_PYTHONPATH', 'GROWTH_CYCLES_DEVICE'];
    const config = { application: applicationId, version: manifest.release.version, sourceHash, releaseDirectory, node: runtime.node, env: Object.fromEntries(executableVariables.filter(key => typeof env[key] === 'string' && env[key]).map(key => [key, env[key]])), installedAt: new Date().toISOString() };
    const configFile = path.join(root, 'installation.json');
    const nextConfig = `${configFile}.next-${randomUUID()}`;
    await fs.writeFile(nextConfig, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
    await fs.rename(nextConfig, configFile);
    if (platform === 'darwin') {
      const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
      await fs.writeFile(path.join(root, '打开打印延时.command'), `#!/bin/bash\nexec ${quote(runtime.node)} ${quote(path.join(releaseDirectory, 'scripts', 'launch.mjs'))} --install-root ${quote(root)}\n`, { mode: 0o755 });
    } else {
      const escaped = value => value.replaceAll('%', '%%');
      await fs.writeFile(path.join(root, '打开打印延时.cmd'), `@echo off\r\nsetlocal DisableDelayedExpansion\r\nchcp 65001 >nul\r\n"${escaped(runtime.node)}" "${escaped(path.join(releaseDirectory, 'scripts', 'launch.mjs'))}" --install-root "${escaped(root)}"\r\nif errorlevel 1 pause\r\nendlocal\r\n`);
    }
    log(`安装完成。启动入口：${path.join(root, platform === 'darwin' ? '打开打印延时.command' : '打开打印延时.cmd')}`);
    if (!options.noLaunch) await run(runtime.node, [path.join(releaseDirectory, 'scripts', 'launch.mjs'), '--install-root', root], { env });
    return { ...plan, releaseDirectory, reused, sourceHash };
  } finally {
    if (stage) await fs.rm(stage, { recursive: true, force: true });
    await lock.close();
    await fs.rm(lockPath, { force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) console.log('安装：node scripts/install.mjs [--manifest <外部发行清单>] [--source <本地源码>] [--install-root <目录>] [--dry-run] [--no-launch] [--no-runtime-install]');
    else await install(options);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
