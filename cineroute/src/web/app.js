/**
 * CineRoute 前端。
 *
 * 注意：片名、文件名、简介都来自第三方归档站，是**用户上传的内容**。
 * 因此本文件全程用 createElement + textContent 构建 DOM，不做任何
 * innerHTML 字符串拼接 —— 否则一个恶意条目标题就能在本地页面里执行脚本。
 */

const $ = (id) => document.getElementById(id);

/** 图片加载失败就隐藏，不留破图占位（第三方图床可能不可达）。 */
function img(props) {
  const node = document.createElement('img');
  node.addEventListener('error', () => node.classList.add('broken'), { once: true });
  for (const [k, v] of Object.entries(props)) if (v != null) node.setAttribute(k, v);
  return node;
}

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

async function startDownload(s, btn) {
  if (btn) { btn.disabled = true; btn.textContent = '已加入队列'; }
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
    upsertJob(job);
  } catch (err) {
    if (btn) { btn.disabled = false; btn.textContent = '⬇ 离线下载'; }
    alert(`加入下载队列失败：${err.message}`);
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
  card.replaceChildren(
    t.poster ? img({ src: t.poster, alt: '' }) : null,
    info,
  );

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

/* ---------------- 检索来源配置 ---------------- */

/**
 * 来源面板。这里是"哪些源参与检索、每个取多少条"的唯一入口——
 * 代码里没有写死的源列表，全部读自 /api/sources。
 */
let SOURCES = { config: null, catalog: null };

const ENGINE_LABELS = { google: 'Google', bing: 'Bing', baidu: '百度', yandex: 'Yandex', duckduckgo: 'DuckDuckGo' };
const engineLabel = (engine) => ENGINE_LABELS[engine]
  || (engine ? engine[0].toUpperCase() + engine.slice(1) : engine);
/** 中文名后不加空格（「百度搜索」），西文名后加（「Google 搜索」）。 */
const engineTitle = (engine) => {
  const n = engineLabel(engine);
  return `${n}${/[一-龥]$/.test(n) ? '' : ' '}搜索`;
};

/** 一行来源：勾选框 + 名称 + 取数输入框。 */
function sourceRow(src, { title, note, removable }) {
  const cb = el('input', { type: 'checkbox' });
  cb.checked = src.enabled !== false;
  cb.addEventListener('change', () => { src.enabled = cb.checked; markDirty(); });

  const num = el('input', { type: 'number', min: '1', max: '1000', class: 'limit-input' });
  num.value = String(src.limit ?? SOURCES.config.defaults.limit);
  num.addEventListener('change', () => {
    const v = Math.max(1, Math.min(1000, Math.round(Number(num.value) || 0)));
    num.value = String(v);
    src.limit = v;
    markDirty();
  });

  return el('div', { class: 'source-row' },
    el('label', { class: 'row-pick' }, cb, el('span', { class: 'row-title' }, title)),
    note ? el('span', { class: 'row-note' }, note) : null,
    el('span', { class: 'spacer' }),
    el('label', { class: 'row-limit' }, '取前', num, '条'),
    removable
      ? el('button', {
          class: 'toggle', type: 'button', title: '移除这个来源',
          onclick: () => {
            SOURCES.config.sources = SOURCES.config.sources.filter((s) => s.id !== src.id);
            renderSources();
            markDirty();
          },
        }, '移除')
      : null,
  );
}

function markDirty() {
  $('sourceSaveState').textContent = '有未保存的改动';
  renderSourceSummary();
}

function renderSourceSummary() {
  const cfg = SOURCES.config;
  if (!cfg) return;
  const on = cfg.sources.filter((s) => s.enabled);
  const engines = on.filter((s) => s.type === 'engine');
  const parts = [`已选 ${on.length} 个来源`];
  if (engines.length) {
    parts.push(engines.map((s) => `${engineLabel(s.engine)} 前 ${s.limit}`).join(' · '));
  }
  $('sourceSummary').textContent = parts.join('｜');
}

function renderSources() {
  const cfg = SOURCES.config;
  const catalog = SOURCES.catalog || {};
  $('defaultLimit').value = String(cfg.defaults.limit);

  // 引擎行：出厂四个 + 用户自己加的
  const engineBox = $('engineList');
  engineBox.replaceChildren();
  const engineSources = cfg.sources.filter((s) => s.type === 'engine');
  if (engineSources.length === 0) {
    engineBox.append(el('p', { class: 'field-note' }, '没有启用任何搜索引擎来源。'));
  }
  const known = new Set((catalog.engines || []).map((e) => e.engine));
  for (const s of engineSources) {
    const pageSize = (catalog.engines || []).find((e) => e.engine === s.engine)?.pageSize;
    const pages = pageSize ? Math.ceil((s.limit || 0) / pageSize) : null;
    engineBox.append(sourceRow(s, {
      title: engineTitle(s.engine),
      note: pages ? `单页 ${pageSize} 条，需翻 ${pages} 页` : '自定义引擎，经 SERP 服务转发',
      removable: !known.has(s.engine) || engineSources.length > 1,
    }));
  }

  // 专用源行
  const builtinBox = $('builtinList');
  builtinBox.replaceChildren();
  for (const b of catalog.builtins || []) {
    let src = cfg.sources.find((s) => s.id === b.id);
    if (!src) {
      // 配置里没有这条（用户删过），补一条禁用的占位，让它还能被勾回来
      src = { id: b.id, type: 'builtin', enabled: false, limit: cfg.defaults.limit };
      cfg.sources.push(src);
    }
    builtinBox.append(sourceRow(src, {
      title: b.label,
      note: b.available ? (b.kind === 'metadata' ? '只出元数据与正版渠道' : null) : `未配置：${b.reason}`,
      removable: false,
    }));
  }

  // 引擎下拉：出厂支持的几个
  const sel = $('addEngineSelect');
  sel.replaceChildren(
    el('option', { value: '' }, '选择引擎…'),
    ...(catalog.engines || []).map((e) => el('option', { value: e.engine }, engineLabel(e.engine))),
  );

  $('siteScope').value = (cfg.siteScope || []).join('\n');

  const serp = $('serpState');
  serp.textContent = catalog.serpConfigured
    ? ''
    : '⚠ 尚未配置 SERP 服务，引擎来源会被跳过（四大引擎都没有可直接用的免费官方 API，需设 CINEROUTE_SERP_PROVIDER / CINEROUTE_SERP_KEY）';
  serp.classList.toggle('warn-text', !catalog.serpConfigured);

  renderSourceSummary();
}

function addEngine() {
  const cfg = SOURCES.config;
  const engine = ($('addEngineName').value.trim() || $('addEngineSelect').value).toLowerCase();
  if (!engine) { alert('先选一个引擎，或填引擎名。'); return; }
  const id = `engine:${engine}`;
  if (cfg.sources.some((s) => s.id === id)) { alert(`${engineLabel(engine)} 已经在来源里了。`); return; }
  cfg.sources.push({
    id, type: 'engine', engine, enabled: true,
    limit: Math.max(1, Math.min(1000, Number($('addEngineLimit').value) || cfg.defaults.limit)),
  });
  $('addEngineName').value = '';
  $('addEngineSelect').value = '';
  renderSources();
  markDirty();
}

async function saveSources(payload) {
  const state = $('sourceSaveState');
  state.textContent = '保存中…';
  try {
    const res = await fetch('/api/sources', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    SOURCES = { config: data.config, catalog: data.catalog };
    renderSources();
    state.textContent = data.warning || '已保存，下次检索按新配置跑';
  } catch (err) {
    state.textContent = `保存失败：${err.message}`;
  }
}

function bindSourcePanel() {
  $('sourceToggle').addEventListener('click', (e) => {
    const body = $('sourceBody');
    const open = body.classList.toggle('hidden') === false;
    e.currentTarget.textContent = open ? '收起设置' : '展开设置';
    e.currentTarget.setAttribute('aria-expanded', String(open));
  });

  $('defaultLimit').addEventListener('change', (e) => {
    const v = Math.max(1, Math.min(1000, Math.round(Number(e.target.value) || 0)));
    e.target.value = String(v);
    SOURCES.config.defaults.limit = v;
    markDirty();
  });

  $('addEngineBtn').addEventListener('click', addEngine);

  $('siteScope').addEventListener('change', (e) => {
    SOURCES.config.siteScope = e.target.value.split('\n').map((s) => s.trim()).filter(Boolean);
    markDirty();
  });

  $('sourceSave').addEventListener('click', () => {
    // 提交前把文本框里的最新内容也带上（用户可能没触发 change 就点了保存）
    SOURCES.config.siteScope = $('siteScope').value.split('\n').map((s) => s.trim()).filter(Boolean);
    saveSources({ config: SOURCES.config });
  });

  $('sourceReset').addEventListener('click', () => saveSources({ reset: true }));
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

  bindTabs();
  $('deepRun').addEventListener('click', runDeepVerify);
  bindSourcePanel();
  try {
    SOURCES = await (await fetch('/api/sources')).json();
    renderSources();
  } catch {
    $('sourceSummary').textContent = '来源配置读取失败，本次按出厂默认检索';
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
      // 有未完成的任务才需要实时进度
      if (jobs.some((j) => !TERMINAL.has(j.status))) ensureEvents();
    }
  } catch { /* 队列为空或服务未就绪 */ }
})();
