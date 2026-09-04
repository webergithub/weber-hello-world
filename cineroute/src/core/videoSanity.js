/**
 * 「这是不是一个有效的视频」——只看**时长**和**体积**的初步判断。
 *
 * 这一步刻意不解码、不请求、不看容器，就拿上游给的两个数字算。理由是它能
 * 极便宜地识破一类很常见、而且别的规则都抓不到的东西：**数字对不上的文件**。
 *
 *   · 声称 1080p、90 分钟，文件只有 48 MB —— 码率 71 kbps。这个码率连
 *     音频都嫌挤，不可能有画面。多半是残片、占位文件，或者只传了音轨。
 *   · 声称 2 分钟，文件 8 GB —— 码率 533 Mbps。这不是发行副本，是母版扫描，
 *     浏览器碰都碰不动。
 *   · 时长 0 或缺失、体积几十 KB —— 条目建好了但文件根本没传上去。
 *
 * 这些在 HTTP 头里看不出来（Content-Type 是 video/mp4，Content-Length 也
 * 真的就是那么大），容器判断也过得去（就是个正经 mp4），非正片关键词更抓不到
 * （文件名规规矩矩）。只有把时长和体积放在一起除一下才露馅。
 *
 * **和"正片"是两件事，分开报。** 一个 2 分半、2400 kbps 的预告片是一个
 * 完全有效的视频文件，只是它不是正片。混在一起报会让人以为"无效"，
 * 而实际上它坏在别处。
 *
 * 数据缺失时**不猜**，报 unknown。归档站上确实有一批条目不给时长，
 * 把它们算成"有效"或"无效"都是在编，只能如实说判不了。
 */

/** 低于这个码率不可能是能看的视频——这个带宽连音频都嫌挤。 */
const MIN_KBPS = 150;
/** 高于这个码率是母版/无损扫描，不是发行副本，也没法在线播。 */
const MAX_KBPS = 60_000;
/** 比这还小的文件不用算码率了，条目建了但文件没传上去。 */
const MIN_BYTES = 1024 * 1024;
/** 短于这个的是片头台标、转场之类的碎片，不算一个视频。 */
const MIN_DURATION_SEC = 30;
/**
 * 正片长度门槛。取 40 分钟——这是电影艺术与科学学院区分
 * feature film 与 short film 的线，不是我随手定的。
 */
export const FEATURE_MIN_SEC = 40 * 60;

/**
 * 判一条片源。
 *
 * @param {{durationSec?: number|null, bytes?: number|null}} source
 * @returns {{verdict: 'valid'|'invalid'|'unknown', feature: boolean,
 *            kbps: number|null, reason: string}}
 *   `feature` 只在 verdict==='valid' 时有意义：有效且够正片长度。
 */
export function classifyVideo(source) {
  const dur = Number(source?.durationSec) || 0;
  const bytes = Number(source?.bytes) || 0;

  if (!dur && !bytes) {
    return { verdict: 'unknown', feature: false, kbps: null, reason: '上游没给时长也没给体积，判不了' };
  }
  if (!dur) {
    return { verdict: 'unknown', feature: false, kbps: null, reason: '上游没给时长，算不出码率' };
  }
  if (!bytes) {
    return { verdict: 'unknown', feature: false, kbps: null, reason: '上游没给体积，算不出码率' };
  }

  const kbps = (bytes * 8) / 1000 / dur;
  // 不足 10 分钟的保留一位小数：152 秒四舍五入成"3 分钟"会让人以为它比实际长
  const mins = dur / 60;
  const minsText = mins < 10 ? `${mins.toFixed(1)} 分钟` : `${Math.round(mins)} 分钟`;
  const mb = bytes / 1024 / 1024;
  const feature = dur >= FEATURE_MIN_SEC;

  if (bytes < MIN_BYTES) {
    return { verdict: 'invalid', feature: false, kbps, reason: `只有 ${Math.round(mb * 1024)} KB，文件多半没真的传上去` };
  }
  if (dur < MIN_DURATION_SEC) {
    return { verdict: 'invalid', feature: false, kbps, reason: `只有 ${Math.round(dur)} 秒，是片段不是视频` };
  }
  if (kbps < MIN_KBPS) {
    return {
      verdict: 'invalid', feature: false, kbps,
      reason: `${minsText}却只有 ${mb.toFixed(0)} MB，码率 ${Math.round(kbps)} kbps —— 这个码率放不出画面，多半是残片或纯音轨`,
    };
  }
  if (kbps > MAX_KBPS) {
    return {
      verdict: 'invalid', feature: false, kbps,
      reason: `码率 ${Math.round(kbps / 1000)} Mbps，是母版而不是发行副本，浏览器放不动`,
    };
  }

  return {
    verdict: 'valid',
    feature,
    kbps,
    reason: feature
      ? `${minsText} · ${mb.toFixed(0)} MB · ${Math.round(kbps)} kbps，够正片长度`
      : `${minsText} · ${mb.toFixed(0)} MB · ${Math.round(kbps)} kbps，是有效视频但够不上正片长度（不足 40 分钟）`,
  };
}

/**
 * 一批片源的汇总。
 *
 * @param {object[]} sources
 * @returns {{total: number, valid: number, feature: number, invalid: number,
 *            unknown: number, items: object[]}}
 */
export function summarizeVideos(sources = []) {
  const items = sources.map((s) => ({ source: s, ...classifyVideo(s) }));
  return {
    total: items.length,
    valid: items.filter((x) => x.verdict === 'valid').length,
    // 正片是"有效"的子集，不是并列的一类
    feature: items.filter((x) => x.verdict === 'valid' && x.feature).length,
    invalid: items.filter((x) => x.verdict === 'invalid').length,
    unknown: items.filter((x) => x.verdict === 'unknown').length,
    items,
  };
}
