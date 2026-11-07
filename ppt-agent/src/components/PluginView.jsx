import React, { useEffect, useMemo, useState } from 'react';
import EtaLine from './Eta';
import { api, on, fmtTime, KIND_LABEL, STATUS_LABEL } from '../api';
import { useApp } from '../ctx';
import DataTable from './DataTable';

const JOB_LABEL = { queued: '排队中', running: '总结中…', done: '已完成', failed: '失败', cancelled: '已取消' };
const JOB_CLS = { queued: 'pending', running: 'running', done: 'done', failed: 'failed', cancelled: 'cancelled' };
const ENGINE_LABEL = { llm: '大模型接口', script: 'AI 调用脚本', fake: '测试替身' };
let TAB = 'tasks';

/**
 * PPT_Agent（v3.11，原“智能总结”插件）：调用大模型解析文档、生成 Markdown 总结并入库的管理界面。
 * “选择任务”列出全部任务与拆分后的子任务（已解析 / 已总结 / 待总结 / 排队 / 失败，数字可下钻），多选后“解析入库”，
 * 所选任务同时加入轮询范围：harness 每隔一段时间轮询，新解析的文档自动总结入库。
 */
export default function PluginView() {
  const app = useApp();
  const [st, setSt] = useState(null);
  const [list, setList] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [tab, setTabState] = useState(TAB);
  const setTab = (t) => { TAB = t; setTabState(t); };
  const [sel, setSel] = useState(() => new Set());
  const [force, setForce] = useState(false);
  const loadList = () => api.summaryList().then(setList).catch(() => {});
  const loadTasks = () => api.pptAgentTasks().then(setTasks).catch(() => {});
  useEffect(() => {
    api.pluginState().then(setSt);
    loadList(); loadTasks();
    let last = 0, lastT = 0;
    const off = on('plugin', (s) => {
      setSt(s);
      if (s.counts.done !== last) { last = s.counts.done; loadList(); }
      if (Date.now() - lastT > 1500) { lastT = Date.now(); loadTasks(); }
    });
    return off;
  }, []);
  useEffect(() => { loadTasks(); }, [app.taskTick]);
  // 总任务在前，其子任务紧随其后（缩进显示）
  const rows = useMemo(() => {
    const top = tasks.filter((t) => !t.parent_id).sort((a, b) => b.id - a.id);
    const out = [];
    top.forEach((t, i) => {
      out.push({ ...t, order: i * 10000 });
      tasks.filter((c) => c.parent_id === t.id).sort((a, b) => (a.part_no || 0) - (b.part_no || 0)).forEach((c, k) => out.push({ ...c, order: i * 10000 + k + 1 }));
    });
    return out;
  }, [tasks]);
  if (!st) return <div className="empty-tip">加载中…</div>;
  const ok = st.available.ok;
  const c = st.counts;
  const total = c.queued + c.running + c.done + c.failed;
  const finished = c.done + c.failed;
  const running = st.jobs.find((j) => j.status === 'running');
  const h = st.harness || { scopes: [] };
  const picked = rows.filter((r) => sel.has(r.id));
  const label = (t) => (t.parent_id ? `子任务 ${t.part_no}${t.part_label ? ` · ${t.part_label}` : ''}` : `#${t.id} ${t.name}`);
  const drill = (t, kind, what) => app.drill({ key: `agent-${t.id}-${kind}`, title: `${label(t)} · ${what}`, load: () => api.pptAgentTaskFiles(t.id, kind) });
  const num = (t, kind, what, v, cls = '') => (v ? <span className={`link ${cls}`} title="查看文件清单" onClick={() => drill(t, kind, what)}>{v}</span> : <span className="muted">0</span>);

  const runPicked = async () => {
    try {
      const r = await api.pptAgentRun({ taskIds: picked.map((t) => t.id), force, poll: true });
      app.toast(`已加入 PPT_Agent 队列 ${r.added} 个文档${r.skipped ? `，已有总结的 ${r.skipped} 个跳过` : ''}；所选 ${picked.length} 个任务已加入轮询范围`, 'info', { cat: 'PPT_Agent' });
      setTab('jobs'); loadTasks();
    } catch (e) { app.toast(e.message, 'error'); }
  };
  const runAll = async () => {
    try {
      const r = await api.summaryStart({ all: true, force });
      app.toast(`已加入 PPT_Agent 队列 ${r.added} 个文档${r.skipped ? `，已有总结的 ${r.skipped} 个跳过` : ''}`, 'info', { cat: 'PPT_Agent' });
      setTab('jobs');
    } catch (e) { app.toast(e.message, 'error'); }
  };
  const setScopes = async (ids) => { setSt(await api.pptAgentSetScopes(ids)); loadTasks(); };
  const addScope = () => setScopes([...h.scopes, ...picked.map((t) => t.id)]);
  const removeScope = () => { const drop = new Set(picked.map((t) => t.id)); setScopes(h.scopes.filter((id) => !drop.has(id))); };

  const ops = (row) => (
    <>
      {row.mdPath || row.md_path ? <button className="btn tiny" title="在资源管理器中显示" onClick={() => api.showItem(row.mdPath || row.md_path)}>📂</button> : null}
      {row.mdPath || row.md_path ? <button className="btn tiny" onClick={() => api.openPath(row.mdPath || row.md_path)}>打开 MD</button> : null}
      {row.path && <><button className="btn tiny ghost" title="在资源管理器中显示并选中该文件" onClick={() => { api.showItem(row.path); }}>📂</button><button className="btn tiny ghost" onClick={() => api.openPath(row.path)}>原文件</button></>}
      {(row.file_md || row.src_md) && <button className="btn tiny ghost" title="解析出的 Markdown" onClick={() => api.openPath(row.file_md || row.src_md)}>解析 MD</button>}
    </>
  );
  const taskCols = [
    { key: 'order', label: '#', type: 'number', hidden: true, sort: (t) => t.order },
    { key: 'name', label: '任务 / 子任务', sort: (t) => t.order, render: (t) => (t.parent_id ? <span className="agent-sub" title={t.dir}>└ {label(t)}</span> : <b title={t.dir}>{label(t)}</b>) },
    { key: 'kind', label: '类型', className: 'nowrap', sort: (t) => (t.parent_id ? 2 : t.hasChildren ? 1 : 0), render: (t) => (t.parent_id ? '子任务' : t.hasChildren ? '总任务' : '任务') },
    { key: 'status', label: '解析状态', className: 'nowrap', sort: (t) => STATUS_LABEL[t.status] || t.status, render: (t) => <span className={`status s-${t.status}`}>{STATUS_LABEL[t.status] || t.status}</span> },
    { key: 'docs', label: '已解析文档', type: 'number', sort: (t) => t.docs, render: (t) => num(t, 'docs', '已解析文档', t.docs) },
    { key: 'summarized', label: '已总结入库', type: 'number', sort: (t) => t.summarized, render: (t) => num(t, 'done', '已总结入库', t.summarized) },
    { key: 'pending', label: '待总结', type: 'number', sort: (t) => t.pending, render: (t) => num(t, 'pending', '待总结', t.pending) },
    { key: 'prog', label: '进度', nofilter: true, sort: (t) => (t.docs ? t.summarized / t.docs : 0), render: (t) => <div className="sub-prog"><div className="progress"><div style={{ width: `${t.docs ? (t.summarized / t.docs) * 100 : 0}%` }} /></div><span className="small">{t.docs ? Math.round((t.summarized / t.docs) * 100) : 0}%</span></div> },
    { key: 'queued', label: '排队 / 进行中', type: 'number', sort: (t) => t.queued, render: (t) => t.queued || <span className="muted">0</span> },
    { key: 'failed', label: '失败', type: 'number', sort: (t) => t.failed, render: (t) => (t.failed ? <span className="danger-fg">{t.failed}</span> : <span className="muted">0</span>) },
    { key: 'inScope', label: '轮询', className: 'nowrap', sort: (t) => (t.inScope ? 1 : 0), render: (t) => (t.inScope ? <span className="tag ok">轮询中</span> : '') },
  ];
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
        <div className="vh-title">🤖 PPT_Agent
          {ok ? <span className="tag ok" title={st.available.engine ? ENGINE_LABEL[st.available.engine] : ''}>{st.available.model}</span> : <span className="tag warn">不可用</span>}
          {h.polling ? <span className="tag accent">轮询中 · 每 {h.pollSec} 秒 · {h.scopes.length} 个任务</span> : h.scopes.length ? <span className="tag">轮询已暂停</span> : null}
        </div>
        <div className="spacer" />
        {st.paused ? <button className="btn" onClick={() => api.summaryResume()}>▶ 继续</button> : <button className="btn" disabled={!c.queued && !c.running && !h.polling} onClick={() => api.summaryPause()}>⏸ 暂停</button>}
        <button className="btn" disabled={!c.queued} onClick={() => api.summaryCancel()}>取消排队</button>
        <button className="btn ghost" disabled={!finished && !c.cancelled} onClick={() => api.summaryClear()}>清除已结束</button>
        <button className="btn ghost" onClick={() => app.go({ type: 'settings', focus: 'agent' })}>⚙ 设置</button>
      </div>
      {!ok && <div className="notice warn">{st.available.reason} <button className="btn small" onClick={() => app.go({ type: 'settings', focus: 'agent' })}>⚙ 去设置</button></div>}
      {ok && st.paused && <div className="notice warn">已暂停 <button className="btn small primary" onClick={() => api.summaryResume()}>▶ 继续</button></div>}
      <div className="plugin-progress">
        <div className="progress"><div style={{ width: `${total ? (finished / total) * 100 : 0}%` }} /></div>
        <span className="small">{finished}/{total}{c.failed ? ` · 失败 ${c.failed}` : ''}{st.paused ? ' · 已暂停' : running ? ` · 正在总结：${running.name}` : ''}{h.lastPoll ? ` · 上次轮询 ${fmtTime(h.lastPoll)}` : ''}</span>
        {st.eta && <EtaLine eta={st.eta} />}
      </div>
      <div className="tabs">
        <button className={tab === 'tasks' ? 'on' : ''} onClick={() => setTab('tasks')}>选择任务（{rows.length}）</button>
        <button className={tab === 'jobs' ? 'on' : ''} onClick={() => setTab('jobs')}>进度（{st.jobs.length}）</button>
        <button className={tab === 'list' ? 'on' : ''} onClick={() => setTab('list')}>已生成的总结（{st.stored}）</button>
      </div>
      <div className="tab-body">
        {tab === 'tasks' && <DataTable id="agentTasks" columns={taskCols} rows={rows} rowKey={(t) => t.id} rowClass={(t) => (t.parent_id ? 'agent-child' : '')} defaultSort={{ k: 'order', d: 1 }} empty="还没有解析任务"
          selectable selected={sel} onSelect={setSel}
          toolbar={<>
            <label className="chk"><input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} /> 重新生成已有的总结</label>
            <button className="btn small ghost" disabled={!ok} onClick={runAll}>▶ 全部已解析文档</button>
          </>}
          actions={<>
            <button className="btn small primary" disabled={!ok || !picked.length} onClick={runPicked}>▶ 解析入库（{picked.length}）</button>
            <button className="btn small" disabled={!picked.some((t) => !h.scopes.includes(t.id))} onClick={addScope}>＋ 加入轮询</button>
            <button className="btn small ghost" disabled={!picked.some((t) => h.scopes.includes(t.id))} onClick={removeScope}>移出轮询</button>
          </>} />}
        {tab === 'jobs' && <DataTable id="summaryJobs" columns={jobCols} rows={st.jobs} rowKey={(j) => j.id} rowClass={(j) => (j.status === 'running' ? 'row-running' : '')} defaultSort={{ k: 'id', d: 1 }} empty="还没有总结任务" />}
        {tab === 'list' && <DataTable id="summaryList" columns={listCols} rows={list} rowKey={(r) => r.file_id} defaultSort={{ k: 'at', d: -1 }} empty="还没有生成的总结" />}
      </div>
    </div>
  );
}
