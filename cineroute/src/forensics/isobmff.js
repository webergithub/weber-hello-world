/**
 * ISOBMFF（MP4 / MOV / M4V）容器解析 —— 纯 JS，零依赖，不解码任何一帧。
 *
 * 为什么取证要从容器入手：
 * 判断一个盗版副本"有没有被二次加工"，最强的证据往往不在画面里，而在
 * **样本表（sample table）**里。stsz 给出每一帧的字节数、stts 给出每一帧的
 * 时长、stss 标出哪些帧是关键帧——把这三张表拼起来，不解码就能还原出
 * 逐秒码率剖面与 GOP 节奏。插入一段广告必然在这两条曲线上留下断点，
 * 因为广告是另一次编码的产物，其码率分布与 GOP 长度几乎不可能与正片一致。
 *
 * 另一类证据在元数据里：x264/x265 会把完整的编码参数串写进 `©too` / `encoder`
 * 标签，muxer 会在 `hdlr` 的 name 字段和 ftyp 品牌列表里留下自己的名字。
 * 原始母版与"下载后重新压制再上传"的副本，在这些字段上通常一眼可辨。
 */

/** 需要递归下钻的容器盒。 */
const CONTAINER_BOXES = new Set([
  'moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'udta',
  'dinf', 'mvex', 'moof', 'traf', 'mfra', 'skip', 'ilst',
]);

/** 这些盒是 FullBox：盒头之后先有 1 字节 version + 3 字节 flags。 */
const FULL_BOXES = new Set([
  'mvhd', 'tkhd', 'mdhd', 'hdlr', 'stsd', 'stts', 'stss', 'stsz',
  'stz2', 'stsc', 'stco', 'co64', 'elst', 'ctts', 'smhd', 'vmhd',
]);

/**
 * 遍历一段字节里的盒结构。
 *
 * @param {Buffer} buf
 * @param {number} start
 * @param {number} end
 * @param {number} [depth]
 * @returns {Array<{type: string, size: number, start: number, dataStart: number, dataEnd: number, children: any[]}>}
 */
export function parseBoxes(buf, start = 0, end = buf.length, depth = 0) {
  const boxes = [];
  let offset = start;

  // 深度保护：畸形文件可能构造出无限嵌套。
  if (depth > 12) return boxes;

  while (offset + 8 <= end) {
    let size = buf.readUInt32BE(offset);
    const type = buf.toString('latin1', offset + 4, offset + 8);
    let headerSize = 8;

    if (size === 1) {
      // 64 位 largesize
      if (offset + 16 > end) break;
      const hi = buf.readUInt32BE(offset + 8);
      const lo = buf.readUInt32BE(offset + 12);
      size = hi * 2 ** 32 + lo;
      headerSize = 16;
    } else if (size === 0) {
      // 延伸到末尾
      size = end - offset;
    }

    // 盒长非法就停止解析这一层，避免死循环。
    if (size < headerSize || offset + size > end) break;

    const dataStart = offset + headerSize;
    const dataEnd = offset + size;

    const box = { type, size, start: offset, dataStart, dataEnd, children: [] };

    if (CONTAINER_BOXES.has(type)) {
      box.children = parseBoxes(buf, dataStart, dataEnd, depth + 1);
    } else if (type === 'meta') {
      // ISO 的 meta 是 FullBox（4 字节版本/标志后才是子盒），
      // QuickTime 的 meta 不是。用"下一个盒的类型是否可读"来判定。
      const isoChildren = parseBoxes(buf, dataStart + 4, dataEnd, depth + 1);
      const qtChildren = parseBoxes(buf, dataStart, dataEnd, depth + 1);
      box.children = isoChildren.length >= qtChildren.length ? isoChildren : qtChildren;
    }

    boxes.push(box);
    offset += size;
  }

  return boxes;
}

/** 在盒树里按路径查找，如 findBox(boxes, ['moov', 'mvhd'])。 */
export function findBox(boxes, path) {
  let current = boxes;
  let found = null;
  for (const type of path) {
    found = current.find((b) => b.type === type);
    if (!found) return null;
    current = found.children;
  }
  return found;
}

/** 找出所有匹配路径前缀的盒（用于多 trak）。 */
export function findAll(boxes, type) {
  return boxes.filter((b) => b.type === type);
}

/**
 * 盒内可读到哪儿为止。
 *
 * 这些解析器面对的是**从归档站下下来的文件**，截断的下载、坏掉的转码、
 * 恶意构造的样本长得一模一样：盒头对得上，里面什么都没有。
 * 所有的读都必须先问一句"还有这么多字节吗"，越界就当没有，
 * 不能让一个空盒把整个取证流程用 RangeError 打断。
 */
const boxLimit = (buf, box) => Math.min(box.dataEnd, buf.length);

/** 盒内安全读 u32：读不到就当 0，不抛。 */
const u32At = (buf, p, limit) => (p >= 0 && p + 4 <= limit ? buf.readUInt32BE(p) : 0);

/** 盒内安全读 i32。 */
const i32At = (buf, p, limit) => (p >= 0 && p + 4 <= limit ? buf.readInt32BE(p) : 0);

/** 一次解压出来的样本数上限。见 parseStts 里的说明。 */
const MAX_SAMPLES = 5_000_000;

/** 读 FullBox 头，返回 {version, flags, offset, limit}（offset 指向实际负载）。 */
function readFullHeader(buf, box) {
  const limit = boxLimit(buf, box);
  // 连 4 字节的 version+flags 都装不下：当成 version 0、flags 0，
  // 后面的读会因为 offset 越过 limit 而各自返回 0
  if (box.dataStart + 4 > limit) {
    return { version: 0, flags: 0, offset: box.dataStart + 4, limit };
  }
  const version = buf.readUInt8(box.dataStart);
  const flags = (buf.readUInt8(box.dataStart + 1) << 16)
    | (buf.readUInt8(box.dataStart + 2) << 8)
    | buf.readUInt8(box.dataStart + 3);
  return { version, flags, offset: box.dataStart + 4, limit };
}

/** mvhd：全局时间刻度与时长。 */
export function parseMvhd(buf, box) {
  const { version, offset, limit } = readFullHeader(buf, box);
  if (version === 1) {
    return {
      timescale: u32At(buf, offset + 16, limit),
      duration: u32At(buf, offset + 20, limit) * 2 ** 32 + u32At(buf, offset + 24, limit),
    };
  }
  return {
    timescale: u32At(buf, offset + 8, limit),
    duration: u32At(buf, offset + 12, limit),
  };
}

/** tkhd：轨道 ID 与显示尺寸（16.16 定点）。 */
export function parseTkhd(buf, box) {
  const { version, offset, limit } = readFullHeader(buf, box);
  const base = version === 1 ? offset + 16 : offset + 8;
  // 尺寸位于盒尾部。盒子被截短时这两个位置会跑到盒头之前，
  // 那就当尺寸未知（0），而不是去读别的盒子的字节。
  const wPos = limit - 8;
  const hPos = limit - 4;
  const sizeOk = wPos >= box.dataStart;
  return {
    trackId: u32At(buf, base, limit),
    width: sizeOk ? u32At(buf, wPos, limit) / 65536 : 0,
    height: sizeOk ? u32At(buf, hPos, limit) / 65536 : 0,
  };
}

/** mdhd：轨道自身的时间刻度与时长。 */
export function parseMdhd(buf, box) {
  const { version, offset, limit } = readFullHeader(buf, box);
  if (version === 1) {
    return {
      timescale: u32At(buf, offset + 16, limit),
      duration: u32At(buf, offset + 20, limit) * 2 ** 32 + u32At(buf, offset + 24, limit),
    };
  }
  return {
    timescale: u32At(buf, offset + 8, limit),
    duration: u32At(buf, offset + 12, limit),
  };
}

/**
 * hdlr：轨道类型 + **handler name**。
 * name 字段是重要的 muxer 指纹——各家写的内容差异明显：
 * "VideoHandler"(ffmpeg/libavformat)、"Core Media Video"(Apple)、
 * "L-SMASH Video Handler"、"Bento4 Video"、"ISO Media file ... HandBrake" 等。
 */
export function parseHdlr(buf, box) {
  const { offset, limit } = readFullHeader(buf, box);
  const handlerType = offset + 8 <= limit ? buf.toString('latin1', offset + 4, offset + 8) : '????';
  // name 从 offset+20 起，可能是以 NUL 结尾的 C 串，也可能是带长度前缀的 Pascal 串
  let name = buf.toString('utf8', Math.min(offset + 20, limit), limit).replace(/\0.*$/s, '').trim();
  if (name && name.charCodeAt(0) < 0x20) name = name.slice(1).trim();
  return { handlerType, name };
}

/** stsd：取样本描述里的编码 fourcc（avc1 / hev1 / mp4a …）。 */
export function parseStsd(buf, box) {
  const { offset, limit } = readFullHeader(buf, box);
  const entryCount = u32At(buf, offset, limit);
  const formats = [];
  let p = offset + 4;
  for (let i = 0; i < entryCount && p + 8 <= limit; i += 1) {
    const size = u32At(buf, p, limit);
    formats.push(buf.toString('latin1', p + 4, p + 8));
    if (size < 8) break;
    p += size;
  }
  return { formats };
}

/** stts：时间-样本表 → 每个样本的时长（解压成数组）。 */
export function parseStts(buf, box) {
  const { offset, limit } = readFullHeader(buf, box);
  const entryCount = u32At(buf, offset, limit);
  const deltas = [];
  let declared = 0;
  let p = offset + 4;

  for (let i = 0; i < entryCount && p + 8 <= limit; i += 1) {
    const count = u32At(buf, p, limit);
    const delta = u32At(buf, p + 4, limit);
    declared += count;
    // 上限卡的是**累计**样本数，不是单条。
    // 原来只卡单条（每条最多 5,000,000），可条数本身是由盒子大小决定的：
    // 一个 16KB 的 stts 能塞 2000 条，每条都声称有 40 亿个样本，
    // 乘出来就是一百亿次 push —— 实测烧掉 20 秒然后抛
    // "Invalid array length"。稍微改小一点的数字则是直接把内存吃光。
    const room = MAX_SAMPLES - deltas.length;
    if (room <= 0) break;
    const n = Math.min(count, room);
    for (let j = 0; j < n; j += 1) deltas.push(delta);
    p += 8;
  }

  // 取证工具不能默默给一份被截短的数据当完整结果用：把实情挂上去，
  // 由 parseContainer 变成 track 上的一条警告。
  deltas.declaredSamples = declared;
  deltas.truncated = declared > deltas.length;
  return deltas;
}

/** stsz：样本大小表。sampleSize 非 0 表示所有样本等长。 */
export function parseStsz(buf, box) {
  const { offset, limit } = readFullHeader(buf, box);
  const sampleSize = u32At(buf, offset, limit);
  const sampleCount = u32At(buf, offset + 4, limit);

  if (sampleSize !== 0) {
    const sizes = new Array(Math.min(sampleCount, MAX_SAMPLES)).fill(sampleSize);
    sizes.declaredSamples = sampleCount;
    sizes.truncated = sampleCount > sizes.length;
    return sizes;
  }

  const sizes = [];
  let p = offset + 8;
  for (let i = 0; i < sampleCount && p + 4 <= limit && sizes.length < MAX_SAMPLES; i += 1) {
    sizes.push(u32At(buf, p, limit));
    p += 4;
  }
  sizes.declaredSamples = sampleCount;
  // 表里根本没这么多字节也算"说了谎"，一样要报出来
  sizes.truncated = sampleCount > sizes.length;
  return sizes;
}

/** stss：同步样本表（关键帧），样本号从 1 开始。返回 Set。 */
export function parseStss(buf, box) {
  const { offset, limit } = readFullHeader(buf, box);
  const entryCount = u32At(buf, offset, limit);
  const keys = new Set();
  let p = offset + 4;
  for (let i = 0; i < entryCount && p + 4 <= limit && keys.size < MAX_SAMPLES; i += 1) {
    keys.add(u32At(buf, p, limit));
    p += 4;
  }
  return keys;
}

/** elst：编辑列表。存在非平凡的编辑列表 = 有过裁剪/位移。 */
export function parseElst(buf, box) {
  const { version, offset, limit } = readFullHeader(buf, box);
  const entryCount = u32At(buf, offset, limit);
  const entries = [];
  let p = offset + 4;
  for (let i = 0; i < entryCount; i += 1) {
    if (version === 1) {
      if (p + 20 > limit) break;
      entries.push({
        segmentDuration: u32At(buf, p, limit) * 2 ** 32 + u32At(buf, p + 4, limit),
        mediaTime: i32At(buf, p + 8, limit) * 2 ** 32 + u32At(buf, p + 12, limit),
      });
      p += 20;
    } else {
      if (p + 12 > limit) break;
      entries.push({
        segmentDuration: u32At(buf, p, limit),
        mediaTime: i32At(buf, p + 4, limit),
      });
      p += 12;
    }
  }
  return entries;
}

/**
 * 从 udta/meta/ilst 里抽取标签，重点是 `©too`（编码器串）。
 * x264 会写入完整参数，例如：
 *   "x264 - core 164 r3095 baee400 - H.264/MPEG-4 AVC codec - ... - options: cabac=1 ref=3 ..."
 * 这串东西是判定"是否被重新压制"最直接的证据。
 */
export function parseTags(buf, boxes) {
  const tags = {};
  const walk = (list) => {
    for (const b of list) {
      if (b.children?.length) walk(b.children);
      // ilst 的条目盒类型即标签名（如 ©too / ©nam），内部套一个 data 盒
      if (b.type.length === 4 && b.dataEnd - b.dataStart > 8) {
        const inner = parseBoxes(buf, b.dataStart, b.dataEnd);
        const data = inner.find((x) => x.type === 'data');
        if (data && data.dataEnd - data.dataStart > 8) {
          const text = buf.toString('utf8', data.dataStart + 8, data.dataEnd).replace(/\0+$/, '');
          if (text.trim()) tags[b.type] = text.trim();
        }
      }
    }
  };
  const udta = findBox(boxes, ['moov', 'udta']);
  if (udta) walk(udta.children);
  return tags;
}

/**
 * 解析整个文件的取证相关结构。
 *
 * @param {Buffer} buf 完整文件（或至少含 ftyp + moov 的前段）
 * @returns {object}
 */
export function parseContainer(buf) {
  const boxes = parseBoxes(buf);
  const topLevel = boxes.map((b) => ({ type: b.type, size: b.size, start: b.start }));

  const ftypBox = boxes.find((b) => b.type === 'ftyp');
  let ftyp = null;
  if (ftypBox && ftypBox.dataEnd - ftypBox.dataStart >= 8) {
    const majorBrand = buf.toString('latin1', ftypBox.dataStart, ftypBox.dataStart + 4);
    const minorVersion = buf.readUInt32BE(ftypBox.dataStart + 4);
    const compatible = [];
    for (let p = ftypBox.dataStart + 8; p + 4 <= ftypBox.dataEnd; p += 4) {
      compatible.push(buf.toString('latin1', p, p + 4));
    }
    ftyp = { majorBrand, minorVersion, compatibleBrands: compatible };
  }

  const moov = boxes.find((b) => b.type === 'moov');
  if (!moov) {
    return { ok: false, reason: '未找到 moov，可能不是 ISOBMFF 文件或 moov 在文件尾部之外', topLevel, ftyp };
  }

  const mvhdBox = findBox(boxes, ['moov', 'mvhd']);
  const movie = mvhdBox ? parseMvhd(buf, mvhdBox) : null;

  const tracks = [];
  for (const trak of findAll(moov.children, 'trak')) {
    const tkhdBox = trak.children.find((b) => b.type === 'tkhd');
    const mdia = trak.children.find((b) => b.type === 'mdia');
    if (!mdia) continue;

    const mdhdBox = mdia.children.find((b) => b.type === 'mdhd');
    const hdlrBox = mdia.children.find((b) => b.type === 'hdlr');
    const minf = mdia.children.find((b) => b.type === 'minf');
    const stbl = minf?.children.find((b) => b.type === 'stbl');

    const edts = trak.children.find((b) => b.type === 'edts');
    const elstBox = edts?.children.find((b) => b.type === 'elst');

    const track = {
      ...(tkhdBox ? parseTkhd(buf, tkhdBox) : { trackId: null, width: 0, height: 0 }),
      ...(hdlrBox ? parseHdlr(buf, hdlrBox) : { handlerType: '????', name: '' }),
      media: mdhdBox ? parseMdhd(buf, mdhdBox) : null,
      editList: elstBox ? parseElst(buf, elstBox) : [],
      codecs: [],
      sampleCount: 0,
      sizes: [],
      deltas: [],
      syncSamples: null,
      // 解析过程中发现的"文件自己说的和实际对不上"，供报告如实呈现
      parseWarnings: [],
    };

    if (stbl) {
      const stsdBox = stbl.children.find((b) => b.type === 'stsd');
      const sttsBox = stbl.children.find((b) => b.type === 'stts');
      const stszBox = stbl.children.find((b) => b.type === 'stsz');
      const stssBox = stbl.children.find((b) => b.type === 'stss');

      if (stsdBox) track.codecs = parseStsd(buf, stsdBox).formats;
      if (sttsBox) track.deltas = parseStts(buf, sttsBox);
      if (stszBox) track.sizes = parseStsz(buf, stszBox);
      if (stssBox) track.syncSamples = parseStss(buf, stssBox);
      track.sampleCount = Math.min(track.sizes.length, track.deltas.length) || track.sizes.length;

      // 表里声称的样本数与实际解析出来的对不上时如实报出来。
      // 取证结论建立在这些数字上，默默用一份被截短的表算出来的码率、
      // 帧率、时长都是错的，而且错得看不出来。
      for (const [what, table] of [['stts', track.deltas], ['stsz', track.sizes]]) {
        if (table?.truncated) {
          track.parseWarnings.push(
            `${what} 声称 ${table.declaredSamples} 个样本，实际只解析出 ${table.length} 个`
            + '（超出上限或文件里根本没这么多字节），基于样本表的统计只能作参考',
          );
        }
      }
      // 没有 stss 表示所有样本都是同步样本（全 I 帧或音频）。
      track.allSync = !stssBox;
    }

    tracks.push(track);
  }

  return {
    ok: true,
    topLevel,
    ftyp,
    movie,
    tracks,
    tags: parseTags(buf, boxes),
    hasFragments: boxes.some((b) => b.type === 'moof') || Boolean(findBox(boxes, ['moov', 'mvex'])),
  };
}
