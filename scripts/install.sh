#!/bin/bash
# macOS bootstrap: private Node runtime only; all other work is in install.mjs.
set -euo pipefail
growth_script_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
growth_root="${GROWTH_DATA_DIR:-$HOME/Library/Application Support/GrowthTimelapseStudio}"
growth_manifest="$growth_script_dir/../install-manifest.json"
growth_dry_run=false
growth_no_runtime_install=false
for growth_arg in "$@"; do
  if [ "$growth_arg" = '--dry-run' ]; then growth_dry_run=true; fi
  if [ "$growth_arg" = '--no-runtime-install' ]; then growth_no_runtime_install=true; fi
done
if [ "$(uname -s)" != 'Darwin' ]; then
  echo '此入口用于 macOS；Windows 请运行 scripts/install.ps1。' >&2
  exit 2
fi
growth_node="$(command -v node || true)"
if [ -n "$growth_node" ] && "$growth_node" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)'; then
  exec "$growth_node" "$growth_script_dir/install.mjs" "$@"
fi
if [ "$growth_dry_run" = true ]; then
  echo 'DRY RUN: 未找到 Node.js 24+；将校验并下载官方 Node.js 24.19.0 到用户数据目录，再运行安装器。'
  exit 0
fi
if [ "$growth_no_runtime_install" = true ]; then
  echo '未找到 Node.js 24+；--no-runtime-install 已禁止安装本机依赖。' >&2
  exit 1
fi
# Avoid provisioning Node for a release which is not actually available.
growth_local_source=false
growth_previous=''
for growth_arg in "$@"; do
  if [ "$growth_previous" = '--source' ]; then growth_local_source=true; fi
  if [ "$growth_previous" = '--install-root' ]; then growth_root="$growth_arg"; fi
  if [ "$growth_previous" = '--manifest' ]; then growth_manifest="$growth_arg"; fi
  growth_previous="$growth_arg"
done
if [ "$growth_local_source" = false ] && [ "$(plutil -extract release.published raw -o - "$growth_manifest")" != 'true' ]; then
  echo '内测安装包尚未发布。维护者可用 --source 指定本地源码验证；不会下载 main 分支代替发行包。' >&2
  exit 2
fi
growth_arch="$(uname -m)"
case "$growth_arch" in
  arm64) growth_sha='8294b7aa9b03997481c06babf1e8b270c859358f27da57a11509afe537ac381d' ;;
  x86_64) growth_arch='x64'; growth_sha='d1b5e999db158c62fe8f7267a4476b035d8bd93b1a605bac24a3f0dd166e3316' ;;
  *) echo "不支持的 CPU：$growth_arch" >&2; exit 2 ;;
esac
growth_runtime="$growth_root/runtimes/node/24.19.0/darwin-$growth_arch"
growth_node="$growth_runtime/bin/node"
if [ ! -x "$growth_node" ]; then
  mkdir -p "$growth_root/cache" "$growth_root/runtimes/node/24.19.0"
  growth_archive="$growth_root/cache/node-v24.19.0-darwin-$growth_arch.tar.gz"
  if [ ! -f "$growth_archive" ] || [ "$(shasum -a 256 "$growth_archive" | cut -d ' ' -f 1)" != "$growth_sha" ]; then
    curl --fail --location --retry 3 --proto '=https' --tlsv1.2 --output "$growth_archive.part" "https://nodejs.org/dist/v24.19.0/node-v24.19.0-darwin-$growth_arch.tar.gz"
    if [ "$(shasum -a 256 "$growth_archive.part" | cut -d ' ' -f 1)" != "$growth_sha" ]; then
      rm -f -- "$growth_archive.part"
      echo 'Node.js SHA256 校验失败，已停止。' >&2
      exit 1
    fi
    mv -- "$growth_archive.part" "$growth_archive"
  fi
  growth_stage="$(mktemp -d "$growth_root/runtimes/node/24.19.0/.stage-XXXXXX")"
  tar -xzf "$growth_archive" -C "$growth_stage" --strip-components=1
  mv -- "$growth_stage" "$growth_runtime"
fi
export PATH="$growth_runtime/bin:$PATH"
exec "$growth_node" "$growth_script_dir/install.mjs" "$@"
