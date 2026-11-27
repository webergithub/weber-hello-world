import React, { useEffect, useMemo, useState } from 'react';
import { api, fmtTime, on } from '../api';
import { useApp } from '../ctx';
import DataTable from './DataTable';
import EtaLine from './Eta';
import { StatCards } from './DrillDialog';

const TABS = [['ingest', '⚗ 炼丹'], ['explore', '🧭 探索'], ['browse', '📖 浏览'], ['ask', '💬 问答'], ['lint', '🩺 体检'], ['log', '📜 日志'], ['schema', '📐 规则']];
const TYPE_LABEL = { source: '资料', concept: '概念', tag: '标签', topic: '分类', query: '问答', index: '总目录', log: '日志', schema: '规则' };
const LINT_LABEL = { removed: '已移出资料库', stale: '资料已更新', missing: '未炼化', broken: '断开的链接', orphan: '孤立页面', weak: '单一来源概念' };
const FIXABLE = { stale: '重新炼化', missing: '炼化', removed: '删除资料页', broken: '重建页面', orphan: '重建页面' };
const OP_LABEL = { ingest: '炼丹', query: '问答', lint: '体检', fix: '修复', schema: '规则', rebuild: '重建' };
// 会话内记住页签、正在看的页面与浏览历史、最近一次问答 / 体检
const MEMO = { tab: 'ingest', slug: 'index', hist: [], typeFilter: '', ask: null, lint: null, q: '' };

/** 极简 Markdown 渲染：标题、列表、引用、段落、`代码`、**加粗**、[[页面|标题]] 链接（点击在 Wiki 内跳转） */
function Md({ text, onLink }) {
  const body = String(text || '');
  const fm = body.match(/^---\n([\s\S]*?)\n---\n/);
  const rest = fm ? body.slice(fm[0].length) : body;
  const inline = (s, k) => {
    const out = [];
    const re = /\[\[([^\]|]+)(?:\|([^\]]*))?\]\]|`([^`]+)`|\*\*([^*]+)\*\*/g;
    let last = 0, m, i = 0;
    while ((m = re.exec(s))) {
      if (m.index > last) out.push(s.slice(last, m.index));
      if (m[1]) { const target = m[1]; out.push(<span key={`${k}-${i++}`} className="link wiki-link" onClick={() => onLink(target)}>{m[2] || m[1]}</span>); }
      else if (m[3]) out.push(<code key={`${k}-${i++}`}>{m[3]}</code>);
      else out.push(<b key={`${k}-${i++}`}>{m[4]}</b>);
      last = re.lastIndex;
    }
    if (last < s.length) out.push(s.slice(last));
    return out;
  };
  const blocks = [];
  let list = null;
  const flush = () => { if (list) { blocks.push(<ul key={`ul-${blocks.length}`}>{list}</ul>); list = null; } };
  rest.split('\n').forEach((line, n) => {
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { flush(); const H = `h${Math.min(4, h[1].length + 1)}`; blocks.push(<H key={n}>{inline(h[2], n)}</H>); return; }
    const li = line.match(/^\s*[-*]\s+(.*)$/);
    if (li) { (list = list || []).push(<li key={n}>{inline(li[1], n)}</li>); return; }
    flush();
    if (/^>\s?/.test(line)) { blocks.push(<blockquote key={n}>{inline(line.replace(/^>\s?/, ''), n)}</blockquote>); return; }
    if (line.trim()) blocks.push(<p key={n}>{inline(line, n)}</p>);
  });
  flush();
  return (
    <div className="wiki-md">
      {fm && <div className="wiki-fm">{fm[1].split('\n').map((l) => { const i = l.indexOf(':'); return <span key={l}><b>{l.slice(0, i)}</b> {l.slice(i + 1)}</span>; })}</div>}
      {blocks}
    </div>
  );
}

/**
 * 智能模块 → LLMWiki 炼丹（v3.13）：把资料库中已解析的文档“炼”成持续维护的 Markdown 知识库
 * （LLM Wiki 模式：原始资料只读 → Wiki 页面 → 规则 schema）。炼丹 = 增量吸收资料；浏览 = 页面与链接；
 * 问答 = 先读总目录挑页面再作答，可存为页面；体检 = 过期 / 未炼化 / 断链 / 孤立页面与修复；日志；规则。
 */
export default function LlmWikiView() {
  const app = useApp();
  const [tab, setTabState] = useState(MEMO.tab);
  const setTab = (t) => { MEMO.tab = t; setTabState(t); };
  const [st, setSt] = useState(null);
  const [pages, setPages] = useState(null);
  const refresh = () => { api.wikiState().then(setSt).catch((e) => app.toast(e.message, 'error')); api.wikiPages().then(setPages).catch(() => {}); };
  useEffect(() => { refresh(); const off = on('wiki', (s) => { setSt(s); if (!s.job) api.wikiPages().then(setPages).catch(() => {}); }); return off; }, []);
  const [slug, setSlug] = useState(MEMO.slug);
  const open = (s, push = true) => { if (push && slug && slug !== s) MEMO.hist = [...MEMO.hist, slug].slice(-50); MEMO.slug = s; setSlug(s); setTab('browse'); };
  const [typeFilter, setTypeFilterState] = useState(MEMO.typeFilter);
  const browseType = (t) => { MEMO.typeFilter = t; setTypeFilterState(t); setTab('browse'); };
  // 从文件详情“📖 Wiki”跳转（v3.14）：view.slug
  const sent = app.view && app.view.type === 'llmwiki' ? app.view.slug : null;
  useEffect(() => { if (sent) open(sent); }, [sent]);
  const askNow = (q) => { MEMO.q = q; MEMO.autoAsk = q; setTab('ask'); };
  if (!st) return <div className="view"><div className="empty-tip">加载中…</div></div>;
  const job = st.job;
  return (
    <div className="view">
      <div className="view-head">
        <div className="vh-title">⚗ LLMWiki 炼丹</div>
        <span className={`tag ${st.aiOn ? 'ok' : ''}`}>{st.aiOn ? `大模型：${st.ai.model}` : '离线提取'}</span>
        <div className="spacer" />
        {job && <span className="wiki-job"><b>{job.label}</b> {job.done}/{job.total} <EtaLine eta={job.eta} compact /></span>}
        <button className="btn ghost" onClick={() => api.wikiOpenDir()}>📂 打开 Wiki 目录</button>
      </div>
      <div className="tabs">{TABS.map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}{k === 'lint' && MEMO.lint && MEMO.lint.issues.filter((i) => i.level === 'warn').length ? <span className="badge">{MEMO.lint.issues.filter((i) => i.level === 'warn').length}</span> : null}</button>)}</div>
      <div className="tab-body pad flex-col wiki-body">
        {tab === 'ingest' && <IngestPanel st={st} onBrowse={browseType} onOpen={open} refresh={refresh} />}
        {tab === 'browse' && <BrowsePanel pages={pages || []} slug={slug} onOpen={open} typeFilter={typeFilter} setTypeFilter={(t) => { MEMO.typeFilter = t; setTypeFilterState(t); }} onBack={() => { const h = MEMO.hist; if (h.length) { const s = h[h.length - 1]; MEMO.hist = h.slice(0, -1); open(s, false); } }} canBack={MEMO.hist.length > 0} />}
        {tab === 'explore' && <ExplorePanel onOpen={open} onAsk={askNow} onIngest={() => setTab('ingest')} />}
        {tab === 'ask' && <AskPanel onOpen={open} />}
        {tab === 'lint' && <LintPanel onOpen={open} busy={!!job} />}
        {tab === 'log' && <LogPanel onOpen={open} />}
        {tab === 'schema' && <SchemaPanel />}
      </div>
    </div>
  );
}

function IngestPanel({ st, onBrowse, onOpen, refresh }) {
  const app = useApp();
  const tasks = (app.tasks || []).filter((t) => !t.parent_id && (t.parsed || t.duplicate || t.finished_at));
  const c = st.counts;
  const scopes = new Set(st.config.scopes || []);
  const setCfg = (p) => api.wikiSetConfig(p).then(refresh).catch((e) => app.toast(e.message, 'error'));
  const start = (force) => {
    if (force && !confirm(`全部重新炼化 ${c.candidates} 份资料？\n\n已有的资料页、概念页会按当前规则重新生成（问答页保留）。`)) return;
    api.wikiIngest({ force }).then((s) => { app.toast(`开始炼丹：${force ? c.candidates : c.pending} 份资料`, 'info', { cat: 'LLMWiki' }); refresh(s); }).catch((e) => app.toast(e.message, 'error'));
  };
  const cards = [
    ['资料页', c.sources, () => onBrowse('source')],
    ['概念页', c.concepts, () => onBrowse('concept')],
    ['标签页', c.tags, () => onBrowse('tag')],
    ['分类页', c.topics, () => onBrowse('topic')],
    ['问答页', c.queries, () => onBrowse('query')],
    ['待炼化', c.pending, c.pending ? () => app.drill({ key: 'wiki-pending', title: 'LLMWiki · 待炼化的资料', load: () => api.wikiPendingFiles() }) : null],
  ];
  return (
    <div className="wiki-ingest">
      <StatCards cards={cards.map(([k, v, f]) => [k, v, f])} onDrill={(k, f) => f()} />
      <div className="fu-form">
        <div className="row"><label>范围</label>
          <label className="chk"><input type="radio" checked={!scopes.size} onChange={() => setCfg({ scopes: [] })} /> 所有资料库</label>
          {tasks.map((t) => <label key={t.id} className="chk"><input type="checkbox" checked={scopes.has(t.id)} onChange={(e) => { const n = new Set(scopes); if (e.target.checked) n.add(t.id); else n.delete(t.id); setCfg({ scopes: [...n] }); }} /> {t.name || t.dir}</label>)}
        </div>
        <div className="row"><label>方式</label>
          <div className="seg">
            <button className={!st.config.useAi ? 'on' : ''} onClick={() => setCfg({ useAi: false })}>离线提取</button>
            <button className={st.config.useAi ? 'on' : ''} disabled={!st.ai.ok} onClick={() => setCfg({ useAi: true })}>大模型炼化</button>
          </div>
          {!st.ai.ok && <button className="btn ghost small" onClick={() => app.go({ type: 'settings', focus: 'agent' })}>⚙ PPT_Agent 设置</button>}
        </div>
        <div className="row"><label />
          {st.job ? <button className="btn danger-outline" disabled={st.job.cancelling} onClick={() => api.wikiCancel().then(refresh)}>{st.job.cancelling ? '正在中止…' : '⏹ 中止'}</button>
            : <>
              <button className="btn primary" disabled={!c.pending} onClick={() => start(false)}>⚗ 开始炼丹（{c.pending}）</button>
              <button className="btn" disabled={!c.candidates} onClick={() => start(true)}>↻ 全部重新炼化</button>
              <button className="btn ghost" onClick={() => onOpen('index')}>📖 总目录</button>
            </>}
          {st.lastIngest && <span className="muted small">上次炼丹 {fmtTime(st.lastIngest)}</span>}
        </div>
        {st.job && (
          <div className="row"><label />
            <div className="progress grow"><div style={{ width: `${st.job.total ? (st.job.done / st.job.total) * 100 : 0}%` }} /></div>
            <span className="small">{st.job.label} {st.job.done}/{st.job.total}</span>
            <EtaLine eta={st.job.eta} unit="份" />
          </div>
        )}
      </div>
      <IngestFeed feed={st.feed || []} job={st.job} onOpen={onOpen} />
    </div>
  );
}

function BrowsePanel({ pages, slug, onOpen, typeFilter, setTypeFilter, onBack, canBack }) {
  const [page, setPage] = useState(null);
  useEffect(() => { let alive = true; api.wikiPage(slug).then((p) => alive && setPage(p)).catch(() => alive && setPage(null)); return () => { alive = false; }; }, [slug, pages]);
  const rows = useMemo(() => (typeFilter ? pages.filter((p) => p.type === typeFilter) : pages), [pages, typeFilter]);
  const cols = [
    { key: 'title', label: '页面', render: (p) => <span className="link" onClick={() => onOpen(p.slug)}>{p.title}</span> },
    { key: 'type', label: '类型', className: 'nowrap', sort: (p) => p.type, filterValue: (p) => TYPE_LABEL[p.type] || p.type, render: (p) => <span className={`tag wiki-${p.type}`}>{TYPE_LABEL[p.type] || p.type}</span> },
    { key: 'sources', label: '资料数', type: 'number' },
    { key: 'inbound', label: '被链接', type: 'number' },
    { key: 'links', label: '链接', type: 'number' },
    { key: 'mtime', label: '更新时间', type: 'date', render: (p) => fmtTime(p.mtime) },
  ];
  return (
    <div className="wiki-browse">
      <div className="wiki-list">
        <div className="seg wiki-types">
          <button className={!typeFilter ? 'on' : ''} onClick={() => setTypeFilter('')}>全部</button>
          {['source', 'concept', 'topic', 'tag', 'query'].map((t) => <button key={t} className={typeFilter === t ? 'on' : ''} onClick={() => setTypeFilter(t)}>{TYPE_LABEL[t]}</button>)}
        </div>
        <DataTable id="wikiPages" columns={cols} rows={rows} rowKey={(p) => p.slug} onRowClick={(p) => onOpen(p.slug)} empty="还没有页面：先在“炼丹”页签开始炼丹" />
      </div>
      <div className="wiki-page">
        <div className="wiki-page-bar">
          <button className="btn small ghost" disabled={!canBack} onClick={onBack}>← 返回</button>
          <button className="btn small ghost" onClick={() => onOpen('index')}>📖 总目录</button>
          <span className="muted small grow" title={page && page.path}>{slug}</span>
          {page && <button className="btn tiny ghost" title="在资源管理器中显示" onClick={() => api.showItem(page.path)}>📂</button>}
          {page && <button className="btn tiny" onClick={() => api.openPath(page.path)}>打开</button>}
        </div>
        {page ? (
          <div className="wiki-page-body">
            <Md text={page.text} onLink={(s) => onOpen(s)} />
            <SourceFileBar text={page.text} />
            {page.backlinks.length > 0 && <div className="wiki-back"><h4>反向链接（{page.backlinks.length}）</h4>{page.backlinks.map((b) => <span key={b.slug} className="link wiki-link" onClick={() => onOpen(b.slug)}>{b.title}</span>)}</div>}
          </div>
        ) : <div className="empty-tip">页面不存在</div>}
      </div>
    </div>
  );
}

/** 资料页：原始文件的 📂 / 打开（在应用中打开解析结果） */
function SourceFileBar({ text }) {
  const app = useApp();
  const fm = (String(text).match(/^---\n([\s\S]*?)\n---/) || [])[1] || '';
  const file = (fm.match(/^file: (.*)$/m) || [])[1];
  const id = Number((fm.match(/^file_id: (.*)$/m) || [])[1]);
  if (!file) return null;
  return (
    <div className="wiki-src">
      <span className="muted small">原始资料</span>
      <button className="btn tiny ghost" title="在资源管理器中显示" onClick={() => api.showItem(file)}>📂</button>
      <button className="btn tiny" onClick={() => api.openPath(file)}>打开原文件</button>
      {id ? <button className="btn tiny" onClick={() => app.openFile(id)}>查看解析结果</button> : null}
    </div>
  );
}

const ASK_MEMO = { threadId: null, filter: 'all', q: '' };
const dayLabel = (t) => { const d = new Date(t), n = new Date(); const k = (x) => x.toDateString(); if (k(d) === k(n)) return '今天'; const y = new Date(n); y.setDate(n.getDate() - 1); if (k(d) === k(y)) return '昨天'; if (n - d < 7 * 864e5) return '最近 7 天'; return '更早'; };
/**
 * 问答（v3.16 重新设计）：左侧“历史 / 归档”会话列表（搜索、按日期分组、归档 / 删除），右侧对话区（问题气泡、答案卡片、
 * 引用页面、追问），底部输入框（Enter 发送、Shift + Enter 换行）；归档 = 把整个会话写成 Wiki 问答页。
 */
function AskPanel({ onOpen }) {
  const app = useApp();
  const [threads, setThreads] = useState([]);
  const [filter, setFilterS] = useState(ASK_MEMO.filter);
  const [kw, setKw] = useState(ASK_MEMO.q);
  const [tid, setTidS] = useState(ASK_MEMO.threadId);
  const [thread, setThread] = useState(null);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState('');
  const [suggest, setSuggest] = useState([]);
  const bodyRef = React.useRef(null);
  const setTid = (x) => { ASK_MEMO.threadId = x; setTidS(x); };
  const loadThreads = () => api.wikiThreads({ archived: filter === 'archived' ? true : null, q: kw }).then(setThreads).catch(() => {});
  const loadThread = (id) => (id ? api.wikiThread(id).then((t) => { setThread(t); if (!t) setTid(null); }) : Promise.resolve(setThread(null)));
  useEffect(() => { loadThreads(); }, [filter, kw]);
  useEffect(() => { loadThread(tid); }, [tid]);
  useEffect(() => { api.wikiExplore().then((d) => setSuggest((d && d.questions) || [])).catch(() => {}); }, []);
  useEffect(() => { if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight; }, [thread, busy]);
  const ask = async (text, newThread = false) => {
    const q = String(text || '').trim();
    if (!q || busy) return;
    setBusy(q); setInput('');
    try {
      const r = await api.wikiQuery(q, { threadId: newThread ? null : tid });
      setTid(r.thread_id); await loadThread(r.thread_id); loadThreads();
    } catch (e) { app.toast(e.message, 'error', { cat: 'LLMWiki' }); setInput(q); } finally { setBusy(''); }
  };
  useEffect(() => { if (MEMO.autoAsk) { const x = MEMO.autoAsk; MEMO.autoAsk = null; ask(x, true); } }, []);
  const archive = async (id, on) => {
    try { const t = await api.wikiArchive(id, on); app.toast(on ? '已归档到 Wiki（问答页）' : '已取消归档', 'info', { cat: 'LLMWiki' }); if (tid === id) setThread(t); loadThreads(); } catch (e) { app.toast(e.message, 'error'); }
  };
  const remove = async (id) => { if (!confirm('删除这个会话？已归档的会同时删除对应的 Wiki 问答页。')) return; await api.wikiDeleteThreads([id]); if (tid === id) { setTid(null); setThread(null); } loadThreads(); };
  const copy = (text) => { try { navigator.clipboard.writeText(text); app.toast('已复制', 'info', { cat: 'LLMWiki' }); } catch { /* ignore */ } };
  const groups = [];
  for (const t of threads) { const g = dayLabel(t.last); if (!groups.length || groups[groups.length - 1][0] !== g) groups.push([g, []]); groups[groups.length - 1][1].push(t); }
  return (
    <div className="qa">
      <aside className="qa-side">
        <button className="btn primary qa-new" onClick={() => { setTid(null); setThread(null); }}>＋ 新的提问</button>
        <input className="input" placeholder="🔎 搜索历史问答" value={kw} onChange={(e) => { ASK_MEMO.q = e.target.value; setKw(e.target.value); }} />
        <div className="seg qa-filter">{[['all', '🕘 历史'], ['archived', '📦 归档']].map(([k, l]) => <button key={k} className={filter === k ? 'on' : ''} onClick={() => { ASK_MEMO.filter = k; setFilterS(k); }}>{l}</button>)}</div>
        <div className="qa-list">
          {!threads.length && <div className="muted small qa-empty">{filter === 'archived' ? '还没有归档的问答' : '还没有提问过'}</div>}
          {groups.map(([g, list]) => (
            <div key={g}>
              <div className="qa-group">{g}</div>
              {list.map((t) => (
                <div key={t.id} className={`qa-item ${t.id === tid ? 'on' : ''}`} onClick={() => setTid(t.id)}>
                  <div className="qa-item-t">{t.archived ? <span title="已归档">📦 </span> : null}{t.title}</div>
                  <div className="qa-item-m muted small">{t.turns > 1 ? `${t.turns} 轮 · ` : ''}{fmtTime(t.last)}</div>
                  <div className="qa-item-ops">
                    <button className="icon-btn" title={t.archived ? '取消归档' : '归档到 Wiki'} onClick={(e) => { e.stopPropagation(); archive(t.id, !t.archived); }}>{t.archived ? '↩' : '📦'}</button>
                    <button className="icon-btn" title="删除" onClick={(e) => { e.stopPropagation(); remove(t.id); }}>🗑</button>
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      </aside>
      <section className="qa-main">
        {thread && (
          <div className="qa-head">
            <b className="qa-title">{thread.title}</b>
            {thread.archived ? <span className="tag ok">📦 已归档</span> : null}
            <div className="spacer" />
            {thread.archived && thread.slug && <button className="btn small ghost" onClick={() => onOpen(thread.slug)}>📖 查看问答页</button>}
            <button className="btn small" onClick={() => archive(thread.id, !thread.archived)}>{thread.archived ? '↩ 取消归档' : '📦 归档到 Wiki'}</button>
          </div>
        )}
        <div className="qa-body" ref={bodyRef}>
          {!thread && !busy && (
            <div className="qa-welcome">
              <div className="qa-welcome-t">💬 向 Wiki 提问</div>
              <div className="muted small">回答只依据已炼化的 Wiki 页面，并注明引用的页面</div>
              {suggest.length > 0 && <div className="qa-sugg">{suggest.map((x) => <button key={x} className="qa-chip" onClick={() => ask(x, true)}>💡 {x}</button>)}</div>}
            </div>
          )}
          {thread && thread.turns.map((t) => (
            <div key={t.id} className="qa-turn">
              <div className="qa-q"><div className="qa-bubble">{t.q}</div></div>
              <div className="qa-a">
                <div className="qa-a-head"><span className="qa-avatar">⚗</span><span className="tag">{t.engine}</span>{t.ms ? <span className="muted small">{(t.ms / 1000).toFixed(1)} 秒</span> : null}<span className="muted small">{fmtTime(t.at)}</span><div className="spacer" />
                  <button className="icon-btn" title="复制答案" onClick={() => copy(t.answer)}>📋</button>
                  <button className="icon-btn" title="重新提问" onClick={() => ask(t.q)}>↻</button>
                </div>
                <Md text={t.answer} onLink={onOpen} />
                {t.pages.length > 0 && <div className="qa-cites"><span className="muted small">引用</span>{t.pages.map((p, k) => <span key={p.slug} className="qa-cite" onClick={() => onOpen(p.slug)}><b>{k + 1}</b>{p.title}</span>)}</div>}
              </div>
            </div>
          ))}
          {busy && (
            <div className="qa-turn">
              <div className="qa-q"><div className="qa-bubble">{busy}</div></div>
              <div className="qa-a qa-thinking"><span className="qa-avatar">⚗</span> 正在查阅 Wiki 并作答…</div>
            </div>
          )}
        </div>
        <div className="qa-input">
          <textarea className="input" rows={2} value={input} placeholder={thread ? '继续追问（Enter 发送，Shift + Enter 换行）' : '输入问题（Enter 发送，Shift + Enter 换行）'} onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); ask(input); } }} />
          <button className="btn primary" disabled={!input.trim() || !!busy} onClick={() => ask(input)}>{busy ? '…' : thread ? '追问' : '发送'}</button>
        </div>
      </section>
    </div>
  );
}

const LEVELS = [['', '全部'], ['error', '错误'], ['warn', '警告'], ['info', '信息'], ['debug', '调试']];
const LEVEL_TAG = { error: 'danger', warn: 'warn', info: 'ok', debug: '' };
const LOG_MEMO = { level: '' };
function LogPanel({ onOpen }) {
  const [data, setData] = useState({ rows: [], counts: {} });
  const [level, setLevelState] = useState(LOG_MEMO.level);
  const setLevel = (l) => { LOG_MEMO.level = l; setLevelState(l); };
  const load = () => api.wikiLogs({ level }).then(setData).catch(() => {});
  useEffect(() => { load(); }, [level]);
  useEffect(() => on('wiki', (s) => { if (!s.job) load(); }), [level]);
  const total = Object.values(data.counts).reduce((a, b) => a + b, 0);
  const cols = [
    { key: 'at', label: '时间', type: 'date', render: (r) => fmtTime(r.at) },
    { key: 'level', label: '等级', className: 'nowrap', sort: (r) => ['error', 'warn', 'info', 'debug'].indexOf(r.level || 'info'), filterValue: (r) => (LEVELS.find(([k]) => k === (r.level || 'info')) || [])[1], render: (r) => <span className={`tag ${LEVEL_TAG[r.level || 'info']}`}>{(LEVELS.find(([k]) => k === (r.level || 'info')) || [])[1]}</span> },
    { key: 'op', label: '操作', className: 'nowrap', filterValue: (r) => OP_LABEL[r.op] || r.op, render: (r) => OP_LABEL[r.op] || r.op },
    { key: 'title', label: '内容', render: (r) => (r.slug ? <span className="link" onClick={() => onOpen(r.slug)}>{r.title}</span> : r.title) },
    { key: 'detail', label: '详情', className: 'small' },
  ];
  return (
    <div className="wiki-log">
      <div className="wiki-lint-bar">
        <div className="seg">{LEVELS.map(([k, l]) => <button key={k || 'all'} className={level === k ? 'on' : ''} onClick={() => setLevel(k)}>{l}（{k ? data.counts[k] || 0 : total}）</button>)}</div>
        <button className="btn small ghost" onClick={load}>↻ 刷新</button>
      </div>
      <DataTable id="wikiLog" sessionKey={`wikiLog-${level}`} columns={cols} rows={data.rows} rowKey={(r) => r.id} rowClass={(r) => (r.level === 'error' ? 'row-error' : r.level === 'warn' ? 'row-warn' : '')} empty="没有日志" />
    </div>
  );
}

/** 探索（v3.14）：炼丹之后的入口——向 Wiki 提问、推荐问题、知识地图（概念及其相关概念）、分类、最近炼化的资料 */
function ExplorePanel({ onOpen, onAsk, onIngest }) {
  const [d, setD] = useState(null);
  const [q, setQ] = useState('');
  useEffect(() => { api.wikiExplore().then(setD).catch(() => setD({ concepts: [], topics: [], questions: [], recent: [], sources: 0 })); }, []);
  if (!d) return <div className="empty-tip">加载中…</div>;
  if (!d.sources) return <div className="empty-tip"><p>Wiki 还是空的。</p><button className="btn primary" onClick={onIngest}>⚗ 去炼丹</button></div>;
  return (
    <div className="wiki-explore">
      <div className="wx-ask">
        <input className="input grow" value={q} placeholder="向 Wiki 提问" onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && q.trim() && onAsk(q.trim())} />
        <button className="btn primary" disabled={!q.trim()} onClick={() => onAsk(q.trim())}>💬 提问</button>
      </div>
      {d.questions.length > 0 && <div className="wx-qs">{d.questions.map((x) => <span key={x} className="chip drill" onClick={() => onAsk(x)}>💡 {x}</span>)}</div>}
      <div className="wx-grid">
        <section className="wx-sec wx-map">
          <h4>🗺 知识地图 <span className="muted small">（{d.concepts.length} 个主要概念）</span></h4>
          <div className="wx-cards">
            {d.concepts.map((c) => (
              <div key={c.slug} className="wx-card" onClick={() => onOpen(c.slug)}>
                <div className="wx-card-t"><b>{c.title}</b><span className="link small">{c.sources} 份</span></div>
                <div className="muted small">{c.cat}</div>
                {c.related.length > 0 && <div className="wx-rel">{c.related.map((r) => <span key={r.slug} className="link small" onClick={(e) => { e.stopPropagation(); onOpen(r.slug); }}>↔ {r.short}（{r.together}）</span>)}</div>}
              </div>
            ))}
          </div>
        </section>
        <section className="wx-sec">
          <h4>📂 分类</h4>
          {d.topics.map((t) => <div key={t.slug} className="wx-row link" onClick={() => onOpen(t.slug)}>{t.title}<span className="muted small"> {t.sources} 份</span></div>)}
          <h4>🆕 最近炼化</h4>
          {d.recent.map((r) => <div key={r.slug} className="wx-row" onClick={() => onOpen(r.slug)}><span className="link">{r.title}</span><div className="muted small">{r.summary}</div></div>)}
        </section>
      </div>
    </div>
  );
}

function SchemaPanel() {
  const app = useApp();
  const [text, setText] = useState(null);
  const [saved, setSaved] = useState('');
  useEffect(() => { api.wikiSchema().then((t) => { setText(t); setSaved(t); }).catch(() => {}); }, []);
  if (text === null) return <div className="empty-tip">加载中…</div>;
  return (
    <div className="wiki-schema">
      <FilterWords />
      <textarea className="input grow wiki-schema-text" value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
      <div className="row">
        <button className="btn primary" disabled={text === saved} onClick={() => api.wikiSaveSchema(text).then((t) => { setText(t); setSaved(t); app.toast('规则已保存，下次炼丹生效', 'info', { cat: 'LLMWiki' }); })}>💾 保存规则</button>
        <button className="btn ghost" disabled={text === saved} onClick={() => setText(saved)}>撤销修改</button>
        <button className="btn ghost" onClick={() => confirm('恢复默认规则？') && api.wikiSaveSchema('').then((t) => { setText(t); setSaved(t); })}>恢复默认</button>
      </div>
    </div>
  );
}

const STEP_ICON = { start: '⚗', read: '📄', send: '📤', reply: '📥', extract: '🔎', write: '💾', skip: '⏭', fail: '❌', remove: '🗑', compile: '🧱', cancel: '⏹', done: '✅' };
const FEED_MEMO = { follow: true, level: '' };
/** 炼丹过程（v3.16）：实时显示每份文档的每一步——读取、发送给大模型、收到答复 / 离线提取、写入资料页，再到下一份 */
function IngestFeed({ feed, job, onOpen }) {
  const [follow, setFollowS] = useState(FEED_MEMO.follow);
  const [level, setLevelS] = useState(FEED_MEMO.level);
  const [open, setOpen] = useState(() => new Set());
  const ref = React.useRef(null);
  const rows = level ? feed.filter((x) => (level === 'warn' ? x.level === 'warn' || x.level === 'error' : level === 'main' ? x.level !== 'debug' : true)) : feed;
  useEffect(() => { if (follow && ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [feed.length, follow, level]);
  const cur = job && job.current;
  return (
    <div className="wiki-feed">
      <div className="wf-head">
        <b>🧪 炼丹过程</b>
        {job ? <span className="small">{job.cancelling ? '正在中止…' : cur ? `正在处理 ${cur.i}/${job.total}${cur.title ? `：${cur.title}` : ''}` : job.label}</span> : feed.length ? <span className="muted small">上次炼丹的过程</span> : null}
        <div className="spacer" />
        <div className="seg small">{[['', '全部步骤'], ['main', '只看结果'], ['warn', '警告与错误']].map(([k, l]) => <button key={k || 'all'} className={level === k ? 'on' : ''} onClick={() => { FEED_MEMO.level = k; setLevelS(k); }}>{l}</button>)}</div>
        <label className="chk small"><input type="checkbox" checked={follow} onChange={(e) => { FEED_MEMO.follow = e.target.checked; setFollowS(e.target.checked); }} /> 跟随最新</label>
      </div>
      <div className="wf-list" ref={ref}>
        {!rows.length && <div className="empty-tip">点“开始炼丹”后，这里逐步显示每份文档的处理过程</div>}
        {rows.map((x) => (
          <div key={x.seq} className={`wf-row lv-${x.level} k-${x.kind}`}>
            <span className="wf-time">{new Date(x.at).toLocaleTimeString()}</span>
            <span className="wf-ic">{STEP_ICON[x.kind] || '•'}</span>
            <span className="wf-text">
              {x.slug ? <span className="link" onClick={() => onOpen(x.slug)}>{x.text}</span> : x.text}
              {x.detail ? <span className="link small wf-more" onClick={() => setOpen((o) => { const n = new Set(o); if (n.has(x.seq)) n.delete(x.seq); else n.add(x.seq); return n; })}>{open.has(x.seq) ? ' 收起' : ' 详情'}</span> : null}
              {x.detail && open.has(x.seq) && <pre className="wf-detail">{x.detail}</pre>}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** 过滤词（v3.16）：炼丹整理时去掉的无意义词语（“PowerPoint 演示文稿”等），每行一个；自动识别多数文档都有的模板标题 */
function FilterWords() {
  const app = useApp();
  const [info, setInfo] = useState(null);
  const [text, setText] = useState('');
  const load = () => api.wikiFilterInfo().then((i) => { setInfo(i); setText(i.stopPhrases.join('\n')); }).catch(() => {});
  useEffect(() => { load(); }, []);
  if (!info) return null;
  const list = [...new Set(text.split('\n').map((x) => x.trim()).filter(Boolean))];
  const changed = list.join('\n') !== info.stopPhrases.join('\n');
  const save = (patch, msg) => api.wikiSetConfig(patch).then(() => { load(); app.toast(msg, 'info', { cat: 'LLMWiki' }); }).catch((e) => app.toast(e.message, 'error'));
  return (
    <div className="wiki-filter">
      <div className="row"><b>🧹 过滤词</b><span className="muted small">{list.length} 个</span><div className="spacer" />
        <label className="chk small"><input type="checkbox" checked={info.autoBoiler} onChange={(e) => save({ autoBoiler: e.target.checked }, e.target.checked ? '已开启自动识别模板标题' : '已关闭自动识别模板标题')} /> 自动过滤多数文档都有的模板标题（{info.boilerplate.length}）</label>
      </div>
      <textarea className="input" value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
      {info.boilerplate.length > 0 && <div className="boiler">{info.boilerplate.map((b) => <span key={b} className="tag">{b}</span>)}</div>}
      <div className="row">
        <button className="btn primary small" disabled={!changed} onClick={() => save({ stopPhrases: list }, '过滤词已保存：已炼化的资料标记为待重新炼化')}>💾 保存过滤词</button>
        <button className="btn ghost small" disabled={!changed} onClick={() => setText(info.stopPhrases.join('\n'))}>撤销修改</button>
        <button className="btn ghost small" onClick={() => confirm('恢复默认过滤词？') && save({ stopPhrases: info.defaults }, '已恢复默认过滤词')}>恢复默认</button>
      </div>
    </div>
  );
}
