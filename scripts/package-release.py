#!/usr/bin/env python3
"""Create a source release from an explicit allowlist, without local artifacts."""
import argparse
import hashlib
import json
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parent.parent
FILES = (
    'index.html', 'package.json', 'package-lock.json', 'README.md', 'LICENSE',
    'THIRD_PARTY_NOTICES.md', '.gitignore', 'start.command', '启动生长延时.command',
    'server.mjs', 'runtime-paths.mjs', 'bambu-engine.mjs', 'slicer-engine.mjs',
    'slice-jobs.mjs', 'support-jobs.mjs', 'realistic-render.mjs',
    'photo-calibration.mjs', 'export-codecs.mjs', 'export-sound.mjs',
    'beta-activation.mjs', 'software-purchase.mjs', 'free-watermark.mjs', 'version-check.mjs', 'beta-config.json', 'INSTALL_AGENT.md', 'install-manifest.json', 'start.cmd',
    'assets/shandi-logo.svg', 'assets/free-watermark.png',
    'assets/sounds/reference-original.wav', 'assets/sounds/SOURCES.md',
)
DIRECTORIES = ('src', 'scripts', 'tests', 'docs', 'examples', 'vendor')
BACKGROUNDS = ('h2c.jpg', 'p1s.jpg', 'a1.jpg', 'pastel-rug.png', 'blue-grey.png', 'teal-room.png')
EXCLUDED_PARTS = {'node_modules', 'research', 'exports', 'samples', 'candidates', '__pycache__', '.git', 'release', 'test-results', '.DS_Store', 'Thumbs.db', '.venv', 'venv', '.idea', '.vscode', '.codex', '.agents', '.aws', 'private-beta', 'integration-work'}


def source_files():
    selected = [ROOT / filename for filename in FILES]
    selected.extend(ROOT / 'assets/backgrounds' / filename for filename in BACKGROUNDS)
    for directory in DIRECTORIES:
        if not (ROOT / directory).is_dir():
            raise FileNotFoundError('Required release directory is missing: ' + directory)
        selected.extend(item for item in (ROOT / directory).rglob('*') if item.is_file())
    result = []
    for filename in selected:
        relative = filename.relative_to(ROOT)
        if any(part in EXCLUDED_PARTS or part.startswith('.slice-') or part.startswith('.support-') or part.startswith('.realistic-') for part in relative.parts):
            continue
        if filename.name.startswith(('.env', '._')) or filename.suffix in ('.pyc', '.log', '.zip', '.pem', '.key', '.p12', '.pfx'):
            continue
        if filename.is_symlink():
            raise ValueError('A source release must not include symlinks: ' + str(relative))
        if not filename.is_file():
            raise FileNotFoundError('Required release file is missing: ' + str(relative))
        result.append(filename)
    return sorted(set(result), key=lambda item: item.relative_to(ROOT).as_posix())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT / 'release')
    args = parser.parse_args()
    package = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))
    name, version = package['name'], package['version']
    if any('/' in value or '\\' in value or '..' in value for value in (name, version)):
        raise ValueError('Unsafe package name or version.')
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    archive_path = output / f'{name}-{version}-source.zip'
    manifest = {'name': name, 'version': version, 'kind': 'source', 'files': []}
    with zipfile.ZipFile(archive_path, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for filename in source_files():
            relative = filename.relative_to(ROOT).as_posix()
            payload = filename.read_bytes()
            metadata = zipfile.ZipInfo(name + '/' + relative, date_time=(2026, 10, 11, 0, 0, 0))
            metadata.create_system = 3
            executable = filename.suffix == '.command'
            metadata.external_attr = (0o100755 if executable else 0o100644) << 16
            metadata.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(metadata, payload)
            manifest['files'].append({'path': relative, 'bytes': len(payload), 'sha256': hashlib.sha256(payload).hexdigest()})
        metadata = zipfile.ZipInfo(name + '/SOURCE_MANIFEST.json', date_time=(2026, 10, 11, 0, 0, 0))
        metadata.create_system = 3
        metadata.external_attr = 0o100644 << 16
        metadata.compress_type = zipfile.ZIP_DEFLATED
        archive.writestr(metadata, json.dumps(manifest, ensure_ascii=False, indent=2).encode('utf-8'))
    checksum = hashlib.sha256(archive_path.read_bytes()).hexdigest()
    (output / 'SHA256SUMS.txt').write_text(checksum + '  ' + archive_path.name + '\n', encoding='utf-8')
    (output / 'SOURCE_MANIFEST.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'archive': str(archive_path), 'files': len(manifest['files']), 'sourceBytes': sum(item['bytes'] for item in manifest['files']), 'archiveBytes': archive_path.stat().st_size, 'sha256': checksum}, ensure_ascii=False))


if __name__ == '__main__':
    main()
