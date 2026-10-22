import React, { useEffect, useState } from 'react';
import { api, fmtSize, fmtTime, KIND_LABEL } from '../api';
import { useApp } from '../ctx';
import DataTable from './DataTable';

/** 列表中“移到回收站”按钮 + 确认框。ids：选中的文件 id；done：完成后回调 */
export function RecycleButton({ ids, done, label = '🗑 移到回收站' }) {
  const [open, setOpen] = useState(false);
  if (!ids.length) return null;
  return (
    <>
      <button className="btn small danger-btn" onClick={() => setOpen(true)}>{label}（{ids.length}）</button>
      {open && <RecycleDialog ids={ids} onClose={(ok) => { setOpen(false); if (ok && done) done(); }} />}
    </>
  );
}

function RecycleDialog({ ids, onClose }) {
  const app = useApp();
  const [moveFile, setMoveFile] = useState(false);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      const r = await api.recycleFiles(ids, { moveFile });
      app.toast(`已移到回收站：${r.ok} 个${r.errors.length ? `；失败 ${r.errors.length} 个：${r.errors.join('；')}` : ''}`, r.errors.length ? 'error' : 'info');
      app.bump();
      onClose(true);
    } catch (e) { app.toast(e.message, 'error'); onClose(false); } finally { setBusy(false); }
  };
  return (
    <div className="overlay" onClick={() => onClose(false)}>
      <div className="modal" style={{ width: 'min(560px, 92vw)' }} onClick={(e) => e.stopPropagation()}>
        <div className="detail-head"><div className="dh-title">🗑 移到回收站（{ids.length} 个文档）</div></div>
        <div className="pad">
          <label className="radio-row"><input type="radio" checked={!moveFile} onChange={() => setMoveFile(false)} /> <div><b>仅从资料库移除</b><div className="muted small">原文件保持不动，只把它的解析结果移出资料库与检索；彻底删除时也只清理解析数据。</div></div></label>
          <label className="radio-row"><input type="radio" checked={moveFile} onChange={() => setMoveFile(true)} /> <div><b>连同原文件一起移入回收站</b><div className="muted small">原文件从所在目录移动到本工具的回收站目录，可随时还原到原位置；在回收站中“彻底删除”后才真正删除。</div></div></label>
          <div className="muted small">若移除的是一组重复文件中的“主文件”，其重复副本会自动接替成为主文件，解析结果不丢失。</div>
        </div>
        <div className="detail-head"><div className="spacer" /><button className="btn" onClick={() => onClose(false)}>取消</button><button className="btn primary" disabled={busy} onClick={go}>{busy ? '处理中…' : '移到回收站'}</button></div>
      </div>
    </div>
  );
}

// 回收站：还原 / 彻底删除 / 清空
export default function RecycleView() {
  const app = useApp();
  const [rows, setRows] = useState([]);
  const [sel, setSel] = useState(() => new Set());
  const load = () => api.recycleList().then((r) => { setRows(r); setSel(new Set()); });
  useEffect(() => { load(); }, [app.taskTick]);
  const picked = [...sel];
  const restore = async (ids) => {
    const r = await api.restoreRecycled(ids);
    app.toast(`已还原 ${r.ok} 个${r.errors.length ? `；失败：${r.errors.join('；')}` : ''}`, r.errors.length ? 'error' : 'info');
    app.bump(); load();
  };
  const purge = async (ids) => {
    const moved = rows.filter((r) => ids.includes(r.id) && r.moved).length;
    if (!confirm(`彻底删除 ${ids.length} 个文档？${moved ? `\n其中 ${moved} 个回收站中的文件会被永久删除，无法恢复。` : ''}\n（“仅从资料库移除”的文档只清理解析数据，原文件不动）`)) return;
    const r = await api.purgeRecycled(ids);
    app.toast(`已彻底删除 ${r.ok} 个${r.errors.length ? `；失败：${r.errors.join('；')}` : ''}`, r.errors.length ? 'error' : 'info');
    app.bump(); load();
  };
  const columns = [
    { key: 'name', label: '文件名' },
    { key: 'kind', label: '类型', render: (r) => KIND_LABEL[r.kind || 'ppt'] },
    { key: 'orig_path', label: '原位置', className: 'small', render: (r) => <span title={r.orig_path}>{r.orig_path}</span> },
    { key: 'moved', label: '方式', sort: (r) => r.moved, render: (r) => (r.moved ? <span className="tag warn">原文件已移入回收站</span> : <span className="tag">仅移出资料库</span>) },
    { key: 'slide_count', label: '页数', sort: (r) => r.slide_count || 0 },
    { key: 'size', label: '大小', sort: (r) => r.size || 0, render: (r) => fmtSize(r.size), className: 'nowrap' },
    { key: 'at', label: '移入时间', sort: (r) => r.at, render: (r) => fmtTime(r.at), className: 'small nowrap' },
    { key: 'exists', label: '文件状态', sort: (r) => (r.exists ? 1 : 0), render: (r) => (r.exists ? '存在' : <span className="danger">已丢失</span>) },
    { key: 'bin_path', label: '回收站位置', hidden: true, className: 'small' },
    { key: 'ops', label: '操作', nosort: true, className: 'nowrap', render: (r) => <><button className="btn tiny" onClick={() => restore([r.id])}>还原</button><button className="btn tiny" onClick={() => purge([r.id])}>彻底删除</button></> },
  ];
  return (
    <div className="view">
      <div className="view-head">
        <div className="vh-title">🗑 回收站 <span className="muted small">{rows.length} 个文档</span></div>
        <div className="spacer" />
        <button className="btn ghost" disabled={!rows.length} onClick={() => purge(rows.map((r) => r.id))}>清空回收站</button>
      </div>
      <div className="tab-body pad">
        <DataTable id="recycle" columns={columns} rows={rows} selectable selected={sel} onSelect={setSel} defaultSort={{ k: 'at', d: -1 }} empty="回收站是空的"
          actions={picked.length ? <><button className="btn small" onClick={() => restore(picked)}>还原所选</button><button className="btn small danger-btn" onClick={() => purge(picked)}>彻底删除所选</button></> : null} />
      </div>
    </div>
  );
}
