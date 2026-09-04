/**
 * Internet Archive 适配器 —— 本系统的主力片源。
 *
 * 为什么它能满足"点开即播 + 离线下载"：
 * archive.org 的 Metadata API 会**逐文件**列出条目下的所有派生格式
 * （含 mp4 / ogv / mkv，以及 size、length、height、md5、sha1），
 * 下载域支持 HTTP Range 且开放 CORS。也就是说这里不需要"猜播放按钮"，
 * 上游本身就以结构化方式给出了真实视频直链和校验和——
 * 这正是盗版站抓取路线试图靠爬虫逆向、却做不稳的那部分数据。
 *
 * 两个公开接口，均免鉴权：
 *   搜索  GET https://archive.org/advancedsearch.php?...&output=json
 *   详情  GET https://archive.org/metadata/{identifier}
 */

import { httpJson, settleAll } from '../core/http.js';
import { titleMatches, yearCompatible, normalizeTitle } from '../core/match.js';

const SEARCH_ENDPOINT = 'https://archive.org/advancedsearch.php';
const METADATA_ENDPOINT = 'https://archive.org/metadata';
const DOWNLOAD_BASE = 'https://archive.org/download';
const DETAILS_BASE = 'https://archive.org/details';

/** 视频文件后缀白名单。非视频（缩略图、字幕、种子、元数据）一律跳过。 */
const VIDEO_EXT = new Set([
  'mp4', 'm4v', 'webm', 'ogv', 'ogg', 'mkv', 'avi', 'mov',
  'mpg', 'mpeg', 'wmv', 'flv', 'rm', 'rmvb', 'divx', 'asf',
]);

/** Lucene 特殊字符转义，防止用户输入把查询语法带歪。 */
function escapeLucene(s) {
  return String(s).replace(/([+\-!(){}[\]^"~*?:\\/])/g, '\\$1');
}

/**
 * IA 的 length 字段有两种写法：秒数字符串 "5460.00"，或 "1:31:00"。
 * @returns {number|null} 秒
 */
export function parseIaLength(length) {
  if (length == null) return null;
  const s = String(length).trim();
  if (!s) return null;
  if (s.includes(':')) {
    const parts = s.split(':').map(Number);
    if (parts.some((n) => !Number.isFinite(n))) return null;
    return parts.reduce((acc, n) => acc * 60 + n, 0);
  }
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** 归一化 collection 字段（IA 可能给字符串或数组）。 */
function toArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function fileExt(name) {
  const m = String(name).match(/\.([a-z0-9]{2,5})$/i);
  return m ? m[1].toLowerCase() : '';
}

/**
 * 把一个 IA 条目的 metadata 展开成若干候选片源。
 * 同一条目常有多档派生（HiRes MPEG4 / 512Kb MPEG4 / Ogg Video），
 * 每一档都是独立的可播地址，因此各自成为一个候选，由打分环节决定谁进 Top5。
 *
 * @param {object} meta   /metadata/{id} 的响应
 * @param {object} doc    advancedsearch 返回的条目摘要（含 downloads / licenseurl / collection）
 * @returns {object[]}
 */
export function extractSourcesFromMetadata(meta, doc = {}) {
  const identifier = meta?.metadata?.identifier || doc.identifier;
  if (!identifier || !Array.isArray(meta?.files)) return [];

  const itemTitle = meta.metadata?.title || doc.title || identifier;
  const license = meta.metadata?.licenseurl || doc.licenseurl || meta.metadata?.rights || '';
  const collections = toArray(meta.metadata?.collection ?? doc.collection);
  const downloads = Number(doc.downloads || 0);
  const pageUrl = `${DETAILS_BASE}/${identifier}`;

  const out = [];
  for (const f of meta.files) {
    const ext = fileExt(f.name || '');
    if (!VIDEO_EXT.has(ext)) continue;
    // 缩略图派生出的动图与极小体积文件不是正片。
    const bytes = Number(f.size || 0) || null;
    if (bytes != null && bytes < 512 * 1024) continue;

    out.push({
      id: `ia:${identifier}:${f.name}`,
      provider: 'internet-archive',
      providerLabel: 'Internet Archive',
      title: itemTitle,
      filename: f.name,
      url: `${DOWNLOAD_BASE}/${encodeURIComponent(identifier)}/${encodeURIComponent(f.name)}`,
      pageUrl,
      container: ext,
      format: f.format || null,
      width: f.width ? Number(f.width) : null,
      height: f.height ? Number(f.height) : null,
      durationSec: parseIaLength(f.length),
      bytes,
      license,
      collections,
      downloads,
      checksums: { md5: f.md5 || null, sha1: f.sha1 || null },
      // archive.org 下载域支持 Range 且开放 CORS，先给乐观默认值，
      // 随后的 probe 阶段会用真实响应头覆盖。
      rangeSupported: null,
      reachable: null,
    });
  }
  return out;
}

/**
 * 搜索并解析片源。
 *
 * @param {{title: string, year: number|null}} query
 * @param {{limit?: number, limitItems?: number, minSimilarity?: number, signal?: AbortSignal,
 *          fetchJson?: typeof httpJson}} [opts]
 * @returns {Promise<{provider: string, items: object[], sources: object[], error?: string}>}
 */
export async function search(query, opts = {}) {
  const {
    // 所有适配器统一接受 limit；limitItems 是这个适配器早先的参数名，保留为别名。
    limitItems = opts.limit ?? 8,
    minSimilarity = 0.55,
    signal,
    fetchJson = httpJson,
  } = opts;

  // **别名一起搜。** archive.org 的元数据几乎全是英文，拿「阿凡达」去查
  // title 字段是查不到任何东西的——这是中文片名"检索结果为 0"最直接的原因，
  // 而且看不出来：请求成功、返回 200、docs 就是空的。
  // 别名来自用户输入（「阿凡达 / Avatar」）与 TMDB 回流的原名。
  const names = [query.title, ...(query.aliases ?? []), ...(opts.aliases ?? [])]
    .map((x) => String(x || '').trim()).filter(Boolean);
  const titleClause = [...new Set(names)]
    .map((n) => `title:("${escapeLucene(n)}")`).join(' OR ');
  const clauses = [`(${titleClause})`, 'mediatype:(movies)'];
  if (query.year) clauses.push(`year:[${query.year - 2} TO ${query.year + 2}]`);

  const params = new URLSearchParams();
  params.set('q', clauses.join(' AND '));
  for (const fl of ['identifier', 'title', 'year', 'downloads', 'licenseurl', 'collection', 'avg_rating', 'description']) {
    params.append('fl[]', fl);
  }
  params.set('rows', String(limitItems * 3));
  params.set('page', '1');
  params.set('output', 'json');
  params.set('sort[]', 'downloads desc');

  let docs;
  try {
    const data = await fetchJson(`${SEARCH_ENDPOINT}?${params}`, { signal, timeoutMs: 10000 });
    docs = data?.response?.docs ?? [];
  } catch (err) {
    return { provider: 'internet-archive', items: [], sources: [], error: String(err.message || err) };
  }

  // 准入过滤：标题相似度与年份必须过关，否则不去拉 metadata（省一次往返）。
  const accepted = docs
    .map((d) => {
      const v = titleMatches(query, d.title || d.identifier, { minSimilarity, aliases: opts.aliases });
      return { doc: d, similarity: v.similarity, ok: v.ok };
    })
    .filter(({ doc, ok }) => ok && yearCompatible(query.year, doc.year))
    .sort((a, b) => b.similarity - a.similarity || (b.doc.downloads || 0) - (a.doc.downloads || 0))
    .slice(0, limitItems);

  // 逐条目取 metadata（并发，单条失败不影响其余）。
  const metas = await settleAll(
    accepted.map(({ doc }) => () =>
      fetchJson(`${METADATA_ENDPOINT}/${encodeURIComponent(doc.identifier)}`, { signal, timeoutMs: 10000 }),
    ),
  );

  const sources = [];
  const items = [];
  metas.forEach((meta, i) => {
    if (!meta) return;
    const { doc, similarity } = accepted[i];
    const extracted = extractSourcesFromMetadata(meta, doc);
    if (extracted.length === 0) return;
    items.push({
      identifier: doc.identifier,
      title: meta.metadata?.title || doc.title,
      year: Number(meta.metadata?.year || doc.year) || null,
      similarity,
      overview: meta.metadata?.description || doc.description || null,
      pageUrl: `${DETAILS_BASE}/${doc.identifier}`,
      sourceCount: extracted.length,
    });
    for (const s of extracted) {
      sources.push({ ...s, similarity, year: Number(meta.metadata?.year || doc.year) || null });
    }
  });

  return { provider: 'internet-archive', items, sources };
}

export const adapter = {
  id: 'internet-archive',
  label: 'Internet Archive（公有领域馆藏）',
  kind: 'direct',          // 产出可直接播放/下载的直链
  requiresConfig: false,
  search,
};

export { normalizeTitle };
