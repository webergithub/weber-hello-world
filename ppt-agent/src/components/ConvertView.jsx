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
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-T:]/g, '');
    const out = await api.saveFile(`黑白底互转_${stamp}.pptx`, 'pptx');
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
            <b>转化规则</b>
            <div><b>黑底 → 白底：</b>背景改为白色；所有文字改为黑色，原有其他颜色的文字改为深红色；表格框线改为浅灰色；所有图形（填充与线条）改为浅灰色；logo 等小图片重着色为深红色；铺满整页的背景图移除。</div>
            <div><b>白底 → 黑底：</b>背景改为黑色；所有文字改为白色；图形去掉填充、线框改为白色（视觉上为透明）；表格去掉填充、框线改为白色；铺满整页的背景图移除。</div>
            <div className="muted small">图表与 SmartArt 内部配色、照片类大图保持不变；同一源文件的页可分别转成不同底色（母版会各自独立复制）。</div>
          </div>
        </div>
        {result && (
          <div className="cv-result">
            <div className="side-title">③ 转换结果：{result.path}（{fmtSize(result.size)}；文字 {result.stats.text} 处、图形 {result.stats.shapes} 个、表格 {result.stats.tables} 个、logo {result.stats.logos} 个）
              <button className="btn tiny" onClick={() => api.openPath(result.path)}>打开</button><button className="btn tiny" onClick={() => api.showItem(result.path)}>位置</button></div>
            <div className="cv-grid big">
              {result.preview.map((p, i) => {
                const src = qSlides[queue[i] && queue[i].slideId];
                return (
                  <div key={p.id} className="cv-pair">
                    <div>{src && <SlidePreview slide={src} file={src.file} />}<div className="small muted">原：{THEME_LABEL[src && src.theme]}</div></div>
                    <div>{p.thumb ? <div className="slide-box" style={{ aspectRatio: p.layout ? `${p.layout.w / p.layout.h}` : '16/9' }}><img src={assetUrl('thumb', p.thumb)} alt="" /></div>
                      : p.layout ? <div className="slide-box" style={{ aspectRatio: `${p.layout.w / p.layout.h}` }}><HtmlSlide layout={p.layout} /></div> : null}
                      <div className="small">转换后：{p.dir === 'toLight' ? '白底' : '黑底'}</div></div>
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
