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
  const id = svc.addTask(lib);
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
  const id2 = svc.addTask(lib);
  const t2 = await done(id2);
  assert.match(t2.message, /解析 0，/);
  svc.close();
});
