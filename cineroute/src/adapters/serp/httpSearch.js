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

/**
 * 每个引擎一个 cookie 罐。
 *
 * 不带 cookie 的后果不是"少了点什么"，是**每一页都长得像一次全新的匿名访问**。
 * 真人翻到第二页时带着第一页种下的会话 cookie，脚本不带——这个差别对方
 * 一眼就能看出来。存下来回传，第二页才像第一页的延续。
 *
 * 放模块级和节流同理：同一个进程里所有检索共用一份会话，
 * 各存各的等于白存。
 */
const jars = new Map();

/**
 * 被挡之后的惩罚倍数。
 *
 * 被挡是**最强的"你打太快了"信号**，比任何固定间隔都准。以前不管挡没挡
 * 都按同一个间隔走，等于收到警告还照原速撞上去。这里挡一次翻一倍，
 * 成功一次减一半——涨得快、退得慢，但会退：一次偶发拦截不该让这家引擎
 * 在整个进程生命周期里一直慢着。
 */
const penalties = new Map();
const MAX_PENALTY = 8;
/**
 * 惩罚之后的间隔上限。
 *
 * 光给倍数封顶不够：Google 的基准是 3 秒，×8 就是 24 秒一发，翻十页
 * 要四分钟——这不叫"谨慎"，叫这条线废了。被挡该慢下来，但一次检索
 * 还是得跑得完；真的一直被挡，正确的做法是让阶梯升级到别的策略，
 * 而不是在这儿无限期地耗着。
 */
const MAX_INTERVAL_MS = 12_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 记下响应里种的 cookie。 */
export function rememberCookies(engine, res) {
  const lines = res?.headers?.getSetCookie?.() ?? [];
  if (!lines.length) return;
  const jar = jars.get(engine) ?? new Map();
  for (const line of lines) {
    const pair = String(line).split(';')[0];
    const i = pair.indexOf('=');
    if (i <= 0) continue;
    const name = pair.slice(0, i).trim();
    const value = pair.slice(i + 1).trim();
    if (!name) continue;
    // 删除指令（1970 年过期，或值被清空）要真的删掉，不能留个空值回传
    if (!value || /expires=\s*Thu,\s*01\s*Jan\s*1970/i.test(line)) jar.delete(name);
    else jar.set(name, value);
  }
  jars.set(engine, jar);
}

/** 这家引擎目前攒了哪些 cookie。 */
export function cookiesFor(engine) {
  return new Map(jars.get(engine) ?? []);
}

/** 被挡了：下次对这家慢一倍。 */
export function noteBlocked(engine) {
  penalties.set(engine, Math.min((penalties.get(engine) ?? 1) * 2, MAX_PENALTY));
}

/** 顺利拿到结果：把惩罚退回去一半。 */
export function noteOk(engine) {
  const cur = penalties.get(engine) ?? 1;
  if (cur > 1) penalties.set(engine, Math.max(1, cur / 2));
}

/** 当前的惩罚倍数（测试与诊断用）。 */
export function penaltyFor(engine) {
  return penalties.get(engine) ?? 1;
}

/** 等到可以再打这家引擎为止。带抖动——固定间隔本身就是指纹。 */
export async function throttle(engine, now = Date.now(), wait = sleep) {
  // 惩罚倍数：被挡过就拉长间隔，但有绝对上限——见 MAX_INTERVAL_MS。
  const min = Math.min(
    (MIN_INTERVAL_MS[engine] ?? DEFAULT_INTERVAL_MS) * penaltyFor(engine),
    MAX_INTERVAL_MS,
  );
  const last = lastHitAt.get(engine) ?? 0;
  const jitter = Math.floor(min * 0.4 * Math.random());
  const readyAt = last + min + jitter;
  if (now < readyAt) await wait(readyAt - now);
  lastHitAt.set(engine, Date.now());
}

/** 测试用：把节流状态清干净。 */
export function resetThrottle() {
  lastHitAt.clear();
  jars.clear();
  penalties.clear();
}

/**
 * 按引擎名挑一套请求头。**正常情况下同一个引擎每次用同一套**——
 * 一个"浏览器"翻着翻着换了内核，比从头到尾用同一套可疑得多。
 *
 * 例外是重试：被挡之后拿同一套指纹再撞一次是没有意义的，对方刚认出它。
 * 所以只有 attempt > 0 时才换，换的是**整套**（UA + sec-ch-ua 一起走），
 * 不是只改 UA——只改 UA 会拼出一个现实中不存在的组合，更可疑。
 */
function profileFor(engine, attempt = 0) {
  let h = 0;
  for (const c of String(engine)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PROFILES[(h + attempt) % PROFILES.length];
}

/** 把 cookie 对象拼成一个请求头。 */
function cookieHeader(cookies) {
  const pairs = Object.entries(cookies || {});
  return pairs.length ? pairs.map(([k, v]) => `${k}=${v}`).join('; ') : null;
}

/**
 * 组一次请求的头。
 *
 * `recipe.headers` 可以是函数——Accept-Language 得跟着**查询词的语种**走，
 * 不能写死。拿中文片名去问一个 Accept-Language 写着 en-US 的 Google，
 * 拿回来的是英文语境的结果集。
 *
 * @param {string} engine
 * @param {object} recipe
 * @param {string} url
 * @param {string} [query] 这次搜的词，决定 locale
 */
export function buildHeaders(engine, recipe, url, query = '', attempt = 0) {
  const profile = profileFor(engine, attempt);
  const { name, ...ua } = profile;
  const recipeHeaders = typeof recipe.headers === 'function'
    ? recipe.headers(query)
    : (recipe.headers || {});
  const headers = { ...COMMON_HEADERS, ...ua, ...recipeHeaders };

  // 先铺攒下来的会话 cookie，**再让配方里的覆盖**。顺序不能反：
  // 配方里那几个（CONSENT=YES 之类）是专门用来跳过同意页的，
  // 让服务端后来种的值盖掉它，等于自己把刚绕过的同意页又请回来。
  const merged = { ...Object.fromEntries(cookiesFor(engine)), ...(recipe.cookies || {}) };
  const cookie = cookieHeader(merged);
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

/** 打一次，解析一次。重试逻辑在外面那层。 */
async function fetchAndParse(engine, query, page, attempt, opts) {
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
      headers: buildHeaders(engine, recipe, url, query, attempt),
      redirect: 'follow',
      signal: ac.signal,
    });
    // **不能用 res.text()**：它一律按 UTF-8 解，而百度这类站点返回的是 GBK，
    // 解出来是一片 "????" 且不报任何错。拿原始字节自己判编码，见 charset.js。
    decoded = decodeBody(await res.arrayBuffer(), res.headers?.get?.('content-type') || '');
    body = decoded.text;
    // 会话 cookie 存起来，下一页带回去——不带的话每一页都长得像一次
    // 全新的匿名访问，而真人翻页时是带着的
    rememberCookies(engine, res);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }

  const elapsedMs = Date.now() - started;
  // 编码信息一路带上去：取证时"这页是按什么编码读的"是溯源的一部分，
  // 偏离了声明更要说出来。
  const meta = {
    charset: decoded.charset, charsetNote: decoded.note,
    status: res.status, url, elapsedMs, attempt,
  };

  // SearXNG 之类直接给 JSON 的，走另一条解析路径
  if (recipe.json) {
    let data = null;
    try { data = JSON.parse(body); } catch { /* 不是 JSON，下面按被挡处理 */ }
    const blocked = recipe.blocked({ status: res.status, title: '', textLength: body.length, text: body })
      || (data ? null : '返回的不是 JSON，实例地址可能不对或未开放 JSON 输出');
    const parsed = data ? recipe.parseJson(data) : { results: [], related: [] };
    return { ...parsed, blocked, ...meta };
  }

  const blocked = recipe.blocked({
    status: res.status,
    title: pageTitle(body),
    textLength: visibleTextLength(body),
    text: stripTags(body).slice(0, 2000),
  });

  // 被挡了就别再去解析——那页上抠出来的东西全是噪音，
  // 混进结果里比没有结果更糟
  if (blocked) return { results: [], related: [], blocked, ...meta };

  const { results, related } = extractResults(body, url, recipe);
  return { results, related, blocked: null, ...meta };
}

/**
 * 被挡之后值不值得换套指纹再试一次。
 *
 * **429 不重试。** 它的字面意思就是"你请求太多了"，换个 User-Agent 再撞
 * 一次既不会成功，还多给对方一次证据。这时唯一对的做法是慢下来，
 * 而惩罚倍数已经替我们慢了。
 *
 * 403 和「200 但是张验证码页」值得试：这两种更像是**认出了你是谁**，
 * 而不是嫌你太快。换一套完整的请求头套装有机会绕过去。
 */
function worthRetrying(r) {
  if (!r.blocked) return false;
  if (r.status === 429) return false;
  return true;
}

/** 一次检索最多打几发。第二发换指纹，再多就是在给对方送样本了。 */
const MAX_ATTEMPTS = 2;

/**
 * 用 http 策略搜一页。
 *
 * 被挡时会**换一套完整的请求头套装重试一次**（429 除外，见 worthRetrying）。
 * 重试前惩罚倍数已经翻倍，所以第二发一定比第一发慢——收到警告还照原速
 * 撞上去是这类抓取最常见的死法。
 *
 * @param {string} engine
 * @param {string} query 已拼好 site: 限定的查询串
 * @param {number} page 从 1 开始
 * @param {{fetchFn?: Function, signal?: AbortSignal, timeoutMs?: number,
 *          baseUrl?: string, skipThrottle?: boolean, maxAttempts?: number}} [opts]
 * @returns {Promise<{results: object[], related: string[], blocked: string|null,
 *                    status: number, url: string, elapsedMs: number, attempts: number,
 *                    charset: string, charsetNote: string|null}>}
 */
export async function httpSearchPage(engine, query, page = 1, opts = {}) {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? MAX_ATTEMPTS);
  let last = null;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    last = await fetchAndParse(engine, query, page, attempt, opts);

    if (!last.blocked) {
      noteOk(engine);
      return { ...last, attempts: attempt + 1 };
    }

    // 被挡了先记账：下一发（以及后面所有对这家的请求）都会慢一倍
    noteBlocked(engine);
    if (attempt + 1 >= maxAttempts || !worthRetrying(last)) break;
  }

  return { ...last, attempts: maxAttempts };
}

/** 这家引擎能不能走 http 策略。 */
export function httpSupported(engine) {
  return recipeFor(engine).httpOk === true;
}

export { ENGINES };
