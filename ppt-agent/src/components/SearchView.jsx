import React, { useEffect, useRef, useState } from 'react';
import { api, fmtSize, fmtTime, THEME_LABEL } from '../api';
import { useApp } from '../ctx';
import { highlight } from '../md';
import SlidePreview from './SlidePreview';
import SlideViewer from './SlideViewer';
import SearchTasks from './SearchTasks';
import { searchQueue, useSearchQueue } from '../searchQueue';

let TASKS_OPEN = false; // 搜索任务与历史面板是否展开（会话内记住）
const firstTab = (r) => (r.slides.light.length ? 'light' : r.slides.dark.length ? 'dark' : r.slides.word.length ? 'word' : (r.slides.pdf || []).length ? 'pdf' : 'light');

const PAGE = 120;
const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function snippet(text, terms, n = 140) {
  const t = String(text || '').replace(/\s+/g, ' ');
  const lower = t.toLowerCase();
  let pos = -1;
  for (const k of terms) { const p = lower.indexOf(k.toLowerCase()); if (p >= 0 && (pos < 0 || p < pos)) pos = p; }
  const start = Math.max(0, pos - 30);
  return (start > 0 ? '…' : '') + t.slice(start, start + n) + (start + n < t.length ? '…' : '');
}

/** 智能搜索（总览分析模块）：默认在所有资料库中检索，可切换为只搜当前选择的任务 */
export default function SearchView({ state, setState, taskId, taskName, defaultAll = false }) {
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
  const llmOn = app.config && !app.config.offlineOnly && app.config.llm && app.config.llm.enabled;
  const [stats, setStats] = useState(null);
  // 检索范围：在已经执行过的任务中多选；不选 = 所有资料库（选择会记住）
  const ran = app.tasks.filter((t) => t.status !== 'draft' && (t.status === 'done' || (t.parsed || 0) + (t.skipped || 0) + (t.duplicate || 0) > 0));
  const [scopeIdsRaw, setScopeIdsRaw] = useState(() => { try { return JSON.parse(localStorage.getItem('ppta.searchScope') || '[]'); } catch { return []; } });
  const scopeIds = scopeIdsRaw.filter((id) => ran.some((t) => t.id === id));
  const setScopeIds = (ids) => { setScopeIdsRaw(ids); try { localStorage.setItem('ppta.searchScope', JSON.stringify(ids)); } catch { /* ignore */ } };
  const scopeKey = scopeIds.join(',');
  // 推荐词：根据已导入文档的标签生成（随检索范围、资料库变化刷新），不再使用固定的预置示例
  const [suggest, setSuggest] = useState([]);
  useEffect(() => { api.searchSuggestions({ taskIds: scopeIds, limit: 12 }).then(setSuggest).catch(() => setSuggest([])); }, [scopeKey, app.taskTick]);
  const tagQuery = (t) => String(t).replace(/\//g, ' ').trim();
  const placeholder = suggest.length ? `输入关键词或一句描述，例如：${suggest.slice(0, 2).map((x) => tagQuery(x.tag)).join(' / ')}` : '输入关键词或一句描述';
  useEffect(() => {
    if (!scopeIds.length) { api.stats().then(setStats).catch(() => {}); return; }
    Promise.all(scopeIds.map((id) => api.library({ taskId: id }).catch(() => []))).then((ls) => {
      const m = new Map(); for (const f of ls.flat()) if (f.status === 'parsed') m.set(f.id, f);
      setStats({ files: m.size, slides: [...m.values()].reduce((a, f) => a + (f.slide_count || 0), 0) });
    });
  }, [app.taskTick, scopeKey]);
  const scopeSeg = <ScopePicker tasks={ran} value={scopeIds} curTaskId={taskId} onChange={(ids) => { setScopeIds(ids); }} />;

  useEffect(() => { inputRef.current && inputRef.current.focus(); }, []);
  const qs = useSearchQueue();
  const [tasksOpen, setTasksOpenState] = useState(TASKS_OPEN);
  const setTasksOpen = (v) => { TASKS_OPEN = v; setTasksOpenState(v); };
  const [recent, setRecent] = useState([]);
  useEffect(() => { if (!result) api.searchHistory({ limit: 30 }).then((h) => { const seen = new Set(); setRecent(h.filter((x) => x.status === 'done' && !seen.has(x.q) && seen.add(x.q)).slice(0, 8)); }).catch(() => {}); }, [result, qs.items.length]);
  const curScope = () => ({ useLlm: llmOn && useLlm, taskIds: scopeIds, taskNames: scopeIds.map((id) => (ran.find((t) => t.id === id) || {}).name || `#${id}`) });
  const show = (q, r) => {
    setState({ q, result: r, tab: state.tab === 'viewer' ? 'viewer' : firstTab(r) });
    setInput(q); setAnswer(null); setFileFilter(null); setSel(new Set()); setCmpSel(new Set());
  };
  const run = async (text = input, scope = curScope()) => {
    if (!text.trim()) return;
    setBusy(true);
    try { show(text.trim(), await api.search(text.trim(), { useLlm: scope.useLlm, taskIds: scope.taskIds || [] })); } catch (e) { app.toast('检索失败：' + e.message, 'error'); } finally { setBusy(false); }
  };
  const enqueue = () => { if (!input.trim()) return; searchQueue.add(input, curScope()); app.toast(`已加入搜索队列：${input.trim()}`); setTasksOpen(true); };
  // 查看历史 / 队列中某次搜索的结果
  const viewHistory = async (id) => { try { const r = await api.searchHistoryResult(id); show(r.analysis.raw || input, r); } catch (e) { app.toast(e.message, 'error'); } };
  const rerun = (h) => run(h.q, { useLlm: !!h.use_llm, taskIds: h.task_ids || [] });
  const busyQ = qs.items.filter((x) => x.status === 'queued' || x.status === 'running').length;
  const tasksBtn = <button className={`btn ${tasksOpen ? 'primary' : ''}`} onClick={() => setTasksOpen(!tasksOpen)}>🗂 搜索任务与历史{busyQ ? `（${busyQ}）` : ''}</button>;
  const terms = result ? [...result.analysis.zh, ...result.analysis.en] : [];
  const slidesAll = result && result.slides[tab] ? result.slides[tab] : [];
  const allHits = result ? [...result.slides.light, ...result.slides.dark, ...(result.slides.word || []), ...(result.slides.pdf || [])] : [];
  const topHit = allHits.slice().sort((a, b) => b.score - a.score)[0];
  const viewerFiles = result ? result.files.map((f) => f.file.id) : [];
  const [viewerStart, setViewerStart] = useState(null);
  // 选中左侧某个文件时，页签数字与页面都只统计该文件的搜索结果；再次单击取消选择回到全部结果
  const ofFile = (arr) => (fileFilter ? (arr || []).filter((s) => s.file_id === fileFilter) : arr || []);
  const counts = result ? { light: ofFile(result.slides.light).length, dark: ofFile(result.slides.dark).length, word: ofFile(result.slides.word).length, pdf: ofFile(result.slides.pdf).length } : {};
  const slidesFiltered = ofFile(slidesAll);
  // 全部结果较多时分批显示，避免一次渲染上千张页面
  const [shown, setShown] = useState(PAGE);
  useEffect(() => { setShown(PAGE); }, [result, tab, fileFilter]);
  const slides = slidesFiltered.slice(0, shown);
  const pickFile = (fid) => {
    const next = fileFilter === fid ? null : fid;
    setFileFilter(next);
    // 当前页签没有该文件的结果时，自动切到有结果的页签
    if (next && result && tab !== 'viewer' && !(result.slides[tab] || []).some((x) => x.file_id === next)) {
      const t = ['light', 'dark', 'word', 'pdf'].find((k) => (result.slides[k] || []).some((x) => x.file_id === next));
      if (t) setState({ ...state, tab: t });
    }
  };
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
    <div className={`view search-view ${tasksOpen ? 'with-tasks' : ''}`}>
      {/* 未搜索时：搜索框在页面中央（类似搜索引擎首页）；有结果后收到顶部 */}
      {!result ? (
        <div className="search-landing">
          <div className="sl-hero">
            <div className="sl-logo">🔍 智能搜索</div>
            <div className="sl-sub">在本机的 PPT、Word 与 PDF 中按文件名、标签与内容检索，中英文混合均可</div>
          </div>
          <div className="sl-box">
            <input ref={inputRef} className="input sl-input" placeholder={placeholder} value={input}
              onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && run()} />
            <button className="btn primary sl-btn" disabled={busy} onClick={() => run()}>{busy ? '检索中…' : '搜索'}</button>
          </div>
          <div className="row center sl-actions">{scopeSeg}<button className="btn" disabled={!input.trim()} title="加入搜索队列，按顺序依次执行" onClick={enqueue}>＋ 加入队列</button>{tasksBtn}</div>
          {recent.length > 0 && <div className="chips sl-recent"><span className="muted small">最近搜索：</span>{recent.map((h) => <span key={h.id} className="chip link" title={`${fmtTime(h.at)} · 文件 ${h.files}`} onClick={() => viewHistory(h.id)}>🕘 {h.q}</span>)}</div>}
          {llmOn && <label className="chk"><input type="checkbox" checked={useLlm} onChange={(e) => setUseLlm(e.target.checked)} /> 大模型解析查询</label>}
          {suggest.length > 0 && <div className="chips sl-chips">{suggest.map((x) => <span key={x.tag} className="chip link" title={`${x.files} 个文档带有该标签`} onClick={() => { const q = tagQuery(x.tag); setInput(q); run(q); }}>{x.tag}</span>)}</div>}
          {stats && <div className="sl-stats"><span><b>{stats.files}</b> 个文档</span><span><b>{stats.slides}</b> 页 / 节</span><span>本地 RAG · 不上传数据</span></div>}
          <div className="sl-flow muted small">中英文解析（分词 + 双语词表互译{llmOn ? ' + 大模型扩展' : ''}）→ 文件名命中 → 标签命中 → 内容（BM25 全文 + 向量语义召回）→ 按白底 / 黑底 / Word / PDF 分开推荐页面</div>
        </div>
      ) : (
        <div className="search-bar">
          <input ref={inputRef} className="input big" placeholder={placeholder} value={input}
            onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && run()} />
          <button className="btn primary big" disabled={busy} onClick={() => run()}>{busy ? '检索中…' : '🔍 智能搜索'}</button>
          <button className="btn" disabled={!input.trim()} title="加入搜索队列，按顺序依次执行" onClick={enqueue}>＋ 加入队列</button>
          {tasksBtn}
          {llmOn && <label className="chk"><input type="checkbox" checked={useLlm} onChange={(e) => setUseLlm(e.target.checked)} /> 大模型解析查询</label>}
          {scopeSeg}
          <button className="btn ghost" title="清空结果，回到搜索首页" onClick={() => { setState({}); setInput(''); }}>✕ 清空</button>
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
            {result.historyAt && <span className="tag warn" title="这是搜索历史中保存的结果，资料库变化后可重新搜索">历史结果 · {fmtTime(result.historyAt)} <span className="link" onClick={() => run(q)}>↻ 重新搜索</span></span>}
          </div>
          <div className="sr-body">
            <div className="sr-files">
              <div className="side-title">相关 PPT（{result.files.length}）{fileFilter && <button className="btn tiny" onClick={() => setFileFilter(null)}>显示全部页面</button>}
                {cmpSel.size > 0 && <button className="btn tiny primary" disabled={cmpSel.size < 2 || cmpSel.size > 4} title="勾选 2–4 个文件后并排对比（从各自命中度最高的页开始）" onClick={() => compareFiles([...cmpSel])}>⧉ 对比（{cmpSel.size}）</button>}</div>
              {result.files.map((f) => (
                <div key={f.file.id} className={`sr-file ${fileFilter === f.file.id ? 'active' : ''}`} onClick={() => pickFile(f.file.id)}>
                  <div className="fi-name"><label className="fi-cmp" title="勾选 2–4 个文件进行对比" onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={cmpSel.has(f.file.id)} onChange={() => toggleCmp(f.file.id)} /></label><span dangerouslySetInnerHTML={{ __html: highlight(esc(f.file.name), terms) }} /></div>
                  <div className="fi-meta">
                    <span className={`tag ${tierCls[f.tier]}`}>{f.tierLabel}</span>
                    <span className={`tag theme-${f.file.theme}`}>{THEME_LABEL[f.file.theme]}</span>
                    <span>{f.file.slide_count} 页</span><span>{fmtSize(f.file.size)}</span>{f.hits ? <span>命中 {f.hits} 页</span> : null}
                  </div>
                  <div className="fi-tags">{(f.file.tags || []).slice(0, 8).map((t) => <span key={t} className={`tag ${terms.some((k) => t.toLowerCase().includes(k.toLowerCase())) ? 'hit' : ''}`}>{t}</span>)}</div>
                  <div className="fi-actions"><button className="btn tiny" onClick={(e) => { e.stopPropagation(); app.openFile(f.file.id); }}>查看全部页</button><button className="btn tiny" onClick={(e) => { e.stopPropagation(); api.openPath(f.file.path); }}>打开原文件</button></div>
                </div>
              ))}
            </div>
            <div className="sr-slides">
              <div className="tabs">
                <button className={tab === 'light' ? 'on' : ''} onClick={() => setState({ ...state, tab: 'light' })}>⬜ 白底（{counts.light}）</button>
                <button className={tab === 'dark' ? 'on' : ''} onClick={() => setState({ ...state, tab: 'dark' })}>⬛ 黑底（{counts.dark}）</button>
                <button className={tab === 'word' ? 'on' : ''} onClick={() => setState({ ...state, tab: 'word' })}>📄 Word（{counts.word}）</button>
                <button className={tab === 'pdf' ? 'on' : ''} onClick={() => setState({ ...state, tab: 'pdf' })}>📕 PDF（{counts.pdf}）</button>
                <button className={tab === 'viewer' ? 'on' : ''} onClick={() => setState({ ...state, tab: 'viewer' })}>⛶ 逐页浏览</button>
                <div className="spacer" />
                <span className="badge">已选 {sel.size}</span>
                <button className="btn small" onClick={() => setSel(new Set([...sel, ...slidesFiltered.map((s) => s.id)]))}>全选</button>
                <button className="btn small" disabled={!sel.size} onClick={() => { app.basket.add([...sel]); setSel(new Set()); }}>＋ 加入导出篮</button>
                <button className="btn small primary" disabled={!sel.size} onClick={() => app.exportSlides([...sel], 'pptx')}>⇩ 导出为新 PPT</button>
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
              {tab !== 'viewer' && slides.length === 0 && <div className="empty-tip">{tab === 'dark' ? '没有匹配的黑底页面' : tab === 'word' ? '没有匹配的 Word 文档章节' : tab === 'pdf' ? '没有匹配的 PDF 页面' : '没有匹配的白底页面'}{counts[tab === 'dark' ? 'light' : 'dark'] ? `，可切换到${tab === 'dark' ? '白底' : '黑底'}页签查看` : ''}</div>}
              {tab !== 'viewer' && <div className="card-grid">
                {slides.map((s) => (
                  <div key={s.id} data-rid={s.id} className={`slide-card ${sel.has(s.id) ? 'sel' : ''} ${flash === s.id ? 'flash' : ''}`}>
                    <div className="sc-preview" data-noopen onClick={() => app.openSlide(s.id, viewerFiles, terms, allHits.map((x) => x.id), slidesFiltered, { max: true })}>
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
                        {s.kind === 'pdf' && s.theme === 'dark' && <span className="tag theme-dark">{THEME_LABEL.dark}</span>}
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
              {tab !== 'viewer' && slidesFiltered.length > shown && <div className="more-row"><button className="btn" onClick={() => setShown((n) => n + PAGE)}>显示更多（已显示 {shown} / {slidesFiltered.length}）</button><button className="btn ghost" onClick={() => setShown(slidesFiltered.length)}>全部显示</button></div>}
            </div>
          </div>
        </div>
      )}
      {tasksOpen && <SearchTasks currentId={result && result.historyId} onView={viewHistory} onRerun={rerun} onClose={() => setTasksOpen(false)} />}
    </div>
  );
}

/** 检索范围选择：所有资料库，或在已执行的任务中多选 */
export function scopeText(ids = [], names = []) {
  if (!ids || !ids.length) return '所有资料库';
  if (ids.length === 1) return `任务 #${ids[0]}${names && names[0] ? ` ${names[0]}` : ''}`;
  return `${ids.length} 个任务：${(names || []).slice(0, 3).join('、')}${ids.length > 3 ? ' 等' : ''}`;
}
function ScopePicker({ tasks, value, onChange, curTaskId }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);
  const set = new Set(value);
  const toggle = (id) => { const n = new Set(set); if (n.has(id)) n.delete(id); else n.add(id); onChange(tasks.filter((t) => n.has(t.id)).map((t) => t.id)); };
  const label = scopeText(value, value.map((id) => (tasks.find((t) => t.id === id) || {}).name));
  return (
    <div className="scope-pick" ref={ref}>
      <button className={`btn ${value.length ? 'primary' : ''}`} title="检索范围：所有资料库，或在已执行的任务中多选" onClick={() => setOpen(!open)}>🎯 范围：{label} ▾</button>
      {open && (
        <div className="scope-pop">
          <label className="chk sp-all"><input type="checkbox" checked={!value.length} onChange={() => onChange([])} /> <b>所有资料库</b></label>
          <div className="sp-list">
            {!tasks.length && <div className="muted small">还没有已执行的任务</div>}
            {tasks.map((t) => (
              <label key={t.id} className="chk sp-item" title={t.dir}>
                <input type="checkbox" checked={set.has(t.id)} onChange={() => toggle(t.id)} />
                <span className="ellipsis">#{t.id} {t.name}</span><span className="muted small">{t.parsed || 0} 个文件{t.id === curTaskId ? ' · 当前任务' : ''}</span>
              </label>
            ))}
          </div>
          <div className="sp-foot">
            <button className="btn tiny" disabled={!tasks.length} onClick={() => onChange(tasks.map((t) => t.id))}>全选</button>
            {curTaskId && tasks.some((t) => t.id === curTaskId) && <button className="btn tiny" onClick={() => onChange([curTaskId])}>仅当前任务</button>}
            <button className="btn tiny ghost" onClick={() => onChange([])}>清空（所有资料库）</button>
            <div className="spacer" /><button className="btn tiny primary" onClick={() => setOpen(false)}>完成</button>
          </div>
        </div>
      )}
    </div>
  );
}
