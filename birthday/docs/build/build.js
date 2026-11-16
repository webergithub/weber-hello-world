/* 生成需求与设计文档：node birthday/docs/build/build.js
   输出 birthday/docs/tenup-requirements-design.html 和 .docx */
const fs = require('fs'), path = require('path');
const docx = require('docx');
const here = __dirname, out = path.join(here, '..');
const S = require('./status.js'), D = require('./content.js')(S);
const TITLE = '十岁啦 · 成长相册', SUB = '需求与设计文档';
const shot = f => path.join(here, 'shots', f);

/* ---------- inline marks: **bold**, `code` ---------- */
function parts(s) {
  const o = []; let m, re = /\*\*(.+?)\*\*|`(.+?)`/g, i = 0;
  while ((m = re.exec(s))) { if (m.index > i) o.push({ x: s.slice(i, m.index) }); o.push(m[1] ? { x: m[1], b: 1 } : { x: m[2], c: 1 }); i = re.lastIndex; }
  if (i < s.length) o.push({ x: s.slice(i) });
  return o;
}
const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ---------- HTML ---------- */
function inl(s) {
  return String(s).split('\n').map(line => parts(line).map(p => {
    let t = esc(p.x).replace(/(https?:\/\/[^\s（）<]+)/g, '<a href="$1">$1</a>');
    return p.b ? '<strong>' + t + '</strong>' : p.c ? '<code>' + t + '</code>' : t;
  }).join('')).join('<br>');
}
function html() {
  let body = '', toc = '', n = 0;
  for (const b of D) {
    if (b.t === 'h1' || b.t === 'h2') { const id = 's' + (++n); if (b.t === 'h1') toc += '<li><a href="#' + id + '">' + esc(b.x) + '</a></li>'; body += '<' + b.t + ' id="' + id + '">' + esc(b.x) + '</' + b.t + '>'; }
    else if (b.t === 'h3') body += '<h3>' + esc(b.x) + '</h3>';
    else if (b.t === 'p') body += '<p>' + inl(b.x) + '</p>';
    else if (b.t === 'note') body += '<p class="note">' + inl(b.x) + '</p>';
    else if (b.t === 'ul' || b.t === 'ol') body += '<' + b.t + '>' + b.x.map(x => '<li>' + inl(x) + '</li>').join('') + '</' + b.t + '>';
    else if (b.t === 'table') body += '<div class="tw"><table><colgroup>' + b.w.map(w => '<col style="width:' + w + '%">').join('') + '</colgroup><thead><tr>' + b.head.map(h => '<th>' + esc(h) + '</th>').join('') + '</tr></thead><tbody>' +
      b.rows.map(r => '<tr>' + r.map(c => '<td>' + inl(c) + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>';
    else if (b.t === 'img') body += '<figure><img alt="' + esc(b.cap) + '" src="data:image/jpeg;base64,' + fs.readFileSync(shot(b.f)).toString('base64') + '"><figcaption>' + esc(b.cap) + '</figcaption></figure>';
  }
  return `<!doctype html>
<html lang="zh-Hans"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${TITLE} ${SUB} ${S.version}</title>
<style>
:root{--ground:#f6ede3;--surface:#fffaf4;--ink:#4a3b33;--muted:#75625a;--line:#e3d2c2;--accent:#a8415f;--band:#f3e4d8}
*{box-sizing:border-box}
html{background:var(--ground)}
body{margin:0 auto;max-width:980px;padding:32px 20px 80px;color:var(--ink);font:16px/1.75 "PingFang SC","Microsoft YaHei","Noto Sans SC",system-ui,sans-serif;-webkit-text-size-adjust:100%}
header{padding:40px 32px;border-radius:28px;background:var(--surface);box-shadow:0 14px 40px rgba(120,84,60,.14);margin-bottom:28px}
header h1{font-size:40px;line-height:1.2;margin:0 0 6px;border:0;padding:0}
header p{margin:0;color:var(--muted)}
nav{padding:18px 28px;border-radius:20px;background:var(--surface);margin-bottom:8px}
nav ol{margin:0;padding-left:0;list-style:none;columns:2;column-gap:32px}
nav li{break-inside:avoid;padding:2px 0}
a{color:var(--accent)}
h1{font-size:28px;line-height:1.3;margin:56px 0 14px;padding-top:18px;border-top:3px solid var(--line)}
h2{font-size:21px;margin:32px 0 10px}
h3{font-size:17px;margin:22px 0 8px}
p{margin:10px 0}
ul,ol{margin:10px 0;padding-left:24px}
li{margin:5px 0}
code{font:13.5px/1.4 ui-monospace,Menlo,Consolas,monospace;background:var(--band);padding:2px 6px;border-radius:6px;word-break:break-all}
.note{padding:12px 18px;border-radius:14px;background:var(--band);border-left:0}
.tw{overflow-x:auto;margin:14px 0;border-radius:14px;background:var(--surface);box-shadow:0 4px 16px rgba(120,84,60,.08)}
table{width:100%;min-width:560px;border-collapse:collapse;font-size:14.5px;line-height:1.6;table-layout:fixed}
th,td{text-align:left;vertical-align:top;padding:9px 12px;border-bottom:1px solid var(--line);overflow-wrap:anywhere}
th{background:var(--band);font-weight:700}
tbody tr:last-child td{border-bottom:0}
figure{margin:20px 0}
figure img{display:block;width:100%;height:auto;border-radius:16px;box-shadow:0 8px 28px rgba(120,84,60,.18)}
figcaption{margin-top:8px;font-size:14px;color:var(--muted)}
@media (max-width:640px){nav ol{columns:1}header{padding:28px 20px}header h1{font-size:30px}}
@media print{html{background:#fff}body{max-width:none}header,nav,.tw{box-shadow:none}figure{break-inside:avoid}}
</style></head><body>
<header><h1>${TITLE}</h1><p>${SUB}　${S.version}　·　${S.date}</p></header>
<nav><ol>${toc}</ol></nav>
${body}
</body></html>`;
}

/* ---------- DOCX ---------- */
const { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, ShadingType, ImageRun, AlignmentType, LevelFormat, BorderStyle, Footer, PageNumber, TableOfContents, PageBreak, VerticalAlign } = docx;
const FONT = { ascii: 'Arial', hAnsi: 'Arial', eastAsia: 'Microsoft YaHei', cs: 'Arial' }, MONO = { ascii: 'Consolas', hAnsi: 'Consolas', eastAsia: 'Microsoft YaHei', cs: 'Consolas' };
const INK = '4A3B33', MUTED = '75625A', ACCENT = 'A8415F', BAND = 'F3E4D8', LINE = 'D9C4B2';
const CONTENT_W = 9638;   /* A4 minus 2 cm margins, in DXA */
function runs(s, base) {
  base = base || {};
  return parts(String(s)).map(p => new TextRun(Object.assign({ text: p.x, font: p.c ? MONO : FONT, bold: !!p.b || base.bold, size: p.c ? (base.size || 21) - 1 : base.size, color: base.color }, p.c ? { shading: { type: ShadingType.CLEAR, fill: BAND, color: 'auto' } } : {})));
}
function cellParas(text, base) { return String(text).split('\n').map(line => new Paragraph({ spacing: { before: 30, after: 30 }, children: runs(line, base) })); }
function tableOf(b) {
  const widths = b.w.map(w => Math.round(CONTENT_W * w / 100)); widths[widths.length - 1] += CONTENT_W - widths.reduce((a, c) => a + c, 0);
  const border = { style: BorderStyle.SINGLE, size: 4, color: LINE }, borders = { top: border, bottom: border, left: border, right: border };
  const row = (cells, head) => new TableRow({ tableHeader: head, cantSplit: true, children: cells.map((c, i) => new TableCell({
    width: { size: widths[i], type: WidthType.DXA }, borders, verticalAlign: VerticalAlign.TOP, margins: { top: 60, bottom: 60, left: 110, right: 110 },
    shading: head ? { type: ShadingType.CLEAR, fill: BAND, color: 'auto' } : undefined, children: cellParas(c, { size: 19, bold: head }) })) });
  return new Table({ width: { size: CONTENT_W, type: WidthType.DXA }, columnWidths: widths, rows: [row(b.head, true)].concat(b.rows.map(r => row(r, false))) });
}
function docxDoc() {
  const kids = [
    new Paragraph({ spacing: { before: 2400, after: 120 }, children: [new TextRun({ text: TITLE, font: FONT, bold: true, size: 72, color: INK })] }),
    new Paragraph({ spacing: { after: 120 }, children: [new TextRun({ text: SUB, font: FONT, size: 40, color: ACCENT })] }),
    new Paragraph({ spacing: { after: 600 }, children: [new TextRun({ text: S.version + '　·　' + S.date, font: FONT, size: 24, color: MUTED })] }),
    new Paragraph({ spacing: { after: 120 }, children: [new TextRun({ text: '目录', font: FONT, bold: true, size: 28, color: INK })] }),
    new TableOfContents('目录', { hyperlink: true, headingStyleRange: '1-2' }),
    new Paragraph({ children: [new PageBreak()] })
  ];
  for (const b of D) {
    if (b.t === 'h1') kids.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: b.x })] }));
    else if (b.t === 'h2') kids.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun({ text: b.x })] }));
    else if (b.t === 'h3') kids.push(new Paragraph({ heading: HeadingLevel.HEADING_3, children: [new TextRun({ text: b.x })] }));
    else if (b.t === 'p') kids.push(new Paragraph({ spacing: { before: 80, after: 80, line: 340 }, children: runs(b.x) }));
    else if (b.t === 'note') kids.push(new Paragraph({ spacing: { before: 120, after: 120, line: 340 }, indent: { left: 200, right: 200 }, shading: { type: ShadingType.CLEAR, fill: BAND, color: 'auto' }, children: runs(b.x) }));
    else if (b.t === 'ul' || b.t === 'ol') b.x.forEach(x => kids.push(new Paragraph({ numbering: { reference: b.t === 'ul' ? 'bul' : 'num', level: 0 }, spacing: { before: 40, after: 40, line: 340 }, children: runs(x) })));
    else if (b.t === 'table') { kids.push(tableOf(b)); kids.push(new Paragraph({ spacing: { before: 0, after: 120 }, children: [] })); }
    else if (b.t === 'img') {
      kids.push(new Paragraph({ alignment: AlignmentType.CENTER, keepNext: true, spacing: { before: 200, after: 60 }, children: [new ImageRun({ type: 'jpg', data: fs.readFileSync(shot(b.f)), transformation: { width: 620, height: Math.round(620 * (b.f === 'manage.jpg' ? 860 / 1280 : 9 / 16)) } })] }));
      kids.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 0, after: 200 }, children: [new TextRun({ text: b.cap, font: FONT, size: 18, color: MUTED })] }));
    }
  }
  const heading = (size, before, color) => ({ run: { font: FONT, size, bold: true, color }, paragraph: { spacing: { before, after: 120 }, keepNext: true } });
  return new Document({
    creator: TITLE, title: TITLE + ' ' + SUB, features: { updateFields: true },
    styles: { default: { document: { run: { font: FONT, size: 21, color: INK } }, heading1: heading(34, 480, INK), heading2: heading(26, 320, ACCENT), heading3: heading(22, 240, INK) } },
    numbering: { config: [
      { reference: 'bul', levels: [{ level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 420, hanging: 260 } } } }] },
      { reference: 'num', levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 420, hanging: 300 } } } }] }
    ] },
    sections: [{ properties: { page: { margin: { top: 1134, bottom: 1134, left: 1134, right: 1134 } } },
      footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: TITLE + ' ' + SUB + ' ' + S.version + '　第 ', font: FONT, size: 16, color: MUTED }), new TextRun({ children: [PageNumber.CURRENT], font: FONT, size: 16, color: MUTED }), new TextRun({ text: ' 页', font: FONT, size: 16, color: MUTED })] })] }) },
      children: kids }]
  });
}

fs.writeFileSync(path.join(out, 'tenup-requirements-design.html'), html());
Packer.toBuffer(docxDoc()).then(buf => { fs.writeFileSync(path.join(out, 'tenup-requirements-design.docx'), buf); console.log('written', S.version); });
