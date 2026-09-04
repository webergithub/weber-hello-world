/**
 * python 检索策略：把**发请求**这一步交给 Python，解析仍留在这边。
 *
 * 为什么要有这条路
 * ----------------
 * 不是因为 Python 会写 HTTP 请求——Node 也会，`http` 策略就是。是因为
 * **TLS 指纹**。Google、Cloudflare 这类不只看 User-Agent：TLS 握手时
 * 客户端提供的密码套件顺序、扩展列表、曲线偏好合起来是一个指纹
 * （JA3/JA4），Node 的 undici 有它自己那一套，跟任何真浏览器都对不上。
 * 请求头调得再像也没用，握手那一刻就已经被认出来了。
 *
 * Python 的 `curl_cffi` 能直接冒充 Chrome 的握手。这是纯 Node 做不到的，
 * 也是这条路真正的价值。没装 curl_cffi 时脚本会退到 httpx/requests/urllib，
 * 那时它跟 `http` 策略的效果差不多——**返回里的 `via` 会如实说明用了哪个**，
 * 别让人以为换了条路就一定更能过检测。
 *
 * 为什么不让 Python 把结果也解析了
 * --------------------------------
 * 因为那意味着引擎配方（各家的翻页参数）、跳转包装还原、字符编码判定、
 * 拦截识别要在 JS 和 Python 里各写一份。这四样每一样都踩过坑、都带着
 * 血泪注释，**两份必然漂移**，而且漂移的那天不会有人发现——两条路
 * 各自都"能跑"，只是结果悄悄不一样了。
 *
 * 所以分工是：Node 拼 URL、组请求头、解析响应；Python 只负责把字节取回来。
 * 一份配方，两种传输。
 *
 * 脚本可以换（设置页里填路径），契约是 stdin 收一个 JSON 作业、
 * stdout 回一个 JSON 结果。想接 ddgs 或自己的爬虫，就回"自解析"那种
 * 形状，见下面 parsePythonResult 的说明。
 */

import { spawn } from 'node:child_process';
import { recipeFor } from './engines.js';
import { buildHeaders, throttle, extractResults } from './httpSearch.js';
import { decodeBody } from './charset.js';
import { pageTitle, visibleTextLength, stripTags } from './html.js';

/** 找不到解释器时按这个顺序试。 */
export const PYTHON_CANDIDATES = ['python3', 'python'];

/** 默认脚本相对仓库根的位置。 */
export const DEFAULT_SCRIPT = 'tools/serp_search.py';

/**
 * 跑一次脚本，把 JSON 作业喂进去。
 *
 * **不走 shell，查询词也不进命令行。** 作业整个从 stdin 传——命令行参数
 * 迟早会有人拼进 shell 字符串里，那就是命令注入。stdin 从根上没有这个问题。
 *
 * @param {{python?: string, script?: string, job: object, timeoutMs?: number,
 *          signal?: AbortSignal, spawnFn?: Function}} opts
 * @returns {Promise<object>} 脚本吐出来的 JSON
 */
export function runPythonScript(opts) {
  const {
    python = 'python3',
    script = DEFAULT_SCRIPT,
    job,
    timeoutMs = 20000,
    signal,
    spawnFn = spawn,
  } = opts;

  return new Promise((resolve, reject) => {
    let p;
    try {
      p = spawnFn(python, [script], { stdio: ['pipe', 'pipe', 'pipe'], shell: false, signal });
    } catch (err) {
      reject(new Error(`无法启动 ${python}：${String(err?.message || err)}`));
      return;
    }

    let out = '';
    let err = '';
    p.stdout.on('data', (c) => { out += c; });
    p.stderr.on('data', (c) => { err += c; });

    const timer = setTimeout(() => {
      p.kill('SIGKILL');
      reject(new Error(`Python 脚本超时（${timeoutMs}ms）：${script}`));
    }, timeoutMs);

    p.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`无法执行 ${python}：${String(e?.message || e)}`));
    });

    p.on('close', (code) => {
      clearTimeout(timer);
      const text = out.trim();
      if (!text) {
        // 脚本什么都没吐——把 stderr 带出去，否则用户只看到"空结果"，
        // 完全不知道是脚本崩了
        reject(new Error(`Python 脚本没有输出（退出码 ${code}）：${err.trim().slice(0, 300) || '（stderr 也是空的）'}`));
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error(`Python 脚本的输出不是 JSON：${text.slice(0, 200)}`));
      }
    });

    p.stdin.on('error', () => { /* 脚本提前退出，下面的 close 会报 */ });
    p.stdin.end(JSON.stringify(job));
  });
}

/**
 * 把脚本的应答翻成统一结果。
 *
 * 认两种形状：
 *
 *  · **传输模式**（默认脚本用的）：`{status, body_b64, content_type, final_url}`
 *    —— 只回字节，这边负责解码和解析。回 base64 是有意的：编码判定必须在
 *    这边做（百度会返 GBK），脚本先按 UTF-8 解一次就毁了。
 *
 *  · **自解析模式**：`{results, related}` —— 脚本自己出结果，原样收下。
 *    想接 ddgs、SearXNG 客户端、或自己写的爬虫就用这个。
 *
 * @param {object} data 脚本吐出来的 JSON
 * @param {{engine: string, recipe: object, url: string}} ctx
 */
export function parsePythonResult(data, ctx) {
  const { engine, recipe, url } = ctx;
  const via = data?.via ? `python/${data.via}` : 'python';

  if (!data || data.ok === false) {
    throw new Error(`Python 检索失败（${via}）：${data?.error || '脚本没说原因'}`);
  }

  // 自解析模式：脚本自己给了结果
  if (Array.isArray(data.results)) {
    return {
      results: data.results
        .map((r) => ({ url: r.url || r.link, title: r.title || '', snippet: r.snippet || r.content || '' }))
        .filter((r) => r.url),
      related: Array.isArray(data.related) ? data.related : [],
      blocked: data.blocked ?? null,
      status: data.status ?? 200,
      url: data.final_url || url,
      elapsedMs: data.elapsed_ms ?? 0,
      charset: null,
      charsetNote: null,
      via,
    };
  }

  // 传输模式：拿到字节，这边解码 + 解析
  const b64 = data.body_b64;
  if (typeof b64 !== 'string') {
    throw new Error(`Python 脚本既没给 results 也没给 body_b64（${via}）`);
  }
  const bytes = Buffer.from(b64, 'base64');
  const decoded = decodeBody(bytes, data.content_type || '');
  const body = decoded.text;
  const status = Number(data.status) || 0;
  const finalUrl = data.final_url || url;

  // JSON 端点（SearXNG）走另一条解析路径
  if (recipe.json) {
    let parsed = null;
    try { parsed = JSON.parse(body); } catch { /* 下面按被挡处理 */ }
    const blocked = recipe.blocked({ status, title: '', textLength: body.length, text: body })
      || (parsed ? null : '返回的不是 JSON，实例地址可能不对或未开放 JSON 输出');
    const got = parsed ? recipe.parseJson(parsed) : { results: [], related: [] };
    return {
      ...got, blocked, status, url: finalUrl,
      elapsedMs: data.elapsed_ms ?? 0,
      charset: decoded.charset, charsetNote: decoded.note, via,
    };
  }

  const blocked = recipe.blocked({
    status,
    title: pageTitle(body),
    textLength: visibleTextLength(body),
    text: stripTags(body).slice(0, 2000),
  });
  if (blocked) {
    return {
      results: [], related: [], blocked, status, url: finalUrl,
      elapsedMs: data.elapsed_ms ?? 0,
      charset: decoded.charset, charsetNote: decoded.note, via,
    };
  }

  const { results, related } = extractResults(body, finalUrl, recipe);
  return {
    results, related, blocked: null, status, url: finalUrl,
    elapsedMs: data.elapsed_ms ?? 0,
    charset: decoded.charset, charsetNote: decoded.note, via,
  };
}

/**
 * 用 Python 搜一页。签名与 httpSearchPage 一致——阶梯和管线不需要知道
 * 这一页是谁去取的。
 *
 * @param {string} engine
 * @param {string} query 已拼好的查询串
 * @param {number} page 从 1 开始
 * @param {{python?: string, script?: string, baseUrl?: string, timeoutMs?: number,
 *          signal?: AbortSignal, skipThrottle?: boolean, spawnFn?: Function}} [opts]
 */
export async function pythonSearchPage(engine, query, page = 1, opts = {}) {
  const recipe = recipeFor(engine);
  const pageSize = recipe.pageSize ?? 10;
  const url = recipe.url(query, page, pageSize, opts.baseUrl || '');

  // 限速跟 http 策略共用同一份节奏。换个传输不等于换了个身份——
  // 对方看到的还是同一个出口 IP，打太快照样封。
  if (!opts.skipThrottle) await throttle(engine);

  const job = {
    engine,
    query,
    page,
    url,
    headers: buildHeaders(engine, recipe, url, query),
    timeoutMs: opts.timeoutMs ?? 15000,
  };

  const data = await runPythonScript({
    python: opts.python,
    script: opts.script,
    job,
    timeoutMs: (opts.timeoutMs ?? 15000) + 5000,   // 给脚本留出启动与收尾的余量
    signal: opts.signal,
    spawnFn: opts.spawnFn,
  });

  return parsePythonResult(data, { engine, recipe, url });
}

/**
 * 问一下这台机器上这条路能不能走、会用哪个传输。设置页拿它做自检。
 *
 * @returns {Promise<{ok: boolean, via?: string, available?: string[],
 *                    python?: string, error?: string}>}
 */
export async function probePython(opts = {}) {
  try {
    const data = await runPythonScript({
      python: opts.python,
      script: opts.script,
      job: { probe: true },
      timeoutMs: opts.timeoutMs ?? 8000,
      spawnFn: opts.spawnFn,
    });
    return data?.ok ? data : { ok: false, error: data?.error || '脚本自检没通过' };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}
