/**
 * 畸形 Matroska / WebM。
 *
 * 与 containerFuzz 同一套判据（不许抛未捕获异常、不许跑不完），
 * 但 EBML 比 MP4 的定长盒头更容易出边界问题：
 *
 *  - 元素 ID 和长度都是**变长整数**，长度由首字节的前导零个数决定，
 *    也就是说"这个字段有多长"本身就是文件说了算；
 *  - 长度字段允许"未知"（全 1），流式封装里 Cluster 常这么写，
 *    解析器得自己决定延伸到哪儿；
 *  - 没有集中索引，一个坏字节之后的所有内容都得靠猜。
 *
 * 最后一条决定了这里还要盯一件事：**解析器放弃时必须说出来**。
 * MKV 扫到坏字节就停是合理的，但停了还报 ok 且给出一份残缺的帧表，
 * 下游据此算出的码率、帧率就是错的——和 MP4 那边样本表被截短是同一类问题。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseMatroska, isMatroska } from '../src/forensics/matroska.js';
import { analyze, renderText } from '../src/forensics/report.js';

/* ── EBML 构造工具 ────────────────────────────────────────── */

/** 把元素 ID 写成字节（ID 本身已含长度标记位）。 */
function idBytes(id) {
  if (id <= 0xff) return Buffer.from([id]);
  if (id <= 0xffff) return Buffer.from([id >> 8, id & 0xff]);
  if (id <= 0xffffff) return Buffer.from([id >> 16, (id >> 8) & 0xff, id & 0xff]);
  return Buffer.from([id >>> 24, (id >> 16) & 0xff, (id >> 8) & 0xff, id & 0xff]);
}

/** EBML 长度字段：1 字节能表示 0..126，再长就用多字节。 */
function sizeBytes(n, forceLen = null) {
  const len = forceLen ?? (n < 0x7f ? 1 : n < 0x3fff ? 2 : n < 0x1fffff ? 3 : 4);
  const b = Buffer.alloc(len);
  // 首字节的标记位：第 len 位置 1
  const marker = 0x80 >> (len - 1);
  let v = n;
  for (let i = len - 1; i >= 0; i -= 1) { b[i] = v & 0xff; v = Math.floor(v / 256); }
  b[0] |= marker;
  return b;
}

/** 一个元素。lieSize 用来让长度字段撒谎。 */
function el(id, payload = Buffer.alloc(0), lieSize = null) {
  return Buffer.concat([idBytes(id), sizeBytes(lieSize ?? payload.length), payload]);
}

/** 长度字段写成"未知"（标记位之后全 1）。 */
function elUnknownSize(id, payload = Buffer.alloc(0)) {
  return Buffer.concat([idBytes(id), Buffer.from([0xff]), payload]);
}

/** 无符号整数负载。 */
function uint(n, len = 4) {
  const b = Buffer.alloc(len);
  let v = n;
  for (let i = len - 1; i >= 0; i -= 1) { b[i] = v & 0xff; v = Math.floor(v / 256); }
  return b;
}

const ID = {
  EBML: 0x1a45dfa3, Segment: 0x18538067, Info: 0x1549a966,
  TimestampScale: 0x2ad7b1, Duration: 0x4489,
  Tracks: 0x1654ae6b, TrackEntry: 0xae, TrackNumber: 0xd7, TrackType: 0x83,
  CodecID: 0x86, Video: 0xe0, PixelWidth: 0xb0, PixelHeight: 0xba,
  Cluster: 0x1f43b675, Timestamp: 0xe7, SimpleBlock: 0xa3,
};

const ebmlHead = () => el(ID.EBML, uint(1, 4));

/** 一个结构完整的最小 MKV，用来当对照组。 */
function goodMkv() {
  const track = el(ID.TrackEntry, Buffer.concat([
    el(ID.TrackNumber, uint(1, 1)),
    el(ID.TrackType, uint(1, 1)),
    el(ID.CodecID, Buffer.from('V_MPEG4/ISO/AVC')),
    el(ID.Video, Buffer.concat([el(ID.PixelWidth, uint(1920, 2)), el(ID.PixelHeight, uint(1080, 2))])),
  ]));
  const block = (t, key) => el(ID.SimpleBlock, Buffer.concat([
    Buffer.from([0x81]),                       // 轨号 1（vint）
    Buffer.from([(t >> 8) & 0xff, t & 0xff]),  // 相对时间戳 int16
    Buffer.from([key ? 0x80 : 0x00]),          // 标志
    Buffer.alloc(200, 7),                      // 帧数据
  ]));
  const cluster = el(ID.Cluster, Buffer.concat([
    el(ID.Timestamp, uint(0, 2)),
    block(0, true), block(40, false), block(80, false),
  ]));
  return Buffer.concat([
    ebmlHead(),
    el(ID.Segment, Buffer.concat([
      el(ID.Info, el(ID.TimestampScale, uint(1_000_000, 4))),
      el(ID.Tracks, track),
      cluster,
    ])),
  ]);
}

/* ── 畸形样本 ─────────────────────────────────────────────── */

const SAMPLES = [
  ['空文件', Buffer.alloc(0)],
  ['只有 EBML 魔数的一半', Buffer.from([0x1a, 0x45])],
  ['魔数对但后面什么都没有', idBytes(ID.EBML)],
  ['长度字段首字节是 0（非法 vint）', Buffer.concat([ebmlHead(), idBytes(ID.Segment), Buffer.from([0x00])])],
  ['元素 ID 首字节是 0', Buffer.concat([ebmlHead(), Buffer.from([0x00, 0x00, 0x00, 0x00])])],
  ['Segment 声称的长度远超文件', Buffer.concat([ebmlHead(), el(ID.Segment, Buffer.alloc(16), 0x0fffffff)])],
  ['Segment 长度未知（流式封装的合法写法）',
    Buffer.concat([ebmlHead(), elUnknownSize(ID.Segment, Buffer.concat([
      el(ID.Info, el(ID.TimestampScale, uint(1_000_000, 4))),
    ]))])],
  ['Cluster 长度未知', Buffer.concat([ebmlHead(), el(ID.Segment, Buffer.concat([
    el(ID.Tracks, el(ID.TrackEntry, Buffer.concat([el(ID.TrackNumber, uint(1, 1)), el(ID.TrackType, uint(1, 1))]))),
    elUnknownSize(ID.Cluster, Buffer.concat([el(ID.Timestamp, uint(0, 2))])),
  ]))])],
  ['TimestampScale = 0（会被拿去做除数）', Buffer.concat([ebmlHead(), el(ID.Segment, Buffer.concat([
    el(ID.Info, el(ID.TimestampScale, uint(0, 4))),
    el(ID.Tracks, el(ID.TrackEntry, Buffer.concat([el(ID.TrackNumber, uint(1, 1)), el(ID.TrackType, uint(1, 1))]))),
  ]))])],
  ['TimestampScale 是个 8 字节天文数字', Buffer.concat([ebmlHead(), el(ID.Segment, Buffer.concat([
    el(ID.Info, el(ID.TimestampScale, Buffer.alloc(8, 0xff))),
    el(ID.Tracks, el(ID.TrackEntry, Buffer.concat([el(ID.TrackNumber, uint(1, 1)), el(ID.TrackType, uint(1, 1))]))),
  ]))])],
  ['Duration 是 4096 字节的垃圾', Buffer.concat([ebmlHead(), el(ID.Segment,
    el(ID.Info, el(ID.Duration, Buffer.alloc(4000, 0xab))))])],
  ['SimpleBlock 头被截断', Buffer.concat([ebmlHead(), el(ID.Segment, Buffer.concat([
    el(ID.Tracks, el(ID.TrackEntry, Buffer.concat([el(ID.TrackNumber, uint(1, 1)), el(ID.TrackType, uint(1, 1))]))),
    el(ID.Cluster, Buffer.concat([el(ID.Timestamp, uint(0, 2)), el(ID.SimpleBlock, Buffer.from([0x81]))])),
  ]))])],
  ['SimpleBlock 声称的负载比实际长', Buffer.concat([ebmlHead(), el(ID.Segment, Buffer.concat([
    el(ID.Tracks, el(ID.TrackEntry, Buffer.concat([el(ID.TrackNumber, uint(1, 1)), el(ID.TrackType, uint(1, 1))]))),
    el(ID.Cluster, Buffer.concat([
      el(ID.Timestamp, uint(0, 2)),
      el(ID.SimpleBlock, Buffer.from([0x81, 0, 0, 0x80]), 0x0ffffff),
    ])),
  ]))])],
  ['嵌套很深的 Segment 套 Segment', (() => {
    let b = el(ID.Info, el(ID.TimestampScale, uint(1_000_000, 4)));
    for (let i = 0; i < 30; i += 1) b = el(ID.Segment, b);
    return Buffer.concat([ebmlHead(), b]);
  })()],
  ['好文件后面接一堆随机字节', Buffer.concat([goodMkv(), (() => {
    const b = Buffer.alloc(8192);
    for (let i = 0; i < b.length; i += 1) b[i] = (i * 2654435761) & 0xff;
    return b;
  })()])],
  ['文件正中间被挖掉一段', (() => {
    const g = goodMkv();
    const cut = Buffer.from(g);
    cut.fill(0, Math.floor(cut.length / 2), Math.floor(cut.length / 2) + 8);
    return cut;
  })()],
  ['好文件被截掉尾巴', goodMkv().subarray(0, Math.floor(goodMkv().length * 0.6))],
];

const BUDGET_MS = 5000;

async function withFile(buf, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cineroute-mkv-'));
  const file = path.join(dir, 'sample.mkv');
  try {
    await fs.writeFile(file, buf);
    return await fn(file);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/* ── 用例 ─────────────────────────────────────────────────── */

test('畸形 MKV：解析器不抛未捕获异常', async () => {
  const bad = [];
  for (const [label, buf] of SAMPLES) {
    await withFile(buf, async (file) => {
      try {
        await parseMatroska(file);
      } catch (e) {
        bad.push(`  · ${label}\n      抛出 ${e.constructor.name}: ${e.message}`);
      }
    });
  }
  assert.equal(bad.length, 0, `${bad.length} 个畸形样本让解析器抛了异常：\n${bad.join('\n')}`);
});

test('畸形 MKV：解析器不会跑不完', async () => {
  const slow = [];
  for (const [label, buf] of SAMPLES) {
    await withFile(buf, async (file) => {
      const t0 = Date.now();
      try { await parseMatroska(file); } catch { /* 上一条用例负责 */ }
      const ms = Date.now() - t0;
      if (ms > BUDGET_MS) slow.push(`  · ${label} 花了 ${ms}ms（上限 ${BUDGET_MS}ms）`);
    });
  }
  assert.equal(slow.length, 0, `${slow.length} 个畸形样本跑不完：\n${slow.join('\n')}`);
});

test('畸形 MKV：返回值成形，且数值不能是 NaN / Infinity', async () => {
  // 时间刻度会被当除数用，算出 Infinity 之后一路污染到帧率、码率、时长
  const bad = [];
  for (const [label, buf] of SAMPLES) {
    await withFile(buf, async (file) => {
      let out;
      try { out = await parseMatroska(file); } catch { return; }
      if (typeof out !== 'object' || out === null) { bad.push(`  · ${label} 返回了 ${out}`); return; }
      if (out.ok === false) {
        if (!out.reason) bad.push(`  · ${label} 说失败但没给原因`);
        return;
      }
      if (!Array.isArray(out.tracks)) { bad.push(`  · ${label} 说成功但没有 tracks`); return; }

      const finite = (v) => v == null || Number.isFinite(v);
      for (const t of out.tracks) {
        if (!finite(t.media?.timescale)) bad.push(`  · ${label} timescale = ${t.media?.timescale}`);
        if (!finite(t.media?.duration)) bad.push(`  · ${label} duration = ${t.media?.duration}`);
        if (t.deltas?.some((d) => !Number.isFinite(d))) bad.push(`  · ${label} deltas 里有非有限数`);
        if (t.sizes?.some((v) => !Number.isFinite(v))) bad.push(`  · ${label} sizes 里有非有限数`);
      }
    });
  }
  assert.equal(bad.length, 0, `${bad.length} 处返回值有问题：\n${bad.join('\n')}`);
});

test('好文件仍然解析得对（畸形防护不能误伤正常路径）', async () => {
  await withFile(goodMkv(), async (file) => {
    assert.equal(await isMatroska(file), true, '应当认得出这是 MKV');
    const out = await parseMatroska(file);
    assert.equal(out.ok, true, `正常文件应当解析成功：${out.reason}`);

    const v = out.tracks.find((t) => t.handlerType === 'vide');
    assert.ok(v, '应当找到视频轨');
    assert.equal(v.width, 1920);
    assert.equal(v.height, 1080);
    assert.equal(v.sampleCount, 3, `应当有 3 帧，实际 ${v.sampleCount}`);
    assert.equal(v.syncSamples.has(1), true, '第一帧应当是关键帧');
    assert.equal(v.media.timescale, 1000, 'TimestampScale 1ms → 每秒 1000 刻度');
    assert.ok(v.sizes.every((s) => s > 0), `帧大小应当都是正数：${v.sizes}`);

    // 关键：正常文件不能无端报"不完整"。
    // 少了这条断言，一个"永远置 incomplete=true"的假修复也能让上面那条用例过。
    assert.equal(out.incomplete, false, `正常文件被误报成不完整：${JSON.stringify(out.warnings)}`);
    assert.deepEqual(out.warnings, [], '正常文件不该有警告');
  });
});

test('扫描中途放弃时必须说出来，不能给一份残缺的帧表却报一切正常', async () => {
  // MKV 没有集中索引，扫到坏字节就停是合理的。但停了还说 ok、
  // 还给出一份残缺的帧表，下游算出的码率和帧率就是错的——
  // 和 MP4 那边样本表被截短是同一类问题。
  const good = goodMkv();
  const truncated = good.subarray(0, Math.floor(good.length * 0.6));

  const full = await withFile(good, (f) => parseMatroska(f));
  const part = await withFile(truncated, (f) => parseMatroska(f));

  const framesOf = (r) => (r.tracks?.find((t) => t.handlerType === 'vide')?.sampleCount ?? 0);
  assert.ok(framesOf(full) > 0, '前提：完整文件应当有帧');

  if (part.ok && framesOf(part) < framesOf(full)) {
    assert.ok(
      part.incomplete === true || (part.warnings?.length ?? 0) > 0,
      `截断文件只解析出 ${framesOf(part)}/${framesOf(full)} 帧，却没有任何"数据不完整"的标记：`
      + `${JSON.stringify({ ok: part.ok, incomplete: part.incomplete, warnings: part.warnings })}`,
    );
  }
});

test('MKV 的不完整警告要一路带到报告文本里', async () => {
  // 与 MP4 那边同样的道理：算出来了但报告里不显示，等于没算。
  // 跑真正的 analyze()，对着真落在磁盘上的截断文件。
  const good = goodMkv();
  await withFile(good.subarray(0, Math.floor(good.length * 0.6)), async (file) => {
    const report = await analyze(file, { skipHash: true });
    assert.equal(report.container.ok, true, `应当仍能解析出结构：${report.container.reason}`);
    assert.equal(report.container.incomplete, true, '报告里应当标出"不完整"');
    assert.ok(report.container.warnings.length > 0, '报告里应当带上警告');

    const text = renderText(report);
    assert.ok(
      text.includes(report.container.warnings[0]),
      `报告文本里没有这条警告：\n${text.split('\n').filter((l) => l.includes('容器') || l.includes('⚠')).join('\n')}`,
    );
  });
});
