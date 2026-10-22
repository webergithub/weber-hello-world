import React, { useEffect, useRef, useState } from 'react';
import { assetUrl } from '../api';
import { renderMarkdown } from '../md';

// 预览优先级：真实截图（PowerPoint/LibreOffice）→ PDF 页（pdf.js）→ 内置版式渲染（HTML）→ 简易卡片
export default function SlidePreview({ slide, file, full = false, className = '', highlight = [] }) {
  if (!slide) return <div data-sid={slide && slide.id} className={`slide-box empty ${className}`} />;
  if (slide.kind === 'word' || (file && file.kind === 'word')) return <DocPage slide={slide} full={full} className={className} highlight={highlight} />;
  const isPdfDoc = slide.kind === 'pdf' || (file && file.kind === 'pdf');
  const ratio = slide.layout ? slide.layout.w / slide.layout.h : (file && file.meta && file.meta.slideSize ? file.meta.slideSize.cx / file.meta.slideSize.cy : isPdfDoc ? 1 / 1.414 : 16 / 9);
  const style = { aspectRatio: String(ratio), ...(full ? { width: `min(100%, calc(${isPdfDoc && ratio < 1 ? 72 : 52}vh * ${ratio}))` } : {}) };
  // PDF 文档：直接用 pdf.js 只读渲染原文件（ppta://src/<文件 id>）；缩略图按需渲染并缓存
  if (isPdfDoc && slide.file_id) {
    const url = assetUrl('src', slide.file_id);
    // 竖版页面在缩略图里放进 4:3 的框中，避免卡片过高
    const st = full || ratio >= 1 ? style : { aspectRatio: '4 / 3' };
    return <div data-sid={slide.id} className={`slide-box pdf-page ${full ? '' : 'thumb'} ${className}`} style={st}>{full ? <PdfPage url={url} page={slide.idx} /> : <PdfThumb url={url} page={slide.idx} slide={slide} />}</div>;
  }
  if (slide.thumb) {
    return <div data-sid={slide && slide.id} className={`slide-box ${className}`} style={style}><img src={assetUrl('thumb', slide.thumb)} alt={slide.title} loading="lazy" draggable={false} /></div>;
  }
  const pdf = file && file.preview && file.preview.engine === 'pdf' ? file.preview.pdf : null;
  if (pdf && full) return <div data-sid={slide && slide.id} className={`slide-box ${className}`} style={style}><PdfPage url={assetUrl('thumb', pdf)} page={slide.idx} /></div>;
  if (slide.layout && full) return <div data-sid={slide && slide.id} className={`slide-box ${className}`} style={style}><HtmlSlide layout={slide.layout} /></div>;
  return <MiniCard slide={slide} style={style} className={className} />;
}

// Word 章节：以“纸张”样式展示
function DocPage({ slide, full, className, highlight }) {
  if (full) return <div data-sid={slide && slide.id} className={`doc-page ${className}`} dangerouslySetInnerHTML={{ __html: renderMarkdown(slide.md || `## ${slide.title}\n\n${slide.text || ''}`, highlight) }} />;
  const lines = String(slide.text || '').split('\n').filter(Boolean).slice(0, 6);
  return (
    <div data-sid={slide && slide.id} className={`slide-box mini doc ${className}`} style={{ aspectRatio: '1 / 1.1' }}>
      <div className="mini-inner">
        <div className="mini-badge">W</div>
        <div className="mini-title">{slide.title || `第 ${slide.idx} 节`}</div>
        {lines.map((l, i) => <div key={i} className="mini-line">{l}</div>)}
      </div>
    </div>
  );
}

function MiniCard({ slide, style, className }) {
  const bg = (slide.bg && slide.bg.color) || (slide.theme === 'dark' ? '#111' : '#fff');
  const fg = slide.theme === 'dark' ? '#f2f2f2' : '#222';
  const img = slide.bg && slide.bg.image;
  const lines = String(slide.text || '').split('\n').filter(Boolean).slice(0, 5);
  return (
    <div data-sid={slide && slide.id} className={`slide-box mini ${className}`} style={{ ...style, background: img ? `center/cover url("${assetUrl('media', img)}")` : bg, color: fg }}>
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

// 中文等字体需要 cMap；标准字体 / 图像解码数据由主进程只读提供（ppta://pdfjs/...）
const PDFJS_DATA = { cMapUrl: 'ppta://pdfjs/cmaps/', cMapPacked: true, standardFontDataUrl: 'ppta://pdfjs/standard_fonts/', wasmUrl: 'ppta://pdfjs/wasm/', iccUrl: 'ppta://pdfjs/iccs/', isEvalSupported: false };
function openPdf(lib, url) {
  if (!pdfDocs.has(url)) {
    const p = lib.getDocument({ url, ...PDFJS_DATA }).promise;
    p.catch(() => pdfDocs.delete(url));
    pdfDocs.set(url, p);
  }
  return pdfDocs.get(url);
}

function PdfPage({ url, page }) {
  const ref = useRef(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const lib = await loadPdfjs();
        const doc = await openPdf(lib, url);
        const p = await doc.getPage(page);
        if (cancelled || !ref.current) return;
        const vp = p.getViewport({ scale: 1 });
        // 以 1.5 倍显示宽度渲染（至少 900 像素），放大查看时仍清晰
        const scale = Math.max(900, ref.current.parentElement.clientWidth * (window.devicePixelRatio || 1) * 1.5) / vp.width;
        const v2 = p.getViewport({ scale });
        const c = ref.current;
        c.width = v2.width; c.height = v2.height;
        await p.render({ canvasContext: c.getContext('2d'), viewport: v2 }).promise;
      } catch (e) { if (!cancelled) setErr(e.message); }
    })();
    return () => { cancelled = true; };
  }, [url, page]);
  return err ? <div className="hs-ph">PDF 预览失败：{err}</div> : <canvas ref={ref} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />;
}

// PDF 缩略图：进入可视区域后排队渲染（同时最多 2 页），结果缓存为图片
const thumbCache = new Map();
const thumbQueue = [];
let thumbBusy = 0;
function pumpThumbs() {
  while (thumbBusy < 2 && thumbQueue.length) {
    const job = thumbQueue.shift();
    if (job.cancelled) continue;
    thumbBusy++;
    renderThumb(job.url, job.page).then(job.done, job.fail).finally(() => { thumbBusy--; pumpThumbs(); });
  }
}
async function renderThumb(url, page) {
  const key = `${url}#${page}`;
  if (thumbCache.has(key)) return thumbCache.get(key);
  const lib = await loadPdfjs();
  const doc = await openPdf(lib, url);
  const p = await doc.getPage(page);
  const vp = p.getViewport({ scale: 1 });
  const v2 = p.getViewport({ scale: 360 / vp.width });
  const c = document.createElement('canvas');
  c.width = Math.round(v2.width); c.height = Math.round(v2.height);
  await p.render({ canvasContext: c.getContext('2d'), viewport: v2 }).promise;
  const src = c.toDataURL('image/jpeg', 0.82);
  if (thumbCache.size > 600) thumbCache.delete(thumbCache.keys().next().value);
  thumbCache.set(key, src);
  return src;
}
function PdfThumb({ url, page, slide }) {
  const key = `${url}#${page}`;
  const ref = useRef(null);
  const [src, setSrc] = useState(() => thumbCache.get(key) || null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    if (thumbCache.has(key)) { setSrc(thumbCache.get(key)); return undefined; }
    setSrc(null); setErr(false);
    let job = null;
    const io = new IntersectionObserver((es) => {
      if (!es.some((e) => e.isIntersecting) || job) return;
      job = { url, page, done: (s) => { if (!job.cancelled) setSrc(s); }, fail: () => { if (!job.cancelled) setErr(true); } };
      thumbQueue.push(job); pumpThumbs(); io.disconnect();
    }, { rootMargin: '200px' });
    if (ref.current) io.observe(ref.current);
    return () => { io.disconnect(); if (job) job.cancelled = true; };
  }, [key]);
  if (src) return <img src={src} alt={slide.title} draggable={false} />;
  const lines = String(slide.text || '').split('\n').filter(Boolean).slice(0, 5);
  return (
    <div ref={ref} className="mini-inner pdf-ph">
      <div className="mini-badge pdf">PDF</div>
      <div className="mini-title">{slide.title || `第 ${slide.idx} 页`}</div>
      {err ? <div className="mini-line muted">原文件不可用</div> : lines.map((l, i) => <div key={i} className="mini-line">{l}</div>)}
    </div>
  );
}
