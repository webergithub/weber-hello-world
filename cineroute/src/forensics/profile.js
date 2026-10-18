/**
 * 从样本表还原时间轴剖面 —— 不解码任何一帧。
 *
 * 输出两条曲线，它们是后续所有篡改判定的输入：
 *  1) **逐秒码率剖面**：每一秒钟里所有样本的字节数之和。
 *     不同来源的视频段（正片 vs 插入的广告）几乎不可能有相同的码率分布。
 *  2) **关键帧节奏（GOP）**：相邻关键帧的时间间隔序列。
 *     编码器的 keyint 设置是强指纹，正片是一套参数、插入段是另一套，
 *     在这条曲线上会呈现为一段节奏突变。
 */

/**
 * 展开样本时间轴。
 * @param {object} track parseContainer 产出的 track
 * @returns {{samples: Array<{index:number,t:number,dur:number,size:number,key:boolean}>, durationSec:number}}
 */
export function buildTimeline(track) {
  const timescale = track.media?.timescale || 1000;
  const n = Math.min(track.sizes.length, track.deltas.length);
  const samples = [];
  let ticks = 0;

  for (let i = 0; i < n; i += 1) {
    const dur = track.deltas[i];
    samples.push({
      index: i + 1,                            // 样本号从 1 开始，与 stss 对齐
      t: ticks / timescale,
      dur: dur / timescale,
      size: track.sizes[i],
      key: track.allSync ? true : Boolean(track.syncSamples?.has(i + 1)),
    });
    ticks += dur;
  }

  return { samples, durationSec: ticks / timescale, timescale };
}

/**
 * 逐秒码率剖面。
 *
 * @param {object} track
 * @param {{binSec?: number}} [opts]
 * @returns {{binSec:number, bins:Array<{t:number,bytes:number,kbps:number,samples:number,keyframes:number}>, durationSec:number}}
 */
export function bitrateProfile(track, opts = {}) {
  const binSec = opts.binSec ?? 1;
  const { samples, durationSec } = buildTimeline(track);
  if (samples.length === 0) return { binSec, bins: [], durationSec: 0 };

  const binCount = Math.max(1, Math.ceil(durationSec / binSec));
  const bins = Array.from({ length: binCount }, (_, i) => ({
    t: i * binSec, bytes: 0, kbps: 0, samples: 0, keyframes: 0,
  }));

  for (const s of samples) {
    const idx = Math.min(binCount - 1, Math.floor(s.t / binSec));
    bins[idx].bytes += s.size;
    bins[idx].samples += 1;
    if (s.key) bins[idx].keyframes += 1;
  }

  for (const b of bins) b.kbps = Math.round((b.bytes * 8) / 1000 / binSec);

  return { binSec, bins, durationSec };
}

/**
 * 关键帧时间点与间隔。
 * @param {object} track
 * @returns {{times:number[], intervals:number[], median:number|null, cv:number|null, applicable:boolean}}
 */
export function keyframeProfile(track) {
  // 音轨或全 I 帧轨没有 GOP 概念，不适用。
  if (track.allSync || !track.syncSamples || track.syncSamples.size === 0) {
    return { times: [], intervals: [], median: null, cv: null, applicable: false };
  }

  const { samples } = buildTimeline(track);
  const times = samples.filter((s) => s.key).map((s) => s.t);
  const intervals = [];
  for (let i = 1; i < times.length; i += 1) intervals.push(times[i] - times[i - 1]);

  const median = intervals.length ? medianOf(intervals) : null;
  // 变异系数：GOP 是否规整。远大于 0 说明节奏不一致（可能有拼接）。
  let cv = null;
  if (intervals.length > 1 && median > 0) {
    const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    const variance = intervals.reduce((a, b) => a + (b - mean) ** 2, 0) / intervals.length;
    cv = Math.sqrt(variance) / mean;
  }

  return { times, intervals, median, cv, applicable: true };
}

/** 中位数。 */
export function medianOf(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * 中位数绝对偏差（MAD）。
 * 取证场景必须用稳健统计：均值和标准差会被待检测的异常段本身污染，
 * 而 MAD 对最多 50% 的离群点免疫。
 */
export function madOf(arr, med = medianOf(arr)) {
  if (!arr.length) return 0;
  return medianOf(arr.map((x) => Math.abs(x - med)));
}

/**
 * 稳健 z 分数序列。1.4826 是把 MAD 换算成正态分布标准差的常数。
 * MAD 为 0（恒定码率）时退化用平均绝对偏差，避免除零。
 */
export function robustZScores(values) {
  const med = medianOf(values);
  let scale = 1.4826 * madOf(values, med);
  if (scale === 0) {
    const mad = values.reduce((a, x) => a + Math.abs(x - med), 0) / (values.length || 1);
    scale = mad || 1;
  }
  return values.map((v) => (v - med) / scale);
}
