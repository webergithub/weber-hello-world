import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, on, STATUS_LABEL, fmtSize } from './api';
import { AppCtx } from './ctx';
import TaskView from './components/TaskView';
import TaskMonitor from './components/TaskMonitor';
import DrillDialog from './components/DrillDialog';
import LibraryView from './components/LibraryView';
import SearchView from './components/SearchView';
import { searchQueue } from './searchQueue';
import NoticesView from './components/NoticesView';
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
import { Tour, WelcomeDialog, HelpView } from './components/Guide';
import PageHelp from './components/PageHelp';

const NOTICE_KEY = 'ppta.notices';
const NOTICE_CATS = [[/任务|解析|扫描/, '解析任务'], [/搜索|检索/, '智能搜索'], [/导出/, '导出'], [/转换|黑底|白底/, '黑白底互转'], [/回收站|删除|还原/, '回收站'], [/设置|快捷键|主题|接口/, '设置']];
const noticeCat = (msg) => (NOTICE_CATS.find(([re]) => re.test(msg)) || [null, '其他'])[1];
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
      cur.scans = [...(cur.scans || []).slice(-200), { seq: (cur.seq = (cur.seq || 0) + 1), file: e.file, index: cur.index, total: cur.total, slide: e.slide, slideTotal: e.slideTotal, title: e.slideTitle, unit: e.unit, kind: e.kind, detail: e.detail }];
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
  const [collapsed, setCollapsedState] = useState(() => readLS('ppta.sbCollapsed', '0') === '1');
  const setCollapsed = (v) => { setCollapsedState(v); try { localStorage.setItem('ppta.sbCollapsed', v ? '1' : '0'); } catch { /* ignore */ } };
  // 侧栏分区（解析任务 / 功能 / 智能模块）可单独折叠，状态记忆
  const [folded, setFolded] = useState(() => { try { return JSON.parse(readLS('ppta.sbFolded', '{}')); } catch { return {}; } });
  const fold = (k) => setFolded((f) => { const n = { ...f, [k]: !f[k] }; try { localStorage.setItem('ppta.sbFolded', JSON.stringify(n)); } catch { /* ignore */ } return n; });
  const secHead = (k, label, short) => (
    <div className={`sb-section fold ${folded[k] ? 'folded' : ''}`} onClick={() => fold(k)} title={folded[k] ? '展开' : '折叠'}>
      {collapsed ? (folded[k] ? '▸' : short || '▾') : <><span className="caret">{folded[k] ? '▸' : '▾'}</span>{label}</>}
    </div>
  );
  const [view, setViewState] = useState({ type: 'search' });
  const [subOpen, setSubOpen] = useState({});
  const [taskMenu, setTaskMenu] = useState(true); // 选中任务下方的“任务详情”菜单是否展开
  const [version, setVersion] = useState('');
  useEffect(() => { api.appVersion().then(setVersion).catch(() => {}); }, []);
  // 当前选择的解析任务：“任务详情”模块下的菜单只显示该任务的内容
  const [curTask, setCurTaskState] = useState(() => Number(readLS('ppta.curTask', '0')) || null);
  const setCurTask = (id) => { setCurTaskState(id); try { localStorage.setItem('ppta.curTask', String(id || '')); } catch { /* ignore */ } };
  // 兼容旧的跳转写法：{ type: 'monitor', taskId } 表示某个任务的解析过程
  const setView = (v) => {
    if (v && v.type === 'monitor' && v.taskId) { setCurTask(v.taskId); setViewState({ type: 'tmonitor', tab: v.tab === 'history' ? 'history' : 'live' }); return; }
    if (v && v.type === 'task' && v.id) { setCurTask(v.id); setViewState({ type: 'task' }); return; }
    if (v && v.type === 'library') { setViewState({ type: 'alllib' }); return; }
    setViewState(v);
  };
  const [tasks, setTasks] = useState([]);
  const [liveTasks, setLiveTasks] = useState({});
  const [progress, setProgress] = useState({});
  const [taskTick, setTaskTick] = useState(0);
  const [logLines, setLogLines] = useState([]);
  const [basket, setBasket] = useState(readBasket);
  const [toasts, setToasts] = useState([]);
  const [modal, setModal] = useState(null);
  const [drill, setDrill] = useState(null); // 统计数字下钻清单
  const [compare, setCompare] = useState(null);
  const [askWatch, setAskWatch] = useState(null);
  const [welcome, setWelcome] = useState(false);
  const [tour, setTour] = useState(false);
  const [config, setConfig] = useState(null);
  const [allLibMode, setAllLibMode] = useState('overview');
  const [searchState, setSearchState] = useState({});
  const [genState, setGenState] = useState({});
  const [exporting, setExporting] = useState(null);
  const [themeMode, setThemeMode] = useState(() => readLS('ppta.theme', 'system'));
  const [sysTheme, setSysTheme] = useState(() => (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'));
  const [addMenu, setAddMenu] = useState(false);

  const theme = themeMode === 'system' ? sysTheme : themeMode;
  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  const setTheme = (m) => { setThemeMode(m); try { localStorage.setItem('ppta.theme', m); } catch { /* ignore */ } api.setUiTheme(m).then(setConfig).catch(() => {}); };

  // 通知：每条提示都记入“维护 → 通知管理”（本机保存最近 500 条）；action.link 为可序列化的跳转目标，点击通知可再次跳转
  const [notices, setNotices] = useState(() => { try { return JSON.parse(localStorage.getItem(NOTICE_KEY) || '[]'); } catch { return []; } });
  useEffect(() => { try { localStorage.setItem(NOTICE_KEY, JSON.stringify(notices.slice(0, 500))); } catch { /* ignore */ } }, [notices]);
  const linkRef = useRef(null);
  const toast = useCallback((msg, kind = 'info', action) => {
    const id = Math.random();
    const link = (action && action.link) || null;
    const run = action && (action.run || (link ? () => linkRef.current && linkRef.current(link) : null));
    setToasts((t) => [...t, { id, msg, kind, action: run ? { label: action.label || '查看', run } : null }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 8000 : 5000);
    setNotices((n) => [{ id: `${Date.now()}-${Math.round(id * 1e6)}`, at: Date.now(), msg, kind, link, label: action && action.label, cat: (action && action.cat) || noticeCat(msg), read: false }, ...n].slice(0, 500));
  }, []);
  const refreshTasks = useCallback(() => api.tasks().then(setTasks), []);
  useEffect(() => { if (tasks.length && !tasks.some((t) => t.id === curTask)) setCurTask(tasks[0].id); if (!tasks.length && curTask) setCurTask(null); }, [tasks]);
  const reloadLogs = useCallback(() => api.logTail(5000).then(setLogLines), []);
  const bump = () => { clearSlideCache(); clearFileCache(); clearRelatedCache(); setTaskTick((x) => x + 1); };

  useEffect(() => {
    refreshTasks(); reloadLogs();
    api.getConfig().then((c) => { setConfig(c); if (c.welcome !== 'never') setWelcome(true); if (c.uiTheme && c.uiTheme !== readLS('ppta.theme', '')) { setThemeMode(c.uiTheme); try { localStorage.setItem('ppta.theme', c.uiTheme); } catch { /* ignore */ } } });
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
        toast(`任务「${t.name}」${STATUS_LABEL[t.status]}：${t.message || ''}${repeat ? `（${repeat} 个文件已解析过，可在“解析任务”中选择是否重新解析）` : ''}`, t.status === 'failed' ? 'error' : 'info', { label: '查看任务', link: { type: 'task', id: t.id }, cat: '解析任务' });
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
      try { last = await api.addTask(d); toast(`已添加任务：${d}（点击“开始解析”后执行）`, 'info', { label: '查看任务', link: { type: 'task', id: last }, cat: '解析任务' }); } catch (e) { toast(e.message, 'error'); }
    }
    if (last) { await refreshTasks(); setCurTask(last); setViewState({ type: 'task' }); }
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
      const nid = await api.addAllLocalTask({ watch: r.watch, time: r.time });
      setConfig(await api.getConfig());
      await refreshTasks(); setCurTask(nid); setViewState({ type: 'task' });
      toast(`已添加“本机全部文档”任务，点击“开始解析”后执行${r.watch ? `；首次解析完成后，每天 ${r.time} 自动增量扫描新增和修改的文档` : ''}`, 'info', { label: '查看任务', link: { type: 'task', id: nid }, cat: '解析任务' });
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
      toast(`导出完成：${r.slides} 页 → ${out}${r.size ? '（' + fmtSize(r.size) + '）' : ''}${r.skippedWord ? `；${r.skippedWord} 个 Word 章节不能放入 PPT，已跳过（可导出 Markdown）` : ''}`, 'info', { label: '打开', link: { type: 'open', path: out }, cat: '导出' });
    } catch (e) { toast('导出失败：' + e.message, 'error'); } finally { setExporting(null); }
  };

  const basketApi = useMemo(() => ({
    items: basket,
    add: (ids) => { setBasket((b) => { const s = new Set(b); const n = [...b, ...ids.filter((x) => !s.has(x))]; toast(`已加入导出篮：${n.length - b.length} 页（共 ${n.length} 页）`); return n; }); },
    remove: (id) => setBasket((b) => b.filter((x) => x !== id)),
    move: (i, d) => setBasket((b) => { const n = [...b]; const j = i + d; if (j < 0 || j >= n.length) return b; [n[i], n[j]] = [n[j], n[i]]; return n; }),
    clear: () => setBasket([]),
  }), [basket]);

  // results：从搜索结果打开时的结果页面顺序（左右键在搜索结果之间翻页）
  const openSlide = async (id, fileIds, terms, matched, results, opts = {}) => {
    const s = await loadSlide(id);
    if (s) setModal({ slideId: id, fileId: s.file_id, fileIds: fileIds && fileIds.length ? fileIds : [s.file_id], terms: terms || [], matched: matched || [], results: results || null, max: !!opts.max });
  };
  // 搜索队列中的搜索完成：提示并可直接查看结果
  useEffect(() => {
    searchQueue.setOnDone((it) => toast(`搜索完成：「${it.q}」文件 ${it.files} · 页面 ${it.light + it.dark + it.word}`, 'info', { label: '查看结果', link: { type: 'search', historyId: it.historyId, q: it.q }, cat: '智能搜索' }));
    return () => searchQueue.setOnDone(null);
  }, [toast]);
  // 通知跳转目标
  const openLink = (link) => {
    if (!link) return;
    if (link.type === 'task') { setCurTask(link.id); setViewState({ type: 'task' }); }
    else if (link.type === 'tmonitor') { setCurTask(link.id); setViewState({ type: 'tmonitor', tab: link.tab || 'live' }); }
    else if (link.type === 'search') api.searchHistoryResult(link.historyId).then((r) => { setViewState({ type: 'search' }); setSearchState({ q: link.q || r.analysis.raw, result: r, tab: r.slides.light.length ? 'light' : r.slides.dark.length ? 'dark' : 'word' }); }).catch((e) => toast(e.message, 'error'));
    else if (link.type === 'open') api.openPath(link.path).catch((e) => toast(e.message, 'error'));
    else if (link.type === 'reveal') api.showItem(link.path);
    else if (link.type === 'view') setViewState(link.view);
  };
  linkRef.current = openLink;
  // 开始 / 继续解析后自动跳转到该任务的“解析动态”
  const startParse = async (id, how = 'start') => {
    try {
      const r = await (how === 'resume' ? api.resumeTask(id) : how === 'watch' ? api.runWatch([id]) : api.startTask(id));
      refreshTasks();
      setCurTask(id); setModal(null); setDrill(null); setCompare(null);
      setViewState({ type: 'tmonitor', tab: 'live' });
      return r;
    } catch (e) { toast(e.message, 'error'); return null; }
  };
  // 双击任何 PPT 原版页面（缩略图 / 原始页）直接进入逐页浏览；浏览 / 对比窗口内的双击保留为最大化
  const openRef = useRef(openSlide);
  openRef.current = openSlide;
  useEffect(() => {
    const dbl = (e) => {
      const el = e.target.closest && e.target.closest('[data-sid]');
      if (!el || !el.dataset.sid || e.target.closest('.viewer, .compare, [data-noopen], input, textarea, button, [contenteditable="true"]')) return;
      const scope = el.closest('[data-open-files]');
      const fileIds = scope ? scope.dataset.openFiles.split(',').map(Number).filter(Boolean) : undefined;
      e.preventDefault();
      openRef.current(Number(el.dataset.sid), fileIds);
    };
    document.addEventListener('dblclick', dbl);
    return () => document.removeEventListener('dblclick', dbl);
  }, []);
  // 对比窗口：2–4 个文档；starts 为 { fileId: 起始页 id }
  const openCompare = (fileIds, starts = {}) => {
    const ids = [...new Set(fileIds)];
    if (ids.length < 2) { toast('请至少选择 2 个文档进行对比', 'error'); return; }
    if (ids.length > COMPARE_MAX) toast(`最多同时对比 ${COMPARE_MAX} 个文档，已打开前 ${COMPARE_MAX} 个`, 'error');
    setModal(null);
    setCompare({ fileIds: ids.slice(0, COMPARE_MAX), starts });
  };
  // 帮助按钮：第一次点击打开帮助指南，再次点击收起并回到智能搜索
  const toggleHelp = () => setViewState(view.type === 'help' ? { type: 'search' } : { type: 'help' });
  const startTour = () => { setModal(null); setCompare(null); setWelcome(false); setTour(true); };
  const onWelcomeClose = async ({ again, next }) => {
    setWelcome(false);
    try { setConfig(await api.setConfig({ welcome: again ? 'always' : 'never' })); } catch { /* ignore */ }
    if (next === 'tour') startTour();
    else if (next === 'help') setView({ type: 'help' });
  };
  const ctx = {
    tasks, liveTasks, progress, taskTick, logLines, reloadLogs, refreshTasks, toast, basket: basketApi, config, setConfig, bump, setTheme,
    exportSlides, openSlide, openCompare, startParse, notices, setNotices, openLink, modalOpen: !!modal || !!compare, openFile: (id) => { setView({ type: 'file', id, back: view, backDrill: drill }); setDrill(null); }, go: setView, drill: setDrill, addDir, addAllLocal,
  };

  const cur = tasks.find((t) => t.id === curTask) || null;
  const SCOPED = ['task', 'tmonitor'];
  // 左侧菜单：解析任务（选择任务）→ 任务详情（只显示所选任务）→ 总览分析（全部历史）→ 智能模块 → 维护 → 底部工具
  const taskNav = [
    { key: 'task', icon: '📁', label: '任务概览' },
    { key: 'tmonitor', icon: '⚙️', label: '解析过程', sub: [['live', '解析动态'], ['history', '解析历史']] },
  ];
  const overNav = [
    { key: 'search', icon: '🔍', label: '智能搜索' },
    { key: 'analytics', icon: '📈', label: '总览分析' },
    { key: 'alllib', icon: '🗂', label: '所有资料库' },
    { key: 'monitor', icon: '🕘', label: `全部任务与历史${tasks.some((t) => t.status === 'running') ? ' ●' : ''}`, sub: [['queue', '任务队列'], ['live', '解析动态'], ['history', '解析历史']] },
    { key: 'groups', icon: '🧩', label: '相似分组' },
  ];
  const maintNav = [
    { key: 'recycle', icon: '🗑', label: '回收站' },
    { key: 'logs', icon: '📜', label: '运行日志' },
    { key: 'notices', icon: '🔔', label: '通知管理', badge: notices.filter((n) => !n.read).length || '' },
  ];
  const smartNav = [
    { key: 'basket', icon: '🧺', label: '导出篮', badge: basket.length || '' },
    { key: 'convert', icon: '🌓', label: 'PPT 黑白底互转' },
    { key: 'generate', icon: '✨', label: '智能生成', wip: true },
  ];
  // 点击任务：选中并在任务下方展开“任务详情”菜单（任务概览 / 解析过程）；再次点击已选中的任务收起菜单
  const selectTask = (t) => {
    if (t.id === curTask && SCOPED.includes(view.type)) { setTaskMenu((v) => !v); return; }
    setCurTask(t.id); setTaskMenu(true);
    if (['running', 'pending'].includes(t.status)) setViewState({ type: 'tmonitor', tab: 'live' });
    else if (!SCOPED.includes(view.type)) setViewState({ type: 'task' });
  };
  // 有子菜单的菜单项：首次点击打开并展开子菜单，再次点击折叠 / 展开子菜单
  const clickNav = (n) => {
    if (n.sub && view.type === n.key) { setSubOpen((m) => ({ ...m, [n.key]: m[n.key] === false })); return; }
    if (n.sub) setSubOpen((m) => ({ ...m, [n.key]: true }));
    setViewState({ type: n.key, tab: n.sub ? n.sub[0][0] : undefined });
  };
  const navItem = (n, { disabled = false } = {}) => (
    <React.Fragment key={n.key}>
      <div className={`sb-item ${view.type === n.key ? 'active' : ''} ${disabled ? 'disabled' : ''}`} data-tour={`nav-${n.key}`} title={n.label}
        onClick={() => !disabled && clickNav(n)}>
        <span className="ic">{n.icon}</span>{!collapsed && <span className="lbl">{n.label}{n.wip && <span className="wip">建设中</span>}</span>}
        {n.badge ? <span className="sb-badge">{n.badge}</span> : null}
        {n.sub && !collapsed && <span className="sb-caret">{view.type === n.key && subOpen[n.key] !== false ? '▾' : '▸'}</span>}
      </div>
      {n.sub && view.type === n.key && subOpen[n.key] !== false && !collapsed && (
        <div className="sb-sub">
          {n.sub.map(([k, v]) => <div key={k} className={`sb-subitem ${(view.tab || n.sub[0][0]) === k ? 'active' : ''}`} onClick={() => setViewState({ type: n.key, tab: k })}>{v}</div>)}
        </div>
      )}
    </React.Fragment>
  );

  return (
    <AppCtx.Provider value={ctx}>
      <div className={`app ${collapsed ? 'collapsed' : ''}`}>
        <aside className="sidebar">
          <div className="sb-head">
            {!collapsed && <div className="logo" title={version ? `PPT智能体 v${version}` : ''}>PPT<span>智能体</span>{version && <sup className="sb-ver">v{version}</sup>}</div>}
            {!collapsed && <button className={`sb-helpbtn ${view.type === 'help' ? 'active' : ''}`} data-tour="help" title={view.type === 'help' ? '收起帮助指南，回到智能搜索' : '帮助指南：功能详解、快捷键、新手指引'} onClick={toggleHelp}>{view.type === 'help' ? '✕ 收起帮助' : '❓ 帮助'}</button>}
            <div className="spacer" />
            <button className="icon-btn" title={collapsed ? '展开菜单' : '折叠菜单'} onClick={() => setCollapsed(!collapsed)}>{collapsed ? '»' : '«'}</button>
          </div>
          <div className="add-wrap" data-tour="add">
            <button className="btn primary add-btn" onClick={addDir} title="添加目录（添加后手动开始解析）">＋{collapsed ? '' : ' 添加目录'}</button>
            {!collapsed && <button className="btn primary add-more" onClick={() => setAddMenu(!addMenu)} title="更多添加方式">▾</button>}
            {addMenu && (
              <div className="add-menu" onMouseLeave={() => setAddMenu(false)}>
                <div onClick={addDir}>📁 添加目录…</div>
                <div onClick={addAllLocal}>🖥 添加所有本地文档（按盘符顺序扫描本机全部 PPT / Word）</div>
              </div>
            )}
          </div>
          {/* 解析任务（蓝）：任务列表，选中任务的下方挂载“任务详情”菜单（任务概览 / 解析过程） */}
          <div className={`sb-mod m-detail ${folded.tasks ? 'is-folded' : ''}`}>
          {secHead('tasks', <>📂 解析任务{tasks.length ? <span className="sb-count">{tasks.length}</span> : null}</>, '📂')}
          {!folded.tasks && <div className="sb-tasks" data-tour="tasks">
            {!tasks.length && !collapsed && <div className="sb-empty">还没有任务，点击上方“添加目录”</div>}
            {tasks.map((t) => {
              const live = liveTasks[t.id];
              const pct = t.total ? Math.round(((live && live.done) || (t.parsed + t.skipped + t.duplicate + t.failed)) / t.total * 100) : 0;
              const on = t.id === curTask;
              return (
                <React.Fragment key={t.id}>
                <div className={`sb-task ${on ? 'active' : ''} ${on && taskMenu ? 'open' : ''}`} onClick={() => selectTask(t)} title={t.dir}>
                  <span className={`dot s-${t.status}`} />
                  {!collapsed && (
                    <div className="sbt-main">
                      <div className="sbt-name">{t.name}{t.watch ? <span className="watch-dot" title={`已开启定时监测更新（每天 ${(config && config.watch && config.watch.time) || ''}）`}> 📡</span> : null}</div>
                      <div className="sbt-meta"><span className={`status s-${t.status}`}>{STATUS_LABEL[t.status]}</span>{t.status === 'running' ? ` ${pct}%` : t.status === 'pending' ? ` · 第 ${t.queuePos} 位` : t.status === 'draft' ? '' : ` · ${t.parsed} 解析`}</div>
                      {t.status === 'running' && <div className="sbt-bar"><div style={{ width: `${pct}%` }} /></div>}
                    </div>
                  )}
                  {!collapsed && <div className="sbt-ops">
                    {['draft', 'interrupted', 'paused', 'cancelled'].includes(t.status) && (
                      <button className="icon-btn tiny start" title={t.status === 'draft' ? '开始解析' : '继续（从断点）'} onClick={(e) => { e.stopPropagation(); startParse(t.id, t.status === 'draft' ? 'start' : 'resume'); }}>▶</button>
                    )}
                    {t.status === 'running' && (
                      <button className="icon-btn tiny pause" title="暂停（可从断点继续）" onClick={(e) => { e.stopPropagation(); api.pauseTask(t.id).then(refreshTasks); }}>⏸</button>
                    )}
                    {!['running', 'pending'].includes(t.status) && (
                      <button className="icon-btn tiny del" title="删除任务（解析历史保留）" onClick={async (e) => {
                        e.stopPropagation();
                        if (!confirm(`删除任务 #${t.id}「${t.name}」？\n\n该任务解析的文件会从资料库移除，解析历史记录会保留。`)) return;
                        await api.deleteTask(t.id, true); refreshTasks(); bump();
                      }}>✕</button>
                    )}
                  </div>}
                  {!collapsed && <span className="sbt-caret" title={on && taskMenu ? '收起任务详情菜单' : '展开任务详情菜单'}>{on && taskMenu ? '▾' : '▸'}</span>}
                </div>
                {on && taskMenu && <div className="sb-group sb-task-menu" data-tour="task-menu">{taskNav.map((n) => navItem(n))}</div>}
                </React.Fragment>
              );
            })}
          </div>}
          </div>
          {/* 其余功能模块：各用一种主题色的卡片区分 */}
          <div className={`sb-mod m-over ${folded.over ? 'is-folded' : ''}`}>
            {secHead('over', '📊 总览分析', '📊')}
            {!folded.over && <div className="sb-group">{overNav.map((n) => navItem(n))}</div>}
          </div>
          <div className={`sb-mod m-smart ${folded.smart ? 'is-folded' : ''}`}>
            {secHead('smart', <>🤖 智能模块</>, '🤖')}
            {!folded.smart && <div className="sb-group">{smartNav.map((n) => navItem(n))}</div>}
          </div>
          <div className={`sb-mod m-maint ${folded.maint ? 'is-folded' : ''}`}>
            {secHead('maint', '🧰 维护', '🧰')}
            {!folded.maint && <div className="sb-group">{maintNav.map((n) => navItem(n))}</div>}
          </div>
          <div className="spacer" />
          <div className="sb-foot">
            {collapsed && <button className={`sb-gear ${view.type === 'help' ? 'active' : ''}`} data-tour="help" title="帮助指南" onClick={toggleHelp}>❓</button>}
            <div className="sb-user" title="用户信息（预留）">
              <span className="sb-avatar">👤</span>
              {!collapsed && <div className="sb-user-main"><div className="sb-user-name">本地用户</div><div className="sb-user-sub">用户信息（预留）</div></div>}
            </div>
            <button className={`sb-gear ${view.type === 'settings' ? 'active' : ''}`} title="设置" data-tour="nav-settings" onClick={() => setViewState({ type: 'settings' })}>⚙</button>
          </div>
        </aside>
        <main className="main">
          <div className="page-help-fab"><PageHelp page={view.type} /></div>
          {view.type === 'task' && (cur ? <TaskView taskId={cur.id} /> : <NoTask />)}
          {view.type === 'tmonitor' && (cur ? <TaskMonitor scoped tab={view.tab || 'live'} taskId={cur.id} setTab={(tab) => setViewState({ type: 'tmonitor', tab })} /> : <NoTask />)}
          {view.type === 'search' && <SearchView defaultAll taskId={cur ? cur.id : undefined} taskName={cur ? cur.name : ''} state={searchState} setState={setSearchState} />}
          {view.type === 'groups' && <GroupsView />}
          {view.type === 'alllib' && <LibraryView key="alllib" title="🗂 所有资料库" mode={allLibMode} setMode={setAllLibMode} />}
          {view.type === 'monitor' && <TaskMonitor tab={view.tab || 'queue'} taskId={view.taskId} setTab={(tab, taskId) => setViewState({ type: 'monitor', tab, taskId: taskId || view.taskId })} />}
          {view.type === 'basket' && <BasketView />}
          {view.type === 'convert' && <ConvertView />}
          {view.type === 'analytics' && <AnalyticsView />}
          {view.type === 'recycle' && <RecycleView />}
          {view.type === 'notices' && <NoticesView />}
          {view.type === 'generate' && <GenerateView state={genState} setState={setGenState} />}
          {view.type === 'settings' && <SettingsView focus={view.focus} />}
          {view.type === 'help' && <HelpView focus={view.focus} onTour={startTour} onWelcome={() => setWelcome(true)} />}
          {view.type === 'logs' && <div className="view"><div className="view-head"><div className="vh-title">📜 运行日志 <span className="muted small">工具只保留一份日志文件，记录全部工作过程</span></div></div><div className="tab-body"><LogView /></div></div>}
          {view.type === 'file' && <FileView id={view.id} onBack={() => { setView(view.back || { type: 'search' }); if (view.backDrill) setDrill(view.backDrill); }} />}
        </main>
        {modal && (
          <div className="overlay" onClick={() => setModal(null)}>
            <div className="modal viewer-modal" onClick={(e) => e.stopPropagation()}>
              <SlideViewer fileIds={modal.fileIds} initialFileId={modal.fileId} initialSlideId={modal.slideId} terms={modal.terms} matched={modal.matched} results={modal.results} startMax={modal.max} onClose={() => setModal(null)} />
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
        {drill && <DrillDialog spec={drill} onClose={() => setDrill(null)} />}
        {welcome && config && <WelcomeDialog onClose={onWelcomeClose} />}
        {tour && <Tour onClose={() => setTour(false)} go={setView} setLibMode={setAllLibMode} onHelp={() => setView({ type: 'help' })} />}
        {askWatch && <WatchAskDialog roots={askWatch.roots} onClose={onAskWatch} />}
        {exporting && <div className="overlay"><div className="spinner-box">正在导出 {exporting.n} 页，请稍候…</div></div>}
        <div className="toasts">{toasts.map((t) => <div key={t.id} className={`toast ${t.kind}`}>{t.msg}{t.action && <button className="btn tiny" onClick={t.action.run}>{t.action.label}</button>}</div>)}</div>
      </div>
    </AppCtx.Provider>
  );
}

function NoTask() {
  return <div className="view"><div className="empty-tip">还没有解析任务。点击左上角“＋ 添加目录”添加要解析的文件夹，然后在左侧选择该任务。</div></div>;
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
