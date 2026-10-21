'use strict';
// 选页导出：把来自多个 PPTX 的若干页合并为一个新的 PPTX，保留各自的母版、版式、主题、图片、视频与备注。
const fs = require('fs');
const path = require('path');
const posix = path.posix;
const { ZipWriter } = require('./zipwriter');
const { openZip } = require('./zip');
const { parseXml, kids, child } = require('./xml');

const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const RT = {
  officeDocument: `${NS_R}/officeDocument`,
  slide: `${NS_R}/slide`, slideMaster: `${NS_R}/slideMaster`, notesMaster: `${NS_R}/notesMaster`, theme: `${NS_R}/theme`,
  presProps: `${NS_R}/presProps`, viewProps: `${NS_R}/viewProps`, tableStyles: `${NS_R}/tableStyles`,
  core: 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties',
  app: `${NS_R}/extended-properties`,
};
const CT = {
  presentation: 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
  slideMaster: 'application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml',
  core: 'application/vnd.openxmlformats-package.core-properties+xml',
  app: 'application/vnd.openxmlformats-officedocument.extended-properties+xml',
  rels: 'application/vnd.openxmlformats-package.relationships+xml',
};
const DROP_REL = /\/(comments|commentAuthors|authors|printerSettings|handoutMaster)$|\/relationships\/comments$/i;
const BINARY_STORE = /\.(mp4|m4v|mov|wmv|avi|mkv|webm|mp3|wav|m4a|wma|png|jpe?g|gif|emf|wmf|tiff?)$/i;

const relsPathOf = (part) => posix.join(posix.dirname(part), '_rels', posix.basename(part) + '.rels');
const resolveTarget = (part, target) => (target.startsWith('/') ? target.slice(1) : posix.normalize(posix.join(posix.dirname(part), target)));
const relTarget = (from, to) => posix.relative(posix.dirname(from), to);
const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

class Source {
  constructor(file, zip) { this.file = file; this.zip = zip; this.ct = null; this.relCache = new Map(); }
  async init() {
    const x = parseXml(await this.zip.text('[Content_Types].xml'));
    this.defaults = new Map(kids(x, 'Default').map((d) => [d.attrs.Extension.toLowerCase(), d.attrs.ContentType]));
    this.overrides = new Map(kids(x, 'Override').map((o) => [o.attrs.PartName.replace(/^\//, '').toLowerCase(), o.attrs.ContentType]));
    const pres = parseXml(await this.zip.text('ppt/presentation.xml'));
    const rels = await this.rels('ppt/presentation.xml');
    this.slides = kids(child(pres, 'p:sldIdLst'), 'p:sldId').map((s) => (rels.find((r) => r.id === s.attrs['r:id']) || {}).abs).filter(Boolean);
    this.presXml = await this.zip.text('ppt/presentation.xml');
    this.presRels = rels;
    return this;
  }
  contentType(part) {
    return this.overrides.get(part.toLowerCase()) || this.defaults.get(posix.extname(part).slice(1).toLowerCase()) || 'application/octet-stream';
  }
  async rels(part) {
    if (this.relCache.has(part)) return this.relCache.get(part);
    const p = relsPathOf(part);
    const x = this.zip.has(p) ? parseXml(await this.zip.text(p)) : null;
    const list = x ? kids(x, 'Relationship').map((r) => ({
      id: r.attrs.Id, type: r.attrs.Type, target: r.attrs.Target, external: r.attrs.TargetMode === 'External',
      abs: r.attrs.TargetMode === 'External' ? null : resolveTarget(part, r.attrs.Target),
    })) : [];
    this.relCache.set(part, list);
    return list;
  }
}

/**
 * selections: [{path, idx}]（idx 为 1 起始的页码），按顺序导出
 * opts: { includeNotes = true, title, log }
 */
async function exportPptx(selections, outPath, opts = {}) {
  if (!selections.length) throw new Error('没有选择任何页面');
  const includeNotes = opts.includeNotes !== false;
  const log = opts.log || { info() {}, warn() {} };
  const sources = new Map();
  try {
    for (const sel of selections) {
      if (sources.has(sel.path)) continue;
      if (!/\.pptx|\.pptm|\.ppsx|\.potx$/i.test(sel.path) && !sel.path.toLowerCase().endsWith('.pptx')) log.warn(`非 PPTX 源文件：${sel.path}`);
      sources.set(sel.path, await new Source(sel.path, await openZip(sel.path)).init());
    }
    const parts = new Map(); // newName -> {data | stream, ct, store}
    const memo = new Map();
    const used = new Set(['[Content_Types].xml', '_rels/.rels', 'ppt/presentation.xml', 'ppt/_rels/presentation.xml.rels', 'docProps/core.xml', 'docProps/app.xml']);
    const masters = [];
    let notesMaster = null;
    const counters = new Map();

    const alloc = (part) => {
      const dir = posix.dirname(part), ext = posix.extname(part), stem = posix.basename(part, ext).replace(/\d+$/, '') || 'part';
      const key = `${dir}/${stem}${ext}`;
      let n = counters.get(key) || 0, name;
      do { n++; name = `${dir}/${stem}${n}${ext}`; } while (used.has(name.toLowerCase()) || used.has(name));
      counters.set(key, n);
      used.add(name);
      return name;
    };

    // 预先规划每个选中页的新部件名，供页内超链接跳转使用
    const planned = selections.map((sel, i) => {
      const src = sources.get(sel.path);
      const part = src.slides[sel.idx - 1];
      if (!part) throw new Error(`页码超出范围：${path.basename(sel.path)} 第 ${sel.idx} 页`);
      const name = `ppt/slides/slide${i + 1}.xml`;
      used.add(name);
      return { src, part, name, ns: sel.ns || '' };
    });
    const firstPlanned = new Map();
    for (const p of planned) { const k = `${p.src.file}|${p.part}`; if (!firstPlanned.has(k)) firstPlanned.set(k, p.name); }

    const SHAREABLE = /\/(slideLayouts|slideMasters|theme|notesMasters|media)\//;
    async function importPart(src, part, ctx = {}) {
      // 母版/版式/主题/媒体可共享；图表、备注页、SmartArt、嵌入对象等按页独立复制（同一页被选多次时不共用）
      // ns：命名空间（如黑白底互转的不同方向），不同命名空间的母版/版式各自独立复制
      const key = SHAREABLE.test(part) && !/\/notesMasters\//.test(part) ? `${ctx.ns || ''}|${src.file}|${part}` : SHAREABLE.test(part) ? `${src.file}|${part}` : `${src.file}|${part}|${ctx.occ}`;
      if (!ctx.forceName && memo.has(key)) return memo.get(key);
      if (!src.zip.has(part)) return null;
      const name = ctx.forceName || alloc(part);
      if (!memo.has(key)) memo.set(key, name);
      const ct = src.contentType(part);
      const entry = { ct, src, part, store: BINARY_STORE.test(part) };
      parts.set(name, entry);
      if (ct === CT.slideMaster) masters.push(name);
      const rels = await src.rels(part);
      if (rels.length) {
        const out = [];
        for (const r of rels) {
          if (DROP_REL.test(r.type)) continue;
          if (r.external) { out.push({ ...r }); continue; }
          let target = null;
          if (r.type === RT.slide) {
            target = ctx.slideName && /notesSlide/.test(part) ? ctx.slideName : (firstPlanned.get(`${src.file}|${r.abs}`) || ctx.slideName || name);
          } else if (r.type.endsWith('/notesSlide')) {
            if (!includeNotes) continue;
            target = await importPart(src, r.abs, { slideName: name, occ: ctx.occ, ns: ctx.ns });
          } else if (r.type === RT.notesMaster) {
            if (!notesMaster) notesMaster = await importPart(src, r.abs);
            target = notesMaster;
          } else {
            target = await importPart(src, r.abs, { slideName: ctx.slideName, occ: ctx.occ, ns: ctx.ns });
          }
          if (!target) { log.warn(`跳过缺失部件 ${r.abs}（${path.basename(src.file)}）`); continue; }
          out.push({ ...r, target: relTarget(name, target), external: false });
        }
        entry.rels = out;
      }
      return name;
    }

    for (let i = 0; i < planned.length; i++) await importPart(planned[i].src, planned[i].part, { forceName: planned[i].name, slideName: planned[i].name, occ: i, ns: planned[i].ns });

    // 演示文稿级部件取自第一个来源
    const base = planned[0].src;
    const presRels = [];
    let rid = 1;
    const addRel = (type, target) => { const id = `rId${rid++}`; presRels.push({ id, type, target }); return id; };
    let idCounter = 2147483648;
    const masterEntries = [];
    for (const m of masters) {
      const masterId = idCounter++;
      const e = parts.get(m);
      let xml = await e.src.zip.text(e.part);
      xml = xml.replace(/<p:sldLayoutId\b([^>]*?)\bid="\d+"/g, (all, pre) => `<p:sldLayoutId${pre}id="${idCounter++}"`);
      e.data = Buffer.from(xml, 'utf8');
      masterEntries.push(`<p:sldMasterId id="${masterId}" r:id="${addRel(RT.slideMaster, m.replace(/^ppt\//, ''))}"/>`);
    }
    const notesEntry = notesMaster ? `<p:notesMasterIdLst><p:notesMasterId r:id="${addRel(RT.notesMaster, notesMaster.replace(/^ppt\//, ''))}"/></p:notesMasterIdLst>` : '';
    const slideEntries = planned.map((p, i) => `<p:sldId id="${256 + i}" r:id="${addRel(RT.slide, p.name.replace(/^ppt\//, ''))}"/>`);
    for (const r of base.presRels) {
      if ([RT.presProps, RT.viewProps, RT.tableStyles, RT.theme].includes(r.type) && !r.external && base.zip.has(r.abs)) {
        const n = r.type === RT.theme ? await importPart(base, r.abs) : posix.join('ppt', posix.basename(r.abs));
        if (r.type !== RT.theme) { used.add(n); parts.set(n, { ct: base.contentType(r.abs), src: base, part: r.abs, clean: r.type === RT.presProps }); }
        addRel(r.type, n.replace(/^ppt\//, ''));
      }
    }

    let pres = base.presXml;
    const replaceOrInsert = (re, replacement, afterRe) => {
      if (re.test(pres)) pres = pres.replace(re, replacement);
      else if (replacement) {
        const m = pres.match(afterRe);
        if (m) pres = pres.replace(afterRe, m[0] + replacement);
      }
    };
    pres = pres.replace(/<p:extLst>[\s\S]*?<\/p:extLst>(?=\s*<\/p:presentation>)/, '');
    pres = pres.replace(/<p:handoutMasterIdLst>[\s\S]*?<\/p:handoutMasterIdLst>/, '')
      .replace(/<p:custShowLst>[\s\S]*?<\/p:custShowLst>|<p:custShowLst\/>/, '')
      .replace(/<p:embeddedFontLst>[\s\S]*?<\/p:embeddedFontLst>/, '')
      .replace(/<p:custDataLst>[\s\S]*?<\/p:custDataLst>/, '')
      .replace(/<p:photoAlbum\b[^>]*\/>/, '');
    replaceOrInsert(/<p:sldMasterIdLst>[\s\S]*?<\/p:sldMasterIdLst>|<p:sldMasterIdLst\/>/, `<p:sldMasterIdLst>${masterEntries.join('')}</p:sldMasterIdLst>`, /<p:presentation\b[^>]*>/);
    replaceOrInsert(/<p:notesMasterIdLst>[\s\S]*?<\/p:notesMasterIdLst>|<p:notesMasterIdLst\/>/, notesEntry, /<\/p:sldMasterIdLst>/);
    replaceOrInsert(/<p:sldIdLst>[\s\S]*?<\/p:sldIdLst>|<p:sldIdLst\/>/, `<p:sldIdLst>${slideEntries.join('')}</p:sldIdLst>`, notesEntry ? /<\/p:notesMasterIdLst>/ : /<\/p:sldMasterIdLst>/);
    if (!/xmlns:r=/.test(pres)) pres = pres.replace(/<p:presentation\b/, `<p:presentation xmlns:r="${NS_R}"`);

    // 写出（[Content_Types].xml 放在最前）
    const ctOverrides = new Map([['/ppt/presentation.xml', CT.presentation], ['/docProps/core.xml', CT.core], ['/docProps/app.xml', CT.app]]);
    const ctDefaults = new Map([['rels', CT.rels], ['xml', 'application/xml']]);
    const relsXml = (list) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${list.map((r) => `<Relationship Id="${xmlEsc(r.id)}" Type="${xmlEsc(r.type)}" Target="${xmlEsc(r.target)}"${r.external ? ' TargetMode="External"' : ''}/>`).join('')}</Relationships>`;
    for (const [name, e] of parts) {
      const ext = posix.extname(name).slice(1).toLowerCase();
      if (/xml$/.test(e.ct) || ext === 'xml') ctOverrides.set('/' + name, e.ct);
      else if (!ctDefaults.has(ext)) ctDefaults.set(ext, e.ct);
      else if (ctDefaults.get(ext) !== e.ct) ctOverrides.set('/' + name, e.ct);
    }
    const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    const title = opts.title || path.basename(outPath, path.extname(outPath));
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    const tmp = outPath + '.part';
    const zw = new ZipWriter(tmp);
    try {
      zw.addBuffer('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${[...ctDefaults].map(([e, c]) => `<Default Extension="${xmlEsc(e)}" ContentType="${xmlEsc(c)}"/>`).join('')}${[...ctOverrides].map(([p, c]) => `<Override PartName="${xmlEsc(p)}" ContentType="${xmlEsc(c)}"/>`).join('')}</Types>`);
      zw.addBuffer('_rels/.rels', relsXml([
        { id: 'rId1', type: RT.officeDocument, target: 'ppt/presentation.xml' },
        { id: 'rId2', type: RT.core, target: 'docProps/core.xml' },
        { id: 'rId3', type: RT.app, target: 'docProps/app.xml' },
      ]));
      zw.addBuffer('docProps/core.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xmlEsc(title)}</dc:title><dc:creator>PPT智能体</dc:creator><cp:lastModifiedBy>PPT智能体</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`);
      zw.addBuffer('docProps/app.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>PPT智能体</Application><Slides>${planned.length}</Slides><Notes>${includeNotes ? planned.length : 0}</Notes></Properties>`);
      zw.addBuffer('ppt/presentation.xml', pres);
      zw.addBuffer('ppt/_rels/presentation.xml.rels', relsXml(presRels));
      for (const [name, e] of parts) {
        if (e.data) zw.addBuffer(name, e.data);
        else if (e.clean) zw.addBuffer(name, (await e.src.zip.text(e.part)).replace(/<p:custShow\b[^>]*\/>|<p:sldRg\b[^>]*\/>/g, ''));
        else {
          const entry = e.src.zip.entries.get(e.src.zip.resolveName(e.part));
          if (entry.uncompressedSize > 16 * 1024 * 1024) await zw.addStream(name, await e.src.zip.stream(e.part), entry.uncompressedSize, entry.crc32);
          else zw.addBuffer(name, await e.src.zip.buffer(e.part), { store: e.store });
        }
        if (e.rels) zw.addBuffer(relsPathOf(name), relsXml(e.rels));
      }
      zw.finish();
    } catch (err) { zw.abort(); fs.rmSync(tmp, { force: true }); throw err; }
    fs.renameSync(tmp, outPath);
    const size = fs.statSync(outPath).size;
    log.info(`导出完成：${outPath}（${planned.length} 页，${(size / 1024 / 1024).toFixed(2)} MB，来源 ${sources.size} 个文件，母版 ${masters.length} 个）`);
    return { path: outPath, slides: planned.length, size, sources: sources.size, masters: masters.length };
  } finally {
    for (const s of sources.values()) s.zip.close();
  }
}

function exportMarkdown(items, outPath, title = '导出页面') {
  const body = items.map((it) => `<!-- 来源：${it.filePath} 第 ${it.idx} 页 -->\n${it.md}`).join('\n---\n\n');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `# ${title}\n\n> 由 PPT智能体 导出，共 ${items.length} 页\n\n${body}`);
  return { path: outPath, slides: items.length };
}

module.exports = { exportPptx, exportMarkdown };
