import React, { useEffect, useMemo, useState } from 'react';
import { api, fmtTime, on } from '../api';
import { useApp } from '../ctx';
import DataTable from './DataTable';
import { StatCards } from './DrillDialog';
import { ColorPick, TAG_COLORS } from './TagEditor';
import { refreshTags } from '../tagStore';

const SOURCE = { manual: '手动', auto: '自动', both: '自动 + 手动', none: '未使用' };
const STATE = { normal: '正常', alias: '已合并', blocked: '已删除' };
const OP = { tag: '加 / 去标签', def: '修改标签', rename: '重命名', merge: '合并', block: '删除', restore: '恢复' };
const MEMO = { tab: 'tags', state: 'normal' };

/** 小对话框：新建 / 编辑标签（名称、颜色、说明），或输入合并后的名称 */
function TagForm({ title, init, names, onSubmit, onClose, nameOnly }) {
  const [name, setName] = useState(init.name || '');
  const [color, setColor] = useState(init.color || '');
  const [note, setNote] = useState(init.note || '');
  const exists = name.trim() && name.trim() !== init.name && names.includes(name.trim());
  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal tag-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="detail-head"><div className="dh-title">{title}</div><div className="spacer" /><button className="icon-btn" onClick={onClose}>✕</button></div>
        <div className="tag-dialog-body">
          <div className="td-label">名称</div>
          <input className="input" list="tag-all-names" autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && name.trim() && onSubmit({ name: name.trim(), color, note })} />
          <datalist id="tag-all-names">{names.slice(0, 500).map((n) => <option key={n} value={n} />)}</datalist>
          {exists && <div className="small warn-text">已有同名标签，保存后将合并到“{name.trim()}”</div>}
          {!nameOnly && <>
            <div className="td-label">颜色</div>
            <ColorPick value={color} onChange={setColor} />
            <div className="td-label">说明</div>
            <input className="input" value={note} onChange={(e) => setNote(e.target.value)} />
          </>}
        </div>
        <div className="tag-dialog-foot"><div className="spacer" /><button className="btn" onClick={onClose}>取消</button><button className="btn primary" disabled={!name.trim()} onClick={() => onSubmit({ name: name.trim(), color, note })}>保存</button></div>
      </div>
    </div>
  );
}

/**
 * 总览分析 → 🏷 标签管理（v3.14）：全部标签（自动 + 手动）的目录，文档数可下钻；
 * 新建、编辑（重命名 / 颜色 / 说明）、合并、删除（屏蔽，以后重新计算也不再出现）、恢复；每次修改记入“操作记录”，可依次撤销。
 */
export default function TagsView() {
  const app = useApp();
  const [tab, setTabState] = useState(app.view && app.view.tab ? app.view.tab : MEMO.tab);
  const setTab = (t) => { MEMO.tab = t; setTabState(t); };
  useEffect(() => { if (app.view && app.view.tab) setTab(app.view.tab); }, [app.view]);
  const [cat, setCat] = useState(null);
  const [ops, setOps] = useState([]);
  const [state, setStateF] = useState(MEMO.state);
  const [sel, setSel] = useState(() => new Set());
  const [form, setForm] = useState(null);
  const [colorFor, setColorFor] = useState(null);
  const load = () => { api.tagCatalog().then(setCat).catch((e) => app.toast(e.message, 'error')); api.tagOps().then(setOps).catch(() => {}); };
  useEffect(() => { load(); const off = on('library', load); return off; }, []);
  const rows = useMemo(() => (cat || []).filter((t) => (state === 'all' ? true : state === 'normal' ? t.state === 'normal' : t.state !== 'normal')), [cat, state]);
  const picked = rows.filter((t) => sel.has(t.name));
  const names = (cat || []).filter((t) => t.state === 'normal').map((t) => t.name);
  const run = async (p, keepSel = false) => {
    try {
      const r = await p;
      if (r && r.title) app.toast(`${r.title}${r.files !== undefined ? `（${r.files} 个文档）` : ''}`, 'info', { cat: '标签', label: '撤销 / 查看记录', link: { type: 'view', view: { type: 'tags', tab: 'ops' } } });
      if (!keepSel) setSel(new Set());
      refreshTags(); load();
    } catch (e) { app.toast(e.message, 'error', { cat: '标签' }); }
  };
  const drill = (t) => app.drill({ key: `tag-${t.name}`, title: `标签：${t.name}`, load: () => api.tagFileRows(t.name) });
  const edit = (t) => setForm({ title: `✏ 编辑标签：${t.name}`, init: t, submit: async (v) => {
    setForm(null);
    await run(api.tagEdit(t.name, v));
  } });
  const cols = [
    { key: 'name', label: '标签', render: (t) => <span className={`tag ${t.color ? `tc-${t.color}` : ''}`} onDoubleClick={() => t.state === 'normal' && edit(t)}>{t.name}</span> },
    { key: 'files', label: '文档数', type: 'number', render: (t) => (t.files ? <span className="link" onClick={() => drill(t)}>{t.files}</span> : 0) },
    { key: 'source', label: '来源', className: 'nowrap', sort: (t) => t.source, filterValue: (t) => SOURCE[t.source], render: (t) => SOURCE[t.source] },
    { key: 'manual', label: '手动添加', type: 'number' },
    { key: 'auto', label: '自动识别', type: 'number' },
    { key: 'hidden', label: '已去掉', type: 'number' },
    { key: 'state', label: '状态', className: 'nowrap', sort: (t) => t.state, filterValue: (t) => STATE[t.state], render: (t) => (t.state === 'alias' ? <span className="tag">→ {t.alias_of}</span> : t.state === 'blocked' ? <span className="tag warn">已删除</span> : '正常') },
    { key: 'note', label: '说明', className: 'small' },
    { key: 'updated_at', label: '修改时间', type: 'date', render: (t) => (t.updated_at ? fmtTime(t.updated_at) : '') },
    { key: 'ops', label: '操作', nosort: true, nofilter: true, className: 'nowrap', render: (t) => (t.state === 'normal' ? <button className="btn tiny ghost" onClick={() => edit(t)}>✏ 编辑</button> : <button className="btn tiny" onClick={() => run(api.tagRestore([t.name]))}>↺ 恢复</button>) },
  ];
  const lastOpen = ops.find((o) => !o.undone);
  const opCols = [
    { key: 'at', label: '时间', type: 'date', render: (o) => fmtTime(o.at) },
    { key: 'op', label: '类型', className: 'nowrap', filterValue: (o) => OP[o.op] || o.op, render: (o) => OP[o.op] || o.op },
    { key: 'title', label: '内容' },
    { key: 'files', label: '文档数', type: 'number' },
    { key: 'undone', label: '状态', className: 'nowrap', filterValue: (o) => (o.undone ? '已撤销' : '有效'), render: (o) => (o.undone ? <span className="tag">已撤销</span> : '有效') },
    { key: 'ops', label: '操作', nosort: true, nofilter: true, className: 'nowrap', render: (o) => (lastOpen && o.id === lastOpen.id ? <button className="btn tiny" onClick={() => confirm(`撤销“${o.title}”？`) && run(api.tagUndo(o.id).then((r) => ({ title: `已撤销：${r.title}` })))}>↶ 撤销</button> : null) },
  ];
  const c = cat || [];
  const normal = c.filter((t) => t.state === 'normal');
  const cards = [
    ['标签', normal.length, () => { setStateF('normal'); MEMO.state = 'normal'; }],
    ['手动添加的标签', normal.filter((t) => t.manual).length, () => { setStateF('normal'); MEMO.state = 'normal'; }],
    ['已删除 / 已合并', c.length - normal.length, () => { setStateF('other'); MEMO.state = 'other'; }],
    ['操作记录', ops.length, () => setTab('ops')],
  ];
  return (
    <div className="view">
      <div className="view-head">
        <div className="vh-title">🏷 标签管理</div>
        <div className="spacer" />
        <button className="btn primary" onClick={() => setForm({ title: '＋ 新建标签', init: {}, submit: (v) => { setForm(null); run(api.tagSaveDef(v.name, { color: v.color, note: v.note }).then(() => ({ title: `新建标签 ${v.name}` }))); } })}>＋ 新建标签</button>
      </div>
      <div className="tabs">
        <button className={tab === 'tags' ? 'on' : ''} onClick={() => setTab('tags')}>🏷 标签（{normal.length}）</button>
        <button className={tab === 'ops' ? 'on' : ''} onClick={() => setTab('ops')}>🕘 操作记录（{ops.length}）</button>
      </div>
      <div className="tab-body pad flex-col tags-body">
        {tab === 'tags' && <>
          <StatCards cards={cards} onDrill={(k, f) => f()} />
          <DataTable id="tagCatalog" columns={cols} rows={rows} rowKey={(t) => t.name} defaultSort={{ k: 'files', d: -1 }} empty={cat ? '没有标签' : '加载中…'}
            selectable selected={sel} onSelect={setSel}
            toolbar={<div className="seg">{[['normal', '正常'], ['other', '已删除 / 已合并'], ['all', '全部']].map(([k, l]) => <button key={k} className={state === k ? 'on' : ''} onClick={() => { MEMO.state = k; setStateF(k); setSel(new Set()); }}>{l}</button>)}</div>}
            actions={<>
              <button className="btn small" disabled={picked.length !== 1 || picked[0].state !== 'normal'} onClick={() => edit(picked[0])}>✏ 编辑</button>
              <button className="btn small" disabled={picked.length < 2 || picked.some((t) => t.state !== 'normal')} onClick={() => setForm({ title: `⧉ 合并 ${picked.length} 个标签`, nameOnly: true, init: { name: [...picked].sort((a, b) => b.files - a.files)[0].name }, submit: (v) => { setForm(null); run(api.tagRename(picked.map((t) => t.name), v.name)); } })}>⧉ 合并</button>
              <span className="color-menu"><button className="btn small" disabled={!picked.length || picked.some((t) => t.state !== 'normal')} onClick={() => setColorFor(colorFor ? null : picked.map((t) => t.name))}>🎨 颜色</button>
                {colorFor && <span className="color-pop"><ColorPick value="" onChange={(col) => { const list = colorFor; setColorFor(null); run(Promise.all(list.map((n) => api.tagSaveDef(n, { color: col }))).then(() => ({ title: `设置 ${list.length} 个标签的颜色` })), true); }} /></span>}
              </span>
              <button className="btn small" disabled={!picked.length || picked.some((t) => t.state !== 'normal')} onClick={() => confirm(`删除所选的 ${picked.length} 个标签？\n\n所有文档都不再显示这些标签，以后重新识别出的同名标签也不显示；可在“操作记录”中撤销，或在“已删除 / 已合并”中恢复。`) && run(api.tagBlock(picked.map((t) => t.name)))}>🗑 删除</button>
              <button className="btn small" disabled={!picked.length || picked.some((t) => t.state === 'normal')} onClick={() => run(api.tagRestore(picked.map((t) => t.name)))}>↺ 恢复</button>
            </>} />
        </>}
        {tab === 'ops' && <DataTable id="tagOps" columns={opCols} rows={ops} rowKey={(o) => o.id} empty="还没有修改过标签" />}
      </div>
      {form && <TagForm title={form.title} init={form.init} names={names} nameOnly={form.nameOnly} onSubmit={form.submit} onClose={() => setForm(null)} />}
    </div>
  );
}
export { TAG_COLORS };
