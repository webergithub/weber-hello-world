// CityTwin 服务端配置：全部可用环境变量覆盖，默认值适配 Oracle Always Free 小机型
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));

export const DATA_DIR = process.env.CITYTWIN_DATA_DIR || '/var/lib/citytwin';
export const PORT = num(process.env.PORT, 8787);
export const HOST = process.env.HOST || '127.0.0.1';   // 永不监听 0.0.0.0：零对外攻击面

// —— Google Photorealistic 3D Tiles ——
export const GOOGLE_KEY = process.env.GOOGLE_MAPS_KEY || '';
export const TILES_UPSTREAM = 'https://tile.googleapis.com';

// —— 配额与熔断（第 1~3 层；第 4 层必须在 GCP 控制台另设预算告警+配额上限）——
export const QUOTA = {
  perPlayerDay: num(process.env.CT_QUOTA_PLAYER_DAY, 20000),   // 单设备日 tile 数
  globalDay: num(process.env.CT_QUOTA_GLOBAL_DAY, 200000),     // 全站日
  globalMonth: num(process.env.CT_QUOTA_GLOBAL_MONTH, 4000000), // 全站月（设为免费额度的 ~80%）
};

// 世界版本：任何影响地图生成/藏点/线索的改动都要 +1，否则历史成绩不可比
export const WORLD_VERSION = num(process.env.CT_WORLD_VERSION, 1);

// 游戏常量（与 game.js 保持一致，用于服务端对账校验）
export const GAME = {
  startCredits: { easy: 160, normal: 110, hard: 70 },
  captureBase: 50,
  speedRunBase: 8.2,      // SPEED.run
  simMulMax: 8,           // 管理员倍速上限
};

export function ensureDataDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true, mode: 0o750 });
}

// 签名密钥：首次运行自动生成并落盘（0600），不入仓库、不进日志
export function loadSecret() {
  if (process.env.CITYTWIN_SECRET) return process.env.CITYTWIN_SECRET;
  ensureDataDir();
  const p = join(DATA_DIR, 'secret.key');
  if (existsSync(p)) return readFileSync(p, 'utf8').trim();
  const s = randomBytes(32).toString('hex');
  writeFileSync(p, s, { mode: 0o600 });
  try { chmodSync(p, 0o600); } catch { /* 某些文件系统不支持 */ }
  return s;
}
