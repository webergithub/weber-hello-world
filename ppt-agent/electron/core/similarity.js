'use strict';
// 相似 PPT 分组（先比较标题，再比较内容向量）与 黑底/白底 页面对应关系。
const path = require('path');
const { ticker } = require('./yieldy');
const { cosine } = require('./vectors');

const VARIANT_RE = [
  /^(副本|copy of)\s*/i,
  /[（(【\[]?\s*(副本|拷贝|复制|copy|备份|backup|最终版?|final|定稿|修订版?|草稿|draft|新版|旧版|终版)\d*\s*[）)】\]]?/gi,
  /[（(【\[]?\s*(黑底|白底|深色|浅色|暗色|亮色|黑色版?|白色版?|dark|light|black|white)\s*(版|模板|背景|theme|version|bg)?\s*[）)】\]]?/gi,
  /[_\-\s.]?v\d+(\.\d+)*\b/gi,
  /[_\-\s]?(20\d{2})[\-_.年]?(\d{1,2})?[\-_.月]?(\d{1,2})?日?/g,
  /[（(]\s*\d+\s*[）)]/g,
];

function normTitle(name) {
  let s = path.basename(String(name || ''), path.extname(String(name || ''))).toLowerCase();
  for (const re of VARIANT_RE) s = s.replace(re, ' ');
  return s.replace(/[_\-–—.\s·,，、]+/g, ' ').trim();
}

function normSlideTitle(t) {
  return String(t || '').toLowerCase().replace(/\s+/g, ' ').replace(/[（(].*?(修订|版|copy|副本).*?[）)]/g, '').replace(/[^\p{L}\p{N} ]/gu, '').trim();
}

class DSU {
  constructor() { this.p = new Map(); }
  find(x) { if (!this.p.has(x)) this.p.set(x, x); const r = this.p.get(x); if (r === x) return x; const root = this.find(r); this.p.set(x, root); return root; }
  union(a, b) { const ra = this.find(a), rb = this.find(b); if (ra !== rb) this.p.set(rb, ra); }
}

/**
 * 计算相似分组。返回 [{id, key, title, members:[{file, reasons:[], score}], reasons}]
 * files: 文件行（含 duplicate），vecs: Map(id -> Float32Array)，slideTitles: Map(fileId -> Set(normTitle))
 */
async function computeGroups(files, vecs, slideTitles, { threshold = 0.82 } = {}) {
  const tk = ticker();
  const dsu = new DSU();
  const edges = new Map();
  const edge = (a, b, reason, score) => {
    if (a === b) return;
    const k = a < b ? `${a}-${b}` : `${b}-${a}`;
    const e = edges.get(k) || { a: Math.min(a, b), b: Math.max(a, b), reasons: new Set(), score: 0 };
    e.reasons.add(reason); e.score = Math.max(e.score, score);
    edges.set(k, e);
    dsu.union(a, b);
  };
  const parsed = files.filter((f) => f.status === 'parsed');
  const byId = new Map(files.map((f) => [f.id, f]));
  // 1) 完全相同（重复文件）
  for (const f of files) if (f.status === 'duplicate' && f.dup_of && byId.has(f.dup_of)) edge(f.dup_of, f.id, '完全相同(重复文件)', 1);
  // 2) 标题（文件名归一化后）相同
  const byTitle = new Map();
  for (const f of parsed) {
    const t = normTitle(f.name);
    if (t.length < 2) continue;
    if (!byTitle.has(t)) byTitle.set(t, []);
    byTitle.get(t).push(f);
  }
  for (const list of byTitle.values()) {
    for (let i = 1; i < list.length; i++) {
      const s = cosine(vecs.get(list[0].id), vecs.get(list[i].id));
      edge(list[0].id, list[i].id, '标题相同', s);
    }
  }
  // 3) 内容相似：小规模全量两两比较；大规模仅比较共享页标题的候选对（分片计算，期间让出事件循环）
  const ids = parsed.map((f) => f.id).filter((id) => vecs.get(id));
  const check = (a, b) => {
    const s = cosine(vecs.get(a), vecs.get(b));
    if (s >= threshold) {
      const ta = slideTitles.get(a) || new Set(), tb = slideTitles.get(b) || new Set();
      let shared = 0; for (const t of ta) if (tb.has(t)) shared++;
      const titleOverlap = shared / Math.max(1, Math.min(ta.size, tb.size));
      if (s >= 0.9 || titleOverlap >= 0.5) edge(a, b, titleOverlap >= 0.5 ? `内容相似(页标题重合${Math.round(titleOverlap * 100)}%)` : '内容相似', s);
    }
  };
  if (ids.length <= 2000) {
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) { const p = tk(); if (p) await p; check(ids[i], ids[j]); }
  } else {
    const inv = new Map();
    for (const [fid, set] of slideTitles) for (const t of set) { if (t.length < 4) continue; if (!inv.has(t)) inv.set(t, []); inv.get(t).push(fid); }
    const done = new Set();
    for (const list of inv.values()) {
      if (list.length > 50) continue;
      for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
        const a = Math.min(list[i], list[j]), b = Math.max(list[i], list[j]), k = a * 4194304 + b;
        if (done.has(k)) continue;
        done.add(k);
        const p = tk(); if (p) await p;
        check(a, b);
      }
    }
  }
  const groups = new Map();
  for (const e of edges.values()) {
    const root = dsu.find(e.a);
    if (!groups.has(root)) groups.set(root, { members: new Map(), reasons: new Set(), maxScore: 0 });
    const g = groups.get(root);
    for (const id of [e.a, e.b]) {
      const m = g.members.get(id) || { id, reasons: new Set(), score: 0 };
      for (const r of e.reasons) m.reasons.add(r);
      m.score = Math.max(m.score, e.score);
      g.members.set(id, m);
    }
    for (const r of e.reasons) g.reasons.add(r);
    g.maxScore = Math.max(g.maxScore, e.score);
  }
  let n = 0;
  return [...groups.values()].map((g) => {
    const members = [...g.members.values()].map((m) => ({ file: byId.get(m.id), reasons: [...m.reasons], score: Math.round(m.score * 1000) / 1000 })).filter((m) => m.file);
    members.sort((a, b) => a.file.name.localeCompare(b.file.name, 'zh'));
    const themes = new Set(members.map((m) => m.file.theme));
    return {
      id: ++n,
      title: normTitle(members[0].file.name) || members[0].file.name,
      members,
      reasons: [...g.reasons],
      hasThemeVariants: themes.has('dark') && (themes.has('light') || themes.has('mixed')),
      totalSize: members.reduce((a, m) => a + (m.file.size || 0), 0),
      maxScore: Math.round(g.maxScore * 1000) / 1000,
    };
  }).filter((g) => g.members.length > 1);
}

/** 黑底/白底页面对应：同组或同标题的异底色页面，标题相同 + 内容相似 */
async function computePairs(allSlides, fileGroups) {
  const tk = ticker();
  const slides = allSlides.filter((s) => (s.kind || 'ppt') === 'ppt');
  const pairs = [];
  const byFile = new Map();
  for (const s of slides) { if (!byFile.has(s.file_id)) byFile.set(s.file_id, []); byFile.get(s.file_id).push(s); }
  const seen = new Set();
  const tryMatch = async (A, B) => {
    const dark = [...A, ...B].filter((s) => s.theme === 'dark');
    const light = [...A, ...B].filter((s) => s.theme !== 'dark');
    // 同标题的白底页优先；候选过多时只比较同标题页 + 少量其他页，避免大分组退化成两两比较
    const byNt = new Map();
    for (const l of light) { if (!byNt.has(l.nt)) byNt.set(l.nt, []); byNt.get(l.nt).push(l); }
    for (const d of dark) {
      { const p = tk(); if (p) await p; }
      let best = null;
      const cands = light.length <= 200 ? light : [...(byNt.get(d.nt) || []).slice(0, 200), ...light.slice(0, 50)];
      for (const l of cands) {
        if (l.file_id === d.file_id) continue;
        const sameTitle = d.nt && d.nt === l.nt;
        const sim = cosine(d.vec, l.vec);
        const score = sim + (sameTitle ? 0.25 : 0);
        if ((sameTitle && sim >= 0.55) || sim >= 0.85) if (!best || score > best.score) best = { l, score };
      }
      if (best) {
        const k = `${d.id}-${best.l.id}`;
        if (!seen.has(k)) { seen.add(k); pairs.push({ a: d.id, b: best.l.id, score: Math.min(1, Math.round(best.score * 1000) / 1000) }); }
      }
    }
  };
  for (const s of slides) s.nt = normSlideTitle(s.title);
  // 1) 相似分组内的文件两两匹配
  for (const g of fileGroups) {
    const ids = g.members.map((m) => m.file.id).filter((id) => byFile.has(id));
    // 组内文件不多时两两匹配；成员很多（几十上百个相似版本）时整组一起匹配一次
    if (ids.length <= 12) { for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) await tryMatch(byFile.get(ids[i]), byFile.get(ids[j])); }
    else await tryMatch(ids.flatMap((id) => byFile.get(id)), []);
  }
  // 2) 全库按页标题完全相同的异底色页面
  const byTitle = new Map();
  for (const s of slides) { if (s.nt.length < 4) continue; if (!byTitle.has(s.nt)) byTitle.set(s.nt, []); byTitle.get(s.nt).push(s); }
  for (const list of byTitle.values()) {
    if (list.length > 40 || !list.some((s) => s.theme === 'dark') || !list.some((s) => s.theme !== 'dark')) continue;
    await tryMatch(list, []);
  }
  return pairs;
}

module.exports = { computeGroups, computePairs, normTitle, normSlideTitle };
