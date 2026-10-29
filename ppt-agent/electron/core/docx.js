'use strict';
// Word（.docx）解析：按标题分节（每节相当于 PPT 的一页），提取段落/列表/表格/图片与批注，输出结构与 parsePptx 一致。
const fs = require('fs');
const path = require('path');
const posix = path.posix;
const crypto = require('crypto');
const { openZip } = require('./zip');
const { parseXml, child, kids, findAll, findFirst } = require('./xml');

const WEB_IMAGES = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.svg', '.webp']);
const MAX_SECTION_CHARS = 2500;

const relsPathOf = (part) => posix.join(posix.dirname(part), '_rels', posix.basename(part) + '.rels');
const resolveTarget = (part, target) => (target.startsWith('/') ? target.slice(1) : posix.normalize(posix.join(posix.dirname(part), target)));

async function readXml(zip, part) {
  const t = zip.has(part) ? await zip.text(part) : null;
  return t ? parseXml(t) : null;
}

async function readRels(zip, part) {
  const x = await readXml(zip, relsPathOf(part));
  const m = new Map();
  if (!x) return m;
  for (const r of kids(x, 'Relationship')) {
    m.set(r.attrs.Id, { type: r.attrs.Type || '', target: r.attrs.Target || '', external: r.attrs.TargetMode === 'External', abs: r.attrs.TargetMode === 'External' ? null : resolveTarget(part, r.attrs.Target || '') });
  }
  return m;
}

function readProps(core, app) {
  const g = (n, t) => { const c = n && findFirst(n, t); return c ? textOf(c).trim() : ''; };
  return {
    title: g(core, 'dc:title'), subject: g(core, 'dc:subject'), author: g(core, 'dc:creator'), keywords: g(core, 'cp:keywords'),
    lastModifiedBy: g(core, 'cp:lastModifiedBy'), created: g(core, 'dcterms:created'), modified: g(core, 'dcterms:modified'),
    app: g(app, 'Application'), company: g(app, 'Company'), pages: Number(g(app, 'Pages')) || 0,
  };
}

function textOf(node) {
  if (!node) return '';
  if (node.tag === '#text') return node.text;
  return node.children.map(textOf).join('');
}

/** 样式表：styleId -> 标题级别（1..9，0 表示文档标题） */
function headingLevels(stylesX) {
  const map = new Map();
  if (!stylesX) return map;
  const raw = new Map();
  for (const st of kids(stylesX, 'w:style')) {
    if (st.attrs['w:type'] !== 'paragraph') continue;
    const id = st.attrs['w:styleId'];
    const name = ((child(st, 'w:name') || { attrs: {} }).attrs['w:val'] || '').toLowerCase();
    const based = (child(st, 'w:basedOn') || { attrs: {} }).attrs['w:val'];
    const ol = findFirst(child(st, 'w:pPr'), 'w:outlineLvl');
    raw.set(id, { name, based, ol: ol ? Number(ol.attrs['w:val']) : null });
  }
  const levelOf = (id, depth = 0) => {
    const s = raw.get(id);
    if (!s || depth > 10) return null;
    let m = s.name.match(/^(?:heading|标题)\s*(\d)$/);
    if (m) return Number(m[1]);
    if (s.name === 'title' || s.name === '标题') return 0;
    if (s.ol !== null && s.ol < 9) return s.ol + 1;
    return s.based ? levelOf(s.based, depth + 1) : null;
  };
  for (const id of raw.keys()) { const l = levelOf(id); if (l !== null) map.set(id, l); }
  return map;
}

function paraText(p) {
  let out = '';
  const walk = (n) => {
    for (const c of n.children) {
      if (c.tag === 'w:del' || c.tag === 'w:instrText' || c.tag === 'w:delText' || c.tag === 'w:txbxContent') continue;
      if (c.tag === 'w:t') out += textOf(c);
      else if (c.tag === 'w:tab') out += '\t';
      else if (c.tag === 'w:br' || c.tag === 'w:cr') out += '\n';
      else if (c.tag === 'w:noBreakHyphen') out += '-';
      else if (c.tag !== '#text') walk(c);
    }
  };
  walk(p);
  return out.replace(/[ \t]+/g, ' ').trim();
}

async function parseDocx(file, opts = {}) {
  const zip = await openZip(file);
  try {
    const props = readProps(await readXml(zip, 'docProps/core.xml'), await readXml(zip, 'docProps/app.xml'));
    const docPart = 'word/document.xml';
    const doc = await readXml(zip, docPart);
    if (!doc) throw new Error('不是有效的 DOCX：缺少 word/document.xml');
    const levels = headingLevels(await readXml(zip, 'word/styles.xml'));
    const rels = await readRels(zip, docPart);
    const comments = new Map();
    const cx = await readXml(zip, 'word/comments.xml');
    for (const c of cx ? kids(cx, 'w:comment') : []) {
      const t = findAll(c, 'w:p').map(paraText).filter(Boolean).join(' ');
      if (t) comments.set(c.attrs['w:id'], `${c.attrs['w:author'] || '批注'}：${t}`);
    }
    const mediaKey = opts.mediaKey || crypto.createHash('sha1').update(file).digest('hex').slice(0, 16);

    // 先线性化文档内容
    const items = [];
    const body = child(doc, 'w:body');
    const walkBody = async (node) => {
      for (const n of node.children) {
        if (n.tag === 'w:p') await onPara(n);
        else if (n.tag === 'w:tbl') items.push({ kind: 'table', rows: tableRows(n) });
        else if (n.tag === 'w:sdt') { const c = child(n, 'w:sdtContent'); if (c) await walkBody(c); }
        else if (n.tag === 'w:customXml') await walkBody(n);
      }
    };
    const onPara = async (p) => {
      const pPr = child(p, 'w:pPr');
      const styleId = pPr && child(pPr, 'w:pStyle') ? child(pPr, 'w:pStyle').attrs['w:val'] : null;
      let level = styleId && levels.has(styleId) ? levels.get(styleId) : null;
      const ol = pPr && child(pPr, 'w:outlineLvl');
      if (level === null && ol && Number(ol.attrs['w:val']) < 9) level = Number(ol.attrs['w:val']) + 1;
      const numPr = pPr && child(pPr, 'w:numPr');
      const lvl = numPr && child(numPr, 'w:ilvl') ? Number(child(numPr, 'w:ilvl').attrs['w:val']) || 0 : 0;
      const text = paraText(p);
      const refs = [...findAll(p, 'w:commentReference'), ...findAll(p, 'w:commentRangeStart')].map((r) => r.attrs['w:id']);
      const note = [...new Set(refs)].map((id) => comments.get(id)).filter(Boolean);
      for (const blip of findAll(p, 'a:blip')) {
        const rel = rels.get(blip.attrs['r:embed']);
        if (!rel || !rel.abs) continue;
        const docPr = findFirst(p, 'wp:docPr');
        items.push({ kind: 'image', name: posix.basename(rel.abs), alt: docPr ? (docPr.attrs.descr || '') : '', src: await extractImage(zip, rel.abs, opts.mediaDir, mediaKey) });
      }
      // 段落里的文本框内容单独成段
      for (const tx of findAll(p, 'w:txbxContent')) for (const tp of kids(tx, 'w:p')) { const t = paraText(tp); if (t) items.push({ kind: 'para', text: t, lvl: 0 }); }
      if (text || note.length) items.push({ kind: level !== null ? 'heading' : 'para', level, text, lvl, bullet: !!numPr, notes: note });
    };
    if (body) await walkBody(body);

    // 分节：在出现的最小两级标题处切分；过长的节按段落续切
    const headLevels = [...new Set(items.filter((i) => i.kind === 'heading' && i.level > 0 && i.text).map((i) => i.level))].sort((a, b) => a - b);
    const splitMax = headLevels.length ? headLevels[Math.min(1, headLevels.length - 1)] : 0;
    const sections = [];
    let cur = null, parents = [];
    const docTitle = props.title || (items.find((i) => i.kind === 'heading' && i.level === 0) || {}).text || path.basename(file, path.extname(file));
    const newSection = (title, cont = false) => { cur = { title, blocks: [], notes: [], chars: 0, cont }; sections.push(cur); };
    for (const it of items) {
      if (it.kind === 'heading' && it.level > 0 && it.level <= splitMax && it.text) {
        parents = parents.filter((p) => p.level < it.level);
        parents.push({ level: it.level, text: it.text });
        newSection(parents.map((p) => p.text).join(' › '));
        if (it.notes.length) cur.notes.push(...it.notes);
        continue;
      }
      if (!cur) newSection(it.kind === 'heading' && it.level === 0 ? it.text : docTitle);
      if (it.kind === 'heading' && it.level === 0) continue;
      if (cur.chars > MAX_SECTION_CHARS && it.kind !== 'heading') newSection(cur.title.replace(/（续\d*）$/, '') + `（续${sections.filter((s) => s.title.startsWith(cur.title.replace(/（续\d*）$/, ''))).length}）`, true);
      if (it.kind === 'para' || it.kind === 'heading') {
        const last = cur.blocks[cur.blocks.length - 1];
        const para = { text: it.text, lvl: it.lvl || 0, bullet: it.bullet, heading: it.kind === 'heading' ? it.level : 0 };
        if (it.text) {
          if (last && last.kind === 'text') last.paras.push(para); else cur.blocks.push({ kind: 'text', paras: [para] });
          cur.chars += it.text.length;
        }
        if (it.notes && it.notes.length) cur.notes.push(...it.notes);
      } else {
        cur.blocks.push(it);
        if (it.kind === 'table') cur.chars += it.rows.flat().join('').length;
      }
    }
    const kept = sections.filter((s) => s.blocks.length || s.notes.length);
    const slides = (kept.length ? kept : sections.slice(0, 1)).map((s, i) => ({
      index: i + 1, part: docPart, hidden: false, title: s.title, blocks: [{ kind: 'title', paras: [{ text: s.title }] }, ...s.blocks], media: [],
      notes: [...new Set(s.notes)].join('\n'), errors: [], theme: 'light', bg: { color: '#ffffff', lum: 1, source: 'word' }, layout: null, section: s.cont ? '续' : '',
    }));
    const { blocksToText } = require('./pptx');
    for (const s of slides) { s.text = blocksToText(s.blocks.filter((b) => b.kind !== 'title')); if (opts.onSlide) opts.onSlide(s.index, slides.length, s.title, s); }
    return { props, size: null, slides, mediaKey, kind: 'word' };
  } finally { zip.close(); }
}

function tableRows(tbl) {
  return kids(tbl, 'w:tr').map((tr) => kids(tr, 'w:tc').map((tc) => kids(tc, 'w:p').map(paraText).filter(Boolean).join(' ')));
}

async function extractImage(zip, abs, mediaDir, key) {
  if (!mediaDir) return null;
  const ext = posix.extname(abs).toLowerCase();
  if (!WEB_IMAGES.has(ext) || !zip.has(abs) || zip.size(abs) > 30 * 1024 * 1024) return null;
  // 不复制图片：记录“文件 key + 部件路径”，显示时从原文件读取
  return `${key}/${abs.replace(/^\//, '').replace(/\//g, '~')}`;
}

module.exports = { parseDocx };
