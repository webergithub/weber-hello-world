import React, { useState } from 'react';

const readOpen = () => { try { return localStorage.getItem('ppta.searchProgOpen') === '1'; } catch { return false; } };
const fmtMs = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);
const ICON = { done: '✓', run: '⏳', wait: '○', skip: '–' };

/**
 * 智能搜索的进度（v3.8）：进度条 + 当前阶段；“详细进度”默认折叠，展开后列出每个阶段的状态、数量与耗时。
 * prog 为主进程 searchProgress 事件（{ pct, label, done, total, elapsed, stages, finished, error }）。
 */
export default function SearchProgress({ prog }) {
  const [open, setOpenState] = useState(readOpen);
  const setOpen = (v) => { setOpenState(v); try { localStorage.setItem('ppta.searchProgOpen', v ? '1' : '0'); } catch { /* ignore */ } };
  if (!prog) return null;
  const running = !prog.finished;
  const line = prog.error ? `检索失败：${prog.error}` : running
    ? `正在检索 · ${prog.label || '准备中'}${prog.total ? `（${prog.done.toLocaleString()} / ${prog.total.toLocaleString()}）` : ''} · ${fmtMs(prog.elapsed || 0)}`
    : `检索完成 · 用时 ${fmtMs(prog.elapsed || 0)}`;
  return (
    <div className={`search-prog ${running ? 'running' : 'finished'} ${prog.error ? 'error' : ''}`}>
      <div className="sp-head">
        {running && <div className="progress sp-bar"><div style={{ width: `${Math.max(3, prog.pct || 0)}%` }} /></div>}
        {running && <span className="sp-pct">{prog.pct || 0}%</span>}
        <span className="sp-line">{line}</span>
        <button className="btn tiny ghost sp-toggle" onClick={() => setOpen(!open)}>{open ? '详细进度 ▾' : '详细进度 ▸'}</button>
      </div>
      {open && prog.stages && (
        <div className="sp-stages">
          {prog.stages.map((st) => (
            <div key={st.key} className={`sp-stage st-${st.status}`}>
              <span className="sp-ic">{ICON[st.status] || '○'}</span>
              <span className="sp-name">{st.label}</span>
              <span className="sp-count">{st.status === 'run' && st.total ? `${st.done.toLocaleString()} / ${st.total.toLocaleString()}` : st.total && st.status === 'done' ? `${st.total.toLocaleString()}` : ''}</span>
              <span className="sp-note">{st.note}</span>
              <span className="sp-ms">{st.status === 'done' ? fmtMs(st.ms) : st.status === 'skip' ? '跳过' : ''}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
