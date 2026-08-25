/**
 * 自有检索框架：HTML 抽取 · 引擎配方 · http 策略 · 策略阶梯。
 *
 * 这套东西的价值在于**不依赖付费 SERP 服务**也能拿到结果，所以测试
 * 要盯的不只是"能解析"，还有几件真实世界里天天发生的事：
 *
 *   · 结果链接是**跳转包装**（Google 的 /url?q=、DDG 的 /l/?uddg=），
 *     不还原就拿到一堆引擎自家的地址；
 *   · **同意页**：HTTP 200、结构完整、零结果。当成"搜不到"是错的；
 *   · **验证码页**：必须识别成"被挡"并升级策略，而不是解析出一堆噪音；
 *   · 引擎**改版面**：选择器写死就废，抽取要抗得住。
 *
 * 用本地起的假引擎来验——不连真的搜索引擎：那样测试会因为对方改版、
 * 限流、地区差异而随机红，而且我们也不该在跑测试时去打人家的服务器。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  decodeEntities, stripTags, extractAnchors, snippetAfter, pageTitle, visibleTextLength,
} from '../src/adapters/serp/html.js';
import { ENGINES, recipeFor, isOwnHost } from '../src/adapters/serp/engines.js';
import {
  httpSearchPage, extractResults, buildHeaders, httpSupported, throttle, resetThrottle,
} from '../src/adapters/serp/httpSearch.js';
import { searchWithLadder, describeAttempts } from '../src/adapters/serp/ladder.js';

/* ── HTML 抽取 ────────────────────────────────────────────── */

test('实体解码：命名的、十进制的、十六进制的都要认', () => {
  assert.equal(decodeEntities('a&amp;b'), 'a&b');
  assert.equal(decodeEntities('&lt;div&gt;'), '<div>');
  assert.equal(decodeEntities('&#39;quoted&#39;'), "'quoted'");
  assert.equal(decodeEntities('&#x27;x&#x27;'), "'x'");
  assert.equal(decodeEntities('caf&#233;'), 'café');
  assert.equal(decodeEntities('a&nbsp;b'), 'a b');
  // 认不出来的原样留着，不能吞掉
  assert.equal(decodeEntities('&notreal;'), '&notreal;');
  assert.equal(decodeEntities('100% &amp; more'), '100% & more');
});

test('去标签：script/style 的内容要整段丢掉，不能混进正文', () => {
  const html = '<div>正文<script>var x="不该出现";</script>还是正文<style>.a{}</style></div>';
  const text = stripTags(html);
  assert.ok(!text.includes('不该出现'), `脚本内容漏进正文了：${text}`);
  assert.ok(!text.includes('.a{}'));
  assert.equal(text, '正文 还是正文');
});

test('抽锚点：嵌套标签、单引号、无引号的 href 都要认', () => {
  const html = `
    <a href="https://a.example/1"><span>标题 <em>一</em></span></a>
    <a href='https://b.example/2'>标题二</a>
    <a href=https://c.example/3 class=x>标题三</a>
    <abbr title="不是链接">abbr</abbr>
    <a>没有 href</a>
  `;
  const got = extractAnchors(html);
  assert.deepEqual(got.map((a) => a.href), [
    'https://a.example/1', 'https://b.example/2', 'https://c.example/3',
  ]);
  assert.equal(got[0].text, '标题 一', '嵌套标签里的文字要拼起来');
  // <abbr> 不能被当成 <a>
  assert.ok(!got.some((a) => a.text === 'abbr'));
});

test('抽锚点：摘要取到下一个链接就停，不能把下一条的标题当本条的描述', () => {
  const html = '<a href="https://a.example/">甲</a><p>甲的描述文字</p>'
    + '<a href="https://b.example/">乙</a><p>乙的描述文字</p>';
  const anchors = extractAnchors(html);
  const s = snippetAfter(html, anchors[0].end);
  assert.ok(s.includes('甲的描述'), `没取到本条的描述：${s}`);
  assert.ok(!s.includes('乙'), `把下一条的内容也吃进来了：${s}`);
});

test('页面标题与正文长度', () => {
  const html = '<html><head><title>  Night of the Living Dead - 搜索  </title></head>'
    + '<body><script>' + 'x'.repeat(50000) + '</script><p>短</p></body></html>';
  assert.equal(pageTitle(html), 'Night of the Living Dead - 搜索');
  // 正文长度不能把内联脚本算进去，否则验证码页看起来"内容很多"
  assert.ok(visibleTextLength(html) < 20, `正文长度算错了：${visibleTextLength(html)}`);
});

/* ── 引擎配方 ─────────────────────────────────────────────── */

test('每个引擎的配方都齐整', () => {
  const bad = [];
  for (const [name, r] of Object.entries(ENGINES)) {
    if (typeof r.url !== 'function') bad.push(`${name} 缺 url()`);
    if (!r.label) bad.push(`${name} 缺 label`);
    if (typeof r.blocked !== 'function') bad.push(`${name} 缺拦截判定`);
    if (!Array.isArray(r.selectors)) bad.push(`${name} 缺 selectors`);
    if (typeof r.httpOk !== 'boolean') bad.push(`${name} 没说明能不能走 http`);
    if (r.json && typeof r.parseJson !== 'function') bad.push(`${name} 标了 json 却没有 parseJson`);
  }
  assert.equal(bad.length, 0, `配方不齐：\n  ${bad.join('\n  ')}`);
});

test('翻页参数：各家算法不一样，不能一套公式套所有', () => {
  const at = (engine, page) => ENGINES[engine].url('x', page, ENGINES[engine].pageSize, 'http://sx');
  // Google 用 start=偏移
  assert.match(at('google', 1), /start=0/);
  assert.match(at('google', 3), /start=20/);
  // Bing 用 first=偏移+1（从 1 开始数）
  assert.match(at('bing', 1), /first=1/);
  assert.match(at('bing', 3), /first=21/);
  // 百度用 pn=偏移
  assert.match(at('baidu', 3), /pn=20/);
  // Yandex 用 p=页码-1
  assert.match(at('yandex', 3), /p=2/);
  // SearXNG 用 pageno=页码（从 1 开始）
  assert.match(at('searxng', 3), /pageno=3/);
});

test('跳转包装还原：Google / DDG / Bing 各有各的包法', () => {
  const g = ENGINES.google.unwrap('/url?q=https%3A%2F%2Farchive.org%2Fx&sa=U', 'https://www.google.com/search');
  assert.equal(g, 'https://archive.org/x');

  const d = ENGINES.duckduckgo.unwrap('/l/?uddg=https%3A%2F%2Farchive.org%2Fy', 'https://html.duckduckgo.com/html/');
  assert.equal(d, 'https://archive.org/y');

  const b = ENGINES.bing.unwrap('https://www.bing.com/ck/a?u=https%3A%2F%2Farchive.org%2Fz', 'https://www.bing.com/');
  assert.equal(b, 'https://archive.org/z');

  // 本来就是绝对地址的，原样返回，别越帮越忙
  assert.equal(ENGINES.google.unwrap('https://archive.org/plain', 'https://www.google.com/'), 'https://archive.org/plain');
});

test('引擎自家域名要排掉，否则满屏都是它的导航链接', () => {
  const own = ENGINES.google.ownHosts;
  assert.equal(isOwnHost('https://www.google.com/preferences', own), true);
  assert.equal(isOwnHost('https://maps.google.com/x', own), true);
  assert.equal(isOwnHost('https://archive.org/details/x', own), false);
  // 后缀伪装不能算作自家域名（那会把真结果误伤掉）
  assert.equal(isOwnHost('https://notgoogle.com.evil.net/x', ENGINES.bing.ownHosts), false);
});

test('不认识的引擎给通用配方，而不是抛错', () => {
  const r = recipeFor('某个没见过的引擎');
  assert.equal(r.generic, true);
  assert.equal(typeof r.url, 'function');
  assert.equal(r.httpOk, false, '通用配方不该假装自己能走 http');
});

/* ── 请求头 ───────────────────────────────────────────────── */

test('请求头是成套的，不是只换个 User-Agent', () => {
  const h = buildHeaders('google', ENGINES.google, 'https://www.google.com/search?q=x');
  // 真实浏览器这几个头是一起出现的，缺了反而更可疑
  for (const k of ['user-agent', 'accept', 'accept-language', 'sec-fetch-mode', 'referer']) {
    assert.ok(h[k], `缺请求头 ${k}`);
  }
  assert.match(h.referer, /^https:\/\/www\.google\.com\/$/, 'referer 应当指向该引擎首页');
  // 同意页 cookie 必须带上，否则欧盟出口拿回来的是零结果的中间页
  assert.match(h.cookie, /CONSENT=/, 'Google 少了 CONSENT cookie');
});

test('同一个引擎每次用同一套请求头，不自己乱变', () => {
  const a = buildHeaders('bing', ENGINES.bing, 'https://www.bing.com/search?q=1');
  const b = buildHeaders('bing', ENGINES.bing, 'https://www.bing.com/search?q=2');
  assert.equal(a['user-agent'], b['user-agent'], '同一引擎的 UA 应当稳定');
});

/* ── 假引擎 ───────────────────────────────────────────────── */

/** 一个像模像样的结果页：跳转包装 + 自家导航 + 相关搜索。 */
function googleLikePage(n = 3) {
  const item = (i) => `
    <div class="g">
      <a href="/url?q=https%3A%2F%2Farchive.org%2Fdetails%2Fnotld${i}&amp;sa=U">
        <h3><span>Night of the Living Dead ${i}</span></h3>
      </a>
      <div class="VwiC3b">1968 年的公有领域影片，第 ${i} 条结果的描述文字。</div>
    </div>`;
  return `<!doctype html><html><head><title>notld - Google 搜索</title></head><body>
    <a href="https://www.google.com/preferences">设置</a>
    <div id="search">${Array.from({ length: n }, (_, i) => item(i + 1)).join('')}</div>
    <div id="botstuff"><a href="/search?q=notld+full+movie">notld full movie</a></div>
    <p>${'页面正文填充。'.repeat(100)}</p>
  </body></html>`;
}

const CONSENT_PAGE = `<!doctype html><html><head><title>Before you continue to Google</title></head>
  <body><form><button>我同意</button></form></body></html>`;

const CAPTCHA_PAGE = `<!doctype html><html><head><title>Sorry...</title></head>
  <body><p>Our systems have detected unusual traffic from your computer network.</p></body></html>`;

async function withEngine(handler, fn) {
  const s = await new Promise((ok) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => ok(srv));
  });
  const base = `http://127.0.0.1:${s.address().port}`;
  try {
    return await fn(base);
  } finally {
    await new Promise((r) => s.close(r));
  }
}

/** 把 httpSearchPage 指到本地假引擎上。 */
function localFetch(base) {
  return (url, init) => {
    const u = new URL(url);
    return fetch(`${base}${u.pathname}${u.search}`, init);
  };
}

/* ── http 策略 ────────────────────────────────────────────── */

test('http 策略：抽出结果、还原跳转包装、排掉自家链接', async () => {
  resetThrottle();
  await withEngine((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(googleLikePage(3));
  }, async (base) => {
    const r = await httpSearchPage('google', 'notld', 1, {
      fetchFn: localFetch(base), skipThrottle: true,
    });

    assert.equal(r.blocked, null, `不该被判成拦截：${r.blocked}`);
    const urls = r.results.map((x) => x.url);
    assert.ok(
      urls.includes('https://archive.org/details/notld1'),
      `跳转包装没还原：${JSON.stringify(urls)}`,
    );
    assert.equal(urls.length, 3, `应当是 3 条结果，实际 ${urls.length}：${JSON.stringify(urls)}`);
    assert.ok(!urls.some((u) => u.includes('google.com')), '引擎自家的链接混进来了');
    assert.ok(r.results[0].title.includes('Night of the Living Dead'));
    assert.ok(r.results[0].snippet.includes('1968'), `摘要没取到：${r.results[0].snippet}`);
    assert.deepEqual(r.related, ['notld full movie']);
  });
});

test('http 策略：同意页要判成被挡，不能当成"没搜到"', async () => {
  // 这是最坑的一种：HTTP 200、结构完整、零结果。
  // 判成"没搜到"就不会升级策略，用户看到的是一个安静的空结果。
  resetThrottle();
  await withEngine((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(CONSENT_PAGE);
  }, async (base) => {
    const r = await httpSearchPage('google', 'notld', 1, {
      fetchFn: localFetch(base), skipThrottle: true,
    });
    assert.ok(r.blocked, '同意页应当被识别为拦截');
    assert.equal(r.results.length, 0);
  });
});

test('http 策略：验证码页判成被挡，且不解析出噪音', async () => {
  resetThrottle();
  await withEngine((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(CAPTCHA_PAGE);
  }, async (base) => {
    const r = await httpSearchPage('google', 'notld', 1, {
      fetchFn: localFetch(base), skipThrottle: true,
    });
    assert.match(r.blocked, /unusual traffic/i);
    assert.equal(r.results.length, 0, '被挡的页面上抠出来的东西全是噪音，不该混进结果');
  });
});

test('http 策略：429 直接判被挡', async () => {
  resetThrottle();
  await withEngine((req, res) => {
    res.writeHead(429, { 'content-type': 'text/html' });
    res.end('<html><body>slow down</body></html>');
  }, async (base) => {
    const r = await httpSearchPage('bing', 'x', 1, { fetchFn: localFetch(base), skipThrottle: true });
    assert.match(r.blocked, /429/);
  });
});

test('抽取不依赖 class 名：引擎改版面之后照样出结果', async () => {
  // 这是"选择器写死"最大的隐患。这里把结果页的 class 全换掉，
  // 只保留链接本身的形态——抽取应当照常工作。
  const renamed = googleLikePage(2)
    .replace(/class="g"/g, 'class="xyz9"')
    .replace(/id="search"/g, 'id="zzz"')
    .replace(/class="VwiC3b"/g, 'class="q7"');

  resetThrottle();
  await withEngine((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(renamed);
  }, async (base) => {
    const r = await httpSearchPage('google', 'notld', 1, {
      fetchFn: localFetch(base), skipThrottle: true,
    });
    assert.equal(r.results.length, 2, `改版面之后抽不出结果了：${JSON.stringify(r.results)}`);
  });
});

test('SearXNG：直接吃 JSON，不用抓 HTML', async () => {
  resetThrottle();
  await withEngine((req, res) => {
    assert.match(req.url, /format=json/);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      results: [
        { url: 'https://archive.org/details/a', title: 'A', content: '描述 A' },
        { url: 'https://commons.wikimedia.org/wiki/File:B.ogv', title: 'B', content: '描述 B' },
        { title: '没有 url 的条目' },
      ],
      suggestions: ['相关词一', '相关词二'],
    }));
  }, async (base) => {
    const r = await httpSearchPage('searxng', 'notld', 1, {
      fetchFn: (u, i) => fetch(`${base}${new URL(u).pathname}${new URL(u).search}`, i),
      baseUrl: 'http://searx.local',
      skipThrottle: true,
    });
    assert.equal(r.blocked, null);
    assert.equal(r.results.length, 2, '没有 url 的条目该被丢掉');
    assert.equal(r.results[0].url, 'https://archive.org/details/a');
    assert.deepEqual(r.related, ['相关词一', '相关词二']);
  });
});

test('SearXNG 实例地址填错时说清楚，而不是给个空结果', async () => {
  resetThrottle();
  await withEngine((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><body>这是一个网页，不是 JSON</body></html>');
  }, async (base) => {
    const r = await httpSearchPage('searxng', 'x', 1, {
      fetchFn: (u, i) => fetch(`${base}${new URL(u).pathname}${new URL(u).search}`, i),
      baseUrl: 'http://searx.local',
      skipThrottle: true,
    });
    assert.match(r.blocked, /不是 JSON/);
  });
});

/* ── 限速 ─────────────────────────────────────────────────── */

test('限速：同一家引擎两次请求之间要留间隔，且带抖动', async () => {
  resetThrottle();
  const waited = [];
  const fakeWait = async (ms) => { waited.push(ms); };

  // 第一次：这家引擎还没被打过，不该等
  await throttle('google', Date.now(), fakeWait);
  assert.deepEqual(waited, [], '第一次请求不该等待');

  // 紧接着第二次：要等够最小间隔
  await throttle('google', Date.now(), fakeWait);
  assert.equal(waited.length, 1, '第二次应当等待');
  assert.ok(waited[0] > 0, `等待时间应当为正：${waited[0]}`);
  // Google 的最小间隔是 3 秒，抖动最多再加 40%
  assert.ok(waited[0] <= 3000 * 1.4, `等太久了：${waited[0]}`);

  // 不同引擎各算各的，别互相拖累
  const other = [];
  await throttle('mojeek', Date.now(), async (ms) => other.push(ms));
  assert.deepEqual(other, [], '换一家引擎不该受上一家的节奏影响');
});

/* ── 策略阶梯 ─────────────────────────────────────────────── */

test('阶梯：http 能出结果就不开浏览器', async () => {
  resetThrottle();
  let browserCalls = 0;
  await withEngine((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(googleLikePage(2));
  }, async (base) => {
    const r = await searchWithLadder('google', 'notld', 1, {
      fetchFn: localFetch(base),
      skipThrottle: true,
      browserSearch: async () => { browserCalls += 1; return { results: [], related: [] }; },
    });
    assert.equal(r.strategy, 'http');
    assert.equal(r.results.length, 2);
    assert.equal(browserCalls, 0, '拿大炮打蚊子：http 已经出结果了还去开浏览器');
  });
});

test('阶梯：http 被挡就升级到浏览器', async () => {
  resetThrottle();
  await withEngine((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(CAPTCHA_PAGE);
  }, async (base) => {
    const r = await searchWithLadder('google', 'notld', 1, {
      fetchFn: localFetch(base),
      skipThrottle: true,
      browserSearch: async () => ({
        results: [{ url: 'https://archive.org/details/x', title: 'X', snippet: '' }],
        related: [], suspectBlocked: false, elapsedMs: 2000,
      }),
    });
    assert.equal(r.strategy, 'browser', `应当升级到浏览器：${describeAttempts(r.attempts)}`);
    assert.equal(r.results.length, 1);
    assert.equal(r.attempts.length, 2, '尝试记录应当留下 http 那次失败');
    assert.match(r.attempts[0].detail, /被挡/);
  });
});

test('阶梯：没被挡但确实没结果时，不该白白升级再跑一次', async () => {
  // "这一页到底了"是正常结束，不是失败。分不清这两件事会让每次
  // 翻到最后一页都多开一次浏览器。
  resetThrottle();
  let browserCalls = 0;
  await withEngine((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<html><head><title>notld - 搜索</title></head><body>
      <p>${'没有更多结果了。'.repeat(100)}</p></body></html>`);
  }, async (base) => {
    const r = await searchWithLadder('google', 'notld', 9, {
      fetchFn: localFetch(base),
      skipThrottle: true,
      browserSearch: async () => { browserCalls += 1; return { results: [], related: [] }; },
    });
    assert.equal(r.strategy, 'http');
    assert.equal(r.results.length, 0);
    assert.equal(browserCalls, 0, '没被挡就不该升级');
  });
});

test('阶梯：httpOk=false 的引擎直接从浏览器起步，不白跑一次 HTTP', async () => {
  resetThrottle();
  let httpCalls = 0;
  const r = await searchWithLadder('yandex', 'notld', 1, {
    fetchFn: async () => { httpCalls += 1; throw new Error('不该走到这儿'); },
    skipThrottle: true,
    browserSearch: async () => ({ results: [], related: [], suspectBlocked: false }),
  });
  assert.equal(httpCalls, 0, 'Yandex 几乎必弹验证码，不该先试 HTTP');
  assert.equal(r.strategy, 'browser');
});

test('阶梯：全都不通时，要分清"被挡了"和"没配"', async () => {
  resetThrottle();

  // 情形一：被挡
  await withEngine((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(CAPTCHA_PAGE);
  }, async (base) => {
    const r = await searchWithLadder('google', 'x', 1, {
      fetchFn: localFetch(base), skipThrottle: true,
    });
    assert.equal(r.strategy, null);
    assert.ok(r.blocked, '被挡就要说被挡');
    assert.match(r.reason, /拦下/);
  });

  // 情形二：没配（引擎不适合 http，又没给浏览器和 api）
  const r2 = await searchWithLadder('yandex', 'x', 1, { skipThrottle: true });
  assert.equal(r2.strategy, null);
  assert.equal(r2.blocked, null, '没配不等于被挡，不该混为一谈');
  assert.match(r2.reason, /没有可用的检索策略/);
});

test('尝试记录能整理成人能读的一行', () => {
  const line = describeAttempts([
    { strategy: 'http', ok: false, detail: '被挡：captcha', elapsedMs: 120 },
    { strategy: 'browser', ok: true, detail: '8 条', elapsedMs: 2400 },
  ]);
  assert.match(line, /http✗/);
  assert.match(line, /browser✓/);
  assert.match(line, /2400ms/);
});

test('httpSupported 如实反映各家能不能走 HTTP', () => {
  assert.equal(httpSupported('duckduckgo'), true);
  assert.equal(httpSupported('yandex'), false);
  assert.equal(httpSupported('searxng'), true);
});
