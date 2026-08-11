// Tiles 配额与熔断（规划 §7 的第 1~3 层）。
// ⚠️ 第 4 层必须在 GCP 控制台设「预算告警 + 配额硬上限」——只做代码层挡不住极端情况。
import { getDb } from './db.js';
import { QUOTA } from './config.js';

const dayKey = (d = new Date()) => d.toISOString().slice(0, 10);   // YYYY-MM-DD
const monthKey = (d = new Date()) => d.toISOString().slice(0, 7);  // YYYY-MM

function readCount(period, scope) {
  const row = getDb().prepare('SELECT count FROM tile_usage WHERE period = ? AND scope = ?').get(period, scope);
  return row ? row.count : 0;
}

function bump(period, scope, n) {
  getDb().prepare(`INSERT INTO tile_usage (period, scope, count) VALUES (?, ?, ?)
                   ON CONFLICT(period, scope) DO UPDATE SET count = count + excluded.count`)
    .run(period, scope, n);
}

/**
 * 请求前检查三层配额。任一层超限即拒绝，客户端据此降级回开放数据白模。
 * @returns {{ok:true}|{ok:false,layer:string,limit:number,used:number}}
 */
export function checkQuota(playerId) {
  const day = dayKey(), month = monthKey();
  const gMonth = readCount(month, 'global');
  if (gMonth >= QUOTA.globalMonth) return { ok: false, layer: 'global_month', limit: QUOTA.globalMonth, used: gMonth };
  const gDay = readCount(day, 'global');
  if (gDay >= QUOTA.globalDay) return { ok: false, layer: 'global_day', limit: QUOTA.globalDay, used: gDay };
  if (playerId) {
    const pDay = readCount(day, playerId);
    if (pDay >= QUOTA.perPlayerDay) return { ok: false, layer: 'player_day', limit: QUOTA.perPlayerDay, used: pDay };
  }
  return { ok: true };
}

/** 计一次 tile 请求（全局日 + 全局月 + 玩家日） */
export function recordTile(playerId, n = 1) {
  const day = dayKey(), month = monthKey();
  bump(day, 'global', n);
  bump(month, 'global', n);
  if (playerId) bump(day, playerId, n);
}

/** 用量快照，供 /healthz 与运维排查 */
export function usageSnapshot() {
  const day = dayKey(), month = monthKey();
  return {
    day,
    globalDay: readCount(day, 'global'),
    globalDayLimit: QUOTA.globalDay,
    globalMonth: readCount(month, 'global'),
    globalMonthLimit: QUOTA.globalMonth,
    perPlayerDayLimit: QUOTA.perPlayerDay,
  };
}
