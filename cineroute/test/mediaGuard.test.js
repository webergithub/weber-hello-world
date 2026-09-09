/**
 * 媒体地址白名单 —— 这是整个产品唯一的安全边界。
 *
 * `/media`、`/api/download`、`/api/verify` 三个接口都会拿着用户给的地址
 * 去服务端发请求。没有这道闸，它们就是一个开放代理：内网探测、云元数据
 * （169.254.169.254）、本机端口扫描全都成立。
 *
 * 所以这里按敌意输入来打：URL 解析的各种花招 + **跳转**。
 * 跳转尤其重要，因为白名单只看得到第一跳。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isAllowedMediaUrl } from '../src/adapters/registry.js';
import { startServer } from '../src/server/server.js';
import { defaultConfig } from '../src/core/sourceConfig.js';
import { DownloadManager } from '../src/server/downloader.js';
import { simulateDownload } from '../src/verify/simDownload.js';

/* ── URL 解析花招 ─────────────────────────────────────────── */

const SHOULD_PASS = [
  'https://archive.org/download/x/y.mp4',
  'https://ia801604.us.archive.org/12/items/x/y.mp4',
  'https://upload.wikimedia.org/wikipedia/commons/a/b/c.ogv',
  'https://commons.wikimedia.org/wiki/File:X.ogv',
  'http://archive.org/download/x/y.mp4',          // 上游确实有明文 HTTP
  'https://ARCHIVE.ORG/download/x/y.mp4',         // 大小写
];

const SHOULD_FAIL = [
  // 后缀伪装：这几个是最容易写漏的
  'https://evil-archive.org/x.mp4',
  'https://notarchive.org/x.mp4',
  'https://archive.org.evil.com/x.mp4',
  'https://archive.orgevil.com/x.mp4',
  'https://fakewikimedia.org/x.mp4',
  // userinfo 冒充主机
  'https://archive.org@evil.com/x.mp4',
  'https://archive.org:pass@evil.com/x.mp4',
  // 同形字（西里尔 а），URL 会转成 punycode
  'https://аrchive.org/x.mp4',
  // 内网与元数据服务
  'http://127.0.0.1:8787/x.mp4',
  'http://localhost/x.mp4',
  'http://169.254.169.254/latest/meta-data/',
  'http://[::1]/x.mp4',
  'http://10.0.0.1/x.mp4',
  'http://192.168.1.1/x.mp4',
  // 非 HTTP 协议
  'file:///etc/passwd',
  'ftp://archive.org/x.mp4',
  'gopher://archive.org/x',
  'data:video/mp4;base64,AAAA',
  'javascript:alert(1)',
  // 根本不是 URL
  '',
  'archive.org/x.mp4',
  '//archive.org/x.mp4',
];

test('白名单：该放的放行', () => {
  const bad = SHOULD_PASS.filter((u) => !isAllowedMediaUrl(u).ok)
    .map((u) => `  · ${u} —— ${isAllowedMediaUrl(u).reason}`);
  assert.equal(bad.length, 0, `${bad.length} 个合法地址被误拒：\n${bad.join('\n')}`);
});

test('白名单：该拦的拦住（后缀伪装 / userinfo / 内网 / 非 HTTP）', () => {
  const bad = SHOULD_FAIL.filter((u) => isAllowedMediaUrl(u).ok).map((u) => `  · ${u}`);
  assert.equal(bad.length, 0, `${bad.length} 个危险地址被放行：\n${bad.join('\n')}`);
});

/* ── 跳转 ─────────────────────────────────────────────────── */

/** 起一个会按路径决定行为的小服务。 */
function serve(handler) {
  return new Promise((ok) => {
    const s = http.createServer(handler);
    s.listen(0, '127.0.0.1', () => ok(s));
  });
}
const close = (s) => new Promise((r) => s.close(r));

/**
 * 用 JELLYFIN_URL 把一个本地地址临时纳入白名单。
 *
 * 这不是取巧：自建媒体库本来就是这么授权的，正好给了一个
 * "白名单内的主机"来验跳转行为，不必去动 ALLOWED_MEDIA_HOSTS 本身。
 */
async function withProxy(fn) {
  const prevJellyfin = process.env.JELLYFIN_URL;

  // 外部主机：不在白名单里，代表"跳转后到达的地方"
  const SECRET = 'INTERNAL-ONLY-SHOULD-NEVER-REACH-CLIENT';
  const outside = await serve((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(SECRET);
  });
  const outsideUrl = `http://127.0.0.1:${outside.address().port}/secret`;

  // 白名单内的主机：按路径给不同的跳转
  const inside = await serve((req, res) => {
    if (req.url.startsWith('/redirect-out')) {
      res.writeHead(302, { location: outsideUrl });
      res.end();
      return;
    }
    if (req.url.startsWith('/redirect-in')) {
      res.writeHead(302, { location: '/ok' });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'video/mp4' });
    res.end('OK-INSIDE');
  });
  const insidePort = inside.address().port;
  process.env.JELLYFIN_URL = `http://127.0.0.1:${insidePort}`;

  const app = await startServer({
    config: defaultConfig(), port: 0, host: '127.0.0.1', quiet: true,
  });
  const appPort = app.address().port;
  const media = (target) => `http://127.0.0.1:${appPort}/media?url=${encodeURIComponent(target)}`;

  try {
    return await fn({ media, insidePort, outsideUrl, SECRET });
  } finally {
    await new Promise((r) => app.close(r));
    await close(inside);
    await close(outside);
    if (prevJellyfin === undefined) delete process.env.JELLYFIN_URL;
    else process.env.JELLYFIN_URL = prevJellyfin;
  }
}

test('跳转不能绕过白名单：白名单内的主机把请求 302 到外部时必须停下', async () => {
  await withProxy(async ({ media, insidePort, SECRET }) => {
    const res = await fetch(media(`http://127.0.0.1:${insidePort}/redirect-out`));
    const body = await res.text();
    assert.ok(
      !body.includes(SECRET),
      '跳转出白名单之后的内容被原样转回了客户端 —— 这条路等于开放代理',
    );
    assert.ok(res.status >= 400, `应当拒绝，实际 HTTP ${res.status}`);
  });
});

test('白名单内部的跳转要照常跟随（archive.org 正常就会 302 到 iaNNNN 节点）', async () => {
  await withProxy(async ({ media, insidePort }) => {
    const res = await fetch(media(`http://127.0.0.1:${insidePort}/redirect-in`));
    assert.equal(res.status, 200, '同源跳转被误伤了');
    assert.equal(await res.text(), 'OK-INSIDE');
  });
});

test('下载同样逐跳校验：上游 302 到白名单外时不能把内容拉到磁盘上', async () => {
  // 代理是把内容直接转给客户端，下载是落到磁盘——同一个洞，两条出口。
  // 这条单独验，因为下载器的注入是另一处接线，改坏了代理那条测不出来。
  const SECRET = 'INTERNAL-ONLY';
  const outside = await serve((req, res) => { res.writeHead(200).end(SECRET); });
  const outsideUrl = `http://127.0.0.1:${outside.address().port}/secret`;
  const inside = await serve((req, res) => {
    res.writeHead(302, { location: outsideUrl });
    res.end();
  });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cineroute-guard-'));

  try {
    const allowed = `http://127.0.0.1:${inside.address().port}`;
    const mgr = new DownloadManager({
      dir,
      concurrency: 1,
      // 只认这一个来源，跳出去就该被拦下
      checkRedirect: (u) => (u.startsWith(allowed)
        ? { ok: true }
        : { ok: false, reason: '不在白名单内' }),
    });
    const job = mgr.enqueue({ url: `${allowed}/movie.mp4`, filename: 'movie.mp4' });
    const final = await new Promise((ok) => {
      const done = () => {
        if (['done', 'failed', 'canceled'].includes(job.status)) ok(job.toJSON());
      };
      job.on('update', done);
      done();
    });

    assert.equal(final.status, 'failed', `应当失败，实际 ${final.status}`);
    const written = await fs.readdir(dir);
    for (const f of written) {
      const body = await fs.readFile(path.join(dir, f), 'utf8').catch(() => '');
      assert.ok(!body.includes(SECRET), `跳转后的内容被写进了 ${f}`);
    }
  } finally {
    await close(inside);
    await close(outside);
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('第五步的模拟下载也逐跳校验：它是直连上游的，/media 那道闸管不到', async () => {
  // 模拟下载不走本机代理，自己拿着片源地址发 Range 请求。
  // 不校验的话，返回的状态码和响应头就是一个"某端口开着没有"的探针。
  const SECRET = 'INTERNAL-ONLY';
  const outside = await serve((req, res) => {
    res.writeHead(206, { 'content-range': 'bytes 0-1/999999', 'content-type': 'video/mp4' });
    res.end(SECRET);
  });
  const outsideUrl = `http://127.0.0.1:${outside.address().port}/secret`;
  const inside = await serve((req, res) => {
    res.writeHead(302, { location: outsideUrl });
    res.end();
  });

  try {
    const allowed = `http://127.0.0.1:${inside.address().port}`;
    const out = await simulateDownload(`${allowed}/movie.mp4`, {
      threads: 2,
      probeBytes: 1024,
      checkRedirect: (u) => (u.startsWith(allowed)
        ? { ok: true }
        : { ok: false, reason: '不在白名单内' }),
    });
    assert.equal(out.ok, false, '跳出白名单之后不该报成功');
    assert.ok(
      !JSON.stringify(out).includes(SECRET),
      '跳转后的内容出现在了结果里',
    );
  } finally {
    await close(inside);
    await close(outside);
  }
});

test('自建媒体库的授权是按来源（协议+主机+端口），不是只看主机名', async () => {
  // JELLYFIN_URL 指到某台机器的 8096 端口，不等于授权了那台机器的所有端口。
  // 只比 hostname 的话，同一台机器上的 22、6379、内部管理口全被顺带放行。
  const prev = process.env.JELLYFIN_URL;
  process.env.JELLYFIN_URL = 'http://192.168.1.50:8096';
  try {
    assert.equal(isAllowedMediaUrl('http://192.168.1.50:8096/Videos/1/stream').ok, true, '配置的那个端口应放行');
    assert.equal(isAllowedMediaUrl('http://192.168.1.50:22/').ok, false, '同一台机器的其他端口不该被顺带放行');
    assert.equal(isAllowedMediaUrl('http://192.168.1.50:6379/').ok, false, '同上');
  } finally {
    if (prev === undefined) delete process.env.JELLYFIN_URL;
    else process.env.JELLYFIN_URL = prev;
  }
});
