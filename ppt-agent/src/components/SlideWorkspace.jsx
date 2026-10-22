import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api, fmtSize, THEME_LABEL, unitOf } from '../api';
import { useApp } from '../ctx';
import { renderMarkdown } from '../md';
import SlidePreview from './SlidePreview';
import { PanelLayout, useStoredLayout, NotesBody, MdBody, onSlideUpdated } from './Panels';
import RelatedRail from './RelatedRail';
import ZoomStage, { FIT } from './ZoomStage';

const slideCache = new Map();
export async function loadSlide(id) {
  if (!slideCache.has(id)) slideCache.set(id, api.slideDetail(id));
  return slideCache.get(id);
}
export function clearSlideCache() { slideCache.clear(); }
// 编辑保存后同步更新缓存
onSlideUpdated((s) => slideCache.set(s.id, Promise.resolve(s)));

const WS_LAYOUT = { mode: 'tb', slots: ['slide', 'notes', 'md'], main: 58, sub: 50, min: [] };

// 主视图：左 文件列表 · 中 页面列表（可多选）· 右 PPT 原始页 + 备注讲解词 + 解析 Markdown
export default function SlideWorkspace({ files, initialFileId, initialSlideId, emptyText = '暂无已解析的 PPT', highlight = [] }) {
  const app = useApp();
  const [filter, setFilter] = useState('');
  const [fileId, setFileId] = useState(initialFileId || null);
  const [detail, setDetail] = useState(null);
  const [slideId, setSlideId] = useState(initialSlideId || null);
  const [slide, setSlide] = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const lastClick = useRef(null);
  const listRef = useRef(null);
  const [cols, setCols] = useState(() => { try { return { files: true, slides: true, ...JSON.parse(localStorage.getItem('ppta.cols') || '{}') }; } catch { return { files: true, slides: true }; } });
  const setCol = (k, v) => { const n = { ...cols, [k]: v }; setCols(n); try { localStorage.setItem('ppta.cols', JSON.stringify(n)); } catch { /* ignore */ } };
  const maximized = !cols.files && !cols.slides;
  // 资料库详情的三个模块（原始页 / 讲解词 / Markdown）可拖动调整大小、换位，下次打开时恢复
  const [layout, setLayout] = useStoredLayout('ppta.wsLayout', WS_LAYOUT);
  const [notesTab, setNotesTab] = useState('orig');
  const [zoom, setZoom] = useState(FIT);
  useEffect(() => { setZoom((z) => ({ ...z, x: 0, y: 0 })); }, [slideId]);
  useEffect(() => onSlideUpdated((s2) => setSlide((cur) => (cur && cur.id === s2.id ? s2 : cur))), []);

  const visible = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return files.filter((x) => !f || x.name.toLowerCase().includes(f) || (x.dir || '').toLowerCase().includes(f) || (x.tags || []).some((t) => t.toLowerCase().includes(f)));
  }, [files, filter]);

  useEffect(() => { if (initialFileId) setFileId(initialFileId); }, [initialFileId]);
  useEffect(() => { if (initialSlideId) setSlideId(initialSlideId); }, [initialSlideId]);
  useEffect(() => {
    if (!fileId && visible.length) setFileId((visible.find((f) => f.status !== 'failed') || visible[0]).id);
  }, [visible, fileId]);
  // 文件列表换了（如切换到另一个任务）而当前文件不在新列表中：切到新列表的第一个文件，不再显示上一个列表的页面
  const filesKey = files.map((f) => f.id).join(',');
  const prevKey = useRef(filesKey);
  useEffect(() => {
    if (prevKey.current === filesKey) return;
    prevKey.current = filesKey;
    if (fileId && !files.some((f) => f.id === fileId)) {
      const first = files.find((f) => f.status !== 'failed') || files[0];
      setFileId(first ? first.id : null); setSlideId(null); setSelected(new Set()); setBack([]);
    }
  }, [filesKey]);

  useEffect(() => {
    let off = false;
    if (!fileId) { setDetail(null); return; }
    api.fileDetail(fileId).then((d) => {
      if (off) return;
      setDetail(d);
      if (d && d.slides.length) {
        const keep = d.slides.find((s) => s.id === slideId);
        if (!keep) setSlideId(d.slides[0].id);
      } else { setSlideId(null); setSlide(null); }
    });
    return () => { off = true; };
  }, [fileId]);

  useEffect(() => {
    let off = false;
    if (!slideId) { setSlide(null); return; }
    loadSlide(slideId).then((s) => { if (!off) setSlide(s); });
    const el = listRef.current && listRef.current.querySelector(`[data-sid="${slideId}"]`);
    if (el) el.scrollIntoView({ block: 'nearest' });
    return () => { off = true; };
  }, [slideId]);

  const slides = detail ? detail.slides : [];
  const toggle = (s, e) => {
    const next = new Set(selected);
    if (e && e.shiftKey && lastClick.current !== null) {
      const a = slides.findIndex((x) => x.id === lastClick.current), b = slides.findIndex((x) => x.id === s.id);
      const [lo, hi] = a < b ? [a, b] : [b, a];
      for (let i = lo; i <= hi; i++) next.add(slides[i].id);
    } else if (next.has(s.id)) next.delete(s.id); else next.add(s.id);
    lastClick.current = s.id;
    setSelected(next);
  };
  const allInFile = slides.length > 0 && slides.every((s) => selected.has(s.id));
  const selectFile = () => {
    const next = new Set(selected);
    if (allInFile) slides.forEach((s) => next.delete(s.id)); else slides.forEach((s) => next.add(s.id));
    setSelected(next);
  };
  const onKey = (e) => {
    const i = slides.findIndex((s) => s.id === slideId);
    if (e.key === 'ArrowDown' && i < slides.length - 1) { setSlideId(slides[i + 1].id); e.preventDefault(); }
    if (e.key === 'ArrowUp' && i > 0) { setSlideId(slides[i - 1].id); e.preventDefault(); }
    if (e.key === ' ' && slide) { toggle(slide); e.preventDefault(); }
  };
  const goCounterpart = (cp) => { setFileId(cp.fileId); setSlideId(cp.id); };
  // 推荐栏：点击推荐页在当前位置替换查看（可返回）
  const [back, setBack] = useState([]);
  const pickRelated = (it) => {
    setBack((b) => [...b.slice(-29), { fileId, slideId, label: `${detail ? detail.file.name : ''} 第 ${slide ? slide.idx : ''} ${unit}` }]);
    setFileId(it.file_id); setSlideId(it.id);
  };
  const goBack = () => { const last = back[back.length - 1]; if (!last) return; setBack(back.slice(0, -1)); setFileId(last.fileId); setSlideId(last.slideId); };
  // 连续点了多个推荐后，一步回到最初的那一页
  const goOrigin = () => { const first = back[0]; if (!first) return; setBack([]); setFileId(first.fileId); setSlideId(first.slideId); };
  const outside = detail && !files.some((f) => f.id === detail.file.id);
  const selIds = [...selected];
  const unit = unitOf(detail && detail.source);
  const isWord = unit === '节';

  return (
    <div className="workspace" data-open-files={files.map((f) => f.id).join(',')}>
      <div className="ws-toolbar">
        <input className="input" placeholder="筛选文件 / 目录 / 标签" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: 220 }} />
        <span className="muted">共 {visible.length} 个文件</span>
        <div className="spacer" />
        <span className="badge">已选 {selected.size} 页</span>
        <button className="btn" disabled={!selected.size} onClick={() => { app.basket.add(selIds); setSelected(new Set()); }}>＋ 加入导出篮</button>
        <button className="btn primary" disabled={!selected.size} onClick={() => app.exportSlides(selIds, 'pptx')}>⇩ 导出为新 PPT</button>
        <button className="btn" disabled={!selected.size} onClick={() => app.exportSlides(selIds, 'md')}>⇩ 导出 Markdown</button>
        <button className="btn ghost" disabled={!selected.size} onClick={() => setSelected(new Set())}>清空选择</button>
        <button className="btn ghost" title="折叠 / 展开文件列与页面列，最大化显示原始内容" onClick={() => { const v = maximized; setCols({ files: v, slides: v }); try { localStorage.setItem('ppta.cols', JSON.stringify({ files: v, slides: v })); } catch { /* ignore */ } }}>{maximized ? '⇤ 还原列' : '⛶ 最大化内容'}</button>
      </div>
      <div className="ws-body" style={{ gridTemplateColumns: `${cols.files ? 'var(--ws-files, 250px)' : '28px'} ${cols.slides ? 'var(--ws-slides, 290px)' : '28px'} 1fr` }}>
        {!cols.files ? <div className="col-collapsed" onClick={() => setCol('files', true)} title="展开文件列"><span>▸ 文件名（{visible.length}）</span></div> : (
        <div className="ws-files">
          <div className="col-head"><span>文件名</span><button className="icon-btn tiny" title="折叠文件列" onClick={() => setCol('files', false)}>«</button></div>
          {visible.length === 0 && <div className="empty-tip">{emptyText}</div>}
          {visible.map((f) => (
            <div key={f.id} className={`file-item ${f.id === fileId ? 'active' : ''} ${f.status}`} onClick={() => setFileId(f.id)} title={f.path}>
              <div className="fi-name">{f.name}</div>
              <div className="fi-meta">
                {f.status === 'failed' ? <span className="tag danger">失败</span> : null}
                {f.status === 'duplicate' ? <span className="tag warn">重复</span> : null}
                {f.theme ? <span className={`tag theme-${f.theme}`}>{THEME_LABEL[f.theme]}</span> : null}
                {f.kind === 'word' ? <span className="tag word">Word</span> : null}
                <span>{f.slide_count || 0} {unitOf(f)}</span><span>{fmtSize(f.size)}</span>
                {f.video_count ? <span>🎬{f.video_count}</span> : null}
              </div>
            </div>
          ))}
        </div>)}
        {!cols.slides ? <div className="col-collapsed" onClick={() => setCol('slides', true)} title="展开页面列"><span>▸ {isWord ? '章节' : 'PPT 页数'}（{slides.length}）</span></div> : (
        <div className="ws-slides" ref={listRef} tabIndex={0} onKeyDown={onKey}>
          {detail && (
            <div className="ws-slides-head">
              <div className="col-head inline"><label className="chk"><input type="checkbox" checked={allInFile} onChange={selectFile} /> 全选本文件</label><button className="icon-btn tiny" title="折叠页面列" onClick={() => setCol('slides', false)}>«</button></div>
              <span className="muted">{slides.length} {unit} · Shift 连选 · ↑↓ 切换 · 空格选择</span>
            </div>
          )}
          {detail && detail.file.status === 'duplicate' && <div className="notice">该文件与 <b>{detail.source.path}</b> 信息完全一致，未重复解析，显示的是原文件的解析结果。</div>}
          {detail && detail.file.status === 'failed' && <div className="notice danger">解析失败：{detail.file.error}</div>}
          {slides.map((s) => (
            <div key={s.id} data-sid={s.id} className={`slide-item ${s.id === slideId ? 'active' : ''} ${selected.has(s.id) ? 'sel' : ''}`} onClick={() => setSlideId(s.id)}>
              <input type="checkbox" checked={selected.has(s.id)} onClick={(e) => { e.stopPropagation(); toggle(s, e); }} readOnly />
              <SlidePreview slide={s} file={detail.source} className="thumb-sm" />
              <div className="si-info">
                <div className="si-title">{s.idx}. {s.title || '（无标题）'}</div>
                <div className="si-meta">
                  {!isWord && <span className={`tag theme-${s.theme}`}>{THEME_LABEL[s.theme]}</span>}
                  {s.hidden && <span className="tag">隐藏</span>}
                  {s.has_video && <span className="tag">🎬 视频</span>}
                  {s.notes && <span className="tag">{isWord ? '💬 批注' : '🗣 备注'}</span>}
                  {s.counterpart && <span className="tag accent" title="存在内容相近的另一底色版本">⇄ {s.theme === 'dark' ? '白底' : '黑底'}</span>}
                </div>
              </div>
            </div>
          ))}
        </div>)}
        <div className="ws-detail">
          {!slide && <div className="empty-tip">选择左侧的页面查看详情</div>}
          {slide && (
            <>
              <div className="detail-head">
                <div>
                  <div className="dh-title">{slide.title || `第 ${slide.idx} 页`}</div>
                  <div className="muted small">{slide.file && slide.file.path} · 第 {slide.idx} {unit}{slide.section && !isWord ? ` · 分节：${slide.section}` : ''}</div>
                </div>
                {back.length > 0 && <button className="btn small back-origin" title={back[back.length - 1].label} onClick={goBack}>↩ 返回原来的页面</button>}
                <div className="spacer" />
                <label className="chk"><input type="checkbox" checked={selected.has(slide.id)} onChange={() => toggle(slide)} /> 选择此页</label>
                <button className="btn small" onClick={() => app.basket.add([slide.id])}>＋ 加入导出篮</button>
                <button className="btn small" onClick={() => app.openSlide(slide.id, files.map((f) => f.id))}>⛶ 逐页浏览</button>
                {slide.file && <button className="btn small ghost" onClick={() => api.openPath(slide.file.path)}>打开原文件</button>}
              </div>
              {(back.length > 0 || outside) && (
                <div className="hint-bar">🔗 正在查看推荐的页面{outside ? '（该文档不在当前列表中）' : ''}{back.length > 0 && <> · <button className="btn small" onClick={goBack}>↩ 返回 {back[back.length - 1].label}</button></>}{back.length > 1 && <button className="btn small" onClick={goOrigin}>⤒ 回到最初：{back[0].label}</button>}</div>
              )}
              {slide.counterpart && (
                <div className="hint-bar">
                  ⇄ 该页有内容相近的 <b>{THEME_LABEL[slide.counterpart.theme]}</b> 版本：{slide.counterpart.fileName} 第 {slide.counterpart.idx} 页（相似度 {Math.round(slide.counterpart.score * 100)}%）
                  <button className="btn small" onClick={() => goCounterpart(slide.counterpart)}>切换到{THEME_LABEL[slide.counterpart.theme]}查看</button>
                </div>
              )}
              <div className="with-rail"><div className="wr-main"><PanelLayout layout={layout} setLayout={setLayout} panels={{
                slide: {
                  title: isWord ? '📄 文档内容' : '🖼 PPT 原始页',
                  extra: (
                    <div className="seg small" title="三个模块的排列方式">
                      <button className={layout.mode === 'tb' ? 'on' : ''} onClick={() => setLayout((l) => ({ ...l, mode: 'tb' }))}>上1下2</button>
                      <button className={layout.mode === 'lr' ? 'on' : ''} onClick={() => setLayout((l) => ({ ...l, mode: 'lr' }))}>左1右2</button>
                    </div>
                  ),
                  body: (
                    <div className="ws-stage" style={{ '--ratio': slide.layout ? slide.layout.w / slide.layout.h : 16 / 9 }}>
                      {isWord ? <SlidePreview slide={slide} file={detail && detail.source} full highlight={highlight} /> : <ZoomStage view={zoom} setView={setZoom}><SlidePreview slide={slide} file={detail && detail.source} full highlight={highlight} /></ZoomStage>}
                      {slide.media && slide.media.length > 0 && (
                        <div className="media-list">
                          {slide.media.map((m, i) => (
                            <div key={i} className="media-item">
                              <div>{m.type === 'audio' ? '🎵' : m.type === 'caption' ? '💬' : '🎬'} <b>{m.name}</b> <span className="muted">{m.external ? '外链' : '内嵌'} {m.size ? fmtSize(m.size) : ''} {m.duration ? `· ${Math.round(m.duration)}s` : ''}</span></div>
                              {(m.subtitles || []).length === 0 && <div className="muted small">未发现字幕（仅解析字幕，不解析视频画面）</div>}
                              {(m.subtitles || []).map((st, k) => <div key={k} className="small">字幕来源：{st.source}（{st.cues.length} 条）</div>)}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ),
                },
                notes: { title: isWord ? '💬 批注' : '🗣 讲解词（备注）', body: <NotesBody slide={slide} terms={highlight} unit={unit} tab={notesTab} setTab={setNotesTab} /> },
                md: { title: '📝 解析 Markdown', body: <MdBody slide={slide} terms={highlight} onGenerated={() => setNotesTab('ai')} /> },
              }} /></div><RelatedRail slide={slide} onPick={pickRelated} /></div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
