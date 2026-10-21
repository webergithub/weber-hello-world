'use strict';
// 文本处理：jieba 中文分词 + 英文词形归一 + 词表概念 token（跨语言检索）。
const jieba = require('jieba-wasm');
const glossary = require('./glossary');

for (const z of glossary.zhTerms) if (z.length >= 2) jieba.add_word(z, 50000, 'nz');

const ZH_STOP = new Set(('的 了 和 与 及 或 是 在 有 为 对 中 等 将 把 被 从 到 以 于 就 也 都 而 并 但 这 那 这些 那些 我们 你们 他们 它 其 之 个 各 每 所 由 让 使 给 向 上 下 不 没有 一个 一些 可以 需要 进行 通过 以及 其中 已经 可能 如何 什么 本次 下面 今天 大家 各位 这一页 一页 页 请 注意 谢谢 方面 主要 相关 包括 实现 情况 问题 内容 部分 方式 我 你 他 她 很 更 最 还 又 再 只 能 要 会 来 去 说 看 做 用 第 次 年 月 日 时 分 秒').split(' '));
const EN_STOP = new Set(('a an the and or of to in on for with by at from as is are was were be been being this that these those it its we our you your they their he she i me my not no but if then than so such can could will would should may might must do does did done have has had having into over under about after before between through during per via vs etc also all any each more most other some only own same too very just one two three new use using used based within across our us here there what which who whom when where why how page slide slides click add text title'.split(' ')));

function stemEn(w) {
  if (w.length <= 3 || /(netes|ss|ics|sis)$/.test(w)) return w;
  if (/ies$/.test(w) && w.length > 4) return w.slice(0, -3) + 'y';
  if (/(ss|us|is)$/.test(w)) return w;
  if (/s$/.test(w)) return w.slice(0, -1);
  return w;
}

const PUNCT = /^[\s\p{P}\p{S}]+$/u;
const HAS_CJK = /[㐀-鿿]/;

function cut(text) {
  if (!text) return [];
  return jieba.cut(String(text), true);
}

/** 用于索引/检索的 token 列表（含概念 token c<ID>） */
function tokenize(text, { concepts = true } = {}) {
  if (!text) return [];
  const out = [];
  for (let t of jieba.cut_for_search(String(text), true)) {
    t = t.trim().toLowerCase();
    if (!t || PUNCT.test(t)) continue;
    if (HAS_CJK.test(t)) {
      if (ZH_STOP.has(t)) continue;
      out.push(t);
    } else {
      for (let w of t.split(/[^a-z0-9\-+#.]+/)) {
        w = w.replace(/^[.\-]+|[.\-]+$/g, '');
        if (!w || EN_STOP.has(w) || (w.length < 2 && !/\d/.test(w))) continue;
        out.push(stemEn(w));
      }
    }
  }
  if (concepts) for (const f of glossary.findConcepts(text)) for (let i = 0; i < Math.min(f.count, 5); i++) out.push('c' + f.concept.id);
  return out;
}

/** 候选关键词（用于打标签）：名词性中文词 + 英文词/短语 */
function keywordCandidates(text) {
  const out = [];
  if (!text) return out;
  for (const { word, tag } of jieba.tag(String(text), true)) {
    const w = word.trim();
    if (!w || PUNCT.test(w)) continue;
    if (HAS_CJK.test(w)) {
      if (w.length < 2 || ZH_STOP.has(w)) continue;
      if (/^(n|nr|ns|nt|nz|vn|l|nrt|nrfg|eng|an|j)/.test(tag)) out.push(w);
    } else {
      for (const part of w.toLowerCase().split(/[^a-z0-9\-+#]+/)) {
        if (part.length >= 3 && !EN_STOP.has(part) && !/^\d+$/.test(part)) out.push(part);
        else if (/^[a-z]{2}$/.test(part) && w === w.toUpperCase() && !EN_STOP.has(part)) out.push(part);
      }
    }
  }
  return out;
}

function detectLang(text) {
  const s = String(text || '');
  const zh = (s.match(/[㐀-鿿]/g) || []).length;
  const en = (s.match(/[A-Za-z]+/g) || []).join('').length;
  if (zh && en) return en > zh * 6 ? 'en' : (en * 6 < zh ? 'zh' : 'mixed');
  return zh ? 'zh' : en ? 'en' : 'unknown';
}

module.exports = { tokenize, cut, keywordCandidates, detectLang, stemEn, ZH_STOP, EN_STOP, HAS_CJK };
