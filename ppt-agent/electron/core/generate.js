'use strict';
// 智能生成：根据用户描述（主题 + 版式要求）匹配候选页面，并按相似度聚类：每组是一种“不同内容”的页面，组内是相似页（可替换的变体）。
const { cosine } = require('./vectors');

// 版式意图：描述中的关键词 → 页面结构判定
const FORMATS = [
  { key: 'compare', label: '对比 / 比较', words: ['对比', '比较', '差异', '优劣', '优缺点', '异同', 'vs', 'versus', 'comparison', 'compare', 'pros and cons'], test: (f) => f.twoCol || /对比|比较|vs\.?|versus|comparison|优劣|差异/i.test(f.title) },
  { key: 'agenda', label: '目录 / 议程', words: ['目录', '议程', '大纲', 'agenda', 'contents', 'outline'], test: (f) => /目录|议程|大纲|agenda|contents|outline/i.test(f.title) },
  { key: 'cover', label: '封面 / 标题页', words: ['封面', '标题页', '首页', 'cover', 'title slide'], test: (f) => f.isTitle },
  { key: 'timeline', label: '时间线 / 路线图', words: ['时间线', '时间轴', '路线图', '里程碑', '规划', 'roadmap', 'timeline', 'milestone'], test: (f) => f.row >= 4 || /时间线|时间轴|路线图|里程碑|规划|roadmap|timeline|milestone|计划/i.test(f.title) },
  { key: 'process', label: '流程 / 步骤', words: ['流程', '步骤', '工序', '环节', 'process', 'workflow', 'steps', 'flow'], test: (f) => f.row >= 3 || f.shapes >= 4 || /流程|步骤|环节|process|flow|steps|甘特/i.test(f.title) },
  { key: 'table', label: '表格', words: ['表格', '数据表', 'table'], test: (f) => f.hasTable },
  { key: 'chart', label: '图表 / 趋势', words: ['图表', '趋势', '曲线', '柱状图', '饼图', 'chart', 'trend', 'graph'], test: (f) => f.hasChart },
  { key: 'arch', label: '架构 / 框架', words: ['架构', '框架', '体系', 'architecture', 'framework'], test: (f) => f.shapes >= 3 || /架构|框架|体系|architecture|framework/i.test(f.title) },
  { key: 'end', label: '总结 / 结束页', words: ['总结', '结束页', '结尾', '谢谢', '致谢', 'summary', 'thank', 'q&a'], test: (f) => f.isEnd },
  { key: 'image', label: '图片 / 照片', words: ['图片', '照片', '配图', 'picture', 'photo', 'image'], test: (f) => f.pics >= 1 },
];

function slideFeatures(s) {
  const L = s.layout;
  const title = String(s.title || '');
  const f = { title, twoCol: false, row: 0, shapes: 0, pics: 0, hasTable: false, hasChart: false, isTitle: false, isEnd: false };
  if (!L || !L.items) return f;
  const items = L.items.filter((i) => !i.title && i.ph !== 'title' && i.ph !== 'ctrTitle');
  const content = items.filter((i) => (i.t === 'text' && (i.paras || []).some((p) => (p.text || '').trim())) || i.t === 'table' || i.t === 'pic' || i.t === 'chart' || i.t === 'video');
  f.hasTable = items.some((i) => i.t === 'table');
  f.hasChart = items.some((i) => i.t === 'chart');
  f.pics = items.filter((i) => i.t === 'pic' && i.w * i.h < 0.85).length;
  f.shapes = items.filter((i) => i.t === 'text' && i.fill).length;
  // 左右并列：两个内容块宽度都小于 60%，水平不重叠、垂直方向大部分重叠
  const big = content.filter((i) => i.w * i.h > 0.04 && i.w < 0.6);
  for (let a = 0; a < big.length && !f.twoCol; a++) {
    for (let b = a + 1; b < big.length; b++) {
      const A = big[a], B = big[b];
      const hOverlap = Math.min(A.x + A.w, B.x + B.w) - Math.max(A.x, B.x);
      const vOverlap = Math.min(A.y + A.h, B.y + B.h) - Math.max(A.y, B.y);
      if (hOverlap <= 0.02 && vOverlap > 0.5 * Math.min(A.h, B.h)) { f.twoCol = true; break; }
    }
  }
  // 同一水平线上排列的形状数（时间线 / 流程）
  const blocks = items.filter((i) => i.t === 'text' || i.t === 'shape');
  for (const a of blocks) {
    const cy = a.y + a.h / 2;
    const n = blocks.filter((b) => Math.abs(b.y + b.h / 2 - cy) < 0.05 && b.w < 0.35).length;
    f.row = Math.max(f.row, n);
  }
  const textLen = String(s.text || '').length;
  f.isTitle = (s.idx === 1 && textLen < 200) || items.some((i) => i.ph === 'ctrTitle');
  f.isEnd = /谢谢|致谢|thank|q\s*&\s*a|总结|结束|summary|conclusion/i.test(title) || (/谢谢|thank you/i.test(s.text || '') && textLen < 60);
  return f;
}

/** 从描述中识别版式意图，并返回去掉版式词后的主题文本 */
function parseIntent(desc) {
  let topic = ` ${String(desc || '')} `;
  const formats = [];
  for (const fm of FORMATS) {
    let hit = false;
    for (const w of fm.words) {
      const re = new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      if (re.test(topic)) { hit = true; topic = topic.replace(re, ' '); }
    }
    if (hit) formats.push(fm);
  }
  topic = topic.replace(/(的|一份|一个|一页|几页|生成|制作|帮我|给我|请|需要|关于|有关|模板|格式|样式|页面|ppt|幻灯片|做|找|要求|版式|类型|包含|包括|以及|还有|和|与|及)/gi, ' ')
    .replace(/[，,、；;。.!！?？:：]+/g, ' ').replace(/\s+/g, ' ').trim();
  return { formats, topic };
}

/**
 * 贪心聚类：按得分从高到低，与已有组代表页相似度 ≥ threshold 的归为该组的相似页，否则新建一组。
 * cands: [{ slide, file, score, vec }]
 */
function cluster(cands, threshold) {
  const rows = [];
  for (const c of cands) {
    let best = null, bestSim = 0;
    for (const r of rows) {
      const sim = cosine(c.vec, r.rep.vec);
      if (sim > bestSim) { bestSim = sim; best = r; }
    }
    if (best && bestSim >= threshold) best.variants.push({ ...c, sim: bestSim });
    else rows.push({ rep: { ...c, sim: 1 }, variants: [] });
  }
  return rows;
}

/** 生成顺序：封面 → 目录 → 正文（按得分）→ 总结 / 结束 */
function orderRows(rows) {
  const cover = rows.find((r) => r.feat.isTitle);
  const rank = (r) => (r === cover ? 0 : /目录|议程|agenda|contents/i.test(r.feat.title) ? 1 : r.feat.isEnd ? 3 : 2);
  return rows.map((r, i) => ({ r, i })).sort((a, b) => rank(a.r) - rank(b.r) || a.i - b.i).map((x) => x.r);
}

module.exports = { FORMATS, slideFeatures, parseIntent, cluster, orderRows };
