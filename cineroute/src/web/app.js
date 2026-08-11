/**
 * CineRoute 前端。
 *
 * 注意：片名、文件名、简介都来自第三方归档站，是**用户上传的内容**。
 * 因此本文件全程用 createElement + textContent 构建 DOM，不做任何
 * innerHTML 字符串拼接 —— 否则一个恶意条目标题就能在本地页面里执行脚本。
 */

const $ = (id) => document.getElementById(id);

/** 安全的元素构造器：children 传字符串时走 textContent。 */
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(typeof c === 'string' || typeof c === 'number' ? String(c) : c);
  }
  return node;
}

const fmtSize = (b) => {
  if (!b) return '—';
  const mb = b / 1024 / 1024;
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${Math.round(mb)} MB`;
};

const fmtDuration = (s) => {
  if (!s) return '—';
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return h > 0 ? `${h} 时 ${String(m).padStart(2, '0')} 分` : `${m} 分钟`;
};

const fmtSpeed = (bps) => (bps > 0 ? `${fmtSize(bps)}/s` : '—');

/** 播放走同源代理：一次解决上游缺 CORS 头与明文 HTTP 混合内容两个问题。 */
const proxied = (url) => `/media?url=${encodeURIComponent(url)}`;

let CONFIG = { offline: false };
const selected = new Map();

/* ---------------- 渲染：片源卡片 ---------------- */

function renderBreakdown(source) {
  const box = el('div', { class: 'breakdown hidden' });
  for (const d of source.breakdown || []) {
    const pct = d.max > 0 ? Math.round((d.score / d.max) * 100) : 0;
    box.append(
      el('div', { class: 'dim' },
        el('span', { class: 'name' }, d.label),
        el('span', { class: 'bar' }, el('i', { style: `width:${pct}%` })),
        el('span', { class: 'val' }, `${d.score}/${d.max}`),
        el('span', { class: 'why' }, d.reason),
      ),
    );
  }
  return box;
}

function specChips(s) {
  const chips = [el('span', { class: 'chip' }, (s.container || '?').toUpperCase())];
  if (s.height) chips.push(el('span', { class: 'chip' }, `${s.height}p`));
  chips.push(el('span', { class: 'chip' }, fmtDuration(s.durationSec)));
  chips.push(el('span', { class: 'chip' }, fmtSize(s.bytes)));
  if (s.rangeSupported === true) chips.push(el('span', { class: 'chip good' }, '可拖动 · 可续传'));
  else if (s.rangeSupported === false) chips.push(el('span', { class: 'chip warn' }, '不支持续传'));
  if (s.checksums?.md5 || s.checksums?.sha1) chips.push(el('span', { class: 'chip good' }, '有校验和'));
  return chips;
}

function sourceCard(s, { playable }) {
  const card = el('div', { class: `source${s.rank === 1 ? ' rank-1' : ''}` });
  const breakdown = renderBreakdown(s);

  card.append(
    el('div', { class: 'source-head' },
      playable ? el('span', { class: 'rank' }, String(s.rank)) : null,
      el('span', { class: 'score' }, String(s.score), el('small', {}, ' 分')),
      el('span', { class: 'provider' }, s.providerLabel || s.provider),
      el('span', { class: 'spacer' }),
      el('a', { class: 'src-link', href: s.pageUrl || s.url, target: '_blank', rel: 'noopener noreferrer' }, '来源页 ↗'),
    ),
    el('p', { class: 'filename' }, s.filename || s.url),
    el('div', { class: 'specs' }, specChips(s)),
  );

  if (!playable && s.blockReason) {
    card.append(el('p', { class: 'blocked-reason' }, `⚠ ${s.blockReason}`));
  }

  const actions = el('div', { class: 'actions' });

  if (playable) {
    actions.append(el('button', {
      class: 'play', type: 'button',
      onclick: () => play(s),
    }, '▶ 立即播放'));
  }

  actions.append(el('button', {
    class: 'dl', type: 'button',
    onclick: (e) => startDownload(s, e.currentTarget),
  }, '⬇ 离线下载'));

  const cb = el('input', { type: 'checkbox' });
  cb.addEventListener('change', () => {
    if (cb.checked) selected.set(s.id, s); else selected.delete(s.id);
    updateBatchBar();
  });
  actions.append(el('label', { class: 'pick' }, cb, '选入批量'));

  actions.append(el('button', {
    class: 'toggle', type: 'button',
    onclick: (e) => {
      breakdown.classList.toggle('hidden');
      e.currentTarget.textContent = breakdown.classList.contains('hidden') ? '打分明细' : '收起明细';
    },
  }, '打分明细'));

  card.append(actions, breakdown);
  return card;
}

function updateBatchBar() {
  const bar = $('batchBar');
  bar.classList.toggle('hidden', selected.size === 0);
  $('batchCount').textContent = `已选 ${selected.size} 个`;
}

/* ---------------- 播放 ---------------- */

function play(s) {
  const panel = $('playerPanel');
  const video = $('player');
  panel.classList.remove('hidden');
  $('nowPlaying').textContent = `${s.filename} · ${s.providerLabel} · ${(s.container || '').toUpperCase()} ${s.height ? s.height + 'p' : ''}`;

  video.src = proxied(s.url);
  video.play().catch(() => { /* 浏览器可能拦截自动播放，用户点一下即可 */ });

  const hint = $('playerHint');
  if (CONFIG.offline) {
    hint.textContent = '离线夹具模式下这些地址不会真的联网，播放会失败——去掉 --offline 即可真实播放。';
  } else if (s.container === 'ogv' || s.container === 'ogg') {
    hint.textContent = 'Ogg/Theora 在 Safari 与 iOS 上无法播放，如遇黑屏请改用 Chrome/Firefox 或选 MP4 片源。';
  } else {
    hint.textContent = '';
  }
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/* ---------------- 下载 ---------------- */

async function startDownload(s, btn) {
  if (btn) { btn.disabled = true; btn.textContent = '已加入队列'; }
  $('downloadPanel').classList.remove('hidden');
  try {
    const res = await fetch('/api/download', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        url: s.url,
        filename: s.filename,
        bytes: s.bytes,
        checksums: s.checksums,
      }),
    });
    const job = await res.json();
    if (!res.ok) throw new Error(job.error || `HTTP ${res.status}`);
    upsertJob(job);
  } catch (err) {
    if (btn) { btn.disabled = false; btn.textContent = '⬇ 离线下载'; }
    alert(`加入下载队列失败：${err.message}`);
  }
}

const jobNodes = new Map();

function upsertJob(job) {
  let node = jobNodes.get(job.id);
  if (!node) {
    node = el('div', { class: 'job' });
    jobNodes.set(job.id, node);
    $('downloadList').prepend(node);
  }
  node.replaceChildren(
    el('div', { class: 'job-head' },
      el('span', { class: 'job-name' }, job.filename),
      el('span', { class: `job-state ${job.status}` }, {
        queued: '排队中', downloading: '下载中', verifying: '校验中',
        done: '已完成', failed: '失败', canceled: '已取消',
      }[job.status] || job.status),
      el('span', { class: 'spacer' }),
      job.status === 'downloading' || job.status === 'queued'
        ? el('button', {
            class: 'toggle', type: 'button',
            onclick: () => fetch(`/api/downloads/${job.id}/cancel`, { method: 'POST' }),
          }, '取消')
        : null,
    ),
    el('div', { class: 'progress' },
      el('i', { style: `width:${job.percent ?? 0}%` })),
    el('div', { class: 'job-meta' },
      el('span', {}, `${fmtSize(job.receivedBytes)} / ${fmtSize(job.totalBytes)}${job.percent != null ? ` · ${job.percent}%` : ''}`),
      el('span', {}, fmtSpeed(job.bytesPerSec)),
      job.resumable ? el('span', {}, '支持断点续传') : null,
      job.verify?.checked ? el('span', {}, job.verify.ok ? `✓ ${job.verify.algo} 校验通过` : `✗ ${job.verify.algo} 校验失败`) : null,
      job.status === 'done' ? el('span', {}, `已存至 ${job.path}`) : null,
      job.error ? el('span', {}, `错误：${job.error}`) : null,
    ),
  );
}

/* ---------------- 渲染：整页 ---------------- */

function renderResult(data) {
  selected.clear();
  updateBatchBar();

  // 作品头
  const t = data.title || {};
  const card = $('titleCard');
  const info = el('div', {},
    el('h2', {}, `${t.name || data.query.title}${t.year ? ` (${t.year})` : ''}`),
    el('p', { class: 'meta' },
      [
        t.runtimeSec ? `片长 ${fmtDuration(t.runtimeSec)}（${t.runtimeSource === 'tmdb' ? '权威数据' : '候选中位数推定'}）` : null,
        `耗时 ${data.elapsedMs}ms`,
      ].filter(Boolean).join(' · ')),
    t.overview ? el('p', { class: 'overview' }, t.overview) : null,
  );
  card.replaceChildren(
    t.poster ? el('img', { src: t.poster, alt: '' }) : null,
    info,
  );

  // Top5
  const topList = $('topList');
  topList.replaceChildren();
  if (data.top.length === 0) {
    topList.append(el('p', { class: 'blocked-reason' }, '没有找到可直接播放的片源。'));
  }
  for (const s of data.top) topList.append(sourceCard(s, { playable: true }));

  // 备选
  const altPanel = $('altPanel');
  const altList = $('altList');
  altList.replaceChildren();
  altPanel.classList.toggle('hidden', data.alternatives.length === 0);
  for (const s of data.alternatives) altList.append(sourceCard(s, { playable: false }));

  // 正版渠道
  const offersPanel = $('offersPanel');
  const offersList = $('offersList');
  offersList.replaceChildren();
  offersPanel.classList.toggle('hidden', data.offers.length === 0);
  for (const o of data.offers) {
    offersList.append(
      el('a', { class: 'offer', href: o.link || '#', target: '_blank', rel: 'noopener noreferrer' },
        o.logo ? el('img', { src: o.logo, alt: '' }) : null,
        el('span', {}, o.providerName),
        el('span', { class: 'type' }, o.typeLabel),
      ),
    );
  }

  // 数据源
  const provList = $('providerList');
  provList.replaceChildren();
  for (const p of data.providers) {
    provList.append(
      el('div', { class: 'prov' },
        el('span', { class: `dot ${p.status}` }),
        el('span', {}, p.label),
        el('span', { class: 'detail' },
          p.status === 'ok' ? `${p.count} 条 · ${p.elapsedMs}ms` : (p.reason || p.status)),
      ),
    );
  }

  const st = data.stats;
  $('statsLine').textContent =
    `候选 ${st.rawCandidates} → 去重 ${st.afterDedupe} → 实测探测 ${st.probed} → 可播 ${st.playable} / 受阻 ${st.blocked}`;

  const notes = $('notes');
  notes.replaceChildren();
  for (const n of data.notes || []) notes.append(el('li', {}, n));

  $('results').classList.remove('hidden');
}

/* ---------------- 事件绑定 ---------------- */

async function runSearch(q) {
  const btn = $('searchBtn');
  const status = $('status');
  btn.disabled = true;
  status.className = 'status';
  status.textContent = `正在向各数据源并发检索「${q}」…`;
  $('results').classList.add('hidden');

  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    renderResult(data);
    status.classList.add('hidden');
  } catch (err) {
    status.className = 'status error';
    status.textContent = `检索失败：${err.message}`;
  } finally {
    btn.disabled = false;
  }
}

$('searchForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = $('q').value.trim();
  if (!q) return;
  // 写进地址栏，让这次检索可以直接分享/刷新复现。
  history.replaceState(null, '', `?q=${encodeURIComponent(q)}`);
  runSearch(q);
});

$('batchDownload').addEventListener('click', () => {
  for (const s of selected.values()) startDownload(s, null);
  selected.clear();
  updateBatchBar();
});

/* ---------------- 启动 ---------------- */

(async function init() {
  try {
    CONFIG = await (await fetch('/api/config')).json();
  } catch { /* 用默认配置继续 */ }

  if (CONFIG.offline) {
    const badge = $('modeBadge');
    badge.textContent = '离线夹具模式 · 演示数据';
    badge.classList.remove('hidden');
  }

  // 地址栏带 ?q= 时直接开检索（可分享的检索链接）。
  const initialQ = new URLSearchParams(location.search).get('q')
    || (CONFIG.offline ? 'Night of the Living Dead' : '');
  if (initialQ) {
    $('q').value = initialQ;
    if (new URLSearchParams(location.search).has('q')) runSearch(initialQ);
  }

  try {
    const { jobs } = await (await fetch('/api/downloads')).json();
    if (jobs.length) {
      $('downloadPanel').classList.remove('hidden');
      for (const j of jobs) upsertJob(j);
    }
  } catch { /* 队列为空或服务未就绪 */ }

  // SSE 实时进度。断线后浏览器会自动重连。
  const es = new EventSource('/api/events');
  es.addEventListener('download', (e) => {
    $('downloadPanel').classList.remove('hidden');
    upsertJob(JSON.parse(e.data));
  });
})();
