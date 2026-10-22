'use strict';
// 运行：npm test（使用 Electron 内置 Node，确保 node:sqlite 可用）
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', 'test-ppts');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ppta-test-'));
const P = (...p) => path.join(ROOT, ...p);

test('解析：标题、备注、隐藏页、表格与图表', async () => {
  const { parsePptx } = require('../electron/core/pptx');
  const r = await parsePptx(P('机场运营', '航班过站保障Turnaround_v2(副本).pptx'), { mediaDir: tmp });
  assert.strictEqual(r.slides.length, 7);
  assert.match(r.slides[0].title, /航班过站保障/);
  assert.ok(r.slides.every((s) => s.notes.length > 0));
  assert.strictEqual(r.slides[4].hidden, true);
  assert.ok(r.slides[4].blocks.some((b) => b.kind === 'table'));
  assert.ok(r.slides[5].blocks.some((b) => b.kind === 'chart'));
  assert.strictEqual(r.props.author, '测试作者');
});

test('解析：黑底识别（页面背景 / 母版背景 / 整页图片）', async () => {
  const { parsePptx } = require('../electron/core/pptx');
  for (const f of [['机场运营', '航班过站保障Turnaround_黑底.pptx'], ['技术方案', 'Smart Airport AI Platform_dark.pptx'], ['技术方案', '数字孪生机场_图片背景.pptx']]) {
    const r = await parsePptx(P(...f), { mediaDir: tmp });
    assert.ok(r.slides.every((s) => s.theme === 'dark'), f[1]);
  }
  const w = await parsePptx(P('机场运营', '航班过站保障Turnaround_白底.pptx'), { mediaDir: tmp });
  assert.ok(w.slides.every((s) => s.theme === 'light'));
});

test('视频：只提取字幕（内封字幕轨 + 隐藏式字幕 + 外挂 srt）', async () => {
  const { parsePptx } = require('../electron/core/pptx');
  const big = await parsePptx(P('培训视频', '地勤安全培训_含视频(大文件).pptx'), { mediaDir: tmp });
  const v = big.slides[1].media[0];
  assert.strictEqual(v.type, 'video');
  assert.ok(v.size > 10 * 1024 * 1024);
  const sources = v.subtitles.map((s) => s.source).join('|');
  assert.match(sources, /内封字幕轨/);
  assert.match(sources, /隐藏式字幕/);
  assert.match(big.slides[1].text, /反光背心/);
  const linked = await parsePptx(P('培训视频', '行李系统介绍_外链视频.pptx'), { mediaDir: tmp });
  const lv = linked.slides[0].media[0];
  assert.strictEqual(lv.external, true);
  assert.ok(lv.subtitles.some((s) => /外挂字幕/.test(s.source)));
});

test('损坏文件给出明确错误', async () => {
  const { parsePptx } = require('../electron/core/pptx');
  await assert.rejects(() => parsePptx(P('其他', '边界情况', '损坏文件.pptx'), {}));
});

test('查询解析：中英互译扩展', async () => {
  const { SearchEngine } = require('../electron/core/search');
  const se = new SearchEngine(null, () => ({ llm: { enabled: false } }), { warn() {} });
  const a = await se.analyze('机航 turnaround');
  const all = a.groups.flatMap((g) => g.synonyms);
  assert.ok(all.includes('过站'));
  assert.ok(all.includes('aviation'));
  assert.ok(a.zh.length && a.en.length);
});

test('相似标题归一化', () => {
  const { normTitle } = require('../electron/core/similarity');
  assert.strictEqual(normTitle('航班过站保障Turnaround_白底.pptx'), normTitle('航班过站保障Turnaround_v2(副本).pptx'));
  assert.strictEqual(normTitle('Smart Airport AI Platform_dark.pptx'), normTitle('Smart Airport AI Platform_light.pptx'));
});

test('导出：跨文件选页合并为新 PPTX（保留母版、视频、备注）', async () => {
  const { exportPptx } = require('../electron/core/exporter');
  const { parsePptx } = require('../electron/core/pptx');
  const out = path.join(tmp, 'merged.pptx');
  const r = await exportPptx([
    { path: P('机场运营', '航班过站保障Turnaround_白底.pptx'), idx: 6 },
    { path: P('机场运营', '航班过站保障Turnaround_黑底.pptx'), idx: 2 },
    { path: P('培训视频', '地勤安全培训_含视频(大文件).pptx'), idx: 2 },
    { path: P('机场运营', '航班过站保障Turnaround_白底.pptx'), idx: 6 },
  ], out, {});
  assert.strictEqual(r.slides, 4);
  assert.strictEqual(r.masters, 3);
  const back = await parsePptx(out, { mediaDir: tmp });
  assert.deepStrictEqual(back.slides.map((s) => s.theme), ['light', 'dark', 'light', 'light']);
  assert.ok(back.slides.every((s) => s.notes));
  assert.ok(back.slides[2].media[0].size > 10 * 1024 * 1024);
  try { execFileSync('unzip', ['-tq', out], { stdio: 'pipe' }); } catch (e) { if (e.code !== 'ENOENT') throw e; }
});

test('服务：去重（已解析过 / 重复文件）、标签 20 个、分组与黑白底对应', async () => {
  const { AgentService } = require('../electron/core/service');
  const svc = new AgentService(path.join(tmp, 'data'));
  svc.setConfig({ thumbnails: 'off' });
  const done = (id) => new Promise((res) => svc.on('task', (t) => { if (t.id === id && ['done', 'failed'].includes(t.status)) res(t); }));
  // 临时资料库：复制两个目录，并放一个名称/大小/修改时间/作者完全一致的副本
  const lib = path.join(tmp, 'lib');
  fs.cpSync(P('机场运营'), path.join(lib, '机场运营'), { recursive: true });
  fs.cpSync(P('技术方案'), path.join(lib, '技术方案'), { recursive: true });
  const src = path.join(lib, '机场运营', '航班过站保障Turnaround_白底.pptx');
  const dup = path.join(lib, '重复副本', '航班过站保障Turnaround_白底.pptx');
  fs.mkdirSync(path.dirname(dup), { recursive: true });
  fs.copyFileSync(src, dup);
  const st = fs.statSync(src);
  fs.utimesSync(dup, st.atime, st.mtime);
  fs.cpSync(P('Word文档', '航班过站保障作业指导书.docx'), path.join(lib, 'Word', '航班过站保障作业指导书.docx'));
  const id = svc.addTask(lib);
  assert.strictEqual(svc.store.getTask(id).status, 'draft', '添加后应等待手动开始');
  const stages = new Set();
  svc.on('progress', (p) => stages.add(p.stage));
  svc.startTask(id);
  await done(id);
  const d = svc.taskDetail(id);
  assert.ok(d.stats.duplicate >= 1);
  const ok = d.files.filter((f) => f.action === 'parsed' && f.slide_count >= 3);
  assert.ok(ok.length >= 7);
  assert.ok(ok.every((f) => f.tags.length === 20), ok.map((f) => f.name + ':' + f.tags.length).join(','));
  const groups = svc.groups();
  assert.ok(groups.some((g) => g.hasThemeVariants));
  const r = await svc.searchQuery('机航 turnaround');
  assert.strictEqual(r.files[0].tier, 1);
  assert.ok(r.slides.light.length && r.slides.dark.length);
  assert.ok(r.slides.dark.some((s) => s.counterpart && s.counterpart.theme === 'light'));
  for (const st of ['scanned', 'file', 'slide', 'parsed', 'tag', 'done']) assert.ok(stages.has(st), '缺少进度事件 ' + st);
  const w = await svc.searchQuery('TOBT 更新规则');
  assert.ok(w.slides.word.length >= 1, 'Word 章节应可被检索');
  const id2 = svc.addTask(lib);
  svc.startTask(id2);
  const t2 = await done(id2);
  assert.match(t2.message, /解析 0，/);
  // 用户确认后强制重新解析重复文件
  const id3 = svc.reparseFiles([dup]);
  const t3 = await done(id3);
  assert.match(t3.message, /解析 1，/);
  assert.ok(svc.history().length >= 3);
  svc.close();
});

test('Word：按标题分节、表格、批注', async () => {
  const { parseDocx } = require('../electron/core/docx');
  const r = await parseDocx(P('Word文档', '航班过站保障作业指导书.docx'), { mediaDir: tmp });
  assert.ok(r.slides.length >= 5);
  assert.ok(r.slides.some((s) => /2\.1 TOBT/.test(s.title)));
  assert.ok(r.slides.some((s) => s.blocks.some((b) => b.kind === 'table')));
  assert.ok(r.slides.some((s) => /审核人/.test(s.notes)));
});

test('Markdown 只保留文字，不含图片', async () => {
  const { parsePptx } = require('../electron/core/pptx');
  const { slideToMd } = require('../electron/core/markdown');
  const r = await parsePptx(P('技术方案', '数字孪生机场_图片背景.pptx'), { mediaDir: tmp });
  for (const s of r.slides) assert.ok(!/!\[/.test(slideToMd(s)));
});

test('黑白底互转：黑→白、白→黑', async () => {
  const { exportPptx } = require('../electron/core/exporter');
  const { convertTheme } = require('../electron/core/converter');
  const { parsePptx } = require('../electron/core/pptx');
  const f = P('技术方案', '黑白互转测试_黑底.pptx');
  const merged = path.join(tmp, 'cv-m.pptx'), out = path.join(tmp, 'cv.pptx');
  await exportPptx([{ path: f, idx: 1, ns: 'toLight' }, { path: P('机场运营', '航班过站保障Turnaround_白底.pptx'), idx: 5, ns: 'toDark' }], merged, {});
  const r = await convertTheme(merged, out, ['toLight', 'toDark'], {});
  assert.ok(r.stats.logos >= 1 && r.stats.tables >= 2 && r.stats.shapes >= 2);
  const back = await parsePptx(out, { mediaDir: tmp });
  assert.deepStrictEqual(back.slides.map((s) => s.theme), ['light', 'dark']);
  const runs = back.slides[0].layout.items.flatMap((i) => (i.paras || []).flatMap((p) => p.runs || []));
  assert.ok(runs.some((x) => x.color === 'C00000'), '彩色文字应变为深红');
  assert.ok(runs.filter((x) => x.text.trim()).every((x) => ['000000', 'C00000'].includes(x.color)));
});

test('智能生成：版式意图识别与相似聚类', () => {
  const gen = require('../electron/core/generate');
  const it = gen.parseIntent('需要一个对比格式的模板页面');
  assert.deepStrictEqual(it.formats.map((f) => f.key), ['compare']);
  assert.strictEqual(it.topic, '');
  const t = gen.parseIntent('航班过站保障的时间线');
  assert.ok(t.formats.some((f) => f.key === 'timeline'));
  assert.match(t.topic, /航班过站保障/);
  const v = (a) => Float32Array.from(a);
  const rows = gen.cluster([{ s: { id: 1 }, vec: v([1, 0]) }, { s: { id: 2 }, vec: v([0.99, 0.141]) }, { s: { id: 3 }, vec: v([0, 1]) }], 0.9);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].variants.length, 1);
  const two = gen.slideFeatures({ idx: 3, title: 'A', text: 'x', layout: { items: [{ t: 'text', x: 0.05, y: 0.3, w: 0.42, h: 0.5, paras: [{ text: '左' }] }, { t: 'text', x: 0.53, y: 0.3, w: 0.42, h: 0.5, paras: [{ text: '右' }] }] } });
  assert.strictEqual(two.twoCol, true);
});

test('任务中断后从断点继续；回收站移入 / 还原 / 彻底删除；讲解词编辑与 Agent 生成；转换规则脚本', async () => {
  const { AgentService } = require('../electron/core/service');
  const lib = path.join(tmp, 'lib2');
  fs.cpSync(P('机场运营'), path.join(lib, '机场运营'), { recursive: true });
  fs.cpSync(P('技术方案'), path.join(lib, '技术方案'), { recursive: true });
  const svc = new AgentService(path.join(tmp, 'data2'));
  svc.setConfig({ thumbnails: 'off' });
  const done = (id, st) => new Promise((res) => svc.on('task', (t) => { if (t.id === id && st.includes(t.status) && t.finished_at) res(t); }));
  const id = svc.addTask(lib);
  let pausedOnce = false;
  svc.on('progress', (p) => { if (!pausedOnce && p.taskId === id && p.stage === 'file' && p.index === 3) { pausedOnce = true; svc.pauseTask(id); } });
  svc.startTask(id);
  const t1 = await done(id, ['paused']);
  assert.match(t1.message, /已中断/);
  let first = null;
  svc.on('progress', (p) => { if (p.taskId === id && p.stage === 'file' && first === null) first = p.index; });
  svc.resumeTask(id);
  const t2 = await done(id, ['done']);
  assert.strictEqual(first, 3, '暂停时正在解析的第 3 个文件应在继续时重新解析');
  assert.ok(t2.parsed >= 8);
  // 回收站
  const f = svc.library().find((x) => x.name.includes('A-CDM'));
  await svc.recycleFiles([f.id], { moveFile: true });
  assert.ok(!fs.existsSync(f.path));
  assert.ok(!svc.library().some((x) => x.id === f.id));
  const bin = svc.recycleList();
  await svc.restoreRecycled([bin[0].id]);
  assert.ok(fs.existsSync(f.path));
  await svc.recycleFiles([f.id], { moveFile: false });
  svc.purgeRecycled(svc.recycleList().map((r) => r.id));
  assert.ok(fs.existsSync(f.path), '仅移出资料库时彻底删除不应删除原文件');
  assert.strictEqual(svc.recycleList().length, 0);
  // 讲解词编辑与 Agent 生成（未配置大模型时使用内置模板）
  const any = svc.library().find((x) => x.status === 'parsed' && x.slide_count > 2);
  const sl = svc.store.slidesOf(any.id)[1];
  const g = await svc.generateNotes(sl.id);
  assert.match(g.source, /内置模板/);
  assert.ok(g.text.length > 10);
  const e = svc.updateSlideText(sl.id, { notes: '唯一测试讲解词XYZ' });
  assert.strictEqual(e.notes, '唯一测试讲解词XYZ');
  const r = await svc.searchQuery('唯一测试讲解词XYZ');
  assert.ok([...r.slides.light, ...r.slides.dark].some((x) => x.id === sl.id));
  assert.strictEqual(svc.updateSlideText(sl.id, { notes: null }).edited, false);
  // 规则脚本
  const rules = svc.setConvertRules({ toLight: { text: '1F3864' } });
  assert.strictEqual(svc.getConvertRules().toLight.text, '1F3864');
  assert.strictEqual(rules.toDark.text, 'FFFFFF');
  svc.resetConvertRules();
  // 总览分析
  const a = svc.analytics();
  assert.ok(a.files.length >= 8 && a.files.every((x) => 'lastOpen' in x));
  svc.close();
});

test('定时监测更新：增量扫描新增 / 修改 / 删除；移出资料库的文档不自动加回', async () => {
  const { AgentService } = require('../electron/core/service');
  const lib = path.join(tmp, 'lib3');
  fs.cpSync(P('机场运营'), lib, { recursive: true });
  const svc = new AgentService(path.join(tmp, 'data3'));
  svc.setConfig({ thumbnails: 'off' });
  const done = (id) => new Promise((res) => { const h = (t) => { if (t.id === id && t.status === 'done' && t.finished_at) { svc.off('task', h); res(t); } }; svc.on('task', h); });
  const id = svc.addTask(lib);
  const draft = svc.addTask(lib);
  svc.setTaskWatch(draft, true);
  svc.startTask(id);
  await done(id);
  svc.setTaskWatch(id, true);
  assert.strictEqual(svc.getConfig().watch.enabled, true);
  // 时间点计算
  const base = new Date(2026, 9, 21, 10, 0).getTime();
  assert.strictEqual(AgentService.lastSlot('03:00', base), new Date(2026, 9, 21, 3, 0).getTime());
  assert.strictEqual(AgentService.lastSlot('12:30', base), new Date(2026, 9, 20, 12, 30).getTime());
  assert.strictEqual(AgentService.nextSlot('12:30', base), new Date(2026, 9, 21, 12, 30).getTime());
  // 刚开启 / 修改时间点时不立即补扫
  svc.setConfig({ watch: { time: '00:00' } });
  assert.strictEqual(await svc.checkSchedule(), false);
  // 文档变化：新增 1、修改 1、删除 1
  const pptx = fs.readdirSync(lib).filter((n) => n.endsWith('.pptx')).sort();
  fs.copyFileSync(path.join(lib, pptx[0]), path.join(lib, '新增文档_增量测试.pptx'));
  const later = new Date(Date.now() + 120000);
  fs.utimesSync(path.join(lib, pptx[1]), later, later);
  fs.rmSync(path.join(lib, pptx[2]));
  svc.setConfig({ watch: { since: 0, lastRun: 0 } });
  const p = done(id);
  assert.strictEqual(await svc.checkSchedule(), true);
  const t = await p;
  assert.match(t.message, /新增 1，更新 1，移除 1/);
  assert.strictEqual(JSON.parse(t.watch_summary).added, 1);
  assert.strictEqual(svc.store.getTask(draft).status, 'draft', '从未开始过的任务不自动开始');
  assert.ok(svc.library().some((f) => f.name === '新增文档_增量测试.pptx'));
  assert.ok(!svc.library().some((f) => f.name === pptx[2]));
  assert.ok(svc.recycleList().some((r) => r.name === pptx[2] && !r.moved));
  assert.strictEqual(await svc.checkSchedule(), false, '同一时间点只扫描一次');
  // 用户移出资料库的文档，再次扫描不自动加回
  const keep = svc.library().find((f) => f.name === pptx[3]);
  await svc.recycleFiles([keep.id], { moveFile: false });
  const p2 = done(id);
  svc.runWatch('手动增量扫描');
  const t2 = await p2;
  assert.match(t2.message, /新增 0，更新 0，移除 0/);
  assert.ok(!svc.library().some((f) => f.id === keep.id));
  assert.ok(svc.watchInfo().tasks.some((x) => x.id === id && x.last_watch_at));
  svc.close();
});

test('页面标签与页面关联：相似 PPT 页推荐；同时选择 Word 时关联 Word 内容', async () => {
  const { AgentService } = require('../electron/core/service');
  const lib = path.join(tmp, 'lib4');
  fs.cpSync(P('机场运营'), path.join(lib, '机场运营'), { recursive: true });
  fs.cpSync(P('Word文档'), path.join(lib, 'Word文档'), { recursive: true });
  const svc = new AgentService(path.join(tmp, 'data4'));
  svc.setConfig({ thumbnails: 'off', docTypes: ['ppt'] });
  const done = (id) => new Promise((res) => { const h = (t) => { if (t.id === id && t.status === 'done' && t.finished_at) { svc.off('task', h); res(t); } }; svc.on('task', h); });
  const relate = [];
  const id = svc.addTask(lib);
  svc.on('progress', (p) => { if (p.stage === 'relate') relate.push(p); });
  svc.startTask(id);
  await done(id);
  assert.ok(relate.length && relate[0].ppt > 0 && relate[0].withWord === false);
  const lib0 = svc.library();
  assert.ok(!lib0.some((f) => f.kind === 'word'), '只选 PPT 时不解析 Word');
  // 页面标签
  const f = lib0.find((x) => x.name.includes('白底') && x.slide_count > 3);
  const sl = svc.store.slidesOf(f.id);
  assert.ok(sl.every((s) => Array.isArray(s.tags)) && sl.some((s) => s.tags.length >= 3));
  // 白底版本的页面应推荐其黑底 / 副本版本
  const r = svc.related(sl[1].id);
  assert.ok(r.ppt.length > 0);
  assert.ok(r.ppt.every((x) => x.file_id !== f.id && x.fileName));
  assert.ok(r.ppt.some((x) => x.reasons.length));
  assert.strictEqual(r.word.length, 0);
  // 同时选择 PPT 与 Word：解析 Word 后关联 Word 章节与 PPT 页
  svc.setConfig({ docTypes: ['ppt', 'word'] });
  svc.startTask(id);
  await done(id);
  assert.ok(svc.library().some((x) => x.kind === 'word'));
  const last = relate[relate.length - 1];
  assert.strictEqual(last.withWord, true);
  assert.ok(last.word > 0, 'Word 与 PPT 之间应有关联');
  const w = svc.store.db.prepare("SELECT slide_id FROM slide_links WHERE kind = 'word' LIMIT 1").get();
  const r2 = svc.related(w.slide_id);
  assert.ok(r2.word.length > 0 && r2.word.every((x) => x.kind === 'word'));
  const wordSec = svc.store.db.prepare("SELECT s.id FROM slides s JOIN files f ON f.id = s.file_id JOIN slide_links l ON l.slide_id = s.id WHERE f.kind = 'word' LIMIT 1").get();
  const r3 = svc.related(wordSec.id);
  assert.strictEqual(r3.kind, 'word');
  assert.ok(r3.ppt.length > 0 && r3.ppt.every((x) => x.kind === 'ppt'), 'Word 章节推荐相关 PPT 页');
  svc.close();
});
