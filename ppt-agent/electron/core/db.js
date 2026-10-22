'use strict';
// SQLite（node:sqlite，内置 FTS5）存储：任务、文件（含解析历史与去重指纹）、页面、全文索引、黑白底对应关系。
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dir TEXT NOT NULL,
  name TEXT,
  status TEXT DEFAULT 'pending',
  created_at INTEGER, started_at INTEGER, finished_at INTEGER,
  total INTEGER DEFAULT 0, parsed INTEGER DEFAULT 0, skipped INTEGER DEFAULT 0, duplicate INTEGER DEFAULT 0, failed INTEGER DEFAULT 0,
  message TEXT
);
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE,
  dir TEXT, name TEXT, ext TEXT,
  size INTEGER, mtime INTEGER, author TEXT, title TEXT,
  fingerprint TEXT,
  status TEXT,
  error TEXT,
  dup_of INTEGER,
  slide_count INTEGER DEFAULT 0,
  theme TEXT, dark_slides INTEGER DEFAULT 0, light_slides INTEGER DEFAULT 0,
  video_count INTEGER DEFAULT 0, notes_count INTEGER DEFAULT 0,
  lang TEXT,
  tags TEXT, category TEXT, terms TEXT,
  md_path TEXT, preview TEXT, meta TEXT,
  vec BLOB, emb BLOB,
  task_id INTEGER, parsed_at INTEGER, parse_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_files_fp ON files(fingerprint);
CREATE TABLE IF NOT EXISTS task_files (
  task_id INTEGER, file_id INTEGER, path TEXT, action TEXT, message TEXT, at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tf_task ON task_files(task_id);
CREATE TABLE IF NOT EXISTS slides (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  idx INTEGER, title TEXT, text TEXT, notes TEXT, md TEXT,
  theme TEXT, bg TEXT, hidden INTEGER, section TEXT,
  has_video INTEGER, media TEXT, layout TEXT, thumb TEXT,
  vec BLOB, emb BLOB
);
CREATE INDEX IF NOT EXISTS idx_slides_file ON slides(file_id);
CREATE VIRTUAL TABLE IF NOT EXISTS slides_fts USING fts5(title, body, notes, meta, tokenize = 'unicode61 remove_diacritics 2');
CREATE TABLE IF NOT EXISTS pairs (slide_id INTEGER, other_id INTEGER, score REAL, PRIMARY KEY (slide_id, other_id));
CREATE TABLE IF NOT EXISTS notes_kb (path TEXT, idx INTEGER, variant TEXT, lang TEXT, text TEXT, source TEXT, written_back INTEGER DEFAULT 0, at INTEGER, PRIMARY KEY (path, idx, variant, lang));
CREATE TABLE IF NOT EXISTS slide_links (slide_id INTEGER, other_id INTEGER, score REAL, kind TEXT, reasons TEXT, PRIMARY KEY (slide_id, other_id));
CREATE TABLE IF NOT EXISTS file_views (file_id INTEGER, kind TEXT, at INTEGER);
CREATE INDEX IF NOT EXISTS idx_views_file ON file_views(file_id);
CREATE TABLE IF NOT EXISTS search_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT, q TEXT, task_id INTEGER, use_llm INTEGER, at INTEGER, ms INTEGER,
  files INTEGER, light INTEGER, dark INTEGER, word INTEGER, status TEXT, error TEXT
);
CREATE TABLE IF NOT EXISTS convert_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, ms INTEGER, out_path TEXT, slides INTEGER, to_light INTEGER, to_dark INTEGER, keep INTEGER,
  sources TEXT, size INTEGER, verify_ok INTEGER, verify_total INTEGER, file_id INTEGER, result TEXT
);
CREATE TABLE IF NOT EXISTS recycle (
  id INTEGER PRIMARY KEY AUTOINCREMENT, file_id INTEGER, name TEXT, orig_path TEXT, bin_path TEXT, moved INTEGER,
  prev_status TEXT, size INTEGER, kind TEXT, slide_count INTEGER, reason TEXT, at INTEGER
);
`;

const toBlob = (v) => (v ? Buffer.from(v.buffer, v.byteOffset, v.byteLength) : null);
const fromBlob = (b) => (b && ArrayBuffer.isView(b) ? new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)) : null);
const J = (s, d = null) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

class Store {
  constructor(file) {
    this.db = new DatabaseSync(file);
    this.db.exec(SCHEMA);
    this.stmts = new Map();
    this.migrate();
  }

  migrate() {
    const cols = (t) => new Set(this.db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name));
    const f = cols('files');
    if (!f.has('kind')) this.db.exec("ALTER TABLE files ADD COLUMN kind TEXT DEFAULT 'ppt'");
    if (!f.has('atime_pre')) this.db.exec('ALTER TABLE files ADD COLUMN atime_pre INTEGER');
    if (!f.has('ctime')) this.db.exec('ALTER TABLE files ADD COLUMN ctime INTEGER');
    const t = cols('tasks');
    if (!t.has('roots')) this.db.exec('ALTER TABLE tasks ADD COLUMN roots TEXT');
    if (!t.has('deleted')) this.db.exec('ALTER TABLE tasks ADD COLUMN deleted INTEGER DEFAULT 0');
    if (!t.has('run_started')) this.db.exec('ALTER TABLE tasks ADD COLUMN run_started INTEGER');
    if (!t.has('scan_list')) this.db.exec('ALTER TABLE tasks ADD COLUMN scan_list TEXT');
    if (!t.has('watch')) this.db.exec('ALTER TABLE tasks ADD COLUMN watch INTEGER DEFAULT 0');
    if (!t.has('last_watch_at')) this.db.exec('ALTER TABLE tasks ADD COLUMN last_watch_at INTEGER');
    if (!t.has('watch_summary')) this.db.exec('ALTER TABLE tasks ADD COLUMN watch_summary TEXT');
    if (!cols('search_history').has('task_ids')) this.db.exec('ALTER TABLE search_history ADD COLUMN task_ids TEXT');
    const sl = cols('slides');
    if (!sl.has('notes_user')) this.db.exec('ALTER TABLE slides ADD COLUMN notes_user TEXT');
    if (!sl.has('md_user')) this.db.exec('ALTER TABLE slides ADD COLUMN md_user TEXT');
    if (!sl.has('notes_ai')) this.db.exec('ALTER TABLE slides ADD COLUMN notes_ai TEXT');
    if (!sl.has('kw')) this.db.exec('ALTER TABLE slides ADD COLUMN kw TEXT');
    if (!sl.has('tags')) this.db.exec('ALTER TABLE slides ADD COLUMN tags TEXT');
  }

  q(sql) {
    let s = this.stmts.get(sql);
    if (!s) { s = this.db.prepare(sql); this.stmts.set(sql, s); }
    return s;
  }

  tx(fn) {
    this.db.exec('BEGIN');
    try { const r = fn(); this.db.exec('COMMIT'); return r; } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  // ---------- 任务 ----------
  createTask(dir, name) {
    const r = this.q('INSERT INTO tasks(dir, name, status, created_at) VALUES (?, ?, ?, ?)').run(dir, name, 'pending', Date.now());
    return Number(r.lastInsertRowid);
  }
  updateTask(id, f) { this.update('tasks', id, f); }
  getTask(id) { return this.q('SELECT * FROM tasks WHERE id = ?').get(id) || null; }
  listTasks() { return this.q('SELECT * FROM tasks WHERE deleted IS NULL OR deleted = 0 ORDER BY id DESC').all(); }
  // 软删除：任务从列表移除，但解析历史保留
  deleteTask(id) { this.q('UPDATE tasks SET deleted = 1 WHERE id = ?').run(id); }

  update(table, id, f) {
    const keys = Object.keys(f);
    if (!keys.length) return;
    const vals = keys.map((k) => {
      const v = f[k];
      if (v instanceof Float32Array) return toBlob(v);
      if (ArrayBuffer.isView(v)) return v;
      if (v && typeof v === 'object') return JSON.stringify(v);
      if (typeof v === 'boolean') return v ? 1 : 0;
      return v === undefined ? null : v;
    });
    this.q(`UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...vals, id);
  }

  linkTaskFile(taskId, fileId, filePath, action, message = '') {
    this.q('INSERT INTO task_files(task_id, file_id, path, action, message, at) VALUES (?, ?, ?, ?, ?, ?)').run(taskId, fileId, filePath, action, message, Date.now());
  }
  /** 本轮（run_started 之后）已处理过的文件路径，用于断点继续 */
  handledSince(taskId, since) {
    return new Set(this.q('SELECT path FROM task_files WHERE task_id = ? AND at >= ?').all(taskId, since || 0).map((r) => r.path));
  }
  taskFiles(taskId) {
    return this.q(`SELECT tf.action, tf.message, tf.path AS link_path, tf.at, f.* FROM task_files tf LEFT JOIN files f ON f.id = tf.file_id WHERE tf.task_id = ? ORDER BY tf.rowid`).all(taskId).map(this.fileRow);
  }

  history({ limit = 5000, action, q, taskId } = {}) {
    const where = [], args = [];
    if (taskId) { where.push('tf.task_id = ?'); args.push(taskId); }
    if (action) { where.push('tf.action = ?'); args.push(action); }
    if (q) { where.push('tf.path LIKE ?'); args.push(`%${q}%`); }
    return this.db.prepare(`SELECT tf.rowid AS hid, tf.task_id, tf.file_id, tf.path, tf.action, tf.message, tf.at, t.name AS task_name,
      f.name, f.size, f.mtime, f.author, f.slide_count, f.kind, f.status, f.dup_of
      FROM task_files tf LEFT JOIN files f ON f.id = tf.file_id LEFT JOIN tasks t ON t.id = tf.task_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY tf.rowid DESC LIMIT ?`).all(...args, limit);
  }

  // ---------- 本工具内的查看 / 打开记录 ----------
  addView(fileId, kind) {
    const last = this.q('SELECT at FROM file_views WHERE file_id = ? AND kind = ? ORDER BY at DESC LIMIT 1').get(fileId, kind);
    if (kind === 'view' && last && Date.now() - last.at < 10 * 60 * 1000) return; // 10 分钟内重复浏览只记一次
    this.q('INSERT INTO file_views(file_id, kind, at) VALUES (?, ?, ?)').run(fileId, kind, Date.now());
  }
  viewStats() { return this.q("SELECT file_id, SUM(kind = 'view') views, SUM(kind = 'open') opens, MAX(at) last FROM file_views GROUP BY file_id").all(); }
  viewDaily(since) { return this.q('SELECT at, file_id FROM file_views WHERE at >= ?').all(since); }
  historyDaily(since) { return this.q('SELECT at, action, file_id FROM task_files WHERE at >= ?').all(since); }

  // ---------- 回收站 ----------
  addRecycle(r) { return Number(this.q('INSERT INTO recycle(file_id, name, orig_path, bin_path, moved, prev_status, size, kind, slide_count, reason, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(r.file_id, r.name, r.orig_path, r.bin_path, r.moved ? 1 : 0, r.prev_status, r.size, r.kind, r.slide_count, r.reason || '', Date.now()).lastInsertRowid); }
  listRecycle() { return this.q('SELECT * FROM recycle ORDER BY id DESC').all(); }
  getRecycle(id) { return this.q('SELECT * FROM recycle WHERE id = ?').get(id) || null; }
  removeRecycle(id) { this.q('DELETE FROM recycle WHERE id = ?').run(id); }
  setFilePath(id, p) { this.q('UPDATE files SET path = ? WHERE id = ?').run(p, id); }
  moveSlides(fromId, toId) { this.q('UPDATE slides SET file_id = ? WHERE file_id = ?').run(toId, fromId); }
  duplicatesOf(id) { return this.q("SELECT * FROM files WHERE dup_of = ? AND status = 'duplicate' ORDER BY id").all(id).map(this.fileRow); }

  // ---------- 文件 ----------
  fileRow = (r) => (r ? { ...r, tags: J(r.tags, []), terms: undefined, meta: J(r.meta, {}), preview: J(r.preview, null), vec: undefined, emb: undefined } : null);
  fileByPath(p) { return this.fileRow(this.q('SELECT * FROM files WHERE path = ?').get(p)); }
  fileByFingerprint(fp) { return this.fileRow(this.q("SELECT * FROM files WHERE fingerprint = ? AND status = 'parsed' ORDER BY id LIMIT 1").get(fp)); }
  getFile(id) { return this.fileRow(this.q('SELECT * FROM files WHERE id = ?').get(id)); }
  upsertFile(f) {
    const ex = this.q('SELECT id FROM files WHERE path = ?').get(f.path);
    if (ex) { this.update('files', ex.id, f); return ex.id; }
    const keys = Object.keys(f);
    const r = this.q(`INSERT INTO files(${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...keys.map((k) => {
      const v = f[k];
      if (v instanceof Float32Array) return toBlob(v);
      if (ArrayBuffer.isView(v)) return v;
      if (v && typeof v === 'object') return JSON.stringify(v);
      return v === undefined ? null : v;
    }));
    return Number(r.lastInsertRowid);
  }
  updateFile(id, f) { this.update('files', id, f); }
  listFiles({ status } = {}) {
    const rows = status ? this.q('SELECT * FROM files WHERE status = ? ORDER BY path').all(status) : this.q('SELECT * FROM files ORDER BY path').all();
    return rows.map(this.fileRow);
  }
  fileTerms() {
    return this.q("SELECT id, terms FROM files WHERE status = 'parsed'").all().map((r) => ({ id: r.id, terms: J(r.terms, {}) }));
  }
  fileVectors() {
    return this.q("SELECT id, vec, emb FROM files WHERE status = 'parsed'").all().map((r) => ({ id: r.id, vec: fromBlob(r.vec), emb: fromBlob(r.emb) }));
  }
  deleteFile(id) {
    const ids = this.q('SELECT id FROM slides WHERE file_id = ?').all(id).map((r) => r.id);
    this.deleteSlidesOf(id, ids);
    this.q('UPDATE files SET dup_of = NULL WHERE dup_of = ?').run(id);
    this.q('DELETE FROM files WHERE id = ?').run(id);
  }
  deleteSlidesOf(fileId, ids) {
    ids = ids || this.q('SELECT id FROM slides WHERE file_id = ?').all(fileId).map((r) => r.id);
    for (const sid of ids) {
      this.q('DELETE FROM slides_fts WHERE rowid = ?').run(sid);
      this.q('DELETE FROM pairs WHERE slide_id = ? OR other_id = ?').run(sid, sid);
      this.q('DELETE FROM slide_links WHERE slide_id = ? OR other_id = ?').run(sid, sid);
    }
    this.q('DELETE FROM slides WHERE file_id = ?').run(fileId);
  }

  // ---------- 页面 ----------
  insertSlide(fileId, s, fts) {
    const r = this.q(`INSERT INTO slides(file_id, idx, title, text, notes, md, theme, bg, hidden, section, has_video, media, layout, thumb, vec, kw)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      fileId, s.index, s.title || '', s.text || '', s.notes || '', s.md || '', s.theme, JSON.stringify(s.bg || {}), s.hidden ? 1 : 0, s.section || '',
      s.media && s.media.some((m) => m.type === 'video') ? 1 : 0, JSON.stringify(s.media || []), s.layout ? JSON.stringify(s.layout) : null, s.thumb || null, toBlob(s.vec), s.kw ? JSON.stringify(s.kw) : null);
    const id = Number(r.lastInsertRowid);
    this.q('INSERT INTO slides_fts(rowid, title, body, notes, meta) VALUES (?, ?, ?, ?, ?)').run(id, fts.title, fts.body, fts.notes, fts.meta);
    return id;
  }
  slideRow = (r, full = false) => {
    if (!r) return null;
    const o = { ...r, bg: J(r.bg, {}), media: J(r.media, []), hidden: !!r.hidden, has_video: !!r.has_video, vec: undefined, emb: undefined, kw: undefined, tags: J(r.tags, []) };
    o.layout = full ? J(r.layout, null) : undefined;
    // 用户编辑过的讲解词 / Markdown 优先生效，原文保留在 *_orig
    o.notes_orig = r.notes; o.md_orig = r.md;
    if (r.notes_user !== null && r.notes_user !== undefined) o.notes = r.notes_user;
    if (r.md_user !== null && r.md_user !== undefined) o.md = r.md_user;
    o.edited = r.notes_user != null || r.md_user != null;
    return o;
  };
  slidesOf(fileId, full = false) {
    return this.q('SELECT * FROM slides WHERE file_id = ? ORDER BY idx').all(fileId).map((r) => this.slideRow(r, full));
  }
  getSlide(id, full = true) { return this.slideRow(this.q('SELECT * FROM slides WHERE id = ?').get(id), full); }
  getSlides(ids, full = false) {
    if (!ids.length) return [];
    const out = [];
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      out.push(...this.db.prepare(`SELECT * FROM slides WHERE id IN (${chunk.map(() => '?').join(',')})`).all(...chunk).map((r) => this.slideRow(r, full)));
    }
    const m = new Map(out.map((s) => [s.id, s]));
    return ids.map((id) => m.get(id)).filter(Boolean);
  }
  slideVectors() {
    return this.q(`SELECT s.id, s.file_id, s.theme, s.title, s.vec, s.emb, f.kind FROM slides s JOIN files f ON f.id = s.file_id WHERE f.status = 'parsed'`).all()
      .map((r) => ({ id: r.id, file_id: r.file_id, theme: r.theme, title: r.title, kind: r.kind || 'ppt', vec: fromBlob(r.vec), emb: fromBlob(r.emb) }));
  }
  setSlideUser(id, f) {
    const sets = [], vals = [];
    for (const k of ['notes_user', 'md_user', 'notes_ai']) if (k in f) { sets.push(`${k} = ?`); vals.push(f[k]); }
    if (sets.length) this.q(`UPDATE slides SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
  }
  updateFts(id, fts) {
    this.q('DELETE FROM slides_fts WHERE rowid = ?').run(id);
    this.q('INSERT INTO slides_fts(rowid, title, body, notes, meta) VALUES (?, ?, ?, ?, ?)').run(id, fts.title, fts.body, fts.notes, fts.meta);
  }
  setSlideEmb(id, emb) { this.q('UPDATE slides SET emb = ? WHERE id = ?').run(toBlob(emb), id); }
  setSlideThumb(id, thumb) { this.q('UPDATE slides SET thumb = ? WHERE id = ?').run(thumb, id); }
  setSlideTheme(id, theme, bg) { this.q('UPDATE slides SET theme = ?, bg = ? WHERE id = ?').run(theme, JSON.stringify(bg), id); }
  ftsSearch(match, limit = 400) {
    try {
      return this.q(`SELECT rowid AS id, bm25(slides_fts, 4.0, 1.0, 0.8, 2.0) AS score FROM slides_fts WHERE slides_fts MATCH ? ORDER BY score LIMIT ?`).all(match, limit);
    } catch { return []; }
  }

  // ---------- 黑白底对应 ----------
  // ---------- 页面标签与页面关联 ----------
  /** 参与关联计算的页面（已解析文件）：向量、词项、标签 */
  relationRows() {
    return this.q(`SELECT s.id, s.file_id, s.title, s.text, s.notes, s.theme, s.vec, s.emb, s.kw, s.tags, f.kind FROM slides s JOIN files f ON f.id = s.file_id WHERE f.status = 'parsed'`).all()
      .map((r) => ({ id: r.id, file_id: r.file_id, title: r.title, text: r.text, notes: r.notes, theme: r.theme, kind: r.kind || 'ppt', vec: fromBlob(r.vec), emb: fromBlob(r.emb), kw: r.kw ? JSON.parse(r.kw) : null, tags: r.tags ? JSON.parse(r.tags) : null }));
  }
  setSlideKwTags(rows) {
    this.tx(() => { for (const r of rows) this.q('UPDATE slides SET kw = COALESCE(?, kw), tags = ? WHERE id = ?').run(r.kw ? JSON.stringify(r.kw) : null, JSON.stringify(r.tags || []), r.id); });
  }
  replaceLinks(links) {
    this.tx(() => {
      this.q('DELETE FROM slide_links').run();
      const ins = this.q('INSERT OR REPLACE INTO slide_links(slide_id, other_id, score, kind, reasons) VALUES (?, ?, ?, ?, ?)');
      for (const l of links) ins.run(l.a, l.b, l.score, l.kind, JSON.stringify(l.reasons || []));
    });
  }
  linksOf(slideId) {
    return this.q('SELECT other_id, score, kind, reasons FROM slide_links WHERE slide_id = ? ORDER BY score DESC').all(slideId).map((r) => ({ ...r, reasons: J(r.reasons, []) }));
  }
  // ---------- 讲解词翻译知识库（按文件路径 + 页码保存，重新解析后仍保留） ----------
  kbGet(p, idx, variant, lang) { return this.q('SELECT * FROM notes_kb WHERE path = ? AND idx = ? AND variant = ? AND lang = ?').get(p, idx, variant, lang) || null; }
  kbList(p, idx) { return this.q('SELECT * FROM notes_kb WHERE path = ? AND idx = ? ORDER BY at DESC').all(p, idx); }
  kbPut(r) { this.q('INSERT OR REPLACE INTO notes_kb(path, idx, variant, lang, text, source, written_back, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(r.path, r.idx, r.variant, r.lang, r.text, r.source || '', r.written_back ? 1 : 0, Date.now()); }
  kbMarkWritten(p, idx, variant, lang) { this.q('UPDATE notes_kb SET written_back = 1 WHERE path = ? AND idx = ? AND variant = ? AND lang = ?').run(p, idx, variant, lang); }
  kbCount() { return this.q('SELECT COUNT(*) n FROM notes_kb').get().n; }
  linkStats() { return this.q('SELECT kind, COUNT(*) n, COUNT(DISTINCT slide_id) pages FROM slide_links GROUP BY kind').all(); }

  replacePairs(pairs) {
    this.tx(() => {
      this.q('DELETE FROM pairs').run();
      for (const p of pairs) {
        this.q('INSERT OR REPLACE INTO pairs(slide_id, other_id, score) VALUES (?, ?, ?)').run(p.a, p.b, p.score);
        this.q('INSERT OR REPLACE INTO pairs(slide_id, other_id, score) VALUES (?, ?, ?)').run(p.b, p.a, p.score);
      }
    });
  }
  counterparts(slideIds) {
    const m = new Map();
    for (let i = 0; i < slideIds.length; i += 500) {
      const chunk = slideIds.slice(i, i + 500);
      const rows = this.db.prepare(`SELECT slide_id, other_id, score FROM pairs WHERE slide_id IN (${chunk.map(() => '?').join(',')}) ORDER BY score DESC`).all(...chunk);
      for (const r of rows) if (!m.has(r.slide_id)) m.set(r.slide_id, { id: r.other_id, score: r.score });
    }
    return m;
  }

  stats() {
    const g = (sql) => this.q(sql).get();
    return {
      files: g("SELECT COUNT(*) n FROM files WHERE status = 'parsed'").n,
      duplicates: g("SELECT COUNT(*) n FROM files WHERE status = 'duplicate'").n,
      failed: g("SELECT COUNT(*) n FROM files WHERE status = 'failed'").n,
      slides: g('SELECT COUNT(*) n FROM slides').n,
      tasks: g('SELECT COUNT(*) n FROM tasks WHERE deleted IS NULL OR deleted = 0').n,
      history: g('SELECT COUNT(*) n FROM task_files').n,
    };
  }

  close() { try { this.db.close(); } catch { /* ignore */ } }
}

module.exports = { Store, toBlob, fromBlob };
