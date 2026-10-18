/**
 * Jellyfin 适配器 —— 检索**用户自己的媒体库**。
 *
 * 这是"直链播放 + 离线下载"在合法前提下最完整的形态：
 * 片子是你自己的（自购碟转录、自己拍的、已获授权的素材），
 * 服务器就在你自己手里，Jellyfin 原生提供 static 直链、支持 Range、
 * 并给出容器与视频流的分辨率/编码 —— 所有打分维度的输入一应俱全。
 *
 * 需要 JELLYFIN_URL 与 JELLYFIN_API_KEY；缺失时自动跳过。
 * 文档：GET /Items 与 GET /Videos/{id}/stream
 */

import { httpJson } from '../core/http.js';
import { titleSimilarity, yearCompatible } from '../core/match.js';

/** Jellyfin 的 RunTimeTicks 单位是 100 纳秒。 */
const TICKS_PER_SEC = 10_000_000;

/**
 * @param {{title: string, year: number|null}} query
 * @param {{baseUrl?: string, apiKey?: string, limit?: number, minSimilarity?: number,
 *          signal?: AbortSignal, fetchJson?: typeof httpJson}} [opts]
 */
export async function search(query, opts = {}) {
  const {
    baseUrl = process.env.JELLYFIN_URL,
    apiKey = process.env.JELLYFIN_API_KEY,
    limit = 20,
    minSimilarity = 0.5,
    signal,
    fetchJson = httpJson,
  } = opts;

  if (!baseUrl || !apiKey) {
    return { provider: 'jellyfin', items: [], sources: [], error: 'JELLYFIN_URL / JELLYFIN_API_KEY 未配置，已跳过' };
  }

  const base = String(baseUrl).replace(/\/+$/, '');
  const params = new URLSearchParams({
    searchTerm: query.title,
    IncludeItemTypes: 'Movie,Episode,Video',
    Recursive: 'true',
    Fields: 'MediaSources,ProductionYear,Overview,Path',
    Limit: String(limit),
  });

  let items;
  try {
    const data = await fetchJson(`${base}/Items?${params}`, {
      signal,
      timeoutMs: 8000,
      headers: { 'X-Emby-Token': apiKey },
    });
    items = data?.Items || [];
  } catch (err) {
    return { provider: 'jellyfin', items: [], sources: [], error: String(err.message || err) };
  }

  const sources = [];
  const matched = [];

  for (const item of items) {
    const similarity = titleSimilarity(query.title, item.Name || '');
    if (similarity < minSimilarity) continue;
    if (!yearCompatible(query.year, item.ProductionYear)) continue;

    const durationSec = item.RunTimeTicks ? Number(item.RunTimeTicks) / TICKS_PER_SEC : null;
    const mediaSources = item.MediaSources?.length ? item.MediaSources : [null];

    for (const ms of mediaSources) {
      const container = (ms?.Container || 'mp4').split(',')[0].toLowerCase();
      const videoStream = (ms?.MediaStreams || []).find((s) => s.Type === 'Video');
      const streamUrl = new URL(`${base}/Videos/${item.Id}/stream.${container}`);
      streamUrl.searchParams.set('static', 'true');
      streamUrl.searchParams.set('api_key', apiKey);
      if (ms?.Id) streamUrl.searchParams.set('mediaSourceId', ms.Id);

      sources.push({
        id: `jellyfin:${item.Id}:${ms?.Id || 'default'}`,
        provider: 'jellyfin',
        providerLabel: '我的媒体库 (Jellyfin)',
        title: item.Name,
        filename: `${item.Name}.${container}`,
        url: streamUrl.toString(),
        pageUrl: `${base}/web/index.html#!/details?id=${item.Id}`,
        container,
        format: videoStream?.Codec || ms?.Container || null,
        width: videoStream?.Width ? Number(videoStream.Width) : null,
        height: videoStream?.Height ? Number(videoStream.Height) : null,
        durationSec,
        bytes: ms?.Size ? Number(ms.Size) : null,
        license: 'owned-by-user',
        collections: ['my-library'],
        downloads: 0,
        checksums: { md5: null, sha1: null },
        similarity,
        year: item.ProductionYear || null,
        // Jellyfin 的 static 直链原生支持 Range。
        rangeSupported: true,
        reachable: null,
        ownedByUser: true,
      });
    }

    matched.push({
      identifier: item.Id,
      title: item.Name,
      year: item.ProductionYear || null,
      similarity,
      overview: item.Overview || null,
      pageUrl: `${base}/web/index.html#!/details?id=${item.Id}`,
      sourceCount: mediaSources.length,
    });
  }

  return { provider: 'jellyfin', items: matched, sources };
}

export const adapter = {
  id: 'jellyfin',
  label: '我的媒体库（Jellyfin，自有内容）',
  kind: 'direct',
  requiresConfig: true,
  configHint: '设置环境变量 JELLYFIN_URL 与 JELLYFIN_API_KEY',
  search,
};
