'use strict';
// PPT 黑白底互转：在 OOXML 层面重写背景、文字、图形、表格框线与 logo 颜色。
// 黑底→白底：背景白；文字黑，原彩色文字→深红；表格框线浅灰；图形填充/线条浅灰；小图片（logo）重着色为深红。
// 白底→黑底：背景黑；文字白；图形去填充（透明）并改为白色线框；表格去填充、框线白色。
const fs = require('fs');
const path = require('path');
const posix = path.posix;
const { DOMParser, XMLSerializer } = require('@xmldom/xmldom');
const { openZip } = require('./zip');
const { ZipWriter } = require('./zipwriter');

const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const NS_P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_C = 'http://schemas.openxmlformats.org/drawingml/2006/chart';

// 默认转换规则（可在界面“转换规则设置”中编辑，保存为规则脚本 convert-rules.json，下次转换生效）
// null 表示“无 / 透明”。logoMaxArea：小于该页面面积比例的图片视为 logo；fullBgMinArea：大于该比例的图片视为整页背景
const RULES = {
  version: 1,
  toLight: { bg: 'FFFFFF', text: '000000', accentText: 'C00000', shapeFill: 'D9D9D9', shapeLine: 'BFBFBF', tableLine: 'BFBFBF', headerFill: 'F2F2F2', logo: 'C00000', custom: [] },
  // 白底 → 黑底：原深红色字（如黑转白时生成的 C00000）显示为金色 FFC000
  toDark: { bg: '000000', text: 'FFFFFF', accentText: 'FFFFFF', shapeFill: null, shapeLine: 'FFFFFF', tableLine: 'FFFFFF', headerFill: null, logo: null, custom: [{ el: 'text', from: 'C00000', tol: 60, to: 'FFC000', note: '原深红色字显示为金色', enabled: true }] },
  options: { logoMaxArea: 0.06, fullBgMinArea: 0.85, removeFullBg: true, keepAccentText: true },
};
// 自定义规则可作用的元素
const CUSTOM_ELEMENTS = { text: '文字', shapeFill: '图形填充', shapeLine: '图形线条 / 连接线', tableLine: '表格框线', tableFill: '表格单元格填充' };
const FILL_TAGS = new Set(['a:noFill', 'a:solidFill', 'a:gradFill', 'a:blipFill', 'a:pattFill', 'a:grpFill']);
const SPPR_AFTER_FILL = ['a:ln', 'a:effectLst', 'a:effectDag', 'a:scene3d', 'a:sp3d', 'a:extLst'];
const SPPR_AFTER_LN = ['a:effectLst', 'a:effectDag', 'a:scene3d', 'a:sp3d', 'a:extLst'];
const RPR_AFTER_FILL = ['a:effectLst', 'a:effectDag', 'a:highlight', 'a:uLnTx', 'a:uLn', 'a:uFillTx', 'a:uFill', 'a:latin', 'a:ea', 'a:cs', 'a:sym', 'a:hlinkClick', 'a:hlinkMouseOver', 'a:rtl', 'a:extLst'];

const relsPathOf = (part) => posix.join(posix.dirname(part), '_rels', posix.basename(part) + '.rels');
const resolveTarget = (part, target) => (target.startsWith('/') ? target.slice(1) : posix.normalize(posix.join(posix.dirname(part), target)));

const elems = (node) => { const out = []; for (let c = node.firstChild; c; c = c.nextSibling) if (c.nodeType === 1) out.push(c); return out; };
const childEl = (node, tag) => elems(node).find((c) => c.nodeName === tag) || null;
const all = (node, tag) => Array.from(node.getElementsByTagName(tag));

function make(doc, tag, attrs = {}, kids = []) {
  const ns = tag.startsWith('p:') ? NS_P : NS_A;
  const e = doc.createElementNS(ns, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const k of kids) e.appendChild(k);
  return e;
}
const solid = (doc, hex) => make(doc, 'a:solidFill', {}, [make(doc, 'a:srgbClr', { val: hex })]);

/** 在 parent 中插入 el：放在第一个属于 before 列表的子元素之前，否则追加 */
function insertBefore(parent, el, before) {
  const ref = elems(parent).find((c) => before.includes(c.nodeName));
  if (ref) parent.insertBefore(el, ref); else parent.appendChild(el);
}
function removeFills(parent) { for (const c of elems(parent)) if (FILL_TAGS.has(c.nodeName)) parent.removeChild(c); }

function hexColored(hex) {
  if (!hex || !/^[0-9a-f]{6}$/i.test(hex)) return false;
  const n = parseInt(hex, 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const s = max === min ? 0 : (l > 0.5 ? (max - min) / (2 - max - min) : (max - min) / (max + min));
  return s > 0.25 && l > 0.12 && l < 0.92;
}

/** 文字原颜色是否为“彩色”（非黑/白/灰） */
function isColoredFill(fillParent, theme) {
  const sf = fillParent && childEl(fillParent, 'a:solidFill');
  if (!sf) return false;
  const c = elems(sf)[0];
  if (!c) return false;
  if (c.nodeName === 'a:srgbClr') return hexColored(c.getAttribute('val'));
  if (c.nodeName === 'a:schemeClr') {
    const v = c.getAttribute('val');
    if (/^accent\d$|^hlink$|^folHlink$/.test(v)) return true;
    const map = { tx1: 'dk1', tx2: 'dk2', bg1: 'lt1', bg2: 'lt2' };
    return hexColored(theme[map[v] || v]);
  }
  if (c.nodeName === 'a:prstClr') return !/^(black|white|gray|grey|darkGray|lightGray|dimGray|silver)$/i.test(c.getAttribute('val'));
  return false;
}

// ---------- 自定义规则：按“元素 + 原颜色”匹配，转换为指定颜色 / 保持原色（keep）/ 无（null，透明） ----------
const PRESET = { black: '000000', white: 'FFFFFF', red: 'FF0000', green: '00FF00', blue: '0000FF', yellow: 'FFFF00', gray: '808080', grey: '808080', darkGray: 'A9A9A9', lightGray: 'D3D3D3' };
/** 读出 fillParent 下 solidFill 的颜色（十六进制），主题色按主题解析；没有显式颜色时返回 null */
function colorHex(fillParent, theme) {
  const sf = fillParent && childEl(fillParent, 'a:solidFill');
  const c = sf && elems(sf)[0];
  if (!c) return null;
  if (c.nodeName === 'a:srgbClr') return (c.getAttribute('val') || '').toUpperCase() || null;
  if (c.nodeName === 'a:schemeClr') { const map = { tx1: 'dk1', tx2: 'dk2', bg1: 'lt1', bg2: 'lt2' }; const v = c.getAttribute('val'); return (theme[map[v] || v] || '').toUpperCase() || null; }
  if (c.nodeName === 'a:sysClr') return (c.getAttribute('lastClr') || '').toUpperCase() || null;
  if (c.nodeName === 'a:prstClr') return PRESET[c.getAttribute('val')] || null;
  return null;
}
function hexDist(a, b) {
  const x = parseInt(a, 16), y = parseInt(b, 16);
  return Math.sqrt(((x >> 16) - (y >> 16)) ** 2 + (((x >> 8) & 255) - ((y >> 8) & 255)) ** 2 + ((x & 255) - (y & 255)) ** 2);
}
/** 第一条匹配的自定义规则（from 为 '*' 表示任意颜色，tol 为近似范围 0–255） */
function matchCustom(rule, el, hex) {
  for (const c of rule.custom || []) {
    if (c.el !== el || c.enabled === false) continue;
    if (c.from === '*' || (hex && /^[0-9A-F]{6}$/.test(c.from) && hexDist(hex, c.from) <= (c.tol || 0))) return c;
  }
  return null;
}

function setTextColor(rPr, rule, theme) {
  const doc = rPr.ownerDocument;
  const cus = matchCustom(rule, 'text', colorHex(rPr, theme));
  if (cus) {
    if (cus.to === 'keep') return;
    removeFills(rPr);
    if (cus.to) insertBefore(rPr, solid(doc, cus.to), RPR_AFTER_FILL);
    else insertBefore(rPr, make(doc, 'a:noFill'), RPR_AFTER_FILL);
    rule.stats && (rule.stats.custom = (rule.stats.custom || 0) + 1);
    return;
  }
  const color = rule.keepAccent && isColoredFill(rPr, theme) ? rule.accentText : rule.text;
  removeFills(rPr);
  insertBefore(rPr, solid(doc, color), RPR_AFTER_FILL);
}

function setLine(lnParent, hex, before, tag = 'a:ln', w = null) {
  const doc = lnParent.ownerDocument;
  let ln = childEl(lnParent, tag);
  if (!ln) { ln = make(doc, tag, w ? { w } : {}); insertBefore(lnParent, ln, before); }
  removeFills(ln);
  const fill = hex ? solid(doc, hex) : make(doc, 'a:noFill');
  if (ln.firstChild) ln.insertBefore(fill, ln.firstChild); else ln.appendChild(fill);
  return ln;
}

function hasExplicitFill(spPr) {
  return elems(spPr).some((c) => ['a:solidFill', 'a:gradFill', 'a:pattFill'].includes(c.nodeName));
}
function styleRefIdx(sp, ref) {
  const style = childEl(sp, 'p:style');
  const r = style && childEl(style, ref);
  return r ? Number(r.getAttribute('idx') || 0) : 0;
}

function transformTree(doc, rule, theme, slideArea, stats, options = RULES.options) {
  // 1) 背景
  for (const cSld of all(doc, 'p:cSld')) {
    const old = childEl(cSld, 'p:bg');
    if (old) cSld.removeChild(old);
    const bg = make(doc, 'p:bg', {}, [make(doc, 'p:bgPr', {}, [solid(doc, rule.bg), make(doc, 'a:effectLst')])]);
    cSld.insertBefore(bg, cSld.firstChild);
  }
  // 2) 配色映射覆盖统一回到母版
  for (const ov of all(doc, 'p:clrMapOvr')) {
    while (ov.firstChild) ov.removeChild(ov.firstChild);
    ov.appendChild(make(doc, 'a:masterClrMapping'));
  }
  // 3) 文字：运行属性、段落结束属性、默认文本样式
  for (const r of [...all(doc, 'a:r'), ...all(doc, 'a:fld')]) {
    let rPr = childEl(r, 'a:rPr');
    if (!rPr) { rPr = make(doc, 'a:rPr', { lang: 'zh-CN' }); r.insertBefore(rPr, r.firstChild); }
    setTextColor(rPr, rule, theme); stats.text++;
  }
  for (const tag of ['a:endParaRPr', 'a:defRPr']) for (const e of all(doc, tag)) setTextColor(e, rule, theme);
  // 4) 形状
  for (const sp of all(doc, 'p:sp')) {
    const spPr = childEl(sp, 'p:spPr');
    if (!spPr || childEl(spPr, 'a:blipFill')) continue;
    const filled = hasExplicitFill(spPr) || (!childEl(spPr, 'a:noFill') && styleRefIdx(sp, 'a:fillRef') > 0);
    const lnEl = childEl(spPr, 'a:ln');
    const lined = (lnEl && !childEl(lnEl, 'a:noFill')) || (!lnEl && styleRefIdx(sp, 'a:lnRef') > 0);
    if (!filled && !lined) continue;
    const cf = filled && matchCustom(rule, 'shapeFill', colorHex(spPr, theme));
    const cl = matchCustom(rule, 'shapeLine', lnEl ? colorHex(lnEl, theme) : null);
    if (cf || cl) stats.custom = (stats.custom || 0) + 1;
    if (!(cf && cf.to === 'keep')) {
      removeFills(spPr);
      const fillTo = cf ? cf.to : (filled ? rule.shapeFill : null);
      insertBefore(spPr, fillTo ? solid(doc, fillTo) : make(doc, 'a:noFill'), SPPR_AFTER_FILL);
    }
    if (cl) { if (cl.to !== 'keep') setLine(spPr, cl.to, SPPR_AFTER_LN, 'a:ln', '12700'); }
    else if (lined || (filled && !rule.shapeFill && !cf)) setLine(spPr, rule.shapeLine, SPPR_AFTER_LN, 'a:ln', '12700');
    stats.shapes++;
  }
  // 5) 连接线
  for (const cx of all(doc, 'p:cxnSp')) {
    const spPr = childEl(cx, 'p:spPr');
    if (spPr) {
      const ln = childEl(spPr, 'a:ln');
      const cl = matchCustom(rule, 'shapeLine', ln ? colorHex(ln, theme) : null);
      if (!(cl && cl.to === 'keep')) setLine(spPr, cl ? cl.to : rule.shapeLine, SPPR_AFTER_LN, 'a:ln', '12700');
      stats.shapes++;
    }
  }
  // 6) 表格：框线与单元格填充
  for (const tbl of all(doc, 'a:tbl')) {
    const tblPr = childEl(tbl, 'a:tblPr');
    const firstRow = tblPr && tblPr.getAttribute('firstRow') === '1';
    elems(tbl).filter((e) => e.nodeName === 'a:tr').forEach((tr, ri) => {
      for (const tc of elems(tr).filter((e) => e.nodeName === 'a:tc')) {
        let tcPr = childEl(tc, 'a:tcPr');
        if (!tcPr) { tcPr = make(doc, 'a:tcPr'); tc.appendChild(tcPr); }
        const oldLn = childEl(tcPr, 'a:lnL') || childEl(tcPr, 'a:lnT') || childEl(tcPr, 'a:lnB') || childEl(tcPr, 'a:lnR');
        const cl = matchCustom(rule, 'tableLine', oldLn ? colorHex(oldLn, theme) : null);
        const cf = matchCustom(rule, 'tableFill', colorHex(tcPr, theme));
        if (cl || cf) stats.custom = (stats.custom || 0) + 1;
        for (const c of elems(tcPr)) if ((/^a:ln[LRTB]$/.test(c.nodeName) && !(cl && cl.to === 'keep')) || (FILL_TAGS.has(c.nodeName) && !(cf && cf.to === 'keep'))) tcPr.removeChild(c);
        if (!(cl && cl.to === 'keep')) {
          const lineTo = cl ? cl.to : rule.tableLine;
          const borders = ['a:lnL', 'a:lnR', 'a:lnT', 'a:lnB'].map((t) => make(doc, t, { w: '12700', cap: 'flat', cmpd: 'sng', algn: 'ctr' }, [lineTo ? solid(doc, lineTo) : make(doc, 'a:noFill'), make(doc, 'a:prstDash', { val: 'solid' })]));
          const first = tcPr.firstChild;
          for (const b of borders) tcPr.insertBefore(b, first);
        }
        if (!(cf && cf.to === 'keep')) {
          const fillTo = cf ? cf.to : (firstRow && ri === 0 ? rule.headerFill : null);
          insertBefore(tcPr, fillTo ? solid(doc, fillTo) : make(doc, 'a:noFill'), ['a:headers', 'a:extLst']);
        }
      }
    });
    stats.tables++;
  }
  // 7) 图片：铺满整页的背景图移除；小图片（logo）按规则重着色
  for (const pic of all(doc, 'p:pic')) {
    const isMedia = all(pic, 'a:videoFile').length || all(pic, 'a:audioFile').length || all(pic, 'p14:media').length;
    const ext = all(pic, 'a:ext').find((e) => e.parentNode && e.parentNode.nodeName === 'a:xfrm');
    const area = ext ? Number(ext.getAttribute('cx')) * Number(ext.getAttribute('cy')) : 0;
    if (!isMedia && options.removeFullBg && area >= options.fullBgMinArea * slideArea) { pic.parentNode.removeChild(pic); stats.bgPictures++; continue; }
    if (!isMedia && rule.logo && area > 0 && area <= options.logoMaxArea * slideArea) {
      const blip = all(pic, 'a:blip')[0];
      if (!blip) continue;
      for (const c of elems(blip)) if (['a:duotone', 'a:clrChange', 'a:grayscl', 'a:biLevel'].includes(c.nodeName)) blip.removeChild(c);
      insertBefore(blip, make(doc, 'a:duotone', {}, [make(doc, 'a:srgbClr', { val: 'FFFFFF' }), make(doc, 'a:srgbClr', { val: rule.logo })]), ['a:extLst']);
      stats.logos++;
    }
  }
}

// 图表（chart 部件）：文字颜色、坐标轴与网格线、图表背景
function transformChart(doc, rule, theme, stats) {
  for (const tag of ['a:defRPr', 'a:rPr', 'a:endParaRPr']) for (const e of all(doc, tag)) setTextColor(e, rule, theme);
  const cs = all(doc, 'c:chartSpace')[0];
  if (cs && !elems(cs).some((c) => c.nodeName === 'c:txPr')) {
    // 图表没有统一文字样式时补一个，否则默认黑字在黑底上看不见
    const txPr = doc.createElementNS(NS_C, 'c:txPr');
    const p = make(doc, 'a:p', {}, [make(doc, 'a:pPr', {}, [make(doc, 'a:defRPr', {}, [solid(doc, rule.text)])]), make(doc, 'a:endParaRPr', { lang: 'zh-CN' })]);
    for (const k of [make(doc, 'a:bodyPr'), make(doc, 'a:lstStyle'), p]) txPr.appendChild(k);
    insertBefore(cs, txPr, ['c:externalData', 'c:printSettings', 'c:userShapes', 'c:extLst']);
  }
  for (const spPr of all(doc, 'c:spPr')) {
    const owner = spPr.parentNode && spPr.parentNode.nodeName;
    if (owner === 'c:chartSpace' || owner === 'c:plotArea') { removeFills(spPr); insertBefore(spPr, make(doc, 'a:noFill'), SPPR_AFTER_FILL); }
    else if (['c:majorGridlines', 'c:minorGridlines', 'c:catAx', 'c:valAx', 'c:dateAx', 'c:serAx'].includes(owner)) setLine(spPr, rule.tableLine, SPPR_AFTER_LN);
  }
  stats.charts = (stats.charts || 0) + 1;
}

// SmartArt：绘图部件（dsp:sp）与数据部件中的文字、形状
function transformDiagram(doc, rule, theme, stats) {
  for (const r of [...all(doc, 'a:r'), ...all(doc, 'a:fld')]) {
    let rPr = childEl(r, 'a:rPr');
    if (!rPr) { rPr = make(doc, 'a:rPr', { lang: 'zh-CN' }); r.insertBefore(rPr, r.firstChild); }
    setTextColor(rPr, rule, theme); stats.text++;
  }
  for (const tag of ['a:endParaRPr', 'a:defRPr']) for (const e of all(doc, tag)) setTextColor(e, rule, theme);
  for (const sp of all(doc, 'dsp:sp')) {
    const spPr = childEl(sp, 'dsp:spPr');
    if (!spPr || childEl(spPr, 'a:blipFill')) continue;
    const filled = hasExplicitFill(spPr);
    const lnEl = childEl(spPr, 'a:ln');
    const lined = lnEl && !childEl(lnEl, 'a:noFill');
    if (!filled && !lined) continue;
    removeFills(spPr);
    insertBefore(spPr, rule.shapeFill && filled ? solid(doc, rule.shapeFill) : make(doc, 'a:noFill'), SPPR_AFTER_FILL);
    if (lined || (filled && !rule.shapeFill)) setLine(spPr, rule.shapeLine, SPPR_AFTER_LN, 'a:ln', '12700');
    stats.shapes++;
  }
  stats.diagrams = (stats.diagrams || 0) + 1;
}

function transformMaster(doc, dir) {
  const map = doc.getElementsByTagName('p:clrMap')[0];
  if (!map) return;
  const v = dir === 'toDark' ? { bg1: 'dk1', tx1: 'lt1', bg2: 'dk2', tx2: 'lt2' } : { bg1: 'lt1', tx1: 'dk1', bg2: 'lt2', tx2: 'dk2' };
  for (const [k, val] of Object.entries(v)) map.setAttribute(k, val);
}

function transformTheme(doc) {
  const scheme = doc.getElementsByTagName('a:clrScheme')[0];
  if (!scheme) return;
  const want = { 'a:dk1': '000000', 'a:lt1': 'FFFFFF', 'a:dk2': '262626', 'a:lt2': 'E7E6E6' };
  for (const el of elems(scheme)) {
    if (!want[el.nodeName]) continue;
    while (el.firstChild) el.removeChild(el.firstChild);
    el.appendChild(make(doc, 'a:srgbClr', { val: want[el.nodeName] }));
  }
}

function themeColors(doc) {
  const t = { dk1: '000000', lt1: 'FFFFFF', dk2: '44546A', lt2: 'E7E6E6' };
  const scheme = doc && doc.getElementsByTagName('a:clrScheme')[0];
  if (!scheme) return t;
  for (const el of elems(scheme)) {
    const c = elems(el)[0];
    if (!c) continue;
    t[el.nodeName.replace('a:', '')] = c.getAttribute('val') && c.nodeName === 'a:srgbClr' ? c.getAttribute('val') : (c.getAttribute('lastClr') || t[el.nodeName.replace('a:', '')]);
  }
  return t;
}

/**
 * directions: 数组，按幻灯片顺序给出 'toLight' | 'toDark' | null
 */
async function convertTheme(inPath, outPath, directions, opts = {}) {
  const log = opts.log || { info() {}, warn() {} };
  const zip = await openZip(inPath);
  try {
    const parse = async (part) => new DOMParser().parseFromString(await zip.text(part), 'text/xml');
    const rels = async (part) => {
      if (!zip.has(relsPathOf(part))) return [];
      const d = new DOMParser().parseFromString(await zip.text(relsPathOf(part)), 'text/xml');
      return Array.from(d.getElementsByTagName('Relationship')).map((r) => ({ type: r.getAttribute('Type'), external: r.getAttribute('TargetMode') === 'External', abs: resolveTarget(part, r.getAttribute('Target')) }));
    };
    const pres = await parse('ppt/presentation.xml');
    const presRels = new Map();
    const prDoc = new DOMParser().parseFromString(await zip.text('ppt/_rels/presentation.xml.rels'), 'text/xml');
    for (const r of Array.from(prDoc.getElementsByTagName('Relationship'))) presRels.set(r.getAttribute('Id'), resolveTarget('ppt/presentation.xml', r.getAttribute('Target')));
    const slides = Array.from(pres.getElementsByTagName('p:sldId')).map((s) => presRels.get(s.getAttributeNS(NS_R, 'id') || s.getAttribute('r:id')));
    const sz = pres.getElementsByTagName('p:sldSz')[0];
    const slideArea = sz ? Number(sz.getAttribute('cx')) * Number(sz.getAttribute('cy')) : 9144000 * 5143500;

    // 收集每个部件的转换方向
    const plan = new Map();
    const want = (part, dir, kind) => {
      if (!part || !zip.has(part)) return;
      const cur = plan.get(part);
      if (cur && cur.dir !== dir) { log.warn(`部件 ${part} 同时被要求转为两种底色，保留 ${cur.dir}`); return; }
      plan.set(part, { dir, kind });
    };
    for (let i = 0; i < slides.length; i++) {
      const dir = directions[i];
      if (!dir) continue;
      want(slides[i], dir, 'slide');
      const sRels = await rels(slides[i]);
      for (const r of sRels) {
        if (r.external) continue;
        if (r.type.endsWith('/chart')) want(r.abs, dir, 'chart');
        else if (r.type.endsWith('/diagramDrawing') || r.type.endsWith('/diagramData')) want(r.abs, dir, 'diagram');
      }
      const layout = sRels.find((r) => r.type.endsWith('/slideLayout'));
      if (!layout) continue;
      const master = (await rels(layout.abs)).find((r) => r.type.endsWith('/slideMaster'));
      if (!master) { want(layout.abs, dir, 'layout'); continue; }
      want(master.abs, dir, 'master');
      for (const r of await rels(master.abs)) {
        if (r.type.endsWith('/slideLayout')) want(r.abs, dir, 'layout');
        if (r.type.endsWith('/theme')) want(r.abs, dir, 'theme');
      }
    }
    const themeOf = new Map();
    const stats = { parts: 0, text: 0, shapes: 0, tables: 0, logos: 0, bgPictures: 0, charts: 0, diagrams: 0, custom: 0 };
    const out = new Map();
    // 先读主题原色（用于判断“彩色文字”），再改主题
    for (const [part, p] of plan) if (p.kind === 'theme') themeOf.set(part, themeColors(await parse(part)));
    const anyTheme = themeOf.values().next().value || themeColors(null);
    const rules = normalizeRules(opts.rules);
    for (const [part, p] of plan) {
      const doc = await parse(part);
      if (p.kind === 'theme') transformTheme(doc);
      else if (p.kind === 'chart') transformChart(doc, { ...rules[p.dir], keepAccent: rules.options.keepAccentText, stats }, anyTheme, stats);
      else if (p.kind === 'diagram') transformDiagram(doc, { ...rules[p.dir], keepAccent: rules.options.keepAccentText, stats }, anyTheme, stats);
      else {
        transformTree(doc, { ...rules[p.dir], keepAccent: rules.options.keepAccentText, stats }, anyTheme, slideArea, stats, rules.options);
        if (p.kind === 'master') transformMaster(doc, p.dir);
      }
      out.set(part, new XMLSerializer().serializeToString(doc));
      stats.parts++;
    }
    // 写出：替换转换过的部件，其余原样拷贝
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    const tmp = outPath + '.part';
    const zw = new ZipWriter(tmp);
    try {
      const names = zip.names().filter((n) => !n.endsWith('/'));
      names.sort((a, b) => (a === '[Content_Types].xml' ? -1 : b === '[Content_Types].xml' ? 1 : 0));
      for (const n of names) {
        if (out.has(n)) { zw.addBuffer(n, out.get(n)); continue; }
        const e = zip.entries.get(n);
        if (e.uncompressedSize > 16 * 1024 * 1024) await zw.addStream(n, await zip.stream(n), e.uncompressedSize, e.crc32);
        else zw.addBuffer(n, await zip.buffer(n), { store: e.compressionMethod === 0 });
      }
      zw.finish();
    } catch (err) { zw.abort(); fs.rmSync(tmp, { force: true }); throw err; }
    fs.renameSync(tmp, outPath);
    log.info(`黑白底转换完成：${outPath}（${directions.filter(Boolean).length} 页，改写部件 ${stats.parts} 个，文字 ${stats.text} 处，图形 ${stats.shapes} 个，表格 ${stats.tables} 个，logo ${stats.logos} 个，图表 ${stats.charts || 0} 个，SmartArt ${stats.diagrams || 0} 个，移除整页背景图 ${stats.bgPictures} 张）`);
    return { path: outPath, slides: slides.length, stats };
  } finally { zip.close(); }
}

/** 校验并补全规则脚本 */
function normalizeRules(r) {
  const out = JSON.parse(JSON.stringify(RULES));
  if (!r || typeof r !== 'object') return out;
  const hex = (v, d) => (v === null ? null : typeof v === 'string' && /^#?[0-9a-f]{6}$/i.test(v) ? v.replace('#', '').toUpperCase() : d);
  for (const dir of ['toLight', 'toDark']) {
    for (const k of Object.keys(out[dir])) if (k !== 'custom' && r[dir] && k in r[dir]) out[dir][k] = hex(r[dir][k], out[dir][k]);
    // 自定义规则：[{ el, from: 'RRGGBB' | '*', tol, to: 'RRGGBB' | null | 'keep', note, enabled }]
    // 规则脚本中没有 custom 字段（旧版本保存的规则）时沿用默认的自定义规则
    const list = r[dir] && Array.isArray(r[dir].custom) ? r[dir].custom : out[dir].custom;
    out[dir].custom = list.filter((c) => c && CUSTOM_ELEMENTS[c.el]).slice(0, 100).map((c) => ({
      el: c.el,
      from: c.from === '*' ? '*' : hex(c.from, '*') || '*',
      tol: Math.max(0, Math.min(255, Number(c.tol) || 0)),
      to: c.to === 'keep' ? 'keep' : c.to === null ? null : hex(c.to, 'keep'),
      note: String(c.note || '').slice(0, 200),
      enabled: c.enabled !== false,
    }));
  }
  const o = r.options || {};
  const num = (v, d, lo, hi) => (typeof v === 'number' && v >= lo && v <= hi ? v : d);
  out.options.logoMaxArea = num(o.logoMaxArea, out.options.logoMaxArea, 0, 0.5);
  out.options.fullBgMinArea = num(o.fullBgMinArea, out.options.fullBgMinArea, 0.3, 1);
  if (typeof o.removeFullBg === 'boolean') out.options.removeFullBg = o.removeFullBg;
  if (typeof o.keepAccentText === 'boolean') out.options.keepAccentText = o.keepAccentText;
  if (r.description) out.description = String(r.description).slice(0, 2000);
  out.updatedAt = r.updatedAt || null;
  return out;
}

module.exports = { convertTheme, RULES, normalizeRules, CUSTOM_ELEMENTS };
