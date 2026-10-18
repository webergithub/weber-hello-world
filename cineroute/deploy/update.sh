#!/usr/bin/env bash
#
# CineRoute 影路 —— 更新到最新代码
#
#   sudo /opt/cineroute/deploy/update.sh              更新到分支最新
#   sudo /opt/cineroute/deploy/update.sh --check      只看有没有更新，不动
#   sudo REPO_BRANCH=main /opt/cineroute/deploy/update.sh   切到别的分支
#
# 不碰 /etc/cineroute.env，也不碰 /var/lib/cineroute 里的配置和下载产物。
# 更新失败会自动回滚到更新前的代码。

set -euo pipefail

REPO_BRANCH="${REPO_BRANCH:-claude/movie-tv-search-platform-gwzo4k}"
APP_DIR="${APP_DIR:-/opt/cineroute}"
CLONE_DIR="${CLONE_DIR:-/opt/cineroute-src}"
DATA_DIR="${DATA_DIR:-/var/lib/cineroute}"
SRC_SUBDIR="cineroute"
BACKUP_DIR="/opt/cineroute-backup"

log()  { printf '\033[36m▸\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "请用 root 或 sudo 执行"
[[ -d "$CLONE_DIR/.git" ]] || die "找不到 ${CLONE_DIR}，先跑 install.sh"

CHECK_ONLY=0
[[ "${1:-}" == "--check" ]] && CHECK_ONLY=1

# ── 1. 看看有没有更新 ────────────────────────────────────────
log "拉取 origin/${REPO_BRANCH}"
git -C "$CLONE_DIR" fetch --depth 1 origin "$REPO_BRANCH"

LOCAL="$(git -C "$CLONE_DIR" rev-parse HEAD)"
REMOTE="$(git -C "$CLONE_DIR" rev-parse "origin/${REPO_BRANCH}")"

if [[ "$LOCAL" == "$REMOTE" ]]; then
  log "已是最新（${LOCAL:0:7}），无需更新"
  exit 0
fi

log "有新版本：${LOCAL:0:7} → ${REMOTE:0:7}"
git -C "$CLONE_DIR" log --oneline "HEAD..origin/${REPO_BRANCH}" 2>/dev/null | head -20 || true

if (( CHECK_ONLY )); then
  log "--check 模式，到此为止"
  exit 0
fi

# ── 2. 更新前先备份现有代码，失败好回滚 ──────────────────────
log "备份当前代码到 ${BACKUP_DIR}"
rm -rf "$BACKUP_DIR"
cp -a "$APP_DIR" "$BACKUP_DIR"

rollback() {
  warn "更新失败，回滚到更新前的代码"
  rm -rf "${APP_DIR:?}"
  mv "$BACKUP_DIR" "$APP_DIR"
  systemctl restart cineroute || true
  die "已回滚。看日志排查：journalctl -u cineroute -n 50"
}

# ── 3. 切到新代码 ────────────────────────────────────────────
git -C "$CLONE_DIR" checkout -q -B "$REPO_BRANCH" "origin/${REPO_BRANCH}"
[[ -f "$CLONE_DIR/$SRC_SUBDIR/index.js" ]] || die "新代码里没有 ${SRC_SUBDIR}/index.js，中止"

# ── 4. 先跑测试，跑不过就不上线 ──────────────────────────────
# 零依赖项目，测试全部离线可跑，几秒钟的事——没有理由不跑。
if command -v node >/dev/null 2>&1; then
  log "跑测试"
  if (cd "$CLONE_DIR/$SRC_SUBDIR" && node --test "test/*.test.js" >/tmp/cineroute-test.log 2>&1); then
    log "测试通过：$(grep -E '^# pass' /tmp/cineroute-test.log | head -1)"
  else
    warn "测试没过，不上线。完整输出："
    tail -40 /tmp/cineroute-test.log >&2
    rm -rf "$BACKUP_DIR"
    die "更新中止，线上代码未改动"
  fi
fi

# ── 5. 同步代码 ──────────────────────────────────────────────
log "同步到 ${APP_DIR}"
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete \
    --exclude 'downloads/' --exclude 'config/' --exclude 'node_modules/' \
    "$CLONE_DIR/$SRC_SUBDIR/" "$APP_DIR/" || rollback
else
  rm -rf "${APP_DIR:?}"/* && cp -a "$CLONE_DIR/$SRC_SUBDIR/." "$APP_DIR/" || rollback
fi
chown -R root:root "$APP_DIR"
chmod -R go-w "$APP_DIR"

# systemd 单元可能也变了
if ! cmp -s "$APP_DIR/deploy/cineroute.service" /etc/systemd/system/cineroute.service; then
  log "systemd 单元有变化，一并更新"
  install -m 644 "$APP_DIR/deploy/cineroute.service" /etc/systemd/system/cineroute.service
  systemctl daemon-reload
fi

# ── 6. 重启并确认 ────────────────────────────────────────────
log "重启服务"
systemctl restart cineroute || rollback

sleep 2
systemctl is-active --quiet cineroute || rollback

PORT="$(grep -oP '^CINEROUTE_PORT=\K.*' /etc/cineroute.env 2>/dev/null || echo 8787)"
if curl -fsS --max-time 5 "http://127.0.0.1:${PORT}/api/config" >/dev/null; then
  log "接口自检通过"
else
  rollback
fi

rm -rf "$BACKUP_DIR"
printf '\033[32m✓\033[0m 已更新到 %s\n' "${REMOTE:0:7}"
log "数据目录未动：${DATA_DIR}"
