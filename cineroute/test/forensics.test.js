/**
 * 取证链路测试。
 *
 * 全部基于**合成 MP4**：可以精确指定"第 600 秒起插入 20 秒、码率 3 倍、
 * GOP 更短的内容"，再断言检测器在那个位置报出发现。这样验证的是检测能力，
 * 而不是"代码没崩"。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { parseContainer } from '../src/forensics/isobmff.js';
import { bitrateProfile, keyframeProfile, medianOf, robustZScores } from '../src/forensics/profile.js';
import { detectInsertedSegments, groupRuns } from '../src/forensics/anomaly.js';
import { analyzeProvenance, parseEncoderOptions } from '../src/forensics/provenance.js';
import { compareWithReference, alignProfiles, correlate, normalizeProfile } from '../src/forensics/compare.js';
import { pHash, hammingDistance, detectStaticOverlays, temporalVariance, dct2d } from '../src/forensics/frames.js';
import { analyze, renderText, parseFile } from '../src/forensics/report.js';
import { buildMp4, makeVideoSamples, deterministicVariation } from './helpers/mp4Builder.js';

const X264_TAG = 'x264 - core 164 r3095 baee400 - H.264/MPEG-4 AVC codec - '
  + 'Copyleft 2003-2023 - options: cabac=1 ref=3 deblock=1:0:0 me=hex subme=7 '
  + 'psy=1 mixed_ref=1 keyint=50 keyint_min=25 crf=21.0';

/** 一部"干净的 20 分钟正片"。 */
function cleanMovie(seed = 1) {
  return makeVideoSamples({
    durationSec: 1200, fps: 25, gopSec: 2, baseKbps: 2000,
    variation: deterministicVariation(seed),
  });
}

/** 同一部片，但第 600 秒起插了 20 秒广告（码率 3 倍、GOP 0.5s）。 */
function movieWithAd(seed = 1) {
  return makeVideoSamples({
    durationSec: 1220, fps: 25, gopSec: 2, baseKbps: 2000,
    variation: deterministicVariation(seed),
    // 广告本身也有码率起伏——真实插播不是恒定码率，恒定码率会掩盖
    // correlate 对"一侧恒定"的处理是否正确。
    inserts: [{ atSec: 600, durationSec: 20, kbpsFactor: 3, gopSec: 0.5,
                variation: deterministicVariation(4242) }],
  });
}

async function writeTemp(buf, name) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cineroute-forensics-'));
  const file = path.join(dir, name);
  await fs.writeFile(file, buf);
  return { file, dir };
}

/* ────────────────────── 容器解析 ────────────────────── */

test('解析 MP4 容器：轨道、编码、尺寸、时长、标签', () => {
  const buf = buildMp4({ video: cleanMovie(), encoderTag: X264_TAG });
  const c = parseContainer(buf);

  assert.equal(c.ok, true);
  assert.equal(c.ftyp.majorBrand, 'isom');
  assert.equal(c.tracks.length, 1);

  const v = c.tracks[0];
  assert.equal(v.handlerType, 'vide');
  assert.equal(v.name, 'VideoHandler');
  assert.deepEqual(v.codecs, ['avc1']);
  assert.equal(Math.round(v.width), 1920);
  assert.equal(Math.round(v.height), 1080);
  assert.equal(v.sampleCount, 1200 * 25);
  assert.equal(c.tags['©too'], X264_TAG);
});

test('缺少 moov 时给出可读原因而不是抛错', () => {
  const c = parseContainer(Buffer.alloc(64));
  assert.equal(c.ok, false);
  assert.match(c.reason, /moov/);
});

test('编辑列表被解析出来（裁剪痕迹）', () => {
  const buf = buildMp4({
    video: cleanMovie(),
    editList: [{ segmentDuration: 1000, mediaTime: 5000 }],
  });
  const c = parseContainer(buf);
  assert.equal(c.tracks[0].editList.length, 1);
  assert.equal(c.tracks[0].editList[0].mediaTime, 5000);
});

/* ────────────────────── 剖面还原 ────────────────────── */

test('码率剖面逐秒还原，长度与时长一致', () => {
  const track = { ...cleanMovie(), media: { timescale: 90000 }, allSync: false };
  track.syncSamples = track.syncSamples;
  const p = bitrateProfile(track, { binSec: 1 });

  assert.equal(p.bins.length, 1200);
  assert.ok(Math.abs(p.durationSec - 1200) < 1);
  const med = medianOf(p.bins.map((b) => b.kbps));
  // 基准 2000 kbps，叠加起伏与关键帧膨胀，中位应在同一量级
  assert.ok(med > 1200 && med < 4000, `中位码率 ${med} 不在预期量级`);
});

test('关键帧节奏还原：GOP 中位间隔等于设定值', () => {
  const track = { ...cleanMovie(), media: { timescale: 90000 }, allSync: false };
  const kf = keyframeProfile(track);

  assert.equal(kf.applicable, true);
  assert.ok(Math.abs(kf.median - 2) < 0.1, `实测 GOP ${kf.median}，期望 2`);
  assert.ok(kf.times.length > 500);
});

test('全同步轨（无 stss）不做 GOP 分析', () => {
  const kf = keyframeProfile({ allSync: true, syncSamples: null, sizes: [], deltas: [] });
  assert.equal(kf.applicable, false);
});

test('robustZScores 用中位数与 MAD，不被异常段本身污染', () => {
  const values = [...Array(100).fill(10), ...Array(5).fill(90)];
  const z = robustZScores(values);
  assert.ok(Math.abs(z[0]) < 1, '正常值的 z 应接近 0');
  assert.ok(z[100] > 5, '异常值应有很高的 z');
});

test('groupRuns 合并连续标记并容忍小间隙', () => {
  const flags = [false, true, true, false, true, false, false, true];
  assert.deepEqual(groupRuns(flags, 1), [{ from: 1, to: 4 }, { from: 7, to: 7 }]);
  assert.deepEqual(groupRuns(flags, 0), [{ from: 1, to: 2 }, { from: 4, to: 4 }, { from: 7, to: 7 }]);
});

/* ────────────────────── 插入段检测（无参考） ────────────────────── */

test('检出第 600 秒起的 20 秒插入段，且给出高置信度', () => {
  const track = { ...movieWithAd(), media: { timescale: 90000 }, allSync: false };
  const { findings } = detectInsertedSegments(track);

  const hit = findings.find((f) => f.startSec <= 605 && f.endSec >= 615);
  assert.ok(hit, `未检出 600–620s 的插入段，实得：${JSON.stringify(findings.map((f) => [f.startSec, f.endSec]))}`);
  assert.equal(hit.level, 'high');
  assert.ok(hit.confidence >= 0.7, `置信度 ${hit.confidence} 偏低`);
  // 码率与 GOP 两项证据都应命中
  assert.ok(hit.evidence.some((e) => e.includes('码率')));
  assert.ok(hit.evidence.some((e) => e.includes('关键帧间隔')));
});

test('干净影片不产出高置信度发现', () => {
  const track = { ...cleanMovie(), media: { timescale: 90000 }, allSync: false };
  const { findings } = detectInsertedSegments(track);
  const high = findings.filter((f) => f.level === 'high');
  assert.equal(high.length, 0, `干净样本误报：${JSON.stringify(high.map((f) => [f.startSec, f.endSec]))}`);
});

test('插入段的码率倍率被如实量化', () => {
  const track = { ...movieWithAd(), media: { timescale: 90000 }, allSync: false };
  const { findings } = detectInsertedSegments(track);
  const hit = findings.find((f) => f.startSec <= 605 && f.endSec >= 615);
  assert.ok(hit.metrics.ratio > 1.8, `实测倍率 ${hit.metrics.ratio}，期望明显大于 1`);
  assert.ok(hit.metrics.gop, '应附带 GOP 异常证据');
  assert.ok(hit.metrics.gop.innerMedianInterval < 1);
});

/* ────────────────────── 编码溯源 ────────────────────── */

test('从 ©too 标签识别 x264 并抽出编码参数', () => {
  const buf = buildMp4({ video: cleanMovie(), encoderTag: X264_TAG });
  const c = parseContainer(buf);
  const p = analyzeProvenance(c, { observedGopSec: 2, fps: 25 });

  assert.ok(p.tools.some((t) => t.tool === 'x264'));
  assert.equal(p.encoderOptions.keyint, '50');
  assert.equal(p.encoderOptions.crf, '21.0');
});

test('keyint 交叉校验：声明值与实测 GOP 一致时不报可疑', () => {
  const buf = buildMp4({ video: cleanMovie(), encoderTag: X264_TAG });
  const c = parseContainer(buf);
  // keyint=50 @ 25fps = 2s，与实测 GOP 2s 吻合
  const p = analyzeProvenance(c, { observedGopSec: 2, fps: 25 });
  const cross = p.signals.find((s) => s.key === 'keyint-crosscheck');
  assert.ok(cross);
  assert.equal(cross.suspicious, false);
});

test('keyint 交叉校验：实测 GOP 与声明值不符时判为可疑（拼接痕迹）', () => {
  const buf = buildMp4({ video: cleanMovie(), encoderTag: X264_TAG });
  const c = parseContainer(buf);
  const p = analyzeProvenance(c, { observedGopSec: 0.5, fps: 25 });
  const cross = p.signals.find((s) => s.key === 'keyint-crosscheck');
  assert.equal(cross.suspicious, true);
  assert.match(cross.note, /拼接|二次封装/);
});

test('剪辑软件签名触发 reprocessed 判定', () => {
  const buf = buildMp4({
    video: cleanMovie(),
    encoderTag: 'Adobe Premiere Pro 2024.0 (Windows)',
  });
  const p = analyzeProvenance(parseContainer(buf), {});
  assert.equal(p.reprocessed, true);
  assert.ok(p.tools.some((t) => t.kind === 'editor'));
});

test('faststart 被识别为"为网络分发重新封装过"', () => {
  const fast = analyzeProvenance(parseContainer(buildMp4({ video: cleanMovie(), faststart: true })), {});
  const slow = analyzeProvenance(parseContainer(buildMp4({ video: cleanMovie(), faststart: false })), {});

  assert.equal(fast.signals.find((s) => s.key === 'faststart').suspicious, true);
  assert.equal(slow.signals.find((s) => s.key === 'faststart').suspicious, false);
});

test('多条视频轨被标记（可能是后期叠加的画中画/水印轨）', () => {
  const p = analyzeProvenance(parseContainer(buildMp4({ video: cleanMovie(), extraVideoTrack: true })), {});
  const tracks = p.signals.find((s) => s.key === 'tracks');
  assert.equal(tracks.suspicious, true);
});

test('parseEncoderOptions 处理没有 options 段的标签', () => {
  assert.deepEqual(parseEncoderOptions('Lavf60.16.100'), {});
  assert.deepEqual(parseEncoderOptions(null), {});
});

/* ────────────────────── 与母版比对 ────────────────────── */

test('correlate：同形状高相关，反形状负相关', () => {
  const a = [1, 3, 2, 5, 4, 6];
  assert.ok(correlate(a, a) > 0.99);
  assert.ok(correlate(a, a.map((x) => -x)) < -0.99);
});

test('normalizeProfile 消除码率档位差异，只留形状', () => {
  const a = [100, 300, 200, 400];
  const b = a.map((x) => x * 4);      // 同一内容，码率翻 4 倍
  assert.ok(correlate(normalizeProfile(a), normalizeProfile(b)) > 0.99);
});

test('alignProfiles 定位插入段的位置与长度', () => {
  // 必须用**非周期**信号：正弦这类周期信号在整数倍周期处会产生伪完美对齐，
  // 拿它测对齐算法等于在测一个退化输入。
  const v = deterministicVariation(11);
  const base = Array.from({ length: 200 }, (_, i) => v(i));
  const w = deterministicVariation(77);
  const foreign = Array.from({ length: 20 }, (_, i) => 2.5 + w(i));
  const suspect = [...base.slice(0, 100), ...foreign, ...base.slice(100)];

  const r = alignProfiles(base, suspect, { window: 8, maxSkip: 60 });
  assert.ok(r.inserted >= 15 && r.inserted <= 25, `插入量 ${r.inserted}，期望约 20`);

  const ins = r.ops.find((o) => o.type === 'insert' && o.susTo - o.susFrom >= 10);
  assert.ok(ins, '应定位到插入操作');
  assert.ok(Math.abs(ins.susFrom - 100) <= 6, `插入起点 ${ins.susFrom}，期望约 100`);
});

test('母版比对：判定同一作品并定位到 600 秒处的插入内容', () => {
  const reference = parseContainer(buildMp4({ video: cleanMovie(1) }));
  const suspect = parseContainer(buildMp4({ video: movieWithAd(1) }));

  const cmp = compareWithReference(suspect, reference);

  assert.equal(cmp.ok, true);
  assert.equal(cmp.identity.verdict, 'same-work', `覆盖率 ${cmp.identity.coverage}`);
  assert.equal(cmp.durations.deltaSec, 20);

  const ins = cmp.findings.filter((f) => f.type === 'inserted-content');
  assert.ok(ins.length >= 1, '应定位到插入内容');
  const total = ins.reduce((a, f) => a + f.durationSec, 0);
  assert.ok(total >= 12 && total <= 30, `插入总时长 ${total}s，期望约 20s`);
  assert.ok(ins.some((f) => Math.abs(f.startSec - 600) <= 20), `插入起点 ${ins.map((f) => f.startSec)}，期望约 600`);
});

test('母版比对：不同作品被判为不匹配', () => {
  const reference = parseContainer(buildMp4({ video: cleanMovie(1) }));
  // 完全不同的码率曲线 = 另一部片
  const other = parseContainer(buildMp4({
    video: makeVideoSamples({
      durationSec: 1200, fps: 25, gopSec: 3, baseKbps: 2600,
      variation: deterministicVariation(9137),
    }),
  }));

  const cmp = compareWithReference(other, reference);
  assert.notEqual(cmp.identity.verdict, 'same-work', `覆盖率 ${cmp.identity.coverage} 过高`);
});

test('母版比对记录分辨率与编码格式差异', () => {
  const reference = parseContainer(buildMp4({ video: cleanMovie(1) }));
  const suspect = parseContainer(buildMp4({
    video: cleanMovie(1), width: 1280, height: 720, codec: 'hev1',
  }));

  const cmp = compareWithReference(suspect, reference);
  assert.ok(cmp.structural.some((s) => s.key === 'resolution' && s.suspicious));
  assert.ok(cmp.structural.some((s) => s.key === 'codec' && s.suspicious));
});

/* ────────────────────── 帧级分析（纯 JS 部分） ────────────────────── */

test('dct2d 对常量图像只在 DC 分量有能量', () => {
  const N = 8;
  const flat = new Uint8Array(N * N).fill(128);
  const c = dct2d(flat, N);
  assert.ok(Math.abs(c[0]) > 1000, 'DC 分量应很大');
  for (let i = 1; i < N; i += 1) {
    assert.ok(Math.abs(c[i]) < 1e-6, `AC 分量 ${i} 应接近 0`);
  }
});

test('pHash：同一画面距离为 0，不同画面距离显著', () => {
  const N = 32;
  const a = new Uint8Array(N * N);
  const b = new Uint8Array(N * N);
  for (let i = 0; i < N * N; i += 1) {
    a[i] = (i * 7) % 256;
    b[i] = (i % N) < N / 2 ? 20 : 230;
  }
  assert.equal(hammingDistance(pHash(a), pHash(a)), 0);
  assert.ok(hammingDistance(pHash(a), pHash(b)) > 10);
});

test('pHash 对整体亮度变化免疫（中位数阈值）', () => {
  const N = 32;
  const a = new Uint8Array(N * N);
  for (let i = 0; i < N * N; i += 1) a[i] = 40 + ((i * 3) % 120);
  const brighter = a.map((v) => Math.min(255, v + 40));
  assert.ok(hammingDistance(pHash(a), pHash(Uint8Array.from(brighter))) <= 4);
});

test('temporalVariance 对恒定像素给 0，对跳变像素给正值', () => {
  const frames = [
    Uint8Array.from([10, 0]),
    Uint8Array.from([10, 200]),
    Uint8Array.from([10, 0]),
    Uint8Array.from([10, 200]),
  ];
  const v = temporalVariance(frames, 2, 1);
  assert.equal(v[0], 0);
  assert.ok(v[1] > 1000);
});

test('检出角落里的静态叠加物（台标/水印）', () => {
  const W = 64;
  const H = 36;
  const frames = [];
  // 8 个"不同场景"的帧：整体像素随机变化，唯独左上角一块恒定
  for (let f = 0; f < 8; f += 1) {
    const fr = new Uint8Array(W * H);
    for (let i = 0; i < fr.length; i += 1) fr[i] = (i * 13 + f * 97) % 256;
    for (let y = 2; y < 9; y += 1) {
      for (let x = 2; x < 14; x += 1) fr[y * W + x] = 240;
    }
    frames.push(fr);
  }

  const r = detectStaticOverlays(frames, W, H, { varianceThreshold: 12 });
  assert.equal(r.ok, true);
  assert.ok(r.regions.length >= 1, '应检出至少一处静态区域');

  const top = r.regions[0];
  assert.equal(top.position, '上左');
  assert.ok(top.rect.x < 0.2 && top.rect.y < 0.3);
  assert.ok(top.confidence >= 0.8);
});

test('全画面都在变化时不误报叠加物', () => {
  const W = 64;
  const H = 36;
  const frames = Array.from({ length: 8 }, (_, f) => {
    const fr = new Uint8Array(W * H);
    for (let i = 0; i < fr.length; i += 1) fr[i] = (i * 29 + f * 61) % 256;
    return fr;
  });
  const r = detectStaticOverlays(frames, W, H);
  assert.equal(r.regions.length, 0);
});

test('采样帧不足时明确拒绝，而不是给出不可靠结论', () => {
  const r = detectStaticOverlays([new Uint8Array(4), new Uint8Array(4)], 2, 2);
  assert.equal(r.ok, false);
  assert.match(r.reason, /采样帧不足/);
});

/* ────────────────────── 端到端报告 ────────────────────── */

test('端到端：分析真实落盘文件，产出证据级报告', async (t) => {
  const { file, dir } = await writeTemp(
    buildMp4({ video: movieWithAd(1), encoderTag: X264_TAG }), 'suspect.mp4');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const report = await analyze(file);

  // 证据固化
  assert.match(report.subject.sha256, /^[0-9a-f]{64}$/);
  assert.match(report.subject.md5, /^[0-9a-f]{32}$/);
  assert.ok(report.subject.bytes > 0);
  assert.ok(report.analyzedAt);

  // 结论
  assert.equal(report.verdict.level, 'tampered');
  assert.ok(report.tamper.findings.some((f) => f.level === 'high'));
  assert.ok(report.provenance.tools.some((tl) => tl.tool === 'x264'));

  // 文本报告可渲染且含关键信息
  const text = renderText(report);
  assert.match(text, /视频取证报告/);
  assert.match(text, /SHA-256/);
  assert.match(text, /00:10:0\d/);        // 600 秒 ≈ 00:10:00
});

test('端到端：干净文件不被判为已加工', async (t) => {
  const { file, dir } = await writeTemp(
    buildMp4({ video: cleanMovie(1), encoderTag: X264_TAG, faststart: false }), 'clean.mp4');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const report = await analyze(file);
  assert.notEqual(report.verdict.level, 'tampered');
  assert.equal(report.tamper.findings.filter((f) => f.level === 'high').length, 0);
});

test('端到端：带参考母版时定位插入段并写入报告', async (t) => {
  const a = await writeTemp(buildMp4({ video: cleanMovie(1) }), 'master.mp4');
  const b = await writeTemp(buildMp4({ video: movieWithAd(1) }), 'suspect.mp4');
  t.after(async () => {
    await fs.rm(a.dir, { recursive: true, force: true });
    await fs.rm(b.dir, { recursive: true, force: true });
  });

  const report = await analyze(b.file, { referencePath: a.file, skipHash: true });

  assert.equal(report.comparison.ok, true);
  assert.equal(report.comparison.identity.verdict, 'same-work');
  assert.equal(report.verdict.level, 'tampered');
  assert.ok(report.verdict.reasons.some((r) => r.includes('插入内容')));

  const text = renderText(report);
  assert.match(text, /与参考母版比对/);
});

test('只读 ftyp+moov：不把整片读进内存', async (t) => {
  // mdat 放大到 4MB，parseFile 仍应正常且不依赖它
  const video = cleanMovie(1);
  const base = buildMp4({ video });
  const padded = Buffer.concat([base, Buffer.alloc(4 * 1024 * 1024, 0x22)]);
  const { file, dir } = await writeTemp(padded, 'big.mp4');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const c = await parseFile(file);
  assert.equal(c.ok, true);
  assert.equal(c.tracks[0].sampleCount, 1200 * 25);
  assert.ok(c.fileSize > 4 * 1024 * 1024);
});

test('非 MP4 文件给出可操作的提示而不是崩溃', async (t) => {
  const { file, dir } = await writeTemp(Buffer.from('not a video at all'), 'x.mkv');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const report = await analyze(file, { skipHash: true });
  assert.equal(report.container.ok, false);
  assert.match(report.container.reason, /MKV|ffprobe|moov/);
  assert.equal(report.verdict.level, 'unknown');
});
