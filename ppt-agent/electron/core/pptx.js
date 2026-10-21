'use strict';
// PPTX 按页解析：文字（含表格 / 图表 / SmartArt / 组合）、备注讲解词、背景底色、图片、视频字幕，并生成预览布局。
const fs = require('fs');
const path = require('path');
const posix = path.posix;
const crypto = require('crypto');
const { openZip } = require('./zip');
const { parseXml, child, kids, path: xpath, findAll, findFirst, textOf } = require('./xml');
const { parseSubtitleText, probeMp4, fileReader } = require('./subtitles');
const { imageLuminance } = require('./image');

const REL = {
  slide: '/slide', layout: '/slideLayout', master: '/slideMaster', theme: '/theme', notes: '/notesSlide',
  image: '/image', video: '/video', audio: '/audio', media: '/media', chart: '/chart', diagramData: '/diagramData',
};
const WEB_IMAGES = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.svg', '.webp']);
const VIDEO_EXT = new Set(['.mp4', '.m4v', '.mov', '.wmv', '.avi', '.mkv', '.webm', '.mpg', '.mpeg', '.flv', '.asf']);
const SUB_EXT = ['.srt', '.vtt', '.ttml', '.dfxp'];
const DEFAULT_THEME = { dk1: '000000', lt1: 'FFFFFF', dk2: '44546A', lt2: 'E7E6E6', accent1: '4472C4', accent2: 'ED7D31', accent3: 'A5A5A5', accent4: 'FFC000', accent5: '5B9BD5', accent6: '70AD47', hlink: '0563C1', folHlink: '954F72' };
const DEFAULT_CLRMAP = { bg1: 'lt1', tx1: 'dk1', bg2: 'lt2', tx2: 'dk2', accent1: 'accent1', accent2: 'accent2', accent3: 'accent3', accent4: 'accent4', accent5: 'accent5', accent6: 'accent6', hlink: 'hlink', folHlink: 'folHlink' };

const relsPathOf = (part) => posix.join(posix.dirname(part), '_rels', posix.basename(part) + '.rels');
const resolveTarget = (part, target) => (target.startsWith('/') ? target.slice(1) : posix.normalize(posix.join(posix.dirname(part), target)));

// ---------------- 颜色 ----------------
function hexToRgb(h) { const n = parseInt(h, 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function rgbToHex([r, g, b]) { return [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('').toUpperCase(); }
function rgbToHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0; const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h /= 6;
  }
  return [h, s, l];
}
function hslToRgb([h, s, l]) {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = (t) => { if (t < 0) t += 1; if (t > 1) t -= 1; if (t < 1 / 6) return p + (q - p) * 6 * t; if (t < 1 / 2) return q; if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6; return p; };
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
}
function luminance(hex) {
  if (!hex) return null;
  const [r, g, b] = hexToRgb(hex).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const PRESET = { black: '000000', white: 'FFFFFF', red: 'FF0000', green: '008000', blue: '0000FF', yellow: 'FFFF00', gray: '808080', grey: '808080', darkGray: 'A9A9A9', lightGray: 'D3D3D3', navy: '000080', darkBlue: '00008B', orange: 'FFA500' };

function colorFrom(node, ctx, phClr) {
  if (!node) return null;
  let base = null, mods = [];
  for (const c of node.children) {
    const v = c.attrs.val;
    if (c.tag === 'a:srgbClr') base = v;
    else if (c.tag === 'a:sysClr') base = c.attrs.lastClr || (v === 'window' ? 'FFFFFF' : '000000');
    else if (c.tag === 'a:prstClr') base = PRESET[v] || '808080';
    else if (c.tag === 'a:scrgbClr') base = rgbToHex(['r', 'g', 'b'].map((k) => (Number(c.attrs[k]) / 100000) * 255));
    else if (c.tag === 'a:hslClr') base = rgbToHex(hslToRgb([Number(c.attrs.hue) / 21600000, Number(c.attrs.sat) / 100000, Number(c.attrs.lum) / 100000]));
    else if (c.tag === 'a:schemeClr') {
      if (v === 'phClr') base = phClr || null;
      else { const key = ctx.clrMap[v] || v; base = ctx.theme[key] || null; }
    } else continue;
    mods = c.children;
    break;
  }
  if (!base || !/^[0-9a-fA-F]{6}$/.test(base)) return null;
  let rgb = hexToRgb(base);
  for (const m of mods) {
    const val = Number(m.attrs.val) / 100000;
    if (m.tag === 'a:lumMod' || m.tag === 'a:lumOff') {
      const hsl = rgbToHsl(rgb);
      hsl[2] = m.tag === 'a:lumMod' ? hsl[2] * val : hsl[2] + val;
      hsl[2] = Math.max(0, Math.min(1, hsl[2]));
      rgb = hslToRgb(hsl);
    } else if (m.tag === 'a:tint') rgb = rgb.map((c) => c + (255 - c) * (1 - val));
    else if (m.tag === 'a:shade') rgb = rgb.map((c) => c * val);
  }
  return rgbToHex(rgb);
}

// ---------------- 包读取 ----------------
class Pkg {
  constructor(zip, file) { this.zip = zip; this.file = file; this.cache = new Map(); this.relCache = new Map(); }
  async xml(part) {
    if (!part) return null;
    if (this.cache.has(part)) return this.cache.get(part);
    const t = this.zip.has(part) ? await this.zip.text(part) : null;
    const x = t ? parseXml(t) : null;
    this.cache.set(part, x);
    return x;
  }
  async rels(part) {
    if (this.relCache.has(part)) return this.relCache.get(part);
    const x = await this.xml(relsPathOf(part));
    const list = x ? kids(x, 'Relationship').map((r) => ({
      id: r.attrs.Id, type: r.attrs.Type || '', target: r.attrs.Target || '', external: r.attrs.TargetMode === 'External',
      abs: r.attrs.TargetMode === 'External' ? null : resolveTarget(part, r.attrs.Target || ''),
    })) : [];
    this.relCache.set(part, list);
    return list;
  }
  async relById(part, id) { return (await this.rels(part)).find((r) => r.id === id) || null; }
  async relOfType(part, suffix) { return (await this.rels(part)).find((r) => r.type.endsWith(suffix)) || null; }
}

async function readProps(pkg) {
  const core = await pkg.xml('docProps/core.xml');
  const app = await pkg.xml('docProps/app.xml');
  const g = (n, t) => { const c = n && findFirst(n, t); return c ? textOf(c).trim() : ''; };
  return {
    title: g(core, 'dc:title'), subject: g(core, 'dc:subject'), author: g(core, 'dc:creator'), keywords: g(core, 'cp:keywords'),
    lastModifiedBy: g(core, 'cp:lastModifiedBy'), created: g(core, 'dcterms:created'), modified: g(core, 'dcterms:modified'),
    app: g(app, 'Application'), company: g(app, 'Company'),
  };
}

/** 只读取作者等核心属性，用于去重指纹（不做完整解析） */
async function quickProps(file) {
  const zip = await openZip(file);
  try { return await readProps(new Pkg(zip, file)); } finally { zip.close(); }
}

async function loadTheme(pkg, masterPart) {
  const rel = await pkg.relOfType(masterPart, REL.theme);
  const x = rel && await pkg.xml(rel.abs);
  const theme = { ...DEFAULT_THEME };
  const scheme = x && findFirst(x, 'a:clrScheme');
  if (scheme) {
    for (const c of scheme.children) {
      const k = c.tag.replace('a:', '');
      const col = c.children[0];
      if (!col) continue;
      if (col.tag === 'a:srgbClr') theme[k] = col.attrs.val;
      else if (col.tag === 'a:sysClr') theme[k] = col.attrs.lastClr || (col.attrs.val === 'window' ? 'FFFFFF' : '000000');
    }
  }
  const lst = x && findFirst(x, 'a:bgFillStyleLst');
  const latin = x && findFirst(findFirst(x, 'a:majorFont'), 'a:latin');
  return { theme, themePart: rel ? rel.abs : null, bgStyles: lst ? lst.children.filter((c) => c.tag !== '#text') : [], majorFont: latin ? latin.attrs.typeface : '' };
}

function clrMapOf(masterX, overrideX) {
  const map = { ...DEFAULT_CLRMAP };
  const m = masterX && child(masterX, 'p:clrMap');
  if (m) Object.assign(map, m.attrs);
  const ov = overrideX && xpath(overrideX, 'p:clrMapOvr', 'a:overrideClrMapping');
  if (ov) Object.assign(map, ov.attrs);
  return map;
}

// ---------------- 背景 ----------------
async function fillInfo(pkg, part, fillParent, ctx, phClr) {
  if (!fillParent) return null;
  for (const f of fillParent.children) {
    if (f.tag === 'a:solidFill') { const c = colorFrom(f, ctx, phClr); return c ? { color: c } : null; }
    if (f.tag === 'a:gradFill') {
      const stops = findAll(f, 'a:gs').map((gs) => colorFrom(gs, ctx, phClr)).filter(Boolean);
      if (!stops.length) return null;
      const avg = stops.map(hexToRgb).reduce((a, b) => a.map((v, i) => v + b[i]), [0, 0, 0]).map((v) => v / stops.length);
      return { color: rgbToHex(avg), gradient: stops };
    }
    if (f.tag === 'a:blipFill') {
      const blip = child(f, 'a:blip');
      const rid = blip && blip.attrs['r:embed'];
      const rel = rid && await pkg.relById(part, rid);
      return rel && rel.abs ? { image: rel.abs } : null;
    }
    if (f.tag === 'a:pattFill') { const c = colorFrom(child(f, 'a:bgClr'), ctx, phClr); return c ? { color: c } : null; }
    if (f.tag === 'a:noFill') return null;
  }
  return null;
}

async function bgOfPart(pkg, part, x, ctx) {
  const bg = xpath(x, 'p:cSld', 'p:bg');
  if (!bg) return null;
  const bgPr = child(bg, 'p:bgPr');
  if (bgPr) return fillInfo(pkg, part, bgPr, ctx);
  const ref = child(bg, 'p:bgRef');
  if (ref) {
    const idx = Number(ref.attrs.idx || 0);
    const phClr = colorFrom(ref, ctx);
    const style = idx >= 1001 ? ctx.bgStyles[idx - 1001] : null;
    if (style) {
      const r = await fillInfo(pkg, ctx.themePart || part, { children: [style] }, ctx, phClr);
      if (r) return r;
    }
    return phClr ? { color: phClr } : null;
  }
  return null;
}

// ---------------- 形状与文字 ----------------
function xfrmOf(spPr) {
  const x = spPr && child(spPr, 'a:xfrm');
  if (!x) return null;
  const off = child(x, 'a:off'), ext = child(x, 'a:ext');
  if (!off || !ext) return null;
  const r = { x: Number(off.attrs.x), y: Number(off.attrs.y), w: Number(ext.attrs.cx), h: Number(ext.attrs.cy) };
  const chOff = child(x, 'a:chOff'), chExt = child(x, 'a:chExt');
  if (chOff && chExt) r.ch = { x: Number(chOff.attrs.x), y: Number(chOff.attrs.y), w: Number(chExt.attrs.cx) || 1, h: Number(chExt.attrs.cy) || 1 };
  return r;
}

function applyGroup(box, tf) {
  if (!box || !tf) return box;
  const sx = tf.w / tf.ch.w, sy = tf.h / tf.ch.h;
  return { x: tf.x + (box.x - tf.ch.x) * sx, y: tf.y + (box.y - tf.ch.y) * sy, w: box.w * sx, h: box.h * sy };
}

function phKey(ph) { return ph ? `${ph.attrs.type || 'body'}|${ph.attrs.idx || ''}` : null; }

function placeholderMap(x) {
  const map = new Map();
  if (!x) return map;
  for (const sp of findAll(xpath(x, 'p:cSld', 'p:spTree'), 'p:sp')) {
    const ph = findFirst(child(sp, 'p:nvSpPr'), 'p:ph');
    if (!ph) continue;
    const box = xfrmOf(child(sp, 'p:spPr'));
    if (!box) continue;
    const type = ph.attrs.type || 'body';
    map.set(`${type}|${ph.attrs.idx || ''}`, box);
    if (!map.has(`${type}|`)) map.set(`${type}|`, box);
    if (ph.attrs.idx && !map.has(`idx|${ph.attrs.idx}`)) map.set(`idx|${ph.attrs.idx}`, box);
  }
  return map;
}

function lookupPh(ph, maps) {
  if (!ph) return null;
  const type = ph.attrs.type || 'body', idx = ph.attrs.idx || '';
  for (const m of maps) {
    const b = m.get(`${type}|${idx}`) || (idx && m.get(`idx|${idx}`)) || m.get(`${type}|`);
    if (b) return b;
  }
  if (type === 'ctrTitle') return lookupPh({ attrs: { type: 'title' } }, maps);
  if (type === 'subTitle') return lookupPh({ attrs: { type: 'body', idx } }, maps);
  return null;
}

function paragraphs(txBody, ctx, defaults) {
  const out = [];
  if (!txBody) return out;
  for (const p of kids(txBody, 'a:p')) {
    const pPr = child(p, 'a:pPr');
    const lvl = Number((pPr && pPr.attrs.lvl) || 0);
    const runs = [];
    for (const r of p.children) {
      if (r.tag === 'a:r' || r.tag === 'a:fld') {
        const rPr = child(r, 'a:rPr');
        const t = textOf(child(r, 'a:t'));
        if (!t) continue;
        const sz = rPr && rPr.attrs.sz ? Number(rPr.attrs.sz) / 100 : null;
        const color = rPr ? colorFrom(child(rPr, 'a:solidFill'), ctx) : null;
        runs.push({ text: t, sz, color, b: rPr && rPr.attrs.b === '1', i: rPr && rPr.attrs.i === '1' });
      } else if (r.tag === 'a:br') runs.push({ text: '\n' });
    }
    const text = runs.map((r) => r.text).join('');
    let bullet = defaults.bullet;
    if (pPr) {
      if (child(pPr, 'a:buNone')) bullet = false;
      else if (child(pPr, 'a:buChar') || child(pPr, 'a:buAutoNum')) bullet = child(pPr, 'a:buAutoNum') ? 'num' : true;
    }
    out.push({ text, lvl, runs, algn: pPr && pPr.attrs.algn, bullet });
  }
  return out;
}

async function chartInfo(pkg, part, rid) {
  const rel = await pkg.relById(part, rid);
  const x = rel && await pkg.xml(rel.abs);
  if (!x) return { title: '', series: [], categories: [] };
  const titleNode = findFirst(x, 'c:title');
  const title = titleNode ? findAll(titleNode, 'a:t').map(textOf).join('') : '';
  const series = [], categories = new Set();
  for (const ser of findAll(x, 'c:ser')) {
    const tx = child(ser, 'c:tx');
    const name = tx ? findAll(tx, 'c:v').map(textOf).join('') : '';
    const vals = findAll(child(ser, 'c:val'), 'c:v').map(textOf);
    for (const v of findAll(child(ser, 'c:cat'), 'c:v')) categories.add(textOf(v));
    series.push({ name, values: vals.slice(0, 50) });
  }
  const typeNode = findFirst(x, 'c:plotArea');
  const kind = typeNode ? (typeNode.children.find((c) => /Chart$/.test(c.tag)) || {}).tag : '';
  return { title, series, categories: [...categories].slice(0, 50), kind: (kind || '').replace('c:', '') };
}

async function diagramText(pkg, part, gd) {
  const relIds = findFirst(gd, 'dgm:relIds');
  const rid = relIds && relIds.attrs['r:dm'];
  const rel = rid && await pkg.relById(part, rid);
  const x = rel && await pkg.xml(rel.abs);
  if (!x) return [];
  const pts = findAll(x, 'dgm:pt').filter((pt) => !pt.attrs.type || pt.attrs.type === 'node');
  return pts.map((pt) => findAll(pt, 'a:t').map(textOf).join('').trim()).filter(Boolean);
}

// ---------------- 媒体 ----------------
async function extractImage(pkg, abs, mediaDir, key) {
  if (!abs || !mediaDir) return null;
  const ext = posix.extname(abs).toLowerCase();
  if (!WEB_IMAGES.has(ext) || !pkg.zip.has(abs)) return null;
  const size = pkg.zip.size(abs);
  if (size > 30 * 1024 * 1024) return null;
  const dir = path.join(mediaDir, key);
  const name = posix.basename(abs);
  const dest = path.join(dir, name);
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(dest, await pkg.zip.buffer(abs));
  }
  return `${key}/${name}`;
}

async function readSubtitleFile(p) {
  try { return parseSubtitleText(fs.readFileSync(p, 'utf8'), p); } catch { return []; }
}

async function videoInfo(pkg, part, rel, opts) {
  const v = { type: 'video', name: posix.basename(rel.target.replace(/\\/g, '/')), external: rel.external, size: 0, duration: 0, subtitles: [] };
  const ext = posix.extname(v.name).toLowerCase();
  v.type = ['.mp3', '.wav', '.wma', '.m4a', '.aac'].includes(ext) || rel.type.endsWith(REL.audio) ? 'audio' : 'video';
  let localFile = null;
  if (rel.external) {
    let t = decodeURIComponent(rel.target.replace(/^file:\/\/\/?/i, ''));
    if (!/^[a-zA-Z]:|^\//.test(t) || (process.platform !== 'win32' && /^[a-zA-Z]:/.test(t))) t = path.resolve(path.dirname(pkg.file), t.replace(/\\/g, path.sep));
    v.path = t;
    if (fs.existsSync(t)) { localFile = t; v.size = fs.statSync(t).size; } else {
      const alt = path.join(path.dirname(pkg.file), path.basename(t.replace(/\\/g, '/')));
      if (fs.existsSync(alt)) { localFile = alt; v.path = alt; v.size = fs.statSync(alt).size; } else v.missing = true;
    }
  } else {
    v.size = pkg.zip.size(rel.abs);
    v.part = rel.abs;
  }
  // 内封字幕（mp4 文本轨）——按区间读取，不解码视频
  if (['.mp4', '.m4v', '.mov', '.3gp'].includes(ext) || (!ext && !rel.external)) {
    try {
      const reader = localFile ? fileReader(localFile) : await pkg.zip.rangeReader(rel.abs);
      if (reader) {
        try {
          const info = await probeMp4(reader);
          v.duration = info.duration;
          v.subtitles.push(...info.subtitles);
        } finally { if (reader.close) reader.close(); }
      }
    } catch (e) { opts.log && opts.log.warn(`读取视频元数据失败 ${v.name}`, e); }
  }
  // 外链视频旁的同名字幕文件
  if (localFile) {
    const base = localFile.replace(/\.[^.\\/]+$/, '');
    for (const se of SUB_EXT) {
      for (const cand of [base + se, base + '.zh' + se, base + '.en' + se]) {
        if (fs.existsSync(cand)) {
          const cues = await readSubtitleFile(cand);
          if (cues.length) v.subtitles.push({ source: '外挂字幕 ' + path.basename(cand), cues });
        }
      }
    }
  }
  // 其他封装格式：使用 ffmpeg 仅提取字幕流
  if (!v.subtitles.length && v.type === 'video' && opts.ffmpeg && !['.mp4', '.m4v', '.mov'].includes(ext)) {
    try {
      const cues = await opts.ffmpeg(localFile, localFile ? null : { pkg, part: rel.abs });
      if (cues && cues.length) v.subtitles.push({ source: 'ffmpeg 提取字幕流', cues });
    } catch (e) { opts.log && opts.log.warn(`ffmpeg 提取字幕失败 ${v.name}`, e); }
  }
  return v;
}

// ---------------- 单页解析 ----------------
async function parseSlide(pkg, part, index, ctxBase, opts) {
  const x = await pkg.xml(part);
  if (!x) throw new Error('幻灯片部件缺失 ' + part);
  const layoutRel = await pkg.relOfType(part, REL.layout);
  const layoutPart = layoutRel && layoutRel.abs;
  const layoutX = await pkg.xml(layoutPart);
  const masterRel = layoutPart && await pkg.relOfType(layoutPart, REL.master);
  const masterPart = masterRel && masterRel.abs;
  const masterX = await pkg.xml(masterPart);
  if (!ctxBase.masters.has(masterPart)) ctxBase.masters.set(masterPart, await loadTheme(pkg, masterPart));
  const th = ctxBase.masters.get(masterPart);
  const ctx = { theme: th.theme, themePart: th.themePart, bgStyles: th.bgStyles, clrMap: clrMapOf(masterX, x) };
  if (layoutX && xpath(layoutX, 'p:clrMapOvr', 'a:overrideClrMapping') && !xpath(x, 'p:clrMapOvr', 'a:overrideClrMapping')) ctx.clrMap = clrMapOf(masterX, layoutX);

  const slide = {
    index, part, hidden: x.attrs.show === '0', layoutName: (layoutX && xpath(layoutX, 'p:cSld') && xpath(layoutX, 'p:cSld').attrs.name) || '',
    title: '', blocks: [], media: [], notes: '', errors: [],
  };
  const { cx: W, cy: H } = ctxBase.size;
  const phMaps = [placeholderMap(layoutX), placeholderMap(masterX)];
  const items = [];
  const textColors = [];
  const key = opts.mediaKey;

  // 背景：幻灯片 → 版式 → 母版
  let bg = (await bgOfPart(pkg, part, x, ctx)) || null, bgSrc = 'slide';
  if (!bg && layoutX) { bg = await bgOfPart(pkg, layoutPart, layoutX, ctx); bgSrc = 'layout'; }
  if (!bg && masterX) { bg = await bgOfPart(pkg, masterPart, masterX, ctx); bgSrc = 'master'; }
  if (!bg) { bg = { color: ctx.theme[ctx.clrMap.bg1] || 'FFFFFF' }; bgSrc = 'default'; }
  if (bg.image) {
    const img = bg.image;
    bg.imageUrl = await extractImage(pkg, img, opts.mediaDir, key);
    try { bg.lum = await imageLuminance(await pkg.zip.buffer(img, 40 * 1024 * 1024), img); } catch { bg.lum = null; }
  } else bg.lum = luminance(bg.color);
  bg.source = bgSrc;

  const defaultTextColor = ctx.theme[ctx.clrMap.tx1] || '000000';

  async function walk(tree, groupTf) {
    for (const node of tree.children) {
      let n = node;
      if (n.tag === 'mc:AlternateContent') {
        const choice = child(n, 'mc:Choice') || child(n, 'mc:Fallback');
        if (choice) await walk(choice, groupTf);
        continue;
      }
      if (n.tag === 'p:grpSp') {
        const tf = xfrmOf(child(n, 'p:grpSpPr'));
        const eff = tf && tf.ch ? { ...applyGroup({ x: tf.x, y: tf.y, w: tf.w, h: tf.h }, groupTf), ch: tf.ch } : groupTf;
        await walk(n, eff && eff.ch ? eff : groupTf);
        continue;
      }
      try {
        if (n.tag === 'p:sp') await onShape(n, groupTf);
        else if (n.tag === 'p:pic') await onPic(n, groupTf);
        else if (n.tag === 'p:graphicFrame') await onFrame(n, groupTf);
      } catch (e) { slide.errors.push(`${n.tag}: ${e.message}`); }
    }
  }

  function boxFor(node, prName, ph, groupTf) {
    let box = xfrmOf(child(node, prName));
    if (!box && ph) box = lookupPh(ph, phMaps);
    return box ? applyGroup(box, groupTf) : null;
  }

  async function onShape(sp, groupTf) {
    const nv = child(sp, 'p:nvSpPr');
    const ph = findFirst(nv, 'p:ph');
    const type = ph ? (ph.attrs.type || 'body') : null;
    if (['sldNum', 'dt', 'ftr', 'hdr'].includes(type)) return;
    const isTextBox = child(nv, 'p:cNvSpPr') && child(nv, 'p:cNvSpPr').attrs.txBox === '1';
    const box = boxFor(sp, 'p:spPr', ph, groupTf);
    const isTitle = type === 'title' || type === 'ctrTitle';
    const paras = paragraphs(child(sp, 'p:txBody'), ctx, { bullet: type === 'body' || (ph && !type) || (ph && type === 'obj') ? true : false });
    const fill = await fillInfo(pkg, part, child(sp, 'p:spPr'), ctx);
    const styleFill = !fill && findFirst(child(sp, 'p:style'), 'a:fillRef');
    const shapeFill = fill ? fill.color : (styleFill && Number(styleFill.attrs.idx) > 0 ? colorFrom(styleFill, ctx) : null);
    const text = paras.map((p) => p.text).join('\n').trim();
    for (const p of paras) for (const r of p.runs) if (r.color && r.text.trim()) textColors.push({ c: r.color, w: r.text.length, onFill: !!shapeFill });
    if (box) items.push({ t: 'text', ...box, paras, fill: shapeFill, title: isTitle, ph: type, tb: isTextBox });
    if (!text) return;
    if (isTitle && !slide.title) slide.title = text.replace(/\s*\n\s*/g, ' ');
    slide.blocks.push({ kind: isTitle ? 'title' : (type === 'subTitle' ? 'subtitle' : 'text'), paras: paras.filter((p) => p.text.trim()).map((p) => ({ text: p.text, lvl: p.lvl, bullet: p.bullet })), maxSz: Math.max(0, ...paras.flatMap((p) => p.runs.map((r) => r.sz || 0))), y: box ? box.y : 0 });
  }

  async function onPic(pic, groupTf) {
    const nv = child(pic, 'p:nvPicPr');
    const cNv = child(nv, 'p:cNvPr') || { attrs: {} };
    const nvPr = child(nv, 'p:nvPr');
    const box = boxFor(pic, 'p:spPr', findFirst(nvPr, 'p:ph'), groupTf);
    const blip = findFirst(child(pic, 'p:blipFill'), 'a:blip');
    const rid = blip && (blip.attrs['r:embed'] || blip.attrs['r:link']);
    const imgRel = rid && await pkg.relById(part, rid);
    const src = imgRel && imgRel.abs ? await extractImage(pkg, imgRel.abs, opts.mediaDir, key) : null;
    const vNode = findFirst(nvPr, 'a:videoFile') || findFirst(nvPr, 'a:audioFile') || findFirst(nvPr, 'a:quickTimeFile');
    const mNode = findFirst(nvPr, 'p14:media');
    const desc = cNv.attrs.descr || '';
    if (vNode || mNode) {
      const ids = [mNode && mNode.attrs['r:embed'], mNode && mNode.attrs['r:link'], vNode && (vNode.attrs['r:link'] || vNode.attrs['r:embed'])].filter(Boolean);
      let mediaRel = null;
      for (const id of ids) { mediaRel = await pkg.relById(part, id); if (mediaRel && !(mediaRel.external && ids.length > 1 && mediaRel.target === 'NULL')) break; }
      if (mediaRel) {
        const v = await videoInfo(pkg, part, mediaRel, opts);
        v.title = desc || cNv.attrs.name || '';
        slide.media.push(v);
        slide.blocks.push({ kind: v.type, media: v, y: box ? box.y : 0 });
        if (box) items.push({ t: 'video', ...box, poster: src, name: v.name, mtype: v.type });
        return;
      }
    }
    const imgName = imgRel ? posix.basename(imgRel.target) : '';
    slide.blocks.push({ kind: 'image', name: imgName, alt: desc, src, y: box ? box.y : 0 });
    if (box) items.push({ t: 'pic', ...box, src, name: imgName });
    if (box && imgRel && imgRel.abs && index && box.w * box.h >= 0.85 * W * H && items.filter((i) => i.t !== 'text' || i.paras.some((p) => p.text.trim())).length <= 1) {
      // 铺满整页的图片视为背景
      try {
        const lum = await imageLuminance(await pkg.zip.buffer(imgRel.abs, 40 * 1024 * 1024), imgRel.abs);
        if (lum !== null) { bg.lum = lum; bg.source = 'full-picture'; }
      } catch { /* 无法解码的图片格式 */ }
    }
  }

  async function onFrame(gf, groupTf) {
    const box = boxFor(gf, 'p:xfrm', null, groupTf);
    const gd = findFirst(gf, 'a:graphicData');
    const uri = gd ? gd.attrs.uri || '' : '';
    if (uri.endsWith('/table')) {
      const rows = findAll(gd, 'a:tr').map((tr) => kids(tr, 'a:tc').filter((tc) => !tc.attrs.hMerge && !tc.attrs.vMerge).map((tc) => findAll(tc, 'a:p').map((p) => findAll(p, 'a:t').map(textOf).join('')).join(' ').trim()));
      for (const t of findAll(gd, 'a:rPr')) { const c = colorFrom(child(t, 'a:solidFill'), ctx); if (c) textColors.push({ c, w: 3, onFill: true }); }
      slide.blocks.push({ kind: 'table', rows, y: box ? box.y : 0 });
      if (box) items.push({ t: 'table', ...box, rows });
    } else if (uri.endsWith('/chart')) {
      const c = findFirst(gd, 'c:chart');
      const info = c ? await chartInfo(pkg, part, c.attrs['r:id']) : { title: '', series: [], categories: [] };
      slide.blocks.push({ kind: 'chart', chart: info, y: box ? box.y : 0 });
      if (box) items.push({ t: 'chart', ...box, title: info.title || info.series.map((s) => s.name).join(' / '), kind: info.kind });
    } else if (uri.endsWith('/diagram')) {
      const texts = await diagramText(pkg, part, gd);
      slide.blocks.push({ kind: 'smartart', items: texts, y: box ? box.y : 0 });
      if (box) items.push({ t: 'text', ...box, paras: texts.map((tx) => ({ text: tx, runs: [{ text: tx }], lvl: 0, bullet: true })), fill: null });
    } else {
      const name = (findFirst(gf, 'p:cNvPr') || { attrs: {} }).attrs.name || '对象';
      slide.blocks.push({ kind: 'object', name, y: box ? box.y : 0 });
      if (box) items.push({ t: 'shape', ...box, label: name });
    }
  }

  await walk(xpath(x, 'p:cSld', 'p:spTree') || { children: [] }, null);

  // 字幕部件（PowerPoint 隐藏式字幕 / 任意关联的字幕文件）
  for (const rel of await pkg.rels(part)) {
    const ext = posix.extname(rel.target).toLowerCase();
    if (!rel.external && (SUB_EXT.includes(ext) || /caption/i.test(rel.type))) {
      const t = await pkg.zip.text(rel.abs);
      const cues = t ? parseSubtitleText(t, ext) : [];
      if (!cues.length) continue;
      const target = slide.media.find((m) => m.type === 'video') || null;
      if (target) target.subtitles.push({ source: '隐藏式字幕 ' + posix.basename(rel.target), cues });
      else slide.media.push({ type: 'caption', name: posix.basename(rel.target), subtitles: [{ source: '字幕文件', cues }] });
    }
  }

  // 标题兜底：最大字号的短文本
  if (!slide.title) {
    const cand = slide.blocks.filter((b) => (b.kind === 'text' || b.kind === 'subtitle') && b.paras.length)
      .map((b) => ({ t: b.paras[0].text.trim(), sz: b.maxSz, y: b.y })).filter((c) => c.t && c.t.length <= 60);
    cand.sort((a, b) => (b.sz - a.sz) || (a.y - b.y));
    if (cand.length && (cand[0].sz >= 20 || cand.length === 1 || !cand[0].sz)) slide.title = cand[0].t;
  }

  // 备注讲解词
  const notesRel = await pkg.relOfType(part, REL.notes);
  if (notesRel) {
    const nx = await pkg.xml(notesRel.abs);
    const parts = [];
    for (const sp of findAll(nx, 'p:sp')) {
      const ph = findFirst(child(sp, 'p:nvSpPr'), 'p:ph');
      const t = ph ? (ph.attrs.type || (ph.attrs.idx === '1' ? 'body' : 'other')) : 'body';
      if (t !== 'body') continue;
      const paras = kids(child(sp, 'p:txBody'), 'a:p').map((p) => p.children.map((r) => (r.tag === 'a:br' ? '\n' : (r.tag === 'a:r' || r.tag === 'a:fld') ? textOf(child(r, 'a:t')) : '')).join(''));
      parts.push(paras.join('\n'));
    }
    slide.notes = parts.join('\n').split('\n').filter((l) => !/^\s*(<number>|<页码>|‹#›|\d{1,3})\s*$/.test(l)).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  // 黑底 / 白底判断：背景亮度优先，无法判断时参考文字颜色
  let lum = bg.lum;
  const freeText = textColors.filter((t) => !t.onFill);
  if (freeText.length) {
    const total = freeText.reduce((a, t) => a + t.w, 0);
    const tl = freeText.reduce((a, t) => a + luminance(t.c) * t.w, 0) / total;
    slide.textLum = tl;
    if (lum === null || lum === undefined) lum = tl > 0.5 ? 0.05 : 0.9;
  }
  if (lum === null || lum === undefined) lum = luminance(defaultTextColor) > 0.5 ? 0.05 : 0.9;
  slide.bg = { color: bg.color ? '#' + bg.color : null, image: bg.imageUrl || null, lum: Math.round(lum * 1000) / 1000, source: bg.source };
  slide.theme = lum < 0.3 ? 'dark' : 'light';
  slide.layout = {
    w: W, h: H, bg: slide.bg, textColor: '#' + defaultTextColor, font: th.majorFont,
    items: items.map((it) => ({ ...it, x: it.x / W, y: it.y / H, w: it.w / W, h: it.h / H })),
  };
  slide.text = blocksToText(slide.blocks.filter((b) => b.kind !== 'title'));
  return slide;
}

function blocksToText(blocks) {
  const lines = [];
  for (const b of blocks) {
    if (b.paras) lines.push(...b.paras.map((p) => p.text));
    else if (b.kind === 'table') lines.push(...b.rows.map((r) => r.join(' | ')));
    else if (b.kind === 'chart') lines.push([b.chart.title, ...b.chart.series.map((s) => s.name), ...b.chart.categories].filter(Boolean).join(' '));
    else if (b.kind === 'smartart') lines.push(...b.items);
    else if (b.kind === 'image' && b.alt) lines.push(b.alt);
    else if ((b.kind === 'video' || b.kind === 'audio') && b.media) {
      lines.push(b.media.title || b.media.name);
      for (const s of b.media.subtitles) lines.push(s.cues.map((c) => c.text).join(' '));
    }
  }
  return lines.filter((l) => l && l.trim()).join('\n');
}

async function presentationInfo(pkg) {
  const presPart = 'ppt/presentation.xml';
  const px = await pkg.xml(presPart);
  if (!px) throw new Error('不是有效的 PPTX：缺少 ppt/presentation.xml');
  const sz = child(px, 'p:sldSz');
  const size = { cx: Number(sz ? sz.attrs.cx : 9144000), cy: Number(sz ? sz.attrs.cy : 6858000) };
  const slides = [];
  const idToPart = new Map();
  for (const sid of kids(child(px, 'p:sldIdLst'), 'p:sldId')) {
    const rel = await pkg.relById(presPart, sid.attrs['r:id']);
    if (rel && rel.abs) { slides.push(rel.abs); idToPart.set(sid.attrs.id, rel.abs); }
  }
  const sections = new Map();
  for (const sec of findAll(px, 'p14:section')) for (const s of findAll(sec, 'p14:sldId')) if (idToPart.has(s.attrs.id)) sections.set(idToPart.get(s.attrs.id), sec.attrs.name || '');
  return { size, slides, sections };
}

/**
 * 解析 PPTX。
 * opts: { mediaDir, mediaKey, log, ffmpeg(localFile, {pkg, part}) }
 */
async function parsePptx(file, opts = {}) {
  const zip = await openZip(file);
  const pkg = new Pkg(zip, file);
  try {
    const props = await readProps(pkg);
    const info = await presentationInfo(pkg);
    const mediaKey = opts.mediaKey || crypto.createHash('sha1').update(file).digest('hex').slice(0, 16);
    const ctxBase = { size: info.size, masters: new Map() };
    const slides = [];
    for (let i = 0; i < info.slides.length; i++) {
      try {
        const s = await parseSlide(pkg, info.slides[i], i + 1, ctxBase, { ...opts, mediaKey });
        s.section = info.sections.get(info.slides[i]) || '';
        slides.push(s);
        if (opts.onSlide) opts.onSlide(i + 1, info.slides.length, s.title, s);
      } catch (e) {
        opts.log && opts.log.warn(`第 ${i + 1} 页解析失败: ${file}`, e);
        slides.push({ index: i + 1, part: info.slides[i], title: '', blocks: [], media: [], notes: '', text: '', errors: [e.message], theme: 'light', bg: { lum: 1 }, layout: null });
      }
      if (i % 20 === 19) await new Promise((r) => setImmediate(r));
    }
    return { props, size: info.size, slides, mediaKey };
  } finally {
    zip.close();
  }
}

module.exports = { parsePptx, quickProps, blocksToText, luminance };
