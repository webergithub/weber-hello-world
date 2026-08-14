#!/usr/bin/env bash
# 一键启动网页版压缩包密码恢复工具。
# 用法：  ./run.sh          启动网页应用
#         ./run.sh 文件.rar  直接命令行破解某个包
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v python3 >/dev/null 2>&1; then
  echo "❌ 未找到 python3，请先安装 Python 3。"; exit 1
fi

# 友好提示：检查 RAR 后端
if ! command -v unrar >/dev/null 2>&1 && ! command -v 7z >/dev/null 2>&1 && ! command -v 7zz >/dev/null 2>&1; then
  echo "⚠️  未检测到 unrar / 7z。若要处理 RAR，请先安装："
  echo "      macOS:  brew install unrar"
  echo "      Ubuntu: sudo apt install unrar"
  echo ""
fi

if [ "$#" -ge 1 ]; then
  exec python3 recover.py "$@"
else
  exec python3 serve.py
fi
