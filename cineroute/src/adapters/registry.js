/**
 * 适配器注册表。
 *
 * 加一个新片源 = 写一个导出 `adapter` 的模块并在这里登记，
 * 无需改动编排、打分、播放、下载任何一环。
 *
 * 两类适配器：
 *   kind: 'direct'   —— 产出可直接播放/下载的视频直链（进 Top5 竞争）
 *   kind: 'metadata' —— 产出权威元数据与正版观看渠道（不产出直链）
 */

import { adapter as internetArchive } from './internetArchive.js';
import { adapter as wikimediaCommons } from './wikimediaCommons.js';
import { adapter as tmdb } from './tmdb.js';
import { adapter as jellyfin } from './jellyfin.js';

/** @type {object[]} */
export const ADAPTERS = [internetArchive, wikimediaCommons, jellyfin, tmdb];

export const DIRECT_ADAPTERS = ADAPTERS.filter((a) => a.kind === 'direct');
export const METADATA_ADAPTERS = ADAPTERS.filter((a) => a.kind === 'metadata');

/** 按 id 取适配器。 */
export function getAdapter(id) {
  return ADAPTERS.find((a) => a.id === id) || null;
}

/**
 * 判断某适配器在当前环境下是否可用（需要的配置是否齐备）。
 * @returns {{available: boolean, reason: string|null}}
 */
export function adapterAvailability(adapter) {
  if (!adapter.requiresConfig) return { available: true, reason: null };
  if (adapter.id === 'tmdb') {
    return process.env.TMDB_API_KEY
      ? { available: true, reason: null }
      : { available: false, reason: adapter.configHint };
  }
  if (adapter.id === 'jellyfin') {
    return process.env.JELLYFIN_URL && process.env.JELLYFIN_API_KEY
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
  if (process.env.JELLYFIN_URL) {
    try {
      if (new URL(process.env.JELLYFIN_URL).hostname === host) return { ok: true };
    } catch { /* 配置格式不对，忽略 */ }
  }

  return { ok: false, reason: `域名 ${host} 不在白名单内` };
}
