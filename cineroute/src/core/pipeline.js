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
import { rankSources, estimateReferenceRuntime } from './score.js';
import { probeAll } from './probe.js';
import { DIRECT_ADAPTERS, METADATA_ADAPTERS, adapterAvailability } from '../adapters/registry.js';

/** 给单个适配器套超时与错误隔离，返回统一的状态记录。 */
async function runAdapter(adapter, query, opts) {
  const started = Date.now();
  const availability = adapterAvailability(adapter);
  if (!availability.available) {
    return {
      id: adapter.id, label: adapter.label, kind: adapter.kind,
      status: 'skipped', reason: availability.reason,
      count: 0, elapsedMs: 0, result: null,
    };
  }

  try {
    const result = await adapter.search(query, opts);
    const count = (result?.sources?.length ?? 0) || (result?.offers?.length ?? 0);
    return {
      id: adapter.id, label: adapter.label, kind: adapter.kind,
      status: result?.error ? 'error' : 'ok',
      reason: result?.error ?? null,
      count,
      elapsedMs: Date.now() - started,
      result,
    };
  } catch (err) {
    return {
      id: adapter.id, label: adapter.label, kind: adapter.kind,
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
  const seen = new Map();
  for (const s of sources) {
    const key = s.checksums?.md5
      ? `md5:${s.checksums.md5}`
      : s.checksums?.sha1
        ? `sha1:${s.checksums.sha1}`
        : `url:${s.url}`;
    const prev = seen.get(key);
    if (!prev) {
      seen.set(key, s);
      continue;
    }
    // 保留信息更全的那条（有分辨率/时长/体积的优先）。
    const richness = (x) => (x.height ? 1 : 0) + (x.durationSec ? 1 : 0) + (x.bytes ? 1 : 0);
    if (richness(s) > richness(prev)) seen.set(key, { ...s, mirrors: (prev.mirrors || 0) + 1 });
    else seen.set(key, { ...prev, mirrors: (prev.mirrors || 0) + 1 });
  }
  return [...seen.values()];
}

/**
 * 主入口。
 *
 * @param {string} rawQuery 用户输入，可含年份，如 "Metropolis 1927"
 * @param {{limit?: number, probeLimit?: number, signal?: AbortSignal,
 *          fetchJson?: Function, probeFn?: Function, adapters?: object[]}} [opts]
 */
export async function searchAll(rawQuery, opts = {}) {
  const started = Date.now();
  const query = parseQuery(rawQuery);
  const limit = opts.limit ?? 5;
  const probeLimit = opts.probeLimit ?? 12;

  const directAdapters = opts.adapters ?? DIRECT_ADAPTERS;
  const metadataAdapters = opts.adapters ? [] : METADATA_ADAPTERS;

  const adapterOpts = {
    signal: opts.signal,
    ...(opts.fetchJson ? { fetchJson: opts.fetchJson } : {}),
  };

  // 1) 所有源并发跑，互不阻塞。
  const runs = await Promise.all(
    [...directAdapters, ...metadataAdapters].map((a) => runAdapter(a, query, adapterOpts)),
  );

  // 2) 汇总直链候选与权威元数据。
  const rawSources = runs.flatMap((r) => r.result?.sources ?? []);
  const metaRun = runs.find((r) => r.kind === 'metadata' && r.result?.titleInfo);
  const titleInfo = metaRun?.result?.titleInfo ?? null;
  const offers = runs.flatMap((r) => r.result?.offers ?? []);

  const sources = dedupeSources(rawSources);

  // 3) 参考片长：权威值优先，否则用候选时长中位数兜底。
  let referenceRuntimeSec = titleInfo?.runtimeSec ?? null;
  let runtimeSource = referenceRuntimeSec ? 'tmdb' : null;
  if (!referenceRuntimeSec) {
    referenceRuntimeSec = estimateReferenceRuntime(sources);
    runtimeSource = referenceRuntimeSec ? 'median' : null;
  }

  // 4) 第一趟：不带探测结果预排名，挑出值得探测的候选。
  const pre = rankSources(sources, { referenceRuntimeSec, limit: probeLimit });
  const preOrdered = [...pre.top, ...pre.overflow, ...pre.alternatives];

  // 5) 只探测靠前的候选。
  const probed = opts.skipProbe
    ? preOrdered
    : await probeAll(preOrdered, {
        limit: probeLimit,
        signal: opts.signal,
        ...(opts.probeFn ? { probeFn: opts.probeFn } : {}),
      });

  // 6) 第二趟：带真实探测结果重排，得到最终 Top5。
  const final = rankSources(probed, { referenceRuntimeSec, limit });

  const notes = [];
  if (runtimeSource === 'median') {
    notes.push('未配置 TMDB_API_KEY，参考片长取候选时长中位数，完整度判定精度略降');
  }
  if (final.top.length === 0 && final.alternatives.length > 0) {
    notes.push('没有浏览器可直接播放的片源，但下方备选可下载后用本地播放器观看');
  }
  if (offers.length > 0) {
    notes.push('正版观看渠道数据来源 JustWatch（经 TMDB 提供）');
  }

  return {
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
    top: final.top,
    alternatives: final.alternatives.slice(0, 10),
    offers,
    providers: runs.map(({ result, ...rest }) => rest),
    stats: {
      rawCandidates: rawSources.length,
      afterDedupe: sources.length,
      probed: opts.skipProbe ? 0 : Math.min(probeLimit, preOrdered.length),
      playable: final.top.length + final.overflow.length,
      blocked: final.alternatives.length,
    },
    notes,
  };
}
