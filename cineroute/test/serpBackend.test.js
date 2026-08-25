/**
 * 检索后端的选路与 browser 后端的取数。
 *
 * browser 后端那部分是**真启动 Chromium**，打开一个本地起的假结果页，
 * 走完整条 导航 → 注入脚本 → 抽链接 的路。不去连真的 Google：
 * 一来测试不该依赖外网，二来引擎的反自动化检测会让结果不稳定。
 * 假页面刻意做成 Google 那种相对地址的跳转包装（`/url?q=…`），
 * 因为那正是之前抽不到结果的地方。
 *
 * 机器上没有 Chromium 就整体跳过 —— 这不是失败，是这台机器走不了这条路。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  serpSettings, resolveBackend, checkBackend, runSerp, browserSearchPage,
} from '../src/adapters/serp.js';
import { launch, findChromeSync } from '../src/browser/cdp.js';
import { normalizeSerpConfig, DEFAULT_SERP } from '../src/core/sourceConfig.js';

/* ── 选路 ────────────────────────────────────────────────── */

test('设置页填的盖过环境变量，留空的才回落到环境变量', () => {
  const env = {
    CINEROUTE_SERP_BACKEND: 'api',
    CINEROUTE_SERP_PROVIDER: 'serper',
    CINEROUTE_SERP_KEY: 'from-env',
    CINEROUTE_SERP_CMD: 'ddgr {query}',
  };

  // 配置里是 auto + 空字段 → 全部用环境变量
  let s = serpSettings(env, normalizeSerpConfig({}));
  assert.equal(s.backend, 'api');
  assert.equal(s.key, 'from-env');

  // 配置里填了就用配置的
  s = serpSettings(env, normalizeSerpConfig({ backend: 'cli', key: 'from-ui' }));
  assert.equal(s.backend, 'cli');
  assert.equal(s.key, 'from-ui');
  assert.equal(s.cmd, 'ddgr {query}', '配置里没填的字段仍然回落到环境变量');
});

test('auto 的挑选顺序：配了什么用什么，什么都没配也能搜', () => {
  const pick = (cfg, hasChrome) => resolveBackend(serpSettings({}, cfg), { hasChrome }).backend;

  // 配了的优先用
  assert.equal(pick(normalizeSerpConfig({ provider: 'serper', key: 'k' }), true), 'api');
  assert.equal(pick(normalizeSerpConfig({ cmd: 'ddgr {query}' }), true), 'cli');

  // 什么都没配：有浏览器走阶梯，没浏览器走纯 http。
  // 关键是**两种情况都可用**——以前这里会返回 null，然后所有引擎源被
  // 整体跳过，用户看到的是一个安静的空结果。
  assert.equal(pick(normalizeSerpConfig({}), true), 'ladder');
  assert.equal(pick(normalizeSerpConfig({}), false), 'http');

  for (const hasChrome of [true, false]) {
    const v = checkBackend({}, normalizeSerpConfig({}), { hasChrome });
    assert.equal(v.available, true, `hasChrome=${hasChrome} 时应当可用`);
    assert.ok(v.why, '自动挑的要说明为什么挑它');
  }
});

test('显式选了一条配不齐的路，才判不可用', () => {
  const cases = [
    [{ backend: 'cli' }, /命令模板/],
    [{ backend: 'api' }, /服务商/],
    [{ backend: 'api', provider: 'serper' }, /key/i],
    [{ backend: 'browser' }, /找不到 Chromium/],
  ];
  for (const [cfg, want] of cases) {
    const v = checkBackend({}, normalizeSerpConfig(cfg), { hasChrome: false });
    assert.equal(v.available, false, `${JSON.stringify(cfg)} 应当判不可用`);
    assert.match(v.reason, want);
  }
});

test('配置规范化把非法值挡在外面', () => {
  const c = normalizeSerpConfig({
    backend: 'telepathy', provider: '不存在', cmdFormat: 'xml',
    timeoutMs: 999999999, settleMs: -5,
  });
  assert.equal(c.backend, 'auto', '不认识的后端退回 auto，而不是原样存进去');
  assert.equal(c.provider, '');
  assert.equal(c.cmdFormat, 'json');
  assert.equal(c.timeoutMs, 120000, '超时上限卡死');
  assert.equal(c.settleMs, 0);
  assert.deepEqual(normalizeSerpConfig(undefined), DEFAULT_SERP);
});

/* ── browser 后端：真开浏览器 ─────────────────────────────── */

const CHROME = findChromeSync();
const needChrome = { skip: CHROME ? false : '本机没有 Chromium' };

/** 一个长得像 Google 结果页的假页面：相对地址 + 跳转包装 + 相关搜索。 */
const FAKE_SERP = `<!doctype html><html><head><title>fake serp</title></head><body>
<div id="search">
  <div class="g"><a href="/url?q=https%3A%2F%2Farchive.org%2Fdetails%2Fnotld&sa=U">Night of the Living Dead : Free Download</a>
    <div>Full length feature film in the public domain, 1968.</div></div>
  <div class="g"><a href="/url?q=https%3A%2F%2Fcommons.wikimedia.org%2Fwiki%2FFile%3ANotld.ogv&sa=U">File:Notld.ogv - Wikimedia Commons</a>
    <div>Original 1968 print, Creative Commons licensed copy hosted on Commons.</div></div>
  <div class="g"><a href="https://www.loc.gov/item/notld/">Library of Congress record</a>
    <div>Catalogue entry for the 1968 film held by the Library of Congress.</div></div>
  <div class="g"><a href="/search?q=next+page">Google 自己的导航链接，不该被当成结果</a></div>
</div>
<div id="botstuff"><a href="#">night of the living dead 1968 full movie</a><a href="#">romero zombie films</a></div>
<p>${'内容填充，让页面正文足够长，否则会被判成疑似拦截。'.repeat(20)}</p>
</body></html>`;

async function withFakeSerp(fn) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(FAKE_SERP);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('browser 后端能真的打开结果页并抽出结果', needChrome, async () => {
  const browser = await launch({ executablePath: CHROME });
  try {
    await withFakeSerp(async (base) => {
      const r = await browserSearchPage(browser, 'google', 'Night of the Living Dead', 1, 10, {
        urlTemplate: `${base}/search?q={query}&page={page}`,
        settleMs: 100,
      });

      const urls = r.results.map((x) => x.url);
      assert.ok(
        urls.includes('https://archive.org/details/notld'),
        `跳转包装里的真实地址要被还原出来，实际拿到：${JSON.stringify(urls)}`,
      );
      assert.ok(urls.includes('https://commons.wikimedia.org/wiki/File:Notld.ogv'));
      assert.ok(urls.includes('https://www.loc.gov/item/notld/'), '绝对地址的结果也要收');
      assert.ok(!urls.some((u) => u.includes('google.')), '引擎自家的导航链接不该混进结果');

      assert.ok(r.results[0].snippet.length > 0, '摘要要从结果块里捞出来');
      assert.ok(r.related.includes('night of the living dead 1968 full movie'), '相关搜索要一起带回来');
      assert.equal(r.suspectBlocked, false, '正常页面不该被判成被拦截');
    });
  } finally {
    await browser.close();
  }
});

test('runSerp 走 browser 后端时不需要任何 key', needChrome, async () => {
  const browser = await launch({ executablePath: CHROME });
  try {
    await withFakeSerp(async (base) => {
      const out = await runSerp('google', 'Night of the Living Dead', {
        browser,
        env: {},
        serp: normalizeSerpConfig({
          backend: 'browser',
          urlTemplate: `${base}/search?q={query}&page={page}`,
          settleMs: 100,
        }),
        limit: 20,
      });
      assert.equal(out.backend, 'browser');
      assert.ok(out.results.length >= 3, `应抽到至少 3 条，实际 ${out.results.length}`);
      // rank 是连续的，取证时"第几条"要能对上
      assert.deepEqual(out.results.map((r) => r.rank), out.results.map((_, i) => i + 1));
    });
  } finally {
    await browser.close();
  }
});

test('选了 browser 却没给浏览器实例时，报错要说人话', async () => {
  await assert.rejects(
    () => runSerp('google', 'x', {
      env: {},
      serp: normalizeSerpConfig({ backend: 'browser' }),
    }),
    (err) => /浏览器连接|找不到 Chromium/.test(err.message),
  );
});
