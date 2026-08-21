#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "未找到 Node.js，请先安装 Node.js 22.22.1 或更高版本。"
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "未找到 npm，请重新安装包含 npm 的 Node.js。"
  exit 1
fi

node -e 'const [major,minor,patch]=process.versions.node.split(".").map(Number);if(major<22||(major===22&&(minor<22||(minor===22&&patch<1)))){console.error(`当前 Node.js ${process.versions.node}，需要 22.22.1 或更高版本。`);process.exit(1)}'

echo "正在安装运行依赖，请保持网络连接…"
npm ci --omit=dev --workspace @spikive/server --workspace @spikive/shared --include-workspace-root
mkdir -p var
echo "安装完成。请执行 ./start.sh，然后访问 http://localhost:${PORT:-3000}"
