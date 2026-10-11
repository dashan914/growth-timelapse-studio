import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { BAMBU_REQUIRED_CLI_FLAGS, bambuStudioCandidates, probeBambuEngine } from './bambu-engine.mjs';

export const LOCAL_SLICER_IDS = Object.freeze(['bambu', 'flash', 'orca']);
export const LOCAL_SLICER_PREFERENCE = Object.freeze(['bambu', 'orca', 'flash']);
export const LOCAL_SLICER_REQUIRED_CLI_FLAGS = BAMBU_REQUIRED_CLI_FLAGS;
const DESCRIPTORS = Object.freeze({
  bambu: { label: 'Bambu Studio', engine: 'Bambu Studio CLI', profileVendor: 'BBL', pathVariable: 'BAMBU_STUDIO_PATH', resourcesVariable: 'BAMBU_STUDIO_RESOURCES' },
  flash: { label: 'Flash Studio', engine: 'Flash Studio / Orca-Flashforge CLI', profileVendor: 'Flashforge', pathVariable: 'FLASH_STUDIO_PATH', resourcesVariable: 'FLASH_STUDIO_RESOURCES',
    versionPattern: /^\s*(?:Orca[- ]Flashforge|Flash(?:[ -]?Studio))[\s:v-]*(\d+(?:\.\d+){2,3}(?:[-+][\w.-]+)?)/im,
    resourceNames: ['Flash Studio', 'Orca-Flashforge', 'FlashStudio'] },
  orca: { label: 'OrcaSlicer', engine: 'OrcaSlicer CLI', profileVendor: 'BBL', pathVariable: 'ORCA_SLICER_PATH', resourcesVariable: 'ORCA_SLICER_RESOURCES',
    versionPattern: /^\s*Orca(?:Slicer|[ -]Slicer)[\s:v-]*(\d+(?:\.\d+){2,3}(?:[-+][\w.-]+)?)/im,
    resourceNames: ['OrcaSlicer', 'OrcaSlicer-bin'] },
});

/** Paths are supplied by the process environment or trusted local backend
 * configuration. The HTTP API should accept an engine id, never an executable. */
export function localSlicerCandidates(engineId, { platform = process.platform, env = process.env } = {}) {
  if (!LOCAL_SLICER_IDS.includes(engineId)) return [];
  if (engineId === 'bambu') return bambuStudioCandidates({ platform, env });
  const descriptor = DESCRIPTORS[engineId];
  const override = env[descriptor.pathVariable];
  if (typeof override === 'string' && override.trim()) return [override.trim()];
  let candidates;
  if (platform === 'darwin') {
    candidates = engineId === 'flash'
      ? ['/Applications/Flash Studio.app/Contents/MacOS/Flash Studio', '/Applications/Orca-Flashforge.app/Contents/MacOS/Orca-Flashforge']
      : ['/Applications/OrcaSlicer.app/Contents/MacOS/OrcaSlicer', '/Applications/Orca Slicer.app/Contents/MacOS/OrcaSlicer'];
    if (env.HOME) candidates.push(path.join(env.HOME, candidates[0].replace(/^\//, '')));
  } else if (platform === 'win32') {
    const roots = [...new Set([env.ProgramFiles, env.ProgramW6432, env['ProgramFiles(x86)'], 'C:\\Program Files'].filter(Boolean))];
    candidates = roots.flatMap(root => engineId === 'flash'
      ? [path.win32.join(root, 'Flash Studio', 'Flash Studio.exe'), path.win32.join(root, 'Orca-Flashforge', 'orca-flashforge.exe')]
      : [path.win32.join(root, 'OrcaSlicer', 'orca-slicer.exe'), path.win32.join(root, 'OrcaSlicer', 'OrcaSlicer.exe')]);
    if (env.LOCALAPPDATA) candidates.push(engineId === 'flash'
      ? path.win32.join(env.LOCALAPPDATA, 'Programs', 'Flash Studio', 'Flash Studio.exe')
      : path.win32.join(env.LOCALAPPDATA, 'Programs', 'OrcaSlicer', 'orca-slicer.exe'));
  } else {
    candidates = engineId === 'flash'
      ? ['orca-flashforge', 'flash-studio', '/usr/bin/orca-flashforge', '/usr/local/bin/orca-flashforge']
      : ['orca-slicer', 'OrcaSlicer', '/usr/bin/orca-slicer', '/usr/local/bin/orca-slicer', '/opt/OrcaSlicer/bin/orca-slicer'];
  }
  return [...new Set(candidates)];
}

export const FLASH_STUDIO_DEFAULT_PATH = localSlicerCandidates('flash')[0];
export const ORCA_SLICER_DEFAULT_PATH = localSlicerCandidates('orca')[0];

async function resolveExecutable(candidate, platform, env) {
  const paths = platform === 'win32' ? path.win32 : path;
  const command = !/[\\/]/.test(candidate);
  const folders = command ? String(env.PATH || '').split(platform === 'win32' ? ';' : path.delimiter).filter(Boolean) : [''];
  for (const folder of folders) {
    const filename = command ? paths.join(folder, candidate) : candidate;
    try {
      await access(filename, platform === 'win32' ? constants.F_OK : constants.X_OK);
      if ((await stat(filename)).isFile()) return await realpath(filename);
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
      if (pending && typeof pending.then === 'function') pending.then(value => {
        if (typeof value === 'string') finish(null, value);
        else finish(null, value?.stdout || '', value?.stderr || '');
      }, error => finish(error));
    } catch (error) { finish(error); }
  });
}

async function findResources(executable, descriptor, platform, env) {
  const paths = platform === 'win32' ? path.win32 : path;
  const override = env[descriptor.resourcesVariable];
  const resourceOverride = typeof override === 'string' ? override.trim() : '';
  let candidates;
  if (resourceOverride) candidates = [paths.basename(resourceOverride).toLowerCase() === 'profiles' ? paths.dirname(resourceOverride) : resourceOverride];
  else if (platform === 'darwin' && /\.app[\\/]Contents[\\/]MacOS[\\/]/.test(executable)) {
    candidates = [paths.join(paths.dirname(executable), '..', 'Resources')];
  } else {
    const parent = paths.dirname(executable);
    candidates = [paths.join(parent, 'resources'), paths.join(parent, 'Resources'), paths.join(parent, '..', 'resources'),
      ...descriptor.resourceNames.map(name => paths.join(parent, '..', 'share', name)),
      ...(platform === 'linux' ? descriptor.resourceNames.flatMap(name => [`/usr/share/${name}`, `/usr/local/share/${name}`]) : [])];
  }
  for (const directory of candidates) {
    const profileDirectory = paths.join(directory, 'profiles');
    try {
      if ((await stat(profileDirectory)).isDirectory()) return { resourceDirectory: await realpath(directory), profileDirectory: await realpath(profileDirectory), profilesAvailable: true };
    } catch {}
  }
  return { resourceDirectory: null, profileDirectory: null, profilesAvailable: false };
}

/** Read-only identity and CLI capability detection, with no cross-engine
 * fallback. Missing/incompatible selected installations return unavailable. */
export async function probeSlicerEngine({ engineId = 'auto', slicerPath, slicerPaths = {}, execFileImpl = execFile, timeoutMs = 10000,
  platform = process.platform, env = process.env } = {}) {
  if (engineId === 'auto') {
    if (slicerPath !== undefined) {
      const unavailable = { id: 'auto', label: '本机切片器', engine: null, profileVendor: null, available: false,
        version: null, engineRevision: null, executablePath: null, resourceDirectory: null, profileDirectory: null,
        profilesAvailable: false, requiredCliFlagsSupported: false, missingCliFlags: [] };
      if (typeof slicerPath !== 'string' || !slicerPath.trim() || slicerPath.includes('\0')
        || typeof execFileImpl !== 'function' || !Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) {
        return { ...unavailable, reason: '本机切片器检测配置无效。' };
      }
      const executablePath = await resolveExecutable(slicerPath.trim(), platform, env);
      if (!executablePath) return { ...unavailable, reason: '指定路径未找到可执行的本机切片器。' };
      let help;
      try { help = await readHelp(executablePath, execFileImpl, timeoutMs); }
      catch { return { ...unavailable, executablePath, reason: '指定本机切片器的命令行检测没有完成。' }; }
      const actualId = /^\s*Bambu(?:Studio|[ -]Studio)[\s:v-]*\d/im.test(help) ? 'bambu'
        : DESCRIPTORS.orca.versionPattern.test(help) ? 'orca'
          : DESCRIPTORS.flash.versionPattern.test(help) ? 'flash' : null;
      if (!actualId) return { ...unavailable, executablePath, reason: '指定程序不是可识别的 Bambu Studio、OrcaSlicer 或 Flash Studio 命令行引擎。' };
      return probeSlicerEngine({ engineId: actualId, slicerPath: executablePath, execFileImpl: async () => help, timeoutMs, platform, env });
    }
    const registry = await probeLocalSlicers({ slicerPaths, execFileImpl, timeoutMs, platform, env });
    if (registry.preferredEngineId) return registry.availableRegistry[registry.preferredEngineId];
    return { id: 'auto', label: '本机切片器', engine: null, profileVendor: null, available: false,
      version: null, engineRevision: null, executablePath: null, resourceDirectory: null, profileDirectory: null,
      profilesAvailable: false, requiredCliFlagsSupported: false, missingCliFlags: [],
      reason: '未找到可用的本机切片器。请安装 Bambu Studio、OrcaSlicer 或 Flash Studio 后重试。' };
  }
  if (!LOCAL_SLICER_IDS.includes(engineId)) return { id: engineId, label: '未知切片器', engine: null, profileVendor: null,
    available: false, version: null, engineRevision: null, executablePath: null, resourceDirectory: null, profileDirectory: null,
    profilesAvailable: false, requiredCliFlagsSupported: false, missingCliFlags: [], reason: '切片引擎选项无效。' };
  const descriptor = DESCRIPTORS[engineId];
  const identity = { id: engineId, label: descriptor.label, engine: descriptor.engine, profileVendor: descriptor.profileVendor };
  if (engineId === 'bambu') return { ...await probeBambuEngine({ slicerPath, execFileImpl, timeoutMs, platform, env }), ...identity };
  const base = { ...identity, available: false, version: null, engineRevision: null, executablePath: null,
    resourceDirectory: null, profileDirectory: null, profilesAvailable: false, requiredCliFlagsSupported: false, missingCliFlags: [], reason: null };
  if (typeof execFileImpl !== 'function' || !Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) return { ...base, reason: `${descriptor.label} 检测配置无效。` };
  const explicit = slicerPath !== undefined || Boolean(env[descriptor.pathVariable]);
  const candidates = slicerPath !== undefined ? [slicerPath] : localSlicerCandidates(engineId, { platform, env });
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !candidate.trim() || candidate.includes('\0')) continue;
    const executablePath = await resolveExecutable(candidate.trim(), platform, env);
    if (!executablePath) continue;
    const identified = { ...base, executablePath };
    let help;
    try { help = await readHelp(executablePath, execFileImpl, timeoutMs); }
    catch (error) {
      return { ...identified, reason: error.killed || error.code === 'ETIMEDOUT'
        ? `${descriptor.label} 命令行检测超时，请确认本机安装可正常运行。`
        : `${descriptor.label} 命令行无法启动，请确认安装路径及可执行权限。` };
    }
    const version = help.match(descriptor.versionPattern)?.[1] || null;
    if (!version) return { ...identified, reason: `指定程序不是可识别的 ${descriptor.label} 命令行引擎；不会切换至其他切片器。` };
    const missingCliFlags = LOCAL_SLICER_REQUIRED_CLI_FLAGS.filter(flag => !new RegExp(`(?:^|\\s)${flag}(?=\\s|[=,]|$)`, 'm').test(help));
    const resources = await findResources(executablePath, descriptor, platform, env);
    let binaryIdentity;
    try {
      const info = await stat(executablePath);
      binaryIdentity = `${engineId}\0${executablePath}\0${version}\0${info.size}\0${info.mtimeMs}\0${info.ctimeMs}`;
    } catch { return { ...identified, ...resources, version, reason: `${descriptor.label} 在检测期间发生变化，请重新检测。` }; }
    const engineRevision = `${engineId}-${version}-${createHash('sha256').update(binaryIdentity).digest('hex').slice(0, 20)}`;
    return { ...identified, ...resources, version, engineRevision, missingCliFlags,
      available: missingCliFlags.length === 0, requiredCliFlagsSupported: missingCliFlags.length === 0,
      reason: missingCliFlags.length ? `此 ${descriptor.label} 版本缺少所需命令行参数：${missingCliFlags.join('、')}。` : null };
  }
  return { ...base, reason: explicit ? `指定路径未找到可执行的 ${descriptor.label}。请检查 ${descriptor.pathVariable}。`
    : `未找到用户本机的 ${descriptor.label}。请安装后重试，或通过 ${descriptor.pathVariable} 指定安装路径。` };
}

/** Discovery is concurrent. The resolved installation is a snapshot for the
 * job; a later slicing failure must not trigger a switch to another engine. */
export async function probeLocalSlicers({ slicerPaths = {}, ...options } = {}) {
  const engines = await Promise.all(LOCAL_SLICER_IDS.map(engineId => probeSlicerEngine({ ...options, engineId, slicerPath: slicerPaths[engineId] })));
  const availableRegistry = Object.fromEntries(engines.filter(engine => engine.available).map(engine => [engine.id, engine]));
  const preferredEngineId = LOCAL_SLICER_PREFERENCE.find(engineId => Object.hasOwn(availableRegistry, engineId)) || null;
  return { engines, availableRegistry, defaultEngineId: preferredEngineId, preferredEngineId };
}
