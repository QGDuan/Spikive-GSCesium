#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
if [ ! -d node_modules ]; then
  echo "尚未安装运行依赖，请先执行 ./install.sh"
  exit 1
fi

export HOST="${HOST:-0.0.0.0}"
export PORT="${PORT:-3000}"
export DATA_DIR="${DATA_DIR:-var}"

echo "Spikive GS Inspector 正在启动：http://localhost:${PORT}"
exec npm run server
