/**
 * python 检索策略：把发请求交给 Python 脚本，解析留在 Node。
 *
 * 这一层要守的线跟别处不太一样，因为它跨了两个语言、跨了一次进程边界：
 *
 * 1. **契约**：stdin 收 JSON 作业、stdout 回 JSON 结果。脚本可以换，
 *    换了也得按这个形状说话。
 * 2. **分工不能乱**：Python 只回原始字节，解码和解析都在 Node。
 *    百度返 GBK 那条线必须还在——脚本要是先按 UTF-8 解一遍就全毁了，
 *    所以专门有一条用真 GBK 字节验这件事。
 * 3. **查询词不进命令行**。作业整个走 stdin。参数里带查询词迟早会有人
 *    拼进 shell，那就是命令注入。
 * 4. **坏掉的时候要说人话**：脚本崩了、吐的不是 JSON、超时——
 *    每种都得给出能看懂的一句话，而不是一个安静的空结果。
 *
 * 真跑 Python 的几条用例只依赖标准库，任何装了 python3 的机器都能跑；
 * 机器上没有 python3 就整体跳过——那不是失败，是这台机器走不了这条路。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  runPythonScript, parsePythonResult, pythonSearchPage, probePython, DEFAULT_SCRIPT,
} from '../src/adapters/serp/pythonSearch.js';
import { recipeFor } from '../src/adapters/serp/engines.js';
import { resetThrottle } from '../src/adapters/serp/httpSearch.js';

const HAS_PY = (() => {
  try { return spawnSync('python3', ['-V']).status === 0; } catch { return false; }
})();
const needPy = { skip: HAS_PY ? false : '本机没有 python3' };

/* ── 假脚本：不真起进程，只验 Node 这一侧 ──────────────────── */

/**
 * 造一个假的子进程。
 * `onJob` 拿到 Node 喂进去的作业，返回要写到 stdout 的字符串。
 */
function fakeSpawn(onJob, { exitCode = 0, stderr = '' } = {}) {
  const seen = [];
  const fn = () => {
    const p = new EventEmitter();
    p.stdout = new EventEmitter();
    p.stderr = new EventEmitter();
    p.kill = () => {};
    p.stdin = {
      on() {},
      end(data) {
        const job = JSON.parse(data);
        seen.push(job);
        // 下一个 tick 再吐，模拟真实的异步
        setImmediate(() => {
          const out = onJob(job);
          if (out) p.stdout.emit('data', out);
          if (stderr) p.stderr.emit('data', stderr);
          p.emit('close', exitCode);
        });
      },
    };
    return p;
  };
  fn.seen = seen;
  return fn;
}

const b64 = (s) => Buffer.from(s).toString('base64');

/** 够长的正文，否则会被拦截判定当成同意页。 */
const FILLER = '页面正文填充，让长度足够。'.repeat(60);

const GOOGLE_PAGE = `<!doctype html><html><head><title>notld - Google 搜索</title></head><body>
<div id="search">
  <div class="g"><a href="/url?q=https%3A%2F%2Farchive.org%2Fdetails%2Fnotld&amp;sa=U">Night of the Living Dead</a>
    <div>1968 年的公有领域影片。</div></div>
</div><p>${FILLER}</p></body></html>`;

/* ── 契约 ────────────────────────────────────────────────── */

test('作业走 stdin，查询词绝不进命令行', async () => {
  // 参数里带查询词迟早会有人拼进 shell 字符串。这条守的是那个。
  const evil = 'notld"; rm -rf / #';
  const spawnFn = fakeSpawn(() => JSON.stringify({
    ok: true, status: 200, content_type: 'text/html; charset=utf-8',
    body_b64: b64(GOOGLE_PAGE), via: 'urllib',
  }));

  await pythonSearchPage('google', evil, 1, { skipThrottle: true, spawnFn });

  assert.equal(spawnFn.seen.length, 1);
  assert.equal(spawnFn.seen[0].query, evil, '查询词应当原样出现在 stdin 的作业里');
});

test('Python 只回字节，解码与解析都在 Node —— GBK 页面不能被解坏', async () => {
  // 这是分工不能乱的核心用例。百度返 GBK 是常事；脚本要是自作主张
  // 先按 UTF-8 解一遍再回文本，标题就永远是乱码，而且**一个错都不报**。
  // 所以契约规定回 base64，解码在 Node（见 serp/charset.js）。
  const dec = new TextDecoder('gb18030');
  const map = new Map();
  const buf = new Uint8Array(2);
  for (let hi = 0x81; hi <= 0xFE; hi += 1) {
    for (let lo = 0x40; lo <= 0xFE; lo += 1) {
      if (lo === 0x7F) continue;
      buf[0] = hi; buf[1] = lo;
      const ch = dec.decode(buf);
      if (ch.length === 1 && ch !== '�' && !map.has(ch)) map.set(ch, [hi, lo]);
    }
  }
  const toGbk = (text) => {
    const out = [];
    for (const ch of text) {
      const code = ch.codePointAt(0);
      if (code < 0x80) { out.push(code); continue; }
      out.push(...map.get(ch));
    }
    return Buffer.from(out);
  };

  const title = '活死人之夜 1968 完整版';
  const page = `<html><head><meta charset="gbk"><title>${title}_百度搜索</title></head><body>
    <div id="content_left"><a href="https://archive.org/details/notld">${title}</a>
    <div class="c-abstract">公有领域影片。</div></div>
    <p>${FILLER}</p></body></html>`;
  const bytes = toGbk(page);

  // 先确认夹具是真 GBK
  assert.ok(!new TextDecoder('utf-8').decode(bytes).includes('活死人'), '夹具不是真的 GBK');

  const spawnFn = fakeSpawn(() => JSON.stringify({
    ok: true, status: 200, content_type: 'text/html; charset=gbk',
    body_b64: bytes.toString('base64'), via: 'curl_cffi/chrome',
  }));

  const r = await pythonSearchPage('baidu', '活死人之夜', 1, { skipThrottle: true, spawnFn });
  assert.equal(r.charset, 'gb18030', '应当按 GBK 解');
  assert.equal(r.results.length, 1);
  assert.equal(r.results[0].title, title, `标题乱码了：${r.results[0].title}`);
  assert.equal(r.via, 'python/curl_cffi/chrome', '用了哪个传输要如实带出来');
});

test('自解析模式：脚本自己出结果就原样收下', () => {
  // 想接 ddgs 或自己写的爬虫走这条。Node 不再解析，只做形状归一。
  const out = parsePythonResult({
    ok: true,
    via: 'ddgs',
    results: [
      { url: 'https://archive.org/details/a', title: 'A', snippet: '甲' },
      { link: 'https://archive.org/details/b', title: 'B', content: '乙' },   // 别名字段也认
      { title: '没有 url 的条目' },
    ],
    related: ['相关词'],
  }, { engine: 'google', recipe: recipeFor('google'), url: 'https://x' });

  assert.equal(out.results.length, 2, '没有 url 的条目该被丢掉');
  assert.equal(out.results[1].url, 'https://archive.org/details/b');
  assert.equal(out.results[1].snippet, '乙');
  assert.deepEqual(out.related, ['相关词']);
  assert.equal(out.via, 'python/ddgs');
});

test('拦截页要判成被挡，且不解析出噪音', async () => {
  const captcha = '<html><head><title>Sorry...</title></head><body>'
    + '<p>Our systems have detected unusual traffic.</p></body></html>';
  const spawnFn = fakeSpawn(() => JSON.stringify({
    ok: true, status: 200, content_type: 'text/html', body_b64: b64(captcha), via: 'urllib',
  }));
  const r = await pythonSearchPage('google', 'x', 1, { skipThrottle: true, spawnFn });
  assert.match(r.blocked, /unusual traffic/i);
  assert.equal(r.results.length, 0, '被挡的页面上抠出来的全是噪音');
});

/* ── 坏掉的时候 ──────────────────────────────────────────── */

test('脚本崩了要说人话，不能安静地给个空结果', async () => {
  const spawnFn = fakeSpawn(() => '', { exitCode: 1, stderr: 'Traceback: ModuleNotFoundError: no such thing' });
  await assert.rejects(
    () => pythonSearchPage('google', 'x', 1, { skipThrottle: true, spawnFn }),
    (e) => /没有输出/.test(e.message) && /ModuleNotFoundError/.test(e.message),
  );
});

test('输出不是 JSON 时把原文带出来，方便排查', async () => {
  const spawnFn = fakeSpawn(() => 'oops this is not json');
  await assert.rejects(
    () => pythonSearchPage('google', 'x', 1, { skipThrottle: true, spawnFn }),
    /不是 JSON.*oops/s,
  );
});

test('脚本自报失败时，把它给的原因原样传上去', () => {
  assert.throws(
    () => parsePythonResult({ ok: false, via: 'curl_cffi', error: 'ConnectionError: 连不上' },
      { engine: 'google', recipe: recipeFor('google'), url: 'https://x' }),
    /python\/curl_cffi.*连不上/s,
  );
});

test('既没给 results 也没给 body_b64 —— 契约没遵守，要点出来', () => {
  assert.throws(
    () => parsePythonResult({ ok: true, via: 'urllib', status: 200 },
      { engine: 'google', recipe: recipeFor('google'), url: 'https://x' }),
    /既没给 results 也没给 body_b64/,
  );
});

/* ── 真跑 Python ─────────────────────────────────────────── */

test('自检：报告这台机器上会用哪个传输', needPy, async () => {
  const r = await probePython({ script: DEFAULT_SCRIPT });
  assert.equal(r.ok, true, `自检没过：${r.error}`);
  assert.ok(r.available.includes('urllib'), 'urllib 永远该在——它是标准库');
  assert.ok(r.python, '要报出 Python 版本');
  // via 必须是 available 里的一个，不能凭空说自己用了个没装的库
  assert.ok(r.available.includes(r.via), `报了个没装的传输：${r.via}`);
});

test('真跑一遍：Python 取字节，Node 解析出结果', needPy, async () => {
  resetThrottle();
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(GOOGLE_PAGE);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;

  // 把作业里的地址换到本地假引擎上——不去打真的 Google：
  // 测试不该依赖外网，也不该在跑测试时去打人家的服务器。
  const spawnFn = (cmd, args, o) => {
    const p = spawn(cmd, args, o);
    const end = p.stdin.end.bind(p.stdin);
    p.stdin.end = (data) => {
      const job = JSON.parse(data);
      const u = new URL(job.url);
      job.url = `http://127.0.0.1:${port}${u.pathname}${u.search}`;
      return end(JSON.stringify(job));
    };
    return p;
  };

  try {
    const r = await pythonSearchPage('google', 'Night of the Living Dead', 1, {
      script: DEFAULT_SCRIPT, skipThrottle: true, spawnFn,
    });
    assert.equal(r.blocked, null, `不该被判成拦截：${r.blocked}`);
    assert.equal(r.status, 200);
    assert.match(r.via, /^python\//, '要说明用了哪个传输');
    assert.equal(r.results.length, 1);
    // 跳转包装还原是 Node 那边做的——证明分工确实是"Python 只管取"
    assert.equal(r.results[0].url, 'https://archive.org/details/notld',
      `跳转包装没还原：${r.results[0].url}`);
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

test('4xx 的响应体也要拿回来 —— 拦截判定靠它', needPy, async () => {
  resetThrottle();
  const srv = http.createServer((req, res) => {
    res.writeHead(429, { 'content-type': 'text/html' });
    res.end('<html><body>slow down</body></html>');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;

  const spawnFn = (cmd, args, o) => {
    const p = spawn(cmd, args, o);
    const end = p.stdin.end.bind(p.stdin);
    p.stdin.end = (d) => {
      const job = JSON.parse(d);
      job.url = `http://127.0.0.1:${port}/`;
      return end(JSON.stringify(job));
    };
    return p;
  };

  try {
    const r = await pythonSearchPage('bing', 'x', 1, {
      script: DEFAULT_SCRIPT, skipThrottle: true, spawnFn,
    });
    assert.equal(r.status, 429, '状态码要如实带回来，不能被异常吞掉');
    assert.match(r.blocked, /429/);
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

test('解释器不存在时报错要说清楚是哪一步没成', async () => {
  await assert.rejects(
    () => runPythonScript({ python: '/nonexistent/python-does-not-exist', script: DEFAULT_SCRIPT, job: {} }),
    /无法执行|无法启动/,
  );
});
