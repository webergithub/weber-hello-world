// SQLite（node:sqlite 内置，免原生编译）。写入量级是「一局结束写一行」，WAL 足矣。
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { DATA_DIR, ensureDataDir } from './config.js';

let db = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS player (
  id           TEXT PRIMARY KEY,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  nickname     TEXT,
  avatar       TEXT,            -- JSON {skin,shirt,pants,hair}
  lang         TEXT
);

-- 一次性迁移码：把匿名身份搬到新设备（不引入密码/邮箱这类长期负债）
CREATE TABLE IF NOT EXISTS migration_code (
  code       TEXT PRIMARY KEY,
  player_id  TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER
);

-- 整局摘要：第一天就存全量，赛季/回放/平衡调参都吃这份数据
CREATE TABLE IF NOT EXISTS match (
  id            TEXT PRIMARY KEY,
  player_id     TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  city          TEXT NOT NULL,
  seed          INTEGER NOT NULL,
  world_version INTEGER NOT NULL,
  mode          TEXT NOT NULL,     -- ai | hot | daily
  daily_date    TEXT,
  difficulty    TEXT NOT NULL,
  total_time    INTEGER NOT NULL,
  n_hiders      INTEGER NOT NULL,
  m_seekers     INTEGER NOT NULL,
  won           INTEGER NOT NULL,
  time_left     INTEGER NOT NULL,
  elapsed       INTEGER NOT NULL,
  captures      INTEGER NOT NULL,
  credits       INTEGER NOT NULL,
  earned        INTEGER NOT NULL,
  spent         INTEGER NOT NULL,
  final_score   INTEGER NOT NULL,
  dist          REAL,
  rides         INTEGER,
  loot          INTEGER,
  airdrop       INTEGER,
  chase_caps    INTEGER,
  poi           INTEGER,
  achievements  TEXT,              -- JSON array
  valid         INTEGER NOT NULL,  -- 未通过软校验则 0，不入榜但保留数据
  reject_reason TEXT,
  summary       TEXT               -- 完整 JSON，未来功能用
);
CREATE INDEX IF NOT EXISTS idx_match_board
  ON match (city, total_time, difficulty, world_version, valid);
CREATE INDEX IF NOT EXISTS idx_match_daily ON match (daily_date, valid);
CREATE INDEX IF NOT EXISTS idx_match_player ON match (player_id, created_at);

-- Tiles 用量：配额与熔断的账本
CREATE TABLE IF NOT EXISTS tile_usage (
  period TEXT NOT NULL,   -- 'YYYY-MM-DD' 或 'YYYY-MM'
  scope  TEXT NOT NULL,   -- 'global' 或 player_id
  count  INTEGER NOT NULL,
  PRIMARY KEY (period, scope)
);
`;

export function initDb() {
  if (db) return db;
  ensureDataDir();
  const file = process.env.CITYTWIN_DB || join(DATA_DIR, 'citytwin.db');
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA busy_timeout = 4000');
  db.exec(SCHEMA);
  return db;
}

export const getDb = () => db || initDb();

export function closeDb() {
  if (db) { try { db.close(); } catch { /* 已关闭 */ } db = null; }
}
