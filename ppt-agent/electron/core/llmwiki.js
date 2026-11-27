'use strict';
// LLMWiki 炼丹（v3.13）：按业界 LLM Wiki 模式（Karpathy “LLM Wiki”：raw sources → wiki → schema）把已解析入库的资料
// “炼”成一个持续维护、可互相链接的 Markdown 知识库，而不是每次提问都从原始资料重新检索（RAG）。
//   原始资料层（raw）：资料库数据库中已解析的文档（files / slides / doc_summaries）与解析 Markdown——只读，从不修改；
//   Wiki 层：数据目录 llmwiki/ 下的 Markdown 页面（资料页 sources/、概念页 concepts/、标签页 tags/、分类页 topics/、
//            问答页 queries/、总目录 index.md、操作日志 log.md），用 [[路径|标题]] 互相链接（可直接用 Obsidian 打开）；
//   规则层（schema）：llmwiki/schema.md，说明页面结构、命名与维护规则；炼丹时作为提示词的一部分交给大模型。
// 三个操作：
//   炼丹（ingest）：逐个吸收新增 / 变化的文档 → 写资料页，并更新涉及的概念 / 标签 / 分类页、总目录与日志（增量，按文档指纹）；
//   问答（query）：先读总目录挑选相关页面，再基于这些页面作答（大模型可用时由大模型综合，否则离线摘录），可把答案存为新页面；
//   体检（lint）：资料已更新 / 已移出资料库、未炼化的文档、断开的链接、孤立页面、只有一个来源的概念，并可一键修复。
// 大模型只经 service.ai（AiGateway）；没有可用的大模型（单机版默认）时全部用离线规则完成（摘录式摘要 + 词表概念）。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const glossary = require('./glossary');
const { ticker } = require('./yieldy');

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS wiki_sources (
  file_id INTEGER PRIMARY KEY, fp TEXT, slug TEXT, title TEXT, summary TEXT, points TEXT, concepts TEXT, extra TEXT,
  tags TEXT, category TEXT, kind TEXT, path TEXT, engine TEXT, at INTEGER
);
CREATE TABLE IF NOT EXISTS wiki_queries (id INTEGER PRIMARY KEY AUTOINCREMENT, q TEXT, answer TEXT, pages TEXT, engine TEXT, slug TEXT, at INTEGER);
CREATE TABLE IF NOT EXISTS wiki_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, op TEXT, title TEXT, detail TEXT);
`;

const DEFAULT_SCHEMA = `# LLM Wiki 规则（schema）

本 Wiki 由 PPT智能体 从资料库中已解析的文档“炼”成，遵循 LLM Wiki 模式：原始资料（raw）只读 → Wiki 页面由程序 / 大模型维护 → 本文件规定结构与规则。可以修改本文件，下次炼丹时生效（大模型模式下会作为提示词的一部分）。

## 目录结构
- \`index.md\`：总目录，列出全部页面与一句话概要（问答时先读它挑选页面）
- \`log.md\`：按时间追加的操作日志（\`## [日期] 操作 | 标题\`）
- \`sources/\`：资料页，每个原始文档一页（一句话概要、要点、涉及概念、相关资料、原始资料位置）
- \`concepts/\`：概念页，领域词表中的概念与大模型提取的实体，汇总所有提到它的资料
- \`tags/\`：标签页（至少 3 份资料使用的标签）
- \`topics/\`：分类页（资料库的内容分类）
- \`queries/\`：问答页（问答结果“存为页面”后归档，成为知识的一部分）

## 页面规则
1. 每页开头是 YAML front matter（type、来源、更新时间），然后是一级标题。
2. 页面之间用 \`[[目录/页面|显示名]]\` 链接；资料页必须链接到它涉及的概念页，概念页必须链回资料页。
3. 只依据原始资料的内容写作，不编造；有冲突时在概念页“不同说法”中并列写出并注明来源。
4. 一句话概要不超过 60 字；要点 3~10 条，每条不超过 40 字。
5. 原始资料从不修改；文档更新后重新炼化对应资料页，并更新相关概念页。
`;

const GENERIC_TITLES = /^(目录|目 录|contents?|agenda|谢谢|thanks?|thank you|q ?& ?a|问答|附录|appendix|封面|结束|the end|\d+)$/i;
const ATTR_TAG = /^(黑底|白底|含视频|有讲解词|无讲解词|PPT|Word|PDF|文档|\d+页)$/;

const md5 = (s) => crypto.createHash('md5').update(String(s)).digest('hex');
const J = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const esc = (s) => String(s || '').replace(/[|\]\[]/g, ' ').trim();
const link = (slug, title) => `[[${slug}|${esc(title) || slug}]]`;
const safeName = (s) => String(s || '').replace(/[\\/:*?"<>|#^[\]\s]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'x';
const dateStr = (t = Date.now()) => { const d = new Date(t); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };

/** 检索用的词：词表同义词 + 中文二元组 + 英文单词 */
function terms(text) {
  const t = String(text || '').toLowerCase();
  const out = new Set();
  for (const f of glossary.findConcepts(t)) { out.add('c:' + f.concept.id); }
  for (const w of t.match(/[a-z][a-z0-9-]{1,}/g) || []) out.add(w);
  for (const seg of t.match(/[一-鿿]+/g) || []) {
    if (seg.length <= 2) out.add(seg);
    for (let i = 0; i + 2 <= seg.length; i++) out.add(seg.slice(i, i + 2));
  }
  return out;
}

class LlmWiki {
  constructor(service) {
    this.svc = service;
    this.job = null; // { op, done, total, label, started, cancel }
    this.inited = false;
  }

  get dir() { return path.join(this.svc.dataDir, 'llmwiki'); }
  get db() { return this.svc.store.db; }
  cfg() { return { useAi: false, scopes: [], ...(this.svc.config.llmwiki || {}) }; }
  setConfig(patch = {}) { this.svc.setConfig({ llmwiki: { ...this.cfg(), ...patch } }); return this.state(); }

  init() {
    if (this.inited) return;
    this.db.exec(SCHEMA_SQL);
    for (const d of ['', 'sources', 'concepts', 'tags', 'topics', 'queries']) fs.mkdirSync(path.join(this.dir, d), { recursive: true });
    if (!fs.existsSync(this.schemaFile)) fs.writeFileSync(this.schemaFile, DEFAULT_SCHEMA, 'utf8');
    this.inited = true;
  }
  get schemaFile() { return path.join(this.dir, 'schema.md'); }
  schema() { this.init(); try { return fs.readFileSync(this.schemaFile, 'utf8'); } catch { return DEFAULT_SCHEMA; } }
  saveSchema(text) { this.init(); fs.writeFileSync(this.schemaFile, String(text || '').trim() ? String(text) : DEFAULT_SCHEMA, 'utf8'); this.log('schema', '修改规则', ''); return this.schema(); }

  /** 是否用大模型：设置中打开且 AI 调用模块可用 */
  aiOn() { return !!this.cfg().useAi && this.svc.ai && this.svc.ai.can('summarize'); }

  log(op, title, detail) {
    this.init();
    const at = Date.now();
    this.db.prepare('INSERT INTO wiki_log(at, op, title, detail) VALUES (?, ?, ?, ?)').run(at, op, title, detail || '');
    const OP = { ingest: '炼丹', query: '问答', lint: '体检', fix: '修复', schema: '规则', rebuild: '重建' };
    fs.appendFileSync(path.join(this.dir, 'log.md'), `${fs.existsSync(path.join(this.dir, 'log.md')) ? '' : '# 操作日志\n\n'}## [${dateStr(at)}] ${OP[op] || op} | ${title}\n${detail ? detail + '\n' : ''}\n`, 'utf8');
  }
  logs(limit = 500) { this.init(); return this.db.prepare('SELECT * FROM wiki_log ORDER BY id DESC LIMIT ?').all(limit); }

  emit() { this.svc.emit('wiki', this.state()); }

  /** 范围内可炼化的文档：已解析、未在回收站（scopes = 任务 id，空 = 全部资料库） */
  candidates() {
    const scopes = (this.cfg().scopes || []).map(Number).filter(Boolean);
    let rows;
    if (scopes.length) {
      const ph = scopes.map(() => '?').join(',');
      rows = this.db.prepare(`SELECT DISTINCT f.id, f.fingerprint, f.parsed_at FROM files f JOIN task_files tf ON tf.file_id = f.id JOIN tasks t ON t.id = tf.task_id WHERE f.status = 'parsed' AND (t.id IN (${ph}) OR t.parent_id IN (${ph}))`).all(...scopes, ...scopes);
    } else rows = this.db.prepare("SELECT id, fingerprint, parsed_at FROM files WHERE status = 'parsed'").all();
    return rows.map((r) => ({ id: r.id, fp: `${r.fingerprint || ''}|${r.parsed_at || 0}` }));
  }

  state() {
    this.init();
    const c = this.cfg();
    const n = (sql, ...a) => this.db.prepare(sql).get(...a).n;
    const cand = this.candidates();
    const have = new Map(this.db.prepare('SELECT file_id, fp FROM wiki_sources').all().map((r) => [r.file_id, r.fp]));
    const pending = cand.filter((x) => have.get(x.id) !== x.fp).length;
    const ai = this.svc.ai ? this.svc.ai.engine() : { ok: false };
    return {
      dir: this.dir, config: c, ai: { ok: !!ai.ok, model: ai.model || '', reason: ai.reason || '' }, aiOn: this.aiOn(),
      counts: { sources: n('SELECT COUNT(*) n FROM wiki_sources'), candidates: cand.length, pending, queries: n('SELECT COUNT(*) n FROM wiki_queries'), concepts: this.countDir('concepts'), tags: this.countDir('tags'), topics: this.countDir('topics'), logs: n('SELECT COUNT(*) n FROM wiki_log') },
      lastIngest: (this.db.prepare("SELECT at FROM wiki_log WHERE op = 'ingest' ORDER BY id DESC LIMIT 1").get() || {}).at || null,
      job: this.job ? { op: this.job.op, done: this.job.done, total: this.job.total, label: this.job.label, started: this.job.started, eta: this.eta() } : null,
    };
  }
  countDir(d) { try { return fs.readdirSync(path.join(this.dir, d)).filter((n) => n.endsWith('.md')).length; } catch { return 0; } }
  eta() {
    const j = this.job;
    if (!j || !j.done || Date.now() - j.started < 5000) return { remainingMs: null, elapsedMs: j ? Date.now() - j.started : 0 };
    const per = (Date.now() - j.started) / j.done;
    return { remainingMs: Math.round(per * (j.total - j.done)), elapsedMs: Date.now() - j.started, rate: j.done / ((Date.now() - j.started) / 1000) };
  }
  progress(done, total, label, force = false) {
    const j = this.job;
    if (!j) return;
    j.done = done; j.total = total; if (label) j.label = label;
    if (force || Date.now() - (j.lastEmit || 0) > 400) { j.lastEmit = Date.now(); this.emit(); }
  }
  cancel() { if (this.job) this.job.cancel = true; return this.state(); }

  // ---------- 炼丹（ingest） ----------
  /** 吸收新增 / 变化的文档（force = 全部重新炼化；ids = 只炼这些文档） */
  async ingest({ force = false, ids = null } = {}) {
    this.init();
    if (this.job) throw new Error('炼丹正在进行中');
    const cand = this.candidates();
    const have = new Map(this.db.prepare('SELECT file_id, fp FROM wiki_sources').all().map((r) => [r.file_id, r.fp]));
    const want = ids ? new Set(ids.map(Number)) : null;
    const todo = cand.filter((x) => (want ? want.has(x.id) : force || have.get(x.id) !== x.fp));
    this.job = { op: 'ingest', done: 0, total: todo.length, label: '吸收资料', started: Date.now() };
    this.emit();
    const useAi = this.aiOn();
    const schema = this.schema();
    const touched = { concepts: new Set(), tags: new Set(), topics: new Set() };
    let ok = 0, failed = 0, aiUsed = 0;
    const tk = ticker();
    const upsert = this.db.prepare('INSERT OR REPLACE INTO wiki_sources(file_id, fp, slug, title, summary, points, concepts, extra, tags, category, kind, path, engine, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    try {
      for (let i = 0; i < todo.length; i++) {
        if (this.job.cancel) break;
        const p = tk(); if (p) await p;
        const x = todo[i];
        try {
          const old = this.db.prepare('SELECT concepts, extra, tags, category FROM wiki_sources WHERE file_id = ?').get(x.id);
          if (old) this.markTouched(touched, old);
          const s = await this.digest(x.id, { useAi, schema });
          if (!s) continue;
          if (s.engine !== '离线提取') aiUsed++;
          upsert.run(x.id, x.fp, s.slug, s.title, s.summary, JSON.stringify(s.points), JSON.stringify(s.concepts), JSON.stringify({ entities: s.entities }), JSON.stringify(s.tags), s.category || '', s.kind, s.path, s.engine, Date.now());
          this.markTouched(touched, { concepts: JSON.stringify(s.concepts), extra: JSON.stringify({ entities: s.entities }), tags: JSON.stringify(s.tags), category: s.category });
          ok++;
        } catch (e) { failed++; this.svc.log.warn(`[LLMWiki] 炼化文档 #${x.id} 失败：${e.message}`); }
        this.progress(i + 1, todo.length, '吸收资料');
      }
      // 资料已不在范围内（移出资料库 / 回收站）：删除资料页
      const live = new Set(cand.map((x) => x.id));
      const gone = this.db.prepare('SELECT file_id, slug, concepts, extra, tags, category FROM wiki_sources').all().filter((r) => !live.has(r.file_id));
      if (!ids) for (const g of gone) this.removeSource(g, touched);
      await this.compile({ touched, full: force });
      const cancelled = !!this.job.cancel;
      const detail = `新增 / 更新 ${ok} 份资料${failed ? `，失败 ${failed} 份` : ''}${!ids && gone.length ? `，移除 ${gone.length} 份已不在资料库的资料` : ''}；更新概念页 ${touched.concepts.size} 个、标签页 ${touched.tags.size} 个、分类页 ${touched.topics.size} 个；${useAi ? `大模型炼化 ${aiUsed} 份` : '离线提取'}${cancelled ? '（已中止）' : ''}`;
      if (ok || failed || gone.length || force) this.log('ingest', force ? '全部重新炼化' : ids ? `炼化 ${ids.length} 份资料` : '增量炼化', detail);
      this.svc.log.info(`[LLMWiki] ${detail}（${Date.now() - this.job.started}ms）`);
      return { ok, failed, removed: ids ? 0 : gone.length, cancelled, touched: { concepts: touched.concepts.size, tags: touched.tags.size, topics: touched.topics.size } };
    } finally { this.job = null; this.emit(); }
  }

  markTouched(t, r) {
    for (const c of J(r.concepts, [])) t.concepts.add('c-' + c);
    for (const e of J(r.extra, {}).entities || []) t.concepts.add('e-' + md5(e).slice(0, 10));
    for (const g of J(r.tags, [])) t.tags.add(g);
    if (r.category) t.topics.add(r.category);
  }
  removeSource(g, touched) {
    this.markTouched(touched, g);
    this.db.prepare('DELETE FROM wiki_sources WHERE file_id = ?').run(g.file_id);
    fs.rmSync(path.join(this.dir, g.slug + '.md'), { force: true });
    this.cache = null;
  }

  /** 读取一个文档，得到资料页的内容（大模型或离线规则） */
  async digest(fileId, { useAi, schema }) {
    const f = this.svc.store.getFile(fileId);
    if (!f) return null;
    const slides = this.db.prepare('SELECT idx, title, text, notes FROM slides WHERE file_id = ? ORDER BY idx').all(fileId);
    const full = slides.map((s) => `${s.title || ''}\n${s.text || ''}\n${s.notes || ''}`).join('\n');
    const titleText = slides.map((s) => s.title || '').join('\n');
    // 概念：词表命中（出现 ≥ 2 次或出现在页标题中），按出现次数排序
    const inTitle = new Set(glossary.findConcepts(titleText).map((c) => c.concept.id));
    const concepts = glossary.findConcepts(full).filter((c) => c.concept.cat !== '通用办公' && (c.count >= 2 || inTitle.has(c.concept.id))).sort((a, b) => b.count - a.count).slice(0, 15).map((c) => c.concept.id);
    const tags = (f.tags || []).filter((t) => t && !ATTR_TAG.test(t)).slice(0, 12);
    const title = clip(f.title || (slides[0] && slides[0].title) || f.name.replace(/\.[^.]+$/, ''), 80);
    let summary = '', points = [], entities = [], engine = '离线提取';
    if (useAi) {
      const r = await this.svc.ai.run('wikiIngest', { schema, file: { name: f.name, path: f.path }, pages: slides.map((s) => ({ idx: s.idx, title: s.title, text: clip(s.text, 1500), notes: clip(s.notes, 800) })) }, { timeoutMs: 180000 });
      const j = r.ok ? require('./ai').parseJson(r.text) : null;
      if (j && j.summary) {
        summary = clip(j.summary, 120);
        points = (Array.isArray(j.points) ? j.points : []).map((p) => clip(p, 80)).filter(Boolean).slice(0, 10);
        entities = (Array.isArray(j.entities) ? j.entities : Array.isArray(j.concepts) ? j.concepts : []).map((e) => clip(typeof e === 'string' ? e : e && e.name, 30)).filter((e) => e && !glossary.expandTerm(e)).slice(0, 10);
        engine = r.engine === 'fake' ? '本地测试替身' : (this.svc.ai.engine().model || '大模型');
      }
    }
    if (!summary) {
      // 优先用 PPT_Agent 已生成的文档总结，其次摘录
      const ds = this.db.prepare('SELECT summary FROM doc_summaries WHERE file_id = ?').get(fileId);
      const sec = (name) => { const m = ds && ds.summary && ds.summary.match(new RegExp(`##\\s*${name}[^\\n]*\\n([\\s\\S]*?)(?=\\n##\\s|$)`)); return m ? m[1].trim() : ''; };
      if (ds && ds.summary) {
        summary = clip(sec('一句话概要').split('\n')[0], 120);
        points = sec('核心要点').split('\n').map((l) => l.replace(/^[-*\d.、\s]+/, '').trim()).filter(Boolean).slice(0, 10).map((p) => clip(p, 80));
        if (summary) engine = 'PPT_Agent 文档总结';
      }
      if (!summary) {
        const sentences = slides.flatMap((s) => String(s.text || '').split(/[。！？\n]|[.!?]\s/)).map((x) => x.trim()).filter((x) => x.length >= 12 && x.length <= 120 && !/^\d/.test(x));
        const cname = concepts.slice(0, 3).map((id) => glossary.concepts[id].zh[0]);
        summary = clip(`${title}${sentences[0] ? '：' + sentences[0] : cname.length ? `：涉及${cname.join('、')}` : ''}`, 120);
      }
      if (!points.length) {
        const seen = new Set();
        for (const s of slides) {
          const t = clip(s.title, 60);
          if (!t || GENERIC_TITLES.test(t) || seen.has(t) || t === title) continue;
          seen.add(t); points.push(t);
          if (points.length >= 10) break;
        }
      }
    }
    return { slug: `sources/${safeName(f.name.replace(/\.[^.]+$/, ''))}-${fileId}`, title, summary, points, concepts, entities, tags, category: f.category || '', kind: f.kind || 'ppt', path: f.path, md: f.md_path, pages: slides.length, engine, file: f };
  }

  /** 由数据表生成 / 更新页面：资料页（相关资料）、概念页、标签页、分类页、总目录 */
  async compile({ touched = null, full = false } = {}) {
    this.init();
    const tk = ticker();
    const rows = this.db.prepare('SELECT * FROM wiki_sources').all().map((r) => ({ ...r, points: J(r.points, []), concepts: J(r.concepts, []), entities: J(r.extra, {}).entities || [], tags: J(r.tags, []) }));
    const byId = new Map(rows.map((r) => [r.file_id, r]));
    // 倒排：概念 / 实体 / 标签 / 分类 → 资料
    const post = new Map(), tagPost = new Map(), topicPost = new Map();
    const add = (m, k, v) => { if (!m.has(k)) m.set(k, []); m.get(k).push(v); };
    const entName = new Map();
    for (const r of rows) {
      for (const c of r.concepts) add(post, 'c-' + c, r.file_id);
      for (const e of r.entities) { const k = 'e-' + md5(e).slice(0, 10); entName.set(k, e); add(post, k, r.file_id); }
      for (const t of r.tags) add(tagPost, t, r.file_id);
      if (r.category) add(topicPost, r.category, r.file_id);
    }
    const tagOk = new Map([...tagPost].filter(([, v]) => v.length >= 3).sort((a, b) => b[1].length - a[1].length).slice(0, 400));
    const conceptSlug = (k) => (k.startsWith('c-') ? `concepts/${safeName(glossary.concepts[Number(k.slice(2))].zh[0])}-${k.slice(2)}` : `concepts/${safeName(entName.get(k))}-${k.slice(2)}`);
    const conceptTitle = (k) => (k.startsWith('c-') ? glossary.concepts[Number(k.slice(2))].label : entName.get(k));
    const tagSlug = (t) => `tags/${safeName(t)}-${md5(t).slice(0, 6)}`;
    const topicSlug = (t) => `topics/${safeName(t)}`;
    const conceptKeys = (r) => [...r.concepts.map((c) => 'c-' + c), ...r.entities.map((e) => 'e-' + md5(e).slice(0, 10))];
    // 资料页：相关资料 = 共享概念最多的资料（每个概念最多看 300 份，避免常见概念两两比较）
    const sourceIds = full || !touched ? rows.map((r) => r.file_id) : rows.filter((r) => conceptKeys(r).some((k) => touched.concepts.has(k)) || r.tags.some((t) => touched.tags.has(t))).map((r) => r.file_id);
    const total = sourceIds.length + post.size + tagOk.size + topicPost.size;
    let done = 0;
    for (const id of sourceIds) {
      const p = tk(); if (p) await p;
      const r = byId.get(id);
      const score = new Map();
      for (const k of conceptKeys(r)) {
        const lst = post.get(k) || [];
        const w = 1 / Math.log2(2 + lst.length);
        for (const o of lst.length > 300 ? lst.slice(0, 300) : lst) if (o !== id) score.set(o, (score.get(o) || 0) + w);
      }
      const related = [...score].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([o]) => byId.get(o));
      this.writeSource(r, { related, conceptSlug, conceptTitle, tagSlug, tagOk, topicSlug, conceptKeys });
      if (++done % 64 === 0) this.progress(done, total, '更新资料页');
    }
    // 概念页
    const writeAll = full || !touched;
    for (const [k, lst] of post) {
      const p = tk(); if (p) await p;
      done++;
      if (!writeAll && !touched.concepts.has(k)) continue;
      this.writeConcept(k, lst.map((i) => byId.get(i)), { conceptSlug, conceptTitle, post, byId, conceptKeys });
      if (done % 64 === 0) this.progress(done, total, '更新概念页');
    }
    // 标签页 / 分类页
    for (const [t, lst] of tagOk) {
      const p = tk(); if (p) await p;
      done++;
      if (!writeAll && !touched.tags.has(t)) continue;
      this.writeList(tagSlug(t), 'tag', `标签：${t}`, lst.map((i) => byId.get(i)));
    }
    for (const [t, lst] of topicPost) {
      const p = tk(); if (p) await p;
      done++;
      if (!writeAll && !touched.topics.has(t)) continue;
      this.writeList(topicSlug(t), 'topic', `分类：${t}`, lst.map((i) => byId.get(i)), { conceptSlug, conceptTitle, conceptKeys });
    }
    // 删除不再有来源的概念 / 标签 / 分类页
    const keep = new Set([...[...post.keys()].map(conceptSlug), ...[...tagOk.keys()].map(tagSlug), ...[...topicPost.keys()].map(topicSlug)]);
    for (const d of ['concepts', 'tags', 'topics']) for (const n of this.listDir(d)) if (!keep.has(`${d}/${n.replace(/\.md$/, '')}`)) { fs.rmSync(path.join(this.dir, d, n), { force: true }); this.cache = null; }
    this.progress(total, total, '更新总目录', true);
    this.writeIndex(rows, { post, tagOk, topicPost, conceptSlug, conceptTitle, tagSlug, topicSlug });
  }
  listDir(d) { try { return fs.readdirSync(path.join(this.dir, d)).filter((n) => n.endsWith('.md')); } catch { return []; } }

  write(slug, text) { this.cache = null; const p = path.join(this.dir, slug + '.md'); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text, 'utf8'); }
  front(o) { return `---\n${Object.entries(o).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${k}: ${String(v).replace(/\n/g, ' ')}`).join('\n')}\n---\n\n`; }

  writeSource(r, ctx) {
    const cks = ctx.conceptKeys(r);
    const lines = [this.front({ type: 'source', file_id: r.file_id, file: r.path, kind: r.kind, category: r.category, engine: r.engine, updated: dateStr(r.at) }), `# ${r.title}\n`, `> ${r.summary}\n`];
    if (r.points.length) lines.push('## 要点\n', ...r.points.map((p) => `- ${p}`), '');
    if (cks.length) lines.push('## 涉及概念\n', cks.map((k) => link(ctx.conceptSlug(k), ctx.conceptTitle(k))).join(' · '), '');
    const tg = r.tags.filter((t) => ctx.tagOk.has(t));
    if (tg.length || r.category) lines.push('## 分类与标签\n', [r.category ? link(ctx.topicSlug(r.category), r.category) : '', ...tg.map((t) => link(ctx.tagSlug(t), '#' + t))].filter(Boolean).join(' · '), '');
    if (ctx.related.length) lines.push('## 相关资料\n', ...ctx.related.map((o) => `- ${link(o.slug, o.title)}：${clip(o.summary, 60)}`), '');
    lines.push('## 原始资料\n', `- 原文件：\`${r.path}\``, '');
    this.write(r.slug, lines.join('\n'));
  }

  writeConcept(k, srcs, ctx) {
    const isG = k.startsWith('c-');
    const c = isG ? glossary.concepts[Number(k.slice(2))] : null;
    // 相关概念：与本概念同时出现最多的概念
    const co = new Map();
    for (const s of srcs.slice(0, 500)) for (const o of ctx.conceptKeys(s)) if (o !== k) co.set(o, (co.get(o) || 0) + 1);
    const rel = [...co].sort((a, b) => b[1] - a[1]).slice(0, 10);
    const lines = [this.front({ type: 'concept', key: k, category: c ? c.cat : '大模型提取', sources: srcs.length, updated: dateStr() }), `# ${ctx.conceptTitle(k)}\n`];
    if (c) lines.push(`- 分类：${c.cat}`, `- 同义词：${[...c.zh, ...c.en].join('、')}`, '');
    lines.push(`## 提到它的资料（${srcs.length}）\n`, ...srcs.slice(0, 300).map((s) => `- ${link(s.slug, s.title)}：${clip(s.summary, 60)}`), srcs.length > 300 ? `- ……另有 ${srcs.length - 300} 份` : '', '');
    if (rel.length) lines.push('## 相关概念\n', rel.map(([o, n]) => `${link(ctx.conceptSlug(o), ctx.conceptTitle(o))}（${n}）`).join(' · '), '');
    this.write(ctx.conceptSlug(k), lines.join('\n'));
  }

  writeList(slug, type, title, srcs, ctx = null) {
    const lines = [this.front({ type, sources: srcs.length, updated: dateStr() }), `# ${title}\n`];
    if (ctx) {
      const cnt = new Map();
      for (const s of srcs) for (const k of ctx.conceptKeys(s)) cnt.set(k, (cnt.get(k) || 0) + 1);
      const top = [...cnt].sort((a, b) => b[1] - a[1]).slice(0, 15);
      if (top.length) lines.push('## 主要概念\n', top.map(([k, n]) => `${link(ctx.conceptSlug(k), ctx.conceptTitle(k))}（${n}）`).join(' · '), '');
    }
    lines.push(`## 资料（${srcs.length}）\n`, ...srcs.slice(0, 500).map((s) => `- ${link(s.slug, s.title)}：${clip(s.summary, 60)}`), srcs.length > 500 ? `- ……另有 ${srcs.length - 500} 份` : '', '');
    this.write(slug, lines.join('\n'));
  }

  writeIndex(rows, ctx) {
    const qs = this.db.prepare('SELECT slug, q, answer FROM wiki_queries WHERE slug IS NOT NULL ORDER BY id DESC').all();
    const lines = [this.front({ type: 'index', updated: dateStr(), sources: rows.length, concepts: ctx.post.size }), '# 总目录\n', `资料 ${rows.length} 份 · 概念 ${ctx.post.size} 个 · 标签 ${ctx.tagOk.size} 个 · 分类 ${ctx.topicPost.size} 个 · 问答 ${qs.length} 篇 · 规则见 [[schema|schema]] · 日志见 [[log|log]]\n`];
    lines.push('## 分类\n', ...[...ctx.topicPost].sort((a, b) => b[1].length - a[1].length).map(([t, l]) => `- ${link(ctx.topicSlug(t), t)}（${l.length}）`), '');
    lines.push('## 概念\n', ...[...ctx.post].sort((a, b) => b[1].length - a[1].length).map(([k, l]) => `- ${link(ctx.conceptSlug(k), ctx.conceptTitle(k))}（${l.length}）`), '');
    lines.push('## 标签\n', [...ctx.tagOk].map(([t, l]) => `${link(ctx.tagSlug(t), '#' + t)}（${l.length}）`).join(' · '), '');
    if (qs.length) lines.push('## 问答\n', ...qs.map((q) => `- ${link(q.slug, q.q)}：${clip(String(q.answer).replace(/[#>*[\]|]/g, ' '), 60)}`), '');
    lines.push('## 资料\n', ...rows.slice().sort((a, b) => a.title.localeCompare(b.title, 'zh')).map((r) => `- ${link(r.slug, r.title)}：${clip(r.summary, 60)}`), '');
    this.write('index', lines.join('\n'));
  }

  // ---------- 浏览 ----------
  /** 页面清单（来自文件，含类型、标题、来源数、链接数、被链接数）；扫描结果缓存到下一次写入页面 */
  scan() {
    this.init();
    if (this.cache) return this.cache;
    const all = [];
    const back = new Map();
    for (const d of ['', 'sources', 'concepts', 'tags', 'topics', 'queries']) {
      for (const n of this.listDir(d)) {
        const slug = (d ? d + '/' : '') + n.replace(/\.md$/, '');
        const file = path.join(this.dir, slug + '.md');
        let text = '', st;
        try { text = fs.readFileSync(file, 'utf8'); st = fs.statSync(file); } catch { continue; }
        const links = [...new Set([...text.replace(/`[^`\n]*`/g, '').matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)].map((m) => m[1]))];
        if (slug !== 'index') for (const l of links) { if (!back.has(l)) back.set(l, []); back.get(l).push(slug); }
        const fm = (text.match(/^---\n([\s\S]*?)\n---/) || [])[1] || '';
        const field = (k) => ((fm.match(new RegExp(`^${k}: (.*)$`, 'm')) || [])[1] || '');
        all.push({ slug, type: field('type') || (d ? d.replace(/s$/, '') : slug), title: (text.match(/^# (.+)$/m) || [])[1] || slug, sources: Number(field('sources')) || (field('file_id') ? 1 : 0), links, size: st.size, mtime: Math.round(st.mtimeMs), file_id: Number(field('file_id')) || null, path: field('file') || '' });
      }
    }
    const bySlug = new Map(all.map((p) => [p.slug, p]));
    this.cache = { list: all.map((p) => ({ ...p, links: p.links.length, broken: p.links.filter((l) => !bySlug.has(l)), inbound: (back.get(p.slug) || []).length })), back, bySlug };
    return this.cache;
  }
  pages() { return this.scan().list.map(({ broken, ...p }) => ({ ...p, broken: broken.length })); }
  readPage(slug) {
    this.init();
    slug = String(slug || 'index');
    const p = path.resolve(this.dir, slug + '.md');
    if (!p.startsWith(path.resolve(this.dir) + path.sep)) throw new Error('页面不存在');
    if (!fs.existsSync(p)) return null;
    const sc = this.scan();
    const back = (sc.back.get(slug) || []).slice(0, 200).map((s) => { const x = sc.bySlug.get(s); return { slug: s, title: x ? x.title : s, type: x ? x.type : '' }; });
    return { slug, text: fs.readFileSync(p, 'utf8'), path: p, backlinks: back };
  }

  // ---------- 问答（query） ----------
  /** 先读总目录（数据表）挑选相关页面，再基于这些页面作答 */
  async query(q, { save = false, limit = 8 } = {}) {
    this.init();
    const question = String(q || '').trim();
    if (!question) throw new Error('请输入问题');
    const qt = terms(question);
    if (!qt.size) throw new Error('问题中没有可检索的词');
    const cands = [];
    const tk = ticker();
    for (const r of this.db.prepare('SELECT file_id, slug, title, summary, points, concepts, tags FROM wiki_sources').iterate()) {
      const p = tk(); if (p) await p;
      const t = terms(`${r.title}\n${r.summary}\n${J(r.points, []).join('\n')}\n${J(r.tags, []).join(' ')}`);
      for (const c of J(r.concepts, [])) t.add('c:' + c);
      let hit = 0; for (const x of qt) if (t.has(x)) hit += x.startsWith('c:') ? 3 : x.length > 2 ? 1.5 : 1;
      if (hit) cands.push({ slug: r.slug, title: r.title, type: 'source', score: hit / Math.sqrt(4 + t.size / 20), summary: r.summary, points: J(r.points, []) });
    }
    for (const x of qt) if (x.startsWith('c:')) {
      const c = glossary.concepts[Number(x.slice(2))];
      const slug = `concepts/${safeName(c.zh[0])}-${c.id}`;
      if (fs.existsSync(path.join(this.dir, slug + '.md'))) cands.push({ slug, title: c.label, type: 'concept', score: 99, summary: `${c.cat}：${[...c.zh, ...c.en].join('、')}`, points: [] });
    }
    for (const r of this.db.prepare('SELECT slug, q, answer FROM wiki_queries WHERE slug IS NOT NULL').all()) {
      const t = terms(r.q);
      let hit = 0; for (const x of qt) if (t.has(x)) hit++;
      if (hit >= Math.max(1, qt.size / 3)) cands.push({ slug: r.slug, title: r.q, type: 'query', score: hit, summary: clip(r.answer, 120), points: [] });
    }
    const pages = cands.sort((a, b) => b.score - a.score).slice(0, limit);
    let answer = '', engine = '离线摘录';
    if (pages.length && this.aiOn()) {
      const ctx = pages.map((p) => ({ slug: p.slug, title: p.title, content: this.pageText(p.slug).slice(0, 6000) }));
      const r = await this.svc.ai.run('wikiQuery', { question, schema: this.schema(), pages: ctx }, { timeoutMs: 180000 });
      if (r.ok && r.text.trim()) { answer = r.text.trim(); engine = r.engine === 'fake' ? '本地测试替身' : (this.svc.ai.engine().model || '大模型'); }
    }
    if (!answer) {
      if (!pages.length) answer = `Wiki 中没有找到与“${question}”相关的页面。可以先“炼丹”吸收更多资料。`;
      else {
        const lines = [`根据 Wiki 中最相关的 ${pages.length} 个页面：`, ''];
        for (const p of pages) {
          lines.push(`### ${link(p.slug, p.title)}`, `${p.summary}`);
          const pts = p.points.filter((x) => { const t = terms(x); for (const y of qt) if (t.has(y)) return true; return false; }).slice(0, 4);
          for (const x of pts) lines.push(`- ${x}`);
          lines.push('');
        }
        answer = lines.join('\n');
      }
    }
    const info = this.db.prepare('INSERT INTO wiki_queries(q, answer, pages, engine, at) VALUES (?, ?, ?, ?, ?)').run(question, answer, JSON.stringify(pages.map((p) => ({ slug: p.slug, title: p.title, type: p.type, score: Math.round(p.score * 100) / 100 }))), engine, Date.now());
    const id = Number(info.lastInsertRowid);
    this.log('query', question, `引用 ${pages.length} 个页面（${engine}）`);
    const res = { id, q: question, answer, engine, pages: pages.map((p) => ({ slug: p.slug, title: p.title, type: p.type, score: Math.round(p.score * 100) / 100 })) };
    if (save) res.slug = await this.saveQuery(id);
    return res;
  }
  pageText(slug) { try { return fs.readFileSync(path.join(this.dir, slug + '.md'), 'utf8').replace(/^---\n[\s\S]*?\n---\n/, ''); } catch { return ''; } }
  queries(limit = 200) { this.init(); return this.db.prepare('SELECT * FROM wiki_queries ORDER BY id DESC LIMIT ?').all(limit).map((r) => ({ ...r, pages: J(r.pages, []) })); }

  /** 把一次问答存为 Wiki 页面（queries/），并加入总目录 */
  async saveQuery(id) {
    this.init();
    const r = this.db.prepare('SELECT * FROM wiki_queries WHERE id = ?').get(id);
    if (!r) throw new Error('问答记录不存在');
    const slug = r.slug || `queries/${safeName(r.q)}-${id}`;
    const pages = J(r.pages, []);
    this.write(slug, [this.front({ type: 'query', question: r.q, engine: r.engine, updated: dateStr(r.at) }), `# ${r.q}\n`, r.answer, '', pages.length ? '## 引用页面\n' : '', ...pages.map((p) => `- ${link(p.slug, p.title)}`), ''].join('\n'));
    this.db.prepare('UPDATE wiki_queries SET slug = ? WHERE id = ?').run(slug, id);
    this.log('query', `存为页面：${r.q}`, link(slug, r.q));
    await this.compileIndexOnly();
    return slug;
  }
  deleteQueries(ids = []) {
    this.init();
    for (const id of ids) {
      const r = this.db.prepare('SELECT slug FROM wiki_queries WHERE id = ?').get(id);
      if (r && r.slug) { fs.rmSync(path.join(this.dir, r.slug + '.md'), { force: true }); this.cache = null; }
      this.db.prepare('DELETE FROM wiki_queries WHERE id = ?').run(id);
    }
    return this.compileIndexOnly();
  }
  async compileIndexOnly() { await this.compile({ touched: { concepts: new Set(), tags: new Set(), topics: new Set() } }); }

  // ---------- 体检（lint） ----------
  async lint() {
    this.init();
    const issues = [];
    const cand = new Map(this.candidates().map((x) => [x.id, x.fp]));
    const tk = ticker();
    for (const r of this.db.prepare('SELECT file_id, slug, title, fp, path FROM wiki_sources').all()) {
      const p = tk(); if (p) await p;
      if (!cand.has(r.file_id)) issues.push({ kind: 'removed', level: 'warn', slug: r.slug, title: r.title, detail: '原始资料已移出资料库 / 不在炼丹范围内', file_id: r.file_id, path: r.path });
      else if (cand.get(r.file_id) !== r.fp) issues.push({ kind: 'stale', level: 'warn', slug: r.slug, title: r.title, detail: '原始资料已重新解析，资料页需要更新', file_id: r.file_id, path: r.path });
    }
    const have = new Set(this.db.prepare('SELECT file_id FROM wiki_sources').all().map((r) => r.file_id));
    const missing = [...cand.keys()].filter((id) => !have.has(id));
    if (missing.length) issues.push({ kind: 'missing', level: 'info', slug: '', title: `${missing.length} 份资料还没有炼化`, detail: '资料库中已解析、还没有资料页', ids: missing.slice(0, 5000), count: missing.length });
    this.cache = null;
    for (const pg of this.scan().list) {
      const p = tk(); if (p) await p;
      const broken = pg.broken;
      if (broken.length) issues.push({ kind: 'broken', level: 'warn', slug: pg.slug, title: pg.title, detail: `断开的链接：${broken.slice(0, 5).join('、')}${broken.length > 5 ? ` 等 ${broken.length} 个` : ''}` });
      if (!['index', 'log', 'schema'].includes(pg.slug) && pg.inbound === 0) issues.push({ kind: 'orphan', level: 'info', slug: pg.slug, title: pg.title, detail: '孤立页面：除总目录外没有其他页面链接到它' });
      if (pg.type === 'concept' && pg.sources === 1) issues.push({ kind: 'weak', level: 'info', slug: pg.slug, title: pg.title, detail: '只有 1 份资料提到这个概念' });
    }
    const sum = issues.reduce((a, i) => ({ ...a, [i.kind]: (a[i.kind] || 0) + (i.count || 1) }), {});
    this.log('lint', '体检', Object.entries(sum).map(([k, n]) => `${LINT_LABEL[k]} ${n}`).join('，') || '没有发现问题');
    return { at: Date.now(), issues, summary: sum };
  }

  /** 修复：stale / missing → 重新炼化；removed → 删除资料页；broken / orphan → 重建页面 */
  async fix(kinds = []) {
    const k = new Set(kinds);
    const lint = await this.lint();
    let ids = [];
    if (k.has('stale')) ids.push(...lint.issues.filter((i) => i.kind === 'stale').map((i) => i.file_id));
    if (k.has('missing')) ids.push(...lint.issues.filter((i) => i.kind === 'missing').flatMap((i) => i.ids));
    const touched = { concepts: new Set(), tags: new Set(), topics: new Set() };
    if (k.has('removed')) for (const i of lint.issues.filter((x) => x.kind === 'removed')) { const g = this.db.prepare('SELECT file_id, slug, concepts, extra, tags, category FROM wiki_sources WHERE file_id = ?').get(i.file_id); if (g) this.removeSource(g, touched); }
    let r = null;
    if (ids.length) r = await this.ingest({ ids: [...new Set(ids)] });
    if (k.has('broken') || k.has('orphan') || k.has('removed')) { this.job = { op: 'rebuild', done: 0, total: 1, label: '重建页面', started: Date.now() }; try { await this.compile({ full: true }); } finally { this.job = null; this.emit(); } }
    this.log('fix', '修复', [...k].map((x) => LINT_LABEL[x]).join('、'));
    return { ingest: r, lint: await this.lint() };
  }
}

const LINT_LABEL = { removed: '已移出资料库', stale: '资料已更新', missing: '未炼化', broken: '断开的链接', orphan: '孤立页面', weak: '单一来源概念' };

module.exports = { LlmWiki, terms, DEFAULT_SCHEMA, LINT_LABEL };
