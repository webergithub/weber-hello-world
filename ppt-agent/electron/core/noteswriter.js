'use strict';
// 把（翻译后的）讲解词写回 PPT 的备注页：在备注正文末尾追加“【语言】”段落；同一语言再次写入时替换原段落。
const fs = require('fs');
const path = require('path');
const posix = path.posix;
const { DOMParser, XMLSerializer } = require('@xmldom/xmldom');
const { openZip } = require('./zip');
const { ZipWriter } = require('./zipwriter');

const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const relsPathOf = (part) => posix.join(posix.dirname(part), '_rels', posix.basename(part) + '.rels');
const resolveTarget = (part, target) => (target.startsWith('/') ? target.slice(1) : posix.normalize(posix.join(posix.dirname(part), target)));
const elems = (node) => { const out = []; for (let c = node.firstChild; c; c = c.nextSibling) if (c.nodeType === 1) out.push(c); return out; };
const paraText = (p) => Array.from(p.getElementsByTagName('a:t')).map((t) => t.textContent).join('');

/** 在第 slideIdx 页（从 1 开始）的备注中写入 heading + text；backupDir 不为空时先备份原文件 */
async function writeNotes(pptxPath, slideIdx, heading, text, { backupDir, lang = 'en-US' } = {}) {
  const zip = await openZip(pptxPath);
  let out;
  let notesPart;
  try {
    const rels = async (part) => {
      if (!zip.has(relsPathOf(part))) return [];
      const d = new DOMParser().parseFromString(await zip.text(relsPathOf(part)), 'text/xml');
      return Array.from(d.getElementsByTagName('Relationship')).map((r) => ({ type: r.getAttribute('Type'), abs: resolveTarget(part, r.getAttribute('Target')), external: r.getAttribute('TargetMode') === 'External' }));
    };
    const pres = new DOMParser().parseFromString(await zip.text('ppt/presentation.xml'), 'text/xml');
    const prDoc = new DOMParser().parseFromString(await zip.text('ppt/_rels/presentation.xml.rels'), 'text/xml');
    const byId = new Map(Array.from(prDoc.getElementsByTagName('Relationship')).map((r) => [r.getAttribute('Id'), resolveTarget('ppt/presentation.xml', r.getAttribute('Target'))]));
    const ids = Array.from(pres.getElementsByTagName('p:sldId'));
    const sid = ids[slideIdx - 1];
    if (!sid) throw new Error(`PPT 中没有第 ${slideIdx} 页`);
    const slidePart = byId.get(sid.getAttributeNS(NS_R, 'id') || sid.getAttribute('r:id'));
    const nrel = (await rels(slidePart)).find((r) => r.type.endsWith('/notesSlide') && !r.external);
    if (!nrel || !zip.has(nrel.abs)) throw new Error('该页没有备注页，无法写入 PPT（已保存在应用知识库中）');
    notesPart = nrel.abs;
    const doc = new DOMParser().parseFromString(await zip.text(notesPart), 'text/xml');
    const body = Array.from(doc.getElementsByTagName('p:sp')).find((sp) => Array.from(sp.getElementsByTagName('p:ph')).some((ph) => ph.getAttribute('type') === 'body'));
    const txBody = body && Array.from(body.getElementsByTagName('p:txBody'))[0];
    if (!txBody) throw new Error('备注页中没有正文占位符，无法写入 PPT（已保存在应用知识库中）');
    // 删除同一语言以前写入的段落：从【heading】段落到下一个【…】段落之前
    const paras = elems(txBody).filter((e) => e.nodeName === 'a:p');
    const mark = `【${heading}】`;
    let removing = false;
    for (const p of paras) {
      const t = paraText(p).trim();
      if (t === mark) removing = true;
      else if (removing && /^【.+】$/.test(t)) removing = false;
      if (removing) txBody.removeChild(p);
    }
    // 去掉末尾的空段落后追加
    let last = elems(txBody).filter((e) => e.nodeName === 'a:p').pop();
    while (last && !paraText(last).trim() && elems(txBody).filter((e) => e.nodeName === 'a:p').length > 1) { txBody.removeChild(last); last = elems(txBody).filter((e) => e.nodeName === 'a:p').pop(); }
    const mk = (line) => {
      const p = doc.createElementNS(NS_A, 'a:p');
      if (line) {
        const r = doc.createElementNS(NS_A, 'a:r');
        const rPr = doc.createElementNS(NS_A, 'a:rPr'); rPr.setAttribute('lang', lang); rPr.setAttribute('dirty', '0');
        const t = doc.createElementNS(NS_A, 'a:t'); t.appendChild(doc.createTextNode(line));
        r.appendChild(rPr); r.appendChild(t); p.appendChild(r);
      }
      return p;
    };
    const hasText = elems(txBody).some((e) => e.nodeName === 'a:p' && paraText(e).trim());
    if (hasText) txBody.appendChild(mk(''));
    txBody.appendChild(mk(mark));
    for (const line of String(text).split(/\r?\n/)) txBody.appendChild(mk(line));
    out = new XMLSerializer().serializeToString(doc);
  } catch (e) { zip.close(); throw e; }
  // 写到临时文件，再替换原文件（先备份）
  const tmp = pptxPath + '.ppta-tmp';
  const zw = new ZipWriter(tmp);
  try {
    const names = zip.names().filter((n) => !n.endsWith('/'));
    names.sort((a, b) => (a === '[Content_Types].xml' ? -1 : b === '[Content_Types].xml' ? 1 : 0));
    for (const n of names) {
      if (n === notesPart) { zw.addBuffer(n, out); continue; }
      const e = zip.entries.get(n);
      if (e.uncompressedSize > 16 * 1024 * 1024) await zw.addStream(n, await zip.stream(n), e.uncompressedSize, e.crc32);
      else zw.addBuffer(n, await zip.buffer(n), { store: e.compressionMethod === 0 });
    }
    zw.finish();
  } catch (e) { zw.abort(); fs.rmSync(tmp, { force: true }); zip.close(); throw e; }
  zip.close();
  let backup = null;
  if (backupDir) {
    fs.mkdirSync(backupDir, { recursive: true });
    backup = path.join(backupDir, `${Date.now()}-${path.basename(pptxPath)}`);
    fs.copyFileSync(pptxPath, backup);
  }
  try { fs.renameSync(tmp, pptxPath); } catch (e) {
    fs.rmSync(tmp, { force: true });
    if (['EBUSY', 'EPERM', 'EACCES'].includes(e.code)) throw new Error('PPT 文件正被打开或没有写入权限，请关闭 PowerPoint 后重试（已保存在应用知识库中）');
    throw e;
  }
  return { notesPart, backup };
}

module.exports = { writeNotes };
