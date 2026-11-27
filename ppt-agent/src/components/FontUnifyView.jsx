import React, { useMemo, useState } from 'react';
import { api, fmtSize, fmtTime } from '../api';
import { useApp } from '../ctx';
import DataTable from './DataTable';

const COMMON_LATIN = ['Arial', 'Calibri', 'Times New Roman', 'Segoe UI', 'Verdana', 'Tahoma', 'Georgia', 'Helvetica'];
const COMMON_EA = ['微软雅黑', '黑体', '宋体', '等线', '仿宋', '楷体', '思源黑体', '华为黑体', '方正兰亭黑'];
const PRESETS = [
  { key: 'yahei', label: '微软雅黑', title: { latin: 'Arial', ea: '微软雅黑', size: 32 }, body: { latin: 'Arial', ea: '微软雅黑', size: 18 } },
  { key: 'hei', label: '黑体 + 宋体', title: { latin: 'Arial', ea: '黑体', size: 32 }, body: { latin: 'Times New Roman', ea: '宋体', size: 18 } },
  { key: 'dengxian', label: '等线', title: { latin: 'Calibri', ea: '等线', size: 30 }, body: { latin: 'Calibri', ea: '等线', size: 16 } },
];
// 会话内保留当前文件、分析结果、设置与已生成的文件
const MEMO = { file: '', info: null, form: null, results: [] };
const top = (m) => Object.entries(m || {}).sort((a, b) => b[1] - a[1]).map(([k]) => k).find((k) => !k.startsWith('（')) || '';
const topSize = (m) => { const k = top(m); return k ? Number(k.replace(/[^\d.]/g, '')) || '' : ''; };

/**
 * 智能模块 → 字体统一（v3.13）：导入一个 PPT，分析标题 / 正文当前使用的字体与字号，
 * 设置标题与正文的西文字体、中文字体、字号后另存为“原名_字体统一.pptx”（原文件不改）。
 */
export default function FontUnifyView() {
  const app = useApp();
  const [file, setFile] = useState(MEMO.file);
  const [info, setInfo] = useState(MEMO.info);
  const [form, setFormState] = useState(MEMO.form || { title: { ...PRESETS[0].title }, body: { ...PRESETS[0].body }, tables: true, masters: true });
  const [results, setResults] = useState(MEMO.results);
  const [busy, setBusy] = useState('');
  const setForm = (f) => setFormState((cur) => { const n = typeof f === 'function' ? f(cur) : f; MEMO.form = n; return n; });
  const part = (k, p) => setForm((f) => ({ ...f, [k]: { ...f[k], ...p } }));

  const load = async (p) => {
    setBusy('analyze');
    try {
      const r = await api.fontAnalyze(p);
      MEMO.file = p; MEMO.info = r; setFile(p); setInfo(r);
      // 默认值：沿用文档中最常用的字体与字号（没有时保留当前设置）
      setForm((f) => ({
        ...f,
        title: { latin: f.title.latin || (r.theme.major && r.theme.major.latin) || '', ea: top(r.title.fonts) || f.title.ea, size: topSize(r.title.sizes) || f.title.size },
        body: { latin: f.body.latin || (r.theme.minor && r.theme.minor.latin) || '', ea: top(r.body.fonts) || f.body.ea, size: topSize(r.body.sizes) || f.body.size },
      }));
    } catch (e) { app.toast(e.message, 'error', { cat: '字体统一' }); }
    finally { setBusy(''); }
  };
  const pick = async () => { const ps = await api.selectFiles('选择要统一字体的 PPT'); if (ps && ps[0]) load(ps[0]); };
  const run = async () => {
    setBusy('run');
    try {
      const r = await api.fontUnify(file, form);
      const row = { ...r.stats, path: r.path, src: file, at: Date.now(), ms: r.ms, title: form.title, body: form.body };
      MEMO.results = [row, ...MEMO.results].slice(0, 50); setResults(MEMO.results);
      app.toast(`已生成 ${r.path.split(/[\\/]/).pop()}（${r.stats.slides} 页，修改 ${r.stats.runs} 处文字）`, 'info', { cat: '字体统一', label: '在资源管理器中显示', link: { type: 'reveal', path: r.path } });
    } catch (e) { app.toast(e.message, 'error', { cat: '字体统一' }); }
    finally { setBusy(''); }
  };

  const usage = useMemo(() => {
    if (!info) return [];
    const rows = [];
    for (const [k, label] of [['title', '标题'], ['body', '正文']]) {
      const total = Object.values(info[k].fonts).reduce((a, b) => a + b, 0) || 1;
      for (const [f, n] of Object.entries(info[k].fonts)) rows.push({ id: `${k}-f-${f}`, part: label, what: '字体', value: f, chars: n, pct: Math.round((n / total) * 100) });
      for (const [s, n] of Object.entries(info[k].sizes)) rows.push({ id: `${k}-s-${s}`, part: label, what: '字号', value: s, chars: n, pct: Math.round((n / total) * 100) });
    }
    return rows;
  }, [info]);
  const usageCols = [
    { key: 'part', label: '位置', filterValue: (r) => r.part },
    { key: 'what', label: '项目', filterValue: (r) => r.what },
    { key: 'value', label: '当前值' },
    { key: 'chars', label: '字符数', type: 'number' },
    { key: 'pct', label: '占比', type: 'number', render: (r) => `${r.pct}%` },
  ];
  const resCols = [
    { key: 'path', label: '生成的文件', render: (r) => <span title={r.path}>{r.path.split(/[\\/]/).pop()}</span> },
    { key: 'spec', label: '标题 / 正文', sort: (r) => r.title.ea, render: (r) => `${r.title.ea || r.title.latin} ${r.title.size || ''} / ${r.body.ea || r.body.latin} ${r.body.size || ''}` },
    { key: 'slides', label: '页数', type: 'number' },
    { key: 'runs', label: '修改文字', type: 'number' },
    { key: 'at', label: '时间', type: 'date', render: (r) => fmtTime(r.at) },
    { key: 'ops', label: '操作', nosort: true, nofilter: true, className: 'nowrap', render: (r) => <><button className="btn tiny ghost" title="在资源管理器中显示" onClick={() => api.showItem(r.path)}>📂</button><button className="btn tiny" onClick={() => api.openPath(r.path)}>打开</button></> },
  ];
  const fontRow = (k, label) => (
    <div className="row fu-row">
      <label>{label}</label>
      <span className="muted small">西文</span>
      <input className="input" list="fu-latin" value={form[k].latin} onChange={(e) => part(k, { latin: e.target.value })} />
      <span className="muted small">中文</span>
      <input className="input" list="fu-ea" value={form[k].ea} onChange={(e) => part(k, { ea: e.target.value })} />
      <span className="muted small">字号</span>
      <input className="input split-par" type="number" min="0" max="400" step="0.5" value={form[k].size} onChange={(e) => part(k, { size: e.target.value })} /> <span className="muted">磅</span>
    </div>
  );
  const fontsInDoc = info ? [...new Set([...Object.keys(info.title.fonts), ...Object.keys(info.body.fonts)].filter((f) => !f.startsWith('（')))] : [];
  return (
    <div className="view">
      <div className="view-head">
        <div className="vh-title">🔤 字体统一</div>
        <div className="spacer" />
        <button className="btn" disabled={!!busy} onClick={pick}>📁 导入 PPT…</button>
      </div>
      <div className="tab-body pad flex-col fu-body">
        <div className="gen-steps">{['导入 PPT', '设置字体与字号', '生成新文件'].map((t, k) => { const step = !file ? 1 : results.some((r) => r.src === file) ? 3 : 2; return <span key={t} className={`gs ${step === k + 1 ? 'on' : step > k + 1 ? 'done' : ''}`}><b>{step > k + 1 ? '✓' : k + 1}</b>{t}</span>; })}</div>
        {file && info && (
          <div className="fu-file">
            <b title={file}>📄 {info.name}</b>
            <span className="muted small">{info.slides} 页 · {fmtSize(info.size)} · {fmtTime(info.mtime)} · 主题字体 标题 {[info.theme.major && info.theme.major.latin, info.theme.major && info.theme.major.ea].filter(Boolean).join(' / ') || '—'} · 正文 {[info.theme.minor && info.theme.minor.latin, info.theme.minor && info.theme.minor.ea].filter(Boolean).join(' / ') || '—'}</span>
            <button className="btn tiny ghost" title="在资源管理器中显示" onClick={() => api.showItem(file)}>📂</button><button className="btn tiny" onClick={() => api.openPath(file)}>打开原文件</button>
          </div>
        )}
        {!file && <div className="empty-tip"><button className="btn primary" disabled={!!busy} onClick={pick}>{busy === 'analyze' ? '分析中…' : '📁 导入 PPT…'}</button></div>}
        {file && (
          <>
            <div className="fu-form">
              <div className="row"><label>方案</label><div className="seg">{PRESETS.map((p) => <button key={p.key} className={form.title.ea === p.title.ea && form.body.ea === p.body.ea && Number(form.title.size) === p.title.size && Number(form.body.size) === p.body.size ? 'on' : ''} onClick={() => setForm((f) => ({ ...f, title: { ...p.title }, body: { ...p.body } }))}>{p.label}</button>)}</div></div>
              {fontRow('title', '标题')}
              {fontRow('body', '正文')}
              <div className="row"><label>范围</label>
                <label className="chk"><input type="checkbox" checked={form.tables} onChange={(e) => setForm((f) => ({ ...f, tables: e.target.checked }))} /> 表格文字按正文统一</label>
                <label className="chk"><input type="checkbox" checked={form.masters} onChange={(e) => setForm((f) => ({ ...f, masters: e.target.checked }))} /> 同时修改母版、版式与主题字体</label>
              </div>
              <div className="row"><label />
                <button className="btn primary" disabled={!!busy || !(form.title.latin || form.title.ea || form.title.size || form.body.latin || form.body.ea || form.body.size)} onClick={run}>{busy === 'run' ? '生成中…' : '🔤 统一字体并另存'}</button>
                <button className="btn ghost" disabled={!!busy} onClick={() => load(file)}>↻ 重新分析</button>
              </div>
              <datalist id="fu-latin">{[...new Set([...COMMON_LATIN, ...fontsInDoc])].map((f) => <option key={f} value={f} />)}</datalist>
              <datalist id="fu-ea">{[...new Set([...COMMON_EA, ...fontsInDoc])].map((f) => <option key={f} value={f} />)}</datalist>
            </div>
            <div className="fu-tables">
              <DataTable id="fontUsage" columns={usageCols} rows={usage} rowKey={(r) => r.id} empty="没有找到文字" />
              {results.length > 0 && <DataTable id="fontResults" columns={resCols} rows={results} rowKey={(r) => r.path} />}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
