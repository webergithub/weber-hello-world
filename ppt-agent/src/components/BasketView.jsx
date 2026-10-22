import React, { useEffect, useState } from 'react';
import { api, THEME_LABEL } from '../api';
import { useApp } from '../ctx';
import SlidePreview from './SlidePreview';

// 导出篮：跨文件、跨任务收集页面，调整顺序后导出为新的 PPT / Markdown
export default function BasketView() {
  const app = useApp();
  const { items, remove, move, clear } = app.basket;
  const [slides, setSlides] = useState([]);
  useEffect(() => { Promise.all(items.map((id) => api.slideDetail(id).catch(() => null))).then((l) => setSlides(l.filter(Boolean))); }, [items]);
  return (
    <div className="view">
      <div className="view-head">
        <div className="vh-title">🧺 导出篮 <span className="muted small">{items.length} 页 · 可调整顺序后导出</span></div>
        <div className="spacer" />
        <button className="btn ghost" disabled={!items.length} onClick={() => confirm('清空导出篮？') && clear()}>清空</button>
        <button className="btn" disabled={!items.length} onClick={() => app.exportSlides(items, 'md')}>⇩ 导出 Markdown</button>
        <button className="btn primary" disabled={!items.length} onClick={() => app.exportSlides(items, 'pptx')}>⇩ 导出为新 PPT</button>
      </div>
      <div className="tab-body scroll pad">
        {!items.length && <div className="empty-tip">导出篮为空。在页面视图或搜索结果中多选页面后点击“加入导出篮”。</div>}
        <div className="basket-list">
          {slides.map((s, i) => (
            <div key={s.id} className="basket-item">
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
