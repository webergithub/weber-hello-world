import React, { useEffect, useRef, useState } from 'react';
import { api, fmtSize, THEME_LABEL } from '../api';
import { useApp } from '../ctx';
import SlidePreview from './SlidePreview';

const EXAMPLES = ['航班过站保障介绍，包含封面、里程碑和 KPI', '对比格式的模板页面', '智慧机场 AI 平台架构', '时间线 路线图', '安全培训 视频'];

// 智能生成：描述 → 自动匹配候选页面 → 纵向列出不同内容的页面、横向列出每页的相似页 → 用户挑选 → 生成 PPT
export default function GenerateView({ state, setState }) {
  const app = useApp();
  const { desc = '', data = null, threshold = 0.75, theme = 'any', unify = 'none', rows = null } = state;
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
      set({ desc: text.trim(), data: d, rows: d.rows.map((r) => ({ ...r, on: true })) });
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

  const list = rows || [];
  const chosen = list.filter((r) => r.on).map((r) => r.pick);
  const patchRow = (i, p) => set({ rows: list.map((r, k) => (k === i ? { ...r, ...p } : r)) });
  const move = (i, d) => { const n = [...list]; const j = i + d; if (j < 0 || j >= n.length) return; [n[i], n[j]] = [n[j], n[i]]; set({ rows: n }); };
  const make = async () => {
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-T:]/g, '');
    const out = await api.saveFile(`智能生成_${(desc || 'PPT').slice(0, 20).replace(/[\\/:*?"<>|\s]+/g, '_')}_${stamp}.pptx`, 'pptx', 'generate');
    if (!out) return;
    setMaking(true);
    try {
      const r = await api.generateDeck(chosen, out, { unifyTheme: unify });
      app.toast(`已生成 PPT：${r.slides} 页 → ${out}${r.size ? '（' + fmtSize(r.size) + '）' : ''}`, 'info', { label: '打开', run: () => api.openPath(out) });
    } catch (e) { app.toast('生成失败：' + e.message, 'error'); } finally { setMaking(false); }
  };

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
      {data && (
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
                  <div className="gr-meta">{r.formats.map((f) => <span key={f} className="tag accent">{f}</span>)}<span className="muted small">相似页 {r.total}</span></div>
                  <div className="gr-ops"><button className="btn tiny" disabled={i === 0} onClick={() => move(i, -1)}>↑</button><button className="btn tiny" disabled={i === list.length - 1} onClick={() => move(i, 1)}>↓</button></div>
                </div>
                <div className="gr-items">
                  {r.items.map((it, k) => (
                    <div key={it.id} className={`gen-card ${r.pick === it.id ? 'picked' : ''}`} onClick={() => patchRow(i, { pick: it.id, on: true })} onDoubleClick={() => app.openSlide(it.id, [...new Set(list.flatMap((x) => x.items.map((y) => y.file_id)))])}>
                      <SlidePreview slide={it} />
                      <div className="gc-info">
                        <div className="small ellipsis" title={it.filePath}>{it.fileName} · 第 {it.idx} 页</div>
                        <div className="small"><span className={`tag theme-${it.theme}`}>{THEME_LABEL[it.theme]}</span>{k === 0 ? <span className="tag hit">代表页</span> : <span className="muted">相似 {Math.round(it.sim * 100)}%</span>}{it.notes ? <span className="muted"> · 有讲解词</span> : ''}</div>
                      </div>
                      {r.pick === it.id && <span className="gc-check">✓ 已选</span>}
                      <button className="gc-zoom" title="逐页浏览" onClick={(e) => { e.stopPropagation(); app.openSlide(it.id, [...new Set(list.flatMap((x) => x.items.map((y) => y.file_id)))]); }}>⛶</button>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div className="gen-foot">
            <span className="badge">将生成 {chosen.length} 页</span>
            <span className="muted">底色：</span>
            <div className="seg small">{[['none', '保持原样'], ['light', '统一为白底'], ['dark', '统一为黑底']].map(([k, v]) => <button key={k} className={unify === k ? 'on' : ''} onClick={() => set({ unify: k })}>{v}</button>)}</div>
            <div className="spacer" />
            <button className="btn" onClick={() => set({ rows: list.map((r) => ({ ...r, on: true })) })}>全部选上</button>
            <button className="btn" disabled={!chosen.length} onClick={() => app.basket.add(chosen)}>＋ 加入导出篮</button>
            <button className="btn primary" disabled={!chosen.length || making} onClick={make}>{making ? '生成中…' : '📄 生成 PPT 并导出'}</button>
          </div>
        </>
      )}
    </div>
  );
}
