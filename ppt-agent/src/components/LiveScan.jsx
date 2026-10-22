import React, { useEffect, useRef, useState } from 'react';
import { api, assetUrl, STATUS_LABEL, THEME_LABEL } from '../api';
import { useApp } from '../ctx';
import { renderMarkdown } from '../md';
import { HtmlSlide } from './SlidePreview';

const base = (p) => String(p || '').split(/[\\/]/).pop();
const MIN_SHOW_MS = 650; // 每页至少展示的时长（只影响动画节奏，不拖慢解析）
const MAX_WAIT_MS = 2500; // 等待页面图片加载的最长时间

// 一页用到的图片：真实截图，或内置版式中的背景与图片
function imagesOf(scan) {
  const d = scan && scan.detail;
  if (!d) return [];
  if (d.thumb) return [assetUrl('thumb', d.thumb)];
  const l = d.layout;
  if (!l) return [];
  const out = [];
  if (l.bg && l.bg.image) out.push(assetUrl('media', l.bg.image));
  for (const it of l.items || []) { if (it.src) out.push(assetUrl('media', it.src)); if (it.poster) out.push(assetUrl('media', it.poster)); }
  return out;
}
const loaded = new Set();
function preload(urls) {
  return Promise.all(urls.map((u) => (loaded.has(u) ? null : new Promise((res) => { const im = new Image(); im.onload = im.onerror = () => { loaded.add(u); res(); }; im.src = u; }))));
}

// 解析动态：用扫描线动画逐页展示正在解析的页面、提取的文字、生成的 Markdown 与标签标注
export default function LiveScan({ taskId, onPick }) {
  const app = useApp();
  const running = app.tasks.find((t) => t.status === 'running');
  const id = taskId || (running && running.id) || (app.tasks[0] && app.tasks[0].id);
  const t = app.tasks.find((x) => x.id === id);
  const p = (id && app.progress[id]) || {};
  const scans = p.scans || [];
  const [cursor, setCursor] = useState(0); // 正在展示的 scans 下标
  const lastSeq = useRef(0);
  useEffect(() => { setCursor(Math.max(0, scans.length - 1)); }, [id]);
  const cur = scans[Math.min(cursor, scans.length - 1)];
  // 当前页的图片全部加载完成（或超时）后才算“就绪”，避免页面显示不完整就切到下一页
  const [ready, setReady] = useState(true);
  useEffect(() => {
    let off = false;
    const urls = imagesOf(cur);
    if (!urls.length || urls.every((u) => loaded.has(u))) { setReady(true); return undefined; }
    setReady(false);
    const t0 = setTimeout(() => { if (!off) setReady(true); }, MAX_WAIT_MS);
    preload(urls).then(() => { if (!off) setReady(true); });
    // 预取下一页的图片
    const next = scans[Math.min(cursor + 1, scans.length - 1)];
    if (next && next !== cur) preload(imagesOf(next));
    return () => { off = true; clearTimeout(t0); };
  }, [cur && cur.seq]);
  // 展示队列：当前页就绪后逐页推进；积压太多时跳到最近几页
  useEffect(() => {
    if (cursor >= scans.length - 1 || !ready) return undefined;
    const backlog = scans.length - 1 - cursor;
    const timer = setTimeout(() => setCursor((c) => (backlog > 8 ? scans.length - 8 : c + 1)), backlog > 8 ? 60 : MIN_SHOW_MS);
    return () => clearTimeout(timer);
  }, [cursor, scans.length, ready]);
  useEffect(() => { if (cur) lastSeq.current = cur.seq; }, [cur]);
  const tags = (p.tagFeed || []).slice(-12).reverse();
  const recent = scans.slice(Math.max(0, cursor - 9), cursor + 1).reverse();
  const filePct = t && t.total ? Math.round(((p.index ? p.index - 1 : 0) + (cur && cur.slideTotal ? cur.slide / cur.slideTotal : 0)) / t.total * 100) : 0;

  if (!t) return <div className="empty-tip">还没有任务</div>;
  return (
    <div className="livescan">
      <div className="ls-top">
        <select className="input" value={id} onChange={(e) => onPick(Number(e.target.value))}>
          {app.tasks.map((x) => <option key={x.id} value={x.id}>#{x.id} {x.name}（{STATUS_LABEL[x.status] || x.status}）</option>)}
        </select>
        <span className={`status s-${t.status}`}>{STATUS_LABEL[t.status]}</span>
        <div className="ls-prog"><div className="progress big"><div style={{ width: `${t.status === 'done' ? 100 : filePct}%` }} /></div></div>
        <span className="small">文件 {p.index || (t.status === 'done' ? t.total : 0)}/{t.total || p.total || '?'}</span>
        {t.status === 'running' && <button className="btn small" disabled={!!(app.liveTasks[t.id] && app.liveTasks[t.id].pausing)} onClick={() => api.pauseTask(t.id).then(app.refreshTasks)}>{app.liveTasks[t.id] && app.liveTasks[t.id].pausing ? '正在暂停…' : '⏸ 暂停'}</button>}
        {['paused', 'interrupted'].includes(t.status) && <button className="btn small primary" onClick={() => api.resumeTask(t.id).then(app.refreshTasks)}>▶ 继续</button>}
        {t.status === 'draft' && <button className="btn small primary" onClick={() => api.startTask(t.id).then(app.refreshTasks)}>▶ 开始解析</button>}
      </div>
      {!cur ? (
        <div className="empty-tip">{t.status === 'running' ? (p.stage === 'scanning' && p.scan ? `正在扫描目录：已检查 ${p.scan.dirs} 个目录，发现 ${p.scan.found} 个文档…` : '等待解析开始…') : '开始解析后，这里会以动画实时展示每一页的扫描读取过程、生成的 Markdown 与标签标注结果。'}</div>
      ) : (
        <div className="ls-body">
          <div className="ls-left">
            <div className="ls-file">📄 <b>{base(cur.file)}</b> <span className="muted small">第 {cur.slide}/{cur.slideTotal} {cur.unit || '页'}</span>
              {cur.detail && cur.kind !== 'word' && <span className={`tag theme-${cur.detail.theme}`}>{THEME_LABEL[cur.detail.theme]}</span>}</div>
            <div className="ls-stage" style={{ '--ratio': cur.detail && cur.detail.layout ? cur.detail.layout.w / cur.detail.layout.h : 16 / 9 }}>
              <div key={cur.seq} className={`ls-slide ${cur.kind === 'word' ? 'doc' : ''}`}>
                {cur.detail && cur.detail.thumb ? <img className="ls-shot" src={assetUrl('thumb', cur.detail.thumb)} alt={cur.title} draggable={false} />
                  : cur.detail && cur.detail.layout ? <HtmlSlide layout={cur.detail.layout} />
                  : <div className="ls-doc"><div className="ls-doc-title">{cur.title}</div>{String((cur.detail && cur.detail.text) || '').split('\n').slice(0, 14).map((l, i) => <div key={i}>{l}</div>)}</div>}
                <div className={`scanline ${t.status === 'running' || cursor < scans.length - 1 ? 'on' : ''}`} />
                <div className="ls-badge">扫描第 {cur.slide} {cur.unit || '页'}{cur.detail && cur.detail.thumb ? ' · 真实页面' : cur.kind !== 'word' ? ' · 版式预览' : ''}</div>
                {!ready && <div className="ls-loading">页面加载中…</div>}
              </div>
            </div>
            <div className="ls-mini">
              <div className="lp-row"><span>本文件</span><div className="progress"><div style={{ width: `${(cur.slide / cur.slideTotal) * 100}%` }} /></div><span>{cur.slide}/{cur.slideTotal}</span></div>
            </div>
            <div className="ls-strip">
              {recent.map((x, i) => (
                <div key={x.seq} className={`ls-chip ${i === 0 ? 'now' : ''}`} title={x.title}>
                  <span className="n">{x.slide}</span><span className="t">{x.title || '（无标题）'}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="ls-right">
            <div className="pane">
              <div className="pane-head">🔍 提取的文字{cur.detail && cur.detail.media && cur.detail.media.length ? ` · 🎬 ${cur.detail.media.map((m) => `${m.name}（字幕 ${m.subtitles} 段）`).join('，')}` : ''}</div>
              <div key={cur.seq} className="pane-body ls-text">
                <div className="ls-line title">{cur.title || '（无标题）'}</div>
                {String((cur.detail && cur.detail.text) || '').split('\n').filter(Boolean).slice(0, 60).map((l, i) => <div key={i} className="ls-line" style={{ animationDelay: `${Math.min(i, 16) * 40}ms` }}>{l}</div>)}
                {cur.detail && cur.detail.notes && <div className="ls-line notes" style={{ animationDelay: '300ms' }}>🗣 {cur.detail.notes}</div>}
              </div>
            </div>
            <div className="pane">
              <div className="pane-head">📝 生成的 Markdown</div>
              <div key={cur.seq} className="pane-body md ls-md" dangerouslySetInnerHTML={{ __html: renderMarkdown((cur.detail && cur.detail.md) || '') }} />
            </div>
            <div className="pane">
              <div className="pane-head">🏷 标签标注 <span className="muted small">（文件解析完成后统一计算）</span></div>
              <div className="pane-body">
                {!tags.length && <div className="muted small">等待本任务的文件完成后进行标签标注…</div>}
                {tags.map((g) => (
                  <div key={g.seq} className="ls-tagrow">
                    <div className="small"><b>{base(g.file)}</b> <span className="tag accent">{g.category}</span></div>
                    <div>{g.tags.map((x, i) => <span key={x} className="tag pop" style={{ animationDelay: `${i * 35}ms` }}>{x}</span>)}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
