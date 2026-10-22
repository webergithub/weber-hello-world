import React from 'react';

/** 列表中的标签：最多显示 max 个，其余折叠为“+N”（悬停显示全部） */
export default function TagList({ tags, max = 8 }) {
  const list = tags || [];
  return (
    <span title={list.length > max ? list.join('、') : undefined}>
      {list.slice(0, max).map((t) => <span key={t} className="tag">{t}</span>)}
      {list.length > max && <span className="tag-more">+{list.length - max}</span>}
    </span>
  );
}
