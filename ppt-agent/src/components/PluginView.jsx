import React, { useEffect, useMemo, useState } from 'react';
import EtaLine from './Eta';
import { api, on, fmtTime, KIND_LABEL } from '../api';
import { useApp } from '../ctx';
import DataTable from './DataTable';

const JOB_LABEL = { queued: '排队中', running: '总结中…', done: '已完成', failed: '失败', cancelled: '已取消' };
const JOB_CLS = { queued: 'pending', running: 'running', done: 'done', failed: 'failed', cancelled: 'cancelled' };
let TAB = 'jobs';

/**
 * 插件 · 智能总结（v3.5，预留）：调用大模型为文档生成 Markdown 总结（另存 .md、入库供检索 / RAG）。
 * 大模型调用在主进程的单独工作线程中异步执行；本页面只展示进度（由 'plugin' 事件实时推送）并控制队列。
 */
export default function PluginView() {
  const app = useApp();
  const [st, setSt] = useState(null);
  const [list, setList] = useState([]);
  const [tab, setTabState] = useState(TAB);
  const setTab = (t) => { TAB = t; setTabState(t); };
  const [scope, setScope] = useState('all');
  const [picked, setPicked] = useState(() => new Set());
  const [force, setForce] = useState(false);
  const loadList = () => api.summaryList().then(setList).catch(() => {});
  useEffect(() => {
    api.pluginState().then(setSt);
    loadList();
    let last = 0;
    return on('plugin', (s) => { setSt(s); if (s.counts.done !== last) { last = s.counts.done; loadList(); } });
  }, []);
  const ran = useMemo(() => app.tasks.filter((t) => t.status === 'done' || (t.parsed || 0) > 0), [app.tasks]);
  if (!st) return <div className="empty-tip">加载中…</div>;
  const ok = st.available.ok;
  const c = st.counts;
  const total = c.queued + c.running + c.done + c.failed;
  const finished = c.done + c.failed;
  const running = st.jobs.find((j) => j.status === 'running');
  const start = async () => {
    try {
      const r = await api.summaryStart(scope === 'all' ? { all: true, force } : { taskIds: [...picked], force });
      app.toast(`已加入总结队列 ${r.added} 个文档${r.skipped ? `，已有总结的 ${r.skipped} 个跳过` : ''}`, 'info', { cat: '智能总结' });
      setTab('jobs');
    } catch (e) { app.toast(e.message, 'error'); }
  };
  const ops = (row) => (
    <>
      {row.mdPath || row.md_path ? <button className="btn tiny" title="在资源管理器中显示" onClick={() => api.showItem(row.mdPath || row.md_path)}>📂</button> : null}
      {row.mdPath || row.md_path ? <button className="btn tiny" onClick={() => api.openPath(row.mdPath || row.md_path)}>打开 MD</button> : null}
      {row.path && <><button className="btn tiny ghost" title="在资源管理器中显示并选中该文件" onClick={() => { api.showItem(row.path); }}>📂</button><button className="btn tiny ghost" onClick={() => api.openPath(row.path)}>原文件</button></>}
      {(row.file_md || row.src_md) && <button className="btn tiny ghost" title="解析出的 Markdown" onClick={() => api.openPath(row.file_md || row.src_md)}>解析 MD</button>}
    </>
  );
  const jobCols = [
    { key: 'id', label: '#', type: 'number', sort: (j) => j.id },
    { key: 'name', label: '文档', render: (j) => <span className="link" title={j.path} onClick={() => app.openFile(j.fileId)}>{j.name}</span> },
    { key: 'kind', label: '类型', sort: (j) => j.kind || 'ppt', render: (j) => KIND_LABEL[j.kind || 'ppt'] },
    { key: 'status', label: '状态', className: 'nowrap', sort: (j) => JOB_LABEL[j.status], render: (j) => <span className={`status s-${JOB_CLS[j.status]}`}>{JOB_LABEL[j.status]}</span> },
    { key: 'ms', label: '耗时', type: 'number', sort: (j) => j.ms || 0, render: (j) => (j.ms ? `${(j.ms / 1000).toFixed(1)}s` : '') },
    { key: 'error', label: '说明', className: 'small muted', render: (j) => j.error || (j.mdPath ? j.mdPath : '') },
    { key: 'ops', label: '操作', nosort: true, nofilter: true, className: 'nowrap', render: ops },
  ];
  const listCols = [
    { key: 'name', label: '文档', render: (r) => <span className="link" title={r.path} onClick={() => app.openFile(r.file_id)}>{r.name}</span> },
    { key: 'kind', label: '类型', sort: (r) => r.kind || 'ppt', render: (r) => KIND_LABEL[r.kind || 'ppt'] },
    { key: 'model', label: '模型' },
    { key: 'at', label: '生成时间', type: 'date', sort: (r) => r.at, filterValue: (r) => r.at, className: 'small nowrap', render: (r) => fmtTime(r.at) },
    { key: 'preview', label: '总结预览', className: 'small muted ellipsis', render: (r) => <span title={r.preview}>{String(r.preview || '').replace(/[#\n]+/g, ' ').slice(0, 120)}</span> },
    { key: 'ops', label: '操作', nosort: true, nofilter: true, className: 'nowrap', render: ops },
  ];
  return (
    <div className="view plugin-view">
      <div className="view-head">
        <div className="vh-title">🧠 智能总结 <span className="tag accent">插件</span>{ok ? <span className="tag ok">{st.available.model}</span> : <span className="tag warn">不可用</span>}{ok && st.script.enabled && st.script.auto ? <span className="tag">自动总结新解析的文档</span> : null}</div>
        <div className="spacer" />
        {st.paused ? <button className="btn" disabled={!total} onClick={() => api.summaryResume()}>▶ 继续</button> : <button className="btn" disabled={!c.queued && !c.running} onClick={() => api.summaryPause()}>⏸ 暂停</button>}
        <button className="btn" disabled={!c.queued} onClick={() => api.summaryCancel()}>取消排队</button>
        <button className="btn ghost" disabled={!finished && !c.cancelled} onClick={() => api.summaryClear()}>清除已结束</button>
      </div>
      {!ok && <div className="notice warn">{st.available.reason} <button className="btn small" onClick={() => app.go({ type: 'settings', focus: 'plugin' })}>⚙ 去设置</button></div>}
      {ok && st.paused && <div className="notice warn">已暂停 <button className="btn small primary" onClick={() => api.summaryResume()}>▶ 继续</button></div>}
      <div className="plugin-bar">
        <div className="seg">
          <button className={scope === 'all' ? 'on' : ''} onClick={() => setScope('all')}>全部已解析文档</button>
          <button className={scope === 'tasks' ? 'on' : ''} onClick={() => setScope('tasks')}>按任务选择</button>
        </div>
        {scope === 'tasks' && <div className="plugin-tasks">{ran.map((t) => (
          <label key={t.id} className={`type-chip ${picked.has(t.id) ? 'on' : ''}`}><input type="checkbox" checked={picked.has(t.id)} onChange={() => { const n = new Set(picked); if (n.has(t.id)) n.delete(t.id); else n.add(t.id); setPicked(n); }} />#{t.id} {t.name}</label>
        ))}{!ran.length && <span className="muted">还没有已解析的任务</span>}</div>}
        <label className="chk"><input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} /> 重新生成已有的总结</label>
        <button className="btn primary" disabled={!ok || (scope === 'tasks' && !picked.size)} onClick={start}>▶ 开始总结</button>
      </div>
      <div className="plugin-progress">
        <div className="progress"><div style={{ width: `${total ? (finished / total) * 100 : 0}%` }} /></div>
        <span className="small">{finished}/{total}{c.failed ? ` · 失败 ${c.failed}` : ''}{st.paused ? ' · 已暂停' : running ? ` · 正在总结：${running.name}` : ''}</span>
        {st.eta && <EtaLine eta={st.eta} />}
      </div>
      <div className="tabs">
        <button className={tab === 'jobs' ? 'on' : ''} onClick={() => setTab('jobs')}>进度（{st.jobs.length}）</button>
        <button className={tab === 'list' ? 'on' : ''} onClick={() => setTab('list')}>已生成的总结（{st.stored}）</button>
      </div>
      <div className="tab-body">
        {tab === 'jobs' && <DataTable id="summaryJobs" columns={jobCols} rows={st.jobs} rowKey={(j) => j.id} rowClass={(j) => (j.status === 'running' ? 'row-running' : '')} defaultSort={{ k: 'id', d: 1 }} empty="还没有总结任务" />}
        {tab === 'list' && <DataTable id="summaryList" columns={listCols} rows={list} rowKey={(r) => r.file_id} defaultSort={{ k: 'at', d: -1 }} empty="还没有生成的总结" />}
      </div>
    </div>
  );
}
