/**
 * 搜索引擎适配器（Google / 百度 / Bing / DuckDuckGo，可自己加）。
 *
 * 分工很明确：**引擎只负责"发现页面"，把页面变成播放直链交给结构化解析器。**
 * 不去爬任意页面翻 <video> 标签——那条路第一，技术上早就不成立（现在的视频
 * 都是 HLS/DASH + DRM + 一次性签名）；第二，能被裸抓到的几乎必然是盗版副本。
 *
 * 引擎检索限定在配置的站点范围内（拼成 site: 过滤条件）。它的作用是补上
 * 没写专用适配器的归档站——比如国会图书馆、Europeana、荷兰开放影像。
 * 搜到的页面里，域名能对上解析器的（archive.org 详情页、Commons 文件页）
 * 会被解析成真实片源；对不上的作为"发现的页面"列出来，不猜也不编。
 *
 * 四个引擎都没有能直接用的免费官方 API：Google 的 Web Search API 早已停用，
 * Bing 的 2025 年 8 月退役，DuckDuckGo 没有官方搜索 API，百度的不对外。
 * 所以这里做成可插拔的 SERP 后端，需要配 key；没配就如实报告"未配置"。
 */

import { httpJson, settleAll } from '../core/http.js';
import { titleSimilarity } from '../core/match.js';
import { extractSourcesFromMetadata } from './internetArchive.js';

/* ───────────────────── SERP 后端 ───────────────────── */

/** 支持的 SERP 服务商。custom 用 URL 模板，自己接别的服务。 */
export const SERP_PROVIDERS = ['serper', 'brave', 'custom'];

function serpSettings(env = process.env) {
  return {
    provider: env.CINEROUTE_SERP_PROVIDER || null,
    key: env.CINEROUTE_SERP_KEY || null,
    urlTemplate: env.CINEROUTE_SERP_URL || null,
  };
}

/**
 * 每个引擎单次请求能拿多少条，用来算要翻几页。
 */
const PAGE_SIZE = { google: 10, bing: 50, duckduckgo: 10, baidu: 10 };

/**
 * 调 SERP 服务，返回规范化的结果列表。
 *
 * @param {string} engine 'google' | 'baidu' | 'bing' | 'duckduckgo' | 自定义
 * @param {string} q 已经拼好 site: 过滤条件的查询串
 * @param {{limit?: number, signal?: AbortSignal, fetchJson?: Function, env?: object}} [opts]
 * @returns {Promise<Array<{url:string,title:string,snippet:string,rank:number}>>}
 */
export async function serpSearch(engine, q, opts = {}) {
  const { limit = 100, signal, fetchJson = httpJson, env = process.env } = opts;
  const { provider, key, urlTemplate } = serpSettings(env);

  if (!provider) throw new Error('未配置 CINEROUTE_SERP_PROVIDER');
  if (provider !== 'custom' && !key) throw new Error('未配置 CINEROUTE_SERP_KEY');

  const pageSize = PAGE_SIZE[engine] ?? 10;
  const pages = Math.min(10, Math.ceil(limit / pageSize));   // 最多翻 10 页，防止把额度打光
  const out = [];

  for (let page = 1; page <= pages && out.length < limit; page += 1) {
    let data;
    try {
      data = await callProvider({ provider, key, urlTemplate, engine, q, pageSize, page, signal, fetchJson });
    } catch (err) {
      // 前几页已经有结果就别因为后面某页失败而全丢
      if (out.length > 0) break;
      throw err;
    }
    const items = normalizeSerp(provider, data);
    if (items.length === 0) break;                            // 没有更多结果
    for (const it of items) {
      if (out.length >= limit) break;
      out.push({ ...it, rank: out.length + 1 });
    }
    // 返回不满一页说明结果到头了，再翻一页只是白花一次配额。
    if (items.length < pageSize) break;
  }
  return out;
}

async function callProvider({ provider, key, urlTemplate, engine, q, pageSize, page, signal, fetchJson }) {
  if (provider === 'serper') {
    // serper.dev：POST，engine 走不同子域
    const host = engine === 'google' ? 'google.serper.dev' : `${engine}.serper.dev`;
    return fetchJson(`https://${host}/search`, {
      method: 'POST',
      headers: { 'X-API-KEY': key, 'content-type': 'application/json' },
      body: JSON.stringify({ q, num: pageSize, page }),
      signal,
      timeoutMs: 12000,
    });
  }
  if (provider === 'brave') {
    const p = new URLSearchParams({ q, count: String(pageSize), offset: String((page - 1) * pageSize) });
    return fetchJson(`https://api.search.brave.com/res/v1/web/search?${p}`, {
      headers: { 'X-Subscription-Token': key, accept: 'application/json' },
      signal,
      timeoutMs: 12000,
    });
  }
  // custom：URL 模板，占位符 {query} {engine} {limit} {page} {key}
  if (!urlTemplate) throw new Error('provider=custom 需要同时配置 CINEROUTE_SERP_URL');
  const url = urlTemplate
    .replace('{query}', encodeURIComponent(q))
    .replace('{engine}', encodeURIComponent(engine))
    .replace('{limit}', String(pageSize))
    .replace('{page}', String(page))
    .replace('{key}', encodeURIComponent(key || ''));
  return fetchJson(url, { signal, timeoutMs: 12000 });
}

/** 把各家不同的响应结构压成统一形状。 */
export function normalizeSerp(provider, data) {
  const pick = (arr, mapper) => (Array.isArray(arr) ? arr.map(mapper).filter((x) => x.url) : []);
  if (provider === 'brave') {
    return pick(data?.web?.results, (r) => ({
      url: r.url, title: r.title || '', snippet: r.description || '',
    }));
  }
  // serper 与 custom 都按 organic 数组取，custom 也兼容 results
  return pick(data?.organic || data?.results, (r) => ({
    url: r.link || r.url, title: r.title || '', snippet: r.snippet || r.description || '',
  }));
}

/* ───────────────────── 页面 → 片源 ───────────────────── */

/** archive.org 详情页：/details/{identifier} */
const IA_DETAILS = /^https?:\/\/(?:www\.)?archive\.org\/details\/([^/?#]+)/i;
/** Commons 文件页：/wiki/File:xxx */
const COMMONS_FILE = /^https?:\/\/commons\.wikimedia\.org\/wiki\/(File|文件):(.+)$/i;

/**
 * 把搜到的页面解析成真实片源。只处理域名认识的，其余原样返回为"线索"。
 *
 * @returns {Promise<{sources: object[], leads: object[]}>}
 */
export async function resolveResults(results, query, opts = {}) {
  const { fetchJson = httpJson, signal, engineId } = opts;
  const sources = [];
  const leads = [];

  const iaIds = [];
  const commonsTitles = [];
  const rest = [];

  for (const r of results) {
    const ia = r.url.match(IA_DETAILS);
    if (ia) { iaIds.push({ id: decodeURIComponent(ia[1]), r }); continue; }
    const cm = r.url.match(COMMONS_FILE);
    if (cm) { commonsTitles.push({ title: decodeURIComponent(cm[2]).replace(/_/g, ' '), r }); continue; }
    rest.push(r);
  }

  // archive.org：拿 metadata 展开成逐文件片源（复用已有解析器）
  const metas = await settleAll(iaIds.map(({ id }) => () =>
    fetchJson(`https://archive.org/metadata/${encodeURIComponent(id)}`, { signal, timeoutMs: 10000 })));
  metas.forEach((meta, i) => {
    const { id, r } = iaIds[i];
    if (!meta) { leads.push(toLead(r, engineId, '详情页解析失败')); return; }
    const extracted = extractSourcesFromMetadata(meta, { identifier: id });
    if (extracted.length === 0) { leads.push(toLead(r, engineId, '该条目没有视频文件')); return; }
    const similarity = titleSimilarity(query.title, meta.metadata?.title || r.title || id);
    for (const s of extracted) {
      sources.push({ ...s, similarity, discoveredBy: engineId, discoveredRank: r.rank });
    }
  });

  // Commons 文件页：走 imageinfo 拿直链
  if (commonsTitles.length) {
    const params = new URLSearchParams({
      action: 'query', format: 'json', formatversion: '2',
      titles: commonsTitles.map(({ title }) => `File:${title}`).join('|'),
      prop: 'imageinfo', iiprop: 'url|size|mime|extmetadata|dimensions', origin: '*',
    });
    try {
      const data = await fetchJson(`https://commons.wikimedia.org/w/api.php?${params}`, { signal, timeoutMs: 10000 });
      const pages = Array.isArray(data?.query?.pages) ? data.query.pages : Object.values(data?.query?.pages || {});
      for (const page of pages) {
        const info = page?.imageinfo?.[0];
        const lead = commonsTitles.find(({ title }) => String(page.title || '').includes(title));
        if (!info?.url) { if (lead) leads.push(toLead(lead.r, engineId, '未取到文件地址')); continue; }
        const name = String(page.title || '').replace(/^File:/i, '');
        sources.push({
          id: `commons:${page.pageid}`,
          provider: 'wikimedia-commons',
          providerLabel: 'Wikimedia Commons',
          title: name.replace(/\.[a-z0-9]{2,5}$/i, ''),
          filename: name,
          url: info.url,
          pageUrl: info.descriptionurl,
          container: (info.url.match(/\.([a-z0-9]{2,5})$/i) || [])[1]?.toLowerCase() || '',
          width: info.width || null, height: info.height || null,
          durationSec: info.duration ? Number(info.duration) : null,
          bytes: info.size || null,
          license: info.extmetadata?.LicenseUrl?.value || info.extmetadata?.LicenseShortName?.value || '',
          collections: ['wikimedia-commons'], downloads: 0,
          checksums: { md5: null, sha1: info.sha1 || null },
          similarity: titleSimilarity(query.title, name),
          rangeSupported: null, reachable: null,
          discoveredBy: engineId,
          discoveredRank: lead?.r.rank ?? null,
        });
      }
    } catch {
      for (const { r } of commonsTitles) leads.push(toLead(r, engineId, 'Commons 查询失败'));
    }
  }

  // 其余页面只作为线索列出，不去猜里面有没有视频
  for (const r of rest) leads.push(toLead(r, engineId, '该域名没有对应的解析器'));

  return { sources, leads };
}

function toLead(r, engineId, reason) {
  return {
    url: r.url, title: r.title, snippet: r.snippet,
    rank: r.rank, discoveredBy: engineId, reason,
  };
}

/* ───────────────────── 适配器工厂 ───────────────────── */

/** 把站点范围拼成 site: 过滤条件。 */
export function buildScopedQuery(title, siteScope) {
  const scope = (siteScope || []).filter(Boolean);
  if (scope.length === 0) return title;
  return `${title} (${scope.map((s) => `site:${s}`).join(' OR ')})`;
}

/** 引擎显示名。用户自己加的引擎不在表里，就首字母大写兜底。 */
export const ENGINE_LABELS = {
  google: 'Google', baidu: '百度', bing: 'Bing', duckduckgo: 'DuckDuckGo',
};

/**
 * 造一个引擎适配器。
 *
 * @param {{id:string, engine:string, label?:string, siteScope?:string[]}} spec
 */
export function createEngineAdapter(spec) {
  const engine = spec.engine || spec.id.replace(/^engine:/, '');
  const name = ENGINE_LABELS[engine] || `${engine[0].toUpperCase()}${engine.slice(1)}`;
  // 中文名后面不加空格（「百度搜索」），西文名后面加（「Google 搜索」）。
  const gap = /[一-龥]$/.test(name) ? '' : ' ';
  const label = spec.label || `${name}${gap}搜索（限定站点范围）`;

  return {
    id: spec.id,
    label,
    kind: 'direct',
    requiresConfig: true,
    configHint: '设置 CINEROUTE_SERP_PROVIDER 与 CINEROUTE_SERP_KEY（四大引擎均无免费官方 API，需接 SERP 服务）',
    engine,
    siteScope: spec.siteScope || null,

    /** 自查配置。没配就如实报告"未配置"，不假装能搜。 */
    checkConfig(env = process.env) {
      const { provider, key, urlTemplate } = serpSettings(env);
      if (!provider) {
        return { available: false, reason: '未配置 SERP 服务（CINEROUTE_SERP_PROVIDER）' };
      }
      if (!SERP_PROVIDERS.includes(provider)) {
        return { available: false, reason: `不认识的 SERP 服务 ${provider}，可选：${SERP_PROVIDERS.join(' / ')}` };
      }
      if (provider === 'custom' && !urlTemplate) {
        return { available: false, reason: 'provider=custom 需要同时配置 CINEROUTE_SERP_URL' };
      }
      if (provider !== 'custom' && !key) {
        return { available: false, reason: '未配置 CINEROUTE_SERP_KEY' };
      }
      return { available: true, reason: null };
    },

    async search(query, opts = {}) {
      const limit = opts.limit ?? 100;
      const scope = spec.siteScope || opts.siteScope || [];
      const q = buildScopedQuery(query.title, scope);

      let results;
      try {
        results = await serpSearch(engine, q, { ...opts, limit });
      } catch (err) {
        return { provider: spec.id, items: [], sources: [], leads: [], error: String(err.message || err) };
      }

      const { sources, leads } = await resolveResults(results, query, { ...opts, engineId: spec.id });
      return {
        provider: spec.id,
        items: [],
        sources,
        leads,
        stats: { returned: results.length, resolved: sources.length, unresolved: leads.length, limit },
      };
    },
  };
}
