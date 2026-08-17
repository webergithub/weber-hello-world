/**
 * 搜索引擎后端：三条路，按可用性选。
 *
 *   api     —— 调 SERP 服务（serper / brave / 自定义 URL 模板）。稳，但要花钱。
 *   cli     —— 调本机命令行工具（ddgr 之类）。免费，但要机器上装了才有。
 *   browser —— 无头 Chromium 打开结果页，从 DOM 里取。免费、不用装东西，
 *              但**脆**：页面结构一改就得跟着改，而且引擎有反自动化检测，
 *              量一大就会被要求验证码。适合小批量调研，不适合当生产管道。
 *
 * 三种后端产出同一个形状：{ results: [{url,title,snippet,rank}], related: [...] }，
 * 上层（searchEngine.js）不需要知道结果是怎么来的。
 */

import { spawn } from 'node:child_process';
import { httpJson } from '../core/http.js';
import { harvestRelated } from '../core/expand.js';
import { findChromeSync } from '../browser/cdp.js';

export const SERP_BACKENDS = ['api', 'cli', 'browser'];
/** api 后端下支持的服务商。 */
export const SERP_PROVIDERS = ['serper', 'brave', 'custom'];

/** 每个引擎单次请求能拿多少条，用来算要翻几页。 */
export const PAGE_SIZE = { google: 10, bing: 50, baidu: 10, yandex: 10, duckduckgo: 10 };

/**
 * 合并「设置页里填的」与「环境变量里给的」。
 *
 * 规则：**设置页填了就用设置页的，留空的字段才回落到环境变量。**
 * 这样界面上改完立刻生效（否则用户在设置页改了没反应，只会觉得是坏的），
 * 同时保留用环境变量部署的老路子——尤其是 API key，不想写进配置文件的
 * 可以只放环境变量，设置页那一栏空着即可。
 *
 * @param {object} [env]
 * @param {object} [cfg] 配置文件里的 serp 块
 */
export function serpSettings(env = process.env, cfg = null) {
  const t = (v) => (v == null ? '' : String(v).trim());
  const or = (a, b) => t(a) || t(b) || null;
  // backend 的 'auto' 表示"没明说"，要继续往环境变量找，都没有就交给 resolveBackend 猜
  const explicit = cfg?.backend && cfg.backend !== 'auto' ? cfg.backend : t(env.CINEROUTE_SERP_BACKEND);
  return {
    backend: explicit || null,
    provider: or(cfg?.provider, env.CINEROUTE_SERP_PROVIDER),
    key: or(cfg?.key, env.CINEROUTE_SERP_KEY),
    urlTemplate: or(cfg?.urlTemplate, env.CINEROUTE_SERP_URL),
    cmd: or(cfg?.cmd, env.CINEROUTE_SERP_CMD),
    cmdFormat: or(cfg?.cmdFormat, env.CINEROUTE_SERP_CMD_FORMAT) || 'json',
    chrome: or(cfg?.chromePath, env.CINEROUTE_CHROME),
    timeoutMs: Number(cfg?.timeoutMs) > 0 ? Number(cfg.timeoutMs) : 25000,
    settleMs: Number.isFinite(Number(cfg?.settleMs)) ? Number(cfg.settleMs) : 800,
  };
}

/**
 * 决定这次到底走哪条路。
 *
 * 没有显式指定时按「已经配好了什么」自动挑，顺序是 api → cli → browser：
 * 付费服务最稳所以优先；命令行工具次之；无头浏览器免配置但最脆，排最后。
 * 一条都不通就返回 backend=null，由 checkBackend 组织成一句人话。
 *
 * @param {object} settings serpSettings() 的产物
 * @param {{hasChrome?: boolean}} [opts] 显式给出 Chromium 是否存在（测试用，
 *        也让调用方在已经启动过浏览器时省掉一次文件探测）
 */
export function resolveBackend(settings, opts = {}) {
  if (settings.backend) return { backend: settings.backend, auto: false, why: null };
  if (settings.provider) return { backend: 'api', auto: true, why: '已配置 SERP 服务商，自动选用 api' };
  if (settings.cmd) return { backend: 'cli', auto: true, why: '已配置命令行工具，自动选用 cli' };
  const hasChrome = opts.hasChrome ?? Boolean(findChromeSync(settings.chrome));
  if (hasChrome) return { backend: 'browser', auto: true, why: '本机有 Chromium，自动选用无头浏览器打开结果页' };
  return { backend: null, auto: true, why: null };
}

/**
 * 后端是否配齐了。没配齐要说清楚缺什么，不能假装能搜。
 *
 * @param {object} [env]
 * @param {object} [cfg] 配置文件里的 serp 块
 * @param {{hasChrome?: boolean}} [opts]
 * @returns {{available: boolean, backend: string|null, auto: boolean,
 *            why: string|null, reason: string|null}}
 */
export function checkBackend(env = process.env, cfg = null, opts = {}) {
  const s = serpSettings(env, cfg);
  const { backend, auto, why } = resolveBackend(s, opts);
  const no = (reason) => ({ available: false, backend, auto, why, reason });
  const yes = () => ({ available: true, backend, auto, why, reason: null });

  if (!backend) {
    return no('没有可用的检索后端：没配 SERP 服务商、没配命令行工具，本机也找不到 Chromium。'
      + '到设置页「检索后端」里选一种，或装个 Chromium 让它自动走无头浏览器');
  }
  if (!SERP_BACKENDS.includes(backend)) {
    return no(`不认识的后端 ${backend}，可选：${SERP_BACKENDS.join(' / ')}`);
  }
  if (backend === 'api') {
    if (!s.provider) return no('api 后端需要选一个服务商（设置页「检索后端」，或 CINEROUTE_SERP_PROVIDER）');
    if (!SERP_PROVIDERS.includes(s.provider)) {
      return no(`不认识的服务商 ${s.provider}，可选：${SERP_PROVIDERS.join(' / ')}`);
    }
    if (s.provider === 'custom' && !s.urlTemplate) {
      return no('provider=custom 需要同时填 URL 模板（CINEROUTE_SERP_URL）');
    }
    if (s.provider !== 'custom' && !s.key) return no('缺 API key（设置页「检索后端」，或 CINEROUTE_SERP_KEY）');
    return yes();
  }
  if (backend === 'cli') {
    if (!s.cmd) {
      return no('cli 后端需要填命令模板，如 `ddgr --json -n {limit} {query}`（CINEROUTE_SERP_CMD）');
    }
    return yes();
  }
  // browser：不用配，但机器上得真有 Chromium
  const hasChrome = opts.hasChrome ?? Boolean(findChromeSync(s.chrome));
  if (!hasChrome) {
    return no('选了 browser 后端，但本机找不到 Chromium。装一个，或在设置页填浏览器路径（CINEROUTE_CHROME）');
  }
  return yes();
}

/* ───────────────────── api 后端 ───────────────────── */

async function apiPage({ engine, q, pageSize, page, signal, fetchJson, settings }) {
  const { provider, key, urlTemplate } = settings;
  if (provider === 'serper') {
    const host = engine === 'google' ? 'google.serper.dev' : `${engine}.serper.dev`;
    return fetchJson(`https://${host}/search`, {
      method: 'POST',
      headers: { 'X-API-KEY': key, 'content-type': 'application/json' },
      body: JSON.stringify({ q, num: pageSize, page }),
      signal, timeoutMs: 12000,
    });
  }
  if (provider === 'brave') {
    const p = new URLSearchParams({ q, count: String(pageSize), offset: String((page - 1) * pageSize) });
    return fetchJson(`https://api.search.brave.com/res/v1/web/search?${p}`, {
      headers: { 'X-Subscription-Token': key, accept: 'application/json' },
      signal, timeoutMs: 12000,
    });
  }
  const url = urlTemplate
    .replace('{query}', encodeURIComponent(q))
    .replace('{engine}', encodeURIComponent(engine))
    .replace('{limit}', String(pageSize))
    .replace('{page}', String(page))
    .replace('{key}', encodeURIComponent(key || ''));
  return fetchJson(url, { signal, timeoutMs: 12000 });
}

/** 把各家不同的响应结构压成统一形状。 */
export function normalizeSerp(provider, data) {
  const pick = (arr, mapper) => (Array.isArray(arr) ? arr.map(mapper).filter((x) => x.url) : []);
  if (provider === 'brave') {
    return pick(data?.web?.results, (r) => ({
      url: r.url, title: r.title || '', snippet: r.description || '',
    }));
  }
  return pick(data?.organic || data?.results, (r) => ({
    url: r.link || r.url, title: r.title || '', snippet: r.snippet || r.description || '',
  }));
}

/* ───────────────────── cli 后端 ───────────────────── */

/**
 * 把命令模板拆成 argv 并填占位符。
 *
 * **刻意不走 shell**：查询词来自用户输入，拼进 shell 字符串就是命令注入。
 * 这里先按空白拆成 argv，再逐个参数替换占位符，spawn 时不带 shell，
 * 所以查询词里有什么字符都只会被当成一个参数。
 *
 * @param {string} template 如 `ddgr --json -n {limit} {query}`
 */
export function buildArgv(template, vars) {
  const parts = String(template).trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) throw new Error('命令模板为空');
  const subst = (s) => s.replace(/\{(query|engine|limit|page)\}/g, (_, k) => String(vars[k] ?? ''));
  return { cmd: subst(parts[0]), args: parts.slice(1).map(subst) };
}

/** 解析 CLI 输出。ddgr/googler 是 JSON 数组；也支持每行一个 JSON，或纯 URL 列表。 */
export function parseCliOutput(text, format = 'json') {
  const out = [];
  const push = (o) => {
    const url = o?.url || o?.link || o?.href;
    if (url) out.push({ url, title: o.title || o.name || '', snippet: o.abstract || o.snippet || o.description || '' });
  };

  if (format === 'lines') {
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (/^https?:\/\//i.test(t)) out.push({ url: t, title: '', snippet: '' });
    }
    return out;
  }
  if (format === 'jsonl') {
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try { push(JSON.parse(t)); } catch { /* 跳过坏行，不因一行毁掉整批 */ }
    }
    return out;
  }
  // json：整体是数组，或者 {results:[...]}/{organic:[...]}
  try {
    const data = JSON.parse(text);
    const arr = Array.isArray(data) ? data : (data.results || data.organic || []);
    for (const o of arr) push(o);
  } catch {
    return [];
  }
  return out;
}

function runCli(cmd, args, { timeoutMs = 20000, signal } = {}) {
  return new Promise((resolve, reject) => {
    // shell:false —— 查询词永远是一个独立参数，注入不了
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false, signal });
    let out = '', err = '';
    p.stdout.on('data', (c) => { out += c; });
    p.stderr.on('data', (c) => { err += c; });
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`命令超时：${cmd}`)); }, timeoutMs);
    p.on('error', (e) => { clearTimeout(timer); reject(new Error(`无法执行 ${cmd}：${e.message}`)); });
    p.on('close', (code) => {
      clearTimeout(timer);
      // 有些工具搜不到结果就返回非 0，这时有 stdout 就按成功处理
      if (code !== 0 && !out.trim()) reject(new Error(`${cmd} 退出码 ${code}：${err.slice(0, 200)}`));
      else resolve(out);
    });
  });
}

/* ───────────────────── browser 后端 ───────────────────── */

/** 各引擎结果页地址。page 从 1 开始。 */
export function engineSearchUrl(engine, q, page = 1, pageSize = 10) {
  const e = encodeURIComponent(q);
  const offset = (page - 1) * pageSize;
  switch (engine) {
    case 'google':     return `https://www.google.com/search?q=${e}&num=${pageSize}&start=${offset}&hl=en`;
    case 'bing':       return `https://www.bing.com/search?q=${e}&count=${pageSize}&first=${offset + 1}`;
    case 'baidu':      return `https://www.baidu.com/s?wd=${e}&pn=${offset}&rn=${pageSize}`;
    case 'yandex':     return `https://yandex.com/search/?text=${e}&p=${page - 1}`;
    // DuckDuckGo 的 html 端点没有 JS 依赖，结构也简单，比主站好取
    case 'duckduckgo': return `https://html.duckduckgo.com/html/?q=${e}&s=${offset}`;
    default:           return `https://duckduckgo.com/?q=${e}`;
  }
}

/**
 * 各引擎的结果容器选择器。取不到就退化成通用抽取。
 *
 * 注意**不要**写成 `a[href^="http"]`：Google 和百度的结果链接是相对地址的
 * 跳转包装（`/url?q=…`、`/link?url=…`），加了这个条件会把真正的结果全漏掉，
 * 只剩零星几条绝对地址的。真实地址由下面的 clean() 从查询参数里还原。
 */
const RESULT_SELECTORS = {
  google: '#search a[href], #rso a[href]',
  bing: '#b_results li.b_algo a[href]',
  baidu: '#content_left a[href]',
  yandex: '.serp-item a[href]',
  duckduckgo: '.result__a, .results_links a.result__a, a.result__url',
};

/** 引擎自家的域名，抽取时要排掉——不然满屏都是它自己的导航链接。 */
const ENGINE_HOSTS = {
  google: ['google.', 'gstatic.', 'youtube.com/redirect'],
  bing: ['bing.com', 'microsoft.com', 'msn.com'],
  baidu: ['baidu.com', 'bdstatic.com'],
  yandex: ['yandex.', 'ya.ru'],
  duckduckgo: ['duckduckgo.com'],
};

/**
 * 在页面里抽结果。先试引擎专用选择器，取不到再退化成
 * 「所有指向站外的链接」——后者结构无关，引擎改版也还能用。
 */
function extractionScript(engine) {
  const sel = RESULT_SELECTORS[engine] || '';
  const hosts = ENGINE_HOSTS[engine] || [];
  return `(() => {
    const own = ${JSON.stringify(hosts)};
    const isOwn = (u) => own.some(h => u.includes(h));
    const clean = (u) => {
      try {
        const url = new URL(u, location.href);
        // 引擎的跳转包装：真实地址在查询参数里
        for (const k of ['uddg','url','u','q','r']) {
          const v = url.searchParams.get(k);
          if (v && /^https?:\\/\\//i.test(v)) return v;
        }
        return url.href;
      } catch { return null; }
    };
    const seen = new Set();
    const out = [];
    const collect = (nodes) => {
      for (const a of nodes) {
        const href = clean(a.getAttribute('href') || '');
        if (!href || !/^https?:/i.test(href) || isOwn(href)) continue;
        if (seen.has(href)) continue;
        seen.add(href);
        const title = (a.innerText || a.textContent || '').trim().slice(0, 300);
        if (!title) continue;
        // 摘要：往上找最近的结果块，取它的文本
        let snip = '';
        let box = a.closest('li, div[class], article');
        for (let i = 0; i < 3 && box; i++) {
          const t = (box.innerText || '').trim();
          if (t.length > title.length + 20) { snip = t.slice(0, 400); break; }
          box = box.parentElement;
        }
        out.push({ url: href, title, snippet: snip });
      }
    };
    ${sel ? `collect(document.querySelectorAll(${JSON.stringify(sel)}));` : ''}
    if (out.length === 0) collect(document.querySelectorAll('a[href]'));
    // 相关搜索：各家标记不一，能拿到就拿
    const related = [...document.querySelectorAll(
      '#botstuff a, .related-searches a, #brs a, .b_rs a, #rs a, .b_ans a'
    )].map(a => (a.innerText||'').trim()).filter(t => t && t.length < 80).slice(0, 12);
    return { results: out, related, title: document.title, bodyLen: document.body.innerText.length };
  })()`;
}

/** 像样的 UA。默认那个 HeadlessChrome 会被大量站点直接挡掉。 */
export const DEFAULT_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/**
 * 用无头浏览器搜一页。
 * @param {object} browser 由 cdp.launch() 得到的连接（调用方负责复用与关闭）
 */
export async function browserSearchPage(browser, engine, q, page, pageSize, opts = {}) {
  // urlTemplate 让用户把结果页指到别处——最典型的用法是自建 SearXNG：
  // 它是开源元搜索，聚合 Google/Bing/DDG 等，自己部署一个就既不用付费 API、
  // 也不用直接爬引擎。占位符与 custom 后端一致。
  const url = opts.urlTemplate
    ? opts.urlTemplate
        .replace('{query}', encodeURIComponent(q))
        .replace('{engine}', encodeURIComponent(engine))
        .replace('{page}', String(page))
        .replace('{limit}', String(pageSize))
    : engineSearchUrl(engine, q, page, pageSize);
  const tab = await browser.newPage({ width: 1280, height: 900 });
  try {
    await tab.setUserAgent(opts.userAgent || DEFAULT_UA, opts.acceptLanguage || 'en-US,en;q=0.9');
    const nav = await tab.goto(url, { timeoutMs: opts.timeoutMs ?? 25000, waitUntil: 'load' });
    // 结果常常是脚本渲染的，load 之后再给一点时间
    await new Promise((r) => setTimeout(r, opts.settleMs ?? 800));
    const got = await tab.evaluate(extractionScript(engine));
    return {
      url,
      results: got?.results ?? [],
      related: got?.related ?? [],
      pageTitle: got?.title ?? '',
      elapsedMs: nav.elapsedMs,
      // 页面正文太短通常意味着被挡了（验证码/同意页），如实报出来
      suspectBlocked: (got?.bodyLen ?? 0) < 500 || /captcha|unusual traffic|verify you|人机验证/i.test(got?.title ?? ''),
    };
  } finally {
    await tab.close();
  }
}

/* ───────────────────── 统一入口 ───────────────────── */

/**
 * 按配置的后端搜一个词，自动翻页到 limit 条。
 *
 * @param {string} engine
 * @param {string} q 已拼好 site: 限定的查询串
 * @param {{limit?: number, signal?: AbortSignal, fetchJson?: Function, env?: object,
 *          serp?: object, browser?: object, onRelated?: Function}} [opts]
 * @returns {Promise<{results: object[], related: string[], backend: string, notes: string[]}>}
 */
export async function runSerp(engine, q, opts = {}) {
  const { limit = 100, signal, fetchJson = httpJson, env = process.env, browser, onRelated } = opts;
  const settings = serpSettings(env, opts.serp);
  // 已经拿到浏览器实例就不必再去磁盘上找 Chromium 了
  const verdict = checkBackend(env, opts.serp, browser ? { hasChrome: true } : {});
  if (!verdict.available) throw new Error(verdict.reason);

  const backend = verdict.backend;
  const pageSize = PAGE_SIZE[engine] ?? 10;
  const pages = Math.min(10, Math.ceil(limit / pageSize));
  const results = [];
  const related = [];
  const notes = [];

  for (let page = 1; page <= pages && results.length < limit; page += 1) {
    let items = [];
    try {
      if (backend === 'api') {
        const data = await apiPage({ engine, q, pageSize, page, signal, fetchJson, settings });
        if (page === 1) related.push(...harvestRelated(settings.provider, data));
        items = normalizeSerp(settings.provider, data);
      } else if (backend === 'cli') {
        const { cmd, args } = buildArgv(settings.cmd, { query: q, engine, limit: pageSize, page });
        const text = await runCli(cmd, args, { signal });
        items = parseCliOutput(text, settings.cmdFormat);
        // CLI 工具一般一次就把结果给全了，没有翻页概念
        if (items.length > 0) notes.push(`CLI 后端一次返回 ${items.length} 条，不翻页`);
      } else {
        if (!browser) throw new Error('browser 后端需要调用方传入已启动的浏览器连接');
        const r = await browserSearchPage(browser, engine, q, page, pageSize, {
          ...opts,
          urlTemplate: settings.urlTemplate,
          timeoutMs: opts.timeoutMs ?? settings.timeoutMs,
          settleMs: opts.settleMs ?? settings.settleMs,
        });
        items = r.results;
        if (page === 1) related.push(...r.related);
        if (r.suspectBlocked) {
          notes.push(`${engine} 疑似触发了反自动化拦截（页面内容异常短或标题含验证字样）`);
        }
      }
    } catch (err) {
      if (results.length > 0) { notes.push(`第 ${page} 页失败：${err.message}`); break; }
      throw err;
    }

    if (items.length === 0) break;
    for (const it of items) {
      if (results.length >= limit) break;
      results.push({ ...it, rank: results.length + 1 });
    }
    if (backend === 'cli') break;                     // CLI 不翻页
    if (items.length < pageSize) break;               // 不满一页说明到头了
  }

  if (typeof onRelated === 'function' && related.length) onRelated(related);
  return { results, related, backend, notes };
}
