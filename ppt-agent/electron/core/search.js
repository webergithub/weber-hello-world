'use strict';
// 混合检索（RAG 召回）：查询中英解析扩展 → 文件名 > 标签 > 内容 分层排序；内容层 = BM25(FTS5) + 向量召回，RRF 融合。
const glossary = require('./glossary');
const { tokenize, cut, detectLang, ZH_STOP, EN_STOP, HAS_CJK } = require('./textproc');
const { hashVector, cosine, embedder } = require('./vectors');
const llm = require('./llm');
const { ticker } = require('./yieldy');

// 检索进度的阶段（v3.8）：[key, 名称, 权重]，界面按权重显示总进度
const STAGES = [['load', '准备检索索引', 10], ['analyze', '解析查询', 5], ['meta', '文件名 / 标签匹配', 15], ['fts', '全文检索（BM25）', 10], ['vector', '向量召回', 25], ['score', '页面打分', 25], ['rank', '排序与黑白底对应', 10]];

/** 进度报告：阶段开始 / 结束、阶段内计数（限流 120ms），onProgress 收到 { pct, stage, label, done, total, elapsed, stages } */
function progressReporter(onProgress) {
  const t0 = Date.now();
  const stages = STAGES.map(([key, label, w]) => ({ key, label, w, status: 'wait', done: 0, total: 0, ms: 0, note: '' }));
  let W = stages.reduce((a, x) => a + x.w, 0);
  let cur = null, last = 0;
  const emit = (force) => {
    if (!onProgress) return;
    const now = Date.now();
    if (!force && now - last < 120) return;
    last = now;
    let p = 0;
    for (const st of stages) p += st.status === 'done' ? st.w : st.status === 'run' && st.total ? st.w * Math.min(1, st.done / st.total) : 0;
    try { onProgress({ pct: Math.round((p / W) * 100), stage: cur && cur.key, label: cur && cur.label, done: cur ? cur.done : 0, total: cur ? cur.total : 0, elapsed: now - t0, stages: stages.map(({ w, ...x }) => x) }); } catch { /* ignore */ }
  };
  return {
    start(key, total = 0, note = '') { if (cur && cur.status === 'run') this.end(); cur = stages.find((x) => x.key === key); cur.status = 'run'; cur.total = total; cur.done = 0; cur.note = note; cur.t = Date.now(); emit(true); },
    tick(done, total) { if (cur) { cur.done = done; if (total) cur.total = total; emit(false); } },
    /** 调整阶段权重：没有检索缓存时“准备检索索引”占大部分时间 */
    weight(key, w) { const st = stages.find((x) => x.key === key); if (st) { st.w = w; W = stages.reduce((a, x) => a + x.w, 0); } },
    end(note) { if (!cur) return; cur.status = 'done'; cur.ms = Date.now() - cur.t; if (cur.total) cur.done = cur.total; if (note !== undefined) cur.note = note; emit(true); },
    finish() { if (cur && cur.status === 'run') this.end(); for (const st of stages) if (st.status === 'wait') st.status = 'skip'; cur = null; if (onProgress) { const now = Date.now(); try { onProgress({ pct: 100, stage: 'done', label: '检索完成', done: 0, total: 0, elapsed: now - t0, stages: stages.map(({ w, ...x }) => x), finished: true }); } catch { /* ignore */ } } },
  };
}

const ASCII = /^[\x00-\x7f]+$/;
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function contains(hay, term) {
  if (!term) return false;
  const t = term.toLowerCase();
  if (ASCII.test(t)) {
    if (t.length <= 3) return new RegExp(`(^|[^a-z0-9])${escapeRe(t)}([^a-z0-9]|$)`, 'i').test(hay);
    return new RegExp(`(^|[^a-z])${escapeRe(t)}`, 'i').test(hay);
  }
  return hay.includes(t);
}

class SearchEngine {
  constructor(store, getConfig, log, getAi = () => null) {
    this.store = store;
    this.getConfig = getConfig;
    this.log = log;
    this.getAi = getAi; // AI 调用模块（查询扩展）
    this.cache = null;
  }

  invalidate() { this.cache = null; this.loading = null; this.gen = (this.gen || 0) + 1; this.prewarm(); }

  /** 异步加载检索索引（分页读取，不阻塞主进程） */
  /**
   * 读取检索缓存（文档 + 每页向量）。onLoad(done, total) 报告读取进度（v3.11：大资料库时“准备检索索引”不再长时间停在 0%）；
   * 同时只读一份：后台预热（prewarm）与用户检索共用同一次读取。
   */
  async loadAsync(onLoad = null) {
    if (this.cache) return this.cache;
    if (!this.loading) {
      const gen = this.gen;
      const listeners = this.loadListeners = new Set();
      const report = (d, t) => { for (const f of listeners) { try { f(d, t); } catch { /* ignore */ } } };
      this.loading = (async () => {
        const c = this.store.searchLoadCounts ? this.store.searchLoadCounts() : { files: 0, slides: 0 };
        const total = c.files + c.slides;
        const files = await this.store.listFilesAsync('parsed', (n) => report(n, total));
        const vecs = await this.store.slideVectorsAsync((n) => report(c.files + n, total));
        const cache = { files, fileMap: new Map(files.map((f) => [f.id, f])), vecs };
        if (gen === this.gen) this.cache = cache;
        return cache;
      })().finally(() => { if (gen === this.gen) this.loading = null; });
    }
    if (onLoad && this.loadListeners) this.loadListeners.add(onLoad);
    return this.loading;
  }

  /** 资料库变化后在后台预先读取检索缓存，下一次检索不用等待 */
  prewarm(delayMs = 3000) {
    clearTimeout(this.prewarmTimer);
    this.prewarmTimer = setTimeout(() => { if (!this.cache) this.loadAsync().catch(() => {}); }, delayMs);
    if (this.prewarmTimer.unref) this.prewarmTimer.unref();
  }

  load() {
    if (this.cache) return this.cache;
    const files = this.store.listFiles({ status: 'parsed' });
    const vecs = this.store.slideVectors();
    this.cache = { files, fileMap: new Map(files.map((f) => [f.id, f])), vecs };
    return this.cache;
  }

  /** 查询解析：拆分关键词，中英互译，形成"同义词组" */
  async analyze(q, { useLlm = true } = {}) {
    const raw = String(q || '').trim();
    const groups = [];
    const addGroup = (term, source, required = true) => {
      term = term.trim();
      if (!term) return;
      const lower = term.toLowerCase();
      if (groups.some((g) => g.synonyms.includes(lower))) return;
      const exp = glossary.expandTerm(term);
      const syn = new Set([lower]);
      if (exp) for (const s of exp.synonyms) syn.add(s.toLowerCase());
      groups.push({ term, synonyms: [...syn], source: exp ? 'glossary' : source, concept: exp ? exp.concept.label : null, required });
    };
    // 中文片段：先最长匹配词表术语，其余用 jieba 分词
    const chunks = raw.split(/[\s,，;；、/|]+/).filter(Boolean);
    const enText = chunks.filter((c) => !HAS_CJK.test(c)).join(' ').toLowerCase();
    let enRest = ' ' + enText.replace(/[^a-z0-9\-+# ]/g, ' ') + ' ';
    for (const ph of glossary.enPhrases) {
      if (enRest.includes(' ' + ph + ' ')) { addGroup(ph, 'glossary'); enRest = enRest.replace(' ' + ph + ' ', ' '); }
    }
    for (const w of enRest.split(/\s+/)) if (w && !EN_STOP.has(w) && (w.length > 1 || /\d/.test(w))) addGroup(w, 'raw');
    for (const c of chunks.filter((x) => HAS_CJK.test(x))) {
      let rest = c;
      for (const z of glossary.zhTerms) {
        if (z.length >= 2 && rest.includes(z)) { addGroup(z, 'glossary'); rest = rest.split(z).join(' '); }
      }
      for (const part of rest.split(/\s+/).filter(Boolean)) {
        if (!HAS_CJK.test(part)) { for (const w of part.toLowerCase().split(/[^a-z0-9\-+#]+/)) if (w && !EN_STOP.has(w)) addGroup(w, 'raw'); continue; }
        const words = cut(part).map((w) => w.trim()).filter((w) => w && HAS_CJK.test(w) && !ZH_STOP.has(w));
        if (!words.length) continue;
        for (const w of words) if (w.length >= 2 || words.length === 1) addGroup(w, 'raw');
        // 单字较多时保留原片段，避免切碎
        if (words.every((w) => w.length === 1) && part.length >= 2) addGroup(part, 'raw');
      }
    }
    let intent = '', llmUsed = false, llmError = null;
    const ai = useLlm ? this.getAi() : null;
    if (ai && raw) {
      try {
        const r = await ai.expandQuery(raw);
        if (r) {
          llmUsed = true;
          intent = r.intent || '';
          for (const kw of [...(r.zh || []), ...(r.en || [])]) {
            const k = String(kw).toLowerCase().trim();
            if (!k) continue;
            const g = groups.find((x) => x.synonyms.some((s) => s.includes(k) || k.includes(s)));
            if (g) { if (!g.synonyms.includes(k)) g.synonyms.push(k); } else addGroup(k, 'llm', false);
          }
        }
      } catch (e) { llmError = e.message; this.log.warn('大模型查询扩展失败，使用内置词表', e); }
    }
    const zh = [...new Set(groups.flatMap((g) => g.synonyms.filter((s) => HAS_CJK.test(s))))];
    const en = [...new Set(groups.flatMap((g) => g.synonyms.filter((s) => !HAS_CJK.test(s))))];
    return { raw, lang: detectLang(raw), groups, zh, en, intent, llmUsed, llmError };
  }

  coverage(hay, groups) {
    const req = groups.filter((g) => g.required);
    const list = req.length ? req : groups;
    if (!list.length) return { score: 0, matched: [] };
    const matched = list.filter((g) => g.synonyms.some((s) => contains(hay, s)));
    return { score: matched.length / list.length, matched: matched.map((g) => g.term) };
  }

  async search(q, opts = {}) {
    const t0 = Date.now();
    const P = progressReporter(opts.onProgress);
    const tk = ticker(20); // 每约 20ms 让出一次主进程，检索上万页时界面不卡
    const y = async () => { const p = tk(); if (p) await p; };
    if (!this.cache) P.weight('load', 50);
    P.start('load', 0, this.cache ? '已缓存' : '');
    const { files, fileMap, vecs } = await this.loadAsync((done, total) => { P.tick(done, total); });
    P.end(`${files.length} 个文档 · ${vecs.length} 页`);
    P.start('analyze');
    const analysis = await this.analyze(q, opts);
    const groups = analysis.groups;
    P.end(`中文词 ${analysis.zh.length} · 英文词 ${analysis.en.length}${analysis.llmUsed ? ' · 大模型扩展' : ''}`);
    const result = { analysis, files: [], slides: { light: [], dark: [], word: [], pdf: [] }, totalSlides: 0, timing: {} };
    if (!groups.length) { P.finish(); return result; }
    // opts.fileIds：只在这些文件中检索（任务范围）
    const scope = opts.fileIds ? new Set(opts.fileIds) : null;
    const filterFile = (f) => (!scope || scope.has(f.id)) && (!opts.folder || f.dir.startsWith(opts.folder)) && (!opts.category || f.category === opts.category);

    // 第 1 层：文件名；第 2 层：标签
    const fileScores = new Map();
    P.start('meta', files.length);
    let fi = 0;
    for (const f of files) {
      if ((++fi & 255) === 0) { P.tick(fi); await y(); }
      if (!filterFile(f)) continue;
      const name = `${f.name} ${f.title || ''}`.toLowerCase();
      const nameCov = this.coverage(name, groups);
      const tagHay = (f.tags || []).join(' | ').toLowerCase() + ' | ' + (f.category || '').toLowerCase();
      const tagCov = this.coverage(tagHay, groups);
      fileScores.set(f.id, { nameScore: nameCov.score, nameMatched: nameCov.matched, tagScore: tagCov.score, tagMatched: tagCov.matched, content: 0, hits: 0, pages: 0 });
    }
    result.timing.meta = Date.now() - t0;
    P.end(`${[...fileScores.values()].filter((x) => x.nameScore || x.tagScore).length} 个文档的名称或标签命中`);

    // 第 3 层：内容 —— BM25 + 哈希向量 + 可选语义向量
    const synonyms = [...new Set(groups.flatMap((g) => g.synonyms))];
    const tokens = [...new Set(synonyms.flatMap((s) => tokenize(s)))].slice(0, 80);
    const lists = [];
    P.start('fts');
    if (tokens.length) {
      const match = tokens.map((t) => `"${t.replace(/"/g, '')}"`).join(' OR ');
      lists.push({ w: 1.0, ids: this.store.ftsSearch(match, scope ? 5000 : 500).map((r) => r.id), name: 'bm25' });
    }
    P.end(`${lists.length ? lists[0].ids.length : 0} 页`);
    const qv = hashVector(synonyms.join(' '));
    const pool = scope ? vecs.filter((v) => scope.has(v.file_id)) : vecs;
    P.start('vector', pool.length);
    const hvAll = [];
    for (let i = 0; i < pool.length; i++) {
      if ((i & 511) === 0 && i) { P.tick(i); await y(); }
      const sc = cosine(qv, pool[i].vec);
      if (sc > 0.08) hvAll.push({ id: pool[i].id, s: sc });
    }
    const hv = hvAll.sort((a, b) => b.s - a.s).slice(0, 400);
    lists.push({ w: 0.7, ids: hv.map((x) => x.id), name: 'vector' });
    const emb = embedder(this.getConfig().embedding);
    if (emb && vecs.some((v) => v.emb)) {
      try {
        const [ev] = await emb.embed([analysis.raw + ' ' + synonyms.join(' ')]);
        const sv = pool.filter((v) => v.emb && v.emb.length === ev.length).map((v) => ({ id: v.id, s: cosine(ev, v.emb) })).sort((a, b) => b.s - a.s).slice(0, 400);
        lists.push({ w: 1.0, ids: sv.map((x) => x.id), name: 'semantic' });
        analysis.semantic = emb.id;
      } catch (e) { this.log.warn('语义向量检索失败，已回退', e); analysis.semanticError = e.message; }
    }
    result.timing.retrieve = Date.now() - t0;
    P.end(`${hv.length} 页`);
    const rrf = new Map();
    for (const l of lists) l.ids.forEach((id, rank) => rrf.set(id, (rrf.get(id) || 0) + l.w / (60 + rank)));
    const maxR = Math.max(1e-9, ...rrf.values());
    const candIds = [...rrf.keys()];
    const slides = this.store.getSlides(candIds);
    const scored = [];
    P.start('score', slides.length);
    let si = 0;
    for (const s of slides) {
      if ((++si & 63) === 0) { P.tick(si); await y(); }
      const f = fileMap.get(s.file_id);
      if (!f || !filterFile(f)) continue;
      if (opts.theme && s.theme !== opts.theme) continue;
      const fs_ = fileScores.get(f.id);
      const hay = `${s.title}\n${s.text}\n${s.notes}`.toLowerCase();
      const cov = this.coverage(hay, groups);
      if (!cov.score && rrf.get(s.id) / maxR < 0.35) continue;
      const score = 0.55 * (rrf.get(s.id) / maxR) + 0.3 * cov.score + 0.1 * fs_.nameScore + 0.05 * fs_.tagScore;
      scored.push({ s, f, score, cov });
      fs_.pages++; // 返回给界面的命中页数 = 该文件出现在结果中的页面数
      if (cov.score > 0) { fs_.content = Math.max(fs_.content, score); fs_.hits++; }
    }
    scored.sort((a, b) => b.score - a.score);
    P.end(`候选 ${slides.length} 页 · 命中 ${scored.length} 页`);
    P.start('rank');

    // 文件分层排序
    const ranked = [];
    for (const [id, sc] of fileScores) {
      const tier = sc.nameScore > 0 ? 1 : sc.tagScore > 0 ? 2 : sc.content > 0 ? 3 : 0;
      if (!tier) continue;
      const tierScore = tier === 1 ? sc.nameScore : tier === 2 ? sc.tagScore : sc.content;
      ranked.push({ file: fileMap.get(id), tier, tierLabel: ['', '文件名命中', '标签命中', '内容命中'][tier], nameScore: sc.nameScore, tagScore: sc.tagScore,
        contentScore: Math.round(sc.content * 1000) / 1000, hits: sc.pages, matched: [...new Set([...sc.nameMatched, ...sc.tagMatched])],
        sort: tier * -10 + tierScore * 2 + sc.content + Math.min(sc.hits, 10) * 0.01 });
    }
    ranked.sort((a, b) => b.sort - a.sort);
    result.files = ranked.slice(0, opts.fileLimit || 200);

    // 页面推荐：附带备注讲解词与 黑/白底 对应页；返回全部命中页（界面按文件筛选时与“命中 N 页”一致，全部结果分批显示）
    const limit = opts.slideLimit || 3000;
    const light = [], dark = [], word = [], pdf = [];
    for (const x of scored) {
      const target = x.f.kind === 'word' ? word : x.f.kind === 'pdf' ? pdf : x.s.theme === 'dark' ? dark : light;
      if (target.length < limit) target.push(x);
    }
    const all = [...light, ...dark, ...word, ...pdf];
    const cp = this.store.counterparts(all.map((x) => x.s.id));
    const cpSlides = new Map(this.store.getSlides([...new Set([...cp.values()].map((c) => c.id))]).map((s) => [s.id, s]));
    const view = (x) => {
      const c = cp.get(x.s.id);
      const other = c && cpSlides.get(c.id);
      const of = other && fileMap.get(other.file_id);
      return {
        ...x.s, text: String(x.s.text || '').slice(0, 3000), notes: String(x.s.notes || '').slice(0, 3000), kind: x.f.kind || 'ppt', fileName: x.f.name, filePath: x.f.path, fileTheme: x.f.theme, score: Math.round(x.score * 1000) / 1000, matched: x.cov.matched,
        counterpart: other ? { id: other.id, theme: other.theme, idx: other.idx, title: other.title, fileName: of ? of.name : '', fileId: other.file_id, score: c.score } : null,
      };
    };
    result.slides.light = light.map(view);
    result.slides.dark = dark.map(view);
    result.slides.word = word.map(view);
    result.slides.pdf = pdf.map(view);
    result.totalSlides = scored.length;
    result.retrievers = lists.map((l) => `${l.name}:${l.ids.length}`);
    result.timing.total = Date.now() - t0;
    P.end(`${result.files.length} 个文档 · ${all.length} 页`);
    P.finish();
    return result;
  }

  async answer(q, slideIds) {
    const client = llm.client(this.getConfig().llm);
    if (!client) throw new Error(require('./offline').OFFLINE_ONLY ? require('./offline').OFFLINE_MSG : '未配置大模型，无法生成 RAG 回答（可在"设置"中配置 OpenAI 兼容接口）');
    const { fileMap } = this.load();
    const slides = this.store.getSlides(slideIds.slice(0, 8));
    const ctx = slides.map((s) => ({ file: (fileMap.get(s.file_id) || {}).name || '', idx: s.idx, title: s.title, text: s.text.slice(0, 1500), notes: (s.notes || '').slice(0, 800) }));
    const text = await client.answer(q, ctx);
    return { text, sources: slides.map((s, i) => ({ n: i + 1, id: s.id, file: ctx[i].file, idx: s.idx, title: s.title })) };
  }
}

module.exports = { SearchEngine, contains };
