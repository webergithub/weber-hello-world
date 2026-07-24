#!/bin/bash
# ============================================================
# CityTwin 一键部署（在你自己的 Mac / Linux 上运行）
# 作用：在 $BASE 下建 CityTwin 文件夹 → 拉取最新代码
#       → rsync 部署到 opc 服务器 → 远程验证
#
# 用法（BASE 指定放在哪个目录下，缺省为 $HOME）：
#   BASE="/Users/you/somewhere" bash mac-deploy.sh
# 或直接从 GitHub 拉起：
#   BASE="/Users/you/somewhere" \
#     bash <(curl -fsSL https://raw.githubusercontent.com/webergithub/weber-hello-world/claude/3d-hideandseek-game-8vw4y9/deploy/mac-deploy.sh)
# 私钥找不到时手动指定：
#   KEY="/path/to/ssh-key-2026-05-05.key" BASE="..." bash mac-deploy.sh
# ============================================================
set -e

BASE="${BASE:-$HOME}"
DIR="$BASE/CityTwin"
BRANCH="claude/3d-hideandseek-game-8vw4y9"
REPO="https://github.com/webergithub/weber-hello-world.git"
SRV="${SRV:-ubuntu@145.241.235.191}"
DEST="${DEST:-/home/ubuntu/website/citytwin}"

# 1) 定位 SSH 私钥（自动搜索 $HOME 与已挂载盘；找不到用 KEY=... 指定）
KEY="${KEY:-$(find "$HOME" /Volumes -name 'ssh-key-2026-05-05.key' 2>/dev/null | head -1)}"
if [ -z "$KEY" ] || [ ! -f "$KEY" ]; then
  echo "❌ 未找到私钥 ssh-key-2026-05-05.key。"
  echo "   从 Google Drive 的 0_publicfolder 下载后，用 KEY=/私钥/路径 重跑本脚本。"
  exit 1
fi
chmod 600 "$KEY"
echo "🔑 使用私钥：$KEY"

# 2) 建文件夹 + 拉取最新代码
mkdir -p "$DIR" && cd "$DIR"
if [ -d .git ]; then
  git fetch origin "$BRANCH"
  git checkout -B "$BRANCH" "origin/$BRANCH"
  git reset --hard "origin/$BRANCH"
else
  git clone -b "$BRANCH" "$REPO" .
fi
echo "📦 代码就绪：$DIR ($(git rev-parse --short HEAD))"

# 3) 部署（rsync over SSH）
SSH="ssh -i $KEY -o StrictHostKeyChecking=no"
$SSH "$SRV" "mkdir -p $DEST"
rsync -avz -e "$SSH" index.html game.js cities.js lib data README.md "$SRV:$DEST/"

# 4) 验证
$SSH "$SRV" "ls -lh $DEST/index.html && echo VERIFY_OK"
echo ""
echo "✅ 部署完成 → http://145.241.235.191/citytwin/"
