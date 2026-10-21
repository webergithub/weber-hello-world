import React, { useEffect, useState } from 'react';
import { api, fmtSize, fmtTime, THEME_LABEL } from '../api';
import { useApp } from '../ctx';

// 内容相近的 PPT 分组：先比较（归一化后的）标题，再比较内容向量；支持按名称或大小排序
export default function GroupsView() {
  const app = useApp();
  const [sort, setSort] = useState('name');
  const [order, setOrder] = useState('asc');
  const [groups, setGroups] = useState([]);
  const [onlyTheme, setOnlyTheme] = useState(false);
  useEffect(() => { api.groups({ sort, order }).then(setGroups); }, [sort, order, app.taskTick]);
  const list = onlyTheme ? groups.filter((g) => g.hasThemeVariants) : groups;
  return (
    <div className="view">
      <div className="view-head">
        <div className="vh-title">🧩 相似 PPT 分组 <span className="muted small">{list.length} 组 · 判定顺序：标题相同 → 内容相似</span></div>
        <div className="spacer" />
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
            <table className="grid">
              <thead><tr><th>文件名</th><th>目录</th><th>大小</th><th>页数</th><th>底色</th><th>修改时间</th><th>相似度</th><th>依据</th><th /></tr></thead>
              <tbody>
                {g.members.map((m) => (
                  <tr key={m.file.id}>
                    <td className="link" onClick={() => app.openFile(m.file.id)}>{m.file.name}{m.file.status === 'duplicate' && <span className="tag warn">重复</span>}</td>
                    <td className="muted small ellipsis" title={m.file.dir}>{m.file.dir}</td>
                    <td>{fmtSize(m.file.size)}</td>
                    <td>{m.file.slide_count}</td>
                    <td><span className={`tag theme-${m.file.theme}`}>{THEME_LABEL[m.file.theme]}</span></td>
                    <td className="small">{fmtTime(m.file.mtime)}</td>
                    <td>{Math.round(m.score * 100)}%</td>
                    <td className="small">{m.reasons.join('、')}</td>
                    <td className="nowrap"><button className="btn tiny" onClick={() => api.openPath(m.file.path)}>打开</button><button className="btn tiny" onClick={() => api.showItem(m.file.path)}>位置</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </div>
  );
}
