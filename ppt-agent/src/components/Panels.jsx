import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useApp } from '../ctx';
import { renderMarkdown, highlight } from '../md';

const esc = (t) => String(t || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ================= 三模块布局：主区 1 个 + 副区 2 个 =================
export const DEFAULT_LAYOUT = { mode: 'tb', slots: ['slide', 'notes', 'md'], main: 64, sub: 50, min: [] };
function loadLayout(key = 'ppta.viewerLayout', def = DEFAULT_LAYOUT) {
  try {
    const l = { ...def, ...JSON.parse(localStorage.getItem(key) || '{}') };
    if (!Array.isArray(l.slots) || l.slots.slice().sort().join() !== 'md,notes,slide') l.slots = def.slots;
    if (!Array.isArray(l.min)) l.min = [];
    return l;
  } catch { return def; }
}
function saveLayout(l, key = 'ppta.viewerLayout') { try { localStorage.setItem(key, JSON.stringify(l)); } catch { /* ignore */ } }

/** 带持久化的布局状态（不同视图用不同 key，下次打开时恢复） */
export function useStoredLayout(key, def = DEFAULT_LAYOUT) {
  const [layout, setState] = useState(() => loadLayout(key, def));
  const setLayout = useCallback((upd) => setState((cur) => { const n = typeof upd === 'function' ? upd(cur) : upd; saveLayout(n, key); return n; }), [key]);
  return [layout, setLayout, def];
}

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

export function PanelLayout({ panels, layout, setLayout, hideSub }) {
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

// ================= 可编辑的讲解词 / Markdown 模块 =================
const slideListeners = new Set();
export function onSlideUpdated(fn) { slideListeners.add(fn); return () => slideListeners.delete(fn); }
function emitSlide(s) { for (const fn of slideListeners) fn(s); }

/** 讲解词模块：页签「原讲解词」「Agent 生成」，均可编辑 */
export function NotesBody({ slide, terms = [], unit = '页', tab, setTab }) {
  const app = useApp();
  const [edit, setEdit] = useState(false);
  const [val, setVal] = useState('');
  useEffect(() => { setEdit(false); }, [slide.id]);
  const isAi = tab === 'ai';
  const text = isAi ? slide.notes_ai || '' : slide.notes || '';
  const save = async () => {
    try {
      const s = isAi ? await api.updateSlideText(slide.id, { notes: val }) : await api.updateSlideText(slide.id, { notes: val });
      emitSlide(s); setEdit(false); if (isAi) setTab('orig');
      app.toast(isAi ? '已采用 Agent 讲解词并保存为本页讲解词' : '讲解词已保存');
    } catch (e) { app.toast('保存失败：' + e.message, 'error'); }
  };
  return (
    <div className="edit-pane">
      <div className="pane-tabs">
        <button className={!isAi ? 'on' : ''} onClick={() => { setTab('orig'); setEdit(false); }}>{unit === '节' ? '批注' : '原讲解词'}{slide.edited && slide.notes !== slide.notes_orig ? ' ✎' : ''}</button>
        <button className={isAi ? 'on' : ''} onClick={() => { setTab('ai'); setEdit(false); }}>🤖 Agent 生成{slide.notes_ai ? '' : '（空）'}</button>
        <div className="spacer" />
        {!edit && <button className="btn tiny" onClick={() => { setVal(text); setEdit(true); }}>✎ 编辑</button>}
        {!edit && isAi && slide.notes_ai && <button className="btn tiny primary" onClick={async () => { const s = await api.updateSlideText(slide.id, { notes: slide.notes_ai }); emitSlide(s); setTab('orig'); app.toast('已采用 Agent 讲解词'); }}>采用为讲解词</button>}
        {!edit && !isAi && slide.notes !== slide.notes_orig && <button className="btn tiny" onClick={async () => { const s = await api.updateSlideText(slide.id, { notes: null }); emitSlide(s); app.toast('已恢复原讲解词'); }}>恢复原文</button>}
        {edit && <><button className="btn tiny primary" onClick={save}>{isAi ? '保存并采用' : '保存'}</button><button className="btn tiny" onClick={() => setEdit(false)}>取消</button></>}
      </div>
      {edit ? <textarea className="pane-edit" value={val} onChange={(e) => setVal(e.target.value)} autoFocus />
        : <div className="pane-body notes" dangerouslySetInnerHTML={{ __html: text ? highlight(esc(text), terms) : `<span class="muted">${isAi ? '尚未生成。点击 Markdown 模块中的“自动调用 Agent 生成讲解词”。' : '（无）'}</span>` }} />}
    </div>
  );
}

/** Markdown 模块：预览 / 源码 / 编辑，附“自动调用 Agent 生成讲解词”按钮 */
export function MdBody({ slide, terms = [], onGenerated }) {
  const app = useApp();
  const [mode, setMode] = useState('render');
  const [val, setVal] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (mode === 'edit') setMode('render'); }, [slide.id]);
  const gen = async () => {
    setBusy(true);
    try {
      const r = await api.generateNotes(slide.id);
      const s = await api.slideDetail(slide.id);
      emitSlide(s);
      if (onGenerated) onGenerated();
      app.toast(`Agent 已生成讲解词（${r.source}）`);
    } catch (e) { app.toast('生成失败：' + e.message, 'error'); } finally { setBusy(false); }
  };
  return (
    <div className="edit-pane">
      <div className="pane-tabs">
        <button className={mode === 'render' ? 'on' : ''} onClick={() => setMode('render')}>预览</button>
        <button className={mode === 'raw' ? 'on' : ''} onClick={() => setMode('raw')}>源码</button>
        <button className={mode === 'edit' ? 'on' : ''} onClick={() => { setVal(slide.md || ''); setMode('edit'); }}>✎ 编辑</button>
        <div className="spacer" />
        {mode === 'edit' ? (
          <>
            <button className="btn tiny primary" onClick={async () => { try { const s = await api.updateSlideText(slide.id, { md: val }); emitSlide(s); setMode('render'); app.toast('Markdown 已保存'); } catch (e) { app.toast(e.message, 'error'); } }}>保存</button>
            <button className="btn tiny" onClick={() => setMode('render')}>取消</button>
          </>
        ) : (
          <>
            {slide.md !== slide.md_orig && <button className="btn tiny" onClick={async () => { const s = await api.updateSlideText(slide.id, { md: null }); emitSlide(s); }}>恢复原文</button>}
            <button className="btn tiny" onClick={() => navigator.clipboard.writeText(slide.md || '')}>复制</button>
            <button className="btn tiny primary" disabled={busy} onClick={gen} title="根据本页内容自动生成讲解词，结果显示在讲解词模块的“Agent 生成”页签">{busy ? '生成中…' : '🤖 自动调用 Agent 生成讲解词'}</button>
          </>
        )}
      </div>
      {mode === 'edit' ? <textarea className="pane-edit mono" value={val} onChange={(e) => setVal(e.target.value)} autoFocus />
        : mode === 'raw' ? <pre className="pane-body md-raw">{slide.md}</pre>
          : <div className="pane-body md" dangerouslySetInnerHTML={{ __html: renderMarkdown(slide.md, terms) }} />}
    </div>
  );
}
