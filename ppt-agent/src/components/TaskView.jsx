import React, { useEffect, useMemo, useState } from 'react';
import { api, fmtSize, fmtTime, THEME_LABEL, ACTION_LABEL, STATUS_LABEL, KIND_LABEL, unitOf } from '../api';
import { useApp } from '../ctx';
import SlideWorkspace from './SlideWorkspace';
import LogView from './LogView';
import { ReparseDialog } from './TaskMonitor';

export default function TaskView({ taskId }) {
  const app = useApp();
  const [tab, setTab] = useState('slides');
  const [data, setData] = useState(null);
  const [focusFile, setFocusFile] = useState(null);
  const [dupes, setDupes] = useState(null);
  const load = () => api.taskDetail(taskId).then(setData);
  useEffect(() => { setTab('slides'); setFocusFile(null); load(); }, [taskId]);
  useEffect(() => { load(); }, [app.taskTick]);
  if (!data) return <div className="empty-tip">加载中…</div>;
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
          ? <button className="btn" onClick={() => api.cancelTask(taskId)}>取消任务</button>
          : <button className={`btn ${task.status === 'draft' ? 'primary' : ''}`} onClick={() => api.startTask(taskId).then(app.refreshTasks)}>{task.status === 'draft' ? '▶ 开始解析' : '↻ 重新扫描'}</button>}
        <button className="btn ghost" onClick={() => app.go({ type: 'monitor' })}>实时进度</button>
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
        {tab === 'slides' && <SlideWorkspace files={files.filter((f) => f.id)} initialFileId={focusFile} emptyText="该任务尚未解析出 PPT" />}
        {tab === 'files' && <FilesStats files={files} stats={stats} onOpen={(id) => { setFocusFile(id); setTab('slides'); }} />}
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

export function FilesStats({ files, stats, onOpen }) {
  const [sort, setSort] = useState({ k: 'name', d: 1 });
  const [q, setQ] = useState('');
  const [act, setAct] = useState('');
  const rows = useMemo(() => {
    const f = q.trim().toLowerCase();
    const list = files.filter((r) => (!act || r.action === act) && (!f || (r.link_path || '').toLowerCase().includes(f) || (r.tags || []).join(' ').toLowerCase().includes(f)));
    const get = (r) => (sort.k === 'name' ? r.name || '' : sort.k === 'size' ? r.size || 0 : sort.k === 'pages' ? r.slide_count || 0 : sort.k === 'mtime' ? r.mtime || 0 : r[sort.k] || '');
    return list.sort((a, b) => { const x = get(a), y = get(b); return (typeof x === 'string' ? x.localeCompare(y, 'zh') : x - y) * sort.d; });
  }, [files, sort, q, act]);
  const th = (k, label) => <th onClick={() => setSort({ k, d: sort.k === k ? -sort.d : 1 })} className="sortable">{label}{sort.k === k ? (sort.d > 0 ? ' ▲' : ' ▼') : ''}</th>;
  const cards = [
    ['文件总数', stats.files], ['本次解析', stats.parsed || 0], ['已解析过·跳过', stats.skipped || 0], ['重复文件', stats.duplicate || 0], ['失败', stats.failed || 0],
    ['页面总数', stats.slides], ['含备注页', stats.notes], ['视频', stats.videos], ['含字幕页', stats.subtitles], ['黑底页 / 白底页', `${stats.dark} / ${stats.light}`], ['隐藏页', stats.hidden], ['文件总大小', fmtSize(stats.size)],
  ];
  return (
    <div className="files-stats">
      <div className="cards">{cards.map(([k, v]) => <div key={k} className="card"><div className="card-v">{v}</div><div className="card-k">{k}</div></div>)}</div>
      <div className="chips">
        {Object.entries(stats.byCategory || {}).map(([k, v]) => <span key={k} className="chip">{k} {v}</span>)}
        {Object.entries(stats.byExt || {}).map(([k, v]) => <span key={k} className="chip ghost">{k} × {v}</span>)}
      </div>
      <div className="ws-toolbar">
        <input className="input" placeholder="按路径 / 标签过滤" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="input" value={act} onChange={(e) => setAct(e.target.value)}>
          <option value="">全部状态</option>{Object.entries(ACTION_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <span className="muted">{rows.length} 个</span>
      </div>
      <div className="table-wrap">
        <table className="grid">
          <thead><tr>{th('action', '状态')}{th('name', '文件名')}<th>类型</th><th>目录</th>{th('pages', '页数/节数')}{th('size', '大小')}<th>作者</th>{th('mtime', '修改时间')}<th>底色</th><th>视频</th><th>分类</th><th>标签（20 个）</th><th>说明</th><th>操作</th></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className={`row-${r.action}`}>
                <td><span className={`tag act-${r.action}`}>{ACTION_LABEL[r.action] || r.action}</span></td>
                <td className="link" onClick={() => r.id && onOpen(r.id)} title={r.link_path}>{r.name || r.link_path}</td>
                <td>{KIND_LABEL[r.kind || 'ppt']}</td>
                <td className="muted small ellipsis" title={r.dir}>{r.dir}</td>
                <td>{r.slide_count ? `${r.slide_count} ${unitOf(r)}` : ''}</td>
                <td>{fmtSize(r.size)}</td>
                <td>{r.author}</td>
                <td className="small">{fmtTime(r.mtime)}</td>
                <td>{r.theme ? <span className={`tag theme-${r.theme}`}>{THEME_LABEL[r.theme]}</span> : ''}</td>
                <td>{r.video_count || ''}</td>
                <td>{r.category}</td>
                <td className="tags-cell">{(r.tags || []).map((t) => <span key={t} className="tag">{t}</span>)}</td>
                <td className="small muted">{r.error || r.message}</td>
                <td className="nowrap">
                  {r.path && <button className="btn tiny" onClick={() => api.openPath(r.path)}>打开</button>}
                  {r.path && <button className="btn tiny" onClick={() => api.showItem(r.path)}>位置</button>}
                  {r.md_path && <button className="btn tiny" onClick={() => api.openPath(r.md_path)}>MD</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
