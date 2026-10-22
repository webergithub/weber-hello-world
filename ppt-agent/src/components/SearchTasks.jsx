import React, { useEffect, useState } from 'react';
import { api, fmtTime } from '../api';
import { useApp } from '../ctx';
import DataTable from './DataTable';
import { searchQueue, useSearchQueue } from '../searchQueue';

const ST = { queued: ['排队中', 'pending'], running: ['检索中', 'running'], done: ['已完成', 'done'], failed: ['失败', 'failed'] };
import { scopeText } from './SearchView';

const scopeOf = (ids, names) => scopeText(ids, names);

/** 智能搜索右侧抽屉：搜索队列（可排序）+ 搜索历史（可查看任意一次的结果） */
export default function SearchTasks({ onView, onRerun, onClose, currentId }) {
  const app = useApp();
  const qs = useSearchQueue();
  const [rows, setRows] = useState([]);
  const [sel, setSel] = useState(() => new Set());
  const load = () => api.searchHistory().then(setRows).catch(() => setRows([]));
  const doneCount = qs.items.filter((x) => x.status === 'done' || x.status === 'failed').length;
  useEffect(() => { load(); }, [doneCount]);
  const queued = qs.items.filter((x) => x.status === 'queued');
  const cols = [
    { key: 'at', label: '时间', type: 'date', sort: (h) => h.at, filterValue: (h) => h.at, className: 'small nowrap', render: (h) => fmtTime(h.at) },
    { key: 'q', label: '搜索内容', render: (h) => <span className="link" title="查看这次搜索的结果" onClick={() => onView(h.id)}>{h.q}</span> },
    { key: 'scope', label: '范围', sort: (h) => scopeOf(h.task_ids, h.task_names), filterValue: (h) => scopeOf(h.task_ids, h.task_names), className: 'small', render: (h) => scopeOf(h.task_ids, h.task_names) },
    { key: 'files', label: '文件', type: 'number', sort: (h) => h.files || 0, render: (h) => (h.status === 'failed' ? <span className="tag act-failed" title={h.error}>失败</span> : h.files) },
    { key: 'pages', label: '页面（白/黑/Word）', type: 'number', sort: (h) => (h.light || 0) + (h.dark || 0) + (h.word || 0), className: 'small nowrap', render: (h) => (h.status === 'failed' ? '' : `${h.light} / ${h.dark} / ${h.word}`) },
    { key: 'ms', label: '耗时', type: 'number', sort: (h) => h.ms || 0, className: 'small nowrap', hidden: true, render: (h) => `${h.ms || 0} ms` },
    { key: 'ops', label: '操作', nosort: true, nofilter: true, className: 'nowrap', render: (h) => <><button className="btn tiny" disabled={!h.hasResult} onClick={() => onView(h.id)}>查看结果</button><button className="btn tiny" title="用同样的条件重新搜索" onClick={() => onRerun(h)}>↻</button><button className="btn tiny" title="加入搜索队列" onClick={() => searchQueue.add(h.q, { taskIds: h.task_ids || [], taskNames: h.task_names || [], useLlm: !!h.use_llm })}>＋队列</button></> },
  ];
  return (
    <div className="search-tasks">
      <div className="st-head"><b>🗂 搜索任务与历史</b><div className="spacer" /><button className="icon-btn" onClick={onClose}>✕</button></div>
      <div className="st-sec">
        <div className="side-title">搜索队列（{queued.length} 个排队{qs.items.some((x) => x.status === 'running') ? '，1 个检索中' : ''}）<div className="spacer" />
          <button className="btn tiny" onClick={() => searchQueue.setPaused(!qs.paused)}>{qs.paused ? '▶ 继续队列' : '⏸ 暂停队列'}</button>
          <button className="btn tiny ghost" disabled={!doneCount} onClick={() => searchQueue.clearDone()}>清除已完成</button>
        </div>
        {!qs.items.length && <div className="muted small st-empty">在搜索框输入内容后点击“＋ 加入队列”，多个搜索会按顺序依次执行。</div>}
        {qs.items.map((it) => {
          const qi = queued.indexOf(it);
          return (
            <div key={it.qid} className={`sq-item ${it.status} ${it.historyId && it.historyId === currentId ? 'cur' : ''}`}>
              <span className={`status s-${ST[it.status][1]}`}>{ST[it.status][0]}</span>
              <div className="sq-main">
                <div className="ellipsis" title={it.q}><b>{it.q}</b></div>
                <div className="muted small">{scopeOf(it.opts.taskIds, it.opts.taskNames)}{it.status === 'done' ? ` · 文件 ${it.files} · 页面 ${it.light} / ${it.dark} / ${it.word}` : ''}{it.status === 'failed' ? ` · ${it.error}` : ''}</div>
              </div>
              {it.status === 'queued' && <><button className="btn tiny" disabled={qi === 0} onClick={() => searchQueue.move(it.qid, -1)}>↑</button><button className="btn tiny" disabled={qi === queued.length - 1} onClick={() => searchQueue.move(it.qid, 1)}>↓</button><button className="btn tiny" onClick={() => searchQueue.remove(it.qid)}>✕</button></>}
              {it.status === 'done' && <button className="btn tiny primary" onClick={() => onView(it.historyId)}>查看结果</button>}
              {it.status === 'failed' && <button className="btn tiny" onClick={() => searchQueue.remove(it.qid)}>✕</button>}
            </div>
          );
        })}
      </div>
      <div className="st-sec st-hist">
        <DataTable id="searchHistory" columns={cols} rows={rows} rowKey={(h) => h.id} rowClass={(h) => (h.id === currentId ? 'row-cur' : '')} defaultSort={{ k: 'at', d: -1 }} empty="还没有搜索历史"
          selectable selected={sel} onSelect={setSel}
          actions={<><button className="btn small" disabled={!sel.size} onClick={async () => { await api.searchHistoryDelete([...sel]); setSel(new Set()); load(); }}>删除所选</button>
            <button className="btn small ghost" disabled={!rows.length} onClick={async () => { if (!confirm('清空全部搜索历史？')) return; await api.searchHistoryClear(); setSel(new Set()); load(); app.toast('已清空搜索历史'); }}>清空历史</button></>} />
      </div>
    </div>
  );
}
