/**
 * 主页与设置页共用的 DOM 小工具。
 *
 * 抽出来的理由不只是省代码：`el()` 里"字符串一律走 textContent"这条规矩
 * 是这个项目的安全底线——片名、文件名、页面标题全都来自第三方站点，
 * 是用户上传的内容。两个页面各写一份迟早会有一份写成 innerHTML。
 */

export const $ = (id) => document.getElementById(id);

/** 图片加载失败就隐藏，不留破图占位（第三方图床可能不可达）。 */
export function img(props) {
  const node = document.createElement('img');
  node.addEventListener('error', () => node.classList.add('broken'), { once: true });
  for (const [k, v] of Object.entries(props)) if (v != null) node.setAttribute(k, v);
  return node;
}

/** 安全的元素构造器：children 传字符串时走 textContent。 */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(typeof c === 'string' || typeof c === 'number' ? String(c) : c);
  }
  return node;
}

export const fmtSize = (b) => {
  if (!b) return '—';
  const mb = b / 1024 / 1024;
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${Math.round(mb)} MB`;
};

export const fmtDuration = (s) => {
  if (!s) return '—';
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return h > 0 ? `${h} 时 ${String(m).padStart(2, '0')} 分` : `${m} 分钟`;
};

export const fmtSpeed = (bps) => (bps > 0 ? `${fmtSize(bps)}/s` : '—');

export const ENGINE_LABELS = {
  google: 'Google', bing: 'Bing', baidu: '百度', yandex: 'Yandex', duckduckgo: 'DuckDuckGo',
};

export const engineLabel = (engine) => ENGINE_LABELS[engine]
  || (engine ? engine[0].toUpperCase() + engine.slice(1) : engine);

/** 中文名后不加空格（「百度搜索」），西文名后加（「Google 搜索」）。 */
export const engineTitle = (engine) => {
  const n = engineLabel(engine);
  return `${n}${/[一-龥]$/.test(n) ? '' : ' '}搜索`;
};

/** 后端的人话说明。设置页和主页状态条共用，免得两处说法不一致。 */
export const BACKEND_LABEL = {
  api: 'SERP 服务（付费接口）',
  cli: '本机命令行工具',
  browser: '无头浏览器打开结果页',
};

/** 一行一个、去空白的文本框读法。域名列表、站点范围都用它。 */
export const linesOf = (text) => String(text || '').split('\n').map((s) => s.trim()).filter(Boolean);
