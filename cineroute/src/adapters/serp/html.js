/**
 * 极简 HTML 抽取（零依赖）。
 *
 * 给 http 检索策略用：拿到结果页的 HTML，从里面把链接和文字捞出来。
 * 不做完整的 DOM 解析——那是另一个量级的工程，而结果页真正需要的东西
 * 只有三样：**锚点的 href、锚点的可见文字、锚点后面那段摘要**。
 *
 * 为什么不用正则一把梭：结果页的锚点里嵌着 `<span>`、`<div>`、`<em>`，
 * 而且 href 的引号可能是单引号、双引号或者干脆不加。用正则去匹配
 * `<a[^>]*>(.*?)</a>` 在真实结果页上会大面积漏。这里改成扫描式的：
 * 逐字符走，遇到 `<a` 就解析属性，然后一路数标签层级找到配对的 `</a>`。
 *
 * 这套东西只面对**我们自己请求回来的搜索结果页**，不渲染、不执行，
 * 抽出来的文本一律当第三方内容对待（前端全程 textContent）。
 */

/** HTML 实体。只列真实结果页里会出现的那些，其余走数字实体分支。 */
const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  '#39': "'", '#x27': "'", '#x2F': '/', '#47': '/',
  hellip: '…', mdash: '—', ndash: '–', laquo: '«', raquo: '»',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', middot: '·',
};

/** 解码 HTML 实体，含十进制与十六进制数字实体。 */
export function decodeEntities(s) {
  if (!s || !s.includes('&')) return s || '';
  return String(s).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);?/g, (m, name) => {
    const known = ENTITIES[name] ?? ENTITIES[name.toLowerCase()];
    if (known !== undefined) return known;
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X'
        ? parseInt(name.slice(2), 16)
        : parseInt(name.slice(1), 10);
      // 只接受合法码位，挡掉 &#0; 之类的东西
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try { return String.fromCodePoint(code); } catch { return m; }
      }
    }
    return m;
  });
}

/** 去掉标签，把连续空白压成一个空格。script/style 的内容整段丢掉。 */
export function stripTags(html) {
  return decodeEntities(
    String(html || '')
      .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]*>/g, ' '),
  ).replace(/\s+/g, ' ').trim();
}

/** 解析一个开标签里的属性。引号可以是单/双/无。 */
function parseAttrs(tagBody) {
  const attrs = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m = re.exec(tagBody);
  // 第一个 token 是标签名，跳过
  while ((m = re.exec(tagBody)) !== null) {
    attrs[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return attrs;
}

/**
 * 抽出页面里所有的锚点。
 *
 * @param {string} html
 * @param {{maxAnchors?: number}} [opts]
 * @returns {Array<{href: string, text: string, attrs: object, end: number}>}
 *          `end` 是 `</a>` 之后的位置，用来往后取摘要
 */
export function extractAnchors(html, opts = {}) {
  const { maxAnchors = 500 } = opts;
  const src = String(html || '');
  const out = [];
  let i = 0;

  while (i < src.length && out.length < maxAnchors) {
    const open = src.indexOf('<a', i);
    if (open === -1) break;
    // `<a` 后面必须是空白或 `>`，否则那是 `<abbr>`、`<article>` 之类
    const after = src[open + 2];
    if (after !== undefined && !/[\s>/]/.test(after)) { i = open + 2; continue; }

    const gt = src.indexOf('>', open);
    if (gt === -1) break;
    const attrs = parseAttrs(src.slice(open + 1, gt));
    i = gt + 1;
    if (!attrs.href) continue;

    // 找配对的 </a>。嵌套的 <a> 是非法 HTML，但真实页面里出现过，所以数层级。
    let depth = 1;
    let p = i;
    let close = -1;
    while (p < src.length) {
      const nextOpen = src.indexOf('<a', p);
      const nextClose = src.indexOf('</a', p);
      if (nextClose === -1) break;
      if (nextOpen !== -1 && nextOpen < nextClose && /[\s>/]/.test(src[nextOpen + 2] ?? '>')) {
        depth += 1;
        p = nextOpen + 2;
        continue;
      }
      depth -= 1;
      if (depth === 0) { close = nextClose; break; }
      p = nextClose + 3;
    }
    if (close === -1) close = src.length;

    const endTag = src.indexOf('>', close);
    out.push({
      href: attrs.href,
      text: stripTags(src.slice(i, close)),
      attrs,
      end: endTag === -1 ? close : endTag + 1,
    });
    i = endTag === -1 ? close : endTag + 1;
  }

  return out;
}

/**
 * 取锚点后面那段文字当摘要。
 *
 * 结果页的结构千差万别，但"标题链接后面紧跟一段描述"这个规律相当稳。
 * 取一个窗口的纯文本，掐掉下一个链接开始的地方。
 */
export function snippetAfter(html, pos, maxChars = 400) {
  const src = String(html || '');
  const window = src.slice(pos, pos + maxChars * 4);
  // 遇到下一个链接就停，不然会把下一条结果的标题当成本条的摘要
  const nextA = window.search(/<a[\s>]/i);
  return stripTags(nextA === -1 ? window : window.slice(0, nextA)).slice(0, maxChars);
}

/** 页面标题。 */
export function pageTitle(html) {
  const m = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? stripTags(m[1]) : '';
}

/**
 * 正文的大致字数。
 *
 * 用来判断"是不是被挡了"——验证码页、同意页的正文通常极短。
 * 不能拿整个 HTML 的长度算：现在的结果页里内联脚本能占九成体积，
 * 一个只有验证码的页面 HTML 也可能有几十 KB。
 */
export function visibleTextLength(html) {
  // <head> 里的东西不算正文——尤其是 <title>。验证码页的标题往往不短
  // （"Sorry... - Google 搜索"），把它算进来会让一个只有验证码的页面
  // 看起来"内容挺多"，正好躲过"正文太短 = 疑似被挡"这条判据。
  const body = String(html || '').replace(/<head\b[^>]*>[\s\S]*?<\/head>/i, ' ');
  return stripTags(body).length;
}

/**
 * 把相对地址解析成绝对地址。解析不了就返回 null（而不是抛）。
 */
export function absolutize(href, base) {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}
