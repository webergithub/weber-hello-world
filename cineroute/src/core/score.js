/**
 * 片源质量打分引擎（满分 100，可解释）。
 *
 * 设计立场：**"能不能真的播出来"优先于"清不清晰"**。
 * 一个 4K 的 MKV 在浏览器里是黑屏，一个 480p 的 MP4 能立刻出画面——
 * 对"点开就要看"的产品来说后者才是好片源。所以可播性既是最高权重维度，
 * 也是一票否决的硬门槛：容器不可播的片源不进 Top5，只进"可下载后本地播放"的备选区。
 *
 * 每个维度都产出 {score, max, reason}，前端把 reason 直接展示给用户，
 * 让"为什么这条排第一"是可解释的，而不是一个黑箱数字。
 */

import { nonFeatureHint } from './match.js';

/** 各维度权重（相加 = 100）。 */
export const WEIGHTS = {
  playability: 30,   // 浏览器能否直接播 + 能否拖进度条
  resolution: 20,    // 清晰度
  completeness: 18,  // 是不是完整正片（而非预告/片段）
  bitrate: 12,       // 码率健康度：太低糊，太高下载慢
  trust: 12,         // 许可清晰度与馆藏可信度
  popularity: 8,     // 人气/健康度
};

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

const PLAYABILITY_BASE = { native: 24, partial: 17, hls: 20, no: 0 };

/** 明确的自由许可 → 高可信；未知许可 → 低分但不否决。 */
const LICENSE_TIERS = [
  { test: /publicdomain|public[\s-]?domain|pdm|mark\/1\.0/i, score: 12, label: '公有领域' },
  { test: /cc0|zero/i, score: 12, label: 'CC0 公共领域贡献' },
  { test: /by-sa/i, score: 11, label: 'CC BY-SA 署名-相同方式共享' },
  { test: /by-nc-nd/i, score: 8, label: 'CC BY-NC-ND 署名-非商业-禁演绎' },
  { test: /by-nc/i, score: 9, label: 'CC BY-NC 署名-非商业' },
  { test: /by-nd/i, score: 9, label: 'CC BY-ND 署名-禁演绎' },
  { test: /creativecommons\.org\/licenses\/by/i, score: 11, label: 'CC BY 署名' },
  { test: /creativecommons/i, score: 9, label: 'Creative Commons 许可' },
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

/** 维度 1：可播性（0-30）。同时决定是否触发硬门槛。 */
function scorePlayability(source) {
  const container = detectContainer(source);
  const support = CONTAINER_SUPPORT[container] || { level: 'partial', note: `未知容器 .${container || '?'}，可播性待探测` };
  let score = PLAYABILITY_BASE[support.level];
  const notes = [support.note];

  // Range 支持决定能否拖动进度条与断点续传，值 0-6 分。
  if (source.rangeSupported === true) {
    score += 6;
    notes.push('支持 Range，可拖动进度条与断点续传');
  } else if (source.rangeSupported === false) {
    notes.push('不支持 Range，只能从头顺序播放，下载不可续传');
  } else {
    score += 2;
    notes.push('Range 支持未探测');
  }

  // 明确探测失败（404/超时）是强负信号。
  if (source.reachable === false) {
    score = 0;
    notes.push('探测不可达，链接可能已失效');
  }

  // 非 HTTPS 在 HTTPS 页面里会被混合内容策略拦截。
  if (source.url && source.url.startsWith('http://')) {
    score = Math.max(0, score - 5);
    notes.push('明文 HTTP，HTTPS 页面内会被混合内容策略拦截');
  }

  return {
    key: 'playability',
    label: '可播性',
    score: clamp(score, 0, WEIGHTS.playability),
    max: WEIGHTS.playability,
    reason: notes.join('；'),
    blocked: support.level === 'no' || source.reachable === false,
    blockReason: support.level === 'no' ? support.note : (source.reachable === false ? '链接探测不可达' : null),
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

/** 维度 2：清晰度（0-20）。 */
function scoreResolution(source) {
  let height = source.height ? Number(source.height) : null;
  let inferred = false;
  if (!height) {
    height = inferHeightFromFormat(source.format);
    inferred = height != null;
  }

  if (!height) {
    return {
      key: 'resolution', label: '清晰度',
      score: 7, max: WEIGHTS.resolution,
      reason: '上游未提供分辨率，按中位水平计分',
    };
  }

  const table = [
    [2160, 20], [1440, 19], [1080, 18], [720, 15],
    [576, 11], [480, 8], [360, 5], [240, 2],
  ];
  let score = 1;
  for (const [h, s] of table) {
    if (height >= h) { score = s; break; }
  }
  // 推断出来的分辨率置信度低，打个折。
  if (inferred) score = Math.round(score * 0.85);

  const label = height >= 2160 ? '4K' : height >= 1080 ? '1080p' : height >= 720 ? '720p' : `${height}p`;
  return {
    key: 'resolution', label: '清晰度',
    score: clamp(score, 0, WEIGHTS.resolution), max: WEIGHTS.resolution,
    reason: inferred ? `由格式名推断约 ${label}` : `${source.width ? `${source.width}×${height}` : label}`,
  };
}

/**
 * 维度 3：完整度（0-18）。
 *
 * 这是把"预告片/片段"挡在 Top5 之外的关键维度。
 * 参考片长优先用权威元数据（TMDB runtime）；没有权威值时，
 * 用同一部作品所有候选片源时长的**中位数**当参考——
 * 归档站里正片副本通常多于预告片副本，中位数天然落在正片时长上，
 * 这样在完全没有外部 API key 的情况下依然能过滤片段。
 */
function scoreCompleteness(source, referenceRuntimeSec) {
  const dur = source.durationSec ? Number(source.durationSec) : null;
  const hint = nonFeatureHint(`${source.title || ''} ${source.filename || ''}`);

  if (hint) {
    return {
      key: 'completeness', label: '完整度',
      score: 0, max: WEIGHTS.completeness,
      reason: `标题含「${hint}」，判定为非正片`,
      suspicious: true,
    };
  }

  if (!dur || !referenceRuntimeSec) {
    return {
      key: 'completeness', label: '完整度',
      score: 9, max: WEIGHTS.completeness,
      reason: dur ? '无参考片长可比对，按中位水平计分' : '上游未提供时长',
    };
  }

  const ratio = dur / referenceRuntimeSec;
  const mins = Math.round(dur / 60);
  const refMins = Math.round(referenceRuntimeSec / 60);
  let score;
  let reason;
  let suspicious = false;

  if (ratio >= 0.9 && ratio <= 1.12) {
    score = 18; reason = `${mins} 分钟，与参考片长 ${refMins} 分钟一致`;
  } else if (ratio >= 0.75 && ratio < 0.9) {
    score = 11; reason = `${mins} 分钟，比参考片长短约 ${Math.round((1 - ratio) * 100)}%，可能有删减`;
  } else if (ratio > 1.12 && ratio <= 1.3) {
    score = 12; reason = `${mins} 分钟，长于参考片长，可能是加长版或含片头广告`;
  } else if (ratio >= 0.5 && ratio < 0.75) {
    score = 5; reason = `${mins} 分钟，明显短于参考片长 ${refMins} 分钟，疑似删减版`;
  } else if (ratio < 0.5) {
    score = 0; reason = `仅 ${mins} 分钟，参考片长 ${refMins} 分钟，判定为片段或预告`;
    suspicious = true;
  } else {
    score = 6; reason = `${mins} 分钟，远长于参考片长，疑似合集`;
  }

  return { key: 'completeness', label: '完整度', score, max: WEIGHTS.completeness, reason, suspicious };
}

/** 维度 4：码率健康度（0-12）。 */
function scoreBitrate(source) {
  const bytes = source.bytes ? Number(source.bytes) : null;
  const dur = source.durationSec ? Number(source.durationSec) : null;
  if (!bytes || !dur || dur <= 0) {
    return {
      key: 'bitrate', label: '码率', score: 6, max: WEIGHTS.bitrate,
      reason: '缺少体积或时长，无法计算码率',
    };
  }

  const kbps = (bytes * 8) / 1000 / dur;
  const mb = bytes / 1024 / 1024;
  let score;
  let verdict;
  if (kbps < 200) { score = 2; verdict = '码率过低，画面会明显模糊'; }
  else if (kbps < 600) { score = 6; verdict = '码率偏低，适合弱网'; }
  else if (kbps < 1500) { score = 10; verdict = '码率适中'; }
  else if (kbps <= 6000) { score = 12; verdict = '码率理想'; }
  else if (kbps <= 15000) { score = 10; verdict = '码率较高，加载偏慢'; }
  else { score = 7; verdict = '码率很高，适合下载而非在线播放'; }

  return {
    key: 'bitrate', label: '码率',
    score, max: WEIGHTS.bitrate,
    reason: `${Math.round(kbps)} kbps · ${mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${Math.round(mb)} MB`}，${verdict}`,
  };
}

/** 维度 5：来源可信度（0-12）。 */
function scoreTrust(source) {
  const license = source.license || '';
  let base = 4;
  let label = '许可未标注';
  for (const tier of LICENSE_TIERS) {
    if (tier.test.test(license)) { base = tier.score; label = tier.label; break; }
  }

  const collections = Array.isArray(source.collections) ? source.collections : [];
  const hit = collections.find((c) => TRUSTED_COLLECTIONS.has(String(c).toLowerCase()));
  let score = base;
  const notes = [label];
  if (hit) {
    score = Math.min(WEIGHTS.trust, score + 2);
    notes.push(`收录于 ${hit} 馆藏`);
  }
  if (source.ownedByUser) {
    score = WEIGHTS.trust;
    notes.length = 0;
    notes.push('来自你自己的媒体库');
  }

  return {
    key: 'trust', label: '来源可信',
    score: clamp(score, 0, WEIGHTS.trust), max: WEIGHTS.trust,
    reason: notes.join('；'),
  };
}

/** 维度 6：人气/健康度（0-8）。对数归一，避免头部条目碾压一切。 */
function scorePopularity(source) {
  const downloads = Number(source.downloads || 0);
  if (!downloads) {
    return {
      key: 'popularity', label: '人气', score: 2, max: WEIGHTS.popularity,
      reason: '无下载量数据',
    };
  }
  // 1e6 次下载封顶
  const score = clamp((Math.log10(downloads) / 6) * WEIGHTS.popularity, 0, WEIGHTS.popularity);
  return {
    key: 'popularity', label: '人气', score: Math.round(score * 10) / 10, max: WEIGHTS.popularity,
    reason: `${downloads.toLocaleString('en-US')} 次下载`,
  };
}

/**
 * 给单个片源打分。
 *
 * @param {object} source 片源（见 types.js 的 PlaySource）
 * @param {{referenceRuntimeSec?: number|null}} [ctx]
 * @returns {object} 带 score / breakdown / blocked 的片源副本
 */
export function scoreSource(source, ctx = {}) {
  const breakdown = [
    scorePlayability(source),
    scoreResolution(source),
    scoreCompleteness(source, ctx.referenceRuntimeSec ?? null),
    scoreBitrate(source),
    scoreTrust(source),
    scorePopularity(source),
  ];

  const total = breakdown.reduce((sum, d) => sum + d.score, 0);
  const playability = breakdown[0];
  const completeness = breakdown[2];

  // 硬门槛：浏览器放不出来的、或判定为片段的，不进 Top5。
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
    // 即使被挡在 Top5 之外，仍然可以下载后本地播放——除非链接根本不可达。
    downloadable: source.reachable !== false,
  };
}

/**
 * 对一组片源打分并排序。
 * 返回 { top, alternatives }：top 是可直接播放的前 N 条，
 * alternatives 是被硬门槛挡下但仍可下载的片源（附原因）。
 *
 * @param {object[]} sources
 * @param {{referenceRuntimeSec?: number|null, limit?: number}} [ctx]
 */
export function rankSources(sources, ctx = {}) {
  const limit = ctx.limit ?? 5;
  const scored = sources.map((s) => scoreSource(s, ctx));
  const byScore = (a, b) => b.score - a.score;

  const playable = scored.filter((s) => !s.blocked).sort(byScore);
  const alternatives = scored.filter((s) => s.blocked).sort(byScore);

  return {
    top: playable.slice(0, limit).map((s, i) => ({ ...s, rank: i + 1 })),
    overflow: playable.slice(limit),
    alternatives,
  };
}

/**
 * 无权威片长时的参考片长估计：取所有候选时长的中位数。
 * 见 scoreCompleteness 的说明——这是本系统在零 API key 情况下
 * 依然能把预告片挡在门外的关键技巧。
 *
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

export { CONTAINER_SUPPORT };
