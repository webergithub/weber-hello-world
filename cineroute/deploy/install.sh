#!/usr/bin/env bash
#
# CineRoute 影路 —— 服务器首次安装
#
# 在服务器上以 root 或 sudo 执行：
#   curl -fsSL https://raw.githubusercontent.com/webergithub/weber-hello-world/claude/movie-tv-search-platform-gwzo4k/cineroute/deploy/install.sh | sudo bash
# 或者先 clone 下来再跑：
#   sudo bash cineroute/deploy/install.sh
#
# 幂等：重复执行不会破坏已有配置（/etc/cineroute.env 存在就不覆盖）。
# 后续更新代码用 update.sh，不用再跑这个。

set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/webergithub/weber-hello-world.git}"
REPO_BRANCH="${REPO_BRANCH:-claude/movie-tv-search-platform-gwzo4k}"
APP_DIR="${APP_DIR:-/opt/cineroute}"
DATA_DIR="${DATA_DIR:-/var/lib/cineroute}"
ENV_FILE="${ENV_FILE:-/etc/cineroute.env}"
SERVICE_USER="${SERVICE_USER:-cineroute}"
PORT="${PORT:-8787}"
NODE_MAJOR="${NODE_MAJOR:-22}"
# 克隆下来的仓库里，应用在 cineroute/ 子目录
SRC_SUBDIR="cineroute"

log()  { printf '\033[36m▸\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "请用 root 或 sudo 执行"

# ── 1. 装 Node ───────────────────────────────────────────────
install_node() {
  if command -v node >/dev/null 2>&1; then
    local have
    have="$(node -p 'process.versions.node.split(".")[0]')"
    if (( have >= 18 )); then
      log "已有 Node v$(node -p process.versions.node)，跳过安装"
      return
    fi
    warn "已有 Node v$(node -p process.versions.node)，低于要求的 18，将安装 Node ${NODE_MAJOR}"
  fi

  log "安装 Node ${NODE_MAJOR}"
  if command -v dnf >/dev/null 2>&1; then
    # Oracle Linux / RHEL / Rocky / AlmaLinux
    curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
    dnf install -y nodejs
  elif command -v apt-get >/dev/null 2>&1; then
    # Ubuntu / Debian
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
    apt-get install -y nodejs
  else
    die "认不出包管理器（既没有 dnf 也没有 apt-get），请手动装 Node ${NODE_MAJOR}+ 后重跑"
  fi
}

install_git() {
  command -v git >/dev/null 2>&1 && return
  log "安装 git"
  if command -v dnf >/dev/null 2>&1; then dnf install -y git
  elif command -v apt-get >/dev/null 2>&1; then apt-get install -y git
  else die "请先手动安装 git"; fi
}

install_node
install_git

# ── 2. 建服务账号 ────────────────────────────────────────────
if id "$SERVICE_USER" >/dev/null 2>&1; then
  log "服务账号 ${SERVICE_USER} 已存在"
else
  log "建服务账号 ${SERVICE_USER}（系统账号、不可登录、无家目录）"
  useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER" 2>/dev/null \
    || useradd --system --no-create-home --shell /sbin/nologin "$SERVICE_USER"
fi

# ── 3. 拉代码 ────────────────────────────────────────────────
CLONE_DIR="/opt/cineroute-src"
if [[ -d "$CLONE_DIR/.git" ]]; then
  log "更新已有仓库 ${CLONE_DIR}"
  git -C "$CLONE_DIR" fetch --depth 1 origin "$REPO_BRANCH"
  git -C "$CLONE_DIR" checkout -q -B "$REPO_BRANCH" "origin/${REPO_BRANCH}"
else
  log "克隆 ${REPO_URL}（分支 ${REPO_BRANCH}）"
  rm -rf "$CLONE_DIR"
  git clone --depth 1 --branch "$REPO_BRANCH" "$REPO_URL" "$CLONE_DIR"
fi

[[ -f "$CLONE_DIR/$SRC_SUBDIR/index.js" ]] || die "仓库里没找到 ${SRC_SUBDIR}/index.js，REPO_BRANCH 是不是写错了？"

log "同步代码到 ${APP_DIR}"
mkdir -p "$APP_DIR"
# --delete 让删掉的文件也同步消失；排除运行期产物，别把服务器上的数据清了
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete \
    --exclude 'downloads/' --exclude 'config/' --exclude 'node_modules/' \
    "$CLONE_DIR/$SRC_SUBDIR/" "$APP_DIR/"
else
  rm -rf "${APP_DIR:?}"/* && cp -a "$CLONE_DIR/$SRC_SUBDIR/." "$APP_DIR/"
fi
# 代码目录归 root，服务账号只读——服务跑起来后改不了自己的代码
chown -R root:root "$APP_DIR"
chmod -R go-w "$APP_DIR"

# ── 4. 数据目录 ──────────────────────────────────────────────
log "建数据目录 ${DATA_DIR}"
mkdir -p "$DATA_DIR/downloads"
chown -R "$SERVICE_USER:$SERVICE_USER" "$DATA_DIR"
chmod 750 "$DATA_DIR"

# ── 5. 环境变量文件 ──────────────────────────────────────────
if [[ -f "$ENV_FILE" ]]; then
  log "${ENV_FILE} 已存在，保留不动（要改配置直接编辑它）"
else
  log "生成 ${ENV_FILE} 模板"
  cat > "$ENV_FILE" <<EOF
# CineRoute 运行配置。改完执行：systemctl restart cineroute

# 只监听本机，由 Nginx 反代出去。要直接对公网暴露就改成 0.0.0.0，
# 但那样 /media 代理和 /api/download 就是完全无认证地对外开着，想清楚再改。
CINEROUTE_HOST=127.0.0.1
CINEROUTE_PORT=${PORT}

# 数据落在 /var/lib，代码目录是只读的，别往那里写
CINEROUTE_CONFIG=${DATA_DIR}/sources.json
CINEROUTE_DOWNLOAD_DIR=${DATA_DIR}/downloads

# ── 可选 ────────────────────────────────────────────────────
# 权威片长 + 正版观看渠道（没有就用候选时长中位数兜底，功能不受影响）
#TMDB_API_KEY=

# 接你自己的媒体库
#JELLYFIN_URL=
#JELLYFIN_API_KEY=

# 搜索引擎来源。四大引擎都没有可直接调用的免费官方 API，需要接 SERP 服务；
# 不配的话引擎来源会在结果里如实标为「已跳过」，其余来源照常工作。
#CINEROUTE_SERP_PROVIDER=serper
#CINEROUTE_SERP_KEY=
#CINEROUTE_SERP_URL=

# 全局默认取数（每个来源可在界面上单独覆盖）
#CINEROUTE_DEFAULT_LIMIT=100

# 正版渠道地区 / TMDB 语言
#CINEROUTE_REGION=US
#CINEROUTE_LANGUAGE=zh-CN

# 出网要走 HTTP 代理时，Node 内置 fetch 需要显式开启
#NODE_USE_ENV_PROXY=1
#HTTPS_PROXY=
EOF
  chmod 640 "$ENV_FILE"
  chown root:"$SERVICE_USER" "$ENV_FILE"
fi

# ── 6. systemd ───────────────────────────────────────────────
log "安装 systemd 单元"
install -m 644 "$APP_DIR/deploy/cineroute.service" /etc/systemd/system/cineroute.service

# node 不在 /usr/bin 时写个 drop-in 覆盖 ExecStart
NODE_BIN="$(command -v node)"
if [[ "$NODE_BIN" != "/usr/bin/node" ]]; then
  log "node 在 ${NODE_BIN}，写 drop-in 覆盖 ExecStart"
  mkdir -p /etc/systemd/system/cineroute.service.d
  cat > /etc/systemd/system/cineroute.service.d/10-node-path.conf <<EOF
[Service]
ExecStart=
ExecStart=${NODE_BIN} ${APP_DIR}/index.js --serve
EOF
else
  rm -f /etc/systemd/system/cineroute.service.d/10-node-path.conf
fi

systemctl daemon-reload
systemctl enable cineroute
systemctl restart cineroute

# ── 7. 确认起来了 ────────────────────────────────────────────
sleep 2
if systemctl is-active --quiet cineroute; then
  log "服务已启动"
else
  warn "服务没起来，最近日志："
  journalctl -u cineroute -n 30 --no-pager >&2
  die "启动失败"
fi

if curl -fsS --max-time 5 "http://127.0.0.1:${PORT}/api/config" >/dev/null; then
  log "接口自检通过：http://127.0.0.1:${PORT}/api/config 返回 200"
else
  warn "接口没响应，看日志：journalctl -u cineroute -n 50"
fi

cat <<EOF

$(printf '\033[32m✓\033[0m') CineRoute 已装好

  代码      ${APP_DIR}          （只读，root 所有）
  数据      ${DATA_DIR}         （下载产物 + sources.json）
  配置      ${ENV_FILE}
  服务      systemctl status cineroute
  日志      journalctl -u cineroute -f
  监听      127.0.0.1:${PORT}   （只对本机，需要 Nginx 反代才能从外面访问）

接下来还要做两件事：

  1) 配 Nginx 反代 —— 见 ${APP_DIR}/deploy/nginx.conf
     /api/events 是 SSE、/media 是视频流，都必须关掉 proxy_buffering，
     照抄那份配置就行，自己写很容易漏。

  2) 放行端口 —— Oracle Cloud 要改两个地方，只改一个不通：
     · 实例防火墙：firewall-cmd --permanent --add-service=http --add-service=https && firewall-cmd --reload
     · 云控制台的安全列表 / NSG 入站规则（这一步在网页上做，脚本管不了）

EOF
