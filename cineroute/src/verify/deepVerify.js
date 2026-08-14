/**
 * 深度验证（第五步）：把第四步的 Top-N 结果真的打开、拖、截、下一遍。
 *
 * 前四步都停在"根据元数据和 HTTP 头判断"，这一步是唯一真正**解码**的环节。
 * 一个地址前面全过了、到这里放不出画面，是很常见的——容器对但编码不支持、
 * 有音轨没视轨、文件截断、声称 1080p 实际是放大的。
 *
 * 全都放不出来时会自动开下一轮检索（换更靠后的候选/更多检索词），
 * 最多 maxRounds 轮。轮次是**可配置**的，默认 10。
 */

import { probePlayback, gradeBatch, DEFAULT_MARKS } from './playback.js';
import { simulateBatch } from './simDownload.js';

/**
 * 对一批候选做深度验证。
 *
 * @param {object[]} candidates 第四步选出的片源（按名次排好）
 * @param {{browser: object, baseUrl: string, threads?: number, marks?: object[],
 *          probeBytes?: number, signal?: AbortSignal, concurrency?: number}} opts
 */
export async function verifyCandidates(candidates, opts) {
  const {
    browser, baseUrl, threads = 5, marks = DEFAULT_MARKS,
    probeBytes, signal, concurrency = 2,
    // 与项目其余部分一致：网络出口可注入，测试才能不依赖真实网络
    requestFn,
  } = opts;
  const started = Date.now();

  // 播放嗅探要开真浏览器页面、真解码，很吃资源，所以限并发；
  // 模拟下载是纯网络，可以一起上。
  const playback = [];
  for (let i = 0; i < candidates.length; i += concurrency) {
    const batch = candidates.slice(i, i + concurrency);
    const got = await Promise.all(batch.map((c) => probePlayback(browser, {
      baseUrl,
      mediaUrl: c.url,
      durationSec: c.durationSec ?? 0,
      marks,
    }).then((r) => ({
      ...r,
      filename: c.filename || c.url,
      claimedHeight: c.height ?? null,
      rank: c.rank ?? null,
      score: c.score ?? null,
    }))));
    playback.push(...got);
  }

  const graded = gradeBatch(playback);

  const download = await simulateBatch(
    candidates.map((c) => ({ url: c.url, bytes: c.bytes, filename: c.filename })),
    { threads, probeBytes, signal, ...(requestFn ? { requestFn } : {}) },
  );

  // 把两边按地址对起来，一条候选一个结论
  const byUrl = new Map(download.results.map((r) => [r.url, r]));
  const items = graded.map((p) => {
    const dl = byUrl.get(p.url) || null;
    const playable = p.ok;
    const downloadable = Boolean(dl?.ok);
    return {
      rank: p.rank,
      filename: p.filename,
      url: p.url,
      score: p.score,
      playable,
      downloadable,
      // 两条路都不通才算这条候选废了
      usable: playable || downloadable,
      playback: p,
      download: dl,
      resolutionCheck: compareClaimed(p.claimedHeight, p.decoded?.height),
      verdict: verdictOf(playable, downloadable),
    };
  });

  const usable = items.filter((x) => x.usable);
  return {
    elapsedMs: Date.now() - started,
    threads,
    total: items.length,
    playableCount: items.filter((x) => x.playable).length,
    downloadableCount: items.filter((x) => x.downloadable).length,
    usableCount: usable.length,
    allFailed: items.length > 0 && usable.length === 0,
    items,
  };
}

function verdictOf(playable, downloadable) {
  if (playable && downloadable) return { level: 'ok', text: '可播放，也可下载' };
  if (playable) return { level: 'warn', text: '可播放，但并发下载有问题' };
  if (downloadable) return { level: 'warn', text: '浏览器放不出画面，但能下载后本地播放' };
  return { level: 'fail', text: '既放不出来也下不下来' };
}

/** 上游声称的分辨率 vs 实际解码出来的。对不上是有价值的发现。 */
function compareClaimed(claimed, decoded) {
  if (!claimed || !decoded) return null;
  if (decoded === claimed) return { match: true, note: `解码 ${decoded}p，与上游标称一致` };
  return {
    match: false,
    note: decoded < claimed
      ? `上游标称 ${claimed}p，实际解码只有 ${decoded}p —— 元数据夸大，或这是降规后的副本`
      : `上游标称 ${claimed}p，实际解码 ${decoded}p —— 元数据偏低`,
  };
}

/**
 * 多轮验证。
 *
 * 一轮里 Top-N 全军覆没就换下一批候选再来，最多 maxRounds 轮。
 * 每轮的完整结果都留着，界面上把历史轮次折叠、只展开当前轮。
 *
 * @param {object[]} allCandidates 全部可用候选（比 topN 多，供后续轮次取用）
 * @param {{topN?: number, maxRounds?: number}} roundOpts
 * @param {object} verifyOpts 传给 verifyCandidates 的参数
 */
export async function verifyWithRounds(allCandidates, roundOpts = {}, verifyOpts = {}) {
  const topN = Math.max(1, roundOpts.topN ?? 5);
  const maxRounds = Math.max(1, roundOpts.maxRounds ?? 10);

  const rounds = [];
  let offset = 0;
  let stopReason = null;

  for (let round = 1; round <= maxRounds; round += 1) {
    const batch = allCandidates.slice(offset, offset + topN);
    if (batch.length === 0) {
      stopReason = `候选已用尽（共 ${allCandidates.length} 条，全部验过）`;
      break;
    }

    const result = await verifyCandidates(batch, verifyOpts);
    rounds.push({
      round,
      candidateRange: [offset + 1, offset + batch.length],
      ...result,
    });
    offset += batch.length;

    if (!result.allFailed) {
      stopReason = `第 ${round} 轮找到 ${result.usableCount} 个可用片源，停止`;
      break;
    }
    if (round === maxRounds) {
      stopReason = `已达最大轮数 ${maxRounds}，仍未找到可用片源`;
    }
  }

  const last = rounds[rounds.length - 1] ?? null;
  return {
    rounds,
    totalRounds: rounds.length,
    maxRounds,
    topN,
    stopReason,
    succeeded: Boolean(last && !last.allFailed),
    // 界面按这个决定展开哪一轮、折叠哪些
    activeRound: rounds.length,
  };
}
