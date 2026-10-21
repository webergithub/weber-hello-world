'use strict';
// 自动标签：每个 PPT 打 20 个标签（领域概念 + TF-IDF 关键词 + 文件属性），并归入内容分类。
const path = require('path');
const glossary = require('./glossary');
const { keywordCandidates, HAS_CJK } = require('./textproc');

const TAG_COUNT = 20;
const GENERIC = new Set(['概述', '介绍', '简介', '总结', '目录', '附录', '谢谢', '内容', '部分', '图片', '背景', '文件', '测试', '副本', '深色', '浅色', '黑底', '白底', '页面', '演示', '幻灯片', '同名', '旧版', '格式', '空白', '大文件',
  'overview', 'introduction', 'summary', 'agenda', 'dark', 'light', 'image', 'picture', 'jpg', 'jpeg', 'png', 'gif', 'mp4', 'mov', 'wmv', 'ppt', 'pptx', 'min', 'number', 'slide', 'copy', 'final', 'demo', 'null']);

/** 统计单个文件的词项权重（标题 ×3，页标题 ×2，正文 ×1，备注 ×0.5），以及概念命中 */
function fileTerms(file, slides) {
  const terms = {};
  const add = (text, w) => {
    for (const k of keywordCandidates(text)) terms[k] = (terms[k] || 0) + w;
  };
  const name = path.basename(file.name || '', path.extname(file.name || '')).replace(/[_\-()（）\[\]【】]+/g, ' ');
  add(name, 3);
  if (file.title && file.title !== name) add(file.title, 2);
  const concepts = {};
  const addC = (text, w) => { for (const f of glossary.findConcepts(text)) concepts[f.concept.id] = (concepts[f.concept.id] || 0) + f.count * w; };
  addC(name, 3);
  for (const s of slides) {
    add(s.title, 2); add(s.text, 1); add(s.notes, 0.5);
    addC(s.title, 2); addC(s.text, 1); addC(s.notes, 0.5);
  }
  for (const k of Object.keys(terms)) terms[k] = Math.round(terms[k] * 10) / 10;
  const top = Object.entries(terms).sort((a, b) => b[1] - a[1]).slice(0, 300);
  return { terms: Object.fromEntries(top), concepts };
}

function attributeTags(file, slides) {
  const tags = [];
  const dark = slides.filter((s) => s.theme === 'dark').length;
  const word = file.kind === 'word';
  if (word) tags.push('Word文档');
  else if (slides.length) tags.push(dark === 0 ? '白底' : dark === slides.length ? '黑底' : '黑白混合');
  if (slides.some((s) => (s.media || []).some((m) => m.type === 'video'))) tags.push('含视频');
  if (slides.some((s) => (s.media || []).some((m) => (m.subtitles || []).length))) tags.push('含字幕');
  if (slides.some((s) => (s.blocks || []).some((b) => b.kind === 'table') || /\|/.test(s.md || ''))) tags.push('含表格');
  if (slides.some((s) => (s.blocks || []).some((b) => b.kind === 'chart') || /📊/.test(s.md || ''))) tags.push('含图表');
  const withNotes = slides.filter((s) => s.notes && s.notes.trim()).length;
  if (withNotes) tags.push(word ? '含批注' : withNotes === slides.length ? '全页讲解词' : '含讲解词');
  const lang = file.lang;
  if (lang === 'zh') tags.push('中文'); else if (lang === 'en') tags.push('英文'); else if (lang === 'mixed') tags.push('中英双语');
  const n = slides.length;
  if (word) tags.push(n <= 5 ? '5节以内' : n <= 20 ? '6-20节' : '20节以上');
  else tags.push(n <= 5 ? '5页以内' : n <= 15 ? '6-15页' : n <= 40 ? '16-40页' : '40页以上');
  if (file.size > 50 * 1024 * 1024) tags.push('大文件');
  const folder = path.basename(file.dir || '');
  if (folder) tags.push('目录:' + folder);
  return tags;
}

function covered(tag, chosen) {
  const t = tag.toLowerCase();
  for (const c of chosen) {
    const l = c.toLowerCase();
    if (l === t || (t.length >= 2 && l.includes(t)) || (HAS_CJK.test(t) && l.length >= 2 && t.includes(l.split('/')[0]))) return true;
  }
  return false;
}

/**
 * 计算标签与分类。
 * df: Map(term -> 包含该词的文件数)，N: 文件总数
 */
function computeTags(file, slides, info, df, N, llmTags = []) {
  const chosen = [];
  const push = (t) => { t = String(t).trim(); if (t && !covered(t, chosen) && chosen.length < TAG_COUNT) chosen.push(t); };
  for (const t of llmTags.slice(0, 12)) push(t);

  // 概念标签，按权重排序
  const cs = Object.entries(info.concepts).map(([id, w]) => ({ c: glossary.concepts[id], w })).filter((x) => x.c && x.c.cat !== '通用办公' && x.w >= 1)
    .sort((a, b) => b.w - a.w);
  const conceptWords = new Set();
  for (const { c } of cs) for (const s of [...c.zh, ...c.en]) conceptWords.add(s.toLowerCase());
  for (const { c } of cs.slice(0, 9)) push(c.label);

  const attrs = attributeTags(file, slides);
  const room = TAG_COUNT - attrs.length;

  // TF-IDF 关键词
  const scored = Object.entries(info.terms).filter(([t]) => !GENERIC.has(t) && !conceptWords.has(t) && !/^\d+(\.\d+)?%?$/.test(t) && !(t.endsWith('s') && info.terms[t.slice(0, -1)]))
    .map(([t, tf]) => ({ t, s: (1 + Math.log(tf)) * Math.log(1 + N / (1 + (df.get(t) || 0))) * (HAS_CJK.test(t) ? 1 + Math.min(t.length, 4) * 0.1 : 1) }))
    .sort((a, b) => b.s - a.s);
  for (const { t } of scored) { if (chosen.length >= room) break; push(t); }
  for (const t of attrs) push(t);
  for (const { t } of scored) { if (chosen.length >= TAG_COUNT) break; push(t); }
  for (const { c } of cs.slice(9)) { if (chosen.length >= TAG_COUNT) break; push(c.label); }

  // 分类：概念所属领域加权
  const catScore = {};
  for (const { c, w } of cs) catScore[c.cat] = (catScore[c.cat] || 0) + w;
  const cat = Object.entries(catScore).sort((a, b) => b[1] - a[1])[0];
  return { tags: chosen.slice(0, TAG_COUNT), category: cat ? cat[0] : '其他' };
}

module.exports = { fileTerms, computeTags, TAG_COUNT };
