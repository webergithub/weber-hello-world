/**
 * 引擎配方表。
 *
 * 一个引擎要能被抓，需要知道的东西远不止"结果页地址是什么"。这张表把
 * 每个引擎的全部知识集中在一处，加一个引擎 = 加一条配方，不用改别处：
 *
 *   url        结果页地址（含翻页参数的算法——各家算法都不一样）
 *   pageSize   单页能拿几条，用来算要翻几页
 *   headers    这家认哪些请求头。少一个 Accept-Language 就可能拿到另一种版面
 *   cookies    绕过同意页要带的 cookie（Google/Bing 在欧盟会先弹同意页，
 *              不带 cookie 拿回来的是一个零结果的中间页）
 *   selectors  浏览器策略用的选择器，**给多套后备**——引擎改版面是常态，
 *              一套写死的选择器等于给自己埋一颗定时炸弹
 *   unwrap     把跳转包装还原成真实地址（Google 的 /url?q=、百度的 /link?url=、
 *              DDG 的 /l/?uddg=）
 *   ownHosts   引擎自家域名，抽取时要排掉，否则满屏都是它自己的导航链接
 *   blocked    这家被拦时页面长什么样
 *   related    相关搜索词在哪儿
 *   httpOk     标记这家能不能走纯 HTTP。做不到的（要跑 JS 才出结果）如实标 false，
 *              让策略阶梯直接跳到浏览器，别白费一次请求
 */

/** 从 URL 的查询参数里取出被包装的真实地址。 */
function unwrapParam(href, base, keys) {
  try {
    const u = new URL(href, base);
    for (const k of keys) {
      const v = u.searchParams.get(k);
      if (v && /^https?:\/\//i.test(v)) return v;
    }
  } catch { /* 不是合法 URL，原样返回 */ }
  return href;
}

/** 常见的拦截特征。各家文案不同，但套路就那几种。 */
const BLOCK_WORDS = [
  'captcha', 'unusual traffic', 'verify you are', 'are you a robot',
  'automated queries', 'suspicious activity', 'access denied',
  '人机验证', '异常流量', '验证码', '安全验证', '访问受限',
];

/** 通用拦截判定：正文极短，或标题/正文里出现验证字样。 */
function genericBlocked({ status, title, textLength, text }) {
  if (status === 429 || status === 403) return `HTTP ${status}`;
  const hay = `${title} ${String(text || '').slice(0, 2000)}`.toLowerCase();
  for (const w of BLOCK_WORDS) {
    if (hay.includes(w)) return `页面出现「${w}」字样`;
  }
  if (textLength < 500) return `正文只有 ${textLength} 字，疑似同意页或验证页`;
  return null;
}

export const ENGINES = {
  google: {
    label: 'Google',
    pageSize: 10,
    httpOk: true,           // 能出结果，但被挡的概率也最高
    url: (q, page, pageSize) =>
      `https://www.google.com/search?q=${encodeURIComponent(q)}`
      + `&num=${pageSize}&start=${(page - 1) * pageSize}&hl=en&gbv=1`,
    headers: { 'accept-language': 'en-US,en;q=0.9' },
    // CONSENT=YES 跳过欧盟同意页。不带这个 cookie，欧洲出口拿到的
    // 是一个只有"我同意"按钮的中间页，一条结果都没有。
    cookies: { CONSENT: 'YES+cb', SOCS: 'CAI' },
    ownHosts: ['google.com', 'gstatic.com', 'googleusercontent.com', 'youtube.com/redirect'],
    selectors: ['#search a[href]', '#rso a[href]', '#main a[href]', 'div.g a[href]'],
    unwrap: (href, base) => unwrapParam(href, base, ['q', 'url', 'imgurl']),
    related: (anchors) => anchors
      .filter((a) => /^\/search\?/.test(a.href) && a.text && a.text.length > 3)
      .map((a) => a.text),
    blocked: genericBlocked,
  },

  bing: {
    label: 'Bing',
    pageSize: 10,
    httpOk: true,
    url: (q, page, pageSize) =>
      `https://www.bing.com/search?q=${encodeURIComponent(q)}`
      + `&count=${pageSize}&first=${(page - 1) * pageSize + 1}&setlang=en`,
    headers: { 'accept-language': 'en-US,en;q=0.9' },
    cookies: { SRCHHPGUSR: 'SRCHLANG=en', _EDGE_CD: 'm=en-us' },
    ownHosts: ['bing.com', 'microsoft.com', 'msn.com'],
    selectors: ['#b_results li.b_algo a[href]', '#b_results h2 a[href]', '#b_content a[href]'],
    unwrap: (href, base) => unwrapParam(href, base, ['u', 'url', 'r']),
    related: (anchors) => anchors
      .filter((a) => /\/search\?q=/.test(a.href) && a.text && a.text.length > 3)
      .map((a) => a.text),
    blocked: genericBlocked,
  },

  duckduckgo: {
    label: 'DuckDuckGo',
    pageSize: 30,
    httpOk: true,           // html 端点不依赖 JS，是最好抓的一家
    // 这个端点是给不支持 JS 的浏览器用的，结构简单也稳定
    url: (q, page, pageSize) =>
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`
      + `&s=${(page - 1) * pageSize}&kl=us-en`,
    headers: { 'accept-language': 'en-US,en;q=0.9' },
    ownHosts: ['duckduckgo.com'],
    selectors: ['.result__a', '.results_links a.result__a', '#links a[href]'],
    // DDG 把外链包成 /l/?uddg=<编码后的真实地址>
    unwrap: (href, base) => unwrapParam(href, base, ['uddg', 'u']),
    related: () => [],
    blocked: genericBlocked,
  },

  baidu: {
    label: '百度',
    pageSize: 10,
    httpOk: true,
    url: (q, page, pageSize) =>
      `https://www.baidu.com/s?wd=${encodeURIComponent(q)}`
      + `&pn=${(page - 1) * pageSize}&rn=${pageSize}&ie=utf-8`,
    headers: { 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' },
    ownHosts: ['baidu.com', 'bdstatic.com', 'bdimg.com'],
    selectors: ['#content_left h3 a[href]', '#content_left a[href]', '.result a[href]'],
    // 百度的 /link?url= 是**服务端跳转**，参数里不含真实地址，只能保留包装地址。
    // 后面的逐跳校验会在真正访问时把它解开——这里硬猜只会猜错。
    unwrap: (href, base) => unwrapParam(href, base, ['url']),
    related: (anchors) => anchors
      .filter((a) => /\/s\?wd=/.test(a.href) && a.text && a.text.length > 2)
      .map((a) => a.text),
    blocked: genericBlocked,
  },

  yandex: {
    label: 'Yandex',
    pageSize: 10,
    httpOk: false,          // 几乎必弹验证码，别浪费一次 HTTP 请求
    url: (q, page) => `https://yandex.com/search/?text=${encodeURIComponent(q)}&p=${page - 1}`,
    headers: { 'accept-language': 'en-US,en;q=0.9' },
    ownHosts: ['yandex.com', 'yandex.ru', 'yastatic.net'],
    selectors: ['.serp-item a.OrganicTitle-Link', '.serp-item a[href]', '#search-result a[href]'],
    unwrap: (href) => href,
    related: () => [],
    blocked: genericBlocked,
  },

  /**
   * Mojeek：有**自己的索引**（不是转发 Google/Bing），而且不排斥抓取。
   * 结果数量比不上大厂，但在别家全被挡住时它往往还能出东西。
   */
  mojeek: {
    label: 'Mojeek',
    pageSize: 10,
    httpOk: true,
    url: (q, page, pageSize) =>
      `https://www.mojeek.com/search?q=${encodeURIComponent(q)}&s=${(page - 1) * pageSize}`,
    headers: { 'accept-language': 'en-US,en;q=0.9' },
    ownHosts: ['mojeek.com'],
    selectors: ['ul.results-standard li a.title', '.results a[href]', 'main a[href]'],
    unwrap: (href) => href,
    related: () => [],
    blocked: genericBlocked,
  },

  /**
   * SearXNG：自建元搜索。
   *
   * 这是"自有检索"最干净的答案——你自己部署一个实例，它替你去问
   * Google/Bing/DDG 并把结果聚合成 JSON。不用抓 HTML、不会被反自动化
   * 拦、也不用给谁付费，代价是你得自己维护一个服务。
   *
   * 地址由设置里的 URL 模板给出，所以这条配方不写死 url。
   */
  searxng: {
    label: 'SearXNG（自建）',
    pageSize: 20,
    httpOk: true,
    json: true,             // 直接返回 JSON，不用抓 HTML
    url: (q, page, pageSize, base) => {
      const root = String(base || '').replace(/\/+$/, '');
      return `${root}/search?q=${encodeURIComponent(q)}&format=json&pageno=${page}`
        + `&language=en&safesearch=0`;
    },
    headers: { accept: 'application/json' },
    ownHosts: [],
    selectors: [],
    unwrap: (href) => href,
    related: () => [],
    blocked: ({ status }) => (status >= 400 ? `HTTP ${status}` : null),
    /** SearXNG 的 JSON 结构。 */
    parseJson: (data) => ({
      results: (data?.results ?? []).map((r) => ({
        url: r.url, title: r.title || '', snippet: r.content || '',
      })).filter((r) => r.url),
      related: data?.suggestions ?? [],
    }),
  },
};

/** 认得的引擎名。 */
export const ENGINE_NAMES = Object.keys(ENGINES);

/**
 * 取一个引擎的配方。不认识的引擎给一份**通用配方**而不是报错——
 * 用户在设置里填了个没见过的名字时，至少还能按通用规则试一把。
 */
export function recipeFor(engine) {
  const known = ENGINES[engine];
  if (known) return known;
  return {
    label: engine,
    pageSize: 10,
    httpOk: false,
    url: (q) => `https://duckduckgo.com/?q=${encodeURIComponent(q)}`,
    headers: {},
    ownHosts: [],
    selectors: ['a[href]'],
    unwrap: (href) => href,
    related: () => [],
    blocked: genericBlocked,
    generic: true,
  };
}

/** 这条地址是不是引擎自家的导航链接。 */
export function isOwnHost(url, ownHosts) {
  if (!ownHosts?.length) return false;
  let host;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return false; }
  return ownHosts.some((h) => host === h || host.endsWith(`.${h}`) || url.includes(h));
}
