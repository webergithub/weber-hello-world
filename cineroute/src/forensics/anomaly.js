/**
 * 篡改检测：从码率剖面与 GOP 节奏里找出"被后期插入/替换"的片段。
 *
 * 核心判据：**一段视频若来自另一次编码，它的码率分布与 GOP 长度不可能与正片一致。**
 * 插播广告、贴片、站点宣传片都是把另一段成品拼进来，因此必然在这两条曲线上
 * 同时留下痕迹；而单纯的画面复杂度变化（打斗戏码率飙高）只影响码率、不影响 GOP。
 * 两个信号同时命中，才给高置信度——这条规则把大部分误报挡在外面。
 *
 * 所有统计都用稳健估计（中位数 / MAD）：均值和标准差会被待检出的异常段本身
 * 污染，样本量越小污染越严重。
 */

import { robustZScores, medianOf, keyframeProfile, bitrateProfile } from './profile.js';

/** 典型插入片段的时长范围（秒）。太短是噪声，太长更可能是正片本身的场景变化。 */
const PLAUSIBLE_INSERT_MIN = 3;
const PLAUSIBLE_INSERT_MAX = 300;

/**
 * 把布尔标记序列合并成连续区间，允许跨过 `gapTolerance` 个未标记项。
 * @param {boolean[]} flags
 * @param {number} gapTolerance
 * @returns {Array<{from:number,to:number}>} 闭区间下标
 */
export function groupRuns(flags, gapTolerance = 1) {
  const runs = [];
  let start = -1;
  let gap = 0;

  for (let i = 0; i < flags.length; i += 1) {
    if (flags[i]) {
      if (start < 0) start = i;
      gap = 0;
    } else if (start >= 0) {
      gap += 1;
      if (gap > gapTolerance) {
        runs.push({ from: start, to: i - gap });
        start = -1;
        gap = 0;
      }
    }
  }
  if (start >= 0) runs.push({ from: start, to: flags.length - 1 - gap });
  return runs.filter((r) => r.to >= r.from);
}

/**
 * 码率异常段检测。
 *
 * @param {{binSec:number, bins:Array}} profile
 * @param {{z?: number, gapTolerance?: number}} [opts]
 */
export function detectBitrateAnomalies(profile, opts = {}) {
  const { z: threshold = 3.5, gapTolerance = 1 } = opts;
  const kbps = profile.bins.map((b) => b.kbps);
  if (kbps.length < 10) return [];

  const zs = robustZScores(kbps);
  const flags = zs.map((v) => Math.abs(v) > threshold);
  const baseline = medianOf(kbps);

  return groupRuns(flags, gapTolerance).map((run) => {
    const slice = kbps.slice(run.from, run.to + 1);
    const inner = medianOf(slice);
    const peakZ = Math.max(...zs.slice(run.from, run.to + 1).map(Math.abs));
    return {
      startSec: run.from * profile.binSec,
      endSec: (run.to + 1) * profile.binSec,
      durationSec: (run.to - run.from + 1) * profile.binSec,
      innerKbps: Math.round(inner),
      baselineKbps: Math.round(baseline),
      ratio: baseline ? Number((inner / baseline).toFixed(2)) : null,
      peakZ: Number(peakZ.toFixed(1)),
    };
  });
}

/**
 * GOP 节奏异常检测。
 *
 * 用滑动窗口的局部中位间隔与全局中位间隔比较：某一段的关键帧突然变密或变疏，
 * 说明那一段是用另一套编码参数生成的。
 *
 * @param {{times:number[], intervals:number[], median:number, applicable:boolean}} kf
 * @param {{ratio?: number}} [opts]
 */
export function detectGopAnomalies(kf, opts = {}) {
  const { ratio: ratioThreshold = 2 } = opts;
  if (!kf.applicable || kf.intervals.length < 8 || !kf.median) return [];

  const flags = kf.intervals.map((iv) => {
    const r = iv / kf.median;
    return r > ratioThreshold || r < 1 / ratioThreshold;
  });

  return groupRuns(flags, 0).map((run) => {
    const slice = kf.intervals.slice(run.from, run.to + 1);
    return {
      // 第 i 个间隔跨越 times[i] → times[i+1]
      startSec: kf.times[run.from],
      endSec: kf.times[Math.min(run.to + 1, kf.times.length - 1)],
      innerMedianInterval: Number(medianOf(slice).toFixed(2)),
      baselineInterval: Number(kf.median.toFixed(2)),
      keyframeCount: slice.length + 1,
    };
  });
}

/** 两个时间区间的重叠秒数。 */
function overlap(a, b) {
  return Math.max(0, Math.min(a.endSec, b.endSec) - Math.max(a.startSec, b.startSec));
}

/**
 * 综合判定：把码率异常与 GOP 异常叠加，输出带置信度的可疑插入段。
 *
 * 置信度构成（0..1）：
 *  - 码率偏离幅度      最高 0.35
 *  - GOP 节奏同时异常  0.30 ← 最强的单项证据
 *  - 边界落在关键帧上  0.20（拼接点必须在关键帧）
 *  - 时长落在合理区间  0.15
 *
 * @param {object} track
 * @param {{binSec?: number, z?: number}} [opts]
 */
export function detectInsertedSegments(track, opts = {}) {
  const profile = bitrateProfile(track, { binSec: opts.binSec ?? 1 });
  const kf = keyframeProfile(track);

  const bitrateHits = detectBitrateAnomalies(profile, opts);
  const gopHits = detectGopAnomalies(kf, opts);

  const keyTimes = kf.times;
  const nearKeyframe = (t, tol) => keyTimes.some((kt) => Math.abs(kt - t) <= tol);
  const tol = Math.max(profile.binSec, kf.median ? kf.median * 0.6 : profile.binSec);

  const findings = bitrateHits.map((hit) => {
    let confidence = 0;
    const evidence = [];

    // 1) 码率偏离
    const zScore = Math.min(hit.peakZ / 10, 1);
    confidence += 0.35 * zScore;
    evidence.push(
      `该段码率中位 ${hit.innerKbps} kbps，全片基线 ${hit.baselineKbps} kbps`
      + `（${hit.ratio}×，稳健 z=${hit.peakZ}）`,
    );

    // 2) GOP 节奏是否同时异常
    const gopHit = gopHits.find((g) => overlap(g, hit) > 0);
    if (gopHit) {
      confidence += 0.30;
      evidence.push(
        `同一时段关键帧间隔为 ${gopHit.innerMedianInterval}s，全片为 ${gopHit.baselineInterval}s`
        + `——该段使用了不同的编码参数`,
      );
    }

    // 3) 边界是否落在关键帧（拼接的必要条件）
    const startAligned = nearKeyframe(hit.startSec, tol);
    const endAligned = nearKeyframe(hit.endSec, tol);
    if (startAligned && endAligned) {
      confidence += 0.20;
      evidence.push('起止点均落在关键帧上，符合拼接特征');
    } else if (startAligned || endAligned) {
      confidence += 0.10;
      evidence.push('一侧边界落在关键帧上');
    }

    // 4) 时长是否像一段插播内容
    const plausible = hit.durationSec >= PLAUSIBLE_INSERT_MIN && hit.durationSec <= PLAUSIBLE_INSERT_MAX;
    if (plausible) {
      confidence += 0.15;
      evidence.push(`时长 ${hit.durationSec}s，落在典型插播时长区间内`);
    } else {
      evidence.push(`时长 ${hit.durationSec}s，超出典型插播时长区间，也可能是正片自身的场景变化`);
    }

    confidence = Math.min(1, Number(confidence.toFixed(2)));

    return {
      type: 'suspected-insert',
      startSec: hit.startSec,
      endSec: hit.endSec,
      durationSec: hit.durationSec,
      confidence,
      level: confidence >= 0.7 ? 'high' : confidence >= 0.45 ? 'medium' : 'low',
      evidence,
      metrics: { ...hit, gop: gopHit ?? null },
    };
  });

  // 只有 GOP 异常、码率没波动的段也要报——重编码后码率被拉平的情况确实存在。
  for (const g of gopHits) {
    if (bitrateHits.some((b) => overlap(b, g) > 0)) continue;
    findings.push({
      type: 'suspected-recode',
      startSec: g.startSec,
      endSec: g.endSec,
      durationSec: Number((g.endSec - g.startSec).toFixed(2)),
      confidence: 0.4,
      level: 'medium',
      evidence: [
        `关键帧间隔为 ${g.innerMedianInterval}s，全片为 ${g.baselineInterval}s，`
        + '该段编码参数与正片不同，但码率未见明显异常',
      ],
      metrics: { gop: g },
    });
  }

  return {
    profile,
    keyframes: kf,
    findings: findings.sort((a, b) => b.confidence - a.confidence || a.startSec - b.startSec),
  };
}
