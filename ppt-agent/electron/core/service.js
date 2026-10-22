'use strict';
// 业务编排：解析任务（扫描目录、去重、解析、截图、入库）、标签、相似分组、检索与导出。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const logger = require('./logger');
const { Store } = require('./db');
const { parsePptx, quickProps } = require('./pptx');
const { parseDocx } = require('./docx');
const { slideToMd, docToMd } = require('./markdown');
const { tokenize, detectLang } = require('./textproc');
const { hashVector, mean, embedder } = require('./vectors');
const { fileTerms, computeTags } = require('./tagger');
const { computeGroups, computePairs, normSlideTitle } = require('./similarity');
const { slideKeywords, pageTags, computeLinks } = require('./relations');
const { writeNotes } = require('./noteswriter');
const { SearchEngine } = require('./search');
const { exportPptx, exportMarkdown } = require('./exporter');
const { convertTheme, RULES: DEFAULT_RULES, normalizeRules } = require('./converter');
const gen = require('./generate');
const { Office } = require('./office');
const { imageLuminance } = require('./image');
const llm = require('./llm');

// 支持的文档类型（设置中多选启用）
const DOC_TYPES = {
  ppt: { label: 'PPT 演示文稿', exts: ['.pptx', '.pptm', '.ppsx', '.ppsm', '.potx', '.potm', '.ppt', '.pps', '.pot'], legacy: ['.ppt', '.pps', '.pot'] },
  word: { label: 'Word 文档', exts: ['.docx', '.docm', '.dotx', '.dotm', '.doc', '.dot'], legacy: ['.doc', '.dot'] },
};
const KIND_OF = new Map(Object.entries(DOC_TYPES).flatMap(([k, t]) => t.exts.map((e) => [e, k])));
const LEGACY = new Set(Object.values(DOC_TYPES).flatMap((t) => t.legacy));
const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '$recycle.bin', 'recycler', 'system volume information', 'windows', 'windows.old', '$windows.~bt', '$windows.~ws', '$winreagent',
  'program files', 'program files (x86)', 'programdata', 'appdata', 'msocache', 'recovery', 'perflogs', 'config.msi', 'intel', 'amd', 'nvidia',
  '.cache', '.trash', '.npm', '.gradle', '.m2', '.cargo', '.rustup', '.conda', 'anaconda3', 'miniconda3', 'site-packages', '__pycache__']);
// 全盘扫描时跳过的系统路径（Linux / macOS）
const SKIP_ROOT_PATHS = ['/proc', '/sys', '/dev', '/run', '/snap', '/boot', '/usr', '/bin', '/sbin', '/lib', '/lib32', '/lib64', '/libx32', '/etc', '/var/lib', '/var/cache', '/var/log', '/opt/pw-browsers',
  '/System', '/Library', '/private', '/Applications', '/cores', '/Volumes/Recovery'];

function localRoots() {
  if (process.platform === 'win32') {
    const roots = [];
    for (let c = 67; c <= 90; c++) { const d = String.fromCharCode(c) + ':\\'; try { if (fs.existsSync(d)) roots.push(d); } catch { /* 无法访问的盘符 */ } }
    return roots;
  }
  if (process.platform === 'darwin') return ['/Users', '/Volumes'].filter((d) => fs.existsSync(d));
  return ['/'];
}

const LANG_NAMES = { zh: '中文', en: 'English', ja: '日本語', ko: '한국어', fr: 'Français', de: 'Deutsch', es: 'Español', ru: 'Русский', pt: 'Português', it: 'Italiano', ar: 'العربية', th: 'ไทย', vi: 'Tiếng Việt', id: 'Bahasa Indonesia', ms: 'Bahasa Melayu', tr: 'Türkçe', nl: 'Nederlands', pl: 'Polski', hi: 'हिन्दी' };
const LANG_TAGS = { zh: 'zh-CN', en: 'en-US', ja: 'ja-JP', ko: 'ko-KR', fr: 'fr-FR', de: 'de-DE', es: 'es-ES', ru: 'ru-RU', pt: 'pt-BR', it: 'it-IT', ar: 'ar-SA', th: 'th-TH', vi: 'vi-VN', id: 'id-ID', ms: 'ms-MY', tr: 'tr-TR', nl: 'nl-NL', pl: 'pl-PL', hi: 'hi-IN' };

const DEFAULT_CONFIG = {
  thumbnails: 'auto', // auto | powerpoint | libreoffice | off
  thumbWidth: 1280,
  llm: { enabled: false, baseUrl: 'https://api.deepseek.com/v1', apiKey: '', model: 'deepseek-chat', useForQuery: true, useForTags: false },
  embedding: { provider: 'none', baseUrl: 'http://127.0.0.1:11434', apiKey: '', model: 'bge-m3' },
  similarityThreshold: 0.82,
  docTypes: ['ppt', 'word'],
  uiTheme: 'system', // dark | light | system
  closeAction: 'ask', // ask | quit | minimize：关闭窗口时的行为
  minorLangs: ['ja', 'ko', 'fr', 'de', 'es', 'ru'], // 讲解词“小语种”下拉中显示的语言
  analyticsRefresh: 'open', // 总览分析统计刷新：open 每次打开 | daily 每天 | weekly 每周 | manual 仅手动
  welcome: 'first', // 启动简介：first 首次打开显示 | always 每次显示 | never 不再显示
  keymap: {}, // 浏览窗口快捷键：只保存与默认不同的动作 { 动作: [按键组合] }
  // 定时监测更新：每天 time 对开启监测的任务做增量扫描；catchUp：错过的（程序未运行）在下次启动时补扫
  watch: { enabled: false, time: '12:30', catchUp: true, since: 0, lastRun: 0 },
};

class AgentService extends EventEmitter {
  constructor(dataDir) {
    super();
    this.dataDir = dataDir;
    fs.mkdirSync(dataDir, { recursive: true });
    logger.init(dataDir);
    this.log = logger.child('service');
    this.cacheDir = path.join(dataDir, 'cache');
    this.mediaDir = path.join(this.cacheDir, 'media');
    this.thumbDir = path.join(this.cacheDir, 'thumbs');
    this.mdDir = path.join(dataDir, 'markdown');
    this.configFile = path.join(dataDir, 'config.json');
    this.config = this.loadConfig();
    this.store = new Store(path.join(dataDir, 'ppt-agent.db'));
    this.office = new Office(logger.child('office'));
    this.search = new SearchEngine(this.store, () => this.config, logger.child('search'));
    this.queue = [];
    this.running = null;
    this.cancelled = new Set();
    this.groupsCache = null;
    // 上次异常退出时未完成的任务标记为中断
    for (const t of this.store.listTasks()) {
      if (t.status === 'running' || t.status === 'pending') this.store.updateTask(t.id, { status: 'interrupted', message: t.status === 'running' ? '程序关闭（或异常退出）时任务未完成，可点击“继续”从断点继续' : '程序关闭时仍在排队，可点击“继续”' });
    }
    this.resumeFlags = new Map();
    this.incrementalRuns = new Map();
    this.pausing = new Set();
    this.log.info(`服务启动，数据目录 ${dataDir}`);
  }

  loadConfig() {
    try {
      const c = JSON.parse(fs.readFileSync(this.configFile, 'utf8'));
      return { ...DEFAULT_CONFIG, ...c, llm: { ...DEFAULT_CONFIG.llm, ...(c.llm || {}) }, embedding: { ...DEFAULT_CONFIG.embedding, ...(c.embedding || {}) }, watch: { ...DEFAULT_CONFIG.watch, ...(c.watch || {}) } };
    } catch { return JSON.parse(JSON.stringify(DEFAULT_CONFIG)); }
  }
  getConfig() { return this.config; }
  setConfig(patch) {
    const w0 = this.config.watch || DEFAULT_CONFIG.watch;
    const watch = { ...w0, ...(patch.watch || {}) };
    // 开启监测或修改时间点时，从“现在”开始计算下一次，避免立即补扫当天早已过去的时间点
    if (patch.watch && (watch.enabled !== w0.enabled || watch.time !== w0.time) && patch.watch.since === undefined) watch.since = Date.now();
    this.config = { ...this.config, ...patch, llm: { ...this.config.llm, ...(patch.llm || {}) }, embedding: { ...this.config.embedding, ...(patch.embedding || {}) }, watch };
    fs.writeFileSync(this.configFile, JSON.stringify(this.config, null, 2));
    // 文档类型变化会影响是否关联 Word 内容：后台重算页面关联
    if (patch.docTypes && this.store) setImmediate(() => this.computeRelations().catch((e) => this.log.warn('重算页面关联失败', e)));
    this.log.info('配置已更新', { thumbnails: this.config.thumbnails, llm: this.config.llm.enabled ? this.config.llm.model : '未启用', embedding: this.config.embedding.provider });
    return this.config;
  }

  enabledExts() {
    const types = (this.config.docTypes && this.config.docTypes.length ? this.config.docTypes : ['ppt']).filter((k) => DOC_TYPES[k]);
    return new Set(types.flatMap((k) => DOC_TYPES[k].exts));
  }

  docTypes() { return Object.entries(DOC_TYPES).map(([key, t]) => ({ key, label: t.label, exts: t.exts })); }

  // ================= 解析任务 =================
  /** 扫描本机所有磁盘中的 PPT / Word 文件（按盘符、目录名顺序） */
  /** watch：开启每日定时增量扫描（监测修改与新增的文档），time：每天扫描的时间点 HH:MM */
  addAllLocalTask({ watch = false, time } = {}) {
    const roots = localRoots();
    const id = this.store.createTask(roots.join(' ; '), '本机全部文档');
    this.store.updateTask(id, { roots: JSON.stringify(roots), status: 'draft', watch: watch ? 1 : 0 });
    this.log.info(`[任务#${id}] 已添加全盘扫描任务（待手动开始）：${roots.join(' ')}（类型：${[...this.enabledExts()].join(' ')}）${watch ? `；开启每日 ${time || this.config.watch.time} 定时增量扫描` : ''}`);
    if (watch) this.setConfig({ watch: { enabled: true, ...(time ? { time } : {}) } });
    this.emitTask(id);
    return id;
  }

  // ================= 定时监测更新（增量扫描） =================
  setTaskWatch(id, on) {
    if (!this.store.getTask(id)) throw new Error('任务不存在');
    this.store.updateTask(id, { watch: on ? 1 : 0 });
    if (on && !this.config.watch.enabled) this.setConfig({ watch: { enabled: true } });
    this.log.info(`[任务#${id}] ${on ? '开启' : '关闭'}定时监测更新`);
    this.emitTask(id, { quiet: true });
    return this.store.getTask(id);
  }

  /** 最近一次应执行的定时时间点（不晚于 now） */
  static lastSlot(time, now = Date.now()) {
    const [h, m] = String(time || '12:30').split(':').map((x) => Number(x) || 0);
    const d = new Date(now); d.setHours(h, m, 0, 0);
    if (d.getTime() > now) d.setDate(d.getDate() - 1);
    return d.getTime();
  }
  static nextSlot(time, now = Date.now()) { const s = AgentService.lastSlot(time, now); const d = new Date(s); d.setDate(d.getDate() + 1); return d.getTime(); }

  watchInfo() {
    const w = this.config.watch;
    const tasks = this.store.listTasks().filter((t) => t.watch);
    return { ...w, next: w.enabled ? AgentService.nextSlot(w.time) : null, tasks: tasks.map((t) => ({ id: t.id, name: t.name, dir: t.dir, status: t.status, last_watch_at: t.last_watch_at, watch_summary: t.watch_summary, finished_at: t.finished_at, neverRun: !t.run_started })) };
  }

  /** 每 30 秒检查一次是否到了定时扫描时间（由主进程启动；测试中可直接调用 checkSchedule） */
  startScheduler() {
    this.schedStart = Date.now();
    // 旧版本升级：已有解析结果但还没有页面标签 / 关联时，后台补算一次
    setTimeout(() => {
      try {
        const has = this.store.db.prepare('SELECT COUNT(*) n FROM slide_links').get().n;
        const pages = this.store.db.prepare(`SELECT COUNT(*) n FROM slides s JOIN files f ON f.id = s.file_id WHERE f.status = 'parsed'`).get().n;
        if (!has && pages > 1 && !this.running) this.computeRelations().catch((e) => this.log.warn('补算页面关联失败', e));
      } catch (e) { this.log.warn('检查页面关联失败', e); }
    }, 4000);
    clearInterval(this.schedTimer);
    this.schedTimer = setInterval(() => this.checkSchedule().catch((e) => this.log.warn('定时扫描检查失败', e)), 30000);
    setTimeout(() => this.checkSchedule().catch(() => {}), 15000);
    // 总览分析按每天 / 每周定期刷新统计
    clearInterval(this.statTimer);
    this.statTimer = setInterval(() => {
      const mode = this.config.analyticsRefresh;
      const period = { daily: 86400000, weekly: 7 * 86400000 }[mode];
      if (!period || this.running) return;
      const c = this.analyticsCache;
      if (!c || Date.now() - c.computedAt >= period) { try { this.analytics({ force: true }); this.log.info(`总览分析已按“${mode === 'daily' ? '每天' : '每周'}”定期刷新统计`); } catch (e) { this.log.warn('定期刷新统计失败', e); } }
    }, 10 * 60000);
  }

  async checkSchedule(now = Date.now()) {
    const w = this.config.watch;
    if (!w || !w.enabled) return false;
    const slot = AgentService.lastSlot(w.time, now);
    if (slot <= Math.max(w.lastRun || 0, w.since || 0)) return false;
    if (!w.catchUp && slot < (this.schedStart || 0)) return false;
    this.setConfig({ watch: { lastRun: now } });
    const missed = this.schedStart && slot < this.schedStart;
    this.runWatch(missed ? '补扫（错过的定时扫描）' : '定时增量扫描');
    return true;
  }

  /** 对所有开启监测的任务做增量扫描（排队执行）；从未手动开始过的任务不自动开始 */
  runWatch(reason = '手动增量扫描', ids = null) {
    const list = this.store.listTasks().filter((t) => t.watch && (!ids || ids.includes(t.id)));
    const started = [];
    for (const t of list) {
      if (!t.run_started) { this.log.info(`[任务#${t.id}] ${reason}：该任务还没有手动开始过首次解析，跳过`); continue; }
      if (this.running === t.id || this.queue.includes(t.id)) continue;
      this.startTask(t.id, { incremental: true, reason });
      started.push(t.id);
    }
    this.log.info(`${reason}：${started.length ? `已加入队列 ${started.map((x) => '#' + x).join(' ')}` : '没有需要扫描的任务'}`);
    return started;
  }

  addTask(dir, { autoStart = false } = {}) {
    dir = path.resolve(dir);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error('目录不存在：' + dir);
    const id = this.store.createTask(dir, path.basename(dir) || dir);
    this.store.updateTask(id, { status: autoStart ? 'pending' : 'draft' });
    this.log.info(`[任务#${id}] 已添加解析任务${autoStart ? '' : '（待手动开始）'}：${dir}`);
    if (autoStart) { this.queue.push(id); setImmediate(() => this.pump()); }
    this.emitTask(id);
    return id;
  }

  /** 对已解析过 / 重复的文件强制重新解析（用户确认后），作为一个新任务排队执行 */
  reparseFiles(paths, name) {
    const list = [...new Set(paths)].filter((p) => fs.existsSync(p));
    if (!list.length) throw new Error('没有可重新解析的文件（文件可能已被移动或删除）');
    const id = this.store.createTask(path.dirname(list[0]), name || `重新解析 ${list.length} 个文件`);
    this.store.updateTask(id, { roots: JSON.stringify({ files: list, force: true }) });
    this.log.info(`[任务#${id}] 用户选择重新解析 ${list.length} 个文件`);
    this.startTask(id);
    return id;
  }

  /** 全部解析历史（每个文件每次被处理的记录） */
  history({ limit = 5000, action, q, taskId } = {}) {
    return this.store.history({ limit, action, q, taskId });
  }

  /** 手动开始（或重新扫描）：加入队列，按顺序依次解析 */
  /** resume = true：从断点继续（复用上次扫描清单，跳过本轮已处理的文件）；否则重新扫描 */
  startTask(id, { resume = false, incremental = false, reason = '' } = {}) {
    const t = this.store.getTask(id);
    if (!t) throw new Error('任务不存在');
    if (this.running === id || this.queue.includes(id)) return id;
    this.cancelled.delete(id);
    this.pausing.delete(id);
    this.resumeFlags.set(id, !!(resume && t.run_started && t.scan_list));
    if (incremental) this.incrementalRuns.set(id, reason || '增量扫描'); else this.incrementalRuns.delete(id);
    this.store.updateTask(id, { status: 'pending', message: '' });
    this.queue.push(id);
    this.log.info(`[任务#${id}] 加入解析队列（第 ${this.queue.length} 位）`);
    this.emitTask(id);
    setImmediate(() => this.pump());
    return id;
  }

  rerunTask(id) { return this.startTask(id); }
  resumeTask(id) { return this.startTask(id, { resume: true }); }

  /** 中断正在运行或排队的任务（可继续） */
  pauseTask(id) {
    this.pausing.add(id);
    this.cancelled.add(id);
    const i = this.queue.indexOf(id);
    if (i >= 0) { this.queue.splice(i, 1); this.store.updateTask(id, { status: 'paused', message: '已暂停，可点击“继续”' }); this.emitTask(id); }
    else if (this.running === id) this.emitTask(id, { pausing: true, current: '正在暂停…（当前文件会在下次继续时重新解析）' });
    this.log.info(`[任务#${id}] 请求暂停`);
  }

  startAll() {
    const ids = this.store.listTasks().filter((t) => ['draft', 'interrupted', 'paused', 'cancelled', 'failed'].includes(t.status)).map((t) => t.id).reverse();
    for (const id of ids) { const t = this.store.getTask(id); this.startTask(id, { resume: ['interrupted', 'paused'].includes(t.status) }); }
    return ids.length;
  }

  /** 调整排队顺序 */
  moveTask(id, delta) {
    const i = this.queue.indexOf(id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= this.queue.length) return this.queue;
    [this.queue[i], this.queue[j]] = [this.queue[j], this.queue[i]];
    this.emitTask(id);
    return this.queue;
  }

  queueState() { return { running: this.running, queue: [...this.queue] }; }

  emitProgress(taskId, data) { this.emit('progress', { taskId, at: Date.now(), ...data }); }

  cancelTask(id) {
    this.cancelled.add(id);
    const i = this.queue.indexOf(id);
    if (i >= 0) { this.queue.splice(i, 1); this.store.updateTask(id, { status: 'cancelled' }); this.emitTask(id); }
    this.log.info(`[任务#${id}] 请求取消`);
  }

  deleteTask(id, removeFiles = false) {
    if (this.running === id) throw new Error('任务正在运行，请先取消');
    if (removeFiles) {
      for (const f of this.store.taskFiles(id)) if (f.id && f.task_id === id) this.store.deleteFile(f.id);
      this.afterLibraryChange();
    }
    this.store.deleteTask(id);
    this.log.info(`[任务#${id}] 已删除${removeFiles ? '（同时移除其解析的文件）' : ''}`);
  }

  async pump() {
    if (this.running || !this.queue.length) return;
    const id = this.queue.shift();
    this.running = id;
    try { await this.runTask(id); } catch (e) {
      this.log.error(`[任务#${id}] 任务异常终止`, e);
      this.store.updateTask(id, { status: 'failed', finished_at: Date.now(), message: e.message });
    } finally {
      this.running = null;
      this.emitTask(id);
      setImmediate(() => this.pump());
    }
  }

  emitTask(id, extra = {}) { this.emit('task', { ...(this.store.getTask(id) || { id }), ...extra }); }

  /** 异步扫描（不阻塞界面），按目录名顺序深度优先；跳过系统目录、符号链接、本工具数据目录 */
  async scan(roots, log, { onProgress, isCancelled, fullDisk = false } = {}) {
    const exts = this.enabledExts();
    const out = [];
    const self = path.resolve(this.dataDir).toLowerCase();
    let dirs = 0, last = Date.now();
    const stack = [...roots].reverse().map((r) => ({ d: r, depth: 0 }));
    while (stack.length) {
      if (isCancelled && isCancelled()) break;
      const { d, depth } = stack.pop();
      if (depth > 40 || path.resolve(d).toLowerCase() === self) continue;
      if (fullDisk && SKIP_ROOT_PATHS.some((p) => d === p || d.startsWith(p + '/'))) continue;
      let list;
      try { list = await fs.promises.readdir(d, { withFileTypes: true }); } catch (e) { if (!fullDisk) log.warn(`无法读取目录 ${d}：${e.code || e.message}`); continue; }
      dirs++;
      list.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
      const sub = [];
      for (const ent of list) {
        const p = path.join(d, ent.name);
        if (ent.isDirectory()) {
          if (ent.name.startsWith('.') || ent.name.startsWith('$') && fullDisk || SKIP_DIRS.has(ent.name.toLowerCase())) continue;
          sub.push({ d: p, depth: depth + 1 });
        } else if (ent.isFile()) {
          const ext = path.extname(ent.name).toLowerCase();
          if (!exts.has(ext)) continue;
          if (ent.name.startsWith('~$') || ent.name.startsWith('._')) { log.info(`忽略 Office 临时锁文件：${p}`); continue; }
          out.push(p);
        }
      }
      for (let i = sub.length - 1; i >= 0; i--) stack.push(sub[i]);
      if (Date.now() - last > 500) { last = Date.now(); if (onProgress) onProgress({ dirs, found: out.length, current: d }); await new Promise((r) => setImmediate(r)); }
    }
    return out;
  }

  async runTask(id) {
    const task = this.store.getTask(id);
    const tag = `[任务#${id}]`;
    const log = logger.child('task');
    const t0 = Date.now();
    const resume = this.resumeFlags.get(id) && task.run_started && task.scan_list;
    this.resumeFlags.delete(id);
    // 增量扫描：只解析新增与修改过的文档，原文件已删除的移入回收站（仅从资料库移除）
    const incremental = !resume ? this.incrementalRuns.get(id) : null;
    this.incrementalRuns.delete(id);
    const prevList = incremental && task.scan_list ? JSON.parse(task.scan_list) : null;
    if (resume) this.store.updateTask(id, { status: 'running', started_at: t0 });
    else this.store.updateTask(id, { status: 'running', started_at: t0, run_started: t0, scan_list: null, parsed: 0, skipped: 0, duplicate: 0, failed: 0 });
    let roots = null;
    try { roots = task.roots ? JSON.parse(task.roots) : null; } catch { roots = null; }
    const explicit = roots && !Array.isArray(roots) ? roots : null;
    if (explicit) roots = null;
    const fullDisk = !!roots;
    const engines = await this.office.detect();
    let files;
    if (resume) {
      files = JSON.parse(task.scan_list);
      log.info(`${tag} 从断点继续：沿用上次扫描清单 ${files.length} 个文档`);
    } else {
      log.info(`${tag} ${incremental ? `${incremental}：` : ''}开始扫描${fullDisk ? '本机全部磁盘 ' + roots.join(' ') : '目录 ' + task.dir}（类型：${[...this.enabledExts()].join(' ')}）`);
      files = explicit ? explicit.files.filter((f) => fs.existsSync(f)) : await this.scan(roots || [task.dir], log, {
        fullDisk, isCancelled: () => this.cancelled.has(id),
        onProgress: (p) => { this.emitTask(id, { current: `扫描中：已检查 ${p.dirs} 个目录，发现 ${p.found} 个文档 · ${p.current}`, done: 0 }); this.emitProgress(id, { stage: 'scanning', ...p }); },
      });
      if (!this.cancelled.has(id)) this.store.updateTask(id, { scan_list: JSON.stringify(files) });
    }
    this.store.updateTask(id, { total: files.length });
    const byKind = {};
    for (const f of files) { const k = KIND_OF.get(path.extname(f).toLowerCase()); byKind[k] = (byKind[k] || 0) + 1; }
    log.info(`${tag} 发现 ${files.length} 个文档（${Object.entries(byKind).map(([k, n]) => `${DOC_TYPES[k].label} ${n}`).join('，')}）`);
    this.emitProgress(id, { stage: 'scanned', total: files.length, byKind });
    this.emitTask(id);
    const prev = this.store.getTask(id);
    const counts = resume ? { parsed: prev.parsed || 0, skipped: prev.skipped || 0, duplicate: prev.duplicate || 0, failed: prev.failed || 0 } : { parsed: 0, skipped: 0, duplicate: 0, failed: 0 };
    const handled = resume ? this.store.handledSince(id, task.run_started) : new Set();
    if (resume) log.info(`${tag} 本轮已处理 ${handled.size} 个，剩余 ${files.filter((f) => !handled.has(f)).length} 个`);
    let changed = false;
    let stoppedAt = -1;
    const inc = { added: 0, updated: 0, removed: 0 };
    if (incremental && !this.cancelled.has(id)) {
      // 上次扫描到、这次没有且原文件已不存在的文档：移入回收站（仅从资料库移除，可还原）
      const now = new Set(files);
      const gone = [];
      for (const p of prevList || this.store.taskFiles(id).map((f) => f.link_path)) {
        if (now.has(p) || fs.existsSync(p)) continue;
        const f = this.store.fileByPath(p);
        if (f && ['parsed', 'duplicate'].includes(f.status) && !gone.includes(f.id)) gone.push(f.id);
      }
      if (gone.length) {
        const r = await this.recycleFiles(gone, { moveFile: false, reason: `${incremental}：原文件已删除或移走` });
        inc.removed = r.ok;
        for (const fid of gone) { const f = this.store.getFile(fid); if (f) this.store.linkTaskFile(id, fid, f.path, 'removed', '原文件已删除或移走，已移入回收站（仅从资料库移除）'); }
        log.info(`${tag} ${incremental}：${r.ok} 个文档的原文件已不存在，已移入回收站（仅从资料库移除，可还原）`);
      }
    }
    for (let i = 0; i < files.length; i++) {
      if (this.cancelled.has(id)) { stoppedAt = i; log.warn(`${tag} 已${this.pausing.has(id) ? '中断' : '取消'}，处理到第 ${i}/${files.length} 个文件`); break; }
      const file = files[i];
      if (handled.has(file)) continue;
      if (!fs.existsSync(file)) { counts.failed++; this.store.linkTaskFile(id, null, file, 'failed', '文件已不存在'); continue; }
      this.emitTask(id, { current: file, done: i });
      this.emitProgress(id, { stage: 'file', index: i + 1, total: files.length, file, counts: { ...counts } });
      try {
        const before = incremental ? this.store.fileByPath(file) : null;
        let r;
        try { r = await this.processFile(id, file, engines, log, tag, { force: !!(explicit && explicit.force), isCancelled: () => this.cancelled.has(id) }); } catch (e) {
          // 解析过程中暂停：放弃当前文件（不记入本轮已处理），继续时重新解析
          if (e && e.paused) { stoppedAt = i; log.warn(`${tag} 已暂停：当前文件 ${path.basename(file)} 未完成，继续时会重新解析`); break; }
          throw e;
        }
        counts[r]++;
        if (incremental && r === 'parsed') { if (before && before.status !== 'recycled') inc.updated++; else inc.added++; }
        if (r !== 'parsed') this.emitProgress(id, { stage: 'result', file, action: r, index: i + 1, total: files.length });
        if (r === 'parsed' || r === 'duplicate') changed = true;
      } catch (e) {
        counts.failed++;
        log.error(`${tag} 处理失败 ${file}`, e);
      }
      this.store.updateTask(id, counts);
      await new Promise((r) => setImmediate(r));
    }
    if (changed) {
      this.emitTask(id, { current: '正在计算标签、相似分组与黑白底对应关系…', done: files.length });
      await this.afterLibraryChange(log, tag, id);
    }
    const cancelled = this.cancelled.delete(id);
    const paused = this.pausing.delete(id);
    const ms = Date.now() - t0;
    let msg = `解析 ${counts.parsed}，已解析过跳过 ${counts.skipped}，重复文件 ${counts.duplicate}，失败 ${counts.failed}，耗时 ${(ms / 1000).toFixed(1)}s`;
    if (incremental) msg = `${incremental}：新增 ${inc.added}，更新 ${inc.updated}，移除 ${inc.removed}；` + msg;
    if (cancelled && stoppedAt >= 0) msg = `${paused ? '已暂停' : '已中断'}（处理到 ${stoppedAt}/${files.length}），可点击“继续”从断点继续；` + msg;
    this.store.updateTask(id, { status: cancelled ? (paused || stoppedAt >= 0 ? 'paused' : 'cancelled') : 'done', finished_at: Date.now(), message: msg,
      ...(incremental && !cancelled ? { last_watch_at: Date.now(), watch_summary: JSON.stringify({ ...inc, total: files.length, at: Date.now(), reason: incremental }) } : {}) });
    log.info(`${tag} 任务结束：${msg}`);
    this.emitProgress(id, { stage: 'done', message: msg, counts: { ...counts }, total: files.length, inc: incremental ? inc : null });
    if (incremental && !cancelled) this.emit('watch', { taskId: id, name: task.name, ...inc, reason: incremental });
    if (changed && this.config.embedding.provider !== 'none') this.buildEmbeddings().catch((e) => log.warn('语义向量生成失败', e));
  }

  fingerprint(name, size, mtime, author) {
    return crypto.createHash('sha1').update(`${name}|${size}|${Math.floor(mtime / 1000)}|${author || ''}`).digest('hex');
  }

  async processFile(taskId, file, engines, log, tag, { force = false, isCancelled = () => false } = {}) {
    const checkPause = () => { if (isCancelled()) { const e = new Error('已暂停'); e.paused = true; throw e; } };
    const st = fs.statSync(file);
    const name = path.basename(file), ext = path.extname(file).toLowerCase();
    const kind = KIND_OF.get(ext) || 'ppt';
    const unit = kind === 'word' ? '节' : '页';
    let author = '', title = '';
    // 快速跳过：路径、大小、修改时间都没变的已解析文件不再打开读取（增量扫描大量文件时更快）
    const known = !force ? this.store.fileByPath(file) : null;
    // 用户移入回收站（移出资料库）的文档：重新扫描时不再自动加回，可在回收站还原
    if (known && known.status === 'recycled') {
      this.store.linkTaskFile(taskId, known.id, file, 'skipped', '该文档在回收站中（已移出资料库），不自动重新解析；可在回收站还原');
      return 'skipped';
    }
    if (known && (known.status === 'parsed' || known.status === 'duplicate') && known.size === st.size && known.mtime === Math.round(st.mtimeMs) && known.fingerprint) {
      this.store.linkTaskFile(taskId, known.id, file, 'skipped', `已解析过（${new Date(known.parsed_at).toLocaleString('zh-CN')}），文件未变化`);
      return 'skipped';
    }
    if (!LEGACY.has(ext)) {
      try { const p = await quickProps(file); author = p.author; title = p.title; } catch (e) {
        const id = this.store.upsertFile({ path: file, dir: path.dirname(file), name, ext, size: st.size, mtime: Math.round(st.mtimeMs), status: 'failed', kind, error: `文件损坏或不是有效的 ${kind === 'word' ? 'DOCX' : 'PPTX'}：` + e.message, task_id: taskId, parsed_at: Date.now() });
        this.store.linkTaskFile(taskId, id, file, 'failed', '文件损坏或格式无效');
        log.warn(`${tag} 文件损坏或格式无效：${file}（${e.message}）`);
        return 'failed';
      }
    }
    const fp = this.fingerprint(name, st.size, st.mtimeMs, author);
    const existing = this.store.fileByPath(file);
    if (force) log.info(`${tag} 用户确认重新解析：${file}`);
    if (!force && existing && existing.fingerprint === fp && (existing.status === 'parsed' || existing.status === 'duplicate')) {
      const when = new Date(existing.parsed_at).toLocaleString('zh-CN');
      this.store.linkTaskFile(taskId, existing.id, file, 'skipped', `已解析过（${when}），文件名/修改时间/大小/作者均未变化`);
      log.info(`${tag} 已解析过，跳过：${file}`);
      return 'skipped';
    }
    const same = this.store.fileByFingerprint(fp);
    if (!force && same && same.path !== file && fs.existsSync(same.path)) {
      const id = this.store.upsertFile({ path: file, dir: path.dirname(file), name, ext, size: st.size, mtime: Math.round(st.mtimeMs), author, title, fingerprint: fp,
        status: 'duplicate', kind, dup_of: same.id, error: null, slide_count: same.slide_count, theme: same.theme, tags: same.tags, category: same.category, task_id: taskId, parsed_at: Date.now() });
      if (existing) this.store.deleteSlidesOf(existing.id);
      this.store.linkTaskFile(taskId, id, file, 'duplicate', `与已解析文件信息完全一致：${same.path}`);
      log.info(`${tag} 与已解析文件一致，不重复解析：${file} == ${same.path}`);
      return 'duplicate';
    }
    // 完整解析
    const t0 = Date.now();
    let src = file;
    if (LEGACY.has(ext)) {
      log.info(`${tag} 旧版格式，转换为 ${kind === 'word' ? 'DOCX' : 'PPTX'}：${file}`);
      const out = path.join(this.cacheDir, 'converted', crypto.createHash('sha1').update(file).digest('hex').slice(0, 12));
      try {
        src = kind === 'word' ? await this.office.convertDoc(file, out) : await this.office.convertPpt(file, out);
      } catch (e) {
        const id = this.store.upsertFile({ path: file, dir: path.dirname(file), name, ext, kind, size: st.size, mtime: Math.round(st.mtimeMs), status: 'failed', error: e.message, task_id: taskId, parsed_at: Date.now() });
        this.store.linkTaskFile(taskId, id, file, 'failed', e.message);
        log.warn(`${tag} 旧版格式转换失败：${file}（${e.message}）`);
        return 'failed';
      }
    }
    // 截图 / 图片缓存按“路径 + 大小 + 修改时间”区分版本：文件修改或重新生成后不会显示旧截图
    const mediaKey = crypto.createHash('sha1').update(`${file}|${st.size}|${Math.round(st.mtimeMs)}`).digest('hex').slice(0, 16);
    // 页面截图（PowerPoint / LibreOffice，可选）：先于逐页解析生成，解析动态即可展示真实页面
    let preview = null;
    if (kind === 'ppt' && this.config.thumbnails !== 'off') {
      try {
        checkPause();
        this.emitProgress(taskId, { stage: 'thumb', file });
        preview = await this.office.thumbnails(src, path.join(this.thumbDir, mediaKey), mediaKey, this.config.thumbnails, this.config.thumbWidth);
        if (preview) log.info(`${tag} 页面截图(${preview.engine})：${preview.images ? preview.images.length + ' 页' : 'PDF'} ${name}`);
      } catch (e) { if (e && e.paused) throw e; log.warn(`${tag} 生成截图失败 ${name}`, e); }
    }
    const thumbOf = (i) => (preview && preview.images && preview.images[i - 1]) || null;
    // 逐页进度：附带真实截图、页面版式、文字、讲解词与生成的 Markdown，用于“解析动态”实时展示
    const onSlide = (i, n, t, sl) => checkPause() || this.emitProgress(taskId, {
      stage: 'slide', file, slide: i, slideTotal: n, slideTitle: t, unit, kind,
      detail: sl ? { theme: sl.theme, bg: sl.bg, layout: sl.layout || null, thumb: thumbOf(i), text: String(sl.text || '').slice(0, 2000), notes: String(sl.notes || '').slice(0, 800), md: slideToMd(sl, kind).slice(0, 6000), media: (sl.media || []).map((m) => ({ type: m.type, name: m.name, subtitles: (m.subtitles || []).length })) } : null,
    });
    this.emitProgress(taskId, { stage: 'parse', file, kind });
    let parsed;
    try {
      parsed = kind === 'word' ? await parseDocx(src, { mediaDir: this.mediaDir, mediaKey, log, onSlide })
        : await parsePptx(src, { mediaDir: this.mediaDir, mediaKey, log, onSlide, ffmpeg: engines.ffmpeg ? this.office.ffmpegExtractor(this.cacheDir) : null });
    } catch (e) {
      if (e && e.paused) throw e;
      const id = this.store.upsertFile({ path: file, dir: path.dirname(file), name, ext, size: st.size, mtime: Math.round(st.mtimeMs), author, kind, fingerprint: null, status: 'failed', error: e.message, task_id: taskId, parsed_at: Date.now() });
      this.store.linkTaskFile(taskId, id, file, 'failed', e.message);
      log.warn(`${tag} 解析失败：${file}（${e.message}）`);
      return 'failed';
    }
    if (LEGACY.has(ext)) { author = parsed.props.author; title = parsed.props.title; }
    const slides = parsed.slides;

    for (const s of slides) {
      s.md = slideToMd(s, kind);
      s.kw = slideKeywords(s);
      s.vec = hashVector(`${s.title}\n${s.title}\n${s.text}\n${s.notes}`);
      if (preview && preview.images && preview.images[s.index - 1]) {
        s.thumb = preview.images[s.index - 1];
        // 用真实渲染图的边缘亮度校正黑白底判断
        try {
          const lum = await borderLuminance(path.join(this.thumbDir, s.thumb));
          if (lum !== null) { s.bg = { ...s.bg, renderLum: Math.round(lum * 1000) / 1000 }; s.theme = lum < 0.3 ? 'dark' : 'light'; }
        } catch { /* ignore */ }
      }
    }
    const dark = slides.filter((s) => s.theme === 'dark').length;
    const allText = slides.map((s) => `${s.title}\n${s.text}\n${s.notes}`).join('\n');
    const fileRow = {
      path: file, dir: path.dirname(file), name, ext, size: st.size, mtime: Math.round(st.mtimeMs), atime_pre: Math.round(st.atimeMs), ctime: Math.round(st.birthtimeMs || st.ctimeMs), author, title: title || (slides[0] && slides[0].title) || '',
      fingerprint: fp, status: 'parsed', kind, error: null, dup_of: null, slide_count: slides.length,
      theme: !slides.length ? 'light' : dark === 0 ? 'light' : dark === slides.length ? 'dark' : (dark / slides.length >= 0.6 ? 'dark' : dark / slides.length <= 0.4 ? 'light' : 'mixed'),
      dark_slides: dark, light_slides: slides.length - dark,
      video_count: slides.reduce((a, s) => a + s.media.filter((m) => m.type === 'video').length, 0),
      notes_count: slides.filter((s) => s.notes).length,
      lang: detectLang(allText), preview,
      meta: { mediaKey, props: parsed.props, slideSize: parsed.size, legacy: LEGACY.has(ext), convertedFrom: LEGACY.has(ext) ? src : undefined, errors: slides.flatMap((s) => (s.errors || []).map((e) => `第${s.index}${unit} ${e}`)).slice(0, 50) },
      task_id: taskId, parsed_at: Date.now(),
    };
    const info = fileTerms(fileRow, slides);
    fileRow.terms = info;
    fileRow.vec = mean([...slides.map((s) => s.vec), hashVector(name.replace(/\.[^.]+$/, ''))]) || hashVector(name);
    const metaTokens = tokenize(`${name} ${path.basename(path.dirname(file))}`).join(' ');
    let fileId;
    checkPause();
    this.emitProgress(taskId, { stage: 'store', file, slides: slides.length });
    // 旧版本的截图与图片缓存不再使用，清理掉
    if (existing) {
      const oldKey = (existing.meta && existing.meta.mediaKey) || crypto.createHash('sha1').update(file).digest('hex').slice(0, 16);
      if (oldKey !== mediaKey) for (const d of [this.thumbDir, this.mediaDir]) { try { fs.rmSync(path.join(d, oldKey), { recursive: true, force: true }); } catch { /* ignore */ } }
    }
    this.store.tx(() => {
      if (existing) this.store.deleteSlidesOf(existing.id);
      fileId = this.store.upsertFile(fileRow);
      for (const s of slides) {
        this.store.insertSlide(fileId, s, { title: tokenize(s.title).join(' '), body: tokenize(s.text).join(' '), notes: tokenize(s.notes).join(' '), meta: metaTokens });
      }
    });
    // Markdown 文件（按源目录结构镜像保存）
    try {
      const rel = file.replace(/^[a-zA-Z]:/, (m) => m[0]).replace(/^[\\/]+/, '');
      const mdPath = path.join(this.mdDir, rel + '.md');
      fs.mkdirSync(path.dirname(mdPath), { recursive: true });
      fs.writeFileSync(mdPath, docToMd({ ...fileRow, tags: [] }, slides));
      this.store.updateFile(fileId, { md_path: mdPath });
    } catch (e) { log.warn(`${tag} 写入 Markdown 失败`, e); }
    this.emitProgress(taskId, { stage: 'parsed', file, kind, slides: slides.length, unit, dark, notes: fileRow.notes_count, videos: fileRow.video_count, ms: Date.now() - t0, titles: slides.slice(0, 40).map((x) => x.title) });
    if (kind === 'word') {
      this.store.linkTaskFile(taskId, fileId, file, 'parsed', `Word：${slides.length} 节，${fileRow.notes_count} 节含批注，耗时 ${Date.now() - t0}ms`);
      log.info(`${tag} 解析完成：${file}（Word，${slides.length} 节，${Date.now() - t0}ms）`);
    } else {
      this.store.linkTaskFile(taskId, fileId, file, 'parsed', `${slides.length} 页，${fileRow.notes_count} 页含备注，${fileRow.video_count} 个视频，耗时 ${Date.now() - t0}ms`);
      log.info(`${tag} 解析完成：${file}（${slides.length} 页，黑底 ${dark}/白底 ${slides.length - dark}，视频 ${fileRow.video_count}，${Date.now() - t0}ms）`);
    }
    return 'parsed';
  }

  /** 资料库变化后：重算标签/分类、相似分组、黑白底对应 */
  async afterLibraryChange(log = this.log, tag = '', taskId = null) {
    const t0 = Date.now();
    const files = this.store.listFiles({ status: 'parsed' });
    const termRows = this.store.fileTerms();
    const df = new Map();
    for (const r of termRows) for (const t of Object.keys((r.terms && r.terms.terms) || {})) df.set(t, (df.get(t) || 0) + 1);
    const client = this.config.llm.enabled && this.config.llm.useForTags ? llm.client(this.config.llm) : null;
    const termMap = new Map(termRows.map((r) => [r.id, r.terms || { terms: {}, concepts: {} }]));
    for (const f of files) {
      const slides = this.store.slidesOf(f.id);
      let llmTags = (f.meta && f.meta.llmTags) || [];
      if (client && !llmTags.length) {
        try {
          llmTags = await client.tags(f.title || f.name, slides.map((s) => `${s.title}\n${s.text}`).join('\n'));
          this.store.updateFile(f.id, { meta: { ...f.meta, llmTags } });
        } catch (e) { log.warn(`大模型打标签失败 ${f.name}`, e); }
      }
      const { tags, category } = computeTags(f, slides, termMap.get(f.id) || { terms: {}, concepts: {} }, df, files.length, llmTags);
      this.store.updateFile(f.id, { tags, category });
      if (taskId && f.task_id === taskId) this.emitProgress(taskId, { stage: 'tag', file: f.path, tags, category });
    }
    for (const d of this.store.listFiles({ status: 'duplicate' })) {
      const o = d.dup_of && this.store.getFile(d.dup_of);
      if (o) this.store.updateFile(d.id, { tags: o.tags, category: o.category, theme: o.theme, slide_count: o.slide_count });
    }
    log.info(`${tag} 已为 ${files.length} 个文件生成标签与分类（${Date.now() - t0}ms）`);
    const t1 = Date.now();
    const groups = this.computeGroupsNow();
    const slideVecs = this.store.slideVectors();
    const pairs = computePairs(slideVecs, groups);
    this.store.replacePairs(pairs);
    log.info(`${tag} 相似分组 ${groups.length} 组，黑白底对应页 ${pairs.length} 对（${Date.now() - t1}ms）`);
    await this.computeRelations(log, tag, taskId);
    this.search.invalidate();
  }

  /** 页面级标签（每页 8 个）+ 页面相互关联（相似 PPT 页；同时选择 Word 时关联 Word 章节与 PPT 页） */
  async computeRelations(log = this.log, tag = '', taskId = null) {
    const t0 = Date.now();
    const rows = this.store.relationRows();
    let fresh = 0;
    for (let i = 0; i < rows.length; i++) {
      if (!rows[i].kw) { rows[i].kw = slideKeywords(rows[i]); rows[i].newKw = true; fresh++; if (fresh % 200 === 0) await new Promise((r) => setImmediate(r)); }
    }
    const df = new Map();
    for (const r of rows) for (const t of Object.keys(r.kw.t || {})) df.set(t, (df.get(t) || 0) + 1);
    const changed = [];
    for (const r of rows) {
      const tags = pageTags(r.kw, df, rows.length);
      if (r.newKw || JSON.stringify(tags) !== JSON.stringify(r.tags)) changed.push({ id: r.id, kw: r.newKw ? r.kw : null, tags });
      r.tags = tags;
    }
    if (changed.length) this.store.setSlideKwTags(changed);
    const types = this.config.docTypes || ['ppt'];
    const withWord = types.includes('ppt') && types.includes('word');
    const links = computeLinks(rows, { withWord });
    this.store.replaceLinks(links);
    const nPpt = links.filter((l) => l.kind === 'ppt').length, nWord = links.length - nPpt;
    const pages = new Set(links.map((l) => l.a)).size;
    log.info(`${tag} 页面标签 ${rows.length} 页（更新 ${changed.length}）；页面关联：${pages} 页有推荐，相似 PPT 页 ${nPpt} 条${withWord ? `，Word ↔ PPT ${nWord} 条` : '（未同时选择 Word，不关联 Word 内容）'}（${Date.now() - t0}ms）`);
    if (taskId) this.emitProgress(taskId, { stage: 'relate', pages: rows.length, linked: pages, ppt: nPpt, word: nWord, withWord });
    return { pages: rows.length, linked: pages, ppt: nPpt, word: nWord, withWord };
  }

  /** 某页的相关推荐：相似 PPT 页 + 相关 Word 内容（或 Word 章节的相关 PPT 页） */
  related(slideId) {
    const s = this.store.getSlide(slideId, false);
    if (!s) return null;
    const links = this.store.linksOf(slideId);
    const others = new Map(this.store.getSlides(links.map((l) => l.other_id)).map((x) => [x.id, x]));
    const files = new Map();
    const fileOf = (id) => { if (!files.has(id)) files.set(id, this.store.getFile(id)); return files.get(id); };
    const items = [];
    for (const l of links) {
      const o = others.get(l.other_id);
      const f = o && fileOf(o.file_id);
      if (!f || f.status !== 'parsed') continue;
      items.push({ ...o, kind: f.kind || 'ppt', fileName: f.name, filePath: f.path, fileTheme: f.theme, score: l.score, reasons: l.reasons, linkKind: l.kind });
    }
    const types = this.config.docTypes || ['ppt'];
    const own = fileOf(s.file_id);
    return { tags: s.tags || [], kind: (own && own.kind) || 'ppt', withWord: types.includes('ppt') && types.includes('word'), ppt: items.filter((x) => x.linkKind === 'ppt'), word: items.filter((x) => x.linkKind === 'word') };
  }

  computeGroupsNow() {
    const files = [...this.store.listFiles({ status: 'parsed' }), ...this.store.listFiles({ status: 'duplicate' })];
    const vecs = new Map(this.store.fileVectors().map((v) => [v.id, v.vec]));
    const titles = new Map();
    for (const v of this.store.slideVectors()) {
      if (!titles.has(v.file_id)) titles.set(v.file_id, new Set());
      const t = normSlideTitle(v.title);
      if (t) titles.get(v.file_id).add(t);
    }
    this.groupsCache = computeGroups(files, vecs, titles, { threshold: this.config.similarityThreshold });
    return this.groupsCache;
  }

  async buildEmbeddings(force = false) {
    const emb = embedder(this.config.embedding);
    if (!emb) throw new Error('未配置语义向量模型');
    const rows = this.store.db.prepare(`SELECT s.id, s.title, s.text, s.notes FROM slides s ${force ? '' : 'WHERE s.emb IS NULL'}`).all();
    this.log.info(`开始生成语义向量（${emb.id}），共 ${rows.length} 页`);
    for (let i = 0; i < rows.length; i += 32) {
      const batch = rows.slice(i, i + 32);
      const vecs = await emb.embed(batch.map((r) => `${r.title}\n${r.text}\n${r.notes}`.slice(0, 4000)));
      this.store.tx(() => batch.forEach((r, k) => this.store.setSlideEmb(r.id, vecs[k])));
      this.emit('embedding', { done: Math.min(rows.length, i + 32), total: rows.length });
    }
    this.search.invalidate();
    this.log.info(`语义向量生成完成，共 ${rows.length} 页`);
    return rows.length;
  }

  // ================= 查询接口 =================
  tasks() { return this.store.listTasks().map((t) => ({ ...t, running: this.running === t.id, queued: this.queue.includes(t.id), queuePos: this.queue.indexOf(t.id) + 1 })); }

  taskDetail(id) {
    const task = this.store.getTask(id);
    if (!task) return null;
    const files = this.store.taskFiles(id);
    const parsedIds = [...new Set(files.filter((f) => f.id && (f.status === 'parsed')).map((f) => f.id))];
    const st = { files: files.length, parsed: 0, skipped: 0, duplicate: 0, failed: 0, slides: 0, notes: 0, videos: 0, dark: 0, light: 0, size: 0, hidden: 0, subtitles: 0, byExt: {}, byCategory: {} };
    for (const f of files) {
      st[f.action] = (st[f.action] || 0) + 1;
      st.size += f.size || 0;
      st.byExt[f.ext || path.extname(f.link_path)] = (st.byExt[f.ext || path.extname(f.link_path)] || 0) + 1;
      if (f.status === 'parsed') st.byCategory[f.category || '其他'] = (st.byCategory[f.category || '其他'] || 0) + 1;
    }
    for (const fid of parsedIds) {
      const f = this.store.getFile(fid);
      st.slides += f.slide_count; st.notes += f.notes_count; st.videos += f.video_count; st.dark += f.dark_slides; st.light += f.light_slides;
    }
    const agg = parsedIds.length ? this.store.db.prepare(`SELECT SUM(hidden) h, SUM(CASE WHEN media LIKE '%"cues"%' THEN 1 ELSE 0 END) s FROM slides WHERE file_id IN (${parsedIds.join(',')})`).get() : { h: 0, s: 0 };
    st.hidden = agg.h || 0; st.subtitles = agg.s || 0;
    return { task: { ...task, running: this.running === id }, files, stats: st };
  }

  /** 任务范围内的文件 id（含重复文件所指向的原文件，用于检索与关联） */
  taskFileIds(taskId) {
    const ids = new Set();
    for (const f of this.store.taskFiles(taskId)) {
      if (!f.id || f.status === 'recycled') continue;
      ids.add(f.id);
      if (f.status === 'duplicate' && f.dup_of) ids.add(f.dup_of);
    }
    return ids;
  }
  /** 资料库文件；taskId：只返回该任务解析到的文件 */
  library({ taskId } = {}) {
    const all = this.store.listFiles().filter((f) => f.status !== 'recycled');
    if (!taskId) return all;
    const own = new Set(this.store.taskFiles(taskId).map((f) => f.id).filter(Boolean));
    return all.filter((f) => own.has(f.id));
  }

  fileDetail(id, { record = true } = {}) {
    const f = this.store.getFile(id);
    if (!f) return null;
    if (record) this.recordView(f.status === 'duplicate' && f.dup_of ? f.dup_of : f.id, 'view');
    const target = f.status === 'duplicate' && f.dup_of ? this.store.getFile(f.dup_of) : f;
    const slides = this.store.slidesOf(target.id);
    const cp = this.store.counterparts(slides.map((s) => s.id));
    return { file: f, source: target, slides: slides.map((s) => ({ ...s, counterpart: cp.get(s.id) || null })) };
  }

  slideDetail(id) {
    const s = this.store.getSlide(id, true);
    if (!s) return null;
    const f = this.store.getFile(s.file_id);
    const cp = this.store.counterparts([id]).get(id);
    let counterpart = null;
    if (cp) { const o = this.store.getSlide(cp.id, false); const of = o && this.store.getFile(o.file_id); counterpart = o ? { id: o.id, idx: o.idx, theme: o.theme, title: o.title, fileName: of ? of.name : '', fileId: o.file_id, score: cp.score } : null; }
    return { ...s, file: f, counterpart };
  }

  categories({ taskId } = {}) {
    let files = this.store.listFiles({ status: 'parsed' });
    if (taskId) { const own = this.taskFileIds(taskId); files = files.filter((f) => own.has(f.id)); }
    const cats = {};
    const tagCount = {};
    for (const f of files) {
      (cats[f.category || '其他'] = cats[f.category || '其他'] || []).push(f);
      for (const t of f.tags || []) tagCount[t] = (tagCount[t] || 0) + 1;
    }
    const isAttr = (t) => /^(白底|黑底|黑白混合|含视频|含字幕|含表格|含图表|含讲解词|全页讲解词|含批注|Word文档|中文|英文|中英双语|大文件|\d+[页节]以内|\d+-\d+[页节]|\d+[页节]以上)$|^目录:/.test(t);
    const tags = Object.entries(tagCount).sort((a, b) => b[1] - a[1]).slice(0, 400).map(([tag, n]) => ({ tag, n, attr: isAttr(tag) }));
    return { categories: Object.entries(cats).map(([name, list]) => ({ name, files: list })).sort((a, b) => b.files.length - a.files.length), tags };
  }

  groups({ sort = 'name', order = 'asc', taskId } = {}) {
    let groups = this.groupsCache || this.computeGroupsNow();
    if (taskId) {
      const own = new Set(this.store.taskFiles(taskId).map((f) => f.id).filter(Boolean));
      groups = groups.map((g) => ({ ...g, members: g.members.filter((m) => own.has(m.file.id)) })).filter((g) => g.members.length > 1)
        .map((g) => ({ ...g, totalSize: g.members.reduce((a, m) => a + (m.file.size || 0), 0) }));
    }
    const dir = order === 'desc' ? -1 : 1;
    const key = (m) => (sort === 'size' ? m.file.size : m.file.name);
    const cmp = (a, b) => (sort === 'size' ? (a - b) : String(a).localeCompare(String(b), 'zh')) * dir;
    const out = groups.map((g) => ({ ...g, members: [...g.members].sort((a, b) => cmp(key(a), key(b))) }));
    out.sort((a, b) => (sort === 'size' ? cmp(a.totalSize, b.totalSize) : cmp(a.title, b.title)));
    return out;
  }

  async searchQuery(q, opts = {}) {
    const useLlm = opts.useLlm !== false && this.config.llm.enabled && this.config.llm.useForQuery;
    const fileIds = opts.taskId ? [...this.taskFileIds(opts.taskId)] : null;
    const r = await this.search.search(q, { ...opts, useLlm, fileIds });
    logger.child('search').info(`检索「${q}」：中文词 ${r.analysis.zh.slice(0, 8).join('/')}；英文词 ${r.analysis.en.slice(0, 8).join('/')}；文件 ${r.files.length}，页面 白底 ${r.slides.light.length} / 黑底 ${r.slides.dark.length} / Word ${r.slides.word.length}，召回 ${r.retrievers.join(' ')}，${r.timing.total}ms`);
    return r;
  }

  async ragAnswer(q, ids) { return this.search.answer(q, ids); }

  /** sels: [{slideId}] → 导出 PPTX */
  async exportSlides(slideIds, outPath, opts = {}) {
    let slides = this.store.getSlides(slideIds);
    const sels = [];
    const isMd = /\.md$/i.test(outPath);
    const wordCount = slides.filter((s) => (this.store.getFile(s.file_id) || {}).kind === 'word').length;
    if (!isMd && wordCount) {
      slides = slides.filter((s) => (this.store.getFile(s.file_id) || {}).kind !== 'word');
      if (!slides.length) throw new Error('所选内容都是 Word 文档的章节，只能导出为 Markdown');
    }
    for (const s of slides) {
      const f = this.store.getFile(s.file_id);
      let src = f.path;
      if (f.meta && f.meta.legacy && f.meta.convertedFrom && fs.existsSync(f.meta.convertedFrom)) src = f.meta.convertedFrom;
      if (!fs.existsSync(src)) throw new Error(`源文件不存在（可能已移动或删除）：${f.path}`);
      sels.push({ path: src, idx: s.idx });
    }
    if (/\.md$/i.test(outPath)) {
      return exportMarkdown(slides.map((s) => ({ md: s.md, idx: s.idx, filePath: (this.store.getFile(s.file_id) || {}).path })), outPath, opts.title);
    }
    const r = await exportPptx(sels, outPath, { ...opts, log: logger.child('export') });
    return { ...r, skippedWord: wordCount };
  }

  /**
   * 黑白底互转：items = [{slideId, dir: 'auto'|'toLight'|'toDark'}]，导出合并后改写配色，并生成转换后预览
   */
  async convertSlides(items, outPath) {
    const log = logger.child('convert');
    const sels = [], dirs = [];
    for (const it of items) {
      const s = this.store.getSlide(it.slideId, false);
      if (!s) continue;
      const f = this.store.getFile(s.file_id);
      if (!f || f.kind === 'word') continue;
      let src = f.path;
      if (f.meta && f.meta.legacy && f.meta.convertedFrom && fs.existsSync(f.meta.convertedFrom)) src = f.meta.convertedFrom;
      if (!fs.existsSync(src)) throw new Error(`源文件不存在：${f.path}`);
      const dir = it.dir === 'keep' ? null : it.dir === 'toLight' || it.dir === 'toDark' ? it.dir : (s.theme === 'dark' ? 'toLight' : 'toDark');
      sels.push({ path: src, idx: s.idx, ns: dir || 'keep' });
      dirs.push(dir);
    }
    if (!sels.length) throw new Error('转换队列中没有可转换的 PPT 页面');
    log.info(`开始黑白底互转：${sels.length} 页（黑→白 ${dirs.filter((d) => d === 'toLight').length}，白→黑 ${dirs.filter((d) => d === 'toDark').length}）`);
    const tmp = path.join(this.cacheDir, 'convert', `merge-${Date.now()}.pptx`);
    fs.mkdirSync(path.dirname(tmp), { recursive: true });
    await exportPptx(sels, tmp, { log });
    const r = await convertTheme(tmp, outPath, dirs, { log, rules: this.getConvertRules() });
    fs.rmSync(tmp, { force: true });
    // 转换后预览：解析输出文件；有 PowerPoint/LibreOffice 时生成真实截图
    const key = 'conv-' + crypto.createHash('sha1').update(outPath + Date.now()).digest('hex').slice(0, 10);
    const back = await parsePptx(outPath, { mediaDir: this.mediaDir, mediaKey: key, log });
    let thumbs = null;
    if (this.config.thumbnails !== 'off') {
      try { thumbs = await this.office.thumbnails(outPath, path.join(this.thumbDir, key), key, this.config.thumbnails, 960); } catch (e) { log.warn('转换结果截图失败', e); }
    }
    const preview = back.slides.map((s, i) => ({ id: `${key}-${i}`, idx: s.index, title: s.title, theme: s.theme, bg: s.bg, layout: s.layout, text: s.text, dir: dirs[i], thumb: thumbs && thumbs.images ? thumbs.images[i] : null }));
    // 转换结果加入资料库（“黑白底转换结果”任务），便于用逐页浏览窗口查看、检索与再次导出
    let imported = null;
    try { imported = await this.importOutput(outPath, '黑白底转换结果'); } catch (e) { log.warn('转换结果加入资料库失败', e); }
    // 转换校验：逐页检查转换后的底色是否为目标底色（有截图时按真实渲染判断）
    const got = imported ? this.store.getSlides(imported.slideIds) : [];
    const checks = dirs.map((d, i) => {
      const p = preview[i] || {};
      const theme = (got[i] && got[i].theme) || p.theme;
      const want = d === 'toLight' ? 'light' : d === 'toDark' ? 'dark' : null;
      return { idx: i + 1, want, theme, ok: !want || theme === want };
    });
    const verify = { total: checks.filter((c) => c.want).length, ok: checks.filter((c) => c.want && c.ok).length, failed: checks.filter((c) => !c.ok) };
    for (let i = 0; i < preview.length; i++) if (checks[i]) preview[i].check = checks[i];
    if (verify.failed.length) log.warn(`转换校验：${verify.failed.length} 页未达到目标底色（第 ${verify.failed.map((c) => c.idx).join('、')} 页），可能含整页图片、图表图片或文字在图片中`);
    else log.info(`转换校验：${verify.ok}/${verify.total} 页已转换为目标底色`);
    return { ...r, preview, verify, size: fs.statSync(outPath).size, fileId: imported && imported.fileId, slideIds: imported ? imported.slideIds : [] };
  }

  /** 把本工具生成的文件（转换结果等）解析进资料库，归入同名的固定任务 */
  async importOutput(file, taskName) {
    let task = this.store.listTasks().find((t) => t.name === taskName && t.dir === '（本工具生成）');
    const id = task ? task.id : this.store.createTask('（本工具生成）', taskName);
    const log = logger.child('task');
    const engines = await this.office.detect();
    const r = await this.processFile(id, file, engines, log, `[任务#${id}]`, { force: true });
    const counts = this.store.db.prepare("SELECT SUM(action = 'parsed') p, SUM(action = 'failed') f FROM task_files WHERE task_id = ?").get(id);
    this.store.updateTask(id, { status: 'done', total: (counts.p || 0) + (counts.f || 0), parsed: counts.p || 0, failed: counts.f || 0, finished_at: Date.now(), message: `本工具生成的文件，共 ${counts.p || 0} 个` });
    await this.afterLibraryChange(log, '', id);
    this.emitTask(id);
    const f = this.store.fileByPath(file);
    return r === 'parsed' && f ? { fileId: f.id, slideIds: this.store.slidesOf(f.id).map((x) => x.id) } : null;
  }

  /**
   * 智能生成：按描述匹配候选页面并聚类。返回 rows：每行一种不同内容，items[0] 为代表页，其余为相似页。
   * opts: { threshold = 0.75, theme = 'any' | 'light' | 'dark', maxRows = 30, maxPerRow = 12 }
   */
  async smartCandidates(desc, opts = {}) {
    const t0 = Date.now();
    const threshold = Number(opts.threshold) || 0.75;
    const intent = gen.parseIntent(desc);
    const fileMap = new Map(this.store.listFiles({ status: 'parsed' }).map((f) => [f.id, f]));
    const vecs = new Map(this.store.slideVectors().filter((v) => v.kind !== 'word').map((v) => [v.id, v]));
    const pool = new Map();
    let analysis = null;
    if (intent.topic || !intent.formats.length) {
      const r = await this.searchQuery(intent.topic || desc, { useLlm: opts.useLlm, slideLimit: 300 });
      analysis = r.analysis;
      for (const x of [...r.slides.light, ...r.slides.dark]) pool.set(x.id, x.score);
    }
    let all = null;
    const feats = new Map();
    const featOf = (s) => { if (!feats.has(s.id)) feats.set(s.id, gen.slideFeatures(s)); return feats.get(s.id); };
    if (intent.formats.length) {
      // 版式要求：在全库中查找满足版式的页面（有主题时只作为加权）
      all = this.store.getSlides([...vecs.keys()], true);
      for (const s of all) {
        const ok = intent.formats.some((fm) => fm.test(featOf(s)));
        const base = pool.get(s.id);
        if (base !== undefined) pool.set(s.id, ok ? base + 0.4 : base * 0.6);
        else if (ok && !intent.topic) pool.set(s.id, 0.5 + (s.notes ? 0.05 : 0));
      }
    }
    const top = Math.max(0, ...pool.values());
    const minScore = intent.topic ? top * (Number(opts.minRelevance) || 0.45) : 0;
    const ids = [...pool.keys()].filter((id) => vecs.has(id) && pool.get(id) >= minScore).sort((a, b) => pool.get(b) - pool.get(a)).slice(0, 400);
    const slides = all ? ids.map((id) => all.find((s) => s.id === id)).filter(Boolean) : this.store.getSlides(ids, true);
    const cands = slides.map((s) => ({ s, score: pool.get(s.id), vec: vecs.get(s.id).vec }));
    let rows = gen.cluster(cands, threshold);
    for (const r of rows) r.feat = featOf(r.rep.s);
    rows = gen.orderRows(rows).slice(0, opts.maxRows || 30);
    const view = (c) => {
      const f = fileMap.get(c.s.file_id) || {};
      return { id: c.s.id, file_id: c.s.file_id, fileName: f.name, filePath: f.path, idx: c.s.idx, title: c.s.title, theme: c.s.theme, thumb: c.s.thumb, bg: c.s.bg, text: String(c.s.text || '').slice(0, 300), notes: c.s.notes ? String(c.s.notes).slice(0, 200) : '', has_video: c.s.has_video, score: Math.round(c.score * 1000) / 1000, sim: Math.round((c.sim || 1) * 1000) / 1000 };
    };
    const out = rows.map((r, i) => {
      const items = [r.rep, ...r.variants.sort((a, b) => b.sim - a.sim)].slice(0, opts.maxPerRow || 12).map(view);
      const pick = (opts.theme === 'light' || opts.theme === 'dark') ? (items.find((x) => x.theme === opts.theme) || items[0]) : items[0];
      return { row: i + 1, title: r.rep.s.title || `第 ${r.rep.s.idx} 页`, formats: gen.FORMATS.filter((fm) => fm.test(r.feat)).map((fm) => fm.label), items, pick: pick.id, total: r.variants.length + 1 };
    });
    logger.child('generate').info(`智能生成「${desc}」：主题「${intent.topic || '-'}」，版式 ${intent.formats.map((f) => f.label).join('/') || '-'}，候选 ${cands.length} 页，阈值 ${threshold} → ${out.length} 组，${Date.now() - t0}ms`);
    return { rows: out, intent: { topic: intent.topic, formats: intent.formats.map((f) => f.label) }, analysis, candidates: cands.length, threshold };
  }

  /** 生成 PPT：可选统一底色（不一致的页按黑白底互转规则转换） */
  async generateDeck(slideIds, outPath, { unifyTheme = 'none' } = {}) {
    if (unifyTheme !== 'light' && unifyTheme !== 'dark') return this.exportSlides(slideIds, outPath, { includeNotes: true });
    const items = this.store.getSlides(slideIds).map((s) => ({ slideId: s.id, dir: unifyTheme === 'light' ? (s.theme === 'dark' ? 'toLight' : 'keep') : (s.theme === 'dark' ? 'keep' : 'toDark') }));
    return this.convertSlides(items, outPath);
  }

  // ================= 回收站 =================
  recycleDir() { return path.join(this.dataDir, 'recycle'); }

  /**
   * 把文档移到回收站。moveFile = true：原文件移动到回收站目录；false：只从资料库移除，原文件不动。
   * 被回收的若是“主文件”，其重复副本会自动提升为主文件（解析结果保留）。
   */
  async recycleFiles(fileIds, { moveFile = true, reason = '' } = {}) {
    const log = logger.child('recycle');
    let ok = 0; const errors = [];
    for (const id of [...new Set(fileIds)]) {
      const f = this.store.getFile(id);
      if (!f || f.status === 'recycled') continue;
      try {
        let binPath = null, moved = false;
        if (moveFile && fs.existsSync(f.path)) {
          const dir = path.join(this.recycleDir(), `${Date.now()}-${id}`);
          fs.mkdirSync(dir, { recursive: true });
          binPath = path.join(dir, f.name);
          moveFileSafe(f.path, binPath);
          moved = true;
        }
        if (f.status === 'parsed') {
          const dups = this.store.duplicatesOf(id).filter((d) => fs.existsSync(d.path));
          if (dups.length) {
            const heir = dups[0];
            this.store.moveSlides(id, heir.id);
            const keep = this.store.db.prepare('SELECT * FROM files WHERE id = ?').get(id);
            this.store.updateFile(heir.id, { status: 'parsed', dup_of: null, theme: keep.theme, slide_count: keep.slide_count, dark_slides: keep.dark_slides, light_slides: keep.light_slides, video_count: keep.video_count, notes_count: keep.notes_count, lang: keep.lang, tags: keep.tags, category: keep.category, terms: keep.terms, md_path: keep.md_path, meta: keep.meta, vec: keep.vec, preview: keep.preview, kind: keep.kind });
            for (const d of dups.slice(1)) this.store.updateFile(d.id, { dup_of: heir.id });
            log.info(`回收主文件，其重复副本提升为主文件：${heir.path}`);
          }
        }
        this.store.addRecycle({ file_id: id, name: f.name, orig_path: f.path, bin_path: binPath, moved, prev_status: f.status, size: f.size, kind: f.kind, slide_count: f.slide_count, reason });
        this.store.updateFile(id, { status: 'recycled' });
        ok++;
        log.info(`移到回收站：${f.path}${moved ? ` → ${binPath}` : '（仅从资料库移除，原文件保留）'}`);
      } catch (e) { errors.push(`${f.name}：${e.message}`); log.error(`移到回收站失败 ${f.path}`, e); }
    }
    if (ok) await this.afterLibraryChange(log);
    return { ok, errors };
  }

  recycleList() {
    return this.store.listRecycle().map((r) => ({ ...r, exists: r.moved ? fs.existsSync(r.bin_path) : fs.existsSync(r.orig_path) }));
  }

  /** 还原：原文件移回原位置（原位置已有同名文件时还原为“名称(还原)”），恢复解析结果 */
  async restoreRecycled(ids) {
    const log = logger.child('recycle');
    let ok = 0; const errors = [];
    for (const rid of ids) {
      const r = this.store.getRecycle(rid);
      if (!r) continue;
      try {
        let target = r.orig_path;
        if (r.moved) {
          if (!fs.existsSync(r.bin_path)) throw new Error('回收站中的文件已不存在');
          if (fs.existsSync(target)) target = target.replace(/(\.[^.\\/]+)$/, '(还原)$1');
          fs.mkdirSync(path.dirname(target), { recursive: true });
          moveFileSafe(r.bin_path, target);
          fs.rmSync(path.dirname(r.bin_path), { recursive: true, force: true });
        }
        const f = this.store.getFile(r.file_id);
        if (f) {
          const hasSlides = this.store.db.prepare('SELECT COUNT(*) n FROM slides WHERE file_id = ?').get(f.id).n;
          const heir = !hasSlides && f.fingerprint ? this.store.fileByFingerprint(f.fingerprint) : null;
          if (r.prev_status === 'parsed' && !hasSlides && heir) this.store.updateFile(f.id, { status: 'duplicate', dup_of: heir.id, path: target });
          else this.store.updateFile(f.id, { status: r.prev_status === 'parsed' && !hasSlides ? 'failed' : r.prev_status, path: target, error: r.prev_status === 'parsed' && !hasSlides ? '解析结果已丢失，请重新解析' : f.error });
        }
        this.store.removeRecycle(rid);
        ok++;
        log.info(`从回收站还原：${target}`);
      } catch (e) { errors.push(`${r.name}：${e.message}`); log.error(`还原失败 ${r.name}`, e); }
    }
    if (ok) await this.afterLibraryChange(log);
    return { ok, errors };
  }

  /** 彻底删除：删除回收站中的文件（仅限移入回收站的那份）及其解析数据 */
  purgeRecycled(ids) {
    const log = logger.child('recycle');
    let ok = 0; const errors = [];
    for (const rid of ids) {
      const r = this.store.getRecycle(rid);
      if (!r) continue;
      try {
        if (r.moved && r.bin_path) fs.rmSync(path.dirname(r.bin_path), { recursive: true, force: true });
        const f = this.store.getFile(r.file_id);
        if (f && f.status === 'recycled') {
          const mk = crypto.createHash('sha1').update(r.orig_path).digest('hex').slice(0, 16);
          this.store.deleteFile(f.id);
          for (const d of [path.join(this.thumbDir, mk), path.join(this.mediaDir, mk)]) fs.rmSync(d, { recursive: true, force: true });
          if (f.md_path && !this.store.db.prepare('SELECT 1 FROM files WHERE md_path = ?').get(f.md_path)) fs.rmSync(f.md_path, { force: true });
        }
        this.store.removeRecycle(rid);
        ok++;
        log.info(`彻底删除：${r.orig_path}${r.moved ? '（已删除回收站中的文件）' : '（仅删除解析数据，原文件未动）'}`);
      } catch (e) { errors.push(`${r.name}：${e.message}`); log.error(`彻底删除失败 ${r.name}`, e); }
    }
    this.search.invalidate();
    return { ok, errors };
  }

  // ================= 讲解词 / Markdown 编辑与 Agent 生成 =================
  /** 保存用户编辑：f = { notes?, md? }；传 null 表示恢复原文。同步更新全文索引与 Markdown 文件 */
  updateSlideText(id, f) {
    const s = this.store.getSlide(id, false);
    if (!s) throw new Error('页面不存在');
    const patch = {};
    if ('notes' in f) patch.notes_user = f.notes === null || f.notes === s.notes_orig ? null : String(f.notes);
    if ('md' in f) patch.md_user = f.md === null || f.md === s.md_orig ? null : String(f.md);
    this.store.setSlideUser(id, patch);
    const now = this.store.getSlide(id, false);
    const file = this.store.getFile(now.file_id);
    this.store.updateFts(id, { title: tokenize(now.title).join(' '), body: tokenize(now.text).join(' '), notes: tokenize(now.notes).join(' '), meta: tokenize(`${file.name} ${path.basename(file.dir || '')}`).join(' ') });
    this.rewriteMarkdownFile(file);
    this.search.invalidate();
    logger.child('edit').info(`编辑保存：${file.name} 第 ${now.idx} ${file.kind === 'word' ? '节' : '页'}（${Object.keys(f).map((k) => (k === 'notes' ? '讲解词' : 'Markdown')).join('、')}${Object.values(f).some((v) => v === null) ? '，恢复原文' : ''}）`);
    return this.slideDetail(id);
  }

  rewriteMarkdownFile(file) {
    if (!file || !file.md_path) return;
    try {
      const slides = this.store.slidesOf(file.id).map((x) => ({ ...x, index: x.idx }));
      fs.writeFileSync(file.md_path, docToMd({ ...file }, slides));
    } catch (e) { this.log.warn('更新 Markdown 文件失败', e); }
  }

  /** Agent 生成讲解词（建设中）：只调用“设置 → Agent 接口”中配置的大模型，未配置时提示去设置 */
  async generateNotes(id) {
    const s = this.store.getSlide(id, false);
    if (!s) throw new Error('页面不存在');
    const file = this.store.getFile(s.file_id);
    const client = llm.client(this.config.llm);
    if (!client || (!this.config.llm.apiKey && !/127\.0\.0\.1|localhost/.test(this.config.llm.baseUrl || ''))) {
      throw new Error('未配置 Agent 接口：请在“设置 → Agent 接口”中选择服务商（如 DeepSeek）、填写 API Key 并启用');
    }
    let text = '';
    try { text = (await client.speakerNotes({ fileName: file.name, title: s.title, text: s.text, md: s.md, notes: s.notes })).trim(); } catch (e) { throw new Error('调用 Agent 接口失败：' + e.message); }
    if (!text) throw new Error('Agent 接口没有返回内容');
    const source = `大模型 ${this.config.llm.model}`;
    this.store.setSlideUser(id, { notes_ai: text });
    logger.child('agent').info(`生成讲解词：${file.name} 第 ${s.idx} 页（${source}，${text.length} 字）`);
    return { text, source };
  }

  // ================= 讲解词多语言（翻译 + 写回 PPT 备注 / 应用知识库） =================
  /** 讲解词的三个版本：orig 原讲解词、ai 生成讲解词、final 修正讲解词（当前采用的版本） */
  notesVariant(s, variant) { return variant === 'orig' ? s.notes_orig || '' : variant === 'ai' ? s.notes_ai || '' : s.notes || ''; }
  /** 某页已有的译文（来自知识库，重新解析后仍保留） */
  notesI18n(slideId) {
    const s = this.store.getSlide(slideId, false);
    if (!s) return [];
    const f = this.store.getFile(s.file_id);
    return this.store.kbList(f.path, s.idx).map((r) => ({ variant: r.variant, lang: r.lang, text: r.text, source: r.source, writtenBack: !!r.written_back, at: r.at }));
  }
  /** 翻译讲解词：已有译文直接返回；否则调用设置中的 Agent 接口翻译，保存到知识库，并按设置写回 PPT 备注 */
  async translateNotes(slideId, { variant = 'final', lang = 'en', force = false, writeBack } = {}) {
    const s = this.store.getSlide(slideId, false);
    if (!s) throw new Error('页面不存在');
    const f = this.store.getFile(s.file_id);
    const src = this.notesVariant(s, variant);
    if (!src.trim()) throw new Error('该版本的讲解词为空，无法翻译');
    const zh = (src.match(/[\u4e00-\u9fff]/g) || []).length, en = (src.match(/[A-Za-z]+/g) || []).join('').length;
    const srcLang = zh * 3 >= en ? 'zh' : 'en';
    if (lang === srcLang) return { text: src, same: true, lang, variant };
    const hit = !force && this.store.kbGet(f.path, s.idx, variant, lang);
    if (hit) return { text: hit.text, source: hit.source, writtenBack: !!hit.written_back, cached: true, lang, variant };
    const client = llm.client(this.config.llm);
    if (!client) throw new Error('未配置 Agent 接口：请在“设置 → Agent 接口”中填写接口地址、API Key 与模型（支持 DeepSeek、通义千问、Kimi、智谱、OpenAI、本地 Ollama）');
    const name = LANG_NAMES[lang] || lang;
    const text = await client.translate(src, name);
    if (!text) throw new Error('翻译接口没有返回内容');
    const source = `${this.config.llm.model}`;
    this.store.kbPut({ path: f.path, idx: s.idx, variant, lang, text, source, written_back: 0 });
    logger.child('agent').info(`翻译讲解词：${f.name} 第 ${s.idx} ${f.kind === 'word' ? '节' : '页'} → ${name}（${source}，${text.length} 字）`);
    // 解析与翻译都不改动原文件：译文只保存在应用知识库，用户手动点击“写入 PPT 备注”时才写回
    let wb = { writtenBack: false };
    if (writeBack === true) wb = await this.writeBackNotes(slideId, { variant, lang }).catch((e) => ({ writtenBack: false, error: e.message }));
    return { text, source, lang, variant, ...wb };
  }
  /** 把知识库中的译文写回 PPT 备注（Word 文档不支持写回，只保存在知识库） */
  async writeBackNotes(slideId, { variant = 'final', lang = 'en' } = {}) {
    const s = this.store.getSlide(slideId, false);
    const f = s && this.store.getFile(s.file_id);
    if (!f) throw new Error('页面不存在');
    const hit = this.store.kbGet(f.path, s.idx, variant, lang);
    if (!hit) throw new Error('还没有该语言的译文');
    if ((f.kind || 'ppt') === 'word') return { writtenBack: false, error: 'Word 文档不支持写回，译文已保存在应用知识库中' };
    if (!/\.(pptx|pptm|potx|ppsx)$/i.test(f.path)) return { writtenBack: false, error: '旧版 .ppt 不支持写回，译文已保存在应用知识库中' };
    const name = LANG_NAMES[lang] || lang;
    const r = await writeNotes(f.path, s.idx, name, hit.text, { backupDir: path.join(this.dataDir, 'backup'), lang: LANG_TAGS[lang] || lang });
    this.store.kbMarkWritten(f.path, s.idx, variant, lang);
    // 同步文件记录的大小与修改时间，避免下次扫描把自己写入的改动当作“文件已修改”而重新解析
    const st = fs.statSync(f.path);
    this.store.updateFile(f.id, { size: st.size, mtime: Math.round(st.mtimeMs), fingerprint: this.fingerprint(f.name, st.size, st.mtimeMs, f.author) });
    logger.child('agent').info(`译文已写回 PPT 备注：${f.path} 第 ${s.idx} 页【${name}】（原文件已备份到 ${r.backup}）`);
    return { writtenBack: true, backup: r.backup };
  }
  async testLlm(cfg) {
    const client = llm.client({ ...this.config.llm, ...(cfg || {}), enabled: true });
    if (!client) throw new Error('请填写模型名称');
    const t0 = Date.now();
    const out = await client.ping();
    return { ok: true, reply: String(out).slice(0, 40), ms: Date.now() - t0 };
  }

  // ================= 黑白底互转规则脚本 =================
  rulesFile() { return path.join(this.dataDir, 'convert-rules.json'); }
  getConvertRules() {
    try { return normalizeRules(JSON.parse(fs.readFileSync(this.rulesFile(), 'utf8'))); } catch { return normalizeRules(null); }
  }
  setConvertRules(r) {
    const n = normalizeRules({ ...r, updatedAt: Date.now() });
    fs.writeFileSync(this.rulesFile(), JSON.stringify(n, null, 2));
    logger.child('convert').info('转换规则脚本已更新，下次转换生效');
    return n;
  }
  resetConvertRules() { fs.rmSync(this.rulesFile(), { force: true }); this.log.info('转换规则已恢复默认'); return this.getConvertRules(); }
  async convertRulesFromText(request) {
    const client = llm.client(this.config.llm);
    if (!client) throw new Error('用自然语言修改规则需要在“设置”中配置大模型；也可以直接在表单中修改');
    const r = await client.convertRules(this.getConvertRules(), request);
    if (!r) throw new Error('大模型没有返回有效的规则 JSON');
    return normalizeRules({ ...r, description: request });
  }

  recordView(fileId, kind = 'view') { try { this.store.addView(fileId, kind); } catch { /* ignore */ } }
  recordOpenPath(p) { const f = this.store.fileByPath(p); if (f) this.recordView(f.id, 'open'); }

  /**
   * 总览分析：实时读取文件的修改 / 访问时间（stat 不会改变访问时间），
   * 扣除本工具解析时产生的读取（解析时刻前后 1 小时内的访问时间视为解析造成，回退到解析前记录的访问时间），
   * 再与“在本工具中查看 / 打开”的记录合并，得到“最近一次被打开”。
   */
  /** 总览分析（带缓存）：按设置的刷新频率复用上次的统计结果；force 立即重新统计 */
  analytics({ force = false } = {}) {
    const mode = this.config.analyticsRefresh || 'open';
    const period = { daily: 86400000, weekly: 7 * 86400000 }[mode];
    if (!this.analyticsCache) { try { this.analyticsCache = JSON.parse(fs.readFileSync(path.join(this.dataDir, 'analytics-cache.json'), 'utf8')); } catch { this.analyticsCache = null; } }
    const c = this.analyticsCache;
    const fresh = c && (mode === 'manual' || (period && Date.now() - c.computedAt < period));
    if (!force && mode !== 'open' && fresh) return { ...c, mode, nextAt: period ? c.computedAt + period : null, cached: true };
    const data = this.computeAnalytics();
    this.analyticsCache = { ...data, computedAt: Date.now() };
    if (mode !== 'open') { try { fs.writeFileSync(path.join(this.dataDir, 'analytics-cache.json'), JSON.stringify(this.analyticsCache)); } catch (e) { this.log.warn('保存统计缓存失败', e); } }
    return { ...this.analyticsCache, mode, nextAt: period ? this.analyticsCache.computedAt + period : null, cached: false };
  }

  computeAnalytics() {
    const now = Date.now();
    const views = new Map(this.store.viewStats().map((v) => [v.file_id, v]));
    const files = this.store.listFiles().filter((f) => f.status === 'parsed' || f.status === 'duplicate').map((f) => {
      let st = null;
      try { st = fs.statSync(f.path); } catch { /* 文件已移动或删除 */ }
      const v = views.get(f.id) || { views: 0, opens: 0, last: null };
      let atime = st ? Math.round(st.atimeMs) : null;
      let atimeSrc = 'system';
      if (atime && f.parsed_at && atime >= f.parsed_at - 5000 && atime <= f.parsed_at + 3600 * 1000) {
        atime = f.atime_pre && f.atime_pre < f.parsed_at - 5000 ? f.atime_pre : null;
        atimeSrc = atime ? 'pre-parse' : 'unknown';
      }
      const mtimeNow = st ? Math.round(st.mtimeMs) : f.mtime;
      const candidates = [atime, mtimeNow, v.last].filter(Boolean);
      const lastOpen = candidates.length ? Math.max(...candidates) : null;
      return {
        id: f.id, name: f.name, path: f.path, dir: f.dir, kind: f.kind || 'ppt', size: f.size, slide_count: f.slide_count, author: f.author, category: f.category, tags: f.tags, theme: f.theme, status: f.status,
        mtime: mtimeNow, modifiedSinceParse: st ? Math.abs(st.mtimeMs - f.mtime) > 2000 : false, ctime: f.ctime || (st ? Math.round(st.birthtimeMs || st.ctimeMs) : null),
        atime, atimeSrc, views: v.views || 0, opens: v.opens || 0, lastView: v.last, lastOpen, exists: !!st, parsed_at: f.parsed_at,
      };
    });
    const since = now - 30 * 86400000;
    return { now, files, viewTimes: this.store.viewDaily(since), history: this.store.historyDaily(since) };
  }

  /** 资料库总览：每个任务及全部任务识别到的文档 */
  overview() {
    const files = this.store.listFiles();
    const tasks = this.store.listTasks().map((t) => ({ id: t.id, name: t.name, dir: t.dir, status: t.status, fileIds: [...new Set(this.store.taskFiles(t.id).map((f) => f.id).filter(Boolean))] }));
    return { tasks, files: files.filter((f) => f.status !== 'recycled') };
  }

  stats() { return { ...this.store.stats(), dataDir: this.dataDir, running: this.running, queued: this.queue.length }; }

  async rebuildAll() {
    this.log.info('重新计算标签、分组与对应关系');
    await this.afterLibraryChange();
  }

  close() { clearInterval(this.schedTimer); clearInterval(this.statTimer); this.store.close(); }
}

/** 移动文件（跨磁盘时复制后删除） */
function moveFileSafe(from, to) {
  try { fs.renameSync(from, to); } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    fs.copyFileSync(from, to);
    fs.unlinkSync(from);
  }
}

/** 内置讲解词模板：根据标题、要点、表格与图表组织成口语化讲解 */
async function borderLuminance(pngPath) {
  const { PNG } = require('pngjs');
  const png = PNG.sync.read(fs.readFileSync(pngPath));
  const { width: w, height: h, data } = png;
  const bw = Math.max(2, Math.round(w * 0.04)), bh = Math.max(2, Math.round(h * 0.06));
  const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  let sum = 0, n = 0;
  const step = Math.max(1, Math.round(w / 200));
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      if (x >= bw && x < w - bw && y >= bh && y < h - bh) continue;
      const i = (y * w + x) * 4;
      sum += 0.2126 * lin(data[i]) + 0.7152 * lin(data[i + 1]) + 0.0722 * lin(data[i + 2]);
      n++;
    }
  }
  return n ? sum / n : imageLuminance(fs.readFileSync(pngPath), pngPath);
}

module.exports = { AgentService, DEFAULT_CONFIG, DOC_TYPES, localRoots };
