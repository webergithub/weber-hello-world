// 端到端冒烟：真起服务器、真发 HTTP 请求。无外部依赖，node test/smoke.mjs 即可跑。
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'ct-test-'));
const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;
let pass = 0, fail = 0;

const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
};

const api = async (path, opts = {}) => {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(opts.token ? { authorization: 'Bearer ' + opts.token } : {}), ...opts.headers },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* 非 JSON 响应 */ }
  return { status: res.status, json };
};

const child = spawn(process.execPath, ['--no-warnings', new URL('../src/index.js', import.meta.url).pathname], {
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', CITYTWIN_DATA_DIR: DIR,
         CITYTWIN_DB: join(DIR, 'test.db'), CITYTWIN_SECRET: 'test-secret-not-for-production',
         GOOGLE_MAPS_KEY: '', CT_QUOTA_GLOBAL_DAY: '5' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stderr.on('data', (d) => { const s = String(d); if (!s.includes('ExperimentalWarning')) process.stderr.write('[server] ' + s); });

const waitUp = async () => {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/healthz'); if (r.ok || r.status === 503) return true; } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
};

// 一份通过对账的合法战绩：credits = start(110) + earned - spent
const legitSummary = () => ({
  city: 'london', seed: 12345, mode: 'ai', difficulty: 'normal',
  totalTime: 480, timeLeft: 200, nHiders: 3, mSeekers: 1, won: true,
  captures: 3, earned: 260, spent: 40, credits: 110 + 260 - 40,
  finalScore: (110 + 260 - 40) + 200,
  dist: 1800, rides: 4, loot: 5, airdrop: true, chaseCaps: 1, poi: 4,
  achievements: ['speed', 'collector'],
});

try {
  if (!(await waitUp())) throw new Error('服务器未能启动');
  console.log('\n【健康检查与配置】');
  const h = await api('/healthz');
  ok('healthz 返回 ok 且含真实内部状态', h.status === 200 && h.json.ok === true && typeof h.json.rssMb === 'number', JSON.stringify(h.json));
  const cfg = await api('/api/config');
  ok('config 在未配 key 时标记 photoreal 不可用', cfg.status === 200 && cfg.json.photorealAvailable === false);
  ok('config 携带每日挑战', !!(cfg.json.daily && cfg.json.daily.seed && cfg.json.daily.city));

  console.log('\n【匿名身份与跨设备迁移】');
  const id1 = await api('/api/identity', { method: 'POST', body: { nickname: '猎手小李', lang: 'zh' } });
  ok('创建匿名身份返回 token', id1.status === 200 && typeof id1.json.token === 'string');
  const token = id1.json.token;
  const me = await api('/api/me', { token });
  ok('凭 token 读取档案', me.status === 200 && me.json.player.nickname === '猎手小李');
  const noAuth = await api('/api/me');
  ok('无 token 被拒 401', noAuth.status === 401);
  const badAuth = await api('/api/me', { token: token.slice(0, -3) + 'xxx' });
  ok('篡改签名的 token 被拒', badAuth.status === 401);
  const put = await api('/api/me', { method: 'PUT', token, body: { avatar: { skin: 1, shirt: 2, pants: 3, hair: 4 } } });
  ok('更新形象并回读', put.status === 200 && put.json.player.avatar.shirt === 2);

  const code = await api('/api/migrate/code', { method: 'POST', token });
  ok('生成 6 位迁移码', code.status === 200 && /^[A-Z2-9]{6}$/.test(code.json.code), code.json.code);
  const redeem = await api('/api/migrate/redeem', { method: 'POST', body: { code: code.json.code } });
  ok('迁移码换新 token 且身份一致', redeem.status === 200 && redeem.json.player.nickname === '猎手小李');
  const redeem2 = await api('/api/migrate/redeem', { method: 'POST', body: { code: code.json.code } });
  ok('迁移码一次性（二次使用被拒）', redeem2.status === 400 && redeem2.json.error === 'already_used');

  console.log('\n【战绩上报与防刷对账】');
  const m1 = await api('/api/matches', { method: 'POST', token, body: legitSummary() });
  ok('合法战绩通过校验', m1.status === 200 && m1.json.valid === true, JSON.stringify(m1.json));
  ok('生涯战绩累加', m1.json.stats.games === 1 && m1.json.stats.wins === 1 && m1.json.stats.caps === 3);

  const cheatLedger = { ...legitSummary(), credits: 99999, finalScore: 99999 + 200 };
  const c1 = await api('/api/matches', { method: 'POST', token, body: cheatLedger });
  ok('伪造信用点被对账挡下', c1.status === 202 && c1.json.valid === false && c1.json.reason === 'ledger_mismatch', JSON.stringify(c1.json));

  const cheatScore = { ...legitSummary(), finalScore: 999999 };
  const c2 = await api('/api/matches', { method: 'POST', token, body: cheatScore });
  ok('伪造最终分数被挡下', c2.json.valid === false && c2.json.reason === 'score_mismatch');

  const cheatDist = { ...legitSummary(), dist: 9e9 };
  const c3 = await api('/api/matches', { method: 'POST', token, body: cheatDist });
  ok('超物理上限的移动距离被挡下', c3.json.valid === false && c3.json.reason === 'dist_exceeds_max_speed');

  // 只违反「通关过快」这一项：距离同步调小，避免先被距离规则拦下
  const cheatFast = { ...legitSummary(), timeLeft: 475, dist: 100, finalScore: 330 + 475 };
  const c4 = await api('/api/matches', { method: 'POST', token, body: cheatFast });
  ok('5 秒通关被判不可能', c4.json.valid === false && c4.json.reason === 'impossibly_fast');

  const cheatCap = { ...legitSummary(), captures: 99 };
  const c5 = await api('/api/matches', { method: 'POST', token, body: cheatCap });
  ok('抓捕数超过躲藏者数被挡下', c5.json.valid === false && c5.json.reason === 'bad_captures');

  console.log('\n【排行榜与每日挑战】');
  const lb = await api('/api/leaderboard?board=fastest&city=london&difficulty=normal&totalTime=480');
  ok('最快通关榜含合法成绩', lb.status === 200 && lb.json.entries.length === 1 && lb.json.entries[0].name === '猎手小李', JSON.stringify(lb.json.entries));
  ok('作弊成绩未进榜', lb.json.entries.every((e) => e.finalScore !== 99999 + 200));
  const lb2 = await api('/api/leaderboard?board=score&city=london&difficulty=normal');
  ok('最高分榜可用', lb2.status === 200 && lb2.json.entries.length >= 1);
  const lbBad = await api('/api/leaderboard?board=nope');
  ok('未知榜名返回错误与可选项', lbBad.json.error === 'unknown_board' && Array.isArray(lbBad.json.boards));

  const d1 = await api('/api/daily'); const d2 = await api('/api/daily');
  ok('每日挑战 seed 稳定（同日同种子）', d1.json.seed === d2.json.seed && d1.json.date === d2.json.date);
  ok('每日挑战锁定高难', d1.json.difficulty === 'hard');

  console.log('\n【Tiles 代理与熔断】');
  const t1 = await api('/api/gtiles/v1/3dtiles/root.json');
  ok('未配 key 时返回 503 并指示降级', t1.status === 503 && t1.json.fallback === 'openmap', JSON.stringify(t1.json));
  const t2 = await api('/api/gtiles/v1/evil/../../etc/passwd');
  ok('白名单外路径被拒（防当通用代理）', t2.status === 403 || t2.status === 503);

  console.log('\n【健壮性】');
  const bad = await fetch(BASE + '/api/matches', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: '{not json' });
  ok('畸形 JSON 返回 400 而非崩溃', bad.status === 400);
  const nf = await api('/api/nope');
  ok('未知路径 404', nf.status === 404);
  const stillUp = await api('/healthz');
  ok('异常请求后服务仍存活', stillUp.status === 200);
} catch (e) {
  fail++; console.log('  ❌ 测试异常:', e && e.stack || e);
} finally {
  child.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 400));
  child.kill('SIGKILL');
  rmSync(DIR, { recursive: true, force: true });
  console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail ? 1 : 0);
}
