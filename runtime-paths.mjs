import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { windowsInstalledExecutables, windowsLauncherPythonPaths } from './scripts/windows-runtime.mjs';

const moduleRoot = path.dirname(fileURLToPath(import.meta.url));

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

export function pythonCandidates({ env = process.env, platform = process.platform, root = moduleRoot } = {}) {
  if (typeof env.PYTHON_PATH === 'string' && env.PYTHON_PATH.trim()) return [env.PYTHON_PATH.trim()];
  return platform === 'win32' ? [
    ...(env.VIRTUAL_ENV ? [path.win32.join(env.VIRTUAL_ENV, 'Scripts', 'python.exe')] : []),
    path.join(root, '.venv', 'Scripts', 'python.exe'), 'python3', 'python',
    ...windowsLauncherPythonPaths({ env, platform }), ...windowsInstalledExecutables('python', { env, platform }),
  ]
    : ['python3', '/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3'];
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
  const applications = platform === 'darwin'
    ? ['/Applications/Blender.app/Contents/MacOS/Blender', ...(env.HOME ? [path.join(env.HOME, 'Applications/Blender.app/Contents/MacOS/Blender')] : [])]
    : platform === 'win32' ? windowsInstalledExecutables('blender', options) : [];
  // A previously prepared research runtime is an optional final fallback.
  const legacy = root ? [path.join(root, 'research/runtime/blender/Blender.app/Contents/MacOS/Blender')] : [];
  return firstExecutable(['blender', ...applications, ...legacy], options) || 'blender';
}
