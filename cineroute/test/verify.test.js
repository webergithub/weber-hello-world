/**
 * 第五步「模拟打开验证」的测试。
 *
 * 这一步真跑起来要开浏览器、真解码，慢且依赖环境。所以这里只测**纯逻辑**：
 * 取样点换算、清晰度评级、分块切分、轮次推进。真正的端到端（开浏览器截图）
 * 靠人工跑 --serve 验证，不进自动化用例——把浏览器塞进 CI 会让测试又慢又飘。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveMarks, summarizeQuality, gradeBatch, DEFAULT_MARKS } from '../src/verify/playback.js';
import { simulateDownload } from '../src/verify/simDownload.js';
import { verifyWithRounds } from '../src/verify/deepVerify.js';
import { buildArgv, parseCliOutput, engineSearchUrl, checkBackend } from '../src/adapters/serp.js';

/* ── 取样点 ─────────────────────────────────────────────── */

test('八个取样点：负数表示从片尾往前数', () => {
  const marks = resolveMarks(6000);   // 100 分钟
  assert.equal(marks.length, 8);
  assert.equal(marks[0].at, 0);
  assert.equal(marks[6].at, 5400);
  assert.equal(marks[7].at, 5700, '片尾前 5 分钟 = 6000-300');
  for (const m of marks) assert.equal(m.inRange, true, `${m.label} 应在范围内`);
});

test('片子短于取样点时如实标为超出片长，不静默丢弃也不夹到边界', () => {
  const marks = resolveMarks(600);    // 只有 10 分钟
  const inRange = marks.filter((m) => m.inRange);
  const out = marks.filter((m) => !m.inRange);
  assert.ok(inRange.length > 0);
  assert.ok(out.length > 0, '30/60/90 分钟这几个点应超出片长');
  for (const m of out) assert.equal(m.skipReason, '超出片长');
  // 越界的点不该被改成边界值——那样截出来的图会被误当成那个时间点的画面
  assert.ok(marks.find((m) => m.label === '90 分钟').at === 5400);
});

test('片长未知时全部标为片长未知，而不是假装能取', () => {
  const marks = resolveMarks(0);
  assert.ok(marks.every((m) => !m.inRange));
  assert.ok(marks.every((m) => m.skipReason === '片长未知'));
});

test('默认取样点覆盖片头片中片尾', () => {
  assert.equal(DEFAULT_MARKS.length, 8);
  assert.equal(DEFAULT_MARKS[0].at, 0);
  assert.ok(DEFAULT_MARKS.some((m) => m.at < 0), '应有一个从片尾倒数的点');
});

/* ── 清晰度 ─────────────────────────────────────────────── */

const frame = (sharpness, contrast = 50, blank = false) => ({
  captured: true, blank, sharpness, contrast,
});

test('清晰度取中位数，不被个别异常帧带偏', () => {
  const q = summarizeQuality(
    [frame(100), frame(110), frame(105), frame(99999)],   // 最后一帧异常高
    { videoWidth: 1920, videoHeight: 1080 },
  );
  assert.ok(q.sharpnessMedian < 200, '中位数不该被那一帧拉爆');
  assert.equal(q.decodedResolution, '1920×1080');
  assert.equal(q.sampledFrames, 4);
});

test('空白帧（黑场/白场）不参与清晰度计算，但要计数', () => {
  const q = summarizeQuality(
    [frame(100), frame(0, 1, true), frame(120)],
    { videoWidth: 640, videoHeight: 360 },
  );
  assert.equal(q.sampledFrames, 2, '空白帧应被排除');
  assert.equal(q.blankFrames, 1, '但要如实报出来');
  assert.equal(q.sharpnessMedian, 110);
});

test('一张有效帧都没有时返回 null，而不是编一个分数', () => {
  assert.equal(summarizeQuality([]), null);
  assert.equal(summarizeQuality([frame(0, 1, true)]), null);
});

/* ── 批内相对评级 ───────────────────────────────────────── */

const probe = (h, density, ok = true) => ({
  ok, url: `u${h}`, quality: ok ? { decodedHeight: h, detailDensity: density, decodedResolution: `${h * 16 / 9}×${h}` } : null,
});

test('评级按批内相对比较，分辨率最高的拿 A', () => {
  const graded = gradeBatch([probe(1080, 10), probe(720, 10), probe(360, 10)]);
  assert.equal(graded[0].grade, 'A');
  assert.equal(graded[1].grade, 'B');
  assert.equal(graded[2].grade, 'C');
});

test('分辨率最高但细节密度明显偏低 → 判为放大后重编码', () => {
  // 三条都是 1080p，但第一条细节密度只有别人的 1/10
  const graded = gradeBatch([probe(1080, 1), probe(1080, 10), probe(1080, 12)]);
  assert.equal(graded[0].grade, 'B');
  assert.match(graded[0].gradeNote, /放大/);
  assert.equal(graded[1].grade, 'A');
});

test('放不出来的条目不给等级，并说明原因', () => {
  const graded = gradeBatch([
    probe(1080, 10),
    { ok: false, url: 'bad', reason: '没有视频轨', quality: null },
  ]);
  assert.equal(graded[1].grade, null);
  assert.match(graded[1].gradeNote, /没有视频轨/);
});

test('一条都播不了时不崩，全部返回无等级', () => {
  const graded = gradeBatch([{ ok: false, url: 'a', quality: null }]);
  assert.equal(graded.length, 1);
  assert.equal(graded[0].grade, null);
});

/* ── 模拟下载 ───────────────────────────────────────────── */

/** 假的 HTTP：按 Range 返回对应字节数，可指定文件大小与是否支持 Range。 */
function fakeHttp({ size, supportsRange = true, failIndexes = [] } = {}) {
  let call = 0;
  return async (url, opts) => {
    const range = opts?.headers?.range || '';
    const m = range.match(/bytes=(\d+)-(\d+)/);
    const isProbe = range === 'bytes=0-1';
    if (!supportsRange) {
      return {
        status: 200,
        headers: new Headers({ 'content-length': String(size), 'content-type': 'video/mp4' }),
        body: null, arrayBuffer: async () => new ArrayBuffer(0),
      };
    }
    const idx = isProbe ? -1 : call++;
    if (failIndexes.includes(idx)) throw new Error('模拟网络错误');
    const start = m ? Number(m[1]) : 0;
    const end = m ? Math.min(Number(m[2]), size - 1) : size - 1;
    const len = Math.max(0, end - start + 1);
    return {
      status: 206,
      headers: new Headers({
        'content-range': `bytes ${start}-${end}/${size}`,
        'content-type': 'video/mp4',
        'accept-ranges': 'bytes',
      }),
      body: null,
      arrayBuffer: async () => new Uint8Array(len).buffer,
    };
  };
}

test('五线程各取一段，段与段不重叠、总量不超过文件本身', async () => {
  const size = 100 * 1024 * 1024;
  const r = await simulateDownload('http://x/f.mp4', {
    threads: 5, requestFn: fakeHttp({ size }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.threads, 5);
  assert.equal(r.segments.length, 5);

  const starts = r.segments.map((s) => s.start);
  assert.equal(new Set(starts).size, 5, '五个线程必须取不同的段');
  assert.ok(r.fetchedBytes <= size, '取回字节数不能超过文件大小');
  // 段要铺开而不是全挤在文件头部
  assert.ok(Math.max(...starts) > size / 2, '取样点应覆盖到文件后半段');
});

test('文件比 分块×线程 还小时自动缩小分块，不让多个线程重复拉同一块', async () => {
  const size = 300 * 1024;    // 比 256KB × 5 小得多
  const r = await simulateDownload('http://x/small.mp4', {
    threads: 5, requestFn: fakeHttp({ size }),
  });
  const starts = r.segments.map((s) => s.start);
  assert.equal(new Set(starts).size, starts.length, '起点不得重复');
  assert.ok(r.fetchedBytes <= size, `取回 ${r.fetchedBytes} 不该超过文件 ${size}`);
});

test('服务端不支持 Range 时直接判定不可并发、不可续传', async () => {
  const r = await simulateDownload('http://x/f.mp4', {
    threads: 5, requestFn: fakeHttp({ size: 1000, supportsRange: false }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.rangeSupported, false);
  assert.match(r.reason, /不支持 Range/);
});

test('部分线程失败时如实报告失败数量', async () => {
  const r = await simulateDownload('http://x/f.mp4', {
    threads: 5, requestFn: fakeHttp({ size: 100 * 1024 * 1024, failIndexes: [1, 3] }),
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /2\/5/);
});

/* ── 轮次推进 ───────────────────────────────────────────── */

/** 造一个 verifyCandidates 的替身：按 url 前缀决定成功还是失败。 */
function fakeVerifyOpts(okPrefix) {
  return {
    browser: {
      async newPage() {
        return {
          goto: async () => ({ elapsedMs: 1 }),
          evaluate: async () => ({ ok: false, frames: [], errors: [], events: {} }),
          close: async () => {},
        };
      },
    },
    baseUrl: 'http://127.0.0.1:1',
    threads: 2,
    // 必须按请求的区间回应：模拟下载会核对 content-range 与请求是否一致，
    // 永远回同一个区间会被正确判定为"区间不符"，那是代码在做该做的事。
    requestFn: async (url, opts) => {
      if (!url.startsWith(okPrefix)) throw new Error('不可达');
      const SIZE = 1000;
      const m = (opts?.headers?.range || '').match(/bytes=(\d+)-(\d+)/);
      const start = m ? Number(m[1]) : 0;
      const end = m ? Math.min(Number(m[2]), SIZE - 1) : SIZE - 1;
      return {
        status: 206,
        headers: new Headers({
          'content-range': `bytes ${start}-${end}/${SIZE}`,
          'content-type': 'video/mp4',
        }),
        body: null,
        arrayBuffer: async () => new ArrayBuffer(Math.max(0, end - start + 1)),
      };
    },
  };
}

test('第一轮就找到可用片源时不再开第二轮', async () => {
  const cands = Array.from({ length: 20 }, (_, i) => ({ url: `http://ok/${i}.mp4`, filename: `${i}.mp4` }));
  const r = await verifyWithRounds(cands, { topN: 5, maxRounds: 10 }, fakeVerifyOpts('http://ok'));
  assert.equal(r.totalRounds, 1);
  assert.equal(r.succeeded, true);
  assert.match(r.stopReason, /第 1 轮/);
});

test('全军覆没就换下一批候选，且不重复验同一批', async () => {
  const cands = Array.from({ length: 12 }, (_, i) => ({ url: `http://bad/${i}.mp4`, filename: `${i}.mp4` }));
  const r = await verifyWithRounds(cands, { topN: 4, maxRounds: 10 }, fakeVerifyOpts('http://ok'));
  assert.equal(r.totalRounds, 3, '12 条 / 每轮 4 条 = 3 轮');
  assert.equal(r.succeeded, false);
  // 每轮验的候选区间要接续，不能重叠
  assert.deepEqual(r.rounds.map((x) => x.candidateRange), [[1, 4], [5, 8], [9, 12]]);
});

test('轮数上限可配置且真的生效', async () => {
  const cands = Array.from({ length: 100 }, (_, i) => ({ url: `http://bad/${i}.mp4` }));
  const r = await verifyWithRounds(cands, { topN: 2, maxRounds: 3 }, fakeVerifyOpts('http://ok'));
  assert.equal(r.totalRounds, 3, '到 3 轮就该停，不该一直验到候选用完');
  assert.match(r.stopReason, /已达最大轮数 3/);
});

test('候选用尽时停下并说明，而不是空转到上限', async () => {
  const cands = [{ url: 'http://bad/1.mp4' }, { url: 'http://bad/2.mp4' }];
  const r = await verifyWithRounds(cands, { topN: 5, maxRounds: 10 }, fakeVerifyOpts('http://ok'));
  assert.equal(r.totalRounds, 1);
  assert.match(r.stopReason, /已达最大轮数|候选/);
});

/* ── 检索后端 ───────────────────────────────────────────── */

test('CLI 模板不走 shell，查询词里的元字符不会被执行', () => {
  const { cmd, args } = buildArgv('ddgr --json -n {limit} {query}', {
    query: 'foo; rm -rf / && curl evil.example', limit: 10,
  });
  assert.equal(cmd, 'ddgr');
  // 整个查询词必须是**一个**参数，而不是被拆成多个、更不能被 shell 解释
  assert.ok(args.includes('foo; rm -rf / && curl evil.example'));
  assert.equal(args.filter((a) => a.includes('rm -rf')).length, 1);
});

test('CLI 输出三种格式都能解析，坏行不会毁掉整批', () => {
  assert.equal(parseCliOutput('[{"url":"https://a.org","title":"A"}]', 'json').length, 1);
  assert.equal(parseCliOutput('{"url":"https://a.org"}\n坏行\n{"url":"https://b.org"}', 'jsonl').length, 2);
  assert.equal(parseCliOutput('https://a.org\n不是地址\nhttps://b.org', 'lines').length, 2);
  // 完全解析不了时返回空数组而不是抛错
  assert.deepEqual(parseCliOutput('乱七八糟', 'json'), []);
});

test('各引擎的结果页地址带上了分页参数', () => {
  assert.match(engineSearchUrl('google', 'x', 3, 10), /start=20/);
  assert.match(engineSearchUrl('bing', 'x', 2, 50), /first=51/);
  assert.match(engineSearchUrl('baidu', 'x', 3, 10), /pn=20/);
  assert.match(engineSearchUrl('duckduckgo', 'x', 1, 10), /html\.duckduckgo\.com/);
  assert.match(engineSearchUrl('yandex', 'x', 2, 10), /p=1/);
});

test('browser 后端不用填配置，但得真有 Chromium；cli 缺命令则不可用', () => {
  const has = { hasChrome: true };
  const none = { hasChrome: false };
  assert.equal(checkBackend({ CINEROUTE_SERP_BACKEND: 'browser' }, null, has).available, true);
  assert.equal(checkBackend({ CINEROUTE_SERP_BACKEND: 'browser' }, null, none).available, false);
  assert.equal(checkBackend({ CINEROUTE_SERP_BACKEND: 'cli' }, null, has).available, false);
  // 什么都没配、机器上也没有 Chromium —— 三条路都不通
  assert.equal(checkBackend({}, null, none).available, false);
  // 什么都没配但有 Chromium —— 自动走无头浏览器，这是开箱即用那条路
  assert.equal(checkBackend({}, null, has).available, true);
  assert.equal(checkBackend({}, null, has).backend, 'browser');
});
