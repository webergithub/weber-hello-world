// 帮助中的“版本记录”“需求文档”：打包时直接内置 docs/需求文档.md（每次迭代都会刷新），不需要另外维护一份
import raw from '../docs/需求文档.md?raw';

export const REQ_MD = raw.replace(/^---\n[\s\S]*?\n---\n/, '');

/** 按顶层“；”拆成条目（括号、引号里的分号不拆） */
function splitItems(text) {
  const out = [];
  let depth = 0, cur = '';
  for (const ch of text) {
    if ('（(“「'.includes(ch)) depth++;
    else if ('）)”」'.includes(ch)) depth = Math.max(0, depth - 1);
    if (ch === '；' && depth === 0) { if (cur.trim()) out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

/** 版本变更记录：[{ ver, date, items }]，最新的在前 */
export function changelog() {
  const sec = REQ_MD.split(/\n## /).find((s) => /^\d+\.\s*版本变更记录/.test(s)) || '';
  const rows = sec.split('\n').filter((l) => /^\|\s*v\d/.test(l)).map(cells);
  const num = (v) => v.replace(/^v/, '').split('.').map(Number);
  const cmp = (a, b) => { const x = num(a.ver), y = num(b.ver); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (y[i] || 0) - (x[i] || 0); return 0; };
  return rows.map(([ver, date, ...rest]) => ({ ver, date, items: splitItems(rest.join('|')) })).sort(cmp);
}

/** Markdown → 块：h（标题）、table、ul / ol、quote、p */
export function mdBlocks(md = REQ_MD) {
  const lines = md.replace(/\r/g, '').split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    const h = /^(#{1,6})\s+(.*)$/.exec(l);
    if (h) { blocks.push({ t: 'h', level: h[1].length, text: h[2].trim() }); i++; continue; }
    if (/^\s*\|/.test(l)) {
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) { rows.push(lines[i]); i++; }
      const body = rows.filter((r) => !/^\s*\|[\s:|-]+\|\s*$/.test(r)).map(cells);
      blocks.push({ t: 'table', head: body[0] || [], rows: body.slice(1) });
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(l)) {
      const ordered = /^\s*\d+\./.test(l);
      const items = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*([-*]|\d+\.)\s+/, '')); i++; }
      blocks.push({ t: ordered ? 'ol' : 'ul', items });
      continue;
    }
    if (/^>\s?/.test(l)) {
      const q = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { q.push(lines[i].replace(/^>\s?/, '')); i++; }
      blocks.push({ t: 'quote', text: q.join(' ') });
      continue;
    }
    const p = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|\s*\||\s*([-*]|\d+\.)\s|>)/.test(lines[i])) { p.push(lines[i].trim()); i++; }
    if (!p.length) { p.push(l.trim()); i++; }
    blocks.push({ t: 'p', text: p.join(' ') });
  }
  return blocks;
}
