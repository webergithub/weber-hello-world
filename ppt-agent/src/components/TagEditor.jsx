import React, { useMemo, useState } from 'react';
import { api } from '../api';
import { useApp } from '../ctx';
import { useTagStore, refreshTags } from '../tagStore';

export const TAG_COLORS = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8'];
const split = (s) => String(s || '').split(/[,，;；\n]+/).map((x) => x.trim()).filter(Boolean);

/** 标签输入：已选标签为可删除的小块，输入框回车 / 逗号添加，候选来自已有标签 */
export function TagInput({ value, onChange, placeholder = '输入标签，回车添加', autoFocus }) {
  const { names, colors } = useTagStore();
  const [text, setText] = useState('');
  const add = (s) => { const n = split(s).filter((t) => !value.includes(t)); if (n.length) onChange([...value, ...n]); setText(''); };
  return (
    <div className="tag-input" onClick={(e) => { const i = e.currentTarget.querySelector('input'); if (i) i.focus(); }}>
      {value.map((t) => <span key={t} className={`tag ${colors[t] ? `tc-${colors[t]}` : ''}`}>{t}<b className="tag-x" onClick={() => onChange(value.filter((x) => x !== t))}>×</b></span>)}
      <input list="tag-names" value={text} autoFocus={autoFocus} placeholder={value.length ? '' : placeholder}
        onChange={(e) => { const v = e.target.value; if (/[,，;；]$/.test(v)) add(v); else setText(v); }}
        onKeyDown={(e) => { if (e.key === 'Enter' && text.trim()) { e.preventDefault(); add(text); } else if (e.key === 'Backspace' && !text && value.length) onChange(value.slice(0, -1)); }}
        onBlur={() => text.trim() && add(text)} />
      <datalist id="tag-names">{names.slice(0, 500).map((n) => <option key={n} value={n} />)}</datalist>
    </div>
  );
}

/** 颜色选择 */
export function ColorPick({ value, onChange }) {
  return (
    <span className="color-pick">
      <span className={`cp-dot none ${!value ? 'on' : ''}`} title="默认" onClick={() => onChange('')}>∅</span>
      {TAG_COLORS.map((c) => <span key={c} className={`cp-dot tc-${c} ${value === c ? 'on' : ''}`} onClick={() => onChange(c)} />)}
    </span>
  );
}

/** 批量编辑标签：files = 所选文档（含 tags / manual_tags），可添加新标签、勾选要去掉的已有标签 */
export function TagDialog({ files, onClose, onDone }) {
  const app = useApp();
  const { colors } = useTagStore();
  const [add, setAdd] = useState([]);
  const [remove, setRemove] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const counts = useMemo(() => {
    const m = new Map();
    for (const f of files) for (const t of f.tags || []) m.set(t, (m.get(t) || 0) + 1);
    return [...m].sort((a, b) => b[1] - a[1]);
  }, [files]);
  const apply = async () => {
    setBusy(true);
    try {
      const r = await api.tagFiles(files.map((f) => f.id), { add, remove: [...remove] });
      app.toast(`${r.title}（${r.files} 个文档）`, 'info', { cat: '标签', label: '撤销 / 查看记录', link: { type: 'view', view: { type: 'tags', tab: 'ops' } } });
      refreshTags();
      if (onDone) onDone(r);
      onClose();
    } catch (e) { app.toast(e.message, 'error', { cat: '标签' }); } finally { setBusy(false); }
  };
  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal tag-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="detail-head"><div className="dh-title">🏷 编辑标签</div><span className="muted small">{files.length} 个文档</span><div className="spacer" /><button className="icon-btn" onClick={onClose}>✕</button></div>
        <div className="tag-dialog-body">
          <div className="td-label">添加标签</div>
          <TagInput value={add} onChange={setAdd} autoFocus />
          {counts.length > 0 && <>
            <div className="td-label">去掉标签 <span className="muted small">（勾选）</span></div>
            <div className="td-current">
              {counts.map(([t, n]) => (
                <label key={t} className={`tag td-tag ${colors[t] ? `tc-${colors[t]}` : ''} ${remove.has(t) ? 'removing' : ''}`}>
                  <input type="checkbox" checked={remove.has(t)} onChange={() => setRemove((s) => { const x = new Set(s); if (x.has(t)) x.delete(t); else x.add(t); return x; })} /> {t}{files.length > 1 ? <span className="muted"> {n}</span> : null}
                </label>
              ))}
            </div>
          </>}
        </div>
        <div className="tag-dialog-foot">
          <button className="btn ghost" onClick={() => app.go({ type: 'tags' })}>🏷 标签管理</button>
          <div className="spacer" />
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn primary" disabled={busy || (!add.length && !remove.size)} onClick={apply}>{busy ? '保存中…' : '保存'}</button>
        </div>
      </div>
    </div>
  );
}

/** 文件详情抬头的标签栏：显示文档标签（手动添加带 ✎），✕ 去掉，＋ 添加 */
export function FileTagsBar({ file, onChanged }) {
  const app = useApp();
  const { colors } = useTagStore();
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState([]);
  if (!file || !file.id) return null;
  const man = new Set(file.manual_tags || []);
  const change = async (c) => {
    try {
      const r = await api.tagFiles([file.id], c);
      app.toast(r.title, 'info', { cat: '标签', label: '撤销 / 查看记录', link: { type: 'view', view: { type: 'tags', tab: 'ops' } } });
      refreshTags();
      if (onChanged) onChanged();
    } catch (e) { app.toast(e.message, 'error', { cat: '标签' }); }
  };
  return (
    <div className="file-tags">
      <span className="muted small">🏷</span>
      {(file.tags || []).map((t) => <span key={t} className={`tag ${colors[t] ? `tc-${colors[t]}` : ''} ${man.has(t) ? 'manual' : ''}`}>{t}<b className="tag-x" title="去掉" onClick={() => change({ remove: [t] })}>×</b></span>)}
      {adding ? (
        <span className="ft-add">
          <TagInput value={draft} onChange={setDraft} autoFocus />
          <button className="btn tiny primary" disabled={!draft.length} onClick={() => { change({ add: draft }); setDraft([]); setAdding(false); }}>添加</button>
          <button className="btn tiny ghost" onClick={() => { setDraft([]); setAdding(false); }}>取消</button>
        </span>
      ) : <button className="btn tiny ghost" onClick={() => setAdding(true)}>＋ 标签</button>}
    </div>
  );
}
