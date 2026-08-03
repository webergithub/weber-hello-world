#!/usr/bin/env bash
# ============================================================
# CityTwin · 服务器一次性安装/更新 nginx 配置（安全版）
#
# 在服务器上执行（key 只留在服务器，不进仓库/不进对话）：
#   GOOGLE_KEY="你的GoogleMapsKey" bash server-setup.sh
#
# 设计原则（区别于已废弃的 deploy-on-server.sh）：
#   · 绝不新建 server 块，绝不覆盖 conf.d 里既有文件 —— 不影响同机其他站点
#   · 改动只落在 2 个自有文件；nginx -t 不过则自动回滚并退出
#   · reload 而非 restart：配置错误不会中断已有连接
# ============================================================
set -euo pipefail

SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"
SRC_DIR="$(cd "$(dirname "$0")" && pwd)/nginx"
HTTP_CONF="/etc/nginx/conf.d/00-citytwin-http.conf"
LOC_DIR="/etc/nginx/citytwin"
LOC_CONF="$LOC_DIR/10-citytwin-locations.conf"

[ -f "$SRC_DIR/00-citytwin-http.conf" ] || { echo "❌ 未找到 $SRC_DIR/00-citytwin-http.conf（请在仓库 deploy/ 目录下运行）"; exit 1; }
[ -n "${GOOGLE_KEY:-}" ] || { echo "❌ 请以 GOOGLE_KEY=xxx bash $0 方式提供 Google Maps key"; exit 1; }

echo "==> [1/4] 备份现有配置（若有）"
for f in "$HTTP_CONF" "$LOC_CONF"; do
  [ -f "$f" ] && $SUDO cp -f "$f" "$f.bak.$(date +%s)" || true
done

echo "==> [2/4] 安装配置并注入 key（key 不回显）"
$SUDO mkdir -p "$LOC_DIR" /var/cache/nginx/ct_tiles
$SUDO cp -f "$SRC_DIR/10-citytwin-locations.conf" "$LOC_CONF"
# 用 python 替换避免 key 含特殊字符时 sed 出错；key 不出现在命令行历史之外的任何输出里
$SUDO env GOOGLE_KEY="$GOOGLE_KEY" python3 - "$SRC_DIR/00-citytwin-http.conf" "$HTTP_CONF" <<'PY'
import os, sys
src, dst = sys.argv[1], sys.argv[2]
open(dst, 'w').write(open(src).read().replace('__GOOGLE_KEY__', os.environ['GOOGLE_KEY']))
os.chmod(dst, 0o640)
PY

echo "==> [3/4] 检查主站 server 块是否已 include 本目录"
if ! $SUDO grep -Rqs "include /etc/nginx/citytwin/" /etc/nginx/sites-enabled/ /etc/nginx/conf.d/ /etc/nginx/nginx.conf 2>/dev/null; then
  cat <<'TIP'
⚠️ 还差一步（为安全起见不自动改你的主站配置）：
   编辑主站 server 块（通常是 /etc/nginx/sites-enabled/default），
   在 server { ... } 内加一行：
       include /etc/nginx/citytwin/*.conf;
   然后重新运行本脚本完成校验与 reload。
TIP
fi

echo "==> [4/4] 校验并热加载"
if $SUDO nginx -t; then
  $SUDO systemctl reload nginx
  echo "✅ 完成。免 key 代理：/citytwin/gtiles/ → tile.googleapis.com（含每IP限速与10分钟缓存）"
  echo "   photoreal 页面留空 key 即可加载照片级3D城市。"
else
  echo "❌ nginx -t 未通过，自动回滚本次改动…"
  LATEST_HTTP=$(ls -t "$HTTP_CONF".bak.* 2>/dev/null | head -1 || true)
  LATEST_LOC=$(ls -t "$LOC_CONF".bak.* 2>/dev/null | head -1 || true)
  [ -n "$LATEST_HTTP" ] && $SUDO cp -f "$LATEST_HTTP" "$HTTP_CONF" || $SUDO rm -f "$HTTP_CONF"
  [ -n "$LATEST_LOC" ] && $SUDO cp -f "$LATEST_LOC" "$LOC_CONF" || $SUDO rm -f "$LOC_CONF"
  $SUDO nginx -t && echo "已回滚，原配置未受影响。请把上方错误发我修配置。"
  exit 1
fi
