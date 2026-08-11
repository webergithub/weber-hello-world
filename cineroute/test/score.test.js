import test from 'node:test';
import assert from 'node:assert/strict';
import {
  scoreSource, rankSources, estimateReferenceRuntime, detectContainer, WEIGHTS,
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
