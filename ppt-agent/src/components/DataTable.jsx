import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

// ---------- 列筛选（参考 Excel）：文本条件 / 数字条件 / 日期条件 + 值清单 ----------
const DAY = 86400000;
const plain = (v) => (v === undefined || v === null ? '' : Array.isArray(v) ? v.join('、') : String(v));
/** 推断列类型：number | date | text（可用 col.type 指定） */
function colType(col, rows, get) {
  if (col.type) return col.type;
  let n = 0, num = 0, date = 0;
  for (const r of rows) {
    const v = get(r);
    if (v === '' || v === null || v === undefined) continue;
    n++;
    if (typeof v === 'number') { num++; if (v > 1e11 && v < 1e14) date++; }
    if (n >= 200) break;
  }
  if (!n || num / n < 0.9) return 'text';
  return date / num > 0.9 && /time|_at$|^at$|date|mtime|atime|ctime|last/i.test(col.key) ? 'date' : 'number';
}
const TEXT_OPS = [['contains', '包含'], ['notContains', '不包含'], ['eq', '等于'], ['neq', '不等于'], ['starts', '开头是'], ['ends', '结尾是'], ['empty', '为空'], ['notEmpty', '不为空']];
const NUM_OPS = [['eq', '等于'], ['neq', '不等于'], ['gt', '大于'], ['gte', '大于或等于'], ['lt', '小于'], ['lte', '小于或等于'], ['between', '介于'], ['top', '最大的前 N 项'], ['bottom', '最小的前 N 项'], ['empty', '为空'], ['notEmpty', '不为空']];
const DATE_OPS = [['today', '今天'], ['d7', '最近 7 天'], ['d30', '最近 30 天'], ['d365', '最近一年'], ['before', '早于'], ['after', '晚于'], ['between', '介于'], ['empty', '为空'], ['notEmpty', '不为空']];
const NO_VALUE = new Set(['empty', 'notEmpty', 'today', 'd7', 'd30', 'd365']);
const fmtDate = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

function matchCond(f, v, ctx) {
  const empty = v === '' || v === null || v === undefined;
  if (f.op === 'empty') return empty;
  if (f.op === 'notEmpty') return !empty;
  if (f.kind === 'text') {
    const a = plain(v).toLowerCase(), b = String(f.a || '').toLowerCase();
    if (!b) return true;
    return { contains: a.includes(b), notContains: !a.includes(b), eq: a === b, neq: a !== b, starts: a.startsWith(b), ends: a.endsWith(b) }[f.op] ?? true;
  }
  if (empty) return false;
  const x = Number(v);
  if (f.kind === 'date') {
    const now = Date.now(), start = new Date(); start.setHours(0, 0, 0, 0);
    const A = f.a ? new Date(f.a + 'T00:00:00').getTime() : null, B = f.b ? new Date(f.b + 'T23:59:59').getTime() : null;
    switch (f.op) {
      case 'today': return x >= start.getTime();
      case 'd7': return x >= now - 7 * DAY;
      case 'd30': return x >= now - 30 * DAY;
      case 'd365': return x >= now - 365 * DAY;
      case 'before': return A === null || x < A;
      case 'after': return A === null || x > new Date(f.a + 'T23:59:59').getTime();
      case 'between': return (A === null || x >= A) && (B === null || x <= B);
      default: return true;
    }
  }
  const a = f.a === '' || f.a === undefined ? null : Number(f.a), b = f.b === '' || f.b === undefined ? null : Number(f.b);
  switch (f.op) {
    case 'eq': return a === null || x === a;
    case 'neq': return a === null || x !== a;
    case 'gt': return a === null || x > a;
    case 'gte': return a === null || x >= a;
    case 'lt': return a === null || x < a;
    case 'lte': return a === null || x <= a;
    case 'between': return (a === null || x >= a) && (b === null || x <= b);
    case 'top': return ctx.top.has(x);
    case 'bottom': return ctx.bottom.has(x);
    default: return true;
  }
}
const condActive = (f) => f && f.op && (NO_VALUE.has(f.op) || (f.a !== undefined && f.a !== '') || (f.b !== undefined && f.b !== ''));
const filterActive = (f) => !!f && (condActive(f) || Array.isArray(f.values));
function describe(f, col) {
  const parts = [];
  if (condActive(f)) {
    const ops = f.kind === 'text' ? TEXT_OPS : f.kind === 'date' ? DATE_OPS : NUM_OPS;
    const name = (ops.find((o) => o[0] === f.op) || [])[1] || f.op;
    parts.push(NO_VALUE.has(f.op) ? name : f.op === 'between' ? `${name} ${f.a || '…'} ~ ${f.b || '…'}` : `${name} ${f.a}`);
  }
  if (Array.isArray(f.values)) parts.push(`选中 ${f.values.length} 个值`);
  return `${col.label}：${parts.join('，')}`;
}

/** 列筛选弹框 */
function FilterPop({ col, kind, values, value, onChange, onClose, anchor, onSort }) {
  const ref = useRef(null);
  const [q, setQ] = useState('');
  const [f, setF] = useState(() => value || { kind, op: kind === 'text' ? 'contains' : kind === 'date' ? 'd30' : 'gte', a: '', b: '' });
  const allVals = values;
  const [checked, setChecked] = useState(() => new Set(value && Array.isArray(value.values) ? value.values : allVals.map((v) => v.k)));
  const [pos, setPos] = useState({ left: anchor.left, top: anchor.bottom + 4 });
  useLayoutEffect(() => {
    const el = ref.current; if (!el) return;
    const w = el.offsetWidth, h = el.offsetHeight;
    setPos({ left: Math.max(8, Math.min(anchor.left, window.innerWidth - w - 8)), top: anchor.bottom + 4 + h > window.innerHeight ? Math.max(8, anchor.top - h - 4) : anchor.bottom + 4 });
  }, []);
  useEffect(() => {
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    const esc = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    setTimeout(() => window.addEventListener('mousedown', close), 0);
    window.addEventListener('keydown', esc, true);
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('keydown', esc, true); };
  }, []);
  const shown = allVals.filter((v) => !q || v.label.toLowerCase().includes(q.toLowerCase()));
  const ops = kind === 'text' ? TEXT_OPS : kind === 'date' ? DATE_OPS : NUM_OPS;
  const apply = () => {
    const allOn = checked.size === allVals.length;
    const out = { ...f, kind };
    if (!allOn) out.values = [...checked]; else delete out.values;
    onChange(condActive(out) || out.values ? out : null);
    onClose();
  };
  const inputType = kind === 'date' ? 'date' : kind === 'number' ? 'number' : 'text';
  return (
    <div ref={ref} className="dt-filter" style={{ left: pos.left, top: pos.top }} onClick={(e) => e.stopPropagation()}>
      <div className="df-sort">
        <button className="btn tiny" onClick={() => { onSort(1); onClose(); }}>{kind === 'text' ? '↑ 升序 A→Z' : '↑ 从小到大'}</button>
        <button className="btn tiny" onClick={() => { onSort(-1); onClose(); }}>{kind === 'text' ? '↓ 降序 Z→A' : '↓ 从大到小'}</button>
      </div>
      <div className="df-title">{kind === 'text' ? '文本筛选' : kind === 'date' ? '日期筛选' : '数字筛选'}</div>
      <div className="df-cond">
        <select className="input" value={f.op} onChange={(e) => setF({ ...f, op: e.target.value })}>{ops.map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        {!NO_VALUE.has(f.op) && <input className="input" type={inputType} value={f.a || ''} placeholder={f.op === 'top' || f.op === 'bottom' ? 'N' : '值'} autoFocus onChange={(e) => setF({ ...f, a: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && apply()} />}
        {f.op === 'between' && <><span className="muted">~</span><input className="input" type={inputType} value={f.b || ''} placeholder="值" onChange={(e) => setF({ ...f, b: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && apply()} /></>}
      </div>
      {allVals.length > 0 && (
        <>
          <div className="df-title">按值筛选（{allVals.length}{allVals.truncated ? '+' : ''}）</div>
          <input className="input df-search" placeholder="搜索值" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="df-values">
            <label className="chk"><input type="checkbox" checked={shown.every((v) => checked.has(v.k))} onChange={(e) => { const n = new Set(checked); for (const v of shown) { if (e.target.checked) n.add(v.k); else n.delete(v.k); } setChecked(n); }} /> <b>（全选{q ? '搜索结果' : ''}）</b></label>
            {shown.slice(0, 500).map((v) => (
              <label key={v.k} className="chk"><input type="checkbox" checked={checked.has(v.k)} onChange={() => { const n = new Set(checked); if (n.has(v.k)) n.delete(v.k); else n.add(v.k); setChecked(n); }} /> <span className="ellipsis">{v.label}</span><span className="muted small">{v.n}</span></label>
            ))}
          </div>
        </>
      )}
      <div className="df-foot">
        <button className="btn tiny ghost" onClick={() => { onChange(null); onClose(); }}>清除筛选</button>
        <div className="spacer" />
        <button className="btn tiny" onClick={onClose}>取消</button>
        <button className="btn tiny primary" onClick={apply}>确定</button>
      </div>
    </div>
  );
}

/**
 * 通用列表：点击任意列标题排序（升序 → 降序 → 取消），“列设置”可显示 / 隐藏列；设置按 id 记忆。
 * columns: [{ key, label, sort?: (row) => 值（默认取 row[key]）, render?: (row) => 节点, hidden?: 默认隐藏, nosort?, className?,
 *   type?: 'text' | 'number' | 'date'（筛选类型，默认自动推断）, filterValue?: (row) => 筛选用的值, filterList?: (row) => 多值（如标签，按值筛选时任一命中即可）, nofilter? }]
 * 每列标题旁 ▾ 打开筛选（排序、文本 / 数字 / 日期条件、按值勾选），工具栏有全列表关键字搜索。
 */
// 会话内记住每个列表的筛选、关键字、滚动位置与“上次查看”的行：从详情返回时恢复到原来的位置
const SESSION = new Map();

export default function DataTable({ id, sessionKey, columns, rows, rowKey = (r, i) => r.id ?? i, rowClass, onRowClick, empty = '暂无数据', defaultSort = null, toolbar = null, maxHeight, selectable = false, selected, onSelect, selectableRow = () => true, actions = null }) {
  const sk = sessionKey || id;
  const sess = useMemo(() => SESSION.get(sk) || {}, [sk]);
  const wrapRef = useRef(null);
  const [lastRow, setLastRow] = useState(sess.last ?? null);
  const restored = useRef(false);
  const storeKey = `ppta.table.${id}`;
  const saved = useMemo(() => { try { return JSON.parse(localStorage.getItem(storeKey) || '{}'); } catch { return {}; } }, [storeKey]);
  const [hidden, setHidden] = useState(() => new Set(saved.hidden || columns.filter((c) => c.hidden).map((c) => c.key)));
  const [sort, setSort] = useState(saved.sort !== undefined ? saved.sort : defaultSort);
  const [menu, setMenu] = useState(false);
  const [filters, setFilters] = useState(sess.filters || {});
  const [kw, setKw] = useState(sess.kw || '');
  useEffect(() => { SESSION.set(sk, { ...(SESSION.get(sk) || {}), filters, kw }); }, [filters, kw, sk]);
  const [pop, setPop] = useState(null);
  const menuRef = useRef(null);
  useEffect(() => { try { localStorage.setItem(storeKey, JSON.stringify({ hidden: [...hidden], sort })); } catch { /* ignore */ } }, [hidden, sort, storeKey]);
  useEffect(() => {
    if (!menu) return undefined;
    const close = (e) => { if (menuRef.current && !menuRef.current.contains(e.target)) setMenu(false); };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [menu]);

  const visible = columns.filter((c) => !hidden.has(c.key));
  // 每列用于筛选 / 排序的值：filterValue > sort > 原始字段
  const getter = (c) => c.filterValue || c.sort || ((r) => r[c.key]);
  const types = useMemo(() => Object.fromEntries(columns.map((c) => [c.key, colType(c, rows, getter(c))])), [columns, rows]);
  const filtered = useMemo(() => {
    const act = Object.entries(filters).filter(([, f]) => filterActive(f));
    const k = kw.trim().toLowerCase();
    if (!act.length && !k) return rows;
    const ctx = {};
    for (const [key, f] of act) {
      if (f.op === 'top' || f.op === 'bottom') {
        const c = columns.find((x) => x.key === key); const g = getter(c);
        const vals = rows.map(g).filter((v) => typeof v === 'number').sort((a, b) => (f.op === 'top' ? b - a : a - b)).slice(0, Math.max(1, Number(f.a) || 10));
        ctx[key] = { top: new Set(vals), bottom: new Set(vals) };
      }
    }
    return rows.filter((r) => {
      for (const [key, f] of act) {
        const c = columns.find((x) => x.key === key); if (!c) continue;
        const v = getter(c)(r);
        if (Array.isArray(f.values) && !(c.filterList ? c.filterList(r).some((x) => f.values.includes(plain(x))) : f.values.includes(plain(v)))) return false;
        if (condActive(f) && !matchCond(f, v, ctx[key] || {})) return false;
      }
      if (k && !visible.some((c) => plain(getter(c)(r)).toLowerCase().includes(k))) return false;
      return true;
    });
  }, [rows, filters, kw, columns, hidden]);
  const openFilter = (c, e) => {
    e.stopPropagation();
    const g = getter(c), kind = types[c.key];
    const m = new Map();
    for (const r of rows) { for (const v of (c.filterList ? c.filterList(r).map(plain) : [plain(g(r))])) m.set(v, (m.get(v) || 0) + 1); if (m.size > 2000) break; }
    let values = [...m.entries()].map(([k, n]) => ({ k, n, label: k === '' ? '（空白）' : kind === 'date' && k ? fmtDate(Number(k)) + (m.size < 60 ? '' : '') : k }));
    values.sort((a, b) => (kind === 'text' ? a.k.localeCompare(b.k, 'zh-CN', { numeric: true }) : Number(a.k) - Number(b.k)));
    if (kind === 'date' && values.length > 300) values = [];
    values.truncated = m.size > 2000;
    setPop({ col: c, kind, values, anchor: e.currentTarget.getBoundingClientRect() });
  };
  const nFilters = Object.values(filters).filter(filterActive).length + (kw.trim() ? 1 : 0);
  // 首次有数据时恢复滚动位置，并确保“上次查看”的行可见
  useEffect(() => {
    if (restored.current || !rows.length || !wrapRef.current) return;
    restored.current = true;
    const el = wrapRef.current;
    requestAnimationFrame(() => {
      if (sess.scroll) el.scrollTop = sess.scroll;
      if (sess.last !== undefined && sess.last !== null) {
        const row = el.querySelector(`tr[data-rk="${CSS.escape(String(sess.last))}"]`);
        if (row) { const a = row.getBoundingClientRect(), b = el.getBoundingClientRect(); if (a.top < b.top || a.bottom > b.bottom) row.scrollIntoView({ block: 'center' }); }
      }
    });
  }, [rows.length]);
  const sorted = useMemo(() => {
    const rows = filtered;
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
  }, [filtered, sort, columns]);
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
        <input className="input dt-kw" placeholder="🔎 在列表中搜索" value={kw} onChange={(e) => setKw(e.target.value)} />
        {nFilters > 0 && <button className="btn small" title="清除所有筛选条件" onClick={() => { setFilters({}); setKw(''); }}>✕ 清除筛选（{nFilters}）</button>}
        <span className="muted small">{nFilters ? `${sorted.length} / ${rows.length}` : rows.length} 条{sort ? ` · 按“${(columns.find((c) => c.key === sort.k) || {}).label}”${sort.d > 0 ? '升序' : '降序'}` : ''}</span>
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
      {nFilters > 0 && (
        <div className="dt-chips">
          {Object.entries(filters).filter(([, f]) => filterActive(f)).map(([k, f]) => { const c = columns.find((x) => x.key === k); return c ? <span key={k} className="chip">{describe(f, c)}<b onClick={() => setFilters((m) => { const n = { ...m }; delete n[k]; return n; })}>×</b></span> : null; })}
          {kw.trim() && <span className="chip">关键字：{kw}<b onClick={() => setKw('')}>×</b></span>}
        </div>
      )}
      <div className="table-wrap" ref={wrapRef} style={maxHeight ? { maxHeight } : undefined} onScroll={(e) => { SESSION.set(sk, { ...(SESSION.get(sk) || {}), scroll: e.currentTarget.scrollTop }); }}>
        <table className="grid">
          <thead>
            <tr>{selectable && <th className="sel-col"><input type="checkbox" checked={allOn} onChange={() => onSelect(allOn ? new Set() : new Set(keys))} title="全选" /></th>}{visible.map((c) => (
              <th key={c.key} className={`${c.nosort ? '' : 'sortable'} ${sort && sort.k === c.key ? 'sorted' : ''} ${filterActive(filters[c.key]) ? 'filtered' : ''} ${c.className || ''}`} onClick={() => clickHead(c)} title={c.nosort ? '' : '点击排序'}>
                <span className="th-in">{c.label}{sort && sort.k === c.key ? (sort.d > 0 ? ' ▲' : ' ▼') : ''}
                  {!c.nosort && !c.nofilter && <button className={`th-filter ${filterActive(filters[c.key]) ? 'on' : ''}`} title={filterActive(filters[c.key]) ? describe(filters[c.key], c) : '筛选'} onClick={(e) => openFilter(c, e)}>{filterActive(filters[c.key]) ? '⧩' : '▾'}</button>}</span>
              </th>
            ))}</tr>
          </thead>
          <tbody>
            {sorted.map((r, i) => (
              <tr key={rowKey(r, i)} data-rk={String(rowKey(r, i))} className={`${rowClass ? rowClass(r) : ''} ${selectable && sel.has(rowKey(r, i)) ? 'row-sel' : ''} ${lastRow !== null && String(rowKey(r, i)) === String(lastRow) ? 'row-last' : ''}`}
                onMouseDown={() => { const k = rowKey(r, i); setLastRow(k); SESSION.set(sk, { ...(SESSION.get(sk) || {}), last: k }); }} onClick={onRowClick ? () => onRowClick(r) : undefined}>
                {selectable && <td className="sel-col">{selectableRow(r) ? <input type="checkbox" checked={sel.has(rowKey(r, i))} onClick={(e) => { e.stopPropagation(); pick(rowKey(r, i), e); }} readOnly /> : null}</td>}
                {visible.map((c) => <td key={c.key} className={c.className || ''}>{c.render ? c.render(r) : r[c.key]}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && <div className="empty-tip">{empty}</div>}
        {rows.length > 0 && !sorted.length && <div className="empty-tip">没有符合筛选条件的记录 <button className="btn tiny" onClick={() => { setFilters({}); setKw(''); }}>清除筛选</button></div>}
      </div>
      {pop && <FilterPop {...pop} value={filters[pop.col.key]} onClose={() => setPop(null)} onSort={(d) => setSort({ k: pop.col.key, d })} onChange={(f) => setFilters((m) => { const n = { ...m }; if (f) n[pop.col.key] = f; else delete n[pop.col.key]; return n; })} />}
    </div>
  );
}
