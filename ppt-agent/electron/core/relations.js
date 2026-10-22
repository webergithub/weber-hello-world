'use strict';
// 页面级标签与页面关联：
// 1) 每页（PPT 页 / Word 章节）提取关键词与领域概念，按全库 TF-IDF 选出 8 个页面标签；
// 2) 按标签倒排索引找候选页，再用内容向量余弦 + 标签重叠 + 标题相同打分，
//    为每页保留最相似的 PPT 页（及开启 Word 时相关的 Word 章节 / PPT 页）。
const glossary = require('./glossary');
const { keywordCandidates, HAS_CJK } = require('./textproc');
const { cosine } = require('./vectors');
const { normSlideTitle } = require('./similarity');
const { GENERIC } = require('./tagger');

const PAGE_TAGS = 8;
const isDoc = (s) => s.kind === 'word' || s.kind === 'pdf';

/** 单页词项权重（标题 ×2、正文 ×1、讲解词 ×0.5）与命中的领域概念 */
function slideKeywords(s) {
  const terms = {};
  const add = (text, w) => { for (const k of keywordCandidates(text)) terms[k] = (terms[k] || 0) + w; };
  add(s.title, 2); add(s.text, 1); add(s.notes, 0.5);
  const concepts = {};
  for (const [t, w] of [[s.title, 2], [s.text, 1], [s.notes, 0.5]]) {
    for (const f of glossary.findConcepts(t || '')) if (f.concept.cat !== '通用办公') concepts[f.concept.id] = (concepts[f.concept.id] || 0) + f.count * w;
  }
  const top = Object.entries(terms).filter(([t]) => !GENERIC.has(t) && !/^\d+(\.\d+)?%?$/.test(t)).sort((a, b) => b[1] - a[1]).slice(0, 40);
  return { t: Object.fromEntries(top.map(([k, v]) => [k, Math.round(v * 10) / 10])), c: concepts };
}

const covered = (t, chosen) => chosen.some((c) => c.toLowerCase() === t.toLowerCase() || (t.length >= 2 && c.toLowerCase().includes(t.toLowerCase())));

/** 由词项权重与全库页面文档频率选出页面标签 */
function pageTags(kw, df, N) {
  const chosen = [];
  const cs = Object.entries(kw.c || {}).map(([id, w]) => ({ c: glossary.concepts[id], w })).filter((x) => x.c).sort((a, b) => b.w - a.w);
  const conceptWords = new Set();
  for (const { c } of cs) for (const w of [...c.zh, ...c.en]) conceptWords.add(w.toLowerCase());
  for (const { c } of cs.slice(0, 3)) if (!covered(c.label, chosen)) chosen.push(c.label);
  const scored = Object.entries(kw.t || {}).filter(([t]) => !conceptWords.has(t.toLowerCase()))
    .map(([t, tf]) => ({ t, s: (1 + Math.log(tf)) * Math.log(1 + N / (1 + (df.get(t) || 0))) * (HAS_CJK.test(t) ? 1 + Math.min(t.length, 4) * 0.1 : 1) }))
    .sort((a, b) => b.s - a.s);
  for (const { t } of scored) { if (chosen.length >= PAGE_TAGS) break; if (!covered(t, chosen)) chosen.push(t); }
  for (const { c } of cs.slice(3)) { if (chosen.length >= PAGE_TAGS) break; if (!covered(c.label, chosen)) chosen.push(c.label); }
  return chosen;
}

/**
 * 计算页面关联。slides: [{ id, file_id, kind, theme, title, vec, emb, tags }]
 * withWord：同时关联 Word 章节与 PPT 页（设置中同时选择了 PPT 与 Word）
 * 返回 [{ a, b, score, kind: 'ppt' | 'word'（b 的类型）, reasons }]，a 为推荐给谁
 */
function computeLinks(slides, { withWord = false, pptK = 8, wordK = 6, minScore = 0.32, preK = 60 } = {}) {
  const N = slides.length;
  const tagIdx = new Map();
  const titleIdx = new Map();
  slides.forEach((s, i) => {
    s._tags = (s.tags || []).map((t) => t.toLowerCase());
    for (const t of s._tags) { if (!tagIdx.has(t)) tagIdx.set(t, []); tagIdx.get(t).push(i); }
    s._nt = normSlideTitle(s.title);
    if (s._nt.length >= 4) { if (!titleIdx.has(s._nt)) titleIdx.set(s._nt, []); titleIdx.get(s._nt).push(i); }
  });
  const cap = Math.max(300, Math.round(N * 0.05));
  const idf = (t) => Math.log(1 + N / (tagIdx.get(t).length));
  const out = [];
  for (let i = 0; i < N; i++) {
    const s = slides[i];
    // Word / PDF 都算“文档”：文档之间不互相推荐，文档 ↔ PPT 仅在同时启用两类时关联
    const sDoc = isDoc(s);
    const allow = (o) => o.file_id !== s.file_id && (sDoc ? withWord && !isDoc(o) : !isDoc(o) || withWord);
    const cand = new Map();
    for (const t of s._tags) {
      const post = tagIdx.get(t);
      if (post.length > cap) continue;
      const w = idf(t);
      for (const j of post) if (j !== i && allow(slides[j])) cand.set(j, (cand.get(j) || 0) + w);
    }
    if (s._nt.length >= 4) for (const j of titleIdx.get(s._nt) || []) if (j !== i && allow(slides[j])) cand.set(j, (cand.get(j) || 0) + 3);
    const pre = [...cand.entries()].sort((a, b) => b[1] - a[1]).slice(0, preK);
    const scored = [];
    for (const [j] of pre) {
      const o = slides[j];
      const shared = s._tags.filter((t) => o._tags.includes(t));
      const overlap = shared.length / Math.max(1, Math.min(s._tags.length, o._tags.length));
      const cos = s.emb && o.emb ? cosine(s.emb, o.emb) : cosine(s.vec, o.vec);
      const sameTitle = s._nt.length >= 4 && s._nt === o._nt;
      const score = Math.min(1, 0.55 * Math.max(0, cos) + 0.45 * overlap + (sameTitle ? 0.1 : 0));
      if (score < minScore) continue;
      const reasons = [];
      if (sameTitle) reasons.push('标题相同');
      if (!isDoc(o) && !sDoc && o.theme !== s.theme && cos >= 0.8) reasons.push(o.theme === 'dark' ? '黑底版本' : '白底版本');
      const origTags = (o.tags || []).filter((t) => shared.includes(t.toLowerCase()));
      reasons.push(...origTags.slice(0, 4).map((t) => `#${t}`));
      if (cos >= 0.75 && !sameTitle) reasons.push('内容相近');
      scored.push({ a: s.id, b: o.id, score: Math.round(score * 1000) / 1000, kind: isDoc(o) ? 'word' : 'ppt', reasons });
    }
    scored.sort((x, y) => y.score - x.score);
    out.push(...scored.filter((x) => x.kind === 'ppt').slice(0, pptK), ...scored.filter((x) => x.kind === 'word').slice(0, wordK));
  }
  for (const s of slides) { delete s._tags; delete s._nt; }
  return out;
}

module.exports = { slideKeywords, pageTags, computeLinks, PAGE_TAGS };
