/**
 * 取证编排与证据固化。
 *
 * 读取策略：**不把整个影片读进内存**。先按盒头逐个跳过顶层盒，只完整读取
 * ftyp 与 moov —— 样本表全在 moov 里，mdat（占 99% 体积）根本不需要读。
 * 一部 2GB 的片子通常只需读几 MB。
 *
 * 证据固化：sha256 + md5 流式计算、文件大小、分析时刻、工具版本，
 * 全部写入报告，使结论可被第三方复核。
 */

import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { parseContainer } from './isobmff.js';
import { bitrateProfile, keyframeProfile, medianOf } from './profile.js';
import { detectInsertedSegments } from './anomaly.js';
import { analyzeProvenance } from './provenance.js';
import { compareWithReference, pickVideoTrack } from './compare.js';

export const TOOL_VERSION = 'cineroute-forensics/0.1';

/**
 * 只读取 ftyp 与 moov，同时记录真实的顶层盒顺序。
 * @param {string} filePath
 */
export async function readContainerHeads(filePath) {
  const fh = await fs.open(filePath, 'r');
  try {
    const { size: fileSize } = await fh.stat();
    const header = Buffer.alloc(16);
    const topLevel = [];
    let ftypBuf = null;
    let moovBuf = null;
    let offset = 0;

    while (offset + 8 <= fileSize) {
      const { bytesRead } = await fh.read(header, 0, 16, offset);
      if (bytesRead < 8) break;

      let size = header.readUInt32BE(0);
      const type = header.toString('latin1', 4, 8);
      let hdr = 8;

      if (size === 1) {
        if (bytesRead < 16) break;
        size = Number(header.readBigUInt64BE(8));
        hdr = 16;
      } else if (size === 0) {
        size = fileSize - offset;
      }
      if (size < hdr || offset + size > fileSize) break;

      topLevel.push({ type, size, start: offset });

      if (type === 'ftyp' || type === 'moov') {
        // moov 可能很大（长片的样本表能到几十 MB），但仍远小于整片。
        const b = Buffer.alloc(size);
        await fh.read(b, 0, size, offset);
        if (type === 'ftyp') ftypBuf = b; else moovBuf = b;
      }

      offset += size;
      // 顶层盒不该有成千上万个，异常文件早停。
      if (topLevel.length > 5000) break;
    }

    return { topLevel, ftypBuf, moovBuf, fileSize };
  } finally {
    await fh.close();
  }
}

/** 流式计算 sha256 与 md5，不占内存。 */
export function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const sha256 = createHash('sha256');
    const md5 = createHash('md5');
    createReadStream(filePath)
      .on('data', (d) => { sha256.update(d); md5.update(d); })
      .on('error', reject)
      .on('end', () => resolve({
        sha256: sha256.digest('hex'),
        md5: md5.digest('hex'),
      }));
  });
}

/**
 * 解析单个文件的容器结构（内存友好）。
 * @param {string} filePath
 */
export async function parseFile(filePath) {
  const { topLevel, ftypBuf, moovBuf, fileSize } = await readContainerHeads(filePath);
  if (!moovBuf) {
    return {
      ok: false,
      reason: '未找到 moov 盒。该文件可能不是 MP4/MOV（MKV、AVI、TS 需要 ffprobe 路径），或已损坏。',
      topLevel,
      fileSize,
    };
  }

  // 拼一个仅含 ftyp+moov 的缓冲区交给解析器；顶层顺序用真实文件的，
  // 否则 faststart 判定会失真。
  const synthetic = ftypBuf ? Buffer.concat([ftypBuf, moovBuf]) : moovBuf;
  const container = parseContainer(synthetic);
  container.topLevel = topLevel;
  container.fileSize = fileSize;
  return container;
}

/** 估算视频轨帧率（用于 keyint 交叉校验）。 */
function estimateFps(track) {
  if (!track?.deltas?.length || !track.media?.timescale) return null;
  const med = medianOf(track.deltas);
  return med > 0 ? track.media.timescale / med : null;
}

/**
 * 完整分析一个嫌疑副本；给了参考母版则同时做比对。
 *
 * @param {string} suspectPath
 * @param {{referencePath?: string, binSec?: number, skipHash?: boolean}} [opts]
 */
export async function analyze(suspectPath, opts = {}) {
  const startedAt = new Date().toISOString();

  const container = await parseFile(suspectPath);
  const stat = await fs.stat(suspectPath);
  const hashes = opts.skipHash ? null : await hashFile(suspectPath);

  const report = {
    tool: TOOL_VERSION,
    analyzedAt: startedAt,
    subject: {
      path: path.resolve(suspectPath),
      filename: path.basename(suspectPath),
      bytes: stat.size,
      mtime: stat.mtime.toISOString(),
      ...(hashes || {}),
    },
    container: null,
    tamper: { findings: [] },
    provenance: null,
    comparison: null,
    verdict: null,
  };

  if (!container.ok) {
    report.container = { ok: false, reason: container.reason };
    report.verdict = { level: 'unknown', summary: container.reason };
    return report;
  }

  const video = pickVideoTrack(container);
  const audioTracks = container.tracks.filter((t) => t.handlerType === 'soun');

  report.container = {
    ok: true,
    ftyp: container.ftyp,
    durationSec: container.movie ? container.movie.duration / container.movie.timescale : null,
    hasFragments: container.hasFragments,
    tracks: container.tracks.map((t) => ({
      trackId: t.trackId,
      type: t.handlerType,
      handlerName: t.name,
      codecs: t.codecs,
      width: t.width,
      height: t.height,
      durationSec: t.media ? t.media.duration / t.media.timescale : null,
      sampleCount: t.sampleCount,
      editList: t.editList,
    })),
    audioTrackCount: audioTracks.length,
    tags: container.tags,
  };

  if (video) {
    const detection = detectInsertedSegments(video, { binSec: opts.binSec ?? 1 });
    const kf = detection.keyframes;
    report.tamper = {
      findings: detection.findings,
      profileSummary: {
        binSec: detection.profile.binSec,
        durationSec: Number(detection.profile.durationSec.toFixed(2)),
        medianKbps: Math.round(medianOf(detection.profile.bins.map((b) => b.kbps)) || 0),
        gopMedianSec: kf.median ? Number(kf.median.toFixed(2)) : null,
        gopVariation: kf.cv != null ? Number(kf.cv.toFixed(2)) : null,
      },
    };

    report.provenance = analyzeProvenance(container, {
      observedGopSec: kf.median,
      fps: estimateFps(video),
    });
  } else {
    report.provenance = analyzeProvenance(container, {});
  }

  if (opts.referencePath) {
    const reference = await parseFile(opts.referencePath);
    if (!reference.ok) {
      report.comparison = { ok: false, reason: `参考母版解析失败：${reference.reason}` };
    } else {
      report.comparison = compareWithReference(container, reference, { binSec: opts.binSec ?? 1 });
      report.comparison.referencePath = path.resolve(opts.referencePath);
    }
  }

  report.verdict = buildVerdict(report);
  return report;
}

/** 汇总结论。 */
export function buildVerdict(report) {
  const reasons = [];
  let level = 'clean';

  const cmp = report.comparison;
  if (cmp?.ok) {
    if (cmp.identity.verdict === 'same-work') {
      reasons.push(`与参考母版内容覆盖率 ${(cmp.identity.coverage * 100).toFixed(1)}%，判定为同一作品`);
    } else if (cmp.identity.verdict === 'partial-match') {
      reasons.push(`与参考母版仅部分匹配（覆盖率 ${(cmp.identity.coverage * 100).toFixed(1)}%）`);
      level = 'suspicious';
    } else {
      reasons.push(`与参考母版不匹配（覆盖率 ${(cmp.identity.coverage * 100).toFixed(1)}%），可能不是同一作品`);
      level = 'suspicious';
    }
    const ins = cmp.findings.filter((f) => f.type === 'inserted-content');
    if (ins.length) {
      const total = ins.reduce((a, f) => a + f.durationSec, 0);
      reasons.push(`检出 ${ins.length} 处插入内容，合计 ${total} 秒`);
      level = 'tampered';
    }
  }

  const high = report.tamper.findings.filter((f) => f.level === 'high');
  const medium = report.tamper.findings.filter((f) => f.level === 'medium');
  if (high.length) {
    reasons.push(`码率与 GOP 双重异常段 ${high.length} 处（高置信）`);
    level = 'tampered';
  } else if (medium.length && level === 'clean') {
    reasons.push(`存在 ${medium.length} 处中等置信的异常段`);
    level = 'suspicious';
  }

  if (report.provenance?.reprocessed) {
    reasons.push('元数据显示经过转码或剪辑软件处理');
    if (level === 'clean') level = 'suspicious';
  }
  const suspiciousSignals = (report.provenance?.signals || []).filter((s) => s.suspicious);
  if (suspiciousSignals.length) {
    reasons.push(...suspiciousSignals.map((s) => `${s.label}：${s.note}`));
    if (level === 'clean') level = 'suspicious';
  }

  return {
    level,
    label: { clean: '未见明显加工痕迹', suspicious: '存在可疑加工痕迹', tampered: '确认经过后期加工', unknown: '无法判定' }[level],
    reasons,
  };
}

/* ─────────────────────────── 文本报告 ─────────────────────────── */

const ts = (sec) => {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
};

const mb = (b) => {
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(2)} GB`;
  if (b >= 1024 ** 2) return `${(b / 1024 ** 2).toFixed(1)} MB`;
  return `${(b / 1024).toFixed(1)} KB`;
};

/** 渲染人读报告。 */
export function renderText(report) {
  const L = [];
  const icon = { clean: '✅', suspicious: '⚠️ ', tampered: '🚩', unknown: '❔' }[report.verdict?.level] || '❔';

  L.push('');
  L.push('═'.repeat(72));
  L.push(`  视频取证报告   ${report.tool}`);
  L.push('═'.repeat(72));
  L.push('');
  L.push(`检材：${report.subject.filename}`);
  L.push(`路径：${report.subject.path}`);
  L.push(`大小：${mb(report.subject.bytes)}   修改时间：${report.subject.mtime}`);
  if (report.subject.sha256) {
    L.push(`SHA-256：${report.subject.sha256}`);
    L.push(`MD5    ：${report.subject.md5}`);
  }
  L.push(`分析时刻：${report.analyzedAt}`);

  L.push('');
  L.push(`${icon} 结论：${report.verdict?.label ?? '无'}`);
  for (const r of report.verdict?.reasons ?? []) L.push(`    · ${r}`);

  if (!report.container?.ok) {
    L.push('');
    L.push(`容器解析失败：${report.container?.reason}`);
    L.push('');
    return L.join('\n');
  }

  L.push('');
  L.push('─── 容器结构 ' + '─'.repeat(58));
  L.push(`封装品牌：${report.container.ftyp ? `${report.container.ftyp.majorBrand} [${report.container.ftyp.compatibleBrands.join(' ')}]` : '未知'}`);
  L.push(`总时长：${report.container.durationSec ? ts(report.container.durationSec) : '未知'}`);
  for (const t of report.container.tracks) {
    const dims = t.width && t.height ? `${Math.round(t.width)}×${Math.round(t.height)}` : '—';
    L.push(`  轨 ${t.trackId} [${t.type}] ${t.codecs.join('/') || '?'} ${dims} · ${t.sampleCount} 样本`
      + `${t.handlerName ? ` · handler="${t.handlerName}"` : ''}`);
    if (t.editList?.length) L.push(`      编辑列表：${JSON.stringify(t.editList)}`);
  }
  if (Object.keys(report.container.tags || {}).length) {
    L.push('  标签：');
    for (const [k, v] of Object.entries(report.container.tags)) {
      L.push(`      ${k} = ${v.length > 140 ? `${v.slice(0, 140)}…` : v}`);
    }
  }

  const ps = report.tamper.profileSummary;
  if (ps) {
    L.push('');
    L.push('─── 码率与 GOP 剖面 ' + '─'.repeat(51));
    L.push(`中位码率：${ps.medianKbps} kbps    关键帧中位间隔：${ps.gopMedianSec ?? '—'} s`
      + `    GOP 变异系数：${ps.gopVariation ?? '—'}`);
  }

  L.push('');
  L.push('─── 后期加工检测 ' + '─'.repeat(54));
  if (report.tamper.findings.length === 0) {
    L.push('  未检出异常段。');
  }
  for (const f of report.tamper.findings) {
    const mark = { high: '🚩', medium: '⚠️ ', low: '·' }[f.level] || '·';
    L.push(`  ${mark} ${ts(f.startSec)} – ${ts(f.endSec)}（${f.durationSec}s）`
      + `  置信度 ${(f.confidence * 100).toFixed(0)}%  ${f.type}`);
    for (const e of f.evidence) L.push(`      ${e}`);
  }

  if (report.provenance) {
    L.push('');
    L.push('─── 编码溯源 ' + '─'.repeat(58));
    if (report.provenance.encoderTag) {
      const t = report.provenance.encoderTag;
      L.push(`  编码器标签：${t.length > 160 ? `${t.slice(0, 160)}…` : t}`);
    }
    for (const tool of report.provenance.tools) {
      L.push(`  · ${tool.tool}${tool.version ? ` (${tool.version})` : ''} [${tool.kind}] — ${tool.note}`);
      L.push(`      来源：${tool.source}`);
    }
    for (const s of report.provenance.signals) {
      L.push(`  ${s.suspicious ? '⚠️ ' : '· '}${s.label}：${s.value}`);
      if (s.note) L.push(`      ${s.note}`);
    }
  }

  if (report.comparison) {
    L.push('');
    L.push('─── 与参考母版比对 ' + '─'.repeat(52));
    if (!report.comparison.ok) {
      L.push(`  ${report.comparison.reason}`);
    } else {
      const c = report.comparison;
      L.push(`  参考母版：${c.referencePath}`);
      L.push(`  同一性：${c.identity.verdict}（内容覆盖率 ${(c.identity.coverage * 100).toFixed(1)}%）`);
      L.push(`  时长：嫌疑副本 ${ts(c.durations.suspectSec)} · 母版 ${ts(c.durations.referenceSec)}`
        + `（差 ${c.durations.deltaSec > 0 ? '+' : ''}${c.durations.deltaSec}s）`);
      L.push(`  对齐：匹配后多出 ${c.align.inserted}s · 缺失 ${c.align.deleted}s · 内容不同 ${c.align.mismatched}s`);
      for (const s of c.structural) {
        L.push(`  ${s.suspicious ? '⚠️ ' : '· '}${s.label}：${s.value}${s.note ? `（${s.note}）` : ''}`);
      }
      if (c.findings.length) {
        L.push('  定位到的差异段：');
        for (const f of c.findings) {
          if (f.type === 'inserted-content') {
            L.push(`    🚩 嫌疑副本 ${ts(f.startSec)} – ${ts(f.endSec)}（${f.durationSec}s）插入内容`);
          } else {
            L.push(`    ⚠️  母版 ${ts(f.refStartSec)} – ${ts(f.refEndSec)}（${f.durationSec}s）在副本中缺失`);
          }
          for (const e of f.evidence) L.push(`        ${e}`);
        }
      }
    }
  }

  L.push('');
  L.push('═'.repeat(72));
  L.push('');
  return L.join('\n');
}
