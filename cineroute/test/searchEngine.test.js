/**
 * 搜索引擎适配器测试。
 *
 * 这里守两条线：
 * 1. **翻页**：用户配"前 100 条"就得真的翻够页数，而不是只拿第一页的 10 条。
 * 2. **产品边界**：引擎只负责发现页面。域名有解析器的才解析成片源，
 *    其余一律进"线索"列表——绝不去爬任意页面翻视频地址。这条线要是破了，
 *    整个平台就变成盗版聚合器了，所以用例写得比功能测试更严。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  serpSearch, normalizeSerp, resolveResults, buildScopedQuery, createEngineAdapter,
} from '../src/adapters/searchEngine.js';

const ENV = { CINEROUTE_SERP_PROVIDER: 'serper', CINEROUTE_SERP_KEY: 'test-key' };

/** 造一个假的 SERP 服务：每页返回 pageSize 条，共 total 条。 */
function fakeSerp(total, pageSize = 10) {
  const calls = [];
  const fetchJson = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push({ url, page: body.page, num: body.num, q: body.q });
    const start = (body.page - 1) * pageSize;
    const organic = [];
    for (let i = start; i < Math.min(start + pageSize, total); i += 1) {
      organic.push({ link: `https://example.org/page-${i}`, title: `结果 ${i}`, snippet: '' });
    }
    return { organic };
  };
  return { fetchJson, calls };
}

test('要 100 条就翻够页数，不是只拿第一页', async () => {
  const { fetchJson, calls } = fakeSerp(200, 10);
  const results = await serpSearch('google', 'x', { limit: 100, fetchJson, env: ENV });

  assert.equal(results.length, 100);
  assert.equal(calls.length, 10, 'google 单页 10 条，100 条要翻 10 页');
  assert.equal(results[0].rank, 1);
  assert.equal(results[99].rank, 100, '名次应连续编到 100');
});

test('单页容量大的引擎少翻几页（每个引擎的翻页方式不同）', async () => {
  const { fetchJson, calls } = fakeSerp(200, 50);
  const results = await serpSearch('bing', 'x', { limit: 100, fetchJson, env: ENV });
  assert.equal(results.length, 100);
  assert.equal(calls.length, 2, 'bing 单页 50 条，100 条只要 2 页');
});

test('上游结果不够时按实际条数返回，不空转', async () => {
  const { fetchJson, calls } = fakeSerp(23, 10);
  const results = await serpSearch('google', 'x', { limit: 100, fetchJson, env: ENV });
  assert.equal(results.length, 23);
  assert.equal(calls.length, 3, '第 3 页拿到 3 条，第 4 页空了就停');
});

test('翻到一半失败时保留已拿到的结果', async () => {
  let n = 0;
  const fetchJson = async () => {
    n += 1;
    if (n > 2) throw new Error('配额用尽');
    return { organic: Array.from({ length: 10 }, (_, i) => ({ link: `https://e.org/${n}-${i}`, title: 't' })) };
  };
  const results = await serpSearch('google', 'x', { limit: 100, fetchJson, env: ENV });
  assert.equal(results.length, 20, '前两页的结果不该因为第三页失败而全丢');
});

test('第一页就失败则如实抛错（没有结果可保）', async () => {
  const fetchJson = async () => { throw new Error('401 无效 key'); };
  await assert.rejects(
    () => serpSearch('google', 'x', { limit: 10, fetchJson, env: ENV }),
    /401/,
  );
});

test('一个后端都没配就明说，不假装能搜', async () => {
  // 只写了 provider 没写 key —— backend=auto 推成 api，然后卡在缺 key
  await assert.rejects(
    () => serpSearch('google', 'x', { env: { CINEROUTE_SERP_PROVIDER: 'serper' } }),
    /key/i,
  );
  // 显式选了 cli 却没给命令模板
  await assert.rejects(
    () => serpSearch('google', 'x', { env: { CINEROUTE_SERP_BACKEND: 'cli' } }),
    /命令模板/,
  );
});

test('不同服务商的响应结构都能压成统一形状', () => {
  assert.deepEqual(
    normalizeSerp('brave', { web: { results: [{ url: 'https://a.org', title: 'A', description: 'd' }] } }),
    [{ url: 'https://a.org', title: 'A', snippet: 'd' }],
  );
  assert.deepEqual(
    normalizeSerp('serper', { organic: [{ link: 'https://b.org', title: 'B', snippet: 's' }] }),
    [{ url: 'https://b.org', title: 'B', snippet: 's' }],
  );
  // 结构对不上时返回空数组而不是抛错
  assert.deepEqual(normalizeSerp('serper', { unexpected: 1 }), []);
  assert.deepEqual(normalizeSerp('brave', null), []);
});

test('站点范围拼成 site: 条件；范围为空则不加限定', () => {
  assert.equal(
    buildScopedQuery('Metropolis', ['archive.org', 'commons.wikimedia.org']),
    'Metropolis (site:archive.org OR site:commons.wikimedia.org)',
  );
  assert.equal(buildScopedQuery('Metropolis', []), 'Metropolis');
});

test('引擎适配器把配置的站点范围带进查询里', async () => {
  let seenQuery = null;
  const fetchJson = async (url, opts) => {
    if (url.includes('serper')) { seenQuery = JSON.parse(opts.body).q; return { organic: [] }; }
    return {};
  };
  const adapter = createEngineAdapter({
    id: 'engine:google', engine: 'google', siteScope: ['archive.org'],
  });
  const prev = { ...process.env };
  Object.assign(process.env, ENV);
  try {
    await adapter.search({ title: 'Metropolis', year: 1927 }, { limit: 10, fetchJson });
  } finally {
    for (const k of Object.keys(ENV)) {
      if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k];
    }
  }
  assert.match(seenQuery, /site:archive\.org/);
});

/* ── 产品边界 ───────────────────────────────────────────── */

test('认识的域名解析成真实片源（archive.org 详情页）', async () => {
  const fetchJson = async (url) => {
    assert.match(url, /archive\.org\/metadata\/night_of_the_living_dead/);
    return {
      metadata: { identifier: 'night_of_the_living_dead', title: 'Night of the Living Dead', year: '1968' },
      server: 'ia801509.us.archive.org', dir: '/27/items/night_of_the_living_dead',
      files: [
        { name: 'night.mp4', format: 'h.264', size: '900000000', length: '5760', height: '720', width: '1280', md5: 'abc' },
      ],
    };
  };
  const { sources, leads } = await resolveResults(
    [{ url: 'https://archive.org/details/night_of_the_living_dead', title: 'NOTLD', rank: 1 }],
    { title: 'Night of the Living Dead', year: 1968 },
    { fetchJson, engineId: 'engine:google' },
  );
  assert.equal(sources.length, 1);
  assert.equal(sources[0].discoveredBy, 'engine:google');
  assert.equal(sources[0].discoveredRank, 1);
  assert.equal(leads.length, 0);
});

test('不认识的域名只列为线索，绝不去抓页面找视频地址', async () => {
  const fetched = [];
  const fetchJson = async (url) => { fetched.push(url); return {}; };

  const suspicious = [
    'https://some-streaming-site.example/watch/12345',
    'https://another-site.example/movie/metropolis',
    'https://cdn.example/hls/master.m3u8',
  ];
  const { sources, leads } = await resolveResults(
    suspicious.map((url, i) => ({ url, title: `t${i}`, rank: i + 1 })),
    { title: 'Metropolis', year: 1927 },
    { fetchJson, engineId: 'engine:google' },
  );

  assert.equal(sources.length, 0, '未知域名不得产出任何可播片源');
  assert.equal(leads.length, 3, '应如实列为线索');
  assert.equal(fetched.length, 0, '不得对未知域名发起任何请求');
  for (const l of leads) assert.match(l.reason, /没有对应的解析器/);
});

test('详情页解析失败时降级为线索，而不是编一个地址出来', async () => {
  const fetchJson = async () => { throw new Error('404'); };
  const { sources, leads } = await resolveResults(
    [{ url: 'https://archive.org/details/gone', title: 'gone', rank: 1 }],
    { title: 'x', year: null },
    { fetchJson, engineId: 'engine:google' },
  );
  assert.equal(sources.length, 0);
  assert.equal(leads.length, 1);
  assert.match(leads[0].reason, /解析失败/);
});

test('未配置时适配器自报不可用，三种后端各自检查各自的配置', async () => {
  const adapter = createEngineAdapter({ id: 'engine:google', engine: 'google' });
  // 有没有 Chromium 是机器状态，会让"什么都没配"的判定摇摆，所以显式给定
  const noChrome = { hasChrome: false };
  const hasChrome = { hasChrome: true };

  assert.equal(adapter.checkConfig({}, noChrome).available, false);
  assert.match(adapter.checkConfig({}, noChrome).reason, /没有可用的检索后端/);

  // api
  assert.equal(adapter.checkConfig({ CINEROUTE_SERP_PROVIDER: 'nope' }, noChrome).available, false);
  assert.equal(
    adapter.checkConfig({ CINEROUTE_SERP_PROVIDER: 'custom' }, noChrome).available, false,
    'custom 缺 URL 模板也算未配置',
  );
  assert.equal(
    adapter.checkConfig({ CINEROUTE_SERP_PROVIDER: 'serper', CINEROUTE_SERP_KEY: 'k' }, noChrome).available,
    true,
  );

  // cli：缺命令模板不算配好
  assert.equal(adapter.checkConfig({ CINEROUTE_SERP_BACKEND: 'cli' }, noChrome).available, false);
  assert.match(adapter.checkConfig({ CINEROUTE_SERP_BACKEND: 'cli' }, noChrome).reason, /命令模板/);
  assert.equal(
    adapter.checkConfig(
      { CINEROUTE_SERP_BACKEND: 'cli', CINEROUTE_SERP_CMD: 'ddgr --json {query}' }, noChrome,
    ).available,
    true,
  );

  // browser：不用填任何东西，但机器上得真有 Chromium
  assert.equal(adapter.checkConfig({ CINEROUTE_SERP_BACKEND: 'browser' }, hasChrome).available, true);
  assert.equal(adapter.checkConfig({ CINEROUTE_SERP_BACKEND: 'browser' }, noChrome).available, false);
  assert.match(adapter.checkConfig({ CINEROUTE_SERP_BACKEND: 'browser' }, noChrome).reason, /找不到 Chromium/);

  // 不认识的后端要报出来，而不是默默当成某一种
  assert.equal(adapter.checkConfig({ CINEROUTE_SERP_BACKEND: 'telepathy' }, noChrome).available, false);
});

test('backend=auto 时按现场情况自己挑一条能走的路', () => {
  const adapter = createEngineAdapter({ id: 'engine:google', engine: 'google' });
  const pick = (env, cfg, opts) => createEngineAdapter({
    id: 'engine:google', engine: 'google', serp: cfg,
  }).checkConfig(env, opts);

  // 优先级：api > cli > browser
  let v = pick({}, { backend: 'auto', provider: 'serper', key: 'k' }, { hasChrome: true });
  assert.equal(v.backend, 'api');
  assert.equal(v.auto, true, '没显式指定就算自动挑的');

  v = pick({}, { backend: 'auto', cmd: 'ddgr --json {query}' }, { hasChrome: true });
  assert.equal(v.backend, 'cli');

  // 什么都没配但机器上有 Chromium —— 这是"开箱即用"那条路
  v = pick({}, { backend: 'auto' }, { hasChrome: true });
  assert.equal(v.backend, 'browser');
  assert.equal(v.available, true);

  // 显式指定就不再自动挑
  v = pick({}, { backend: 'browser', provider: 'serper', key: 'k' }, { hasChrome: true });
  assert.equal(v.backend, 'browser');
  assert.equal(v.auto, false);

  // 设置页填了就盖过环境变量；设置页留空才回落到环境变量
  v = pick({ CINEROUTE_SERP_BACKEND: 'cli', CINEROUTE_SERP_CMD: 'x {query}' }, { backend: 'auto' }, { hasChrome: true });
  assert.equal(v.backend, 'cli', '配置里是 auto，环境变量说了算');
  v = pick({ CINEROUTE_SERP_BACKEND: 'cli', CINEROUTE_SERP_CMD: 'x {query}' }, { backend: 'browser' }, { hasChrome: true });
  assert.equal(v.backend, 'browser', '配置里显式指定就盖过环境变量');

  assert.equal(adapter.checkConfig({}, { hasChrome: false }).available, false);
});

test('引擎失败时返回错误而不是抛出，不拖垮其他源', async () => {
  const adapter = createEngineAdapter({ id: 'engine:google', engine: 'google' });
  const fetchJson = async () => { throw new Error('配额用尽'); };
  const prev = { ...process.env };
  Object.assign(process.env, ENV);
  try {
    const r = await adapter.search({ title: 'x', year: null }, { limit: 10, fetchJson });
    assert.match(r.error, /配额用尽/);
    assert.deepEqual(r.sources, []);
  } finally {
    for (const k of Object.keys(ENV)) {
      if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k];
    }
  }
});
