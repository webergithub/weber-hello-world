import React, { useEffect, useState } from 'react';
import { api, fmtSize, THEME_LABEL, assetUrl } from '../api';
import { useApp } from '../ctx';
import SlidePreview, { HtmlSlide } from './SlidePreview';
import DataTable from './DataTable';
import { fmtTime } from '../api';

let SHOW_HIST = false; // 是否在看转换历史（会话内记住，从逐页浏览返回时保持）
let CV_MODE = 'pages'; // pages：导出篮中的页面 | files：按文件 / 文件夹整份转换
const DIRS = [['auto', '自动（黑↔白互换）'], ['toLight', '统一转为白底'], ['toDark', '统一转为黑底']];
const readLS = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } };
const writeLS = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } };

/** 按文件 / 文件夹批量转换：选择一个或多个 PPT 文件或文件夹，指定转换方向；输出到原目录（加后缀）或统一的新目录；原文件不改动 */
function FileConvert({ onDone }) {
  const app = useApp();
  const [files, setFiles] = useState([]);
  const [sel, setSel] = useState(() => new Set());
  const [direction, setDirection] = useState(() => readLS('ppta.cvf.dir', 'auto'));
  const [outMode, setOutMode] = useState(() => readLS('ppta.cvf.outMode', 'suffix'));
  const [outDir, setOutDir] = useState(() => readLS('ppta.cvf.outDir', ''));
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState({}); // path → { status, out, error, converted, slides }
  useEffect(() => { writeLS('ppta.cvf.dir', direction); writeLS('ppta.cvf.outMode', outMode); writeLS('ppta.cvf.outDir', outDir); }, [direction, outMode, outDir]);
  const add = async (paths) => {
    if (!paths || !paths.length) return;
    const list = await api.listPptx(paths);
    setFiles((cur) => { const m = new Map(cur.map((f) => [f.path, f])); for (const f of list) m.set(f.path, f); return [...m.values()]; });
    setSel((cur) => new Set([...cur, ...list.filter((f) => !f.legacy).map((f) => f.path)]));
    if (!list.length) app.toast('所选位置中没有 PPT 文件', 'error');
  };
  const picked = files.filter((f) => sel.has(f.path) && !f.legacy);
  const start = async () => {
    if (outMode === 'dir' && !outDir) { app.toast('请先选择输出目录', 'error'); return; }
    setBusy(true);
    let ok = 0, failed = 0;
    for (const f of picked) {
      setState((m) => ({ ...m, [f.path]: { status: 'running' } }));
      try {
        const r = await api.convertFile(f.path, { direction, outMode, outDir });
        ok++; setState((m) => ({ ...m, [f.path]: { status: 'done', out: r.path, converted: r.converted, slides: r.slides } }));
      } catch (e) { failed++; setState((m) => ({ ...m, [f.path]: { status: 'failed', error: e.message } })); }
    }
    setBusy(false); onDone();
    app.toast(`批量转换完成：成功 ${ok} 个${failed ? `，失败 ${failed} 个` : ''}${outMode === 'dir' ? `，已输出到 ${outDir}` : '，已保存在各自原目录（文件名加后缀）'}`, failed ? 'error' : 'info', outMode === 'dir' ? { label: '打开目录', link: { type: 'open', path: outDir }, cat: '黑白底互转' } : { cat: '黑白底互转' });
  };
  const ST = { running: ['转换中', 'running'], done: ['已完成', 'done'], failed: ['失败', 'failed'] };
  const cols = [
    { key: 'name', label: '文件', render: (f) => <span title={f.path}>{f.name}{f.legacy && <span className="tag warn">旧版 .ppt 不支持</span>}</span> },
    { key: 'dir', label: '所在目录', className: 'muted small ellipsis', render: (f) => <span title={f.dir}>{f.dir}</span> },
    { key: 'size', label: '大小', type: 'number', sort: (f) => f.size, className: 'nowrap', render: (f) => fmtSize(f.size) },
    { key: 'st', label: '状态', sort: (f) => (state[f.path] ? state[f.path].status : ''), render: (f) => { const x = state[f.path]; return x ? <span className={`status s-${ST[x.status][1]}`} title={x.error || ''}>{ST[x.status][0]}{x.status === 'done' ? ` · ${x.converted}/${x.slides} 页` : ''}</span> : <span className="muted small">待转换</span>; } },
    { key: 'out', label: '输出文件', className: 'small', render: (f) => { const x = state[f.path]; return x && x.out ? <span className="link" title={x.out} onClick={() => api.openPath(x.out)}>{x.out.split(/[\\/]/).pop()}</span> : x && x.error ? <span className="danger-fg small">{x.error}</span> : ''; } },
    { key: 'ops', label: '操作', nosort: true, nofilter: true, className: 'nowrap', render: (f) => { const x = state[f.path]; return <>{x && x.out && <button className="btn tiny" title="在资源管理器中显示并选中该文件" onClick={() => api.showItem(x.out)}>📂 位置</button>}<button className="btn tiny ghost" disabled={busy} onClick={() => { setFiles((l) => l.filter((y) => y.path !== f.path)); }}>移除</button></>; } },
  ];
  return (
    <div className="cvf">
      <div className="cvf-bar">
        <button className="btn" disabled={busy} onClick={async () => add(await api.selectFiles('选择要转换的 PPT 文件（可多选）'))}>＋ 选择 PPT 文件…</button>
        <button className="btn" disabled={busy} onClick={async () => add(await api.selectDir('选择包含 PPT 的文件夹（会包含子文件夹）'))}>＋ 选择文件夹…</button>
        <span className="cvf-sep" />
        <span className="muted">转换方向</span>
        <div className="seg">{DIRS.map(([k, v]) => <button key={k} className={direction === k ? 'on' : ''} onClick={() => setDirection(k)}>{v}</button>)}</div>
        <span className="cvf-sep" />
        <span className="muted">输出到</span>
        <div className="seg">
          <button className={outMode === 'suffix' ? 'on' : ''} onClick={() => setOutMode('suffix')}>原目录（文件名加后缀）</button>
          <button className={outMode === 'dir' ? 'on' : ''} onClick={() => setOutMode('dir')}>统一新目录</button>
        </div>
        {outMode === 'dir' && <><code className="cvf-dir ellipsis" title={outDir}>{outDir || '未选择'}</code><button className="btn small" onClick={async () => { const r = await api.selectDir('选择统一的输出目录', true); if (r && r[0]) setOutDir(r[0]); }}>选择…</button></>}
        <div className="spacer" />
        <button className="btn primary" disabled={!picked.length || busy} onClick={start}>{busy ? '转换中…' : `开始批量转换（${picked.length} 个文件）`}</button>
      </div>
      <DataTable id="convertFiles" columns={cols} rows={files} rowKey={(f) => f.path} selectable selected={sel} onSelect={setSel} selectableRow={(f) => !f.legacy} defaultSort={{ k: 'name', d: 1 }}
        empty="点击“＋ 选择 PPT 文件…”或“＋ 选择文件夹…”添加要转换的 PPT；原文件不会被修改，转换结果另存为新文件" />
    </div>
  );
}

const DIR_LABEL = { auto: '自动（黑↔白）', toLight: '黑底 → 白底', toDark: '白底 → 黑底' };

// PPT 黑白底互转：从导出篮多选页面加入转化序列，按规则改写配色后导出新 PPT
export default function ConvertView() {
  const app = useApp();
  const [basket, setBasket] = useState([]);
  const [pick, setPick] = useState(() => new Set());
  const [queue, setQueue] = useState([]); // [{slideId, dir}]
  const [qSlides, setQSlides] = useState({});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [rules, setRules] = useState(null);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [mode, setModeState] = useState(CV_MODE);
  const setMode = (m) => { CV_MODE = m; setModeState(m); };
  const [showHist, setShowHistState] = useState(SHOW_HIST);
  const setShowHist = (v) => { SHOW_HIST = v; setShowHistState(v); };
  const [hist, setHist] = useState([]);
  const [histSel, setHistSel] = useState(() => new Set());
  const loadHist = () => api.convertHistory().then(setHist).catch(() => setHist([]));
  useEffect(() => { loadHist(); }, [app.taskTick]);
  const viewHist = async (id) => { try { setResult(await api.convertHistoryResult(id)); setShowHist(false); } catch (e) { app.toast(e.message, 'error'); } };
  useEffect(() => { api.getConvertRules().then(setRules); }, []);

  useEffect(() => { Promise.all(app.basket.items.map((id) => api.slideDetail(id).catch(() => null))).then((l) => setBasket(l.filter(Boolean))); }, [app.basket.items]);
  useEffect(() => { const m = {}; for (const s of basket) m[s.id] = s; setQSlides((o) => ({ ...o, ...m })); }, [basket]);
  const pptSlides = basket.filter((s) => !(s.file && (s.file.kind === 'word' || s.file.kind === 'pdf')));
  const inQueue = new Set(queue.map((q) => q.slideId));
  const addToQueue = () => {
    setQueue([...queue, ...[...pick].filter((id) => !inQueue.has(id)).map((id) => ({ slideId: id, dir: 'auto' }))]);
    setPick(new Set());
  };
  const effective = (q) => (q.dir === 'auto' ? ((qSlides[q.slideId] || {}).theme === 'dark' ? 'toLight' : 'toDark') : q.dir);
  const run = async () => {
    // 默认文件名：原 PPT 文件名 + 转换后的底色
    const dirs = queue.map(effective);
    const suffix = dirs.every((d) => d === 'toLight') ? '_白底' : dirs.every((d) => d === 'toDark') ? '_黑底' : '_黑白互转';
    const first = qSlides[queue[0].slideId];
    const files = new Set(queue.map((q) => (qSlides[q.slideId] && qSlides[q.slideId].file ? qSlides[q.slideId].file.name : '')));
    const baseName = first && first.file ? first.file.name.replace(/\.[^.]+$/, '') : '黑白底互转';
    const out = await api.saveFile(`${baseName}${files.size > 1 ? `等${files.size}个文件` : ''}${suffix}.pptx`, 'pptx', 'convert');
    if (!out) return;
    setBusy(true); setResult(null);
    try {
      const r = await api.convertSlides(queue, out);
      setResult(r); loadHist();
      app.toast(`转换完成：${r.slides} 页 → ${out}`, 'info', { label: '打开', link: { type: 'open', path: out }, cat: '黑白底互转' });
    } catch (e) { app.toast('转换失败：' + e.message, 'error'); } finally { setBusy(false); }
  };

  const histCols = [
    { key: 'at', label: '转换时间', type: 'date', sort: (h) => h.at, filterValue: (h) => h.at, className: 'small nowrap', render: (h) => fmtTime(h.at) },
    { key: 'out', label: '输出文件', sort: (h) => h.out_path, render: (h) => <span className={h.exists ? 'link' : 'muted'} title={h.out_path} onClick={() => h.exists && api.openPath(h.out_path)}>{h.out_path.split(/[\\/]/).pop()}{!h.exists && '（文件已不存在）'}</span> },
    { key: 'slides', label: '页数', type: 'number', sort: (h) => h.slides, render: (h) => h.slides },
    { key: 'to_light', label: '黑→白', type: 'number', sort: (h) => h.to_light, render: (h) => h.to_light || '' },
    { key: 'to_dark', label: '白→黑', type: 'number', sort: (h) => h.to_dark, render: (h) => h.to_dark || '' },
    { key: 'src', label: '来源文件', sort: (h) => h.srcFiles.join('、'), filterList: (h) => h.srcFiles, className: 'small', render: (h) => <span title={h.srcFiles.join('\n')}>{h.srcFiles.slice(0, 2).join('、')}{h.srcFiles.length > 2 ? ` 等 ${h.srcFiles.length} 个` : ''}</span> },
    { key: 'verify', label: '校验', sort: (h) => (h.verify_total ? h.verify_ok / h.verify_total : 1), render: (h) => (h.verify_total ? <span className={`tag ${h.verify_ok === h.verify_total ? 'ok' : 'warn'}`}>{h.verify_ok}/{h.verify_total}</span> : '') },
    { key: 'size', label: '大小', type: 'number', sort: (h) => h.size || 0, className: 'nowrap', render: (h) => fmtSize(h.size) },
    { key: 'ops', label: '操作', nosort: true, nofilter: true, className: 'nowrap', render: (h) => <>
      <button className="btn tiny primary" onClick={() => viewHist(h.id)}>查看结果</button>
      {h.inLibrary && <button className="btn tiny" onClick={() => app.openFile(h.file_id)}>⛶ 逐页浏览</button>}
      <button className="btn tiny" disabled={!h.exists} onClick={() => api.openPath(h.out_path)}>打开原文件</button>
      <button className="btn tiny" disabled={!h.exists} title="在资源管理器中显示并选中该文件" onClick={() => api.showItem(h.out_path)}>📂 位置</button>
    </> },
  ];
  return (
    <div className="view">
      {rulesOpen && <RulesDialog onClose={(r) => { setRulesOpen(false); if (r) setRules(r); }} />}
      <div className="view-head">
        <div className="vh-title">🌓 PPT 黑白底互转 <button className="btn small rules-btn" onClick={() => setRulesOpen(true)}>⚙ 转换规则设置</button></div>
        <div className="spacer" />
        <button className={`btn ${showHist ? 'primary' : ''}`} onClick={() => { if (!showHist) loadHist(); setShowHist(!showHist); }}>{showHist ? '← 返回转换' : `🕘 转换历史（${hist.length}）`}</button>
        {!showHist && <div className="seg">
          <button className={mode === 'pages' ? 'on' : ''} onClick={() => setMode('pages')}>📄 导出篮中的页面</button>
          <button className={mode === 'files' ? 'on' : ''} onClick={() => setMode('files')}>🗂 按文件 / 文件夹</button>
        </div>}
        {!showHist && mode === 'pages' && <button className="btn ghost" disabled={!queue.length} onClick={() => setQueue([])}>清空序列</button>}
        {!showHist && mode === 'pages' && <button className="btn primary" disabled={!queue.length || busy} onClick={run}>{busy ? '转换中…' : `开始转换并导出（${queue.length} 页）`}</button>}
      </div>
      {rules && (
        <div className="cv-rules-banner">
          <div className="rules-head"><b>📐 当前转换规则</b><div className="spacer" /><span className="link small" onClick={() => setRulesOpen(true)}>查看 / 修改</span></div>
          <RulesSummary rules={rules} />
        </div>
      )}
      {showHist && (
        <div className="tab-body pad flex-col">
          <DataTable id="convertHistory" columns={histCols} rows={hist} rowKey={(h) => h.id} defaultSort={{ k: 'at', d: -1 }} empty="还没有转换记录" selectable selected={histSel} onSelect={setHistSel}
            actions={<button className="btn small" disabled={!histSel.size} onClick={async () => { if (!confirm(`删除 ${histSel.size} 条转换记录？（只删除记录，不删除转换生成的文件）`)) return; await api.convertHistoryDelete([...histSel]); setHistSel(new Set()); loadHist(); }}>删除记录</button>} />
        </div>
      )}
      {!showHist && mode === 'files' && <FileConvert onDone={loadHist} />}
      {!showHist && mode === 'pages' && <div className="convert">
        <div className="cv-col">
          <div className="side-title">① 导出篮中的 PPT 页面（{pptSlides.length}）<div className="spacer" />
            <button className="btn tiny" onClick={() => setPick(new Set(pptSlides.filter((s) => !inQueue.has(s.id)).map((s) => s.id)))}>全选</button>
            <button className="btn tiny primary" disabled={!pick.size} onClick={addToQueue}>加入转化序列 →</button>
          </div>
          {!pptSlides.length && <div className="empty-tip">导出篮为空。请先在页面视图 / 搜索结果中选择页面加入导出篮。</div>}
          <div className="cv-grid">
            {pptSlides.map((s) => (
              <label key={s.id} className={`cv-item ${pick.has(s.id) ? 'sel' : ''} ${inQueue.has(s.id) ? 'queued' : ''}`}>
                <input type="checkbox" disabled={inQueue.has(s.id)} checked={pick.has(s.id)} onChange={() => { const n = new Set(pick); if (n.has(s.id)) n.delete(s.id); else n.add(s.id); setPick(n); }} />
                <SlidePreview slide={s} file={s.file} />
                <div className="small ellipsis">{s.title || `第 ${s.idx} 页`}</div>
                <div className="small muted"><span className={`tag theme-${s.theme}`}>{THEME_LABEL[s.theme]}</span>{inQueue.has(s.id) ? ' 已在序列' : ''}</div>
              </label>
            ))}
          </div>
        </div>
        <div className="cv-col">
          <div className="side-title">② 转化序列（{queue.length}）</div>
          {!queue.length && <div className="empty-tip">从左侧多选页面加入转化序列</div>}
          {queue.map((q, i) => {
            const s = qSlides[q.slideId];
            return (
              <div key={q.slideId} className="cv-q">
                <span className="bi-no">{i + 1}</span>
                <div className="cv-thumb">{s && <SlidePreview slide={s} file={s.file} />}</div>
                <div className="cv-info">
                  <div className="si-title">{s ? s.title || `第 ${s.idx} 页` : q.slideId}</div>
                  <div className="small muted">{s && s.file ? s.file.name : ''}</div>
                  <select className="input" value={q.dir} onChange={(e) => setQueue(queue.map((x, k) => (k === i ? { ...x, dir: e.target.value } : x)))}>
                    {Object.entries(DIR_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                  <span className="small"> → {effective(q) === 'toLight' ? '白底' : '黑底'}</span>
                </div>
                <div className="bi-ops">
                  <button className="btn tiny" disabled={i === 0} onClick={() => { const n = [...queue]; [n[i - 1], n[i]] = [n[i], n[i - 1]]; setQueue(n); }}>↑</button>
                  <button className="btn tiny" disabled={i === queue.length - 1} onClick={() => { const n = [...queue]; [n[i + 1], n[i]] = [n[i], n[i + 1]]; setQueue(n); }}>↓</button>
                  <button className="btn tiny" onClick={() => setQueue(queue.filter((_, k) => k !== i))}>移除</button>
                </div>
              </div>
            );
          })}
        </div>
        {result && (
          <div className="cv-result">
            <div className="side-title">③ 转换结果：{result.path}（{fmtSize(result.size)}；文字 {result.stats.text} 处、图形 {result.stats.shapes} 个、表格 {result.stats.tables} 个、图表 {result.stats.charts || 0} 个、SmartArt {result.stats.diagrams || 0} 个、logo {result.stats.logos} 个）
              {result.fileId && <button className="btn tiny primary" onClick={() => app.openSlide(result.slideIds[0], [result.fileId])}>⛶ 逐页浏览转换结果</button>}
              <button className="btn tiny" onClick={() => api.openPath(result.path)}>用 PowerPoint 打开</button><button className="btn tiny" onClick={() => api.showItem(result.path)}>📂 位置</button></div>
            {result.verify && result.verify.total > 0 && (
              <div className={`notice ${result.verify.failed.length ? 'danger' : 'ok'}`} style={{ margin: '0 0 8px' }}>
                {result.verify.failed.length
                  ? <>转换校验：{result.verify.ok}/{result.verify.total} 页达到目标底色；第 {result.verify.failed.map((c) => c.idx).join('、')} 页未达到（常见原因：页面由整张图片构成、图表或文字是图片、背景来自未识别的图片）。可在“⚙ 转换规则设置”中调整整页背景图阈值后重试。</>
                  : <>✅ 转换校验通过：{result.verify.ok}/{result.verify.total} 页均已转换为目标底色。</>}
              </div>
            )}
            {result.fileId && <div className="muted small" style={{ margin: '0 0 8px' }}>转换结果已加入资料库（解析任务“黑白底转换结果”），可在资料库与检索中找到。</div>}
            <div className="cv-grid big">
              {result.preview.map((p, i) => {
                const src = result.historyAt ? null : qSlides[queue[i] && queue[i].slideId];
                const srcInfo = result.sources && result.sources[i];
                return (
                  <div key={p.id} className="cv-pair">
                    <div>{src ? <><SlidePreview slide={src} file={src.file} /><div className="small muted">原：{THEME_LABEL[src.theme]}</div></> : srcInfo ? <div className="small muted cv-src-info">原：{srcInfo.file} 第 {srcInfo.idx} 页（{THEME_LABEL[srcInfo.theme] || ''}）</div> : null}</div>
                    <div>{p.thumb ? <div className="slide-box" style={{ aspectRatio: p.layout ? `${p.layout.w / p.layout.h}` : '16/9' }}><img src={assetUrl('thumb', p.thumb)} alt="" /></div>
                      : p.layout ? <div className="slide-box" style={{ aspectRatio: `${p.layout.w / p.layout.h}` }}><HtmlSlide layout={p.layout} /></div> : null}
                      <div className="small">转换后：{p.dir === 'toLight' ? '白底' : p.dir === 'toDark' ? '黑底' : '保持'}
                        {result.slideIds && result.slideIds[i] && <button className="btn tiny" onClick={() => app.openSlide(result.slideIds[i], [result.fileId])}>⛶ 查看</button>}</div></div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>}
    </div>
  );
}

const FIELDS = [
  ['bg', '背景'], ['text', '文字'], ['accentText', '原彩色文字'], ['shapeFill', '图形填充'], ['shapeLine', '图形线框'], ['tableLine', '表格框线'], ['headerFill', '表头填充'], ['logo', 'logo 重着色'],
];
const swatch = (v) => (v ? <span className="sw" style={{ background: '#' + v }} /> : <span className="sw none" />);

function describe(rules) {
  const c = (v) => (v ? '#' + v : '无/透明');
  const d = (r) => `背景 ${c(r.bg)}；文字 ${c(r.text)}${rules.options.keepAccentText ? `，原彩色文字 ${c(r.accentText)}` : ''}；图形填充 ${c(r.shapeFill)}、线框 ${c(r.shapeLine)}；表格框线 ${c(r.tableLine)}${r.headerFill ? `、表头 ${c(r.headerFill)}` : ''}；logo ${r.logo ? '重着色为 ' + c(r.logo) : '不处理'}`;
  const cus = (r) => (r.custom && r.custom.length ? `；自定义规则 ${r.custom.filter((c) => c.enabled !== false).length} 条` : '');
  return { toLight: d(rules.toLight) + cus(rules.toLight), toDark: d(rules.toDark) + cus(rules.toDark), options: `小于页面面积 ${Math.round(rules.options.logoMaxArea * 100)}% 的图片视为 logo；${rules.options.removeFullBg ? `大于 ${Math.round(rules.options.fullBgMinArea * 100)}% 的整页背景图移除` : '保留整页背景图'}` };
}

function RulesSummary({ rules }) {
  const d = describe(rules);
  return (
    <div className="small rules-sum">
      <div><b>黑底 → 白底：</b>{d.toLight}</div>
      <div><b>白底 → 黑底：</b>{d.toDark}</div>
      <div className="muted">{d.options}。{rules.updatedAt ? `规则脚本更新于 ${new Date(rules.updatedAt).toLocaleString('zh-CN')}` : '当前为默认规则'}</div>
    </div>
  );
}

// 转换规则设置：两个页签（黑底 → 白底 / 白底 → 黑底），每页有基础规则、自定义规则与效果预览；保存为规则脚本，应用到下一次转换
const BASE_ROWS = {
  toLight: [
    ['bg', '背景', '黑色 / 深色背景（页面、版式、母版）'], ['text', '文字', '白色 / 浅色等普通文字'], ['accentText', '原彩色文字', '红、橙、蓝等彩色文字（需开启“保留彩色文字区分”）'],
    ['shapeFill', '图形填充', '有填充色的形状'], ['shapeLine', '图形线框', '形状边框与连接线'], ['tableLine', '表格框线', '表格的全部边框'], ['headerFill', '表头填充', '表格首行（标题行）底色'], ['logo', 'logo', '小图片（不超过 logo 判定面积）'],
  ],
  toDark: [
    ['bg', '背景', '白色 / 浅色背景（页面、版式、母版）'], ['text', '文字', '黑色 / 深色等普通文字'], ['accentText', '原彩色文字', '红、橙、蓝等彩色文字（需开启“保留彩色文字区分”）'],
    ['shapeFill', '图形填充', '有填充色的形状'], ['shapeLine', '图形线框', '形状边框与连接线'], ['tableLine', '表格框线', '表格的全部边框'], ['headerFill', '表头填充', '表格首行（标题行）底色'], ['logo', 'logo', '小图片（不超过 logo 判定面积）'],
  ],
};
const ELEMENTS = { text: '文字', shapeFill: '图形填充', shapeLine: '图形线条 / 连接线', tableLine: '表格框线', tableFill: '表格单元格填充' };
// 预览用的“原页面”样例颜色
const SAMPLE = {
  toLight: { bg: '111111', text: 'FFFFFF', accent: 'FF9900', shapeFill: '2F5597', shapeLine: 'FFFFFF', tableLine: '7F7F7F', tableFill: '262626', logo: 'E0301E' },
  toDark: { bg: 'FFFFFF', text: '000000', accent: 'C00000', shapeFill: 'D9D9D9', shapeLine: '595959', tableLine: '7F7F7F', tableFill: 'F2F2F2', logo: 'E0301E' },
};
const hexDist = (a, b) => { const x = parseInt(a, 16), y = parseInt(b, 16); return Math.sqrt(((x >> 16) - (y >> 16)) ** 2 + (((x >> 8) & 255) - ((y >> 8) & 255)) ** 2 + ((x & 255) - (y & 255)) ** 2); };
/** 与转换引擎一致：先找第一条匹配的自定义规则，否则用基础规则；返回 'keep' 表示保持原色 */
function resolve(rule, el, orig, base) {
  for (const c of rule.custom || []) {
    if (c.el !== el || c.enabled === false) continue;
    if (c.from === '*' || (orig && /^[0-9A-F]{6}$/i.test(c.from) && hexDist(orig, c.from) <= (c.tol || 0))) return { v: c.to, custom: true };
  }
  return { v: base, custom: false };
}
const css = (v, orig) => (v === 'keep' ? '#' + orig : v ? '#' + v : 'transparent');

function ColorEdit({ value, onChange, allowKeep = false, allowNone = true }) {
  const mode = value === 'keep' ? 'keep' : value === null ? 'none' : 'color';
  return (
    <div className="rule-color">
      <select className="input tiny" value={mode} onChange={(e) => onChange(e.target.value === 'keep' ? 'keep' : e.target.value === 'none' ? null : (mode === 'color' ? value : 'FFFFFF'))}>
        <option value="color">指定颜色</option>
        {allowKeep && <option value="keep">保持原色</option>}
        {allowNone && <option value="none">无 / 透明</option>}
      </select>
      {mode === 'color' && <>
        <input type="color" value={'#' + (value || 'FFFFFF')} onChange={(e) => onChange(e.target.value.slice(1).toUpperCase())} />
        <input className="input hex" value={value || ''} onChange={(e) => onChange(/^[0-9a-f]{6}$/i.test(e.target.value) ? e.target.value.toUpperCase() : e.target.value)} />
      </>}
    </div>
  );
}

function RulePreview({ dir, rule, options }) {
  const o = SAMPLE[dir];
  const r = (el, orig, base) => css(resolve(rule, el, orig, base).v, orig);
  const before = { bg: '#' + o.bg, text: '#' + o.text, accent: '#' + o.accent, fill: '#' + o.shapeFill, line: '#' + o.shapeLine, tline: '#' + o.tableLine, tfill: '#' + o.tableFill, logo: '#' + o.logo };
  const after = {
    bg: '#' + rule.bg, text: r('text', o.text, rule.text), accent: r('text', o.accent, options.keepAccentText ? rule.accentText : rule.text),
    fill: r('shapeFill', o.shapeFill, rule.shapeFill), line: r('shapeLine', o.shapeLine, rule.shapeLine), tline: r('tableLine', o.tableLine, rule.tableLine),
    tfill: r('tableFill', o.tableFill, null), head: r('tableFill', o.tableFill, rule.headerFill), logo: rule.logo ? '#' + rule.logo : '#' + o.logo,
  };
  const card = (c, title) => (
    <div className="rp-card">
      <div className="rp-cap">{title}</div>
      <div className="rp-slide" style={{ background: c.bg }}>
        <div className="rp-logo" style={{ background: c.logo }} />
        <div className="rp-title" style={{ color: c.text }}>标题文字 Title</div>
        <div className="rp-line" style={{ color: c.text }}>• 普通正文 <span style={{ color: c.accent }}>彩色强调</span></div>
        <div className="rp-shape" style={{ background: c.fill, borderColor: c.line }}><span style={{ color: c.text }}>图形</span></div>
        <table className="rp-table" style={{ borderColor: c.tline }}><tbody>
          <tr>{[1, 2].map((k) => <td key={k} style={{ borderColor: c.tline, background: c.head || c.tfill, color: c.text }}>表头</td>)}</tr>
          <tr>{[1, 2].map((k) => <td key={k} style={{ borderColor: c.tline, background: c.tfill, color: c.text }}>数据</td>)}</tr>
        </tbody></table>
      </div>
    </div>
  );
  return <div className="rule-preview">{card(before, dir === 'toLight' ? '转换前（黑底示例）' : '转换前（白底示例）')}<div className="rp-arrow">→</div>{card(after, '转换后')}</div>;
}

// “新增规则”中的样例：未修改时保存会被忽略
let draftSeq = 0;
const SAMPLE_FIELDS = (dir) => ({ el: 'text', from: dir === 'toLight' ? 'FF0000' : 'C00000', tol: 40, to: dir === 'toLight' ? 'C00000' : 'FF6666', note: '', enabled: true });
const sampleRule = (dir) => ({ ...SAMPLE_FIELDS(dir), _k: `d${++draftSeq}` });
const untouchedSample = (dir, d) => { const f = SAMPLE_FIELDS(dir); return Object.keys(f).every((k) => (d[k] ?? '') === f[k]); };

function RulesDialog({ onClose }) {
  const app = useApp();
  const [r, setR] = useState(null);
  const [tab, setTab] = useState('toLight');
  const [script, setScript] = useState('');
  const [draft, setDraft] = useState(() => ({ toLight: [sampleRule('toLight')], toDark: [sampleRule('toDark')] }));
  useEffect(() => { api.getConvertRules().then((x) => { setR(x); setScript(JSON.stringify(x, null, 2)); }); }, []);
  if (!r) return null;
  const upd = (n) => { setR(n); setScript(JSON.stringify(n, null, 2)); };
  const rule = r[tab];
  const setC = (k, v) => upd({ ...r, [tab]: { ...rule, [k]: v } });
  const setO = (k, v) => upd({ ...r, options: { ...r.options, [k]: v } });
  const custom = rule.custom || [];
  const setCustom = (list) => upd({ ...r, [tab]: { ...rule, custom: list } });
  // 新增规则：先在“新增规则”中编辑（默认放一条样例），点“保存新增的规则”后才加入自定义规则；未修改的样例在保存时忽略
  const drafts = (draft && draft[tab]) || [];
  const setDrafts = (list) => setDraft((d) => ({ ...d, [tab]: list }));
  const changed = drafts.filter((d) => !untouchedSample(tab, d));
  const ruleColumns = (list, setList, isDraft) => {
    const patch = (i, p) => setList(list.map((c, k) => (k === i ? { ...c, ...p } : c)));
    const move = (i, d) => { const n = [...list]; const j = i + d; if (j < 0 || j >= n.length) return; [n[i], n[j]] = [n[j], n[i]]; setList(n); };
    return [
      { key: 'i', label: '#', nosort: true, render: (c) => (isDraft && untouchedSample(tab, c) ? <span className="tag">样例</span> : c.i + 1) },
      { key: 'enabled', label: '启用', nosort: true, render: (c) => <input type="checkbox" checked={c.enabled !== false} onChange={(e) => patch(c.i, { enabled: e.target.checked })} /> },
      { key: 'el', label: '元素', nosort: true, render: (c) => <select className="input tiny" value={c.el} onChange={(e) => patch(c.i, { el: e.target.value })}>{Object.entries(ELEMENTS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select> },
      { key: 'from', label: '原颜色', nosort: true, render: (c) => (
        <div className="rule-color">
          <select className="input tiny" value={c.from === '*' ? 'any' : 'color'} onChange={(e) => patch(c.i, { from: e.target.value === 'any' ? '*' : 'FF0000' })}><option value="any">任意颜色</option><option value="color">指定颜色</option></select>
          {c.from !== '*' && <>
            <input type="color" value={'#' + (/^[0-9A-F]{6}$/i.test(c.from) ? c.from : 'FF0000')} onChange={(e) => patch(c.i, { from: e.target.value.slice(1).toUpperCase() })} />
            <input className="input hex" value={c.from} onChange={(e) => patch(c.i, { from: e.target.value.toUpperCase() })} />
            <span className="muted small" title="与指定颜色相差在该范围内都算匹配（0 = 完全一致）">近似</span>
            <input className="input num" type="number" min="0" max="255" value={c.tol || 0} onChange={(e) => patch(c.i, { tol: Number(e.target.value) })} />
          </>}
        </div>
      ) },
      { key: 'to', label: '→ 转换后', nosort: true, render: (c) => <ColorEdit value={c.to} allowKeep onChange={(v) => patch(c.i, { to: v })} /> },
      { key: 'note', label: '说明', nosort: true, render: (c) => <input className="input" value={c.note || ''} placeholder="如：红色强调字改深红" onChange={(e) => patch(c.i, { note: e.target.value })} /> },
      { key: 'ops', label: '操作', nosort: true, className: 'nowrap', render: (c) => <><button className="btn tiny" disabled={c.i === 0} onClick={() => move(c.i, -1)}>↑</button><button className="btn tiny" disabled={c.i === list.length - 1} onClick={() => move(c.i, 1)}>↓</button><button className="btn tiny" onClick={() => setList(list.filter((_, k) => k !== c.i))}>删除</button></> },
    ];
  };
  const rows = custom.map((c, i) => ({ ...c, i }));
  const columns = ruleColumns(custom, setCustom, false);
  const draftRows = drafts.map((c, i) => ({ ...c, i }));
  const draftColumns = ruleColumns(drafts, setDrafts, true);
  const addRule = () => setDrafts([...drafts, sampleRule(tab)]);
  // 把两个方向中改过的新增规则并入自定义规则（未修改的样例忽略）
  const withDrafts = (base) => {
    const out = { ...base };
    for (const d of ['toLight', 'toDark']) {
      const add = ((draft && draft[d]) || []).filter((x) => !untouchedSample(d, x)).map(({ _k, ...x }) => x);
      if (add.length) out[d] = { ...out[d], custom: [...(out[d].custom || []), ...add] };
    }
    return out;
  };
  const saveNew = async () => {
    if (!changed.length) { app.toast('样例规则还没有修改，没有需要保存的新增规则', 'error'); return; }
    const next = { ...r, [tab]: { ...rule, custom: [...custom, ...changed.map(({ _k, ...x }) => x)] } };
    try {
      const saved = await api.setConvertRules(next);
      upd(saved || next);
      setDrafts([sampleRule(tab)]);
      app.toast(`已保存 ${changed.length} 条新增规则（${tab === 'toLight' ? '黑底转白底' : '白底转黑底'}）`, 'info', { cat: '黑白底互转' });
    } catch (e) { app.toast(e.message, 'error'); }
  };
  return (
    <div className="overlay" onClick={() => onClose(null)}>
      <div className="modal rules-modal" onClick={(e) => e.stopPropagation()}>
        <div className="detail-head"><div className="dh-title">⚙ 黑白底互转 · 转换规则设置</div><div className="spacer" /><button className="icon-btn" onClick={() => onClose(null)}>✕</button></div>
        <div className="tabs attached rules-tabs">
          <button className={tab === 'toLight' ? 'on' : ''} onClick={() => setTab('toLight')}>⬛ → ⬜ 黑底转白底{r.toLight.custom && r.toLight.custom.length ? `（自定义 ${r.toLight.custom.length}）` : ''}</button>
          <button className={tab === 'toDark' ? 'on' : ''} onClick={() => setTab('toDark')}>⬜ → ⬛ 白底转黑底{r.toDark.custom && r.toDark.custom.length ? `（自定义 ${r.toDark.custom.length}）` : ''}</button>
        </div>
        <div className="modal-body pad rules-body">
          <RulePreview dir={tab} rule={rule} options={r.options} />
          <h4>基础规则 <span className="muted small">原页面中的元素 → 转换后的呈现</span></h4>
          <table className="grid rules-table">
            <thead><tr><th>元素</th><th>原页面中</th><th>转换后</th><th>效果</th></tr></thead>
            <tbody>{BASE_ROWS[tab].map(([k, label, desc]) => (
              <tr key={k}>
                <td><b>{label}</b></td>
                <td className="muted small">{desc}</td>
                <td><ColorEdit value={rule[k]} allowNone={k !== 'bg' && k !== 'text'} onChange={(v) => setC(k, v)} /></td>
                <td className="nowrap">{swatch(SAMPLE[tab][{ accentText: 'accent', headerFill: 'tableFill' }[k] || k])}<span className="muted"> → </span>{k === 'logo' && !rule[k] ? <span className="muted small">不处理</span> : swatch(rule[k])}</td>
              </tr>
            ))}</tbody>
          </table>
          <h4>自定义规则 <span className="muted small">按“元素 + 原颜色”精确或近似匹配，优先于基础规则；从上到下第一条匹配的生效</span></h4>
          <DataTable id={`convRules-${tab}`} columns={columns} rows={rows} rowKey={(c) => c.i} empty="还没有自定义规则：在下方“新增规则”中修改样例，然后点击“保存新增的规则”。" />
          <div className="rule-new">
            <div className="rule-new-head"><b>新增规则</b><span className="muted small">{changed.length ? `已修改 ${changed.length} 条` : '样例未修改时不会保存'}</span></div>
            <DataTable id={`convRulesNew-${tab}`} sessionKey={`convRulesNew-${tab}`} columns={draftColumns} rows={draftRows} rowKey={(c) => c._k} empty="点击“＋ 添加规则”新增一条" />
            <div className="row"><button className="btn small" onClick={addRule}>＋ 添加规则</button><button className="btn small primary" disabled={!changed.length} onClick={saveNew}>💾 保存新增的规则{changed.length ? `（${changed.length}）` : ''}</button></div>
          </div>
          <h4>通用选项 <span className="muted small">两个方向共用</span></h4>
          <div className="rule-opts">
            <label className="chk"><input type="checkbox" checked={r.options.keepAccentText} onChange={(e) => setO('keepAccentText', e.target.checked)} />保留“彩色文字”的区分（使用“原彩色文字”颜色）</label>
            <label className="chk"><input type="checkbox" checked={r.options.removeFullBg} onChange={(e) => setO('removeFullBg', e.target.checked)} />移除铺满整页的背景图</label>
            <label>整页背景图判定（≥ 页面面积）<input className="input num" type="number" step="0.05" min="0.3" max="1" value={r.options.fullBgMinArea} onChange={(e) => setO('fullBgMinArea', Number(e.target.value))} /></label>
            <label>logo 判定（≤ 页面面积）<input className="input num" type="number" step="0.01" min="0" max="0.5" value={r.options.logoMaxArea} onChange={(e) => setO('logoMaxArea', Number(e.target.value))} /></label>
          </div>
          <div className="rule-nl wip-box">
            <div className="small"><b>🤖 用自然语言描述生成规则</b> <span className="wip">建设中</span></div>
            <textarea className="input" rows={2} disabled placeholder="例如：黑转白时文字改为深蓝色 1F3864，表格框线用中灰色" />
            <button className="btn" disabled>按描述生成规则</button>
          </div>
          <details className="rule-script"><summary>规则脚本（JSON，可直接编辑）</summary>
            <textarea className="pane-edit mono" rows={14} value={script} onChange={(e) => setScript(e.target.value)} />
            <button className="btn small" onClick={() => { try { upd(JSON.parse(script)); app.toast('已应用 JSON 到表单'); } catch (e) { app.toast('JSON 格式错误：' + e.message, 'error'); } }}>应用 JSON 到表单</button>
          </details>
        </div>
        <div className="detail-head">
          <button className="btn ghost" onClick={async () => { if (!confirm('恢复默认规则？自定义规则会被清除。')) return; const d = await api.resetConvertRules(); upd(d); app.toast('已恢复默认规则'); }}>恢复默认</button>
          <div className="spacer" />
          <button className="btn" onClick={() => onClose(null)}>取消</button>
          <button className="btn primary" onClick={async () => { try { const saved = await api.setConvertRules(withDrafts(r)); app.toast('转换规则已保存，将应用到下一次转换'); onClose(saved); } catch (e) { app.toast(e.message, 'error'); } }}>保存规则</button>
        </div>
      </div>
    </div>
  );
}
