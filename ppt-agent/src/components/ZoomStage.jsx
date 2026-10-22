import React, { useEffect, useRef, useState } from 'react';

export const ZOOM_MIN = 0.2;
export const ZOOM_MAX = 8;
export const FIT = { z: 1, x: 0, y: 0 };
const clamp = (z) => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));

/** 以 (cx, cy)（相对舞台中心的坐标）为中心缩放到 z2 */
export function zoomAt(v, z2, cx = 0, cy = 0) {
  z2 = clamp(z2);
  const k = z2 / v.z;
  return { z: z2, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k };
}
export const zoomBy = (v, f) => zoomAt(v, v.z * f);

/**
 * 页面无级缩放：Ctrl + 滚轮以鼠标位置为中心缩放；放大后可拖动平移、滚轮平移；
 * 右下角工具条：－ / 缩放比例滑块 / ＋ / “适配窗口”。view / setView 为 { z, x, y }，由外部保存（便于键盘快捷键控制）。
 */
export default function ZoomStage({ view, setView, children, className = '' }) {
  const box = useRef(null);
  const drag = useRef(null);
  const [dragging, setDragging] = useState(false);
  const v = view || FIT;
  useEffect(() => {
    const el = box.current;
    if (!el) return undefined;
    const wheel = (e) => {
      const r = el.getBoundingClientRect();
      const cx = e.clientX - r.left - r.width / 2, cy = e.clientY - r.top - r.height / 2;
      if (e.ctrlKey || e.metaKey) { e.preventDefault(); setView((cur) => zoomAt(cur || FIT, (cur || FIT).z * Math.exp(-e.deltaY * 0.0015), cx, cy)); }
      else if ((view || FIT).z > 1.001) { e.preventDefault(); setView((cur) => ({ ...cur, x: cur.x - e.deltaX, y: cur.y - e.deltaY })); }
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, [setView, view && view.z > 1.001]);
  const onDown = (e) => {
    if (e.button !== 0 || v.z <= 1.001) return;
    drag.current = { sx: e.clientX, sy: e.clientY, x: v.x, y: v.y };
    setDragging(true);
    const move = (ev) => { const d = drag.current; if (d) setView((cur) => ({ ...cur, x: d.x + ev.clientX - d.sx, y: d.y + ev.clientY - d.sy })); };
    const up = () => { drag.current = null; setDragging(false); window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
  const fit = Math.abs(v.z - 1) < 0.001 && !v.x && !v.y;
  const pct = Math.round(v.z * 100);
  return (
    <div ref={box} className={`zoom-stage ${v.z > 1.001 ? 'zoomed' : ''} ${dragging ? 'dragging' : ''} ${className}`} onMouseDown={onDown}>
      <div className="zoom-inner" style={{ transform: `translate(${v.x}px, ${v.y}px) scale(${v.z})` }}>{children}</div>
      <div className="zoom-bar" onMouseDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
        <button title="缩小（Ctrl + 滚轮）" onClick={() => setView((cur) => zoomBy(cur || FIT, 1 / 1.25))}>－</button>
        <input type="range" min={Math.log(ZOOM_MIN)} max={Math.log(ZOOM_MAX)} step="0.01" value={Math.log(v.z)} title="拖动无级缩放" onChange={(e) => setView((cur) => zoomAt(cur || FIT, Math.exp(Number(e.target.value))))} />
        <button title="放大（Ctrl + 滚轮）" onClick={() => setView((cur) => zoomBy(cur || FIT, 1.25))}>＋</button>
        <span className="zoom-pct">{pct}%</span>
        <button className={`zoom-fit ${fit ? '' : 'on'}`} disabled={fit} title="恢复到适配窗口的大小" onClick={() => setView(FIT)}>⤢ 适配窗口</button>
      </div>
    </div>
  );
}
