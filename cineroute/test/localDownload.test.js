/**
 * 离线下载存到本机。
 *
 * 以前点「离线下载」是让**服务端**把文件下到它自己的 downloads/ 目录。
 * 服务跑在本机时还说得过去；按 deploy/ 那套部署到远程机器之后，
 * 那个目录对用户毫无用处——文件下到了别人的机器上。
 *
 * 现在默认存到用户自己的机器。这里验三件事：
 *   1) 配置项本身（默认值、非法值挡掉）；
 *   2) `/media?download=1` 这条退化路径的响应头对不对（中文片名不能乱码）；
 *   3) 分块并发写入的逻辑——用一个内存里的假文件句柄跑，
 *      不依赖浏览器，但跑的是 localSave.js 里真正的那段代码。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { normalizeConfig, defaultConfig, DEFAULT_DOWNLOAD_TARGET } from '../src/core/sourceConfig.js';
import { startServer } from '../src/server/server.js';

/* ── 配置 ─────────────────────────────────────────────────── */

test('下载去向：默认存到本机', () => {
  assert.equal(DEFAULT_DOWNLOAD_TARGET, 'local');
  assert.equal(defaultConfig().downloadTarget, 'local');
});

test('下载去向：只认 local / server，别的值退回默认', () => {
  assert.equal(normalizeConfig({ downloadTarget: 'server' }).downloadTarget, 'server');
  assert.equal(normalizeConfig({ downloadTarget: 'local' }).downloadTarget, 'local');
  for (const bad of ['云端', '../etc', '', null, 42, {}]) {
    assert.equal(
      normalizeConfig({ downloadTarget: bad }).downloadTarget, 'local',
      `非法值 ${JSON.stringify(bad)} 应退回 local`,
    );
  }
});

/* ── /media?download=1 ────────────────────────────────────── */

const PAYLOAD = Buffer.from('FAKE-VIDEO-BYTES-'.repeat(64));

/** 起一个假上游，并把它通过 JELLYFIN_URL 纳入白名单。 */
async function withServer(fn) {
  const prevJellyfin = process.env.JELLYFIN_URL;

  const upstream = await new Promise((ok) => {
    const s = http.createServer((req, res) => {
      const range = req.headers.range;
      if (range) {
        const m = range.match(/bytes=(\d+)-(\d*)/);
        const start = Number(m[1]);
        const end = m[2] ? Number(m[2]) : PAYLOAD.length - 1;
        const slice = PAYLOAD.subarray(start, end + 1);
        res.writeHead(206, {
          'content-type': 'video/mp4',
          'content-range': `bytes ${start}-${end}/${PAYLOAD.length}`,
          'accept-ranges': 'bytes',
          'content-length': String(slice.length),
        });
        res.end(slice);
        return;
      }
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(PAYLOAD.length) });
      res.end(PAYLOAD);
    });
    s.listen(0, '127.0.0.1', () => ok(s));
  });
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}/movie.mp4`;
  process.env.JELLYFIN_URL = `http://127.0.0.1:${upstream.address().port}`;

  const app = await startServer({
    config: defaultConfig(), port: 0, host: '127.0.0.1', quiet: true,
  });
  const base = `http://127.0.0.1:${app.address().port}`;

  try {
    return await fn({ base, upstreamUrl });
  } finally {
    await new Promise((r) => app.close(r));
    await new Promise((r) => upstream.close(r));
    if (prevJellyfin === undefined) delete process.env.JELLYFIN_URL;
    else process.env.JELLYFIN_URL = prevJellyfin;
  }
}

test('/media?download=1 让浏览器存成文件，而不是在标签页里播', async () => {
  await withServer(async ({ base, upstreamUrl }) => {
    const plain = await fetch(`${base}/media?url=${encodeURIComponent(upstreamUrl)}`);
    assert.equal(plain.headers.get('content-disposition'), null, '不加 download 时不该有附件头');
    await plain.arrayBuffer();

    const dl = await fetch(
      `${base}/media?url=${encodeURIComponent(upstreamUrl)}&download=1&filename=${encodeURIComponent('哪吒之魔童闹海.mp4')}`,
    );
    const cd = dl.headers.get('content-disposition');
    assert.ok(cd, '加了 download=1 就该有 content-disposition');
    assert.match(cd, /^attachment;/, '必须是 attachment，否则浏览器会内联播放');
    // 中文片名要走 RFC 5987 编码，否则到浏览器那儿是乱码或被截断
    assert.match(cd, /filename\*=UTF-8''/, '缺少 filename* 编码');
    assert.ok(
      cd.includes(encodeURIComponent('哪吒之魔童闹海.mp4')),
      `中文片名没编进去：${cd}`,
    );
    assert.equal(Buffer.from(await dl.arrayBuffer()).equals(PAYLOAD), true, '内容要原样透传');
  });
});

test('/media?download=1 的文件名同样要过清洗，不能被用来穿越目录', async () => {
  await withServer(async ({ base, upstreamUrl }) => {
    const res = await fetch(
      `${base}/media?url=${encodeURIComponent(upstreamUrl)}&download=1`
      + `&filename=${encodeURIComponent('../../../etc/passwd')}`,
    );
    const cd = res.headers.get('content-disposition');
    await res.arrayBuffer();
    assert.ok(!cd.includes('../'), `文件名里还带着路径穿越：${cd}`);
    assert.ok(cd.includes('passwd'), '清洗之后应当只剩最后一段');
  });
});

test('download=1 仍然守着白名单，不是绕过闸门的后门', async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(
      `${base}/media?url=${encodeURIComponent('http://169.254.169.254/latest/meta-data/')}&download=1`,
    );
    assert.equal(res.status, 403, `内网地址应当被拒，实际 HTTP ${res.status}`);
  });
});

/* ── 分块并发写入 ─────────────────────────────────────────── */

/**
 * 内存里的假文件句柄，接口形状与 FileSystemFileHandle 一致。
 *
 * 这样就能在 Node 里跑 localSave.js 里那段真正的下载逻辑——
 * 并发分块、按偏移写、写完读回来算校验和，全都是线上会跑的代码。
 */
function fakeFileHandle(name = 'movie.mp4') {
  let data = Buffer.alloc(0);
  const writes = [];

  return {
    name,
    _writes: writes,
    get bytes() { return data; },
    async createWritable() {
      return {
        async write(cmd) {
          const buf = Buffer.from(cmd.data);
          const end = cmd.position + buf.length;
          if (end > data.length) {
            const grown = Buffer.alloc(end);
            data.copy(grown);
            data = grown;
          }
          buf.copy(data, cmd.position);
          writes.push({ position: cmd.position, length: buf.length });
        },
        async close() {},
        async abort() {},
      };
    },
    async getFile() {
      return {
        size: data.length,
        slice(start, end) {
          const part = data.subarray(start, end);
          return { size: part.length, async arrayBuffer() { return part; } };
        },
      };
    },
  };
}

/** localSave.js 依赖 fetch 和一个 `/media` 前缀的同源地址，在 Node 里补上。 */
async function withGlobals(base, fn) {
  const prevFetch = globalThis.fetch;
  const prevDoc = globalThis.document;
  globalThis.fetch = (input, init) => prevFetch(
    typeof input === 'string' && input.startsWith('/') ? `${base}${input}` : input,
    init,
  );
  try {
    return await fn();
  } finally {
    globalThis.fetch = prevFetch;
    if (prevDoc === undefined) delete globalThis.document;
  }
}

test('分块并发下载：写到正确的偏移，内容完整，校验和对得上', async () => {
  const { saveToDisk } = await import('../src/web/localSave.js');

  await withServer(async ({ base, upstreamUrl }) => {
    await withGlobals(base, async () => {
      const handle = fakeFileHandle('哪吒之魔童闹海.mp4');
      const md5 = createHash('md5').update(PAYLOAD).digest('hex');

      const updates = [];
      const out = await saveToDisk(
        { url: upstreamUrl, filename: '哪吒之魔童闹海.mp4', bytes: PAYLOAD.length, checksums: { md5 } },
        handle,
        { threads: 3, onUpdate: (u) => updates.push(u) },
      );

      assert.equal(out.status, 'done', `应当成功，实际 ${out.status}：${out.error}`);
      assert.equal(handle.bytes.equals(PAYLOAD), true, '写进去的内容与上游不一致');
      assert.equal(out.verify.checked, true, '有校验和就该校验');
      assert.equal(out.verify.ok, true, `校验应当通过：${JSON.stringify(out.verify)}`);
      assert.equal(out.verify.algo, 'md5');

      // 进度要一路往上报，且最后到 100%
      assert.ok(updates.length >= 2, '应当有多次进度回报');
      assert.equal(updates.at(-1).percent, 100);
      assert.ok(updates.some((u) => u.status === 'verifying'), '校验阶段也要报给界面');
    });
  });
});

test('校验和对不上时判失败，不把损坏文件当成品交付', async () => {
  const { saveToDisk } = await import('../src/web/localSave.js');

  await withServer(async ({ base, upstreamUrl }) => {
    await withGlobals(base, async () => {
      const handle = fakeFileHandle();
      const out = await saveToDisk(
        { url: upstreamUrl, filename: 'movie.mp4', bytes: PAYLOAD.length, checksums: { md5: 'f'.repeat(32) } },
        handle,
        { threads: 2 },
      );
      assert.equal(out.status, 'failed', '校验不过就该判失败');
      assert.equal(out.verify.ok, false);
      assert.equal(out.verify.actual, createHash('md5').update(PAYLOAD).digest('hex'));
    });
  });
});

test('上游没给校验和时如实标注"未校验"，而不是假装校验通过', async () => {
  const { saveToDisk } = await import('../src/web/localSave.js');

  await withServer(async ({ base, upstreamUrl }) => {
    await withGlobals(base, async () => {
      const handle = fakeFileHandle();
      const out = await saveToDisk(
        { url: upstreamUrl, filename: 'movie.mp4', bytes: PAYLOAD.length, checksums: {} },
        handle,
        { threads: 2 },
      );
      assert.equal(out.status, 'done');
      assert.equal(out.verify.checked, false);
      assert.match(out.verify.reason, /未提供/);
      assert.equal(handle.bytes.equals(PAYLOAD), true, '没校验和不影响内容正确');
    });
  });
});

test('上游不支持 Range 时退化为单流顺序写，结果依然正确', async () => {
  const { saveToDisk } = await import('../src/web/localSave.js');
  const prevJellyfin = process.env.JELLYFIN_URL;

  // 这个上游对 Range 视而不见，永远返回 200 全量
  const upstream = await new Promise((ok) => {
    const s = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(PAYLOAD.length) });
      res.end(PAYLOAD);
    });
    s.listen(0, '127.0.0.1', () => ok(s));
  });
  const port = upstream.address().port;
  process.env.JELLYFIN_URL = `http://127.0.0.1:${port}`;
  const app = await startServer({ config: defaultConfig(), port: 0, host: '127.0.0.1', quiet: true });
  const base = `http://127.0.0.1:${app.address().port}`;

  try {
    await withGlobals(base, async () => {
      const handle = fakeFileHandle();
      const md5 = createHash('md5').update(PAYLOAD).digest('hex');
      const out = await saveToDisk(
        { url: `http://127.0.0.1:${port}/m.mp4`, filename: 'm.mp4', bytes: null, checksums: { md5 } },
        handle,
        { threads: 4 },
      );
      assert.equal(out.status, 'done', `应当成功：${out.error}`);
      assert.equal(handle.bytes.equals(PAYLOAD), true);
      assert.equal(out.verify.ok, true);
    });
  } finally {
    await new Promise((r) => app.close(r));
    await new Promise((r) => upstream.close(r));
    if (prevJellyfin === undefined) delete process.env.JELLYFIN_URL;
    else process.env.JELLYFIN_URL = prevJellyfin;
  }
});
