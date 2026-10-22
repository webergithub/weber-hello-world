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

export const LANG_NAMES = { zh: '中文', en: 'English', ja: '日本語', ko: '한국어', fr: 'Français', de: 'Deutsch', es: 'Español', ru: 'Русский', pt: 'Português', it: 'Italiano', ar: 'العربية', th: 'ไทย', vi: 'Tiếng Việt', id: 'Bahasa Indonesia', ms: 'Bahasa Melayu', tr: 'Türkçe', nl: 'Nederlands', pl: 'Polski', hi: 'हिन्दी' };
const MINOR_DEFAULT = ['ja', 'ko', 'fr', 'de', 'es', 'ru'];

/**
 * 讲解词模块：页签「原讲解词」「生成讲解词」「修正讲解词」（当前采用的版本，可编辑），
 * 每个页签可切换 原文 / 中文 / English / 小语种：缺少的语言自动调用设置中的 Agent 接口翻译，
 * 译文只保存在应用知识库；用户手动点击“写入 PPT 备注”（二次确认、先备份）时才写回原 PPT。
 */
export function NotesBody({ slide, terms = [], unit = '页', tab, setTab }) {
  const app = useApp();
  const word = unit === '节';
  const tabKey = tab === 'ai' || tab === 'final' ? tab : 'orig';
  const [edit, setEdit] = useState(false);
  const [val, setVal] = useState('');
  const [lang, setLang] = useState('src');
  const minor = (app.config && app.config.minorLangs && app.config.minorLangs.length ? app.config.minorLangs : MINOR_DEFAULT);
  const [minorLang, setMinorLang] = useState(minor[0]);
  const [tr, setTr] = useState(null);
  const [tick, setTick] = useState(0);
  useEffect(() => { setEdit(false); }, [slide.id]);
  const base = tabKey === 'orig' ? slide.notes_orig || '' : tabKey === 'ai' ? slide.notes_ai || '' : slide.notes || '';
  const final = slide.notes || '';
  useEffect(() => {
    let off = false;
    if (lang === 'src') { setTr(null); return undefined; }
    if (!base.trim()) { setTr({ error: '该版本的讲解词为空' }); return undefined; }
    setTr({ loading: true });
    api.translateNotes(slide.id, { variant: tabKey, lang, force: tick > 0 && tr && tr.force })
      .then((r) => { if (!off) setTr(r); if (!off && r.error) app.toast(r.error, 'error'); })
      .catch((e) => { if (!off) setTr({ error: e.message }); });
    return () => { off = true; };
  }, [slide.id, tabKey, lang, base, tick]);
  const retranslate = () => { setTr({ loading: true, force: true }); setTick((x) => x + 1); };
  const writeBack = async () => {
    const fileName = slide.file ? slide.file.name : '原 PPT';
    if (!confirm(`把 ${LANG_NAMES[lang]} 译文写入「${fileName}」第 ${slide.idx} 页的备注？\n\n这会修改原 PPT 文件（写入前自动备份到数据目录 backup），备注末尾追加“【${LANG_NAMES[lang]}】”段落。`)) return;
    const r = await api.writeBackNotes(slide.id, { variant: tabKey, lang }).catch((e) => ({ error: e.message }));
    if (r.writtenBack) { setTr((t) => ({ ...t, writtenBack: true })); app.toast(`已写入 PPT 备注（原文件已备份）`); } else app.toast(r.error || '写入失败', 'error');
  };
  const saveFinal = async (text, msg) => {
    try { const s = await api.updateSlideText(slide.id, { notes: text }); emitSlide(s); setEdit(false); setTab('final'); app.toast(msg); } catch (e) { app.toast('保存失败：' + e.message, 'error'); }
  };
  const showing = lang === 'src' ? base : tr && tr.text ? tr.text : '';
  const empty = { orig: word ? '（原文档没有批注）' : '（原 PPT 没有讲解词）', ai: '尚未生成。点击 Markdown 模块中的“🤖 自动调用 Agent 生成讲解词”。', final: '（无）' }[tabKey];
  const tabs = [['orig', word ? '原批注' : '原讲解词'], ['ai', `生成讲解词${slide.notes_ai ? '' : '（空）'}`], ['final', `修正讲解词${slide.edited && final !== slide.notes_orig ? ' ✎' : ''}`]];
  return (
    <div className="edit-pane">
      <div className="pane-tabs">
        {tabs.map(([k, v]) => <button key={k} className={tabKey === k ? 'on' : ''} title={k === 'final' ? '当前采用的版本（编辑后保存的内容，不区分来自原讲解词还是生成讲解词）' : ''} onClick={() => { setTab(k); setEdit(false); }}>{v}</button>)}
        <div className="spacer" />
        {!edit && tabKey === 'ai' && slide.notes_ai && lang === 'src' && <button className="btn tiny primary" onClick={() => saveFinal(slide.notes_ai, '已采用生成讲解词为修正讲解词')}>采用为修正讲解词</button>}
        {!edit && tabKey === 'orig' && slide.notes_orig && final !== slide.notes_orig && <button className="btn tiny" onClick={() => saveFinal(null, '已恢复为原讲解词')}>采用原讲解词</button>}
        {!edit && tabKey === 'final' && lang === 'src' && <button className="btn tiny" onClick={() => { setVal(final); setEdit(true); }}>✎ 编辑</button>}
        {!edit && tabKey === 'final' && final !== slide.notes_orig && lang === 'src' && <button className="btn tiny" onClick={() => saveFinal(null, '已恢复原讲解词')}>恢复原文</button>}
        {!edit && lang !== 'src' && tr && tr.text && !tr.same && <button className="btn tiny" onClick={() => saveFinal(tr.text, `已把${LANG_NAMES[lang]}译文采用为修正讲解词`)} title="把译文作为修正讲解词（当前采用的版本）">采用译文</button>}
        {edit && <><button className="btn tiny primary" onClick={() => saveFinal(val, '修正讲解词已保存')}>保存</button><button className="btn tiny" onClick={() => setEdit(false)}>取消</button></>}
      </div>
      <div className="lang-bar">
        <span className="muted small">语言</span>
        <div className="seg small">
          {[['src', '原文'], ['zh', '中文'], ['en', 'English']].map(([k, v]) => <button key={k} className={lang === k ? 'on' : ''} onClick={() => setLang(k)}>{v}</button>)}
          <button className={!['src', 'zh', 'en'].includes(lang) ? 'on' : ''} onClick={() => setLang(minorLang)} title="小语种（可在右侧选择）">小语种</button>
        </div>
        <select className="input tiny" value={minorLang} title="选择小语种" onChange={(e) => { setMinorLang(e.target.value); setLang(e.target.value); }}>
          {Object.entries(LANG_NAMES).filter(([k]) => k !== 'zh' && k !== 'en').sort((a, b) => (minor.includes(b[0]) - minor.includes(a[0]))).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        {lang !== 'src' && tr && tr.text && !tr.same && (
          <span className="tr-meta small">
            🌐 {LANG_NAMES[lang]} 译文{tr.source ? ` · ${tr.source}` : ''} · {tr.writtenBack ? <span className="ok-fg">已写入 PPT 备注</span> : <span className="muted">保存在应用知识库</span>}
            {!tr.writtenBack && !word && <button className="btn tiny" onClick={writeBack} title="把译文写入原 PPT 该页的备注（写入前自动备份原文件）">写入 PPT 备注</button>}
            <button className="btn tiny ghost" onClick={retranslate}>重新翻译</button>
          </span>
        )}
        {lang !== 'src' && tr && tr.same && <span className="muted small">原文即为{LANG_NAMES[lang]}</span>}
      </div>
      {edit ? <textarea className="pane-edit" value={val} onChange={(e) => setVal(e.target.value)} autoFocus />
        : lang !== 'src' && tr && tr.loading ? <div className="pane-body notes muted">正在调用 Agent 接口翻译为 {LANG_NAMES[lang]}…</div>
          : lang !== 'src' && tr && tr.error ? <div className="pane-body notes"><div className="notice danger" style={{ margin: 0 }}>{tr.error}{/Agent 接口/.test(tr.error) && <> <span className="link" onClick={() => app.go({ type: 'settings', focus: 'agent' })}>去设置</span></>}</div></div>
            : <div className="pane-body notes" dangerouslySetInnerHTML={{ __html: showing ? highlight(esc(showing), terms) : `<span class="muted">${empty}</span>` }} />}
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
            <button className="btn tiny primary" disabled={busy} onClick={gen} title="调用设置中的 Agent 接口（未配置时用内置模板）根据本页内容生成讲解词，结果显示在讲解词模块的“生成讲解词”页签">{busy ? '生成中…' : <>🤖 自动调用 Agent 生成讲解词 <span className="wip">建设中</span></>}</button>
          </>
        )}
      </div>
      {mode === 'edit' ? <textarea className="pane-edit mono" value={val} onChange={(e) => setVal(e.target.value)} autoFocus />
        : mode === 'raw' ? <pre className="pane-body md-raw">{slide.md}</pre>
          : <div className="pane-body md" dangerouslySetInnerHTML={{ __html: renderMarkdown(slide.md, terms) }} />}
    </div>
  );
}
