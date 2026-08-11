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

/** 一眼可判定"不是正片"的词。命中即降级，不参与 Top5。 */
const NON_FEATURE_HINTS = [
  'trailer', 'teaser', 'preview', 'clip', 'excerpt', 'behind the scenes',
  'making of', 'interview', 'commentary', 'review', 'reaction',
  'soundtrack', 'ost', 'sample', 'promo', 'outtake', 'blooper',
  '预告', '片段', '花絮', '解说', '影评', '幕后', '访谈', '主题曲',
];

const CJK_RE = /[㐀-䶿一-鿿぀-ヿ가-힯]/;

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

/** Dice 系数（对集合大小差异比 Jaccard 更宽容，适合"标题 vs 长条目名"）。 */
function diceCoefficient(a, b) {
  if (!a.length || !b.length) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let overlap = 0;
  for (const t of setA) if (setB.has(t)) overlap += 1;
  return (2 * overlap) / (setA.size + setB.size);
}

/** 编辑距离比值，处理拼写差异与转写差异（Metropolis / Metropolís）。 */
function levenshteinRatio(a, b) {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
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
  return 1 - prev[n] / Math.max(m, n);
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

  // 子串包含：查询是候选的一部分，且查询本身有足够信息量。
  if (q.length >= 4 && c.includes(q)) {
    const coverage = q.length / c.length;
    return Math.max(0.86, Math.min(0.97, 0.7 + coverage * 0.3));
  }

  // 所有查询词都出现在候选里（顺序无关）——同样是强信号。
  if (qTokens.length > 0 && qTokens.every((t) => cTokens.includes(t))) {
    return Math.max(0.84, diceCoefficient(qTokens, cTokens));
  }

  return Math.max(diceCoefficient(qTokens, cTokens), levenshteinRatio(q, c));
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
 * @param {string} text
 * @returns {string|null} 命中的提示词，未命中返回 null
 */
export function nonFeatureHint(text) {
  if (!text) return null;
  const lower = String(text).toLowerCase();
  for (const hint of NON_FEATURE_HINTS) {
    if (lower.includes(hint)) return hint;
  }
  return null;
}

/**
 * 从自由文本中抽取查询里的年份，例如 "教父 1972" / "Metropolis (1927)"。
 * @param {string} q
 * @returns {{title: string, year: number|null}}
 */
export function parseQuery(q) {
  const raw = String(q || '').trim();
  const m = raw.match(/\(?\b((?:18|19|20)\d{2})\b\)?\s*$/);
  if (!m) return { title: raw, year: null };
  return {
    title: raw.slice(0, m.index).trim() || raw,
    year: Number(m[1]),
  };
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
