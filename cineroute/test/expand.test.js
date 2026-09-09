/**
 * 检索词扩展测试。
 *
 * 这一层直接决定 SERP 花多少钱：每多一个词，请求数就多「引擎数 × 页数」一份。
 * 所以用例的重点有两个——扩出来的词得有用，以及**预算必须封得住**。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildVariants, harvestRelated, filterSuggested, capTerms,
  planFirstRound, planSecondRound,
} from '../src/core/expand.js';

test('原词永远排第一，且只有它标记为 original', () => {
  const v = buildVariants({ title: 'Night of the Living Dead', year: 1968 });
  assert.equal(v[0].term, 'Night of the Living Dead');
  assert.equal(v[0].kind, 'original');
  assert.equal(v.filter((x) => x.kind === 'original').length, 1);
});

test('有年份就加带年份的词——同名重拍片全靠这个分开', () => {
  const v = buildVariants({ title: 'Night of the Living Dead', year: 1968 });
  assert.ok(v.some((x) => x.term === 'Night of the Living Dead 1968'));

  // 没年份就不该硬造一个出来
  const noYear = buildVariants({ title: 'Metropolis', year: null });
  assert.ok(!noYear.some((x) => /\d{4}/.test(x.term)));
});

test('英文片名去掉前置冠词，中文片名不套这条规则', () => {
  const en = buildVariants({ title: 'The Great Train Robbery', year: null, }, { maxVariants: 8 });
  assert.ok(en.some((x) => x.term === 'Great Train Robbery'), '应给出去冠词的变体');

  const cn = buildVariants({ title: '活死人之夜', year: null }, { maxVariants: 8 });
  assert.ok(cn.some((x) => x.term.includes('完整版')), '中文应加中文后缀');
  assert.ok(!cn.some((x) => x.term.includes('full movie')), '中文不该加英文后缀');
});

test('近似词之间不重复', () => {
  const v = buildVariants({ title: 'Metropolis', year: 1927 }, { maxVariants: 10 });
  const terms = v.map((x) => x.term.toLowerCase());
  assert.equal(new Set(terms).size, terms.length);
});

test('空片名不产出任何词，不至于拿空串去搜', () => {
  assert.deepEqual(buildVariants({ title: '   ', year: null }), []);
  assert.deepEqual(buildVariants({ title: null, year: null }), []);
});

/* ── 预算 ─────────────────────────────────────────────────── */

test('封顶时原词一定留下，砍的是扩展词', () => {
  const many = [
    { term: 'A', kind: 'original', why: '' },
    { term: 'B', kind: 'variant', why: '' },
    { term: 'C', kind: 'variant', why: '' },
    { term: 'D', kind: 'suggested', why: '' },
  ];
  const capped = capTerms(many, 2);
  assert.equal(capped.length, 2);
  assert.equal(capped[0].term, 'A');
});

test('maxTerms 真的能把词数压下去', () => {
  const one = planFirstRound({ title: 'Night of the Living Dead', year: 1968 }, { maxTerms: 1 });
  assert.equal(one.length, 1);
  assert.equal(one[0].kind, 'original');

  const three = planFirstRound({ title: 'Night of the Living Dead', year: 1968 }, { maxTerms: 3 });
  assert.equal(three.length, 3);
});

/* ── 推荐搜索词 ───────────────────────────────────────────── */

test('能从各家 SERP 响应里捞出推荐搜索词', () => {
  assert.deepEqual(
    harvestRelated('serper', { relatedSearches: [{ query: 'notld 1968' }, { query: 'romero' }] }),
    ['notld 1968', 'romero'],
  );
  assert.deepEqual(
    harvestRelated('serper', { peopleAlsoAsk: [{ question: 'x', title: 'notld full movie' }] }),
    ['notld full movie'],
  );
  assert.deepEqual(
    harvestRelated('brave', { query: { altered: 'night of the living dead' } }),
    ['night of the living dead'],
  );
  // 结构对不上时返回空数组，不抛错也不猜
  assert.deepEqual(harvestRelated('serper', { nothing: 1 }), []);
  assert.deepEqual(harvestRelated('serper', null), []);
});

test('推荐词去重且保序', () => {
  const r = harvestRelated('serper', {
    relatedSearches: [{ query: 'a' }, { query: 'b' }, { query: 'A' }],
  });
  assert.deepEqual(r, ['a', 'b']);
});

test('跑题的推荐词被过滤掉——否则第二轮拿着无关词白烧配额', () => {
  const kept = filterSuggested(
    [
      'Night of the Living Dead 1968 full movie',   // 相关，留
      'Night of the Living Dead cast',              // 相关，留
      'best horror movies 2024',                    // 跑题，删
      'romero biography',                           // 跑题，删
    ],
    'Night of the Living Dead',
  );
  assert.deepEqual(kept, [
    'Night of the Living Dead 1968 full movie',
    'Night of the Living Dead cast',
  ]);
});

test('已经搜过的词不会再进第二轮', () => {
  const kept = filterSuggested(
    ['Metropolis 1927', 'Metropolis restored'],
    'Metropolis',
    new Set(['metropolis 1927']),
  );
  assert.deepEqual(kept, ['Metropolis restored']);
});

test('第二轮的词数受 maxSuggested 限制，且都标记为 suggested', () => {
  const second = planSecondRound(
    ['Metropolis 1927', 'Metropolis restored', 'Metropolis 4k', 'Metropolis bluray'],
    { title: 'Metropolis' },
    [{ term: 'Metropolis' }],
    { maxSuggested: 2 },
  );
  assert.equal(second.length, 2);
  for (const t of second) assert.equal(t.kind, 'suggested');
});

test('maxSuggested=0 时不产生第二轮', () => {
  const second = planSecondRound(
    ['Metropolis 1927'], { title: 'Metropolis' }, [{ term: 'Metropolis' }], { maxSuggested: 0 },
  );
  assert.deepEqual(second, []);
});
