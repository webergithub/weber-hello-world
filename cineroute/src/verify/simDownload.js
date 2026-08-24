/**
 * 模拟下载：多线程并发拉，验证"这东西真的能下下来"，但不真的落盘。
 *
 * 为什么是"模拟"而不是真下：调研阶段要的是**结论**——能不能下、多快、
 * 支不支持并发分块、断了能不能续。为这个把几个 GB 拉完既慢又占磁盘，
 * 没必要。所以每个线程只取一小段 Range，把该验的都验了就停。
 *
 * 验的东西：
 *   · 服务端认不认 Range（返回 206 还是 200）——不认就没法并发也没法续传
 *   · 各线程拿到的字节区间对不对（要的是 [a,b]，给的是不是 [a,b]）
 *   · 实测吞吐（按最慢的线程算，那才是用户能感受到的速度）
 *   · 分片内容是否一致（同一区间取两次应当一模一样）
 */

import { httpRequest } from '../core/http.js';

/** 默认每个线程取多少字节。256KB 足够测出速度，又不至于真把文件拉下来。 */
export const DEFAULT_PROBE_BYTES = 256 * 1024;

const fmtSpeed = (bytes, ms) => (ms > 0 ? Math.round((bytes / ms) * 1000) : 0);

/**
 * 用 N 个线程模拟下载一个地址。
 *
 * @param {string} url
 * @param {{threads?: number, probeBytes?: number, totalBytes?: number|null,
 *          signal?: AbortSignal, requestFn?: Function}} [opts]
 */
export async function simulateDownload(url, opts = {}) {
  const {
    threads = 5,
    probeBytes = DEFAULT_PROBE_BYTES,
    totalBytes = null,
    signal,
    requestFn = httpRequest,
    // 逐跳校验跳转目标。这一步是直连上游发 Range 请求，不走本机的 /media 代理，
    // 所以那道闸管不到它——上游一个 302 就能把请求带进内网，
    // 返回的状态码和响应头会变成一个"某端口开着没有"的探针。
    checkRedirect = null,
  } = opts;
  const guard = checkRedirect ? { checkRedirect } : {};

  const started = Date.now();

  // 先摸一次拿总大小与 Range 支持；拿不到大小就退化成单线程顺序读
  let size = totalBytes;
  let acceptRanges = null;
  let headStatus = null;
  let contentType = null;
  try {
    const head = await requestFn(url, {
      headers: { range: 'bytes=0-1' }, timeoutMs: 10000, retries: 0, signal, ...guard,
    });
    headStatus = head.status;
    acceptRanges = head.headers.get('accept-ranges');
    contentType = head.headers.get('content-type');
    const cr = head.headers.get('content-range');
    if (cr) {
      const m = cr.match(/\/(\d+)\s*$/);
      if (m) size = Number(m[1]);
    } else if (!size) {
      const cl = head.headers.get('content-length');
      if (cl) size = Number(cl);
    }
    // 读掉 body，否则连接会挂着
    if (head.body) await head.body.cancel().catch(() => {});
  } catch (err) {
    return {
      url, ok: false, threads: 0,
      reason: `首次探测失败：${String(err?.message || err)}`,
      elapsedMs: Date.now() - started,
      rangeSupported: null, totalBytes: null, segments: [],
    };
  }

  const rangeSupported = headStatus === 206;
  if (!rangeSupported) {
    return {
      url, ok: false, threads: 1,
      reason: `服务端不支持 Range（返回 ${headStatus}），无法并发分块，也无法断点续传`,
      elapsedMs: Date.now() - started,
      rangeSupported: false, totalBytes: size ?? null, contentType, segments: [],
    };
  }

  // 把取样点均匀铺在整个文件上——只测头部的话测不出后半段是否完整。
  //
  // 文件比 probeBytes×线程数 还小时必须把每段缩小，否则各段会算出同一个
  // 起点、几个线程重复拉同一块，取回字节数还会超过文件本身，
  // 吞吐和耗时推算全跟着废掉。
  let n = Math.max(1, threads);
  let seg = probeBytes;      // 每个线程实际读多少
  let stride = probeBytes;   // 相邻两个取样点相隔多远

  if (size && size > 0) {
    if (size >= probeBytes * n) {
      // 大文件：取样点按 size/n 铺开，覆盖到片尾。
      // 若只按 probeBytes 递增，几个取样点会全挤在文件开头——
      // 100MB 的片子只测了前 1MB，测不出后半段是否完整。
      stride = Math.floor(size / n);
    } else {
      // 小文件：缩小每段，让 n 段正好铺满，避免线程之间重复拉同一块
      seg = Math.floor(size / n);
      if (seg < 1024) { n = Math.max(1, Math.floor(size / 1024)); seg = Math.floor(size / n); }
      stride = seg;
    }
  }

  const jobs = [];
  for (let i = 0; i < n; i++) {
    const start = i * stride;
    if (size && start >= size) break;
    const end = size ? Math.min(start + seg - 1, size - 1) : start + seg - 1;
    jobs.push({ index: i, start, end });
  }
  n = jobs.length;

  const segments = await Promise.all(jobs.map(async (job) => {
    const t0 = Date.now();
    try {
      const res = await requestFn(url, {
        headers: { range: `bytes=${job.start}-${job.end}` },
        timeoutMs: 20000, retries: 0, signal, ...guard,
      });
      if (res.status !== 206) {
        if (res.body) await res.body.cancel().catch(() => {});
        return { ...job, ok: false, status: res.status, reason: `期望 206，实际 ${res.status}` };
      }
      const buf = Buffer.from(await res.arrayBuffer());
      const ms = Date.now() - t0;
      const cr = res.headers.get('content-range') || '';
      // 服务端给的区间必须与请求一致，否则并发拼出来的文件会错位
      const expect = `bytes ${job.start}-${job.end}`;
      return {
        ...job, ok: true, status: 206, bytes: buf.length, elapsedMs: ms,
        bytesPerSec: fmtSpeed(buf.length, ms),
        contentRange: cr,
        rangeExact: cr.startsWith(expect),
        // 取前 16 字节做指纹，用来核对重复请求是否稳定
        head: buf.subarray(0, 16).toString('hex'),
      };
    } catch (err) {
      return { ...job, ok: false, reason: String(err?.message || err), elapsedMs: Date.now() - t0 };
    }
  }));

  const good = segments.filter((s) => s.ok);
  const elapsedMs = Date.now() - started;
  const totalFetched = good.reduce((a, s) => a + (s.bytes ?? 0), 0);
  // 并发吞吐按墙钟算：n 个线程一起跑完用了多久
  const aggregate = fmtSpeed(totalFetched, elapsedMs);
  const slowest = good.length ? Math.min(...good.map((s) => s.bytesPerSec)) : 0;
  const misaligned = good.filter((s) => !s.rangeExact);

  const ok = good.length === segments.length && misaligned.length === 0;
  let reason = null;
  if (!ok) {
    if (good.length < segments.length) reason = `${segments.length - good.length}/${segments.length} 个线程失败`;
    else reason = `${misaligned.length} 个线程拿到的字节区间与请求不符，并发分块会拼错`;
  }

  return {
    url, ok, reason,
    threads: n,
    rangeSupported: true,
    totalBytes: size ?? null,
    contentType,
    elapsedMs,
    fetchedBytes: totalFetched,
    aggregateBytesPerSec: aggregate,
    slowestThreadBytesPerSec: slowest,
    // 按实测吞吐推整片要多久——这是用户真正关心的数
    // 小文件不足一秒，取整会变成 0 看着像没测；保留一位小数
    estimatedFullDownloadSec: size && aggregate > 0
      ? Math.max(0.1, Math.round((size / aggregate) * 10) / 10) : null,
    segments,
  };
}

/**
 * 对一批地址并发跑模拟下载。
 *
 * 线程数是**每个地址内部**的分块并发；这里同时还会有多个地址在跑，
 * 所以真实并发是 地址数 × 线程数。http.js 的全局闸门会把总量压住，
 * 不至于把上游打爆。
 *
 * @param {Array<{url: string, bytes?: number|null, filename?: string}>} items
 */
export async function simulateBatch(items, opts = {}) {
  const results = await Promise.all(items.map(async (it) => {
    const r = await simulateDownload(it.url, { ...opts, totalBytes: it.bytes ?? null });
    return { ...r, filename: it.filename || it.url };
  }));
  return {
    total: results.length,
    ok: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    threadsEach: opts.threads ?? 5,
    results,
  };
}
