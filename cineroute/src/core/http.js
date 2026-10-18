/**
 * 带超时、重试、全局并发闸的 HTTP 客户端。
 *
 * 聚合检索会在一次查询里对多个上游打十几到几十个请求，没有闸门会同时
 * 打爆上游并触发限流。这里所有出网请求都必须经过 `httpJson` / `httpHead`，
 * 以便统一控制并发与退避。
 */

/** 简单信号量：限制同时在途的请求数。 */
class Semaphore {
  constructor(limit) {
    this.limit = limit;
    this.active = 0;
    /** @type {Array<() => void>} */
    this.queue = [];
  }

  async acquire() {
    if (this.active < this.limit) {
      this.active += 1;
      return;
    }
    await new Promise((resolve) => this.queue.push(resolve));
    this.active += 1;
  }

  release() {
    this.active -= 1;
    const next = this.queue.shift();
    if (next) next();
  }

  async run(fn) {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

const gate = new Semaphore(Number(process.env.CINEROUTE_MAX_CONCURRENCY || 6));

const DEFAULT_UA =
  'CineRoute/0.1 (+https://github.com/webergithub/weber-hello-world; public-domain media discovery)';

/** 抖动退避，避免多个失败请求同时重试形成尖峰。 */
function backoffDelay(attempt) {
  const base = 300 * 2 ** attempt;
  return base + Math.random() * base * 0.3;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 发起一次请求，带超时与有限重试。
 * 只对网络错误和 5xx / 429 重试；4xx 直接返回，重试没有意义。
 *
 * @param {string} url
 * @param {{method?: string, headers?: Record<string,string>, timeoutMs?: number,
 *          retries?: number, signal?: AbortSignal}} [opts]
 * @returns {Promise<Response>}
 */
export async function httpRequest(url, opts = {}) {
  const {
    method = 'GET',
    headers = {},
    timeoutMs = 8000,
    retries = 2,
    signal,
    // 给定时改为**手动跟随跳转**，每一跳都先过一遍这个校验。
    // 不给则行为与从前一致（交给 fetch 自己 follow）。
    checkRedirect = null,
    maxRedirects = 5,
  } = opts;

  /** 对单个地址发一次请求（含重试）。 */
  const attemptFetch = async (target) => {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
      const onAbort = () => controller.abort(signal?.reason);
      signal?.addEventListener('abort', onAbort, { once: true });

      try {
        const res = await gate.run(() =>
          fetch(target, {
            method,
            headers: { 'user-agent': DEFAULT_UA, ...headers },
            signal: controller.signal,
            redirect: checkRedirect ? 'manual' : 'follow',
          }),
        );

        if ((res.status >= 500 || res.status === 429) && attempt < retries) {
          lastErr = new Error(`upstream ${res.status}`);
          await sleep(backoffDelay(attempt));
          continue;
        }
        return res;
      } catch (err) {
        lastErr = err;
        // 调用方主动取消，不重试。
        if (signal?.aborted) throw err;
        if (attempt < retries) await sleep(backoffDelay(attempt));
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      }
    }
    throw lastErr ?? new Error(`request failed: ${target}`);
  };

  if (!checkRedirect) return attemptFetch(url);

  /* 逐跳校验。
   *
   * 存在的理由：白名单只看得见**第一个**地址。上游只要回一个 302，
   * fetch 自己就把请求带到任意主机上去了——内网、云元数据服务
   *（169.254.169.254）全都够得着，而响应体会被原样转回客户端。
   * 归档站本身也确实在用跳转（archive.org → iaNNNN.us.archive.org），
   * 所以不能一刀切禁掉，只能一跳一跳地查。 */
  let target = url;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const res = await attemptFetch(target);
    const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (!location) return res;

    let next;
    try {
      next = new URL(location, target).toString();
    } catch {
      throw new Error(`跳转地址无法解析：${location}`);
    }

    const verdict = checkRedirect(next);
    if (!verdict?.ok) {
      throw new Error(`拒绝跳转到 ${next}：${verdict?.reason ?? '不在允许范围内'}`);
    }
    // 上一跳的响应体要主动丢掉，否则连接会挂着
    await res.body?.cancel().catch(() => {});
    target = next;
  }
  throw new Error(`跳转次数超过上限（${maxRedirects} 跳）`);
}

/**
 * 取 JSON。上游返回非 2xx 或非 JSON 时抛出，由适配器降级处理。
 * @returns {Promise<any>}
 */
export async function httpJson(url, opts = {}) {
  const res = await httpRequest(url, {
    ...opts,
    headers: { accept: 'application/json', ...(opts.headers || {}) },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

/**
 * 探测资源头信息。优先 HEAD；部分 CDN 对 HEAD 返回 405，
 * 此时退化为 `GET Range: bytes=0-1`——只取两个字节，代价可忽略，
 * 而且顺带验证了服务端是否真的支持 Range（返回 206 才算支持）。
 *
 * @returns {Promise<{ok: boolean, status: number, headers: Headers}|null>}
 */
export async function httpProbeHeaders(url, opts = {}) {
  try {
    const head = await httpRequest(url, { ...opts, method: 'HEAD', retries: 1 });
    if (head.status !== 405 && head.status !== 501) {
      return { ok: head.ok, status: head.status, headers: head.headers };
    }
  } catch {
    // 落到下面的 Range 探测
  }

  try {
    const ranged = await httpRequest(url, {
      ...opts,
      method: 'GET',
      retries: 1,
      headers: { ...(opts.headers || {}), range: 'bytes=0-1' },
    });
    // 主动丢弃 body，避免连接挂在半读状态。
    await ranged.body?.cancel().catch(() => {});
    return { ok: ranged.ok, status: ranged.status, headers: ranged.headers };
  } catch {
    return null;
  }
}

/**
 * 并发跑一批任务，单个失败不影响整体（返回 null 占位）。
 * 聚合检索的基本约定：**任何单一上游都不能拖垮整次查询**。
 *
 * @template T
 * @param {Array<() => Promise<T>>} tasks
 * @returns {Promise<Array<T|null>>}
 */
export async function settleAll(tasks) {
  const results = await Promise.allSettled(tasks.map((t) => t()));
  return results.map((r) => (r.status === 'fulfilled' ? r.value : null));
}

export { Semaphore };
