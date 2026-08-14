/**
 * 检索词扩展。
 *
 * 一个片名只搜一次是不够的：归档站上传者起的标题五花八门——
 * 带年份的、加「full movie」的、用外文原名的、片名里冠词漏掉的。
 * 只用原词搜，这些条目根本进不了候选池。
 *
 * 两类扩展词，来源不同、可信度也不同，所以分开标注：
 *
 *   variant   —— **近似词**。按规则从原词推出来的，本地生成，不花配额。
 *   suggested —— **推荐搜索词**。搜索引擎自己返回的相关搜索
 *                （serper 的 relatedSearches / peopleAlsoAsk、brave 的 query.altered 等）。
 *                这是引擎基于真实用户行为给的，命中率往往比规则生成的高，
 *                但要先搜一轮才能拿到，所以是第二轮才用。
 *
 * 扩展词会成倍放大 SERP 请求数（词数 × 引擎数 × 页数），所以必须有预算上限，
 * 见 capTerms()。
 */

/** 中日韩字符：这类片名不适用英文的冠词/词序规则。 */
const CJK = /[㐀-䶿一-鿿぀-ヿ가-힯]/;

/** 英文里对检索没有区分度的前置冠词。 */
const LEADING_ARTICLE = /^(the|a|an)\s+/i;

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/**
 * 生成近似词。
 *
 * @param {{title: string, year?: number|null}} query
 * @param {{maxVariants?: number}} [opts]
 * @returns {Array<{term: string, kind: 'original'|'variant', why: string}>}
 */
export function buildVariants(query, opts = {}) {
  const { maxVariants = 4 } = opts;
  const title = clean(query.title);
  if (!title) return [];

  const isCjk = CJK.test(title);
  const out = [{ term: title, kind: 'original', why: '原始输入' }];
  const seen = new Set([title.toLowerCase()]);

  const push = (term, why) => {
    const t = clean(term);
    if (!t || seen.has(t.toLowerCase())) return;
    seen.add(t.toLowerCase());
    out.push({ term: t, kind: 'variant', why });
  };

  // 年份是最有效的一个：同名重拍片非常多，带上年份能直接分开
  if (query.year) push(`${title} ${query.year}`, '加年份，区分同名重拍');

  // 精确短语：挡掉把片名拆开匹配的模糊结果
  push(`"${title}"`, '精确短语，排除拆词匹配');

  // 归档站上传者常用的后缀
  if (isCjk) {
    push(`${title} 完整版`, '归档站常见标题写法');
  } else {
    push(`${title} full movie`, '归档站常见标题写法');
  }

  // 英文片名去掉前置冠词：条目标题常写成 "Night of the Living Dead, The"
  if (!isCjk && LEADING_ARTICLE.test(title)) {
    push(title.replace(LEADING_ARTICLE, ''), '去掉前置冠词');
  }

  return out.slice(0, Math.max(1, maxVariants));
}

/**
 * 从 SERP 响应里捞引擎给的推荐搜索词。
 *
 * 各家字段名不一样，能认的都认一遍；认不出来就返回空数组，不猜。
 *
 * @param {string} provider
 * @param {any} data 原始 SERP 响应
 * @returns {string[]}
 */
export function harvestRelated(provider, data) {
  const out = [];
  const take = (v) => {
    const t = clean(typeof v === 'string' ? v : (v?.query ?? v?.title ?? v?.text));
    if (t) out.push(t);
  };

  if (provider === 'brave') {
    // brave: query.altered 是纠错后的词，faq/discussions 里也带问句
    take(data?.query?.altered);
    for (const q of data?.query?.related ?? []) take(q);
  } else {
    // serper / custom: relatedSearches + peopleAlsoAsk
    for (const r of data?.relatedSearches ?? []) take(r);
    for (const r of data?.peopleAlsoAsk ?? []) take(r);
    for (const r of data?.related ?? []) take(r);
  }

  // 去重，保持顺序
  const seen = new Set();
  return out.filter((t) => {
    const k = t.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * 推荐词质量过滤。
 *
 * 引擎返回的相关搜索里混着大量与本次调研无关的东西
 *（演员八卦、周边商品、"xxx 影评"）。只保留还带着原片名的，
 * 否则第二轮会拿着一堆跑题的词去搜，白烧配额还污染候选池。
 *
 * @param {string[]} terms
 * @param {string} title
 * @param {Set<string>} already 已经搜过的词（小写）
 */
export function filterSuggested(terms, title, already = new Set()) {
  const t = clean(title).toLowerCase();
  if (!t) return [];
  // 片名里最长的那个词作为锚点；太短的词（如 "the"）不足以判断相关性
  const anchor = t.split(/\s+/).sort((a, b) => b.length - a.length)[0] || t;
  const useAnchor = anchor.length >= 4 || CJK.test(anchor);

  return terms.filter((term) => {
    const k = clean(term).toLowerCase();
    if (!k || already.has(k)) return false;
    if (k === t) return false;
    return useAnchor ? k.includes(anchor) : k.includes(t);
  });
}

/**
 * 给检索词列表封顶。
 *
 * 每多一个词就多一轮「引擎数 × 页数」的请求，SERP 服务按次计费，
 * 不封顶一次检索能把配额打穿。原词永远保留在第一位。
 *
 * @param {Array<{term: string, kind: string, why: string}>} terms
 * @param {number} max
 */
export function capTerms(terms, max) {
  const cap = Math.max(1, max);
  if (terms.length <= cap) return terms;
  const original = terms.filter((t) => t.kind === 'original');
  const rest = terms.filter((t) => t.kind !== 'original');
  return [...original, ...rest].slice(0, cap);
}

/**
 * 一次性算出第一轮要搜的词。
 *
 * @param {{title: string, year?: number|null}} query
 * @param {{maxVariants?: number, maxTerms?: number}} [opts]
 */
export function planFirstRound(query, opts = {}) {
  const variants = buildVariants(query, { maxVariants: opts.maxVariants ?? 4 });
  return capTerms(variants, opts.maxTerms ?? 4);
}

/**
 * 根据第一轮拿到的推荐词，算出第二轮要搜的词。
 *
 * @param {string[]} rawSuggested 各引擎返回的推荐词汇总
 * @param {{title: string}} query
 * @param {Array<{term: string}>} firstRound 第一轮已搜过的
 * @param {{maxSuggested?: number}} [opts]
 * @returns {Array<{term: string, kind: 'suggested', why: string}>}
 */
export function planSecondRound(rawSuggested, query, firstRound, opts = {}) {
  const already = new Set(firstRound.map((t) => clean(t.term).toLowerCase()));
  const keep = filterSuggested(rawSuggested, query.title, already);
  return keep.slice(0, Math.max(0, opts.maxSuggested ?? 3)).map((term) => ({
    term,
    kind: 'suggested',
    why: '搜索引擎返回的相关搜索',
  }));
}
