import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { useApp } from '../ctx';

// 运行日志：全局唯一的一份日志文件，可按任务 / 级别 / 关键字过滤；任务详情中默认只显示本任务的日志
export default function LogView({ taskId }) {
  const { logLines, reloadLogs } = useApp();
  const [onlyTask, setOnlyTask] = useState(!!taskId);
  const [level, setLevel] = useState('');
  const [q, setQ] = useState('');
  const [follow, setFollow] = useState(true);
  const box = useRef(null);
  const lines = useMemo(() => logLines.filter((l) => (!onlyTask || !taskId || l.includes(`[任务#${taskId}]`))
    && (!level || l.includes(`[${level}]`)) && (!q || l.toLowerCase().includes(q.toLowerCase()))).slice(-3000), [logLines, onlyTask, level, q, taskId]);
  useEffect(() => { if (follow && box.current) box.current.scrollTop = box.current.scrollHeight; }, [lines, follow]);
  const cls = (l) => (l.includes('[ERROR]') ? 'err' : l.includes('[WARN]') ? 'warn' : l.includes('[DEBUG]') ? 'dbg' : '');
  return (
    <div className="logview">
      <div className="ws-toolbar">
        {taskId ? (
          <div className="seg small" title="日志范围">
            <button className={onlyTask ? 'on' : ''} onClick={() => setOnlyTask(true)}>本任务 #{taskId}</button>
            <button className={!onlyTask ? 'on' : ''} onClick={() => setOnlyTask(false)}>全部日志</button>
          </div>
        ) : null}
        <select className="input" value={level} onChange={(e) => setLevel(e.target.value)}>
          <option value="">全部级别</option><option value="INFO">INFO</option><option value="WARN">WARN</option><option value="ERROR">ERROR</option>
        </select>
        <input className="input" placeholder="关键字过滤" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="chk"><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> 自动滚动</label>
        <span className="muted">{lines.length} 行</span>
        <div className="spacer" />
        <button className="btn" onClick={reloadLogs}>刷新</button>
        <button className="btn" onClick={async () => api.showItem(await api.logPath())}>打开日志文件位置</button>
        <button className="btn ghost" onClick={async () => { if (confirm('确定清空运行日志？')) { await api.logClear(); reloadLogs(); } }}>清空</button>
      </div>
      <div className="log-box" ref={box}>
        {lines.map((l, i) => <div key={i} className={`log-line ${cls(l)}`}>{l}</div>)}
      </div>
    </div>
  );
}
