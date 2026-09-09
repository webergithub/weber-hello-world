/**
 * 落盘文件名的安全性。
 *
 * `/api/download` 的 filename 是**客户端传进来的**，而客户端拿到的又是
 * 上游归档站的文件名——第三方用户上传的内容。所以这个值必须当成敌意输入：
 * 它最终会变成服务器上的一个路径。
 *
 * 拿片名清单里的中英文片名当输入（`Thunderbolts*`、`Deadpool & Wolverine`、
 * 《你好，李焕英》这类真的会出现的写法），再加一批标准的穿越样本。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { safeFilename, DownloadManager } from '../src/server/downloader.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORPUS = JSON.parse(readFileSync(path.join(HERE, 'corpus/titles.json'), 'utf8'));
const TITLES = [...CORPUS.zh, ...CORPUS.en, ...CORPUS.edge].map((e) => e.q);

/* ── 目录穿越 ─────────────────────────────────────────────── */

const HOSTILE = [
  '../../../etc/passwd',
  '../../etc/shadow',
  '/etc/passwd',
  '....//....//etc/passwd',
  '..\\..\\Windows\\System32\\drivers\\etc\\hosts',
  'C:\\Windows\\System32\\config\\SAM',
  '..',
  '../',
  '.',
  '...',
  './.ssh/authorized_keys',
  'foo/../../bar.mp4',
  '\u0000etc/passwd',
  'a\nb/../c.mp4',
  '~/.bashrc',
  '$HOME/.bashrc',
];

test('恶意文件名落不出下载目录', () => {
  const dir = '/srv/cineroute/downloads';
  const bad = [];
  for (const name of HOSTILE) {
    const safe = safeFilename(name);
    const full = path.resolve(dir, safe);
    if (path.dirname(full) !== dir) bad.push(`  · 「${name}」→「${safe}」落在 ${path.dirname(full)}`);
    if (safe.includes('/') || safe.includes('\\')) bad.push(`  · 「${name}」→「${safe}」还带着路径分隔符`);
    if (!safe) bad.push(`  · 「${name}」清成了空串`);
    if (/^\.+$/.test(safe)) bad.push(`  · 「${name}」→「${safe}」是纯点号`);
  }
  assert.equal(bad.length, 0, `${bad.length} 个穿越样本没挡住：\n${bad.join('\n')}`);
});

test('片名清单里的真实片名不会被清洗坏', () => {
  const dir = '/srv/cineroute/downloads';
  const bad = [];
  for (const t of TITLES) {
    for (const ext of ['.mp4', '.mkv']) {
      const safe = safeFilename(`${t}${ext}`);
      const full = path.resolve(dir, safe);
      if (path.dirname(full) !== dir) bad.push(`  · 「${t}」→「${safe}」跑出了下载目录`);
      if (!safe.endsWith(ext)) bad.push(`  · 「${t}」→「${safe}」丢了扩展名`);
      // 中文、数字、字母这些正常字符不该被抹掉
      const kept = [...t].filter((c) => /[\p{L}\p{N}]/u.test(c));
      const missing = kept.filter((c) => !safe.includes(c));
      if (missing.length) bad.push(`  · 「${t}」→「${safe}」丢了字符：${missing.join('')}`);
    }
  }
  assert.equal(bad.length, 0, `${bad.length} 处片名被清洗坏：\n${bad.join('\n')}`);
});

test('文件名长度不能超过文件系统上限（255 字节）', async () => {
  // 归档站的条目名可以非常长，中文一个字 3 字节，很容易撞上限。
  // 撞上了不是"名字难看"，是 open() 直接 ENAMETOOLONG，整个下载失败。
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cineroute-name-'));
  try {
    const cases = [
      ['英文超长', `${'a'.repeat(400)}.mp4`],
      ['中文超长', `${'流浪地球'.repeat(60)}.mp4`],
      ['中英混合超长', `${'流浪地球The Wandering Earth '.repeat(20)}.mkv`],
    ];
    const bad = [];
    for (const [what, name] of cases) {
      const safe = safeFilename(name);
      const bytes = Buffer.byteLength(safe, 'utf8');
      if (bytes > 255) { bad.push(`  · ${what}：清洗后仍有 ${bytes} 字节`); continue; }
      // 真写一下，确认文件系统收得下
      try {
        await fs.writeFile(path.join(dir, safe), 'x');
      } catch (err) {
        bad.push(`  · ${what}：写盘失败 ${err.code}（文件名 ${bytes} 字节）`);
      }
      // 截断不能把扩展名切掉——播放器和校验都靠它
      if (!safe.endsWith('.mp4') && !safe.endsWith('.mkv')) {
        bad.push(`  · ${what}：截断后丢了扩展名 →「${safe.slice(-30)}」`);
      }
    }
    assert.equal(bad.length, 0, `${bad.length} 处超长文件名没处理好：\n${bad.join('\n')}`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('同名的两个下载任务不会互相覆盖', async () => {
  // 很常见：同一部片子在两个源上都叫 video.mp4，或者两条不同的片源
  // 恰好同名。两个任务写同一个路径 = 文件互相踩，校验和还都对不上。
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cineroute-dup-'));
  try {
    const mgr = new DownloadManager({ dir, concurrency: 0 });   // 不真跑，只看排期
    const a = mgr.enqueue({ url: 'https://archive.org/download/a/video.mp4', filename: 'video.mp4' });
    const b = mgr.enqueue({ url: 'https://archive.org/download/b/video.mp4', filename: 'video.mp4' });
    assert.notEqual(a.id, b.id, '两个任务应有不同的 id');
    assert.notEqual(
      a.targetPath, b.targetPath,
      `两个不同的下载任务落到了同一个文件：${a.targetPath}`,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('同一个地址 + 同一个名字重复提交 = 同一个任务（不能两个写手抢一个 .part）', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cineroute-same-'));
  try {
    const mgr = new DownloadManager({ dir, concurrency: 0 });
    const url = 'https://archive.org/download/x/movie.mp4';
    const a = mgr.enqueue({ url, filename: 'movie.mp4' });
    const b = mgr.enqueue({ url, filename: 'movie.mp4' });
    assert.equal(a.id, b.id, '重复提交应返回同一个任务');
    assert.equal(mgr.list().length, 1);

    // 但同一个地址存成两个不同的名字是合法的：两条路径，不会互相踩
    const c = mgr.enqueue({ url, filename: '备份.mp4' });
    assert.notEqual(c.id, a.id);
    assert.notEqual(c.targetPath, a.targetPath);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('伴生文件（.part / .cineroute.json）也要落得下', async () => {
  // 主文件名卡在 255 字节正好合法，但 `.cineroute.json` 再加 15 字节就超了，
  // 而那个写入是 catch 掉的——断点续传会静默失效，查都查不出来
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cineroute-side-'));
  try {
    const mgr = new DownloadManager({ dir, concurrency: 0 });
    const job = mgr.enqueue({
      url: 'https://archive.org/download/x/y.mp4',
      filename: `${'流浪地球'.repeat(80)}.mp4`,
    });
    const bad = [];
    for (const [what, p] of [['正片', job.targetPath], ['分块', job.partPath], ['续传记录', job.metaPath]]) {
      const bytes = Buffer.byteLength(path.basename(p), 'utf8');
      if (bytes > 255) { bad.push(`  · ${what}文件名 ${bytes} 字节`); continue; }
      try {
        await fs.writeFile(p, 'x');
      } catch (err) {
        bad.push(`  · ${what}写盘失败 ${err.code}（${bytes} 字节）`);
      }
    }
    assert.equal(bad.length, 0, `伴生文件落不下：\n${bad.join('\n')}`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('清洗规则本身：该保的保住，该换的换掉', () => {
  // 这几条是回归位置，改清洗规则时不许破
  assert.equal(safeFilename('notld_restored_1080p.mp4'), 'notld_restored_1080p.mp4', '正常文件名原样保留');
  assert.equal(safeFilename('哪吒之魔童闹海.mp4'), '哪吒之魔童闹海.mp4', '中文原样保留');
  assert.equal(safeFilename('Thunderbolts*.mp4'), 'Thunderbolts_.mp4', '星号是 Windows 非法字符');
  assert.equal(safeFilename('Deadpool & Wolverine.mp4'), 'Deadpool & Wolverine.mp4', '& 是合法字符，别动它');
  assert.equal(safeFilename('Dune: Part Two.mp4'), 'Dune_ Part Two.mp4', '冒号在 Windows 上非法');
  assert.equal(safeFilename(''), 'video.mp4', '空串走兜底');
  assert.equal(safeFilename(null), 'video.mp4', 'null 走兜底');
  assert.equal(safeFilename('   '), 'video.mp4', '纯空白走兜底');
});
