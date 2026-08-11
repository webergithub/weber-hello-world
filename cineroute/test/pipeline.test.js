/**
 * 端到端管线测试。
 *
 * 这里刻意**不** mock 适配器：夹具喂进去的是真实形状的上游响应，
 * 走的是真实的解析 → 去重 → 打分 → 排序代码路径。
 * 换句话说，这些用例验证的是线上会跑的那套逻辑，只是把网络换成了磁盘。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { searchAll, dedupeSources } from '../src/core/pipeline.js';
import { createFixtureFetch, createFixtureProbe } from '../src/core/fixtureFetch.js';

const offline = () => ({
  fetchJson: createFixtureFetch(),
  probeFn: createFixtureProbe(),
});

test('端到端：Top5 按可播性与画质排序，最优解是 1080p MP4', async () => {
  const r = await searchAll('Night of the Living Dead', offline());

  assert.equal(r.top.length, 5);
  assert.equal(r.top[0].filename, 'notld_restored_1080p.mp4');
  assert.equal(r.top[0].container, 'mp4');
  assert.equal(r.top[0].height, 1080);
  assert.equal(r.top[0].rank, 1);

  // 分数单调不增
  const scores = r.top.map((s) => s.score);
  assert.deepEqual([...scores].sort((a, b) => b - a), scores);
});

test('端到端：无 TMDB key 时用候选时长中位数推定片长，仍能挡住预告片', async () => {
  const r = await searchAll('Night of the Living Dead', offline());

  assert.equal(r.title.runtimeSource, 'median');
  assert.equal(r.title.runtimeSec, 5754);   // 96 分钟

  const topNames = r.top.map((s) => s.filename);
  assert.ok(!topNames.some((n) => n.includes('trailer')), '预告片不应出现在 Top5');
  assert.ok(!topNames.some((n) => n.includes('behind_the_scenes')), '幕后花絮不应出现在 Top5');
});

test('端到端：不可播容器进备选区并给出原因，且仍标记为可下载', async () => {
  const r = await searchAll('Night of the Living Dead', offline());

  const mkv = r.alternatives.find((s) => s.container === 'mkv');
  assert.ok(mkv, '应有 MKV 备选');
  assert.match(mkv.blockReason, /Matroska/);
  assert.equal(mkv.downloadable, true);

  const mpg = r.alternatives.find((s) => s.container === 'mpg');
  assert.ok(mpg, '应有 MPEG2 备选');
});

test('端到端：非视频文件（缩略图/元数据/动图）被过滤掉', async () => {
  const r = await searchAll('Night of the Living Dead', offline());
  const all = [...r.top, ...r.alternatives].map((s) => s.filename);
  for (const junk of ['__ia_thumb.jpg', 'night_of_the_living_dead_meta.xml', 'night_of_the_living_dead.gif']) {
    assert.ok(!all.includes(junk), `${junk} 不应被当作片源`);
  }
});

test('端到端：多个数据源的结果合并进同一个排名', async () => {
  const r = await searchAll('Metropolis 1927', offline());

  const providers = new Set([...r.top, ...r.alternatives].map((s) => s.provider));
  assert.ok(providers.has('internet-archive'), '应含 Internet Archive 片源');
  assert.ok(providers.has('wikimedia-commons'), '应含 Wikimedia Commons 片源');

  // 查询里的年份被解析出来
  assert.equal(r.query.year, 1927);
  assert.equal(r.query.title, 'Metropolis');
});

test('端到端：配置 TMDB 后使用权威片长并返回正版观看渠道', async (t) => {
  const prev = process.env.TMDB_API_KEY;
  process.env.TMDB_API_KEY = 'fixture-key';
  t.after(() => {
    if (prev === undefined) delete process.env.TMDB_API_KEY;
    else process.env.TMDB_API_KEY = prev;
  });

  const r = await searchAll('Night of the Living Dead', offline());

  assert.equal(r.title.runtimeSource, 'tmdb');
  assert.equal(r.title.runtimeSec, 96 * 60);
  assert.equal(r.title.name, '活死人之夜');

  assert.ok(r.offers.length > 0, '应返回正版观看渠道');
  const free = r.offers.filter((o) => o.type === 'free').map((o) => o.providerName);
  assert.ok(free.includes('Tubi TV'), '应含免费正版渠道 Tubi TV');
  // 正版渠道只给落地页，绝不产出视频直链
  for (const o of r.offers) {
    assert.ok(!/\.(mp4|m3u8|mkv|webm)(\?|$)/i.test(o.link || ''), '正版渠道不应包含视频文件地址');
  }
});

test('单一数据源失败不影响整次检索', async () => {
  const fixture = createFixtureFetch();
  const flaky = async (url, opts) => {
    if (String(url).includes('commons.wikimedia.org')) throw new Error('模拟上游 500');
    return fixture(url, opts);
  };

  const r = await searchAll('Metropolis 1927', { fetchJson: flaky, probeFn: createFixtureProbe() });

  assert.ok(r.top.length > 0, 'Internet Archive 的结果仍应正常返回');
  const commons = r.providers.find((p) => p.id === 'wikimedia-commons');
  assert.equal(commons.status, 'error');
  assert.match(commons.reason, /模拟上游 500/);
});

test('查不到时优雅返回空结果而不是抛错', async () => {
  const r = await searchAll('A Film That Does Not Exist At All', offline());
  assert.equal(r.top.length, 0);
  assert.equal(r.alternatives.length, 0);
  assert.ok(Array.isArray(r.providers));
});

test('dedupeSources 按校验和合并镜像文件', () => {
  const out = dedupeSources([
    { url: 'https://a/x.mp4', checksums: { md5: 'same' }, height: null, durationSec: null, bytes: null },
    { url: 'https://b/x.mp4', checksums: { md5: 'same' }, height: 1080, durationSec: 5760, bytes: 1000 },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].height, 1080, '应保留信息更完整的那条');
  assert.equal(out[0].mirrors, 1);
});

test('dedupeSources 无校验和时按 URL 去重', () => {
  const out = dedupeSources([
    { url: 'https://a/x.mp4', checksums: {} },
    { url: 'https://a/x.mp4', checksums: {} },
    { url: 'https://a/y.mp4', checksums: {} },
  ]);
  assert.equal(out.length, 2);
});

test('检索统计如实反映漏斗各级数量', async () => {
  const r = await searchAll('Night of the Living Dead', offline());
  assert.equal(r.stats.rawCandidates, r.stats.afterDedupe);
  assert.equal(r.stats.blocked, r.alternatives.length);
  assert.ok(r.stats.playable >= r.top.length);
});
