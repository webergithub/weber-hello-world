import React, { useEffect, useRef, useState } from 'react';
import { fmtTime } from '../api';
import { useApp } from '../ctx';
import DataTable from './DataTable';

const KIND = { info: ['通知', 'ok'], error: ['错误', 'warn'] };
const LINK_LABEL = { task: '查看任务', tmonitor: '解析动态', search: '查看搜索结果', open: '打开文件', reveal: '打开位置', view: '前往' };

/** 维护 → 通知管理：所有历史通知（解析任务完成、搜索完成、导出完成、错误等），点击可跳转到对应界面 */
export default function NoticesView() {
  const app = useApp();
  const { notices, setNotices } = app;
  const [sel, setSel] = useState(() => new Set());
  // 打开本页时记下哪些是未读（本次仍高亮显示），并全部标为已读
  const unreadAtOpen = useRef(new Set(notices.filter((n) => !n.read).map((n) => n.id)));
  useEffect(() => { if (notices.some((n) => !n.read)) setNotices((list) => list.map((n) => (n.read ? n : { ...n, read: true }))); }, []);
  const go = (n) => { if (n.link) app.openLink(n.link); };
  const cols = [
    { key: 'at', label: '时间', type: 'date', sort: (n) => n.at, filterValue: (n) => n.at, className: 'small nowrap', render: (n) => fmtTime(n.at) },
    { key: 'cat', label: '类型', className: 'nowrap', render: (n) => <span className="tag">{n.cat || '其他'}</span> },
    { key: 'kind', label: '级别', sort: (n) => n.kind, filterValue: (n) => (KIND[n.kind] || KIND.info)[0], className: 'nowrap', render: (n) => <span className={`tag ${(KIND[n.kind] || KIND.info)[1]}`}>{(KIND[n.kind] || KIND.info)[0]}</span> },
    { key: 'msg', label: '内容', render: (n) => (n.link ? <span className="link" onClick={() => go(n)}>{n.msg}</span> : n.msg) },
    { key: 'ops', label: '操作', nosort: true, nofilter: true, className: 'nowrap', render: (n) => <>{n.link && <button className="btn tiny primary" onClick={() => go(n)}>{n.label || LINK_LABEL[n.link.type] || '前往'}</button>}<button className="btn tiny ghost" onClick={() => setNotices((l) => l.filter((x) => x.id !== n.id))}>删除</button></> },
  ];
  return (
    <div className="view">
      <div className="view-head">
        <div className="vh-title">🔔 通知管理 <span className="muted small">{notices.length} 条</span></div>
        <div className="spacer" />
        <button className="btn" disabled={!sel.size} onClick={() => { setNotices((l) => l.filter((x) => !sel.has(x.id))); setSel(new Set()); }}>删除所选（{sel.size}）</button>
        <button className="btn ghost" disabled={!notices.length} onClick={() => { if (confirm('清空全部通知？')) { setNotices([]); setSel(new Set()); } }}>清空通知</button>
      </div>
      <div className="tab-body pad flex-col">
        <DataTable id="notices" columns={cols} rows={notices} rowKey={(n) => n.id} defaultSort={{ k: 'at', d: -1 }} empty="还没有通知"
          rowClass={(n) => (unreadAtOpen.current.has(n.id) ? 'row-unread' : '')} selectable selected={sel} onSelect={setSel} />
      </div>
    </div>
  );
}
