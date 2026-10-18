/**
 * 畸形容器：取证模块的解析器面对敌意二进制。
 *
 * 取证模块解析的是**从归档站下下来的文件**——第三方上传的二进制。
 * 它跟片名一样是敌意输入，只是更危险：解析器里一个没兜住的长度字段，
 * 轻则抛异常把整个取证流程打断，重则按文件里写的数字去分配内存，
 * 一个几 KB 的文件就能把进程拖死。
 *
 * 这里造的都是**结构上合法、数值上撒谎**的文件：盒头对得上，
 * 里面的 entryCount / sampleCount / size 写的是攻击者想写的数。
 * 真实世界里这不一定是攻击，截断的下载、坏掉的转码同样长这样。
 *
 * 判据只有两条，但都是硬的：
 *   1) 不许抛出未捕获的异常 —— 要么给出结果，要么给出"解析失败"的结论；
 *   2) 不许跑不完 —— 每个样本都有时间上限。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseBoxes, parseContainer, parseStts, parseStsz, parseStss, parseElst, findBox,
} from '../src/forensics/isobmff.js';
import { renderText, analyze } from '../src/forensics/report.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/* ── 造畸形文件的小工具 ───────────────────────────────────── */

const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
};

/** 一个盒：size + type + payload。size 可以显式指定（用来撒谎）。 */
function box(type, payload = Buffer.alloc(0), lieSize = null) {
  const size = lieSize ?? payload.length + 8;
  return Buffer.concat([u32(size), Buffer.from(type, 'latin1'), payload]);
}

/** FullBox：盒头之后 1 字节 version + 3 字节 flags。 */
function fullBox(type, version, payload = Buffer.alloc(0), lieSize = null) {
  return box(type, Buffer.concat([Buffer.from([version, 0, 0, 0]), payload]), lieSize);
}

/** 把一堆盒包成一个最小可解析的 MP4。 */
function mp4(...boxes) {
  return Buffer.concat([
    box('ftyp', Buffer.concat([Buffer.from('isom'), u32(512), Buffer.from('isomiso2')])),
    ...boxes,
  ]);
}

/** 包一层 moov/trak/mdia/minf/stbl，把给定的表盒放进去。 */
function withStbl(...tableBoxes) {
  const stbl = box('stbl', Buffer.concat(tableBoxes));
  const minf = box('minf', stbl);
  const mdia = box('mdia', Buffer.concat([
    fullBox('mdhd', 0, Buffer.concat([u32(0), u32(0), u32(1000), u32(1000)])),
    fullBox('hdlr', 0, Buffer.concat([u32(0), Buffer.from('vide'), u32(0), u32(0), u32(0)])),
    minf,
  ]));
  const trak = box('trak', mdia);
  return mp4(box('moov', Buffer.concat([
    fullBox('mvhd', 0, Buffer.concat([u32(0), u32(0), u32(1000), u32(1000)])),
    trak,
  ])));
}

/* ── 样本清单 ─────────────────────────────────────────────── */

/**
 * 每一条都是一种真实会遇到的坏法。
 * 名字里写清楚坏在哪，失败时才知道是哪种畸形打穿了解析器。
 */
const SAMPLES = [
  ['空文件', Buffer.alloc(0)],
  ['只有几个字节', Buffer.from([0, 0, 0])],
  ['盒头声称的长度超出文件', box('moov', Buffer.alloc(4), 0x7fffffff)],
  ['盒长为 0（延伸到末尾）', Buffer.concat([u32(0), Buffer.from('moov'), Buffer.alloc(16)])],
  ['盒长小于盒头', Buffer.concat([u32(4), Buffer.from('moov'), Buffer.alloc(16)])],
  ['64 位 largesize 撒了个天文数字', Buffer.concat([
    u32(1), Buffer.from('moov'), u32(0xffffffff), u32(0xffffffff), Buffer.alloc(8),
  ])],
  ['ftyp 声称有 compatible brands 但被截断', mp4(box('ftyp', Buffer.from('isom')))],
  ['moov 是空的', mp4(box('moov'))],
  ['trak 里什么都没有', mp4(box('moov', box('trak')))],
  ['stbl 是空的', withStbl()],

  // 表盒：数值撒谎
  ['stts 说有 40 亿条', withStbl(fullBox('stts', 0, Buffer.concat([u32(0xffffffff), u32(10), u32(100)])))],
  ['stts 单条 count 是 40 亿', withStbl(fullBox('stts', 0, Buffer.concat([u32(1), u32(0xffffffff), u32(100)])))],
  ['stts 每条都说自己有 40 亿个样本（累计不设上限就爆）', withStbl(
    fullBox('stts', 0, Buffer.concat([
      u32(2000),
      ...Array.from({ length: 2000 }, () => Buffer.concat([u32(0xffffffff), u32(1)])),
    ])),
  )],
  ['stsz 等长样本，数量 40 亿', withStbl(fullBox('stsz', 0, Buffer.concat([u32(1000), u32(0xffffffff)])))],
  ['stsz 说有 40 亿条但表是空的', withStbl(fullBox('stsz', 0, Buffer.concat([u32(0), u32(0xffffffff)])))],
  ['stss 说有 40 亿个关键帧', withStbl(fullBox('stss', 0, u32(0xffffffff)))],
  ['elst 说有 40 亿条编辑', mp4(box('moov', box('trak', box('edts', fullBox('elst', 0, u32(0xffffffff))))))],
  ['elst version=1 但数据不够长', mp4(box('moov', box('trak', box('edts', fullBox('elst', 1, Buffer.concat([u32(1), u32(0)]))))))],

  // 表盒：盒子本身太小，连自己的头都装不下
  ['stts 是个空盒（连 entryCount 都没有）', withStbl(box('stts'))],
  ['stsz 是个空盒', withStbl(box('stsz'))],
  ['stss 是个空盒', withStbl(box('stss'))],
  ['stts 空盒且正好在文件末尾', withStbl(box('stts'))],
  ['stsd 是个空盒', withStbl(box('stsd'))],
  ['mvhd 是个空盒', mp4(box('moov', box('mvhd')))],
  ['tkhd 是个空盒', mp4(box('moov', box('trak', box('tkhd'))))],
  ['mdhd 是个空盒', mp4(box('moov', box('trak', box('mdia', box('mdhd')))))],
  ['hdlr 是个空盒', mp4(box('moov', box('trak', box('mdia', box('hdlr')))))],

  // 嵌套
  ['moov 套 moov 套很多层', (() => {
    let b = box('moov', Buffer.alloc(8));
    for (let i = 0; i < 40; i += 1) b = box('moov', b);
    return Buffer.concat([box('ftyp', Buffer.from('isomisom')), b]);
  })()],
  ['meta 深度嵌套（这个盒会被解析两遍，容易指数放大）', (() => {
    let b = box('meta', Buffer.alloc(64));
    for (let i = 0; i < 20; i += 1) b = box('meta', b);
    return mp4(box('moov', b));
  })()],

  // 全随机
  ['纯随机字节', (() => {
    const b = Buffer.alloc(4096);
    for (let i = 0; i < b.length; i += 1) b[i] = (i * 2654435761) & 0xff;
    return b;
  })()],
];

/** 单个样本的时间上限。超时说明解析器在按文件里写的数字干活。 */
const BUDGET_MS = 3000;

function timed(label, fn) {
  const t0 = Date.now();
  let err = null;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  return { label, ms: Date.now() - t0, err };
}

test('畸形容器：解析器不抛未捕获异常', () => {
  const bad = [];
  for (const [label, buf] of SAMPLES) {
    const r = timed(label, () => parseContainer(buf));
    if (r.err) bad.push(`  · ${label}\n      抛出 ${r.err.constructor.name}: ${r.err.message}`);
  }
  assert.equal(bad.length, 0, `${bad.length} 个畸形样本让解析器抛了异常：\n${bad.join('\n')}`);
});

test('畸形容器：解析器不会跑不完', () => {
  const slow = [];
  for (const [label, buf] of SAMPLES) {
    const r = timed(label, () => { try { parseContainer(buf); } catch { /* 上一条用例负责 */ } });
    if (r.ms > BUDGET_MS) slow.push(`  · ${label} 花了 ${r.ms}ms（上限 ${BUDGET_MS}ms）`);
  }
  assert.equal(slow.length, 0, `${slow.length} 个畸形样本跑不完：\n${slow.join('\n')}`);
});

test('畸形容器：解析结果要么可用，要么明确说失败', () => {
  const bad = [];
  for (const [label, buf] of SAMPLES) {
    let out;
    try {
      out = parseContainer(buf);
    } catch {
      continue;   // 抛异常由第一条用例管
    }
    if (typeof out !== 'object' || out === null) { bad.push(`  · ${label} 返回了 ${out}`); continue; }
    if (out.ok === false && !out.reason) bad.push(`  · ${label} 说失败但没给原因`);
    if (out.ok !== false && !Array.isArray(out.tracks)) bad.push(`  · ${label} 说成功但没有 tracks`);
  }
  assert.equal(bad.length, 0, `${bad.length} 处返回值不成形：\n${bad.join('\n')}`);
});

/* ── 表解析器单独打 ───────────────────────────────────────── */

/** 从造好的文件里取出某个表盒，直接喂给对应的解析器。 */
function grabBox(buf, path) {
  return findBox(parseBoxes(buf), path);
}

const STBL_PATH = ['moov', 'trak', 'mdia', 'minf', 'stbl'];

test('表解析器：撒谎的 entryCount 不能变成天量内存', () => {
  const cases = [
    ['stts 每条 count 都是 40 亿', withStbl(fullBox('stts', 0, Buffer.concat([
      u32(2000),
      ...Array.from({ length: 2000 }, () => Buffer.concat([u32(0xffffffff), u32(1)])),
    ]))), 'stts', parseStts],
    ['stsz 等长样本 40 亿个', withStbl(fullBox('stsz', 0, Buffer.concat([u32(1000), u32(0xffffffff)]))), 'stsz', parseStsz],
    ['stss 40 亿个关键帧', withStbl(fullBox('stss', 0, u32(0xffffffff))), 'stss', parseStss],
  ];

  const bad = [];
  for (const [label, buf, type, fn] of cases) {
    const b = grabBox(buf, [...STBL_PATH, type]);
    if (!b) { bad.push(`  · ${label}：盒子没找到，样本造错了`); continue; }
    const t0 = Date.now();
    let out;
    try {
      out = fn(buf, b);
    } catch (e) {
      bad.push(`  · ${label}：抛出 ${e.message}`);
      continue;
    }
    const ms = Date.now() - t0;
    const n = out?.length ?? out?.size ?? 0;
    // 表里真实能装下的条目数远小于它声称的数字，产出必须跟着真实字节数走
    if (n > 6_000_000) bad.push(`  · ${label}：产出了 ${n} 条（文件里根本没这么多字节）`);
    if (ms > BUDGET_MS) bad.push(`  · ${label}：花了 ${ms}ms`);
  }
  assert.equal(bad.length, 0, `${bad.length} 处没兜住：\n${bad.join('\n')}`);
});

test('样本表被截短时要如实报出来，不能默默当完整数据用', () => {
  // 取证结论（码率、帧率、时长）全建立在样本表上。默默用一份被截短的表
  // 算出来的数字是错的，而且错得看不出来——这比直接报错更糟。
  const buf = withStbl(
    fullBox('stts', 0, Buffer.concat([
      u32(3),
      ...Array.from({ length: 3 }, () => Buffer.concat([u32(0xffffffff), u32(40)])),
    ])),
    fullBox('stsz', 0, Buffer.concat([u32(1000), u32(0xffffffff)])),
  );
  const out = parseContainer(buf);
  assert.equal(out.ok, true);
  const track = out.tracks[0];
  assert.ok(track, '应当解析出一条轨道');

  assert.ok(track.parseWarnings.length >= 2, `应当有 stts 和 stsz 两条警告，实际：${JSON.stringify(track.parseWarnings)}`);
  assert.ok(track.parseWarnings.some((w) => w.startsWith('stts')), 'stts 的截断没报出来');
  assert.ok(track.parseWarnings.some((w) => w.startsWith('stsz')), 'stsz 的截断没报出来');
  for (const w of track.parseWarnings) {
    assert.match(w, /声称 \d+ 个样本/, `警告里要写清楚文件声称了多少：${w}`);
  }

  // 正常文件不该无端冒出警告
  const clean = withStbl(
    fullBox('stts', 0, Buffer.concat([u32(1), u32(3), u32(40)])),
    fullBox('stsz', 0, Buffer.concat([u32(0), u32(3), u32(100), u32(120), u32(90)])),
  );
  assert.deepEqual(parseContainer(clean).tracks[0].parseWarnings, [], '正常文件不该有警告');
});

test('截断警告要一路带到报告文本里，不能只留在内部结构上', async () => {
  // 警告只算做到一半：算出来了但报告里不显示，等于没有。
  // 所以这里跑**真正的 analyze()**，对着一个真的落在磁盘上的畸形文件，
  // 而不是手搓一个报告对象——手搓的话形状一旦对不上就测了个寂寞。
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cineroute-fuzz-'));
  const file = path.join(dir, 'truncated.mp4');
  try {
    await fs.writeFile(file, withStbl(
      fullBox('stts', 0, Buffer.concat([u32(1), u32(0xffffffff), u32(40)])),
    ));

    const report = await analyze(file, { skipHash: true });
    assert.equal(report.container.ok, true, `容器应当解析成功：${report.container.reason}`);

    const track = report.container.tracks[0];
    assert.ok(track, '应当有一条轨道');
    assert.ok(
      track.parseWarnings?.length > 0,
      `报告结构里应当带上截断警告，实际：${JSON.stringify(track.parseWarnings)}`,
    );

    const text = renderText(report);
    assert.ok(
      text.includes(track.parseWarnings[0]),
      `报告文本里没有这条警告：\n${text.split('\n').filter((l) => l.includes('轨')).join('\n')}`,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('表解析器：盒子小到装不下自己的头也不能崩', () => {
  const cases = [
    ['stts', parseStts], ['stsz', parseStsz], ['stss', parseStss],
  ];
  const bad = [];
  for (const [type, fn] of cases) {
    // 空盒，且刻意放在文件最末尾——读越界最容易在这儿发生
    const buf = withStbl(box(type));
    const b = grabBox(buf, [...STBL_PATH, type]);
    if (!b) { bad.push(`  · ${type}：盒子没找到`); continue; }
    try {
      fn(buf, b);
    } catch (e) {
      bad.push(`  · ${type} 空盒抛出 ${e.constructor.name}: ${e.message}`);
    }
  }
  // elst 单独造，它不在 stbl 里
  const elstBuf = mp4(box('moov', box('trak', box('edts', box('elst')))));
  const elstBox = grabBox(elstBuf, ['moov', 'trak', 'edts', 'elst']);
  if (elstBox) {
    try {
      parseElst(elstBuf, elstBox);
    } catch (e) {
      bad.push(`  · elst 空盒抛出 ${e.constructor.name}: ${e.message}`);
    }
  }
  assert.equal(bad.length, 0, `${bad.length} 处空盒把解析器打崩了：\n${bad.join('\n')}`);
});
