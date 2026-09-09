/**
 * 片名清单回归测试。
 *
 * 拿 test/corpus/titles.json 里的近年热门中英文片名，把它们喂给真实的
 * 片名解析 / 相似度 / 检索词扩展代码，看这套逻辑在"不是《活死人之夜》"的
 * 输入上还站不站得住。
 *
 * 断言尽量写成**性质**而不是硬编码的期望值：
 * 「同一部片子的不同写法要能对上」「不同的片子不能对上」
 * 「清单里的片名不该被判成预告片」。这样加一部新片进清单不用改测试。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseQuery, titleSimilarity, normalizeTitle, tokenize, nonFeatureHint, titleKey,
} from '../src/core/match.js';
import { buildVariants, filterSuggested, planFirstRound } from '../src/core/expand.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORPUS = JSON.parse(readFileSync(path.join(HERE, 'corpus/titles.json'), 'utf8'));

/** 清单展开成一维，并补上省略的默认期望。 */
const ALL = [...CORPUS.zh, ...CORPUS.en, ...CORPUS.edge].map((e) => ({
  ...e,
  title: e.title ?? e.q,
  parsedYear: e.parsedYear ?? null,
}));

const POPULAR = ALL.filter((e) => e.tags.includes('popular'));
const label = (e) => `${e.q}${e.note ? `（${e.note}）` : ''}`;

/** 把失败的条目一次性攒起来报出来，别让第一条失败挡住后面全部。 */
function collect(items, check) {
  const bad = [];
  for (const it of items) {
    const msg = check(it);
    if (msg) bad.push(`  · ${label(it)}\n      ${msg}`);
  }
  return bad;
}

const report = (bad, total, what) => {
  assert.equal(bad.length, 0, `${bad.length}/${total} 条${what}：\n${bad.join('\n')}`);
};

/* ── 片名解析 ─────────────────────────────────────────────── */

test('清单：片名与年份能正确分开', () => {
  const bad = collect(ALL, (e) => {
    const got = parseQuery(e.q);
    if (got.title !== e.title) return `片名应为「${e.title}」，实际「${got.title}」`;
    if (got.year !== e.parsedYear) return `年份应为 ${e.parsedYear}，实际 ${got.year}`;
    return null;
  });
  report(bad, ALL.length, '解析错了');
});

test('清单：手输年份（片名 + 空格 + 四位数）一律能剥出来', () => {
  const bad = collect(ALL, (e) => {
    const got = parseQuery(`${e.title} ${e.year}`);
    if (got.year !== e.year) return `「${e.title} ${e.year}」的年份应为 ${e.year}，实际 ${got.year}`;
    if (got.title !== e.title) return `片名应为「${e.title}」，实际「${got.title}」`;
    return null;
  });
  report(bad, ALL.length, '年份没剥干净');
});

/* ── 相似度 ───────────────────────────────────────────────── */

test('清单：片名与自己的相似度是 1', () => {
  const bad = collect(ALL, (e) => {
    const s = titleSimilarity(e.title, e.title);
    return s === 1 ? null : `自比相似度 ${s.toFixed(3)}，应为 1`;
  });
  report(bad, ALL.length, '自比不等于 1');
});

test('清单：归档站那种长条目名要能匹配上', () => {
  // 归档站/资源站的实际标题长这样，片名只是其中一段
  const dress = (t, y) => [
    `${t} (${y}) 1080p BluRay x264`,
    `${t} ${y} 完整版`,
    `[${y}] ${t} - remastered`,
  ];
  const bad = collect(ALL, (e) => {
    const low = dress(e.title, e.year)
      .map((c) => [c, titleSimilarity(e.title, c)])
      .filter(([, s]) => s < 0.7);
    return low.length
      ? low.map(([c, s]) => `「${c}」只有 ${s.toFixed(3)}`).join('；')
      : null;
  });
  report(bad, ALL.length, '匹配不上自己的常见条目写法');
});

test('清单：不同的片子不该互相匹配（准入门槛不能形同虚设）', () => {
  // 相似度是准入门槛，误判成"同一部"会让无关片源混进候选池
  const bad = [];
  for (let i = 0; i < POPULAR.length; i += 1) {
    for (let j = i + 1; j < POPULAR.length; j += 1) {
      const a = POPULAR[i];
      const b = POPULAR[j];
      if (a.lang !== b.lang) continue;      // 跨语种本来就不该比
      const s = titleSimilarity(a.title, b.title);
      if (s >= 0.75) bad.push(`  · 「${a.title}」×「${b.title}」= ${s.toFixed(3)}`);
    }
  }
  assert.equal(bad.length, 0, `${bad.length} 对不同的片子被判成高度相似：\n${bad.join('\n')}`);
});

test('清单：归一化和切词不会把片名清空', () => {
  const bad = collect(ALL, (e) => {
    const n = normalizeTitle(e.title);
    if (!n) return '归一化之后成了空串';
    if (tokenize(n).length === 0) return `切词之后没有词（归一化结果「${n}」）`;
    return null;
  });
  report(bad, ALL.length, '被归一化/切词吃掉了');
});

test('清单：去重键唯一——不同的片子不能撞成同一个键', () => {
  const seen = new Map();
  const bad = [];
  for (const e of POPULAR) {
    const k = titleKey(e.title, e.year);
    if (seen.has(k)) bad.push(`  · 「${e.title}」与「${seen.get(k)}」都得到键 ${k}`);
    else seen.set(k, e.title);
  }
  assert.equal(bad.length, 0, `去重键相撞：\n${bad.join('\n')}`);
});

/* ── 非正片判定 ───────────────────────────────────────────── */

test('清单：正片片名不该被判成预告片/花絮/原声带', () => {
  // 命中这条判定的后果很重：完整度维度直接归零并标记为可疑，
  // 等于把这个片源踢出推荐位。误判一次就是一部正片被丢掉。
  const bad = collect(ALL.filter((e) => e.q !== 'The Interview'), (e) => {
    const hint = nonFeatureHint(e.title);
    return hint ? `被判为非正片，命中提示词「${hint}」` : null;
  });
  report(bad, ALL.length, '正片被误判成非正片');
});

test('非正片判定对真的非正片仍然有效（修复不能矫枉过正）', () => {
  const should = [
    ['Oppenheimer official trailer', 'trailer'],
    ['Dune Part Two teaser', 'teaser'],
    ['Barbie behind the scenes', 'behind the scenes'],
    ['Wicked - Making of', 'making of'],
    ['哪吒之魔童闹海 预告', '预告'],
    ['流浪地球2 幕后花絮', '幕后'],
    ['满江红 影评', '影评'],
    ['The Wild Robot OST', 'ost'],
    ['Gladiator II soundtrack', 'soundtrack'],
    ['Top Gun Maverick clip', 'clip'],
    ['The Interview', 'interview'],
  ];
  const bad = [];
  for (const [text, want] of should) {
    const got = nonFeatureHint(text);
    if (!got) bad.push(`  · 「${text}」应命中「${want}」，实际没命中`);
  }
  assert.equal(bad.length, 0, `漏判了真正的非正片：\n${bad.join('\n')}`);
});

/* ── 检索词扩展 ───────────────────────────────────────────── */

test('清单：每个片名都能生成检索词，且原词永远排第一', () => {
  const bad = collect(ALL, (e) => {
    const terms = planFirstRound({ title: e.title, year: e.parsedYear }, { maxVariants: 4, maxTerms: 4 });
    if (terms.length === 0) return '一个检索词都没生成';
    if (terms[0].kind !== 'original') return `第一个词应是原词，实际是 ${terms[0].kind}`;
    if (terms[0].term !== e.title) return `原词应为「${e.title}」，实际「${terms[0].term}」`;
    if (terms.some((t) => !t.term.trim())) return '有空的检索词';
    if (new Set(terms.map((t) => t.term)).size !== terms.length) return '检索词有重复';
    return null;
  });
  report(bad, ALL.length, '检索词生成有问题');
});

test('清单：中英文各走各的归档站后缀写法', () => {
  const bad = collect(ALL, (e) => {
    const terms = buildVariants({ title: e.title }, { maxVariants: 6 }).map((t) => t.term);
    const want = e.lang === 'zh' ? '完整版' : 'full movie';
    const wrong = e.lang === 'zh' ? 'full movie' : '完整版';
    if (!terms.some((t) => t.includes(want))) return `缺少带「${want}」的近似词：${terms.join(' | ')}`;
    if (terms.some((t) => t.includes(wrong))) return `不该出现带「${wrong}」的近似词`;
    return null;
  });
  report(bad, ALL.length, '归档站后缀用错了语种');
});

test('清单：引擎返回的推荐搜索词能过得了相关性过滤', () => {
  // 第二轮补搜全靠这一步。过滤太严会把所有推荐词都毙掉，等于第二轮白跑。
  //
  // 关键在于用**引擎真实会返回的形态**来验，而不是把片名原样拼一下：
  // 相关搜索是从用户查询串里聚合出来的，标点基本都掉了——
  // 「Spider-Man: Across the Spider-Verse」回来是「spider man across the spider verse」，
  // 「你好，李焕英」回来是「你好李焕英」。拿原样片名去验等于没验。
  const strip = (t) => t.toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const bad = collect(ALL, (e) => {
    const t = e.title;
    const s = strip(t);
    const suggested = e.lang === 'zh'
      ? [`${s} 在线观看`, `${s.replace(/\s+/g, '')}免费完整版`, `${t} 下载`, '完全无关的词']
      : [`${s} full movie online`, `watch ${s} free`, `${t} 4k download`, 'totally unrelated'];
    const kept = filterSuggested(suggested, t);
    if (kept.length === 0) return `全被过滤掉了，一个都没留下：${suggested.slice(0, 3).join(' | ')}`;
    if (kept.includes('完全无关的词') || kept.includes('totally unrelated')) return '无关词没被过滤掉';
    return null;
  });
  report(bad, ALL.length, '推荐词过滤有问题');
});

test('推荐词过滤要挡住"沾了个词就算相关"的跑题词', () => {
  // 过滤太松的后果同样实在：第二轮拿着跑题词去搜，白烧配额还污染候选池
  const cases = [
    ['Dune: Part Two', 'dune 1984 david lynch', false],
    ['Dune: Part Two', 'dune part two full movie', true],
    ['流浪地球2', '流浪地球2 在线观看', true],
    ['流浪地球2', '刘慈欣 三体 小说', false],
    ['Killers of the Flower Moon', 'killers of the flower moon 1080p', true],
    ['Killers of the Flower Moon', 'moon knight disney', false],
  ];
  const bad = [];
  for (const [title, term, want] of cases) {
    const got = filterSuggested([term], title).length === 1;
    if (got !== want) bad.push(`  · 「${title}」← 「${term}」应${want ? '保留' : '过滤'}，实际${got ? '保留' : '过滤'}`);
  }
  assert.equal(bad.length, 0, `推荐词过滤松紧不对：\n${bad.join('\n')}`);
});
