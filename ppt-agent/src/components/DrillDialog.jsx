import React, { useEffect, useState } from 'react';
import { api, fmtSize, fmtTime, ACTION_LABEL, KIND_LABEL, THEME_LABEL, unitOf } from '../api';
import { useApp } from '../ctx';
import DataTable from './DataTable';
import { CompareButton } from './CompareView';

const base = (p) => String(p || '').split(/[\\/]/).pop();
const pathOf = (r) => r.path || r.link_path || '';
const STATUS = { parsed: '已解析', duplicate: '重复', failed: '失败', recycled: '已在回收站' };
// 下钻清单中可按统计项突出显示的数字列（show 中列出的列放在文件名之后并显示）
const NUM_COLS = {
  slide_count: ['页数/节数', (r) => (r.slide_count ? `${r.slide_count} ${unitOf(r)}` : '')],
  dark_slides: ['黑底页', (r) => r.dark_slides || ''],
  light_slides: ['白底页', (r) => r.light_slides || ''],
  notes_count: ['含备注页', (r) => r.notes_count || ''],
  video_count: ['视频', (r) => r.video_count || ''],
  hidden_count: ['隐藏页', (r) => r.hidden_count || ''],
  subtitle_count: ['含字幕页', (r) => r.subtitle_count || ''],
};

/**
 * 统计数字下钻：点击任意统计数字打开对应的文件清单。
 * spec：{ key, title, rows | load: () => Promise<rows>, show: [列 key] }；由 App 统一渲染，从文件详情返回时重新打开并定位到原来的条目。
 */
export default function DrillDialog({ spec, onClose }) {
  const app = useApp();
  const [rows, setRows] = useState(spec.rows || null);
  const [sel, setSel] = useState(() => new Set());
  useEffect(() => { if (!spec.rows && spec.load) spec.load().then((r) => setRows(r || [])); }, [spec]);
  useEffect(() => {
    const esc = (e) => { if (e.key === 'Escape' && !document.querySelector('.dt-filter, .page-help-pop')) { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', esc, true);
    return () => window.removeEventListener('keydown', esc, true);
  }, [onClose]);
  const show = spec.show || [];
  const rk = (r, i) => pathOf(r) || r.id || i;
  const columns = [
    { key: 'state', label: '状态', sort: (r) => (r.action ? ACTION_LABEL[r.action] : STATUS[r.status]) || '', render: (r) => (r.action ? <span className={`tag act-${r.action}`}>{ACTION_LABEL[r.action] || r.action}</span> : r.status ? <span className={`tag act-${r.status}`}>{STATUS[r.status] || r.status}</span> : '') },
    { key: 'name', label: '文件名', sort: (r) => r.name || base(pathOf(r)), render: (r) => (r.id && r.status !== 'failed' ? <span className="link" title={pathOf(r)} onClick={() => app.openFile(r.id)}>{r.name || base(pathOf(r))}</span> : <span title={pathOf(r)}>{r.name || base(pathOf(r))}</span>) },
    ...show.filter((k) => NUM_COLS[k]).map((k) => ({ key: k, label: NUM_COLS[k][0], type: 'number', sort: (r) => r[k] || 0, filterValue: (r) => r[k] || 0, render: NUM_COLS[k][1] })),
    { key: 'kind', label: '类型', sort: (r) => r.kind || 'ppt', render: (r) => KIND_LABEL[r.kind || 'ppt'] },
    { key: 'dir', label: '目录', sort: (r) => r.dir || pathOf(r), className: 'muted small ellipsis', render: (r) => <span title={pathOf(r)}>{r.dir || pathOf(r).replace(/[\\/][^\\/]*$/, '')}</span> },
    ...Object.keys(NUM_COLS).filter((k) => !show.includes(k)).map((k) => ({ key: k, label: NUM_COLS[k][0], type: 'number', sort: (r) => r[k] || 0, filterValue: (r) => r[k] || 0, render: NUM_COLS[k][1], hidden: k !== 'slide_count' })),
    { key: 'theme', label: '底色', render: (r) => ((r.kind || 'ppt') === 'ppt' && r.theme ? <span className={`tag theme-${r.theme}`}>{THEME_LABEL[r.theme]}</span> : '') },
    { key: 'size', label: '大小', type: 'number', sort: (r) => r.size || 0, filterValue: (r) => Math.round(((r.size || 0) / 1048576) * 100) / 100, className: 'nowrap', render: (r) => fmtSize(r.size) },
    { key: 'author', label: '作者' },
    { key: 'mtime', label: '修改时间', type: 'date', sort: (r) => r.mtime || 0, filterValue: (r) => r.mtime, className: 'small nowrap', render: (r) => fmtTime(r.mtime) },
    { key: 'category', label: '主题分类', hidden: true },
    { key: 'tags', label: '标签', sort: (r) => (r.tags || []).join(' '), filterList: (r) => r.tags || [], className: 'tags-cell', hidden: true, render: (r) => (r.tags || []).map((t) => <span key={t} className="tag">{t}</span>) },
    { key: 'message', label: '说明', sort: (r) => r.error || r.message || '', className: 'small muted', render: (r) => r.error || r.message || '' },
    { key: 'ops', label: '操作', nosort: true, nofilter: true, className: 'nowrap', render: (r) => (pathOf(r) ? <><button className="btn tiny" onClick={() => api.openPath(pathOf(r))}>打开</button><button className="btn tiny" title="在资源管理器中显示并选中该文件" onClick={() => api.showItem(pathOf(r))}>📂 位置</button></> : null) },
  ];
  const picked = (rows || []).filter((r, i) => sel.has(rk(r, i)));
  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal drill-modal" onClick={(e) => e.stopPropagation()}>
        <div className="detail-head">
          <div className="dh-title">📋 {spec.title}</div>
          <span className="muted small">{rows ? `${rows.length} 个文件` : '加载中…'}</span>
          <div className="spacer" />
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>
        <div className="drill-body">
          {rows && <DataTable id={`drill-${show.join("-") || "base"}`} sessionKey={`drill-${spec.key || spec.title}`} columns={columns} rows={rows} rowKey={rk} defaultSort={spec.sort || { k: 'name', d: 1 }} empty="没有文件"
            selectable selected={sel} onSelect={setSel} selectableRow={(r) => !!r.id}
            actions={<><button className="btn small" disabled={picked.length !== 1 || !pathOf(picked[0])} onClick={() => api.showItem(pathOf(picked[0]))}>📂 在资源管理器中显示</button><CompareButton ids={picked.filter((r) => r.id && r.status !== 'failed').map((r) => r.id)} /></>} />}
        </div>
      </div>
    </div>
  );
}

// 统计数字下钻：打开任务中对应处理结果的文件清单
export function drillTask(app, t, label, actions) {
  app.drill({ key: `taskfiles-${t.id}-${label}`, title: `#${t.id} ${t.name} · ${label}`,
    load: () => api.taskDetail(t.id).then((d) => {
      const m = new Map(); for (const f of (d ? d.files : [])) m.set(f.link_path, f);
      return [...m.values()].filter((f) => !actions || actions.includes(f.action));
    }) });
}

/** 统计卡片：带 pick 的卡片可点击下钻；cards：[[名称, 数值, pick?, show?]] */
export function StatCards({ cards, onDrill }) {
  return (
    <div className="cards">{cards.map(([k, v, pick, show]) => (
      <div key={k} className={`card ${pick ? 'drill' : ''}`} title={pick ? '点击查看清单' : undefined} onClick={pick ? () => onDrill(k, pick, show) : undefined}>
        <div className="card-v">{v}</div><div className="card-k">{k}</div>
      </div>
    ))}</div>
  );
}
