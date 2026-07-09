#!/usr/bin/env bash
# ============================================================
# CityTwin 服务器部署脚本 —— 在你的服务器上执行（首次或更新都用它）
#
# 用法（SSH 登录服务器后）：
#   curl -fsSL https://raw.githubusercontent.com/webergithub/weber-hello-world/claude/3d-hideandseek-game-8vw4y9/deploy/deploy-on-server.sh | bash
# 或克隆后：
#   bash deploy/deploy-on-server.sh [目标目录] [端口]
#
# 默认：目标目录 ~/citytwin，端口 8080（纯静态文件，python3 即可托管；
# 有 nginx 时把目标目录设为站点 root 即可，无需端口）
# ============================================================
set -euo pipefail

REPO="https://github.com/webergithub/weber-hello-world.git"
BRANCH="claude/3d-hideandseek-game-8vw4y9"
TARGET="${1:-$HOME/citytwin}"
PORT="${2:-8080}"

echo "==> 部署 CityTwin 到 $TARGET (分支 $BRANCH)"

if [ -d "$TARGET/.git" ]; then
  git -C "$TARGET" fetch origin "$BRANCH"
  git -C "$TARGET" checkout -B "$BRANCH" "origin/$BRANCH"
else
  git clone --depth 1 -b "$BRANCH" "$REPO" "$TARGET"
fi

echo "==> 文件就绪：$TARGET/index.html"

if command -v nginx >/dev/null 2>&1; then
  cat <<NGINX

检测到 nginx。把下面的片段加进你的 server 配置即可（无需其他步骤）：

    location /citytwin/ {
        alias $TARGET/;
        index index.html;
    }

NGINX
else
  echo "==> 未检测到 nginx，用 python3 起一个静态服务（Ctrl+C 停止）："
  echo "    cd $TARGET && nohup python3 -m http.server $PORT >/dev/null 2>&1 &"
  echo ""
  echo "⚠️ Oracle Cloud (opc) 用户注意：还需放行端口 $PORT —"
  echo "   1) 控制台 VCN 安全列表加一条 Ingress 规则：TCP $PORT, 源 0.0.0.0/0"
  echo "   2) 服务器防火墙： sudo firewall-cmd --permanent --add-port=$PORT/tcp && sudo firewall-cmd --reload"
  echo ""
  read -r -p "现在就启动 python3 静态服务吗？[y/N] " yn || true
  if [[ "${yn:-n}" =~ ^[Yy]$ ]]; then
    cd "$TARGET"
    nohup python3 -m http.server "$PORT" >/dev/null 2>&1 &
    echo "==> 已启动：http://$(curl -s ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}'):$PORT"
  fi
fi

echo "==> 完成。浏览器打开站点即可游玩 CityTwin 🙈"
