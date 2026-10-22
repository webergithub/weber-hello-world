import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, THEME_LABEL, unitOf, slideRatio } from '../api';
import { useApp } from '../ctx';
import SlidePreview from './SlidePreview';
import { loadFile } from './SlideViewer';
import { loadSlide } from './SlideWorkspace';
import { useKeymap, comboOf, isTyping, keysLabel } from '../keymap';
import PageHelp from './PageHelp';

export const COMPARE_MAX = 4;
const NUM = ['①', '②', '③', '④'];
const readLS = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : v === '1'; } catch { return d; } };
const writeLS = (k, v) => { try { localStorage.setItem(k, v ? '1' : '0'); } catch { /* ignore */ } };

// 文字相似度：去空白标点后的字二元组 Jaccard（只用于提示两页内容是否接近）
const norm = (t) => String(t || '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
function bigrams(t) {
  const s = norm(t);
  const out = new Set();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  if (s.length === 1) out.add(s);
  return out;
}
export function textSim(a, b) {
  const x = bigrams(a), y = bigrams(b);
  if (!x.size || !y.size) return x.size === y.size ? 1 : 0;
  let n = 0;
  for (const g of x) if (y.has(g)) n++;
  return n / (x.size + y.size - n);
}
const slideText = (s) => (s ? `${s.title || ''}\n${s.text || ''}` : '');

/** 列表中的“对比查看”按钮：选中 2–4 个文档后可用 */
export function CompareButton({ ids, label = '⧉ 对比查看' }) {
  const app = useApp();
  if (!ids.length) return null;
  const ok = ids.length >= 2 && ids.length <= COMPARE_MAX;
  return (
    <button className="btn small" disabled={!ok} title={ok ? '在对比窗口中并排打开，可一起翻页对比' : `请选择 2–${COMPARE_MAX} 个文档进行对比（当前 ${ids.length} 个）`}
      onClick={() => app.openCompare(ids)}>{label}（{ids.length}）</button>
  );
}

/**
 * 对比窗口：2–4 个文档并排展示，每个窗格有独立的翻页按钮；
 * “一起翻页”打开时，键盘与顶部按钮同时翻动所有窗格（各自保持当前页的偏移），
 * 某个窗格单独翻页（窗格按钮或 Alt+← →）即可跳过一页，之后继续一起翻页。
 * starts：可选，每个文件的起始页 id
 */
export default function CompareView({ fileIds, starts = {}, onClose }) {
  const app = useApp();
  const keys = useKeymap();
  const ids = useMemo(() => fileIds.slice(0, COMPARE_MAX), [fileIds]);
  const n = ids.length;
  const [details, setDetails] = useState(() => ids.map(() => null));
  const [pos, setPos] = useState(() => ids.map(() => 0));
  const [focus, setFocus] = useState(0);
  const [linked, setLinked] = useState(() => readLS('ppta.cmpLinked', true));
  // 同步翻页的窗格：每个窗格可勾选是否参与“一起翻页”（默认全部勾选）；未勾选任何窗格时只翻选中的窗格
  const [sync, setSync] = useState(() => ids.map(() => true));
  const toggleSync = (i) => setSync((v) => v.map((x, k) => (k === i ? !x : x)));
  const moves = (i) => (linked && sync.some(Boolean) ? !!sync[i] : i === focus);
  const [notes, setNotes] = useState(() => readLS('ppta.cmpNotes', false));
  const [strip, setStrip] = useState(() => readLS('ppta.cmpStrip', true));
  const [maxed, setMaxed] = useState(() => readLS('ppta.cmpMax', false));
  const [grid, setGrid] = useState(n >= 4);
  const [osd, setOsd] = useState(null);
  const osdTimer = useRef(null);
  const root = useRef(null);

  useEffect(() => {
    let off = false;
    Promise.all(ids.map((id) => loadFile(id))).then((ds) => {
      if (off) return;
      setDetails(ds);
      setPos(ds.map((d) => {
        const sid = d && starts[d.file.id];
        const i = d && sid ? d.slides.findIndex((s) => s.id === sid) : -1;
        return Math.max(0, i);
      }));
    });
    return () => { off = true; };
  }, [ids]);

  const lens = details.map((d) => (d ? d.slides.length : 0));
  const clamp = (i, p) => Math.max(0, Math.min(Math.max(0, lens[i] - 1), p));
  const flash = (next) => {
    setOsd(next.map((p, i) => `${NUM[i]} ${lens[i] ? p + 1 : 0}/${lens[i]}`).join('　'));
    clearTimeout(osdTimer.current);
    osdTimer.current = setTimeout(() => setOsd(null), 1100);
  };
  const update = useCallback((fn) => setPos((cur) => { const next = cur.map((p, i) => clamp(i, fn(p, i))); flash(next); return next; }), [lens.join(',')]);
  // 翻动：linked 时所有窗格一起，否则只动当前窗格；only 指定只动某一个窗格
  const step = useCallback((d, only = null) => update((p, i) => ((only === null ? moves(i) : i === only) ? p + d : p)), [update, linked, focus, sync.join(',')]);
  const jump = useCallback((where, only = null) => update((p, i) => ((only === null ? moves(i) : i === only) ? (where === 'first' ? 0 : lens[i] - 1) : p)), [update, linked, focus, sync.join(','), lens.join(',')]);
  const setOne = (i, p) => update((q, k) => (k === i ? p : q));
  const alignByIndex = () => update(() => pos[focus]);
  // 按标题（及正文）对齐：其他窗格跳到与当前窗格这一页最相近的页面
  const alignByTitle = useCallback(() => {
    const ref = details[focus] && details[focus].slides[pos[focus]];
    if (!ref) return;
    update((p, i) => {
      if (i === focus || !details[i]) return p;
      let best = p, bs = -1;
      details[i].slides.forEach((s, k) => {
        const sc = textSim(ref.title, s.title) * 0.6 + textSim(slideText(ref), slideText(s)) * 0.4;
        if (sc > bs + 1e-9) { bs = sc; best = k; }
      });
      return best;
    });
    app.toast('已按标题 / 内容把其他窗格对齐到最相近的页面');
  }, [details, focus, pos, update]);

  const toggle = (setter, key) => setter((v) => { writeLS(key, !v); return !v; });
  const toggleFull = useCallback(() => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else if (root.current && root.current.requestFullscreen) root.current.requestFullscreen().catch(() => {});
  }, []);
  const brief = details.map((d, i) => (d ? d.slides[pos[i]] : null));
  // 当前页加载完整数据（版式、讲解词编辑结果），缩略条用列表数据
  const [full, setFull] = useState({});
  const curKey = brief.map((s) => (s ? s.id : 0)).join(',');
  useEffect(() => {
    let off = false;
    for (const s of brief) if (s && !full[s.id]) loadSlide(s.id).then((x) => { if (!off && x) setFull((m) => ({ ...m, [x.id]: x })); });
    return () => { off = true; };
  }, [curKey]);
  const cur = brief.map((s) => (s ? { ...s, ...(full[s.id] || {}) } : null));
  const toggleBasket = useCallback((i = focus) => {
    const s = cur[i];
    if (!s) return;
    if (app.basket.items.includes(s.id)) app.basket.remove(s.id); else app.basket.add([s.id]);
  }, [cur, focus, app.basket]);

  useEffect(() => {
    const k = (e) => {
      if (isTyping(e.target)) return;
      const c = comboOf(e);
      const action = c && keys.lut.get(c);
      if (!action) return;
      let handled = true;
      switch (action) {
        case 'next': step(1); break;
        case 'prev': step(-1); break;
        case 'next5': step(5); break;
        case 'prev5': step(-5); break;
        case 'first': jump('first'); break;
        case 'last': jump('last'); break;
        case 'paneNext': step(1, focus); break;
        case 'panePrev': step(-1, focus); break;
        case 'nextFile': setFocus((f) => (f + 1) % n); break;
        case 'prevFile': setFocus((f) => (f - 1 + n) % n); break;
        case 'firstFile': setFocus(0); break;
        case 'lastFile': setFocus(n - 1); break;
        case 'pane1': case 'pane2': case 'pane3': case 'pane4': { const i = Number(action.slice(4)) - 1; if (i < n) setFocus(i); break; }
        case 'link': toggle(setLinked, 'ppta.cmpLinked'); break;
        case 'align': alignByTitle(); break;
        case 'panes': toggle(setNotes, 'ppta.cmpNotes'); break;
        case 'layout': setGrid((g) => !g); break;
        case 'max': toggle(setMaxed, 'ppta.cmpMax'); break;
        case 'full': toggleFull(); break;
        case 'basket': toggleBasket(); break;
        case 'close':
          if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
          else onClose();
          break;
        default: handled = false;
      }
      if (handled) { e.preventDefault(); e.stopPropagation(); }
    };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, [keys, step, jump, focus, n, alignByTitle, toggleFull, toggleBasket, onClose]);

  const ref = cur[0];
  const allEnd = pos.every((p, i) => p >= lens[i] - 1);
  const allStart = pos.every((p) => p <= 0);
  return (
    <div ref={root} className={`compare ${maxed ? 'maxed' : ''}`}>
      {osd && <div className="viewer-osd cmp-osd">{osd}</div>}
      <div className="corner-help"><PageHelp page="compare" onBeforeNav={onClose} /></div>
      <div className="viewer-bar">
        <b>⧉ 对比窗口</b><span className="muted small">{n} 个文档</span>
        <div className="spacer" />
        <span className="muted small">{linked && sync.some(Boolean) ? `一起翻页：${sync.map((x, i) => (x ? NUM[i] : '')).join('')}` : `只翻 ${NUM[focus]}`}</span>
        <button className="btn small" disabled={allStart} onClick={() => jump('first')} title={`首页（${keysLabel(keys.map, 'first')}）`}>⏮</button>
        <button className="btn small" disabled={allStart} onClick={() => step(-1)} title={`上一页（${keysLabel(keys.map, 'prev')}）`}>◀ 上一页</button>
        <button className="btn small primary" disabled={allEnd} onClick={() => step(1)} title={`下一页（${keysLabel(keys.map, 'next')}）`}>下一页 ▶</button>
        <button className="btn small" disabled={allEnd} onClick={() => jump('last')} title={`末页（${keysLabel(keys.map, 'last')}）`}>⏭</button>
        <label className="chk" title={`一起翻页（${keysLabel(keys.map, 'link')}）：打开时翻页同时作用于所有窗格；关闭时只翻选中的窗格`}>
          <input type="checkbox" checked={linked} onChange={() => toggle(setLinked, 'ppta.cmpLinked')} /> 一起翻页
        </label>
        <button className="btn small" onClick={alignByIndex} title="其他窗格跳到与选中窗格相同的页码">⇉ 对齐页码</button>
        <button className="btn small" onClick={alignByTitle} title={`其他窗格跳到与选中窗格当前页标题 / 内容最相近的页面（${keysLabel(keys.map, 'align')}）`}>≈ 按标题对齐</button>
        <div className="seg small" title={keysLabel(keys.map, 'layout')}>
          <button className={!grid ? 'on' : ''} onClick={() => setGrid(false)}>并排</button>
          <button className={grid ? 'on' : ''} onClick={() => setGrid(true)}>田字格</button>
        </div>
        <button className={`btn small ${notes ? 'primary' : ''}`} onClick={() => toggle(setNotes, 'ppta.cmpNotes')} title={keysLabel(keys.map, 'panes')}>讲解词</button>
        <button className={`btn small ${strip ? 'primary' : ''}`} onClick={() => toggle(setStrip, 'ppta.cmpStrip')}>缩略条</button>
        <button className="btn small" onClick={() => toggle(setMaxed, 'ppta.cmpMax')} title={keysLabel(keys.map, 'max')}>{maxed ? '🗗 还原' : '⛶ 最大化'}</button>
        <button className="btn small" onClick={toggleFull} title={keysLabel(keys.map, 'full')}>🖵 全屏</button>
        <button className="icon-btn" onClick={onClose} title={keysLabel(keys.map, 'close')}>✕</button>
      </div>
      <div className={`cmp-panes n${n} ${grid ? 'grid' : 'cols'}`}>
        {ids.map((id, i) => {
          const d = details[i];
          const s = cur[i];
          const unit = unitOf(d && d.source);
          const sim = i > 0 && ref && s ? textSim(slideText(ref), slideText(s)) : null;
          const inBasket = s && app.basket.items.includes(s.id);
          return (
            <div key={id} className={`cmp-pane ${focus === i ? 'focus' : ''}`} onMouseDown={() => setFocus(i)}>
              <div className="cmp-head">
                <span className="cmp-num">{NUM[i]}</span>
                <label className={`chk cmp-sync ${linked ? '' : 'off'}`} title="勾选的窗格在“一起翻页”时同时翻动" onMouseDown={(e) => e.stopPropagation()}><input type="checkbox" checked={!!sync[i]} onChange={() => toggleSync(i)} /> 同步翻页</label>
                <b className="ellipsis" title={d ? d.file.path : ''}>{d ? d.file.name : '加载中…'}</b>
                <div className="spacer" />
                {sim !== null && <span className={`tag ${sim >= 0.8 ? 'ok' : sim >= 0.4 ? 'accent' : ''}`} title="与 ① 当前页的文字相似度">与①相似 {Math.round(sim * 100)}%</span>}
              </div>
              <div className="cmp-ctl">
                <button className="btn tiny" disabled={!s || pos[i] <= 0} onClick={() => setOne(i, 0)} title="本窗格首页">⏮</button>
                <button className="btn tiny" disabled={!s || pos[i] <= 0} onClick={() => step(-1, i)} title={`只让本窗格上一页（${keysLabel(keys.map, 'panePrev')}）`}>◀</button>
                <span className="cmp-page">第 <input className="input tiny-num" type="number" min={1} max={lens[i] || 1} value={lens[i] ? pos[i] + 1 : 0}
                  onChange={(e) => setOne(i, Number(e.target.value) - 1)} /> / {lens[i]} {unit}</span>
                <button className="btn tiny" disabled={!s || pos[i] >= lens[i] - 1} onClick={() => step(1, i)} title={`只让本窗格下一页，跳过一页（${keysLabel(keys.map, 'paneNext')}）`}>▶</button>
                <button className="btn tiny" disabled={!s || pos[i] >= lens[i] - 1} onClick={() => setOne(i, lens[i] - 1)} title="本窗格末页">⏭</button>
                {s && pos[i] >= lens[i] - 1 && lens[i] > 1 && <span className="tag warn">已到末页</span>}
                <div className="spacer" />
                {s && unit === '页' && <span className={`tag theme-${s.theme}`}>{THEME_LABEL[s.theme]}</span>}
                <button className={`btn tiny ${inBasket ? 'primary' : ''}`} disabled={!s} onClick={() => toggleBasket(i)}>{inBasket ? '✓ 导出篮' : '＋ 导出篮'}</button>
                {d && <button className="btn tiny ghost" onClick={() => api.openPath(d.file.path)}>打开</button>}
              </div>
              <div className="cmp-title ellipsis" title={s ? s.title : ''}>{s ? s.title || `第 ${s.idx} ${unit}` : ''}</div>
              <div className="cmp-stage" style={{ '--ratio': slideRatio(s, d && d.source) }}>
                {s ? <SlidePreview slide={s} file={d.source} full /> : <div className="empty-tip">{d ? '没有可浏览的页面' : '加载中…'}</div>}
              </div>
              {notes && s && (
                <div className="cmp-notes">
                  {s.notes ? <div className="pre">{s.notes}</div> : <span className="muted small">（本{unit}没有{unit === '节' ? '批注' : '讲解词'}）</span>}
                </div>
              )}
              {strip && d && (
                <div className="viewer-strip cmp-strip">
                  {d.slides.map((s2, k) => (
                    <div key={s2.id} className={`strip-item ${k === pos[i] ? 'active' : ''}`} onClick={() => setOne(i, k)} title={s2.title}
                      ref={k === pos[i] ? (el) => el && el.scrollIntoView({ block: 'nearest', inline: 'center' }) : undefined}>
                      <SlidePreview slide={s2} file={d.source} />
                      <span>{s2.idx}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
