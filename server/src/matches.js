// 战绩上报、软校验与排行榜。
// 防刷原则（规划 §6.3）：个人项目不追求完美，只挡明显伪造；不通过则不入榜，但仍存数据、不封号。
import { randomUUID, createHash } from 'node:crypto';
import { getDb } from './db.js';
import { GAME, WORLD_VERSION } from './config.js';

const CITIES = ['town', 'london', 'shanghai', 'istanbul', 'newyork', 'dubai'];
const DIFFS = ['easy', 'normal', 'hard'];
const MODES = ['ai', 'hot', 'daily'];

// dist 只统计自身移动（updatePlayer 里 moving 为真才累加；打车/乘车瞬移不计）。
// 上界取最快自走方式：单车 11.5 / 3 × 倍速上限 8 × 能量加速 1.3 ≈ 39.9 m/s，再放宽 20%。
const MAX_GROUND_SPEED = (11.5 / 3) * GAME.simMulMax * 1.3 * 1.2;

const int = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : NaN);

/** 软校验：返回 {valid, reason} */
export function validateSummary(s) {
  const fail = (r) => ({ valid: false, reason: r });

  if (!CITIES.includes(s.city)) return fail('bad_city');
  if (!DIFFS.includes(s.difficulty)) return fail('bad_difficulty');
  if (!MODES.includes(s.mode)) return fail('bad_mode');

  const totalTime = int(s.totalTime), timeLeft = int(s.timeLeft);
  if (!Number.isFinite(totalTime) || totalTime <= 0 || totalTime > 3600) return fail('bad_total_time');
  if (!Number.isFinite(timeLeft) || timeLeft < 0 || timeLeft > totalTime) return fail('bad_time_left');
  const elapsed = totalTime - timeLeft;

  const nHiders = int(s.nHiders), captures = int(s.captures);
  if (!(nHiders >= 1 && nHiders <= 8)) return fail('bad_n_hiders');
  if (!(captures >= 0 && captures <= nHiders)) return fail('bad_captures');
  if (s.won && captures !== nHiders) return fail('won_without_all_captures');

  // ① 账目对账（最强的一条：game.js 里每笔收支都成对累加，恒等式必须成立）
  const start = GAME.startCredits[s.difficulty];
  const credits = int(s.credits), earned = int(s.earned), spent = int(s.spent);
  if (![credits, earned, spent].every(Number.isFinite)) return fail('bad_ledger_numbers');
  if (earned < 0 || spent < 0) return fail('negative_ledger');
  if (credits !== start + earned - spent) return fail('ledger_mismatch');

  // 抓捕收入下界：每次抓捕至少 captureBase（悬赏另计，只增不减）
  if (earned < captures * GAME.captureBase) return fail('earned_below_capture_floor');

  // ② 最终分数必须自洽
  const finalScore = int(s.finalScore);
  const expectScore = credits + (s.won ? Math.round(timeLeft) : 0);
  if (finalScore !== expectScore) return fail('score_mismatch');

  // ③ 移动距离与用时自洽
  const dist = Number(s.dist);
  if (!Number.isFinite(dist) || dist < 0) return fail('bad_dist');
  if (dist > elapsed * MAX_GROUND_SPEED + 50) return fail('dist_exceeds_max_speed');

  // 用时下界：抓齐每个躲藏者总得跑一段路，10 秒内通关视为伪造
  if (s.won && elapsed < 10) return fail('impossibly_fast');

  return { valid: true, reason: null };
}

export function submitMatch(playerId, s) {
  const { valid, reason } = validateSummary(s);
  const id = randomUUID();
  const totalTime = int(s.totalTime), timeLeft = int(s.timeLeft);
  const elapsed = totalTime - timeLeft;
  getDb().prepare(`INSERT INTO match (
      id, player_id, created_at, city, seed, world_version, mode, daily_date, difficulty,
      total_time, n_hiders, m_seekers, won, time_left, elapsed, captures, credits, earned, spent,
      final_score, dist, rides, loot, airdrop, chase_caps, poi, achievements, valid, reject_reason, summary
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, playerId, Date.now(), s.city, int(s.seed) || 0, WORLD_VERSION, s.mode,
         s.dailyDate ?? null, s.difficulty, totalTime, int(s.nHiders), int(s.mSeekers) || 1,
         s.won ? 1 : 0, timeLeft, elapsed, int(s.captures), int(s.credits), int(s.earned), int(s.spent),
         int(s.finalScore), Number(s.dist) || 0, int(s.rides) || 0, int(s.loot) || 0,
         s.airdrop ? 1 : 0, int(s.chaseCaps) || 0, int(s.poi) || 0,
         JSON.stringify(Array.isArray(s.achievements) ? s.achievements : []),
         valid ? 1 : 0, reason, JSON.stringify(s).slice(0, 20000));
  return { id, valid, reason };
}

const BOARDS = {
  fastest:  { where: 'won = 1', order: 'elapsed ASC',      metric: 'elapsed' },
  score:    { where: '1=1',     order: 'final_score DESC', metric: 'final_score' },
  thrifty:  { where: 'won = 1', order: 'spent ASC',        metric: 'spent' },
  explorer: { where: '1=1',     order: 'poi DESC',         metric: 'poi' },
};

export function leaderboard({ board = 'fastest', city = 'london', totalTime, difficulty = 'normal', dailyDate, limit = 20 }) {
  const b = BOARDS[board];
  if (!b) return { error: 'unknown_board', boards: Object.keys(BOARDS) };
  const args = [];
  let sql = `SELECT m.id, m.player_id, m.${b.metric} AS metric, m.final_score, m.elapsed, m.spent,
                    m.poi, m.captures, m.created_at, p.nickname
             FROM match m LEFT JOIN player p ON p.id = m.player_id
             WHERE m.valid = 1 AND m.world_version = ? AND (${b.where})`;
  args.push(WORLD_VERSION);
  if (dailyDate) { sql += ' AND m.daily_date = ?'; args.push(dailyDate); }
  else {
    sql += ' AND m.city = ? AND m.difficulty = ?'; args.push(city, difficulty);
    if (totalTime) { sql += ' AND m.total_time = ?'; args.push(int(totalTime)); }
  }
  sql += ` ORDER BY ${b.order} LIMIT ?`;
  args.push(Math.min(Math.max(int(limit) || 20, 1), 100));
  const rows = getDb().prepare(sql).all(...args);
  return {
    board, city, difficulty, totalTime: totalTime ? int(totalTime) : null,
    dailyDate: dailyDate || null, worldVersion: WORLD_VERSION,
    entries: rows.map((r, i) => ({
      rank: i + 1,
      name: r.nickname || ('玩家' + String(r.player_id).slice(0, 4)),
      metric: r.metric, finalScore: r.final_score, elapsed: r.elapsed,
      spent: r.spent, poi: r.poi, captures: r.captures, at: r.created_at,
    })),
  };
}

export function playerStats(playerId) {
  const row = getDb().prepare(
    `SELECT COUNT(*) games, COALESCE(SUM(won),0) wins, COALESCE(SUM(captures),0) caps,
            COALESCE(MAX(final_score),0) best
     FROM match WHERE player_id = ? AND valid = 1`).get(playerId);
  return { games: row.games, wins: row.wins, caps: row.caps, best: row.best };
}

/** 每日挑战：seed 由日期 + worldVersion 决定，全球同一张图 */
export function dailyChallenge(date = new Date()) {
  const day = date.toISOString().slice(0, 10);
  const h = createHash('sha256').update(`citytwin|${day}|v${WORLD_VERSION}`).digest();
  const seed = h.readUInt32BE(0);
  const cities = ['london', 'shanghai', 'istanbul', 'newyork', 'dubai'];
  return {
    date: day,
    city: cities[h[4] % cities.length],
    seed,
    difficulty: 'hard',      // 每日挑战锁高难：hintCount=2、起始 70💰
    totalTime: 480,
    nHiders: 3,
    mSeekers: 1,
    worldVersion: WORLD_VERSION,
  };
}
