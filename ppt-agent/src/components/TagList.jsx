import React from 'react';
import { useTagStore } from '../tagStore';

/** 列表中的标签：最多显示 max 个，其余折叠为“+N”（悬停显示全部）；手动添加的标签带 ✎ 标记，按标签颜色显示（v3.14） */
export default function TagList({ tags, manual, max = 8 }) {
  const { colors } = useTagStore();
  const list = tags || [];
  const man = new Set(manual || []);
  return (
    <span title={list.length > max ? list.join('、') : undefined}>
      {list.slice(0, max).map((t) => <span key={t} className={`tag ${colors[t] ? `tc-${colors[t]}` : ''} ${man.has(t) ? 'manual' : ''}`}>{t}</span>)}
      {list.length > max && <span className="tag-more">+{list.length - max}</span>}
    </span>
  );
}
