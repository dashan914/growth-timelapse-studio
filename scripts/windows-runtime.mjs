import { execFile, execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const worker = fileURLToPath(new URL('./capture-cli.mjs', import.meta.url));
const registryScript = `$ProgressPreference = 'SilentlyContinue'
$OutputEncoding = [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$roots = @('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*')
@(Get-ItemProperty -Path $roots -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match 'Bambu Studio|Blender|Orca|Flash Studio|Python' } | Select-Object DisplayName,InstallLocation,DisplayIcon) | ConvertTo-Json -Compress`;
let registryCache;
let pythonCache;

function hostEnvironment(env, platform) {
  return platform === 'win32' && process.platform === 'win32'
    && env.SystemRoot === process.env.SystemRoot && Boolean(env.SystemRoot);
}

export function readWindowsInstallations({ env = process.env, platform = process.platform } = {}) {
  if (!hostEnvironment(env, platform)) return [];
  if (registryCache) return registryCache;
  try {
    const powershell = path.win32.join(env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const output = execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(registryScript, 'utf16le').toString('base64')],
      { env, encoding: 'utf8', timeout: 5000, maxBuffer: 256 * 1024, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const records = JSON.parse(output.trim() || '[]');
    registryCache = (Array.isArray(records) ? records : [records]).filter(record => record && typeof record.DisplayName === 'string');
  } catch { registryCache = []; }
  return registryCache;
}

const applications = {
  bambu: { name: /Bambu\s*Studio/i, files: ['bambu-studio.exe', 'BambuStudio.exe'] },
  orca: { name: /Orca(?:\s*Slicer|Slicer)/i, files: ['orca-slicer.exe', 'OrcaSlicer.exe'] },
  flash: { name: /Flash\s*Studio|Orca[- ]Flashforge/i, files: ['Flash Studio.exe', 'orca-flashforge.exe'] },
  blender: { name: /^Blender(?:\s|$)/i, files: ['blender.exe'] },
  python: { name: /^Python\s+3\./i, files: ['python.exe'] },
};

export function windowsInstalledExecutables(application, { env = process.env, platform = process.platform, readRegistry = readWindowsInstallations } = {}) {
  if (platform !== 'win32' || !applications[application]) return [];
  const descriptor = applications[application], candidates = [];
  for (const record of readRegistry({ env, platform })) {
    if (!descriptor.name.test(record.DisplayName || '')) continue;
    if (typeof record.InstallLocation === 'string' && record.InstallLocation.trim()) {
      candidates.push(...descriptor.files.map(file => path.win32.join(record.InstallLocation.trim().replace(/^"|"$/g, ''), file)));
    }
    if (typeof record.DisplayIcon === 'string') {
      const icon = record.DisplayIcon.trim().replace(/,\s*-?\d+$/, '').replace(/^"|"$/g, '');
      if (path.win32.isAbsolute(icon) && descriptor.files.some(file => path.win32.basename(icon).toLowerCase() === file.toLowerCase())) candidates.push(icon);
    }
  }
  return [...new Set(candidates)];
}

export function windowsLauncherPythonPaths({ env = process.env, platform = process.platform } = {}) {
  if (!hostEnvironment(env, platform)) return [];
  if (pythonCache) return pythonCache;
  try {
    const output = execFileSync('py.exe', ['-0p'], { env, encoding: 'utf8', timeout: 3000, maxBuffer: 64 * 1024, windowsHide: true, shell: false });
    pythonCache = output.split(/\r?\n/).map(line => line.match(/([A-Za-z]:\\.*?python(?:\d+(?:\.\d+)*)?\.exe)\s*$/i)?.[1]).filter(Boolean);
  } catch { pythonCache = []; }
  return pythonCache;
}

// GUI slicer launchers may reopen CONOUT$ after AttachConsole, discarding pipes.
// A console-free parent keeps their inherited stdout/stderr pipes intact.
export function execFileWithConsoleCapture(filename, args, options, callback) {
  if (process.platform !== 'win32') return execFile(filename, args, options, callback);
  const request = JSON.stringify({ filename, args, timeout: options.timeout, maxBuffer: options.maxBuffer, cwd: options.cwd });
  const child = spawn(process.execPath, [worker, request], { cwd: options.cwd, env: options.env,
    shell: false, detached: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', bytes = 0, settled = false;
  const finish = (error, output = '', errors = '') => {
    if (settled) return;
    settled = true; clearTimeout(timer); callback(error, output, errors);
  };
  const timer = setTimeout(() => {
    child.kill(); finish(Object.assign(new Error('CLI capture timed out'), { code: 'ETIMEDOUT', killed: true }));
  }, (options.timeout || 10000) + 2000);
  const collect = (data, target) => {
    bytes += data.length;
    if (bytes > (options.maxBuffer || 2 * 1024 * 1024) * 6) {
      child.kill(); finish(Object.assign(new Error('CLI capture exceeded maxBuffer'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: true }));
    } else if (target === 'stdout') stdout += data; else stderr += data;
  };
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', data => collect(data, 'stdout')); child.stderr.on('data', data => collect(data, 'stderr'));
  child.once('error', error => finish(error));
  child.once('close', code => {
    if (settled) return;
    if (code !== 0) { finish(Object.assign(new Error('CLI capture worker failed'), { code }), stdout, stderr); return; }
    try {
      const result = JSON.parse(stdout);
      const failure = result.error ? Object.assign(new Error(result.error.message), result.error) : null;
      finish(failure, result.stdout, result.stderr);
    } catch (failure) { finish(failure, '', stderr); }
  });
  return child;
}
