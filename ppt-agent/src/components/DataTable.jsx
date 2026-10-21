import React, { useEffect, useMemo, useRef, useState } from 'react';

/**
 * 通用列表：点击任意列标题排序（升序 → 降序 → 取消），“列设置”可显示 / 隐藏列；设置按 id 记忆。
 * columns: [{ key, label, sort?: (row) => 值（默认取 row[key]）, render?: (row) => 节点, hidden?: 默认隐藏, nosort?, className? }]
 */
export default function DataTable({ id, columns, rows, rowKey = (r, i) => r.id ?? i, rowClass, onRowClick, empty = '暂无数据', defaultSort = null, toolbar = null, maxHeight, selectable = false, selected, onSelect, selectableRow = () => true, actions = null }) {
  const storeKey = `ppta.table.${id}`;
  const saved = useMemo(() => { try { return JSON.parse(localStorage.getItem(storeKey) || '{}'); } catch { return {}; } }, [storeKey]);
  const [hidden, setHidden] = useState(() => new Set(saved.hidden || columns.filter((c) => c.hidden).map((c) => c.key)));
  const [sort, setSort] = useState(saved.sort !== undefined ? saved.sort : defaultSort);
  const [menu, setMenu] = useState(false);
  const menuRef = useRef(null);
  useEffect(() => { try { localStorage.setItem(storeKey, JSON.stringify({ hidden: [...hidden], sort })); } catch { /* ignore */ } }, [hidden, sort, storeKey]);
  useEffect(() => {
    if (!menu) return undefined;
    const close = (e) => { if (menuRef.current && !menuRef.current.contains(e.target)) setMenu(false); };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [menu]);

  const visible = columns.filter((c) => !hidden.has(c.key));
  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.k);
    if (!col) return rows;
    const get = col.sort || ((r) => r[col.key]);
    const val = (r) => { const v = get(r); return v === undefined || v === null ? '' : v; };
    return [...rows].sort((a, b) => {
      const x = val(a), y = val(b);
      const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'zh-CN', { numeric: true });
      return c * sort.d;
    });
  }, [rows, sort, columns]);
  const clickHead = (c) => {
    if (c.nosort) return;
    if (!sort || sort.k !== c.key) setSort({ k: c.key, d: 1 });
    else if (sort.d === 1) setSort({ k: c.key, d: -1 });
    else setSort(null);
  };
  // 多选：selected 为 Set(rowKey)，onSelect(新 Set)
  const keys = sorted.filter(selectableRow).map((r, i) => rowKey(r, i));
  const sel = selected || new Set();
  const allOn = keys.length > 0 && keys.every((k) => sel.has(k));
  const lastKey = useRef(null);
  const pick = (k, e) => {
    const n = new Set(sel);
    if (e && e.shiftKey && lastKey.current !== null) {
      const a = keys.indexOf(lastKey.current), b = keys.indexOf(k);
      if (a >= 0 && b >= 0) { const [lo, hi] = a < b ? [a, b] : [b, a]; for (let i = lo; i <= hi; i++) n.add(keys[i]); }
    } else if (n.has(k)) n.delete(k); else n.add(k);
    lastKey.current = k;
    onSelect(n);
  };
  const toggle = (k) => { const n = new Set(hidden); if (n.has(k)) n.delete(k); else if (visible.length > 1) n.add(k); setHidden(n); };

  return (
    <div className="dt">
      <div className="dt-bar">
        {toolbar}
        {selectable && sel.size > 0 && <span className="badge">已选 {sel.size}</span>}
        {selectable && actions}
        <div className="spacer" />
        <span className="muted small">{rows.length} 条{sort ? ` · 按“${(columns.find((c) => c.key === sort.k) || {}).label}”${sort.d > 0 ? '升序' : '降序'}` : ''}</span>
        <div className="dt-menu-wrap" ref={menuRef}>
          <button className="btn small" onClick={() => setMenu(!menu)} title="显示 / 隐藏列">☰ 列设置（{visible.length}/{columns.length}）</button>
          {menu && (
            <div className="dt-menu">
              {columns.map((c) => <label key={c.key} className="chk"><input type="checkbox" checked={!hidden.has(c.key)} onChange={() => toggle(c.key)} />{c.label || c.key}</label>)}
              <div className="dt-menu-ops">
                <button className="btn tiny" onClick={() => setHidden(new Set())}>全部显示</button>
                <button className="btn tiny" onClick={() => setHidden(new Set(columns.filter((c) => c.hidden).map((c) => c.key)))}>恢复默认</button>
              </div>
            </div>
          )}
        </div>
      </div>
      <div className="table-wrap" style={maxHeight ? { maxHeight } : undefined}>
        <table className="grid">
          <thead>
            <tr>{selectable && <th className="sel-col"><input type="checkbox" checked={allOn} onChange={() => onSelect(allOn ? new Set() : new Set(keys))} title="全选" /></th>}{visible.map((c) => (
              <th key={c.key} className={`${c.nosort ? '' : 'sortable'} ${sort && sort.k === c.key ? 'sorted' : ''} ${c.className || ''}`} onClick={() => clickHead(c)} title={c.nosort ? '' : '点击排序'}>
                {c.label}{sort && sort.k === c.key ? (sort.d > 0 ? ' ▲' : ' ▼') : ''}
              </th>
            ))}</tr>
          </thead>
          <tbody>
            {sorted.map((r, i) => (
              <tr key={rowKey(r, i)} className={`${rowClass ? rowClass(r) : ''} ${selectable && sel.has(rowKey(r, i)) ? 'row-sel' : ''}`} onClick={onRowClick ? () => onRowClick(r) : undefined}>
                {selectable && <td className="sel-col">{selectableRow(r) ? <input type="checkbox" checked={sel.has(rowKey(r, i))} onClick={(e) => { e.stopPropagation(); pick(rowKey(r, i), e); }} readOnly /> : null}</td>}
                {visible.map((c) => <td key={c.key} className={c.className || ''}>{c.render ? c.render(r) : r[c.key]}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && <div className="empty-tip">{empty}</div>}
      </div>
    </div>
  );
}
