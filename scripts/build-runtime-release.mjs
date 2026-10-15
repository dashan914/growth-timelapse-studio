import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import JavaScriptObfuscator from 'javascript-obfuscator';

const execute = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeScripts = new Set(['install.mjs', 'install.sh', 'install.ps1', 'launch.mjs', 'check-runtime.mjs', 'windows-runtime.mjs', 'capture-cli.mjs', 'prepare-slice-project.py', 'prepare-support-project.py', 'render-cycles.py', 'calibration-uprights.py', 'zip-png-sequence.py']);
const guardedModules = new Set(['server.mjs', 'beta-activation.mjs', 'software-purchase.mjs', 'free-watermark.mjs', 'realistic-render.mjs', 'version-check.mjs', 'src/beta-access.js']);
const digest = value => createHash('sha256').update(value).digest('hex');

function selected(relative) {
  if (relative.startsWith('tests/') || relative.startsWith('vendor/test-dom/') || /(?:\.map|\.pem|\.key|\.p12|\.pfx|\.log|\.pyc)$/.test(relative)) return false;
  if (relative.startsWith('scripts/')) return runtimeScripts.has(relative.slice(8));
  // Keep the linked user guides, release records and demonstration media so
  // documentation remains usable after extracting or installing the runtime.
  if (relative.startsWith('docs/')) return true;
  return relative !== '.gitignore';
}

export async function buildRuntimeRelease({ root = projectRoot, output = path.join(projectRoot, 'release'), python = 'python3' } = {}) {
  root = path.resolve(root); output = path.resolve(output);
  if (root === output) throw new Error('发行目录不能覆盖源码根目录。');
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  if (pkg.name !== 'growth-timelapse-studio' || !/^[A-Za-z0-9][A-Za-z0-9.+-]{0,79}$/.test(pkg.version)) throw new Error('发行标识不正确。');
  const { stdout } = await execute(python, ['-c', "import json,runpy,sys; m=runpy.run_path(sys.argv[1]); print(json.dumps([str(p.relative_to(m['ROOT'])) for p in m['source_files']()]))", path.join(root, 'scripts/package-release.py')], { maxBuffer: 4 * 1024 * 1024 });
  const sourceFiles = JSON.parse(stdout).filter(selected).sort();
  await fs.mkdir(output, { recursive: true });
  const working = await fs.mkdtemp(path.join(output, '.runtime-'));
  const stageDirectory = path.join(working, pkg.name);
  await fs.mkdir(stageDirectory);
  const manifest = { name: pkg.name, version: pkg.version, kind: 'runtime', protection: 'light-obfuscation', sourceMaps: false, files: [] };
  for (const relative of sourceFiles) {
    if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) throw new Error('Unsafe release entry');
    let bytes = await fs.readFile(path.join(root, relative));
    let transformed = false;
    if (/\.(?:mjs|js)$/.test(relative) && !relative.startsWith('vendor/')) {
      const guarded = guardedModules.has(relative);
      const seed = createHash('sha256').update(pkg.version + ':' + relative).digest().readUInt32BE(0) || 1;
      const options = { compact: true, seed, target: relative.startsWith('src/') ? 'browser-no-eval' : 'node',
        renameGlobals: false, renameProperties: false, identifierNamesGenerator: 'hexadecimal',
        controlFlowFlattening: false, deadCodeInjection: false, debugProtection: false,
        selfDefending: false, disableConsoleOutput: false, sourceMap: false,
        stringArray: guarded, stringArrayThreshold: 0.5, stringArrayEncoding: ['base64'],
        stringArrayCallsTransform: false, splitStrings: false, transformObjectKeys: false,
        unicodeEscapeSequence: false, log: false };
      bytes = Buffer.from(JavaScriptObfuscator.obfuscate(bytes.toString('utf8'), options).getObfuscatedCode() + '\n');
      transformed = true;
    } else if (relative === 'package.json') {
      const runtimePackage = structuredClone(pkg);
      delete runtimePackage.devDependencies;
      runtimePackage.scripts = Object.fromEntries(Object.entries(runtimePackage.scripts || {}).filter(([name]) => ['start', 'doctor', 'check:runtime'].includes(name)));
      bytes = Buffer.from(JSON.stringify(runtimePackage, null, 2) + '\n');
    } else if (relative === 'package-lock.json') {
      const lock = JSON.parse(bytes);
      if (!lock.packages || lock.lockfileVersion !== 3) throw new Error('运行包需要 npm v3 lockfile。');
      delete lock.packages[''].devDependencies;
      for (const [name, item] of Object.entries(lock.packages)) if (name && item.dev === true) delete lock.packages[name];
      bytes = Buffer.from(JSON.stringify(lock, null, 2) + '\n');
    }
    const target = path.join(stageDirectory, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes, { mode: relative.endsWith('.command') ? 0o755 : 0o644 });
    manifest.files.push({ path: relative, bytes: bytes.length, sha256: digest(bytes), transformed });
  }
  const artifactName = `${pkg.name}-${pkg.version}-runtime.zip`;
  const archive = path.join(output, artifactName);
  const text = JSON.stringify(manifest, null, 2) + '\n';
  await fs.writeFile(path.join(stageDirectory, 'RUNTIME_MANIFEST.json'), text);
  await fs.writeFile(path.join(output, 'RUNTIME_MANIFEST.json'), text);
  await execute(python, ['-c', `import pathlib,sys,zipfile
root=pathlib.Path(sys.argv[1]); target=sys.argv[2]
with zipfile.ZipFile(target,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=9) as z:
 for p in sorted(root.rglob('*')):
  if p.is_symlink(): raise ValueError('Symlink in runtime')
  if not p.is_file(): continue
  relative=p.relative_to(root).as_posix()
  info=zipfile.ZipInfo(root.name+'/'+relative,date_time=(2026,10,11,0,0,0)); info.create_system=3
  info.external_attr=(0o100755 if p.suffix=='.command' else 0o100644)<<16; info.compress_type=zipfile.ZIP_DEFLATED
  z.writestr(info,p.read_bytes())`, stageDirectory, archive], { maxBuffer: 1024 * 1024 });
  const sha256 = digest(await fs.readFile(archive));
  await fs.writeFile(path.join(output, 'SHA256SUMS.txt'), `${sha256}  ${artifactName}\n`);
  return { archive, stageDirectory, manifest, sha256, files: manifest.files.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== '--output')) throw new Error('用法：node scripts/build-runtime-release.mjs [--output <发行目录>]');
    const result = await buildRuntimeRelease(args.length ? { output: args[1] } : {});
    console.log(JSON.stringify({ archive: result.archive, stageDirectory: result.stageDirectory, files: result.files, sha256: result.sha256 }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
