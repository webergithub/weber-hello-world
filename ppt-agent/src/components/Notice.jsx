import React, { useState } from 'react';

// 已关闭的提示栏（v3.9.1）：按 id 记在本机，id 中带上数量 / 状态，情况变化（如重新解析后数量不同）时会重新显示
const KEY = 'ppta.dismissed';
const read = () => { try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; } };
export const isDismissed = (id) => !!(id && read()[id]);
export const dismissNotice = (id) => { try { const m = read(); m[id] = Date.now(); const keys = Object.keys(m); if (keys.length > 2000) for (const k of keys.sort((a, b) => m[a] - m[b]).slice(0, keys.length - 2000)) delete m[k]; localStorage.setItem(KEY, JSON.stringify(m)); } catch { /* ignore */ } };
export const restoreNotices = () => { try { localStorage.removeItem(KEY); } catch { /* ignore */ } };
export const dismissedCount = () => Object.keys(read()).length;

/** 可关闭的提示栏：右侧 ✕ 关闭；id 为空时不可关闭 */
export default function Notice({ id, kind = '', className = '', style, children }) {
  const [hidden, setHidden] = useState(() => isDismissed(id));
  if (hidden) return null;
  return (
    <div className={`notice ${kind} ${id ? 'closable' : ''} ${className}`} style={style}>
      {children}
      {id && <button className="notice-x" title="关闭此提示" onClick={() => { dismissNotice(id); setHidden(true); }}>✕</button>}
    </div>
  );
}
