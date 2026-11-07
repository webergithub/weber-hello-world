'use strict';
// PPT_Agent harness 层（v3.11，基于 DeepSeek Harness “一切皆插件” 的思路定制）：
// 轮询读取 PPT / 文档 → 发给大模型 → 取得总结 → 生成 Markdown 文件 + 内容入库（doc_summaries，供智能搜索 / RAG）。
// 流水线由可替换的插件组成（use(stage, plugin)）：
//   source    轮询来源：从“轮询范围”（所选任务 / 子任务）中找出已解析、还没有总结的文档
//   reader    读取文档：逐页标题、正文、讲解词
//   model     调用模型：交给 AI 调用模块（service.ai：PPT_Agent 大模型接口 / AI 调用脚本 / 测试替身）
//   sinks     输出：markdown（写 summaries/<id>_<名>_总结.md，头部带原文件与解析 MD 的关联）、database（写 doc_summaries）
// 文档逐个异步处理，失败只通知（连续 3 次失败自动暂停），不影响解析任务；进度经 'update' 事件推给“PPT_Agent”页面。
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const PLUGINS = [
  { id: 'summary', name: 'PPT_Agent', icon: '🤖', desc: '调用大模型（或 AI 调用脚本）为文档生成 Markdown 总结，另存为单独的 .md 文件，并入库供智能搜索 / RAG 检索' },
];

const safeName = (s) => String(s || '').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80);

/** 默认插件 */
function defaultPipeline(h) {
  return {
    source: {
      name: 'source.taskScopes',
      /** 轮询范围内已解析、没有总结、也不在队列中的文档 id */
      poll() {
        const scopes = h.scopes();
        if (!scopes.length) return [];
        const ids = new Set();
        const stmt = h.store.db.prepare(`SELECT DISTINCT tf.file_id id FROM task_files tf JOIN files f ON f.id = tf.file_id AND f.status = 'parsed'
          LEFT JOIN doc_summaries s ON s.file_id = f.id
          WHERE s.file_id IS NULL AND tf.task_id IN (SELECT id FROM tasks WHERE (id = ? OR parent_id = ?) AND (deleted IS NULL OR deleted = 0)) LIMIT 5000`);
        for (const tid of scopes) for (const r of stmt.all(tid, tid)) ids.add(r.id);
        return [...ids];
      },
    },
    reader: {
      name: 'reader.library',
      read(fileId) {
        const f = h.store.getFile(fileId) || {};
        const pages = h.store.slidesOf(fileId, true).map((sl) => ({ idx: sl.idx, title: sl.title || '', text: sl.text || '', notes: sl.notes || '' }));
        return { file: { id: f.id, name: f.name, path: f.path, kind: f.kind || 'ppt', pages: pages.length, author: f.author || '', category: f.category || '', tags: f.tags || [], markdown: f.md_path || '' }, pages, row: f };
      },
    },
    model: {
      name: 'model.aiGateway',
      run(doc, { signal, onSpawn }) { return h.svc.ai.run('summarize', { file: doc.file, pages: doc.pages }, { signal, onSpawn }); },
    },
    sinks: [
      {
        name: 'sink.markdown',
        write(ctx) {
          fs.mkdirSync(h.dir, { recursive: true });
          const f = ctx.doc.row;
          ctx.body = String(ctx.text).replace(/^---\n[\s\S]*?\n---\n/, '');
          ctx.mdPath = path.join(h.dir, `${ctx.fileId}_${safeName(path.parse(f.name || String(ctx.fileId)).name)}_总结.md`);
          const head = `---\n原文件: ${f.path || ''}\n解析 Markdown: ${f.md_path || ''}\n文档编号: ${ctx.fileId}\n生成方式: ${ctx.model}\n生成时间: ${new Date().toLocaleString('zh-CN', { hour12: false })}\n---\n\n`;
          fs.writeFileSync(ctx.mdPath, head + ctx.body, 'utf8');
        },
      },
      {
        name: 'sink.database',
        write(ctx) {
          const f = ctx.doc.row;
          h.store.db.prepare('INSERT OR REPLACE INTO doc_summaries(file_id, md_path, summary, model, at, ms, src_path, src_md) VALUES (?,?,?,?,?,?,?,?)')
            .run(ctx.fileId, ctx.mdPath || '', ctx.body, ctx.model, Date.now(), ctx.ms, f.path || '', f.md_path || '');
        },
      },
    ],
  };
}

class PptAgentHarness extends EventEmitter {
  constructor(service) {
    super();
    this.svc = service;
    this.dir = path.join(service.dataDir, 'summaries');
    this.jobs = []; // { id, fileId, name, path, kind, status: queued | running | done | failed | cancelled, mdPath, ms, error, at }
    this.seq = 0;
    this.paused = false;
    this.busy = null;
    this.failStreak = 0;
    this.noticeAt = 0; this.mutedFails = 0;
    this.pipeline = defaultPipeline(this);
    this.lastPoll = 0; this.lastPollAdded = 0;
    this.timer = setInterval(() => this.tick(), 1000);
    if (this.timer.unref) this.timer.unref();
  }

  get store() { return this.svc.store; }
  /** AI 调用脚本的设置（plugins.summary），兼容旧版本 */
  cfg() { return ((this.svc.config.plugins || {}).summary) || {}; }
  agentCfg() { return this.svc.config.pptAgent || {}; }
  /** 轮询范围：任务 / 子任务 id */
  scopes() { return [...new Set((this.agentCfg().scopes || []).map(Number).filter(Boolean))]; }
  pollSec() { return Math.max(5, Number(this.agentCfg().pollSec) || 30); }

  /** 替换流水线中的某个插件：use('model', { name, run }) / use('sinks', [...]) */
  use(stage, plugin) {
    if (!(stage in this.pipeline)) throw new Error(`未知的流水线阶段：${stage}`);
    this.pipeline[stage] = plugin;
    return this;
  }

  static examplePath() {
    const packed = process.resourcesPath ? path.join(process.resourcesPath, 'plugins', 'summary-example.js') : '';
    return packed && fs.existsSync(packed) ? packed : path.join(__dirname, '..', '..', '..', 'plugins', 'summary-example.js');
  }

  notice(kind, msg) { this.emit('notice', { kind, msg, at: Date.now() }); }

  available() {
    const e = this.svc.ai.engine();
    return e.ok ? { ok: true, engine: e.engine, model: e.model } : { ok: false, reason: e.reason, engine: e.engine };
  }

  /** 每秒检查一次：到轮询间隔时从轮询范围取新文档加入队列 */
  tick() {
    if (this.paused || !this.scopes().length) return;
    if (Date.now() - this.lastPoll < this.pollSec() * 1000) return;
    this.poll();
  }

  poll() {
    this.lastPoll = Date.now();
    try {
      if (!this.available().ok) return 0;
      const ids = this.pipeline.source.poll();
      const failed = new Set(this.jobs.filter((j) => j.status === 'failed').map((j) => j.fileId)); // 本次运行中失败过的不再自动重试
      const r = ids.length ? this.start(ids.filter((id) => !failed.has(id)), { quiet: true }) : { added: 0 };
      this.lastPollAdded = r.added;
      if (r.added) this.svc.log.info(`[PPT_Agent] 轮询：轮询范围内新增 ${r.added} 个待总结文档`);
      this.changed();
      return r.added;
    } catch (e) { this.svc.log.warn('[PPT_Agent] 轮询失败', e); return 0; }
  }

  /** 解析任务每解析完一个文档调用：开启“自动总结”时加入队列 */
  onParsed(fileId) {
    try {
      const c = this.cfg();
      if (c.auto === false || this.paused) return;
      const e = this.svc.ai.engine();
      if (!e.ok) return;
      // AI 调用脚本沿用“解析完成的文档自动生成智能总结”；大模型接口另需打开 PPT_Agent 的“自动总结新解析的文档”（默认关，避免大量调用）
      if (e.engine === 'script' && !c.enabled) return;
      if (e.engine === 'llm' && !this.agentCfg().auto) return;
      this.start([fileId], { quiet: true });
    } catch (e) { this.svc.log.warn('[PPT_Agent] 自动加入队列失败', e); }
  }

  start(fileIds, { force = false, quiet = false } = {}) {
    const av = this.available();
    if (!av.ok) throw new Error(av.reason);
    const queued = new Set(this.jobs.filter((j) => ['queued', 'running'].includes(j.status)).map((j) => j.fileId));
    if (!queued.size) this.batchStart = Date.now();
    const have = new Set(force ? [] : this.store.db.prepare('SELECT file_id FROM doc_summaries').all().map((r) => r.file_id));
    let added = 0, skipped = 0;
    for (const id of [...new Set(fileIds || [])]) {
      const f = this.store.getFile(id);
      if (!f || f.status !== 'parsed' || queued.has(id)) continue;
      if (have.has(id)) { skipped++; continue; }
      this.jobs.push({ id: ++this.seq, fileId: id, name: f.name, path: f.path, kind: f.kind, status: 'queued', at: Date.now() });
      added++;
    }
    if (this.jobs.length > 5000) this.jobs = this.jobs.filter((j, i) => ['queued', 'running'].includes(j.status) || i >= this.jobs.length - 3000);
    if (!quiet || added) this.svc.log.info(`[PPT_Agent] 加入队列 ${added} 个文档${skipped ? `，已有总结跳过 ${skipped} 个` : ''}`);
    if (!quiet) { this.paused = false; this.failStreak = 0; }
    this.changed();
    setImmediate(() => this.kick());
    return { added, skipped };
  }

  /** 暂停：立即结束正在进行的调用（脚本进程 / 大模型请求），文档放回队列 */
  pause() {
    this.paused = true;
    if (this.child) { this.aborted = true; require('../procs').killTree(this.child.pid); }
    if (this.abort) { this.aborted = true; this.abort.abort(); }
    this.changed();
  }
  resume() { this.paused = false; this.failStreak = 0; this.lastPoll = 0; this.changed(); setImmediate(() => this.kick()); }
  cancel() { for (const j of this.jobs) if (j.status === 'queued') j.status = 'cancelled'; this.changed(); }
  clearFinished() { this.jobs = this.jobs.filter((j) => ['queued', 'running'].includes(j.status)); this.changed(); }

  kick() {
    if (this.paused || this.busy) return;
    const j = this.jobs.find((x) => x.status === 'queued');
    if (!j) return;
    j.status = 'running'; j.startedAt = Date.now();
    this.busy = j.id;
    this.changed();
    this.runJob(j).catch((e) => this.finish(j, { ok: false, error: String((e && e.message) || e), ms: Date.now() - j.startedAt }));
  }

  async runJob(j) {
    const doc = this.pipeline.reader.read(j.fileId);
    this.abort = new AbortController();
    const r = await this.pipeline.model.run(doc, { signal: this.abort.signal, onSpawn: (ch) => { this.child = ch; } });
    this.child = null; this.abort = null;
    if (this.aborted) {
      this.aborted = false;
      Object.assign(j, { status: 'queued', startedAt: null });
      this.busy = null;
      this.changed();
      return;
    }
    if (!r.ok) { this.finish(j, r); return; }
    const ctx = { fileId: j.fileId, doc, text: r.text, ms: r.ms, model: this.available().model || r.engine || '' };
    for (const sink of this.pipeline.sinks) await sink.write(ctx);
    this.finish(j, { ok: true, ms: r.ms, mdPath: ctx.mdPath });
  }

  finish(j, r) {
    this.busy = null;
    if (r.ok) {
      this.failStreak = 0;
      Object.assign(j, { status: 'done', mdPath: r.mdPath, ms: r.ms });
      this.svc.log.info(`[PPT_Agent] 完成：${j.name}（${r.ms}ms）→ ${r.mdPath}`);
    } else {
      Object.assign(j, { status: 'failed', error: r.error, ms: r.ms });
      this.svc.log.warn(`[PPT_Agent] 失败：${j.name}：${r.error}`);
      this.failStreak++;
      if (Date.now() - this.noticeAt > 10000) {
        this.notice('error', `PPT_Agent 总结失败：${j.name}（${r.error}）${this.mutedFails ? `；另有 ${this.mutedFails} 个文档失败` : ''}。解析任务不受影响`);
        this.noticeAt = Date.now(); this.mutedFails = 0;
      } else this.mutedFails++;
      if (this.failStreak >= 3 && !this.paused) {
        this.paused = true;
        this.notice('error', 'PPT_Agent 连续 3 个文档失败，已自动暂停；请检查“设置 → PPT_Agent”后在“PPT_Agent”页面点“继续”');
        this.svc.log.warn('[PPT_Agent] 连续失败 3 次，已自动暂停');
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
    const scopes = this.scopes();
    return {
      eta: this.eta(c), plugins: PLUGINS, available: this.available(), paused: this.paused, counts: c, jobs: this.jobs, stored: total,
      script: { enabled: !!cfg.enabled, script: cfg.script || '', auto: cfg.auto !== false },
      harness: { scopes, pollSec: this.pollSec(), polling: !!scopes.length && !this.paused, lastPoll: this.lastPoll, nextPoll: scopes.length && !this.paused ? (this.lastPoll || Date.now()) + this.pollSec() * 1000 : null, lastPollAdded: this.lastPollAdded, pipeline: { source: this.pipeline.source.name, reader: this.pipeline.reader.name, model: this.pipeline.model.name, sinks: this.pipeline.sinks.map((s) => s.name) } },
    };
  }

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

  list() {
    return this.store.db.prepare('SELECT s.file_id, s.md_path, s.model, s.at, s.ms, s.src_md, f.name, f.path, f.md_path AS file_md, f.kind, f.slide_count, substr(s.summary, 1, 400) AS preview FROM doc_summaries s LEFT JOIN files f ON f.id = s.file_id ORDER BY s.at DESC').all();
  }

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

  close() { clearInterval(this.timer); if (this.abort) this.abort.abort(); }
}

module.exports = { PptAgentHarness, SummaryPlugin: PptAgentHarness, PLUGINS, defaultPipeline };
