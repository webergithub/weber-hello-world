import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api, on, STATUS_LABEL, THEME_LABEL, fmtSize } from './api';
import { AppCtx } from './ctx';
import { renderMarkdown } from './md';
import TaskView from './components/TaskView';
import LibraryView from './components/LibraryView';
import SearchView from './components/SearchView';
import GroupsView from './components/GroupsView';
import BasketView from './components/BasketView';
import SettingsView from './components/SettingsView';
import LogView from './components/LogView';
import SlideWorkspace, { clearSlideCache, loadSlide } from './components/SlideWorkspace';
import SlidePreview from './components/SlidePreview';

const BASKET_KEY = 'ppta.basket';
const readBasket = () => { try { return JSON.parse(localStorage.getItem(BASKET_KEY) || '[]'); } catch { return []; } };

export default function App() {
  const [collapsed, setCollapsed] = useState(false);
  const [view, setView] = useState({ type: 'search' });
  const [tasks, setTasks] = useState([]);
  const [liveTasks, setLiveTasks] = useState({});
  const [taskTick, setTaskTick] = useState(0);
  const [logLines, setLogLines] = useState([]);
  const [basket, setBasket] = useState(readBasket);
  const [toasts, setToasts] = useState([]);
  const [modal, setModal] = useState(null);
  const [config, setConfig] = useState(null);
  const [libMode, setLibMode] = useState('folder');
  const [searchState, setSearchState] = useState({});
  const [exporting, setExporting] = useState(null);

  const toast = useCallback((msg, kind = 'info', action) => {
    const id = Math.random();
    setToasts((t) => [...t, { id, msg, kind, action }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 8000 : 5000);
  }, []);
  const refreshTasks = useCallback(() => api.tasks().then(setTasks), []);
  const reloadLogs = useCallback(() => api.logTail(5000).then(setLogLines), []);
  const bump = () => { clearSlideCache(); setTaskTick((x) => x + 1); };

  useEffect(() => {
    refreshTasks(); reloadLogs(); api.getConfig().then(setConfig);
    const off1 = on('task', (t) => {
      setLiveTasks((m) => ({ ...m, [t.id]: t }));
      if (t.status !== 'running' || t.done === undefined || t.done % 5 === 0) refreshTasks();
      if (['done', 'failed', 'cancelled'].includes(t.status)) {
        bump();
        toast(`任务「${t.name}」${STATUS_LABEL[t.status]}：${t.message || ''}`, t.status === 'failed' ? 'error' : 'info');
      }
    });
    const off2 = on('log', (lines) => setLogLines((l) => (l.length > 20000 ? l.slice(-15000) : l).concat(lines)));
    return () => { off1(); off2(); };
  }, []);
  useEffect(() => { try { localStorage.setItem(BASKET_KEY, JSON.stringify(basket)); } catch { /* ignore */ } }, [basket]);

  const addDir = async () => {
    const dirs = await api.selectDir();
    for (const d of dirs) {
      try { const id = await api.addTask(d); await refreshTasks(); setView({ type: 'task', id }); toast(`已添加解析任务：${d}`); } catch (e) { toast(e.message, 'error'); }
    }
  };

  const exportSlides = async (ids, kind) => {
    if (!ids.length) return;
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-T:]/g, '');
    const out = await api.saveFile(`PPT智能体导出_${stamp}.${kind === 'md' ? 'md' : 'pptx'}`, kind);
    if (!out) return;
    setExporting({ n: ids.length });
    try {
      const r = await api.exportSlides(ids, out, { includeNotes: true });
      toast(`导出完成：${r.slides} 页 → ${out}${r.size ? '（' + fmtSize(r.size) + '）' : ''}`, 'info', { label: '打开', run: () => api.openPath(out) });
    } catch (e) { toast('导出失败：' + e.message, 'error'); } finally { setExporting(null); }
  };

  const basketApi = useMemo(() => ({
    items: basket,
    add: (ids) => { setBasket((b) => { const s = new Set(b); const n = [...b, ...ids.filter((x) => !s.has(x))]; toast(`已加入导出篮：${n.length - b.length} 页（共 ${n.length} 页）`); return n; }); },
    remove: (id) => setBasket((b) => b.filter((x) => x !== id)),
    move: (i, d) => setBasket((b) => { const n = [...b]; const j = i + d; if (j < 0 || j >= n.length) return b; [n[i], n[j]] = [n[j], n[i]]; return n; }),
    clear: () => setBasket([]),
  }), [basket]);

  const ctx = {
    tasks, liveTasks, taskTick, logLines, reloadLogs, refreshTasks, toast, basket: basketApi, config, setConfig, bump,
    exportSlides, openSlide: (id) => setModal({ slideId: id }), openFile: (id) => setView({ type: 'file', id, back: view }),
  };

  const nav = [
    { key: 'search', icon: '🔍', label: '智能搜索' },
    { key: 'library', icon: '📚', label: '资料库浏览' },
    { key: 'groups', icon: '🧩', label: '相似分组' },
    { key: 'basket', icon: '🧺', label: `导出篮${basket.length ? `（${basket.length}）` : ''}` },
    { key: 'logs', icon: '📜', label: '运行日志' },
    { key: 'settings', icon: '⚙️', label: '设置' },
  ];

  return (
    <AppCtx.Provider value={ctx}>
      <div className={`app ${collapsed ? 'collapsed' : ''}`}>
        <aside className="sidebar">
          <div className="sb-head">
            {!collapsed && <div className="logo">PPT<span>智能体</span></div>}
            <button className="icon-btn" title={collapsed ? '展开菜单' : '折叠菜单'} onClick={() => setCollapsed(!collapsed)}>{collapsed ? '»' : '«'}</button>
          </div>
          <button className="btn primary add-btn" onClick={addDir} title="添加目录进行 PPT 解析">＋{collapsed ? '' : ' 添加目录解析'}</button>
          <div className="sb-section">{!collapsed && '解析任务'}</div>
          <div className="sb-tasks">
            {!tasks.length && !collapsed && <div className="muted small pad">还没有任务，点击上方按钮添加目录</div>}
            {tasks.map((t) => {
              const live = liveTasks[t.id];
              const pct = t.total ? Math.round(((live && live.done) || (t.parsed + t.skipped + t.duplicate + t.failed)) / t.total * 100) : 0;
              return (
                <div key={t.id} className={`sb-task ${view.type === 'task' && view.id === t.id ? 'active' : ''}`} onClick={() => setView({ type: 'task', id: t.id })} title={t.dir}>
                  <span className={`dot s-${t.status}`} />
                  {!collapsed && (
                    <div className="sbt-main">
                      <div className="sbt-name">#{t.id} {t.name}</div>
                      <div className="sbt-meta">{STATUS_LABEL[t.status]}{t.status === 'running' ? ` ${pct}%` : ` · ${t.parsed} 解析 / ${t.skipped + t.duplicate} 跳过`}</div>
                    </div>
                  )}
                  {!collapsed && t.status !== 'running' && (
                    <button className="icon-btn tiny" title="删除任务记录" onClick={async (e) => {
                      e.stopPropagation();
                      const rm = confirm(`删除任务 #${t.id}「${t.name}」？\n\n确定：同时从资料库移除该任务解析的文件\n取消：不删除`);
                      if (!rm) return;
                      await api.deleteTask(t.id, true); refreshTasks(); bump(); if (view.id === t.id) setView({ type: 'search' });
                    }}>✕</button>
                  )}
                </div>
              );
            })}
          </div>
          <div className="sb-section">{!collapsed && '功能'}</div>
          {nav.map((n) => (
            <div key={n.key} className={`sb-item ${view.type === n.key ? 'active' : ''}`} onClick={() => setView({ type: n.key })} title={n.label}>
              <span className="ic">{n.icon}</span>{!collapsed && <span>{n.label}</span>}
            </div>
          ))}
          {view.type === 'library' && !collapsed && (
            <div className="sb-sub">
              {[['folder', '按文件夹'], ['name', '按 PPT 名称'], ['tags', '按内容归类（标签）']].map(([k, v]) => <div key={k} className={`sb-subitem ${libMode === k ? 'active' : ''}`} onClick={() => setLibMode(k)}>{v}</div>)}
            </div>
          )}
        </aside>
        <main className="main">
          {view.type === 'task' && <TaskView taskId={view.id} />}
          {view.type === 'library' && <LibraryView mode={libMode} setMode={setLibMode} />}
          {view.type === 'search' && <SearchView state={searchState} setState={setSearchState} />}
          {view.type === 'groups' && <GroupsView />}
          {view.type === 'basket' && <BasketView />}
          {view.type === 'settings' && <SettingsView />}
          {view.type === 'logs' && <div className="view"><div className="view-head"><div className="vh-title">📜 运行日志 <span className="muted small">工具只保留一份日志文件，记录全部工作过程</span></div></div><div className="tab-body"><LogView /></div></div>}
          {view.type === 'file' && <FileView id={view.id} onBack={() => setView(view.back || { type: 'search' })} />}
        </main>
        {modal && <SlideModal slideId={modal.slideId} onClose={() => setModal(null)} onSwitch={(id) => setModal({ slideId: id })} />}
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

function SlideModal({ slideId, onClose, onSwitch }) {
  const [s, setS] = useState(null);
  const { basket } = React.useContext(AppCtx);
  useEffect(() => { setS(null); loadSlide(slideId).then(setS); }, [slideId]);
  useEffect(() => { const k = (e) => e.key === 'Escape' && onClose(); window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, []);
  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        {!s ? <div className="pad">加载中…</div> : (
          <>
            <div className="detail-head">
              <div><div className="dh-title">{s.title || `第 ${s.idx} 页`} <span className={`tag theme-${s.theme}`}>{THEME_LABEL[s.theme]}</span></div><div className="muted small">{s.file.path} · 第 {s.idx} 页</div></div>
              <div className="spacer" />
              {s.counterpart && <button className="btn" onClick={() => onSwitch(s.counterpart.id)}>⇄ 切换到{THEME_LABEL[s.counterpart.theme]}版本</button>}
              <button className="btn" onClick={() => basket.add([s.id])}>加入导出篮</button>
              <button className="btn" onClick={() => api.openPath(s.file.path)}>打开 PPT</button>
              <button className="icon-btn" onClick={onClose}>✕</button>
            </div>
            {s.counterpart && <div className="hint-bar">⇄ 该页有内容相近的 <b>{THEME_LABEL[s.counterpart.theme]}</b> 版本：{s.counterpart.fileName} 第 {s.counterpart.idx} 页</div>}
            <div className="modal-body">
              <div className="detail-preview"><SlidePreview slide={s} file={s.file} full /></div>
              <div className="detail-panes">
                <div className="pane"><div className="pane-head">🗣 备注（讲解词）</div><div className="pane-body notes">{s.notes || <span className="muted">（本页无备注）</span>}</div></div>
                <div className="pane"><div className="pane-head">📝 解析 Markdown</div><div className="pane-body md" dangerouslySetInnerHTML={{ __html: renderMarkdown(s.md) }} /></div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
