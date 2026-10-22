import React, { useEffect, useMemo, useState } from 'react';
import { api, fmtTime } from '../api';
import { useApp } from '../ctx';
import DataTable from './DataTable';

// 字符级差异（LCS）；文本很长时退化为按行比较，避免卡顿
function diff(a, b) {
  const A = [...a], B = [...b];
  if (A.length * B.length > 2.5e6) {
    const la = a.split('\n'), lb = b.split('\n'), sb = new Set(lb), sa = new Set(la);
    return { left: la.map((t) => ({ t: t + '\n', k: sb.has(t) ? 'same' : 'del' })), right: lb.map((t) => ({ t: t + '\n', k: sa.has(t) ? 'same' : 'add' })) };
  }
  const n = A.length, m = B.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const left = [], right = [];
  const push = (arr, t, k) => { const l = arr[arr.length - 1]; if (l && l.k === k) l.t += t; else arr.push({ t, k }); };
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { push(left, A[i], 'same'); push(right, B[j], 'same'); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { push(left, A[i], 'del'); i++; } else { push(right, B[j], 'add'); j++; }
  }
  while (i < n) push(left, A[i++], 'del');
  while (j < m) push(right, B[j++], 'add');
  return { left, right };
}
const Seg = ({ parts }) => <div className="nr-text">{parts.map((p, i) => <span key={i} className={`nr-${p.k}`}>{p.t}</span>)}</div>;
const typeLabel = (c) => (c.type === 'final' ? '修正讲解词' : `译文 · ${c.langName || c.lang}`);
const clip = (s, n = 60) => { const t = String(s || '').replace(/\s+/g, ' '); return t.length > n ? t.slice(0, n) + '…' : t; };

/** 总览分析 → 完善讲解词：在本应用中修改过的讲解词（默认不改原 PPT），对比后可多选批量写回 PPT 对应页的备注 */
export default function NotesReviewView() {
  const app = useApp();
  const [tab, setTab] = useState('pending');
  const [rows, setRows] = useState([]);
  const [hist, setHist] = useState([]);
  const [sel, setSel] = useState(() => new Set());
  const [cur, setCur] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = () => { api.notesChanges().then((r) => { setRows(r); setSel((s) => new Set([...s].filter((k) => r.some((x) => x.key === k)))); }); api.notesWritebackHistory().then(setHist); };
  useEffect(() => { load(); }, [app.taskTick]);
  const curRow = rows.find((r) => r.key === cur) || rows[0] || null;
  const d = useMemo(() => (curRow ? diff(curRow.before || '', curRow.after || '') : null), [curRow && curRow.key, curRow && curRow.after]);
  const picked = rows.filter((r) => sel.has(r.key));
  const files = new Set(picked.map((r) => r.path));
  const writeBack = async () => {
    const bad = picked.filter((r) => !r.writable);
    if (!confirm(`把 ${picked.length - bad.length} 处讲解词写入 ${new Set(picked.filter((r) => r.writable).map((r) => r.path)).size} 个 PPT 文件对应页的备注？\n\n写入前每个文件都会自动备份到数据目录的 backup 文件夹；修正讲解词会替换该页备注，译文以“【语言】”段落追加。${bad.length ? `\n\n其中 ${bad.length} 处不能写回（Word / PDF / 旧版 .ppt / 原文件不存在），会跳过。` : ''}`)) return;
    setBusy(true);
    try {
      const r = await api.writeBackNotesBatch(picked.filter((x) => x.writable).map((x) => x.key));
      app.toast(`已写回 ${r.ok} 处讲解词（${r.files} 个文件，已备份原文件）${r.errors.length ? `；${r.errors.length} 个文件失败：${r.errors.map((e) => `${e.path.split(/[\\/]/).pop()}（${e.error}）`).join('；')}` : ''}`, r.errors.length ? 'error' : 'info', { label: '查看记录', link: { type: 'view', view: { type: 'notesreview' } }, cat: '讲解词' });
      setSel(new Set()); load(); app.bump();
    } catch (e) { app.toast(e.message, 'error'); } finally { setBusy(false); }
  };
  const cols = [
    { key: 'type', label: '类型', sort: typeLabel, filterValue: typeLabel, className: 'nowrap', render: (c) => <span className={`tag ${c.type === 'final' ? 'accent' : ''}`}>{typeLabel(c)}</span> },
    { key: 'file', label: '文件', sort: (c) => c.fileName, filterValue: (c) => c.fileName, render: (c) => <span className="link" title={c.path} onClick={() => app.openFile(c.fileId)}>{c.fileName}</span> },
    { key: 'idx', label: '页', type: 'number', sort: (c) => c.idx, className: 'nowrap', render: (c) => `第 ${c.idx} 页` },
    { key: 'title', label: '页面标题', className: 'small', render: (c) => c.title || '' },
    { key: 'before', label: 'PPT 中的讲解词', nofilter: true, className: 'small muted', render: (c) => clip(c.before) || <span className="muted">（空）</span> },
    { key: 'after', label: '修改后', nofilter: true, className: 'small', render: (c) => clip(c.after) },
    { key: 'at', label: '修改时间', type: 'date', sort: (c) => c.at || 0, filterValue: (c) => c.at, className: 'small nowrap', render: (c) => fmtTime(c.at) },
    { key: 'writable', label: '可写回', sort: (c) => (c.writable ? 1 : 0), filterValue: (c) => (c.writable ? '可写回' : '不可写回'), className: 'nowrap', render: (c) => (c.writable ? <span className="tag ok">可写回</span> : <span className="tag warn" title="Word / PDF 文档、旧版 .ppt 或原文件不存在">不可写回</span>) },
    { key: 'ops', label: '操作', nosort: true, nofilter: true, className: 'nowrap', render: (c) => <button className="btn tiny" onClick={(e) => { e.stopPropagation(); app.openSlide(c.slideId, [c.fileId]); }}>⛶ 查看页面</button> },
  ];
  const hcols = [
    { key: 'at', label: '写回时间', type: 'date', sort: (h) => h.at, filterValue: (h) => h.at, className: 'small nowrap', render: (h) => fmtTime(h.at) },
    { key: 'file', label: '文件', sort: (h) => h.file_name, render: (h) => <span title={h.path}>{h.file_name}</span> },
    { key: 'idx', label: '页', type: 'number', sort: (h) => h.idx, render: (h) => `第 ${h.idx} 页` },
    { key: 'kind', label: '类型', render: (h) => (h.kind === 'final' ? '修正讲解词' : `译文 · ${h.lang}`) },
    { key: 'before', label: '写回前', nofilter: true, className: 'small muted', render: (h) => clip(h.before) },
    { key: 'after', label: '写回内容', nofilter: true, className: 'small', render: (h) => clip(h.after) },
    { key: 'ops', label: '操作', nosort: true, nofilter: true, className: 'nowrap', render: (h) => <><button className="btn tiny" onClick={() => api.openPath(h.path)}>打开原文件</button>{h.backup && <button className="btn tiny" title="在资源管理器中显示写回前的备份文件" onClick={() => api.showItem(h.backup)}>📂 备份</button>}</> },
  ];
  return (
    <div className="view">
      <div className="view-head">
        <div className="vh-title">✍ 完善讲解词 <span className="muted small">{rows.length} 处待写回 · {new Set(rows.map((r) => r.path)).size} 个文件</span></div>
        <div className="spacer" />
        <div className="seg">
          <button className={tab === 'pending' ? 'on' : ''} onClick={() => setTab('pending')}>待写回（{rows.length}）</button>
          <button className={tab === 'history' ? 'on' : ''} onClick={() => setTab('history')}>写回记录（{hist.length}）</button>
        </div>
        {tab === 'pending' && <button className="btn primary" disabled={!picked.length || busy} onClick={writeBack}>{busy ? '写入中…' : `✍ 批量写入 PPT 备注（${picked.length}${picked.length ? ` 处 · ${files.size} 个文件` : ''}）`}</button>}
      </div>
      {tab === 'pending' ? (
        <div className="notes-review">
          <div className="nr-list">
            <DataTable id="notesReview" columns={cols} rows={rows} rowKey={(c) => c.key} selectable selected={sel} onSelect={setSel} defaultSort={{ k: 'at', d: -1 }}
              rowClass={(c) => (curRow && c.key === curRow.key ? 'row-cur' : '')} onRowClick={(c) => setCur(c.key)} empty="没有待写回的讲解词：在页面详情的讲解词模块中修改“修正讲解词”或保存译文后会出现在这里" />
          </div>
          {curRow && d && (
            <div className="nr-compare">
              <div className="nr-head"><b>{curRow.fileName}</b><span className="muted"> · 第 {curRow.idx} 页 {curRow.title ? `· ${curRow.title}` : ''}</span><span className={`tag ${curRow.type === 'final' ? 'accent' : ''}`}>{typeLabel(curRow)}</span>
                <div className="spacer" /><button className="btn tiny" onClick={() => app.openSlide(curRow.slideId, [curRow.fileId])}>⛶ 查看页面</button></div>
              <div className="nr-cols">
                <div className="nr-col"><div className="nr-cap">PPT 中的讲解词（原文）</div>{curRow.before ? <Seg parts={d.left} /> : <div className="muted small">（空）</div>}</div>
                <div className="nr-col"><div className="nr-cap">{curRow.type === 'final' ? '修正讲解词（写回后替换该页备注）' : `${curRow.langName} 译文（写回后以【${curRow.langName}】段落追加）`}</div><Seg parts={d.right} /></div>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="tab-body pad flex-col">
          <DataTable id="notesWriteback" columns={hcols} rows={hist} rowKey={(h) => h.id} defaultSort={{ k: 'at', d: -1 }} empty="还没有写回记录" />
        </div>
      )}
    </div>
  );
}
