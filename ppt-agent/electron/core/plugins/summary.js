'use strict';
// 插件：智能总结（v3.5 预留，v3.7 改为脚本调用）——为资料库中的文档各生成一份 Markdown 总结：
// 另存为单独的 .md 文件（数据目录 summaries/），内容写入 doc_summaries 表，智能搜索的“文档总结”页签与 RAG 可检索。
// 生成方式：设置中配置的脚本（config.plugins.summary，设为“生效”后才执行），在单独的子进程中异步运行，
// 脚本里可以调用用户自己的大模型；脚本失败只在通知中提示（连续失败 3 次自动暂停），不影响总任务 / 子任务的解析。
// （联网版的大模型接口走工作线程 summaryWorker.js；单机版不可用。）进度通过 'update' 事件推给“智能总结”页面。
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { Worker } = require('worker_threads');

const isFake = () => process.env.PPTA_FAKE_LLM === '1'; // 测试用：工作线程用本地替身生成总结，不联网

const PLUGINS = [
  { id: 'summary', name: '智能总结', icon: '🧠', desc: '调用设置中的脚本（可在脚本中调用大模型）为每个文档生成 Markdown 总结，另存为单独的 .md 文件，并入库供智能搜索 / RAG 检索' },
];

const safeName = (s) => String(s || '').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80);

class SummaryPlugin extends EventEmitter {
  constructor(service) {
    super();
    this.svc = service;
    this.dir = path.join(service.dataDir, 'summaries');
    this.jobs = []; // { id, fileId, name, path, status: queued | running | done | failed | cancelled, mdPath, ms, error, at }
    this.seq = 0;
    this.paused = false;
    this.worker = null;
    this.busy = null; // 正在处理的 job id
    this.failStreak = 0; // 连续失败次数（达到 3 次自动暂停）
    this.noticeAt = 0; this.mutedFails = 0; // 失败通知限流
  }

  /** 设置中的脚本配置 */
  cfg() { return ((this.svc.config.plugins || {}).summary) || {}; }

  /** 示例脚本（随程序打包在 resources/plugins，开发时在 ppt-agent/plugins） */
  static examplePath() {
    const packed = process.resourcesPath ? path.join(process.resourcesPath, 'plugins', 'summary-example.js') : '';
    return packed && fs.existsSync(packed) ? packed : path.join(__dirname, '..', '..', '..', 'plugins', 'summary-example.js');
  }

  notice(kind, msg) { this.emit('notice', { kind, msg, at: Date.now() }); }

  get store() { return this.svc.store; }

  /** 是否可用：统一由 AI 调用模块判断（脚本 / 大模型接口 / 测试替身） */
  available() {
    const e = this.svc.ai.engine();
    return e.ok ? { ok: true, engine: e.engine === 'script' ? 'script' : 'worker', model: e.model } : { ok: false, reason: e.reason, engine: e.engine };
  }

  /** 解析任务每解析完一个文档调用：开启“自动总结”时加入队列（任何错误都不影响解析任务） */
  onParsed(fileId) {
    try {
      const c = this.cfg();
      if (!c.enabled || c.auto === false || !c.script || this.paused) return;
      if (!this.available().ok) return;
      this.start([fileId], { quiet: true });
    } catch (e) { this.svc.log.warn('[智能总结] 自动加入队列失败', e); }
  }

  /** 把文档加入总结队列；已有总结的默认跳过（force 时重新生成） */
  start(fileIds, { force = false, quiet = false } = {}) {
    const av = this.available();
    if (!av.ok) throw new Error(av.reason);
    const queued = new Set(this.jobs.filter((j) => ['queued', 'running'].includes(j.status)).map((j) => j.fileId));
    if (!queued.size) this.batchStart = Date.now(); // 新一批：重新计算已用时间与预计剩余
    const have = new Set(force ? [] : this.store.db.prepare('SELECT file_id FROM doc_summaries').all().map((r) => r.file_id));
    let added = 0, skipped = 0;
    for (const id of [...new Set(fileIds || [])]) {
      const f = this.store.getFile(id);
      if (!f || f.status !== 'parsed' || queued.has(id)) continue;
      if (have.has(id)) { skipped++; continue; }
      this.jobs.push({ id: ++this.seq, fileId: id, name: f.name, path: f.path, kind: f.kind, status: 'queued', at: Date.now() });
      added++;
    }
    if (!quiet || added) this.svc.log.info(`[智能总结] 加入队列 ${added} 个文档${skipped ? `，已有总结跳过 ${skipped} 个` : ''}`);
    if (!quiet) { this.paused = false; this.failStreak = 0; }
    this.changed();
    setImmediate(() => this.kick());
    return { added, skipped };
  }

  /** 手动暂停：立即结束正在运行的脚本，该文档放回队列（继续时重新总结） */
  pause() {
    this.paused = true;
    if (this.child) { this.aborted = true; require('../procs').killTree(this.child.pid); }
    this.changed();
  }
  resume() { this.paused = false; this.failStreak = 0; this.changed(); setImmediate(() => this.kick()); }
  cancel() {
    for (const j of this.jobs) if (j.status === 'queued') j.status = 'cancelled';
    this.changed();
  }
  clearFinished() { this.jobs = this.jobs.filter((j) => ['queued', 'running'].includes(j.status)); this.changed(); }

  ensureWorker() {
    if (this.worker) return this.worker;
    // 以代码字符串启动：打包后脚本位于 app.asar 内，主进程可读取，工作线程不能直接按路径加载
    const code = fs.readFileSync(path.join(__dirname, 'summaryWorker.js'), 'utf8');
    const llm = this.svc.config.llm || {};
    this.worker = new Worker(code, { eval: true, workerData: { fake: isFake(), llm: { baseUrl: llm.baseUrl, apiKey: llm.apiKey, model: llm.model } } });
    this.worker.unref(); // 不阻止进程退出
    this.worker.on('message', (m) => this.onMessage(m));
    this.worker.on('error', (e) => { this.svc.log.error('[智能总结] 工作线程出错', e); this.failBusy(String(e.message || e)); this.worker = null; });
    this.worker.on('exit', () => { this.worker = null; if (this.busy) this.failBusy('工作线程已退出'); });
    return this.worker;
  }

  /** 文档内容：逐页标题、正文与讲解词 */
  docText(fileId) {
    const parts = [];
    for (const s of this.store.slidesOf(fileId, true)) {
      parts.push(`## 第 ${s.idx} 页 ${s.title || ''}\n${(s.text || '').slice(0, 1500)}${s.notes ? `\n讲解词：${String(s.notes).slice(0, 600)}` : ''}`);
    }
    return parts.join('\n\n');
  }

  kick() {
    if (this.paused || this.busy) return;
    const j = this.jobs.find((x) => x.status === 'queued');
    if (!j) return;
    j.status = 'running'; j.startedAt = Date.now();
    this.busy = j.id;
    this.changed();
    if (this.available().engine === 'script') { this.runScript(j).catch((e) => this.failBusy(String(e.message || e))); return; }
    try { this.ensureWorker().postMessage({ type: 'job', id: j.id, name: j.name, text: this.docText(j.fileId) }); } catch (e) { this.failBusy(String(e.message || e)); }
  }

  outPath(j) { return path.join(this.dir, `${j.fileId}_${safeName(path.parse(j.name).name)}_总结.md`); }

  /** 脚本方式：写出输入 JSON，子进程运行脚本，读取输出的 Markdown */
  /** 脚本方式：交给 AI 调用模块（ai.run('summarize')）在子进程中执行 */
  async runScript(j) {
    const f = this.store.getFile(j.fileId) || {};
    const pages = this.store.slidesOf(j.fileId, true).map((sl) => ({ idx: sl.idx, title: sl.title || '', text: sl.text || '', notes: sl.notes || '' }));
    const file = { id: f.id, name: f.name, path: f.path, kind: f.kind || 'ppt', pages: pages.length, author: f.author || '', category: f.category || '', tags: f.tags || [], markdown: f.md_path || '' };
    const r = await this.svc.ai.run('summarize', { file, pages }, { onSpawn: (ch) => { this.child = ch; } });
    this.child = null;
    if (this.aborted) {
      // 手动暂停打断：不算失败，放回队列
      this.aborted = false;
      Object.assign(j, { status: 'queued', startedAt: null });
      this.busy = null;
      this.changed();
      return;
    }
    if (r.ok) this.onMessage({ type: 'done', id: j.id, md: r.text, ms: r.ms });
    else this.onMessage({ type: 'error', id: j.id, ms: r.ms, error: r.error });
  }

  failBusy(error) {
    const j = this.jobs.find((x) => x.id === this.busy);
    this.busy = null;
    if (j) { j.status = 'failed'; j.error = error; j.ms = Date.now() - (j.startedAt || Date.now()); }
    this.changed();
    setImmediate(() => this.kick());
  }

  onMessage(m) {
    const j = this.jobs.find((x) => x.id === m.id);
    if (!j) return;
    if (m.type === 'start') return;
    this.busy = null;
    if (m.type === 'done') {
      fs.mkdirSync(this.dir, { recursive: true });
      const out = this.outPath(j);
      this.failStreak = 0;
      const model = this.available().model || '';
      // 与原文件、解析出的 Markdown 建立关联：总结文件头部写明来源，入库时记录原文件路径与解析 MD 路径
      const f = this.store.getFile(j.fileId) || {};
      const body = String(m.md).replace(/^---\n[\s\S]*?\n---\n/, '');
      const head = `---\n原文件: ${f.path || ''}\n解析 Markdown: ${f.md_path || ''}\n文档编号: ${j.fileId}\n生成方式: ${model}\n生成时间: ${new Date().toLocaleString('zh-CN', { hour12: false })}\n---\n\n`;
      fs.writeFileSync(out, head + body, 'utf8');
      this.store.db.prepare('INSERT OR REPLACE INTO doc_summaries(file_id, md_path, summary, model, at, ms, src_path, src_md) VALUES (?,?,?,?,?,?,?,?)').run(j.fileId, out, body, model, Date.now(), m.ms, f.path || '', f.md_path || '');
      Object.assign(j, { status: 'done', mdPath: out, ms: m.ms });
      this.svc.log.info(`[智能总结] 完成：${j.name}（${m.ms}ms）→ ${out}`);
    } else {
      Object.assign(j, { status: 'failed', error: m.error, ms: m.ms });
      this.svc.log.warn(`[智能总结] 失败：${j.name}：${m.error}`);
      this.failStreak++;
      // 通知限流：10 秒内最多提示一次，期间的失败合并到下一条
      if (Date.now() - this.noticeAt > 10000) {
        this.notice('error', `智能总结失败：${j.name}（${m.error}）${this.mutedFails ? `；另有 ${this.mutedFails} 个文档失败` : ''}。解析任务不受影响`);
        this.noticeAt = Date.now(); this.mutedFails = 0;
      } else this.mutedFails++;
      if (this.failStreak >= 3 && !this.paused) {
        this.paused = true;
        this.notice('error', '智能总结连续 3 个文档失败，已自动暂停；请检查“设置 → 常规 → AI 调用脚本”后在“智能总结”页面点“继续”');
        this.svc.log.warn('[智能总结] 连续失败 3 次，已自动暂停');
      }
    }
    this.changed();
    setImmediate(() => this.kick());
  }

  changed() { this.emit('update', this.state()); }

  state() {
    const c = { queued: 0, running: 0, done: 0, failed: 0, cancelled: 0 };
    for (const j of this.jobs) c[j.status] = (c[j.status] || 0) + 1;
    const total = this.store.db.prepare('SELECT COUNT(*) n FROM doc_summaries').get().n;
    const cfg = this.cfg();
    return { eta: this.eta(c), plugins: PLUGINS, available: this.available(), paused: this.paused, counts: c, jobs: this.jobs, stored: total, script: { enabled: !!cfg.enabled, script: cfg.script || '', auto: cfg.auto !== false } };
  }

  /**
   * 预计剩余时间（v3.10）：按本批最近 10 个已结束文档的平均耗时 × 剩余文档数（逐个执行），
   * 减去正在总结的文档已用的时间；返回 { elapsed, remainingMs, totalMs, avgMs, left }，暂停或没有排队时为 null
   */
  eta(c) {
    const left = c.queued + c.running;
    if (!left || !this.batchStart) return null;
    const now = Date.now();
    const recent = this.jobs.filter((j) => (j.status === 'done' || j.status === 'failed') && j.ms && j.at >= this.batchStart - 1).slice(-10);
    const avgMs = recent.length ? Math.round(recent.reduce((a, j) => a + j.ms, 0) / recent.length) : null;
    const run = this.jobs.find((j) => j.status === 'running');
    const runLeft = run && avgMs !== null ? Math.max(0, avgMs - (now - (run.startedAt || now))) : 0;
    const remainingMs = avgMs === null ? null : avgMs * c.queued + runLeft;
    const elapsed = now - this.batchStart;
    return { elapsed, remainingMs, totalMs: remainingMs === null ? null : elapsed + remainingMs, avgMs, left, paused: this.paused };
  }

  /** 已入库的总结（“已生成的总结”列表） */
  list() {
    return this.store.db.prepare('SELECT s.file_id, s.md_path, s.model, s.at, s.ms, s.src_md, f.name, f.path, f.md_path AS file_md, f.kind, f.slide_count, substr(s.summary, 1, 400) AS preview FROM doc_summaries s LEFT JOIN files f ON f.id = s.file_id ORDER BY s.at DESC').all();
  }

  /** 检索总结内容（智能搜索的“文档总结”页签 / RAG）：按命中的检索词数排序 */
  search(terms, fileIds = null) {
    const list = [...new Set((terms || []).map((t) => String(t).toLowerCase()).filter((t) => t.length > 1))];
    if (!list.length) return [];
    const scope = fileIds ? new Set(fileIds) : null;
    const out = [];
    for (const r of this.store.db.prepare('SELECT s.file_id, s.md_path, s.summary, s.at, f.name, f.path, f.md_path AS file_md, f.kind FROM doc_summaries s JOIN files f ON f.id = s.file_id WHERE f.status = \'parsed\'').all()) {
      if (scope && !scope.has(r.file_id)) continue;
      const low = r.summary.toLowerCase();
      const matched = list.filter((t) => low.includes(t));
      if (!matched.length) continue;
      const i = low.indexOf(matched[0]);
      out.push({ file_id: r.file_id, name: r.name, path: r.path, kind: r.kind, md_path: r.md_path, file_md: r.file_md, at: r.at, matched, score: matched.length / list.length, snippet: r.summary.slice(Math.max(0, i - 60), i + 160) });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, 100);
  }

  close() { if (this.worker) { this.worker.terminate(); this.worker = null; } }
}

module.exports = { SummaryPlugin, PLUGINS };
