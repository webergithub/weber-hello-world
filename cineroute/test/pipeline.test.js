/**
 * 端到端管线测试。
 *
 * 这里刻意**不** mock 适配器：夹具喂进去的是真实形状的上游响应，
 * 走的是真实的解析 → 去重 → 打分 → 排序代码路径。
 * 换句话说，这些用例验证的是线上会跑的那套逻辑，只是把网络换成了磁盘。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { searchAll, dedupeSources, buildRecommendations } from '../src/core/pipeline.js';
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

/* ── 推荐位：前 3 直连、第 4/5 正版订阅付费 ───────────────────── */

test('配置正版渠道后，推荐位为 3 条直连 + 2 条订阅/付费', async (t) => {
  const prev = process.env.TMDB_API_KEY;
  process.env.TMDB_API_KEY = 'fixture-key';
  t.after(() => {
    if (prev === undefined) delete process.env.TMDB_API_KEY;
    else process.env.TMDB_API_KEY = prev;
  });

  const r = await searchAll('Night of the Living Dead', offline());

  assert.equal(r.recommendations.length, 5);
  assert.deepEqual(r.recommendations.map((x) => x.rank), [1, 2, 3, 4, 5]);
  assert.deepEqual(r.recommendations.map((x) => x.kind),
    ['direct', 'direct', 'direct', 'offer', 'offer']);
  assert.equal(r.stats.recommendedDirect, 3);
  assert.equal(r.stats.recommendedOffers, 2);

  // 前三位必须带可播直链
  for (const rec of r.recommendations.slice(0, 3)) {
    assert.ok(rec.source?.url, '直连推荐位必须有播放地址');
    assert.equal(rec.source.blocked, false);
  }
  // 第 4/5 位是渠道，没有也不应该有文件地址
  for (const rec of r.recommendations.slice(3)) {
    assert.ok(rec.offer?.providerName);
    assert.equal(rec.source, undefined);
    assert.ok(!/\.(mp4|mkv|webm|m3u8)(\?|$)/i.test(rec.offer.link || ''));
  }
});

test('推荐位 4/5 优先给订阅，而不是免费广告渠道', async (t) => {
  const prev = process.env.TMDB_API_KEY;
  process.env.TMDB_API_KEY = 'fixture-key';
  t.after(() => {
    if (prev === undefined) delete process.env.TMDB_API_KEY;
    else process.env.TMDB_API_KEY = prev;
  });

  const r = await searchAll('Night of the Living Dead', offline());
  const offerTypes = r.recommendations.filter((x) => x.kind === 'offer').map((x) => x.access);
  assert.deepEqual(offerTypes, ['flatrate', 'flatrate']);
});

test('没有正版渠道时，推荐位用更多直连片源补满', async () => {
  const r = await searchAll('Night of the Living Dead', offline());

  assert.equal(r.recommendations.length, 5);
  assert.ok(r.recommendations.every((x) => x.kind === 'direct'));
  assert.equal(r.stats.recommendedOffers, 0);
  assert.ok(r.notes.some((n) => n.includes('推荐位 4-5 已用可直接播放的片源补齐')));
});

test('推荐位内的直连片源按清晰度降序', async () => {
  const r = await searchAll('Night of the Living Dead', offline());
  const heights = r.recommendations
    .filter((x) => x.kind === 'direct')
    .map((x) => x.source.height);
  assert.deepEqual([...heights].sort((a, b) => b - a), heights, `实际次序：${heights.join(', ')}`);
});

test('推荐位第一条是分辨率最高的可播片源', async () => {
  const r = await searchAll('Night of the Living Dead', offline());
  assert.equal(r.recommendations[0].source.height, 1080);
  assert.equal(r.recommendations[0].source.container, 'mp4');
});

test('buildRecommendations 在直连不足 3 条时让正版渠道往前顶', () => {
  const recs = buildRecommendations(
    [{ id: 'only', url: 'https://x/a.mp4' }],
    [
      { type: 'flatrate', typeLabel: '订阅可看', providerName: 'A' },
      { type: 'rent', typeLabel: '租赁', providerName: 'B' },
      { type: 'buy', typeLabel: '购买', providerName: 'C' },
      { type: 'free', typeLabel: '免费可看', providerName: 'D' },
      { type: 'ads', typeLabel: '广告免费', providerName: 'E' },
    ],
  );
  assert.equal(recs.length, 5);
  assert.deepEqual(recs.map((r) => r.kind), ['direct', 'offer', 'offer', 'offer', 'offer']);
  // 订阅 → 租赁 → 购买 → 广告 → 免费
  assert.deepEqual(recs.slice(1).map((r) => r.offer.providerName), ['A', 'B', 'C', 'E']);
});

test('buildRecommendations 按平台去重，保留优先级最高的那条', () => {
  const recs = buildRecommendations([], [
    { type: 'buy', typeLabel: '购买', providerName: 'Apple TV' },
    { type: 'flatrate', typeLabel: '订阅可看', providerName: 'Apple TV' },
  ]);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].access, 'flatrate');
  assert.equal(recs[0].offer.providerName, 'Apple TV');
});

test('两边都空时推荐位为空，而不是抛错', () => {
  assert.deepEqual(buildRecommendations([], []), []);
});

/* ── 配置驱动的来源范围 ───────────────────────────────────── */

import { normalizeConfig, defaultConfig } from '../src/core/sourceConfig.js';
import { FIXTURE_SERP_ENV } from '../src/core/fixtureFetch.js';

/** 在夹具 SERP 环境下跑一段代码，跑完把 env 还原。 */
async function withFixtureSerp(fn) {
  const prev = { ...process.env };
  Object.assign(process.env, FIXTURE_SERP_ENV);
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(FIXTURE_SERP_ENV)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

test('关掉的来源不参与检索，勾上的才跑', async () => {
  const config = normalizeConfig({
    sources: [
      { id: 'internet-archive', type: 'builtin', enabled: true, limit: 8 },
      { id: 'wikimedia-commons', type: 'builtin', enabled: false, limit: 20 },
      { id: 'tmdb', type: 'builtin', enabled: false, limit: 1 },
    ],
  });
  const r = await searchAll('Night of the Living Dead', { ...offline(), config });

  assert.deepEqual(r.providers.map((p) => p.id), ['internet-archive']);
  assert.ok(r.top.length > 0, '关掉其他源不影响剩下那个源出结果');
});

test('每个来源按自己配置的数量取，数量写在结果里可核对', async () => {
  const config = normalizeConfig({
    sources: [
      { id: 'internet-archive', type: 'builtin', enabled: true, limit: 2 },
      { id: 'wikimedia-commons', type: 'builtin', enabled: true, limit: 5 },
    ],
  });
  const r = await searchAll('Night of the Living Dead', { ...offline(), config });

  const ia = r.providers.find((p) => p.id === 'internet-archive');
  const commons = r.providers.find((p) => p.id === 'wikimedia-commons');
  assert.equal(ia.limit, 2);
  assert.equal(commons.limit, 5);
});

test('引擎来源产出的片源与专用源同台竞争，重复的会被合并', async () => {
  await withFixtureSerp(async () => {
    const config = normalizeConfig({
      sources: [
        { id: 'internet-archive', type: 'builtin', enabled: true, limit: 8 },
        { id: 'engine:google', type: 'engine', engine: 'google', enabled: true, limit: 100 },
        { id: 'engine:baidu', type: 'engine', engine: 'baidu', enabled: true, limit: 100 },
      ],
    });
    const r = await searchAll('Night of the Living Dead', { ...offline(), config });

    const google = r.providers.find((p) => p.id === 'engine:google');
    assert.equal(google.status, 'ok');
    assert.ok(google.count > 0, 'Google 应解析出片源');
    assert.equal(google.limit, 100);

    // 三个源报出的候选远多于去重后的数量 —— 说明跨源去重真的在起作用
    assert.ok(r.stats.rawCandidates > r.stats.afterDedupe);
    assert.equal(r.top[0].filename, 'notld_restored_1080p.mp4', '接入引擎后排序结论不变');
  });
});

test('引擎按配置的数量翻页，改小数量就少要几条', async () => {
  await withFixtureSerp(async () => {
    const config = normalizeConfig({
      sources: [{ id: 'engine:google', type: 'engine', engine: 'google', enabled: true, limit: 3 }],
    });
    const r = await searchAll('Night of the Living Dead', { ...offline(), config });
    const google = r.providers.find((p) => p.id === 'engine:google');
    assert.equal(google.stats.limit, 3);
    assert.equal(google.stats.returned, 3, '只取前 3 条');
  });
});

test('引擎搜到但没有解析器的域名，只作为线索列出，不产出可播地址', async () => {
  await withFixtureSerp(async () => {
    const config = normalizeConfig({
      sources: [{ id: 'engine:google', type: 'engine', engine: 'google', enabled: true, limit: 100 }],
    });
    const r = await searchAll('Night of the Living Dead', { ...offline(), config });

    assert.ok(r.leads.length > 0, '应如实列出未解析的页面');
    const leadUrls = new Set(r.leads.map((l) => l.url));
    // 线索里的地址绝不能同时出现在可播/备选列表里
    for (const s of [...r.top, ...r.alternatives]) {
      assert.ok(!leadUrls.has(s.url), `线索地址 ${s.url} 不该进入片源列表`);
    }
    assert.ok(r.notes.some((n) => n.includes('没有对应的解析器')));
  });
});

test('未配置 SERP 服务时引擎被跳过，其余来源照常出结果', async () => {
  const prev = process.env.CINEROUTE_SERP_PROVIDER;
  delete process.env.CINEROUTE_SERP_PROVIDER;
  try {
    const r = await searchAll('Night of the Living Dead', { ...offline(), config: defaultConfig() });
    const engines = r.providers.filter((p) => p.id.startsWith('engine:'));
    assert.equal(engines.length, 4, '四个引擎都应出现在数据源列表里');
    for (const e of engines) {
      assert.equal(e.status, 'skipped');
      assert.match(e.reason, /SERP/);
    }
    assert.ok(r.top.length > 0, '引擎不可用不影响其他来源');
  } finally {
    if (prev !== undefined) process.env.CINEROUTE_SERP_PROVIDER = prev;
  }
});
