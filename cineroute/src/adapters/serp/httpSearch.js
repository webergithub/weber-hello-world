/**
 * http 检索策略：直接请求结果页，自己解析。
 *
 * 就是「用 requests 发一个 GET，再从 response 里把结果抠出来」那条路。
 * 比开无头浏览器**快一到两个数量级**（几十毫秒 vs 两三秒），也不占内存，
 * 代价是拿不到 JS 渲染出来的东西，而且更容易被认出来是机器。
 *
 * 所以这里的功夫全花在"别让对方一眼看出是脚本"上，而这件事的关键
 * 不是把 User-Agent 换得多花哨，是**请求头要成套**：
 * 真实浏览器发的 Accept、Accept-Language、Sec-Fetch-* 是一整组，
 * 只改 UA 而其余不带，反而比不改更可疑。
 *
 * 另外三件容易被忽略但影响很大的事：
 *
 *  1) **同意页**。Google/Bing 在欧盟出口会先返回一个只有"我同意"按钮的
 *     中间页，HTTP 200，结构完整，就是一条结果都没有。不带 CONSENT
 *     cookie 的话，你会以为是选择器写错了，其实压根没到结果页。
 *
 *  2) **限速**。连着打十几个请求是最快让自己被封的方式。这里按引擎
 *     分别记录上次请求时间，强制留出间隔，并且带抖动——固定间隔本身
 *     就是一种指纹。
 *
 *  3) **字符编码**。百度返回的常常是 GBK，`res.text()` 按 UTF-8 解出来
 *     全是乱码，还不报错。所以这里取原始字节自己判编码，见 charset.js。
 */

import { ENGINES, recipeFor, isOwnHost } from './engines.js';
import { decodeBody } from './charset.js';
import {
  extractAnchors, snippetAfter, pageTitle, visibleTextLength, absolutize, stripTags,
} from './html.js';

/**
 * 请求头模板。
 *
 * 这几组取自真实浏览器，成套使用。不做"随机拼装"——拼出来的组合
 * 现实中不存在，反而是更明显的指纹。
 */
const PROFILES = [
  {
    name: 'chrome-win',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      + ' (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'sec-ch-ua': '"Chromium";v="131", "Not_A Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
  },
  {
    name: 'chrome-mac',
    'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
      + ' (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'sec-ch-ua': '"Chromium";v="131", "Not_A Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"macOS"',
  },
  {
    name: 'firefox-win',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
  },
];

/** 每次请求都带的那一套，与上面的 profile 合并。 */
const COMMON_HEADERS = {
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
  'accept-encoding': 'gzip, deflate, br',
  'upgrade-insecure-requests': '1',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'none',
  'sec-fetch-user': '?1',
  'cache-control': 'max-age=0',
};

/** 每个引擎两次请求之间至少隔多久（毫秒）。 */
const MIN_INTERVAL_MS = {
  google: 3000, bing: 1500, baidu: 1500, yandex: 4000,
  duckduckgo: 1000, mojeek: 1000, searxng: 200,
};
const DEFAULT_INTERVAL_MS = 1500;

/**
 * 按引擎限速。
 *
 * 状态放在模块级：同一个进程里所有检索共用一份节奏，
 * 否则并发五个引擎适配器各限各的，对同一家还是会打成一片。
 */
const lastHitAt = new Map();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 等到可以再打这家引擎为止。带抖动——固定间隔本身就是指纹。 */
export async function throttle(engine, now = Date.now(), wait = sleep) {
  const min = MIN_INTERVAL_MS[engine] ?? DEFAULT_INTERVAL_MS;
  const last = lastHitAt.get(engine) ?? 0;
  const jitter = Math.floor(min * 0.4 * Math.random());
  const readyAt = last + min + jitter;
  if (now < readyAt) await wait(readyAt - now);
  lastHitAt.set(engine, Date.now());
}

/** 测试用：把节流状态清干净。 */
export function resetThrottle() {
  lastHitAt.clear();
}

/** 按引擎名挑一个稳定的请求头套装——同一个引擎每次用同一套，别自己乱变。 */
function profileFor(engine) {
  let h = 0;
  for (const c of String(engine)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PROFILES[h % PROFILES.length];
}

/** 把 cookie 对象拼成一个请求头。 */
function cookieHeader(cookies) {
  const pairs = Object.entries(cookies || {});
  return pairs.length ? pairs.map(([k, v]) => `${k}=${v}`).join('; ') : null;
}

/**
 * 组一次请求的头。
 * @param {string} engine
 * @param {object} recipe
 * @param {string} url
 */
export function buildHeaders(engine, recipe, url) {
  const profile = profileFor(engine);
  const { name, ...ua } = profile;
  const headers = { ...COMMON_HEADERS, ...ua, ...(recipe.headers || {}) };

  const cookie = cookieHeader(recipe.cookies);
  if (cookie) headers.cookie = cookie;

  // 带上 Referer，看起来像是从首页点过来的
  try {
    const u = new URL(url);
    headers.referer = `${u.protocol}//${u.host}/`;
  } catch { /* 地址不合法，不带 referer */ }

  return headers;
}

/**
 * 从结果页 HTML 里抽结果。
 *
 * 不依赖选择器——纯 HTTP 拿到的是原始 HTML，没有 DOM 可查。做法是
 * **把所有锚点捞出来再按规则筛**：还原跳转包装 → 只留 http(s) →
 * 排掉引擎自家域名 → 按地址去重。这套比选择器抗改版：引擎换了 class 名
 * 照样能出结果，因为结果链接本身的形态是不变的。
 *
 * @param {string} html
 * @param {string} baseUrl 用来把相对地址补全
 * @param {object} recipe
 */
export function extractResults(html, baseUrl, recipe) {
  const anchors = extractAnchors(html);
  const seen = new Set();
  const results = [];

  for (const a of anchors) {
    let href = recipe.unwrap ? recipe.unwrap(a.href, baseUrl) : a.href;
    href = absolutize(href, baseUrl);
    if (!href || !/^https?:/i.test(href)) continue;
    if (isOwnHost(href, recipe.ownHosts)) continue;
    if (seen.has(href)) continue;

    const title = a.text.trim();
    // 没有文字的锚点多半是图标、缩略图，不是结果
    if (title.length < 2) continue;

    seen.add(href);
    results.push({
      url: href,
      title,
      snippet: snippetAfter(html, a.end),
    });
  }

  const related = (recipe.related ? recipe.related(anchors) : [])
    .map((t) => String(t).trim())
    .filter(Boolean);

  return { results, related: [...new Set(related)] };
}

/**
 * 用 http 策略搜一页。
 *
 * @param {string} engine
 * @param {string} query 已拼好 site: 限定的查询串
 * @param {number} page 从 1 开始
 * @param {{fetchFn?: Function, signal?: AbortSignal, timeoutMs?: number,
 *          baseUrl?: string, skipThrottle?: boolean}} [opts]
 * @returns {Promise<{results: object[], related: string[], blocked: string|null,
 *                    status: number, url: string, elapsedMs: number,
 *                    charset: string, charsetNote: string|null}>}
 */
export async function httpSearchPage(engine, query, page = 1, opts = {}) {
  const {
    fetchFn = fetch, signal, timeoutMs = 15000, baseUrl = '', skipThrottle = false,
  } = opts;
  const recipe = recipeFor(engine);
  const pageSize = recipe.pageSize ?? 10;
  const url = recipe.url(query, page, pageSize, baseUrl);

  if (!skipThrottle) await throttle(engine);

  const started = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('timeout')), timeoutMs);
  const onAbort = () => ac.abort(signal?.reason);
  signal?.addEventListener('abort', onAbort, { once: true });

  let res;
  let body;
  let decoded;
  try {
    res = await fetchFn(url, {
      headers: buildHeaders(engine, recipe, url),
      redirect: 'follow',
      signal: ac.signal,
    });
    // **不能用 res.text()**：它一律按 UTF-8 解，而百度这类站点返回的是 GBK，
    // 解出来是一片 "����" 且不报任何错。拿原始字节自己判编码，见 charset.js。
    decoded = decodeBody(await res.arrayBuffer(), res.headers?.get?.('content-type') || '');
    body = decoded.text;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }

  const elapsedMs = Date.now() - started;
  // 编码信息一路带上去：取证时"这页是按什么编码读的"是溯源的一部分，
  // 偏离了声明更要说出来。
  const charsetInfo = { charset: decoded.charset, charsetNote: decoded.note };

  // SearXNG 之类直接给 JSON 的，走另一条解析路径
  if (recipe.json) {
    let data = null;
    try { data = JSON.parse(body); } catch { /* 不是 JSON，下面按被挡处理 */ }
    const blocked = recipe.blocked({ status: res.status, title: '', textLength: body.length, text: body })
      || (data ? null : '返回的不是 JSON，实例地址可能不对或未开放 JSON 输出');
    const parsed = data ? recipe.parseJson(data) : { results: [], related: [] };
    return { ...parsed, blocked, status: res.status, url, elapsedMs, ...charsetInfo };
  }

  const title = pageTitle(body);
  const textLength = visibleTextLength(body);
  const blocked = recipe.blocked({
    status: res.status, title, textLength, text: stripTags(body).slice(0, 2000),
  });

  // 被挡了就别再去解析——那页上抠出来的东西全是噪音，
  // 混进结果里比没有结果更糟
  if (blocked) {
    return { results: [], related: [], blocked, status: res.status, url, elapsedMs, ...charsetInfo };
  }

  const { results, related } = extractResults(body, url, recipe);
  return { results, related, blocked: null, status: res.status, url, elapsedMs, ...charsetInfo };
}

/** 这家引擎能不能走 http 策略。 */
export function httpSupported(engine) {
  return recipeFor(engine).httpOk === true;
}

export { ENGINES };
