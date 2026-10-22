import React, { useEffect, useState } from 'react';
import { api, fmtSize, fmtTime, KIND_LABEL, unitOf } from '../api';
import { useApp } from '../ctx';
import DataTable from './DataTable';

const base = (p) => String(p || '').split(/[\\/]/).pop();
const KIND_OF_EXT = (p) => (/\.pdf$/i.test(p) ? 'pdf' : /\.docx?$|\.docm$/i.test(p) ? 'word' : 'ppt');
// 会话内保留已选文件
let PICKED = [];

/**
 * 智能模块 → 智能合成（建设中）：选择多个本机文件，或从已解析的资料库中选择整个文件，
 * 分析内容后智能合并，遇到冲突（同一内容的不同版本、黑白底不一致、讲解词不同等）提示用户选择。
 * 当前已实现“选择文件”，分析与合并在建设中。
 */
export default function MergeView() {
  const app = useApp();
  const [files, setFilesState] = useState(PICKED);
  const setFiles = (f) => { PICKED = typeof f === 'function' ? f(PICKED) : f; setFilesState(PICKED); };
  const [picker, setPicker] = useState(false);
  const [sel, setSel] = useState(() => new Set());
  const add = (list) => setFiles((cur) => { const seen = new Set(cur.map((x) => x.path)); return [...cur, ...list.filter((x) => x && x.path && !seen.has(x.path))]; });
  const upload = async () => {
    const paths = await api.selectFiles('选择要合成的文件（PPT / Word / PDF，可多选）', 'docs');
    add((paths || []).map((p) => ({ path: p, name: base(p), kind: KIND_OF_EXT(p), source: 'upload' })));
  };
  const step = files.length >= 2 ? 2 : 1;
  const cols = [
    { key: 'name', label: '文件', render: (f) => (f.id ? <span className="link" title={f.path} onClick={() => app.openFile(f.id)}>{f.name}</span> : <span title={f.path}>{f.name}</span>) },
    { key: 'source', label: '来源', sort: (f) => f.source, filterValue: (f) => (f.source === 'library' ? '资料库' : '本机文件'), className: 'nowrap', render: (f) => (f.source === 'library' ? <span className="tag ok">资料库</span> : <span className="tag">本机文件（待入库）</span>) },
    { key: 'kind', label: '类型', sort: (f) => f.kind, render: (f) => KIND_LABEL[f.kind || 'ppt'] },
    { key: 'slide_count', label: '页数', type: 'number', sort: (f) => f.slide_count || 0, render: (f) => (f.slide_count ? `${f.slide_count} ${unitOf(f)}` : '') },
    { key: 'dir', label: '目录', className: 'muted small', sort: (f) => f.path, render: (f) => <span title={f.path}>{String(f.path).replace(/[\\/][^\\/]*$/, '')}</span> },
    { key: 'ops', label: '操作', nosort: true, nofilter: true, className: 'nowrap', render: (f) => <><button className="btn tiny" onClick={() => api.showItem(f.path)}>📂 位置</button><button className="btn tiny" onClick={() => setFiles((cur) => cur.filter((x) => x.path !== f.path))}>移除</button></> },
  ];
  return (
    <div className="view">
      <div className="view-head">
        <div className="vh-title">🧬 智能合成 <span className="wip">建设中</span></div>
        <div className="spacer" />
        <button className="btn" onClick={upload}>📁 上传文件…</button>
        <button className="btn" onClick={() => setPicker(true)}>🗂 从资料库选择</button>
      </div>
      <div className="tab-body pad flex-col merge-body">
        <div className="gen-steps">{['选择文件', '内容分析', '智能合并（冲突提示选择）', '生成合成文件'].map((t, k) => <span key={t} className={`gs ${step === k + 1 ? 'on' : step > k + 1 ? 'done' : ''}`}><b>{step > k + 1 ? '✓' : k + 1}</b>{t}</span>)}</div>
        <DataTable id="mergeFiles" columns={cols} rows={files} rowKey={(f) => f.path} selectable selected={sel} onSelect={setSel} empty="还没有选择文件：点击右上角“📁 上传文件…”或“🗂 从资料库选择”"
          actions={<><button className="btn small" disabled={!sel.size} onClick={() => { setFiles((cur) => cur.filter((x) => !sel.has(x.path))); setSel(new Set()); }}>移除所选</button><button className="btn small ghost" disabled={!files.length} onClick={() => { setFiles([]); setSel(new Set()); }}>清空</button></>} />
        <div className="merge-foot">
          <span className="badge">已选 {files.length} 个文件</span>
          <div className="spacer" />
          <button className="btn primary" disabled title="建设中">🧬 分析并智能合并 <span className="wip">建设中</span></button>
        </div>
      </div>
      {picker && <LibraryPicker onClose={() => setPicker(false)} onPick={(rows) => { add(rows.map((r) => ({ ...r, source: 'library' }))); setPicker(false); app.toast(`已加入 ${rows.length} 个资料库文件`, 'info', { cat: '智能合成' }); }} exclude={new Set(files.map((f) => f.path))} />}
    </div>
  );
}

/** 从已解析的资料库中选择整个文件（多选） */
function LibraryPicker({ onClose, onPick, exclude }) {
  const [rows, setRows] = useState(null);
  const [sel, setSel] = useState(() => new Set());
  useEffect(() => { api.library({}).then((r) => setRows((r || []).filter((f) => f.status === 'parsed'))); }, []);
  const cols = [
    { key: 'name', label: '文件名', render: (f) => <span title={f.path}>{f.name}{exclude.has(f.path) ? <span className="tag"> 已选</span> : null}</span> },
    { key: 'kind', label: '类型', sort: (f) => f.kind || 'ppt', render: (f) => KIND_LABEL[f.kind || 'ppt'] },
    { key: 'slide_count', label: '页数', type: 'number', sort: (f) => f.slide_count || 0, render: (f) => `${f.slide_count || 0} ${unitOf(f)}` },
    { key: 'size', label: '大小', type: 'number', sort: (f) => f.size || 0, render: (f) => fmtSize(f.size) },
    { key: 'mtime', label: '修改时间', type: 'date', sort: (f) => f.mtime || 0, filterValue: (f) => f.mtime, className: 'small nowrap', render: (f) => fmtTime(f.mtime) },
    { key: 'dir', label: '目录', className: 'muted small', render: (f) => <span title={f.path}>{f.dir}</span> },
  ];
  const picked = (rows || []).filter((f) => sel.has(f.id));
  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal drill-modal" onClick={(e) => e.stopPropagation()}>
        <div className="detail-head"><div className="dh-title">🗂 从资料库选择文件</div><span className="muted small">{rows ? `${rows.length} 个已解析文件` : '加载中…'}</span><div className="spacer" /><button className="icon-btn" onClick={onClose}>✕</button></div>
        <div className="drill-body">{rows && <DataTable id="mergePicker" columns={cols} rows={rows} rowKey={(f) => f.id} selectable selected={sel} onSelect={setSel} selectableRow={(f) => !exclude.has(f.path)} empty="资料库中还没有已解析的文件" />}</div>
        <div className="detail-head"><div className="spacer" /><button className="btn" onClick={onClose}>取消</button><button className="btn primary" disabled={!picked.length} onClick={() => onPick(picked)}>加入所选（{picked.length}）</button></div>
      </div>
    </div>
  );
}
