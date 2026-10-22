import React, { useEffect, useState } from 'react';
import { api, fmtTime, STATUS_LABEL } from '../api';
import { useApp } from '../ctx';
import DataTable from './DataTable';

const summary = (t) => {
  try { const s = JSON.parse(t.watch_summary || 'null'); return s ? `新增 ${s.added} · 更新 ${s.updated} · 移除 ${s.removed}（共扫描 ${s.total}）` : ''; } catch { return ''; }
};

/** 添加“本机全部文档”时询问：是否监测更新和新增的文档，每天几点增量扫描 */
export function WatchAskDialog({ roots, onClose }) {
  const app = useApp();
  const w = (app.config && app.config.watch) || {};
  const [watch, setWatch] = useState(true);
  const [time, setTime] = useState(w.time || '12:30');
  const [catchUp, setCatchUp] = useState(w.catchUp !== false);
  return (
    <div className="overlay" onClick={() => onClose(null)}>
      <div className="modal" style={{ width: 'min(600px, 94vw)' }} onClick={(e) => e.stopPropagation()}>
        <div className="detail-head"><div className="dh-title">🖥 添加所有本地文档</div></div>
        <div className="pad">
          <p>将按顺序扫描本机所有磁盘（<code>{roots.join('  ')}</code>）中的 PPT / Word 文件（类型以设置为准），系统目录会被跳过。文件较多时耗时较长，可随时中断、继续。</p>
          <p className="muted small">添加后需要点击“开始解析”执行首次解析。</p>
          <label className="radio-row"><input type="checkbox" checked={watch} onChange={(e) => setWatch(e.target.checked)} />
            <div><b>监测更新和新增的 PPT / Word 文件</b><div className="muted small">每天在指定时间自动增量扫描：只解析新增的和修改过的文档，原文件已删除的移入回收站（仅移出资料库，可还原）；未变化的文档直接跳过。</div></div>
          </label>
          {watch && (
            <div className="row watch-row">
              <label>每天扫描时间</label>
              <input className="input" type="time" value={time} onChange={(e) => setTime(e.target.value || '12:30')} />
              <label className="chk"><input type="checkbox" checked={catchUp} onChange={(e) => setCatchUp(e.target.checked)} /> 错过时（程序未运行）下次启动后补扫</label>
            </div>
          )}
          <p className="muted small">定时扫描需要程序在运行（可最小化到右下角图标栏）；时间点与开关之后可在“设置 → 定时监测更新”中修改。</p>
        </div>
        <div className="detail-head"><div className="spacer" /><button className="btn" onClick={() => onClose(null)}>取消</button><button className="btn primary" onClick={() => onClose({ watch, time, catchUp })}>添加任务</button></div>
      </div>
    </div>
  );
}

/** 设置 → 定时监测更新 */
export default function WatchSettings() {
  const app = useApp();
  const [info, setInfo] = useState(null);
  const load = () => api.watchInfo().then(setInfo);
  useEffect(() => { load(); }, [app.taskTick]);
  if (!info) return null;
  const save = async (patch, msg = '定时监测设置已保存') => {
    const c = await api.setConfig({ watch: patch });
    app.setConfig(c); app.toast(msg); load();
  };
  const runNow = async (ids) => {
    const r = await api.runWatch(ids);
    app.toast(r.length ? `已开始增量扫描：${r.length} 个任务（在“解析任务”中查看进度）` : '没有可扫描的任务（任务需要先手动完成首次解析）', r.length ? 'info' : 'error');
    app.refreshTasks();
  };
  const columns = [
    { key: 'name', label: '任务', render: (t) => <span className="link" onClick={() => app.go({ type: 'task', id: t.id })}>#{t.id} {t.name}</span> },
    { key: 'dir', label: '扫描范围', className: 'muted small ellipsis', render: (t) => <span title={t.dir}>{t.dir}</span> },
    { key: 'status', label: '状态', render: (t) => (t.neverRun ? <span className="tag warn">未开始首次解析</span> : <span className={`status s-${t.status}`}>{STATUS_LABEL[t.status] || t.status}</span>) },
    { key: 'last_watch_at', label: '上次增量扫描', sort: (t) => t.last_watch_at || 0, className: 'small nowrap', render: (t) => fmtTime(t.last_watch_at) || '—' },
    { key: 'summary', label: '上次结果', sort: (t) => summary(t), className: 'small', render: summary },
    { key: 'ops', label: '操作', nosort: true, className: 'nowrap', render: (t) => <><button className="btn tiny" disabled={t.neverRun} onClick={() => runNow([t.id])}>立即扫描</button><button className="btn tiny" onClick={() => api.setTaskWatch(t.id, false).then(() => { load(); app.refreshTasks(); })}>关闭监测</button></> },
  ];
  return (
    <div className="watch-settings">
      <div className="row wrap">
        <label className="chk"><input type="checkbox" checked={!!info.enabled} onChange={(e) => save({ enabled: e.target.checked }, e.target.checked ? '已开启定时监测更新' : '已关闭定时监测更新')} /> <b>开启每日定时增量扫描</b></label>
        <span className="muted">每天</span>
        <input className="input" type="time" value={info.time} disabled={!info.enabled} onChange={(e) => e.target.value && save({ time: e.target.value }, `扫描时间已改为每天 ${e.target.value}`)} />
        <label className="chk"><input type="checkbox" checked={info.catchUp !== false} disabled={!info.enabled} onChange={(e) => save({ catchUp: e.target.checked })} /> 错过时下次启动后补扫</label>
        <div className="spacer" />
        {info.enabled && info.next && <span className="muted small">下次扫描：{fmtTime(info.next)}{info.lastRun ? ` · 上次：${fmtTime(info.lastRun)}` : ''}</span>}
        <button className="btn small" disabled={!info.tasks.length} onClick={() => runNow(null)}>↻ 立即增量扫描全部</button>
      </div>
      <DataTable id="watchTasks" columns={columns} rows={info.tasks} defaultSort={{ k: 'name', d: 1 }}
        empty="还没有开启监测的任务：添加“所有本地文档”时可选择监测，或在任务详情中点击“📡 监测更新”" />
    </div>
  );
}
