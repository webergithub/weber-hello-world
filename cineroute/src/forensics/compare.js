/**
 * 与参考母版比对 —— 同一性甄别 + 插入段精确定位。
 *
 * 有参考副本时，这是最强的一层证据。原理：
 * **码率剖面的"形状"在重编码后基本保留**。复杂场景吃更多比特，这一点
 * 与码率档位无关，所以把两条曲线各自除以自身中位数做归一化之后，
 * 同一部片子的正片段之间相关性很高（通常 r>0.7），不同内容之间则接近 0。
 *
 * 于是插入检测就变成一个序列对齐问题：沿着两条曲线同步前进，
 * 一旦相关性掉下去，就在嫌疑副本上向前试探——如果跳过 k 秒后重新对上，
 * 那这 k 秒就是**被插入的内容**，且能给出精确到秒的起止时间码。
 * 反之若要在参考上跳过才对得上，说明嫌疑副本**删掉**了那一段。
 *
 * 这个方法不需要解码，也不受重编码、改分辨率、改码率影响。
 */

import { bitrateProfile, medianOf, keyframeProfile } from './profile.js';

/** 用中位数归一化，消除码率档位差异，只保留曲线形状。 */
export function normalizeProfile(kbps) {
  const med = medianOf(kbps) || 1;
  return kbps.map((v) => v / med);
}

/** 皮尔逊相关系数。任一侧方差为 0 时退化为均值接近度。 */
export function correlate(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;

  let sa = 0;
  let sb = 0;
  for (let i = 0; i < n; i += 1) { sa += a[i]; sb += b[i]; }
  const ma = sa / n;
  const mb = sb / n;

  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i += 1) {
    const x = a[i] - ma;
    const y = b[i] - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  // 恒定段要分两种情况，不能一律退化成"比均值"：
  // 两侧都恒定且均值接近，才算像；只有一侧恒定（例如一段码率拉平的插播广告
  // 对上一段有起伏的正片）必须判为不相似——否则那段广告会和任何窗口都"匹配"，
  // 整条对齐随即失效。
  if (da === 0 && db === 0) {
    const diff = Math.abs(ma - mb) / (Math.max(Math.abs(ma), Math.abs(mb)) || 1);
    return diff < 0.15 ? 1 : 0;
  }
  if (da === 0 || db === 0) return 0;

  return num / Math.sqrt(da * db);
}

const win = (arr, from, len) => arr.slice(from, from + len);

/**
 * 对齐两条归一化剖面。
 *
 * @param {number[]} ref  参考母版的归一化逐秒剖面
 * @param {number[]} sus  嫌疑副本的归一化逐秒剖面
 * @param {{window?:number, threshold?:number, maxSkip?:number}} [opts]
 * @returns {{ops:Array, matched:number, inserted:number, deleted:number, mismatched:number}}
 */
export function alignProfiles(ref, sus, opts = {}) {
  const W = opts.window ?? 10;
  const threshold = opts.threshold ?? 0.6;
  const maxSkip = opts.maxSkip ?? 400;
  // 重新对齐必须用更高的门槛 + 更长的确认窗口。
  // 只要"第一个过阈值的偏移"是不够的：失配点附近的窗口跨越了拼接边界，
  // 此时任何偏移都对不准，却可能有某个偏移碰巧达到walk阈值——一旦采信，
  // 后续整条对齐就会持续漂移，把 20 秒的插入放大成 40 秒。
  const confirmThreshold = opts.confirmThreshold ?? 0.9;
  const confirmWindow = opts.confirmWindow ?? W * 3;
  // 重新对齐的次数上限。这不是性能考虑，而是判据本身：
  // 一个被插播了广告的副本会有个位数的拼接点，不会有几百个。
  // 不设上限的话，在几百个候选偏移里"总能"找到某个碰巧高相关的位置
  // （生日问题），于是两部完全不同的片子也会被对齐成"同一作品"。
  const maxResyncs = opts.maxResyncs ?? 12;

  const ops = [];
  let resyncs = 0;
  let i = 0;
  let j = 0;

  /**
   * 在给定方向上找最佳重同步偏移。
   * 取相关性**最高**的偏移（而非第一个达标的），并要求它在双倍窗口上
   * 超过确认阈值，否则宁可判为失配、各自前进一格，等真正的对齐点出现。
   */
  const findResync = (side) => {
    for (let skip = 1; skip <= maxSkip; skip += 1) {
      const ri = side === 'insert' ? i : i + skip;
      const sj = side === 'insert' ? j + skip : j;
      const len = Math.min(confirmWindow, ref.length - ri, sus.length - sj);
      if (len < Math.min(6, confirmWindow)) break;

      const c = correlate(win(ref, ri, len), win(sus, sj, len));
      // 取**最小**的达标偏移，而不是相关性最高的：多个偏移同时达标时，
      // 最小偏移是假设最少的解释。信号若含周期成分（视频里就是每个 GOP
      // 一次的 I 帧尖峰），整数倍周期处会出现伪完美对齐，取最大相关性
      // 反而会选中那个伪解。compareWithReference 因此还会把分箱粒度
      // 放大到不小于 GOP，从源头削掉这个周期成分。
      if (c >= confirmThreshold) return { skip, corr: c };
    }
    return null;
  };

  /** 把连续的同类操作合并，避免产出上千条 1 秒的碎片。 */
  const push = (type, refFrom, refTo, susFrom, susTo) => {
    const last = ops[ops.length - 1];
    if (last && last.type === type && last.refTo === refFrom && last.susTo === susFrom) {
      last.refTo = refTo;
      last.susTo = susTo;
      return;
    }
    ops.push({ type, refFrom, refTo, susFrom, susTo });
  };

  while (i < ref.length && j < sus.length) {
    // 尾部不足一个窗口时，按剩余长度比对收尾。
    const len = Math.min(W, ref.length - i, sus.length - j);
    if (len < 3) {
      push('match', i, ref.length, j, sus.length);
      i = ref.length;
      j = sus.length;
      break;
    }

    if (correlate(win(ref, i, len), win(sus, j, len)) >= threshold) {
      push('match', i, i + 1, j, j + 1);
      i += 1;
      j += 1;
      continue;
    }

    // 失配：先试"嫌疑副本多了一段"（插入），再试"少了一段"（删除）。
    // 超过重同步次数上限就不再尝试——继续找下去只会拼出越来越离谱的伪对齐。
    const ins = resyncs < maxResyncs ? findResync('insert') : null;
    const del = resyncs < maxResyncs ? findResync('delete') : null;
    const pick = !ins ? del : !del ? ins : (ins.corr >= del.corr ? ins : del);

    if (pick === ins && ins) {
      push('insert', i, i, j, j + ins.skip);
      j += ins.skip;
      resyncs += 1;
      continue;
    }
    if (pick === del && del) {
      push('delete', i, i + del.skip, j, j);
      i += del.skip;
      resyncs += 1;
      continue;
    }

    // 两边都对不上：可能是内容本身不同，也可能只是窗口正跨在拼接边界上。
    // 各自前进一格，等窗口完全越过边界后自然会找到正确偏移。
    push('mismatch', i, i + 1, j, j + 1);
    i += 1;
    j += 1;
  }

  // 收尾：任一侧还有剩余
  if (j < sus.length) push('insert', i, i, j, sus.length);
  if (i < ref.length) push('delete', i, ref.length, j, j);

  const sum = (type, side) => ops
    .filter((o) => o.type === type)
    .reduce((a, o) => a + (side === 'ref' ? o.refTo - o.refFrom : o.susTo - o.susFrom), 0);

  return {
    ops,
    matched: sum('match', 'sus'),
    inserted: sum('insert', 'sus'),
    deleted: sum('delete', 'ref'),
    mismatched: sum('mismatch', 'sus'),
  };
}

/** 从容器里挑出主视频轨。 */
export function pickVideoTrack(container) {
  return (container.tracks || []).find((t) => t.handlerType === 'vide') || null;
}

/**
 * 嫌疑副本 vs 参考母版。
 *
 * @param {object} suspect   parseContainer 输出
 * @param {object} reference parseContainer 输出
 * @param {{binSec?:number, window?:number, threshold?:number, maxSkip?:number}} [opts]
 */
export function compareWithReference(suspect, reference, opts = {}) {
  const sv = pickVideoTrack(suspect);
  const rv = pickVideoTrack(reference);

  if (!sv || !rv) {
    return { ok: false, reason: '嫌疑副本或参考母版缺少视频轨，无法比对' };
  }

  // 分箱粒度默认不小于母版的 GOP：I 帧比 P 帧大好几倍，若分箱比 GOP 还细，
  // 剖面里就会混进一个"每个 GOP 一次"的强周期成分，让对齐算法在整数倍
  // GOP 处产生伪匹配。分箱覆盖至少一个完整 GOP 后，这个尖峰被均摊掉，
  // 剩下的才是真正由画面内容驱动的码率信号。
  const refKf = keyframeProfile(rv);
  const binSec = opts.binSec ?? Math.max(1, Math.ceil(refKf.median || 1));

  const sProfile = bitrateProfile(sv, { binSec });
  const rProfile = bitrateProfile(rv, { binSec });

  const align = alignProfiles(
    normalizeProfile(rProfile.bins.map((b) => b.kbps)),
    normalizeProfile(sProfile.bins.map((b) => b.kbps)),
    opts,
  );

  // 同一性：参考时长里有多大比例在嫌疑副本里被匹配到
  const refSec = rProfile.durationSec;
  const susSec = sProfile.durationSec;
  const coverage = refSec > 0 ? Math.min(1, (align.matched * binSec) / refSec) : 0;

  const inserts = align.ops
    .filter((o) => o.type === 'insert' && o.susTo - o.susFrom >= 2)
    .map((o) => ({
      type: 'inserted-content',
      startSec: o.susFrom * binSec,
      endSec: o.susTo * binSec,
      durationSec: (o.susTo - o.susFrom) * binSec,
      level: 'high',
      evidence: [
        `参考母版在此处是连续的，嫌疑副本却多出 ${(o.susTo - o.susFrom) * binSec} 秒内容；`
        + `跳过这段之后两者的码率曲线重新对齐——这是插入内容的典型特征`,
      ],
    }));

  const deletes = align.ops
    .filter((o) => o.type === 'delete' && o.refTo - o.refFrom >= 2)
    .map((o) => ({
      type: 'removed-content',
      refStartSec: o.refFrom * binSec,
      refEndSec: o.refTo * binSec,
      durationSec: (o.refTo - o.refFrom) * binSec,
      level: 'medium',
      evidence: [`参考母版第 ${o.refFrom * binSec}–${o.refTo * binSec} 秒的内容在嫌疑副本中缺失`],
    }));

  const structural = [];
  if (Math.abs(susSec - refSec) > 2) {
    structural.push({
      key: 'duration',
      label: '时长差异',
      value: `嫌疑副本 ${susSec.toFixed(1)}s · 参考母版 ${refSec.toFixed(1)}s（差 ${(susSec - refSec).toFixed(1)}s）`,
      suspicious: true,
    });
  }
  if (sv.width !== rv.width || sv.height !== rv.height) {
    structural.push({
      key: 'resolution',
      label: '分辨率差异',
      value: `嫌疑副本 ${sv.width}×${sv.height} · 参考母版 ${rv.width}×${rv.height}`,
      suspicious: true,
      note: '分辨率不同说明经过重新编码',
    });
  }
  const sCodecs = sv.codecs.join(',');
  const rCodecs = rv.codecs.join(',');
  if (sCodecs !== rCodecs) {
    structural.push({
      key: 'codec',
      label: '编码格式差异',
      value: `嫌疑副本 ${sCodecs || '未知'} · 参考母版 ${rCodecs || '未知'}`,
      suspicious: true,
    });
  }

  return {
    ok: true,
    identity: {
      coverage: Number(coverage.toFixed(3)),
      matchedSec: align.matched * binSec,
      verdict: coverage >= 0.85 ? 'same-work'
        : coverage >= 0.5 ? 'partial-match'
          : 'not-matched',
    },
    durations: { suspectSec: susSec, referenceSec: refSec, deltaSec: Number((susSec - refSec).toFixed(2)) },
    align: { inserted: align.inserted * binSec, deleted: align.deleted * binSec, mismatched: align.mismatched * binSec },
    findings: [...inserts, ...deletes].sort((a, b) => (a.startSec ?? a.refStartSec) - (b.startSec ?? b.refStartSec)),
    structural,
  };
}
