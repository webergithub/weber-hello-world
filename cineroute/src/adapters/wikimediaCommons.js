/**
 * Wikimedia Commons 适配器。
 *
 * Commons 上的影像一律是公有领域或自由许可（CC BY / BY-SA / CC0），
 * MediaWiki 的 imageinfo 接口直接返回文件直链、时长、分辨率与许可字段，
 * 且上游开放 CORS —— 又一个"结构化给出直链"的合法源。
 *
 * 覆盖面偏纪录/历史/动画短片，正片长片不如 Internet Archive 多，
 * 因此定位为补充源。
 */

import { httpJson } from '../core/http.js';
import { titleSimilarity } from '../core/match.js';

const API = 'https://commons.wikimedia.org/w/api.php';

/** Commons 文件名形如 "File:Metropolis (1927).webm"，取后缀判容器。 */
function extOf(title) {
  const m = String(title).match(/\.([a-z0-9]{2,5})$/i);
  return m ? m[1].toLowerCase() : '';
}

const VIDEO_EXT = new Set(['webm', 'ogv', 'ogg', 'mp4', 'mpg', 'mpeg', 'mov']);

/** extmetadata 的值都包在 {value: ...} 里。 */
function meta(extmetadata, key) {
  const v = extmetadata?.[key]?.value;
  return v == null ? null : String(v).replace(/<[^>]*>/g, '').trim();
}

/**
 * @param {{title: string, year: number|null}} query
 * @param {{limit?: number, minSimilarity?: number, signal?: AbortSignal,
 *          fetchJson?: typeof httpJson}} [opts]
 */
export async function search(query, opts = {}) {
  const { limit = 20, minSimilarity = 0.5, signal, fetchJson = httpJson } = opts;

  const params = new URLSearchParams({
    action: 'query',
    format: 'json',
    formatversion: '2',
    generator: 'search',
    gsrsearch: `filetype:video ${query.title}`,
    gsrnamespace: '6',                 // File: 命名空间
    gsrlimit: String(limit),
    prop: 'imageinfo',
    iiprop: 'url|size|mime|extmetadata|dimensions',
    origin: '*',
  });

  let pages;
  try {
    const data = await fetchJson(`${API}?${params}`, { signal, timeoutMs: 10000 });
    pages = data?.query?.pages ?? [];
  } catch (err) {
    return { provider: 'wikimedia-commons', items: [], sources: [], error: String(err.message || err) };
  }

  const sources = [];
  const items = [];
  for (const page of Array.isArray(pages) ? pages : Object.values(pages || {})) {
    const info = page?.imageinfo?.[0];
    if (!info?.url) continue;

    const container = extOf(info.url) || extOf(page.title);
    if (!VIDEO_EXT.has(container)) continue;

    const displayTitle = String(page.title || '').replace(/^File:/i, '').replace(/\.[a-z0-9]{2,5}$/i, '');
    const similarity = titleSimilarity(query.title, displayTitle);
    if (similarity < minSimilarity) continue;

    const license = meta(info.extmetadata, 'LicenseUrl')
      || meta(info.extmetadata, 'LicenseShortName')
      || meta(info.extmetadata, 'License')
      || '';

    sources.push({
      id: `commons:${page.pageid}`,
      provider: 'wikimedia-commons',
      providerLabel: 'Wikimedia Commons',
      title: displayTitle,
      filename: displayTitle + '.' + container,
      url: info.url,
      pageUrl: info.descriptionurl || `https://commons.wikimedia.org/wiki/${encodeURIComponent(page.title)}`,
      container,
      format: info.mime || null,
      width: info.width ? Number(info.width) : null,
      height: info.height ? Number(info.height) : null,
      durationSec: info.duration ? Number(info.duration) : null,
      bytes: info.size ? Number(info.size) : null,
      license,
      collections: ['wikimedia-commons'],
      downloads: 0,
      checksums: { md5: null, sha1: info.sha1 || null },
      similarity,
      rangeSupported: null,
      reachable: null,
    });

    items.push({
      identifier: String(page.pageid),
      title: displayTitle,
      year: null,
      similarity,
      pageUrl: info.descriptionurl,
      sourceCount: 1,
    });
  }

  return { provider: 'wikimedia-commons', items, sources };
}

export const adapter = {
  id: 'wikimedia-commons',
  label: 'Wikimedia Commons（自由许可影像）',
  kind: 'direct',
  requiresConfig: false,
  search,
};
