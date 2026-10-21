// 轻量 Markdown 渲染（覆盖本工具生成的语法子集），输出经过转义的 HTML
import { assetUrl } from './api';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function inline(s, hl) {
  let h = esc(s);
  h = h.replace(/!\[([^\]]*)\]\(media\/([^)]+)\)/g, (_m, alt, src) => `<img alt="${alt}" src="${assetUrl('media', src)}"/>`);
  h = h.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, alt, src) => `<span class="md-img">🖼 ${alt || src}</span>`);
  h = h.replace(/`([^`]+)`/g, '<code>$1</code>');
  h = h.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  h = h.replace(/(^|[\s(（])_([^_]+)_(?=$|[\s)）。，,])/g, '$1<i>$2</i>');
  if (hl && hl.length) h = highlight(h, hl);
  return h;
}

export function highlight(html, terms) {
  const list = [...new Set(terms.filter((t) => t && t.length >= 1))].sort((a, b) => b.length - a.length).slice(0, 30);
  if (!list.length) return html;
  const re = new RegExp(`(${list.map((t) => esc(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  return html.split(/(<[^>]+>)/).map((part) => (part.startsWith('<') ? part : part.replace(re, '<mark>$1</mark>'))).join('');
}

export function renderMarkdown(md, hl = []) {
  if (!md) return '';
  let lines = String(md).replace(/\r/g, '').split('\n');
  if (lines[0] === '---') { const end = lines.indexOf('---', 1); if (end > 0) lines = lines.slice(end + 1); }
  const out = [];
  let i = 0;
  let para = [];
  const flush = () => { if (para.length) { out.push(`<p>${inline(para.join(' '), hl)}</p>`); para = []; } };
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { flush(); i++; continue; }
    let m;
    if ((m = l.match(/^(#{1,4})\s+(.*)$/))) { flush(); out.push(`<h${m[1].length}>${inline(m[2], hl)}</h${m[1].length}>`); i++; continue; }
    if (/^<sub>.*<\/sub>$/.test(l)) { flush(); out.push(`<div class="md-sub">${inline(l.slice(5, -6), hl)}</div>`); i++; continue; }
    if (l.trim() === '---') { flush(); out.push('<hr/>'); i++; continue; }
    if (/^\s*\|/.test(l)) {
      flush();
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) { rows.push(lines[i]); i++; }
      const cells = (r) => r.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
      const body = rows.filter((r) => !/^\s*\|[\s\-|:]+\|\s*$/.test(r));
      out.push('<table>' + body.map((r, k) => `<tr>${cells(r).map((c) => (k === 0 ? `<th>${inline(c, hl)}</th>` : `<td>${inline(c, hl)}</td>`)).join('')}</tr>`).join('') + '</table>');
      continue;
    }
    if (/^>\s?/.test(l)) {
      flush();
      const q = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { q.push(inline(lines[i].replace(/^>\s?/, ''), hl)); i++; }
      out.push(`<blockquote>${q.join('<br/>')}</blockquote>`);
      continue;
    }
    if (/^\s*[-*]\s+/.test(l)) {
      flush();
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        const lvl = Math.floor(lines[i].match(/^\s*/)[0].length / 2);
        items.push(`<li style="margin-left:${lvl * 18}px">${inline(lines[i].replace(/^\s*[-*]\s+/, ''), hl)}</li>`);
        i++;
      }
      out.push(`<ul>${items.join('')}</ul>`);
      continue;
    }
    para.push(l);
    i++;
  }
  flush();
  return out.join('\n');
}
