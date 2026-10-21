import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api, on, STATUS_LABEL, fmtSize } from './api';
import { AppCtx } from './ctx';
import TaskView from './components/TaskView';
import TaskMonitor from './components/TaskMonitor';
import LibraryView from './components/LibraryView';
import SearchView from './components/SearchView';
import GroupsView from './components/GroupsView';
import BasketView from './components/BasketView';
import ConvertView from './components/ConvertView';
import GenerateView from './components/GenerateView';
import AnalyticsView from './components/AnalyticsView';
import RecycleView from './components/Recycle';
import SettingsView from './components/SettingsView';
import LogView from './components/LogView';
import SlideWorkspace, { clearSlideCache, loadSlide } from './components/SlideWorkspace';
import SlideViewer, { clearFileCache } from './components/SlideViewer';
import CompareView, { COMPARE_MAX } from './components/CompareView';
import { WatchAskDialog } from './components/WatchSettings';
import { clearRelatedCache } from './components/RelatedRail';

const BASKET_KEY = 'ppta.basket';
const readBasket = () => { try { return JSON.parse(localStorage.getItem(BASKET_KEY) || '[]'); } catch { return []; } };
const readLS = (k, d) => { try { return localStorage.getItem(k) || d; } catch { return d; } };
const base = (p) => String(p || '').split(/[\\/]/).pop();

// 把主进程推送的解析进度事件归并为每个任务的实时状态
function reduceProgress(prev, e) {
  const cur = { feed: [], files: [], ...(prev[e.taskId] || {}) };
  const feed = (line) => { cur.feed = [...cur.feed.slice(-599), line]; };
  const t = new Date(e.at).toLocaleTimeString('zh-CN', { hour12: false });
  switch (e.stage) {
    case 'scanning': cur.stage = 'scanning'; cur.scan = { dirs: e.dirs, found: e.found, current: e.current }; break;
    case 'scanned': cur.total = e.total; cur.files = []; cur.index = 0; feed(`${t} 🔍 扫描完成：共发现 ${e.total} 个文档`); break;
    case 'file': Object.assign(cur, { stage: 'file', index: e.index, total: e.total, file: e.file, slide: 0, slideTotal: 0, slideTitle: '' }); feed(`${t} 📄 [${e.index}/${e.total}] ${base(e.file)}`); break;
    case 'parse': case 'thumb': case 'store': cur.stage = e.stage; if (e.stage === 'thumb') feed(`${t}    🖼 生成页面截图…`); break;
    case 'slide': Object.assign(cur, { stage: 'slide', slide: e.slide, slideTotal: e.slideTotal, slideTitle: e.slideTitle, unit: e.unit });
      cur.scans = [...(cur.scans || []).slice(-80), { seq: (cur.seq = (cur.seq || 0) + 1), file: e.file, index: cur.index, total: cur.total, slide: e.slide, slideTotal: e.slideTotal, title: e.slideTitle, unit: e.unit, kind: e.kind, detail: e.detail }];
      feed(`${t}    第 ${e.slide}/${e.slideTotal} ${e.unit || '页'}：${e.slideTitle || '（无标题）'}`); break;
    case 'parsed': cur.stage = 'parsed'; cur.files = [...cur.files, { file: e.file, kind: e.kind, slides: e.slides, unit: e.unit, dark: e.dark, notes: e.notes, videos: e.videos, ms: e.ms, titles: e.titles, action: 'parsed' }];
      feed(`${t}    ✅ 解析完成：${e.slides} ${e.unit || '页'}，${e.ms}ms`); break;
    case 'result': cur.files = [...cur.files, { file: e.file, action: e.action }]; feed(`${t}    ${e.action === 'failed' ? '❌ 解析失败' : e.action === 'skipped' ? '⏭ 已解析过，跳过' : '♻️ 重复文件，未重复解析'}`); break;
    case 'tag': cur.stage = 'tag'; cur.files = cur.files.map((f) => (f.file === e.file ? { ...f, tags: e.tags, category: e.category } : f));
      cur.tagFeed = [...(cur.tagFeed || []).slice(-60), { seq: (cur.seq = (cur.seq || 0) + 1), file: e.file, tags: e.tags, category: e.category }]; feed(`${t} 🏷 ${base(e.file)}：${e.category} · ${e.tags.slice(0, 10).join('、')}…`); break;
    case 'relate': cur.relate = e; feed(`${t} 🔗 页面关联：${e.pages} 页已打页面标签，${e.linked} 页有相似推荐（相似 PPT 页 ${e.ppt} 条${e.withWord ? `，Word ↔ PPT ${e.word} 条` : ''}）`); break;
    case 'done': cur.stage = 'done'; cur.message = e.message; feed(`${t} 🏁 任务结束：${e.message}`); break;
    default: break;
  }
  return { ...prev, [e.taskId]: cur };
}

export default function App() {
  const [collapsed, setCollapsed] = useState(false);
  const [view, setView] = useState({ type: 'search' });
  const [tasks, setTasks] = useState([]);
  const [liveTasks, setLiveTasks] = useState({});
  const [progress, setProgress] = useState({});
  const [taskTick, setTaskTick] = useState(0);
  const [logLines, setLogLines] = useState([]);
  const [basket, setBasket] = useState(readBasket);
  const [toasts, setToasts] = useState([]);
  const [modal, setModal] = useState(null);
  const [compare, setCompare] = useState(null);
  const [askWatch, setAskWatch] = useState(null);
  const [config, setConfig] = useState(null);
  const [libMode, setLibMode] = useState('overview');
  const [searchState, setSearchState] = useState({});
  const [genState, setGenState] = useState({});
  const [exporting, setExporting] = useState(null);
  const [themeMode, setThemeMode] = useState(() => readLS('ppta.theme', 'system'));
  const [sysTheme, setSysTheme] = useState(() => (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'));
  const [addMenu, setAddMenu] = useState(false);

  const theme = themeMode === 'system' ? sysTheme : themeMode;
  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  const setTheme = (m) => { setThemeMode(m); try { localStorage.setItem('ppta.theme', m); } catch { /* ignore */ } api.setUiTheme(m).then(setConfig).catch(() => {}); };

  const toast = useCallback((msg, kind = 'info', action) => {
    const id = Math.random();
    setToasts((t) => [...t, { id, msg, kind, action }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 8000 : 5000);
  }, []);
  const refreshTasks = useCallback(() => api.tasks().then(setTasks), []);
  const reloadLogs = useCallback(() => api.logTail(5000).then(setLogLines), []);
  const bump = () => { clearSlideCache(); clearFileCache(); clearRelatedCache(); setTaskTick((x) => x + 1); };

  useEffect(() => {
    refreshTasks(); reloadLogs();
    api.getConfig().then((c) => { setConfig(c); if (c.uiTheme && c.uiTheme !== readLS('ppta.theme', '')) { setThemeMode(c.uiTheme); try { localStorage.setItem('ppta.theme', c.uiTheme); } catch { /* ignore */ } } });
    api.systemTheme().then(setSysTheme).catch(() => {});
    const mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;
    const onMq = () => setSysTheme(mq.matches ? 'light' : 'dark');
    if (mq) mq.addEventListener('change', onMq);
    const off0 = on('systemTheme', setSysTheme);
    const off1 = on('task', (t) => {
      setLiveTasks((m) => ({ ...m, [t.id]: t }));
      if (t.status !== 'running' || t.done === undefined || t.done % 5 === 0) refreshTasks();
      if (['done', 'failed', 'cancelled'].includes(t.status) && t.finished_at && !t.quiet) {
        bump();
        const repeat = /增量扫描|补扫/.test(t.message || '') ? 0 : (t.skipped || 0) + (t.duplicate || 0);
        toast(`任务「${t.name}」${STATUS_LABEL[t.status]}：${t.message || ''}${repeat ? `（${repeat} 个文件已解析过，可在“解析任务”中选择是否重新解析）` : ''}`, t.status === 'failed' ? 'error' : 'info');
      }
    });
    const off2 = on('log', (lines) => setLogLines((l) => (l.length > 20000 ? l.slice(-15000) : l).concat(lines)));
    const off3 = on('progress', (e) => setProgress((p) => reduceProgress(p, e)));
    return () => { off0(); off1(); off2(); off3(); if (mq) mq.removeEventListener('change', onMq); };
  }, []);
  useEffect(() => { try { localStorage.setItem(BASKET_KEY, JSON.stringify(basket)); } catch { /* ignore */ } }, [basket]);

  const addDir = async () => {
    setAddMenu(false);
    const dirs = await api.selectDir();
    let last = null;
    for (const d of dirs) {
      try { last = await api.addTask(d); toast(`已添加任务：${d}（点击“开始解析”后执行）`); } catch (e) { toast(e.message, 'error'); }
    }
    if (last) { await refreshTasks(); setView({ type: 'monitor' }); }
  };
  const addAllLocal = async () => {
    setAddMenu(false);
    setAskWatch({ roots: await api.localRoots() });
  };
  // 全盘扫描：询问是否监测更新和新增的文档（每天定时增量扫描）
  const onAskWatch = async (r) => {
    setAskWatch(null);
    if (!r) return;
    try {
      if (r.watch) setConfig(await api.setConfig({ watch: { time: r.time, catchUp: r.catchUp } }));
      await api.addAllLocalTask({ watch: r.watch, time: r.time });
      setConfig(await api.getConfig());
      await refreshTasks(); setView({ type: 'monitor' });
      toast(`已添加“本机全部文档”任务，点击“开始解析”后执行${r.watch ? `；首次解析完成后，每天 ${r.time} 自动增量扫描新增和修改的文档` : ''}`);
    } catch (e) { toast(e.message, 'error'); }
  };

  const exportSlides = async (ids, kind) => {
    if (!ids.length) return;
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-T:]/g, '');
    const out = await api.saveFile(`PPT智能体导出_${stamp}.${kind === 'md' ? 'md' : 'pptx'}`, kind, kind === 'md' ? 'exportMd' : 'export');
    if (!out) return;
    setExporting({ n: ids.length });
    try {
      const r = await api.exportSlides(ids, out, { includeNotes: true });
      toast(`导出完成：${r.slides} 页 → ${out}${r.size ? '（' + fmtSize(r.size) + '）' : ''}${r.skippedWord ? `；${r.skippedWord} 个 Word 章节不能放入 PPT，已跳过（可导出 Markdown）` : ''}`, 'info', { label: '打开', run: () => api.openPath(out) });
    } catch (e) { toast('导出失败：' + e.message, 'error'); } finally { setExporting(null); }
  };

  const basketApi = useMemo(() => ({
    items: basket,
    add: (ids) => { setBasket((b) => { const s = new Set(b); const n = [...b, ...ids.filter((x) => !s.has(x))]; toast(`已加入导出篮：${n.length - b.length} 页（共 ${n.length} 页）`); return n; }); },
    remove: (id) => setBasket((b) => b.filter((x) => x !== id)),
    move: (i, d) => setBasket((b) => { const n = [...b]; const j = i + d; if (j < 0 || j >= n.length) return b; [n[i], n[j]] = [n[j], n[i]]; return n; }),
    clear: () => setBasket([]),
  }), [basket]);

  const openSlide = async (id, fileIds, terms, matched) => {
    const s = await loadSlide(id);
    if (s) setModal({ slideId: id, fileId: s.file_id, fileIds: fileIds && fileIds.length ? fileIds : [s.file_id], terms: terms || [], matched: matched || [] });
  };
  // 对比窗口：2–4 个文档；starts 为 { fileId: 起始页 id }
  const openCompare = (fileIds, starts = {}) => {
    const ids = [...new Set(fileIds)];
    if (ids.length < 2) { toast('请至少选择 2 个文档进行对比', 'error'); return; }
    if (ids.length > COMPARE_MAX) toast(`最多同时对比 ${COMPARE_MAX} 个文档，已打开前 ${COMPARE_MAX} 个`, 'error');
    setModal(null);
    setCompare({ fileIds: ids.slice(0, COMPARE_MAX), starts });
  };
  const ctx = {
    tasks, liveTasks, progress, taskTick, logLines, reloadLogs, refreshTasks, toast, basket: basketApi, config, setConfig, bump, setTheme,
    exportSlides, openSlide, openCompare, modalOpen: !!modal || !!compare, openFile: (id) => setView({ type: 'file', id, back: view }), go: setView, addDir, addAllLocal,
  };

  // 左侧菜单分区：解析任务 → 智能模块 → 功能
  const smartNav = [
    { key: 'generate', icon: '✨', label: '智能生成' },
  ];
  const nav = [
    { key: 'search', icon: '🔍', label: '智能搜索' },
    { key: 'analytics', icon: '📈', label: '总览分析' },
    { key: 'monitor', icon: '⚙️', label: `解析任务${tasks.some((t) => t.status === 'running') ? ' ●' : ''}` },
    { key: 'library', icon: '📚', label: '资料库浏览' },
    { key: 'groups', icon: '🧩', label: '相似分组' },
    { key: 'basket', icon: '🧺', label: `导出篮${basket.length ? `（${basket.length}）` : ''}` },
    { key: 'convert', icon: '🌓', label: 'PPT 黑白底互转' },
    { key: 'recycle', icon: '🗑', label: '回收站' },
    { key: 'logs', icon: '📜', label: '运行日志' },
    { key: 'settings', icon: '🛠', label: '设置' },
  ];
  const themeNext = { system: 'dark', dark: 'light', light: 'system' };
  const themeIcon = { system: '🖥', dark: '🌙', light: '☀️' };

  return (
    <AppCtx.Provider value={ctx}>
      <div className={`app ${collapsed ? 'collapsed' : ''}`}>
        <aside className="sidebar">
          <div className="sb-head">
            {!collapsed && <div className="logo">PPT<span>智能体</span></div>}
            <button className="icon-btn" title={collapsed ? '展开菜单' : '折叠菜单'} onClick={() => setCollapsed(!collapsed)}>{collapsed ? '»' : '«'}</button>
          </div>
          <div className="add-wrap">
            <button className="btn primary add-btn" onClick={addDir} title="添加目录（添加后手动开始解析）">＋{collapsed ? '' : ' 添加目录'}</button>
            {!collapsed && <button className="btn primary add-more" onClick={() => setAddMenu(!addMenu)} title="更多添加方式">▾</button>}
            {addMenu && (
              <div className="add-menu" onMouseLeave={() => setAddMenu(false)}>
                <div onClick={addDir}>📁 添加目录…</div>
                <div onClick={addAllLocal}>🖥 添加所有本地文档（按盘符顺序扫描本机全部 PPT / Word）</div>
              </div>
            )}
          </div>
          <div className="sb-section">{!collapsed && '解析任务'}</div>
          <div className="sb-tasks">
            {!tasks.length && !collapsed && <div className="muted small pad">还没有任务，点击上方按钮添加目录</div>}
            {tasks.map((t) => {
              const live = liveTasks[t.id];
              const pct = t.total ? Math.round(((live && live.done) || (t.parsed + t.skipped + t.duplicate + t.failed)) / t.total * 100) : 0;
              return (
                <div key={t.id} className={`sb-task ${(view.type === 'task' && view.id === t.id) || (view.type === 'monitor' && view.taskId === t.id) ? 'active' : ''}`} onClick={() => setView(['running', 'pending'].includes(t.status) ? { type: 'monitor', tab: 'live', taskId: t.id } : { type: 'task', id: t.id })} title={t.dir}>
                  <span className={`dot s-${t.status}`} />
                  {!collapsed && (
                    <div className="sbt-main">
                      <div className="sbt-name">#{t.id} {t.name}{t.watch ? <span className="watch-dot" title={`已开启定时监测更新（每天 ${(config && config.watch && config.watch.time) || ''}）`}> 📡</span> : null}</div>
                      <div className="sbt-meta"><span className={`status s-${t.status}`}>{STATUS_LABEL[t.status]}</span>{t.status === 'running' ? ` ${pct}%` : t.status === 'pending' ? ` · 第 ${t.queuePos} 位` : t.status === 'draft' ? '' : ` · ${t.parsed} 解析 / ${t.skipped + t.duplicate} 跳过`}</div>
                    </div>
                  )}
                  {!collapsed && ['draft', 'interrupted', 'paused', 'cancelled'].includes(t.status) && (
                    <button className="icon-btn tiny start" title={t.status === 'draft' ? '开始解析' : '继续（从断点）'} onClick={(e) => { e.stopPropagation(); (t.status === 'draft' ? api.startTask(t.id) : api.resumeTask(t.id)).then(refreshTasks); setView({ type: 'monitor', tab: 'live', taskId: t.id }); }}>▶</button>
                  )}
                  {!collapsed && t.status === 'running' && (
                    <button className="icon-btn tiny pause" title="中断（可继续）" onClick={(e) => { e.stopPropagation(); api.pauseTask(t.id).then(refreshTasks); }}>⏸</button>
                  )}
                  {!collapsed && !['running', 'pending'].includes(t.status) && (
                    <button className="icon-btn tiny" title="删除任务（解析历史保留）" onClick={async (e) => {
                      e.stopPropagation();
                      if (!confirm(`删除任务 #${t.id}「${t.name}」？\n\n该任务解析的文件会从资料库移除，解析历史记录会保留。`)) return;
                      await api.deleteTask(t.id, true); refreshTasks(); bump(); if (view.id === t.id) setView({ type: 'search' });
                    }}>✕</button>
                  )}
                </div>
              );
            })}
          </div>
          <div className="sb-section">{!collapsed && '功能'}</div>
          {nav.map((n) => (
            <React.Fragment key={n.key}>
              <div className={`sb-item ${view.type === n.key ? 'active' : ''}`} onClick={() => setView({ type: n.key })} title={n.label}>
                <span className="ic">{n.icon}</span>{!collapsed && <span>{n.label}</span>}
              </div>
              {n.key === 'monitor' && view.type === 'monitor' && (
                <div className={`sb-sub ${collapsed ? 'mini' : ''}`}>
                  {[['queue', '📋', '任务队列'], ['live', '📡', '解析动态（实时）'], ['history', '🕘', '解析历史']].map(([k, ic, v]) => <div key={k} title={v} className={`sb-subitem ${(view.tab || 'queue') === k ? 'active' : ''}`} onClick={() => setView({ ...view, tab: k })}>{collapsed ? ic : v}</div>)}
                </div>
              )}
            </React.Fragment>
          ))}
          <div className="sb-section">{!collapsed ? '智能模块（建设中）' : '智能'}</div>
          {smartNav.map((n) => (
            <div key={n.key} className={`sb-item ${view.type === n.key ? 'active' : ''}`} onClick={() => setView({ type: n.key })} title={n.label}>
              <span className="ic">{n.icon}</span>{!collapsed && <span>{n.label} <span className="wip">建设中</span></span>}
            </div>
          ))}
          <div className="spacer" />
          <div className="sb-theme" title="切换主题：黑 / 白 / 跟随系统" onClick={() => setTheme(themeNext[themeMode])}>
            <span className="ic">{themeIcon[themeMode]}</span>{!collapsed && <span>主题：{{ system: '跟随系统', dark: '黑色', light: '白色' }[themeMode]}</span>}
          </div>
        </aside>
        <main className="main">
          {view.type === 'task' && <TaskView taskId={view.id} />}
          {view.type === 'monitor' && <TaskMonitor tab={view.tab || 'queue'} taskId={view.taskId} setTab={(tab, taskId) => setView({ type: 'monitor', tab, taskId: taskId || view.taskId })} />}
          {view.type === 'library' && <LibraryView mode={libMode} setMode={setLibMode} />}
          {view.type === 'search' && <SearchView state={searchState} setState={setSearchState} />}
          {view.type === 'groups' && <GroupsView />}
          {view.type === 'basket' && <BasketView />}
          {view.type === 'convert' && <ConvertView />}
          {view.type === 'analytics' && <AnalyticsView />}
          {view.type === 'recycle' && <RecycleView />}
          {view.type === 'generate' && <GenerateView state={genState} setState={setGenState} />}
          {view.type === 'settings' && <SettingsView focus={view.focus} />}
          {view.type === 'logs' && <div className="view"><div className="view-head"><div className="vh-title">📜 运行日志 <span className="muted small">工具只保留一份日志文件，记录全部工作过程</span></div></div><div className="tab-body"><LogView /></div></div>}
          {view.type === 'file' && <FileView id={view.id} onBack={() => setView(view.back || { type: 'search' })} />}
        </main>
        {modal && (
          <div className="overlay" onClick={() => setModal(null)}>
            <div className="modal viewer-modal" onClick={(e) => e.stopPropagation()}>
              <SlideViewer fileIds={modal.fileIds} initialFileId={modal.fileId} initialSlideId={modal.slideId} terms={modal.terms} matched={modal.matched} onClose={() => setModal(null)} />
            </div>
          </div>
        )}
        {compare && (
          <div className="overlay" onClick={() => setCompare(null)}>
            <div className="modal compare-modal" onClick={(e) => e.stopPropagation()}>
              <CompareView fileIds={compare.fileIds} starts={compare.starts} onClose={() => setCompare(null)} />
            </div>
          </div>
        )}
        {askWatch && <WatchAskDialog roots={askWatch.roots} onClose={onAskWatch} />}
        {exporting && <div className="overlay"><div className="spinner-box">正在导出 {exporting.n} 页，请稍候…</div></div>}
        <div className="toasts">{toasts.map((t) => <div key={t.id} className={`toast ${t.kind}`}>{t.msg}{t.action && <button className="btn tiny" onClick={t.action.run}>{t.action.label}</button>}</div>)}</div>
      </div>
    </AppCtx.Provider>
  );
}

function FileView({ id, onBack }) {
  const [file, setFile] = useState(null);
  useEffect(() => { api.fileDetail(id).then((d) => setFile(d && d.file)); }, [id]);
  return (
    <div className="view">
      <div className="view-head"><button className="btn" onClick={onBack}>← 返回</button><div className="vh-title">{file ? file.name : ''}</div><div className="muted small">{file && file.path}</div></div>
      <div className="tab-body">{file && <SlideWorkspace files={[file]} initialFileId={file.id} />}</div>
    </div>
  );
}
