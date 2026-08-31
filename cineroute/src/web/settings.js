/**
 * 设置页。
 *
 * 与主页彻底分开的理由很实际：这些东西一次配好就很少再动，
 * 挤在检索框上面只会天天占地方；而它们又都是"配错了检索就出不来结果"的东西，
 * 塞在折叠面板里容易被当成可有可无的高级选项。
 *
 * 页面上所有的值都来自 /api/sources，没有写死的清单。保存时整份提交，
 * 服务端规范化后回传，界面再按回传的值重画——**以服务端为准**，
 * 这样用户填了非法值会当场看到它被改成什么，而不是以为存进去了。
 */

import { $, el, engineLabel, engineTitle, BACKEND_LABEL, linesOf } from './dom.js';

let SOURCES = { config: null, catalog: null };
let dirty = false;

function markDirty() {
  dirty = true;
  $('saveState').textContent = '有未保存的改动';
  $('saveState').classList.remove('ok-text');
}

/* ---------------- 检索后端 ---------------- */

/** 只显示当前后端相关的字段，其余淡出——三组字段同时摊开没人看得懂该填哪个。 */
function syncBackendFields() {
  const picked = $('serpBackend').value;
  const actual = SOURCES.catalog?.serp?.backend || null;
  const show = (id, on) => $(id).classList.toggle('inactive', !on);
  const on = (name) => picked === name || (picked === 'auto' && actual === name);
  // 阶梯把 http 和 browser 两级都用上，所以两组字段都算相关
  show('httpFields', on('http') || on('ladder') || picked === 'ladder');
  show('apiFields', on('api'));
  show('cliFields', on('cli'));
  show('browserFields', on('browser') || on('ladder') || picked === 'ladder');
}

function renderBackendState() {
  const s = SOURCES.catalog?.serp;
  const box = $('backendState');
  box.replaceChildren();
  if (!s) return;

  box.className = `backend-state ${s.available ? 'ok' : 'bad'}`;
  const name = s.backend ? (BACKEND_LABEL[s.backend] || s.backend) : '无';

  // 注意：这里必须先滤掉 null 再 append —— Node.append(null) 会把 null
  // 转成字符串 "null" 显示出来，el() 的跳过规则管不到这一层。
  box.append(...[
    el('p', { class: 'backend-line' },
      el('strong', {}, s.available ? '✓ 当前可用' : '✗ 当前不可用'),
      '　当前走：',
      el('code', {}, s.backend || '—'),
      `　${name}`,
      s.auto && s.backend ? el('span', { class: 'chip tiny' }, '自动挑的') : null),
    s.why ? el('p', { class: 'field-note' }, s.why) : null,
    s.reason ? el('p', { class: 'field-note warn-text' }, s.reason) : null,
  ].filter(Boolean));

  // 哪些字段其实是环境变量在兜底。不说清楚，用户会以为界面上空着就是没配。
  const envKeys = Object.entries(s.envOnly || {}).filter(([, v]) => v).map(([k]) => k);
  if (envKeys.length) {
    box.append(el('p', { class: 'field-note' },
      `以下项由环境变量提供，界面上留空也能用：${envKeys.join('、')}。填了则以界面上的为准。`));
  }
  if (SOURCES.catalog?.offline) {
    box.append(el('p', { class: 'field-note warn-text' },
      '当前是离线夹具模式，引擎检索被强制指向本地夹具，这里的后端设置本次不生效。'));
  }
}

function renderBackend() {
  const c = SOURCES.config?.serp || {};
  $('serpBackend').value = c.backend || 'auto';
  $('serpProvider').value = c.provider || '';
  $('serpKey').value = '';
  $('serpKeyState').textContent = c.keySet ? '已存有 key，留空即保持不变' : '尚未填写';
  $('serpUrl').value = c.urlTemplate || '';
  $('serpCmd').value = c.cmd || '';
  $('serpCmdFormat').value = c.cmdFormat || 'json';
  $('serpChrome').value = c.chromePath || '';
  $('serpTimeout').value = String(c.timeoutMs ?? 25000);
  $('serpSettle').value = String(c.settleMs ?? 800);
  renderBackendState();
  syncBackendFields();
}

function readBackend() {
  return {
    backend: $('serpBackend').value,
    provider: $('serpProvider').value,
    // 留空 = 保持原样。服务端认这个约定，因为 key 从来不往前端发。
    key: $('serpKey').value.trim(),
    urlTemplate: $('serpUrl').value.trim(),
    cmd: $('serpCmd').value.trim(),
    cmdFormat: $('serpCmdFormat').value,
    chromePath: $('serpChrome').value.trim(),
    timeoutMs: Number($('serpTimeout').value) || 25000,
    settleMs: Number($('serpSettle').value) || 0,
  };
}

/* ---------------- 优先来源 ---------------- */

function renderPriority() {
  const pr = SOURCES.config?.priority;
  if (!pr) return;
  $('priorityEnabled').checked = pr.enabled !== false;
  $('priorityDomains').value = (pr.domains || []).join('\n');
  $('priorityLimit').value = String(pr.limitPerDomain ?? 10);
  $('priorityShots').checked = Boolean(pr.captureScreenshots);
  $('priorityMaxShots').value = String(pr.maxScreenshots ?? 5);

  const n = (pr.domains || []).length;
  $('prioritySummary').textContent = pr.enabled === false
    ? '已关闭'
    : `${n} 个站点：${(pr.domains || []).join('、')}`;
}

function readPriority() {
  return {
    enabled: $('priorityEnabled').checked,
    domains: linesOf($('priorityDomains').value),
    limitPerDomain: Number($('priorityLimit').value) || 10,
    captureScreenshots: $('priorityShots').checked,
    maxScreenshots: Number($('priorityMaxShots').value) || 5,
  };
}

/* ---------------- 检索来源 ---------------- */

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

function renderSources() {
  const cfg = SOURCES.config;
  const catalog = SOURCES.catalog || {};
  $('defaultLimit').value = String(cfg.defaults.limit);

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
      note: pages ? `单页 ${pageSize} 条，需翻 ${pages} 页` : '自定义引擎，按后端模板转发',
      removable: !known.has(s.engine) || engineSources.length > 1,
    }));
  }

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

  const sel = $('addEngineSelect');
  sel.replaceChildren(
    el('option', { value: '' }, '选择引擎…'),
    ...(catalog.engines || []).map((e) => el('option', { value: e.engine }, engineLabel(e.engine))),
  );

  $('siteScope').value = (cfg.siteScope || []).join('\n');
  // 建议列表只当占位提示：让人看得见能填什么，但**不自动填进去**——
  // 默认就该是全网搜
  const hints = catalog.siteScopeSuggestions || [];
  if (hints.length) $('siteScope').placeholder = `留空 = 全网搜。想限定就一行一个，例如：\n${hints.slice(0, 4).join('\n')}`;
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

/* ---------------- 预算 ---------------- */

function renderDownloadTarget() {
  const cfg = SOURCES.config;
  const sel = $('downloadTarget');
  sel.value = cfg.downloadTarget || 'local';
  const dir = SOURCES.catalog?.downloadDir;
  $('downloadTargetNote').textContent = sel.value === 'server'
    ? `文件会留在服务端：${dir || 'downloads/'}`
    : '文件存到你正在用的这台机器上';
}

function renderBudget() {
  const cfg = SOURCES.config;
  const e = cfg.expand || {};
  $('expMaxVariants').value = String(e.maxVariants ?? 4);
  $('expMaxTerms').value = String(e.maxTerms ?? 4);
  $('expUseSuggested').checked = e.useSuggested !== false;
  $('expMaxSuggested').value = String(e.maxSuggested ?? 3);
  $('probeLimit').value = String(cfg.probeLimit ?? 24);

  const v = cfg.verify || {};
  $('verifyEnabled').checked = v.enabled !== false;
  $('verifyTopN').value = String(v.topN ?? 5);
  $('verifyThreads').value = String(v.threads ?? 5);
  $('verifyRounds').value = String(v.maxRounds ?? 10);
  $('verifyShotWidth').value = String(v.shotWidth ?? 480);
  $('verifyProbeBytes').value = String(v.probeBytes ?? 262144);
  $('verifyConcurrency').value = String(v.concurrency ?? 2);
}

function readBudget() {
  return {
    expand: {
      maxVariants: Number($('expMaxVariants').value) || 4,
      maxTerms: Number($('expMaxTerms').value) || 4,
      useSuggested: $('expUseSuggested').checked,
      maxSuggested: Number($('expMaxSuggested').value) || 0,
    },
    probeLimit: Number($('probeLimit').value) || 24,
    verify: {
      enabled: $('verifyEnabled').checked,
      topN: Number($('verifyTopN').value) || 5,
      threads: Number($('verifyThreads').value) || 5,
      maxRounds: Number($('verifyRounds').value) || 10,
      shotWidth: Number($('verifyShotWidth').value) || 480,
      probeBytes: Number($('verifyProbeBytes').value) || 262144,
      concurrency: Number($('verifyConcurrency').value) || 2,
    },
  };
}

/* ---------------- 保存 ---------------- */

function renderAll() {
  renderBackend();
  renderPriority();
  renderSources();
  renderDownloadTarget();
  renderBudget();
  $('configPath').textContent = SOURCES.catalog?.configPath
    ? `配置文件：${SOURCES.catalog.configPath}`
    : '';
}

/** 把整页读成一份配置。分散在各处的 read* 在这里汇总，只有这一个提交入口。 */
function collect() {
  const cfg = SOURCES.config;
  return {
    ...cfg,
    defaults: { ...cfg.defaults, limit: Number($('defaultLimit').value) || cfg.defaults.limit },
    serp: readBackend(),
    priority: readPriority(),
    downloadTarget: $('downloadTarget').value,
    siteScope: linesOf($('siteScope').value),
    ...readBudget(),
  };
}

async function save(payload) {
  const state = $('saveState');
  state.classList.remove('ok-text');
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
    renderAll();
    dirty = false;
    state.textContent = data.warning || '已保存，下次检索按新配置跑';
    if (!data.warning) state.classList.add('ok-text');
  } catch (err) {
    state.textContent = `保存失败：${err.message}`;
  }
}

/* ---------------- 绑定 ---------------- */

function bind() {
  $('saveBtn').addEventListener('click', () => save({ config: collect() }));
  $('resetBtn').addEventListener('click', () => {
    if (confirm('恢复出厂设置会丢掉你改过的全部检索配置（包括填过的 API key），确定吗？')) {
      save({ reset: true });
    }
  });
  $('addEngineBtn').addEventListener('click', addEngine);
  $('serpBackend').addEventListener('change', () => { syncBackendFields(); markDirty(); });
  $('downloadTarget').addEventListener('change', () => { renderDownloadTarget(); markDirty(); });

  // 除了"添加引擎"那几个输入框，页面上其他控件一动就标脏
  const skip = new Set(['addEngineName', 'addEngineSelect', 'addEngineLimit']);
  for (const node of document.querySelectorAll('input, select, textarea')) {
    if (skip.has(node.id)) continue;
    node.addEventListener('change', markDirty);
  }

  // 改完没保存就走人是这类页面最常见的坑
  window.addEventListener('beforeunload', (e) => {
    if (!dirty) return;
    e.preventDefault();
    e.returnValue = '';
  });
}

(async function init() {
  try {
    const res = await fetch('/api/sources');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    SOURCES = await res.json();
  } catch (err) {
    const box = $('loadError');
    box.textContent = `读取配置失败：${err.message}。服务没起来的话，先跑 npm start。`;
    box.classList.remove('hidden');
    return;
  }
  renderAll();
  bind();
})();
