import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, THEME_LABEL, unitOf } from '../api';
import { useApp } from '../ctx';
import { renderMarkdown, highlight } from '../md';
import { PanelLayout, useStoredLayout, DEFAULT_LAYOUT, NotesBody, MdBody, onSlideUpdated } from './Panels';

const esc = (t) => String(t || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
import SlidePreview from './SlidePreview';
import { loadSlide } from './SlideWorkspace';

const fileCache = new Map();
function loadFile(id) {
  if (!fileCache.has(id)) fileCache.set(id, api.fileDetail(id));
  return fileCache.get(id);
}
export function clearFileCache() { fileCache.clear(); }

/**
 * 逐页浏览：每页单独完整展示。
 * ← →：当前文件的上一页 / 下一页；↑ ↓：上一个 / 下一个文件；Home / End：首页 / 末页；空格：加入 / 移出导出篮。
 * fileIds：可切换的文件顺序（如搜索结果的文件顺序）；matched：命中的页面 id（在缩略条上标记）
 */
export default function SlideViewer({ fileIds, initialFileId, initialSlideId, terms = [], matched = [], onClose, active = true, compact = false, onFileChange }) {
  const app = useApp();
  const ids = useMemo(() => (fileIds && fileIds.length ? fileIds : initialFileId ? [initialFileId] : []), [fileIds, initialFileId]);
  const [fileId, setFileId] = useState(initialFileId || ids[0]);
  const [detail, setDetail] = useState(null);
  const [slideId, setSlideId] = useState(initialSlideId || null);
  const [slide, setSlide] = useState(null);
  const [mdMode, setMdMode] = useState('render');
  const pendingLast = useRef(false);
  const strip = useRef(null);
  const root = useRef(null);
  const [maxed, setMaxed] = useState(() => { try { return localStorage.getItem('ppta.viewerMax') === '1'; } catch { return false; } });
  const [panes, setPanes] = useState(true);
  const [layout, setLayout] = useStoredLayout('ppta.viewerLayout');
  const [notesTab, setNotesTab] = useState('orig');
  useEffect(() => onSlideUpdated((s2) => setSlide((cur) => (cur && cur.id === s2.id ? s2 : cur))), []);
  const [osd, setOsd] = useState(null);
  const osdTimer = useRef(null);
  const toggleMax = useCallback(() => setMaxed((m) => { try { localStorage.setItem('ppta.viewerMax', m ? '0' : '1'); } catch { /* ignore */ } return !m; }), []);
  const toggleFull = useCallback(() => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else if (root.current && root.current.requestFullscreen) root.current.requestFullscreen().catch(() => {});
  }, []);
  const matchedSet = useMemo(() => new Set(matched), [matched]);

  useEffect(() => { if (initialFileId) setFileId(initialFileId); if (initialSlideId) setSlideId(initialSlideId); }, [initialFileId, initialSlideId]);
  useEffect(() => { if (onFileChange && fileId) onFileChange(fileId); }, [fileId]);
  useEffect(() => {
    let off = false;
    if (!fileId) return;
    loadFile(fileId).then((d) => {
      if (off || !d) return;
      setDetail(d);
      const has = d.slides.some((s) => s.id === slideId);
      if (!has && d.slides.length) setSlideId(pendingLast.current ? d.slides[d.slides.length - 1].id : d.slides[0].id);
      if (!d.slides.length) { setSlideId(null); setSlide(null); }
      pendingLast.current = false;
    });
    return () => { off = true; };
  }, [fileId]);
  useEffect(() => {
    let off = false;
    if (!slideId) return;
    loadSlide(slideId).then((s) => { if (!off) setSlide(s); });
    const el = strip.current && strip.current.querySelector(`[data-vid="${slideId}"]`);
    if (el) el.scrollIntoView({ block: 'nearest', inline: 'center' });
    return () => { off = true; };
  }, [slideId]);

  const slides = detail ? detail.slides : [];
  const pos = slides.findIndex((s) => s.id === slideId);
  const fpos = ids.indexOf(fileId);
  const goFile = useCallback((d, last = false) => {
    const j = Math.max(0, Math.min(ids.length - 1, fpos + d));
    if (j === fpos || j < 0) return false;
    pendingLast.current = last;
    setFileId(ids[j]);
    return true;
  }, [fpos, ids]);
  // 翻页：到达文件末页 / 首页时继续进入下一个 / 上一个文件（wrap = true）
  const go = useCallback((d, wrap = false) => {
    const j = pos + d;
    if (j >= 0 && j < slides.length) { setSlideId(slides[j].id); return; }
    if (wrap && d > 0 && pos === slides.length - 1) goFile(1, false);
    else if (wrap && d < 0 && pos === 0) goFile(-1, true);
    else if (slides.length) setSlideId(slides[Math.max(0, Math.min(slides.length - 1, j))].id);
  }, [pos, slides, goFile]);
  const inBasket = slide && app.basket.items.includes(slide.id);
  const toggleBasket = useCallback(() => { if (!slide) return; if (app.basket.items.includes(slide.id)) app.basket.remove(slide.id); else app.basket.add([slide.id]); }, [slide, app.basket]);

  useEffect(() => {
    if (!active) return undefined;
    const k = (e) => {
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      const ctrl = e.ctrlKey || e.metaKey;
      let handled = true;
      switch (e.key) {
        case 'ArrowRight': if (ctrl) { if (slides.length) setSlideId(slides[slides.length - 1].id); } else go(e.shiftKey ? 5 : 1, !e.shiftKey); break;
        case 'ArrowLeft': if (ctrl) { if (slides.length) setSlideId(slides[0].id); } else go(e.shiftKey ? -5 : -1, !e.shiftKey); break;
        case 'ArrowDown': goFile(e.shiftKey ? 5 : 1); break;
        case 'ArrowUp': goFile(e.shiftKey ? -5 : -1); break;
        case 'PageDown': go(1, true); break;
        case 'PageUp': go(-1, true); break;
        case 'Home': if (ctrl) { if (ids.length) setFileId(ids[0]); } else if (slides.length) setSlideId(slides[0].id); break;
        case 'End': if (ctrl) { if (ids.length) setFileId(ids[ids.length - 1]); } else if (slides.length) setSlideId(slides[slides.length - 1].id); break;
        case ' ': toggleBasket(); break;
        case 'Enter': case 'f': case 'F': if (e.shiftKey) toggleFull(); else toggleMax(); break;
        case 'n': case 'N': setPanes((v) => !v); break;
        case 'l': case 'L': setLayout((l) => ({ ...l, mode: l.mode === 'tb' ? 'lr' : 'tb' })); break;
        case 'Escape':
          if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
          else if (maxed) toggleMax();
          else if (onClose) onClose();
          break;
        default: handled = false;
      }
      if (handled) { e.preventDefault(); e.stopPropagation(); }
    };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, [active, go, goFile, slides, ids, toggleBasket, onClose, maxed, toggleMax, toggleFull, setLayout]);

  // 翻页 / 切换文件时的屏幕提示
  useEffect(() => {
    if (!detail || pos < 0) return;
    setOsd(`文件 ${fpos + 1}/${ids.length} · 第 ${pos + 1}/${slides.length} ${unitOf(detail.source)}`);
    clearTimeout(osdTimer.current);
    osdTimer.current = setTimeout(() => setOsd(null), 1100);
  }, [slideId, fileId]);

  const unit = unitOf(detail && detail.source);
  const switchCounterpart = (cp) => { setFileId(cp.fileId); setSlideId(cp.id); };

  return (
    <div ref={root} className={`viewer ${compact ? 'compact' : ''} ${maxed ? 'maxed' : ''}`}>
      {osd && <div className="viewer-osd">{osd}</div>}
      <div className="viewer-bar">
        <button className="btn small" disabled={fpos <= 0} onClick={() => goFile(-1)} title="上一个文件（↑）">▲ 上个文件</button>
        <button className="btn small" disabled={fpos < 0 || fpos >= ids.length - 1} onClick={() => goFile(1)} title="下一个文件（↓）">▼ 下个文件</button>
        <div className="vb-file">
          <b>{detail ? detail.file.name : ''}</b>
          <span className="muted small"> 文件 {fpos + 1}/{ids.length}</span>
        </div>
        <div className="spacer" />
        <button className="btn small" disabled={pos <= 0} onClick={() => go(-1)} title="上一页（←）">◀</button>
        <span className="vb-page">{unit === '节' ? '第' : '第'} {pos + 1} / {slides.length} {unit}</span>
        <button className="btn small" disabled={pos < 0 || pos >= slides.length - 1} onClick={() => go(1)} title="下一页（→）">▶</button>
        {slide && slide.counterpart && <button className="btn small" onClick={() => switchCounterpart(slide.counterpart)}>⇄ 切换到{THEME_LABEL[slide.counterpart.theme]}版本</button>}
        <button className={`btn small ${inBasket ? 'primary' : ''}`} disabled={!slide} onClick={toggleBasket} title="空格">{inBasket ? '✓ 已在导出篮' : '＋ 加入导出篮'}</button>
        {detail && <button className="btn small ghost" onClick={() => api.openPath(detail.file.path)}>打开原文件</button>}
        <div className="seg small" title="三个模块的排列方式（L 键切换）">
          <button className={layout.mode === 'tb' ? 'on' : ''} onClick={() => setLayout((l) => ({ ...l, mode: 'tb' }))}>上1下2</button>
          <button className={layout.mode === 'lr' ? 'on' : ''} onClick={() => setLayout((l) => ({ ...l, mode: 'lr' }))}>左1右2</button>
        </div>
        <button className="btn small ghost" title="恢复默认布局" onClick={() => setLayout(DEFAULT_LAYOUT)}>↺ 布局</button>
        <button className="btn small" onClick={() => setPanes(!panes)} title="N">{panes ? '隐藏讲解词/MD' : '显示讲解词/MD'}</button>
        <button className="btn small" onClick={toggleMax} title="Enter / F">{maxed ? '🗗 还原窗口' : '⛶ 最大化'}</button>
        <button className="btn small" onClick={toggleFull} title="Shift+F">🖵 全屏</button>
        {onClose && <button className="icon-btn" onClick={onClose}>✕</button>}
      </div>
      <div className="viewer-keys muted small">← → 翻页（到末页自动进入下一个文件）· Shift+← → 跳 5 页 · Ctrl+← → 首/末页 · ↑ ↓ 上/下一个文件（Shift 跳 5 个）· Ctrl+Home/End 第一个/最后一个文件 · Enter/F 最大化 · Shift+F 全屏 · N 显示/隐藏讲解词与 MD · L 切换上1下2/左1右2 · 拖动模块标题栏可交换位置，拖动分隔条调整大小 · 空格 加入/移出导出篮 · Esc {maxed ? '还原' : onClose ? '关闭' : ''}</div>
      {slide ? (() => {
        const panels = {
          slide: {
            title: unit === '节' ? '📄 文档内容' : '🖼 PPT 页面',
            body: (
              <div className="vp-slide">
                <div className="viewer-title">
                  <span className="dh-title">{slide.title || `第 ${slide.idx} ${unit}`}</span>
                  {unit === '页' && <span className={`tag theme-${slide.theme}`}>{THEME_LABEL[slide.theme]}</span>}
                  {matchedSet.has(slide.id) && <span className="tag hit">检索命中</span>}
                  {slide.hidden && <span className="tag">隐藏页</span>}
                  <span className="muted small ellipsis" title={slide.file && slide.file.path}>{slide.file && slide.file.path}</span>
                </div>
                {slide.counterpart && <div className="hint-bar">⇄ 该页有内容相近的 <b>{THEME_LABEL[slide.counterpart.theme]}</b> 版本：{slide.counterpart.fileName} 第 {slide.counterpart.idx} 页 <button className="btn small" onClick={() => switchCounterpart(slide.counterpart)}>切换查看</button></div>}
                <div className="viewer-stage">
                  <button className="stage-nav left" disabled={pos <= 0 && fpos <= 0} onClick={() => go(-1, true)}>‹</button>
                  <div className="stage-slide" onDoubleClick={toggleMax} title="双击最大化 / 还原" style={{ '--ratio': slide.layout ? slide.layout.w / slide.layout.h : 16 / 9 }}><SlidePreview slide={slide} file={detail && detail.source} full highlight={terms} /></div>
                  <button className="stage-nav right" disabled={pos >= slides.length - 1 && fpos >= ids.length - 1} onClick={() => go(1, true)}>›</button>
                </div>
                <div className="viewer-strip" ref={strip}>
                  {slides.map((s2) => (
                    <div key={s2.id} data-vid={s2.id} className={`strip-item ${s2.id === slideId ? 'active' : ''} ${matchedSet.has(s2.id) ? 'hit' : ''}`} onClick={() => setSlideId(s2.id)} title={s2.title}>
                      <SlidePreview slide={s2} file={detail.source} />
                      <span>{s2.idx}</span>
                    </div>
                  ))}
                </div>
              </div>
            ),
          },
          notes: {
            title: unit === '节' ? '💬 批注' : '🗣 讲解词（备注）',
            body: <NotesBody slide={slide} terms={terms} unit={unit} tab={notesTab} setTab={setNotesTab} />,
          },
          md: {
            title: '📝 解析 Markdown',
            body: <MdBody slide={slide} terms={terms} onGenerated={() => setNotesTab('ai')} />,
          },
        };
        return <PanelLayout panels={panels} layout={layout} setLayout={setLayout} hideSub={!panes} />;
      })() : <div className="empty-tip">{ids.length ? '加载中…' : '没有可浏览的文件'}</div>}
    </div>
  );
}

