import React, { useEffect, useState } from 'react';
import { busy } from '../api';

// 接口 → 提示里显示的内容
const WHAT = { library: '资料库', overview: '资料库总览', categories: '分类与标签', taskDetail: '任务详情', analytics: '总览统计', groups: '相似分组', history: '解析历史',
  fileDetail: '文件', slideDetail: '页面', notesChanges: '讲解词修改', recycleList: '回收站', searchHistory: '搜索历史', searchHistoryResult: '搜索结果', subtaskFiles: '子任务清单', summaryList: '总结列表', related: '相关推荐', exportSlides: '导出', convertSlides: '黑白底转换', generateDeck: '生成 PPT' };

/** 全局“正在加载…”提示（v3.8）：任何接口超过 0.3 秒还没返回时显示在内容区中央（v3.11），返回后消失 */
export default function BusyHint() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const off = busy.subscribe(() => setTick((x) => x + 1));
    const iv = setInterval(() => setTick((x) => x + 1), 200);
    return () => { off(); clearInterval(iv); };
  }, []);
  const o = busy.oldest();
  if (!o || Date.now() - o.t0 < 300) return null;
  const sec = Math.floor((Date.now() - o.t0) / 1000);
  // 居中到右侧内容区（去掉侧栏宽度）
  const sb = document.querySelector('.sidebar');
  const dx = sb ? sb.getBoundingClientRect().width / 2 : 0;
  return <div className="busy-hint" role="status" style={{ '--busy-dx': `${dx}px` }}><span className="spin" />正在加载{WHAT[o.method] ? `${WHAT[o.method]}` : '数据'}…{sec >= 2 ? ` ${sec}s` : ''}</div>;
}
