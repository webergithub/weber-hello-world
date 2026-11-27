'use strict';
// 手动标签与标签管理（v3.14）：在自动标签（tagger.computeTags，存 files.auto_tags）之上叠加用户的修改——
//   文档级：file_tags(file_id, tag, op)，op = add（手动添加）| hide（隐藏该文档的某个自动标签）；
//   标签级：tag_defs(name, color, note, alias_of, blocked)，alias_of = 重命名 / 合并到另一个标签，blocked = 屏蔽（删除）；
// 两者都对以后重新计算出的自动标签继续生效（重新解析、全库重算不会冲掉手动修改）。
// 生效标签 files.tags = 手动添加 + （自动标签 → 别名 → 去掉屏蔽 / 隐藏），files.manual_tags = 手动添加的标签。
// 每次修改记一条 tag_ops（含修改前的 file_tags / tag_defs 快照），可撤销。
const { ticker } = require('./yieldy');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tag_defs (name TEXT PRIMARY KEY, color TEXT, note TEXT, alias_of TEXT, blocked INTEGER DEFAULT 0, created_at INTEGER, updated_at INTEGER);
CREATE TABLE IF NOT EXISTS file_tags (file_id INTEGER, tag TEXT, op TEXT, at INTEGER, PRIMARY KEY (file_id, tag));
CREATE INDEX IF NOT EXISTS idx_file_tags_tag ON file_tags(tag);
CREATE TABLE IF NOT EXISTS tag_ops (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, op TEXT, title TEXT, files INTEGER, snapshot TEXT, undone INTEGER DEFAULT 0);
`;
const COLORS = ['', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8'];
const J = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const clean = (t) => String(t || '').replace(/[\r\n\t|,，;；]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
const LIVE = "status IN ('parsed', 'duplicate')";

class UserTags {
  constructor(service) { this.svc = service; this.ready = false; }
  get db() { return this.svc.store.db; }

  init() {
    if (this.ready) return;
    this.db.exec(SCHEMA);
    const cols = new Set(this.db.prepare('PRAGMA table_info(files)').all().map((c) => c.name));
    if (!cols.has('auto_tags')) {
      this.db.exec('ALTER TABLE files ADD COLUMN auto_tags TEXT');
      this.db.exec('UPDATE files SET auto_tags = tags'); // 升级时还没有手动修改，现有标签都是自动标签
    }
    if (!cols.has('manual_tags')) this.db.exec('ALTER TABLE files ADD COLUMN manual_tags TEXT');
    this.ready = true;
  }

  /** 标签级规则：Map(name → { alias_of, blocked, color, note }) */
  defs() { this.init(); return new Map(this.db.prepare('SELECT * FROM tag_defs').all().map((r) => [r.name, r])); }
  /** 文档级修改：Map(file_id → { add: [], hide: Set }) */
  overrides(fileIds = null) {
    this.init();
    const rows = fileIds ? this.byFiles(fileIds) : this.db.prepare('SELECT file_id, tag, op FROM file_tags ORDER BY at').all();
    const m = new Map();
    for (const r of rows) {
      if (!m.has(r.file_id)) m.set(r.file_id, { add: [], hide: new Set() });
      const o = m.get(r.file_id);
      if (r.op === 'add') o.add.push(r.tag); else o.hide.add(r.tag);
    }
    return m;
  }
  byFiles(ids) {
    const out = [];
    for (let i = 0; i < ids.length; i += 500) {
      const part = ids.slice(i, i + 500);
      out.push(...this.db.prepare(`SELECT file_id, tag, op FROM file_tags WHERE file_id IN (${part.map(() => '?').join(',')}) ORDER BY at`).all(...part));
    }
    return out;
  }

  /** 由自动标签与修改得到生效标签 */
  static merge(auto, ov, defs) {
    const resolve = (t) => { let x = t; for (let g = 0; g < 8; g++) { const d = defs.get(x); if (!d || !d.alias_of) break; x = d.alias_of; } return x; };
    const blocked = (t) => { const d = defs.get(t); return !!(d && d.blocked); };
    const manual = [];
    for (const t of (ov && ov.add) || []) { const r = resolve(t); if (!blocked(r) && !manual.includes(r)) manual.push(r); }
    const tags = [...manual];
    for (const t of auto || []) {
      const r = resolve(t);
      if (blocked(r) || (ov && (ov.hide.has(r) || ov.hide.has(t))) || tags.includes(r)) continue;
      tags.push(r);
    }
    return { tags, manual };
  }

  /** 全库重算标签时调用：一次读出规则与修改，返回 apply(fileId, autoTags) */
  applier() {
    const defs = this.defs(), ov = this.overrides();
    return (fileId, auto) => UserTags.merge(auto, ov.get(fileId), defs);
  }

  /** 重新计算这些文档的生效标签并写回 */
  async refresh(ids) {
    this.init();
    ids = [...new Set(ids)].filter(Boolean);
    if (!ids.length) return 0;
    const defs = this.defs(), ov = this.overrides(ids);
    const tk = ticker();
    const up = this.db.prepare('UPDATE files SET tags = ?, manual_tags = ? WHERE id = ?');
    const get = this.db.prepare('SELECT id, auto_tags, tags FROM files WHERE id = ?');
    this.db.exec('BEGIN');
    try {
      for (let i = 0; i < ids.length; i++) {
        if ((i & 255) === 255) { this.db.exec('COMMIT'); const p = tk(); if (p) await p; this.db.exec('BEGIN'); }
        const r = get.get(ids[i]);
        if (!r) continue;
        const m = UserTags.merge(J(r.auto_tags, null) || [], ov.get(r.id), defs);
        up.run(JSON.stringify(m.tags), JSON.stringify(m.manual), r.id);
      }
      this.db.exec('COMMIT');
    } catch (e) { try { this.db.exec('ROLLBACK'); } catch { /* ignore */ } throw e; }
    this.changed();
    return ids.length;
  }
  changed() { if (this.svc.search) this.svc.search.invalidate(); this.svc.emit('library', { at: Date.now(), tags: true }); }

  /** 带有这些标签（生效 / 自动 / 修改记录中）的文档 */
  filesWith(names) {
    this.init();
    const set = new Set();
    for (const n of names) {
      for (const r of this.db.prepare(`SELECT f.id FROM files f, json_each(COALESCE(f.tags, '[]')) j WHERE j.value = ? UNION SELECT f.id FROM files f, json_each(COALESCE(f.auto_tags, '[]')) j WHERE j.value = ? UNION SELECT file_id id FROM file_tags WHERE tag = ?`).all(n, n, n)) set.add(r.id);
    }
    return [...set];
  }

  // ---------- 可撤销的修改 ----------
  snapshot(names, fileIds) {
    const n = [...new Set(names)];
    const defs = n.length ? this.db.prepare(`SELECT * FROM tag_defs WHERE name IN (${n.map(() => '?').join(',')}) OR alias_of IN (${n.map(() => '?').join(',')})`).all(...n, ...n) : [];
    const rows = fileIds.length ? this.byFiles(fileIds).map((r) => ({ ...r })) : [];
    return { names: n, fileIds, defs, rows };
  }
  record(op, title, snap) {
    const info = this.db.prepare('INSERT INTO tag_ops(at, op, title, files, snapshot) VALUES (?, ?, ?, ?, ?)').run(Date.now(), op, title, snap.fileIds.length, JSON.stringify(snap));
    this.db.prepare('DELETE FROM tag_ops WHERE id <= ?').run(Number(info.lastInsertRowid) - 500);
    this.svc.log.info(`[标签] ${title}（${snap.fileIds.length} 个文档）`);
    return Number(info.lastInsertRowid);
  }
  ops(limit = 300) { this.init(); return this.db.prepare('SELECT id, at, op, title, files, undone FROM tag_ops ORDER BY id DESC LIMIT ?').all(limit); }

  async undo(id) {
    this.init();
    const op = this.db.prepare('SELECT * FROM tag_ops WHERE id = ?').get(id);
    if (!op) throw new Error('操作记录不存在');
    if (op.undone) throw new Error('该操作已撤销');
    const later = this.db.prepare('SELECT COUNT(*) n FROM tag_ops WHERE id > ? AND undone = 0').get(id).n;
    if (later) throw new Error('只能从最近的操作开始依次撤销');
    const s = J(op.snapshot, null);
    if (!s) throw new Error('操作记录已损坏');
    this.db.exec('BEGIN');
    try {
      if (s.names.length) {
        const ph = s.names.map(() => '?').join(',');
        this.db.prepare(`DELETE FROM tag_defs WHERE name IN (${ph}) OR alias_of IN (${ph})`).run(...s.names, ...s.names);
      }
      const ins = this.db.prepare('INSERT OR REPLACE INTO tag_defs(name, color, note, alias_of, blocked, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
      for (const d of s.defs) ins.run(d.name, d.color, d.note, d.alias_of, d.blocked || 0, d.created_at, d.updated_at);
      for (let i = 0; i < s.fileIds.length; i += 500) {
        const part = s.fileIds.slice(i, i + 500);
        this.db.prepare(`DELETE FROM file_tags WHERE file_id IN (${part.map(() => '?').join(',')})`).run(...part);
      }
      const insT = this.db.prepare('INSERT OR REPLACE INTO file_tags(file_id, tag, op, at) VALUES (?, ?, ?, ?)');
      for (const r of s.rows) insT.run(r.file_id, r.tag, r.op, Date.now());
      this.db.prepare('UPDATE tag_ops SET undone = 1 WHERE id = ?').run(id);
      this.db.exec('COMMIT');
    } catch (e) { try { this.db.exec('ROLLBACK'); } catch { /* ignore */ } throw e; }
    await this.refresh([...s.fileIds, ...this.filesWith(s.names)]);
    this.svc.log.info(`[标签] 撤销：${op.title}`);
    return { title: op.title };
  }

  ensureDef(name) {
    this.db.prepare('INSERT OR IGNORE INTO tag_defs(name, created_at, updated_at) VALUES (?, ?, ?)').run(name, Date.now(), Date.now());
    this.db.prepare('UPDATE tag_defs SET blocked = 0, alias_of = NULL WHERE name = ? AND (blocked = 1 OR alias_of IS NOT NULL)').run(name);
  }

  /** 给文档加 / 去标签（ids：文档 id；add / remove：标签名） */
  async tagFiles(ids, { add = [], remove = [] } = {}) {
    this.init();
    ids = [...new Set((ids || []).map(Number).filter(Boolean))];
    add = [...new Set(add.map(clean).filter(Boolean))];
    remove = [...new Set(remove.map(clean).filter(Boolean))].filter((t) => !add.includes(t));
    if (!ids.length || (!add.length && !remove.length)) throw new Error('请选择文档并输入标签');
    const snap = this.snapshot([...add, ...remove], ids);
    const now = Date.now();
    const put = this.db.prepare('INSERT OR REPLACE INTO file_tags(file_id, tag, op, at) VALUES (?, ?, ?, ?)');
    const del = this.db.prepare('DELETE FROM file_tags WHERE file_id = ? AND tag = ?');
    const autoHas = this.db.prepare("SELECT 1 FROM files f, json_each(COALESCE(f.auto_tags, '[]')) j WHERE f.id = ? AND j.value = ? LIMIT 1");
    this.db.exec('BEGIN');
    try {
      for (const t of add) this.ensureDef(t);
      for (const id of ids) {
        for (const t of add) put.run(id, t, 'add', now);
        // 去掉：手动添加的直接删除；自动标签记为“隐藏”（以后重新计算也不再出现）
        for (const t of remove) { del.run(id, t); if (autoHas.get(id, t)) put.run(id, t, 'hide', now); }
      }
      this.db.exec('COMMIT');
    } catch (e) { try { this.db.exec('ROLLBACK'); } catch { /* ignore */ } throw e; }
    const title = [add.length ? `添加标签 ${add.join('、')}` : '', remove.length ? `去掉标签 ${remove.join('、')}` : ''].filter(Boolean).join('；');
    const opId = this.record('tag', title, snap);
    await this.refresh(ids);
    return { opId, files: ids.length, title };
  }

  /** 标签目录：全部标签（含只定义未使用的）及文档数、手动 / 自动来源、颜色、说明、别名、屏蔽 */
  catalog() {
    this.init();
    const m = new Map();
    const get = (n) => { if (!m.has(n)) m.set(n, { name: n, files: 0, manual: 0, auto: 0, hidden: 0, color: '', note: '', alias_of: '', blocked: 0, updated_at: null, created_at: null }); return m.get(n); };
    for (const r of this.db.prepare(`SELECT j.value t, COUNT(*) n FROM files f, json_each(COALESCE(f.tags, '[]')) j WHERE f.${LIVE} GROUP BY j.value`).all()) get(r.t).files = r.n;
    for (const r of this.db.prepare(`SELECT j.value t, COUNT(*) n FROM files f, json_each(COALESCE(f.auto_tags, '[]')) j WHERE f.${LIVE} GROUP BY j.value`).all()) get(r.t).auto = r.n;
    for (const r of this.db.prepare(`SELECT ft.tag t, ft.op, COUNT(*) n FROM file_tags ft JOIN files f ON f.id = ft.file_id WHERE f.${LIVE} GROUP BY ft.tag, ft.op`).all()) get(r.t)[r.op === 'add' ? 'manual' : 'hidden'] = r.n;
    for (const d of this.db.prepare('SELECT * FROM tag_defs').all()) Object.assign(get(d.name), { color: d.color || '', note: d.note || '', alias_of: d.alias_of || '', blocked: d.blocked || 0, updated_at: d.updated_at, created_at: d.created_at });
    return [...m.values()].map((t) => ({ ...t, source: t.manual && t.auto ? 'both' : t.manual ? 'manual' : t.auto ? 'auto' : 'none', state: t.blocked ? 'blocked' : t.alias_of ? 'alias' : 'normal' }));
  }
  /** 标签的颜色（界面显示用） */
  colors() { this.init(); const o = {}; for (const r of this.db.prepare("SELECT name, color FROM tag_defs WHERE color IS NOT NULL AND color != ''").all()) o[r.name] = r.color; return o; }

  /** 带某个标签的文档（下钻）：生效标签中含该标签 */
  fileIdsOf(name) { this.init(); return this.db.prepare(`SELECT f.id FROM files f, json_each(COALESCE(f.tags, '[]')) j WHERE f.${LIVE} AND j.value = ?`).all(name).map((r) => r.id); }

  /** 新建 / 修改标签定义（颜色、说明） */
  saveDef(name, { color, note } = {}, rename = null) {
    this.init();
    const n = clean(name);
    if (!n) throw new Error('标签名称不能为空');
    const snap = this.snapshot([n], []);
    this.ensureDef(n);
    const sets = [], vals = [];
    if (color !== undefined) { sets.push('color = ?'); vals.push(COLORS.includes(color) ? color : ''); }
    if (note !== undefined) { sets.push('note = ?'); vals.push(String(note || '').slice(0, 200)); }
    sets.push('updated_at = ?'); vals.push(Date.now());
    this.db.prepare(`UPDATE tag_defs SET ${sets.join(', ')} WHERE name = ?`).run(...vals, n);
    this.record('def', rename || `修改标签 ${n}`, snap);
    this.changed();
    return this.catalog().find((t) => t.name === n);
  }

  /** 重命名 / 合并：from 中的每个标签都改为 to（以后重新计算出的自动标签也按此改名） */
  async rename(from, to) {
    this.init();
    from = [...new Set((Array.isArray(from) ? from : [from]).map(clean).filter(Boolean))];
    to = clean(to);
    if (!to || !from.length) throw new Error('请输入新的标签名称');
    from = from.filter((f) => f !== to);
    if (!from.length) throw new Error('新名称与原名称相同');
    const files = this.filesWith(from);
    const snap = this.snapshot([...from, to], files);
    this.db.exec('BEGIN');
    try {
      this.ensureDef(to);
      const target = this.db.prepare('SELECT * FROM tag_defs WHERE name = ?').get(to);
      for (const f of from) {
        const d = this.db.prepare('SELECT * FROM tag_defs WHERE name = ?').get(f);
        // 目标还没有颜色 / 说明时沿用原标签的
        if (d && !target.color && d.color) { this.db.prepare('UPDATE tag_defs SET color = ? WHERE name = ?').run(d.color, to); target.color = d.color; }
        if (d && !target.note && d.note) { this.db.prepare('UPDATE tag_defs SET note = ? WHERE name = ?').run(d.note, to); target.note = d.note; }
        this.db.prepare('INSERT OR IGNORE INTO tag_defs(name, created_at) VALUES (?, ?)').run(f, Date.now());
        this.db.prepare('UPDATE tag_defs SET alias_of = ?, blocked = 0, updated_at = ? WHERE name = ?').run(to, Date.now(), f);
        this.db.prepare('UPDATE tag_defs SET alias_of = ? WHERE alias_of = ?').run(to, f); // 原来合并到 f 的也改到 to
        // 文档级修改改名：手动添加 f → 手动添加 to；隐藏 f → 隐藏 to（目标已有记录时以目标为准）
        this.db.prepare('UPDATE OR IGNORE file_tags SET tag = ? WHERE tag = ?').run(to, f);
        this.db.prepare('DELETE FROM file_tags WHERE tag = ?').run(f);
      }
      this.db.prepare('UPDATE tag_defs SET updated_at = ? WHERE name = ?').run(Date.now(), to);
      this.db.exec('COMMIT');
    } catch (e) { try { this.db.exec('ROLLBACK'); } catch { /* ignore */ } throw e; }
    const title = from.length > 1 ? `合并标签 ${from.join('、')} → ${to}` : `重命名标签 ${from[0]} → ${to}`;
    const opId = this.record(from.length > 1 ? 'merge' : 'rename', title, snap);
    await this.refresh(files);
    return { opId, files: files.length, title };
  }

  /** 删除（屏蔽）标签：所有文档都不再显示，以后重新计算出的自动标签也不显示 */
  async block(names) {
    this.init();
    names = [...new Set((names || []).map(clean).filter(Boolean))];
    if (!names.length) throw new Error('请选择标签');
    const files = this.filesWith(names);
    const snap = this.snapshot(names, files);
    this.db.exec('BEGIN');
    try {
      for (const n of names) {
        this.db.prepare('INSERT OR IGNORE INTO tag_defs(name, created_at) VALUES (?, ?)').run(n, Date.now());
        this.db.prepare('UPDATE tag_defs SET blocked = 1, alias_of = NULL, updated_at = ? WHERE name = ?').run(Date.now(), n);
        this.db.prepare('DELETE FROM file_tags WHERE tag = ?').run(n);
      }
      this.db.exec('COMMIT');
    } catch (e) { try { this.db.exec('ROLLBACK'); } catch { /* ignore */ } throw e; }
    const title = `删除标签 ${names.join('、')}`;
    const opId = this.record('block', title, snap);
    await this.refresh(files);
    return { opId, files: files.length, title };
  }

  /** 恢复已删除（屏蔽）或已合并的标签 */
  async restore(names) {
    this.init();
    names = [...new Set((names || []).map(clean).filter(Boolean))];
    const files = this.filesWith(names);
    const snap = this.snapshot(names, files);
    for (const n of names) this.db.prepare('UPDATE tag_defs SET blocked = 0, alias_of = NULL, updated_at = ? WHERE name = ?').run(Date.now(), n);
    const title = `恢复标签 ${names.join('、')}`;
    const opId = this.record('restore', title, snap);
    await this.refresh(files);
    return { opId, files: files.length, title };
  }
}

module.exports = { UserTags, COLORS };
