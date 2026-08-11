#!/usr/bin/env node
/**
 * CineRoute 影路 —— 命令行入口。
 *
 *   node index.js "Night of the Living Dead"     联网检索
 *   node index.js --offline "活死人之夜"          用本地夹具跑（无网、无 API key 可用）
 *   node index.js --serve                        启动 Web 服务（播放 + 离线下载）
 *   node index.js --serve --offline              离线演示模式启动 Web 服务
 */

import { searchAll } from './src/core/pipeline.js';
import { createFixtureFetch, createFixtureProbe } from './src/core/fixtureFetch.js';

const HELP = `
CineRoute 影路 — 公有领域 / 自由许可 / 自有媒体库的影视片源聚合检索

用法：
  node index.js <片名>              联网检索并输出 Top5 播放地址
  node index.js --offline <片名>    使用本地夹具（无需联网与 API key）
  node index.js --serve             启动 Web 服务（默认 http://localhost:8787）
  node index.js --serve --offline   离线演示模式启动 Web 服务

可选环境变量：
  TMDB_API_KEY        启用权威元数据与正版观看渠道（数据来源 JustWatch）
  JELLYFIN_URL/_API_KEY  接入你自己的媒体库
  CINEROUTE_PORT      Web 服务端口，默认 8787
  CINEROUTE_REGION    正版渠道地区，默认 US
`.trim();

function fmtDuration(sec) {
  if (!sec) return '—';
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h > 0 ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m`;
}

function fmtSize(bytes) {
  if (!bytes) return '—';
  const mb = bytes / 1024 / 1024;
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${Math.round(mb)} MB`;
}

/** 把一次检索结果打印成人类可读的报告。 */
function printReport(result) {
  const { query, title, recommendations, top, alternatives, offers, providers, stats, notes, elapsedMs } = result;

  console.log(`\n🎬  ${title.name}${title.year ? ` (${title.year})` : ''}`);
  if (title.runtimeSec) {
    const tag = title.runtimeSource === 'tmdb' ? '权威片长' : '推定片长（候选中位数）';
    console.log(`    ${tag}：${fmtDuration(title.runtimeSec)}`);
  }
  console.log(`    查询「${query.raw}」· 耗时 ${elapsedMs}ms`);

  console.log('\n📡  数据源');
  for (const p of providers) {
    const icon = p.status === 'ok' ? '✅' : p.status === 'skipped' ? '⏭️ ' : '⚠️ ';
    const detail = p.status === 'ok' ? `${p.count} 条 · ${p.elapsedMs}ms` : (p.reason || '');
    console.log(`    ${icon} ${p.label.padEnd(46)} ${detail}`);
  }
  console.log(`    候选 ${stats.rawCandidates} → 去重 ${stats.afterDedupe} → 探测 ${stats.probed} → 可播 ${stats.playable} / 受阻 ${stats.blocked}`);

  console.log(`\n🏆  Top${recommendations.length} 推荐（前 ${stats.recommendedDirect} 位可直接播放 · 后 ${stats.recommendedOffers} 位正版订阅/付费）`);
  if (recommendations.length === 0) console.log('    （无）');

  for (const rec of recommendations) {
    if (rec.kind === 'direct') {
      const s = rec.source;
      console.log(`\n  #${rec.rank}  ▶ 直接播放   ${s.score} 分   ${s.providerLabel}`);
      console.log(`      ${s.filename}`);
      console.log(`      ${s.container.toUpperCase()} · ${s.height ? `${s.height}p` : '分辨率未知'} · ${fmtDuration(s.durationSec)} · ${fmtSize(s.bytes)}`);
      console.log(`      ${s.url}`);
      for (const d of s.breakdown) {
        console.log(`        ${d.label.padEnd(6)} ${String(d.score).padStart(5)}/${String(d.max).padEnd(3)} ${d.reason}`);
      }
    } else {
      const o = rec.offer;
      console.log(`\n  #${rec.rank}  🎟️  ${o.typeLabel}   ${o.providerName}`);
      console.log(`      需在该平台订阅或付费后观看（${o.region} 区）`);
      if (o.link) console.log(`      ${o.link}`);
    }
  }

  if (alternatives.length > 0) {
    console.log(`\n📦  备选（浏览器放不了，但可下载后本地播放）`);
    for (const s of alternatives.slice(0, 5)) {
      console.log(`    · ${s.filename} — ${s.container.toUpperCase()} ${s.height ? `${s.height}p` : ''} ${fmtSize(s.bytes)}`);
      console.log(`      原因：${s.blockReason}`);
    }
  }

  if (offers.length > 0) {
    console.log(`\n🎟️   正版观看渠道（数据来源 JustWatch）`);
    const grouped = new Map();
    for (const o of offers) {
      if (!grouped.has(o.typeLabel)) grouped.set(o.typeLabel, []);
      grouped.get(o.typeLabel).push(o.providerName);
    }
    for (const [label, names] of grouped) {
      console.log(`    ${label}：${names.join('、')}`);
    }
    const link = offers.find((o) => o.link)?.link;
    if (link) console.log(`    观看页：${link}`);
  }

  if (notes.length > 0) {
    console.log('\n📝  说明');
    for (const n of notes) console.log(`    · ${n}`);
  }
  console.log('');
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(HELP);
    return;
  }

  const offline = argv.includes('--offline');
  const serve = argv.includes('--serve');
  const positional = argv.filter((a) => !a.startsWith('--'));

  const offlineOpts = offline
    ? { fetchJson: createFixtureFetch(), probeFn: createFixtureProbe() }
    : {};

  if (serve) {
    const { startServer } = await import('./src/server/server.js');
    await startServer({ offline, offlineOpts });
    return;
  }

  const q = positional.join(' ').trim();
  if (!q) {
    console.log(HELP);
    process.exitCode = 1;
    return;
  }

  if (offline) {
    console.log('（离线夹具模式：仅覆盖 Night of the Living Dead / Metropolis 两部演示作品）');
  }

  const result = await searchAll(q, offlineOpts);
  if (argv.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printReport(result);
  }
}

main().catch((err) => {
  console.error('运行失败：', err?.stack || err);
  process.exitCode = 1;
});
