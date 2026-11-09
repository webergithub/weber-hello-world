import React, { useEffect, useMemo, useState } from 'react';
import { api, fmtSize, fmtTime, isActive } from '../api';
import { useApp } from '../ctx';

const SORTS = [['name', '盘符 / 名称'], ['files', '文档数'], ['bytes', '大小'], ['mtime', '最近修改']];
const STATE_LABEL = { same: '未变化', changed: '有变化', new: '未处理' };
const MEMO = new Map(); // 任务 → { open, sort, dir, q, onlyChanged }（会话内记住展开与排序）
const STEP = 400; // 一次渲染的行数，滚动到底部继续显示

/**
 * 目录树（v3.12）：任务扫描到的原始文件夹结构（不拆分、不合并），每个文件夹显示子树合计的文档数、大小、最近修改时间、
 * 已解析数与变化状态（文件夹特征值）；可按盘符 / 名称、文档数、大小、最近修改排序（同级之间），关键字筛选，
 * 勾选文件夹（勾选父文件夹即包含全部子文件夹）后“分析所选”（增量，未变化的文件夹自动跳过）或“重新分析所选”（强制）。
 */
export default function DirTree({ task }) {
  const app = useApp();
  const memo = MEMO.get(task.id) || {};
  const [tree, setTree] = useState(null);
  const [open, setOpen] = useState(() => new Set(memo.open || []));
  const [sort, setSort] = useState(memo.sort || 'name');
  const [dir, setDir] = useState(memo.dir || 1);
  const [q, setQ] = useState(memo.q || '');
  const [onlyChanged, setOnlyChanged] = useState(!!memo.onlyChanged);
  const [sel, setSel] = useState(() => new Set());
  const [limit, setLimit] = useState(STEP);
  const busy = isActive(task);
  const load = () => api.taskTree(task.id).then((t) => {
    setTree(t);
    if (!MEMO.has(task.id) || !(MEMO.get(task.id).open || []).length) setOpen(new Set(t.roots.concat(t.nodes.filter((n) => n.depth <= 1).map((n) => n.path))));
  });
  useEffect(() => { load(); }, [task.id, task.status, task.finished_at]);
  useEffect(() => { if (tree) MEMO.set(task.id, { open: [...open], sort, dir, q, onlyChanged }); }, [tree, open, sort, dir, q, onlyChanged]);
  const byParent = useMemo(() => {
    const m = new Map();
    if (tree) for (const n of tree.nodes) { const k = n.parent || ''; if (!m.has(k)) m.set(k, []); m.get(k).push(n); }
    return m;
  }, [tree]);
  const nodeMap = useMemo(() => new Map((tree ? tree.nodes : []).map((n) => [n.path, n])), [tree]);
  // 关键字 / 只看有变化：保留命中的文件夹及其上级
  const visibleSet = useMemo(() => {
    if (!tree || (!q.trim() && !onlyChanged)) return null;
    const k = q.trim().toLowerCase();
    const keep = new Set();
    for (const n of tree.nodes) {
      const hit = (!k || n.path.toLowerCase().includes(k)) && (!onlyChanged || n.state === 'changed' || n.state === 'new');
      if (!hit) continue;
      let p = n.path;
      for (let g = 0; p && g < 64; g++) { keep.add(p); p = (nodeMap.get(p) || {}).parent; }
    }
    return keep;
  }, [tree, q, onlyChanged, nodeMap]);
  const cmp = (a, b) => {
    const v = sort === 'name' ? a.name.localeCompare(b.name, 'zh', { numeric: true }) : (a[sort] || 0) - (b[sort] || 0);
    return v * dir;
  };
  const rows = useMemo(() => {
    if (!tree) return [];
    const out = [];
    const walk = (k, depth) => {
      const kids = (byParent.get(k) || []).filter((n) => !visibleSet || visibleSet.has(n.path)).sort(cmp);
      for (const n of kids) {
        out.push({ ...n, depth });
        if (open.has(n.path) || (visibleSet && q.trim())) walk(n.path, depth + 1);
      }
    };
    walk('', 0);
    return out;
  }, [tree, byParent, open, sort, dir, visibleSet, q]);
  useEffect(() => { setLimit(STEP); }, [rows.length]);
  if (!tree) return <div className="empty-tip">加载中…</div>;
  if (!tree.nodes.some((n) => n.files)) {
    return (
      <div className="empty-tip">
        <p>还没有扫描目录。</p>
        <button className="btn primary" disabled={busy} onClick={() => api.startTask(task.id, { scanOnly: true }).then(app.refreshTasks).catch((e) => app.toast(e.message, 'error'))}>🔍 扫描目录</button>
      </div>
    );
  }
  // 勾选：父文件夹勾选时子文件夹显示为已包含
  const ancestorPicked = (p) => { let x = (nodeMap.get(p) || {}).parent; for (let g = 0; x && g < 64; g++) { if (sel.has(x)) return true; x = (nodeMap.get(x) || {}).parent; } return false; };
  const toggle = (p) => setSel((s) => { const n = new Set(s); if (n.has(p)) n.delete(p); else { n.add(p); for (const x of [...n]) if (x !== p && (x.startsWith(p.endsWith('\\') || p.endsWith('/') ? p : p + (p.includes('\\') ? '\\' : '/')))) n.delete(x); } return n; });
  const picked = [...sel];
  const pickedFiles = picked.reduce((a, p) => a + ((nodeMap.get(p) || {}).files || 0), 0);
  const run = async (force) => {
    if (!picked.length) return;
    if (force && !confirm(`重新分析所选的 ${picked.length} 个文件夹（${pickedFiles} 个文档）？\n\n这些文件夹中的文档会全部重新解析，不跳过未变化的文件。`)) return;
    try { await api.startTask(task.id, { dirs: picked, force }); app.refreshTasks(); app.toast(`已开始${force ? '重新分析' : '分析'}所选的 ${picked.length} 个文件夹（${pickedFiles} 个文档）`, 'info', { cat: '解析任务', label: '查看解析动态', link: { type: 'tmonitor', id: task.id } }); setSel(new Set()); }
    catch (e) { app.toast(e.message, 'error'); }
  };
  const head = (k, label, cls = '') => <th className={`${cls} sortable`} onClick={() => { if (sort === k) setDir(-dir); else { setSort(k); setDir(k === 'name' ? 1 : -1); } }}>{label}{sort === k ? (dir > 0 ? ' ▲' : ' ▼') : ''}</th>;
  const root = tree.nodes.filter((n) => !n.parent);
  const tot = root.reduce((a, n) => ({ files: a.files + n.files, bytes: a.bytes + n.bytes, changed: a.changed + n.dirs.changed + n.dirs.new }), { files: 0, bytes: 0, changed: 0 });
  const shown = rows.slice(0, limit);
  return (
    <div className="dir-tree">
      <div className="dt-toolbar dir-tree-bar">
        <input className="input" placeholder="🔎 筛选文件夹" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="chk"><input type="checkbox" checked={onlyChanged} onChange={(e) => setOnlyChanged(e.target.checked)} /> 只看有变化 / 未处理</label>
        <span className="muted small">{tree.nodes.length} 个文件夹 · {tot.files} 个文档 · {fmtSize(tot.bytes)}{tot.changed ? ` · ${tot.changed} 个文件夹有变化或未处理` : ''}{tree.scannedAt ? ` · 扫描于 ${fmtTime(tree.scannedAt)}` : ''}</span>
        <div className="spacer" />
        <button className="btn small ghost" disabled={busy} onClick={() => api.startTask(task.id, { scanOnly: true }).then(app.refreshTasks).catch((e) => app.toast(e.message, 'error'))}>🔍 重新扫描目录</button>
        {picked.length > 0 && <span className="badge">已选 {picked.length} 个文件夹 · {pickedFiles} 个文档</span>}
        <button className="btn small primary" disabled={busy || !picked.length} onClick={() => run(false)}>▶ 分析所选</button>
        <button className="btn small" disabled={busy || !picked.length} onClick={() => run(true)}>↻ 重新分析所选</button>
        {picked.length > 0 && <button className="btn small ghost" onClick={() => setSel(new Set())}>清空选择</button>}
      </div>
      <div className="table-wrap dir-tree-wrap" onScroll={(e) => { const el = e.currentTarget; if (el.scrollTop + el.clientHeight > el.scrollHeight - 200 && limit < rows.length) setLimit(limit + STEP); }}>
        <table className="grid">
          <thead><tr>
            <th className="chk-col" />
            {head('name', '文件夹（盘符 / 名称）')}
            {head('files', '文档数', 'num')}
            {head('bytes', '大小', 'num')}
            {head('mtime', '最近修改')}
            <th className="num">已解析</th>
            <th>状态</th>
            <th>操作</th>
          </tr></thead>
          <tbody>
            {shown.map((n) => {
              const kids = byParent.get(n.path);
              const hasKids = kids && kids.length > 0;
              const inherited = ancestorPicked(n.path);
              const st = n.direct ? n.state : n.dirs.changed ? 'changed' : n.dirs.new ? 'new' : 'same';
              return (
                <tr key={n.path} className={sel.has(n.path) || inherited ? 'row-sel' : ''} onDoubleClick={() => hasKids && setOpen((o) => { const x = new Set(o); if (x.has(n.path)) x.delete(n.path); else x.add(n.path); return x; })}>
                  <td className="chk-col"><input type="checkbox" checked={sel.has(n.path) || inherited} disabled={inherited} onChange={() => toggle(n.path)} /></td>
                  <td className="dir-name" style={{ paddingLeft: 8 + n.depth * 18 }} title={n.path}>
                    <span className={`caret ${hasKids ? '' : 'none'}`} onClick={() => hasKids && setOpen((o) => { const x = new Set(o); if (x.has(n.path)) x.delete(n.path); else x.add(n.path); return x; })}>{hasKids ? (open.has(n.path) || (visibleSet && q.trim()) ? '▾' : '▸') : ''}</span>
                    {n.parent ? '📁' : '💽'} {n.name}{n.direct ? <span className="muted small">（本文件夹 {n.direct} 个）</span> : null}
                  </td>
                  <td className="num"><span className="link" title="查看文档清单" onClick={() => app.drill({ key: `dir-${task.id}-${n.path}`, title: `${n.path} · 文档`, load: () => api.dirFiles(task.id, n.path) })}>{n.files}</span></td>
                  <td className="num nowrap">{fmtSize(n.bytes)}</td>
                  <td className="small nowrap">{n.mtime ? fmtTime(n.mtime) : ''}</td>
                  <td className="num">{n.parsed}</td>
                  <td className="nowrap">{st ? <span className={`tag dir-${st}`}>{STATE_LABEL[st]}</span> : ''}{!n.direct && (n.dirs.changed + n.dirs.new) ? <span className="muted small"> {n.dirs.changed + n.dirs.new} 个</span> : null}</td>
                  <td className="nowrap"><button className="btn tiny ghost" title="在资源管理器中打开该文件夹" onClick={() => api.showItem(n.path)}>📂</button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {rows.length > shown.length && <div className="dt-more">已显示 {shown.length} / {rows.length}，滚动到底部继续显示</div>}
      </div>
    </div>
  );
}
