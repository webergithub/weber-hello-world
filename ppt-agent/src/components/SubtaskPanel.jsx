import React, { useMemo } from 'react';
import { api, STATUS_LABEL, isActive } from '../api';
import { useApp } from '../ctx';
import DataTable from './DataTable';
import { StatCards } from './DrillDialog';

const processed = (c) => (c.parsed || 0) + (c.skipped || 0) + (c.duplicate || 0) + (c.failed || 0);

/**
 * 总任务的子任务视图（v3.5）：大任务按盘符 / 文件夹拆分后，每个子任务的文件数、已处理、解析 / 跳过 / 重复 / 失败 / 待处理；
 * 每个数字都可点击查看文件清单；每个子任务可单独开始、暂停、继续、重新处理。数据来自 app.allTasks（实时合并的任务状态）。
 */
export default function SubtaskPanel({ task }) {
  const app = useApp();
  const kids = useMemo(() => app.allTasks.filter((t) => t.parent_id === task.id).sort((a, b) => (a.part_no || 0) - (b.part_no || 0)), [app.allTasks, task.id]);
  const title = (c) => `${task.name} · 子任务 ${c.part_no}${c.part_label ? ` · ${c.part_label}` : ''}`;
  const filesOf = (list, act) => Promise.all(list.map((c) => api.subtaskFiles(c.id))).then((rs) => rs.flat().filter((r) => !act || (act === 'done' ? r.action !== 'pending' : r.action === act)));
  const drill = (c, act, label) => app.drill({ key: `sub-${c ? c.id : `all-${task.id}`}-${act || 'all'}`, title: `${c ? title(c) : task.name} · ${label}`, load: () => filesOf(c ? [c] : kids, act) });
  const num = (c, act, label, v, cls = '') => (v ? <span className={`link ${cls}`} title="查看文件清单" onClick={() => drill(c, act, label)}>{v}</span> : <span className="muted">0</span>);
  const sum = kids.reduce((a, c) => ({ total: a.total + (c.total || 0), parsed: a.parsed + (c.parsed || 0), skipped: a.skipped + (c.skipped || 0), duplicate: a.duplicate + (c.duplicate || 0), failed: a.failed + (c.failed || 0) }), { total: 0, parsed: 0, skipped: 0, duplicate: 0, failed: 0 });
  const done = kids.filter((c) => c.status === 'done').length;
  const allDrill = (k, act) => () => drill(null, act, k);
  const cards = [
    ['子任务', `${done} / ${kids.length}`], ['文件总数', sum.total, allDrill('文件总数', '')], ['已处理', processed(sum), allDrill('已处理', 'done')], ['本次解析', sum.parsed, allDrill('本次解析', 'parsed')],
    ['已解析过·跳过', sum.skipped, allDrill('已解析过·跳过', 'skipped')], ['重复文件', sum.duplicate, allDrill('重复文件', 'duplicate')], ['失败', sum.failed, allDrill('失败', 'failed')], ['待处理', Math.max(0, sum.total - processed(sum)), allDrill('待处理', 'pending')],
  ];
  const ops = (c) => {
    if (c.status === 'pausing') return <button className="btn tiny" disabled>暂停中…</button>;
    if (isActive(c) || c.status === 'pending') return <button className="btn tiny" onClick={() => api.pauseTask(c.id).then(app.refreshTasks)}>⏸ 暂停</button>;
    return (
      <>
        {c.status !== 'done' && <button className="btn tiny primary" onClick={() => api.startTask(c.id, { resume: !!(c.run_started && c.has_scan) }).then(app.refreshTasks).catch((e) => app.toast(e.message, 'error'))}>{c.run_started ? '▶ 继续' : '▶ 开始'}</button>}
        <button className="btn tiny" title="重新处理该子任务的全部文件（未变化的文件会快速跳过）" onClick={() => api.startTask(c.id).then(app.refreshTasks).catch((e) => app.toast(e.message, 'error'))}>↻ 重新处理</button>
      </>
    );
  };
  const columns = [
    { key: 'part_no', label: '#', type: 'number', sort: (c) => c.part_no || 0, className: 'nowrap' },
    { key: 'part_label', label: '子任务（盘符 / 文件夹）', sort: (c) => c.part_label || '', render: (c) => <span className="link" title={c.dir} onClick={() => app.go({ type: 'task', id: c.id, back: true })}>{c.part_label || c.name}</span> },
    { key: 'status', label: '状态', className: 'nowrap', sort: (c) => STATUS_LABEL[c.status] || c.status, render: (c) => <span className={`status s-${c.status}`}>{STATUS_LABEL[c.status] || c.status}{c.status === 'pending' && c.queuePos ? ` · 第 ${c.queuePos} 位` : ''}</span> },
    { key: 'total', label: '文件数', type: 'number', sort: (c) => c.total || 0, render: (c) => num(c, '', '全部文件', c.total) },
    { key: 'done', label: '已处理', type: 'number', sort: (c) => processed(c), render: (c) => (
      <div className="sub-prog"><div className="progress"><div style={{ width: `${c.total ? (processed(c) / c.total) * 100 : 0}%` }} /></div><span className="small">{processed(c)}/{c.total || 0}</span></div>
    ) },
    { key: 'parsed', label: '解析', type: 'number', sort: (c) => c.parsed || 0, render: (c) => num(c, 'parsed', '本次解析', c.parsed) },
    { key: 'skipped', label: '已解析过·跳过', type: 'number', sort: (c) => c.skipped || 0, render: (c) => num(c, 'skipped', '已解析过·跳过', c.skipped) },
    { key: 'duplicate', label: '重复', type: 'number', sort: (c) => c.duplicate || 0, render: (c) => num(c, 'duplicate', '重复文件', c.duplicate) },
    { key: 'failed', label: '失败', type: 'number', sort: (c) => c.failed || 0, render: (c) => num(c, 'failed', '失败', c.failed, 'danger-fg') },
    { key: 'pending', label: '待处理', type: 'number', sort: (c) => Math.max(0, (c.total || 0) - processed(c)), render: (c) => num(c, 'pending', '待处理', Math.max(0, (c.total || 0) - processed(c))) },
    { key: 'dir', label: '目录', className: 'muted small ellipsis', render: (c) => <span title={c.dir}>{c.dir}</span> },
    { key: 'ops', label: '操作', nosort: true, nofilter: true, className: 'nowrap', render: (c) => <>{ops(c)}<button className="btn tiny ghost" title="在资源管理器中显示" onClick={() => api.showItem(c.dir)}>📂</button></> },
  ];
  return (
    <div className="files-stats subtasks">
      <StatCards cards={cards} onDrill={(k, pick) => pick()} />
      <DataTable id="subtasks" sessionKey={`subtasks-${task.id}`} columns={columns} rows={kids} rowKey={(c) => c.id} rowClass={(c) => (isActive(c) ? 'row-running' : '')} defaultSort={{ k: 'part_no', d: 1 }} empty="没有子任务" />
    </div>
  );
}
