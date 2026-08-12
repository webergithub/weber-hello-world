/**
 * 合成 MP4 构造器（仅供测试）。
 *
 * 造出结构合法、样本表可控的 MP4，用来验证取证链路：
 * 可以精确指定"第 600–620 秒是一段码率 3 倍、GOP 更短的插入内容"，
 * 然后断言检测器确实在那个位置报出高置信度发现。
 *
 * 只写取证需要读的盒；mdat 用占位数据填充（分析全程不读它）。
 */

/** 组装一个盒：size(4) + type(4) + payload。 */
export function box(type, ...payloads) {
  const body = Buffer.concat(payloads.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p))));
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, body]);
}

/** FullBox：在 payload 前插入 version(1) + flags(3)。 */
export function fullBox(type, version, flags, ...payloads) {
  const vf = Buffer.alloc(4);
  vf.writeUInt8(version, 0);
  vf.writeUIntBE(flags, 1, 3);
  return box(type, vf, ...payloads);
}

const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32BE(v >>> 0, 0); return b; };
const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16BE(v, 0); return b; };
const zeros = (n) => Buffer.alloc(n);
/** 16.16 定点，用于 tkhd 的宽高。 */
const fixed1616 = (v) => u32(Math.round(v * 65536));

const UNITY_MATRIX = Buffer.concat([
  u32(0x00010000), u32(0), u32(0),
  u32(0), u32(0x00010000), u32(0),
  u32(0), u32(0), u32(0x40000000),
]);

/**
 * 生成一条视频轨的样本序列。
 *
 * @param {{
 *   durationSec: number,
 *   fps?: number,
 *   gopSec?: number,
 *   baseKbps?: number,
 *   variation?: (t:number)=>number,     // 返回该秒的码率倍率
 *   inserts?: Array<{atSec:number, durationSec:number, kbpsFactor:number, gopSec:number}>,
 * }} spec
 * @returns {{sizes:number[], deltas:number[], syncSamples:Set<number>, timescale:number, fps:number}}
 */
export function makeVideoSamples(spec) {
  const {
    durationSec,
    fps = 25,
    gopSec = 2,
    baseKbps = 2000,
    variation = () => 1,
    inserts = [],
  } = spec;

  const timescale = 90000;
  const frameDelta = Math.round(timescale / fps);

  const sizes = [];
  const deltas = [];
  const syncSamples = new Set();

  let sinceKey = Infinity;       // 距上一个关键帧的秒数

  // 把插入段按时间排好，便于逐帧判断当前处于哪一段
  const sorted = [...inserts].sort((a, b) => a.atSec - b.atSec);
  const activeInsert = (time) => sorted.find((x) => time >= x.atSec && time < x.atSec + x.durationSec) || null;

  // 用整数帧计数，不要拿浮点 t 做循环条件——累加误差会多出一帧。
  const totalFrames = Math.round(durationSec * fps);

  // 正片自身的时间轴。插入段消耗墙钟时间但**不消耗正片时间**，
  // 于是插入点之后的正片内容整体后移——这才是真正的"插播"。
  // 若不这样做，插入段只是把那几秒的码率覆盖掉，后续内容仍在原时间点，
  // 对齐算法当然找不到位移，测试也就测不到任何东西。
  let sourceTime = 0;

  for (let frame = 0; frame < totalFrames; frame += 1) {
    const t = frame / fps;
    const sampleNo = frame + 1;

    const ins = activeInsert(t);
    const localGop = ins ? ins.gopSec : gopSec;
    // 插入段有**自己的**码率曲线：它是另一次编码的产物，
    // 不会继承正片的码率起伏。
    let factor;
    if (ins) {
      factor = ins.kbpsFactor * (ins.variation ? ins.variation(t - ins.atSec) : 1);
    } else {
      factor = variation(sourceTime);
      sourceTime += 1 / fps;
    }

    // 关键帧：插入段边界必须是关键帧（真实拼接的必要条件），其余按 GOP 节奏
    const atInsertBoundary = sorted.some(
      (x) => Math.abs(t - x.atSec) < 1 / fps || Math.abs(t - (x.atSec + x.durationSec)) < 1 / fps,
    );
    if (sinceKey >= localGop - 1e-9 || atInsertBoundary) {
      syncSamples.add(sampleNo);
      sinceKey = 0;
    }

    // 关键帧显著大于 P 帧，符合真实编码特征
    const isKey = syncSamples.has(sampleNo);
    const perFrameBytes = (baseKbps * factor * 1000) / 8 / fps;
    sizes.push(Math.max(1, Math.round(perFrameBytes * (isKey ? 3.2 : 0.8))));
    deltas.push(frameDelta);

    sinceKey += 1 / fps;
  }

  return { sizes, deltas, syncSamples, timescale, fps };
}

/** stts：逐样本时长压成 (count, delta) 游程。 */
function buildStts(deltas) {
  const runs = [];
  for (const d of deltas) {
    const last = runs[runs.length - 1];
    if (last && last.delta === d) last.count += 1;
    else runs.push({ count: 1, delta: d });
  }
  return fullBox('stts', 0, 0, u32(runs.length),
    ...runs.flatMap((r) => [u32(r.count), u32(r.delta)]));
}

function buildStsz(sizes) {
  return fullBox('stsz', 0, 0, u32(0), u32(sizes.length), ...sizes.map(u32));
}

function buildStss(syncSamples) {
  const list = [...syncSamples].sort((a, b) => a - b);
  return fullBox('stss', 0, 0, u32(list.length), ...list.map(u32));
}

/** 最小可解析的 stsd：一个条目，四字符码即编码格式。 */
function buildStsd(format) {
  const entry = box(format, zeros(78));
  return fullBox('stsd', 0, 0, u32(1), entry);
}

function buildHdlr(handlerType, name) {
  return fullBox('hdlr', 0, 0,
    u32(0), Buffer.from(handlerType, 'latin1'), zeros(12),
    Buffer.from(`${name}\0`, 'utf8'));
}

/**
 * 组装一个完整的测试 MP4。
 *
 * @param {{
 *   video: {sizes:number[], deltas:number[], syncSamples:Set<number>, timescale:number},
 *   width?: number, height?: number, codec?: string,
 *   handlerName?: string, encoderTag?: string|null,
 *   majorBrand?: string, compatibleBrands?: string[],
 *   faststart?: boolean, editList?: Array<{segmentDuration:number, mediaTime:number}>,
 *   extraVideoTrack?: boolean,
 * }} spec
 * @returns {Buffer}
 */
export function buildMp4(spec) {
  const {
    video,
    width = 1920, height = 1080, codec = 'avc1',
    handlerName = 'VideoHandler',
    encoderTag = null,
    majorBrand = 'isom',
    compatibleBrands = ['isom', 'iso2', 'avc1', 'mp41'],
    faststart = true,
    editList = null,
    extraVideoTrack = false,
  } = spec;

  const mediaDuration = video.deltas.reduce((a, b) => a + b, 0);
  const movieTimescale = 1000;
  const movieDuration = Math.round((mediaDuration / video.timescale) * movieTimescale);

  const ftyp = box('ftyp',
    Buffer.from(majorBrand, 'latin1'), u32(512),
    ...compatibleBrands.map((b) => Buffer.from(b, 'latin1')));

  const mvhd = fullBox('mvhd', 0, 0,
    u32(0), u32(0), u32(movieTimescale), u32(movieDuration),
    u32(0x00010000), u16(0x0100), zeros(10), UNITY_MATRIX, zeros(24), u32(2));

  const makeTrack = (trackId) => {
    const tkhd = fullBox('tkhd', 0, 3,
      u32(0), u32(0), u32(trackId), u32(0), u32(movieDuration),
      zeros(8), u16(0), u16(0), u16(0), u16(0), UNITY_MATRIX,
      fixed1616(width), fixed1616(height));

    const mdhd = fullBox('mdhd', 0, 0,
      u32(0), u32(0), u32(video.timescale), u32(mediaDuration), u16(0x55c4), u16(0));

    const stbl = box('stbl',
      buildStsd(codec),
      buildStts(video.deltas),
      buildStss(video.syncSamples),
      buildStsz(video.sizes),
      fullBox('stsc', 0, 0, u32(0)),
      fullBox('stco', 0, 0, u32(0)));

    const minf = box('minf', box('vmhd', zeros(12)), stbl);
    const mdia = box('mdia', mdhd, buildHdlr('vide', handlerName), minf);

    const parts = [tkhd];
    if (editList) {
      // v0 的 elst 条目是 12 字节：segmentDuration + mediaTime + mediaRate，
      // 少写 mediaRate 会让解析器判定长度不足而丢弃整条。
      parts.push(box('edts', fullBox('elst', 0, 0, u32(editList.length),
        ...editList.flatMap((e) => [u32(e.segmentDuration), u32(e.mediaTime), u32(0x00010000)]))));
    }
    parts.push(mdia);
    return box('trak', ...parts);
  };

  const traks = [makeTrack(1)];
  if (extraVideoTrack) traks.push(makeTrack(2));

  const moovParts = [mvhd, ...traks];

  if (encoderTag) {
    // udta > meta(ISO FullBox) > hdlr + ilst > ©too > data
    const dataBox = box('data', u32(1), u32(0), Buffer.from(encoderTag, 'utf8'));
    const tooBox = box('\xa9too', dataBox);
    const ilst = box('ilst', tooBox);
    const metaPayload = Buffer.concat([
      Buffer.from([0, 0, 0, 0]),                 // meta 的 version/flags
      buildHdlr('mdir', ''),
      ilst,
    ]);
    moovParts.push(box('udta', box('meta', metaPayload)));
  }

  const moov = box('moov', ...moovParts);
  // mdat 只是占位：分析全程不读取媒体数据。
  const mdat = box('mdat', Buffer.alloc(1024, 0x11));

  return faststart
    ? Buffer.concat([ftyp, moov, mdat])
    : Buffer.concat([ftyp, mdat, moov]);
}

/* ─────────────────── 分片 MP4（fMP4）构造 ─────────────────── */

const u64 = (v) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(Math.round(v)), 0);
  return b;
};

/** sample_flags 里的"非同步样本"位。关键帧此位为 0。 */
const SAMPLE_IS_NON_SYNC = 0x00010000;

/**
 * 组装一个分片 MP4。
 *
 * 与 buildMp4 的关键差别：moov 里的 stbl 是**空的**，样本信息全在
 * 一串 moof/mdat 里——这正是从 HLS/DASH 重新封装出来的副本的形态，
 * 也是"只读 moov 就会得到 0 个样本"这个陷阱的来源。
 *
 * @param {{
 *   video: {sizes:number[], deltas:number[], syncSamples:Set<number>, timescale:number},
 *   fragmentSec?: number,
 *   width?: number, height?: number, codec?: string, handlerName?: string,
 *   encoderTag?: string|null,
 *   discontinuity?: {atFragment:number, driftTicks:number}|null,
 * }} spec
 */
export function buildFragmentedMp4(spec) {
  const {
    video,
    fragmentSec = 6,
    width = 1920, height = 1080, codec = 'avc1',
    handlerName = 'VideoHandler',
    encoderTag = null,
    discontinuity = null,
  } = spec;

  const trackId = 1;
  const movieTimescale = 1000;
  const totalTicks = video.deltas.reduce((a, b) => a + b, 0);

  const ftyp = box('ftyp',
    Buffer.from('iso5', 'latin1'), u32(512),
    ...['iso5', 'iso6', 'mp41', 'dash', 'cmfc'].map((b) => Buffer.from(b, 'latin1')));

  // 分片文件的 mvhd duration 常为 0（时长要靠遍历分片才知道）
  const mvhd = fullBox('mvhd', 0, 0,
    u32(0), u32(0), u32(movieTimescale), u32(0),
    u32(0x00010000), u16(0x0100), zeros(10), UNITY_MATRIX, zeros(24), u32(2));

  const tkhd = fullBox('tkhd', 0, 3,
    u32(0), u32(0), u32(trackId), u32(0), u32(0),
    zeros(8), u16(0), u16(0), u16(0), u16(0), UNITY_MATRIX,
    fixed1616(width), fixed1616(height));

  const mdhd = fullBox('mdhd', 0, 0,
    u32(0), u32(0), u32(video.timescale), u32(0), u16(0x55c4), u16(0));

  // 空 stbl：所有计数为 0，样本信息在 moof 里
  const stbl = box('stbl',
    buildStsdPublic(codec),
    fullBox('stts', 0, 0, u32(0)),
    fullBox('stsc', 0, 0, u32(0)),
    fullBox('stsz', 0, 0, u32(0), u32(0)),
    fullBox('stco', 0, 0, u32(0)));

  const minf = box('minf', box('vmhd', zeros(12)), stbl);
  const mdia = box('mdia', mdhd, buildHdlrPublic('vide', handlerName), minf);
  const trak = box('trak', tkhd, mdia);

  // mvex/trex：样本默认值。这里全填 0，强制每个样本在 trun 里显式给出。
  const trex = fullBox('trex', 0, 0, u32(trackId), u32(1), u32(0), u32(0), u32(0));
  const mvex = box('mvex', trex);

  const moovParts = [mvhd, trak, mvex];
  if (encoderTag) {
    const dataBox = box('data', u32(1), u32(0), Buffer.from(encoderTag, 'utf8'));
    const ilst = box('ilst', box('\xa9too', dataBox));
    moovParts.push(box('udta', box('meta', Buffer.concat([
      Buffer.from([0, 0, 0, 0]), buildHdlrPublic('mdir', ''), ilst,
    ]))));
  }
  const moov = box('moov', ...moovParts);

  // 按时长切分片
  const samplesPerFragment = Math.max(1, Math.round(fragmentSec * video.timescale
    / (video.deltas[0] || video.timescale)));

  const parts = [ftyp, moov];
  let sampleIndex = 0;
  let baseTime = 0;
  let fragmentIndex = 0;
  let sequence = 1;

  while (sampleIndex < video.sizes.length) {
    const count = Math.min(samplesPerFragment, video.sizes.length - sampleIndex);

    // 漂移从 atFragment 起**持续生效**：插入或删除分片会把后续所有分片
    // 整体推移，只改一个分片的 tfdt 会造出"跳出去又跳回来"的两个断点，
    // 那不是真实形态。
    let declaredBase = baseTime;
    if (discontinuity && fragmentIndex >= discontinuity.atFragment) {
      declaredBase = baseTime + discontinuity.driftTicks;
    }

    const mfhd = fullBox('mfhd', 0, 0, u32(sequence));
    // tfhd flags=0：不带任何默认值，全部回落到 trex（此处为 0），
    // 因此每个样本的时长/大小/标志都必须由 trun 显式给出。
    const tfhd = fullBox('tfhd', 0, 0, u32(trackId));
    const tfdt = fullBox('tfdt', 1, 0, u64(declaredBase));

    // trun flags: data-offset(0x1) | duration(0x100) | size(0x200) | flags(0x400)
    const perSample = [];
    for (let i = 0; i < count; i += 1) {
      const n = sampleIndex + i;
      const isKey = video.syncSamples.has(n + 1);
      perSample.push(u32(video.deltas[n]), u32(video.sizes[n]),
        u32(isKey ? 0 : SAMPLE_IS_NON_SYNC));
    }
    const trun = fullBox('trun', 0, 0x000701, u32(count), u32(0), ...perSample);

    const traf = box('traf', tfhd, tfdt, trun);
    const moof = box('moof', mfhd, traf);

    const mdatBytes = video.sizes.slice(sampleIndex, sampleIndex + count)
      .reduce((a, b) => a + b, 0);
    // mdat 只放占位数据：分析全程不读媒体数据，放真实大小会让测试文件变成 GB 级。
    const mdat = box('mdat', Buffer.alloc(Math.min(mdatBytes, 256), 0x11));

    parts.push(moof, mdat);

    for (let i = 0; i < count; i += 1) baseTime += video.deltas[sampleIndex + i];
    sampleIndex += count;
    fragmentIndex += 1;
    sequence += 1;
  }

  return { buffer: Buffer.concat(parts), fragmentCount: fragmentIndex, totalTicks };
}

/* buildMp4 内部用的两个构造器，分片版本也要用，这里导出。 */
function buildStsdPublic(format) {
  return fullBox('stsd', 0, 0, u32(1), box(format, zeros(78)));
}
function buildHdlrPublic(handlerType, name) {
  return fullBox('hdlr', 0, 0,
    u32(0), Buffer.from(handlerType, 'latin1'), zeros(12),
    Buffer.from(`${name}\0`, 'utf8'));
}

/**
 * 造一条确定性但**非周期**的码率曲线，模拟真实影片。
 *
 * 不要用正弦叠加：正弦是周期信号，整数倍周期处会产生伪完美对齐，
 * 用它测对齐算法等于在测一个退化输入。这里用带种子的 LCG 生成白噪声后
 * 做指数平滑——得到的曲线像真实码率一样"局部相关、全局不重复"，
 * 不同种子之间也是真正不同的内容，而不只是相位差。
 */
export function deterministicVariation(seed = 1) {
  let state = (seed * 2654435761) >>> 0;
  const rnd = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };

  const cache = [];
  let ema = 1;
  const valueAt = (sec) => {
    while (cache.length <= sec) {
      ema = ema * 0.72 + (0.35 + rnd() * 1.5) * 0.28;   // 约 0.4× ~ 1.7×
      cache.push(ema);
    }
    return cache[sec];
  };

  // 秒内做线性插值，避免每秒一个台阶造成人为的强边界
  return (t) => {
    const i = Math.floor(t);
    const f = t - i;
    return valueAt(i) * (1 - f) + valueAt(i + 1) * f;
  };
}
