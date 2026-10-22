import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api, fmtSize, fmtTime, STATUS_LABEL, ACTION_LABEL, KIND_LABEL } from '../api';
import { useApp } from '../ctx';
import LiveScan from './LiveScan';
import DataTable from './DataTable';
import { drillTask } from './DrillDialog';

const Num = ({ onClick, children }) => <span className="num-link" onClick={(e) => { e.stopPropagation(); onClick(); }}>{children}</span>;

// 解析任务：任务队列（手动开始、排队、调整顺序）+ 实时解析动态 + 全部解析历史
const SUB_TITLE = { queue: '任务队列', live: '解析动态（实时）', history: '解析历史' };

// 解析任务：子视图（任务队列 / 解析动态 / 解析历史）由左侧子菜单切换；添加目录等入口统一在左侧
// scoped：只显示所选任务（任务详情 → 解析过程）；否则为全部任务（总览分析 → 全部任务与历史）
export default function TaskMonitor({ tab = 'queue', taskId, setTab, scoped = false }) {
  const app = useApp();
  const t = scoped && app.tasks.find((x) => x.id === taskId);
  return (
    <div className="view">
      <div className="view-head">
        <div className="vh-title">{scoped ? <>⚙️ 解析过程 <span className="crumb">› {t ? `#${t.id} ${t.name}` : ''} › {SUB_TITLE[tab]}</span></> : <>🗂 全部任务与历史 <span className="crumb">› {SUB_TITLE[tab]}</span></>}</div>
        <div className="spacer" />
        {tab === 'queue' && <button className="btn primary" onClick={async () => { const n = await api.startAll(); app.refreshTasks(); app.toast(n ? `已将 ${n} 个任务加入解析队列` : '没有待解析的任务'); if (n) setTab('live'); }}>▶ 全部开始</button>}
      </div>
      <div className="tab-body">
        {tab === 'queue' && <QueuePanel initial={taskId} onLive={(id) => setTab('live', id)} />}
        {tab === 'live' && <LiveScan taskId={taskId} lock={scoped} onPick={(id) => setTab('live', id)} />}
        {tab === 'history' && <HistoryPanel taskId={scoped ? taskId : undefined} />}
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
        {t.status !== 'draft' && t.status !== 'pending' && <div className="small muted">
          <Num onClick={() => drillTask(app, t, '本次解析', ['parsed'])}>解析 {t.parsed}</Num> · <Num onClick={() => drillTask(app, t, '已解析过', ['skipped'])}>已解析过 {t.skipped}</Num> · <Num onClick={() => drillTask(app, t, '重复', ['duplicate'])}>重复 {t.duplicate}</Num> · <Num onClick={() => drillTask(app, t, '失败', ['failed'])}>失败 {t.failed}</Num></div>}
        <div className="tc-ops" onClick={(e) => e.stopPropagation()}>
          {t.status === 'draft' && <button className="btn tiny primary" onClick={() => app.startParse(t.id)}>▶ 开始解析</button>}
          {['paused', 'interrupted'].includes(t.status) && <button className="btn tiny primary" onClick={() => app.startParse(t.id, 'resume')}>▶ 继续</button>}
          {['done', 'cancelled', 'interrupted', 'paused', 'failed'].includes(t.status) && <button className="btn tiny" onClick={() => app.startParse(t.id)}>↻ 重新扫描</button>}
          {(t.status === 'running' || t.status === 'pending') && <button className="btn tiny" onClick={() => api.pauseTask(t.id).then(app.refreshTasks)}>⏸ 暂停</button>}
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
      {t.status === 'draft' && <div className="notice">任务已添加，尚未开始。点击 <button className="btn small primary" onClick={() => app.startParse(t.id)}>▶ 开始解析</button> 加入解析队列。</div>}
      {['paused', 'interrupted'].includes(t.status) && <div className="notice">{t.message || '任务已暂停'} <button className="btn small primary" onClick={() => app.startParse(t.id, 'resume')}>▶ 从断点继续</button></div>}
      {t.status === 'pending' && <div className="notice">排队中：第 {t.queuePos} 位，前面的任务完成后自动开始。</div>}
      <div className="live-stats">
        <div className="card drill" onClick={() => drillTask(app, t, '已处理文档')}><div className="card-v">{t.total || (p.scan ? p.scan.found : 0)}</div><div className="card-k">{t.status === 'running' && !t.total ? '已发现文档' : '文档总数'}</div></div>
        <div className="card drill" onClick={() => drillTask(app, t, '已处理文档')}><div className="card-v">{p.index || (t.status === 'done' ? t.total : 0)}</div><div className="card-k">当前第几个</div></div>
        <div className="card drill" onClick={() => drillTask(app, t, '已解析', ['parsed'])}><div className="card-v">{nParsed}</div><div className="card-k">已解析</div></div>
        <div className="card drill" onClick={() => drillTask(app, t, '已解析过 / 重复', ['skipped', 'duplicate'])}><div className="card-v">{repeat}</div><div className="card-k">已解析过 / 重复</div></div>
        <div className="card drill" onClick={() => drillTask(app, t, '失败', ['failed'])}><div className="card-v">{nFailed}</div><div className="card-k">失败</div></div>
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
          <button className="btn primary" disabled={!sel.size} onClick={async () => { try { const id = await api.reparseFiles([...sel]); app.refreshTasks(); app.toast(`已创建重新解析任务：${sel.size} 个文件`); onClose(); if (id) app.go({ type: 'monitor', tab: 'live', taskId: id }); } catch (e) { app.toast(e.message, 'error'); } }}>重新解析所选（{sel.size}）</button></div>
      </div>
    </div>
  );
}

// 解析历史的筛选与当前选中的文件按范围记住：从文件详情返回时恢复到原来的条目
const HIST_STATE = new Map();

function HistoryPanel({ taskId }) {
  const app = useApp();
  const skey = `history-${taskId || 'all'}`;
  const saved = HIST_STATE.get(skey);
  const [rows, setRows] = useState([]);
  const [action, setAction] = useState(saved ? saved.action : '');
  const [q, setQ] = useState(saved ? saved.q : '');
  const [cur, setCur] = useState(saved ? saved.cur : null);
  useEffect(() => { HIST_STATE.set(skey, { action, q, cur }); }, [skey, action, q, cur]);
  const [sel, setSel] = useState(() => new Set());
  const [dlg, setDlg] = useState(null);
  useEffect(() => { api.history({ action: action || undefined, q: q || undefined, limit: 5000, taskId }).then(setRows); }, [action, q, app.taskTick, taskId]);
  // 正在解析的文件：来自实时进度，作为“解析中”记录显示在历史中
  const STAGE = { file: '读取文件', parse: '解析中', slide: '逐页解析', thumb: '生成页面截图', store: '写入数据库', parsed: '解析完成', tag: '计算标签', scanning: '扫描目录' };
  const live = useMemo(() => app.tasks.filter((t) => t.status === 'running' && (!taskId || t.id === taskId)).map((t) => {
    const p = app.progress[t.id] || {};
    const lt = app.liveTasks[t.id] || {};
    const file = p.file || (lt.current && /[\\/]/.test(lt.current) && !lt.current.startsWith('扫描中') ? lt.current : '');
    if (!file) return null;
    const unit = p.unit || '页';
    return { hid: `live-${t.id}`, live: true, task_id: t.id, task_name: t.name, action: 'running', path: file, at: Date.now(), name: file.split(/[\\/]/).pop(),
      message: `第 ${p.index || (lt.done || 0) + 1}/${p.total || t.total || '?'} 个文件${p.slideTotal ? ` · 第 ${p.slide}/${p.slideTotal} ${unit}` : ''} · ${STAGE[p.stage] || '解析中'}` };
  }).filter((r) => r && (!action || action === 'running') && (!q || r.path.includes(q))), [app.tasks, app.progress, app.liveTasks, action, q, taskId]);
  const all = useMemo(() => (action === 'running' ? live : [...live, ...rows]), [live, rows, action]);
  const [follow, setFollow] = useState(true);
  const locate = () => { const el = document.querySelector('.files-stats .row-live'); if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' }); return !!el; };
  const livePath = live.map((r) => r.path).join('|');
  // 打开时自动定位到正在解析的文件；勾选“跟随”时文件切换也自动定位
  const opened = useRef(!!(saved && saved.cur));
  useEffect(() => {
    if (!livePath) return;
    if (!opened.current || follow) { setTimeout(locate, 60); opened.current = true; }
  }, [livePath, follow]);
  const toggle = (id) => { const n = new Set(sel); if (n.has(id)) n.delete(id); else n.add(id); setSel(n); };
  const picked = rows.filter((r) => sel.has(r.hid));
  // 资源管理器：只选了一条时用所选，否则用最近点击的那条
  const target = (sel.size === 1 && all.find((r) => sel.has(r.hid))) || (cur && all.find((r) => r.hid === cur.hid || r.path === cur.path)) || null;
  const counts = useMemo(() => rows.reduce((m, r) => { m[r.action] = (m[r.action] || 0) + 1; return m; }, {}), [rows]);
  return (
    <div className="files-stats">
      <div className="ws-toolbar">
        <select className="input" value={action} onChange={(e) => setAction(e.target.value)}>
          <option value="">全部记录</option>{Object.entries(ACTION_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <input className="input" placeholder="按路径搜索" value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="muted"><Num onClick={() => setAction('')}>{rows.length} 条</Num>{Object.entries(counts).map(([k, v]) => <React.Fragment key={k}> · <Num onClick={() => setAction(k)}>{ACTION_LABEL[k]} {v}</Num></React.Fragment>)}</span>
        {live.length > 0 && <>
          <span className="status s-running">解析中 {live.length}</span>
          <button className="btn small" onClick={locate} title="滚动到正在解析的文件">📍 定位到正在解析的文件</button>
          {live.map((r) => <button key={r.task_id} className="btn small" onClick={() => api.pauseTask(r.task_id).then(app.refreshTasks)} title={`暂停任务 #${r.task_id}（可从断点继续）`}>⏸ 暂停 #{r.task_id}</button>)}
          <label className="chk" title="正在解析的文件切换时自动定位"><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> 跟随</label>
        </>}
        <div className="spacer" />
        <button className="btn small" disabled={!target} title={target ? target.path : ''} onClick={() => api.showItem(target.path)}>📂 在资源管理器中显示</button>
        <span className="badge">已选 {sel.size}</span>
        <button className="btn primary" disabled={!sel.size} onClick={() => setDlg(picked.map((r) => ({ ...r, link_path: r.path })))}>重新解析所选…</button>
      </div>
      <DataTable id="history" sessionKey={skey} rows={all} onRowClick={(r) => setCur({ hid: r.hid, path: r.path })} rowKey={(r) => r.hid} selectable selected={sel} onSelect={setSel} selectableRow={(r) => !r.live} rowClass={(r) => (r.live ? 'row-live' : '')} defaultSort={{ k: 'at', d: -1 }} empty="还没有解析记录" columns={[
        { key: 'at', label: '时间', sort: (r) => r.at, className: 'small nowrap', render: (r) => fmtTime(r.at) },
        { key: 'task', label: '任务', sort: (r) => r.task_id, className: 'small', render: (r) => `#${r.task_id} ${r.task_name || '（已删除）'}` },
        { key: 'action', label: '结果', sort: (r) => ACTION_LABEL[r.action] || r.action, render: (r) => (r.live ? <span className="status s-running live-pulse">⏳ 解析中</span> : <span className={`tag act-${r.action}`}>{ACTION_LABEL[r.action] || r.action}</span>) },
        { key: 'kind', label: '类型', render: (r) => KIND_LABEL[r.kind] || '' },
        { key: 'path', label: '文件', className: 'small', render: (r) => (r.live ? <span className="link" title="查看解析动态" onClick={() => app.go({ type: 'monitor', tab: 'live', taskId: r.task_id })}>{r.path}</span> : <span className="link" title={r.path} onClick={() => r.file_id && app.openFile(r.file_id)}>{r.path}</span>) },
        { key: 'slide_count', label: '页/节', sort: (r) => r.slide_count || 0, render: (r) => r.slide_count || '' },
        { key: 'size', label: '大小', sort: (r) => r.size || 0, className: 'nowrap', render: (r) => fmtSize(r.size) },
        { key: 'author', label: '作者' },
        { key: 'mtime', label: '修改时间', sort: (r) => r.mtime || 0, className: 'small nowrap', render: (r) => fmtTime(r.mtime), hidden: true },
        { key: 'message', label: '说明', className: 'small muted' },
        { key: 'ops', label: '位置', nosort: true, nofilter: true, className: 'nowrap', render: (r) => <button className="btn tiny" title="在资源管理器中显示并选中该文件" onClick={(e) => { e.stopPropagation(); setCur({ hid: r.hid, path: r.path }); api.showItem(r.path); }}>📂</button> },
      ]} />
      {dlg && <ReparseDialog files={dlg} onClose={() => { setDlg(null); setSel(new Set()); }} />}
    </div>
  );
}
