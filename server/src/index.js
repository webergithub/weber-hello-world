// CityTwin 后端入口：node:http + 手写路由，零运行时依赖。
// 只监听 127.0.0.1；对外由 nginx 以 /citytwin/api/ 反向代理。
import { createServer } from 'node:http';
import { PORT, HOST, WORLD_VERSION, GOOGLE_KEY } from './config.js';
import { initDb, closeDb } from './db.js';
import { issueToken, verifyToken, createPlayer, getPlayer, updateProfile, touchPlayer,
         createMigrationCode, redeemMigrationCode } from './auth.js';
import { submitMatch, leaderboard, playerStats, dailyChallenge } from './matches.js';
import { proxyTile, tilesConfigured } from './tiles.js';
import { usageSnapshot } from './quota.js';

const STARTED_AT = Date.now();
let lastTick = Date.now();          // /healthz 探真实内部状态，而非无脑 200
setInterval(() => { lastTick = Date.now(); }, 5000).unref();

const send = (res, status, obj, extra = {}) => {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8',
    'content-length': body.length, 'cache-control': 'no-store', ...extra });
  res.end(body);
};

async function readJson(req, limit = 64 * 1024) {
  const chunks = []; let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) { const e = new Error('payload_too_large'); e.code = 413; throw e; }
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { const e = new Error('invalid_json'); e.code = 400; throw e; }
}

const bearer = (req) => {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? verifyToken(h.slice(7)) : null;
};

// 极简滑动窗口限流（内存态，进程重启即清零；防洪泛足够）
const hits = new Map();
function rateLimit(ip, max = 240, windowMs = 60000) {
  const now = Date.now();
  const rec = hits.get(ip);
  if (!rec || now - rec.start > windowMs) { hits.set(ip, { start: now, n: 1 }); return true; }
  rec.n += 1;
  if (hits.size > 5000) hits.clear();   // 防内存膨胀
  return rec.n <= max;
}

const server = createServer(async (req, res) => {
  const ip = req.socket.remoteAddress || '?';
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { return send(res, 400, { error: 'bad_url' }); }
  // nginx 会以 /citytwin/api/ 前缀转发，这里同时兼容裸 /api/
  const path = url.pathname.replace(/^\/citytwin/, '');

  if (!rateLimit(ip)) return send(res, 429, { error: 'rate_limited' });

  try {
    // ---- 健康检查：探到内部真实状态 ----
    if (path === '/healthz' || path === '/api/healthz') {
      const mem = process.memoryUsage();
      const stale = Date.now() - lastTick > 30000;
      return send(res, stale ? 503 : 200, {
        ok: !stale,
        uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000),
        rssMb: Math.round(mem.rss / 1048576),
        heapMb: Math.round(mem.heapUsed / 1048576),
        tilesConfigured: tilesConfigured(),
        worldVersion: WORLD_VERSION,
        tiles: usageSnapshot(),
      });
    }

    // ---- 客户端启动配置（前端据此决定走代理还是自备 key / 降级白模）----
    if (path === '/api/config') {
      return send(res, 200, {
        worldVersion: WORLD_VERSION,
        photorealAvailable: tilesConfigured(),
        tilesEndpoint: tilesConfigured() ? '/citytwin/api/gtiles' : null,
        daily: dailyChallenge(),
      });
    }

    // ---- Google 3D Tiles 代理 ----
    if (path.startsWith('/api/gtiles/')) {
      const sub = path.slice('/api/gtiles'.length);
      const out = await proxyTile(sub, url.searchParams, bearer(req));
      if (out.json) return send(res, out.status, out.json);
      res.writeHead(out.status, {
        'content-type': out.contentType,
        'content-length': out.buffer.length,
        'cache-control': 'public, max-age=600',
        'x-ct-cache': out.cache || 'MISS',
      });
      return res.end(out.buffer);
    }

    // ---- 匿名身份 ----
    if (path === '/api/identity' && req.method === 'POST') {
      const body = await readJson(req);
      const id = createPlayer({ nickname: body.nickname, avatar: body.avatar, lang: body.lang });
      return send(res, 200, { token: issueToken(id), player: getPlayer(id) });
    }

    // 以下端点需要 token
    const playerId = bearer(req);
    const needAuth = () => send(res, 401, { error: 'unauthorized' });

    if (path === '/api/me') {
      if (!playerId) return needAuth();
      const p = getPlayer(playerId);
      if (!p) return send(res, 404, { error: 'player_not_found' });
      if (req.method === 'GET') { touchPlayer(playerId); return send(res, 200, { player: p, stats: playerStats(playerId) }); }
      if (req.method === 'PUT') {
        const patch = await readJson(req);
        return send(res, 200, { player: updateProfile(playerId, patch), stats: playerStats(playerId) });
      }
    }

    if (path === '/api/migrate/code' && req.method === 'POST') {
      if (!playerId) return needAuth();
      return send(res, 200, createMigrationCode(playerId));
    }
    if (path === '/api/migrate/redeem' && req.method === 'POST') {
      const body = await readJson(req);
      const r = redeemMigrationCode(body.code);
      if (r.error) return send(res, 400, r);
      return send(res, 200, { token: r.token, player: getPlayer(r.playerId), stats: playerStats(r.playerId) });
    }

    if (path === '/api/matches' && req.method === 'POST') {
      if (!playerId) return needAuth();
      const body = await readJson(req);
      const r = submitMatch(playerId, body);
      return send(res, r.valid ? 200 : 202, { ...r, stats: playerStats(playerId) });
    }

    if (path === '/api/leaderboard' && req.method === 'GET') {
      const q = url.searchParams;
      return send(res, 200, leaderboard({
        board: q.get('board') || 'fastest',
        city: q.get('city') || 'london',
        totalTime: q.get('totalTime'),
        difficulty: q.get('difficulty') || 'normal',
        dailyDate: q.get('dailyDate'),
        limit: q.get('limit'),
      }));
    }

    if (path === '/api/daily' && req.method === 'GET') return send(res, 200, dailyChallenge());

    return send(res, 404, { error: 'not_found', path });
  } catch (e) {
    const code = e && e.code === 413 ? 413 : (e && e.code === 400 ? 400 : 500);
    if (code === 500) console.error('[error]', path, e && e.stack || e);
    return send(res, code, { error: e && e.message || 'internal_error' });
  }
});

initDb();
server.listen(PORT, HOST, () => {
  console.log(`[citytwin] listening http://${HOST}:${PORT}  tiles=${GOOGLE_KEY ? 'on' : 'off'}  worldVersion=${WORLD_VERSION}`);
});

// 优雅退出：停止接受新连接 → 20 秒内退出（systemd 会在超时后 SIGKILL）
let closing = false;
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    if (closing) return;
    closing = true;
    console.log(`[citytwin] ${sig} received, shutting down…`);
    server.close(() => { closeDb(); process.exit(0); });
    setTimeout(() => { closeDb(); process.exit(0); }, 20000).unref();
  });
}

export { server };
