/**
 * 「有效视频」的初步判断：只看时长和体积。
 *
 * 这一步的价值在于**它能抓到别的规则全都抓不到的东西**：数字对不上的文件。
 * 声称 90 分钟、实际 48 MB 的那种，容器是正经 mp4、Content-Type 是
 * video/mp4、Content-Length 也真的就是那么大、文件名规规矩矩——
 * 前面每一道闸都放它过去，只有把时长和体积除一下才露馅。
 *
 * 所以用例的重点不是"能算码率"，是**这几类坏法都得被认出来**，
 * 并且"有效"与"正片"分开报——预告片是有效视频，只是不够长。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyVideo, summarizeVideos, FEATURE_MIN_SEC } from '../src/core/videoSanity.js';

const src = (durationSec, bytes, filename = 'x.mp4') => ({ filename, durationSec, bytes });
const MB = 1024 * 1024;
const GB = 1024 * MB;

test('正常的正片：有效，且够正片长度', () => {
  // 96 分钟 · 1.1 GB · 1643 kbps —— archive.org 上一个很典型的公有领域长片
  const v = classifyVideo(src(5754, 1181745152));
  assert.equal(v.verdict, 'valid');
  assert.equal(v.feature, true);
  assert.ok(Math.abs(v.kbps - 1643) < 5, `码率算错了：${v.kbps}`);
});

test('预告片是**有效视频**，只是够不上正片——两件事不能混着报', () => {
  const v = classifyVideo(src(152, 48234496));
  assert.equal(v.verdict, 'valid', '2 分半 2539 kbps 是个完好的视频文件');
  assert.equal(v.feature, false);
  assert.match(v.reason, /够不上正片长度/);
  // 时长文案不能把 2.5 分钟四舍五入成 3 分钟，那会让人以为它比实际长
  assert.match(v.reason, /2\.5 分钟/);
});

test('码率过低 = 残片或纯音轨，必须判无效', () => {
  // 这是最要命的一种：90 分钟只有 48 MB。前面每一道闸都拦不住它。
  const v = classifyVideo(src(5400, 48 * MB));
  assert.equal(v.verdict, 'invalid');
  assert.ok(v.kbps < 150, `码率应当很低：${v.kbps}`);
  assert.match(v.reason, /放不出画面/);
});

test('码率过高 = 母版扫描，不是发行副本', () => {
  const v = classifyVideo(src(120, 8 * GB));
  assert.equal(v.verdict, 'invalid');
  assert.match(v.reason, /母版/);
});

test('文件小到不可能是视频、短到不算一个视频', () => {
  assert.match(classifyVideo(src(5400, 400_000)).reason, /没真的传上去/);
  assert.match(classifyVideo(src(12, 5 * MB)).reason, /是片段不是视频/);
});

test('缺数据时**不猜**，如实报判不了', () => {
  // 归档站上确实有一批条目不给时长。算成"有效"或"无效"都是在编。
  for (const s of [src(null, 900_000_000), src(5400, null), src(null, null)]) {
    const v = classifyVideo(s);
    assert.equal(v.verdict, 'unknown');
    assert.equal(v.kbps, null);
  }
  assert.match(classifyVideo(src(null, 9e8)).reason, /没给时长/);
  assert.match(classifyVideo(src(5400, null)).reason, /没给体积/);
});

test('正片门槛卡在 40 分钟：差一秒就不是正片', () => {
  // 40 分钟是电影艺术与科学学院区分 feature / short 的线
  const big = 500 * MB;
  assert.equal(classifyVideo(src(FEATURE_MIN_SEC, big)).feature, true);
  assert.equal(classifyVideo(src(FEATURE_MIN_SEC - 1, big)).feature, false);
});

test('汇总：正片是"有效"的子集，不是并列的一类', () => {
  const s = summarizeVideos([
    src(5754, 1181745152, 'feature.mp4'),   // 有效 + 正片
    src(152, 48234496, 'trailer.mp4'),      // 有效，非正片
    src(5400, 48 * MB, 'stub.mp4'),         // 无效
    src(null, 9e8, 'nodur.mp4'),            // 判不了
  ]);
  assert.equal(s.total, 4);
  assert.equal(s.valid, 2, '预告片也算有效视频');
  assert.equal(s.feature, 1, '正片只有一条');
  assert.equal(s.invalid, 1);
  assert.equal(s.unknown, 1);
  // 三类加起来必须等于总数，否则报表上会对不上账
  assert.equal(s.valid + s.invalid + s.unknown, s.total);
  assert.ok(s.feature <= s.valid, '正片数不可能超过有效数');
});

test('空输入不炸', () => {
  const s = summarizeVideos([]);
  assert.deepEqual([s.total, s.valid, s.feature, s.invalid, s.unknown], [0, 0, 0, 0, 0]);
  assert.deepEqual(summarizeVideos().items, []);
});
