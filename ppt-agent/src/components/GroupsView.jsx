import React, { useEffect, useState } from 'react';
import { api, fmtSize, fmtTime, THEME_LABEL } from '../api';
import { useApp } from '../ctx';
import DataTable from './DataTable';
import { RecycleButton } from './Recycle';

// 内容相近的 PPT 分组：先比较（归一化后的）标题，再比较内容向量；支持按名称或大小排序
export default function GroupsView() {
  const app = useApp();
  const [sort, setSort] = useState('name');
  const [order, setOrder] = useState('asc');
  const [groups, setGroups] = useState([]);
  const [onlyTheme, setOnlyTheme] = useState(false);
  useEffect(() => { api.groups({ sort, order }).then(setGroups); }, [sort, order, app.taskTick]);
  const list = onlyTheme ? groups.filter((g) => g.hasThemeVariants) : groups;
  const [sel, setSel] = useState(() => new Set());
  const memberCols = [
    { key: 'name', label: '文件名', sort: (m) => m.file.name, render: (m) => <span className="link" onClick={() => app.openFile(m.file.id)}>{m.file.name}{m.file.status === 'duplicate' && <span className="tag warn">重复</span>}</span> },
    { key: 'dir', label: '目录', sort: (m) => m.file.dir, className: 'muted small ellipsis', render: (m) => <span title={m.file.dir}>{m.file.dir}</span> },
    { key: 'size', label: '大小', sort: (m) => m.file.size || 0, className: 'nowrap', render: (m) => fmtSize(m.file.size) },
    { key: 'pages', label: '页数', sort: (m) => m.file.slide_count || 0, render: (m) => m.file.slide_count },
    { key: 'theme', label: '底色', sort: (m) => m.file.theme, render: (m) => <span className={`tag theme-${m.file.theme}`}>{THEME_LABEL[m.file.theme]}</span> },
    { key: 'mtime', label: '修改时间', sort: (m) => m.file.mtime || 0, className: 'small nowrap', render: (m) => fmtTime(m.file.mtime) },
    { key: 'author', label: '作者', sort: (m) => m.file.author, render: (m) => m.file.author, hidden: true },
    { key: 'score', label: '相似度', sort: (m) => m.score, render: (m) => `${Math.round(m.score * 100)}%` },
    { key: 'reasons', label: '依据', sort: (m) => m.reasons.join('、'), className: 'small', render: (m) => m.reasons.join('、') },
    { key: 'ops', label: '操作', nosort: true, className: 'nowrap', render: (m) => <><button className="btn tiny" onClick={() => api.openPath(m.file.path)}>打开</button><button className="btn tiny" onClick={() => api.showItem(m.file.path)}>位置</button></> },
  ];
  return (
    <div className="view">
      <div className="view-head">
        <div className="vh-title">🧩 相似 PPT 分组 <span className="muted small">{list.length} 组 · 判定顺序：标题相同 → 内容相似</span></div>
        <div className="spacer" />
        {sel.size > 0 && <span className="badge">已选 {sel.size}</span>}
        <RecycleButton ids={[...sel]} done={() => setSel(new Set())} />
        <label className="chk"><input type="checkbox" checked={onlyTheme} onChange={(e) => setOnlyTheme(e.target.checked)} /> 仅看含黑白底版本的分组</label>
        <span className="muted">排序</span>
        <div className="seg">
          <button className={sort === 'name' ? 'on' : ''} onClick={() => setSort('name')}>按名称</button>
          <button className={sort === 'size' ? 'on' : ''} onClick={() => setSort('size')}>按大小</button>
        </div>
        <div className="seg">
          <button className={order === 'asc' ? 'on' : ''} onClick={() => setOrder('asc')}>升序</button>
          <button className={order === 'desc' ? 'on' : ''} onClick={() => setOrder('desc')}>降序</button>
        </div>
      </div>
      <div className="tab-body scroll pad">
        {!list.length && <div className="empty-tip">暂无相似分组（解析更多 PPT 后自动生成）</div>}
        {list.map((g) => (
          <div key={g.id} className="group-card">
            <div className="gc-head">
              <b>{g.title}</b>
              <span className="muted small">{g.members.length} 个文件 · 共 {fmtSize(g.totalSize)}</span>
              {g.reasons.map((r) => <span key={r} className="tag accent">{r}</span>)}
              {g.hasThemeVariants && <span className="tag theme-dark">含黑底/白底版本</span>}
            </div>
            <DataTable id="groupMembers" columns={memberCols} rows={g.members} rowKey={(m) => m.file.id} selectable
              selected={new Set(g.members.map((m) => m.file.id).filter((id) => sel.has(id)))}
              onSelect={(n) => { const next = new Set([...sel].filter((id) => !g.members.some((m) => m.file.id === id))); for (const id of n) next.add(id); setSel(next); }}
              actions={null} />
          </div>
        ))}
      </div>
    </div>
  );
}
