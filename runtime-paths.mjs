import { accessSync, constants, readdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { windowsInstalledExecutables, windowsLauncherPythonPaths } from './scripts/windows-runtime.mjs';

const moduleRoot = path.dirname(fileURLToPath(import.meta.url));
const BLENDER_VERSIONS = ['5.2', '5.1', '5.0', '4.5', '4.4', '4.3', '4.2', '4.1', '4.0', '3.6', '3.5', '3.4', '3.3', '3.2', '3.1', '3.0', '2.93'];

// These paths come only from trusted process configuration, never from HTTP.
export function resolveExecutablePath(candidate, { env = process.env, platform = process.platform } = {}) {
  if (typeof candidate !== 'string' || !candidate.trim()) return null;
  candidate = candidate.trim();
  const paths = platform === 'win32' ? path.win32 : path;
  const isCommand = !/[\\/]/.test(candidate);
  const folders = isCommand ? String(env.PATH || '').split(platform === 'win32' ? ';' : path.delimiter).filter(Boolean) : [''];
  const extensions = platform === 'win32' && !paths.extname(candidate)
    ? ['', ...String(env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean)] : [''];
  for (const folder of folders) for (const extension of extensions) {
    const filename = isCommand ? paths.join(folder, candidate + extension) : candidate + extension;
    try {
      accessSync(filename, platform === 'win32' ? constants.F_OK : constants.X_OK);
      if (statSync(filename).isFile()) return realpathSync.native(filename);
    } catch {}
  }
  return null;
}

function firstExecutable(candidates, options, accept = () => true) {
  for (const candidate of candidates) {
    const resolved = resolveExecutablePath(candidate, options);
    if (resolved && accept(resolved)) return resolved;
  }
  return null;
}

function configuredExecutable(variable, options) {
  const candidate = options.env[variable];
  return typeof candidate === 'string' && candidate.trim()
    ? resolveExecutablePath(candidate, options) || candidate.trim() : null;
}

export function findFFmpegPath({ env = process.env, platform = process.platform } = {}) {
  const options = { env, platform };
  return configuredExecutable('FFMPEG_PATH', options)
    || firstExecutable(['ffmpeg', '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'], options)
    || 'ffmpeg';
}

function scanSubdirectories(parent, prefix, joiner = path) {
  try {
    return readdirSync(parent, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && entry.name.toLowerCase().startsWith(prefix.toLowerCase()))
      .map(entry => entry.name)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map(name => joiner.join(parent, name));
  } catch { return []; }
}

export function blenderCandidates({ root, env = process.env, platform = process.platform } = {}) {
  if (typeof env.BLENDER_PATH === 'string' && env.BLENDER_PATH.trim()) return [env.BLENDER_PATH.trim()];
  const options = { env, platform };
  const candidates = ['blender'];
  if (platform === 'darwin') {
    candidates.push('/Applications/Blender.app/Contents/MacOS/Blender');
    if (env.HOME) candidates.push(path.join(env.HOME, 'Applications/Blender.app/Contents/MacOS/Blender'));
    for (const appRoot of ['/Applications', ...(env.HOME ? [path.join(env.HOME, 'Applications')] : [])]) {
      for (const bundle of scanSubdirectories(appRoot, 'Blender')) {
        if (bundle.toLowerCase().endsWith('.app')) candidates.push(path.join(bundle, 'Contents/MacOS/Blender'));
      }
    }
    if (env.HOME) candidates.push(path.join(env.HOME, 'Library/Application Support/Steam/steamapps/common/Blender/Blender.app/Contents/MacOS/Blender'));
    candidates.push('/opt/homebrew/bin/blender', '/usr/local/bin/blender');
  } else if (platform === 'win32') {
    candidates.push(...windowsInstalledExecutables('blender', options));
    const programRoots = [...new Set([
      env.ProgramFiles,
      env.ProgramW6432,
      env['ProgramFiles(x86)'],
      ...(process.platform === 'win32' ? ['C:\\Program Files', 'D:\\Program Files', 'E:\\Program Files', 'F:\\Program Files', 'G:\\Program Files', 'C:\\Program Files (x86)', 'D:\\Program Files (x86)'] : []),
    ].filter(Boolean))];
    for (const progRoot of programRoots) {
      const foundation = path.win32.join(progRoot, 'Blender Foundation');
      for (const dir of scanSubdirectories(foundation, 'Blender', path.win32)) {
        candidates.push(path.win32.join(dir, 'blender.exe'));
      }
      for (const ver of BLENDER_VERSIONS) {
        candidates.push(path.win32.join(foundation, `Blender ${ver}`, 'blender.exe'));
      }
      candidates.push(path.win32.join(progRoot, 'Steam', 'steamapps', 'common', 'Blender', 'blender.exe'));
    }
    if (process.platform === 'win32') {
      for (const drive of ['C:', 'D:', 'E:', 'F:', 'G:']) {
        candidates.push(
          path.win32.join(drive, '\\SteamLibrary\\steamapps\\common\\Blender\\blender.exe'),
          path.win32.join(drive, '\\Steam\\steamapps\\common\\Blender\\blender.exe'),
        );
      }
    }
    if (env.USERPROFILE) candidates.push(path.win32.join(env.USERPROFILE, 'scoop', 'apps', 'blender', 'current', 'blender.exe'));
    candidates.push('C:\\ProgramData\\chocolatey\\bin\\blender.exe');
  }
  // A previously prepared research runtime is an optional final fallback.
  if (root) {
    candidates.push(
      path.join(root, 'research/runtime/blender/Blender.app/Contents/MacOS/Blender'),
      path.resolve(root, '../../research/runtime/blender/Blender.app/Contents/MacOS/Blender'),
    );
  }
  return [...new Set(candidates)];
}

export function pythonCandidates({ env = process.env, platform = process.platform, root = moduleRoot } = {}) {
  if (typeof env.PYTHON_PATH === 'string' && env.PYTHON_PATH.trim()) return [env.PYTHON_PATH.trim()];
  if (platform !== 'win32') return ['python3', '/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3'];
  const candidates = [
    ...(env.VIRTUAL_ENV ? [path.win32.join(env.VIRTUAL_ENV, 'Scripts', 'python.exe')] : []),
    path.join(root, '.venv', 'Scripts', 'python.exe'), 'python3', 'python',
    ...windowsLauncherPythonPaths({ env, platform }), ...windowsInstalledExecutables('python', { env, platform }),
  ];
  const pythonParentDirs = [
    ...(env.LOCALAPPDATA ? [path.win32.join(env.LOCALAPPDATA, 'Programs', 'Python')] : []),
    ...(env.USERPROFILE ? [path.win32.join(env.USERPROFILE, 'AppData', 'Local', 'Programs', 'Python')] : []),
    ...(process.platform === 'win32' ? ['C:\\'] : []),
  ];
  const pyVers = ['313', '312', '311', '310', '39'];
  for (const parent of pythonParentDirs) {
    for (const dir of scanSubdirectories(parent, 'Python3', path.win32)) {
      candidates.push(path.win32.join(dir, 'python.exe'));
    }
    for (const ver of pyVers) {
      candidates.push(path.win32.join(parent, `Python${ver}`, 'python.exe'));
    }
  }
  for (const blenderExe of blenderCandidates({ root, env, platform })) {
    if (!/[\\/]/.test(blenderExe)) continue;
    const blenderDir = path.win32.dirname(blenderExe);
    for (const sub of scanSubdirectories(blenderDir, '', path.win32)) {
      if (/^\d+\.\d+$/.test(path.win32.basename(sub))) {
        candidates.push(path.win32.join(sub, 'python', 'bin', 'python.exe'));
      }
    }
    const verMatch = blenderDir.match(/Blender\s+(\d+\.\d+)/i);
    for (const ver of verMatch ? [verMatch[1], ...BLENDER_VERSIONS] : BLENDER_VERSIONS.slice(0, 8)) {
      candidates.push(path.win32.join(blenderDir, ver, 'python', 'bin', 'python.exe'));
    }
  }
  return [...new Set(candidates)];
}

export function findPythonPath({ env = process.env, platform = process.platform, root = moduleRoot } = {}) {
  const options = { env, platform };
  return configuredExecutable('PYTHON_PATH', options)
    || firstExecutable(pythonCandidates({ ...options, root }), options,
      filename => platform !== 'win32' || !/[\\/]Microsoft[\\/]WindowsApps[\\/]python(?:3)?\.exe$/i.test(filename)) || 'python3';
}

export function findBlenderPath({ root, env = process.env, platform = process.platform } = {}) {
  const options = { env, platform };
  const override = configuredExecutable('BLENDER_PATH', options);
  if (override) return override;
  return firstExecutable(blenderCandidates({ root, env, platform }), options) || 'blender';
}
