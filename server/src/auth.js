// 匿名身份：HMAC 签名 token，无密码/无邮箱（避免找回流程与邮件服务这类长期负债）。
// 换设备用一次性 6 位迁移码。
import { createHmac, randomUUID, randomInt, timingSafeEqual } from 'node:crypto';
import { getDb } from './db.js';
import { loadSecret } from './config.js';

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const sign = (payload) => b64u(createHmac('sha256', loadSecret()).update(payload).digest());

// 迁移码去掉易混字符 0/O/1/I/L
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function issueToken(playerId) {
  const payload = `v1.${playerId}.${Date.now()}`;
  return `${payload}.${sign(payload)}`;
}

export function verifyToken(token) {
  if (typeof token !== 'string') return null;
  const i = token.lastIndexOf('.');
  if (i < 0) return null;
  const payload = token.slice(0, i);
  const got = token.slice(i + 1);
  const want = sign(payload);
  // 定长比较防时序侧信道
  if (got.length !== want.length) return null;
  try {
    if (!timingSafeEqual(Buffer.from(got), Buffer.from(want))) return null;
  } catch { return null; }
  const [v, playerId] = payload.split('.');
  if (v !== 'v1' || !playerId) return null;
  return playerId;
}

export function createPlayer(profile = {}) {
  const db = getDb();
  const id = randomUUID();
  const now = Date.now();
  db.prepare(`INSERT INTO player (id, created_at, last_seen_at, nickname, avatar, lang)
              VALUES (?, ?, ?, ?, ?, ?)`)
    .run(id, now, now, profile.nickname ?? null,
         profile.avatar ? JSON.stringify(profile.avatar) : null, profile.lang ?? null);
  return id;
}

export function getPlayer(playerId) {
  const row = getDb().prepare('SELECT * FROM player WHERE id = ?').get(playerId);
  if (!row) return null;
  let avatar = null;
  try { avatar = row.avatar ? JSON.parse(row.avatar) : null; } catch { avatar = null; }
  return { id: row.id, nickname: row.nickname, avatar, lang: row.lang, createdAt: row.created_at };
}

export function touchPlayer(playerId) {
  getDb().prepare('UPDATE player SET last_seen_at = ? WHERE id = ?').run(Date.now(), playerId);
}

export function updateProfile(playerId, patch) {
  const db = getDb();
  const cur = getPlayer(playerId);
  if (!cur) return null;
  const nickname = patch.nickname !== undefined ? String(patch.nickname).slice(0, 24) : cur.nickname;
  const avatar = patch.avatar !== undefined ? patch.avatar : cur.avatar;
  const lang = patch.lang !== undefined ? String(patch.lang).slice(0, 8) : cur.lang;
  db.prepare('UPDATE player SET nickname = ?, avatar = ?, lang = ?, last_seen_at = ? WHERE id = ?')
    .run(nickname ?? null, avatar ? JSON.stringify(avatar) : null, lang ?? null, Date.now(), playerId);
  return getPlayer(playerId);
}

/** 生成一次性迁移码（15 分钟有效） */
export function createMigrationCode(playerId) {
  const db = getDb();
  let code = '';
  for (let attempt = 0; attempt < 8; attempt++) {
    code = Array.from({ length: 6 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
    const exists = db.prepare('SELECT 1 FROM migration_code WHERE code = ? AND used_at IS NULL AND expires_at > ?')
      .get(code, Date.now());
    if (!exists) break;
  }
  const now = Date.now();
  const expires = now + 15 * 60 * 1000;
  db.prepare(`INSERT OR REPLACE INTO migration_code (code, player_id, created_at, expires_at, used_at)
              VALUES (?, ?, ?, ?, NULL)`).run(code, playerId, now, expires);
  return { code, expiresAt: expires };
}

/** 用迁移码换取该身份的新 token（一次性，用后作废） */
export function redeemMigrationCode(code) {
  const db = getDb();
  const c = String(code || '').toUpperCase().trim();
  const row = db.prepare('SELECT * FROM migration_code WHERE code = ?').get(c);
  if (!row) return { error: 'not_found' };
  if (row.used_at) return { error: 'already_used' };
  if (row.expires_at < Date.now()) return { error: 'expired' };
  db.prepare('UPDATE migration_code SET used_at = ? WHERE code = ?').run(Date.now(), c);
  touchPlayer(row.player_id);
  return { playerId: row.player_id, token: issueToken(row.player_id) };
}
