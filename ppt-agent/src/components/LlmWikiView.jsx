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
          {st.job ? <button className="btn" onClick={() => api.wikiCancel()}>⏹ 中止</button>
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

function AskPanel({ onOpen }) {
  const app = useApp();
  const [q, setQ] = useState(MEMO.q);
  const [res, setRes] = useState(MEMO.ask);
  const [busy, setBusy] = useState(false);
  const [hist, setHist] = useState([]);
  const [sel, setSel] = useState(() => new Set());
  const loadHist = () => api.wikiQueries().then(setHist).catch(() => {});
  useEffect(() => { loadHist(); if (MEMO.autoAsk) { const x = MEMO.autoAsk; MEMO.autoAsk = null; ask(x); } }, []);
  const ask = async (text) => {
    const qq = String(text || q).trim();
    if (!qq) return;
    setBusy(true); MEMO.q = qq; setQ(qq);
    try { const r = await api.wikiQuery(qq); MEMO.ask = r; setRes(r); loadHist(); } catch (e) { app.toast(e.message, 'error', { cat: 'LLMWiki' }); } finally { setBusy(false); }
  };
  const save = async (id) => { try { const s = await api.wikiSaveQuery(id); app.toast('已存为 Wiki 页面', 'info', { cat: 'LLMWiki' }); loadHist(); if (res && res.id === id) { const r = { ...res, slug: s }; MEMO.ask = r; setRes(r); } } catch (e) { app.toast(e.message, 'error'); } };
  const cols = [
    { key: 'q', label: '问题', render: (r) => <span className="link" onClick={() => { const x = { ...r }; MEMO.ask = x; MEMO.q = r.q; setRes(x); setQ(r.q); }}>{r.q}</span> },
    { key: 'pages', label: '引用页面', type: 'number', sort: (r) => r.pages.length, render: (r) => r.pages.length },
    { key: 'engine', label: '方式', filterValue: (r) => r.engine },
    { key: 'slug', label: '已存为页面', sort: (r) => (r.slug ? 1 : 0), filterValue: (r) => (r.slug ? '是' : '否'), render: (r) => (r.slug ? <span className="link" onClick={() => onOpen(r.slug)}>查看</span> : <button className="btn tiny" onClick={() => save(r.id)}>存为页面</button>) },
    { key: 'at', label: '时间', type: 'date', render: (r) => fmtTime(r.at) },
  ];
  return (
    <div className="wiki-ask">
      <div className="wiki-ask-bar">
        <input className="input grow" value={q} placeholder="向 Wiki 提问" onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && ask()} />
        <button className="btn primary" disabled={busy || !q.trim()} onClick={() => ask()}>{busy ? '思考中…' : '💬 提问'}</button>
      </div>
      {res && (
        <div className="wiki-answer">
          <div className="wiki-answer-head"><b>{res.q}</b><span className="tag">{res.engine}</span><div className="spacer" />{res.slug ? <button className="btn small ghost" onClick={() => onOpen(res.slug)}>📖 查看页面</button> : <button className="btn small" onClick={() => save(res.id)}>💾 存为 Wiki 页面</button>}</div>
          <Md text={res.answer} onLink={onOpen} />
          {res.pages.length > 0 && <div className="wiki-back"><h4>引用页面</h4>{res.pages.map((p) => <span key={p.slug} className="link wiki-link" onClick={() => onOpen(p.slug)}>{p.title}</span>)}</div>}
        </div>
      )}
      <DataTable id="wikiQueries" columns={cols} rows={hist} rowKey={(r) => r.id} selectable selected={sel} onSelect={setSel}
        actions={<button className="btn small" disabled={!sel.size} onClick={() => confirm(`删除所选的 ${sel.size} 条问答？已存为页面的会同时删除页面。`) && api.wikiDeleteQueries([...sel]).then(() => { setSel(new Set()); loadHist(); })}>🗑 删除所选</button>} />
    </div>
  );
}

function LintPanel({ onOpen, busy }) {
  const app = useApp();
  const [r, setR] = useState(MEMO.lint);
  const [running, setRunning] = useState(false);
  const run = async () => { setRunning(true); try { const x = await api.wikiLint(); MEMO.lint = x; setR(x); } catch (e) { app.toast(e.message, 'error'); } finally { setRunning(false); } };
  useEffect(() => { if (!r) run(); }, []);
  const fix = async (kind) => {
    setRunning(true);
    try { const x = await api.wikiFix([kind]); MEMO.lint = x.lint; setR(x.lint); app.toast(`已修复：${LINT_LABEL[kind]}`, 'info', { cat: 'LLMWiki' }); } catch (e) { app.toast(e.message, 'error'); } finally { setRunning(false); }
  };
  const cols = [
    { key: 'kind', label: '问题', className: 'nowrap', sort: (i) => i.kind, filterValue: (i) => LINT_LABEL[i.kind], render: (i) => <span className={`tag ${i.level === 'warn' ? 'warn' : ''}`}>{LINT_LABEL[i.kind]}</span> },
    { key: 'title', label: '页面', render: (i) => (i.slug ? <span className="link" onClick={() => onOpen(i.slug)}>{i.title}</span> : i.title) },
    { key: 'detail', label: '说明' },
    { key: 'ops', label: '操作', nosort: true, nofilter: true, className: 'nowrap', render: (i) => (i.path ? <button className="btn tiny ghost" title="在资源管理器中显示" onClick={() => api.showItem(i.path)}>📂</button> : null) },
  ];
  const sum = (r && r.summary) || {};
  return (
    <div className="wiki-lint">
      <div className="wiki-lint-bar">
        <button className="btn" disabled={running || busy} onClick={run}>{running ? '检查中…' : '🩺 重新体检'}</button>
        {Object.keys(FIXABLE).filter((k) => sum[k]).map((k) => <button key={k} className="btn small" disabled={running || busy} onClick={() => fix(k)}>🔧 {FIXABLE[k]}：{LINT_LABEL[k]}（{sum[k]}）</button>)}
        <div className="spacer" />
        {r && <span className="muted small">体检于 {fmtTime(r.at)}</span>}
      </div>
      <DataTable id="wikiLint" columns={cols} rows={(r && r.issues) || []} rowKey={(i) => `${i.kind}-${i.slug}-${i.file_id || ''}`} empty={r ? '没有发现问题' : '检查中…'} />
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
      <textarea className="input grow wiki-schema-text" value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
      <div className="row">
        <button className="btn primary" disabled={text === saved} onClick={() => api.wikiSaveSchema(text).then((t) => { setText(t); setSaved(t); app.toast('规则已保存，下次炼丹生效', 'info', { cat: 'LLMWiki' }); })}>💾 保存规则</button>
        <button className="btn ghost" disabled={text === saved} onClick={() => setText(saved)}>撤销修改</button>
        <button className="btn ghost" onClick={() => confirm('恢复默认规则？') && api.wikiSaveSchema('').then((t) => { setText(t); setSaved(t); })}>恢复默认</button>
      </div>
    </div>
  );
}
