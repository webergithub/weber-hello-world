// Google Photorealistic 3D Tiles 代理：服务端持 key，客户端永不接触。
// 合规要点：只放行白名单路径、不做长期落盘复制（仅内存短 TTL）、客户端保留 Google 归属信息。
import { GOOGLE_KEY, TILES_UPSTREAM } from './config.js';
import { checkQuota, recordTile } from './quota.js';

// 白名单：只允许 3D Tiles 相关路径，拒绝任意透传（防被当通用代理滥用）
const ALLOWED = [/^\/v1\/3dtiles\//, /^\/v1\/createSession/];

// 短 TTL 内存缓存：只为性能，不落盘、不长期保存
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 300;
const cache = new Map();   // url -> {expires, status, ct, body}

function cacheGet(k) {
  const e = cache.get(k);
  if (!e) return null;
  if (e.expires < Date.now()) { cache.delete(k); return null; }
  cache.delete(k); cache.set(k, e);   // LRU：命中后移到末尾
  return e;
}

function cacheSet(k, v) {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(k, v);
}

export function tilesConfigured() { return !!GOOGLE_KEY; }

/**
 * 处理 /api/gtiles/* 转发。
 * @param {string} subPath 形如 /v1/3dtiles/root.json
 * @param {URLSearchParams} query 客户端带来的查询串（session 等；key 一律剥除）
 * @param {string|null} playerId
 */
export async function proxyTile(subPath, query, playerId) {
  if (!GOOGLE_KEY) {
    return { status: 503, json: { error: 'tiles_not_configured', fallback: 'openmap',
      message: '服务端未配置 Google key，请在页面自填 key 或使用开放数据地图' } };
  }
  if (!ALLOWED.some((re) => re.test(subPath))) {
    return { status: 403, json: { error: 'path_not_allowed' } };
  }

  const q = checkQuota(playerId);
  if (!q.ok) {
    // 熔断：明确告诉客户端降级，避免它反复重试把额度耗尽
    return { status: 429, json: { error: 'quota_exceeded', layer: q.layer, limit: q.limit,
      fallback: 'openmap', message: '照片级地图今日额度已用完，已自动切换回开放数据地图' } };
  }

  // 客户端传来的 key 一律忽略，改用服务端的
  const params = new URLSearchParams(query);
  params.delete('key');
  params.set('key', GOOGLE_KEY);
  const upstreamUrl = `${TILES_UPSTREAM}${subPath}?${params.toString()}`;
  const cacheKey = `${subPath}?${new URLSearchParams([...params].filter(([k]) => k !== 'key')).toString()}`;

  const hit = cacheGet(cacheKey);
  if (hit) {
    recordTile(playerId, 0);   // 缓存命中不计上游用量
    return { status: hit.status, buffer: hit.body, contentType: hit.ct, cache: 'HIT' };
  }

  let res;
  try {
    res = await fetch(upstreamUrl, {
      headers: { 'User-Agent': 'CityTwin/0.1 (+https://github.com/webergithub/weber-hello-world)' },
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) {
    return { status: 502, json: { error: 'upstream_unreachable', detail: String(e && e.message || e) } };
  }

  const buf = Buffer.from(await res.arrayBuffer());
  const ct = res.headers.get('content-type') || 'application/octet-stream';
  if (res.ok) {
    recordTile(playerId, 1);
    cacheSet(cacheKey, { expires: Date.now() + CACHE_TTL_MS, status: res.status, ct, body: buf });
  }
  // 上游报错原样透传状态码，但绝不回显含 key 的 URL
  return { status: res.status, buffer: buf, contentType: ct, cache: 'MISS' };
}
