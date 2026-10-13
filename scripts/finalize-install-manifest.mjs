import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applicationId, sha256File, validateManifest } from './install.mjs';

export async function finalizeInstallManifest({ archive, template, output, repository } = {}) {
  if (!archive) throw new Error('请用 --archive 指定已生成的发行 ZIP。');
  archive = path.resolve(archive);
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const templateFile = path.resolve(template || path.join(root, 'install-manifest.json'));
  const manifest = JSON.parse(await fs.readFile(templateFile, 'utf8'));
  validateManifest(manifest, true);
  if (!['source', 'runtime'].some(kind => path.basename(archive) === `${applicationId}-${manifest.release.version}-${kind}.zip`)) throw new Error('发行包名称与固定版本不一致。');
  const selectedRepository = repository || manifest.release.repository;
  if (!['dashan914/growth-timelapse-studio', 'dashan914/growth-timelapse-studio-beta'].includes(selectedRepository)) throw new Error('发行仓库不在固定允许范围。');
  const handle = await fs.open(archive, 'r');
  try {
    const magic = Buffer.alloc(4);
    await handle.read(magic, 0, 4, 0);
    if (!magic.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) throw new Error('文件不是源码 ZIP。');
  } finally { await handle.close(); }
  manifest.release = {
    ...manifest.release,
    repository: selectedRepository,
    kind: path.basename(archive).endsWith('-runtime.zip') ? 'runtime' : 'source',
    published: true,
    url: `https://github.com/${selectedRepository}/releases/download/${manifest.release.tag}/${path.basename(archive)}`,
    sha256: await sha256File(archive),
  };
  validateManifest(manifest);
  const outputFile = path.resolve(output || path.join(path.dirname(archive), 'install-manifest.json'));
  if (outputFile === templateFile) throw new Error('外部发行清单不能覆盖仓库内模板。');
  if (outputFile === archive) throw new Error('外部发行清单不能覆盖源码包。');
  await fs.mkdir(path.dirname(outputFile), { recursive: true });
  await fs.writeFile(outputFile, JSON.stringify(manifest, null, 2) + '\n');
  return { path: outputFile, manifest };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = {};
    for (let index = 0; index < process.argv.slice(2).length; index++) {
      const args = process.argv.slice(2), arg = args[index];
      if (!['--archive', '--template', '--output', '--repository'].includes(arg) || !args[index + 1]) throw new Error('用法：node scripts/finalize-install-manifest.mjs --archive <版本源码ZIP> [--output <外部清单>] [--repository dashan914/growth-timelapse-studio-beta]');
      options[arg.slice(2)] = args[++index];
    }
    const result = await finalizeInstallManifest(options);
    console.log(`已生成待上传的外部发行清单：${result.path}\n发行包 SHA256：${result.manifest.release.sha256}\n此命令不会创建或发布 GitHub Release；安装器会核对实际下载文件。`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
