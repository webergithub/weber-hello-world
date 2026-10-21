import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, THEME_LABEL, unitOf } from '../api';
import { useApp } from '../ctx';
import { renderMarkdown, highlight } from '../md';

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
export default function SlideViewer({ fileIds, initialFileId, initialSlideId, terms = [], matched = [], onClose, active = true, compact = false }) {
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
  const [layout, setLayoutState] = useState(loadLayout);
  const setLayout = useCallback((upd) => setLayoutState((cur) => { const n = typeof upd === 'function' ? upd(cur) : upd; saveLayout(n); return n; }), []);
  const [osd, setOsd] = useState(null);
  const osdTimer = useRef(null);
  const toggleMax = useCallback(() => setMaxed((m) => { try { localStorage.setItem('ppta.viewerMax', m ? '0' : '1'); } catch { /* ignore */ } return !m; }), []);
  const toggleFull = useCallback(() => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else if (root.current && root.current.requestFullscreen) root.current.requestFullscreen().catch(() => {});
  }, []);
  const matchedSet = useMemo(() => new Set(matched), [matched]);

  useEffect(() => { if (initialFileId) setFileId(initialFileId); if (initialSlideId) setSlideId(initialSlideId); }, [initialFileId, initialSlideId]);
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
            body: <div className="pane-body notes" dangerouslySetInnerHTML={{ __html: slide.notes ? highlight(esc(slide.notes), terms) : '<span class="muted">（无）</span>' }} />,
          },
          md: {
            title: '📝 解析 Markdown',
            extra: (
              <>
                <button className={`btn tiny ${mdMode === 'render' ? 'on' : ''}`} onClick={() => setMdMode('render')}>预览</button>
                <button className={`btn tiny ${mdMode === 'raw' ? 'on' : ''}`} onClick={() => setMdMode('raw')}>源码</button>
              </>
            ),
            body: mdMode === 'raw' ? <pre className="pane-body md-raw">{slide.md}</pre> : <div className="pane-body md" dangerouslySetInnerHTML={{ __html: renderMarkdown(slide.md, terms) }} />,
          },
        };
        return <PanelLayout panels={panels} layout={layout} setLayout={setLayout} hideSub={!panes} />;
      })() : <div className="empty-tip">{ids.length ? '加载中…' : '没有可浏览的文件'}</div>}
    </div>
  );
}

// ================= 三模块布局：主区 1 个 + 副区 2 个 =================
const DEFAULT_LAYOUT = { mode: 'tb', slots: ['slide', 'notes', 'md'], main: 64, sub: 50, min: [] };
function loadLayout() {
  try {
    const l = { ...DEFAULT_LAYOUT, ...JSON.parse(localStorage.getItem('ppta.viewerLayout') || '{}') };
    if (!Array.isArray(l.slots) || l.slots.slice().sort().join() !== 'md,notes,slide') l.slots = DEFAULT_LAYOUT.slots;
    if (!Array.isArray(l.min)) l.min = [];
    return l;
  } catch { return DEFAULT_LAYOUT; }
}
function saveLayout(l) { try { localStorage.setItem('ppta.viewerLayout', JSON.stringify(l)); } catch { /* ignore */ } }

/** 拖动分隔条：返回 onMouseDown，按容器尺寸换算为百分比 */
function useSplitter(getBox, horizontal, onChange) {
  return (e) => {
    e.preventDefault();
    const box = getBox();
    if (!box) return;
    const rect = box.getBoundingClientRect();
    const move = (ev) => {
      const pct = horizontal ? ((ev.clientX - rect.left) / rect.width) * 100 : ((ev.clientY - rect.top) / rect.height) * 100;
      onChange(Math.max(12, Math.min(88, Math.round(pct * 10) / 10)));
    };
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); document.body.classList.remove('dragging'); };
    document.body.classList.add('dragging', horizontal ? 'drag-h' : 'drag-v');
    document.body.classList.remove(horizontal ? 'drag-v' : 'drag-h');
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
}

function PanelLayout({ panels, layout, setLayout, hideSub }) {
  const outer = useRef(null);
  const subBox = useRef(null);
  const [dragOver, setDragOver] = useState(null);
  const lr = layout.mode === 'lr';
  const minimized = new Set(layout.min.filter((k) => panels[k]));
  const visible = (k) => !minimized.has(k) && !(hideSub && k !== 'slide');
  const [mainKey, subA, subB] = layout.slots;
  const subKeys = [subA, subB].filter(visible);
  const showMain = visible(mainKey);
  const minimize = (k) => setLayout((l) => ({ ...l, min: [...new Set([...l.min, k])] }));
  const restore = (k) => setLayout((l) => ({ ...l, min: l.min.filter((x) => x !== k) }));
  const swap = (a, b) => {
    if (!a || !b || a === b) return;
    setLayout((l) => { const slots = [...l.slots]; const i = slots.indexOf(a), j = slots.indexOf(b); [slots[i], slots[j]] = [slots[j], slots[i]]; return { ...l, slots }; });
  };
  const onMain = useSplitter(() => outer.current, lr, (v) => setLayout((l) => ({ ...l, main: v })));
  const onSub = useSplitter(() => subBox.current, !lr, (v) => setLayout((l) => ({ ...l, sub: v })));

  const panel = (k, style) => {
    const p = panels[k];
    return (
      <div key={k} className={`vpanel vp-${k} ${dragOver === k ? 'drop' : ''}`} style={style}
        onDragOver={(e) => { if (e.dataTransfer.types.includes('text/ppta-panel')) { e.preventDefault(); setDragOver(k); } }}
        onDragLeave={() => setDragOver((d) => (d === k ? null : d))}
        onDrop={(e) => { e.preventDefault(); setDragOver(null); swap(e.dataTransfer.getData('text/ppta-panel'), k); }}>
        <div className="vpanel-head" draggable onDragStart={(e) => { e.dataTransfer.setData('text/ppta-panel', k); e.dataTransfer.effectAllowed = 'move'; }} title="拖动标题栏到其他模块上可交换位置">
          <span className="grip">⠿</span><span className="vph-title">{p.title}</span>
          <div className="spacer" />{p.extra}
          <button className="icon-btn tiny" title="最小化到底部" onClick={() => minimize(k)}>▁</button>
        </div>
        <div className="vpanel-body">{p.body}</div>
      </div>
    );
  };
  const subArea = subKeys.length ? (
    <div ref={subBox} className="vsub" style={{ flexDirection: lr ? 'column' : 'row', flex: showMain ? `0 0 ${100 - layout.main}%` : '1 1 auto' }}>
      {subKeys.length === 2 ? (
        <>
          {panel(subKeys[0], { flex: `0 0 calc(${layout.sub}% - 3px)` })}
          <div className={`vsplit ${lr ? 'h' : 'v'}`} onMouseDown={onSub} title="拖动调整大小" />
          {panel(subKeys[1], { flex: '1 1 0' })}
        </>
      ) : panel(subKeys[0], { flex: '1 1 0' })}
    </div>
  ) : null;
  const dock = [...minimized].concat(hideSub ? layout.slots.filter((k) => k !== 'slide' && !minimized.has(k)) : []);
  return (
    <div className="vlayout-wrap">
      <div ref={outer} className={`vlayout ${lr ? 'lr' : 'tb'}`}>
        {showMain && panel(mainKey, { flex: subArea ? `0 0 calc(${layout.main}% - 3px)` : '1 1 auto' })}
        {showMain && subArea && <div className={`vsplit ${lr ? 'v' : 'h'}`} onMouseDown={onMain} title="拖动调整大小" />}
        {subArea}
        {!showMain && !subArea && <div className="empty-tip">所有模块都已最小化，点击底部按钮恢复</div>}
      </div>
      {dock.length > 0 && (
        <div className="vdock">
          <span className="muted small">已最小化：</span>
          {[...new Set(dock)].map((k) => <button key={k} className="btn small" onClick={() => (minimized.has(k) ? restore(k) : null)} disabled={!minimized.has(k)}>{panels[k].title} ▴</button>)}
        </div>
      )}
    </div>
  );
}
