/**
 * 分片 MP4（fMP4）样本表解析。
 *
 * 为什么必须支持：盗版副本里有很大一部分是**从 HLS/DASH 流重新封装**来的，
 * 这类文件的 `moov` 只有骨架，真正的样本信息分散在一连串 `moof` 里。
 * 只读 `moov` 的话会得到"0 个样本"——分析器不会报错，只会给出一份空洞的报告，
 * 这是最坏的一种失败：看起来成功了，结论却毫无依据。
 *
 * 解析出的样本被填回与非分片文件**完全相同**的 `sizes/deltas/syncSamples` 结构，
 * 因此下游的码率剖面、GOP 分析、异常检测、母版比对全部无需改动。
 *
 * 附带产出一个只有分片文件才有的证据：**分片时间轴断点**。
 * `tfdt` 声明了每个分片的绝对起始时刻，把它和"按样本时长累加出来的时刻"比对，
 * 对不上就说明分片序列被增删或重排过——这正是插播广告的一种常见做法
 * （直接在 m3u8 播放列表里插进几个广告分片，再整体封装成 MP4）。
 */

import { parseBoxes, findBox } from './isobmff.js';

/* tfhd flags */
const TFHD_BASE_DATA_OFFSET = 0x000001;
const TFHD_SAMPLE_DESC_INDEX = 0x000002;
const TFHD_DEFAULT_SAMPLE_DURATION = 0x000008;
const TFHD_DEFAULT_SAMPLE_SIZE = 0x000010;
const TFHD_DEFAULT_SAMPLE_FLAGS = 0x000020;

/* trun flags */
const TRUN_DATA_OFFSET = 0x000001;
const TRUN_FIRST_SAMPLE_FLAGS = 0x000004;
const TRUN_SAMPLE_DURATION = 0x000100;
const TRUN_SAMPLE_SIZE = 0x000200;
const TRUN_SAMPLE_FLAGS = 0x000400;
const TRUN_SAMPLE_CTS = 0x000800;

/** sample_flags 里的"非同步样本"位。为 0 才是关键帧。 */
const SAMPLE_IS_NON_SYNC = 0x00010000;

function readFullHeader(buf, box) {
  return {
    version: buf.readUInt8(box.dataStart),
    flags: (buf.readUInt8(box.dataStart + 1) << 16)
      | (buf.readUInt8(box.dataStart + 2) << 8)
      | buf.readUInt8(box.dataStart + 3),
    offset: box.dataStart + 4,
  };
}

/**
 * mvex/trex：各轨的样本默认值。分片里没显式给出的字段回落到这里。
 * @returns {Map<number, {defaultSampleDuration:number, defaultSampleSize:number, defaultSampleFlags:number}>}
 */
export function parseTrex(buf, moovBoxes) {
  const out = new Map();
  const mvex = findBox(moovBoxes, ['moov', 'mvex']);
  if (!mvex) return out;

  for (const trex of mvex.children.filter((b) => b.type === 'trex')) {
    const { offset } = readFullHeader(buf, trex);
    out.set(buf.readUInt32BE(offset), {
      defaultSampleDuration: buf.readUInt32BE(offset + 8),
      defaultSampleSize: buf.readUInt32BE(offset + 12),
      defaultSampleFlags: buf.readUInt32BE(offset + 16),
    });
  }
  return out;
}

function parseTfhd(buf, box) {
  const { flags, offset } = readFullHeader(buf, box);
  let p = offset;
  const trackId = buf.readUInt32BE(p);
  p += 4;

  // 各可选字段按标志位顺序出现，顺序不能乱。
  if (flags & TFHD_BASE_DATA_OFFSET) p += 8;
  if (flags & TFHD_SAMPLE_DESC_INDEX) p += 4;

  let defaultSampleDuration = null;
  let defaultSampleSize = null;
  let defaultSampleFlags = null;
  if (flags & TFHD_DEFAULT_SAMPLE_DURATION) { defaultSampleDuration = buf.readUInt32BE(p); p += 4; }
  if (flags & TFHD_DEFAULT_SAMPLE_SIZE) { defaultSampleSize = buf.readUInt32BE(p); p += 4; }
  if (flags & TFHD_DEFAULT_SAMPLE_FLAGS) { defaultSampleFlags = buf.readUInt32BE(p); p += 4; }

  return { trackId, defaultSampleDuration, defaultSampleSize, defaultSampleFlags };
}

/** tfdt：该分片的绝对解码起始时刻（媒体时间刻度）。 */
function parseTfdt(buf, box) {
  const { version, offset } = readFullHeader(buf, box);
  if (version === 1) {
    const hi = buf.readUInt32BE(offset);
    const lo = buf.readUInt32BE(offset + 4);
    return hi * 2 ** 32 + lo;
  }
  return buf.readUInt32BE(offset);
}

/**
 * trun：一个分片里的逐样本时长/大小/标志。
 * @returns {Array<{duration:number|null, size:number|null, flags:number|null}>}
 */
function parseTrun(buf, box) {
  const { version, flags, offset } = readFullHeader(buf, box);
  let p = offset;
  const sampleCount = buf.readUInt32BE(p);
  p += 4;

  if (flags & TRUN_DATA_OFFSET) p += 4;
  let firstSampleFlags = null;
  if (flags & TRUN_FIRST_SAMPLE_FLAGS) { firstSampleFlags = buf.readUInt32BE(p); p += 4; }

  const samples = [];
  for (let i = 0; i < sampleCount; i += 1) {
    const s = { duration: null, size: null, flags: null };
    if (flags & TRUN_SAMPLE_DURATION) { if (p + 4 > box.dataEnd) break; s.duration = buf.readUInt32BE(p); p += 4; }
    if (flags & TRUN_SAMPLE_SIZE) { if (p + 4 > box.dataEnd) break; s.size = buf.readUInt32BE(p); p += 4; }
    if (flags & TRUN_SAMPLE_FLAGS) { if (p + 4 > box.dataEnd) break; s.flags = buf.readUInt32BE(p); p += 4; }
    if (flags & TRUN_SAMPLE_CTS) {
      if (p + 4 > box.dataEnd) break;
      // 合成时间偏移，v1 是有符号数；取证不需要，跳过即可。
      p += 4;
    }
    // first_sample_flags 只覆盖第一个样本，且优先于 trun 的逐样本 flags 缺省。
    if (i === 0 && firstSampleFlags != null && s.flags == null) s.flags = firstSampleFlags;
    samples.push(s);
  }

  return samples;
}

/**
 * 解析全部 moof，按 trackId 归并出样本序列。
 *
 * @param {Buffer[]} moofBuffers 每个 moof 盒的完整字节
 * @param {Map<number, object>} trexDefaults
 * @returns {Map<number, {sizes:number[], deltas:number[], syncSamples:Set<number>,
 *                        fragmentCount:number, discontinuities:Array}>}
 */
export function parseFragments(moofBuffers, trexDefaults) {
  /** @type {Map<number, any>} */
  const tracks = new Map();

  const ensure = (trackId) => {
    if (!tracks.has(trackId)) {
      tracks.set(trackId, {
        sizes: [], deltas: [], syncSamples: new Set(),
        fragmentCount: 0, discontinuities: [], expectedTime: 0, sawTfdt: false,
      });
    }
    return tracks.get(trackId);
  };

  for (const buf of moofBuffers) {
    const boxes = parseBoxes(buf);
    const moof = boxes.find((b) => b.type === 'moof');
    if (!moof) continue;

    for (const traf of moof.children.filter((b) => b.type === 'traf')) {
      const tfhdBox = traf.children.find((b) => b.type === 'tfhd');
      if (!tfhdBox) continue;
      const tfhd = parseTfhd(buf, tfhdBox);
      const defaults = trexDefaults.get(tfhd.trackId) || {};

      const track = ensure(tfhd.trackId);
      track.fragmentCount += 1;

      // 分片时间轴断点：tfdt 声明的起点 vs 按样本时长累加出来的起点。
      const tfdtBox = traf.children.find((b) => b.type === 'tfdt');
      if (tfdtBox) {
        const declared = parseTfdt(buf, tfdtBox);
        if (track.sawTfdt) {
          const drift = declared - track.expectedTime;
          // 容忍 1 个样本的取整误差；超出即为真实断点。
          const tolerance = (tfhd.defaultSampleDuration ?? defaults.defaultSampleDuration ?? 0) + 1;
          if (Math.abs(drift) > tolerance) {
            track.discontinuities.push({
              fragmentIndex: track.fragmentCount - 1,
              declaredTime: declared,
              expectedTime: track.expectedTime,
              driftTicks: drift,
            });
          }
        }
        track.sawTfdt = true;
        track.expectedTime = declared;
      }

      for (const trunBox of traf.children.filter((b) => b.type === 'trun')) {
        for (const s of parseTrun(buf, trunBox)) {
          const duration = s.duration
            ?? tfhd.defaultSampleDuration
            ?? defaults.defaultSampleDuration
            ?? 0;
          const size = s.size
            ?? tfhd.defaultSampleSize
            ?? defaults.defaultSampleSize
            ?? 0;
          const sampleFlags = s.flags
            ?? tfhd.defaultSampleFlags
            ?? defaults.defaultSampleFlags
            ?? 0;

          track.sizes.push(size);
          track.deltas.push(duration);
          if (!(sampleFlags & SAMPLE_IS_NON_SYNC)) {
            track.syncSamples.add(track.sizes.length);   // 样本号 1 基
          }
          track.expectedTime += duration;
        }
      }
    }
  }

  // 清掉内部记账字段
  for (const t of tracks.values()) {
    delete t.expectedTime;
    delete t.sawTfdt;
  }
  return tracks;
}

/**
 * 把分片样本合并进 parseContainer 产出的 track 结构。
 * 合并后 track 与非分片文件形状一致，下游分析无需区分两者。
 *
 * @param {object} container parseContainer 输出（moov 部分）
 * @param {Buffer} moovBuf   moov 的完整字节（用于读 trex）
 * @param {Buffer[]} moofBuffers
 */
export function mergeFragmentsIntoTracks(container, moovBuf, moofBuffers) {
  if (!moofBuffers.length) return container;

  const trex = parseTrex(moovBuf, parseBoxes(moovBuf));
  const fragTracks = parseFragments(moofBuffers, trex);

  for (const track of container.tracks) {
    const frag = fragTracks.get(track.trackId);
    if (!frag) continue;

    // moov 里的 stbl 对分片文件是空的，直接以分片样本为准。
    track.sizes = frag.sizes;
    track.deltas = frag.deltas;
    track.syncSamples = frag.syncSamples;
    track.sampleCount = frag.sizes.length;
    track.allSync = frag.syncSamples.size === frag.sizes.length;
    track.fragmentCount = frag.fragmentCount;
    track.fragmentDiscontinuities = frag.discontinuities;

    // 分片文件的 mdhd duration 常为 0，用样本时长之和补上，
    // 否则报告里的总时长会是 0。
    const totalTicks = frag.deltas.reduce((a, b) => a + b, 0);
    if (track.media && (!track.media.duration || track.media.duration === 0)) {
      track.media = { ...track.media, duration: totalTicks };
    }
  }

  container.fragmented = true;
  container.fragmentCount = moofBuffers.length;

  // 分片文件的 mvhd duration 通常是 0——时长要遍历完分片才知道。
  // 用最长的一条轨补上，否则报告里总时长会是 0。
  if (container.movie && !container.movie.duration) {
    const longest = container.tracks.reduce((best, t) => {
      const sec = t.media?.timescale ? (t.media.duration || 0) / t.media.timescale : 0;
      return sec > best ? sec : best;
    }, 0);
    if (longest > 0) {
      container.movie = {
        ...container.movie,
        duration: Math.round(longest * container.movie.timescale),
        durationDerivedFromFragments: true,
      };
    }
  }

  return container;
}
