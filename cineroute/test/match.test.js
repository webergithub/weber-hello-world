import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeTitle, titleSimilarity, yearCompatible, nonFeatureHint, parseQuery, titleKey,
} from '../src/core/match.js';

test('normalizeTitle 去掉括注年份、方括注与标点', () => {
  assert.equal(normalizeTitle('Metropolis (1927)'), 'metropolis');
  assert.equal(normalizeTitle('Night of the Living Dead [restored]'), 'night of the living dead');
  assert.equal(normalizeTitle('A.I. — Artificial_Intelligence'), 'a i artificial intelligence');
});

test('titleSimilarity：完全一致为 1', () => {
  assert.equal(titleSimilarity('Metropolis', 'metropolis'), 1);
});

test('titleSimilarity：归档站长条目名仍能匹配上查询', () => {
  const s = titleSimilarity(
    'Night of the Living Dead',
    'Night of the Living Dead (1968) — Restored Transfer',
  );
  assert.ok(s >= 0.8, `期望 ≥0.8，实际 ${s}`);
});

test('titleSimilarity：无关片名得分低，能被准入门槛挡住', () => {
  const s = titleSimilarity('Night of the Living Dead', 'The Sound of Music');
  assert.ok(s < 0.4, `期望 <0.4，实际 ${s}`);
});

test('titleSimilarity：中文按字符 bigram 切分，仍可匹配', () => {
  const s = titleSimilarity('大都会', '大都会 1927 修复版');
  assert.ok(s >= 0.7, `期望 ≥0.7，实际 ${s}`);
});

test('yearCompatible：±2 年容差，缺年份不否决', () => {
  assert.equal(yearCompatible(1968, 1968), true);
  assert.equal(yearCompatible(1968, 1970), true);
  assert.equal(yearCompatible(1968, 1975), false);
  assert.equal(yearCompatible(1968, null), true);
  assert.equal(yearCompatible(null, 1999), true);
});

test('nonFeatureHint 识别预告/花絮（中英文）', () => {
  assert.equal(nonFeatureHint('Movie Trailer HD'), 'trailer');
  assert.equal(nonFeatureHint('Behind the Scenes Featurette'), 'behind the scenes');
  assert.equal(nonFeatureHint('活死人之夜 预告'), '预告');
  assert.equal(nonFeatureHint('Night of the Living Dead'), null);
});

test('parseQuery 抽出结尾年份', () => {
  assert.deepEqual(parseQuery('Metropolis 1927'), { title: 'Metropolis', year: 1927 });
  assert.deepEqual(parseQuery('Blade Runner (1982)'), { title: 'Blade Runner', year: 1982 });
  assert.deepEqual(parseQuery('Casablanca'), { title: 'Casablanca', year: null });
});

test('titleKey 让不同写法的同一部片合并到同一个键', () => {
  assert.equal(titleKey('The Metropolis', 1927), titleKey('Metropolis', 1927));
});
