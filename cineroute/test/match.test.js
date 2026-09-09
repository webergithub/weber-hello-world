import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeTitle, titleSimilarity, yearCompatible, nonFeatureHint, parseQuery, titleKey,
  titleMatches, scriptOf, comparableTitles,
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
  assert.deepEqual(parseQuery('Metropolis 1927'), { title: 'Metropolis', year: 1927, aliases: [] });
  assert.deepEqual(parseQuery('Blade Runner (1982)'), { title: 'Blade Runner', year: 1982, aliases: [] });
  assert.deepEqual(parseQuery('Casablanca'), { title: 'Casablanca', year: null, aliases: [] });
});

test('titleKey 让不同写法的同一部片合并到同一个键', () => {
  assert.equal(titleKey('The Metropolis', 1927), titleKey('Metropolis', 1927));
});

test('中文片名差一个字就是两部片：不能用编辑距离兜底', () => {
  // 实跑「我不是酒神」「阿凡达」时抓到的：编辑距离在拉丁文里是对的
  // （Metropolis / Metropolís 差一个字母，是转写差异），但一个汉字不是
  // 一个字母，是一个词。「我不是药神」和「我不是酒神」也差一个字，
  // 却是两部完全不同的电影。
  //
  // 当时的分数是 0.80，比正常该放行的「猫和老鼠」vs「貓和老鼠」(0.75)
  // 还高 —— 两边区间完全重叠，**调门槛救不回来**，只能不让编辑距离
  // 参与中日韩的判定。
  const GATE = 0.55;   // 与 IA / 引擎两个适配器的准入门槛一致

  const mustBlock = [
    ['我不是酒神', '我不是药神'],
    ['阿凡达', '阿凡提'],
    ['阿凡达', 'Avatar: The Last Airbender - Book One'],
    ['欢迎来到龙餐厅', 'The Dragon Restaurant — regional cooking show'],
  ];
  for (const [q, c] of mustBlock) {
    const s = titleSimilarity(q, c);
    assert.ok(s < GATE, `「${q}」vs「${c}」得了 ${s.toFixed(2)}，会被当成同一部片`);
  }

  const mustPass = [
    ['阿凡达', '阿凡达 2009 官方预告片 中文字幕'],
    ['我不是药神', '我不是药神 片段合集'],
    ['猫和老鼠', '貓和老鼠'],                    // 繁简变体
    ['欢迎来到龙餐厅', '欢迎来到龙虾餐厅'],       // 译名变体
  ];
  for (const [q, c] of mustPass) {
    const s = titleSimilarity(q, c);
    assert.ok(s >= GATE, `「${q}」vs「${c}」只有 ${s.toFixed(2)}，正常的同名变体被误伤了`);
  }

  // 拉丁文那边不受影响：转写差异还得靠编辑距离救回来
  assert.equal(titleSimilarity('Metropolis', 'Metropolís'), 1);
});

test('跨语种：相似度 0 不等于"不是同一部片"', () => {
  // 这是三个中文片名"检索结果为 0"的头号原因。
  //
  // 「阿凡达」和「Avatar」得 0.00，不是因为它们是两部片（恰恰是同一部），
  // 是因为字符串距离这把尺子量不了跨语种。把这个 0 当成"片名对不上"，
  // 后果有两层：跨语种的正确结果被全部挡掉，而且给出的理由是错的——
  // 这个工具是拿来取证的，说错理由比没有理由更糟。
  const r = titleMatches('阿凡达', 'Avatar (2009)');
  assert.equal(r.verdict, 'incomparable', '应当判成"没法比"，不是"不一样"');
  assert.equal(r.ok, false, '没法比时不能放行——那等于不设防');
  assert.match(r.reason, /跨语种/);
  assert.match(r.reason, /English Title/, '理由里要告诉用户怎么办');

  // 同语种、名字确实不一样的，仍然是 mismatch，不能被这条新逻辑放跑
  assert.equal(titleMatches('我不是酒神', '我不是药神').verdict, 'mismatch');
  assert.equal(titleMatches('阿凡达', '阿凡提').verdict, 'mismatch');
});

test('给了别名就认得出来，且别名不会把另一部片带进来', () => {
  const q = parseQuery('阿凡达 / Avatar');
  assert.deepEqual(q.aliases, ['Avatar']);

  const hit = titleMatches(q, 'Avatar (2009) 1080p');
  assert.equal(hit.ok, true);
  assert.equal(hit.matched, 'Avatar', '要说清楚是靠哪个名字对上的');
  assert.match(hit.reason, /按别名/);

  // 关键：别名是「Avatar」，而《降世神通》的英文名以 Avatar 开头。
  // 光看"是不是子串"会把它放进来——多出来的 last/airbender/book/one
  // 是实词，不是年份画质那类限定词，所以这是另一部作品。
  assert.equal(
    titleMatches(q, 'Avatar: The Last Airbender - Book One').ok, false,
    '别名不能把《降世神通》一起带进来',
  );
  // 而"片名 + 限定词"那种必须照旧放行
  assert.equal(titleMatches(q, 'Avatar 2009 1080p bluray').ok, true);
});

test('拉丁文的编辑距离要有上限：差一两个字符是转写，差三个是另一个词', () => {
  // Metropolis / Metropolitan 差 3 个字符，比值却有 0.75，看着像"就差一点点"
  assert.equal(titleMatches('Metropolis', 'Metropolitan').ok, false);
  // 转写差异（差 1~2 个字符）仍要救得回来
  assert.equal(titleMatches('Battleship Potemkin', 'Battleship Potyomkin').ok, true);
  assert.equal(titleSimilarity('Metropolis', 'Metropolís'), 1, '去掉重音后本来就是同一个串');
});
