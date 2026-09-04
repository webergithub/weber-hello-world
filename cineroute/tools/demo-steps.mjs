#!/usr/bin/env node
/**
 * 把一次检索的**第一步（引擎原始结果）**和**第三步（嗅探甄别）**摊开打印。
 *
 * CLI 的默认报告只给最终 Top5，中间被谁筛掉了看不见。调研取证要能回答
 * "这个地址是怎么来的、为什么没进来"，所以单独有这么个脚本。Web 界面上
 * 这两步是 tab ① 和 tab ③，这里打印的是同一份数据（stages.discovery /
 * stages.verify），只是换成终端能看的样子。
 *
 *   node tools/demo-steps.mjs "阿凡达" "我不是酒神"
 *
 * 默认走离线夹具（`--offline` 是默认行为，因为这个脚本是用来看流程的）。
 * 加 `--live` 则打真实引擎——那需要机器能出网。
 */

import { searchAll } from '../src/core/pipeline.js';
import {
  createFixtureFetch, createFixtureProbe, applyFixtureSerpEnv, FIXTURE_SERP_CONFIG,
} from '../src/core/fixtureFetch.js';

const argv = process.argv.slice(2);
const live = argv.includes('--live');
const titles = argv.filter((a) => !a.startsWith('--'));
if (titles.length === 0) {
  console.error('用法：node tools/demo-steps.mjs [--live] <片名> [片名...]');
  process.exit(1);
}

const pad = (s, n) => {
  // 中日韩字符终端里占两格，按显示宽度补空格，否则表格会歪
  let w = 0;
  for (const ch of String(s)) w += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/.test(ch) ? 2 : 1;
  return String(s) + ' '.repeat(Math.max(0, n - w));
};
const trunc = (s, n) => (String(s ?? '').length > n ? `${String(s).slice(0, n - 1)}…` : String(s ?? ''));
const dur = (sec) => (sec ? `${Math.floor(sec / 60)}分${String(Math.round(sec % 60)).padStart(2, '0')}秒` : '—');
const size = (b) => (b ? (b >= 1 << 30 ? `${(b / 2 ** 30).toFixed(2)}GB` : `${Math.round(b / 2 ** 20)}MB`) : '—');

async function run(rawQuery) {
  const opts = live ? {} : {
    fetchJson: createFixtureFetch(),
    probeFn: createFixtureProbe(),      // 选项名是 probeFn，写错就等于没接探测替身
    serp: FIXTURE_SERP_CONFIG,
  };
  const r = await searchAll(rawQuery, opts);
  const { discovery, verify } = r.stages;

  console.log(`\n${'━'.repeat(96)}`);
  console.log(`🎬  「${rawQuery}」　解析为：片名=${r.query.title}　年份=${r.query.year ?? '未指定'}　耗时 ${r.elapsedMs}ms`);
  console.log('━'.repeat(96));

  /* ── 第一步 ─────────────────────────────────────────── */
  console.log(`\n【第一步】${discovery.label}`);
  console.log(`  检索词 ${discovery.terms.length} 个：${discovery.terms.map((t) => `${t.term}（${t.why}）`).join('、')}`);
  console.log(`  合计原始返回 ${discovery.totalResults} 条\n`);

  for (const e of discovery.engines) {
    const icon = e.status === 'ok' ? '✓' : e.status === 'skipped' ? '⏭' : '✗';
    console.log(`  ${icon} ${pad(e.label, 40)} ${e.status === 'ok' ? `${e.total} 条` : (e.reason || e.status)}`);
    for (const round of e.rounds ?? []) {
      if (!round.results?.length) continue;
      console.log(`      「${round.term}」→ ${round.returned} 条`);
      for (const x of round.results) {
        console.log(`        ${String(x.rank).padStart(2)}. ${trunc(x.title, 52)}`);
        console.log(`            ${trunc(x.url, 88)}`);
      }
    }
  }

  /* ── 第三步 ─────────────────────────────────────────── */
  console.log(`\n【第二步/嗅探】${verify.label}`);
  console.log(`  归一去重后 ${r.stats.afterDedupe} 条候选 · 实际嗅探 ${verify.checked}/${verify.total} 条`
    + ` · 可用 ${verify.usable} 条 · 筛除 ${verify.rejected} 条\n`);

  if (verify.items.length === 0) {
    console.log('  （没有任何候选进到这一步——引擎发现的页面都没有对应的解析器，见下面的线索）\n');
  }
  for (const v of verify.items) {
    const mark = v.verdict === 'usable' ? '✅ 可用' : '❌ 筛除';
    console.log(`  ${mark}  ${trunc(v.filename, 56)}`);
    console.log(`         来源 ${v.providerLabel} · ${v.container || '?'} · ${v.height ? `${v.height}p` : '?'}`
      + ` · ${dur(v.durationSec)} · ${size(v.bytes)}${v.score != null ? ` · 得分 ${v.score}` : ''}`);
    console.log(`         嗅探：${v.probed ? `已探测 HTTP ${v.httpStatus}${v.rangeSupported ? '，支持 Range' : ''}` : '未探测（超出配额，按上游元数据判定）'}`);
    console.log(`         结论：${v.reason}`);
    for (const c of (v.citations ?? []).slice(0, 2)) {
      console.log(`         引用：${c.providerLabel || c.provider} 用「${c.term}」第 ${c.rank ?? '?'} 名 ← ${trunc(c.via || c.pageUrl || '', 60)}`);
    }
    console.log();
  }

  const leads = verify.leads ?? [];
  console.log(`  📄 引擎发现但没有解析器的页面：${leads.length} 条（只列线索，不抓取、不猜）`);
  for (const l of leads.slice(0, 12)) {
    console.log(`     · ${trunc(l.title || l.url, 54)}`);
    console.log(`       ${trunc(l.url, 88)}`);
    console.log(`       ${l.reason}`);
  }
  if (leads.length > 12) console.log(`     … 另有 ${leads.length - 12} 条`);

  console.log(`\n  ⟹ 最终可直接播放：${r.top.length} 条${r.top.length ? '' : '（没有找到可播的正片）'}`);
  for (const t of r.top.slice(0, 5)) console.log(`     ${t.score} 分  ${trunc(t.filename, 60)}`);
}

for (const t of titles) {
  try {
    await run(t);
  } catch (err) {
    console.log(`\n✗ 「${t}」跑失败：${String(err?.message || err)}`);
  }
}
