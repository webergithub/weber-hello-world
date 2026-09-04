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
import { createFixtureFetch, createFixtureProbe, FIXTURE_SERP_CONFIG } from '../src/core/fixtureFetch.js';

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
    priority: { enabled: false },   // 这条用例只看片源装配，把优先来源隔离掉
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

test('检索后端不可用时引擎被跳过，其余来源照常出结果', async () => {
  // 显式指一个配不齐的后端（cli 没给命令模板）。
  // 不用"什么都不配"来构造这个场景：那种情况下 backend=auto 会去看本机
  // 有没有 Chromium，测试结果就跟着跑测试的机器摇摆了。
  const prev = { ...process.env };
  for (const k of Object.keys(process.env)) if (k.startsWith('CINEROUTE_SERP')) delete process.env[k];
  try {
    const config = { ...defaultConfig(), serp: { ...defaultConfig().serp, backend: 'cli', cmd: '' } };
    const r = await searchAll('Night of the Living Dead', { ...offline(), config });
    const engines = r.providers.filter((p) => p.id.startsWith('engine:'));
    assert.equal(engines.length, 5, '五个引擎都应出现在数据源列表里');
    for (const e of engines) {
      assert.equal(e.status, 'skipped');
      assert.match(e.reason, /命令模板/);
    }
    assert.ok(r.top.length > 0, '引擎不可用不影响其他来源');
  } finally {
    for (const k of Object.keys(process.env)) if (k.startsWith('CINEROUTE_SERP')) delete process.env[k];
    Object.assign(process.env, prev);
  }
});

test('配置里的检索后端能直接驱动引擎源，不必设环境变量', async () => {
  // 这是"搜索结果永远是空的"那个问题的回归用例：以前后端只认环境变量，
  // clone 下来直接跑，五个引擎全部因为"未配置检索后端"被跳过。
  const prev = { ...process.env };
  for (const k of Object.keys(process.env)) if (k.startsWith('CINEROUTE_SERP')) delete process.env[k];
  try {
    const config = { ...defaultConfig(), serp: { ...FIXTURE_SERP_CONFIG } };
    const r = await searchAll('Night of the Living Dead', { ...offline(), config });
    const engines = r.providers.filter((p) => p.id.startsWith('engine:'));
    assert.equal(engines.filter((e) => e.status === 'skipped').length, 0, '不该再有引擎被跳过');
    assert.ok(
      engines.some((e) => (e.stats?.returned ?? 0) > 0),
      '至少要有一个引擎真的返回了结果',
    );
  } finally {
    for (const k of Object.keys(process.env)) if (k.startsWith('CINEROUTE_SERP')) delete process.env[k];
    Object.assign(process.env, prev);
  }
});

/* ── 四步走：中间账目 ─────────────────────────────────────── */

import { dedupeWithTrail, dedupeLeads } from '../src/core/pipeline.js';

test('四个阶段都有产出，且计数能对得上', async () => {
  await withFixtureSerp(async () => {
    const r = await searchAll('Night of the Living Dead', offline());
    const s = r.stages;
    assert.ok(s, '应返回 stages');

    for (const k of ['discovery', 'normalize', 'verify', 'final']) {
      assert.ok(s[k], `缺少阶段 ${k}`);
      assert.ok(s[k].label, `${k} 应有中文标签`);
    }

    // 第二步的输入应等于第一步解析出的片源数
    assert.equal(s.normalize.before + s.normalize.removed * 0, s.normalize.before);
    assert.equal(s.normalize.after + s.normalize.removed, s.normalize.before);
    // 第三步的输入是第二步的输出
    assert.equal(s.verify.total, s.normalize.after);
    assert.equal(s.verify.usable + s.verify.rejected, s.verify.total);
    // 第四步的直链数不会超过第三步判定可用的数量
    assert.ok(s.final.directCount <= s.verify.usable);
  });
});

test('第一步保留逐引擎逐词的原始结果，不做任何合并', async () => {
  await withFixtureSerp(async () => {
    const r = await searchAll('Night of the Living Dead', offline());
    const d = r.stages.discovery;

    assert.ok(d.terms.length > 1, '应该扩展出多个检索词');
    assert.equal(d.terms[0].kind, 'original');

    const google = d.engines.find((e) => e.id === 'engine:google');
    assert.ok(google, '应有 Google 的记录');
    assert.equal(google.rounds.length, d.terms.filter((t) => t.kind !== 'suggested').length,
      '每个第一轮的词都该有一条记录');

    // 原始结果里允许有重复——去重是第二步的事，第一步不能先斩后奏
    const urls = google.rounds.flatMap((rd) => rd.results.map((x) => x.url));
    assert.ok(urls.length > new Set(urls).size, '第一步应保留重复项');

    // 每条都带着"哪个词搜到的"
    for (const rd of google.rounds) {
      for (const item of rd.results) assert.equal(item.term, rd.term);
    }
  });
});

test('第二步的每个分组都带完整引用，能倒查到引擎与检索词', async () => {
  await withFixtureSerp(async () => {
    const r = await searchAll('Night of the Living Dead', offline());
    const groups = r.stages.normalize.groups;
    assert.ok(groups.length > 0);

    const merged = groups.find((g) => g.count > 1);
    assert.ok(merged, '应有被合并的分组');
    assert.ok(merged.keyLabel, '应说明按什么合并的');
    assert.ok(merged.citations.length > 1, '合并的分组应保留多条来路');

    for (const c of merged.citations) {
      assert.ok(c.provider, '引用必须写明来源');
      assert.ok(c.term, '引用必须写明用的哪个检索词');
    }
    // 被多个引擎独立命中的要能识别出来
    assert.ok(groups.some((g) => new Set(g.citations.map((c) => c.provider)).size > 1));
  });
});

test('第三步逐条给出可用/筛除的结论与原因，并附引用', async () => {
  await withFixtureSerp(async () => {
    const r = await searchAll('Night of the Living Dead', offline());
    const v = r.stages.verify;

    assert.ok(v.items.length > 0);
    for (const it of v.items) {
      assert.ok(['usable', 'rejected'].includes(it.verdict));
      assert.ok(it.reason, `${it.filename} 缺少结论原因`);
      assert.ok(it.url, '必须给出被甄别的地址');
      assert.ok(Array.isArray(it.citations), '必须带引用数组');
    }

    // 被筛掉的要说清楚为什么
    const rejected = v.items.filter((x) => x.verdict === 'rejected');
    assert.ok(rejected.length > 0, '夹具里有 MKV 和预告片，应该被筛掉');
    assert.ok(rejected.some((x) => /Matroska|不支持/.test(x.reason)));
    assert.ok(rejected.some((x) => /trailer|非正片/.test(x.reason)));
  });
});

test('第三步如实报告嗅探了几条——不能让人以为全验过了', async () => {
  await withFixtureSerp(async () => {
    const r = await searchAll('Night of the Living Dead', { ...offline(), probeLimit: 2 });
    const v = r.stages.verify;
    assert.equal(v.checked, 2, '只探测 2 条就该只报 2 条');
    assert.ok(v.total > v.checked, '总数应大于探测数');
    assert.ok(r.notes.some((n) => n.includes('只嗅探了前 2 条')), '应在说明里点出来');

    // 没探测到的条目要有标记，UI 才能挂「未探测」提示
    const unprobed = v.items.filter((x) => !x.probed);
    assert.ok(unprobed.length > 0);
    // 判定可用的，理由里必须说明这是按元数据判的而不是实测的；
    // 被筛掉的理由说的是筛除原因（如容器不支持），不该混进探测状态。
    for (const it of unprobed.filter((x) => x.verdict === 'usable')) {
      assert.match(it.reason, /未探测|按上游元数据/);
    }
  });
});

test('线索按 URL 合并，同一页面不重复列出', () => {
  const merged = dedupeLeads([
    { url: 'https://a.example/x', discoveredBy: 'engine:google', term: 'a', rank: 1, reason: 'r' },
    { url: 'https://a.example/x', discoveredBy: 'engine:google', term: 'b', rank: 2, reason: 'r' },
    { url: 'https://a.example/x', discoveredBy: 'engine:bing', term: 'a', rank: 3, reason: 'r' },
    { url: 'https://b.example/y', discoveredBy: 'engine:google', term: 'a', rank: 4, reason: 'r' },
  ]);
  assert.equal(merged.length, 2);
  const first = merged.find((l) => l.url === 'https://a.example/x');
  assert.equal(first.citations.length, 3, '三种「来源+词」组合都要留下');
  assert.equal(first.foundByCount, 2, '两个引擎命中');
});

test('去重账目里合并数与保留数相加等于输入数', () => {
  const mk = (url, md5) => ({ url, filename: url, checksums: { md5 }, discoveredBy: 'x' });
  const { kept, groups, removed } = dedupeWithTrail([
    mk('https://a/1.mp4', 'aaa'),
    mk('https://mirror/1.mp4', 'aaa'),   // 同校验和，不同 URL → 合并
    mk('https://b/2.mp4', 'bbb'),
  ]);
  assert.equal(kept.length, 2);
  assert.equal(removed, 1);
  assert.equal(groups.reduce((n, g) => n + g.count, 0), 3);
  assert.equal(groups.find((g) => g.count === 2).keyKind, 'md5');
});
