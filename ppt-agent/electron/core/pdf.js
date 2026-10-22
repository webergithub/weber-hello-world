'use strict';
// PDF 解析：每一页相当于 PPT 的一页，用 pdf.js 只读提取文字（按行、识别标题），
// 用页面绘制指令判断黑底 / 白底；输出结构与 parsePptx / parseDocx 一致。
const fs = require('fs');
const path = require('path');

let libPromise = null;
// 说明：pdf.js 的 legacy 版在 Electron 的 Node 中会崩溃，Electron 自带的新版 V8 直接用标准版即可
function loadLib() {
  if (!libPromise) {
    const entry = require.resolve('pdfjs-dist/build/pdf.mjs');
    const warn = console.warn;
    console.warn = (...a) => { if (!/legacy/.test(String(a[0]))) warn(...a); };
    libPromise = import(require('url').pathToFileURL(entry).href).finally(() => { console.warn = warn; });
  }
  return libPromise;
}

const hexLum = (hex) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** 页面底色：第一段文字之前、覆盖整页的填充矩形的颜色（没有则视为白底） */
function pageBackground(lib, ops, view) {
  const O = lib.OPS;
  const fills = new Set([O.fill, O.eoFill, O.fillStroke, O.eoFillStroke].filter((x) => x !== undefined));
  const pw = Math.abs(view[2] - view[0]), ph = Math.abs(view[3] - view[1]);
  let color = '#000000', bg = null;
  const n = Math.min(ops.fnArray.length, 400);
  for (let i = 0; i < n; i++) {
    const fn = ops.fnArray[i], args = ops.argsArray[i];
    if (fn === O.setFillRGBColor) color = args && args[0];
    else if (fn === O.setFillGray && args) { const v = Math.round(args[0] * 255).toString(16).padStart(2, '0'); color = `#${v}${v}${v}`; }
    else if (fn === O.beginText || fn === O.showText || fn === O.paintImageXObject) break;
    else if (fn === O.constructPath && args && fills.has(args[0]) && args[2]) {
      const mm = Object.values(args[2]).map(Number);
      if (mm.length >= 4 && Math.abs(mm[2] - mm[0]) >= pw * 0.9 && Math.abs(mm[3] - mm[1]) >= ph * 0.9) bg = color;
    }
  }
  const lum = hexLum(bg);
  return { color: bg || '#ffffff', lum: lum === null ? 1 : Math.round(lum * 1000) / 1000, source: 'pdf' };
}

/** 文字项 → 行（按基线 y 聚合，同一行按 x 排序），保留字号用于识别标题 */
function textLines(items) {
  const rows = [];
  for (const it of items) {
    if (!it || typeof it.str !== 'string') continue;
    const y = it.transform[5], x = it.transform[4], size = Math.abs(it.height || it.transform[3] || 0);
    let row = rows.find((r) => Math.abs(r.y - y) <= Math.max(2, Math.min(r.size || size, size || r.size) * 0.4));
    if (!row) { row = { y, size: 0, parts: [] }; rows.push(row); }
    row.parts.push({ x, str: it.str, w: it.width || 0, size });
    if (it.str.trim()) row.size = Math.max(row.size, size);
  }
  rows.sort((a, b) => b.y - a.y);
  return rows.map((r) => {
    r.parts.sort((a, b) => a.x - b.x);
    let text = '', end = null;
    for (const p of r.parts) {
      if (end !== null && p.x - end > Math.max(1.5, p.size * 0.25) && !/\s$/.test(text) && !/^\s/.test(p.str)) text += ' ';
      text += p.str; end = p.x + p.w;
    }
    return { text: text.replace(/\s+/g, ' ').trim(), size: r.size, y: r.y };
  }).filter((l) => l.text);
}

/**
 * 解析 PDF（只读）：返回 { props, size, slides, mediaKey, kind: 'pdf' }。
 * 每页：标题 = 本页最大字号的前几行（页眉页码等很短的数字行除外），正文 = 其余行。
 */
async function parsePdf(file, opts = {}) {
  const lib = await loadLib();
  const data = new Uint8Array(fs.readFileSync(file));
  const root = path.dirname(path.dirname(require.resolve('pdfjs-dist/build/pdf.mjs')));
  const dirUrl = (d) => path.join(root, d) + path.sep;
  const doc = await lib.getDocument({ data, cMapUrl: dirUrl('cmaps'), cMapPacked: true, standardFontDataUrl: dirUrl('standard_fonts'), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0, stopAtErrors: false }).promise;
  try {
    let info = {};
    try { info = ((await doc.getMetadata()) || {}).info || {}; } catch { /* ignore */ }
    const props = {
      title: String(info.Title || '').trim(), subject: String(info.Subject || '').trim(), author: String(info.Author || '').trim(), keywords: String(info.Keywords || '').trim(),
      lastModifiedBy: '', created: String(info.CreationDate || ''), modified: String(info.ModDate || ''), app: String(info.Creator || info.Producer || '').trim(), company: '', pages: doc.numPages,
    };
    const slides = [];
    let size = null;
    for (let i = 1; i <= doc.numPages; i++) {
      const s = { index: i, part: `page${i}`, hidden: false, title: '', blocks: [], media: [], notes: '', errors: [], theme: 'light', bg: { color: '#ffffff', lum: 1, source: 'pdf' }, layout: null, section: '' };
      try {
        const page = await doc.getPage(i);
        const view = page.view || [0, 0, 595, 842];
        if (!size) size = { cx: Math.round(Math.abs(view[2] - view[0]) * 12700), cy: Math.round(Math.abs(view[3] - view[1]) * 12700) };
        const tc = await page.getTextContent();
        const lines = textLines(tc.items).filter((l) => !/^[\d\s/\-–—|·.页第of]+$/i.test(l.text) || l.text.length > 12);
        try { s.bg = pageBackground(lib, await page.getOperatorList(), view); } catch { /* 底色判断失败按白底 */ }
        s.theme = s.bg.lum < 0.3 ? 'dark' : 'light';
        const max = Math.max(0, ...lines.map((l) => l.size));
        const body = lines.map((l) => l.size).sort((a, b) => a - b)[Math.floor(lines.length / 2)] || 0;
        let ti = [];
        if (lines.length && max > body * 1.15) {
          for (let k = 0; k < lines.length && ti.length < 3; k++) if (lines[k].size >= max * 0.9) ti.push(k); else if (ti.length) break;
        }
        if (!ti.length && lines.length) ti = [0];
        s.title = ti.map((k) => lines[k].text).join(' ').slice(0, 200);
        const rest = lines.filter((_, k) => !ti.includes(k));
        if (s.title) s.blocks.push({ kind: 'title', paras: [{ text: s.title }] });
        if (rest.length) s.blocks.push({ kind: 'text', paras: rest.map((l) => ({ text: l.text, lvl: 0, bullet: /^[•·●▪\-–]\s?/.test(l.text), heading: l.size >= max * 0.9 && max > body * 1.15 ? 2 : 0 })) });
        page.cleanup();
      } catch (e) {
        s.errors.push(String((e && e.message) || e));
      }
      if (!s.title) s.title = `第 ${i} 页`;
      s.text = s.blocks.filter((b) => b.kind !== 'title').flatMap((b) => b.paras.map((p) => p.text)).join('\n');
      slides.push(s);
      if (opts.onSlide) opts.onSlide(i, doc.numPages, s.title, s);
    }
    if (!props.title) props.title = (slides[0] && slides[0].title !== '第 1 页' ? slides[0].title : '') || path.basename(file, path.extname(file));
    return { props, size, slides, mediaKey: opts.mediaKey, kind: 'pdf' };
  } finally {
    try { await doc.destroy(); } catch { /* ignore */ }
  }
}

/** 快速读取作者 / 标题（用于判断是否重复）；不是有效 PDF 时抛错 */
async function quickPdfProps(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(1024);
    const n = fs.readSync(fd, head, 0, 1024, 0);
    if (!head.subarray(0, n).toString('latin1').includes('%PDF-')) throw new Error('缺少 PDF 文件头');
  } finally { fs.closeSync(fd); }
  const lib = await loadLib();
  const doc = await lib.getDocument({ data: new Uint8Array(fs.readFileSync(file)), isEvalSupported: false, disableFontFace: true, verbosity: 0 }).promise;
  try {
    const info = ((await doc.getMetadata().catch(() => null)) || {}).info || {};
    return { author: String(info.Author || '').trim(), title: String(info.Title || '').trim(), pages: doc.numPages };
  } finally { try { await doc.destroy(); } catch { /* ignore */ } }
}

module.exports = { parsePdf, quickPdfProps };
