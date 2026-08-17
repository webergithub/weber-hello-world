/**
 * 优先来源：先查指定站点上「有没有这部片子」，把发现记成证据。
 *
 * 用途是侵权调查——要回答的是"某站上是否出现了这部作品"，
 * 产出是**证据记录**：地址、页面标题、摘要、发现时间、可选截图。
 *
 * ── 这个模块刻意不做的事 ─────────────────────────────────
 * 不解析播放直链、不抓 m3u8/mp4、不接播放器、不进下载队列。
 * 产出一律走 `leads`（线索）通道，永远不进 `sources`（片源）通道。
 *
 * 这不是保守，是这两条通道在架构上就不一样：`sources` 里的地址会被
 * /media 代理和 /api/download 使用，而那两个接口只放行
 * registry.ALLOWED_MEDIA_HOSTS 里的域名。优先来源不会往那个白名单里
 * 加任何东西，所以这里配什么域名，都不可能变成可播可下的地址。
 *
 * 换句话说：**这个模块只回答"在不在"，不回答"怎么拿"。**
 */

import { httpJson } from '../core/http.js';
import { runSerp, checkBackend } from './serp.js';
import { titleSimilarity } from '../core/match.js';

/** 一条证据记录长什么样。 */
function evidence({ domain, url, title, snippet, rank, term, termKind, query, via }) {
  return {
    kind: 'evidence',
    domain,
    url,
    title: title || '',
    snippet: snippet || '',
    rank: rank ?? null,
    term: term ?? null,
    termKind: termKind ?? null,
    // 标题相似度：太低的多半是站内导航或不相干条目，供人工复核时排序用
    similarity: query ? titleSimilarity(query.title, title || '') : null,
    // 取证要素：什么时候看到的、怎么看到的
    observedAt: new Date().toISOString(),
    via: via || null,
    // 明确标注：这条只是"看到了"，没有也不会去取播放地址
    note: '仅记录该站点上出现了匹配条目，未解析播放地址',
  };
}

/**
 * 用配置的检索后端，在单个域名内查这部片子。
 *
 * 走 `site:` 限定，复用已有的三种后端（api / cli / browser）——
 * 不为这个模块单独写爬虫。
 */
async function probeDomain(domain, query, terms, opts) {
  const { limit = 10, signal, fetchJson = httpJson, env, serp, browser } = opts;
  const found = [];
  const errors = [];

  for (const t of terms) {
    const q = `${t.term} site:${domain}`;
    try {
      const { results } = await runSerp('google', q, {
        limit, signal, fetchJson, env, serp, browser,
      });
      for (const r of results) {
        // 只收确实落在该域名下的结果——引擎偶尔会带回别的站
        let host = '';
        try { host = new URL(r.url).hostname; } catch { continue; }
        if (host !== domain && !host.endsWith(`.${domain}`)) continue;
        found.push(evidence({
          domain, url: r.url, title: r.title, snippet: r.snippet,
          rank: r.rank, term: t.term, termKind: t.kind, query, via: `site:${domain}`,
        }));
      }
    } catch (err) {
      errors.push(`「${t.term}」：${String(err?.message || err)}`);
    }
  }

  // 同一地址被多个词搜到只留一条
  const seen = new Set();
  const unique = found.filter((e) => !seen.has(e.url) && seen.add(e.url));
  return { domain, found: unique, errors };
}

/**
 * 给证据记录补截图。
 *
 * 截图是取证里最有说服力的一项——它证明"某年某月某日，这个地址上确实
 * 挂着这部片子的页面"。只截页面本身，不与页面里的播放器交互。
 */
export async function captureEvidence(browser, records, opts = {}) {
  const { limit = 5, timeoutMs = 20000, width = 1280, height = 800 } = opts;
  const targets = records.slice(0, limit);

  for (const rec of targets) {
    let page = null;
    try {
      page = await browser.newPage({ width, height });
      const nav = await page.goto(rec.url, { timeoutMs, waitUntil: 'load' });
      await new Promise((r) => setTimeout(r, 600));
      const meta = await page.evaluate(
        '({ title: document.title, len: document.body ? document.body.innerText.length : 0 })',
      ).catch(() => null);
      const shot = await page.screenshot({ format: 'jpeg', quality: 60 });
      rec.screenshot = `data:image/jpeg;base64,${shot.toString('base64')}`;
      rec.pageTitle = meta?.title ?? null;
      rec.loadMs = nav.elapsedMs;
      rec.capturedAt = new Date().toISOString();
    } catch (err) {
      rec.screenshotError = String(err?.message || err);
    } finally {
      if (page) await page.close().catch(() => {});
    }
  }
  return records;
}

/**
 * 造一个优先来源适配器。
 *
 * kind 是 'evidence' —— 管线据此决定它的产出只进线索、不进片源。
 * 这个 kind 是新加的第三类，与 direct / metadata 并列。
 *
 * @param {{domains: string[], label?: string, limitPerDomain?: number}} spec
 */
export function createPriorityAdapter(spec) {
  const domains = (spec.domains || []).filter(Boolean);

  return {
    id: 'priority',
    label: spec.label || '优先来源（只记录是否出现，不解析地址）',
    kind: 'evidence',
    domains,
    requiresConfig: true,
    configHint: '需要可用的检索后端（设置页「检索后端」）才能查这些站点',
    serp: spec.serp || null,

    checkConfig(env = process.env, opts = {}) {
      if (domains.length === 0) {
        return { available: false, reason: '优先来源列表为空，去设置页「优先来源」里填域名' };
      }
      // 查站点靠的是同一套检索后端，所以配置要求与引擎源完全一致
      return checkBackend(env, spec.serp, opts);
    },

    async search(query, opts = {}) {
      const terms = opts.terms?.length
        ? opts.terms
        : [{ term: query.title, kind: 'original', why: '原始输入' }];
      const limitPerDomain = spec.limitPerDomain ?? opts.limit ?? 10;

      // 按配置顺序逐个域名查——"优先"体现在顺序上，前面的先出结果
      const perDomain = [];
      for (const domain of domains) {
        perDomain.push(await probeDomain(domain, query, terms, {
          ...opts, serp: spec.serp, limit: limitPerDomain,
        }));
      }

      const leads = perDomain.flatMap((d) => d.found);
      const errors = perDomain.flatMap((d) => d.errors.map((e) => `${d.domain} ${e}`));

      return {
        provider: 'priority',
        items: [],
        // 关键：sources 永远是空的。这个模块不产出可播可下的地址。
        sources: [],
        leads,
        perDomain: perDomain.map((d) => ({
          domain: d.domain,
          hits: d.found.length,
          errors: d.errors,
        })),
        error: leads.length === 0 && errors.length > 0 ? errors[0] : null,
        stats: {
          domains: domains.length,
          hits: leads.length,
          terms: terms.length,
          limitPerDomain,
        },
      };
    },
  };
}
