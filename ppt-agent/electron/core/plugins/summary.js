'use strict';
// 插件：智能总结（v3.5，预留）——调用设置中的大模型，为资料库中的文档各生成一份 Markdown 总结：
// 另存为单独的 .md 文件（数据目录 summaries/），内容写入 doc_summaries 表，智能搜索的“文档总结”页签与 RAG 可检索。
// 大模型调用在单独的工作线程（worker_threads）中异步执行，主进程只负责排队、读取文档内容和保存结果；
// 进度通过 'update' 事件推给界面的“智能总结”页面。单机版（不联网）时不可用。
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { Worker } = require('worker_threads');
const { client } = require('../llm');
const { OFFLINE_ONLY, OFFLINE_MSG } = require('../offline');

const isFake = () => process.env.PPTA_FAKE_LLM === '1'; // 测试用：工作线程用本地替身生成总结，不联网

const PLUGINS = [
  { id: 'summary', name: '智能总结', icon: '🧠', desc: '调用大模型为每个文档生成 Markdown 总结，另存为单独的 .md 文件，并入库供智能搜索 / RAG 检索', needsLlm: true },
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
  }

  get store() { return this.svc.store; }

  available() {
    if (isFake()) return { ok: true, model: '本地测试替身' };
    if (OFFLINE_ONLY) return { ok: false, reason: OFFLINE_MSG };
    const llm = this.svc.config.llm || {};
    if (!client(llm)) return { ok: false, reason: '请先在“设置 → 大模型与语义向量”中启用大模型接口' };
    return { ok: true, model: llm.model };
  }

  /** 把文档加入总结队列；已有总结的默认跳过（force 时重新生成） */
  start(fileIds, { force = false } = {}) {
    const av = this.available();
    if (!av.ok) throw new Error(av.reason);
    const queued = new Set(this.jobs.filter((j) => ['queued', 'running'].includes(j.status)).map((j) => j.fileId));
    const have = new Set(force ? [] : this.store.db.prepare('SELECT file_id FROM doc_summaries').all().map((r) => r.file_id));
    let added = 0, skipped = 0;
    for (const id of [...new Set(fileIds || [])]) {
      const f = this.store.getFile(id);
      if (!f || f.status !== 'parsed' || queued.has(id)) continue;
      if (have.has(id)) { skipped++; continue; }
      this.jobs.push({ id: ++this.seq, fileId: id, name: f.name, path: f.path, kind: f.kind, status: 'queued', at: Date.now() });
      added++;
    }
    this.svc.log.info(`[智能总结] 加入队列 ${added} 个文档${skipped ? `，已有总结跳过 ${skipped} 个` : ''}`);
    this.paused = false;
    this.changed();
    setImmediate(() => this.kick());
    return { added, skipped };
  }

  pause() { this.paused = true; this.changed(); }
  resume() { this.paused = false; this.changed(); setImmediate(() => this.kick()); }
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
    try { this.ensureWorker().postMessage({ type: 'job', id: j.id, name: j.name, text: this.docText(j.fileId) }); } catch (e) { this.failBusy(String(e.message || e)); }
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
      const out = path.join(this.dir, `${j.fileId}_${safeName(path.parse(j.name).name)}_总结.md`);
      fs.writeFileSync(out, m.md, 'utf8');
      const model = this.available().model || '';
      this.store.db.prepare('INSERT OR REPLACE INTO doc_summaries(file_id, md_path, summary, model, at, ms) VALUES (?,?,?,?,?,?)').run(j.fileId, out, m.md, model, Date.now(), m.ms);
      Object.assign(j, { status: 'done', mdPath: out, ms: m.ms });
      this.svc.log.info(`[智能总结] 完成：${j.name}（${m.ms}ms）→ ${out}`);
    } else {
      Object.assign(j, { status: 'failed', error: m.error, ms: m.ms });
      this.svc.log.warn(`[智能总结] 失败：${j.name}：${m.error}`);
    }
    this.changed();
    setImmediate(() => this.kick());
  }

  changed() { this.emit('update', this.state()); }

  state() {
    const c = { queued: 0, running: 0, done: 0, failed: 0, cancelled: 0 };
    for (const j of this.jobs) c[j.status] = (c[j.status] || 0) + 1;
    const total = this.store.db.prepare('SELECT COUNT(*) n FROM doc_summaries').get().n;
    return { plugins: PLUGINS, available: this.available(), paused: this.paused, counts: c, jobs: this.jobs, stored: total };
  }

  /** 已入库的总结（“已生成的总结”列表） */
  list() {
    return this.store.db.prepare('SELECT s.file_id, s.md_path, s.model, s.at, s.ms, f.name, f.path, f.kind, f.slide_count, substr(s.summary, 1, 400) AS preview FROM doc_summaries s LEFT JOIN files f ON f.id = s.file_id ORDER BY s.at DESC').all();
  }

  /** 检索总结内容（智能搜索的“文档总结”页签 / RAG）：按命中的检索词数排序 */
  search(terms, fileIds = null) {
    const list = [...new Set((terms || []).map((t) => String(t).toLowerCase()).filter((t) => t.length > 1))];
    if (!list.length) return [];
    const scope = fileIds ? new Set(fileIds) : null;
    const out = [];
    for (const r of this.store.db.prepare('SELECT s.file_id, s.md_path, s.summary, s.at, f.name, f.path, f.kind FROM doc_summaries s JOIN files f ON f.id = s.file_id WHERE f.status = \'parsed\'').all()) {
      if (scope && !scope.has(r.file_id)) continue;
      const low = r.summary.toLowerCase();
      const matched = list.filter((t) => low.includes(t));
      if (!matched.length) continue;
      const i = low.indexOf(matched[0]);
      out.push({ file_id: r.file_id, name: r.name, path: r.path, kind: r.kind, md_path: r.md_path, at: r.at, matched, score: matched.length / list.length, snippet: r.summary.slice(Math.max(0, i - 60), i + 160) });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, 100);
  }

  close() { if (this.worker) { this.worker.terminate(); this.worker = null; } }
}

module.exports = { SummaryPlugin, PLUGINS };
