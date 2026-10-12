import { execFileWithConsoleCapture, windowsInstalledExecutables } from './scripts/windows-runtime.mjs';
import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { resolveExecutablePath } from './runtime-paths.mjs';

export const BAMBU_ENGINE_NAME = 'Bambu Studio CLI';
export const BAMBU_REQUIRED_CLI_FLAGS = Object.freeze([
  '--slice', '--arrange', '--orient', '--outputdir', '--load-settings', '--load-filaments', '--mstpp',
]);

/** Only Bambu Studio installations are considered. An explicit path is final:
 * a missing or incompatible override never falls back to a different slicer. */
export function bambuStudioCandidates({ platform = process.platform, env = process.env } = {}) {
  if (typeof env.BAMBU_STUDIO_PATH === 'string' && env.BAMBU_STUDIO_PATH.trim()) return [env.BAMBU_STUDIO_PATH.trim()];
  let candidates;
  if (platform === 'darwin') {
    candidates = ['/Applications/BambuStudio.app/Contents/MacOS/BambuStudio',
      '/Applications/Bambu Studio.app/Contents/MacOS/BambuStudio',
      ...(env.HOME ? [path.join(env.HOME, 'Applications/BambuStudio.app/Contents/MacOS/BambuStudio')] : [])];
  } else if (platform === 'win32') {
    const roots = [env.ProgramFiles, env.ProgramW6432, env['ProgramFiles(x86)'], 'C:\\Program Files'].filter(Boolean);
    candidates = roots.flatMap(root => ['bambu-studio.exe', 'BambuStudio.exe'].map(name => path.win32.join(root, 'Bambu Studio', name)));
    if (env.LOCALAPPDATA) candidates.push(path.win32.join(env.LOCALAPPDATA, 'Programs', 'Bambu Studio', 'bambu-studio.exe'));
    candidates.push(...windowsInstalledExecutables('bambu', { env, platform }));
  } else {
    candidates = ['bambu-studio', 'BambuStudio', '/usr/bin/bambu-studio', '/usr/local/bin/bambu-studio',
      '/opt/BambuStudio/bin/bambu-studio'];
  }
  return [...new Set(candidates)];
}

export const BAMBU_STUDIO_DEFAULT_PATH = bambuStudioCandidates().find(candidate => resolveExecutablePath(candidate)) || bambuStudioCandidates()[0];

async function resolveExecutable(candidate, env, platform) {
  const isCommand = !/[\\/]/.test(candidate);
  const folders = isCommand ? String(env.PATH || '').split(platform === 'win32' ? ';' : path.delimiter).filter(Boolean) : [''];
  for (const folder of folders) {
    const filename = isCommand ? (platform === 'win32' ? path.win32 : path).join(folder, candidate) : candidate;
    try {
      await access(filename, platform === 'win32' ? constants.F_OK : constants.X_OK);
      if (!(await stat(filename)).isFile()) continue;
      return await realpath(filename);
    } catch {}
  }
  return null;
}

function readHelp(executable, execFileImpl, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, stdout = '', stderr = '') => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(String(stdout) + '\n' + String(stderr));
    };
    try {
      const pending = execFileImpl(executable, ['--help'], {
        encoding: 'utf8', timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024, windowsHide: true, shell: false,
      }, finish);
      // Promise-style adapters are useful for hosts that already wrap execFile.
      if (pending && typeof pending.then === 'function') pending.then(result => {
        if (typeof result === 'string') finish(null, result);
        else finish(null, result?.stdout || '', result?.stderr || '');
      }, error => finish(error));
    } catch (error) { finish(error); }
  });
}

async function isDirectory(filename) {
  try { return (await stat(filename)).isDirectory(); } catch { return false; }
}

async function locateResources(executable, env, platform) {
  const paths = platform === 'win32' ? path.win32 : path;
  const override = typeof env.BAMBU_STUDIO_RESOURCES === 'string' ? env.BAMBU_STUDIO_RESOURCES.trim() : '';
  let candidates;
  if (override) candidates = [paths.basename(override).toLowerCase() === 'profiles' ? paths.dirname(override) : override];
  else if (platform === 'darwin' && /\.app[\\/]Contents[\\/]MacOS[\\/]/.test(executable)) {
    candidates = [paths.join(paths.dirname(executable), '..', 'Resources')];
  } else {
    const parent = paths.dirname(executable);
    candidates = [paths.join(parent, 'resources'), paths.join(parent, 'Resources'),
      paths.join(parent, '..', 'resources'), paths.join(parent, '..', 'share', 'BambuStudio'),
      ...(platform === 'linux' ? ['/usr/share/BambuStudio', '/usr/local/share/BambuStudio'] : [])];
  }
  for (const directory of candidates) {
    const profileDirectory = paths.join(directory, 'profiles');
    try {
      if (await isDirectory(profileDirectory)) return {
        resourceDirectory: await realpath(directory), profileDirectory: await realpath(profileDirectory), profilesAvailable: true,
      };
    } catch {} // An installation can be upgraded while its resources are read.
  }
  return { resourceDirectory: null, profileDirectory: null, profilesAvailable: false };
}

/** Read-only --help probe. No slicing, GUI launch, install or shell is involved.
 * execFileImpl may use Node's callback convention or return {stdout, stderr}.
 * An absent/incompatible installation is a capability result, not an exception. */
export async function probeBambuEngine({ slicerPath, execFileImpl = execFileWithConsoleCapture, timeoutMs = 10000,
  platform = process.platform, env = process.env } = {}) {
  const explicit = slicerPath !== undefined;
  const candidates = explicit ? [slicerPath] : bambuStudioCandidates({ platform, env });
  const base = { available: false, engine: BAMBU_ENGINE_NAME, version: null, engineRevision: null,
    executablePath: null, resourceDirectory: null, profileDirectory: null, profilesAvailable: false,
    requiredCliFlagsSupported: false, missingCliFlags: [], reason: null };
  if (typeof execFileImpl !== 'function' || !Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) {
    return { ...base, reason: 'Bambu Studio 检测配置无效。' };
  }
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !candidate.trim() || candidate.includes('\0')) continue;
    const executable = await resolveExecutable(candidate.trim(), env, platform);
    if (!executable) continue;
    const identified = { ...base, executablePath: executable };
    let help;
    try { help = await readHelp(executable, execFileImpl, timeoutMs); }
    catch (error) {
      return { ...identified, reason: error.killed || error.code === 'ETIMEDOUT'
        ? 'Bambu Studio 命令行检测超时，请确认本机安装可正常运行。'
        : 'Bambu Studio 命令行无法启动，请确认安装路径及可执行权限。' };
    }
    const version = help.match(/^\s*Bambu(?:Studio|[ -]Studio)[\s:v-]*(\d+(?:\.\d+){2,3}(?:[-+][\w.-]+)?)/im)?.[1] || null;
    if (!version) return { ...identified, reason: '指定程序不是可识别的 Bambu Studio 命令行引擎；不会切换至其他切片器。' };
    const missingCliFlags = BAMBU_REQUIRED_CLI_FLAGS.filter(flag => !new RegExp(`(?:^|\\s)${flag}(?=\\s|[=,]|$)`, 'm').test(help));
    const resources = await locateResources(executable, env, platform);
    let identity;
    try {
      const info = await stat(executable);
      identity = `${executable}\0${version}\0${info.size}\0${info.mtimeMs}\0${info.ctimeMs}`;
    } catch {
      return { ...identified, version, ...resources, reason: 'Bambu Studio 在检测期间发生变化，请重新检测。' };
    }
    const engineRevision = `bambu-studio-${version}-${createHash('sha256').update(identity).digest('hex').slice(0, 20)}`;
    return { ...identified, ...resources, version, engineRevision, missingCliFlags,
      available: missingCliFlags.length === 0, requiredCliFlagsSupported: missingCliFlags.length === 0,
      reason: missingCliFlags.length ? `此 Bambu Studio 版本缺少所需命令行参数：${missingCliFlags.join('、')}。` : null };
  }
  return { ...base, reason: explicit || env.BAMBU_STUDIO_PATH
    ? '指定路径未找到可执行的 Bambu Studio。请通过 BAMBU_STUDIO_PATH 指定用户本机安装路径。'
    : '未找到用户本机的 Bambu Studio。请安装后重试，或通过 BAMBU_STUDIO_PATH 指定安装路径。' };
}
