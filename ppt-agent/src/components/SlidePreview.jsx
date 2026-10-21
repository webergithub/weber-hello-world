import React, { useEffect, useRef, useState } from 'react';
import { assetUrl } from '../api';

// 预览优先级：真实截图（PowerPoint/LibreOffice）→ PDF 页（pdf.js）→ 内置版式渲染（HTML）→ 简易卡片
export default function SlidePreview({ slide, file, full = false, className = '' }) {
  if (!slide) return <div className={`slide-box empty ${className}`} />;
  const ratio = slide.layout ? slide.layout.w / slide.layout.h : (file && file.meta && file.meta.slideSize ? file.meta.slideSize.cx / file.meta.slideSize.cy : 16 / 9);
  const style = { aspectRatio: String(ratio), ...(full ? { width: `min(100%, calc(52vh * ${ratio}))` } : {}) };
  if (slide.thumb) {
    return <div className={`slide-box ${className}`} style={style}><img src={assetUrl('thumb', slide.thumb)} alt={slide.title} loading="lazy" draggable={false} /></div>;
  }
  const pdf = file && file.preview && file.preview.engine === 'pdf' ? file.preview.pdf : null;
  if (pdf && full) return <div className={`slide-box ${className}`} style={style}><PdfPage url={assetUrl('thumb', pdf)} page={slide.idx} /></div>;
  if (slide.layout && full) return <div className={`slide-box ${className}`} style={style}><HtmlSlide layout={slide.layout} /></div>;
  return <MiniCard slide={slide} style={style} className={className} />;
}

function MiniCard({ slide, style, className }) {
  const bg = (slide.bg && slide.bg.color) || (slide.theme === 'dark' ? '#111' : '#fff');
  const fg = slide.theme === 'dark' ? '#f2f2f2' : '#222';
  const img = slide.bg && slide.bg.image;
  const lines = String(slide.text || '').split('\n').filter(Boolean).slice(0, 5);
  return (
    <div className={`slide-box mini ${className}`} style={{ ...style, background: img ? `center/cover url("${assetUrl('media', img)}")` : bg, color: fg }}>
      <div className="mini-inner">
        <div className="mini-title">{slide.title || `第 ${slide.idx} 页`}</div>
        {lines.map((l, i) => <div key={i} className="mini-line">{l}</div>)}
        {slide.has_video && <div className="mini-video">▶ 视频</div>}
      </div>
    </div>
  );
}

const DEFAULT_SZ = { title: 32, ctrTitle: 40, subTitle: 22, body: 20 };

export function HtmlSlide({ layout }) {
  const widthPt = layout.w / 12700;
  const fs = (pt) => `${(pt / widthPt) * 100}cqw`;
  const bg = layout.bg || {};
  const bgStyle = bg.image ? { background: `center/cover url("${assetUrl('media', bg.image)}")` } : { background: bg.color || '#fff' };
  return (
    <div className="html-slide" style={{ ...bgStyle, fontFamily: layout.font ? `"${layout.font}", "Microsoft YaHei", sans-serif` : undefined }}>
      {layout.items.map((it, i) => {
        const pos = { left: `${it.x * 100}%`, top: `${it.y * 100}%`, width: `${it.w * 100}%`, height: `${it.h * 100}%` };
        if (it.t === 'pic') {
          return <div key={i} className="hs-item" style={pos}>{it.src ? <img src={assetUrl('media', it.src)} alt="" /> : <div className="hs-ph">🖼 {it.name}</div>}</div>;
        }
        if (it.t === 'video') {
          return (
            <div key={i} className="hs-item hs-video" style={pos}>
              {it.poster ? <img src={assetUrl('media', it.poster)} alt="" /> : null}
              <span className="hs-play">{it.mtype === 'audio' ? '🎵' : '▶'} {it.name}</span>
            </div>
          );
        }
        if (it.t === 'table') {
          return (
            <div key={i} className="hs-item hs-table" style={{ ...pos, fontSize: fs(12), color: layout.textColor }}>
              <table><tbody>{it.rows.map((r, k) => <tr key={k}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody></table>
            </div>
          );
        }
        if (it.t === 'chart' || it.t === 'shape') {
          return <div key={i} className="hs-item hs-ph" style={{ ...pos, fontSize: fs(14) }}>{it.t === 'chart' ? '📊 ' : '📎 '}{it.title || it.label || '图表'}</div>;
        }
        const base = DEFAULT_SZ[it.ph] || (it.title ? 32 : 18);
        const center = it.ph === 'ctrTitle' || it.ph === 'subTitle' || it.ph === 'title';
        return (
          <div key={i} className="hs-item hs-text" style={{ ...pos, background: it.fill ? '#' + it.fill : undefined, justifyContent: it.fill || it.ph === 'ctrTitle' ? 'center' : it.ph === 'title' ? 'center' : 'flex-start' }}>
            {(it.paras || []).map((p, k) => (
              <div key={k} style={{ textAlign: p.algn === 'ctr' || (center && !p.algn && it.ph !== 'title') ? 'center' : p.algn === 'r' ? 'right' : 'left', paddingLeft: `${(p.lvl || 0) * 4}%` }}>
                {p.bullet && p.runs && p.runs.some((r) => r.text.trim()) ? <span className="hs-bullet">•</span> : null}
                {(p.runs || []).map((r, j) => (
                  <span key={j} style={{ fontSize: fs(r.sz || (p.lvl ? base * 0.85 : base)), color: r.color ? '#' + r.color : (it.fill ? '#fff' : layout.textColor), fontWeight: r.b ? 700 : undefined, fontStyle: r.i ? 'italic' : undefined }}>{r.text}</span>
                ))}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

const pdfDocs = new Map();
let pdfjsPromise = null;
function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]).then(([lib, worker]) => {
      lib.GlobalWorkerOptions.workerSrc = worker.default;
      return lib;
    });
  }
  return pdfjsPromise;
}

function PdfPage({ url, page }) {
  const ref = useRef(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const lib = await loadPdfjs();
        if (!pdfDocs.has(url)) pdfDocs.set(url, lib.getDocument({ url }).promise);
        const doc = await pdfDocs.get(url);
        const p = await doc.getPage(page);
        if (cancelled || !ref.current) return;
        const vp = p.getViewport({ scale: 1 });
        const scale = (ref.current.parentElement.clientWidth * (window.devicePixelRatio || 1)) / vp.width;
        const v2 = p.getViewport({ scale });
        const c = ref.current;
        c.width = v2.width; c.height = v2.height;
        await p.render({ canvasContext: c.getContext('2d'), viewport: v2 }).promise;
      } catch (e) { if (!cancelled) setErr(e.message); }
    })();
    return () => { cancelled = true; };
  }, [url, page]);
  return err ? <div className="hs-ph">PDF 预览失败：{err}</div> : <canvas ref={ref} style={{ width: '100%', height: '100%' }} />;
}
