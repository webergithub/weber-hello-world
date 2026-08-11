/**
 * TMDB 适配器 —— 提供两件事，都不产出直链：
 *
 * 1) **权威元数据**：规范片名、年份、海报、简介，尤其是 runtime（片长）。
 *    片长是打分环节"完整度"维度的参照系，有了它就能把 3 分钟的预告片
 *    和 96 分钟的正片区分开，这是 Top5 质量的关键输入。
 *
 * 2) **正版观看渠道（offers）**：TMDB 的 watch/providers 数据由 JustWatch 提供，
 *    覆盖 Netflix / Prime / Disney+ / Apple TV 等 300+ 服务、60+ 国家。
 *    这里返回的是"去哪个平台看"的落地页链接，不是视频文件地址——
 *    正版平台的播放地址是 DRM + 一次性签名令牌，既取不到也不该取。
 *
 * 合规要求：使用该数据必须署名 JustWatch，且引导用户跳转官方观看页。
 * 见 https://developer.themoviedb.org/reference/movie-watch-providers
 *
 * 需要 TMDB_API_KEY 环境变量；缺失时本适配器自动跳过，不影响其它源。
 */

import { httpJson } from '../core/http.js';
import { titleSimilarity, yearCompatible } from '../core/match.js';

const BASE = 'https://api.themoviedb.org/3';
const IMG = 'https://image.tmdb.org/t/p/w342';

/**
 * @param {{title: string, year: number|null}} query
 * @param {{apiKey?: string, region?: string, language?: string,
 *          signal?: AbortSignal, fetchJson?: typeof httpJson}} [opts]
 * @returns {Promise<{provider: string, titleInfo: object|null, offers: object[], error?: string}>}
 */
export async function search(query, opts = {}) {
  const {
    apiKey = process.env.TMDB_API_KEY,
    region = process.env.CINEROUTE_REGION || 'US',
    language = process.env.CINEROUTE_LANGUAGE || 'zh-CN',
    signal,
    fetchJson = httpJson,
  } = opts;

  if (!apiKey) {
    return { provider: 'tmdb', titleInfo: null, offers: [], error: 'TMDB_API_KEY 未配置，已跳过' };
  }

  const q = new URLSearchParams({
    api_key: apiKey,
    query: query.title,
    include_adult: 'false',
    language,
  });
  if (query.year) q.set('year', String(query.year));

  let results;
  try {
    const data = await fetchJson(`${BASE}/search/multi?${q}`, { signal, timeoutMs: 8000 });
    results = (data?.results || []).filter((r) => r.media_type === 'movie' || r.media_type === 'tv');
  } catch (err) {
    return { provider: 'tmdb', titleInfo: null, offers: [], error: String(err.message || err) };
  }

  const best = results
    .map((r) => {
      const name = r.title || r.name || '';
      const original = r.original_title || r.original_name || '';
      const date = r.release_date || r.first_air_date || '';
      const year = date ? Number(date.slice(0, 4)) : null;
      // 本地化片名与原始片名都要比：language=zh-CN 时 title 是中文，
      // 用户却可能输入英文原名（反之亦然），只比其中一个必然漏配。
      const similarity = Math.max(
        titleSimilarity(query.title, name),
        original ? titleSimilarity(query.title, original) : 0,
      );
      return { r, name, original, year, similarity };
    })
    .filter((c) => c.similarity >= 0.5 && yearCompatible(query.year, c.year))
    .sort((a, b) => b.similarity - a.similarity || (b.r.popularity || 0) - (a.r.popularity || 0))[0];

  if (!best) return { provider: 'tmdb', titleInfo: null, offers: [] };

  const kind = best.r.media_type === 'tv' ? 'tv' : 'movie';

  // 详情（拿 runtime）与观看渠道并发取，任一失败都不阻塞另一个。
  const [detail, providers] = await Promise.all([
    fetchJson(`${BASE}/${kind}/${best.r.id}?api_key=${apiKey}&language=${language}`, { signal, timeoutMs: 8000 })
      .catch(() => null),
    fetchJson(`${BASE}/${kind}/${best.r.id}/watch/providers?api_key=${apiKey}`, { signal, timeoutMs: 8000 })
      .catch(() => null),
  ]);

  // 电影是 runtime（分钟）；剧集是 episode_run_time 数组。
  let runtimeSec = null;
  if (detail?.runtime) runtimeSec = Number(detail.runtime) * 60;
  else if (Array.isArray(detail?.episode_run_time) && detail.episode_run_time[0]) {
    runtimeSec = Number(detail.episode_run_time[0]) * 60;
  }

  const regionData = providers?.results?.[region] || null;
  const offers = [];
  const pushOffers = (list, type, typeLabel) => {
    for (const p of list || []) {
      offers.push({
        type,
        typeLabel,
        providerName: p.provider_name,
        providerId: p.provider_id,
        logo: p.logo_path ? `${IMG}${p.logo_path}` : null,
        // TMDB 不返回各平台深链，官方要求跳到这个聚合观看页。
        link: regionData?.link || null,
        region,
      });
    }
  };
  pushOffers(regionData?.flatrate, 'flatrate', '订阅可看');
  pushOffers(regionData?.free, 'free', '免费可看');
  pushOffers(regionData?.ads, 'ads', '广告免费');
  pushOffers(regionData?.rent, 'rent', '租赁');
  pushOffers(regionData?.buy, 'buy', '购买');

  return {
    provider: 'tmdb',
    titleInfo: {
      tmdbId: best.r.id,
      kind,
      name: best.name,
      year: best.year,
      runtimeSec,
      overview: best.r.overview || detail?.overview || null,
      poster: best.r.poster_path ? `${IMG}${best.r.poster_path}` : null,
      similarity: best.similarity,
      tmdbUrl: `https://www.themoviedb.org/${kind}/${best.r.id}`,
    },
    offers,
    attribution: 'JustWatch',
  };
}

export const adapter = {
  id: 'tmdb',
  label: 'TMDB（元数据 + 正版观看渠道，数据来源 JustWatch）',
  kind: 'metadata',        // 只产出元数据与正版渠道，不产出直链
  requiresConfig: true,
  configHint: '设置环境变量 TMDB_API_KEY',
  search,
};
