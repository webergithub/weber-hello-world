/**
 * 片源可播性探测。
 *
 * 上游元数据说"这是个 mp4"不等于它真的能播：链接可能已失效、
 * 可能不支持 Range（进度条拖不动、下载断了要从头来）、可能缺 CORS 头
 * （<video> 能播但 canvas 截帧和部分播放器会失败）、也可能 Content-Type
 * 与后缀不符。这些只有真的发一个请求才知道。
 *
 * 代价控制：只对**预排名靠前的候选**探测，用 HEAD 或 `Range: bytes=0-1`，
 * 单次开销约等于零；并发与超时由 http.js 的闸门统一约束。
 */

import { httpProbeHeaders, settleAll } from './http.js';

/** Content-Type → 容器，用于校正后缀撒谎的情况。 */
const MIME_TO_CONTAINER = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/ogg': 'ogv',
  'application/ogg': 'ogv',
  'video/x-matroska': 'mkv',
  'video/quicktime': 'mov',
  'video/x-msvideo': 'avi',
  'video/mpeg': 'mpg',
  'video/x-ms-wmv': 'wmv',
  'application/vnd.apple.mpegurl': 'm3u8',
  'application/x-mpegurl': 'm3u8',
};

/**
 * 探测单个片源，返回带探测结果的副本（不修改入参）。
 * 探测失败**不等于**片源不可用——可能只是上游禁 HEAD 或网络抖动，
 * 因此只在明确 4xx/5xx 时才标记 reachable=false。
 *
 * @param {object} source
 * @param {{signal?: AbortSignal, probeFn?: typeof httpProbeHeaders}} [opts]
 */
export async function probeSource(source, opts = {}) {
  const { signal, probeFn = httpProbeHeaders } = opts;

  let result;
  try {
    result = await probeFn(source.url, { signal, timeoutMs: 6000 });
  } catch {
    result = null;
  }

  if (!result) {
    // 探测没拿到结果：保持未知，不做否定判断。
    return { ...source, probed: true, probeOutcome: 'inconclusive' };
  }

  const { status, headers } = result;
  const h = (name) => headers?.get?.(name) ?? null;

  // 明确的客户端/服务端错误才判定不可达。
  if (status >= 400) {
    return {
      ...source,
      probed: true,
      probeOutcome: 'unreachable',
      reachable: false,
      httpStatus: status,
    };
  }

  const acceptRanges = (h('accept-ranges') || '').toLowerCase();
  const contentRange = h('content-range');
  // 206 + Content-Range 是最硬的 Range 证据；Accept-Ranges: bytes 次之。
  const rangeSupported = status === 206 || Boolean(contentRange) || acceptRanges.includes('bytes');

  const contentType = (h('content-type') || '').split(';')[0].trim().toLowerCase();
  const mimeContainer = MIME_TO_CONTAINER[contentType] || null;

  // 真实体积：206 时 Content-Length 是分片长度，要从 Content-Range 的 "/total" 取。
  let bytes = source.bytes;
  const totalFromRange = contentRange?.match(/\/(\d+)\s*$/);
  if (totalFromRange) bytes = Number(totalFromRange[1]);
  else if (status !== 206 && h('content-length')) bytes = Number(h('content-length'));

  return {
    ...source,
    probed: true,
    probeOutcome: 'ok',
    reachable: true,
    httpStatus: status,
    rangeSupported,
    corsOk: h('access-control-allow-origin') != null,
    contentType: contentType || null,
    // Content-Type 与后缀冲突时以服务端声明为准（后缀更容易撒谎）。
    container: mimeContainer && mimeContainer !== source.container ? mimeContainer : source.container,
    bytes: Number.isFinite(bytes) && bytes > 0 ? bytes : source.bytes,
  };
}

/**
 * 批量探测。只探测前 `limit` 个，其余原样返回。
 *
 * @param {object[]} sources 已按预排名排序
 * @param {{limit?: number, signal?: AbortSignal, probeFn?: typeof httpProbeHeaders}} [opts]
 * @returns {Promise<object[]>}
 */
export async function probeAll(sources, opts = {}) {
  const { limit = 12 } = opts;
  const head = sources.slice(0, limit);
  const tail = sources.slice(limit);

  const probed = await settleAll(head.map((s) => () => probeSource(s, opts)));
  return [...probed.map((p, i) => p ?? head[i]), ...tail];
}
