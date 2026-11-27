'use strict';
// PPT 字体统一（v3.13）：导入一个 PPT，统一标题与正文的字体（西文 / 中文）和字号，另存为新文件（不改原文件）。
// 处理范围：每页的标题占位符（title / ctrTitle）与其余文字（正文、文本框、可选表格）；可选同时修改母版 / 版式的
// 文字样式与主题字体（major = 标题、minor = 正文），让继承主题 / 母版的文字也一起统一。
const fs = require('fs');
const path = require('path');
const { DOMParser, XMLSerializer } = require('@xmldom/xmldom');
const { openZip } = require('./zip');
const { ZipWriter } = require('./zipwriter');

const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const TITLE_PH = new Set(['title', 'ctrTitle']);
// a:rPr 子元素中必须排在 latin / ea / cs 之后的元素（DrawingML 顺序：… latin, ea, cs, sym, hlinkClick, hlinkMouseOver, rtl, extLst）
const AFTER_FONTS = new Set(['a:sym', 'a:hlinkClick', 'a:hlinkMouseOver', 'a:rtl', 'a:extLst']);

const kids = (el, name) => { const out = []; for (let c = el && el.firstChild; c; c = c.nextSibling) if (c.nodeType === 1 && (!name || c.nodeName === name)) out.push(c); return out; };
const all = (el, name) => Array.from(el.getElementsByTagName(name));

/** 形状是否为标题占位符 */
function isTitleShape(sp) {
  const nv = kids(sp, 'p:nvSpPr')[0];
  const nvPr = nv && kids(nv, 'p:nvPr')[0];
  const ph = nvPr && kids(nvPr, 'p:ph')[0];
  return !!(ph && TITLE_PH.has(ph.getAttribute('type')));
}

/** 字体名：主题引用（+mj-lt 等）显示为“主题字体” */
const fontName = (v) => (!v ? '' : v.startsWith('+mj') ? '（主题标题字体）' : v.startsWith('+mn') ? '（主题正文字体）' : v);

/** 设置一个 rPr / defRPr / endParaRPr 的字体与字号 */
function applyRun(doc, rPr, { latin, ea, size }, stats) {
  let changed = false;
  if (size) { const v = String(Math.round(size * 100)); if (rPr.getAttribute('sz') !== v) { rPr.setAttribute('sz', v); changed = true; } }
  for (const [tag, face] of [['a:latin', latin], ['a:ea', ea], ['a:cs', latin]]) {
    if (!face) continue;
    let el = kids(rPr, tag)[0];
    if (!el) {
      el = doc.createElementNS(NS_A, tag);
      const before = kids(rPr).find((c) => AFTER_FONTS.has(c.nodeName) || (tag === 'a:latin' && (c.nodeName === 'a:ea' || c.nodeName === 'a:cs')) || (tag === 'a:ea' && c.nodeName === 'a:cs'));
      if (before) rPr.insertBefore(el, before); else rPr.appendChild(el);
    }
    if (el.getAttribute('typeface') !== face) { el.setAttribute('typeface', face); changed = true; }
    for (const a of ['panose', 'pitchFamily', 'charset']) if (el.hasAttribute(a)) el.removeAttribute(a);
  }
  if (changed && stats) stats.runs++;
  return changed;
}

/** 某个 txBody 中的全部文字（a:r、a:fld、段落结束标记）统一字体字号 */
function applyTxBody(doc, txBody, spec, stats) {
  const targets = [];
  for (const p of all(txBody, 'a:p')) {
    for (const r of [...kids(p, 'a:r'), ...kids(p, 'a:fld')]) {
      let rPr = kids(r, 'a:rPr')[0];
      if (!rPr) { rPr = doc.createElementNS(NS_A, 'a:rPr'); r.insertBefore(rPr, r.firstChild); }
      targets.push(rPr);
    }
    const end = kids(p, 'a:endParaRPr')[0];
    if (end) targets.push(end);
  }
  for (const rPr of targets) applyRun(doc, rPr, spec, stats);
}

/** 统计一个 txBody 中出现的字体与字号（用于“分析”） */
function collect(txBody, bucket) {
  for (const r of [...all(txBody, 'a:r'), ...all(txBody, 'a:fld')]) {
    const t = kids(r, 'a:t')[0];
    const text = t ? t.textContent || '' : '';
    if (!text.trim()) continue;
    const rPr = kids(r, 'a:rPr')[0];
    const latin = rPr && kids(rPr, 'a:latin')[0], ea = rPr && kids(rPr, 'a:ea')[0];
    const face = fontName((ea && ea.getAttribute('typeface')) || (latin && latin.getAttribute('typeface'))) || '（继承母版 / 主题）';
    const sz = rPr && rPr.getAttribute('sz') ? `${Number(rPr.getAttribute('sz')) / 100} 磅` : '（继承）';
    bucket.fonts[face] = (bucket.fonts[face] || 0) + text.length;
    bucket.sizes[sz] = (bucket.sizes[sz] || 0) + text.length;
    bucket.runs++;
  }
}

/** 幻灯片部件列表（按演示顺序）与母版 / 版式 / 主题部件 */
async function partsOf(zip) {
  const names = zip.names();
  const slides = names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/i.test(n)).sort((a, b) => Number(a.match(/(\d+)\.xml$/)[1]) - Number(b.match(/(\d+)\.xml$/)[1]));
  return {
    slides,
    masters: names.filter((n) => /^ppt\/slideMasters\/slideMaster\d+\.xml$/i.test(n)),
    layouts: names.filter((n) => /^ppt\/slideLayouts\/slideLayout\d+\.xml$/i.test(n)),
    themes: names.filter((n) => /^ppt\/theme\/theme\d+\.xml$/i.test(n)),
  };
}

/** 分析：标题与正文分别用了哪些字体、字号（按字符数统计）以及主题字体 */
async function analyzeFonts(file) {
  const zip = await openZip(file);
  try {
    const parts = await partsOf(zip);
    const title = { fonts: {}, sizes: {}, runs: 0 }, body = { fonts: {}, sizes: {}, runs: 0 };
    for (const part of parts.slides) {
      const doc = new DOMParser().parseFromString(await zip.text(part), 'text/xml');
      for (const sp of all(doc, 'p:sp')) { const tb = kids(sp, 'p:txBody')[0]; if (tb) collect(tb, isTitleShape(sp) ? title : body); }
      for (const tb of all(doc, 'a:tbl')) collect(tb, body);
    }
    const theme = {};
    if (parts.themes[0]) {
      const t = new DOMParser().parseFromString(await zip.text(parts.themes[0]), 'text/xml');
      const pick = (name) => { const f = all(t, name)[0]; if (!f) return {}; const l = kids(f, 'a:latin')[0], e = kids(f, 'a:ea')[0]; return { latin: l ? l.getAttribute('typeface') : '', ea: e ? e.getAttribute('typeface') : '' }; };
      theme.major = pick('a:majorFont'); theme.minor = pick('a:minorFont');
    }
    return { slides: parts.slides.length, title, body, theme };
  } finally { zip.close(); }
}

/**
 * 统一字体，另存为 outPath。opts：
 *   title: { latin, ea, size }   标题的西文字体、中文字体、字号（磅；不填则不改）
 *   body:  { latin, ea, size }   正文
 *   tables（默认 true）表格文字按正文处理；masters（默认 true）同时修改母版 / 版式文字样式与主题字体
 */
async function unifyFonts(inPath, outPath, opts = {}) {
  const title = opts.title || {}, body = opts.body || {};
  const zip = await openZip(inPath);
  const stats = { slides: 0, runs: 0, parts: 0, titleShapes: 0, bodyShapes: 0, tables: 0 };
  try {
    const parts = await partsOf(zip);
    const out = new Map();
    const edit = async (part, fn) => {
      const doc = new DOMParser().parseFromString(await zip.text(part), 'text/xml');
      if (fn(doc) !== false) { out.set(part, new XMLSerializer().serializeToString(doc)); stats.parts++; }
    };
    for (const part of parts.slides) {
      await edit(part, (doc) => {
        stats.slides++;
        for (const sp of all(doc, 'p:sp')) {
          const tb = kids(sp, 'p:txBody')[0];
          if (!tb) continue;
          if (isTitleShape(sp)) { stats.titleShapes++; applyTxBody(doc, tb, title, stats); } else { stats.bodyShapes++; applyTxBody(doc, tb, body, stats); }
        }
        if (opts.tables !== false) for (const tbl of all(doc, 'a:tbl')) { stats.tables++; for (const tb of all(tbl, 'a:txBody')) applyTxBody(doc, tb, body, stats); }
      });
    }
    if (opts.masters !== false) {
      // 母版文字样式：titleStyle → 标题，bodyStyle / otherStyle → 正文
      for (const part of parts.masters) {
        await edit(part, (doc) => {
          const styles = all(doc, 'p:txStyles')[0];
          if (!styles) return false;
          for (const [tag, spec] of [['p:titleStyle', title], ['p:bodyStyle', body], ['p:otherStyle', body]]) {
            const st = kids(styles, tag)[0];
            if (st) for (const d of all(st, 'a:defRPr')) applyRun(doc, d, spec, null);
          }
          for (const sp of all(doc, 'p:sp')) { const ls = all(sp, 'a:lstStyle')[0]; if (ls) for (const d of all(ls, 'a:defRPr')) applyRun(doc, d, isTitleShape(sp) ? title : body, null); }
          return true;
        });
      }
      // 版式中占位符自带的列表样式
      for (const part of parts.layouts) {
        await edit(part, (doc) => {
          let any = false;
          for (const sp of all(doc, 'p:sp')) {
            const tb = kids(sp, 'p:txBody')[0];
            const ls = tb && kids(tb, 'a:lstStyle')[0];
            if (ls) for (const d of all(ls, 'a:defRPr')) { applyRun(doc, d, isTitleShape(sp) ? title : body, null); any = true; }
          }
          return any;
        });
      }
      // 主题字体：major（标题）/ minor（正文）
      for (const part of parts.themes) {
        await edit(part, (doc) => {
          let any = false;
          for (const [tag, spec] of [['a:majorFont', title], ['a:minorFont', body]]) {
            const f = all(doc, tag)[0];
            if (!f) continue;
            for (const [k, face] of [['a:latin', spec.latin], ['a:ea', spec.ea]]) {
              const el = kids(f, k)[0];
              if (el && face) { el.setAttribute('typeface', face); for (const a of ['panose', 'pitchFamily', 'charset']) if (el.hasAttribute(a)) el.removeAttribute(a); any = true; }
            }
          }
          return any;
        });
      }
    }
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    const tmp = outPath + '.part';
    const zw = new ZipWriter(tmp);
    try {
      const names = zip.names().filter((n) => !n.endsWith('/'));
      names.sort((a, b) => (a === '[Content_Types].xml' ? -1 : b === '[Content_Types].xml' ? 1 : 0));
      for (const n of names) {
        if (out.has(n)) { zw.addBuffer(n, Buffer.from(out.get(n), 'utf8')); continue; }
        const e = zip.entries.get(n);
        if (e.uncompressedSize > 16 * 1024 * 1024) await zw.addStream(n, await zip.stream(n), e.uncompressedSize, e.crc32);
        else zw.addBuffer(n, await zip.buffer(n), { store: e.compressionMethod === 0 });
      }
      zw.finish();
    } catch (err) { zw.abort(); fs.rmSync(tmp, { force: true }); throw err; }
    fs.renameSync(tmp, outPath);
    return { path: outPath, stats };
  } finally { zip.close(); }
}

module.exports = { analyzeFonts, unifyFonts, isTitleShape };
