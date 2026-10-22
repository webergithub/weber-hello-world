import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api, fmtSize, fmtTime, THEME_LABEL, ACTION_LABEL, STATUS_LABEL, KIND_LABEL, unitOf } from '../api';
import { useApp } from '../ctx';
import SlideWorkspace from './SlideWorkspace';
import LogView from './LogView';
import { ReparseDialog } from './TaskMonitor';
import DataTable from './DataTable';
import { RecycleButton } from './Recycle';
import { CompareButton } from './CompareView';
import { StatCards } from './DrillDialog';
import TagList from './TagList';

// 每个任务上次所在的页签：从文件详情等页面返回时恢复
const TAB_MEMO = new Map();

export default function TaskView({ taskId }) {
  const app = useApp();
  const [tab, setTabState] = useState(() => TAB_MEMO.get(taskId) || 'slides');
  const setTab = (t) => { TAB_MEMO.set(taskId, t); setTabState(t); };
  const [data, setData] = useState(null);
  const [focusFile, setFocusFile] = useState(null);
  const [dupes, setDupes] = useState(null);
  const curId = useRef(taskId);
  curId.current = taskId;
  // 只接收当前任务的数据（快速切换任务时，旧任务较慢返回的数据不会覆盖新任务）
  const load = () => { const id = taskId; return api.taskDetail(id).then((d) => { if (curId.current === id) setData(d); }); };
  useEffect(() => { setTabState(TAB_MEMO.get(taskId) || 'slides'); setFocusFile(null); load(); }, [taskId]);
  useEffect(() => { load(); }, [app.taskTick]);
  // 切换任务时，新任务的数据到达前不显示上一个任务的内容
  if (!data || !data.task || data.task.id !== taskId) return <div className="empty-tip">加载中…</div>;
  const { task, stats } = data;
  const files = dedupe(data.files);
  const live = app.liveTasks[taskId];
  return (
    <div className="view">
      <div className="view-head">
        <div>
          <div className="vh-title">📁 {task.name} <span className={`status s-${task.status}`}>{STATUS_LABEL[task.status] || task.status}</span></div>
          <div className="muted small">{task.dir} · 创建于 {fmtTime(task.created_at)}{task.message ? ' · ' + task.message : ''}</div>
          {live && live.status === 'running' && (
            <div className="progress-wrap">
              <div className="progress"><div style={{ width: `${task.total ? ((live.done || 0) / task.total) * 100 : 5}%` }} /></div>
              <span className="small muted">{live.done || 0}/{task.total} {live.current ? '· ' + live.current : ''}</span>
            </div>
          )}
        </div>
        <div className="spacer" />
        {task.status === 'running' || task.status === 'pending'
          ? <><button className="btn primary" onClick={() => api.pauseTask(taskId).then(app.refreshTasks)} title="暂停后可从断点继续">⏸ 暂停</button><button className="btn" onClick={() => api.cancelTask(taskId)}>取消任务</button></>
          : <>{['paused', 'interrupted'].includes(task.status) && <button className="btn primary" onClick={() => app.startParse(taskId, 'resume')}>▶ 从断点继续</button>}<button className={`btn ${task.status === 'draft' ? 'primary' : ''}`} onClick={() => app.startParse(taskId)}>{task.status === 'draft' ? '▶ 开始解析' : '↻ 重新扫描'}</button></>}
        {task.watch && task.run_started && !['running', 'pending'].includes(task.status) ? <button className="btn" title="只解析新增和修改过的文档，原文件已删除的移入回收站" onClick={() => app.startParse(taskId, 'watch')}>↻ 增量扫描</button> : null}
        <button className={`btn ${task.watch ? 'primary' : ''}`} title={`每天 ${(app.config && app.config.watch && app.config.watch.time) || ''} 定时增量扫描该任务（时间在“设置 → 定时监测更新”中修改）`}
          onClick={async () => { await api.setTaskWatch(taskId, !task.watch); app.setConfig(await api.getConfig()); app.refreshTasks(); load(); app.toast(task.watch ? '已关闭该任务的定时监测' : '已开启定时监测：每天定时增量扫描该任务'); }}>📡 监测更新：{task.watch ? '开' : '关'}</button>
        <button className="btn ghost" onClick={() => app.go({ type: 'monitor', tab: 'live', taskId })}>⚙️ 解析动态</button>
      </div>
      {task.status === 'draft' && <div className="notice">任务尚未开始：点击右上角“开始解析”加入解析队列。</div>}
      {(stats.skipped || 0) + (stats.duplicate || 0) > 0 && task.status !== 'running' && (
        <div className="notice">有 <b>{(stats.skipped || 0) + (stats.duplicate || 0)}</b> 个文件与解析历史记录信息完全一致（名称、修改时间、大小、作者），未重复解析。
          <button className="btn small" onClick={() => setDupes(files.filter((f) => f.action === 'skipped' || f.action === 'duplicate'))}>选择是否重新解析…</button></div>
      )}
      {dupes && <ReparseDialog files={dupes} onClose={() => setDupes(null)} />}
      <div className="tabs">
        <button className={tab === 'slides' ? 'on' : ''} onClick={() => setTab('slides')}>页面视图（原始页 · 备注 · Markdown）</button>
        <button className={tab === 'files' ? 'on' : ''} onClick={() => setTab('files')}>文件清单与统计（{files.length}）</button>
        <button className={tab === 'log' ? 'on' : ''} onClick={() => setTab('log')}>运行日志</button>
      </div>
      <div className="tab-body">
        {tab === 'slides' && <SlideWorkspace key={`ws-${taskId}`} files={files.filter((f) => f.id && f.status !== 'recycled')} initialFileId={focusFile} emptyText="该任务尚未解析出 PPT" />}
        {tab === 'files' && <FilesStats files={files} stats={stats} title={`#${task.id} ${task.name}`} onOpen={(id) => { setFocusFile(id); setTab('slides'); }} />}
        {tab === 'log' && <LogView taskId={taskId} />}
      </div>
    </div>
  );
}

function dedupe(rows) {
  // 同一文件在一次任务中只显示最后一次处理结果
  const m = new Map();
  for (const r of rows) m.set(r.link_path, r);
  return [...m.values()];
}

export function FilesStats({ files, stats, onOpen, title = '' }) {
  const app = useApp();
  const [q, setQ] = useState('');
  const [act, setAct] = useState('');
  const [sel, setSel] = useState(() => new Set());
  const rows = useMemo(() => {
    const f = q.trim().toLowerCase();
    return files.filter((r) => (!act || r.action === act) && (!f || (r.link_path || '').toLowerCase().includes(f) || (r.tags || []).join(' ').toLowerCase().includes(f)));
  }, [files, q, act]);
  const ok = (r) => r.status === 'parsed';
  const byAct = (a) => (r) => r.action === a;
  // 每个统计数字都可点击下钻：[名称, 数值, 筛选条件, 突出显示的列]
  const cards = [
    ['文件总数', stats.files, () => true], ['本次解析', stats.parsed || 0, byAct('parsed')], ['已解析过·跳过', stats.skipped || 0, byAct('skipped')], ['重复文件', stats.duplicate || 0, byAct('duplicate')], ['失败', stats.failed || 0, byAct('failed')],
    ['页面总数', stats.slides, ok, ['slide_count']], ['含备注页', stats.notes, (r) => ok(r) && r.notes_count > 0, ['notes_count']], ['视频', stats.videos, (r) => ok(r) && r.video_count > 0, ['video_count']], ['含字幕页', stats.subtitles, (r) => ok(r) && r.subtitle_count > 0, ['subtitle_count']],
    ['黑底页 / 白底页', `${stats.dark} / ${stats.light}`, (r) => ok(r) && (r.kind || 'ppt') === 'ppt', ['dark_slides', 'light_slides']], ['隐藏页', stats.hidden, (r) => ok(r) && r.hidden_count > 0, ['hidden_count']], ['文件总大小', fmtSize(stats.size), () => true],
  ];
  const drill = (k, pick, show) => app.drill({ key: `task-${title}-${k}`, title: `${title ? `${title} · ` : ''}${k}`, rows: files.filter(pick), show, sort: k === '文件总大小' ? { k: 'size', d: -1 } : show ? { k: show[0], d: -1 } : undefined });
  const columns = [
    { key: 'action', label: '状态', sort: (r) => ACTION_LABEL[r.action] || r.action, render: (r) => <span className={`tag act-${r.action}`}>{ACTION_LABEL[r.action] || r.action}</span> },
    { key: 'name', label: '文件名', sort: (r) => r.name || r.link_path, render: (r) => <span className="link" onClick={() => r.id && onOpen(r.id)} title={r.link_path}>{r.name || r.link_path}</span> },
    { key: 'kind', label: '类型', sort: (r) => r.kind || 'ppt', render: (r) => KIND_LABEL[r.kind || 'ppt'] },
    { key: 'dir', label: '目录', className: 'muted small ellipsis', render: (r) => <span title={r.dir}>{r.dir}</span> },
    { key: 'slide_count', label: '页数/节数', sort: (r) => r.slide_count || 0, render: (r) => (r.slide_count ? `${r.slide_count} ${unitOf(r)}` : '') },
    { key: 'size', label: '大小', sort: (r) => r.size || 0, render: (r) => fmtSize(r.size), className: 'nowrap' },
    { key: 'author', label: '作者' },
    { key: 'mtime', label: '修改时间', sort: (r) => r.mtime || 0, render: (r) => fmtTime(r.mtime), className: 'small nowrap' },
    { key: 'theme', label: '底色', render: (r) => (r.theme && (r.kind || 'ppt') === 'ppt' ? <span className={`tag theme-${r.theme}`}>{THEME_LABEL[r.theme]}</span> : '') },
    { key: 'dark_slides', label: '黑底页', sort: (r) => r.dark_slides || 0, hidden: true },
    { key: 'notes_count', label: '含备注页', sort: (r) => r.notes_count || 0, hidden: true },
    { key: 'video_count', label: '视频', sort: (r) => r.video_count || 0, render: (r) => r.video_count || '' },
    { key: 'category', label: '分类' },
    { key: 'tags', label: '标签（20 个）', sort: (r) => (r.tags || []).join(' '), filterList: (r) => r.tags || [], className: 'tags-cell', render: (r) => <TagList tags={r.tags} /> },
    { key: 'message', label: '说明', sort: (r) => r.error || r.message, className: 'small muted', render: (r) => r.error || r.message },
    { key: 'at', label: '处理时间', sort: (r) => r.at || 0, render: (r) => fmtTime(r.at), className: 'small nowrap', hidden: true },
    { key: 'ops', label: '操作', nosort: true, className: 'nowrap', render: (r) => (
      <>
        {r.path && <button className="btn tiny" onClick={() => api.openPath(r.path)}>打开</button>}
        {r.path && <button className="btn tiny" onClick={() => api.showItem(r.path)}>📂 位置</button>}
        {r.md_path && <button className="btn tiny" onClick={() => api.openPath(r.md_path)}>MD</button>}
      </>
    ) },
  ];
  return (
    <div className="files-stats">
      <StatCards cards={cards} onDrill={drill} />
      <div className="chips">
        {Object.entries(stats.byCategory || {}).map(([k, v]) => <span key={k} className="chip drill" onClick={() => drill(`主题分类·${k}`, (r) => ok(r) && (r.category || '其他') === k)}>{k} {v}</span>)}
        {Object.entries(stats.byExt || {}).map(([k, v]) => <span key={k} className="chip ghost drill" onClick={() => drill(`${k} 文件`, (r) => (r.ext || (r.link_path || '').replace(/^.*(\.[^.\\/]+)$/, '$1')) === k)}>{k} × {v}</span>)}
      </div>
      <DataTable id="taskFiles" columns={columns} rows={rows} rowKey={(r, i) => r.link_path || i} rowClass={(r) => `row-${r.action}`} defaultSort={{ k: 'name', d: 1 }} empty="没有匹配的文件"
        selectable selected={sel} onSelect={setSel} selectableRow={(r) => r.id && r.status !== 'recycled'}
        actions={<><CompareButton ids={rows.filter((r) => sel.has(r.link_path) && r.id && r.status !== 'failed').map((r) => r.id)} /><RecycleButton ids={rows.filter((r) => sel.has(r.link_path) && r.id).map((r) => r.id)} done={() => setSel(new Set())} /></>}
        toolbar={(
          <>
            <input className="input" placeholder="按路径 / 标签过滤" value={q} onChange={(e) => setQ(e.target.value)} />
            <select className="input" value={act} onChange={(e) => setAct(e.target.value)}>
              <option value="">全部状态</option>{Object.entries(ACTION_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </>
        )} />
    </div>
  );
}
