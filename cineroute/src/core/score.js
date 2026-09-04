/**
 * 片源质量打分引擎（满分 100，可解释）。
 *
 * 设计立场：**"能不能真的播出来"是硬门槛，"清不清晰、全不全"决定排位**。
 * 一个 4K 的 MKV 在浏览器里是黑屏，一个 480p 的 MP4 能立刻出画面——
 * 所以可播性是一票否决项：容器不可播的片源不进推荐位，只进"可下载后本地播放"的备选区。
 * 但在**都能播**的候选之间，排序由清晰度与片长完整度主导（合计 48 分）。
 *
 * 每个维度先产出一个 0..1 的归一化比值，再乘以权重。这样调整权重
 * 不会牵动任何维度的内部判据，也让权重可以按需覆盖（见 resolveWeights）。
 */

import { nonFeatureHint } from './match.js';

/**
 * 各维度权重（相加 = 100）。
 *
 * 清晰度 26 + 完整度 22 = 48，高于可播性 30：在都能播的前提下，
 * "更清晰、更完整（更长）"是排序的主导因素。
 */
export const WEIGHTS = {
  playability: 30,   // 硬门槛：浏览器能否直接播 + 能否拖进度条
  resolution: 26,    // 清晰度 —— 主导排序
  completeness: 22,  // 片长完整度 —— 主导排序，且偏好更长的版本
  trust: 10,         // 许可清晰度与馆藏可信度
  bitrate: 8,        // 码率健康度：太低糊，太高下载慢
  popularity: 4,     // 人气/健康度
};

/**
 * 解析权重覆盖。支持 `CINEROUTE_WEIGHTS="resolution=30,completeness=25"`，
 * 也支持通过 ctx.weights 传入。未覆盖的维度沿用默认值。
 * @param {Record<string, number>} [override]
 */
export function resolveWeights(override) {
  const merged = { ...WEIGHTS };
  const fromEnv = process.env.CINEROUTE_WEIGHTS;
  if (fromEnv) {
    for (const pair of fromEnv.split(',')) {
      const [k, v] = pair.split('=').map((s) => s?.trim());
      if (k in merged && Number.isFinite(Number(v))) merged[k] = Number(v);
    }
  }
  if (override) {
    for (const [k, v] of Object.entries(override)) {
      if (k in merged && Number.isFinite(Number(v))) merged[k] = Number(v);
    }
  }
  return merged;
}

/**
 * 容器 → 浏览器原生播放能力。
 * 'native'  : <video src> 直接可播
 * 'partial' : 取决于内部编码或浏览器（如 ogv 在 Safari 不支持）
 * 'hls'     : 需要 hls.js（Safari 原生支持）
 * 'no'      : 浏览器放不了，只能下载后用本地播放器
 */
const CONTAINER_SUPPORT = {
  mp4: { level: 'native', note: 'MP4/H.264 全平台原生可播' },
  m4v: { level: 'native', note: 'M4V 等同 MP4 容器' },
  webm: { level: 'native', note: 'WebM 现代浏览器原生可播' },
  ogv: { level: 'partial', note: 'Ogg/Theora，Safari 与 iOS 不支持' },
  ogg: { level: 'partial', note: 'Ogg 容器，Safari 与 iOS 不支持' },
  mov: { level: 'partial', note: 'MOV 取决于内部编码，H.264 可播' },
  m3u8: { level: 'hls', note: 'HLS 流，Safari 原生、其余需 hls.js' },
  mpd: { level: 'hls', note: 'DASH 流，需 dash.js' },
  mkv: { level: 'no', note: 'Matroska 浏览器不支持，可下载后本地播放' },
  avi: { level: 'no', note: 'AVI 浏览器不支持，可下载后本地播放' },
  mpg: { level: 'no', note: 'MPEG-1/2 浏览器不支持，可下载后本地播放' },
  mpeg: { level: 'no', note: 'MPEG-1/2 浏览器不支持，可下载后本地播放' },
  wmv: { level: 'no', note: 'Windows Media 浏览器不支持' },
  flv: { level: 'no', note: 'Flash 视频，早已无浏览器支持' },
  rm: { level: 'no', note: 'RealMedia 浏览器不支持' },
  rmvb: { level: 'no', note: 'RealMedia 浏览器不支持' },
  gif: { level: 'no', note: '动图预览，不是正片' },
};

/** 归一化的可播性基准（0..1，留 0.2 给 Range 支持）。 */
const PLAYABILITY_BASE = { native: 0.8, hls: 0.67, partial: 0.57, no: 0 };

/** 明确的自由许可 → 高可信；未知许可 → 低分但不否决。 */
const LICENSE_TIERS = [
  { test: /publicdomain|public[\s-]?domain|pdm|mark\/1\.0/i, ratio: 1, label: '公有领域' },
  { test: /cc0|zero/i, ratio: 1, label: 'CC0 公共领域贡献' },
  { test: /by-sa/i, ratio: 0.92, label: 'CC BY-SA 署名-相同方式共享' },
  { test: /by-nc-nd/i, ratio: 0.67, label: 'CC BY-NC-ND 署名-非商业-禁演绎' },
  { test: /by-nc/i, ratio: 0.75, label: 'CC BY-NC 署名-非商业' },
  { test: /by-nd/i, ratio: 0.75, label: 'CC BY-ND 署名-禁演绎' },
  { test: /creativecommons\.org\/licenses\/by/i, ratio: 0.92, label: 'CC BY 署名' },
  { test: /creativecommons/i, ratio: 0.75, label: 'Creative Commons 许可' },
];

/** 已知的高可信馆藏/来源，额外加信任分（上限内）。 */
const TRUSTED_COLLECTIONS = new Set([
  'feature_films', 'prelinger', 'classic_cartoons', 'silent_films',
  'moviesandfilms', 'publicmovies', 'sci-fi_horror', 'film_noir',
  'universal_library', 'more_animation', 'newsandpublicaffairs',
]);

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** 从文件名或 URL 推断容器后缀。 */
export function detectContainer(source) {
  if (source.container) return String(source.container).toLowerCase().replace(/^\./, '');
  const path = String(source.url || '').split('?')[0].split('#')[0];
  const m = path.match(/\.([a-z0-9]{2,5})$/i);
  return m ? m[1].toLowerCase() : '';
}

/** 维度 1：可播性。同时决定是否触发硬门槛。 */
function dimPlayability(source) {
  const container = detectContainer(source);
  const support = CONTAINER_SUPPORT[container]
    || { level: 'partial', note: `未知容器 .${container || '?'}，可播性待探测` };
  let ratio = PLAYABILITY_BASE[support.level];
  const notes = [support.note];

  // Range 支持决定能否拖动进度条与断点续传。
  if (source.rangeSupported === true) {
    ratio += 0.2;
    notes.push('支持 Range，可拖动进度条与断点续传');
  } else if (source.rangeSupported === false) {
    notes.push('不支持 Range，只能从头顺序播放，下载不可续传');
  } else {
    ratio += 0.07;
    notes.push('Range 支持未探测');
  }

  // 明确探测失败（404/超时）是强负信号。
  if (source.reachable === false) {
    ratio = 0;
    notes.push('探测不可达，链接可能已失效');
  }

  // 非 HTTPS 在 HTTPS 页面里会被混合内容策略拦截。
  if (source.url && source.url.startsWith('http://')) {
    ratio = Math.max(0, ratio - 0.17);
    notes.push('明文 HTTP，HTTPS 页面内会被混合内容策略拦截');
  }

  return {
    key: 'playability',
    label: '可播性',
    ratio: clamp(ratio, 0, 1),
    reason: notes.join('；'),
    blocked: support.level === 'no' || source.reachable === false,
    blockReason: support.level === 'no'
      ? support.note
      : (source.reachable === false ? '链接探测不可达' : null),
  };
}

/** 从 Internet Archive 的 format 串反推大致清晰度（无 height 字段时的兜底）。 */
function inferHeightFromFormat(format) {
  if (!format) return null;
  const f = String(format).toLowerCase();
  if (/2160|4k|uhd/.test(f)) return 2160;
  if (/1440/.test(f)) return 1440;
  if (/1080|hires|hi-?res/.test(f)) return 1080;
  if (/720|hd/.test(f)) return 720;
  if (/576/.test(f)) return 576;
  if (/480|512kb/.test(f)) return 480;
  if (/360/.test(f)) return 360;
  if (/240|256kb|64kb/.test(f)) return 240;
  return null;
}

/** 清晰度阶梯 → 归一化比值。 */
const RESOLUTION_LADDER = [
  [2160, 1.00], [1440, 0.94], [1080, 0.88], [720, 0.72],
  [576, 0.54], [480, 0.40], [360, 0.24], [240, 0.10],
];

/** 维度 2：清晰度。权重最高的排序维度之一。 */
function dimResolution(source) {
  let height = source.height ? Number(source.height) : null;
  let inferred = false;
  if (!height) {
    height = inferHeightFromFormat(source.format);
    inferred = height != null;
  }

  if (!height) {
    return { key: 'resolution', label: '清晰度', ratio: 0.35, reason: '上游未提供分辨率，按中位水平计分' };
  }

  let ratio = 0.04;
  for (const [h, r] of RESOLUTION_LADDER) {
    if (height >= h) { ratio = r; break; }
  }
  // 推断出来的分辨率置信度低，打个折。
  if (inferred) ratio *= 0.85;

  const label = height >= 2160 ? '4K' : height >= 1080 ? '1080p' : height >= 720 ? '720p' : `${height}p`;
  return {
    key: 'resolution', label: '清晰度',
    ratio: clamp(ratio, 0, 1),
    reason: inferred ? `由格式名推断约 ${label}` : (source.width ? `${source.width}×${height}` : label),
  };
}

/**
 * 维度 3：片长完整度。**偏好更长的版本。**
 *
 * 由两部分构成：
 *  - 完整度基准（75%）：相对参考片长的达标程度。**不对称**——
 *    短于参考片长按缺失比例扣分，达到或超过参考片长给满分，
 *    因为更长的版本通常意味着未删减版 / 修复加长版，而非缺陷。
 *  - 长度偏好（25%）：相对本次候选中最长片源的比值，
 *    让两个都"完整"的版本之间，更长的那个胜出。
 *
 * 参考片长优先用权威元数据（TMDB runtime）；没有权威值时用候选时长中位数——
 * 归档站里正片副本通常多于预告片副本，中位数天然落在正片时长上。
 */
function dimCompleteness(source, referenceRuntimeSec, maxDurationSec) {
  const dur = source.durationSec ? Number(source.durationSec) : null;
  const hint = nonFeatureHint(`${source.title || ''} ${source.filename || ''}`);

  if (hint) {
    return {
      key: 'completeness', label: '完整度', ratio: 0,
      reason: `标题含「${hint}」，判定为非正片`, suspicious: true,
    };
  }

  if (!dur) {
    return { key: 'completeness', label: '完整度', ratio: 0.5, reason: '上游未提供时长' };
  }

  const mins = Math.round(dur / 60);

  if (!referenceRuntimeSec) {
    // 没有参照系时，只能靠"相对最长候选"排序。
    const lengthOnly = maxDurationSec ? clamp(dur / maxDurationSec, 0, 1) : 0.5;
    return {
      key: 'completeness', label: '完整度',
      ratio: clamp(0.4 + lengthOnly * 0.6, 0, 1),
      reason: `${mins} 分钟，无参考片长可比对，按相对时长计分`,
    };
  }

  const ratio = dur / referenceRuntimeSec;
  const refMins = Math.round(referenceRuntimeSec / 60);
  let base;
  let reason;
  let suspicious = false;

  if (ratio < 0.5) {
    base = 0;
    reason = `仅 ${mins} 分钟，参考片长 ${refMins} 分钟，判定为片段或预告`;
    suspicious = true;
  } else if (ratio < 0.75) {
    base = 0.3;
    reason = `${mins} 分钟，明显短于参考片长 ${refMins} 分钟，疑似删减版`;
  } else if (ratio < 0.9) {
    base = 0.65;
    reason = `${mins} 分钟，比参考片长短约 ${Math.round((1 - ratio) * 100)}%，可能有删减`;
  } else if (ratio < 1) {
    base = 0.88;
    reason = `${mins} 分钟，接近参考片长 ${refMins} 分钟`;
  } else if (ratio <= 1.35) {
    base = 1;
    reason = ratio > 1.03
      ? `${mins} 分钟，长于参考片长 ${refMins} 分钟，可能是未删减版/修复加长版`
      : `${mins} 分钟，与参考片长 ${refMins} 分钟一致`;
  } else {
    // 远长于片长通常是合集或含大量片头片尾，不再继续加分但也不判定为非正片。
    base = 0.8;
    reason = `${mins} 分钟，远长于参考片长 ${refMins} 分钟，可能是合集`;
  }

  if (suspicious) {
    return { key: 'completeness', label: '完整度', ratio: 0, reason, suspicious: true };
  }

  // 长度偏好：在都达标的候选之间，更长的胜出。
  const lengthPref = maxDurationSec ? clamp(dur / maxDurationSec, 0, 1) : 0.8;
  return {
    key: 'completeness', label: '完整度',
    ratio: clamp(base * 0.75 + lengthPref * 0.25, 0, 1),
    reason,
  };
}

/** 维度 4：码率健康度。 */
function dimBitrate(source) {
  const bytes = source.bytes ? Number(source.bytes) : null;
  const dur = source.durationSec ? Number(source.durationSec) : null;
  if (!bytes || !dur || dur <= 0) {
    return { key: 'bitrate', label: '码率', ratio: 0.5, reason: '缺少体积或时长，无法计算码率' };
  }

  const kbps = (bytes * 8) / 1000 / dur;
  const mb = bytes / 1024 / 1024;
  let ratio;
  let verdict;
  if (kbps < 200) { ratio = 0.17; verdict = '码率过低，画面会明显模糊'; }
  else if (kbps < 600) { ratio = 0.5; verdict = '码率偏低，适合弱网'; }
  else if (kbps < 1500) { ratio = 0.83; verdict = '码率适中'; }
  else if (kbps <= 6000) { ratio = 1; verdict = '码率理想'; }
  else if (kbps <= 15000) { ratio = 0.83; verdict = '码率较高，加载偏慢'; }
  else { ratio = 0.58; verdict = '码率很高，适合下载而非在线播放'; }

  return {
    key: 'bitrate', label: '码率', ratio,
    reason: `${Math.round(kbps)} kbps · ${mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${Math.round(mb)} MB`}，${verdict}`,
  };
}

/** 维度 5：来源可信度。 */
function dimTrust(source) {
  const license = source.license || '';
  let ratio = 0.33;
  let label = '许可未标注';
  for (const tier of LICENSE_TIERS) {
    if (tier.test.test(license)) { ratio = tier.ratio; label = tier.label; break; }
  }

  const collections = Array.isArray(source.collections) ? source.collections : [];
  const hit = collections.find((c) => TRUSTED_COLLECTIONS.has(String(c).toLowerCase()));
  const notes = [label];
  if (hit) {
    ratio = Math.min(1, ratio + 0.17);
    notes.push(`收录于 ${hit} 馆藏`);
  }
  if (source.ownedByUser) {
    ratio = 1;
    notes.length = 0;
    notes.push('来自你自己的媒体库');
  }

  return { key: 'trust', label: '来源可信', ratio: clamp(ratio, 0, 1), reason: notes.join('；') };
}

/** 维度 6：人气/健康度。对数归一，避免头部条目碾压一切。 */
function dimPopularity(source) {
  const downloads = Number(source.downloads || 0);
  if (!downloads) {
    return { key: 'popularity', label: '人气', ratio: 0.25, reason: '无下载量数据' };
  }
  // 1e6 次下载封顶
  return {
    key: 'popularity', label: '人气',
    ratio: clamp(Math.log10(downloads) / 6, 0, 1),
    reason: `${downloads.toLocaleString('en-US')} 次下载`,
  };
}

/**
 * 给单个片源打分。
 *
 * @param {object} source 片源
 * @param {{referenceRuntimeSec?: number|null, maxDurationSec?: number|null,
 *          weights?: Record<string, number>}} [ctx]
 */
export function scoreSource(source, ctx = {}) {
  const weights = resolveWeights(ctx.weights);
  const dims = [
    dimPlayability(source),
    dimResolution(source),
    dimCompleteness(source, ctx.referenceRuntimeSec ?? null, ctx.maxDurationSec ?? null),
    dimBitrate(source),
    dimTrust(source),
    dimPopularity(source),
  ];

  const breakdown = dims.map((d) => {
    const max = weights[d.key];
    return {
      key: d.key,
      label: d.label,
      score: Math.round(d.ratio * max * 10) / 10,
      max,
      reason: d.reason,
      ...(d.blocked !== undefined ? { blocked: d.blocked, blockReason: d.blockReason } : {}),
      ...(d.suspicious !== undefined ? { suspicious: d.suspicious } : {}),
    };
  });

  const total = breakdown.reduce((sum, d) => sum + d.score, 0);
  const playability = breakdown[0];
  const completeness = breakdown[2];

  // 硬门槛：浏览器放不出来的、或判定为片段的，不进推荐位。
  const blocked = Boolean(playability.blocked) || Boolean(completeness.suspicious);
  const blockReason = playability.blocked
    ? playability.blockReason
    : (completeness.suspicious ? completeness.reason : null);

  return {
    ...source,
    container: detectContainer(source),
    score: Math.round(total * 10) / 10,
    breakdown,
    blocked,
    blockReason,
    // 即使被挡在推荐位之外，仍然可以下载后本地播放——除非链接根本不可达。
    downloadable: source.reachable !== false,
  };
}

/**
 * 对一组片源打分并排序。
 *
 * 同分时的决胜次序体现"优先清晰度、其次时长"的产品要求：
 * 总分 → 分辨率 → 时长 → 体积。
 *
 * @param {object[]} sources
 * @param {{referenceRuntimeSec?: number|null, maxDurationSec?: number|null,
 *          limit?: number, weights?: Record<string, number>}} [ctx]
 */
export function rankSources(sources, ctx = {}) {
  const limit = ctx.limit ?? 5;
  const scored = sources.map((s) => scoreSource(s, ctx));

  const compare = (a, b) =>
    b.score - a.score
    || (Number(b.height) || 0) - (Number(a.height) || 0)
    || (Number(b.durationSec) || 0) - (Number(a.durationSec) || 0)
    || (Number(b.bytes) || 0) - (Number(a.bytes) || 0);

  const playable = scored.filter((s) => !s.blocked).sort(compare);
  const alternatives = scored.filter((s) => s.blocked).sort(compare);

  return {
    top: playable.slice(0, limit).map((s, i) => ({ ...s, rank: i + 1 })),
    overflow: playable.slice(limit),
    alternatives,
  };
}

/**
 * 无权威片长时的参考片长估计：取所有候选时长的中位数。
 * @param {object[]} sources
 * @returns {number|null}
 */
export function estimateReferenceRuntime(sources) {
  const durations = sources
    .map((s) => Number(s.durationSec))
    .filter((d) => Number.isFinite(d) && d > 0)
    .sort((a, b) => a - b);
  if (durations.length === 0) return null;
  const mid = Math.floor(durations.length / 2);
  return durations.length % 2 ? durations[mid] : (durations[mid - 1] + durations[mid]) / 2;
}

/**
 * "长度偏好"的分母：候选中的最长时长。
 *
 * 但要防止一个 5 小时的合集把所有正片的长度分压到很低，
 * 因此只在参考片长的 1.5 倍以内取最大值。
 *
 * @param {object[]} sources
 * @param {number|null} referenceRuntimeSec
 * @returns {number|null}
 */
export function computeMaxDuration(sources, referenceRuntimeSec) {
  const cap = referenceRuntimeSec ? referenceRuntimeSec * 1.5 : Infinity;
  const durations = sources
    .map((s) => Number(s.durationSec))
    .filter((d) => Number.isFinite(d) && d > 0 && d <= cap);
  if (durations.length === 0) return null;
  return Math.max(...durations);
}

export { CONTAINER_SUPPORT };
