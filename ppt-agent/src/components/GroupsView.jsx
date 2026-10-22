import React, { useEffect, useState } from 'react';
import { api, fmtSize, fmtTime, THEME_LABEL } from '../api';
import { useApp } from '../ctx';
import DataTable from './DataTable';
import { RecycleButton } from './Recycle';
import { CompareButton, COMPARE_MAX } from './CompareView';

// 内容相近的 PPT 分组：先比较（归一化后的）标题，再比较内容向量；支持按名称或大小排序
// 会话内记住所选分组：从文件详情返回时回到原来的分组
const MEMO = { cur: null };

export default function GroupsView({ taskId }) {
  const app = useApp();
  const [groups, setGroups] = useState([]);
  const [onlyTheme, setOnlyTheme] = useState(false);
  const [curId, setCurId] = useState(MEMO.cur);
  useEffect(() => { api.groups({ sort: 'name', order: 'asc', taskId }).then(setGroups); }, [app.taskTick, taskId]);
  const list = onlyTheme ? groups.filter((g) => g.hasThemeVariants) : groups;
  const [sel, setSel] = useState(() => new Set());
  const memberCols = [
    { key: 'name', label: '文件名', sort: (m) => m.file.name, render: (m) => <span className="link" onClick={() => app.openFile(m.file.id)}>{m.file.name}{m.file.status === 'duplicate' && <span className="tag warn">重复</span>}</span> },
    { key: 'dir', label: '目录', sort: (m) => m.file.dir, className: 'muted small ellipsis', render: (m) => <span title={m.file.dir}>{m.file.dir}</span> },
    { key: 'size', label: '大小', type: 'number', sort: (m) => m.file.size || 0, filterValue: (m) => Math.round(((m.file.size || 0) / 1048576) * 100) / 100, className: 'nowrap', render: (m) => fmtSize(m.file.size) },
    { key: 'pages', label: '页数', sort: (m) => m.file.slide_count || 0, render: (m) => m.file.slide_count },
    { key: 'theme', label: '底色', sort: (m) => m.file.theme, render: (m) => <span className={`tag theme-${m.file.theme}`}>{THEME_LABEL[m.file.theme]}</span> },
    { key: 'mtime', label: '修改时间', type: 'date', sort: (m) => m.file.mtime || 0, filterValue: (m) => m.file.mtime, className: 'small nowrap', render: (m) => fmtTime(m.file.mtime) },
    { key: 'author', label: '作者', sort: (m) => m.file.author, render: (m) => m.file.author, hidden: true },
    { key: 'score', label: '相似度', sort: (m) => m.score, render: (m) => `${Math.round(m.score * 100)}%` },
    { key: 'reasons', label: '依据', sort: (m) => m.reasons.join('、'), filterList: (m) => m.reasons, className: 'small ellipsis', render: (m) => <span title={m.reasons.join('、')}>{m.reasons.join('、')}</span> },
    { key: 'ops', label: '操作', nosort: true, nofilter: true, className: 'nowrap', render: (m) => <><button className="btn tiny" onClick={() => api.openPath(m.file.path)}>打开</button><button className="btn tiny" title="在资源管理器中显示并选中该文件" onClick={() => api.showItem(m.file.path)}>📂 位置</button></> },
  ];
  // 分组较多时：左侧分组列表（可排序 / 筛选），右侧铺满显示所选分组的文件
  const cur = list.find((g) => g.id === curId) || list[0] || null;
  useEffect(() => { if (cur) MEMO.cur = cur.id; }, [cur && cur.id]);
  const groupCols = [
    { key: 'title', label: '分组', render: (g) => <b>{g.title}</b> },
    { key: 'count', label: '文件数', type: 'number', sort: (g) => g.members.length, filterValue: (g) => g.members.length, className: 'nowrap', render: (g) => g.members.length },
    { key: 'size', label: '总大小', type: 'number', sort: (g) => g.totalSize || 0, filterValue: (g) => Math.round(((g.totalSize || 0) / 1048576) * 100) / 100, className: 'nowrap', render: (g) => fmtSize(g.totalSize) },
    { key: 'reasons', label: '依据', sort: (g) => g.reasons.join('、'), filterList: (g) => g.reasons, className: 'small', render: (g) => g.reasons.map((r) => <span key={r} className="tag accent">{r}</span>) },
    { key: 'theme', label: '黑白底版本', sort: (g) => (g.hasThemeVariants ? 1 : 0), filterValue: (g) => (g.hasThemeVariants ? '含' : '无'), render: (g) => (g.hasThemeVariants ? <span className="tag theme-dark">含</span> : '') },
    { key: 'picked', label: '已选', type: 'number', sort: (g) => g.members.filter((m) => sel.has(m.file.id)).length, hidden: true, render: (g) => g.members.filter((m) => sel.has(m.file.id)).length || '' },
  ];
  return (
    <div className="view">
      <div className="view-head">
        <div className="vh-title">🧩 相似 PPT 分组 <span className="muted small">{list.length} 组 · {list.reduce((a, g) => a + g.members.length, 0)} 个文件</span></div>
        <div className="spacer" />
        {sel.size > 0 && <span className="badge">已选 {sel.size}</span>}
        {sel.size > 0 && <button className="btn small ghost" onClick={() => setSel(new Set())}>清空选择</button>}
        <CompareButton ids={[...sel]} />
        <RecycleButton ids={[...sel]} done={() => setSel(new Set())} />
        <label className="chk"><input type="checkbox" checked={onlyTheme} onChange={(e) => setOnlyTheme(e.target.checked)} /> 仅看含黑白底版本的分组</label>
      </div>
      {!list.length ? <div className="empty-tip">暂无相似分组（解析更多 PPT 后自动生成）</div> : (
        <div className="groups-split">
          <div className="gs-list">
            <DataTable id="groups" sessionKey={`groups-${taskId || 'all'}`} columns={groupCols} rows={list} rowKey={(g) => g.id} defaultSort={{ k: 'title', d: 1 }}
              rowClass={(g) => (cur && g.id === cur.id ? 'row-cur' : '')} onRowClick={(g) => setCurId(g.id)} empty="没有匹配的分组" />
          </div>
          {cur && (
            <div className="gs-detail">
              <div className="gc-head">
                <b>{cur.title}</b>
                <span className="muted small">{cur.members.length} 个文件 · 共 {fmtSize(cur.totalSize)}</span>
                {cur.reasons.map((r) => <span key={r} className="tag accent">{r}</span>)}
                {cur.hasThemeVariants && <span className="tag theme-dark">含黑底/白底版本</span>}
                <div className="spacer" />
                <button className="btn small" title={`并排对比本组${cur.members.length > COMPARE_MAX ? `前 ${COMPARE_MAX} 个` : '全部'}文件`} onClick={() => app.openCompare(cur.members.slice(0, COMPARE_MAX).map((m) => m.file.id))}>⧉ 对比本组</button>
              </div>
              <DataTable id="groupMembers" sessionKey={`groupMembers-${cur.id}`} key={cur.id} columns={memberCols} rows={cur.members} rowKey={(m) => m.file.id} selectable defaultSort={{ k: 'name', d: 1 }}
                selected={new Set(cur.members.map((m) => m.file.id).filter((id) => sel.has(id)))}
                onSelect={(n) => { const next = new Set([...sel].filter((id) => !cur.members.some((m) => m.file.id === id))); for (const id of n) next.add(id); setSel(next); }}
                actions={<button className="btn small" disabled={cur.members.filter((m) => sel.has(m.file.id)).length !== 1} onClick={() => { const m = cur.members.find((x) => sel.has(x.file.id)); if (m) api.showItem(m.file.path); }}>📂 在资源管理器中显示</button>} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
