import React, { useState } from 'react';
import { api } from '../api';
import { useApp } from '../ctx';
import DataTable from './DataTable';

const NAME = { 'WINWORD.EXE': 'Word', 'POWERPNT.EXE': 'PowerPoint' };
// Windows FILETIME（100 纳秒，自 1601 年）→ 毫秒时间戳
const ftTime = (s) => { try { return Number((BigInt(s) - 116444736000000000n) / 10000n); } catch { return 0; } };

/**
 * 设置 → 常规 → 后台 Office 进程（v3.10.1）：列出没有窗口的 Word / PowerPoint 自动化进程（旧版本或其他程序遗留的），
 * 确认后结束。只列没有窗口、命令行带 /Automation 或 -Embedding 的进程，用户自己打开的 Word / PowerPoint 不会出现。
 */
export default function OfficeProcs() {
  const app = useApp();
  const [list, setList] = useState(null);
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState(() => new Set());
  const check = async () => {
    setBusy(true);
    try { const l = await api.officeProcs(); setList(l); setSel(new Set(l.map((o) => o.pid))); } catch (e) { app.toast(e.message, 'error'); } finally { setBusy(false); }
  };
  const kill = async (rows) => {
    if (!rows.length || !confirm(`结束 ${rows.length} 个后台 Word / PowerPoint 进程？\n\n这些进程没有窗口，未保存的内容（如果有）会丢失。`)) return;
    setBusy(true);
    try { const n = await api.killOfficeProcs(rows.map(({ pid, start, image }) => ({ pid, start, image }))); app.toast(`已结束 ${n} 个后台进程`, 'info', { cat: '系统' }); await check(); } catch (e) { app.toast(e.message, 'error'); } finally { setBusy(false); }
  };
  const cols = [
    { key: 'image', label: '程序', sort: (o) => NAME[o.image] || o.image, render: (o) => NAME[o.image] || o.image },
    { key: 'pid', label: 'PID', type: 'number' },
    { key: 'memMB', label: '内存', type: 'number', render: (o) => `${o.memMB} MB` },
    { key: 'start', label: '启动时间', type: 'date', sort: (o) => ftTime(o.start), filterValue: (o) => ftTime(o.start), className: 'small nowrap', render: (o) => new Date(ftTime(o.start)).toLocaleString('zh-CN', { hour12: false }) },
    { key: 'ours', label: '来源', sort: (o) => (o.ours ? 1 : 0), render: (o) => (o.ours ? <span className="tag accent">本程序正在使用</span> : <span className="tag warn">遗留 / 其他程序</span>) },
  ];
  const rows = list || [];
  return (
    <div className="office-procs">
      <div className="row">
        <button className="btn" disabled={busy} onClick={check}>{busy ? '检查中…' : '🔍 检查后台 Word / PowerPoint 进程'}</button>
        {list && <span className="muted">{rows.length ? `${rows.length} 个，约 ${rows.reduce((a, o) => a + o.memMB, 0)} MB` : '没有后台进程'}</span>}
        {rows.length > 0 && <button className="btn danger-btn" disabled={busy || !sel.size} onClick={() => kill(rows.filter((o) => sel.has(o.pid)))}>⏹ 结束所选（{sel.size}）</button>}
      </div>
      {rows.length > 0 && <DataTable id="officeProcs" columns={cols} rows={rows} rowKey={(o) => o.pid} selectable selected={sel} onSelect={setSel} defaultSort={{ k: 'memMB', d: -1 }} empty="没有后台进程" />}
    </div>
  );
}
