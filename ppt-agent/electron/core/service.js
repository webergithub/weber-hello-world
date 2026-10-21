'use strict';
// 业务编排：解析任务（扫描目录、去重、解析、截图、入库）、标签、相似分组、检索与导出。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const logger = require('./logger');
const { Store } = require('./db');
const { parsePptx, quickProps } = require('./pptx');
const { slideToMd, docToMd } = require('./markdown');
const { tokenize, detectLang } = require('./textproc');
const { hashVector, mean, embedder } = require('./vectors');
const { fileTerms, computeTags } = require('./tagger');
const { computeGroups, computePairs, normSlideTitle } = require('./similarity');
const { SearchEngine } = require('./search');
const { exportPptx, exportMarkdown } = require('./exporter');
const { Office } = require('./office');
const { imageLuminance } = require('./image');
const llm = require('./llm');

const PPT_EXT = new Set(['.pptx', '.pptm', '.ppsx', '.ppsm', '.potx', '.potm', '.ppt', '.pps', '.pot']);
const LEGACY = new Set(['.ppt', '.pps', '.pot']);
const SKIP_DIRS = new Set(['node_modules', '.git', '$recycle.bin', 'system volume information', 'windows', 'program files', 'program files (x86)', 'appdata', '.cache', '.trash']);

const DEFAULT_CONFIG = {
  thumbnails: 'auto', // auto | powerpoint | libreoffice | off
  thumbWidth: 1280,
  llm: { enabled: false, baseUrl: 'https://api.deepseek.com/v1', apiKey: '', model: 'deepseek-chat', useForQuery: true, useForTags: false },
  embedding: { provider: 'none', baseUrl: 'http://127.0.0.1:11434', apiKey: '', model: 'bge-m3' },
  similarityThreshold: 0.82,
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
    for (const t of this.store.listTasks()) if (t.status === 'running' || t.status === 'pending') this.store.updateTask(t.id, { status: 'interrupted', message: '程序退出时任务未完成，可重新运行' });
    this.log.info(`服务启动，数据目录 ${dataDir}`);
  }

  loadConfig() {
    try {
      const c = JSON.parse(fs.readFileSync(this.configFile, 'utf8'));
      return { ...DEFAULT_CONFIG, ...c, llm: { ...DEFAULT_CONFIG.llm, ...(c.llm || {}) }, embedding: { ...DEFAULT_CONFIG.embedding, ...(c.embedding || {}) } };
    } catch { return JSON.parse(JSON.stringify(DEFAULT_CONFIG)); }
  }
  getConfig() { return this.config; }
  setConfig(patch) {
    this.config = { ...this.config, ...patch, llm: { ...this.config.llm, ...(patch.llm || {}) }, embedding: { ...this.config.embedding, ...(patch.embedding || {}) } };
    fs.writeFileSync(this.configFile, JSON.stringify(this.config, null, 2));
    this.log.info('配置已更新', { thumbnails: this.config.thumbnails, llm: this.config.llm.enabled ? this.config.llm.model : '未启用', embedding: this.config.embedding.provider });
    return this.config;
  }

  // ================= 解析任务 =================
  addTask(dir) {
    dir = path.resolve(dir);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error('目录不存在：' + dir);
    const id = this.store.createTask(dir, path.basename(dir) || dir);
    this.log.info(`[任务#${id}] 已添加解析任务：${dir}`);
    this.queue.push(id);
    this.emitTask(id);
    setImmediate(() => this.pump());
    return id;
  }

  rerunTask(id) {
    const t = this.store.getTask(id);
    if (!t) throw new Error('任务不存在');
    this.store.updateTask(id, { status: 'pending', message: '' });
    this.queue.push(id);
    setImmediate(() => this.pump());
    return id;
  }

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

  scan(dir, log) {
    const out = [];
    const walk = (d, depth) => {
      if (depth > 40) return;
      let list;
      try { list = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { log.warn(`无法读取目录 ${d}：${e.code || e.message}`); return; }
      for (const ent of list) {
        const p = path.join(d, ent.name);
        if (ent.isDirectory()) {
          if (ent.name.startsWith('.') || SKIP_DIRS.has(ent.name.toLowerCase())) continue;
          walk(p, depth + 1);
        } else if (ent.isFile()) {
          const ext = path.extname(ent.name).toLowerCase();
          if (!PPT_EXT.has(ext)) continue;
          if (ent.name.startsWith('~$') || ent.name.startsWith('._')) { log.info(`忽略 Office 临时锁文件：${p}`); continue; }
          out.push(p);
        }
      }
    };
    walk(dir, 0);
    return out.sort((a, b) => a.localeCompare(b, 'zh'));
  }

  async runTask(id) {
    const task = this.store.getTask(id);
    const tag = `[任务#${id}]`;
    const log = logger.child('task');
    const t0 = Date.now();
    this.store.updateTask(id, { status: 'running', started_at: t0, parsed: 0, skipped: 0, duplicate: 0, failed: 0 });
    log.info(`${tag} 开始扫描目录 ${task.dir}`);
    const engines = await this.office.detect();
    const files = this.scan(task.dir, log);
    this.store.updateTask(id, { total: files.length });
    log.info(`${tag} 发现 ${files.length} 个 PPT 文件`);
    this.emitTask(id);
    const counts = { parsed: 0, skipped: 0, duplicate: 0, failed: 0 };
    let changed = false;
    for (let i = 0; i < files.length; i++) {
      if (this.cancelled.has(id)) { log.warn(`${tag} 已取消，处理到第 ${i}/${files.length} 个文件`); break; }
      const file = files[i];
      this.emitTask(id, { current: file, done: i });
      try {
        const r = await this.processFile(id, file, engines, log, tag);
        counts[r]++;
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
      await this.afterLibraryChange(log, tag);
    }
    const cancelled = this.cancelled.delete(id);
    const ms = Date.now() - t0;
    const msg = `解析 ${counts.parsed}，已解析过跳过 ${counts.skipped}，重复文件 ${counts.duplicate}，失败 ${counts.failed}，耗时 ${(ms / 1000).toFixed(1)}s`;
    this.store.updateTask(id, { status: cancelled ? 'cancelled' : 'done', finished_at: Date.now(), message: msg });
    log.info(`${tag} 任务结束：${msg}`);
    if (changed && this.config.embedding.provider !== 'none') this.buildEmbeddings().catch((e) => log.warn('语义向量生成失败', e));
  }

  fingerprint(name, size, mtime, author) {
    return crypto.createHash('sha1').update(`${name}|${size}|${Math.floor(mtime / 1000)}|${author || ''}`).digest('hex');
  }

  async processFile(taskId, file, engines, log, tag) {
    const st = fs.statSync(file);
    const name = path.basename(file), ext = path.extname(file).toLowerCase();
    let author = '', title = '';
    if (!LEGACY.has(ext)) {
      try { const p = await quickProps(file); author = p.author; title = p.title; } catch (e) {
        const id = this.store.upsertFile({ path: file, dir: path.dirname(file), name, ext, size: st.size, mtime: Math.round(st.mtimeMs), status: 'failed', error: '文件损坏或不是有效的 PPTX：' + e.message, task_id: taskId, parsed_at: Date.now() });
        this.store.linkTaskFile(taskId, id, file, 'failed', '文件损坏或格式无效');
        log.warn(`${tag} 文件损坏或格式无效：${file}（${e.message}）`);
        return 'failed';
      }
    }
    const fp = this.fingerprint(name, st.size, st.mtimeMs, author);
    const existing = this.store.fileByPath(file);
    if (existing && existing.fingerprint === fp && (existing.status === 'parsed' || existing.status === 'duplicate')) {
      const when = new Date(existing.parsed_at).toLocaleString('zh-CN');
      this.store.linkTaskFile(taskId, existing.id, file, 'skipped', `已解析过（${when}），文件名/修改时间/大小/作者均未变化`);
      log.info(`${tag} 已解析过，跳过：${file}`);
      return 'skipped';
    }
    const same = this.store.fileByFingerprint(fp);
    if (same && same.path !== file && fs.existsSync(same.path)) {
      const id = this.store.upsertFile({ path: file, dir: path.dirname(file), name, ext, size: st.size, mtime: Math.round(st.mtimeMs), author, title, fingerprint: fp,
        status: 'duplicate', dup_of: same.id, error: null, slide_count: same.slide_count, theme: same.theme, tags: same.tags, category: same.category, task_id: taskId, parsed_at: Date.now() });
      if (existing) this.store.deleteSlidesOf(existing.id);
      this.store.linkTaskFile(taskId, id, file, 'duplicate', `与已解析文件信息完全一致：${same.path}`);
      log.info(`${tag} 与已解析文件一致，不重复解析：${file} == ${same.path}`);
      return 'duplicate';
    }
    // 完整解析
    const t0 = Date.now();
    let src = file;
    if (LEGACY.has(ext)) {
      log.info(`${tag} 旧版格式，转换为 PPTX：${file}`);
      src = await this.office.convertPpt(file, path.join(this.cacheDir, 'converted', crypto.createHash('sha1').update(file).digest('hex').slice(0, 12)));
    }
    const mediaKey = crypto.createHash('sha1').update(file).digest('hex').slice(0, 16);
    let parsed;
    try {
      parsed = await parsePptx(src, { mediaDir: this.mediaDir, mediaKey, log, ffmpeg: engines.ffmpeg ? this.office.ffmpegExtractor(this.cacheDir) : null });
    } catch (e) {
      const id = this.store.upsertFile({ path: file, dir: path.dirname(file), name, ext, size: st.size, mtime: Math.round(st.mtimeMs), author, fingerprint: null, status: 'failed', error: e.message, task_id: taskId, parsed_at: Date.now() });
      this.store.linkTaskFile(taskId, id, file, 'failed', e.message);
      log.warn(`${tag} 解析失败：${file}（${e.message}）`);
      return 'failed';
    }
    if (LEGACY.has(ext)) { author = parsed.props.author; title = parsed.props.title; }
    const slides = parsed.slides;

    // 页面截图（PowerPoint / LibreOffice，可选）
    let preview = null;
    if (this.config.thumbnails !== 'off' && slides.length) {
      try {
        preview = await this.office.thumbnails(src, path.join(this.thumbDir, mediaKey), mediaKey, this.config.thumbnails, this.config.thumbWidth);
        if (preview) log.info(`${tag} 页面截图(${preview.engine})：${preview.images ? preview.images.length + ' 页' : 'PDF'} ${name}`);
      } catch (e) { log.warn(`${tag} 生成截图失败 ${name}`, e); }
    }
    for (const s of slides) {
      s.md = slideToMd(s);
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
      path: file, dir: path.dirname(file), name, ext, size: st.size, mtime: Math.round(st.mtimeMs), author, title: title || (slides[0] && slides[0].title) || '',
      fingerprint: fp, status: 'parsed', error: null, dup_of: null, slide_count: slides.length,
      theme: !slides.length ? 'light' : dark === 0 ? 'light' : dark === slides.length ? 'dark' : (dark / slides.length >= 0.6 ? 'dark' : dark / slides.length <= 0.4 ? 'light' : 'mixed'),
      dark_slides: dark, light_slides: slides.length - dark,
      video_count: slides.reduce((a, s) => a + s.media.filter((m) => m.type === 'video').length, 0),
      notes_count: slides.filter((s) => s.notes).length,
      lang: detectLang(allText), preview,
      meta: { props: parsed.props, slideSize: parsed.size, legacy: LEGACY.has(ext), convertedFrom: LEGACY.has(ext) ? src : undefined, errors: slides.flatMap((s) => (s.errors || []).map((e) => `第${s.index}页 ${e}`)).slice(0, 50) },
      task_id: taskId, parsed_at: Date.now(),
    };
    const info = fileTerms(fileRow, slides);
    fileRow.terms = info;
    fileRow.vec = mean([...slides.map((s) => s.vec), hashVector(name.replace(/\.[^.]+$/, ''))]) || hashVector(name);
    const metaTokens = tokenize(`${name} ${path.basename(path.dirname(file))}`).join(' ');
    let fileId;
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
    this.store.linkTaskFile(taskId, fileId, file, 'parsed', `${slides.length} 页，${fileRow.notes_count} 页含备注，${fileRow.video_count} 个视频，耗时 ${Date.now() - t0}ms`);
    log.info(`${tag} 解析完成：${file}（${slides.length} 页，黑底 ${dark}/白底 ${slides.length - dark}，视频 ${fileRow.video_count}，${Date.now() - t0}ms）`);
    return 'parsed';
  }

  /** 资料库变化后：重算标签/分类、相似分组、黑白底对应 */
  async afterLibraryChange(log = this.log, tag = '') {
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
    this.search.invalidate();
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
  tasks() { return this.store.listTasks().map((t) => ({ ...t, running: this.running === t.id, queued: this.queue.includes(t.id) })); }

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

  library() { return this.store.listFiles().map((f) => ({ ...f })); }

  fileDetail(id) {
    const f = this.store.getFile(id);
    if (!f) return null;
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

  categories() {
    const files = this.store.listFiles({ status: 'parsed' });
    const cats = {};
    const tagCount = {};
    for (const f of files) {
      (cats[f.category || '其他'] = cats[f.category || '其他'] || []).push(f);
      for (const t of f.tags || []) tagCount[t] = (tagCount[t] || 0) + 1;
    }
    const isAttr = (t) => /^(白底|黑底|黑白混合|含视频|含字幕|含表格|含图表|含讲解词|全页讲解词|中文|英文|中英双语|大文件|\d+页以内|\d+-\d+页|\d+页以上)$|^目录:/.test(t);
    const tags = Object.entries(tagCount).sort((a, b) => b[1] - a[1]).slice(0, 400).map(([tag, n]) => ({ tag, n, attr: isAttr(tag) }));
    return { categories: Object.entries(cats).map(([name, list]) => ({ name, files: list })).sort((a, b) => b.files.length - a.files.length), tags };
  }

  groups({ sort = 'name', order = 'asc' } = {}) {
    const groups = this.groupsCache || this.computeGroupsNow();
    const dir = order === 'desc' ? -1 : 1;
    const key = (m) => (sort === 'size' ? m.file.size : m.file.name);
    const cmp = (a, b) => (sort === 'size' ? (a - b) : String(a).localeCompare(String(b), 'zh')) * dir;
    const out = groups.map((g) => ({ ...g, members: [...g.members].sort((a, b) => cmp(key(a), key(b))) }));
    out.sort((a, b) => (sort === 'size' ? cmp(a.totalSize, b.totalSize) : cmp(a.title, b.title)));
    return out;
  }

  async searchQuery(q, opts = {}) {
    const useLlm = opts.useLlm !== false && this.config.llm.enabled && this.config.llm.useForQuery;
    const r = await this.search.search(q, { ...opts, useLlm });
    logger.child('search').info(`检索「${q}」：中文词 ${r.analysis.zh.slice(0, 8).join('/')}；英文词 ${r.analysis.en.slice(0, 8).join('/')}；文件 ${r.files.length}，页面 白底 ${r.slides.light.length} / 黑底 ${r.slides.dark.length}，召回 ${r.retrievers.join(' ')}，${r.timing.total}ms`);
    return r;
  }

  async ragAnswer(q, ids) { return this.search.answer(q, ids); }

  /** sels: [{slideId}] → 导出 PPTX */
  async exportSlides(slideIds, outPath, opts = {}) {
    const slides = this.store.getSlides(slideIds);
    const sels = [];
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
    return exportPptx(sels, outPath, { ...opts, log: logger.child('export') });
  }

  stats() { return { ...this.store.stats(), dataDir: this.dataDir, running: this.running, queued: this.queue.length }; }

  async rebuildAll() {
    this.log.info('重新计算标签、分组与对应关系');
    await this.afterLibraryChange();
  }

  close() { this.store.close(); }
}

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

module.exports = { AgentService, DEFAULT_CONFIG };
