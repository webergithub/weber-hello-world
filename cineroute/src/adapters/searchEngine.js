/**
 * 搜索引擎适配器（Google / Bing / 百度 / Yandex / DuckDuckGo，可自己加）。
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
 * 这几家都没有能直接用的免费官方 API：Google 的 Web Search API 早已停用，
 * Bing 的 2025 年 8 月退役，DuckDuckGo 没有官方搜索 API，百度和 Yandex 的不对外。
 * 所以检索做成三种可插拔后端（见 serp.js）：付费 SERP 服务、本机 CLI 工具、
 * 无头浏览器开结果页。没有任何一种可用时如实报告"未配置"，不假装搜过。
 */

import { httpJson, settleAll } from '../core/http.js';
import { titleSimilarity } from '../core/match.js';
import { runSerp, checkBackend, SERP_BACKENDS, SERP_PROVIDERS, PAGE_SIZE } from './serp.js';
import { extractSourcesFromMetadata } from './internetArchive.js';

// 兼容旧的引用点
export { SERP_PROVIDERS, SERP_BACKENDS, PAGE_SIZE };
export { normalizeSerp, engineSearchUrl, buildArgv, parseCliOutput } from './serp.js';

/* ───────────────────── 检索 ───────────────────── */

/**
 * 按配置的后端搜一个词并翻页。后端见 serp.js（默认 http，也可以选
 * api / cli / browser / ladder）—— 这里只关心"给我结果"，不关心怎么来的。
 */
export async function serpSearch(engine, q, opts = {}) {
  const { results } = await runSerp(engine, q, opts);
  return results;
}

/* ───────────────────── 页面 → 片源 ───────────────────── */

/** archive.org 详情页：/details/{identifier} */
const IA_DETAILS = /^https?:\/\/(?:www\.)?archive\.org\/details\/([^/?#]+)/i;
/** Commons 文件页：/wiki/File:xxx */
const COMMONS_FILE = /^https?:\/\/commons\.wikimedia\.org\/wiki\/(File|文件):(.+)$/i;

/**
 * 把搜到的页面解析成真实片源。只处理域名认识的，其余原样返回为"线索"。
 *
 * **片名对不上的要挡在外面。** 引擎给的是"这个页面里出现过你搜的词"，
 * 不是"这个页面就是那部片"——搜「阿凡达」它会给你 archive.org 上的
 * 《降世神通》（英文名 Avatar: The Last Airbender），搜「我不是酒神」
 * 它会自作主张纠正成《我不是药神》。这些页面确实在 archive.org 上、
 * 确实能解析出能播的 mp4，唯一的问题是**那不是用户要的片子**。
 *
 * 别的适配器（IA、Commons、Jellyfin）都在自己那头做了这道过滤，只有这里
 * 漏了：相似度算了、挂在片源上了，就是没拿它筛过。于是搜「阿凡达」的
 * 第一推荐位是一集《降世神通》，而且分还挺高（480p、mp4、23 分钟，
 * 各项指标都很正常）——错得非常理直气壮。
 *
 * 被挡下来的不删掉，**转成线索并写明理由**：调研取证要能回答"这条为什么
 * 没进来"，静悄悄丢掉等于把证据链掐断。
 *
 * @param {{fetchJson?: Function, signal?: AbortSignal, engineId?: string,
 *          engineLabel?: string, minSimilarity?: number}} [opts]
 * @returns {Promise<{sources: object[], leads: object[]}>}
 */
export async function resolveResults(results, query, opts = {}) {
  const {
    fetchJson = httpJson, signal, engineId, engineLabel,
    // 跟 internetArchive.js 用同一档（0.55）：引擎这条路解析的正是
    // archive.org 的条目，同一部片从两条路进来待遇不该不一样。
    // 0.5 挡不住「我不是药神」冒充「我不是酒神」——二元组只对上一半正好是 0.50，
    // 卡在门槛线上。
    minSimilarity = 0.55,
  } = opts;
  /** 片名对不上时的线索理由。把数字写出来，方便判断门槛该不该调。 */
  const mismatch = (name, similarity) =>
    `片名对不上：《${name}》与「${query.title}」相似度 ${similarity.toFixed(2)}，低于门槛 ${minSimilarity}`;
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
    const name = meta.metadata?.title || r.title || id;
    const similarity = titleSimilarity(query.title, name);
    if (similarity < minSimilarity) { leads.push(toLead(r, engineId, mismatch(name, similarity))); return; }
    for (const s of extracted) {
      sources.push({ ...s, similarity, ...citation(r, engineId, engineLabel) });
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
        const similarity = titleSimilarity(query.title, name);
        if (similarity < minSimilarity) {
          if (lead) leads.push(toLead(lead.r, engineId, mismatch(name, similarity)));
          continue;
        }
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
          similarity,
          rangeSupported: null, reachable: null,
          ...(lead ? citation(lead.r, engineId, engineLabel) : { discoveredBy: engineId, discoveredByLabel: engineLabel }),
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

/**
 * 溯源信息。取证要能回答「这个地址是怎么来的」——
 * 哪个引擎、用哪个检索词、在结果里排第几、落地页是哪个。
 * 这几个字段会一路带到最终结果，第三个 tab 的「引用」就是它们。
 */
function citation(r, engineId, engineLabel) {
  return {
    discoveredBy: engineId,
    // 「谁发现的」的显示名。注意与片源自带的 providerLabel 区分：
    // 后者是文件托管在哪（Internet Archive），前者是哪个引擎搜到的。
    // 取证要的是后者，混用会让所有引用看起来都来自同一个源。
    discoveredByLabel: engineLabel || engineId,
    discoveredRank: r.rank ?? null,
    discoveredTerm: r.term ?? null,
    discoveredTermKind: r.termKind ?? null,
    // 引擎搜到的那个页面地址（不是最终的视频直链）
    discoveredVia: r.url ?? null,
    discoveredTitle: r.title ?? null,
  };
}

function toLead(r, engineId, reason) {
  return {
    url: r.url, title: r.title, snippet: r.snippet,
    rank: r.rank, term: r.term ?? null, termKind: r.termKind ?? null,
    discoveredBy: engineId, reason,
  };
}

/* ───────────────────── 适配器工厂 ───────────────────── */

/**
 * 把站点范围拼成 site: 过滤条件。
 *
 * **默认没有站点范围**，这里原样返回片名，也就是全网搜。只有用户在设置页
 * 里明确填了域名才会加限定——加了就是一条 `(site:a OR site:b OR …)`
 * 挂在词后面，引擎只在这几个站里翻。
 */
export function buildScopedQuery(title, siteScope) {
  const scope = (siteScope || []).filter(Boolean);
  if (scope.length === 0) return title;
  return `${title} (${scope.map((s) => `site:${s}`).join(' OR ')})`;
}

/** 引擎显示名。用户自己加的引擎不在表里，就首字母大写兜底。 */
export const ENGINE_LABELS = {
  google: 'Google', bing: 'Bing', baidu: '百度', yandex: 'Yandex', duckduckgo: 'DuckDuckGo',
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
  // 名字要如实反映这次到底限不限站点——默认不限，就别再挂个"（限定站点范围）"
  // 的尾巴让人以为搜的范围很小
  const scopeCount = (spec.siteScope || []).filter(Boolean).length;
  const label = spec.label
    || `${name}${gap}搜索${scopeCount ? `（限定 ${scopeCount} 个站点）` : ''}`;

  return {
    id: spec.id,
    label,
    kind: 'direct',
    requiresConfig: true,
    configHint: '默认就能用：直接请求结果页并解析，不用配任何东西。'
      + '想更稳可以到设置页「检索后端」里换：api 需填服务商与 key；'
      + 'cli 需填命令模板；browser / ladder 要这台机器上真装了浏览器',
    engine,
    siteScope: spec.siteScope || null,
    // 设置页里配的检索后端。跟着适配器走，这样每个引擎理论上可以配不同后端。
    serp: spec.serp || null,

    /** 自查配置。三种后端只要有一种配齐就算可用。 */
    checkConfig(env = process.env, opts = {}) {
      return checkBackend(env, spec.serp, opts);
    },

    /**
     * 按给定的检索词逐个搜，保留「哪个词搜出哪条结果」的原始账目。
     *
     * `opts.terms` 是调用方（管线）算好的词表，包含原词、近似词、推荐词。
     * 不传就退化成只搜片名——保证单独调用适配器时行为不变。
     */
    async search(query, opts = {}) {
      const limit = opts.limit ?? 100;
      const scope = spec.siteScope || opts.siteScope || [];
      const terms = opts.terms?.length
        ? opts.terms
        : [{ term: query.title, kind: 'original', why: '原始输入' }];

      // 多个词共用一个总配额，别让词数把请求数乘爆
      const perTerm = Math.max(1, Math.floor(limit / terms.length));
      const related = [];
      const backendNotes = [];
      let usedBackend = null;
      const rounds = [];
      const allResults = [];
      let firstError = null;

      for (const t of terms) {
        const q = buildScopedQuery(t.term, scope);
        let results;
        try {
          const r = await runSerp(engine, q, { ...opts, serp: spec.serp, limit: perTerm });
          results = r.results;
          related.push(...r.related);
          if (r.notes?.length) backendNotes.push(...r.notes);
          usedBackend = r.backend;
        } catch (err) {
          firstError ??= String(err.message || err);
          rounds.push({ ...t, query: q, returned: 0, error: firstError, results: [] });
          continue;
        }
        // 标注来源：这条是哪个引擎、用哪个词、第几名搜到的——取证时要能倒查
        const tagged = results.map((r) => ({
          ...r, engine: spec.id, term: t.term, termKind: t.kind,
        }));
        rounds.push({ ...t, query: q, returned: tagged.length, error: null, results: tagged });
        allResults.push(...tagged);
      }

      // 一个词都没搜成才算整体失败；部分失败保留已有结果
      if (allResults.length === 0 && firstError) {
        return {
          provider: spec.id, items: [], sources: [], leads: [],
          error: firstError, rounds, related: [],
        };
      }

      const { sources, leads } = await resolveResults(allResults, query, { ...opts, engineId: spec.id, engineLabel: label });
      return {
        provider: spec.id,
        items: [],
        sources,
        leads,
        // 第一步原始账目：逐词的搜索结果，未去重、未筛选
        rounds,
        related,
        backend: usedBackend,
        backendNotes: [...new Set(backendNotes)],
        stats: {
          backend: usedBackend,
          terms: terms.length,
          returned: allResults.length,
          resolved: sources.length,
          unresolved: leads.length,
          limit,
          perTerm,
        },
      };
    },
  };
}
