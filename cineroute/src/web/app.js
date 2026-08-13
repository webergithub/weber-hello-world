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

  // 引擎发现但没有解析器的页面
  const leads = data.leads || [];
  const leadsPanel = $('leadsPanel');
  const leadsList = $('leadsList');
  leadsList.replaceChildren();
  leadsPanel.classList.toggle('hidden', leads.length === 0);
  for (const l of leads) {
    leadsList.append(
      el('div', { class: 'lead' },
        el('a', { href: l.url, target: '_blank', rel: 'noopener noreferrer' }, l.title || l.url),
        el('p', { class: 'lead-url' }, l.url),
        el('p', { class: 'lead-note' },
          `${l.discoveredBy || '引擎'} 第 ${l.rank ?? '?'} 条 · ${l.reason || ''}`),
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

  $('results').classList.remove('hidden');
}

/* ---------------- 检索来源配置 ---------------- */

/**
 * 来源面板。这里是"哪些源参与检索、每个取多少条"的唯一入口——
 * 代码里没有写死的源列表，全部读自 /api/sources。
 */
let SOURCES = { config: null, catalog: null };

const ENGINE_LABELS = { google: 'Google', baidu: '百度', bing: 'Bing', duckduckgo: 'DuckDuckGo' };
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
