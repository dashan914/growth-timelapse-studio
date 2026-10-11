#!/bin/bash
set -e
cd "$(dirname "$0")"
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"

if ! command -v node >/dev/null 2>&1; then
  echo "没有找到 Node.js。请先安装 Node.js 22 或更新版本，推荐 Node.js 24 LTS。"
  read -r -p "按回车关闭…" _growth_reply
  exit 1
fi
if ! node -e 'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1)'; then
  echo "需要 Node.js 22 或更新版本，推荐 Node.js 24 LTS。"
  read -r -p "按回车关闭…" _growth_reply
  exit 1
fi
if ! node --input-type=module -e 'import { findFFmpegPath, resolveExecutablePath } from "./runtime-paths.mjs"; if (!resolveExecutablePath(findFFmpegPath())) process.exit(1)'; then
  echo "没有找到 FFmpeg。仍可导出透明 PNG 序列；MP4 需要安装 FFmpeg 或设置 FFMPEG_PATH。"
fi
if [ ! -f "node_modules/three/build/three.module.js" ]; then
  echo "正在安装模型预览依赖…"
  npm ci --no-audit --no-fund
fi

growth_port="${PORT:-4317}"
growth_url="http://127.0.0.1:${growth_port}"
# Reuse a running instance only when it identifies itself as this workbench.
if command -v curl >/dev/null 2>&1; then
  growth_health="$(curl --max-time 2 -fsS "$growth_url/api/health" 2>/dev/null || true)"
  if printf '%s' "$growth_health" | node -e 'let s=""; process.stdin.on("data",c=>s+=c); process.stdin.on("end",()=>{try {const h=JSON.parse(s);process.exit(h.ok===true&&typeof h.ffmpeg?.available==="boolean"?0:1)}catch{process.exit(1)}})'; then
    echo "工作台已经启动：$growth_url"
    if command -v open >/dev/null 2>&1; then open "$growth_url"; fi
    exit 0
  fi
fi

echo "正在启动模型生长延时工作台…"
node server.mjs &
growth_server_pid=$!
trap 'kill "$growth_server_pid" 2>/dev/null || true' EXIT INT TERM
growth_ready=false
for _growth_attempt in {1..50}; do
  if ! kill -0 "$growth_server_pid" 2>/dev/null; then
    wait "$growth_server_pid" || true
    read -r -p "启动失败，按回车关闭…" _growth_reply
    exit 1
  fi
  if curl --max-time 1 -fsS "$growth_url/api/health" >/dev/null 2>&1; then
    growth_ready=true
    break
  fi
  sleep 0.2
done
if [ "$growth_ready" = true ]; then
  if command -v open >/dev/null 2>&1; then open "$growth_url"; fi
  echo "关闭这个终端窗口即可停止工作台。导出的视频保存在 exports 文件夹。"
else
  echo "服务启动较慢，可手动打开：$growth_url"
fi
wait "$growth_server_pid"
