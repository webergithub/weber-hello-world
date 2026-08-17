/**
 * 数据源配置：不再把源写死在代码里。
 *
 * 每个源可以单独开关、单独设结果数量；也有一个全局默认数量给没单独配的源用。
 * 用户还能自己加源（目前支持加搜索引擎和自建 Jellyfin 实例）。
 *
 * 配置存在 config/sources.json，第一次写入时才创建；文件不存在就用代码里的默认值，
 * 所以 clone 下来不做任何配置也能跑。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CONFIG_PATH = process.env.CINEROUTE_CONFIG
  || path.resolve(HERE, '../../config/sources.json');

/** 全局默认：没给某个源单独配数量时用这个。 */
export const DEFAULT_LIMIT = Number(process.env.CINEROUTE_DEFAULT_LIMIT || 100);

/**
 * 引擎检索的站点范围。
 *
 * 引擎适配器会把这些域名拼成 `site:` 过滤条件，只在范围内搜。
 * 这是产品边界：不限定域名地搜片名再抓视频地址，搜到的绝大部分是盗版站。
 * 限定在归档站里搜，作用是补上没写专用适配器的那些站。
 * 这个列表用户可以增删。
 */
export const DEFAULT_SITE_SCOPE = [
  'archive.org',
  'commons.wikimedia.org',
  'upload.wikimedia.org',
  'www.loc.gov',                 // 美国国会图书馆
  'www.europeana.eu',            // 欧洲数字图书馆
  'openbeelden.nl',              // 荷兰开放影像
  'publicdomainmovie.net',
  'moviesfoundonline.com',
  'www.pond5.com/free',
];

/**
 * 优先来源：先查这些站点上「有没有这部片子」。
 *
 * 产出是**证据记录**（地址 + 页面标题 + 发现时间 + 可选截图），
 * 进线索列表，**不解析播放地址、不进播放/下载通道**。
 * 用途是侵权调查里的「取证」环节：确认某站上出现了这部作品并留证。
 *
 * 预置的两个是无授权影视站，正因如此它们是调查对象——
 * 记录它们上面有什么，与提供它们上面的东西，是两件事。
 * 这个列表用户可以自己改。
 */
export const DEFAULT_PRIORITY_DOMAINS = ['yifan.tv', 'olevod.com'];

export const DEFAULT_PRIORITY = {
  enabled: true,
  domains: DEFAULT_PRIORITY_DOMAINS,
  limitPerDomain: 10,
  // 是否给命中的页面截图存证。要开无头浏览器，慢一些。
  captureScreenshots: false,
  maxScreenshots: 5,
};

/**
 * 检索后端配置。
 *
 * 这一块**以前只能靠环境变量**，结果是：clone 下来直接跑，五个引擎全部
 * 因为「未配置检索后端」被跳过，搜索结果永远是空的。现在它进配置文件、
 * 进设置页，并且默认值是 `auto`——自己按现场情况挑一条能走的路：
 *
 *   配了 SERP 服务商 → api ；配了命令行工具 → cli ；本机有 Chromium → browser
 *
 * 三条都不通才报「没有可用的后端」，并说清楚缺什么。
 * 环境变量仍然有效，作用是给配置里留空的字段兜底（部署时不想把 key 写进文件）。
 */
export const SERP_BACKEND_CHOICES = ['auto', 'api', 'cli', 'browser'];
export const SERP_CMD_FORMATS = ['json', 'jsonl', 'lines'];

export const DEFAULT_SERP = {
  backend: 'auto',
  provider: '',        // serper / brave / custom
  key: '',             // API key。存本地配置文件，接口返回时会打码
  urlTemplate: '',     // provider=custom 或 browser 指向自建 SearXNG 时用
  cmd: '',             // cli 后端的命令模板，如 `ddgr --json -n {limit} {query}`
  cmdFormat: 'json',
  chromePath: '',      // 留空则按常见路径自动找
  timeoutMs: 25000,    // browser 后端打开结果页的超时
  settleMs: 800,       // load 之后再等多久取 DOM（结果常是脚本渲染的）
};

/**
 * 出厂默认源。
 *
 * builtin  —— 有专用适配器，直接解析出结构化片源
 * engine   —— 搜索引擎，产出"发现的页面"，能识别的域名再交给对应解析器
 */
export const DEFAULT_SOURCES = [
  { id: 'internet-archive', type: 'builtin', enabled: true, limit: 8 },
  { id: 'wikimedia-commons', type: 'builtin', enabled: true, limit: 20 },
  { id: 'jellyfin', type: 'builtin', enabled: true, limit: 20 },
  { id: 'tmdb', type: 'builtin', enabled: true, limit: 1 },
  // 五大引擎默认都勾上，数量各自可调
  { id: 'engine:google', type: 'engine', engine: 'google', enabled: true, limit: 100 },
  { id: 'engine:bing', type: 'engine', engine: 'bing', enabled: true, limit: 100 },
  { id: 'engine:baidu', type: 'engine', engine: 'baidu', enabled: true, limit: 100 },
  { id: 'engine:yandex', type: 'engine', engine: 'yandex', enabled: true, limit: 100 },
  { id: 'engine:duckduckgo', type: 'engine', engine: 'duckduckgo', enabled: true, limit: 100 },
];

/** 各引擎单次请求能返回的上限，用来提示用户"要翻几页"。 */
export const ENGINE_PAGE_SIZE = {
  google: 10, bing: 50, baidu: 10, yandex: 10, duckduckgo: 10,
};

/**
 * 检索词扩展的默认预算。
 *
 * 每多一个词，请求数就多「引擎数 × 页数」一份，SERP 服务按次计费，
 * 所以这几个数字直接决定一次检索的成本。默认值算下来是
 * 4 词 × 5 引擎 + 3 推荐词 × 5 引擎 = 35 组翻页请求。
 */
export const DEFAULT_EXPAND = {
  maxVariants: 4,      // 近似词上限（含原词）
  maxTerms: 4,         // 第一轮实际用几个词
  useSuggested: true,  // 是否用引擎返回的推荐搜索词补搜第二轮
  maxSuggested: 3,     // 第二轮用几个推荐词
};

/** 第三步嗅探甄别的条数上限。调研取证场景默认给得比展示场景大。 */
export const DEFAULT_PROBE_LIMIT = 24;

/**
 * 第五步「深度验证」的预算。
 *
 * 这一步是真开浏览器解码、真发并发请求，比前四步贵得多，所以每个数字
 * 都直接对应资源消耗：topN 决定验几个、threads 决定每个开几路并发、
 * maxRounds 决定最坏情况下重试到什么时候。
 */
export const DEFAULT_VERIFY = {
  enabled: true,
  topN: 5,          // 验第四步的前几名
  threads: 5,       // 模拟下载的并发线程数
  maxRounds: 10,    // 全军覆没时最多再试几轮
  shotWidth: 480,   // 截图采样宽度（也是清晰度计算的分辨率）
  probeBytes: 262144,
  concurrency: 2,   // 同时开几个浏览器页面做播放嗅探
};

const clampLimit = (v, fallback) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(1000, Math.round(n)));
};

/** 规范化单条源配置，挡掉非法字段。 */
export function normalizeSource(raw, defaults = {}) {
  if (!raw || typeof raw.id !== 'string' || !raw.id.trim()) return null;
  const type = ['builtin', 'engine'].includes(raw.type) ? raw.type : 'engine';
  const out = {
    id: raw.id.trim(),
    type,
    enabled: raw.enabled !== false,
    limit: clampLimit(raw.limit, defaults.limit ?? DEFAULT_LIMIT),
  };
  if (type === 'engine') {
    out.engine = typeof raw.engine === 'string' && raw.engine.trim()
      ? raw.engine.trim()
      : out.id.replace(/^engine:/, '');
    if (raw.label) out.label = String(raw.label).slice(0, 80);
    // 自定义引擎可以覆盖站点范围；不给就用全局的
    if (Array.isArray(raw.siteScope)) {
      out.siteScope = raw.siteScope.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 200);
    }
  }
  return out;
}

/** 规范化整份配置。 */
export function normalizeConfig(raw) {
  const defaults = {
    limit: clampLimit(raw?.defaults?.limit, DEFAULT_LIMIT),
  };
  const seen = new Set();
  const sources = [];
  for (const s of Array.isArray(raw?.sources) ? raw.sources : DEFAULT_SOURCES) {
    const n = normalizeSource(s, defaults);
    if (!n || seen.has(n.id)) continue;   // 同 id 只保留第一条
    seen.add(n.id);
    sources.push(n);
  }
  if (sources.length === 0) sources.push(...DEFAULT_SOURCES.map((s) => normalizeSource(s, defaults)));

  const siteScope = Array.isArray(raw?.siteScope) && raw.siteScope.length
    ? raw.siteScope.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 500)
    : [...DEFAULT_SITE_SCOPE];

  const expand = normalizeExpand(raw?.expand);
  const probeLimit = clampInt(raw?.probeLimit, DEFAULT_PROBE_LIMIT, 1, 200);
  const verify = normalizeVerify(raw?.verify);
  const priority = normalizePriority(raw?.priority);
  const serp = normalizeSerpConfig(raw?.serp);

  return { version: 1, defaults, serp, priority, sources, siteScope, expand, probeLimit, verify };
}

/**
 * 规范化检索后端配置。
 *
 * 注意与 adapters/serp.js 里的 `normalizeSerp` 不是一回事：那个是把各家 SERP
 * 服务的**响应**压成统一形状，这个是校验用户填的**设置**。
 */
export function normalizeSerpConfig(raw) {
  const str = (v, max = 500) => String(v ?? '').trim().slice(0, max);
  return {
    backend: SERP_BACKEND_CHOICES.includes(raw?.backend) ? raw.backend : 'auto',
    provider: ['serper', 'brave', 'custom'].includes(raw?.provider) ? raw.provider : '',
    key: str(raw?.key, 300),
    urlTemplate: str(raw?.urlTemplate),
    cmd: str(raw?.cmd),
    cmdFormat: SERP_CMD_FORMATS.includes(raw?.cmdFormat) ? raw.cmdFormat : 'json',
    chromePath: str(raw?.chromePath),
    timeoutMs: clampInt(raw?.timeoutMs, DEFAULT_SERP.timeoutMs, 3000, 120000),
    settleMs: clampInt(raw?.settleMs, DEFAULT_SERP.settleMs, 0, 15000),
  };
}

const clampInt = (v, fallback, lo, hi) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, Math.round(n)));
};

/**
 * 规范化优先来源配置。
 *
 * 域名要清洗：用户很可能整条 URL 粘进来（https://x.com/path），
 * 这里统一剥成裸域名，否则拼出来的 `site:` 条件不成立。
 */
export function normalizePriority(raw) {
  const cleanDomain = (v) => {
    let d = String(v || '').trim().toLowerCase();
    if (!d) return null;
    d = d.replace(/^https?:\/\//, '').replace(/^www\./, '');
    d = d.split('/')[0].split('?')[0].split('#')[0].split(':')[0];
    // 至少要长得像个域名，别把随手输入的中文当域名去搜
    return /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(d) ? d : null;
  };

  const list = Array.isArray(raw?.domains) ? raw.domains : DEFAULT_PRIORITY_DOMAINS;
  const seen = new Set();
  const domains = list.map(cleanDomain).filter((d) => d && !seen.has(d) && seen.add(d)).slice(0, 50);

  return {
    enabled: raw?.enabled !== false,
    // 全被清洗掉时不要静默变成空——那样这个模块等于没开
    domains: domains.length ? domains : [...DEFAULT_PRIORITY_DOMAINS],
    limitPerDomain: clampInt(raw?.limitPerDomain, DEFAULT_PRIORITY.limitPerDomain, 1, 100),
    captureScreenshots: raw?.captureScreenshots === true,
    maxScreenshots: clampInt(raw?.maxScreenshots, DEFAULT_PRIORITY.maxScreenshots, 1, 20),
  };
}

/** 规范化深度验证预算。上限卡死，免得一次检索把机器打满。 */
export function normalizeVerify(raw) {
  return {
    enabled: raw?.enabled !== false,
    topN: clampInt(raw?.topN, DEFAULT_VERIFY.topN, 1, 20),
    threads: clampInt(raw?.threads, DEFAULT_VERIFY.threads, 1, 16),
    maxRounds: clampInt(raw?.maxRounds, DEFAULT_VERIFY.maxRounds, 1, 10),
    shotWidth: clampInt(raw?.shotWidth, DEFAULT_VERIFY.shotWidth, 160, 1280),
    probeBytes: clampInt(raw?.probeBytes, DEFAULT_VERIFY.probeBytes, 4096, 8 * 1024 * 1024),
    concurrency: clampInt(raw?.concurrency, DEFAULT_VERIFY.concurrency, 1, 6),
  };
}

/** 规范化词扩展预算，把上限卡死——这几个数字直接决定 SERP 花多少钱。 */
export function normalizeExpand(raw) {
  return {
    maxVariants: clampInt(raw?.maxVariants, DEFAULT_EXPAND.maxVariants, 1, 10),
    maxTerms: clampInt(raw?.maxTerms, DEFAULT_EXPAND.maxTerms, 1, 10),
    useSuggested: raw?.useSuggested !== false,
    maxSuggested: clampInt(raw?.maxSuggested, DEFAULT_EXPAND.maxSuggested, 0, 10),
  };
}

/** 出厂配置。 */
export function defaultConfig() {
  return normalizeConfig({
    defaults: { limit: DEFAULT_LIMIT },
    serp: DEFAULT_SERP,
    sources: DEFAULT_SOURCES,
    siteScope: DEFAULT_SITE_SCOPE,
    expand: DEFAULT_EXPAND,
    probeLimit: DEFAULT_PROBE_LIMIT,
    verify: DEFAULT_VERIFY,
    priority: DEFAULT_PRIORITY,
  });
}

/** 读配置。文件不存在或坏了就回落到出厂值，不让启动失败。 */
export async function loadConfig(file = CONFIG_PATH) {
  try {
    const raw = JSON.parse(await fs.readFile(file, 'utf8'));
    return normalizeConfig(raw);
  } catch {
    return defaultConfig();
  }
}

/** 写配置。先规范化再落盘，避免把非法值写进文件。 */
export async function saveConfig(config, file = CONFIG_PATH) {
  const normalized = normalizeConfig(config);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(normalized, null, 2));
  return normalized;
}

/** 取某个源的生效数量：源上配了就用源上的，否则用全局默认。 */
export function limitFor(config, sourceId) {
  const s = config.sources.find((x) => x.id === sourceId);
  return s?.limit ?? config.defaults.limit ?? DEFAULT_LIMIT;
}

/** 当前启用的源。 */
export function enabledSources(config) {
  return config.sources.filter((s) => s.enabled);
}
