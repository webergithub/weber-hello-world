'use strict';
// 编码兼容（v3.9）：
// 1）decodeXml：按 BOM / XML 声明的编码（UTF-8、UTF-16、GBK、GB2312、Big5……）解码 PPT / Word 内部的 XML，
//    无声明且按 UTF-8 解码出现乱码时改用 GB18030；
// 2）fixMojibake：修复常见的“乱码”——中文的 GBK / UTF-8 字节被当成 Latin-1、Windows-1252 或 CP437 显示
//    （如“²âÊÔ”“æµ‹è¯•”“▓Γ╩╘”，多见于从压缩包解出的文件名、旧软件导出的文档）。
//    只在乱码特征明显时才改（可疑字符占比高、能按候选编码完整解码出中文），正常的法语 / 德语等带重音字母的文字不受影响。

// CP437（DOS 英文代码页）0x80–0xFF
const CP437 = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';
const CP437_REV = new Map([...CP437].map((c, i) => [c, 0x80 + i]));
// Windows-1252 的 0x80–0x9F
const CP1252 = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ';
const CP1252_REV = new Map([...CP1252].map((c, i) => [c, 0x80 + i]));

const CJK = /[㐀-鿿豈-﫿　-〿＀-￯]/g;
const decoders = {};
const dec = (enc) => (decoders[enc] = decoders[enc] || new TextDecoder(enc, { fatal: true }));

/** 乱码中常见的字符：Latin-1 补充、CP1252 特殊符号、CP437 制表符 / 希腊字母等 */
function suspicious(c) {
  const n = c.charCodeAt(0);
  return (n >= 0x80 && n <= 0xff) || CP1252_REV.has(c) || (CP437_REV.has(c) && n > 0xff);
}

function toBytes(s, table) {
  const out = [];
  for (const c of s) {
    const n = c.charCodeAt(0);
    if (n < 0x80) out.push(n);
    else if (table === 'cp437') { const b = CP437_REV.get(c); if (b === undefined) return null; out.push(b); }
    else if (CP1252_REV.has(c)) out.push(CP1252_REV.get(c));
    else if (n <= 0xff) out.push(n);
    else return null;
  }
  return Buffer.from(out);
}

const cjkCount = (s) => (s.match(CJK) || []).length;
const badCount = (s) => { let n = 0; for (const c of s) if (suspicious(c) || c === '�' || (c < ' ' && c !== '\n' && c !== '\t' && c !== '\r')) n++; return n; };

/** 修复一段文字中的乱码；看不出乱码时原样返回 */
function fixMojibake(s) {
  if (!s || typeof s !== 'string') return s;
  if (!/[\u0080-ÿ─-■Α-ω†-™]/.test(s)) return s; // 快速路径：没有可疑字符
  let sus = 0, nonSpace = 0;
  for (const c of s) { if (c.trim()) nonSpace++; if (suspicious(c)) sus++; }
  // 只有可疑字符占比高、且原文没有正常中文时才尝试（正常的西文重音字母占比很低）
  if (sus < 2 || sus / Math.max(1, nonSpace) < 0.3 || cjkCount(s) > 0) return s;
  let best = s, bestScore = -badCount(s) * 3;
  for (const [table, enc] of [['cp1252', 'utf-8'], ['cp1252', 'gb18030'], ['cp437', 'gb18030'], ['cp437', 'utf-8'], ['cp1252', 'big5']]) {
    const b = toBytes(s, table);
    if (!b) continue;
    let r;
    try { r = dec(enc).decode(b); } catch { continue; }
    const cj = cjkCount(r);
    if (!cj) continue;
    // 能按 UTF-8 完整解码几乎可以确定原文就是 UTF-8（随机字节很难恰好组成合法 UTF-8），直接采用
    if (enc === 'utf-8' && !badCount(r)) return r;
    const score = cj * 2 - badCount(r) * 3;
    if (score > bestScore) { best = r; bestScore = score; }
  }
  return best;
}

/** 解码 XML 部件：BOM → XML 声明的编码 → UTF-8（乱码时退回 GB18030） */
function decodeXml(buf) {
  if (!buf || !buf.length) return '';
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2));
  if (buf[0] === 0x3c && buf[1] === 0x00) return new TextDecoder('utf-16le').decode(buf);
  if (buf[0] === 0x00 && buf[1] === 0x3c) return new TextDecoder('utf-16be').decode(buf);
  const head = buf.subarray(0, 200).toString('latin1');
  const m = /^<\?xml[^>]*encoding\s*=\s*["']([A-Za-z0-9_\-]+)["']/i.exec(head);
  const enc = m ? m[1].toLowerCase() : 'utf-8';
  if (enc !== 'utf-8' && enc !== 'utf8') {
    try { return new TextDecoder(enc === 'gb2312' || enc === 'gbk' ? 'gb18030' : enc).decode(buf); } catch { /* 不认识的编码：按 UTF-8 */ }
  }
  const s = buf.toString('utf8');
  // 声明为 UTF-8（或没有声明）却解出大量替换字符：多半是 GBK 编码的旧文件
  const bad = (s.match(/�/g) || []).length;
  if (bad >= 3) {
    try { const g = dec('gb18030').decode(buf); if (cjkCount(g) > bad) return g; } catch { /* 不是 GBK */ }
  }
  return s;
}

/** 修复解析结果中的乱码（文档属性、页标题、正文、讲解词、段落）；返回修复的字段数 */
function fixParsed(parsed) {
  let n = 0;
  const fx = (o, k) => { if (o && typeof o[k] === 'string') { const v = fixMojibake(o[k]); if (v !== o[k]) { o[k] = v; n++; } } };
  if (parsed.props) for (const k of ['title', 'subject', 'author', 'keywords', 'lastModifiedBy', 'company']) fx(parsed.props, k);
  for (const s of parsed.slides || []) {
    for (const k of ['title', 'text', 'notes', 'section']) fx(s, k);
    for (const b of s.blocks || []) for (const p of b.paras || []) fx(p, 'text');
  }
  return n;
}

module.exports = { fixMojibake, decodeXml, fixParsed };
