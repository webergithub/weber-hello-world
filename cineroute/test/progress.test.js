/**
 * 检索进度。
 *
 * 进度条的数字是粗算的，所以不去断言"某一步应该是 37%"——那是把实现细节
 * 焊死在测试里。真正要保证的是两件事，而且这两件事一旦破了用户立刻会看见：
 * 进度**不倒退**，跑完**确实到 100%**。
 *
 * 另外验一遍 SSE 那条路：进度是一边跑一边推的，不是攒到最后一起来。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { PHASES, phaseStart, phaseWeight, createReporter } from '../src/core/progress.js';
import { searchAll } from '../src/core/pipeline.js';
import { createFixtureFetch, createFixtureProbe, FIXTURE_SERP_CONFIG } from '../src/core/fixtureFetch.js';
import { defaultConfig } from '../src/core/sourceConfig.js';
import { startServer } from '../src/server/server.js';

const offline = () => ({
  fetchJson: createFixtureFetch(),
  probeFn: createFixtureProbe(),
  config: { ...defaultConfig(), serp: { ...FIXTURE_SERP_CONFIG } },
});

test('阶段权重合起来正好铺满 0-100，且首尾对齐', () => {
  const first = PHASES[0];
  const last = PHASES[PHASES.length - 1];
  assert.equal(phaseStart(first.key), 0);
  assert.equal(
    Math.round(phaseStart(last.key) + phaseWeight(last.key)),
    100,
    '最后一个阶段的终点必须正好是 100，否则进度条永远差一口气',
  );
  // 阶段起点严格递增
  const starts = PHASES.map((p) => phaseStart(p.key));
  assert.deepEqual(starts, [...starts].sort((a, b) => a - b));
  assert.equal(new Set(starts).size, starts.length, '两个阶段不该有相同起点');
});

test('没传回调时上报器是空操作，不会炸', () => {
  const r = createReporter(undefined);
  r.phase('discovery');
  r.step('x', { done: 1, total: 2 });
  r.note('y');
  r.done();
  r.fail('z');
});

test('回调自己抛错不会连累检索', () => {
  const r = createReporter(() => { throw new Error('界面炸了'); });
  r.phase('discovery');
  r.step('x');
  r.done();
});

test('百分比单调不减：阶段内算出更小的值也不许倒退', () => {
  const seen = [];
  const r = createReporter((ev) => seen.push(ev.pct));
  r.phase('probe');
  r.step('a', { done: 5, total: 10 });
  r.step('b', { done: 1, total: 10 });   // 故意给个更小的
  r.phase('plan');                        // 故意退回靠前的阶段
  r.done();
  assert.deepEqual(seen, [...seen].sort((a, b) => a - b), `进度倒退了：${seen.join(' → ')}`);
  assert.equal(seen.at(-1), 100);
});

test('端到端：进度覆盖全部阶段，逐源与逐条嗅探都有交代', async () => {
  const events = [];
  const r = await searchAll('Night of the Living Dead', {
    ...offline(),
    onProgress: (ev) => events.push(ev),
  });

  const pcts = events.map((e) => e.pct);
  assert.deepEqual(pcts, [...pcts].sort((a, b) => a - b), '进度不能倒退');
  assert.equal(pcts.at(-1), 100);
  assert.equal(events.at(-1).type, 'done');

  // 阶段按定义的顺序出现，不重不漏
  const phases = events.filter((e) => e.type === 'phase').map((e) => e.phase);
  assert.deepEqual(phases, PHASES.map((p) => p.key));

  // 每个源都要有一行收工消息——跳过的、出错的也算
  const stepLabels = events.filter((e) => e.type === 'step').map((e) => e.label);
  for (const p of r.providers) {
    assert.ok(
      stepLabels.some((l) => l.startsWith(p.label)),
      `源「${p.label}」没有进度消息`,
    );
  }

  // 嗅探是最慢的一步，必须逐条报，不能整段静默
  const probeSteps = events.filter((e) => e.phase === 'probe' && e.type === 'step');
  assert.equal(probeSteps.length, r.stats.probed, '嗅探了几条就该报几条');
  assert.ok(probeSteps.every((e) => e.total === r.stats.probed && e.done >= 1));

  // 每条进度都带耗时，界面上要显示"已经跑了多久"
  assert.ok(events.every((e) => Number.isFinite(e.elapsedMs)));
});

test('优先来源的进度消息用它自己的统计口径，不会打出 undefined', async () => {
  const events = [];
  await searchAll('Night of the Living Dead', {
    ...offline(),
    onProgress: (ev) => events.push(ev),
  });
  const line = events.find((e) => e.type === 'step' && e.label.startsWith('优先来源'));
  assert.ok(line, '优先来源应有一行进度消息');
  assert.ok(!/undefined/.test(`${line.label}${line.detail}`), `进度消息里有 undefined：${line.detail}`);
  assert.match(line.detail, /命中 \d+ 条/);
});

/* ── SSE ────────────────────────────────────────────────── */

/** 把 SSE 流拆成 {event, data} 列表。 */
function parseSse(text) {
  return text.split('\n\n').filter((b) => b.includes('event:')).map((block) => ({
    event: (block.match(/^event: (.+)$/m) || [])[1],
    data: JSON.parse((block.match(/^data: ([\s\S]+)$/m) || [])[1]),
  }));
}

test('/api/search?stream=1 边跑边推进度，最后推一帧完整结果', async () => {
  const server = await startServer({
    offline: true,
    offlineOpts: { ...offline(), serp: { ...FIXTURE_SERP_CONFIG } },
    port: 0,
    host: '127.0.0.1',
  });
  const { port } = server.address();

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/search?stream=1&q=Night of the Living Dead`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);

    const frames = parseSse(await res.text());
    const progress = frames.filter((f) => f.event === 'progress');
    const result = frames.filter((f) => f.event === 'result');

    assert.ok(progress.length > 10, `进度帧太少（${progress.length}），像是攒到最后才发`);
    assert.equal(result.length, 1, '结果帧应恰好一帧');
    assert.equal(frames.at(-1).event, 'result', '结果必须是最后一帧');
    assert.equal(progress.at(-1).data.pct, 100);

    // 结果帧就是普通检索的那份 JSON，不是精简版——第五步验证要拿它去跑
    const data = result[0].data;
    assert.ok(data.stages && data.recommendations && data.providers);
    assert.ok(data.top.length > 0);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('不带 stream=1 时仍返回一整个 JSON，脚本调用方不受影响', async () => {
  const server = await startServer({
    offline: true,
    offlineOpts: { ...offline(), serp: { ...FIXTURE_SERP_CONFIG } },
    port: 0,
    host: '127.0.0.1',
  });
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/search?q=Night of the Living Dead`);
    assert.match(res.headers.get('content-type'), /application\/json/);
    const data = await res.json();
    assert.ok(data.top.length > 0);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
