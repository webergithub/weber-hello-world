/**
 * CineRoute 前端（主页：检索 + 结果）。
 *
 * 配置类界面全在 /settings.html —— 这里只管"搜"和"看结果"。
 *
 * 注意：片名、文件名、简介都来自第三方归档站，是**用户上传的内容**。
 * 所以全程用 dom.js 的 el()（字符串走 textContent），不做任何
 * innerHTML 字符串拼接 —— 否则一个恶意条目标题就能在本地页面里执行脚本。
 */

import {
  $, el, img, fmtSize, fmtDuration, fmtSpeed, engineTitle, BACKEND_LABEL,
} from './dom.js';
import {
  saveToDisk, pickSaveTarget, pickSaveDirectory, browserDownload,
  canSaveToPickedFile, canPickDirectory,
} from './localSave.js';

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

/** 推荐位 4/5：正版订阅/付费渠道。没有直链，只有跳转。 */
function offerCard(rec) {
  const o = rec.offer;
  const card = el('div', { class: 'source offer-card' });

  card.append(
    el('div', { class: 'source-head' },
      el('span', { class: 'rank' }, String(rec.rank)),
      el('span', { class: 'offer-type' }, o.typeLabel),
      el('span', { class: 'provider' }, o.providerName),
      el('span', { class: 'spacer' }),
      el('span', { class: 'chip warn' }, '需订阅/付费'),
    ),
    el('div', { class: 'offer-body' },
      o.logo ? img({ class: 'offer-logo', src: o.logo, alt: '' }) : null,
      el('p', { class: 'offer-desc' },
        `在 ${o.providerName} 上${o.typeLabel}（${o.region} 区）。正版平台的播放地址受 DRM 与一次性签名保护，只能跳转到官方页面观看。`),
    ),
    el('div', { class: 'actions' },
      o.link
        ? el('a', { class: 'play', href: o.link, target: '_blank', rel: 'noopener noreferrer' }, '前往正版观看 ↗')
        : el('span', { class: 'provider' }, '该地区未提供跳转链接'),
    ),
  );
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

/**
 * 离线下载。
 *
 * **文件存到你自己的机器上**，不是服务器。以前是让服务端下到它的
 * `downloads/` 目录，部署到远程机器之后那个目录对用户毫无用处。
 *
 * 三条路，按能力自动选：
 *   picked  —— 你选保存位置，分块并发直接写进去，写完校验（Chromium + 安全上下文）
 *   browser —— 交给浏览器自己下（Firefox / Safari），**没法校验**，界面上会说明
 *   server  —— 存到服务器目录（设置里显式选择，给真的在服务器上跑的场景）
 */

let localJobSeq = 0;

/** 本机下载任务的取消开关，按 job id 存。 */
const localAborts = new Map();

/** 目前该走哪条路。设置里选了 server 就听设置的，否则看浏览器能力。 */
function downloadMode() {
  if (CONFIG.downloadTarget === 'server') return 'server';
  return canSaveToPickedFile() ? 'picked' : 'browser';
}

/**
 * 存到本机。
 *
 * `handle` 由调用方先拿好——选文件的弹窗**必须在点击事件里同步弹**，
 * 中间只要 await 过一次，浏览器就会以"不是用户操作触发的"拒绝掉。
 */
async function saveLocally(s, handle) {
  const id = `local-${++localJobSeq}`;
  const ac = new AbortController();
  localAborts.set(id, ac);

  $('downloadPanel').classList.remove('hidden');
  const base = { id, origin: 'local', filename: handle.name || s.filename, path: '本机' };
  upsertJob({ ...base, status: 'queued', receivedBytes: 0, totalBytes: s.bytes ?? null, percent: 0 });

  try {
    await saveToDisk(s, handle, {
      signal: ac.signal,
      onUpdate: (state) => upsertJob({ ...base, ...state }),
    });
  } finally {
    localAborts.delete(id);
  }
}

/** 交给浏览器自己下。没法校验，如实标出来。 */
function handOffToBrowser(s) {
  browserDownload(s);
  $('downloadPanel').classList.remove('hidden');
  upsertJob({
    id: `browser-${++localJobSeq}`,
    origin: 'browser',
    filename: s.filename,
    status: 'done',
    receivedBytes: s.bytes ?? 0,
    totalBytes: s.bytes ?? null,
    percent: 100,
    path: '浏览器下载目录',
    verify: { checked: false, reason: '这个浏览器不支持直接写文件，字节没经过本页，校验不了' },
  });
}

/** 存到服务器目录（设置里显式选了才走这条）。 */
async function queueOnServer(s, btn) {
  $('downloadPanel').classList.remove('hidden');
  ensureEvents();
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
    upsertJob({ ...job, origin: 'server' });
  } catch (err) {
    if (btn) { btn.disabled = false; btn.textContent = '⬇ 离线下载'; }
    alert(`加入下载队列失败：${err.message}`);
  }
}

/**
 * 点「离线下载」。
 *
 * 注意这个函数**不是 async**：走 picked 那条路时第一件事必须是弹选择框，
 * 前面不能有任何 await。
 */
function startDownload(s, btn) {
  const mode = downloadMode();

  if (mode === 'server') {
    if (btn) { btn.disabled = true; btn.textContent = '已加入队列'; }
    queueOnServer(s, btn);
    return;
  }

  if (mode === 'browser') {
    if (btn) { btn.disabled = true; btn.textContent = '已交给浏览器'; }
    handOffToBrowser(s);
    return;
  }

  // picked：同步弹窗，拿到 handle 之后才开始下载
  pickSaveTarget(s.filename).then((handle) => {
    if (!handle) return;                       // 用户取消了，什么都不做
    if (btn) { btn.disabled = true; btn.textContent = '下载中'; }
    return saveLocally(s, handle);
  }).catch((err) => {
    if (btn) { btn.disabled = false; btn.textContent = '⬇ 离线下载'; }
    alert(`保存失败：${err.message}`);
  });
}

/**
 * 批量下载：先选一个目录，再往里逐个写。
 *
 * 不能对每个文件都弹一次选择框——用户手势只够弹一次，第二次就被浏览器拒了。
 */
async function startBatchDownload(sources) {
  const mode = downloadMode();
  if (mode === 'server') { for (const s of sources) await queueOnServer(s, null); return; }
  if (mode === 'browser') { for (const s of sources) handOffToBrowser(s); return; }

  const dir = canPickDirectory() ? await pickSaveDirectory() : null;
  if (!dir) {
    // 选不了目录就退化成一个一个来（用户会看到多次弹窗，但至少能用）
    for (const s of sources) {
      const handle = await pickSaveTarget(s.filename);
      if (handle) await saveLocally(s, handle);
    }
    return;
  }

  for (const s of sources) {
    const handle = await dir.getFileHandle(s.filename || 'video.mp4', { create: true });
    await saveLocally(s, handle);
  }
}

const jobNodes = new Map();
const TERMINAL = new Set(['done', 'failed', 'canceled']);

/* ── SSE 按需连接 ──────────────────────────────────────────────
 * 不在页面加载时就连：一条常开的 SSE 会让页面永远到不了"加载完成"，
 * 无头浏览器的截图、预渲染、爬虫都会卡在那里等；服务端也要为每个
 * 闲置页面留一个连接。改成有下载任务才连，任务全部结束就断开。
 */
let eventSource = null;

function ensureEvents() {
  if (eventSource) return;
  eventSource = new EventSource('/api/events');
  eventSource.addEventListener('download', (e) => {
    $('downloadPanel').classList.remove('hidden');
    upsertJob(JSON.parse(e.data));
  });
}

function closeEventsIfIdle() {
  if (!eventSource) return;
  const anyActive = [...jobNodes.values()].some((n) => n.dataset.active === '1');
  if (!anyActive) {
    eventSource.close();
    eventSource = null;
  }
}

function upsertJob(job) {
  let node = jobNodes.get(job.id);
  if (!node) {
    node = el('div', { class: 'job' });
    jobNodes.set(job.id, node);
    $('downloadList').prepend(node);
  }
  node.dataset.active = TERMINAL.has(job.status) ? '0' : '1';
  node.replaceChildren(
    el('div', { class: 'job-head' },
      el('span', { class: 'job-name' }, job.filename),
      el('span', { class: `job-state ${job.status}` }, {
        queued: job.origin === 'local' ? '准备中' : '排队中',
        downloading: '下载中', verifying: '校验中',
        done: '已完成', failed: '失败', canceled: '已取消',
      }[job.status] || job.status),
      el('span', { class: 'spacer' }),
      job.status === 'downloading' || job.status === 'queued' || job.status === 'verifying'
        ? el('button', {
            class: 'toggle', type: 'button',
            // 本机任务用 AbortController 掐，服务端任务才走接口
            onclick: () => (job.origin === 'local'
              ? localAborts.get(job.id)?.abort(new Error('用户取消'))
              : fetch(`/api/downloads/${job.id}/cancel`, { method: 'POST' })),
          }, '取消')
        : null,
    ),
    el('div', { class: 'progress' },
      el('i', { style: `width:${job.percent ?? 0}%` })),
    el('div', { class: 'job-meta' },
      el('span', {}, `${fmtSize(job.receivedBytes)} / ${fmtSize(job.totalBytes)}${job.percent != null ? ` · ${job.percent}%` : ''}`),
      el('span', {}, fmtSpeed(job.bytesPerSec)),
      job.resumable ? el('span', {}, '支持断点续传') : null,
      job.verify?.checked
        ? el('span', {}, job.verify.ok ? `✓ ${job.verify.algo} 校验通过` : `✗ ${job.verify.algo} 校验失败`)
        : (job.verify?.reason && job.status === 'done'
            ? el('span', { class: 'no-verify' }, `未校验：${job.verify.reason}`)
            : null),
      job.status === 'done' ? el('span', {}, `已存至 ${job.path}`) : null,
      job.error ? el('span', {}, `错误：${job.error}`) : null,
    ),
  );

  if (TERMINAL.has(job.status)) closeEventsIfIdle();
}

/* ---------------- 四步走 tab ---------------- */

const STAGES = ['discovery', 'normalize', 'verify', 'final', 'deep'];
let activeStage = 'final';

function selectStage(name) {
  activeStage = STAGES.includes(name) ? name : 'final';
  for (const s of STAGES) {
    $(`panel-${s}`).classList.toggle('hidden', s !== activeStage);
  }
  for (const btn of document.querySelectorAll('#stageTabs .tab')) {
    const on = btn.dataset.stage === activeStage;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-selected', String(on));
  }
}

function bindTabs() {
  const tabs = [...document.querySelectorAll('#stageTabs .tab')];
  for (const btn of tabs) {
    btn.addEventListener('click', () => selectStage(btn.dataset.stage));
    // 键盘左右键切换，符合 tablist 的惯例
    btn.addEventListener('keydown', (e) => {
      const i = tabs.indexOf(btn);
      const next = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : -1;
      if (next < 0 || next >= tabs.length) return;
      e.preventDefault();
      tabs[next].focus();
      selectStage(tabs[next].dataset.stage);
    });
  }
}

const TERM_KIND = {
  original: { label: '原词', cls: 'kind-original' },
  variant: { label: '近似词', cls: 'kind-variant' },
  suggested: { label: '推荐词', cls: 'kind-suggested' },
};

/** 一条溯源引用。取证的关键：这个地址是谁、用什么词、第几名、从哪个页面找到的。 */
function citationNode(c) {
  const kind = TERM_KIND[c.termKind] || TERM_KIND.original;
  return el('li', { class: 'cite' },
    // 发现者：哪个引擎/数据源搜到的
    el('span', { class: 'cite-src' }, c.providerLabel || c.provider || '未知来源'),
    c.rank != null ? el('span', { class: 'cite-rank' }, `第 ${c.rank} 名`) : null,
    c.term ? el('span', { class: `chip tiny ${kind.cls}` }, `${kind.label}：${c.term}`) : null,
    // 托管方与发现者不同时才标出来，避免「Internet Archive · Internet Archive」这种废话
    c.hostLabel && c.hostLabel !== (c.providerLabel || c.provider)
      ? el('span', { class: 'cite-host' }, `托管于 ${c.hostLabel}`)
      : null,
    c.via
      ? el('a', { class: 'cite-via', href: c.via, target: '_blank', rel: 'noopener noreferrer' }, c.via)
      : el('span', { class: 'cite-via muted' }, '（无落地页，直接由数据源 API 返回）'),
  );
}

/* ── 第一步：各引擎原始结果 ── */
function renderDiscovery(d) {
  const terms = $('termList');
  terms.replaceChildren(
    el('div', { class: 'term-head' }, '本次用了这些检索词：'),
    ...d.terms.map((t) => {
      const kind = TERM_KIND[t.kind] || TERM_KIND.original;
      return el('span', { class: `term-chip ${kind.cls}`, title: t.why },
        el('b', {}, kind.label), t.term);
    }),
  );
  if (d.suggestedRaw?.length) {
    terms.append(el('p', { class: 'field-note' },
      `引擎共返回 ${d.suggestedRaw.length} 个推荐搜索词，筛掉跑题的后采用了 ${d.suggestedUsed.length} 个。`));
  }

  const box = $('engineResults');
  box.replaceChildren();
  for (const e of d.engines) {
    const wrap = el('div', { class: 'engine-block' });
    const head = el('div', { class: 'engine-head' },
      el('span', { class: `dot ${e.status}` }),
      el('b', {}, e.label),
      el('span', { class: 'spacer' }),
      el('span', { class: 'engine-total' },
        e.status === 'ok' ? `${e.total} 条 · ${e.elapsedMs}ms` : (e.reason || e.status)),
    );
    wrap.append(head);

    if (e.status !== 'ok') { box.append(wrap); continue; }

    for (const r of e.rounds) {
      const kind = TERM_KIND[r.kind] || TERM_KIND.original;
      const list = el('ol', { class: 'raw-list hidden' });
      for (const item of r.results) {
        list.append(el('li', {},
          el('a', { href: item.url, target: '_blank', rel: 'noopener noreferrer' }, item.title || item.url),
          el('span', { class: 'raw-url' }, item.url),
          item.snippet ? el('span', { class: 'raw-snippet' }, item.snippet) : null,
        ));
      }
      const toggle = el('button', {
        class: 'round-head', type: 'button',
        onclick: () => {
          const open = list.classList.toggle('hidden') === false;
          toggle.classList.toggle('open', open);
        },
      },
        el('span', { class: `chip tiny ${kind.cls}` }, kind.label),
        el('span', { class: 'round-term' }, r.term),
        el('span', { class: 'spacer' }),
        el('span', { class: 'round-count' }, r.error ? `失败：${r.error}` : `${r.returned} 条`),
      );
      wrap.append(toggle, list);
    }
    box.append(wrap);
  }
}

/* ── 第二步：归一去重 ── */
function renderNormalize(n) {
  $('normalizeSummary').textContent =
    `${n.before} 条原始结果 → 归一为 ${n.after} 条，合并掉 ${n.removed} 条重复；`
    + `其中 ${n.multiSourced} 条被两个以上的来源独立命中（互相印证，可信度更高）。`;

  const box = $('dedupeList');
  box.replaceChildren();
  if (n.groups.length === 0) {
    box.append(el('p', { class: 'field-note' }, '没有候选。'));
    return;
  }
  for (const g of n.groups) {
    const cites = el('ul', { class: 'cites hidden' }, ...g.citations.map(citationNode));
    const providers = [...new Set(g.citations.map((c) => c.provider))];
    const toggle = el('button', {
      class: 'dedupe-head', type: 'button',
      onclick: () => {
        const open = cites.classList.toggle('hidden') === false;
        toggle.classList.toggle('open', open);
      },
    },
      el('span', { class: `chip tiny ${g.count > 1 ? 'good' : ''}` }, `×${g.count}`),
      el('span', { class: 'dedupe-name' }, g.filename),
      el('span', { class: 'spacer' }),
      el('span', { class: 'chip tiny' }, g.keyLabel),
      el('span', { class: 'dedupe-src' }, `${providers.length} 个来源`),
    );
    box.append(toggle, cites);
  }
}

/* ── 第三步：嗅探甄别 ── */
function renderVerify(v) {
  $('verifySummary').textContent =
    `对 ${v.total} 条去重后的地址做嗅探甄别（其中 ${v.checked} 条发了真实探测请求）：`
    + `${v.usable} 条判定可用，${v.rejected} 条被筛掉。每条都附原始来源地址，可倒查取证。`;

  const box = $('verifyList');
  const draw = (filter) => {
    box.replaceChildren();
    const items = v.items.filter((x) => filter === 'all' || x.verdict === filter);
    if (items.length === 0) {
      box.append(el('p', { class: 'field-note' }, '没有符合条件的条目。'));
      return;
    }
    for (const it of items) {
      const ok = it.verdict === 'usable';
      const cites = el('ul', { class: 'cites' }, ...it.citations.map(citationNode));
      box.append(
        el('div', { class: `verify-item ${ok ? 'ok' : 'rejected'}` },
          el('div', { class: 'verify-head' },
            el('span', { class: `chip tiny ${ok ? 'good' : 'warn'}` }, ok ? '✓ 可用' : '✗ 已筛除'),
            el('span', { class: 'verify-name' }, it.filename),
            el('span', { class: 'spacer' }),
            it.score != null ? el('span', { class: 'verify-score' }, `${it.score} 分`) : null,
          ),
          el('p', { class: 'verify-url' },
            el('a', { href: it.url, target: '_blank', rel: 'noopener noreferrer' }, it.url)),
          el('div', { class: 'specs' },
            el('span', { class: 'chip tiny' }, (it.container || '?').toUpperCase()),
            it.height ? el('span', { class: 'chip tiny' }, `${it.height}p`) : null,
            it.durationSec ? el('span', { class: 'chip tiny' }, fmtDuration(it.durationSec)) : null,
            it.bytes ? el('span', { class: 'chip tiny' }, fmtSize(it.bytes)) : null,
            it.httpStatus ? el('span', { class: 'chip tiny' }, `HTTP ${it.httpStatus}`) : null,
            it.contentType ? el('span', { class: 'chip tiny' }, it.contentType) : null,
            !it.probed ? el('span', { class: 'chip tiny warn' }, '未探测') : null,
          ),
          el('p', { class: 'verify-reason' }, it.reason || ''),
          el('div', { class: 'cite-block' },
            el('div', { class: 'cite-title' }, `引用 · 原始来源（${it.citations.length}）`),
            cites),
        ),
      );
    }
  };
  draw('all');

  for (const radio of document.querySelectorAll('input[name="verifyFilter"]')) {
    radio.checked = radio.value === 'all';
    radio.onchange = () => { if (radio.checked) draw(radio.value); };
  }

  // 线索（没有解析器的域名）
  const leads = v.leads || [];
  const leadsPanel = $('leadsPanel');
  const leadsList = $('leadsList');
  leadsList.replaceChildren();
  leadsPanel.classList.toggle('hidden', leads.length === 0);
  for (const l of leads) {
    const cites = l.citations || [];
    leadsList.append(
      el('div', { class: 'lead' },
        el('a', { href: l.url, target: '_blank', rel: 'noopener noreferrer' }, l.title || l.url),
        el('p', { class: 'lead-url' }, l.url),
        el('p', { class: 'lead-note' },
          `${l.reason || ''}`
          + (cites.length > 1 ? ` · 被 ${l.foundByCount} 个来源、${cites.length} 种检索词命中` : '')),
        cites.length
          ? el('ul', { class: 'cites' }, ...cites.map((c) => {
              const kind = TERM_KIND[c.termKind] || TERM_KIND.original;
              return el('li', { class: 'cite' },
                el('span', { class: 'cite-src' }, c.provider || '引擎'),
                c.rank != null ? el('span', { class: 'cite-rank' }, `第 ${c.rank} 名`) : null,
                c.term ? el('span', { class: `chip tiny ${kind.cls}` }, `${kind.label}：${c.term}`) : null,
              );
            }))
          : null,
      ),
    );
  }
}

/* ── 第五步：模拟打开验证 ── */

let LAST_RESULT = null;

const fmtMs = (v) => (v == null ? '—' : `${v} ms`);

/** 八张截图。这是这一步最直观的产出，所以给它单独的网格。 */
function frameGrid(frames) {
  const grid = el('div', { class: 'shot-grid' });
  for (const f of frames) {
    if (!f.captured) {
      grid.append(el('div', { class: 'shot missing' },
        el('div', { class: 'shot-ph' }, '✗'),
        el('div', { class: 'shot-cap' }, el('b', {}, f.label), el('span', {}, f.reason || '未截到')),
      ));
      continue;
    }
    grid.append(el('div', { class: 'shot' },
      img({ src: f.jpeg, alt: `${f.label} 截图`, loading: 'lazy' }),
      el('div', { class: 'shot-cap' },
        el('b', {}, f.label),
        el('span', {}, `落点 ${f.atActual?.toFixed(1) ?? '?'}s · 清晰度 ${f.sharpness}`),
        f.blank ? el('span', { class: 'chip tiny warn' }, '空白帧') : null,
      ),
    ));
  }
  return grid;
}

function deepItemCard(it) {
  const p = it.playback || {};
  const d = it.download || {};
  const lv = it.verdict?.level || 'fail';

  const card = el('div', { class: `deep-item ${lv}` });
  card.append(
    el('div', { class: 'deep-head' },
      it.rank != null ? el('span', { class: 'rank' }, String(it.rank)) : null,
      el('span', { class: 'deep-name' }, it.filename),
      el('span', { class: 'spacer' }),
      p.grade ? el('span', { class: `grade grade-${p.grade}` }, p.grade) : null,
      el('span', { class: `chip tiny ${lv === 'ok' ? 'good' : lv === 'warn' ? 'warn' : 'bad'}` },
        it.verdict?.text || ''),
    ),
    el('p', { class: 'verify-url' },
      el('a', { href: it.url, target: '_blank', rel: 'noopener noreferrer' }, it.url)),
  );

  // 打开耗时——「点开要等多久」
  card.append(
    el('div', { class: 'metric-row' },
      el('span', { class: 'metric' }, el('b', {}, fmtMs(p.timings?.metadataMs)), '拿到元数据'),
      el('span', { class: 'metric' }, el('b', {}, fmtMs(p.timings?.firstDataMs)), '首帧数据'),
      el('span', { class: 'metric' }, el('b', {}, fmtMs(p.timings?.canPlayMs)), '可开始播'),
      el('span', { class: 'metric' }, el('b', {}, fmtMs(p.timings?.canPlayThroughMs)), '缓冲够播完'),
      el('span', { class: 'metric' }, el('b', {}, String(p.stalls ?? 0)), '卡顿次数'),
      el('span', { class: 'metric' },
        el('b', {}, p.decoded?.width ? `${p.decoded.width}×${p.decoded.height}` : '—'), '实际解码'),
    ),
  );

  if (!p.ok) card.append(el('p', { class: 'blocked-reason' }, `⚠ 放不出画面：${p.reason || '未知原因'}`));
  if (p.gradeNote) card.append(el('p', { class: 'verify-reason' }, `清晰度评级：${p.gradeNote}`));
  if (it.resolutionCheck && !it.resolutionCheck.match) {
    card.append(el('p', { class: 'blocked-reason' }, `⚠ ${it.resolutionCheck.note}`));
  }
  if (p.coverage?.note) {
    card.append(el('p', { class: p.coverage.degraded ? 'blocked-reason' : 'verify-reason' },
      `取样覆盖：截到 ${p.coverage.captured}/${p.coverage.total} 张 —— ${p.coverage.note}`));
  }
  if (p.quality) {
    card.append(el('p', { class: 'verify-reason' },
      `清晰度中位 ${p.quality.sharpnessMedian} · 对比度 ${p.quality.contrastMedian}`
      + (p.quality.detailDensity != null ? ` · 细节密度 ${p.quality.detailDensity}` : '')));
  }

  if (p.frames?.length) card.append(frameGrid(p.frames));

  // 模拟下载
  const dlBox = el('div', { class: 'dl-box' },
    el('div', { class: 'dl-head' },
      el('b', {}, `模拟下载 · ${d.threads ?? 0} 线程`),
      el('span', { class: `chip tiny ${d.ok ? 'good' : 'warn'}` }, d.ok ? '通过' : (d.reason || '失败')),
      el('span', { class: 'spacer' }),
      el('span', { class: 'dl-speed' },
        d.aggregateBytesPerSec ? `${fmtSize(d.aggregateBytesPerSec)}/s` : '—',
        d.estimatedFullDownloadSec != null ? ` · 推算整片 ${d.estimatedFullDownloadSec}s` : ''),
    ),
  );
  for (const s of d.segments ?? []) {
    dlBox.append(el('div', { class: `dl-seg ${s.ok ? 'ok' : 'fail'}` },
      el('span', { class: 'seg-i' }, `#${s.index}`),
      el('span', { class: 'seg-range' }, `bytes ${s.start}–${s.end}`),
      el('span', { class: 'spacer' }),
      s.ok
        ? el('span', {}, `${fmtSize(s.bytes)} · ${s.elapsedMs}ms · ${fmtSize(s.bytesPerSec)}/s`
            + (s.rangeExact ? '' : ' · ⚠ 区间不符'))
        : el('span', {}, s.reason || '失败'),
    ));
  }
  card.append(dlBox);
  return card;
}

function renderDeep(data) {
  const box = $('deepRounds_out');
  box.replaceChildren();

  if (data.skipped) {
    box.append(el('p', { class: 'blocked-reason' }, `⚠ ${data.reason}`));
    return;
  }

  $('deepStatus').textContent =
    `${data.stopReason}（共 ${data.totalRounds} 轮，上限 ${data.maxRounds} 轮，每轮验前 ${data.topN} 名）`;

  for (const rd of data.rounds) {
    const isActive = rd.round === data.activeRound;
    const body = el('div', { class: `round-body${isActive ? '' : ' hidden'}` });
    for (const it of rd.items) body.append(deepItemCard(it));

    const head = el('button', {
      class: `round-toggle${isActive ? ' open' : ''}`, type: 'button',
      onclick: () => {
        const open = body.classList.toggle('hidden') === false;
        head.classList.toggle('open', open);
      },
    },
      el('span', { class: 'chip tiny' }, `第 ${rd.round} 轮`),
      el('span', {}, `候选 ${rd.candidateRange.join('–')} 名`),
      el('span', { class: 'spacer' }),
      el('span', { class: `chip tiny ${rd.allFailed ? 'warn' : 'good'}` },
        rd.allFailed ? '全部不可用' : `${rd.usableCount}/${rd.total} 可用`),
      el('span', { class: 'round-meta' }, `可播 ${rd.playableCount} · 可下 ${rd.downloadableCount} · ${rd.elapsedMs}ms`),
    );
    box.append(head, body);
  }

  if (data.rejected?.length) {
    box.append(el('p', { class: 'field-note' },
      `${data.rejected.length} 个地址因不在白名单内被拒绝验证。`));
  }

  const tabCount = document.querySelector('#stageTabs .tab-count[data-count="deep"]');
  if (tabCount) {
    const last = data.rounds[data.rounds.length - 1];
    tabCount.textContent = last ? String(last.usableCount) : '';
  }
}

async function runDeepVerify() {
  const btn = $('deepRun');
  const status = $('deepStatus');
  if (!LAST_RESULT) { status.textContent = '请先检索。'; return; }

  // 验的是第四步推荐位里的直链，外加备选——备选里常有下载可用的
  const candidates = [
    ...LAST_RESULT.recommendations.filter((r) => r.kind === 'direct').map((r) => r.source),
    ...(LAST_RESULT.top || []),
    ...(LAST_RESULT.alternatives || []),
  ];
  const seen = new Set();
  const unique = candidates.filter((c) => c && !seen.has(c.url) && seen.add(c.url));
  if (unique.length === 0) { status.textContent = '没有可验证的片源。'; return; }

  btn.disabled = true;
  status.textContent = '正在打开浏览器、逐个加载并截图…（这一步会真的解码，比前几步慢）';
  try {
    const res = await fetch('/api/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        candidates: unique,
        verify: {
          topN: Number($('deepTopN').value) || 5,
          threads: Number($('deepThreads').value) || 5,
          maxRounds: Number($('deepRounds').value) || 10,
        },
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    renderDeep(data);
    if (data.skipped) status.textContent = data.reason;
  } catch (err) {
    status.textContent = `验证失败：${err.message}`;
  } finally {
    btn.disabled = false;
  }
}

function renderStages(data) {
  LAST_RESULT = data;
  // 换了检索就把上一次的深度验证结果清掉，免得张冠李戴
  $('deepRounds_out').replaceChildren();
  $('deepStatus').textContent = '点「开始验证」运行。这一步会真的打开浏览器解码，比前几步慢。';
  const s = data.stages;
  if (!s) return;
  renderPriorityHits(s.priority);
  renderDiscovery(s.discovery);
  renderNormalize(s.normalize);
  renderVerify(s.verify);

  const counts = {
    discovery: `${s.discovery.totalResults}`,
    normalize: `${s.normalize.after}`,
    verify: `${s.verify.usable}`,
    final: `${s.final.recommendations.length}`,
    deep: '',            // 第五步要手动触发，没跑之前不显示数字
  };
  for (const node of document.querySelectorAll('#stageTabs .tab-count')) {
    node.textContent = counts[node.dataset.count] ?? '';
  }
  // 每次检索回到最终结果页；想看过程再自己点
  selectStage('final');
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
  // 没海报时不能直接传 null 进去：replaceChildren/append 是原生 DOM 接口，
  // 会把 null 当成文本节点，标题左边就会多出一个 "null"。
  card.replaceChildren(...[
    t.poster ? img({ src: t.poster, alt: '' }) : null,
    info,
  ].filter(Boolean));

  // 推荐位：前 3 直接可播，第 4/5 正版订阅/付费
  const recs = data.recommendations || [];
  $('topHeading').textContent = `🏆 Top${recs.length} 推荐`;
  $('topSubhead').textContent = recs.length
    ? `前 ${data.stats.recommendedDirect} 位可直接点开播放 · 后 ${data.stats.recommendedOffers} 位需订阅或付费的正版渠道`
    : '';

  const topList = $('topList');
  topList.replaceChildren();
  if (recs.length === 0) {
    topList.append(el('p', { class: 'blocked-reason' }, '没有找到可推荐的片源或观看渠道。'));
  }
  for (const rec of recs) {
    topList.append(
      rec.kind === 'direct'
        ? sourceCard({ ...rec.source, rank: rec.rank }, { playable: true })
        : offerCard(rec),
    );
  }

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
    const detail = p.status === 'ok'
      ? [
          `${p.count} 条`,
          p.stats ? `引擎返回 ${p.stats.returned} / 解析 ${p.stats.resolved}` : null,
          p.limit ? `上限 ${p.limit}` : null,
          `${p.elapsedMs}ms`,
        ].filter(Boolean).join(' · ')
      : (p.reason || p.status);
    provList.append(
      el('div', { class: 'prov' },
        el('span', { class: `dot ${p.status}` }),
        el('span', {}, p.label),
        el('span', { class: 'detail' }, detail),
      ),
    );
  }

  const st = data.stats;
  $('statsLine').textContent =
    `候选 ${st.rawCandidates} → 去重 ${st.afterDedupe} → 实测探测 ${st.probed} → 可播 ${st.playable} / 受阻 ${st.blocked}`
    + (st.leads ? ` · 另有 ${st.leads} 个未解析页面` : '');

  const notes = $('notes');
  notes.replaceChildren();
  for (const n of data.notes || []) notes.append(el('li', {}, n));

  // 四步走的中间账目
  renderStages(data);

  $('results').classList.remove('hidden');
}

/** 检索结果里的优先来源命中。这里是取证记录，不给播放/下载按钮。 */
function renderPriorityHits(stage) {
  const box = $('priorityResult');
  const list = $('priorityHits');
  list.replaceChildren();

  if (!stage || !stage.enabled) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');

  const domains = stage.domains || [];
  $('priorityResultNote').textContent = stage.status === 'ok'
    ? `${domains.map((d) => `${d.domain} ${d.hits} 条`).join(' · ')}｜${stage.note}`
    : `${stage.status === 'skipped' ? '已跳过' : '出错'}：${stage.reason || ''}`;

  if (stage.status !== 'ok') return;
  if ((stage.hits || []).length === 0) {
    list.append(el('p', { class: 'field-note' }, '配置的站点上未发现匹配条目。'));
    return;
  }

  for (const h of stage.hits) {
    list.append(el('div', { class: 'evidence' },
      el('div', { class: 'evidence-head' },
        el('span', { class: 'chip tiny warn' }, h.domain),
        el('a', { href: h.url, target: '_blank', rel: 'noopener noreferrer' }, h.title || h.url),
        el('span', { class: 'spacer' }),
        h.similarity != null
          ? el('span', { class: 'chip tiny' }, `标题相似度 ${(h.similarity * 100).toFixed(0)}%`)
          : null,
      ),
      el('p', { class: 'lead-url' }, h.url),
      h.snippet ? el('p', { class: 'lead-note' }, h.snippet) : null,
      el('p', { class: 'lead-note' },
        `发现时间 ${h.observedAt}`
        + (h.term ? ` · 检索词「${h.term}」` : '')
        + (h.rank != null ? ` · 第 ${h.rank} 条` : '')),
      h.screenshot ? img({ class: 'evidence-shot', src: h.screenshot, alt: '页面截图存证' }) : null,
      h.screenshotError ? el('p', { class: 'lead-note' }, `截图失败：${h.screenshotError}`) : null,
      el('p', { class: 'evidence-note' }, h.note),
    ));
  }
}

/* ---------------- 检索前的状态条 ---------------- */

/**
 * 一眼看清"这次检索会拿什么去搜"。
 *
 * 存在的理由是踩过的坑：检索后端没配好时，五个引擎会被整体跳过，
 * 界面上却只是安静地返回一个空结果——用户看到的是"这软件搜不出东西"，
 * 而不是"有个开关没打开"。所以把后端状态放在检索框正下方，配不对就红着。
 */
function renderReadyBar() {
  const bar = $('readyBar');
  bar.replaceChildren();

  const serp = CONFIG.serp || null;
  const adapters = CONFIG.adapters || [];
  const engines = adapters.filter((a) => a.id.startsWith('engine:'));
  const usable = adapters.filter((a) => a.available);

  const gear = el('a', { class: 'ghost-btn tiny', href: '/settings.html' }, '⚙️ 设置');

  if (serp && !serp.available) {
    bar.className = 'ready-bar bad';
    bar.append(
      el('span', { class: 'chip warn' }, '引擎检索不可用'),
      el('span', { class: 'ready-text' }, serp.reason || '检索后端未配置'),
      el('span', { class: 'spacer' }),
      gear,
    );
    return;
  }

  bar.className = 'ready-bar';
  const backend = serp?.backend ? (BACKEND_LABEL[serp.backend] || serp.backend) : '—';
  bar.append(
    el('span', { class: 'chip ok' }, `后端 ${serp?.backend || '—'}`),
    el('span', { class: 'ready-text' },
      `${backend}${serp?.auto ? '（自动选的）' : ''}`
      + `　·　${usable.length}/${adapters.length} 个来源就绪`
      + (engines.length ? `　·　引擎 ${engines.map((e) => engineTitle(e.id.slice(7))).join('、')}` : '')),
    el('span', { class: 'spacer' }),
    gear,
  );

  const blocked = adapters.filter((a) => !a.available);
  if (blocked.length) {
    bar.append(el('p', { class: 'ready-note' },
      `未启用：${blocked.map((a) => `${a.label}（${a.reason}）`).join('；')}`));
  }
}

/* ---------------- 事件绑定 ---------------- */

/* ---------------- 检索进度 ---------------- */

const MARK = { ok: '✓', warn: '!', err: '✗', info: '·' };

function resetProgress() {
  const box = $('progress');
  box.className = 'progress-panel';
  box.classList.remove('hidden');
  $('progressBar').style.width = '0%';
  $('progressPct').textContent = '0%';
  $('progressElapsed').textContent = '';
  $('progressPhase').textContent = '准备中…';
  $('progressDetail').textContent = '';
  $('progressLog').replaceChildren();
}

/**
 * 一条进度消息。
 *
 * 阶段切换写进标题，阶段内的每一步追加进日志——日志才是用户真正想看的：
 * "现在卡在哪个源"、"哪个源已经回来了、拿到几条"。
 */
function onProgressEvent(ev) {
  const pct = Math.max(0, Math.min(100, ev.pct ?? 0));
  $('progressBar').style.width = `${pct}%`;
  $('progressPct').textContent = `${pct}%`;
  $('progressElapsed').textContent = ev.elapsedMs != null ? `${(ev.elapsedMs / 1000).toFixed(1)}s` : '';

  if (ev.type === 'phase') {
    $('progressPhase').textContent = ev.label;
    $('progressDetail').textContent = ev.detail || '';
    return;
  }
  if (ev.type === 'done') {
    $('progress').classList.add('done');
    $('progressPhase').textContent = '完成';
    $('progressDetail').textContent = ev.detail || '';
    return;
  }
  if (ev.type === 'failed') {
    $('progress').classList.add('failed');
    $('progressPhase').textContent = ev.label || '失败';
    $('progressDetail').textContent = ev.detail || '';
    return;
  }

  // step / note：进日志
  const log = $('progressLog');
  const status = ev.status && MARK[ev.status] ? ev.status : 'info';
  log.append(el('li', { class: status },
    el('span', { class: 'mark' }, MARK[status]),
    el('span', { class: 'what' },
      ev.label + (ev.detail ? ` —— ${ev.detail}` : '')),
    ev.total > 1 ? el('span', { class: 'at' }, `${ev.done}/${ev.total}`) : null,
  ));
  log.scrollTop = log.scrollHeight;
  if (ev.label) $('progressDetail').textContent = ev.label;
}

let searchStream = null;

function runSearch(q) {
  const btn = $('searchBtn');
  const status = $('status');
  btn.disabled = true;
  status.classList.add('hidden');
  $('results').classList.add('hidden');
  resetProgress();

  // 上一次没关干净的流先掐掉，否则两次检索的进度会串在一起
  if (searchStream) { searchStream.close(); searchStream = null; }

  const finish = () => {
    if (searchStream) { searchStream.close(); searchStream = null; }
    btn.disabled = false;
  };

  const es = new EventSource(`/api/search?stream=1&q=${encodeURIComponent(q)}`);
  searchStream = es;

  es.addEventListener('progress', (e) => {
    try { onProgressEvent(JSON.parse(e.data)); } catch { /* 坏帧跳过，不打断检索 */ }
  });

  es.addEventListener('result', (e) => {
    finish();
    try {
      renderResult(JSON.parse(e.data));
      // 进度条留在页面上，它本身就是这次检索的过程记录
      $('progress').classList.add('done');
      $('progressPhase').textContent = '完成';
    } catch (err) {
      status.className = 'status error';
      status.textContent = `结果解析失败：${err.message}`;
    }
  });

  es.addEventListener('failed', (e) => {
    finish();
    let msg = '未知错误';
    try { msg = JSON.parse(e.data).error || msg; } catch { /* 用默认文案 */ }
    $('progress').classList.add('failed');
    status.className = 'status error';
    status.textContent = `检索失败：${msg}`;
  });

  // EventSource 断流会自己重连，这里必须显式收掉，否则会不停重新发起检索
  es.onerror = () => {
    if (!searchStream) return;          // 正常收尾时也会触发一次，忽略
    finish();
    $('progress').classList.add('failed');
    status.className = 'status error';
    status.textContent = '与服务端的连接中断了，检索未完成。';
  };
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
  const picked = [...selected.values()];
  selected.clear();
  updateBatchBar();
  startBatchDownload(picked).catch((err) => alert(`批量下载失败：${err.message}`));
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

  bindTabs();
  $('deepRun').addEventListener('click', runDeepVerify);
  renderReadyBar();

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
      // 有未完成的任务才需要实时进度
      if (jobs.some((j) => !TERMINAL.has(j.status))) ensureEvents();
    }
  } catch { /* 队列为空或服务未就绪 */ }
})();
