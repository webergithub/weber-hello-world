import React, { useEffect, useState } from 'react';
import { api, fmtSize, THEME_LABEL, assetUrl } from '../api';
import { useApp } from '../ctx';
import SlidePreview, { HtmlSlide } from './SlidePreview';

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
  useEffect(() => { api.getConvertRules().then(setRules); }, []);

  useEffect(() => { Promise.all(app.basket.items.map((id) => api.slideDetail(id).catch(() => null))).then((l) => setBasket(l.filter(Boolean))); }, [app.basket.items]);
  useEffect(() => { const m = {}; for (const s of basket) m[s.id] = s; setQSlides((o) => ({ ...o, ...m })); }, [basket]);
  const pptSlides = basket.filter((s) => !(s.file && s.file.kind === 'word'));
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
      setResult(r);
      app.toast(`转换完成：${r.slides} 页 → ${out}`, 'info', { label: '打开', run: () => api.openPath(out) });
    } catch (e) { app.toast('转换失败：' + e.message, 'error'); } finally { setBusy(false); }
  };

  return (
    <div className="view">
      {rulesOpen && <RulesDialog onClose={(r) => { setRulesOpen(false); if (r) setRules(r); }} />}
      <div className="view-head">
        <div className="vh-title">🌓 PPT 黑白底互转</div>
        <div className="spacer" />
        <button className="btn ghost" disabled={!queue.length} onClick={() => setQueue([])}>清空序列</button>
        <button className="btn primary" disabled={!queue.length || busy} onClick={run}>{busy ? '转换中…' : `开始转换并导出（${queue.length} 页）`}</button>
      </div>
      <div className="convert">
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
          <div className="rules">
            <div className="rules-head"><b>转化规则</b><div className="spacer" /><button className="btn small" onClick={() => setRulesOpen(true)}>⚙ 转换规则设置</button></div>
            {rules && <RulesSummary rules={rules} />}
          </div>
        </div>
        {result && (
          <div className="cv-result">
            <div className="side-title">③ 转换结果：{result.path}（{fmtSize(result.size)}；文字 {result.stats.text} 处、图形 {result.stats.shapes} 个、表格 {result.stats.tables} 个、图表 {result.stats.charts || 0} 个、SmartArt {result.stats.diagrams || 0} 个、logo {result.stats.logos} 个）
              {result.fileId && <button className="btn tiny primary" onClick={() => app.openSlide(result.slideIds[0], [result.fileId])}>⛶ 逐页浏览转换结果</button>}
              <button className="btn tiny" onClick={() => api.openPath(result.path)}>用 PowerPoint 打开</button><button className="btn tiny" onClick={() => api.showItem(result.path)}>位置</button></div>
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
                const src = qSlides[queue[i] && queue[i].slideId];
                return (
                  <div key={p.id} className="cv-pair">
                    <div>{src && <SlidePreview slide={src} file={src.file} />}<div className="small muted">原：{THEME_LABEL[src && src.theme]}</div></div>
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
      </div>
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
  return { toLight: d(rules.toLight), toDark: d(rules.toDark), options: `小于页面面积 ${Math.round(rules.options.logoMaxArea * 100)}% 的图片视为 logo；${rules.options.removeFullBg ? `大于 ${Math.round(rules.options.fullBgMinArea * 100)}% 的整页背景图移除` : '保留整页背景图'}` };
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

// 转换规则设置：表单编辑 → 生成规则脚本（JSON）→ 保存后应用到下一次转换
function RulesDialog({ onClose }) {
  const app = useApp();
  const [r, setR] = useState(null);
  const [script, setScript] = useState('');
  const [nl, setNl] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.getConvertRules().then((x) => { setR(x); setScript(JSON.stringify(x, null, 2)); }); }, []);
  if (!r) return null;
  const upd = (n) => { setR(n); setScript(JSON.stringify(n, null, 2)); };
  const setC = (dir, k, v) => upd({ ...r, [dir]: { ...r[dir], [k]: v } });
  const setO = (k, v) => upd({ ...r, options: { ...r.options, [k]: v } });
  const colorCell = (dir, k) => {
    const v = r[dir][k];
    return (
      <td key={dir}>
        <div className="rule-color">
          <input type="color" value={'#' + (v || 'FFFFFF')} disabled={!v} onChange={(e) => setC(dir, k, e.target.value.slice(1).toUpperCase())} />
          <input className="input hex" value={v || ''} placeholder="无" onChange={(e) => setC(dir, k, /^[0-9a-f]{6}$/i.test(e.target.value) ? e.target.value.toUpperCase() : e.target.value)} />
          <label className="chk small"><input type="checkbox" checked={!v} onChange={(e) => setC(dir, k, e.target.checked ? null : 'FFFFFF')} />无/透明</label>
        </div>
      </td>
    );
  };
  return (
    <div className="overlay" onClick={() => onClose(null)}>
      <div className="modal rules-modal" onClick={(e) => e.stopPropagation()}>
        <div className="detail-head"><div className="dh-title">⚙ 黑白底互转 · 转换规则设置</div><div className="spacer" /><button className="icon-btn" onClick={() => onClose(null)}>✕</button></div>
        <div className="modal-body pad">
          <p className="muted small">编辑下方规则后点击“保存规则脚本”，生成新的转换规则脚本（JSON，保存在数据目录 convert-rules.json），并应用到下一次转换。</p>
          <table className="grid rules-table">
            <thead><tr><th>对象</th><th>黑底 → 白底</th><th>白底 → 黑底</th></tr></thead>
            <tbody>{FIELDS.map(([k, label]) => <tr key={k}><td>{label}</td>{colorCell('toLight', k)}{colorCell('toDark', k)}</tr>)}</tbody>
          </table>
          <div className="rule-opts">
            <label className="chk"><input type="checkbox" checked={r.options.keepAccentText} onChange={(e) => setO('keepAccentText', e.target.checked)} />保留“彩色文字”的区分（使用“原彩色文字”颜色）</label>
            <label className="chk"><input type="checkbox" checked={r.options.removeFullBg} onChange={(e) => setO('removeFullBg', e.target.checked)} />移除铺满整页的背景图</label>
            <label>整页背景图判定（≥ 页面面积）<input className="input num" type="number" step="0.05" min="0.3" max="1" value={r.options.fullBgMinArea} onChange={(e) => setO('fullBgMinArea', Number(e.target.value))} /></label>
            <label>logo 判定（≤ 页面面积）<input className="input num" type="number" step="0.01" min="0" max="0.5" value={r.options.logoMaxArea} onChange={(e) => setO('logoMaxArea', Number(e.target.value))} /></label>
          </div>
          <div className="rules-sum-box"><RulesSummary rules={r} /></div>
          <div className="rule-nl">
            <textarea className="input" rows={2} placeholder="用自然语言描述修改，例如：黑转白时文字改为深蓝色 1F3864，表格框线用中灰色（需要在设置中配置大模型）" value={nl} onChange={(e) => setNl(e.target.value)} />
            <button className="btn" disabled={!nl.trim() || busy} onClick={async () => { setBusy(true); try { upd(await api.convertRulesFromText(nl)); app.toast('已根据描述生成新规则，请确认后保存'); } catch (e) { app.toast(e.message, 'error'); } finally { setBusy(false); } }}>{busy ? '生成中…' : '🤖 按描述生成规则'}</button>
          </div>
          <details className="rule-script"><summary>规则脚本（JSON，可直接编辑）</summary>
            <textarea className="pane-edit mono" rows={14} value={script} onChange={(e) => setScript(e.target.value)} />
            <button className="btn small" onClick={() => { try { upd(JSON.parse(script)); app.toast('已应用 JSON 到表单'); } catch (e) { app.toast('JSON 格式错误：' + e.message, 'error'); } }}>应用 JSON 到表单</button>
          </details>
        </div>
        <div className="detail-head">
          <button className="btn ghost" onClick={async () => { const d = await api.resetConvertRules(); upd(d); app.toast('已恢复默认规则'); }}>恢复默认</button>
          <div className="spacer" />
          <button className="btn" onClick={() => onClose(null)}>取消</button>
          <button className="btn primary" onClick={async () => { try { const saved = await api.setConvertRules(r); app.toast('规则脚本已保存，将应用到下一次转换'); onClose(saved); } catch (e) { app.toast(e.message, 'error'); } }}>保存规则脚本</button>
        </div>
      </div>
    </div>
  );
}
