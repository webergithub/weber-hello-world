/**
 * Matroska / WebM（.mkv / .webm）解析。
 *
 * 为什么要支持：盗版发布里 MKV 占比很高，而它和 MP4 的结构完全不同——
 * MP4 把样本表集中放在 moov 里，MKV 则把每一帧的时间戳和大小分散在
 * 整个文件的 Cluster 里，没有集中索引。
 *
 * 但我们要的东西是一样的：每一帧的时间、大小、是不是关键帧。
 * MKV 的 SimpleBlock 头里恰好全都有（相对时间戳 + 关键帧标志），
 * 帧数据本身的长度就是这一帧的字节数。所以照样不用解码。
 *
 * 有一点必须说清楚：**MKV 要整文件扫描**，做不到 MP4 那样只读几 MB。
 * 因为 MKV 没有集中索引——每一帧的大小和时间戳散落在所有 Cluster 里，
 * Cues 只索引关键帧，不含逐帧信息。所以想要完整的码率剖面就得走一遍全文件。
 * 好在取证流程本来就要算整文件的 sha256，这一遍扫描并不额外增加 I/O 量级。
 *
 * 解析结果填成和 MP4 完全一样的 track 结构，所以码率剖面、GOP 分析、
 * 异常检测、母版比对全都不用改。
 */

import fs from 'node:fs/promises';

/* EBML 元素 ID（含长度标记位，直接按字节比对） */
const ID = {
  EBML: 0x1a45dfa3,
  Segment: 0x18538067,
  Info: 0x1549a966,
  TimestampScale: 0x2ad7b1,
  Duration: 0x4489,
  MuxingApp: 0x4d80,
  WritingApp: 0x5741,
  Title: 0x7ba9,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackType: 0x83,
  CodecID: 0x86,
  Name: 0x536e,
  DefaultDuration: 0x23e383,
  Video: 0xe0,
  PixelWidth: 0xb0,
  PixelHeight: 0xba,
  Cluster: 0x1f43b675,
  Timestamp: 0xe7,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
  ReferenceBlock: 0xfb,
};

/** 规范默认的时间刻度：1,000,000 纳秒（1 毫秒）。 */
const DEFAULT_TIMESTAMP_SCALE = 1_000_000;

/** 需要往里钻的容器元素，其余一律跳过。 */
const MASTER = new Set([
  ID.Segment, ID.Info, ID.Tracks, ID.TrackEntry, ID.Video, ID.Cluster, ID.BlockGroup,
]);

/** TrackType → 与 MP4 对齐的 handlerType，好让下游代码不用区分容器。 */
const TRACK_TYPE = { 1: 'vide', 2: 'soun', 3: 'cplx', 16: 'logo', 17: 'subt', 18: 'butt', 32: 'ctrl' };

/**
 * 带缓冲的顺序读取器。
 * 跳过大块帧数据时只移动偏移，不产生实际读取。
 */
class BufferedReader {
  constructor(fh, fileSize, windowSize = 4 << 20) {
    this.fh = fh;
    this.fileSize = fileSize;
    this.windowSize = windowSize;
    this.buf = Buffer.alloc(windowSize);
    this.bufStart = 0;
    this.bufLen = 0;
    this.bytesRead = 0;
  }

  /** 保证 [pos, pos+len) 在缓冲区内，返回它在缓冲区里的下标。 */
  async ensure(pos, len) {
    if (pos >= this.bufStart && pos + len <= this.bufStart + this.bufLen) {
      return pos - this.bufStart;
    }
    if (len > this.windowSize) throw new Error(`单次读取超出窗口：${len}`);
    const want = Math.min(this.windowSize, this.fileSize - pos);
    if (want < len) throw new Error('文件提前结束');
    const { bytesRead } = await this.fh.read(this.buf, 0, want, pos);
    this.bufStart = pos;
    this.bufLen = bytesRead;
    this.bytesRead += bytesRead;
    if (bytesRead < len) throw new Error('文件提前结束');
    return 0;
  }
}

/**
 * 读 EBML 变长整数。
 * 首字节的前导零个数决定总长度：1xxxxxxx 是 1 字节，01xxxxxx 是 2 字节，以此类推。
 *
 * @param {Buffer} buf @param {number} i
 * @param {boolean} stripMarker true 用于长度字段（去掉标记位），false 用于元素 ID（保留）
 */
function readVint(buf, i, stripMarker) {
  const first = buf[i];
  if (first === 0) return null;                 // 非法，最长 8 字节
  let length = 1;
  let mask = 0x80;
  while (!(first & mask)) { mask >>= 1; length += 1; }

  let value = stripMarker ? (first & (mask - 1)) : first;
  let allOnes = stripMarker ? (first & (mask - 1)) === mask - 1 : false;
  for (let k = 1; k < length; k += 1) {
    value = value * 256 + buf[i + k];
    if (buf[i + k] !== 0xff) allOnes = false;
  }
  return { value, length, unknown: stripMarker && allOnes };
}

/** 大端无符号整数（EBML 的整数长度可变）。 */
function readUInt(buf, i, len) {
  let v = 0;
  for (let k = 0; k < len; k += 1) v = v * 256 + buf[i + k];
  return v;
}

/** EBML 浮点（4 或 8 字节）。 */
function readFloat(buf, i, len) {
  if (len === 4) return buf.readFloatBE(i);
  if (len === 8) return buf.readDoubleBE(i);
  return null;
}

function readString(buf, i, len) {
  return buf.toString('utf8', i, i + len).replace(/\0+$/, '').trim();
}

/**
 * 扫描整个文件，抽出取证需要的结构。
 *
 * @param {string} filePath
 * @param {{maxBlocks?: number}} [opts]
 */
export async function parseMatroska(filePath, opts = {}) {
  const maxBlocks = opts.maxBlocks ?? 3_000_000;
  const fh = await fs.open(filePath, 'r');

  try {
    const { size: fileSize } = await fh.stat();
    const r = new BufferedReader(fh, fileSize);

    // 校验 EBML 魔数
    const head = Buffer.alloc(4);
    await fh.read(head, 0, 4, 0);
    if (head.readUInt32BE(0) !== ID.EBML) {
      return { ok: false, reason: '不是 Matroska/WebM 文件（缺少 EBML 魔数）' };
    }

    const info = { timestampScale: 1_000_000, duration: null, muxingApp: null, writingApp: null, title: null };
    /** @type {Map<number, any>} 按 TrackNumber 存 */
    const tracks = new Map();
    /** @type {Map<number, Array<{t:number,size:number,key:boolean}>>} */
    const blocks = new Map();

    let clusterTs = 0;
    let clusterCount = 0;
    let blockCount = 0;
    let truncated = false;
    /**
     * 扫描中途放弃的地方。
     *
     * MKV 没有集中索引，扫到坏字节就停是合理的做法——但**停了必须说出来**。
     * 停了还报 ok、还给出一份残缺的帧表，下游据此算出的码率、帧率、时长
     * 就是错的，而且看不出来。这跟 MP4 那边样本表被截短是同一类问题。
     * @type {Array<{at: number, expectedEnd: number, why: string}>}
     */
    const abandoned = [];
    const giveUp = (pos, expectedEnd, why) => {
      if (pos < expectedEnd) abandoned.push({ at: pos, expectedEnd, why });
    };

    /** 当前正在解析的 TrackEntry / BlockGroup 上下文 */
    let curTrack = null;
    let curGroup = null;

    /**
     * 递归遍历一段区间里的元素。
     * @param {number} start @param {number} end @param {number} depth
     */
    async function walk(start, end, depth) {
      let pos = start;
      if (depth > 8) return;

      while (pos < end && !truncated) {
        // 元素头最长 8+8=16 字节
        const need = Math.min(16, fileSize - pos);
        if (need < 2) { giveUp(pos, end, '文件在这里就结束了，连一个元素头都读不全'); return; }
        let base;
        try {
          base = await r.ensure(pos, need);
        } catch { giveUp(pos, end, '读文件失败'); return; }

        const idv = readVint(r.buf, base, false);
        if (!idv) { giveUp(pos, end, '元素 ID 不是合法的变长整数'); return; }
        const sizev = readVint(r.buf, base + idv.length, true);
        if (!sizev) { giveUp(pos, end, '长度字段不是合法的变长整数'); return; }

        const headerLen = idv.length + sizev.length;
        const contentStart = pos + headerLen;
        // 未知长度（流式封装常见）：一直延伸到父元素结尾
        const declaredEnd = contentStart + sizev.value;
        const contentEnd = sizev.unknown ? end : Math.min(end, declaredEnd);
        const id = idv.value;

        // 元素声称的长度被父元素/文件末尾截断了 —— 这才是"文件不完整"最常见的
        // 表现形式，而不是解析中途放弃：下载断在半路时，外层元素的长度字段
        // 仍然写着完整值，扫描却会在 pos == end 处正常收尾，什么都不报。
        // 未知长度的元素本来就延伸到父元素结尾，不算数。
        if (!sizev.unknown && declaredEnd > end) {
          giveUp(pos, declaredEnd, `元素 0x${id.toString(16)} 声称到第 ${declaredEnd} 字节，`
            + `但可读范围只到第 ${end} 字节，文件像是被截断了`);
        }

        if (MASTER.has(id)) {
          if (id === ID.Cluster) { clusterCount += 1; clusterTs = 0; }
          if (id === ID.TrackEntry) curTrack = { trackNumber: null, trackType: null, codecId: null, name: null, width: 0, height: 0, defaultDuration: null };
          if (id === ID.BlockGroup) curGroup = { hasReference: false, block: null };

          await walk(contentStart, contentEnd, depth + 1);

          if (id === ID.TrackEntry && curTrack?.trackNumber != null) {
            tracks.set(curTrack.trackNumber, curTrack);
            curTrack = null;
          }
          if (id === ID.BlockGroup) {
            // BlockGroup 里没有 ReferenceBlock 才是关键帧
            if (curGroup?.block) {
              const b = curGroup.block;
              pushBlock(b.track, b.t, b.size, !curGroup.hasReference);
            }
            curGroup = null;
          }
          pos = contentEnd;
          continue;
        }

        const len = contentEnd - contentStart;

        // 叶子元素：只在需要时读内容
        if (id === ID.SimpleBlock || id === ID.Block) {
          // 只读块头：轨号(vint) + 时间戳(int16) + 标志(1)
          try {
            const hb = await r.ensure(contentStart, Math.min(12, len));
            const tn = readVint(r.buf, hb, true);
            if (tn) {
              const tcOff = hb + tn.length;
              const timecode = r.buf.readInt16BE(tcOff);
              const flags = r.buf[tcOff + 2];
              const payload = len - (tn.length + 3);
              const key = id === ID.SimpleBlock ? Boolean(flags & 0x80) : false;
              if (id === ID.SimpleBlock) {
                pushBlock(tn.value, clusterTs + timecode, payload, key);
              } else {
                // Block 的关键帧判定要等 BlockGroup 收尾时看有没有 ReferenceBlock
                if (curGroup) curGroup.block = { track: tn.value, t: clusterTs + timecode, size: payload };
              }
            }
          } catch { /* 块头读失败就跳过这一块 */ }
          pos = contentEnd;
          continue;
        }

        if (len > 0 && len <= 4096) {
          let cb;
          try { cb = await r.ensure(contentStart, len); } catch { pos = contentEnd; continue; }

          switch (id) {
            case ID.TimestampScale: info.timestampScale = readUInt(r.buf, cb, len); break;
            case ID.Duration: info.duration = readFloat(r.buf, cb, len); break;
            case ID.MuxingApp: info.muxingApp = readString(r.buf, cb, len); break;
            case ID.WritingApp: info.writingApp = readString(r.buf, cb, len); break;
            case ID.Title: info.title = readString(r.buf, cb, len); break;
            case ID.Timestamp: clusterTs = readUInt(r.buf, cb, len); break;
            case ID.TrackNumber: if (curTrack) curTrack.trackNumber = readUInt(r.buf, cb, len); break;
            case ID.TrackType: if (curTrack) curTrack.trackType = readUInt(r.buf, cb, len); break;
            case ID.CodecID: if (curTrack) curTrack.codecId = readString(r.buf, cb, len); break;
            case ID.Name: if (curTrack) curTrack.name = readString(r.buf, cb, len); break;
            case ID.DefaultDuration: if (curTrack) curTrack.defaultDuration = readUInt(r.buf, cb, len); break;
            case ID.PixelWidth: if (curTrack) curTrack.width = readUInt(r.buf, cb, len); break;
            case ID.PixelHeight: if (curTrack) curTrack.height = readUInt(r.buf, cb, len); break;
            case ID.ReferenceBlock: if (curGroup) curGroup.hasReference = true; break;
            default: break;
          }
        }

        pos = contentEnd;
      }
    }

    function pushBlock(trackNumber, t, size, key) {
      blockCount += 1;
      if (blockCount > maxBlocks) { truncated = true; return; }
      if (!blocks.has(trackNumber)) blocks.set(trackNumber, []);
      blocks.get(trackNumber).push({ t, size, key });
    }

    await walk(0, fileSize, 0);

    // 组装成与 MP4 一致的 track 结构
    // MKV 的时间戳单位是 TimestampScale 纳秒，换算成"每秒多少刻度"。
    //
    // 这个值是**除数**，文件里写个 0 就直接把 timescale 变成 Infinity，
    // 再一路污染帧率（timescale / 帧间隔）、时长（duration / timescale）——
    // 报告上会出现一堆 Infinity 和 0，而且看不出根因在哪。
    // 写个 8 字节的天文数字则相反，timescale 被压成 0，同样是除零。
    // 规范的默认值是 1,000,000 纳秒（1 毫秒），非法就退回它并留一条记录。
    const warnings = [];
    const rawScale = info.timestampScale;
    let scale = rawScale;
    if (!Number.isFinite(scale) || scale <= 0 || 1e9 / scale < 1) {
      scale = DEFAULT_TIMESTAMP_SCALE;
      warnings.push(
        `TimestampScale 是 ${rawScale}，不是个能用的时间刻度，`
        + `已退回规范默认值 ${DEFAULT_TIMESTAMP_SCALE} 纳秒；基于时间的统计只能作参考`,
      );
    }
    const timescale = Math.round(1e9 / scale);
    const outTracks = [];

    for (const [trackNumber, meta] of tracks) {
      const list = (blocks.get(trackNumber) || []).sort((a, b) => a.t - b.t);
      const sizes = [];
      const deltas = [];
      const syncSamples = new Set();

      for (let i = 0; i < list.length; i += 1) {
        sizes.push(list[i].size);
        // MKV 给的是时间戳不是时长，相邻差值即时长；最后一帧用默认帧时长兜底
        const next = list[i + 1];
        const d = next
          ? Math.max(0, next.t - list[i].t)
          : (meta.defaultDuration ? meta.defaultDuration / info.timestampScale : 0);
        deltas.push(Math.round(d));
        if (list[i].key) syncSamples.add(i + 1);
      }

      const totalTicks = deltas.reduce((a, b) => a + b, 0);
      outTracks.push({
        trackId: trackNumber,
        handlerType: TRACK_TYPE[meta.trackType] || 'unkn',
        name: meta.name || '',
        codecs: meta.codecId ? [meta.codecId] : [],
        width: meta.width,
        height: meta.height,
        media: { timescale, duration: totalTicks },
        editList: [],
        sizes,
        deltas,
        syncSamples,
        sampleCount: sizes.length,
        // 音轨每一帧都是关键帧，没有 GOP 概念
        allSync: sizes.length > 0 && syncSamples.size === sizes.length,
      });
    }

    const durationSec = Number.isFinite(info.duration) && info.duration > 0
      ? (info.duration * scale) / 1e9
      : null;

    if (abandoned.length > 0) {
      const first = abandoned[0];
      warnings.push(
        `${first.why}（第 ${first.at} 字节处）`
        + `${abandoned.length > 1 ? `，另有 ${abandoned.length - 1} 处同样情况` : ''}；`
        + '这之后的帧没有进入统计，码率与帧率只能作参考',
      );
    }
    if (truncated) {
      warnings.push(`块数超过上限 ${maxBlocks}，其余未统计`);
    }

    return {
      ok: true,
      format: 'matroska',
      // 解析没走完整个文件。下游据此知道"这份帧表是残缺的"。
      incomplete: abandoned.length > 0 || truncated,
      warnings,
      ftyp: null,
      movie: {
        timescale,
        duration: durationSec ? Math.round(durationSec * timescale) : 0,
      },
      tracks: outTracks,
      // 塞进 tags 让编码溯源那一层不用改就能识别
      tags: {
        ...(info.muxingApp ? { MuxingApp: info.muxingApp } : {}),
        ...(info.writingApp ? { WritingApp: info.writingApp } : {}),
        ...(info.title ? { Title: info.title } : {}),
      },
      matroska: {
        timestampScale: info.timestampScale,
        clusterCount,
        blockCount,
        truncated,
      },
      hasFragments: false,
      fileSize,
      bytesRead: r.bytesRead,
      topLevel: [],
    };
  } finally {
    await fh.close();
  }
}

/** 快速判断一个文件是不是 Matroska。 */
export async function isMatroska(filePath) {
  const fh = await fs.open(filePath, 'r');
  try {
    const b = Buffer.alloc(4);
    const { bytesRead } = await fh.read(b, 0, 4, 0);
    return bytesRead === 4 && b.readUInt32BE(0) === ID.EBML;
  } catch {
    return false;
  } finally {
    await fh.close();
  }
}

export { ID as EBML_ID };
