/**
 * 播放嗅探：真的把地址在浏览器里打开、拖进度条、截画面。
 *
 * 前面几步（HEAD / Range 探测）只能回答"地址活着吗、支不支持续传"，
 * 回答不了"**这东西真的能放出画面吗**"。能放不能放，只有真的解码一遍才知道：
 * 容器对但编码不支持、有音轨没视轨、文件截断、声称 1080p 实际是 640×480
 * 拉上去的——这些在 HTTP 头里全看不出来。
 *
 * 做法：在**同源**页面里塞一个 <video>（走 /media 代理保证同源，
 * 否则 canvas 读像素会被跨源污染直接抛错），逐个时间点 seek，
 * 每次把当帧画到 canvas 上，既截图也就地算清晰度指标。
 *
 * 八个取样点覆盖片头、片中、片尾，理论上能把整片的大部分内容抽到。
 */

/** 默认取样点（秒）。最后一个是"片尾前 5 分钟"，运行时按实际片长换算。 */
export const DEFAULT_MARKS = [
  { at: 0, label: '开头' },
  { at: 60, label: '1 分钟' },
  { at: 300, label: '5 分钟' },
  { at: 600, label: '10 分钟' },
  { at: 1800, label: '30 分钟' },
  { at: 3600, label: '60 分钟' },
  { at: 5400, label: '90 分钟' },
  { at: -300, label: '片尾前 5 分钟' },   // 负数表示"从结尾往前数"
];

/**
 * 把取样点换算成绝对秒数，并标出超出片长的那些。
 * 不静默丢弃——"这片子只有 20 分钟所以取不到 90 分钟那张"本身就是信息。
 */
export function resolveMarks(durationSec, marks = DEFAULT_MARKS) {
  return marks.map((m) => {
    const at = m.at < 0 ? (durationSec > 0 ? durationSec + m.at : null) : m.at;
    const inRange = at != null && durationSec > 0 && at >= 0 && at < durationSec;
    return { ...m, at, inRange, skipReason: inRange ? null : (durationSec > 0 ? '超出片长' : '片长未知') };
  });
}

/**
 * 页面里跑的那段脚本。
 *
 * 全部逻辑放在页面内一次跑完，而不是来回 evaluate —— 每次 CDP 往返都有开销，
 * 而 seek 完成是异步事件，来回切换容易错过。
 */
function probeScript({ src, marks, shotWidth, timeoutMs }) {
  return `(async () => {
  const out = { events: {}, frames: [], errors: [] };
  const t0 = performance.now();
  const ms = () => Math.round(performance.now() - t0);

  const v = document.createElement('video');
  v.preload = 'auto';
  v.muted = true;                 // 不静音的话自动播放会被浏览器策略拦掉
  v.playsInline = true;
  v.crossOrigin = 'anonymous';
  v.style.cssText = 'position:fixed;left:-9999px;width:640px';
  document.body.appendChild(v);

  const once = (target, ev, ms_) => new Promise((res) => {
    const t = setTimeout(() => res(null), ms_);
    target.addEventListener(ev, () => { clearTimeout(t); res(true); }, { once: true });
  });

  // 关键时间点：拿到元数据 / 能开始播 / 缓冲够播完
  const marksP = {
    loadedmetadata: once(v, 'loadedmetadata', ${timeoutMs}).then((ok) => { if (ok) out.events.loadedmetadata = ms(); }),
    loadeddata:     once(v, 'loadeddata', ${timeoutMs}).then((ok) => { if (ok) out.events.loadeddata = ms(); }),
    canplay:        once(v, 'canplay', ${timeoutMs}).then((ok) => { if (ok) out.events.canplay = ms(); }),
    canplaythrough: once(v, 'canplaythrough', ${timeoutMs}).then((ok) => { if (ok) out.events.canplaythrough = ms(); }),
  };
  v.addEventListener('error', () => {
    const e = v.error;
    out.errors.push('MEDIA_ERR_' + (e ? e.code : '?') + (e && e.message ? ': ' + e.message : ''));
  });
  // 卡顿次数：拖进度条之外的 waiting 说明缓冲跟不上
  let stalls = 0;
  v.addEventListener('waiting', () => { stalls += 1; });

  v.src = ${JSON.stringify(src)};
  v.load();

  await marksP.loadedmetadata;
  if (out.errors.length && !out.events.loadedmetadata) {
    return { ...out, ok: false, stalls, reason: '加载元数据失败：' + out.errors.join('; ') };
  }
  if (!out.events.loadedmetadata) {
    return { ...out, ok: false, stalls, reason: '等待元数据超时（' + ${timeoutMs} + 'ms）' };
  }

  out.duration = Number.isFinite(v.duration) ? v.duration : null;
  // 解码出来的真实分辨率。注意这跟上游元数据声称的可能不一样——
  // 标着 1080p 实际解码 640×480 的文件是存在的，这里能当场戳穿。
  out.videoWidth = v.videoWidth;
  out.videoHeight = v.videoHeight;
  out.hasVideoTrack = v.videoWidth > 0 && v.videoHeight > 0;

  await Promise.race([marksP.canplay, new Promise((r) => setTimeout(r, ${timeoutMs}))]);

  // 试着真播一下，测首帧出画时间
  try {
    const p = v.play();
    if (p) await p.catch(() => {});
    out.events.playing = ms();
    await new Promise((r) => setTimeout(r, 300));
    out.advanced = v.currentTime > 0;   // 时间轴真的在走 = 真的在解码
    v.pause();
  } catch (e) { out.errors.push('play(): ' + e.message); }

  if (!out.hasVideoTrack) {
    return { ...out, ok: false, stalls, reason: '没有视频轨（只有音频或解码失败）' };
  }

  // ── 逐点 seek + 截帧 ──────────────────────────────────
  const cv = document.createElement('canvas');
  const ctx = cv.getContext('2d', { willReadFrequently: true });

  for (const m of ${JSON.stringify(marks)}) {
    if (!m.inRange) { out.frames.push({ ...m, captured: false, reason: m.skipReason }); continue; }
    const seekT0 = performance.now();
    let seeked = false;
    try {
      const done = once(v, 'seeked', ${timeoutMs});
      v.currentTime = m.at;
      seeked = Boolean(await done);
    } catch (e) { out.errors.push('seek ' + m.at + ': ' + e.message); }

    if (!seeked) { out.frames.push({ ...m, captured: false, reason: 'seek 超时' }); continue; }

    // 落点核对：请求 30 分钟却停在 20 秒，说明这个副本根本拖不过去
    // （缺时长/索引、文件截断、或服务端不支持 Range）。这时截到的画面
    // 不代表那个时间点，必须标出来，不能拿它去算清晰度。
    const landed = v.currentTime;
    const drift = Math.abs(landed - m.at);
    if (drift > 2) {
      out.frames.push({
        ...m, captured: false, atActual: landed, drift: Math.round(drift * 10) / 10,
        reason: 'seek 未落到请求位置（停在 ' + landed.toFixed(1) + 's）——该副本可能缺时长索引、被截断或不支持拖动',
      });
      continue;
    }

    const sw = ${shotWidth};
    const sh = Math.max(1, Math.round(sw * v.videoHeight / v.videoWidth));
    cv.width = sw; cv.height = sh;
    ctx.drawImage(v, 0, 0, sw, sh);

    let data;
    try {
      data = ctx.getImageData(0, 0, sw, sh);
    } catch (e) {
      // 跨源污染会走到这里。走 /media 同源代理就不会。
      out.frames.push({ ...m, captured: false, reason: 'canvas 被跨源污染，无法读像素：' + e.message });
      continue;
    }

    // 灰度化 + 亮度统计
    const n = sw * sh;
    const gray = new Float64Array(n);
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const p = i * 4;
      const g = 0.299 * data.data[p] + 0.587 * data.data[p + 1] + 0.114 * data.data[p + 2];
      gray[i] = g; sum += g;
    }
    const mean = sum / n;
    let varSum = 0;
    for (let i = 0; i < n; i++) { const d = gray[i] - mean; varSum += d * d; }
    const contrast = Math.sqrt(varSum / n);

    // 拉普拉斯方差 —— 判断模糊的标准做法：图越清晰，二阶导的方差越大
    let lapSum = 0, lapSq = 0, cnt = 0;
    for (let y = 1; y < sh - 1; y++) {
      for (let x = 1; x < sw - 1; x++) {
        const i = y * sw + x;
        const l = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - sw] - gray[i + sw];
        lapSum += l; lapSq += l * l; cnt += 1;
      }
    }
    const lapMean = cnt ? lapSum / cnt : 0;
    const sharpness = cnt ? (lapSq / cnt) - lapMean * lapMean : 0;

    out.frames.push({
      ...m,
      captured: true,
      atActual: v.currentTime,
      seekMs: Math.round(performance.now() - seekT0),
      width: sw, height: sh,
      meanLuma: Math.round(mean * 10) / 10,
      contrast: Math.round(contrast * 10) / 10,
      sharpness: Math.round(sharpness * 10) / 10,
      // 全黑/全白帧：片头黑场或解码失败，单独标出来免得拉低清晰度评价
      blank: contrast < 3,
      jpeg: cv.toDataURL('image/jpeg', 0.72),
    });
  }

  v.removeAttribute('src');
  v.load();
  v.remove();
  return { ...out, ok: true, stalls, reason: null };
})()`;
}

/**
 * 对一个视频地址做完整的播放嗅探。
 *
 * @param {object} browser cdp.launch() 得到的连接
 * @param {{baseUrl: string, mediaUrl: string, durationSec?: number,
 *          marks?: object[], shotWidth?: number, timeoutMs?: number}} opts
 */
export async function probePlayback(browser, opts) {
  const {
    baseUrl, mediaUrl, durationSec = 0,
    marks = DEFAULT_MARKS, shotWidth = 480, timeoutMs = 20000,
  } = opts;

  const resolved = resolveMarks(durationSec, marks);
  const page = await browser.newPage({ width: 800, height: 600 });
  const started = Date.now();

  try {
    // 必须先落到自己的源上：/media 是同源代理，页面同源才能读 canvas 像素
    await page.goto(baseUrl, { timeoutMs: 15000 });
    const src = `/media?url=${encodeURIComponent(mediaUrl)}`;
    const r = await page.evaluate(
      probeScript({ src, marks: resolved, shotWidth, timeoutMs }),
      { timeoutMs: timeoutMs * (resolved.length + 4) },
    );

    const frames = r.frames ?? [];
    const captured = frames.filter((f) => f.captured);
    // 取样覆盖率要分两种情况说清楚：
    //   · 取样点超出片长 —— 片子短而已，不是缺陷
    //   · 取样点在范围内却没截到 —— 拖不动或解码失败，这才是缺陷
    const inRange = frames.filter((f) => f.inRange);
    const missedInRange = inRange.filter((f) => !f.captured);
    return {
      url: mediaUrl,
      ok: Boolean(r.ok),
      reason: r.reason ?? null,
      coverage: {
        total: frames.length,
        inRange: inRange.length,
        captured: captured.length,
        outOfRange: frames.length - inRange.length,
        missedInRange: missedInRange.length,
        // 范围内漏掉一半以上，说明这个副本拖不动或解码不稳
        degraded: inRange.length > 0 && missedInRange.length > inRange.length / 2,
        note: missedInRange.length > 0
          ? `${missedInRange.length} 个片内取样点没截到（拖不动或解码失败）`
          : (frames.length > inRange.length
            ? `${frames.length - inRange.length} 个取样点超出片长，属正常` : null),
      },
      totalMs: Date.now() - started,
      // 加载各阶段耗时——「点开要等多久」就看这几个数
      timings: {
        metadataMs: r.events?.loadedmetadata ?? null,
        firstDataMs: r.events?.loadeddata ?? null,
        canPlayMs: r.events?.canplay ?? null,
        canPlayThroughMs: r.events?.canplaythrough ?? null,
        playingMs: r.events?.playing ?? null,
      },
      stalls: r.stalls ?? 0,
      advanced: Boolean(r.advanced),
      decoded: {
        durationSec: r.duration ?? null,
        width: r.videoWidth ?? null,
        height: r.videoHeight ?? null,
        hasVideoTrack: Boolean(r.hasVideoTrack),
      },
      frames: r.frames ?? [],
      quality: summarizeQuality(captured, r),
      errors: r.errors ?? [],
    };
  } catch (err) {
    return {
      url: mediaUrl, ok: false, reason: String(err?.message || err),
      totalMs: Date.now() - started, timings: {}, stalls: 0, advanced: false,
      decoded: {}, frames: resolved.map((m) => ({ ...m, captured: false, reason: '嗅探未执行' })),
      quality: null, errors: [String(err?.message || err)],
    };
  } finally {
    await page.close();
  }
}

const median = (arr) => {
  const a = [...arr].sort((x, y) => x - y);
  if (a.length === 0) return 0;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

/**
 * 综合八张截图给出清晰度测量值。
 *
 * 单看一帧不作数：片头黑场、字幕卡、暗场都会让指标偏低。所以取
 * **非空白帧的中位数**——中位数不会被一两张异常帧带偏，这跟取证模块里
 * 处理码率剖面是同一个理由。
 *
 * **这里只给测量值，不给等级。** 原因：拉普拉斯方差强烈依赖画面内容——
 * 密集纹理的战争片天然比柔光文艺片高一个数量级，拿一套绝对阈值去卡
 * 不同片子必然误判。实测同一幅图加不同模糊：0px→19977、1px→1525、
 * 2px→251、4px→61，0–4px 区间区分度极高；但再糊下去就饱和了
 * （8px→56、16px→95 反而回升，因为重度模糊会引入低频波纹）。
 * 也就是说这个指标适合**同题材横向比较**，不适合当绝对标尺。
 * 等级由 gradeBatch() 在同一批候选之间给。
 */
export function summarizeQuality(frames, raw = {}) {
  const usable = frames.filter((f) => f.captured && !f.blank);
  if (usable.length === 0) return null;

  const sharp = median(usable.map((f) => f.sharpness));
  const contrast = median(usable.map((f) => f.contrast));
  const w = raw.videoWidth ?? 0;
  const h = raw.videoHeight ?? 0;

  return {
    sharpnessMedian: Math.round(sharp * 10) / 10,
    contrastMedian: Math.round(contrast * 10) / 10,
    // 按对比度归一，削弱"画面本身反差大"带来的虚高
    detailDensity: contrast > 1 ? Math.round((sharp / (contrast * contrast)) * 100) / 100 : null,
    decodedResolution: w && h ? `${w}×${h}` : null,
    decodedHeight: h || null,
    sampledFrames: usable.length,
    blankFrames: frames.filter((f) => f.captured && f.blank).length,
  };
}

/**
 * 在同一批候选之间给清晰度评级。
 *
 * 这批候选是**同一部片子的不同副本**，题材内容一致，所以横向比较是成立的——
 * 比用绝对阈值靠谱得多。
 *
 * 排序主依据是**解码出来的真实分辨率**（客观事实），细节密度只在
 * 分辨率相同时用来分高下，以及用来戳穿"标着高分辨率其实是放大的"。
 *
 * @param {object[]} probes probePlayback() 的结果数组
 */
export function gradeBatch(probes) {
  const ok = probes.filter((p) => p.ok && p.quality);
  if (ok.length === 0) return probes.map((p) => ({ ...p, grade: null }));

  const heights = ok.map((p) => p.quality.decodedHeight || 0);
  const maxH = Math.max(...heights);
  const densities = ok.map((p) => p.quality.detailDensity || 0).filter((d) => d > 0);
  const medDensity = median(densities);

  return probes.map((p) => {
    if (!p.ok || !p.quality) return { ...p, grade: null, gradeNote: p.reason || '未能播放，无法评级' };
    const h = p.quality.decodedHeight || 0;
    const d = p.quality.detailDensity || 0;

    // 分辨率占位次，细节密度做修正
    const resRatio = maxH > 0 ? h / maxH : 0;
    const dense = medDensity > 0 ? d / medDensity : 1;

    let grade, note;
    if (resRatio >= 0.99 && dense >= 0.8) {
      grade = 'A'; note = `本批最高分辨率（${p.quality.decodedResolution}），细节密度也在中位以上`;
    } else if (resRatio >= 0.99) {
      grade = 'B';
      note = `分辨率最高（${p.quality.decodedResolution}），但细节密度只有中位的 ${(dense * 100).toFixed(0)}%`
        + '——像是从低分辨率放大后重新编码的';
    } else if (resRatio >= 0.6) {
      grade = 'B'; note = `分辨率 ${p.quality.decodedResolution}，低于本批最高的 ${maxH}p`;
    } else if (resRatio > 0) {
      grade = 'C'; note = `分辨率 ${p.quality.decodedResolution}，明显低于本批最高的 ${maxH}p`;
    } else {
      grade = 'D'; note = '未取到解码分辨率';
    }
    return { ...p, grade, gradeNote: note };
  });
}

/**
 * 把上游声称的分辨率与实际解码出来的对照。
 * 对不上是有价值的发现：可能是元数据错，也可能是低分辨率放大后重新封装的。
 */
export function compareClaimedResolution(claimedHeight, decodedHeight) {
  if (!claimedHeight || !decodedHeight) return null;
  if (decodedHeight === claimedHeight) return { match: true, note: '与上游元数据一致' };
  const ratio = decodedHeight / claimedHeight;
  return {
    match: false,
    note: ratio < 0.9
      ? `上游标称 ${claimedHeight}p，实际解码只有 ${decodedHeight}p —— 元数据夸大或副本被降规`
      : `上游标称 ${claimedHeight}p，实际解码 ${decodedHeight}p —— 元数据偏低`,
  };
}
