// 标签颜色与标签名称缓存（v3.14）：界面各处的标签显示颜色、输入标签时的候选；资料库变化（library 事件）后刷新。
import { useEffect, useState } from 'react';
import { api, on } from './api';

let colors = {};
let names = [];
let loaded = false;
const subs = new Set();
let pending = null;

export function refreshTags() {
  if (pending) return pending;
  pending = Promise.all([api.tagColors(), api.tagCatalog()]).then(([c, cat]) => {
    colors = c || {};
    names = (cat || []).filter((t) => t.state === 'normal').sort((a, b) => b.files - a.files).map((t) => t.name);
    loaded = true;
    for (const f of subs) f();
  }).catch(() => {}).finally(() => { pending = null; });
  return pending;
}
let wired = false;
function wire() { if (wired) return; wired = true; on('library', () => refreshTags()); }

/** 订阅标签颜色 / 名称：{ colors, names } */
export function useTagStore() {
  const [, tick] = useState(0);
  useEffect(() => { wire(); const f = () => tick((x) => x + 1); subs.add(f); if (!loaded) refreshTags(); return () => subs.delete(f); }, []);
  return { colors, names };
}
export const tagColor = (t) => colors[t] || '';
