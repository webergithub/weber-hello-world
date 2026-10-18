import test from 'node:test';
import assert from 'node:assert/strict';
import {
  scoreSource, rankSources, estimateReferenceRuntime, detectContainer, WEIGHTS,
  resolveWeights, computeMaxDuration,
} from '../src/core/score.js';

/** 一个各项都健康的基准片源，测试里按需覆盖单个字段。 */
const base = {
  id: 's1',
  provider: 'internet-archive',
  filename: 'feature.mp4',
  title: 'Feature Film',
  url: 'https://archive.org/download/x/feature.mp4',
  container: 'mp4',
  width: 1440, height: 1080,
  durationSec: 5760, bytes: 2_000_000_000,
  license: 'http://creativecommons.org/publicdomain/mark/1.0/',
  collections: ['feature_films'],
  downloads: 500_000,
  rangeSupported: true,
  checksums: { md5: 'abc' },
};

test('detectContainer 能从 URL 后缀兜底推断容器', () => {
  assert.equal(detectContainer({ url: 'https://x/y/z.webm' }), 'webm');
  assert.equal(detectContainer({ container: 'MP4', url: 'https://x/y' }), 'mp4');
  assert.equal(detectContainer({ url: 'https://x/y/no-extension' }), '');
});

test('各维度权重之和为 100', () => {
  assert.equal(Object.values(WEIGHTS).reduce((a, b) => a + b, 0), 100);
});

test('健康的 MP4 片源拿到接近满分且不被拦截', () => {
  const s = scoreSource(base, { referenceRuntimeSec: 5760 });
  assert.equal(s.blocked, false);
  assert.ok(s.score >= 90, `期望 ≥90，实际 ${s.score}`);
});

test('MKV 触发硬门槛：不进 Top5，但仍可下载', () => {
  const s = scoreSource({ ...base, container: 'mkv', filename: 'feature.mkv' }, { referenceRuntimeSec: 5760 });
  assert.equal(s.blocked, true);
  assert.match(s.blockReason, /Matroska/);
  assert.equal(s.downloadable, true);
});

test('时长远短于参考片长的片段被判为非正片', () => {
  const s = scoreSource({ ...base, durationSec: 142, bytes: 30_000_000 }, { referenceRuntimeSec: 5760 });
  assert.equal(s.blocked, true);
  assert.match(s.blockReason, /片段或预告/);
});

test('文件名含 trailer 的片源被判为非正片', () => {
  const s = scoreSource({ ...base, filename: 'feature_trailer.mp4' }, { referenceRuntimeSec: 5760 });
  assert.equal(s.blocked, true);
  assert.match(s.blockReason, /trailer/);
});

test('探测不可达的片源既不可播也不可下载', () => {
  const s = scoreSource({ ...base, reachable: false }, { referenceRuntimeSec: 5760 });
  assert.equal(s.blocked, true);
  assert.equal(s.downloadable, false);
});

test('可播性优先于清晰度：480p 的 MP4 排在 1080p 的 MKV 之前', () => {
  const { top, alternatives } = rankSources([
    { ...base, id: 'mkv-1080', container: 'mkv', filename: 'a.mkv' },
    { ...base, id: 'mp4-480', container: 'mp4', filename: 'b.mp4', width: 640, height: 480, bytes: 700_000_000 },
  ], { referenceRuntimeSec: 5760 });

  assert.equal(top.length, 1);
  assert.equal(top[0].id, 'mp4-480');
  assert.equal(alternatives[0].id, 'mkv-1080');
});

test('同为可播容器时，清晰度更高的排前面', () => {
  const { top } = rankSources([
    { ...base, id: 'low', width: 320, height: 240, bytes: 200_000_000 },
    { ...base, id: 'high' },
  ], { referenceRuntimeSec: 5760 });
  assert.equal(top[0].id, 'high');
  assert.equal(top[0].rank, 1);
});

test('不支持 Range 会被扣分（拖不动进度条、下载不可续传）', () => {
  const withRange = scoreSource(base, { referenceRuntimeSec: 5760 });
  const without = scoreSource({ ...base, rangeSupported: false }, { referenceRuntimeSec: 5760 });
  assert.ok(without.score < withRange.score);
  assert.match(without.breakdown[0].reason, /不支持 Range/);
});

test('明文 HTTP 被扣分（HTTPS 页面内会被混合内容拦截）', () => {
  const https = scoreSource(base, {});
  const http = scoreSource({ ...base, url: base.url.replace('https:', 'http:') }, {});
  assert.ok(http.score < https.score);
});

test('rankSources 限制 Top N，其余进 overflow', () => {
  const many = Array.from({ length: 8 }, (_, i) => ({ ...base, id: `s${i}`, height: 1080 - i * 60 }));
  const { top, overflow } = rankSources(many, { referenceRuntimeSec: 5760, limit: 5 });
  assert.equal(top.length, 5);
  assert.equal(overflow.length, 3);
  assert.deepEqual(top.map((s) => s.rank), [1, 2, 3, 4, 5]);
});

test('estimateReferenceRuntime 取中位数，正片数量占优时能压过片段', () => {
  // 三个正片副本 + 两个短片段，中位数应落在正片时长上。
  const sources = [
    { durationSec: 5754 }, { durationSec: 5760 }, { durationSec: 5766 },
    { durationSec: 142 }, { durationSec: 743 },
  ];
  assert.equal(estimateReferenceRuntime(sources), 5754);
});

test('estimateReferenceRuntime 在无时长数据时返回 null', () => {
  assert.equal(estimateReferenceRuntime([{ durationSec: null }, {}]), null);
});

test('打分明细对每个维度都给出可展示的理由', () => {
  const s = scoreSource(base, { referenceRuntimeSec: 5760 });
  assert.equal(s.breakdown.length, 6);
  for (const d of s.breakdown) {
    assert.ok(d.label && d.reason, `维度 ${d.key} 缺少 label/reason`);
    assert.ok(d.score <= d.max, `维度 ${d.key} 得分超过上限`);
  }
});

/* ── 排序偏好：清晰度优先、同清晰度下更长的胜出 ───────────────── */

test('清晰度优先：1080p 排在 720p 之前，即使 720p 更长', () => {
  const { top } = rankSources([
    { ...base, id: 'p720-long', width: 960, height: 720, durationSec: 6200, bytes: 1_200_000_000 },
    { ...base, id: 'p1080', width: 1440, height: 1080, durationSec: 5760, bytes: 2_000_000_000 },
  ], { referenceRuntimeSec: 5760, maxDurationSec: 6200 });

  assert.equal(top[0].id, 'p1080');
});

test('同清晰度下更长的版本胜出（未删减版偏好）', () => {
  const { top } = rankSources([
    { ...base, id: 'short-cut', durationSec: 4900, bytes: 1_700_000_000 },
    { ...base, id: 'full-cut', durationSec: 5760, bytes: 2_000_000_000 },
  ], { referenceRuntimeSec: 5760, maxDurationSec: 5760 });

  assert.equal(top[0].id, 'full-cut');
  assert.ok(top[0].score > top[1].score);
});

test('长于参考片长不再被扣分（可能是未删减版/修复加长版）', () => {
  const exact = scoreSource({ ...base, durationSec: 5760 }, { referenceRuntimeSec: 5760, maxDurationSec: 6400 });
  const longer = scoreSource({ ...base, durationSec: 6400 }, { referenceRuntimeSec: 5760, maxDurationSec: 6400 });

  const dimOf = (s) => s.breakdown.find((d) => d.key === 'completeness');
  assert.ok(dimOf(longer).score >= dimOf(exact).score, '更长的版本不应比刚好等于片长的低');
  assert.match(dimOf(longer).reason, /未删减版|加长版/);
});

test('极短片段仍被判为非正片，长度偏好不能救它', () => {
  const s = scoreSource({ ...base, durationSec: 142 }, { referenceRuntimeSec: 5760, maxDurationSec: 5760 });
  assert.equal(s.blocked, true);
  assert.match(s.blockReason, /片段或预告/);
});

test('清晰度与完整度合计权重高于可播性，主导都能播时的排序', () => {
  const w = resolveWeights();
  assert.ok(w.resolution + w.completeness > w.playability,
    `期望 ${w.resolution}+${w.completeness} > ${w.playability}`);
});

test('resolveWeights 支持覆盖，且未指定的维度沿用默认', () => {
  const w = resolveWeights({ resolution: 40 });
  assert.equal(w.resolution, 40);
  assert.equal(w.playability, WEIGHTS.playability);
});

test('覆盖权重后打分上限随之改变', () => {
  const s = scoreSource(base, { referenceRuntimeSec: 5760, weights: { resolution: 40 } });
  const res = s.breakdown.find((d) => d.key === 'resolution');
  assert.equal(res.max, 40);
});

test('computeMaxDuration 忽略远超片长的合集，避免拉低正片的长度分', () => {
  const sources = [
    { durationSec: 5760 }, { durationSec: 5766 }, { durationSec: 30000 },
  ];
  assert.equal(computeMaxDuration(sources, 5760), 5766);
});

test('computeMaxDuration 在无参考片长时取全局最大', () => {
  assert.equal(computeMaxDuration([{ durationSec: 100 }, { durationSec: 900 }], null), 900);
});
