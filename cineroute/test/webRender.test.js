/**
 * 前端渲染：第三方文本进 DOM。
 *
 * 片名、文件名、简介、页面标题全都来自归档站，是**用户上传的内容**。
 * 前端约定全程用 createElement + textContent，不做 innerHTML 拼接。
 * 这个约定的价值全在"真的没有例外"上，所以这里真开一次浏览器验：
 *
 *  1) 恶意标题不会变成 DOM 节点、不会执行脚本；
 *  2) 中文片名、`&`、`*`、全角标点原样显示，不被转义坏；
 *  3) 检索词能经 `?q=` 往返（分享链接刷新后还能复现同一次检索）。
 *
 * 上游数据用真夹具的形状，只把标题换成清单里的片名和攻击载荷——
 * 这样跑的是真实的解析路径，不是一个假造的响应。
 *
 * 机器上没有 Chromium 就整体跳过。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../src/server/server.js';
import { createFixtureFetch, createFixtureProbe, FIXTURE_SERP_CONFIG } from '../src/core/fixtureFetch.js';
import { defaultConfig } from '../src/core/sourceConfig.js';
import { launch, findChromeSync } from '../src/browser/cdp.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORPUS = JSON.parse(readFileSync(path.join(HERE, 'corpus/titles.json'), 'utf8'));

const CHROME = findChromeSync();
const needChrome = { skip: CHROME ? false : '本机没有 Chromium' };

/** 会出现在真实片名里、又容易被转义坏的写法。 */
const REAL = ['你好，李焕英', 'Deadpool & Wolverine', 'Thunderbolts*', '封神第一部：朝歌风云'];

/** 攻击载荷。归档站的条目标题是任何人都能填的。 */
const XSS = [
  '<img src=x onerror="window.__xss=1">',
  '<script>window.__xss=2</script>',
  '"><svg onload="window.__xss=3">',
  "javascript:window.__xss=4",
  '<iframe src="javascript:window.__xss=5"></iframe>',
];

const HOSTILE_TITLES = [...REAL, ...XSS];

const MEDIA_EXT = /\.(mp4|webm|mkv|ogv|mpg|avi|mov)$/i;

/**
 * 包一层夹具 fetch，把返回里的第三方文本换成我们要验的那些。
 * 形状仍是真的 IA 响应，走的也是真的解析代码。
 *
 * 载荷主要塞进**文件名**：片源卡片上显示的就是 `filename`（不是 title），
 * 塞错字段等于什么都没验——第一版就栽在这儿。
 * 标题、简介也一并换掉，它们会出现在别的位置（引用、线索、条目名）。
 */
function hostileFetch() {
  // 文件名与条目标题各用各的计数器。共用一个的话，载荷落到哪个字段
  // 取决于夹具里恰好有几个 doc、几个文件，换个夹具就漂了——
  // 断言"某个片名应该显示出来"也就跟着时灵时不灵。
  let fileN = 0;
  let titleN = 0;
  const inner = createFixtureFetch();
  return async (url, opts) => {
    const data = await inner(url, opts);
    const nextFile = () => HOSTILE_TITLES[fileN++ % HOSTILE_TITLES.length];
    const nextTitle = () => HOSTILE_TITLES[titleN++ % HOSTILE_TITLES.length];

    // 条目标题里**追加**载荷，而不是整个替换掉。
    //
    // 整个替换等于把条目变成"另一部片"——搜的是 Night of the Living Dead，
    // 条目却叫《你好，李焕英》。准入门槛会正当地把它挡在外面，于是页面上
    // 一条片源都不剩，这条用例就退化成在验"空页面里没有 XSS"，白验。
    // （引擎那条路以前没做片名过滤，所以这些条目能混进来，用例才一直是绿的；
    // 门槛补上之后这个依赖就暴露了。）
    //
    // 要验的是**载荷经过渲染路径之后有没有被转义坏**，所以条目得先进得来。
    // 追加的写法两头都占：片名对得上，载荷也照样走完整条渲染路径。
    if (data?.response?.docs) {
      data.response.docs.forEach((d) => { d.title = `${d.title} ${nextTitle()}`; });
    }
    if (data?.metadata) {
      data.metadata.title = `${data.metadata.title} ${nextTitle()}`;
      data.metadata.description = `简介里也来一发：${XSS[0]}`;
      if (Array.isArray(data.files)) {
        for (const f of data.files) {
          const ext = String(f.name || '').match(MEDIA_EXT);
          if (ext) f.name = `${nextFile()}${ext[0]}`;
        }
      }
    }
    return data;
  };
}

async function withPage(fn) {
  const server = await startServer({
    offline: true,
    offlineOpts: {
      fetchJson: hostileFetch(),
      probeFn: createFixtureProbe(),
      serp: { ...FIXTURE_SERP_CONFIG },
    },
    config: defaultConfig(),
    port: 0,
    host: '127.0.0.1',
    quiet: true,
  });
  const { port } = server.address();
  const browser = await launch({ executablePath: CHROME });
  try {
    const page = await browser.newPage({ width: 1200, height: 900 });
    try {
      return await fn(page, `http://127.0.0.1:${port}`);
    } finally {
      await page.close().catch(() => {});
    }
  } finally {
    await browser.close().catch(() => {});
    await new Promise((r) => server.close(r));
  }
}

/** 等到检索结果渲染出来。 */
const waitForResults = `new Promise((ok, fail) => {
  const t = setTimeout(() => fail(new Error('检索超时')), 25000);
  const tick = () => {
    const r = document.getElementById('results');
    if (r && !r.classList.contains('hidden')) { clearTimeout(t); ok(true); return; }
    const s = document.getElementById('status');
    if (s && s.classList.contains('error')) { clearTimeout(t); fail(new Error(s.textContent)); return; }
    setTimeout(tick, 120);
  };
  tick();
})`;

test('恶意标题进不了 DOM，也执行不了脚本', needChrome, async () => {
  await withPage(async (page, base) => {
    await page.goto(`${base}/?q=${encodeURIComponent('Night of the Living Dead')}`, { waitUntil: 'load' });
    await page.evaluate(waitForResults, { awaitPromise: true });

    const verdict = await page.evaluate(`(() => {
      const root = document.getElementById('results');
      return {
        xss: window.__xss ?? null,
        // 攻击载荷若被当成 HTML 解析，会真的造出这些节点
        injected: {
          img: root.querySelectorAll('img[src="x"]').length,
          script: root.querySelectorAll('script').length,
          svg: root.querySelectorAll('svg[onload]').length,
          iframe: root.querySelectorAll('iframe').length,
        },
        // 载荷应当以纯文本形式出现在页面上（说明走的是 textContent）
        showsPayloadAsText: root.textContent.includes('<img src=x onerror='),
        // 顺带确认页面确实渲染出了内容，不是空的导致上面全是 0
        rendered: root.textContent.length,
      };
    })()`);

    assert.ok(verdict.rendered > 200, `结果区几乎是空的（${verdict.rendered} 字），这一轮什么也没验到`);
    assert.equal(verdict.xss, null, `有脚本被执行了（window.__xss = ${verdict.xss}）`);
    assert.deepEqual(
      verdict.injected, { img: 0, script: 0, svg: 0, iframe: 0 },
      `攻击载荷被当成 HTML 解析了：${JSON.stringify(verdict.injected)}`,
    );
    assert.equal(verdict.showsPayloadAsText, true, '载荷应当原样显示为文本，说明走的是 textContent');
  });
});

test('中文片名与 & * 全角标点原样显示，不被转义坏', needChrome, async () => {
  await withPage(async (page, base) => {
    await page.goto(`${base}/?q=${encodeURIComponent('Night of the Living Dead')}`, { waitUntil: 'load' });
    await page.evaluate(waitForResults, { awaitPromise: true });

    // 片源卡片显示的是文件名，所以这些片名是以 `片名.mp4` 的形式出现在页面上的
    const text = await page.evaluate(`document.getElementById('results').textContent`);
    const missing = REAL.filter((t) => !text.includes(t));
    assert.deepEqual(missing, [], `这些片名没能原样显示：${missing.join(' / ')}`);
    // 常见的转义事故：显示成 &amp; 或 &lt;
    assert.ok(!text.includes('&amp;'), '出现了双重转义的 &amp;');
    assert.ok(!text.includes('&#'), '出现了数字实体，说明某处做了字符串拼接');
  });
});

test('检索词经 ?q= 往返：分享链接刷新后仍是同一次检索', needChrome, async () => {
  // 中文、空格、&、* 在 URL 里都要能正确编解码，否则分享出去的链接打不开
  const queries = ['你好，李焕英', 'Deadpool & Wolverine', 'Thunderbolts*', 'Dune: Part Two 2024'];
  await withPage(async (page, base) => {
    const bad = [];
    for (const q of queries) {
      await page.goto(`${base}/?q=${encodeURIComponent(q)}`, { waitUntil: 'load' });
      // 回填检索框是在启动那段 async 逻辑里做的（先要取 /api/config），
      // load 之后立刻读会读到空串——等它填上，等不到就是真的丢了
      const got = await page.evaluate(`new Promise((ok) => {
        const started = Date.now();
        const tick = () => {
          const v = document.getElementById('q').value;
          if (v || Date.now() - started > 8000) { ok(v); return; }
          setTimeout(tick, 60);
        };
        tick();
      })`, { awaitPromise: true });
      if (got !== q) bad.push(`  · 「${q}」读回来成了「${got}」`);
    }
    assert.equal(bad.length, 0, `${bad.length} 条检索词往返丢失：\n${bad.join('\n')}`);
  });
});

test('设置页把清单里的片名当域名/站点范围填进去也不会崩', needChrome, async () => {
  // 用户很可能把片名误粘进"优先来源"，这时要静静地清洗掉，不是白屏
  await withPage(async (page, base) => {
    await page.goto(`${base}/settings.html`, { waitUntil: 'load' });
    await page.evaluate(`new Promise((ok, fail) => {
      const t = setTimeout(() => fail(new Error('设置页加载超时')), 15000);
      const tick = () => {
        const b = document.getElementById('backendState');
        if (b && b.children.length) { clearTimeout(t); ok(true); return; }
        setTimeout(tick, 100);
      };
      tick();
    })`, { awaitPromise: true });

    const junk = [...CORPUS.zh.slice(0, 3), ...CORPUS.en.slice(0, 3)].map((e) => e.q).join('\n');
    const saved = await page.evaluate(`(async () => {
      document.getElementById('priorityDomains').value = ${JSON.stringify(`${junk}\nyifan.tv`)};
      document.getElementById('saveBtn').click();
      await new Promise((r) => setTimeout(r, 800));
      return {
        state: document.getElementById('saveState').textContent,
        domains: document.getElementById('priorityDomains').value,
        errors: document.getElementById('loadError').classList.contains('hidden'),
      };
    })()`, { awaitPromise: true });

    assert.match(saved.state, /已保存/, `保存失败：${saved.state}`);
    // 片名不是域名，应当被清洗掉；合法域名要留下
    assert.equal(saved.domains.trim(), 'yifan.tv', `清洗结果不对：${JSON.stringify(saved.domains)}`);
    assert.equal(saved.errors, true, '页面出现了加载错误');
  });
});
