import React, { useEffect, useRef, useState } from 'react';

/**
 * 长列表分批显示（v3.8）：先显示 step 条，列表底部的标记进入可视区域时再追加；
 * keepIndex 为必须可见的条目下标（如当前选中的文件），超出时直接显示到那一条。
 * 返回 { items, more, sentinel }：渲染 items，并把 sentinel 放在列表最后。
 */
export function useIncremental(list, { step = 200, resetKey, keepIndex = -1 } = {}) {
  const [n, setN] = useState(step);
  const ref = useRef(null);
  useEffect(() => { setN(step); }, [resetKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (keepIndex >= n) setN(keepIndex + 50); }, [keepIndex]); // eslint-disable-line react-hooks/exhaustive-deps
  const more = Math.max(0, list.length - n);
  useEffect(() => {
    const el = ref.current;
    if (!el || !more || typeof IntersectionObserver === 'undefined') return undefined;
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) setN((x) => x + step * 2); }, { rootMargin: '400px' });
    io.observe(el);
    return () => io.disconnect();
  }, [more, step]);
  const items = more ? list.slice(0, n) : list;
  const sentinel = more ? React.createElement('div', { ref, className: 'inc-more', onClick: () => setN((x) => x + step * 5) }, `已显示 ${items.length} / ${list.length}，继续滚动加载`) : null;
  return { items, more, sentinel };
}
