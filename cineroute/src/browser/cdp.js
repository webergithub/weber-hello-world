/**
 * 极简 Chrome DevTools Protocol 客户端（零依赖）。
 *
 * 为什么不用 Playwright/Puppeteer：本项目承诺 clone 下来不 npm install 就能跑。
 * 而 Node 22 已经内置了 WebSocket 和 fetch，驱动 Chromium 需要的东西都齐了——
 * 启动进程、连 WS、发命令、收事件，加起来两百行。
 *
 * 只实现真正用得到的部分：开页面、导航、执行 JS、截图、拦截请求。
 * 不做 Playwright 那套自动等待与选择器引擎——需要等什么就在页面里自己等，
 * 反正 Runtime.evaluate 能跑任意 JS。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** 常见的 Chromium 位置。找不到就让调用方显式给路径。 */
const CANDIDATES = [
  process.env.CINEROUTE_CHROME,
  process.env.CHROME_PATH,
  '/opt/pw-browsers/chromium/chrome',
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

/** 找一个能用的 Chromium。找不到返回 null，由调用方决定怎么降级。 */
export async function findChrome() {
  for (const p of CANDIDATES) {
    if (!p) continue;
    try {
      await fs.access(p, (await import('node:fs')).constants.X_OK);
      return p;
    } catch { /* 试下一个 */ }
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 启动 Chromium 并连上 CDP。
 *
 * @param {{executablePath?: string, headless?: boolean, args?: string[],
 *          timeoutMs?: number, proxy?: string}} [opts]
 */
export async function launch(opts = {}) {
  const exe = opts.executablePath || await findChrome();
  if (!exe) throw new Error('找不到 Chromium，可用 CINEROUTE_CHROME 指定路径');

  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cineroute-chrome-'));
  const args = [
    // 端口给 0 让系统分配，真实端口写在 DevToolsActivePort 里
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    opts.headless === false ? null : '--headless=new',
    '--no-first-run', '--no-default-browser-check',
    // 容器里没有 sandbox 需要的用户命名空间；/dev/shm 也通常很小
    '--no-sandbox', '--disable-dev-shm-usage',
    '--disable-background-networking',
    '--disable-extensions',
    '--mute-audio',
    // 无头页面默认被当成后台标签页：setTimeout 会被压到每秒一次、
    // requestAnimationFrame 几乎停摆。播放嗅探全靠定时器和事件，
    // 不关掉这三个节流，seek 等待和帧采集会慢到超时。
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    // 没有真实音频设备时用假的，否则带音轨的视频可能起不来
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    // 别让 Chromium 自己去连各种 Google 服务，调研环境应当保持安静
    '--disable-sync', '--disable-component-update', '--metrics-recording-only',
    opts.proxy ? `--proxy-server=${opts.proxy}` : null,
    ...(opts.args ?? []),
  ].filter(Boolean);

  const proc = spawn(exe, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', (c) => { stderr += c.toString(); });

  // 等 DevToolsActivePort 出现——比解析 stderr 稳，格式也是官方约定的
  const portFile = path.join(userDataDir, 'DevToolsActivePort');
  const deadline = Date.now() + (opts.timeoutMs ?? 20000);
  let wsPath = null;
  let port = null;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(`Chromium 启动即退出（code ${proc.exitCode}）：${stderr.slice(-400)}`);
    }
    try {
      const [p, wp] = (await fs.readFile(portFile, 'utf8')).split('\n');
      if (p && wp) { port = Number(p); wsPath = wp.trim(); break; }
    } catch { /* 还没写出来 */ }
    await sleep(50);
  }
  if (!wsPath) {
    proc.kill('SIGKILL');
    throw new Error(`等待 Chromium 就绪超时：${stderr.slice(-400)}`);
  }

  const browser = new CdpConnection(`ws://127.0.0.1:${port}${wsPath}`, { proc, userDataDir });
  await browser.connect();
  return browser;
}

/** 一条 CDP 连接。命令走 id 配对，事件走监听器。 */
class CdpConnection {
  constructor(url, { proc, userDataDir }) {
    this.url = url;
    this.proc = proc;
    this.userDataDir = userDataDir;
    this.ws = null;
    this.nextId = 1;
    /** @type {Map<number, {resolve: Function, reject: Function}>} */
    this.pending = new Map();
    /** @type {Map<string, Set<Function>>} */
    this.listeners = new Map();
    this.closed = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.addEventListener('open', () => resolve(this));
      this.ws.addEventListener('error', (e) => reject(new Error(`CDP 连接失败：${e.message || e.type}`)));
      this.ws.addEventListener('close', () => {
        this.closed = true;
        // 连接断了，挂起的命令不会再有回应，全部拒掉，别让调用方永远等下去
        for (const { reject: rej } of this.pending.values()) rej(new Error('CDP 连接已关闭'));
        this.pending.clear();
      });
      this.ws.addEventListener('message', (ev) => this.#onMessage(String(ev.data)));
    });
  }

  #onMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.id != null) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${msg.error.message}${msg.error.data ? ` — ${msg.error.data}` : ''}`));
      else p.resolve(msg.result);
      return;
    }

    // 事件：按 method 分发；带 sessionId 的也一并传给监听器判断
    for (const fn of this.listeners.get(msg.method) ?? []) {
      try { fn(msg.params, msg.sessionId); } catch { /* 监听器自己的错不该影响连接 */ }
    }
  }

  /** 发一条命令。sessionId 为空表示发给浏览器本身而非某个页面。 */
  send(method, params = {}, sessionId = undefined, timeoutMs = 30000) {
    if (this.closed) return Promise.reject(new Error('CDP 连接已关闭'));
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 命令超时：${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.ws.send(payload);
    });
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(fn);
    return () => this.listeners.get(method)?.delete(fn);
  }

  /** 开一个新页面并附加上去，返回 Page。 */
  async newPage({ width = 1280, height = 720 } = {}) {
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank' });
    // flatten 让页面的消息复用同一条 WS，不用再开连接
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    const page = new Page(this, sessionId, targetId);
    await page.init({ width, height });
    return page;
  }

  async close() {
    try { await this.send('Browser.close', {}, undefined, 3000); } catch { /* 已经没了 */ }
    try { this.ws?.close(); } catch { /* 同上 */ }
    // Browser.close 之后进程通常会自己退出；给一点时间，然后强杀兜底
    const gone = await Promise.race([
      new Promise((r) => this.proc.once('exit', () => r(true))),
      sleep(3000).then(() => false),
    ]);
    if (!gone) this.proc.kill('SIGKILL');
    await fs.rm(this.userDataDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** 一个页面（CDP 里的 target/session）。 */
class Page {
  constructor(conn, sessionId, targetId) {
    this.conn = conn;
    this.sessionId = sessionId;
    this.targetId = targetId;
    this.consoleErrors = [];
  }

  send(method, params) { return this.conn.send(method, params, this.sessionId); }

  on(method, fn) {
    return this.conn.on(method, (params, sid) => {
      if (sid === this.sessionId) fn(params);
    });
  }

  async init({ width, height }) {
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    await this.send('Network.enable');
    await this.send('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: 1, mobile: false,
    });
    this.on('Runtime.exceptionThrown', (p) => {
      this.consoleErrors.push(p?.exceptionDetails?.exception?.description || p?.exceptionDetails?.text || '');
    });
  }

  /** 设置 UA。用真实 UA，默认那个 HeadlessChrome 会被很多站点直接挡掉。 */
  setUserAgent(ua, acceptLanguage) {
    return this.send('Network.setUserAgentOverride', { userAgent: ua, acceptLanguage });
  }

  setExtraHeaders(headers) {
    return this.send('Network.setExtraHTTPHeaders', { headers });
  }

  /**
   * 导航并等到 load 事件（或超时）。
   * 超时不抛错——很多页面会挂着长连接永远到不了 load，但内容早就渲染好了。
   */
  async goto(url, { timeoutMs = 30000, waitUntil = 'load' } = {}) {
    const started = Date.now();
    const done = new Promise((resolve) => {
      const off = this.on(waitUntil === 'domcontentloaded'
        ? 'Page.domContentEventFired' : 'Page.loadEventFired', () => { off(); resolve('event'); });
      setTimeout(() => { off(); resolve('timeout'); }, timeoutMs);
    });
    const nav = await this.send('Page.navigate', { url });
    if (nav.errorText) throw new Error(`导航失败：${nav.errorText}`);
    const how = await done;
    return { elapsedMs: Date.now() - started, settledBy: how, frameId: nav.frameId };
  }

  /**
   * 在页面里跑一段 JS，返回值必须能 JSON 序列化。
   * 传函数体字符串或表达式都行；await 用 awaitPromise。
   */
  async evaluate(expression, { awaitPromise = true, timeoutMs = 30000 } = {}) {
    const r = await this.conn.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise,
      userGesture: true,
    }, this.sessionId, timeoutMs);
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(`页面内异常：${d.exception?.description || d.text}`);
    }
    return r.result?.value;
  }

  /** 截图，返回 PNG 的 Buffer。 */
  async screenshot({ format = 'png', quality } = {}) {
    const r = await this.send('Page.captureScreenshot', {
      format, ...(quality != null ? { quality } : {}), captureBeyondViewport: false,
    });
    return Buffer.from(r.data, 'base64');
  }

  async close() {
    try { await this.conn.send('Target.closeTarget', { targetId: this.targetId }); } catch { /* 已经关了 */ }
  }
}
