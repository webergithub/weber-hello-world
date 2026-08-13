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
  // 四个引擎默认都勾上，数量各自可调
  { id: 'engine:google', type: 'engine', engine: 'google', enabled: true, limit: 100 },
  { id: 'engine:baidu', type: 'engine', engine: 'baidu', enabled: true, limit: 100 },
  { id: 'engine:bing', type: 'engine', engine: 'bing', enabled: true, limit: 100 },
  { id: 'engine:duckduckgo', type: 'engine', engine: 'duckduckgo', enabled: true, limit: 100 },
];

/** 各引擎单次请求能返回的上限，用来提示用户"要翻几页"。 */
export const ENGINE_PAGE_SIZE = {
  google: 10, bing: 50, duckduckgo: 10, baidu: 10,
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

  return { version: 1, defaults, sources, siteScope };
}

/** 出厂配置。 */
export function defaultConfig() {
  return normalizeConfig({
    defaults: { limit: DEFAULT_LIMIT },
    sources: DEFAULT_SOURCES,
    siteScope: DEFAULT_SITE_SCOPE,
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
