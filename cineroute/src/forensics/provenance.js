/**
 * 编码溯源：从容器元数据判断这个文件是不是"下载后重新压制再上传"的副本。
 *
 * 这一层不看画面，只看谁写了这个文件。压制工具会在容器里留下明确签名：
 *  - x264 / x265 把**完整编码参数串**写进 `©too` 标签，包括 crf、keyint、ref、
 *    bitrate 等；母版与盗录压制版在这串上几乎不可能相同。
 *  - 各家 muxer 在 `hdlr` 的 name 字段留下自己的名字（Lavf=ffmpeg、
 *    L-SMASH、Bento4、HandBrake、Apple Core Media…）。
 *  - ftyp 品牌列表反映封装目标（网络分发 / 苹果生态 / 通用）。
 *  - moov 相对 mdat 的位置说明有没有做过 faststart —— 为网络分发重新封装过的
 *    文件几乎都会把 moov 前移，而摄制/母版流程通常不会。
 *
 * 另有一个交叉校验点很有价值：x264 参数串里声明的 keyint，可以拿去和
 * 样本表里**实测**的关键帧间隔比对。声明 250 而实测忽长忽短，说明成片
 * 经历过拼接——因为拼接会打乱原本规整的 GOP 节奏。
 */

/** 已知的编码器 / 封装器签名。 */
const SIGNATURES = [
  { re: /x264[\s-]+core\s+(\d+)/i, tool: 'x264', kind: 'encoder', note: 'x264 命令行/库压制' },
  { re: /mkvmerge\s*v?([\d.]+)?/i, tool: 'mkvmerge', kind: 'muxer', note: 'MKVToolNix 封装，常见于重新封装的发布版' },
  { re: /libmakemkv|MakeMKV/i, tool: 'MakeMKV', kind: 'transcoder', note: '光盘抓取工具——来源是实体碟或蓝光镜像' },
  { re: /libmatroska|libebml/i, tool: 'libmatroska', kind: 'muxer', note: 'Matroska 官方库封装' },
  { re: /x265[\s-]+(?:core\s+)?(\d+)/i, tool: 'x265', kind: 'encoder', note: 'x265（HEVC）压制' },
  { re: /HandBrake\s*([\d.]+)?/i, tool: 'HandBrake', kind: 'transcoder', note: '桌面转码工具，常见于二次压制' },
  { re: /Lavf([\d.]+)/i, tool: 'FFmpeg (libavformat)', kind: 'muxer', note: 'ffmpeg 封装' },
  { re: /libavformat/i, tool: 'FFmpeg (libavformat)', kind: 'muxer', note: 'ffmpeg 封装' },
  { re: /L-SMASH/i, tool: 'L-SMASH', kind: 'muxer', note: '常与 x264 配套用于重新封装' },
  { re: /Bento4/i, tool: 'Bento4', kind: 'muxer', note: '流媒体切片/封装工具链' },
  { re: /GPAC|MP4Box/i, tool: 'GPAC / MP4Box', kind: 'muxer', note: '流媒体封装工具' },
  { re: /Core Media|Apple|QuickTime/i, tool: 'Apple Core Media', kind: 'muxer', note: '苹果生态录制/导出' },
  { re: /Google|Android/i, tool: 'Google / Android', kind: 'muxer', note: '安卓设备录制' },
  { re: /Adobe|Premiere|Media Encoder/i, tool: 'Adobe', kind: 'editor', note: '剪辑软件导出——存在后期编辑' },
  { re: /Vegas|Final Cut|DaVinci|Resolve/i, tool: '剪辑软件', kind: 'editor', note: '剪辑软件导出——存在后期编辑' },
];

/** 从 x264/x265 的参数串里抽取关键设置。 */
export function parseEncoderOptions(text) {
  if (!text) return {};
  const opts = {};
  const optionsPart = text.split(/options\s*:/i)[1];
  if (!optionsPart) return opts;
  for (const kv of optionsPart.trim().split(/\s+/)) {
    const [k, v] = kv.split('=');
    if (k && v !== undefined) opts[k] = v;
  }
  return opts;
}

/**
 * 汇总所有可用的溯源线索。
 *
 * @param {object} container parseContainer 的输出
 * @param {{observedGopSec?: number|null, videoTimescale?: number|null, fps?: number|null}} [ctx]
 */
export function analyzeProvenance(container, ctx = {}) {
  const signals = [];
  const tools = new Map();

  const addTool = (hit, source, raw) => {
    const key = `${hit.tool}::${source}`;
    if (!tools.has(key)) tools.set(key, { ...hit, source, raw });
  };

  const scan = (text, source) => {
    if (!text) return;
    for (const sig of SIGNATURES) {
      const m = text.match(sig.re);
      if (m) addTool({ tool: sig.tool, kind: sig.kind, note: sig.note, version: m[1] || null }, source, text);
    }
  };

  // 1) 标签。MP4 看 ©too，MKV 看 WritingApp / MuxingApp——都是压制/封装工具写的自述。
  const encoderTag = container.tags?.['©too']
    || container.tags?.encoder
    || container.tags?.WritingApp
    || container.tags?.MuxingApp
    || null;
  scan(encoderTag, '编码器标签');
  for (const [k, v] of Object.entries(container.tags || {})) {
    // 已经当作编码器标签扫过的那一条不要再扫一遍，否则同一个工具会报两次。
    if (v !== encoderTag) scan(v, `标签 ${k}`);
  }

  // 2) hdlr handler name
  for (const t of container.tracks || []) {
    if (t.name) scan(t.name, `${t.handlerType} 轨 handler name`);
  }

  // 3) ftyp 品牌
  if (container.ftyp) {
    signals.push({
      key: 'ftyp',
      label: '封装品牌',
      value: `${container.ftyp.majorBrand} [${container.ftyp.compatibleBrands.join(', ')}]`,
      note: container.ftyp.compatibleBrands.includes('isom')
        ? '通用 ISO 品牌，多见于 ffmpeg / 通用封装工具'
        : '非通用品牌，可能来自特定设备或平台',
    });
  }

  // 4) moov / mdat 顺序 —— faststart 是"为网络分发重新封装过"的强提示
  const order = (container.topLevel || []).map((b) => b.type);
  const moovIdx = order.indexOf('moov');
  const mdatIdx = order.indexOf('mdat');
  if (moovIdx >= 0 && mdatIdx >= 0) {
    const faststart = moovIdx < mdatIdx;
    signals.push({
      key: 'faststart',
      label: 'moov 位置',
      value: faststart ? 'moov 在 mdat 之前（faststart）' : 'moov 在 mdat 之后',
      note: faststart
        ? '已做 faststart 处理，说明这个文件是为网页/渐进式播放重新封装过的'
        : '未做 faststart，更接近录制或导出后未再处理的形态',
      suspicious: faststart,
    });
  }

  // 5) 编辑列表 —— 存在非平凡 elst 说明有过裁剪或时间轴位移
  for (const t of container.tracks || []) {
    const nontrivial = (t.editList || []).filter((e) => e.mediaTime > 0);
    if (nontrivial.length) {
      signals.push({
        key: 'elst',
        label: `${t.handlerType} 轨编辑列表`,
        value: `${t.editList.length} 条，其中 ${nontrivial.length} 条起始偏移非零`,
        note: '存在编辑列表，说明轨道被裁剪或做过时间轴位移',
        suspicious: true,
      });
    }
  }

  // 6) 轨道构成 —— 多出来的轨道可能是后期加上的字幕/水印/数据轨
  const byType = {};
  for (const t of container.tracks || []) {
    byType[t.handlerType] = (byType[t.handlerType] || 0) + 1;
  }
  signals.push({
    key: 'tracks',
    label: '轨道构成',
    value: Object.entries(byType).map(([k, v]) => `${k}×${v}`).join(' · ') || '无',
    note: (byType.vide || 0) > 1
      ? '存在多条视频轨，需确认是否有后期叠加的画中画/水印轨'
      : '轨道构成正常',
    suspicious: (byType.vide || 0) > 1,
  });

  // 7) 声明 keyint vs 实测 GOP 的交叉校验
  const encOpts = parseEncoderOptions(encoderTag);
  if (encOpts.keyint && ctx.observedGopSec && ctx.fps) {
    const declaredSec = Number(encOpts.keyint) / ctx.fps;
    const ratio = ctx.observedGopSec / declaredSec;
    const mismatch = ratio < 0.6 || ratio > 1.6;
    signals.push({
      key: 'keyint-crosscheck',
      label: 'keyint 交叉校验',
      value: `声明 keyint=${encOpts.keyint}（约 ${declaredSec.toFixed(1)}s）· 实测中位 GOP ${ctx.observedGopSec.toFixed(1)}s`,
      note: mismatch
        ? '声明值与实测值不一致：成片很可能在编码之后又经过拼接或二次封装'
        : '声明值与实测值吻合，未见拼接迹象',
      suspicious: mismatch,
    });
  }

  return {
    encoderTag,
    encoderOptions: encOpts,
    tools: [...tools.values()],
    signals,
    // 出现剪辑软件签名，或同时出现多个编码器签名，都指向"经过后期处理"
    reprocessed: [...tools.values()].some((t) => t.kind === 'editor' || t.kind === 'transcoder')
      || [...tools.values()].filter((t) => t.kind === 'encoder').length > 1,
  };
}
