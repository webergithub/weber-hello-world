/**
 * 下载器测试：对着一个本地 HTTP 服务真下载，验证分块、续传与校验。
 *
 * 用真服务而不是 mock fetch，是因为要验证的恰恰是 HTTP 层行为——
 * Range 请求发得对不对、206 分片写到文件哪个偏移、断点怎么接上。
 * 这些用 mock 验证等于什么都没验证。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

// 必须在 import 下载器之前设置：模块在加载时读取分块大小。
process.env.CINEROUTE_CHUNK_BYTES = String(256 * 1024);
const { DownloadManager, safeFilename } = await import('../src/server/downloader.js');

const PAYLOAD = randomBytes(1024 * 1024);              // 1 MB → 4 个分块
const PAYLOAD_MD5 = createHash('md5').update(PAYLOAD).digest('hex');

/**
 * 起一个测试用媒体服务。
 * @param {{supportRange?: boolean}} [opts]
 */
async function startMediaServer({ supportRange = true } = {}) {
  /** @type {string[]} 收到的 Range 请求，供断言用 */
  const rangeLog = [];

  const server = http.createServer((req, res) => {
    if (req.method === 'HEAD') {
      res.writeHead(200, {
        'content-length': String(PAYLOAD.length),
        'content-type': 'video/mp4',
        ...(supportRange ? { 'accept-ranges': 'bytes' } : {}),
      });
      res.end();
      return;
    }

    const range = req.headers.range;
    if (supportRange && range) {
      rangeLog.push(range);
      const m = range.match(/bytes=(\d+)-(\d+)/);
      const start = Number(m[1]);
      const end = Math.min(Number(m[2]), PAYLOAD.length - 1);
      const slice = PAYLOAD.subarray(start, end + 1);
      res.writeHead(206, {
        'content-range': `bytes ${start}-${end}/${PAYLOAD.length}`,
        'content-length': String(slice.length),
        'accept-ranges': 'bytes',
        'content-type': 'video/mp4',
      });
      res.end(slice);
      return;
    }

    res.writeHead(200, { 'content-length': String(PAYLOAD.length), 'content-type': 'video/mp4' });
    res.end(PAYLOAD);
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/movie.mp4`,
    rangeLog,
    close: () => new Promise((r) => server.close(r)),
  };
}

/** 等任务跑到终态。 */
function waitFor(job) {
  return new Promise((resolve) => {
    const check = () => {
      if (['done', 'failed', 'canceled'].includes(job.status)) resolve(job.toJSON());
    };
    job.on('update', check);
    check();
  });
}

async function tmpdir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cineroute-test-'));
}

test('safeFilename 阻断目录穿越但保留正常文件名（含数字）', () => {
  assert.equal(safeFilename('../../etc/passwd'), 'passwd');
  assert.equal(safeFilename('/abs/path/movie.mp4'), 'movie.mp4');
  assert.equal(safeFilename('notld_restored_1080p.mp4'), 'notld_restored_1080p.mp4');
  assert.equal(safeFilename('a:b*c?.mp4'), 'a_b_c_.mp4');
  assert.equal(safeFilename(''), 'video.mp4');
});

test('分块并发下载：文件内容完整且 md5 校验通过', async (t) => {
  const media = await startMediaServer();
  const dir = await tmpdir();
  t.after(async () => { await media.close(); await fs.rm(dir, { recursive: true, force: true }); });

  const mgr = new DownloadManager({ dir, concurrency: 1 });
  const job = mgr.enqueue({
    url: media.url, filename: 'movie.mp4',
    bytes: PAYLOAD.length, checksums: { md5: PAYLOAD_MD5 },
  });
  const final = await waitFor(job);

  assert.equal(final.status, 'done', final.error || '');
  assert.equal(final.verify.checked, true);
  assert.equal(final.verify.ok, true);
  assert.equal(final.verify.algo, 'md5');

  const written = await fs.readFile(path.join(dir, 'movie.mp4'));
  assert.equal(written.length, PAYLOAD.length);
  assert.ok(written.equals(PAYLOAD), '落盘内容应与源文件逐字节一致');

  // 1MB / 256KB = 4 块
  assert.equal(media.rangeLog.length, 4);
  // 中间文件与进度记录都应清理干净
  assert.equal(await fs.access(path.join(dir, 'movie.mp4.part')).then(() => true, () => false), false);
  assert.equal(await fs.access(path.join(dir, 'movie.mp4.cineroute.json')).then(() => true, () => false), false);
});

test('校验和不匹配时判定失败，不把损坏文件当成品交付', async (t) => {
  const media = await startMediaServer();
  const dir = await tmpdir();
  t.after(async () => { await media.close(); await fs.rm(dir, { recursive: true, force: true }); });

  const mgr = new DownloadManager({ dir, concurrency: 1 });
  const job = mgr.enqueue({
    url: media.url, filename: 'movie.mp4',
    bytes: PAYLOAD.length, checksums: { md5: '0'.repeat(32) },
  });
  const final = await waitFor(job);

  assert.equal(final.status, 'failed');
  assert.equal(final.verify.ok, false);
  assert.match(final.error, /校验失败/);
  // 没有通过校验就不该出现在最终文件名下
  assert.equal(await fs.access(path.join(dir, 'movie.mp4')).then(() => true, () => false), false);
});

test('断点续传：已完成的分块不会重复下载', async (t) => {
  const media = await startMediaServer();
  const dir = await tmpdir();
  t.after(async () => { await media.close(); await fs.rm(dir, { recursive: true, force: true }); });

  const chunkSize = 256 * 1024;
  const partPath = path.join(dir, 'movie.mp4.part');
  const metaPath = path.join(dir, 'movie.mp4.cineroute.json');

  // 伪造一次"下到一半被打断"的现场：第 0、1 块已写好并记账。
  const handle = await fs.open(partPath, 'w+');
  await handle.truncate(PAYLOAD.length);
  await handle.write(PAYLOAD.subarray(0, chunkSize * 2), 0, chunkSize * 2, 0);
  await handle.close();
  await fs.writeFile(metaPath, JSON.stringify({
    url: media.url,
    totalBytes: PAYLOAD.length,
    chunkSize,
    doneChunks: [0, 1],
  }));

  const mgr = new DownloadManager({ dir, concurrency: 1 });
  const job = mgr.enqueue({
    url: media.url, filename: 'movie.mp4',
    bytes: PAYLOAD.length, checksums: { md5: PAYLOAD_MD5 },
  });
  const final = await waitFor(job);

  assert.equal(final.status, 'done', final.error || '');
  assert.equal(final.verify.ok, true, '续传后整体校验仍须通过');

  // 只补下剩余两块，且没有任何一块从 0 开始重下
  assert.equal(media.rangeLog.length, 2, `实际请求：${media.rangeLog.join(', ')}`);
  assert.ok(!media.rangeLog.some((r) => r.startsWith('bytes=0-')), '第 0 块不应被重复下载');
});

test('服务端不支持 Range 时退化为单流下载，结果依然正确', async (t) => {
  const media = await startMediaServer({ supportRange: false });
  const dir = await tmpdir();
  t.after(async () => { await media.close(); await fs.rm(dir, { recursive: true, force: true }); });

  const mgr = new DownloadManager({ dir, concurrency: 1 });
  const job = mgr.enqueue({
    url: media.url, filename: 'movie.mp4',
    bytes: PAYLOAD.length, checksums: { md5: PAYLOAD_MD5 },
  });
  const final = await waitFor(job);

  assert.equal(final.status, 'done', final.error || '');
  assert.equal(final.rangeSupported, false);
  assert.equal(final.resumable, false);
  const written = await fs.readFile(path.join(dir, 'movie.mp4'));
  assert.ok(written.equals(PAYLOAD));
});

test('上游未提供校验和时如实标注"未校验"，而不是假装校验通过', async (t) => {
  const media = await startMediaServer();
  const dir = await tmpdir();
  t.after(async () => { await media.close(); await fs.rm(dir, { recursive: true, force: true }); });

  const mgr = new DownloadManager({ dir, concurrency: 1 });
  const job = mgr.enqueue({ url: media.url, filename: 'movie.mp4', bytes: PAYLOAD.length, checksums: {} });
  const final = await waitFor(job);

  assert.equal(final.status, 'done');
  assert.equal(final.verify.checked, false);
  assert.match(final.verify.reason, /未提供校验和/);
});

test('下载队列按并发上限调度，全部任务最终完成', async (t) => {
  const media = await startMediaServer();
  const dir = await tmpdir();
  t.after(async () => { await media.close(); await fs.rm(dir, { recursive: true, force: true }); });

  const mgr = new DownloadManager({ dir, concurrency: 2 });
  const jobs = ['a.mp4', 'b.mp4', 'c.mp4'].map((name) =>
    mgr.enqueue({ url: media.url, filename: name, bytes: PAYLOAD.length, checksums: { md5: PAYLOAD_MD5 } }));

  const finals = await Promise.all(jobs.map(waitFor));
  assert.deepEqual(finals.map((f) => f.status), ['done', 'done', 'done']);
  assert.equal(mgr.list().length, 3);
});
