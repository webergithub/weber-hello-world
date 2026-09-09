/**
 * 适配器注册表。
 *
 * 这里只登记"代码里有哪些源可用"，**具体启用哪些、每个取多少条，由配置决定**
 * （见 core/sourceConfig.js）。加一个新片源 = 写一个导出 `adapter` 的模块并在
 * BUILTIN_ADAPTERS 里登记，无需改动编排、打分、播放、下载任何一环。
 *
 * 三类适配器：
 *   kind: 'direct'   —— 产出可直接播放/下载的视频直链（进 Top5 竞争）
 *   kind: 'metadata' —— 产出权威元数据与正版观看渠道（不产出直链）
 *   kind: 'evidence' —— 只记录「某站点上出现了这部作品」，产出证据线索。
 *                       **永远不产出片源**，因此也永远不会进播放/下载通道。
 */

import { adapter as internetArchive } from './internetArchive.js';
import { adapter as wikimediaCommons } from './wikimediaCommons.js';
import { adapter as tmdb } from './tmdb.js';
import { adapter as jellyfin } from './jellyfin.js';
import { createEngineAdapter } from './searchEngine.js';
import { createPriorityAdapter } from './prioritySource.js';
import { defaultConfig } from '../core/sourceConfig.js';

/**
 * 代码里自带的适配器。搜索引擎不在这里——引擎是按配置动态造出来的，
 * 用户可以加任意多个（不同引擎、不同站点范围）。
 * @type {object[]}
 */
export const BUILTIN_ADAPTERS = [internetArchive, wikimediaCommons, jellyfin, tmdb];

/** 按 id 取内置适配器。 */
export function getBuiltin(id) {
  return BUILTIN_ADAPTERS.find((a) => a.id === id) || null;
}

/**
 * 按配置装配这一次检索要跑的适配器。
 *
 * 返回的是"计划"：适配器 + 它这次该取多少条。数量来自源自己的配置，
 * 源没配就用全局默认值。禁用的源直接不出现在计划里。
 *
 * @param {object} [config] 来自 sourceConfig.loadConfig()
 * @returns {Array<{adapter: object, source: object, limit: number}>}
 */
export function buildAdapters(config = defaultConfig()) {
  const fallbackLimit = config?.defaults?.limit ?? 100;
  const plan = [];

  // 优先来源排在最前面——「优先」就体现在这里：它先跑，结果先出。
  // 它的 kind 是 evidence，产出只进线索，不会与片源混在一起。
  const priority = config?.priority;
  if (priority?.enabled && priority.domains?.length) {
    plan.push({
      adapter: createPriorityAdapter({
        domains: priority.domains,
        limitPerDomain: priority.limitPerDomain,
        serp: config?.serp ?? null,
      }),
      source: { id: 'priority', type: 'priority', enabled: true },
      limit: priority.limitPerDomain,
    });
  }

  for (const s of config?.sources ?? []) {
    if (!s.enabled) continue;

    if (s.type === 'builtin') {
      const adapter = getBuiltin(s.id);
      // 配置里写了代码里不存在的内置源（改过配置又换了版本）——跳过，不让检索崩掉。
      if (!adapter) continue;
      plan.push({ adapter, source: s, limit: s.limit ?? fallbackLimit });
      continue;
    }

    // engine：每条配置造一个独立适配器，站点范围优先用源自己的，没有就用全局的。
    plan.push({
      adapter: createEngineAdapter({
        ...s,
        siteScope: s.siteScope || config.siteScope,
        serp: config.serp ?? null,
      }),
      source: s,
      limit: s.limit ?? fallbackLimit,
    });
  }

  return plan;
}

/**
 * 出厂配置下的完整适配器清单。
 * 供 /api/config 展示与 getAdapter 查询用——它代表"系统里有哪些源"，
 * 不代表"这次检索会跑哪些"（后者看 buildAdapters）。
 * @type {object[]}
 */
export const ADAPTERS = buildAdapters(defaultConfig()).map((p) => p.adapter);

export const DIRECT_ADAPTERS = ADAPTERS.filter((a) => a.kind === 'direct');
export const METADATA_ADAPTERS = ADAPTERS.filter((a) => a.kind === 'metadata');

/** 按 id 取适配器（含出厂引擎源）。 */
export function getAdapter(id) {
  return ADAPTERS.find((a) => a.id === id) || null;
}

/**
 * 判断某适配器在当前环境下是否可用（需要的配置是否齐备）。
 *
 * 适配器可以自带 checkConfig() 自查（引擎适配器就是这么做的）；
 * 没自带的走下面这几条内置判断。
 *
 * @param {object} adapter
 * @param {object} [env]
 * @param {{hasChrome?: boolean}} [opts] 透传给适配器的自查，主要给测试用
 * @returns {{available: boolean, reason: string|null, backend?: string|null}}
 */
export function adapterAvailability(adapter, env = process.env, opts = {}) {
  if (!adapter) return { available: false, reason: '未知的源' };
  if (!adapter.requiresConfig) return { available: true, reason: null };

  if (typeof adapter.checkConfig === 'function') {
    const verdict = adapter.checkConfig(env, opts);
    // backend/auto/why 只有引擎类源会给。带出来是为了界面上能显示
    // 「这次走的是哪条路、是自动挑的还是手动指定的」。
    const extra = verdict.backend !== undefined
      ? { backend: verdict.backend, backendAuto: verdict.auto ?? false, backendWhy: verdict.why ?? null }
      : {};
    return verdict.available
      ? { available: true, reason: null, ...extra }
      : { available: false, reason: verdict.reason || adapter.configHint, ...extra };
  }

  if (adapter.id === 'tmdb') {
    return env.TMDB_API_KEY
      ? { available: true, reason: null }
      : { available: false, reason: adapter.configHint };
  }
  if (adapter.id === 'jellyfin') {
    return env.JELLYFIN_URL && env.JELLYFIN_API_KEY
      ? { available: true, reason: null }
      : { available: false, reason: adapter.configHint };
  }
  return { available: true, reason: null };
}

/**
 * 允许直连播放/下载的域名白名单。
 *
 * 这是安全边界：服务端的媒体代理只会转发白名单内的地址，
 * 否则 /media?url= 就成了一个开放代理，可被用来打内网（SSRF）。
 * 新增 direct 适配器时必须同步在这里登记其域名。
 *
 * 注意：搜索引擎源不会往这里加域名。引擎只负责"发现页面"，
 * 页面要能被结构化解析器解析成片源才会进候选，而解析器产出的
 * 直链本来就落在下面这几个域名里。引擎搜到的其他域名只作为线索列出，
 * 不进播放/下载通道——所以加多少个引擎都不会扩大这道闸的口子。
 */
export const ALLOWED_MEDIA_HOSTS = [
  /(^|\.)archive\.org$/i,
  /(^|\.)us\.archive\.org$/i,
  /(^|\.)wikimedia\.org$/i,
  /(^|\.)wikipedia\.org$/i,
];

/**
 * 校验一个媒体地址是否允许被服务端代理。
 * Jellyfin 走用户自建地址，由 JELLYFIN_URL 显式授权。
 *
 * @param {string} url
 * @returns {{ok: boolean, reason?: string}}
 */
export function isAllowedMediaUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: '不是合法 URL' };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, reason: `不支持的协议 ${parsed.protocol}` };
  }

  const host = parsed.hostname;
  if (ALLOWED_MEDIA_HOSTS.some((re) => re.test(host))) return { ok: true };

  // 用户自己配置的 Jellyfin 服务器视为已授权。
  // 比的是 origin（协议 + 主机 + 端口）而不是只比主机名：授权
  // `http://192.168.1.50:8096` 不等于把那台机器上的 22、6379、
  // 各种内部管理口一起放行了。
  if (process.env.JELLYFIN_URL) {
    try {
      if (new URL(process.env.JELLYFIN_URL).origin === parsed.origin) return { ok: true };
    } catch { /* 配置格式不对，忽略 */ }
  }

  return { ok: false, reason: `域名 ${host} 不在白名单内` };
}
