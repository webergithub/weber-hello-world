/**
 * 片名清单 × 完整管线。
 *
 * 上一个文件（titles.test.js）验的是单个函数；这里把清单里的片名喂进
 * **真实的编排 + 打分 + 排序**，看整条链路在中文片名、续集编号、
 * 带标点的片名上会不会塌。
 *
 * 候选池是照着归档站的真实样子造的：一个正片、一个预告、一个幕后花絮、
 * 一个浏览器放不了的 MKV、外加一部**别的电影**。正确的行为是
 * 正片排第一，预告和花絮进不了推荐位，别的电影不该冒头。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { searchAll } from '../src/core/pipeline.js';
import { titleSimilarity } from '../src/core/match.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORPUS = JSON.parse(readFileSync(path.join(HERE, 'corpus/titles.json'), 'utf8'));

/** 每个语种挑几部有代表性的，跑全管线比跑单函数贵得多，不必全上。 */
const PICKS = [
  '哪吒之魔童闹海', '流浪地球2', '你好，李焕英', '深海', '封神第一部：朝歌风云',
  'Dune: Part Two', 'Deadpool & Wolverine', 'The Wild Robot',
  'Ghostbusters: Frozen Empire', 'Everything Everywhere All at Once', 'Thunderbolts*',
];
const ENTRIES = [...CORPUS.zh, ...CORPUS.en, ...CORPUS.edge]
  .filter((e) => PICKS.includes(e.q));

/** 一部"别的电影"，用来验准入门槛：它不该混进推荐位。 */
const OTHER = { zh: '满江红', en: 'Barbie' };

const RUNTIME = 6600;   // 110 分钟

/** 造一条归档站风格的片源记录。 */
function src(id, title, over = {}) {
  return {
    id,
    provider: 'internet-archive',
    providerLabel: 'Internet Archive',
    title,
    filename: `${id}.mp4`,
    url: `https://archive.org/download/${id}/${id}.mp4`,
    pageUrl: `https://archive.org/details/${id}`,
    container: 'mp4',
    height: 1080,
    durationSec: RUNTIME,
    bytes: 3_500_000_000,
    license: 'https://creativecommons.org/publicdomain/zero/1.0/',
    collections: ['moviesandfilms'],
    downloads: 5000,
    checksums: { md5: id.padEnd(32, '0'), sha1: null },
    rangeSupported: true,
    reachable: true,
    ...over,
  };
}

/** 一个只返回给定片源的假适配器。管线其余部分全是真的。 */
function fakeAdapter(sources) {
  return {
    id: 'fake', label: '测试源', kind: 'direct', requiresConfig: false,
    async search() { return { provider: 'fake', items: [], sources, leads: [] }; },
  };
}

/** 给一部片子造一池候选：正片 + 预告 + 花絮 + 不可播容器 + 另一部电影。 */
function pool(entry) {
  const t = entry.title ?? entry.q;
  const other = OTHER[entry.lang];
  const suffix = entry.lang === 'zh' ? '完整版' : 'full movie';
  return [
    src('feature', `${t} ${suffix}`),
    src('trailer', entry.lang === 'zh' ? `${t} 预告片` : `${t} official trailer`, {
      filename: 'trailer.mp4', durationSec: 140, bytes: 40_000_000, height: 720,
    }),
    src('bts', entry.lang === 'zh' ? `${t} 幕后花絮` : `${t} behind the scenes`, {
      filename: 'behind_the_scenes.mp4', durationSec: 900, bytes: 300_000_000, height: 720,
    }),
    src('mkv', `${t} ${suffix} 4K`, {
      filename: `${t}.mkv`, container: 'mkv',
      url: `https://archive.org/download/mkv/${encodeURIComponent(t)}.mkv`,
      height: 2160, bytes: 20_000_000_000,
    }),
    src('other', `${other} ${suffix}`, { height: 1080, durationSec: RUNTIME - 300 }),
  ];
}

const run = (entry) => searchAll(entry.q, {
  adapters: [fakeAdapter(pool(entry))],
  skipProbe: true,
});

test('清单 × 管线：正片排第一，预告与花絮进不了推荐位', async () => {
  const bad = [];
  for (const e of ENTRIES) {
    const r = await run(e);
    const top = r.top.map((s) => s.id);
    if (top[0] !== 'feature') {
      bad.push(`  · 「${e.q}」第一名是 ${top[0] ?? '（空）'}，应为 feature（排序：${top.join(' > ')}）`);
    }
    for (const junk of ['trailer', 'bts']) {
      if (top.includes(junk)) bad.push(`  · 「${e.q}」${junk} 混进了推荐位：${top.join(' > ')}`);
    }
  }
  assert.equal(bad.length, 0, `${bad.length} 处排序不对：\n${bad.join('\n')}`);
});

test('清单 × 管线：浏览器放不了的容器进备选区，不占推荐位', async () => {
  const bad = [];
  for (const e of ENTRIES) {
    const r = await run(e);
    if (r.top.some((s) => s.id === 'mkv')) bad.push(`  · 「${e.q}」MKV 进了推荐位`);
    const alt = r.alternatives.find((s) => s.id === 'mkv');
    if (!alt) bad.push(`  · 「${e.q}」MKV 没出现在备选区`);
    else if (!alt.blockReason) bad.push(`  · 「${e.q}」MKV 进了备选区但没说明原因`);
  }
  assert.equal(bad.length, 0, `${bad.length} 处不对：\n${bad.join('\n')}`);
});

test('清单 × 管线：非正片的完整度维度归零并写明理由', async () => {
  const bad = [];
  for (const e of ENTRIES) {
    const r = await run(e);
    const all = [...r.top, ...r.alternatives];
    for (const junk of ['trailer', 'bts']) {
      const s = all.find((x) => x.id === junk);
      if (!s) continue;   // 已经被排到看不见的位置，也算达到目的
      const dim = s.breakdown?.find((d) => d.key === 'completeness');
      if (!dim) { bad.push(`  · 「${e.q}」${junk} 没有完整度维度`); continue; }
      if (dim.score !== 0) bad.push(`  · 「${e.q}」${junk} 完整度得分 ${dim.score}，应为 0`);
      if (!dim.suspicious) bad.push(`  · 「${e.q}」${junk} 没被标为可疑`);
      if (!/非正片/.test(dim.reason || '')) bad.push(`  · 「${e.q}」${junk} 理由没说清：${dim.reason}`);
      if (!s.blocked) bad.push(`  · 「${e.q}」${junk} 没被挡在推荐位之外`);
    }
  }
  assert.equal(bad.length, 0, `${bad.length} 处不对：\n${bad.join('\n')}`);
});

test('清单 × 管线：正片的完整度不该被误判成非正片', async () => {
  // 这是 Ghostbusters（含 ost）、Eclipse（含 clip）那类误判的回归位置：
  // 误判一次就是完整度归零，正片直接被踢出推荐位
  const bad = [];
  for (const e of ENTRIES) {
    const r = await run(e);
    const feature = [...r.top, ...r.alternatives].find((s) => s.id === 'feature');
    if (!feature) { bad.push(`  · 「${e.q}」正片整个消失了`); continue; }
    const dim = feature.breakdown?.find((d) => d.key === 'completeness');
    if (dim?.suspicious) bad.push(`  · 「${e.q}」正片被标为可疑：${dim.reason}`);
    if (dim && dim.score === 0) bad.push(`  · 「${e.q}」正片完整度归零：${dim.reason}`);
    if (feature.blocked) bad.push(`  · 「${e.q}」正片被挡在推荐位之外：${feature.blockReason}`);
  }
  assert.equal(bad.length, 0, `${bad.length} 处正片被误伤：\n${bad.join('\n')}`);
});

test('清单 × 管线：别的电影不该排在本片前面', async () => {
  // 管线本身不做相似度准入（那是各适配器的事），但排序结果里
  // 同等条件的"另一部电影"不该压过本片；相似度也要能把两者分开
  const bad = [];
  for (const e of ENTRIES) {
    const t = e.title ?? e.q;
    const other = OTHER[e.lang];
    const sim = titleSimilarity(t, other);
    if (sim >= 0.6) bad.push(`  · 「${t}」与「${other}」相似度 ${sim.toFixed(3)}，分不开`);

    const r = await run(e);
    const top = r.top.map((s) => s.id);
    const iFeature = top.indexOf('feature');
    const iOther = top.indexOf('other');
    if (iOther !== -1 && iFeature !== -1 && iOther < iFeature) {
      bad.push(`  · 「${e.q}」另一部电影排在本片前面：${top.join(' > ')}`);
    }
  }
  assert.equal(bad.length, 0, `${bad.length} 处不对：\n${bad.join('\n')}`);
});

test('清单 × 管线：中文片名一路走下来不会被解析坏', async () => {
  const bad = [];
  for (const e of ENTRIES.filter((x) => x.lang === 'zh')) {
    const r = await run(e);
    if (r.query.title !== (e.title ?? e.q)) {
      bad.push(`  · 「${e.q}」管线里的片名成了「${r.query.title}」`);
    }
    // 检索词里必须有原词，且中文走中文的后缀
    const terms = r.stages.discovery.terms.map((t) => t.term);
    if (!terms.includes(e.title ?? e.q)) bad.push(`  · 「${e.q}」检索词里没有原词：${terms.join(' | ')}`);
    if (terms.some((t) => t.includes('full movie'))) bad.push(`  · 「${e.q}」中文片名用了英文后缀：${terms.join(' | ')}`);
  }
  assert.equal(bad.length, 0, `${bad.length} 处不对：\n${bad.join('\n')}`);
});
