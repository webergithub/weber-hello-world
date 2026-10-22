import React, { useEffect, useRef, useState } from 'react';
import { api, THEME_LABEL } from '../api';
import { useApp } from '../ctx';
import SlidePreview from './SlidePreview';

// 导出篮：跨文件、跨任务收集页面，调整顺序后导出为新的 PPT / Markdown
export default function BasketView() {
  const app = useApp();
  const { items, remove, move, clear } = app.basket;
  const [slides, setSlides] = useState([]);
  useEffect(() => { Promise.all(items.map((id) => api.slideDetail(id).catch(() => null))).then((l) => setSlides(l.filter(Boolean))); }, [items]);
  // 多选：勾选页面（Shift 连选）后只导出所选页面，顺序与导出篮一致
  const [sel, setSel] = useState(() => new Set());
  const last = useRef(null);
  useEffect(() => { setSel((cur) => new Set([...cur].filter((id) => items.includes(id)))); }, [items]);
  const pick = (id, e) => {
    const n = new Set(sel);
    if (e && e.shiftKey && last.current !== null) {
      const a = items.indexOf(last.current), b = items.indexOf(id);
      const [lo, hi] = a < b ? [a, b] : [b, a];
      for (let k = lo; k <= hi; k++) n.add(items[k]);
    } else if (n.has(id)) n.delete(id); else n.add(id);
    last.current = id; setSel(n);
  };
  const picked = items.filter((id) => sel.has(id));
  const allOn = items.length > 0 && picked.length === items.length;
  return (
    <div className="view">
      <div className="view-head">
        <div className="vh-title">🧺 导出篮 <span className="muted small">{items.length} 页 · 可调整顺序后导出</span></div>
        <div className="spacer" />
        <label className="chk"><input type="checkbox" checked={allOn} disabled={!items.length} onChange={() => setSel(allOn ? new Set() : new Set(items))} /> 全选</label>
        <span className="badge">已选 {picked.length}</span>
        <button className="btn ghost" disabled={!picked.length} onClick={() => { for (const id of picked) remove(id); setSel(new Set()); }}>移除所选</button>
        <button className="btn ghost" disabled={!items.length} onClick={() => confirm('清空导出篮？') && clear()}>清空</button>
        <button className="btn" disabled={!items.length} onClick={() => app.exportSlides(picked.length ? picked : items, 'md')}>⇩ 导出 Markdown{picked.length ? `（所选 ${picked.length}）` : ''}</button>
        <button className="btn primary" disabled={!items.length} onClick={() => app.exportSlides(picked.length ? picked : items, 'pptx')}>⇩ 导出为新 PPT{picked.length ? `（所选 ${picked.length} 页）` : '（全部）'}</button>
      </div>
      <div className="tab-body scroll pad">
        {!items.length && <div className="empty-tip">导出篮为空。在页面视图或搜索结果中多选页面后点击“加入导出篮”。</div>}
        <div className="basket-list">
          {slides.map((s, i) => (
            <div key={s.id} className={`basket-item ${sel.has(s.id) ? 'sel' : ''}`}>
              <input type="checkbox" className="bi-check" checked={sel.has(s.id)} onClick={(e) => pick(s.id, e)} readOnly />
              <div className="bi-no">{i + 1}</div>
              <div className="bi-thumb" data-noopen onClick={() => app.openSlide(s.id)}><SlidePreview slide={s} file={s.file} /></div>
              <div className="bi-info">
                <div className="si-title">{s.title || `第 ${s.idx} 页`}</div>
                <div className="muted small">{s.file && s.file.name} · 第 {s.idx} 页 · <span className={`tag theme-${s.theme}`}>{THEME_LABEL[s.theme]}</span>{s.notes ? ' · 含讲解词' : ''}</div>
              </div>
              <div className="bi-ops">
                <button className="btn tiny" disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
                <button className="btn tiny" disabled={i === slides.length - 1} onClick={() => move(i, 1)}>↓</button>
                <button className="btn tiny" onClick={() => remove(s.id)}>移除</button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
