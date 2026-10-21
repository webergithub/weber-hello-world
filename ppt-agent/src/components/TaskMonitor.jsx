import React, { useEffect, useMemo, useState } from 'react';
import { api, fmtSize, fmtTime, STATUS_LABEL, ACTION_LABEL, KIND_LABEL } from '../api';
import { useApp } from '../ctx';
import LiveScan from './LiveScan';
import DataTable from './DataTable';

// 解析任务：任务队列（手动开始、排队、调整顺序）+ 实时解析动态 + 全部解析历史
const SUB_TITLE = { queue: '任务队列', live: '解析动态（实时）', history: '解析历史' };

// 解析任务：子视图（任务队列 / 解析动态 / 解析历史）由左侧子菜单切换；添加目录等入口统一在左侧
export default function TaskMonitor({ tab = 'queue', taskId, setTab }) {
  const app = useApp();
  return (
    <div className="view">
      <div className="view-head">
        <div className="vh-title">⚙️ 解析任务 <span className="crumb">› {SUB_TITLE[tab]}</span></div>
        <span className="muted small">{tab === 'queue' ? '添加目录后手动开始；多个任务排队依次解析；可中断与继续' : tab === 'live' ? '实时展示扫描读取、生成 Markdown 与标签标注的过程' : '每个文件每次被处理的完整记录'}</span>
        <div className="spacer" />
        {tab === 'queue' && <button className="btn primary" onClick={async () => { const n = await api.startAll(); app.refreshTasks(); app.toast(n ? `已将 ${n} 个任务加入解析队列` : '没有待解析的任务'); }}>▶ 全部开始</button>}
      </div>
      <div className="tab-body">
        {tab === 'queue' && <QueuePanel initial={taskId} onLive={(id) => setTab('live', id)} />}
        {tab === 'live' && <LiveScan taskId={taskId} onPick={(id) => setTab('live', id)} />}
        {tab === 'history' && <HistoryPanel />}
      </div>
    </div>
  );
}

function QueuePanel({ initial, onLive }) {
  const app = useApp();
  const { tasks } = app;
  const runningId = (tasks.find((t) => t.status === 'running') || {}).id;
  const [sel, setSel] = useState(initial || null);
  const cur = sel || runningId || (tasks[0] && tasks[0].id);
  const queued = tasks.filter((t) => t.queuePos > 0).sort((a, b) => a.queuePos - b.queuePos);
  const others = tasks.filter((t) => !(t.queuePos > 0));
  const card = (t) => {
    const live = app.progress[t.id];
    const done = t.parsed + t.skipped + t.duplicate + t.failed;
    return (
      <div key={t.id} className={`task-card ${cur === t.id ? 'active' : ''}`} onClick={() => setSel(t.id)}>
        <div className="tc-head">
          <span className={`dot s-${t.status}`} />
          <b>#{t.id} {t.name}</b>
          <span className={`status s-${t.status}`}>{STATUS_LABEL[t.status] || t.status}{t.queuePos > 0 ? ` · 第 ${t.queuePos} 位` : ''}</span>
        </div>
        <div className="muted small ellipsis" title={t.dir}>{t.dir}</div>
        {t.status === 'running' && (
          <div className="progress-wrap">
            <div className="progress"><div style={{ width: `${t.total ? ((live && live.index ? live.index - 1 : done) / t.total) * 100 : 3}%` }} /></div>
            <span className="small muted">{live && live.index ? live.index : done}/{t.total || '?'}</span>
          </div>
        )}
        {t.status !== 'draft' && t.status !== 'pending' && <div className="small muted">解析 {t.parsed} · 已解析过 {t.skipped} · 重复 {t.duplicate} · 失败 {t.failed}</div>}
        <div className="tc-ops" onClick={(e) => e.stopPropagation()}>
          {t.status === 'draft' && <button className="btn tiny primary" onClick={() => api.startTask(t.id).then(app.refreshTasks)}>▶ 开始解析</button>}
          {['paused', 'interrupted'].includes(t.status) && <button className="btn tiny primary" onClick={() => api.resumeTask(t.id).then(app.refreshTasks)}>▶ 继续</button>}
          {['done', 'cancelled', 'interrupted', 'paused', 'failed'].includes(t.status) && <button className="btn tiny" onClick={() => api.startTask(t.id).then(app.refreshTasks)}>↻ 重新扫描</button>}
          {(t.status === 'running' || t.status === 'pending') && <button className="btn tiny" onClick={() => api.pauseTask(t.id).then(app.refreshTasks)}>⏸ 中断</button>}
          {t.status === 'running' && <button className="btn tiny" onClick={() => onLive(t.id)}>解析动态</button>}
          {t.queuePos > 0 && <><button className="btn tiny" onClick={() => api.moveTask(t.id, -1).then(app.refreshTasks)}>上移</button><button className="btn tiny" onClick={() => api.moveTask(t.id, 1).then(app.refreshTasks)}>下移</button></>}
          <button className="btn tiny" onClick={() => app.go({ type: 'task', id: t.id })}>查看结果</button>
        </div>
      </div>
    );
  };
  return (
    <div className="monitor">
      <div className="mon-list">
        {!tasks.length && <div className="empty-tip">还没有任务。点击左上角“＋ 添加目录”（或其下拉菜单中的“添加所有本地文档”）。</div>}
        {queued.length > 0 && <div className="side-title">排队中（{queued.length}）</div>}
        {queued.map(card)}
        {others.length > 0 && <div className="side-title">全部任务</div>}
        {others.map(card)}
      </div>
      <div className="mon-live">{cur ? <LivePanel taskId={cur} /> : null}</div>
    </div>
  );
}

function LivePanel({ taskId }) {
  const app = useApp();
  const t = app.tasks.find((x) => x.id === taskId);
  const p = app.progress[taskId] || {};
  const [dupes, setDupes] = useState(null);
  if (!t) return null;
  const files = p.files || [];
  const pct = t.total ? Math.round(((p.index ? p.index - (t.status === 'running' ? 1 : 0) : t.parsed + t.skipped + t.duplicate + t.failed) / t.total) * 100) : 0;
  // 运行中使用实时事件统计，避免任务行计数刷新滞后
  const liveCount = (a) => files.filter((f) => (f.action || 'parsed') === a).length;
  const running = t.status === 'running' && files.length;
  const nParsed = running ? liveCount('parsed') : t.parsed;
  const nFailed = running ? liveCount('failed') : t.failed;
  const repeat = running ? liveCount('skipped') + liveCount('duplicate') : t.skipped + t.duplicate;
  return (
    <div className="live">
      <div className="live-head">
        <div className="vh-title">#{t.id} {t.name} <span className={`status s-${t.status}`}>{STATUS_LABEL[t.status]}</span></div>
        <div className="muted small">{t.dir}</div>
      </div>
      {t.status === 'draft' && <div className="notice">任务已添加，尚未开始。点击 <button className="btn small primary" onClick={() => api.startTask(t.id).then(app.refreshTasks)}>▶ 开始解析</button> 加入解析队列。</div>}
      {['paused', 'interrupted'].includes(t.status) && <div className="notice">{t.message || '任务已中断'} <button className="btn small primary" onClick={() => api.resumeTask(t.id).then(app.refreshTasks)}>▶ 从断点继续</button></div>}
      {t.status === 'pending' && <div className="notice">排队中：第 {t.queuePos} 位，前面的任务完成后自动开始。</div>}
      <div className="live-stats">
        <div className="card"><div className="card-v">{t.total || (p.scan ? p.scan.found : 0)}</div><div className="card-k">{t.status === 'running' && !t.total ? '已发现文档' : '文档总数'}</div></div>
        <div className="card"><div className="card-v">{p.index || (t.status === 'done' ? t.total : 0)}</div><div className="card-k">当前第几个</div></div>
        <div className="card"><div className="card-v">{nParsed}</div><div className="card-k">已解析</div></div>
        <div className="card"><div className="card-v">{repeat}</div><div className="card-k">已解析过 / 重复</div></div>
        <div className="card"><div className="card-v">{nFailed}</div><div className="card-k">失败</div></div>
      </div>
      {(t.status === 'running' || p.index) && (
        <div className="live-progress">
          <div className="lp-row"><span>总进度</span><div className="progress big"><div style={{ width: `${Math.min(100, pct)}%` }} /></div><span>{pct}%</span></div>
          {p.stage === 'scanning' && p.scan && <div className="small muted">扫描目录中：已检查 {p.scan.dirs} 个目录，发现 {p.scan.found} 个文档 · {p.scan.current}</div>}
          {p.file && t.status === 'running' && (
            <>
              <div className="lp-file">📄 正在处理：<b>{p.file.split(/[\\/]/).pop()}</b> <span className="tag">{STAGE[p.stage] || p.stage}</span></div>
              {p.slideTotal ? <div className="lp-row"><span>逐{p.unit || '页'}扫描</span><div className="progress"><div style={{ width: `${(p.slide / p.slideTotal) * 100}%` }} /></div><span>{p.slide}/{p.slideTotal}</span></div> : null}
              {p.slideTitle && <div className="small">第 {p.slide} {p.unit || '页'}：{p.slideTitle}</div>}
            </>
          )}
        </div>
      )}
      {['done', 'cancelled'].includes(t.status) && repeat > 0 && (
        <div className="notice">本次有 <b>{repeat}</b> 个文件与解析历史中的记录信息完全一致（名称、修改时间、大小、作者），未重复解析。
          <button className="btn small" onClick={async () => { const d = await api.taskDetail(t.id); setDupes(d.files.filter((f) => f.action === 'skipped' || f.action === 'duplicate')); }}>选择是否重新解析…</button>
        </div>
      )}
      <div className="live-split">
        <div className="pane">
          <div className="pane-head">已处理文件（逐页扫描与标签标注）</div>
          <div className="pane-body">
            {!files.length && <div className="muted">开始解析后，这里会实时显示每个文件的页数、页标题和自动标签。</div>}
            {[...files].reverse().slice(0, 300).map((f, i) => (
              <div key={f.file + i} className={`live-file ${f.action || ''}`}>
                <div><span className={`tag act-${f.action || 'parsed'}`}>{ACTION_LABEL[f.action] || '已解析'}</span> <b>{f.file.split(/[\\/]/).pop()}</b> {f.kind && <span className="tag">{KIND_LABEL[f.kind]}</span>}
                  {f.slides !== undefined && <span className="muted small"> {f.slides} {f.unit || '页'}{f.dark ? ` · 黑底 ${f.dark}` : ''}{f.notes ? ` · 备注 ${f.notes}` : ''}{f.videos ? ` · 视频 ${f.videos}` : ''}{f.ms ? ` · ${f.ms}ms` : ''}</span>}
                </div>
                {f.titles && f.titles.length > 0 && <div className="lf-titles small">{f.titles.slice(0, 12).map((x, k) => <span key={k}>{k + 1}. {x || '（无标题）'}</span>)}</div>}
                {f.tags && <div className="lf-tags">🏷 {f.category && <span className="tag accent">{f.category}</span>}{f.tags.map((x) => <span key={x} className="tag">{x}</span>)}</div>}
              </div>
            ))}
          </div>
        </div>
        <div className="pane">
          <div className="pane-head">实时动态</div>
          <div className="pane-body feed">{(p.feed || []).slice(-400).map((l, i) => <div key={i} className="feed-line">{l}</div>)}</div>
        </div>
      </div>
      {dupes && <ReparseDialog files={dupes} onClose={() => setDupes(null)} />}
    </div>
  );
}

const STAGE = { file: '准备', parse: '解析内容', slide: '逐页扫描', thumb: '生成页面截图', store: '入库', parsed: '完成', tag: '标签标注', done: '任务完成' };

export function ReparseDialog({ files, onClose }) {
  const app = useApp();
  const [sel, setSel] = useState(() => new Set(files.map((f) => f.link_path || f.path)));
  const toggle = (p) => { const n = new Set(sel); if (n.has(p)) n.delete(p); else n.add(p); setSel(n); };
  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 'min(900px, 94vw)' }}>
        <div className="detail-head"><div className="dh-title">这些文件已解析过，是否重新解析？</div><div className="spacer" /><button className="icon-btn" onClick={onClose}>✕</button></div>
        <div className="pad muted small">文件名、最后修改时间、大小、作者与解析历史中的记录完全一致，因此默认没有重复解析。勾选需要强制重新解析的文件：</div>
        <div className="modal-body pad">
          <DataTable id="reparse" rows={files} rowKey={(f) => f.link_path || f.path} selectable selected={sel} onSelect={setSel} maxHeight="50vh" columns={[
            { key: 'action', label: '状态', render: (f) => <span className={`tag act-${f.action}`}>{ACTION_LABEL[f.action]}</span> },
            { key: 'path', label: '文件', sort: (f) => f.link_path || f.path, className: 'small', render: (f) => f.link_path || f.path },
            { key: 'size', label: '大小', sort: (f) => f.size || 0, className: 'nowrap', render: (f) => fmtSize(f.size) },
            { key: 'mtime', label: '修改时间', sort: (f) => f.mtime || 0, className: 'small nowrap', render: (f) => fmtTime(f.mtime) },
            { key: 'author', label: '作者' },
            { key: 'message', label: '说明', className: 'small muted' },
          ]} />
        </div>
        <div className="detail-head"><div className="spacer" /><button className="btn" onClick={onClose}>不重新解析</button>
          <button className="btn primary" disabled={!sel.size} onClick={async () => { try { await api.reparseFiles([...sel]); app.refreshTasks(); app.toast(`已创建重新解析任务：${sel.size} 个文件`); onClose(); } catch (e) { app.toast(e.message, 'error'); } }}>重新解析所选（{sel.size}）</button></div>
      </div>
    </div>
  );
}

function HistoryPanel() {
  const app = useApp();
  const [rows, setRows] = useState([]);
  const [action, setAction] = useState('');
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(() => new Set());
  const [dlg, setDlg] = useState(null);
  useEffect(() => { api.history({ action: action || undefined, q: q || undefined, limit: 5000 }).then(setRows); }, [action, q, app.taskTick]);
  const toggle = (id) => { const n = new Set(sel); if (n.has(id)) n.delete(id); else n.add(id); setSel(n); };
  const picked = rows.filter((r) => sel.has(r.hid));
  const counts = useMemo(() => rows.reduce((m, r) => { m[r.action] = (m[r.action] || 0) + 1; return m; }, {}), [rows]);
  return (
    <div className="files-stats">
      <div className="ws-toolbar">
        <select className="input" value={action} onChange={(e) => setAction(e.target.value)}>
          <option value="">全部记录</option>{Object.entries(ACTION_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <input className="input" placeholder="按路径搜索" value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="muted">{rows.length} 条{Object.entries(counts).map(([k, v]) => ` · ${ACTION_LABEL[k]} ${v}`).join('')}</span>
        <div className="spacer" />
        <span className="badge">已选 {sel.size}</span>
        <button className="btn primary" disabled={!sel.size} onClick={() => setDlg(picked.map((r) => ({ ...r, link_path: r.path })))}>重新解析所选…</button>
      </div>
      <DataTable id="history" rows={rows} rowKey={(r) => r.hid} selectable selected={sel} onSelect={setSel} defaultSort={{ k: 'at', d: -1 }} empty="还没有解析记录" columns={[
        { key: 'at', label: '时间', sort: (r) => r.at, className: 'small nowrap', render: (r) => fmtTime(r.at) },
        { key: 'task', label: '任务', sort: (r) => r.task_id, className: 'small', render: (r) => `#${r.task_id} ${r.task_name || '（已删除）'}` },
        { key: 'action', label: '结果', sort: (r) => ACTION_LABEL[r.action] || r.action, render: (r) => <span className={`tag act-${r.action}`}>{ACTION_LABEL[r.action] || r.action}</span> },
        { key: 'kind', label: '类型', render: (r) => KIND_LABEL[r.kind] || '' },
        { key: 'path', label: '文件', className: 'small', render: (r) => <span className="link" title={r.path} onClick={() => r.file_id && app.openFile(r.file_id)}>{r.path}</span> },
        { key: 'slide_count', label: '页/节', sort: (r) => r.slide_count || 0, render: (r) => r.slide_count || '' },
        { key: 'size', label: '大小', sort: (r) => r.size || 0, className: 'nowrap', render: (r) => fmtSize(r.size) },
        { key: 'author', label: '作者' },
        { key: 'mtime', label: '修改时间', sort: (r) => r.mtime || 0, className: 'small nowrap', render: (r) => fmtTime(r.mtime), hidden: true },
        { key: 'message', label: '说明', className: 'small muted' },
      ]} />
      {dlg && <ReparseDialog files={dlg} onClose={() => { setDlg(null); setSel(new Set()); }} />}
    </div>
  );
}
