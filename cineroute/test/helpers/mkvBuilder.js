/**
 * 合成 Matroska（.mkv）构造器（仅供测试）。
 *
 * 和 MP4 构造器有个关键差别：MKV 里每个块的元素长度**就是**帧的真实字节数，
 * 没法像 MP4 的 mdat 那样塞占位符——声明多大就得写多少字节，否则文件是坏的。
 * 所以测试用的片子要压低码率、缩短时长，把文件控制在几 MB。
 * 这不影响检测逻辑：异常检测看的是相对倍率，不是绝对码率。
 */

/* EBML 元素 ID */
const ID = {
  EBML: 0x1a45dfa3,
  DocType: 0x4282,
  Segment: 0x18538067,
  Info: 0x1549a966,
  TimestampScale: 0x2ad7b1,
  Duration: 0x4489,
  MuxingApp: 0x4d80,
  WritingApp: 0x5741,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackType: 0x83,
  CodecID: 0x86,
  DefaultDuration: 0x23e383,
  Video: 0xe0,
  PixelWidth: 0xb0,
  PixelHeight: 0xba,
  Cluster: 0x1f43b675,
  Timestamp: 0xe7,
  SimpleBlock: 0xa3,
};

/** 元素 ID 本身已含长度标记，按数值大小推出占几个字节。 */
function idBytes(id) {
  if (id <= 0xff) return Buffer.from([id]);
  if (id <= 0xffff) return Buffer.from([id >> 8, id & 0xff]);
  if (id <= 0xffffff) return Buffer.from([id >> 16, (id >> 8) & 0xff, id & 0xff]);
  return Buffer.from([id >>> 24, (id >> 16) & 0xff, (id >> 8) & 0xff, id & 0xff]);
}

/**
 * EBML 变长长度字段。选能装下该数值的最短长度，
 * 并避开"全 1"（那是"长度未知"的保留写法）。
 */
export function vintSize(value) {
  for (let len = 1; len <= 8; len += 1) {
    const max = 2 ** (7 * len) - 1;
    if (value < max) {
      const out = Buffer.alloc(len);
      let v = value;
      for (let i = len - 1; i >= 0; i -= 1) { out[i] = v & 0xff; v = Math.floor(v / 256); }
      out[0] |= 0x80 >> (len - 1);
      return out;
    }
  }
  throw new Error(`长度超出 EBML 上限：${value}`);
}

/** 组装一个元素：ID + 长度 + 内容。 */
function el(id, content) {
  const body = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return Buffer.concat([idBytes(id), vintSize(body.length), body]);
}

/** 无符号整数元素内容：用能装下的最短字节数。 */
function uintBody(v) {
  if (v === 0) return Buffer.from([0]);
  const bytes = [];
  let n = v;
  while (n > 0) { bytes.unshift(n & 0xff); n = Math.floor(n / 256); }
  return Buffer.from(bytes);
}

function floatBody(v) {
  const b = Buffer.alloc(8);
  b.writeDoubleBE(v, 0);
  return b;
}

/**
 * 造一个 MKV。
 *
 * @param {{
 *   sizes: number[], syncSamples: Set<number>, fps?: number,
 *   width?: number, height?: number, codecId?: string,
 *   muxingApp?: string, writingApp?: string,
 *   clusterSec?: number,
 * }} spec
 */
export function buildMkv(spec) {
  const {
    sizes,
    syncSamples,
    fps = 25,
    width = 1920,
    height = 1080,
    codecId = 'V_MPEG4/ISO/AVC',
    muxingApp = 'libebml v1.4.2 + libmatroska v1.6.4',
    writingApp = 'mkvmerge v70.0.0 (\'Go Away\')',
    clusterSec = 2,
  } = spec;

  const timestampScale = 1_000_000;              // 1ms 一刻度
  const frameMs = 1000 / fps;
  const durationMs = Math.round(sizes.length * frameMs);

  const ebml = el(ID.EBML, el(ID.DocType, Buffer.from('matroska', 'ascii')));

  const info = el(ID.Info, Buffer.concat([
    el(ID.TimestampScale, uintBody(timestampScale)),
    el(ID.Duration, floatBody(durationMs)),
    el(ID.MuxingApp, Buffer.from(muxingApp, 'utf8')),
    el(ID.WritingApp, Buffer.from(writingApp, 'utf8')),
  ]));

  const trackEntry = el(ID.TrackEntry, Buffer.concat([
    el(ID.TrackNumber, uintBody(1)),
    el(ID.TrackType, uintBody(1)),                       // 1 = video
    el(ID.CodecID, Buffer.from(codecId, 'ascii')),
    el(ID.DefaultDuration, uintBody(Math.round(frameMs * 1e6))),  // 纳秒
    el(ID.Video, Buffer.concat([
      el(ID.PixelWidth, uintBody(width)),
      el(ID.PixelHeight, uintBody(height)),
    ])),
  ]));
  const tracksEl = el(ID.Tracks, trackEntry);

  // 按时长切 Cluster。块内时间戳是 int16 相对值，所以 Cluster 不能太长。
  const framesPerCluster = Math.max(1, Math.round(clusterSec * fps));
  const clusters = [];
  let i = 0;
  while (i < sizes.length) {
    const count = Math.min(framesPerCluster, sizes.length - i);
    const clusterStartMs = Math.round(i * frameMs);
    const parts = [el(ID.Timestamp, uintBody(clusterStartMs))];

    for (let k = 0; k < count; k += 1) {
      const n = i + k;
      const rel = Math.round(n * frameMs) - clusterStartMs;
      const isKey = syncSamples.has(n + 1);

      const header = Buffer.alloc(4);
      header[0] = 0x81;                                   // 轨号 1，vint 单字节
      header.writeInt16BE(rel, 1);
      header[3] = isKey ? 0x80 : 0x00;                    // 0x80 = 关键帧

      // 帧数据必须真的写出来：MKV 的块长度就是帧的字节数
      const payload = Buffer.alloc(Math.max(1, sizes[n]), 0x33);
      parts.push(el(ID.SimpleBlock, Buffer.concat([header, payload])));
    }

    clusters.push(el(ID.Cluster, Buffer.concat(parts)));
    i += count;
  }

  const segment = el(ID.Segment, Buffer.concat([info, tracksEl, ...clusters]));
  return { buffer: Buffer.concat([ebml, segment]), clusterCount: clusters.length, durationMs };
}
