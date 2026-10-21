import React, { useEffect, useState } from 'react';
import { api, THEME_LABEL } from '../api';
import { useApp } from '../ctx';
import SlidePreview from './SlidePreview';

const cache = new Map();
export function clearRelatedCache() { cache.clear(); }
function loadRelated(id) {
  if (!cache.has(id)) cache.set(id, api.related(id).catch(() => null));
  return cache.get(id);
}
const readOpen = () => { try { return localStorage.getItem('ppta.relRail') !== '0'; } catch { return true; } };

/**
 * 相关推荐栏：本页标签 + 相似 PPT 页（+ 同时选择 Word 时的相关 Word 内容 / Word 章节的相关 PPT 页）。
 * 点击推荐项 onPick(item) 由所在视图在当前位置替换显示该页。
 */
export default function RelatedRail({ slide, onPick, open: openProp, setOpen: setOpenProp }) {
  const app = useApp();
  const [openState, setOpenState] = useState(readOpen);
  const open = openProp !== undefined ? openProp : openState;
  const setOpen = (v) => { try { localStorage.setItem('ppta.relRail', v ? '1' : '0'); } catch { /* ignore */ } (setOpenProp || setOpenState)(v); };
  const [data, setData] = useState(null);
  useEffect(() => {
    let off = false;
    setData(null);
    if (slide) loadRelated(slide.id).then((d) => { if (!off) setData(d); });
    return () => { off = true; };
  }, [slide && slide.id, app.taskTick]);

  const isWord = data ? data.kind === 'word' : false;
  const total = data ? data.ppt.length + data.word.length : 0;
  if (!open) {
    return <div className="rel-rail collapsed" onClick={() => setOpen(true)} title="展开相关推荐"><span>🔗 相关推荐{data ? `（${total}）` : ''}</span></div>;
  }
  const compare = (it) => app.openCompare([slide.file_id, it.file_id], { [slide.file_id]: slide.id, [it.file_id]: it.id });
  const card = (it) => {
    const inBasket = app.basket.items.includes(it.id);
    return (
      <div key={it.id} className={`rel-card ${it.kind === 'word' ? 'word' : ''}`} data-rel={it.id} onClick={() => onPick(it)} title={`${it.filePath}\n点击在当前位置查看该${it.kind === 'word' ? '节' : '页'}`}>
        <div className="rc-thumb"><SlidePreview slide={it} file={{ kind: it.kind }} /></div>
        <div className="rc-info">
          <div className="rc-title ellipsis">{it.title || `第 ${it.idx} ${it.kind === 'word' ? '节' : '页'}`}</div>
          <div className="muted small ellipsis">{it.fileName} · 第 {it.idx} {it.kind === 'word' ? '节' : '页'}</div>
          <div className="rc-meta">
            <span className={`tag ${it.score >= 0.75 ? 'ok' : it.score >= 0.5 ? 'accent' : ''}`}>相似 {Math.round(it.score * 100)}%</span>
            {it.kind !== 'word' && <span className={`tag theme-${it.theme}`}>{THEME_LABEL[it.theme]}</span>}
            {it.reasons.slice(0, 3).map((r) => <span key={r} className="tag rc-reason">{r}</span>)}
          </div>
          <div className="rc-ops" onClick={(e) => e.stopPropagation()}>
            <button className="btn tiny" title="与当前页所在文档并排对比" onClick={() => compare(it)}>⧉ 对比</button>
            {it.kind !== 'word' && <button className={`btn tiny ${inBasket ? 'primary' : ''}`} onClick={() => (inBasket ? app.basket.remove(it.id) : app.basket.add([it.id]))}>{inBasket ? '✓ 导出篮' : '＋ 导出篮'}</button>}
          </div>
        </div>
      </div>
    );
  };
  return (
    <div className="rel-rail">
      <div className="rr-head"><b>🔗 相关推荐</b><span className="muted small">{data ? `${total} 条` : ''}</span><div className="spacer" /><button className="icon-btn tiny" title="收起推荐栏" onClick={() => setOpen(false)}>»</button></div>
      <div className="rr-body">
        {!data && <div className="muted small pad">加载中…</div>}
        {data && (
          <>
            <div className="rr-sec">
              <div className="rr-title">本{isWord ? '节' : '页'}标签</div>
              <div className="rr-tags">{data.tags.length ? data.tags.map((t) => <span key={t} className="tag">{t}</span>) : <span className="muted small">（内容较少，没有提取到标签）</span>}</div>
            </div>
            <div className="rr-sec">
              <div className="rr-title">{isWord ? '相关 PPT 页面' : '相似 PPT 页面'}（{data.ppt.length}）</div>
              {data.ppt.map(card)}
              {!data.ppt.length && <div className="muted small">没有找到内容相近的 PPT 页面</div>}
            </div>
            {!isWord && data.withWord && (
              <div className="rr-sec">
                <div className="rr-title">相关 Word 内容（{data.word.length}）</div>
                {data.word.map(card)}
                {!data.word.length && <div className="muted small">没有找到相关的 Word 章节</div>}
              </div>
            )}
            {!isWord && !data.withWord && <div className="muted small rr-tip">在“设置 → 解析文档类型”中同时选择 Word 后，会把 Word 文档内容与 PPT 页面相互关联并在这里推荐。</div>}
          </>
        )}
      </div>
    </div>
  );
}
