/**
 * 片名归一化与相似度。
 *
 * 聚合检索最大的失真来源不是"找不到"，而是"找错了还排在前面"：
 * 搜《大都会》可能返回一堆同名纪录片、修复花絮、影评播客。
 * 所以匹配度在本系统里**不是打分维度，而是准入门槛**——
 * 匹配不上的候选在进入打分环节之前就被丢弃。
 */

/** 会干扰匹配、但不携带作品身份的修饰词。 */
const NOISE_TOKENS = new Set([
  'the', 'a', 'an', 'of', 'and', 'or', 'de', 'la', 'le', 'el',
  'movie', 'film', 'video', 'full', 'complete', 'hd', 'hq', 'remastered',
  'restored', 'colorized', 'trailer', 'teaser', 'clip', 'excerpt', 'preview',
  'official', 'part', 'reel', 'edition', 'cut', 'version',
]);

/**
 * 一眼可判定"不是正片"的词。命中即降级，不参与 Top5。
 *
 * 拉丁文的部分必须**按整词匹配**。原来是裸的 includes()，于是
 * `Ghostbusters` 里的 ost、`Eclipse` 里的 clip、`Lost in Translation`
 * 里的 ost 全部误命中——后果不轻：完整度维度直接归零并标记为可疑，
 * 等于把一部正片踢出推荐位。
 */
const NON_FEATURE_HINTS_LATIN = [
  'trailer', 'teaser', 'preview', 'clip', 'clips', 'excerpt', 'behind the scenes',
  'making of', 'interview', 'commentary', 'review', 'reaction',
  'soundtrack', 'ost', 'sample', 'promo', 'outtake', 'blooper',
];

/** 中文没有词边界，只能按子串匹配——这几个词也确实不会嵌在别的词里。 */
const NON_FEATURE_HINTS_CJK = [
  '预告', '片段', '花絮', '解说', '影评', '幕后', '访谈', '主题曲',
];

/** 供外部查看的完整表（顺序即匹配顺序）。 */
export const NON_FEATURE_HINTS = [...NON_FEATURE_HINTS_LATIN, ...NON_FEATURE_HINTS_CJK];

/** 整词匹配：前后都不能紧邻字母或数字。 */
const LATIN_HINT_RE = NON_FEATURE_HINTS_LATIN.map((h) => [
  h,
  new RegExp(`(?<![a-z0-9])${h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9])`, 'i'),
]);

const CJK_RE = /[㐀-䶿一-鿿぀-ヿ가-힯]/;

/**
 * 片名用的是哪套文字。
 *
 * 存在的理由：**相似度为 0 有两种完全不同的含义。**
 * 「我不是酒神」和「我不是药神」都是中文、差一个字，0.50 是在说"这两个
 * 名字不一样"——这是证据。而「阿凡达」和「Avatar」得 0.00，不是因为它们
 * 是两部片（恰恰是同一部），是因为**字符串距离这把尺子量不了跨语种**。
 *
 * 把这两件事混成一个数字，就会一边正确地挡住《我不是药神》，一边
 * 把《Avatar》也一起挡掉，而且给出的理由是"片名对不上"——这句话是错的。
 */
export function scriptOf(text) {
  const s = String(text || '');
  const cjk = CJK_RE.test(s);
  const latin = /[A-Za-z]/.test(s);
  const cyr = /[\u0400-\u04FF]/.test(s);
  const kinds = [cjk && 'cjk', latin && 'latin', cyr && 'cyrillic'].filter(Boolean);
  if (kinds.length === 0) return 'other';
  return kinds.length > 1 ? 'mixed' : kinds[0];
}

/**
 * 这两个片名能不能用字符串距离比。
 *
 * 两边各用一套完全不同的文字时不能——量出来的 0 不是"不像"，是"没法量"。
 * 只要有一边是混排（「阿凡达 Avatar」），就有共同的字符可比，算能比。
 */
export function comparableTitles(a, b) {
  const sa = scriptOf(a);
  const sb = scriptOf(b);
  if (sa === 'other' || sb === 'other') return true;   // 纯数字/符号，交给相似度自己判
  if (sa === 'mixed' || sb === 'mixed') return true;
  return sa === sb;
}

/**
 * 归一化片名：小写、去括注年份、去标点、压空格。
 * @param {string} raw
 * @returns {string}
 */
export function normalizeTitle(raw) {
  if (!raw) return '';
  return String(raw)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')          // 去重音符
    .replace(/\((?:19|20)\d{2}\)/g, ' ')      // 去 (1968) 这类年份括注
    .replace(/\[[^\]]*\]/g, ' ')              // 去 [restored] 这类方括注
    .replace(/[_\-–—.]+/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')        // 保留字母数字与空白
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 切词。中日韩没有空格分词，退化为字符 bigram，
 * 这样《大都会》/《大都会 1927》仍能得到高相似度。
 * @param {string} normalized
 * @returns {string[]}
 */
export function tokenize(normalized) {
  if (!normalized) return [];
  if (CJK_RE.test(normalized)) {
    const chars = normalized.replace(/\s+/g, '');
    if (chars.length <= 1) return [chars];
    const grams = [];
    for (let i = 0; i < chars.length - 1; i += 1) grams.push(chars.slice(i, i + 2));
    return grams;
  }
  return normalized.split(' ').filter((t) => t && !NOISE_TOKENS.has(t));
}

/**
 * 这个词是不是"限定词"——它出现与否不改变作品身份。
 *
 * 年份、清晰度、画质标记、版本标记都属于这一类。NOISE_TOKENS 里那批
 * （the / full / restored…）在 tokenize 时就已经被剔掉了，这里补的是
 * 那些带数字、以及这个领域特有的说法。
 */
function isQualifier(token) {
  const t = String(token || '').toLowerCase();
  if (/^\d{2,4}$/.test(t)) return true;              // 年份、集数
  if (/^\d{3,4}[pi]$/.test(t)) return true;          // 1080p / 720p / 480i
  return /^(4k|8k|uhd|hdr|bluray|bdrip|dvdrip|webrip|web|remux|rip|feature|features|extended|uncut|unrated|director|directors|theatrical|scan|print|copy|reissue|anniversary|mp4|mkv|avi|ogv|webm|x264|x265|h264|h265|aac|mp3)$/.test(t);
}

/** Dice 系数（对集合大小差异比 Jaccard 更宽容，适合"标题 vs 长条目名"）。 */
function diceCoefficient(a, b) {
  if (!a.length || !b.length) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let overlap = 0;
  for (const t of setA) if (setB.has(t)) overlap += 1;
  return (2 * overlap) / (setA.size + setB.size);
}

/** 编辑距离本身。比值会被长度稀释，判"是不是转写差异"要看绝对值。 */
function editDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let cur = new Array(n + 1);
  for (let i = 1; i <= m; i += 1) {
    cur[0] = i;
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

/**
 * 编辑距离比值，处理拼写差异与转写差异（Potemkin / Potyomkin）。
 *
 * **只在绝对距离很小时才认。** 比值会被长度稀释：Metropolis 和
 * Metropolitan 差 3 个字符，比值却有 0.75，看着像"就差一点点"，
 * 实际是两个不相干的词。转写差异和手误通常就差一两个字符，
 * 卡在这儿既救得回该救的，也不会把另一个词放进来。
 */
const MAX_TRANSLITERATION_EDITS = 2;
function levenshteinRatio(a, b) {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const d = editDistance(a, b);
  if (d > MAX_TRANSLITERATION_EDITS) return 0;
  return 1 - d / Math.max(a.length, b.length);
}

/**
 * 综合相似度 ∈ [0,1]。
 * 取"词集相似"与"字面相似"的较大值：前者容忍词序与冗余词，
 * 后者容忍拼写差异，两者互补。
 *
 * 额外规则：查询词完整出现在候选标题里（子串包含）直接给高分，
 * 因为归档站的条目名常常是「Night of the Living Dead 1968 full feature」这种长串。
 *
 * @param {string} query
 * @param {string} candidate
 * @returns {number}
 */
export function titleSimilarity(query, candidate) {
  const q = normalizeTitle(query);
  const c = normalizeTitle(candidate);
  if (!q || !c) return 0;
  if (q === c) return 1;

  const qTokens = tokenize(q);
  const cTokens = tokenize(c);

  // 子串包含：查询完整出现在候选里。
  //
  // 但**不能只看"是不是子串"**。归档站的条目名确实常常是
  // 「Night of the Living Dead 1968 full feature」这种"片名 + 一堆限定词"，
  // 那种该给高分；可「Avatar」也是「Avatar: The Last Airbender」的子串，
  // 那是另一部片。以前这里给 0.86 的下限，两种情况一视同仁——
  // 加上英文别名之后，搜《阿凡达》立刻又把《降世神通》放了进来。
  //
  // 分辨的办法是**看多出来的是什么词**：全是年份、清晰度、"完整版"这类
  // 限定词，就还是同一部片；多出来的是实词（last / airbender / book），
  // 那就是另一部作品，让它落到下面按重合度算。
  if (q.length >= 4 && c.includes(q)) {
    // 只对拉丁文这么判。中日韩切的是字符二元组不是词，
    // 「大都会 1927 修复版」会切出「会1」「7修」这类跨界二元组，
    // 拿它问"是不是限定词"毫无意义——问了就会把正常的同名变体全误伤掉。
    const wordy = !CJK_RE.test(c);
    const extra = wordy ? cTokens.filter((t) => !qTokens.includes(t)) : [];
    if (!wordy || extra.every(isQualifier)) {
      const coverage = q.length / c.length;
      return Math.max(0.86, Math.min(0.97, 0.7 + coverage * 0.3));
    }
  }

  // 所有查询词都出现在候选里（顺序无关）——同样是强信号，
  // 但和上面的子串分支一样，**得看多出来的是什么词**。
  // 「Avatar」的词全在「Avatar: The Last Airbender」里，多出来的却是实词；
  // 「Night of the Living Dead」vs「…: Reanimated」也是这样。
  // 不加这道判断，这条分支会把上面那道刚补好的口子原样再开一遍。
  if (qTokens.length > 0 && qTokens.every((t) => cTokens.includes(t))) {
    const wordy = !CJK_RE.test(c);
    const extra = wordy ? cTokens.filter((t) => !qTokens.includes(t)) : [];
    if (!wordy || extra.every(isQualifier)) return Math.max(0.84, diceCoefficient(qTokens, cTokens));
  }

  const dice = diceCoefficient(qTokens, cTokens);

  // **中日韩片名不能用编辑距离兜底。**
  //
  // 编辑距离在拉丁文里是对的：Metropolis / Metropolís 差一个字母，是转写差异，
  // 同一部片。但一个汉字不是一个字母，是一个词——「我不是药神」和「我不是酒神」
  // 也差一个字，却是两部完全不同的电影；「阿凡达」和「阿凡提」同理。
  //
  // 实测这条兜底把这几对的分数抬到了 0.67~0.80，而正常该放行的
  // （「猫和老鼠」vs「貓和老鼠」= 0.75、「欢迎来到龙餐厅」vs
  // 「欢迎来到龙虾餐厅」= 0.88）也在这个区间里——**两边完全重叠，
  // 调门槛救不回来**，只能不让编辑距离参与中日韩的判定。
  //
  // 去掉之后靠二元组 Dice：换掉一个字会同时打掉两个二元组，短片名上
  // 掉得很明显（药神/酒神 → 0.50），而"片名 + 后缀"那种走上面的子串分支，
  // 根本到不了这里。
  //
  // 仍有拦不住的：同长度、差两个字的续集名（「哪吒之魔童降世」vs
  // 「哪吒之魔童闹海」= 0.67）还是会过。要真分开得靠繁简归一 + 作品库比对，
  // 不是一个字符串距离能解决的，这里不假装解决了。
  if (CJK_RE.test(q) || CJK_RE.test(c)) return dice;

  return Math.max(dice, levenshteinRatio(q, c));
}

/**
 * 年份是否可接受。归档站的年份字段常常是入库年而非上映年，
 * 所以给 ±2 年容差；候选没有年份时不作否决（返回 true）。
 *
 * @param {number|null|undefined} queryYear
 * @param {number|null|undefined} candidateYear
 * @param {number} [tolerance=2]
 */
export function yearCompatible(queryYear, candidateYear, tolerance = 2) {
  if (!queryYear || !candidateYear) return true;
  return Math.abs(Number(queryYear) - Number(candidateYear)) <= tolerance;
}

/**
 * 是否疑似"非正片"（预告/花絮/解说）。
 *
 * 传进来的多半是文件名，所以先把 `_` `-` `.` 当成分词符换成空格：
 * `notld_behind_the_scenes.mp4` 与 `notld behind the scenes.mp4`
 * 说的是同一件事，不该一个判得出一个判不出。
 *
 * @param {string} text
 * @returns {string|null} 命中的提示词，未命中返回 null
 */
export function nonFeatureHint(text) {
  if (!text) return null;
  const raw = String(text);
  const spaced = raw.replace(/[_\-–—.]+/g, ' ');

  for (const [hint, re] of LATIN_HINT_RE) {
    if (re.test(spaced)) return hint;
  }
  for (const hint of NON_FEATURE_HINTS_CJK) {
    if (raw.includes(hint)) return hint;
  }
  return null;
}

/**
 * 从自由文本中抽取查询里的年份，例如 "教父 1972" / "Metropolis (1927)"。
 *
 * 结尾的四位数不一定是年份，很多时候是片名的一部分：
 * 《唐探1900》《Blade Runner 2049》《2012》《1917》。剥错了就是拿着
 * 半个片名去搜，搜出来的东西全不对。所以加了两道闸：
 *
 *  1) **年份前面必须有分隔符**（空格或左括号）。`唐探1900` 里的 1900
 *     紧贴汉字，是片名的一部分；`唐探1900 2025` 里的 2025 前面有空格，
 *     才是用户手输的年份。
 *  2) **不接受太靠后的年份**。2049 年的电影还不存在，出现在片名结尾
 *     只可能是片名自带的。上限给到今年 +2，留出已定档新片的余量。
 *
 * 整串就是一个年份时（《2012》《1917》）两头落空，此时保留整串作片名，
 * 同时把年份也报出来——用户输 "2012" 既可能想搜那部片，也可能想搜那一年。
 *
 * @param {string} q
 * @param {{maxYear?: number}} [opts] maxYear 可注入，方便测试不受当前日期影响
 * @returns {{title: string, year: number|null}}
 */
export function parseQuery(q, opts = {}) {
  const rawInput = String(q || '').trim();
  const maxYear = opts.maxYear ?? new Date().getFullYear() + 2;

  // 「阿凡达 / Avatar」「阿凡达 | Avatar」——用户自己把两个名字一起给进来。
  //
  // 这是跨语种检索唯一不依赖任何外部服务的解法：中文片在 archive.org 上
  // 十有八九挂的是英文名，光拿中文名去搜什么都搜不到，而字符串距离又
  // 跨不了语种。让用户能一次把两个名字都给出来，成本是一个分隔符。
  const parts = rawInput.split(/\s*[/|｜]\s*/).map((x) => x.trim()).filter(Boolean);
  const raw = parts[0] || rawInput;
  const aliases = parts.slice(1);

  // 整串就是一个年份
  if (/^\(?((?:18|19|20)\d{2})\)?$/.test(raw)) {
    return { title: raw, year: Number(raw.replace(/[()]/g, '')), aliases };
  }

  // 结尾年份：前面必须是空白或左括号
  const m = raw.match(/(?:^|[\s(])\(?((?:18|19|20)\d{2})\)?\s*$/);
  if (!m) return { title: raw, year: null, aliases };

  const year = Number(m[1]);
  // 未来太远的不是上映年份，是片名的一部分（Blade Runner 2049）
  if (year > maxYear) return { title: raw, year: null, aliases };

  const title = raw.slice(0, m.index).trim();
  return title ? { title, year, aliases } : { title: raw, year, aliases };
}

/**
 * 生成作品去重键：不同上游对同一部片会给出不同写法，
 * 用归一化标题 + 年份作为合并键。
 * @param {string} title
 * @param {number|null} year
 */
export function titleKey(title, year) {
  const norm = tokenize(normalizeTitle(title)).join(' ') || normalizeTitle(title);
  return year ? `${norm}::${year}` : norm;
}

/**
 * 片名准入判定——**三种结局，不是两种**。
 *
 * 这是全系统唯一该用的那道闸。以前各适配器各写各的
 * `titleSimilarity(...) >= 0.55`，问题不在重复，在于那个写法只有
 * "过 / 不过"两种结局，把两件完全不同的事压成了一个：
 *
 *   通过        —— 名字对得上
 *   挡下        —— 名字**确实不一样**（《我不是药神》≠《我不是酒神》）
 *   **判不了**  —— 两边不是同一套文字，这把尺子量不了
 *                 （「阿凡达」vs「Avatar」得 0.00，但它们是同一部片）
 *
 * 第三种以前被当成第二种，后果有两层：一是跨语种的正确结果被挡光，
 * 二是给出的理由——"片名对不上"——是**错的**。这个工具是拿来取证的，
 * 说错理由比没有理由更糟。
 *
 * 别名一并比：查询自带的（「阿凡达 / Avatar」）、以及 TMDB 回流的原名。
 * 只要有一个对得上就算对得上，取最高分。
 *
 * @param {{title: string, aliases?: string[]}|string} query
 * @param {string} candidate
 * @param {{minSimilarity?: number, aliases?: string[]}} [opts]
 * @returns {{ok: boolean, verdict: 'match'|'mismatch'|'incomparable',
 *            similarity: number, matched: string|null, reason: string}}
 */
export function titleMatches(query, candidate, opts = {}) {
  const min = opts.minSimilarity ?? 0.55;
  const title = typeof query === 'string' ? query : (query?.title ?? '');
  const names = [title, ...(typeof query === 'string' ? [] : (query?.aliases ?? [])), ...(opts.aliases ?? [])]
    .map((x) => String(x || '').trim())
    .filter(Boolean);

  let best = { similarity: 0, matched: null };
  let anyComparable = false;
  for (const name of names) {
    if (!comparableTitles(name, candidate)) continue;
    anyComparable = true;
    const sim = titleSimilarity(name, candidate);
    if (sim > best.similarity) best = { similarity: sim, matched: name };
  }

  // 一个名字都没法跟候选比 —— 这不是"不像"，是"量不了"
  if (!anyComparable) {
    return {
      ok: false,
      verdict: 'incomparable',
      similarity: 0,
      matched: null,
      reason: `跨语种，片名没法直接比对（${scriptOf(title)} vs ${scriptOf(candidate)}）：`
        + `《${candidate}》。如果这就是你要找的片子，把两个名字一起给我——`
        + `检索框里写「${title} / English Title」`,
    };
  }

  if (best.similarity >= min) {
    return {
      ok: true,
      verdict: 'match',
      similarity: best.similarity,
      matched: best.matched,
      reason: best.matched === title
        ? `片名对得上（相似度 ${best.similarity.toFixed(2)}）`
        : `按别名「${best.matched}」对上（相似度 ${best.similarity.toFixed(2)}）`,
    };
  }

  return {
    ok: false,
    verdict: 'mismatch',
    similarity: best.similarity,
    matched: null,
    reason: `片名对不上：《${candidate}》与「${title}」相似度 `
      + `${best.similarity.toFixed(2)}，低于门槛 ${min}`,
  };
}
