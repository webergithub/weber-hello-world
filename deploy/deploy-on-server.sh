#!/usr/bin/env bash
# ============================================================
# CityTwin 服务器部署脚本（Oracle Cloud / 通用 Linux）
# 在你的服务器上执行（首次或更新都用它）：
#
#   curl -fsSL https://raw.githubusercontent.com/webergithub/weber-hello-world/claude/3d-hideandseek-game-8vw4y9/deploy/deploy-on-server.sh | bash
#
# 功能：
#   1. 克隆/更新游戏代码
#   2. 未安装 nginx 时自动安装并启动（dnf/yum/apt 自动识别）
#   3. 部署到 /var/www/citytwin 并配置 nginx location /citytwin/
#   4. 放行 80 端口（firewalld/ufw + 提示 Oracle Cloud 安全列表）
#   5. 安装主页"孪生"模块卡片示例（deploy/homepage-card.html）
# ============================================================
set -euo pipefail

REPO="https://github.com/webergithub/weber-hello-world.git"
BRANCH="claude/3d-hideandseek-game-8vw4y9"
SRC="$HOME/.citytwin-src"
WEBROOT="/var/www/citytwin"

SUDO=""
[ "$(id -u)" -ne 0 ] && SUDO="sudo"

echo "==> [1/5] 拉取 CityTwin 代码 (分支 $BRANCH)"
if [ -d "$SRC/.git" ]; then
  git -C "$SRC" fetch origin "$BRANCH"
  git -C "$SRC" checkout -B "$BRANCH" "origin/$BRANCH"
else
  git clone --depth 1 -b "$BRANCH" "$REPO" "$SRC"
fi

echo "==> [2/5] 检查 / 安装 nginx"
if ! command -v nginx >/dev/null 2>&1; then
  if command -v dnf >/dev/null 2>&1; then $SUDO dnf install -y nginx
  elif command -v yum >/dev/null 2>&1; then $SUDO yum install -y nginx
  elif command -v apt-get >/dev/null 2>&1; then $SUDO apt-get update -y && $SUDO apt-get install -y nginx
  else echo "!! 未识别的包管理器，请手动安装 nginx"; exit 1
  fi
fi
$SUDO systemctl enable --now nginx

echo "==> [3/5] 部署静态文件到 $WEBROOT"
$SUDO mkdir -p "$WEBROOT"
$SUDO cp -f "$SRC/index.html" "$SRC/game.js" "$SRC/cities.js" "$WEBROOT/"
$SUDO cp -rf "$SRC/lib" "$WEBROOT/"
$SUDO cp -f "$SRC/deploy/homepage-card.html" "$WEBROOT/homepage-card.html" 2>/dev/null || true
# SELinux（Oracle Linux 默认开启）：允许 nginx 读取
if command -v restorecon >/dev/null 2>&1; then $SUDO restorecon -R "$WEBROOT" || true; fi

echo "==> [4/5] 配置 nginx location /citytwin/"
CONF_DIR="/etc/nginx/conf.d"
[ -d /etc/nginx/sites-enabled ] && CONF_DIR="/etc/nginx/conf.d" # debian 系也支持 conf.d
$SUDO tee "$CONF_DIR/citytwin.conf" >/dev/null <<'NGINX'
# CityTwin —— 挂载到已有站点的 /citytwin/ 路径
# 如果你的主页在默认 server 里，这个 location 会自动生效；
# 如果主页在自定义 server 块中，请把下面的 location 拷进那个 server 块。
server {
    listen 8081;
    server_name _;
    location /citytwin/ {
        alias /var/www/citytwin/;
        index index.html;
    }
}
NGINX
# 同时尝试注入默认站点（80 端口）方便直接访问 /citytwin/
if [ -f /etc/nginx/nginx.conf ] && ! grep -q "citytwin" /etc/nginx/nginx.conf; then
  echo "   （提示：如需在 80 端口主站点使用 /citytwin/，把 location 块拷入你的 server 配置）"
fi
$SUDO nginx -t && $SUDO systemctl reload nginx

echo "==> [5/5] 防火墙放行 80/8081"
if command -v firewall-cmd >/dev/null 2>&1; then
  $SUDO firewall-cmd --permanent --add-service=http || true
  $SUDO firewall-cmd --permanent --add-port=8081/tcp || true
  $SUDO firewall-cmd --reload || true
elif command -v ufw >/dev/null 2>&1; then
  $SUDO ufw allow 80/tcp || true
  $SUDO ufw allow 8081/tcp || true
fi

IP=$(curl -s --max-time 5 ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')
cat <<DONE

✅ 部署完成！
   游戏地址：  http://$IP:8081/citytwin/   （独立端口，立即可用）
   主站挂载：  把 /etc/nginx/conf.d/citytwin.conf 里的 location 块
               拷进你主页的 server 配置后 → http://$IP/citytwin/

📌 Oracle Cloud 别忘了在控制台 VCN 安全列表放行 TCP 80 和 8081 的 Ingress 规则。

🧩 主页"孪生"模块卡片：/var/www/citytwin/homepage-card.html
   把其中的 <a class="ct-card">…</a> 片段粘贴进你主页孪生模块的栅格里即可，
   点击卡片进入游戏。
DONE
