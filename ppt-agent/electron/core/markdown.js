'use strict';
// 将解析结果转换为 Markdown：每页一节，包含正文、表格、图表、视频字幕与备注讲解词。
const { fmt, cuesToText } = require('./subtitles');

const esc = (s) => String(s || '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const mb = (n) => (n ? (n / 1024 / 1024).toFixed(1) + 'MB' : '');

function tableMd(rows) {
  if (!rows.length) return '';
  const w = Math.max(...rows.map((r) => r.length));
  const pad = (r) => [...r, ...Array(w - r.length).fill('')];
  const lines = [`| ${pad(rows[0]).map(esc).join(' | ')} |`, `| ${Array(w).fill('---').join(' | ')} |`];
  for (const r of rows.slice(1)) lines.push(`| ${pad(r).map(esc).join(' | ')} |`);
  return lines.join('\n');
}

function mediaMd(m) {
  const icon = m.type === 'audio' ? '🎵 **音频**' : m.type === 'caption' ? '💬 **字幕文件**' : '🎬 **视频**';
  const info = [m.duration ? `时长 ${fmt(m.duration)}` : '', mb(m.size), m.type === 'caption' ? '' : (m.external ? (m.missing ? '外链（文件缺失）' : '外链') : '内嵌')].filter(Boolean).join('，');
  const out = [`${icon}：${m.title && m.title !== m.name ? m.title + ' — ' : ''}\`${m.name}\`${info ? `（${info}）` : ''}`];
  if (!m.subtitles || !m.subtitles.length) out.push('> 未发现字幕（仅解析字幕，不解析视频画面）');
  for (const s of m.subtitles || []) {
    out.push(`> **字幕**（${s.source}，${s.cues.length} 条）：`);
    out.push(cuesToText(s.cues).split('\n').map((l) => '> ' + l).join('\n'));
  }
  return out.join('\n');
}

function slideToMd(s) {
  const lines = [];
  const flags = [s.hidden ? '隐藏页' : '', s.theme === 'dark' ? '黑底' : '白底', s.section ? `分节：${s.section}` : ''].filter(Boolean).join(' · ');
  lines.push(`## 第 ${s.index} 页${s.title ? '：' + s.title.replace(/\n/g, ' ') : ''}`);
  lines.push(`<sub>${flags}</sub>`);
  lines.push('');
  for (const b of s.blocks || []) {
    if (b.kind === 'title') continue;
    if (b.paras) {
      for (const p of b.paras) {
        const text = p.text.replace(/\n/g, ' ').trim();
        if (!text) continue;
        if (p.bullet || p.lvl) lines.push(`${'  '.repeat(p.lvl || 0)}- ${text}`);
        else lines.push(text, '');
      }
      lines.push('');
    } else if (b.kind === 'table') { lines.push(tableMd(b.rows), ''); } else if (b.kind === 'chart') {
      const c = b.chart;
      lines.push(`📊 **图表${c.kind ? '（' + c.kind + '）' : ''}**：${c.title || '未命名'}`);
      if (c.series.length) lines.push(`- 系列：${c.series.map((x) => x.name + (x.values.length ? ` [${x.values.slice(0, 12).join(', ')}]` : '')).join('；')}`);
      if (c.categories.length) lines.push(`- 类别：${c.categories.join('、')}`);
      lines.push('');
    } else if (b.kind === 'smartart') { lines.push('🔷 **SmartArt**', ...b.items.map((t) => `- ${t}`), ''); } else if (b.kind === 'image') {
      lines.push(`![${esc(b.alt || b.name)}](${b.src ? 'media/' + b.src : b.name})`, '');
    } else if (b.kind === 'video' || b.kind === 'audio') { lines.push(mediaMd(b.media), ''); } else if (b.kind === 'object') lines.push(`📎 嵌入对象：${b.name}`, '');
  }
  for (const m of s.media || []) if (m.type === 'caption') lines.push(mediaMd(m), '');
  lines.push('### 🗣 备注（讲解词）');
  lines.push(s.notes ? s.notes : '_（无备注）_');
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

function docToMd(file, slides) {
  const head = [
    '---',
    `title: "${(file.title || file.name).replace(/"/g, "'")}"`,
    `source: "${file.path.replace(/\\/g, '/').replace(/"/g, "'")}"`,
    `author: "${file.author || ''}"`,
    `slides: ${slides.length}`,
    `modified: ${new Date(file.mtime).toISOString()}`,
    file.tags && file.tags.length ? `tags: [${file.tags.map((t) => JSON.stringify(t)).join(', ')}]` : null,
    '---',
    '',
    `# ${file.title || file.name}`,
    '',
  ].filter((l) => l !== null);
  return head.join('\n') + slides.map((s) => s.md || slideToMd(s)).join('\n---\n\n');
}

module.exports = { slideToMd, docToMd, tableMd };
