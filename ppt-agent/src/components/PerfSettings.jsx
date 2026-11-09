import React, { useEffect, useState } from 'react';
import { api } from '../api';
import { useApp } from '../ctx';
import DataTable from './DataTable';

/**
 * 设置 → 常规 → 资源与优先级（v3.11）：用户操作时解析任务让路、只在空闲期解析、内存上限、大文件逐个解析；
 * 下方列出程序的各个进程与内存（Electron 固定由主进程、界面、GPU、网络服务等进程组成）。改了立即保存。
 */
export default function PerfSettings() {
  const app = useApp();
  const saved = { yieldOnActivity: true, idleOnly: false, idleSec: 60, memLimitMB: 16384, bigFileMB: 64, ...((app.config && app.config.perf) || {}) };
  const [p, setP] = useState(saved);
  const [mem, setMem] = useState(null);
  const save = async (patch) => { const n = { ...p, ...patch }; setP(n); app.setConfig(await api.setConfig({ perf: patch })); };
  useEffect(() => {
    let on = true;
    const load = () => api.memInfo().then((m) => on && setMem(m)).catch(() => {});
    load();
    const iv = setInterval(load, 3000);
    return () => { on = false; clearInterval(iv); };
  }, []);
  const cols = [
    { key: 'label', label: '进程', sort: (r) => r.label },
    { key: 'pid', label: 'PID', type: 'number' },
    { key: 'mb', label: '内存', type: 'number', sort: (r) => r.mb || 0, render: (r) => (r.mb == null ? '' : `${r.mb} MB`) },
    { key: 'cpu', label: 'CPU', type: 'number', sort: (r) => r.cpu || 0, render: (r) => (r.cpu == null ? '' : `${r.cpu}%`) },
  ];
  return (
    <div className="perf-settings">
      <div className="row"><label className="chk"><input type="checkbox" checked={p.yieldOnActivity !== false} onChange={(e) => save({ yieldOnActivity: e.target.checked })} /> 操作界面时解析任务让路（只保留一个子任务继续，后台计算放慢）</label></div>
      <div className="row"><label className="chk"><input type="checkbox" checked={!!p.idleOnly} onChange={(e) => save({ idleOnly: e.target.checked })} /> 只在空闲期解析：停止操作</label>
        <input className="input split-par" type="number" min="5" max="3600" value={p.idleSec} disabled={!p.idleOnly} onChange={(e) => save({ idleSec: Math.max(5, Math.min(3600, Number(e.target.value) || 60)) })} /> <span className="muted">秒后继续解析</span></div>
      <div className="row"><label>内存上限</label><input className="input split-size" type="number" min="1024" max="262144" step="1024" value={p.memLimitMB} onChange={(e) => save({ memLimitMB: Math.max(1024, Math.min(262144, Number(e.target.value) || 16384)) })} /> <span className="muted">MB（全部进程合计；超过时释放缓存并暂缓开始下一个文件）</span></div>
      <div className="row"><label>大文件</label><input className="input split-par" type="number" min="8" max="4096" value={p.bigFileMB} onChange={(e) => save({ bigFileMB: Math.max(8, Math.min(4096, Number(e.target.value) || 64)) })} /> <span className="muted">MB 以上同一时间只解析一个</span></div>
      {mem && <>
        <div className="row"><label>当前进程</label><span className="muted">合计 {mem.totalMB} MB</span></div>
        <DataTable id="memInfo" columns={cols} rows={mem.rows} rowKey={(r) => r.pid} defaultSort={{ k: 'mb', d: -1 }} empty="" />
      </>}
    </div>
  );
}
