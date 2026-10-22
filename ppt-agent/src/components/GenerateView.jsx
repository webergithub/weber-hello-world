import React, { useEffect, useRef, useState } from 'react';
import { api, fmtSize, THEME_LABEL } from '../api';
import { useApp } from '../ctx';
import SlidePreview from './SlidePreview';

const EXAMPLES = ['航班过站保障介绍，包含封面、里程碑和 KPI', '对比格式的模板页面', '智慧机场 AI 平台架构', '时间线 路线图', '安全培训 视频'];

// 智能生成：描述 → 自动匹配候选页面 → 纵向列出不同内容的页面、横向列出每页的相似页 → 用户挑选 → 生成 PPT
export default function GenerateView({ state, setState }) {
  const app = useApp();
  const { desc = '', data = null, threshold = 0.75, theme = 'any', rows = null, made = null } = state;
  const [unifying, setUnifying] = useState(null);
  const [input, setInput] = useState(desc);
  const [busy, setBusy] = useState(false);
  const [making, setMaking] = useState(false);
  const timer = useRef(null);
  const set = (patch) => setState((s) => ({ ...s, ...patch }));

  const run = async (text = input, th = threshold, th2 = theme) => {
    if (!text.trim()) return;
    setBusy(true);
    try {
      const d = await api.smartCandidates(text.trim(), { threshold: th, theme: th2 });
      set({ desc: text.trim(), data: d, rows: d.rows.map((r) => ({ ...r, on: true, picks: [r.pick] })) });
    } catch (e) { app.toast('匹配失败：' + e.message, 'error'); } finally { setBusy(false); }
  };
  // 调整相似阈值 / 底色偏好后自动重新分组
  const onThreshold = (v) => {
    set({ threshold: v });
    clearTimeout(timer.current);
    if (desc) timer.current = setTimeout(() => run(desc, v, theme), 350);
  };
  const onTheme = (v) => { set({ theme: v }); if (desc) run(desc, threshold, v); };
  useEffect(() => () => clearTimeout(timer.current), []);

  // 每组可多选（相似度高的页面也可以同时加入），按组顺序、组内按页面顺序生成
  const list = (rows || []).map((r) => (r.picks ? r : { ...r, picks: r.pick ? [r.pick] : [] }));
  const chosen = list.filter((r) => r.on).flatMap((r) => r.items.filter((it) => r.picks.includes(it.id)).map((it) => it.id));
  const togglePick = (i, id) => {
    const r = list[i];
    const picks = r.picks.includes(id) ? r.picks.filter((x) => x !== id) : [...r.picks, id];
    patchRow(i, { picks, pick: picks[0] || null, on: picks.length > 0 });
  };
  const patchRow = (i, p) => set({ rows: list.map((r, k) => (k === i ? { ...r, ...p } : r)) });
  const move = (i, d) => { const n = [...list]; const j = i + d; if (j < 0 || j >= n.length) return; [n[i], n[j]] = [n[j], n[i]]; set({ rows: n }); };
  const make = async () => {
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-T:]/g, '');
    const out = await api.saveFile(`智能生成_${(desc || 'PPT').slice(0, 20).replace(/[\\/:*?"<>|\s]+/g, '_')}_${stamp}.pptx`, 'pptx', 'generate');
    if (!out) return;
    setMaking(true);
    try {
      // 第一步只生成新 PPT（保持原样）；之后在生成结果中逐页查看，并可另存统一为白底 / 黑底的版本
      const r = await api.generateDeck(chosen, out);
      const byId = new Map(list.flatMap((x) => x.items).map((it) => [it.id, it]));
      const pages = chosen.map((id) => byId.get(id)).filter((it) => it && (it.kind || 'ppt') === 'ppt');
      set({ made: { path: out, size: r.size, slides: r.slides, ids: chosen, pages, outputs: {} } });
      app.toast(`已生成 PPT：${r.slides} 页 → ${out}${r.size ? '（' + fmtSize(r.size) + '）' : ''}`, 'info', { label: '打开', link: { type: 'open', path: out }, cat: '智能生成' });
    } catch (e) { app.toast('生成失败：' + e.message, 'error'); } finally { setMaking(false); }
  };
  const unify = async (to) => {
    if (!made) return;
    setUnifying(to);
    try {
      const r = await api.unifyDeck(made.path, made.ids, to);
      set({ made: { ...made, outputs: { ...made.outputs, [to]: { path: r.path, size: r.size, converted: r.converted, slides: r.slides } } } });
      app.toast(`已另存${to === 'light' ? '白底' : '黑底'}版本：${r.path}（转换 ${r.converted}/${r.slides} 页）`, 'info', { label: '打开', link: { type: 'open', path: r.path }, cat: '智能生成' });
    } catch (e) { app.toast('转换失败：' + e.message, 'error'); } finally { setUnifying(null); }
  };
  const fileName = (p) => String(p || '').split(/[\\/]/).pop();
  const step = made ? 3 : chosen.length ? 2 : 1;
  const steps = <div className="gen-steps">{['挑选页面', '生成新 PPT', '统一白底 / 黑底'].map((t, k) => <span key={t} className={`gs ${step === k + 1 ? 'on' : step > k + 1 ? 'done' : ''}`}><b>{step > k + 1 ? '✓' : k + 1}</b>{t}</span>)}</div>;

  return (
    <div className="view">
      <div className="view-head">
        <div className="vh-title">✨ 智能生成 <span className="muted small">描述主题或版式要求 → 自动匹配最合适的页面 → 挑选后生成 PPT</span></div>
        <div className="spacer" />
        <div className="gen-ctl" title="相似度不低于该值的页面归为同一组（横向展示）">
          <span>相似阈值</span>
          <input type="range" min="0.5" max="0.98" step="0.01" value={threshold} onChange={(e) => onThreshold(Number(e.target.value))} />
          <b>{Math.round(threshold * 100)}%</b>
        </div>
        <div className="gen-ctl">
          <span>默认选择</span>
          <div className="seg small">{[['any', '不限'], ['light', '白底'], ['dark', '黑底']].map(([k, v]) => <button key={k} className={theme === k ? 'on' : ''} onClick={() => onTheme(k)}>{v}</button>)}</div>
        </div>
      </div>
      <div className="search-bar">
        <textarea className="input big gen-input" rows={2} placeholder="例如：做一份航班过站保障介绍，包含封面、关键里程碑、KPI 统计和优化建议；或：需要一个对比格式的模板页面" value={input}
          onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) run(); }} />
        <button className="btn primary big" disabled={busy} onClick={() => run()}>{busy ? '匹配中…' : '🔎 智能匹配'}</button>
      </div>
      {!data && (
        <div className="search-empty">
          <p>根据描述中的<b>主题</b>做中英文混合检索（本地 RAG），并识别<b>版式要求</b>（对比、目录、封面、时间线 / 路线图、流程、表格、图表、架构、总结、图片）。匹配结果按相似阈值分组：<b>纵向</b>每行是一种不同内容的页面，<b>横向</b>是与之相似的页面（如黑底 / 白底版本、不同版本副本），每行选择一页后生成 PPT。</p>
          <div className="chips">{EXAMPLES.map((x) => <span key={x} className="chip link" onClick={() => { setInput(x); run(x); }}>{x}</span>)}</div>
        </div>
      )}
      {made && (
        <div className="gen-made">
          {steps}
          <div className="gm-head">
            <div className="gm-title">✅ 已生成 <b title={made.path}>{fileName(made.path)}</b><span className="muted small"> · {made.slides} 页{made.size ? ` · ${fmtSize(made.size)}` : ''}</span></div>
            <div className="spacer" />
            <button className="btn primary" disabled={!!unifying} onClick={() => unify('light')}>{unifying === 'light' ? '转换中…' : '⬜ 统一为白底'}</button>
            <button className="btn primary" disabled={!!unifying} onClick={() => unify('dark')}>{unifying === 'dark' ? '转换中…' : '⬛ 统一为黑底'}</button>
            <button className="btn" onClick={() => api.openPath(made.path)}>打开</button>
            <button className="btn" onClick={() => api.showItem(made.path)}>📂 位置</button>
            <button className="btn ghost" onClick={() => set({ made: null })}>← 返回继续挑选</button>
          </div>
          {['light', 'dark'].filter((k) => made.outputs[k]).map((k) => (
            <div key={k} className="gm-out"><span className={`tag theme-${k}`}>{k === 'light' ? '白底版' : '黑底版'}</span><b title={made.outputs[k].path}>{fileName(made.outputs[k].path)}</b>
              <span className="muted small">转换 {made.outputs[k].converted}/{made.outputs[k].slides} 页{made.outputs[k].size ? ` · ${fmtSize(made.outputs[k].size)}` : ''}</span>
              <button className="btn tiny" onClick={() => api.openPath(made.outputs[k].path)}>打开</button><button className="btn tiny" onClick={() => api.showItem(made.outputs[k].path)}>📂 位置</button></div>
          ))}
          <div className="gm-pages">
            {made.pages.map((it, k) => (
              <div key={`${it.id}-${k}`} className="gm-page" onDoubleClick={() => app.openSlide(it.id, [...new Set(made.pages.map((x) => x.file_id))])}>
                <SlidePreview slide={it} />
                <div className="gc-info">
                  <div className="small"><b>第 {k + 1} 页</b> <span className={`tag theme-${it.theme}`}>{THEME_LABEL[it.theme]}</span></div>
                  <div className="small ellipsis" title={it.title}>{it.title || '（无标题）'}</div>
                  <div className="muted small ellipsis" title={it.filePath}>来自 {it.fileName} 第 {it.idx} 页</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      {data && !made && (
        <>
          <div className="analysis">
            <span className="muted">理解：</span>
            {data.intent.topic && <span className="qgroup"><b>主题</b> {data.intent.topic}</span>}
            {data.intent.formats.map((f) => <span key={f} className="qgroup"><b>版式</b> {f}</span>)}
            <span className="muted small">候选 {data.candidates} 页 → {list.length} 组不同内容（阈值 {Math.round(data.threshold * 100)}%）</span>
          </div>
          <div className="gen-rows">
            {!list.length && <div className="empty-tip">没有匹配的页面，换个描述或先解析更多 PPT</div>}
            {list.map((r, i) => (
              <div key={r.items[0].id} className={`gen-row ${r.on ? '' : 'off'}`}>
                <div className="gr-head">
                  <label className="chk"><input type="checkbox" checked={r.on} onChange={() => patchRow(i, { on: !r.on })} /> <b>{i + 1}</b></label>
                  <div className="gr-title" title={r.title}>{r.title}</div>
                  <div className="gr-meta">{r.formats.map((f) => <span key={f} className="tag accent">{f}</span>)}<span className="muted small">相似页 {r.total}{r.picks.length > 1 ? ` · 已选 ${r.picks.length} 页` : ''}</span></div>
                  <div className="gr-ops"><button className="btn tiny" onClick={() => patchRow(i, { picks: r.items.map((it) => it.id), on: true })}>本组全选</button><button className="btn tiny ghost" disabled={r.picks.length <= 1} onClick={() => patchRow(i, { picks: [r.items[0].id], pick: r.items[0].id })}>只留代表页</button></div>
                  <div className="gr-ops"><button className="btn tiny" disabled={i === 0} onClick={() => move(i, -1)}>↑</button><button className="btn tiny" disabled={i === list.length - 1} onClick={() => move(i, 1)}>↓</button></div>
                </div>
                <div className="gr-items">
                  {r.items.map((it, k) => (
                    <div key={it.id} className={`gen-card ${r.picks.includes(it.id) ? 'picked' : ''}`} onClick={() => togglePick(i, it.id)} onDoubleClick={() => app.openSlide(it.id, [...new Set(list.flatMap((x) => x.items.map((y) => y.file_id)))])}>
                      <SlidePreview slide={it} />
                      <div className="gc-info">
                        <div className="small ellipsis" title={it.filePath}>{it.fileName} · 第 {it.idx} 页</div>
                        <div className="small"><span className={`tag theme-${it.theme}`}>{THEME_LABEL[it.theme]}</span>{k === 0 ? <span className="tag hit">代表页</span> : <span className="muted">相似 {Math.round(it.sim * 100)}%</span>}{it.notes ? <span className="muted"> · 有讲解词</span> : ''}</div>
                      </div>
                      {r.picks.includes(it.id) && <span className="gc-check">✓ 已选{r.picks.length > 1 ? ` ${r.picks.indexOf(it.id) + 1}` : ''}</span>}
                      <button className="gc-zoom" title="逐页浏览" onClick={(e) => { e.stopPropagation(); app.openSlide(it.id, [...new Set(list.flatMap((x) => x.items.map((y) => y.file_id)))]); }}>⛶</button>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div className="gen-foot">
            {steps}
            <span className="badge">将生成 {chosen.length} 页</span>
            <div className="spacer" />
            <button className="btn" onClick={() => set({ rows: list.map((r) => ({ ...r, on: true, picks: r.picks.length ? r.picks : [r.items[0].id] })) })}>每组都选上</button>
            <button className="btn" disabled={!chosen.length} onClick={() => app.basket.add(chosen)}>＋ 加入导出篮</button>
            <button className="btn primary" disabled={!chosen.length || making} onClick={make}>{making ? '生成中…' : '📄 生成新 PPT'}</button>
          </div>
        </>
      )}
    </div>
  );
}
