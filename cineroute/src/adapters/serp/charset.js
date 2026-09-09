/**
 * 结果页的字符编码。
 *
 * 这是纯 HTTP 抓取里最容易踩、又最难发现的一个坑：**百度返回的经常不是
 * UTF-8**。`res.text()` 一律按 UTF-8 解，GBK 的字节进去，出来就是一串
 * "����"——标题和摘要全成乱码，而且**一个错都不报**。你只会觉得
 * "这家引擎抓回来的怎么全是问号"，然后去改选择器，改到天亮也没用。
 *
 * 用无头浏览器时碰不到这件事，因为编码判定是浏览器替你做了。改成自己发
 * 请求，这一步就得自己补上。
 *
 * 判定顺序按可信度从高到低（跟浏览器的做法一致）：
 *
 *   1. BOM                    字节自己说的，最硬，谁都盖不过
 *   2. Content-Type: charset  服务器说的
 *   3. <meta charset>         页面自己说的，只扫开头一段
 *   4. 都没说                 按 UTF-8 解
 *
 * 然后多做一步浏览器不做的事：**解完回头验一眼**。替换字符（U+FFFD）
 * 成片出现就说明编码判错了——正常网页里这个字符基本不会出现，出现几十个
 * 只有一种解释。这时按中文站点最常见的几种编码重解一遍，哪个乱码少用哪个。
 * 多这一步的理由很实在：有些站点的声明本身就是错的，宁可信字节不信声明。
 */

/** 声明里的编码名 → TextDecoder 认得的标签。 */
function normalizeLabel(raw) {
  const s = String(raw || '').trim().toLowerCase().replace(/^["']|["']$/g, '');
  if (!s) return null;
  // GB2312 / GBK 声明的页面里，实际内容经常超出各自的字符范围（生僻字、
  // emoji 兼容区）。一律用最宽的 GB18030 解——字节格式是兼容的，
  // 但不会因为多出来的那些字被解成乱码。
  if (['gb2312', 'gb_2312', 'gb_2312-80', 'gbk', 'csgb2312', 'chinese'].includes(s)) return 'gb18030';
  if (s === 'latin1' || s === 'iso8859-1') return 'iso-8859-1';
  return s;
}

const BOMS = [
  { bytes: [0xEF, 0xBB, 0xBF], charset: 'utf-8' },
  { bytes: [0xFF, 0xFE], charset: 'utf-16le' },
  { bytes: [0xFE, 0xFF], charset: 'utf-16be' },
];

const toBytes = (input) => {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  return new Uint8Array(0);
};

/** 开头几个字节里的 BOM。三字节的 UTF-8 要先判，否则会被两字节的规则截胡。 */
export function charsetFromBom(input) {
  const bytes = toBytes(input);
  for (const b of BOMS) {
    if (bytes.length >= b.bytes.length && b.bytes.every((v, i) => bytes[i] === v)) return b.charset;
  }
  return null;
}

/** `text/html; charset=gbk` 里的那一段。 */
export function charsetFromContentType(contentType) {
  const m = /charset\s*=\s*["']?\s*([\w.:+-]+)/i.exec(String(contentType || ''));
  return m ? normalizeLabel(m[1]) : null;
}

/**
 * 页面自己声明的编码。
 *
 * 只扫开头——规范里是 1024 字节，这里放宽到 2048，有些站点的 <head>
 * 塞了一堆 preload 才轮到 meta。按 latin1 逐字节读：这一段只需要认
 * ASCII 的标签名和属性，用什么编码解都不影响这个正则。
 */
export function charsetFromMeta(input, limit = 2048) {
  const bytes = toBytes(input);
  const n = Math.min(bytes.length, limit);
  let head = '';
  for (let i = 0; i < n; i += 1) head += String.fromCharCode(bytes[i]);
  // <meta charset="gbk"> 和 <meta http-equiv=Content-Type content="…;charset=gbk"> 两种写法
  const m = /<meta[^>]+charset\s*=\s*["']?\s*([\w.:+-]+)/i.exec(head);
  return m ? normalizeLabel(m[1]) : null;
}

/** 解不出来就返回 null（这个 Node 构建不认识这个编码），而不是抛错。 */
function tryDecode(bytes, label) {
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return null;
  }
}

/** 替换字符的个数。编码解错时它会成片出现，是最直接的信号。 */
export function replacementCount(text) {
  let n = 0;
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 0xFFFD) n += 1;
  return n;
}

/** 声明靠不住时，按中文/日文站点的常见程度依次再试。 */
const SNIFF_FALLBACKS = ['gb18030', 'big5', 'shift_jis', 'euc-jp'];
/** 少量替换字符可能是页面里真有这个字符，成片出现才算判错。 */
const SNIFF_THRESHOLD = 3;

/**
 * 把响应字节解成文本。
 *
 * @param {Uint8Array|ArrayBuffer} input
 * @param {string} [contentType] 响应头里的 Content-Type 原文
 * @returns {{text: string, charset: string, source: string,
 *            declared: string|null, note: string|null}}
 *   `source` 是这个编码怎么定下来的：bom / header / meta / default / sniff。
 *   `note` 只在偏离了声明时才有值——这种事要说出来，不能默默换掉。
 */
export function decodeBody(input, contentType = '') {
  const bytes = toBytes(input);
  const bom = charsetFromBom(bytes);
  const header = bom ? null : charsetFromContentType(contentType);
  const meta = charsetFromMeta(bytes);

  const declared = bom || header || meta || null;
  const source = bom ? 'bom' : (header ? 'header' : (meta ? 'meta' : 'default'));
  const first = declared || 'utf-8';

  let charset = first;
  let text = tryDecode(bytes, first);
  if (text == null) {
    // 声明了一个这台机器解不了的编码。别硬撑着装作解开了——按 UTF-8 走，
    // 并把这件事记下来，让上层能显示出来。
    return {
      text: tryDecode(bytes, 'utf-8') ?? '',
      charset: 'utf-8',
      source: 'default',
      declared: first,
      note: `不认识声明的编码 ${first}，已按 utf-8 解码，内容可能有乱码`,
    };
  }

  let bad = replacementCount(text);
  if (bad < SNIFF_THRESHOLD) {
    return { text, charset, source, declared, note: null };
  }

  // 解出来是乱码。按候选逐个重解，取乱码最少的那个。
  // meta 排在最前面：声明冲突时（头里写 utf-8、页面里写 gbk）页面往往更准。
  let note = null;
  const seen = new Set([charset]);
  for (const cand of [meta, ...SNIFF_FALLBACKS]) {
    if (!cand || seen.has(cand)) continue;
    seen.add(cand);
    const alt = tryDecode(bytes, cand);
    if (alt == null) continue;
    const altBad = replacementCount(alt);
    if (altBad < bad) {
      text = alt;
      charset = cand;
      bad = altBad;
      note = declared
        ? `声明的是 ${first}，但按它解出来是乱码，改用 ${cand}`
        : `没有编码声明，按 utf-8 解是乱码，改用 ${cand}`;
      if (bad === 0) break;
    }
  }

  return {
    text,
    charset,
    source: charset === first ? source : 'sniff',
    declared,
    note,
  };
}
