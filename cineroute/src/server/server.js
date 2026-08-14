/**
 * CineRoute Web 服务：检索 API + 媒体代理 + 下载队列 + SSE 进度推送。
 *
 * 只用 node:http，零依赖 —— clone 下来 `node index.js --serve` 就能跑。
 */

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { searchAll } from '../core/pipeline.js';
import { httpRequest } from '../core/http.js';
import {
  isAllowedMediaUrl, BUILTIN_ADAPTERS, buildAdapters, adapterAvailability,
} from '../adapters/registry.js';
import {
  loadConfig, saveConfig, normalizeConfig, defaultConfig,
  ENGINE_PAGE_SIZE, DEFAULT_SITE_SCOPE, CONFIG_PATH,
} from '../core/sourceConfig.js';
import { SERP_PROVIDERS } from '../adapters/searchEngine.js';
import { DownloadManager } from './downloader.js';
import { launch, findChrome } from '../browser/cdp.js';
import { verifyWithRounds } from '../verify/deepVerify.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(HERE, '../web');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

async function readBody(req, limitBytes = 1024 * 64) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limitBytes) throw new Error('请求体过大');
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** 静态资源：只允许读 web/ 目录内的文件。 */
async function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const full = path.resolve(WEB_DIR, rel);
  if (!full.startsWith(WEB_DIR + path.sep) && full !== path.join(WEB_DIR, 'index.html')) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const data = await fs.readFile(full);
    res.writeHead(200, {
      'content-type': MIME[path.extname(full)] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not Found');
  }
}

/**
 * 媒体代理：把上游视频以同源方式转给 <video>，透传 Range。
 *
 * 存在的理由：部分上游没有 CORS 头、或只提供明文 HTTP，
 * 浏览器要么拒播要么被混合内容策略拦掉。同源代理一次性解决两者，
 * 并让进度条拖动（Range）继续可用。
 *
 * 安全边界：只转发 registry 白名单内的域名。没有这道闸，
 * 这个接口就是一个开放代理，可被用来探测内网（SSRF）。
 */
async function proxyMedia(req, res, target) {
  const verdict = isAllowedMediaUrl(target);
  if (!verdict.ok) {
    sendJson(res, 403, { error: `媒体代理拒绝该地址：${verdict.reason}` });
    return;
  }

  const headers = {};
  if (req.headers.range) headers.range = req.headers.range;

  let upstream;
  try {
    upstream = await httpRequest(target, { headers, timeoutMs: 30000, retries: 1 });
  } catch (err) {
    sendJson(res, 502, { error: `上游请求失败：${String(err?.message || err)}` });
    return;
  }

  const pass = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag'];
  const out = {};
  for (const h of pass) {
    const v = upstream.headers.get(h);
    if (v) out[h] = v;
  }
  out['cache-control'] = 'no-store';

  res.writeHead(upstream.status, out);
  if (!upstream.body) { res.end(); return; }

  // 客户端提前断开（用户拖进度条/关页面）时要主动掐掉上游，否则连接泄漏。
  const reader = upstream.body.getReader();
  let closed = false;
  res.on('close', () => { closed = true; reader.cancel().catch(() => {}); });

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || closed) break;
      if (!res.write(Buffer.from(value))) {
        await new Promise((r) => res.once('drain', r));
      }
    }
  } catch { /* 传输中断，直接收尾 */ }
  res.end();
}

/**
 * 启动服务。
 * @param {{offline?: boolean, offlineOpts?: object, port?: number,
 *          host?: string, downloadDir?: string}} [options]
 */
export async function startServer(options = {}) {
  const {
    offline = false,
    offlineOpts = {},
    port = Number(process.env.CINEROUTE_PORT || 8787),
    // 绑定地址。放在 Nginx 之类的反代后面时设成 127.0.0.1，
    // 否则应用端口自己也对公网开着，绕过反代上的一切限制就能直连。
    host = process.env.CINEROUTE_HOST || '0.0.0.0',
    downloadDir = process.env.CINEROUTE_DOWNLOAD_DIR || path.resolve(process.cwd(), 'downloads'),
  } = options;

  const downloads = new DownloadManager({ dir: downloadDir, concurrency: 2 });
  /** @type {Set<import('node:http').ServerResponse>} */
  const sseClients = new Set();

  // 数据源配置：进程启动时读一次，PUT /api/sources 之后就地更新。
  // 配置文件不存在也能跑——loadConfig 会回落到出厂默认。
  let sourceConfig = await loadConfig();

  // 深度验证要开无头浏览器。开一次很贵（两秒多），所以进程内复用一个实例，
  // 用完不关；进程退出时统一收。并发由 verify.concurrency 控制页面数。
  let sharedBrowser = null;
  let browserLaunching = null;
  async function getBrowser() {
    if (sharedBrowser && !sharedBrowser.closed) return sharedBrowser;
    if (!browserLaunching) {
      browserLaunching = launch().then((b) => { sharedBrowser = b; browserLaunching = null; return b; })
        .catch((e) => { browserLaunching = null; throw e; });
    }
    return browserLaunching;
  }

  /** 把"系统里有哪些源可选"告诉前端，用来渲染勾选面板。 */
  function sourceCatalog() {
    const enabledIds = new Set(sourceConfig.sources.map((s) => s.id));
    return {
      builtins: BUILTIN_ADAPTERS.map((a) => {
        const av = adapterAvailability(a);
        return {
          id: a.id, label: a.label, kind: a.kind,
          available: av.available, reason: av.reason,
          configHint: a.configHint || null,
          inConfig: enabledIds.has(a.id),
        };
      }),
      // 出厂支持的引擎；用户也能填别的名字，走 custom 模板转发
      engines: Object.entries(ENGINE_PAGE_SIZE).map(([engine, pageSize]) => ({
        engine, pageSize, id: `engine:${engine}`, inConfig: enabledIds.has(`engine:${engine}`),
      })),
      serpProviders: SERP_PROVIDERS,
      serpConfigured: Boolean(process.env.CINEROUTE_SERP_PROVIDER),
      defaultSiteScope: DEFAULT_SITE_SCOPE,
      configPath: CONFIG_PATH,
    };
  }

  downloads.on('update', (job) => {
    const frame = `event: download\ndata: ${JSON.stringify(job)}\n\n`;
    for (const client of sseClients) client.write(frame);
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const { pathname } = url;

    try {
      if (pathname === '/api/config') {
        sendJson(res, 200, {
          offline,
          downloadDir,
          // 这次配置下真正会跑的源
          adapters: buildAdapters(sourceConfig).map(({ adapter, limit }) => {
            const av = adapterAvailability(adapter);
            return {
              id: adapter.id, label: adapter.label, kind: adapter.kind, limit,
              available: av.available, reason: av.reason,
            };
          }),
        });
        return;
      }

      // 数据源配置：读 / 改。改完立即生效，下一次检索就按新配置跑。
      if (pathname === '/api/sources' && req.method === 'GET') {
        sendJson(res, 200, { config: sourceConfig, catalog: sourceCatalog() });
        return;
      }

      if (pathname === '/api/sources' && (req.method === 'PUT' || req.method === 'POST')) {
        let incoming;
        try {
          incoming = JSON.parse(await readBody(req));
        } catch (err) {
          sendJson(res, 400, { error: `配置解析失败：${String(err?.message || err)}` });
          return;
        }
        // reset:true 用来一键恢复出厂设置
        const next = incoming?.reset ? defaultConfig() : (incoming?.config ?? incoming);
        try {
          sourceConfig = await saveConfig(next);
        } catch (err) {
          // 磁盘不可写时不该让配置面板整个失灵：内存里先生效，同时如实说明没落盘。
          sourceConfig = normalizeConfig(next);
          sendJson(res, 200, {
            config: sourceConfig, catalog: sourceCatalog(),
            warning: `配置已在本次运行中生效，但写入 ${CONFIG_PATH} 失败（重启后会丢）：${String(err?.message || err)}`,
          });
          return;
        }
        sendJson(res, 200, { config: sourceConfig, catalog: sourceCatalog() });
        return;
      }

      // 第五步：深度验证。真开浏览器解码、真发并发请求，比检索贵得多，
      // 所以做成单独的接口，由前端在用户点开第五个 tab 时才调。
      if (pathname === '/api/verify' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req, 1024 * 256));
        const cands = Array.isArray(body?.candidates) ? body.candidates : [];
        if (cands.length === 0) { sendJson(res, 400, { error: '没有可验证的候选' }); return; }

        const vcfg = { ...sourceConfig.verify, ...(body.verify ?? {}) };
        if (!vcfg.enabled) { sendJson(res, 200, { skipped: true, reason: '深度验证已在配置中关闭' }); return; }

        const chrome = await findChrome();
        if (!chrome) {
          sendJson(res, 200, {
            skipped: true,
            reason: '本机找不到 Chromium，无法做播放嗅探。可用 CINEROUTE_CHROME 指定路径；'
              + '模拟下载不依赖浏览器，仍可单独使用。',
          });
          return;
        }

        // 白名单同样管住这里：不能让 /api/verify 变成任意地址的打开器
        const allowed = [];
        const rejected = [];
        for (const c of cands) {
          const v = isAllowedMediaUrl(c.url || '');
          if (v.ok) allowed.push(c); else rejected.push({ url: c.url, reason: v.reason });
        }
        if (allowed.length === 0) {
          sendJson(res, 403, { error: '候选地址全部不在白名单内', rejected });
          return;
        }

        const browser = await getBrowser();
        const baseUrl = `http://127.0.0.1:${port}`;
        const out = await verifyWithRounds(
          allowed,
          { topN: vcfg.topN, maxRounds: vcfg.maxRounds },
          {
            browser, baseUrl,
            threads: vcfg.threads,
            probeBytes: vcfg.probeBytes,
            concurrency: vcfg.concurrency,
          },
        );
        sendJson(res, 200, { ...out, rejected, config: vcfg });
        return;
      }

      if (pathname === '/api/search') {
        const q = (url.searchParams.get('q') || '').trim();
        if (!q) { sendJson(res, 400, { error: '缺少查询参数 q' }); return; }
        const result = await searchAll(q, {
          ...(offline ? offlineOpts : {}),
          config: sourceConfig,
        });
        sendJson(res, 200, result);
        return;
      }

      if (pathname === '/api/download' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req));
        if (!body?.url) { sendJson(res, 400, { error: '缺少 url' }); return; }
        // 下载同样走白名单：不能让接口变成任意 URL 抓取器。
        const verdict = isAllowedMediaUrl(body.url);
        if (!verdict.ok) { sendJson(res, 403, { error: `拒绝下载该地址：${verdict.reason}` }); return; }
        const job = downloads.enqueue({
          url: body.url,
          filename: body.filename || 'video.mp4',
          bytes: body.bytes ?? null,
          checksums: body.checksums ?? {},
        });
        sendJson(res, 202, job.toJSON());
        return;
      }

      if (pathname === '/api/downloads' && req.method === 'GET') {
        sendJson(res, 200, { jobs: downloads.list() });
        return;
      }

      const cancelMatch = pathname.match(/^\/api\/downloads\/([^/]+)\/cancel$/);
      if (cancelMatch && req.method === 'POST') {
        const ok = downloads.cancel(cancelMatch[1]);
        sendJson(res, ok ? 200 : 404, { ok });
        return;
      }

      if (pathname === '/api/events') {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        res.write(': connected\n\n');
        sseClients.add(res);
        // 心跳，防中间设备掐断空闲连接。
        const beat = setInterval(() => res.write(': ping\n\n'), 25000);
        req.on('close', () => { clearInterval(beat); sseClients.delete(res); });
        return;
      }

      if (pathname === '/media') {
        const target = url.searchParams.get('url');
        if (!target) { sendJson(res, 400, { error: '缺少 url' }); return; }
        await proxyMedia(req, res, target);
        return;
      }

      await serveStatic(res, pathname);
    } catch (err) {
      if (!res.headersSent) sendJson(res, 500, { error: String(err?.message || err) });
      else res.end();
    }
  });

  // 进程退出时把无头浏览器一起收掉，否则会留下孤儿进程和临时目录
  const shutdown = async () => {
    if (sharedBrowser) { try { await sharedBrowser.close(); } catch { /* 已经没了 */ } }
  };
  process.once('SIGINT', () => { shutdown().finally(() => process.exit(0)); });
  process.once('SIGTERM', () => { shutdown().finally(() => process.exit(0)); });
  server.on('close', shutdown);

  await new Promise((resolve) => server.listen(port, host, resolve));

  console.log(`\n🎬  CineRoute 影路 已启动`);
  console.log(`    http://localhost:${port}${host === '127.0.0.1' ? '  （仅本机可访问）' : ''}`);
  console.log(`    下载目录：${downloadDir}`);
  if (offline) console.log('    ⚠️  离线夹具模式：仅 Night of the Living Dead / Metropolis 有数据，媒体代理与下载不可用');
  console.log('');

  return server;
}
