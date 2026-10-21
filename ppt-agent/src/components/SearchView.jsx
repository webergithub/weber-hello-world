import React, { useEffect, useRef, useState } from 'react';
import { api, fmtSize, THEME_LABEL } from '../api';
import { useApp } from '../ctx';
import { highlight } from '../md';
import SlidePreview from './SlidePreview';
import SlideViewer from './SlideViewer';

const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function snippet(text, terms, n = 140) {
  const t = String(text || '').replace(/\s+/g, ' ');
  const lower = t.toLowerCase();
  let pos = -1;
  for (const k of terms) { const p = lower.indexOf(k.toLowerCase()); if (p >= 0 && (pos < 0 || p < pos)) pos = p; }
  const start = Math.max(0, pos - 30);
  return (start > 0 ? '…' : '') + t.slice(start, start + n) + (start + n < t.length ? '…' : '');
}

export default function SearchView({ state, setState }) {
  const app = useApp();
  const { q = '', result = null, tab = 'light' } = state;
  const [input, setInput] = useState(q);
  const [busy, setBusy] = useState(false);
  const [useLlm, setUseLlm] = useState(true);
  const [sel, setSel] = useState(() => new Set());
  const [flash, setFlash] = useState(null);
  const [answer, setAnswer] = useState(null);
  const [fileFilter, setFileFilter] = useState(null);
  const [cmpSel, setCmpSel] = useState(() => new Set());
  const inputRef = useRef(null);
  const llmOn = app.config && app.config.llm && app.config.llm.enabled;

  useEffect(() => { inputRef.current && inputRef.current.focus(); }, []);
  const run = async (text = input) => {
    if (!text.trim()) return;
    setBusy(true); setAnswer(null); setFileFilter(null);
    try {
      const r = await api.search(text.trim(), { useLlm: llmOn && useLlm });
      setState({ q: text.trim(), result: r, tab: state.tab === 'viewer' ? 'viewer' : r.slides.light.length ? 'light' : r.slides.dark.length ? 'dark' : r.slides.word.length ? 'word' : 'light' });
      setSel(new Set()); setCmpSel(new Set());
    } catch (e) { app.toast('检索失败：' + e.message, 'error'); } finally { setBusy(false); }
  };
  const terms = result ? [...result.analysis.zh, ...result.analysis.en] : [];
  const slidesAll = result && result.slides[tab] ? result.slides[tab] : [];
  const allHits = result ? [...result.slides.light, ...result.slides.dark, ...(result.slides.word || [])] : [];
  const topHit = allHits.slice().sort((a, b) => b.score - a.score)[0];
  const viewerFiles = result ? result.files.map((f) => f.file.id) : [];
  const [viewerStart, setViewerStart] = useState(null);
  const slides = fileFilter ? slidesAll.filter((s) => s.file_id === fileFilter) : slidesAll;
  const toggle = (id) => { const n = new Set(sel); if (n.has(id)) n.delete(id); else n.add(id); setSel(n); };
  const jumpCounterpart = (cp) => {
    const other = cp.theme === 'dark' ? 'dark' : 'light';
    const inList = result.slides[other].some((s) => s.id === cp.id);
    if (inList) {
      setState({ ...state, tab: other });
      setFileFilter(null);
      setFlash(cp.id);
      setTimeout(() => { const el = document.querySelector(`[data-rid="${cp.id}"]`); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, 60);
      setTimeout(() => setFlash(null), 2500);
    } else app.openSlide(cp.id);
  };
  const ask = async () => {
    setAnswer({ loading: true });
    try {
      const ids = [...result.slides.light, ...result.slides.dark].sort((a, b) => b.score - a.score).slice(0, 8).map((s) => s.id);
      setAnswer(await api.answer(result.analysis.raw, ids));
    } catch (e) { setAnswer({ error: e.message }); }
  };
  const tierCls = { 1: 'tier1', 2: 'tier2', 3: 'tier3' };
  // 对比：每个文件从得分最高的命中页开始
  const bestHit = (fid) => { let b = null; for (const h of allHits) if (h.file_id === fid && (!b || h.score > b.score)) b = h; return b ? b.id : undefined; };
  const compareFiles = (fids) => app.openCompare(fids, Object.fromEntries(fids.map((f) => [f, bestHit(f)]).filter((x) => x[1])));
  const selFiles = [...new Set(allHits.filter((h) => sel.has(h.id)).map((h) => h.file_id))];
  const toggleCmp = (id) => { const n = new Set(cmpSel); if (n.has(id)) n.delete(id); else n.add(id); setCmpSel(n); };

  return (
    <div className="view">
      <div className="search-bar">
        <input ref={inputRef} className="input big" placeholder="输入关键词或一句描述，例如：机航 turnaround / 如何缩短飞机过站时间" value={input}
          onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && run()} />
        <button className="btn primary big" disabled={busy} onClick={() => run()}>{busy ? '检索中…' : '🔍 智能搜索'}</button>
        {llmOn && <label className="chk"><input type="checkbox" checked={useLlm} onChange={(e) => setUseLlm(e.target.checked)} /> 大模型解析查询</label>}
      </div>
      {!result && (
        <div className="search-empty">
          <p>可检索内容：设置中启用的 PPT 与 Word 文档（本地数据库 + 本地 RAG，不上传数据）。检索流程：<b>中英文解析</b>（分词 + 双语词表互译{llmOn ? ' + 大模型扩展' : ''}）→ <b>文件名</b>命中优先 → <b>标签</b>命中 → <b>内容</b>（BM25 全文 + 向量语义召回，RRF 融合）→ 推荐页面（附备注讲解词），按白底 / 黑底分开展示。</p>
          <div className="chips">{['机航 turnaround', '如何缩短飞机过站时间', 'RAG knowledge assistant', '安全培训视频', '成本优化 cost'].map((x) => <span key={x} className="chip link" onClick={() => { setInput(x); run(x); }}>{x}</span>)}</div>
        </div>
      )}
      {result && (
        <div className="search-result">
          <div className="analysis">
            <span className="muted">查询解析（{result.analysis.lang === 'mixed' ? '中英混合' : result.analysis.lang === 'zh' ? '中文' : result.analysis.lang === 'en' ? '英文' : '未知'}）：</span>
            {result.analysis.groups.map((g, i) => (
              <span key={i} className={`qgroup ${g.required ? '' : 'opt'}`} title={g.synonyms.join(' / ')}>
                <b>{g.term}</b>{g.synonyms.length > 1 ? <span className="muted"> ≈ {g.synonyms.filter((s) => s !== g.term.toLowerCase()).slice(0, 5).join(' / ')}</span> : null}
                <span className={`src src-${g.source}`}>{g.source === 'glossary' ? '词表' : g.source === 'llm' ? '大模型' : '分词'}</span>
              </span>
            ))}
            {result.analysis.intent && <span className="muted">意图：{result.analysis.intent}</span>}
            {result.analysis.llmError && <span className="tag warn" title={result.analysis.llmError}>大模型不可用，已使用内置词表</span>}
            <span className="muted small">召回 {result.retrievers.join(' · ')} · {result.timing.total}ms</span>
          </div>
          <div className="sr-body">
            <div className="sr-files">
              <div className="side-title">相关 PPT（{result.files.length}）{fileFilter && <button className="btn tiny" onClick={() => setFileFilter(null)}>显示全部页面</button>}
                {cmpSel.size > 0 && <button className="btn tiny primary" disabled={cmpSel.size < 2 || cmpSel.size > 4} title="勾选 2–4 个文件后并排对比（从各自命中度最高的页开始）" onClick={() => compareFiles([...cmpSel])}>⧉ 对比（{cmpSel.size}）</button>}</div>
              {result.files.map((f) => (
                <div key={f.file.id} className={`sr-file ${fileFilter === f.file.id ? 'active' : ''}`} onClick={() => setFileFilter(fileFilter === f.file.id ? null : f.file.id)}>
                  <div className="fi-name"><label className="fi-cmp" title="勾选 2–4 个文件进行对比" onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={cmpSel.has(f.file.id)} onChange={() => toggleCmp(f.file.id)} /></label><span dangerouslySetInnerHTML={{ __html: highlight(esc(f.file.name), terms) }} /></div>
                  <div className="fi-meta">
                    <span className={`tag ${tierCls[f.tier]}`}>{f.tierLabel}</span>
                    <span className={`tag theme-${f.file.theme}`}>{THEME_LABEL[f.file.theme]}</span>
                    <span>{f.file.slide_count} 页</span><span>{fmtSize(f.file.size)}</span>{f.hits ? <span>命中 {f.hits} 页</span> : null}
                  </div>
                  <div className="fi-tags">{(f.file.tags || []).slice(0, 8).map((t) => <span key={t} className={`tag ${terms.some((k) => t.toLowerCase().includes(k.toLowerCase())) ? 'hit' : ''}`}>{t}</span>)}</div>
                  <div className="fi-actions"><button className="btn tiny" onClick={(e) => { e.stopPropagation(); app.openFile(f.file.id); }}>查看全部页</button><button className="btn tiny" onClick={(e) => { e.stopPropagation(); api.openPath(f.file.path); }}>打开 PPT</button></div>
                </div>
              ))}
            </div>
            <div className="sr-slides">
              <div className="tabs">
                <button className={tab === 'light' ? 'on' : ''} onClick={() => setState({ ...state, tab: 'light' })}>⬜ 白底页面（{result.slides.light.length}）</button>
                <button className={tab === 'dark' ? 'on' : ''} onClick={() => setState({ ...state, tab: 'dark' })}>⬛ 黑底页面（{result.slides.dark.length}）</button>
                <button className={tab === 'word' ? 'on' : ''} onClick={() => setState({ ...state, tab: 'word' })}>📄 Word 文档（{(result.slides.word || []).length}）</button>
                <button className={tab === 'viewer' ? 'on' : ''} onClick={() => setState({ ...state, tab: 'viewer' })}>⛶ 逐页浏览</button>
                <div className="spacer" />
                <span className="badge">已选 {sel.size}</span>
                <button className="btn small" onClick={() => setSel(new Set([...sel, ...slides.map((s) => s.id)]))}>全选本页签</button>
                <button className="btn small" disabled={!sel.size} onClick={() => { app.basket.add([...sel]); setSel(new Set()); }}>加入导出篮</button>
                <button className="btn small primary" disabled={!sel.size} onClick={() => app.exportSlides([...sel], 'pptx')}>导出新 PPT</button>
                {selFiles.length >= 2 && <button className="btn small" disabled={selFiles.length > 4} title="所选页面来自 2–4 个文件时，可并排对比这些文件（从所选页开始）" onClick={() => app.openCompare(selFiles, Object.fromEntries(selFiles.map((f) => [f, allHits.find((h) => h.file_id === f && sel.has(h.id)).id])))}>⧉ 对比所选页所在文件（{selFiles.length}）</button>}
                {llmOn && <button className="btn small" onClick={ask}>🤖 RAG 回答</button>}
              </div>
              {answer && tab !== 'viewer' && (
                <div className="answer">
                  {answer.loading ? '正在基于检索结果生成回答…' : answer.error ? <span className="danger">{answer.error}</span> : (
                    <>
                      <div className="answer-text">{answer.text}</div>
                      <div className="small muted">出处：{answer.sources.map((s) => <span key={s.id} className="chip link" onClick={() => app.openSlide(s.id)}>[{s.n}] {s.file} 第{s.idx}页</span>)}</div>
                    </>
                  )}
                </div>
              )}
              {tab === 'viewer' && (
                <div className="viewer-wrap">
                  <SlideViewer fileIds={viewerFiles} active={tab === 'viewer' && !app.modalOpen} compact terms={terms} matched={allHits.map((x) => x.id)}
                    initialFileId={(viewerStart && viewerStart.fileId) || (fileFilter) || (topHit && topHit.file_id) || viewerFiles[0]}
                    initialSlideId={(viewerStart && viewerStart.slideId) || (!fileFilter && topHit ? topHit.id : null)} />
                </div>
              )}
              {tab !== 'viewer' && slides.length === 0 && <div className="empty-tip">{tab === 'dark' ? '没有匹配的黑底页面' : tab === 'word' ? '没有匹配的 Word 文档章节' : '没有匹配的白底页面'}{result.slides[tab === 'dark' ? 'light' : 'dark'].length ? `，可切换到${tab === 'dark' ? '白底' : '黑底'}页签查看` : ''}</div>}
              {tab !== 'viewer' && <div className="card-grid">
                {slides.map((s) => (
                  <div key={s.id} data-rid={s.id} className={`slide-card ${sel.has(s.id) ? 'sel' : ''} ${flash === s.id ? 'flash' : ''}`}>
                    <div className="sc-preview" onClick={() => app.openSlide(s.id, viewerFiles, terms, allHits.map((x) => x.id))}>
                      <SlidePreview slide={s} highlight={terms} />
                      <label className="sc-check" onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={sel.has(s.id)} onChange={() => toggle(s.id)} /></label>
                      <span className="sc-score">{Math.round(s.score * 100)}</span>
                    </div>
                    <div className="sc-body">
                      <div className="sc-title" dangerouslySetInnerHTML={{ __html: highlight(esc(s.title || `第 ${s.idx} 页`), terms) }} />
                      <div className="muted small ellipsis" title={s.filePath}>{s.fileName} · 第 {s.idx} {s.kind === 'word' ? '节' : '页'}{s.hidden ? ' · 隐藏页' : ''}</div>
                      <button className="btn tiny" style={{ alignSelf: 'flex-start', marginLeft: 0 }} onClick={() => { setViewerStart({ fileId: s.file_id, slideId: s.id }); setState({ ...state, tab: 'viewer' }); }}>⛶ 在逐页浏览中打开</button>
                      <div className="sc-snippet" dangerouslySetInnerHTML={{ __html: highlight(esc(snippet(s.text, terms)), terms) }} />
                      {s.notes && <details className="sc-notes"><summary>{s.kind === 'word' ? '💬 批注' : '🗣 讲解词'}</summary><div dangerouslySetInnerHTML={{ __html: highlight(esc(s.notes), terms) }} /></details>}
                      <div className="sc-foot">
                        {s.matched.map((m) => <span key={m} className="tag hit">{m}</span>)}
                        {s.has_video && <span className="tag">🎬</span>}
                      </div>
                      {s.counterpart && (
                        <div className="cp-hint" onClick={() => jumpCounterpart(s.counterpart)}>
                          ⇄ 有内容相近的<b>{THEME_LABEL[s.counterpart.theme]}</b>版本（{s.counterpart.fileName} 第 {s.counterpart.idx} 页），点击切换查看
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
