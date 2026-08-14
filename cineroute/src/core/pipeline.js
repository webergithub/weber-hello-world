/**
 * 检索编排：一次输入 → 多源并发 → 深度解析 → 探测 → 打分 → Top5。
 *
 * 关键设计：**两趟排名**。
 * 第一趟用上游元数据做预排名，选出前 K 个候选；只对这 K 个发探测请求
 * （HEAD / Range），拿到真实的可达性与 Range 支持；第二趟带着探测结果重排。
 * 这样既让"可播性"这个最高权重维度建立在事实而非声明之上，
 * 又把探测请求数从"全部候选"压到常数级。
 */

import { parseQuery } from './match.js';
import { rankSources, estimateReferenceRuntime, computeMaxDuration } from './score.js';
import { probeAll } from './probe.js';
import { buildAdapters, adapterAvailability } from '../adapters/registry.js';
import { defaultConfig } from './sourceConfig.js';
import { planFirstRound, planSecondRound } from './expand.js';

/**
 * 把两轮的适配器结果按源合并。
 *
 * 第二轮只跑引擎源，所以它的记录要并回第一轮对应的那条上，
 * 而不是让同一个引擎在数据源列表里出现两次。
 */
function mergeRuns(runs1, runs2) {
  if (runs2.length === 0) return runs1;
  const byId = new Map(runs2.map((r) => [r.id, r]));
  return runs1.map((r) => {
    const extra = byId.get(r.id);
    if (!extra) return r;
    return {
      ...r,
      status: r.status === 'ok' || extra.status === 'ok' ? 'ok' : r.status,
      count: (r.count ?? 0) + (extra.count ?? 0),
      elapsedMs: (r.elapsedMs ?? 0) + (extra.elapsedMs ?? 0),
      stats: r.stats && extra.stats
        ? {
            ...r.stats,
            terms: (r.stats.terms ?? 0) + (extra.stats.terms ?? 0),
            returned: (r.stats.returned ?? 0) + (extra.stats.returned ?? 0),
            resolved: (r.stats.resolved ?? 0) + (extra.stats.resolved ?? 0),
            unresolved: (r.stats.unresolved ?? 0) + (extra.stats.unresolved ?? 0),
          }
        : (r.stats ?? extra.stats),
      result: {
        ...(r.result ?? {}),
        sources: [...(r.result?.sources ?? []), ...(extra.result?.sources ?? [])],
        leads: [...(r.result?.leads ?? []), ...(extra.result?.leads ?? [])],
        rounds: [...(r.result?.rounds ?? []), ...(extra.result?.rounds ?? [])],
        related: [...(r.result?.related ?? []), ...(extra.result?.related ?? [])],
      },
    };
  });
}

/**
 * 给单个适配器套超时与错误隔离，返回统一的状态记录。
 * `limit` 是这一次该取多少条——来自配置，不是写死的。
 */
async function runAdapter({ adapter, limit }, query, opts) {
  const started = Date.now();
  const availability = adapterAvailability(adapter);
  const base = { id: adapter.id, label: adapter.label, kind: adapter.kind, limit: limit ?? null };

  if (!availability.available) {
    return { ...base, status: 'skipped', reason: availability.reason, count: 0, elapsedMs: 0, result: null };
  }

  try {
    const result = await adapter.search(query, limit == null ? opts : { ...opts, limit });
    const count = (result?.sources?.length ?? 0) || (result?.offers?.length ?? 0);
    return {
      ...base,
      status: result?.error ? 'error' : 'ok',
      reason: result?.error ?? null,
      count,
      // 引擎源额外报告"搜到多少页 / 解析出多少 / 多少条没有解析器"
      stats: result?.stats ?? null,
      elapsedMs: Date.now() - started,
      result,
    };
  } catch (err) {
    return {
      ...base,
      status: 'error', reason: String(err?.message || err),
      count: 0, elapsedMs: Date.now() - started, result: null,
    };
  }
}

/**
 * 去重：同一个文件可能被多个源报出来（镜像、同条目不同入口）。
 * 优先按 md5/sha1 合并——校验和相同就是同一个文件，与 URL 无关；
 * 没有校验和时退化为按 URL 合并。
 *
 * @param {object[]} sources
 */
export function dedupeSources(sources) {
  return dedupeWithTrail(sources).kept;
}

/**
 * 线索去重。
 *
 * 同一个页面会被多个引擎、多个检索词反复搜到，不合并的话列表里同一条
 * 会出现七八遍——看着像搜到很多，其实是同一个东西。按 URL 合并，
 * 把「谁用什么词搜到的」累加成引用列表，这才是调研要的信息。
 *
 * @param {object[]} leads
 */
export function dedupeLeads(leads) {
  const byUrl = new Map();
  for (const l of leads) {
    const g = byUrl.get(l.url);
    const cite = {
      provider: l.discoveredBy,
      term: l.term ?? null,
      termKind: l.termKind ?? null,
      rank: l.rank ?? null,
      via: l.url,
    };
    if (!g) {
      byUrl.set(l.url, { ...l, citations: [cite], foundByCount: 1 });
      continue;
    }
    const dup = g.citations.some((c) => c.provider === cite.provider && c.term === cite.term);
    if (!dup) g.citations.push(cite);
    g.foundByCount = new Set(g.citations.map((c) => c.provider)).size;
  }
  return [...byUrl.values()];
}

/** 通过甄别的片源，一句话说明它凭什么算「可用」。 */
function playableReason(s) {
  const bits = [];
  if (s.probeOutcome === 'ok' || s.reachable === true) bits.push('地址可达');
  else if (s.probed) bits.push('探测未得到明确结论，按上游元数据判定');
  else bits.push('未探测（超出本次探测配额），按上游元数据判定');
  if (s.container) bits.push(`${s.container.toUpperCase()} 浏览器可直接播放`);
  if (s.rangeSupported === true) bits.push('支持 Range，可拖动与断点续传');
  if (s.checksums?.md5 || s.checksums?.sha1) bits.push('上游提供校验和，可核对完整性');
  return bits.join('；');
}

/** 单条片源的溯源记录：这条是谁、用什么词、在第几名搜到的。 */
function citationOf(s) {
  return {
    // provider/providerLabel = **谁发现的**（引擎或专用源）
    provider: s.discoveredBy || s.provider,
    providerLabel: s.discoveredByLabel || s.providerLabel || null,
    // host = 文件**托管在哪**。两者不是一回事：Google 搜到一个
    // 托管在 archive.org 的文件，发现者是 Google，托管方是 Internet Archive。
    host: s.provider || null,
    hostLabel: s.providerLabel || null,
    term: s.discoveredTerm ?? null,
    termKind: s.discoveredTermKind ?? null,
    rank: s.discoveredRank ?? null,
    via: s.discoveredVia ?? s.pageUrl ?? null,
    viaTitle: s.discoveredTitle ?? null,
    url: s.url,
  };
}

/**
 * 去重，并留下合并账目。
 *
 * 与 dedupeSources 的区别只在返回值：这里额外给出每个分组合并了哪些来源，
 * 供「第二步」页面展示——调研时需要看到"这条被三个引擎同时搜到"这个事实，
 * 光给去重后的结果等于把证据链掐断了。
 *
 * 合并时**溯源记录是累加的**：同一个文件被 Google 和百度分别搜到，
 * 两条来路都要保留，否则只剩一条会让人误以为只有一个引擎命中。
 *
 * @param {object[]} sources
 * @returns {{kept: object[], groups: object[], removed: number}}
 */
export function dedupeWithTrail(sources) {
  const richness = (x) => (x.height ? 1 : 0) + (x.durationSec ? 1 : 0) + (x.bytes ? 1 : 0);
  /** @type {Map<string, {key:string, keyKind:string, best:object, members:object[]}>} */
  const groups = new Map();

  for (const s of sources) {
    const [keyKind, key] = s.checksums?.md5
      ? ['md5', `md5:${s.checksums.md5}`]
      : s.checksums?.sha1
        ? ['sha1', `sha1:${s.checksums.sha1}`]
        : ['url', `url:${s.url}`];

    const g = groups.get(key);
    if (!g) {
      groups.set(key, { key, keyKind, best: s, members: [s] });
      continue;
    }
    g.members.push(s);
    // 保留信息更全的那条（有分辨率/时长/体积的优先）
    if (richness(s) > richness(g.best)) g.best = s;
  }

  const kept = [];
  const trail = [];
  for (const g of groups.values()) {
    const citations = g.members.map(citationOf);
    // 同一个源同一个词重复上报的没有信息量，按 provider+term+url 去个重
    const seenCite = new Set();
    const uniqueCitations = citations.filter((c) => {
      const k = `${c.provider}|${c.term}|${c.via}`;
      if (seenCite.has(k)) return false;
      seenCite.add(k);
      return true;
    });

    kept.push({
      ...g.best,
      mirrors: g.members.length - 1,
      citations: uniqueCitations,
      // 有几个不同的来源报了这条——被多个引擎独立命中是可信度信号
      foundByCount: new Set(uniqueCitations.map((c) => c.provider)).size,
    });

    trail.push({
      key: g.key,
      keyKind: g.keyKind,
      keyLabel: { md5: '按 md5 校验和合并', sha1: '按 sha1 校验和合并', url: '按 URL 合并' }[g.keyKind],
      url: g.best.url,
      filename: g.best.filename || g.best.title || g.best.url,
      count: g.members.length,
      merged: g.members.length - 1,
      citations: uniqueCitations,
    });
  }

  return { kept, groups: trail, removed: sources.length - kept.length };
}

/**
 * 正版渠道的展示优先级：订阅 → 租赁 → 购买 → 广告免费。
 * 推荐位 4/5 留给"需要订阅或付费"的正版渠道，所以这三类排在免费之前。
 */
const OFFER_PRIORITY = { flatrate: 0, rent: 1, buy: 2, ads: 3, free: 4 };

/** 同一平台可能同时出现在 flatrate 与 buy 里，按平台去重，保留优先级最高的那条。 */
function rankOffers(offers) {
  const byProvider = new Map();
  for (const o of offers) {
    const key = o.providerName;
    const prev = byProvider.get(key);
    if (!prev || (OFFER_PRIORITY[o.type] ?? 9) < (OFFER_PRIORITY[prev.type] ?? 9)) {
      byProvider.set(key, o);
    }
  }
  return [...byProvider.values()].sort(
    (a, b) => (OFFER_PRIORITY[a.type] ?? 9) - (OFFER_PRIORITY[b.type] ?? 9),
  );
}

/**
 * 组装最终推荐位。
 *
 * 产品规则：**前 3 位给可以直接点开就看的片源，第 4、5 位给需要订阅或付费的正版渠道。**
 * 两侧任一不足时互相回填，保证推荐位尽量填满：
 *  - 直链不足 3 条 → 正版渠道往前顶；
 *  - 正版渠道为空（未配置 TMDB 或该片无正版上架）→ 用更多直链补齐。
 *
 * @param {object[]} playable  已排序的可直接播放片源
 * @param {object[]} offers    正版观看渠道
 * @param {{directSlots?: number, total?: number}} [opts]
 */
export function buildRecommendations(playable, offers, opts = {}) {
  const { directSlots = 3, total = 5 } = opts;
  const rankedOffers = rankOffers(offers);

  const directPicks = playable.slice(0, directSlots);
  // 直链不足时，正版渠道可以多占几个位置。
  const offerBudget = total - Math.max(directPicks.length, 0);
  const offerPicks = rankedOffers.slice(0, offerBudget);

  // 正版渠道不足时，用更多直链把位置补满。
  const remaining = total - directPicks.length - offerPicks.length;
  const extraDirect = remaining > 0
    ? playable.slice(directPicks.length, directPicks.length + remaining)
    : [];

  const entries = [
    ...[...directPicks, ...extraDirect].map((s) => ({
      kind: 'direct',
      access: 'direct-play',
      accessLabel: '可直接播放',
      source: s,
    })),
    ...offerPicks.map((o) => ({
      kind: 'offer',
      access: o.type,
      accessLabel: o.typeLabel,
      offer: o,
    })),
  ];

  return entries.map((e, i) => ({ rank: i + 1, ...e }));
}

/**
 * 主入口。
 *
 * 跑哪些源、每个源取多少条，全部来自 `opts.config`（配置驱动，不写死）。
 * 不传就用出厂配置。
 *
 * 检索分四步走，每一步的中间结果都完整保留在返回值的 `stages` 里：
 *   ① discovery —— 各引擎按原词/近似词/推荐词搜到的**原始**结果，分引擎分词呈现
 *   ② normalize —— 跨引擎归一去重，并记录每条合并了谁
 *   ③ verify    —— 对去重后的地址做嗅探甄别，筛出真正可用的，附溯源引用
 *   ④ final     —— 打分排序后的最终推荐
 * 这不是为了好看：调研取证要能回答"这个地址是怎么来的、中间被谁筛掉了"。
 *
 * @param {string} rawQuery 用户输入，可含年份，如 "Metropolis 1927"
 * @param {{limit?: number, probeLimit?: number, signal?: AbortSignal,
 *          fetchJson?: Function, probeFn?: Function,
 *          config?: object, adapters?: object[], expand?: object}} [opts]
 */
export async function searchAll(rawQuery, opts = {}) {
  const started = Date.now();
  const query = parseQuery(rawQuery);
  const limit = opts.limit ?? 5;

  // opts.adapters 是测试用的直接注入口；正常路径一律走配置。
  const config = opts.config ?? defaultConfig();
  const plan = opts.adapters
    ? opts.adapters.map((adapter) => ({ adapter, source: null, limit: null }))
    : buildAdapters(config);

  const expandCfg = { ...(config.expand ?? {}), ...(opts.expand ?? {}) };
  // 取证时希望尽量多探一些，别只探前 12 个就下结论
  const probeLimit = opts.probeLimit ?? config.probeLimit ?? 24;

  const adapterOpts = {
    signal: opts.signal,
    ...(opts.fetchJson ? { fetchJson: opts.fetchJson } : {}),
  };

  /* ── 第一步：发现 ─────────────────────────────────────────
   * 先用原词 + 近似词跑一轮，顺手收下各引擎返回的推荐搜索词；
   * 如果拿到了推荐词，再补一轮。两轮的结果都算「第一步」的产出。 */
  const round1Terms = planFirstRound(query, {
    maxVariants: expandCfg.maxVariants ?? 4,
    maxTerms: expandCfg.maxTerms ?? 4,
  });

  const runs1 = await Promise.all(
    plan.map((p) => runAdapter(p, query, { ...adapterOpts, terms: round1Terms })),
  );

  const rawSuggested = runs1.flatMap((r) => r.result?.related ?? []);
  const round2Terms = (expandCfg.useSuggested ?? true)
    ? planSecondRound(rawSuggested, query, round1Terms, {
        maxSuggested: expandCfg.maxSuggested ?? 3,
      })
    : [];

  // 第二轮只跑引擎源：专用适配器（IA / Commons / TMDB）已经按片名搜过，
  // 拿推荐词再搜一遍纯属重复消耗。
  const runs2 = round2Terms.length > 0
    ? await Promise.all(
        plan
          .filter((p) => p.adapter.id.startsWith('engine:'))
          .map((p) => runAdapter(p, query, { ...adapterOpts, terms: round2Terms })),
      )
    : [];

  const runs = mergeRuns(runs1, runs2);
  const allTerms = [...round1Terms, ...round2Terms];

  // 2) 汇总直链候选与权威元数据。
  // 专用适配器（IA / Commons / Jellyfin）自己不产出溯源字段——它们是按片名
  // 直接查 API，没有"搜索词"和"结果排名"的概念。这里补上，否则引用里会出现
  // 一片 null，取证时看不出这条是怎么来的。
  const rawSources = runs.flatMap((r) => (r.result?.sources ?? []).map((s, i) => (
    s.discoveredBy ? s : {
      ...s,
      discoveredBy: r.id,
      discoveredByLabel: r.label,
      discoveredRank: i + 1,
      discoveredTerm: query.title,
      discoveredTermKind: 'original',
      discoveredVia: s.pageUrl ?? null,
    }
  )));
  const metaRun = runs.find((r) => r.kind === 'metadata' && r.result?.titleInfo);
  const titleInfo = metaRun?.result?.titleInfo ?? null;
  const offers = runs.flatMap((r) => r.result?.offers ?? []);
  // 引擎搜到但没有对应解析器的页面：如实列出来，不去猜里面有没有视频。
  // 同一个页面会被多引擎多词反复搜到，按 URL 合并，来路累加成引用。
  const rawLeads = runs.flatMap((r) => r.result?.leads ?? []);
  const leads = dedupeLeads(rawLeads);

  /* ── 第二步：归一去重 ──────────────────────────────────── */
  const { kept: sources, groups: dedupeGroups, removed: dedupeRemoved } = dedupeWithTrail(rawSources);

  // 3) 参考片长：权威值优先，否则用候选时长中位数兜底。
  let referenceRuntimeSec = titleInfo?.runtimeSec ?? null;
  let runtimeSource = referenceRuntimeSec ? 'tmdb' : null;
  if (!referenceRuntimeSec) {
    referenceRuntimeSec = estimateReferenceRuntime(sources);
    runtimeSource = referenceRuntimeSec ? 'median' : null;
  }

  // 3b) 长度偏好的分母：候选中的最长时长（在参考片长 1.5 倍以内取，防合集拉偏）。
  const maxDurationSec = computeMaxDuration(sources, referenceRuntimeSec);
  const rankCtx = { referenceRuntimeSec, maxDurationSec, weights: opts.weights };

  // 4) 第一趟：不带探测结果预排名，挑出值得探测的候选。
  const pre = rankSources(sources, { ...rankCtx, limit: probeLimit });
  const preOrdered = [...pre.top, ...pre.overflow, ...pre.alternatives];

  // 5) 只探测靠前的候选。
  const probed = opts.skipProbe
    ? preOrdered
    : await probeAll(preOrdered, {
        limit: probeLimit,
        signal: opts.signal,
        ...(opts.probeFn ? { probeFn: opts.probeFn } : {}),
      });

  // 6) 第二趟：带真实探测结果重排。
  const final = rankSources(probed, { ...rankCtx, limit });

  /* ── 第三步：嗅探甄别的账目 ────────────────────────────────
   * probed 里已经带着每条的探测结论和打分理由，这里把它整理成
   * 「通过 / 被筛掉 + 原因 + 引用」的形式。没被探测到的也要如实列出，
   * 不能让人以为全部都验过了。 */
  const rankedAll = [...final.top, ...final.overflow, ...final.alternatives];
  const verifyItems = rankedAll.map((s) => {
    const rejected = Boolean(s.blockReason);
    return {
      url: s.url,
      filename: s.filename || s.title || s.url,
      provider: s.provider,
      providerLabel: s.providerLabel || s.provider,
      container: s.container || null,
      height: s.height ?? null,
      durationSec: s.durationSec ?? null,
      bytes: s.bytes ?? null,
      // 嗅探拿到的事实
      probed: Boolean(s.probed),
      probeOutcome: s.probeOutcome ?? (s.probed ? 'ok' : 'not-probed'),
      httpStatus: s.probeStatus ?? null,
      contentType: s.probeContentType ?? null,
      reachable: s.reachable ?? null,
      rangeSupported: s.rangeSupported ?? null,
      checksums: s.checksums ?? null,
      // 甄别结论
      verdict: rejected ? 'rejected' : 'usable',
      reason: rejected ? s.blockReason : playableReason(s),
      score: s.score ?? null,
      // 溯源引用：这个地址是谁、用什么词、从哪个页面找到的
      citations: s.citations ?? [],
      pageUrl: s.pageUrl ?? null,
    };
  });
  const usable = verifyItems.filter((v) => v.verdict === 'usable');

  // 7) 组推荐位：前 3 位直接可播，第 4/5 位正版订阅/付费渠道。
  const recommendations = buildRecommendations(
    [...final.top, ...final.overflow],
    offers,
    { directSlots: opts.directSlots ?? 3, total: limit },
  );

  const directCount = recommendations.filter((r) => r.kind === 'direct').length;
  const offerCount = recommendations.filter((r) => r.kind === 'offer').length;

  const notes = [];
  if (runtimeSource === 'median') {
    notes.push('未配置 TMDB_API_KEY，参考片长取候选时长中位数，完整度判定精度略降');
  }
  if (offerCount === 0) {
    notes.push('未取到正版订阅/付费渠道，推荐位 4-5 已用可直接播放的片源补齐（配置 TMDB_API_KEY 可启用）');
  }
  if (directCount < (opts.directSlots ?? 3)) {
    notes.push(`只找到 ${directCount} 个可直接播放的片源，其余推荐位由正版渠道顶上`);
  }
  if (final.top.length === 0 && final.alternatives.length > 0) {
    notes.push('没有浏览器可直接播放的片源，但下方备选可下载后用本地播放器观看');
  }
  if (offers.length > 0) {
    notes.push('正版观看渠道数据来源 JustWatch（经 TMDB 提供）');
  }
  const skippedEngines = runs.filter((r) => r.id.startsWith('engine:') && r.status === 'skipped');
  if (skippedEngines.length > 0) {
    notes.push(`${skippedEngines.length} 个搜索引擎源未启用：${skippedEngines[0].reason}`);
  }
  if (leads.length > 0) {
    notes.push(`引擎另搜到 ${leads.length} 个页面，但这些域名没有对应的解析器，只列出不解析`);
  }
  if (rawLeads.length > leads.length) {
    notes.push(`这 ${leads.length} 个页面被重复搜到 ${rawLeads.length} 次，已按 URL 合并（每条下方列出全部来路）`);
  }
  if (round2Terms.length > 0) {
    notes.push(`用引擎返回的推荐搜索词补搜了一轮：${round2Terms.map((t) => t.term).join('、')}`);
  }
  if (!opts.skipProbe && rankedAll.length > probeLimit) {
    notes.push(`第三步只嗅探了前 ${probeLimit} 条（共 ${rankedAll.length} 条），其余按上游元数据判定；调大 probeLimit 可全量嗅探`);
  }

  /* 四步走的完整账目。UI 用它渲染四个 tab，也可以直接取 JSON 存证。 */
  const stages = {
    discovery: {
      label: '第一步 · 各引擎原始检索结果',
      terms: allTerms,
      suggestedRaw: [...new Set(rawSuggested)],
      suggestedUsed: round2Terms.map((t) => t.term),
      engines: runs.map((r) => ({
        id: r.id,
        label: r.label,
        kind: r.kind,
        status: r.status,
        reason: r.reason ?? null,
        limit: r.limit ?? null,
        elapsedMs: r.elapsedMs,
        // 引擎源有逐词账目；专用适配器没有，用一条汇总代替
        rounds: r.result?.rounds ?? (r.result
          ? [{
              term: query.title, kind: 'original', why: '原始输入',
              returned: r.result.sources?.length ?? 0, error: null,
              results: (r.result.sources ?? []).map((s, i) => ({
                url: s.url, title: s.filename || s.title || s.url,
                snippet: '', rank: i + 1, engine: r.id,
                term: query.title, termKind: 'original',
              })),
            }]
          : []),
        total: r.result?.rounds
          ? r.result.rounds.reduce((n, x) => n + x.returned, 0)
          : (r.result?.sources?.length ?? 0),
      })),
      totalResults: rawSources.length + leads.length,
    },
    normalize: {
      label: '第二步 · 跨引擎归一去重',
      before: rawSources.length,
      after: sources.length,
      removed: dedupeRemoved,
      groups: dedupeGroups.sort((a, b) => b.count - a.count),
      // 被多个引擎独立命中的，单独拎出来——这是可信度最高的一批
      multiSourced: dedupeGroups.filter((g) => new Set(g.citations.map((c) => c.provider)).size > 1).length,
    },
    verify: {
      label: '第三步 · 嗅探甄别',
      checked: opts.skipProbe ? 0 : Math.min(probeLimit, preOrdered.length),
      total: rankedAll.length,
      usable: usable.length,
      rejected: verifyItems.length - usable.length,
      items: verifyItems,
      // 没有解析器、只能作为线索的页面也归到这一步，方便一起看
      leads,
    },
    final: {
      label: '第四步 · 最终结果',
      recommendations,
      directCount,
      offerCount,
    },
  };

  return {
    stages,
    query: { raw: rawQuery, ...query },
    elapsedMs: Date.now() - started,
    title: titleInfo
      ? { ...titleInfo, runtimeSource }
      : {
          name: query.title,
          year: query.year,
          runtimeSec: referenceRuntimeSec,
          runtimeSource,
          poster: null,
          overview: null,
        },
    // 最终推荐位：前 3 直接可播，第 4/5 正版订阅/付费。
    recommendations,
    // 全部可直接播放的片源（推荐位只取其中前几条）。
    top: final.top,
    alternatives: final.alternatives.slice(0, 10),
    offers,
    // 引擎发现但无法解析的页面（只给线索，不猜内容）
    leads: leads.slice(0, 30),
    providers: runs.map(({ result, ...rest }) => rest),
    stats: {
      rawCandidates: rawSources.length,
      leads: leads.length,
      afterDedupe: sources.length,
      probed: opts.skipProbe ? 0 : Math.min(probeLimit, preOrdered.length),
      playable: final.top.length + final.overflow.length,
      blocked: final.alternatives.length,
      recommendedDirect: directCount,
      recommendedOffers: offerCount,
      maxDurationSec,
    },
    notes,
  };
}
