/**
 * 离线下载器：Range 分块并发 + 断点续传 + 校验和验证。
 *
 * 为什么不直接 `curl -O`：
 *  - 大文件单流下载受单连接带宽限制，分块并发能吃满链路；
 *  - 归档站的长连接容易中断，没有续传就要从头再来（2GB 的片子重来一次很致命）；
 *  - Internet Archive 在 metadata 里给了每个文件的 md5/sha1，
 *    下完不校验等于白下——静默损坏的视频往往播到一半才爆。
 *
 * 断点续传靠一个与 .part 同目录的 .cineroute.json 记录已完成分块，
 * 进程重启后能接着下。服务端不支持 Range 时自动退化为单流顺序下载。
 */

import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { httpRequest, httpProbeHeaders } from '../core/http.js';

const CHUNK_SIZE = Number(process.env.CINEROUTE_CHUNK_BYTES || 8 * 1024 * 1024);
const CHUNK_CONCURRENCY = Number(process.env.CINEROUTE_CHUNK_CONCURRENCY || 4);

/**
 * 文件名的字节上限。
 *
 * 常见文件系统（ext4 / APFS / NTFS）单个文件名的上限是 255 字节——**字节**不是字符，
 * 一个汉字 3 字节，八十来个字就撞线了，归档站的长条目名很容易超。超了不是
 * "名字难看"，是 open() 直接 ENAMETOOLONG，整个下载失败。
 *
 * 这里留 240 而不是 255：同一个任务还要写两个伴生文件，后缀最长的是
 * `.cineroute.json`（15 字节）。只卡主文件名的话，正片能落盘、续传记录
 * 却写不进去，而那个写入是 catch 掉的——断点续传会**静默**失效。
 */
const MAX_FILENAME_BYTES = 240;

/** 按字节截断，且不把一个多字节字符切成两半，同时保住扩展名。 */
function capBytes(name, max = MAX_FILENAME_BYTES) {
  if (Buffer.byteLength(name, 'utf8') <= max) return name;
  const rawExt = path.extname(name);
  // 扩展名本身也可能是垃圾（有人把整串塞在最后一个点后面），太长就不要了
  const ext = Buffer.byteLength(rawExt, 'utf8') <= 16 ? rawExt : '';
  const stem = rawExt ? name.slice(0, name.length - rawExt.length) : name;
  const budget = Math.max(1, max - Buffer.byteLength(ext, 'utf8'));
  // subarray 切在多字节字符中间时，toString 会在末尾留一个 U+FFFD，去掉它
  const cut = Buffer.from(stem, 'utf8').subarray(0, budget).toString('utf8').replace(/\uFFFD+$/, '');
  return `${cut}${ext}`;
}

/** 把不安全的文件名压成可落盘的形式，防目录穿越、防超长。 */
export function safeFilename(name, fallback = 'video.mp4') {
  const base = path.basename(String(name || '').trim());
  // 控制字符 + Windows 非法字符。注意不要写成 [\u0020-\u003c] 这种区间：
  // 0x20..0x3C 会连数字 0-9 一起吃掉，把 1080p 变成 ____p。
  const cleaned = base.replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_').replace(/^\.+/, '');
  return capBytes(cleaned) || fallback;
}

/** 名字被占了就加 `(2)`、`(3)`…，加完仍要守住字节上限。 */
function uniqueFilename(name, taken) {
  if (!taken.has(name)) return name;
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 2; i < 1000; i += 1) {
    const suffix = ` (${i})${ext}`;
    const candidate = capBytes(stem, MAX_FILENAME_BYTES - Buffer.byteLength(suffix, 'utf8')) + suffix;
    if (!taken.has(candidate)) return candidate;
  }
  return `${Date.now()}${ext}`;
}


/**
 * 单个下载任务。
 * 状态流转：queued → downloading → verifying → done
 *                              ↘ failed / canceled
 */
class DownloadJob extends EventEmitter {
  constructor({ id, url, filename, requestedFilename, bytes, checksums, dir }) {
    super();
    this.id = id;
    this.url = url;
    this.filename = filename;
    // 用户/前端请求的原始名字（已清洗，未错开）。判"是不是同一个任务"用它，
    // 因为 filename 可能已经被错开成 `video (2).mp4` 了。
    this.requestedFilename = requestedFilename ?? filename;
    this.dir = dir;
    this.targetPath = path.join(dir, filename);
    this.partPath = `${this.targetPath}.part`;
    this.metaPath = `${this.targetPath}.cineroute.json`;
    this.totalBytes = bytes || null;
    this.checksums = checksums || {};
    this.receivedBytes = 0;
    this.status = 'queued';
    this.error = null;
    this.rangeSupported = null;
    this.startedAt = null;
    this.finishedAt = null;
    this.verifyResult = null;
    this._abort = new AbortController();
    /** @type {Set<number>} 已完成的分块序号 */
    this._doneChunks = new Set();
  }

  toJSON() {
    const elapsed = this.startedAt ? ((this.finishedAt || Date.now()) - this.startedAt) / 1000 : 0;
    return {
      id: this.id,
      url: this.url,
      filename: this.filename,
      path: this.status === 'done' ? this.targetPath : this.partPath,
      status: this.status,
      totalBytes: this.totalBytes,
      receivedBytes: this.receivedBytes,
      percent: this.totalBytes ? Math.min(100, Math.round((this.receivedBytes / this.totalBytes) * 1000) / 10) : null,
      bytesPerSec: elapsed > 0 ? Math.round(this.receivedBytes / elapsed) : 0,
      rangeSupported: this.rangeSupported,
      resumable: this.rangeSupported === true,
      verify: this.verifyResult,
      error: this.error,
    };
  }

  cancel() {
    if (this.status === 'done') return;
    this.status = 'canceled';
    this._abort.abort(new Error('用户取消'));
    this.emit('update');
  }

  /** 读取上次中断留下的进度记录。 */
  async _loadMeta() {
    try {
      const meta = JSON.parse(await fs.readFile(this.metaPath, 'utf8'));
      if (meta.url === this.url && meta.totalBytes === this.totalBytes && Array.isArray(meta.doneChunks)) {
        this._doneChunks = new Set(meta.doneChunks);
        this.receivedBytes = this._doneChunks.size * CHUNK_SIZE;
        // 末块可能不足一个 CHUNK_SIZE，收敛到真实总量。
        if (this.totalBytes) this.receivedBytes = Math.min(this.receivedBytes, this.totalBytes);
        return true;
      }
    } catch { /* 无记录或记录不匹配，从头开始 */ }
    return false;
  }

  async _saveMeta() {
    const meta = {
      url: this.url,
      totalBytes: this.totalBytes,
      chunkSize: CHUNK_SIZE,
      doneChunks: [...this._doneChunks],
      updatedAt: Date.now(),
    };
    await fs.writeFile(this.metaPath, JSON.stringify(meta)).catch(() => {});
  }

  /** 分块并发下载。每块下完即落盘并记账，任意时刻中断都能续。 */
  async _downloadRanged(handle) {
    const total = this.totalBytes;
    const chunkCount = Math.ceil(total / CHUNK_SIZE);
    let nextChunk = 0;

    const worker = async () => {
      for (;;) {
        const index = nextChunk++;
        if (index >= chunkCount) return;
        if (this._doneChunks.has(index)) continue;
        if (this._abort.signal.aborted) return;

        const start = index * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, total) - 1;

        const res = await httpRequest(this.url, {
          headers: { range: `bytes=${start}-${end}` },
          signal: this._abort.signal,
          timeoutMs: 60000,
          retries: 3,
        });
        if (res.status !== 206 && res.status !== 200) {
          throw new Error(`分块 ${index} 返回 HTTP ${res.status}`);
        }

        const buf = Buffer.from(await res.arrayBuffer());
        await handle.write(buf, 0, buf.length, start);

        this._doneChunks.add(index);
        this.receivedBytes = Math.min(total, this.receivedBytes + buf.length);
        this.emit('update');
        // 每块都落一次进度，崩溃最多丢一块。
        await this._saveMeta();
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(CHUNK_CONCURRENCY, chunkCount) }, () => worker()),
    );
  }

  /** 服务端不支持 Range 时的退化路径：单流顺序写。 */
  async _downloadStreaming(handle) {
    const res = await httpRequest(this.url, {
      signal: this._abort.signal,
      timeoutMs: 60000,
      retries: 1,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (!this.totalBytes) {
      const len = res.headers.get('content-length');
      if (len) this.totalBytes = Number(len);
    }

    let position = 0;
    for await (const chunk of res.body) {
      if (this._abort.signal.aborted) throw new Error('已取消');
      const buf = Buffer.from(chunk);
      await handle.write(buf, 0, buf.length, position);
      position += buf.length;
      this.receivedBytes = position;
      this.emit('update');
    }
  }

  /** 用上游给的 md5/sha1 校验落盘文件。上游没给就跳过。 */
  async _verify() {
    const algo = this.checksums?.md5 ? 'md5' : this.checksums?.sha1 ? 'sha1' : null;
    if (!algo) {
      this.verifyResult = { checked: false, reason: '上游未提供校验和' };
      return true;
    }

    this.status = 'verifying';
    this.emit('update');

    const expected = String(this.checksums[algo]).toLowerCase();
    const hash = createHash(algo);
    await new Promise((resolve, reject) => {
      createReadStream(this.partPath)
        .on('data', (d) => hash.update(d))
        .on('end', resolve)
        .on('error', reject);
    });
    const actual = hash.digest('hex');
    const ok = actual === expected;
    this.verifyResult = { checked: true, algo, expected, actual, ok };
    return ok;
  }

  async run() {
    this.status = 'downloading';
    this.startedAt = Date.now();
    this.emit('update');

    let handle;
    try {
      await fs.mkdir(this.dir, { recursive: true });

      // 先探测：拿真实体积，并确认能不能分块。
      const probe = await httpProbeHeaders(this.url, { signal: this._abort.signal, timeoutMs: 15000 });
      if (probe) {
        const cr = probe.headers?.get?.('content-range');
        const total = cr?.match(/\/(\d+)\s*$/);
        if (total) this.totalBytes = Number(total[1]);
        else if (probe.headers?.get?.('content-length') && probe.status !== 206) {
          this.totalBytes = Number(probe.headers.get('content-length'));
        }
        this.rangeSupported = probe.status === 206
          || Boolean(cr)
          || (probe.headers?.get?.('accept-ranges') || '').includes('bytes');
      } else {
        this.rangeSupported = false;
      }

      const resumed = await this._loadMeta();
      handle = await fs.open(this.partPath, resumed ? 'r+' : 'w+');
      // 预分配，避免并发写稀疏文件时反复扩容。
      if (this.totalBytes && !resumed) await handle.truncate(this.totalBytes);

      if (this.rangeSupported && this.totalBytes) {
        await this._downloadRanged(handle);
      } else {
        this._doneChunks.clear();
        await this._downloadStreaming(handle);
      }

      await handle.close();
      handle = null;

      if (this._abort.signal.aborted) throw new Error('已取消');

      const ok = await this._verify();
      if (!ok) {
        this.status = 'failed';
        this.error = `校验失败：期望 ${this.verifyResult.expected}，实际 ${this.verifyResult.actual}`;
        this.emit('update');
        return;
      }

      await fs.rename(this.partPath, this.targetPath);
      await fs.unlink(this.metaPath).catch(() => {});
      this.status = 'done';
      this.finishedAt = Date.now();
      this.emit('update');
    } catch (err) {
      if (handle) await handle.close().catch(() => {});
      if (this.status !== 'canceled') {
        this.status = 'failed';
        this.error = String(err?.message || err);
      }
      this.finishedAt = Date.now();
      this.emit('update');
    }
  }
}

/** 下载队列：限制同时进行的任务数，其余排队。 */
export class DownloadManager extends EventEmitter {
  constructor({ dir, concurrency = 2 } = {}) {
    super();
    this.dir = dir || path.resolve(process.cwd(), 'downloads');
    this.concurrency = concurrency;
    /** @type {Map<string, DownloadJob>} */
    this.jobs = new Map();
    this._running = 0;
    /** @type {DownloadJob[]} */
    this._queue = [];
  }

  /**
   * 加入下载队列。
   * @param {{url: string, filename: string, bytes?: number|null, checksums?: object}} spec
   */
  enqueue(spec) {
    // 还活着的任务：已取消/已失败的不再占用文件名
    const live = [...this.jobs.values()].filter((j) => !['canceled', 'failed'].includes(j.status));

    const requested = safeFilename(spec.filename);

    // 同一个地址 + 同一个文件名重复提交就是同一个任务，把原来的还回去。
    // 不这么做的话两个任务会同时往同一个 .part 里写，分块互相盖掉，
    // 最后校验和还对不上——查起来像是上游给了坏文件。
    // 注意判据是**地址 + 文件名**：同一个地址存成两个不同的名字是合法的
    //（两个文件、两条路径，不会互相踩），不该被并成一个。
    const existing = live.find((j) => j.url === spec.url && j.requestedFilename === requested);
    if (existing) return existing;

    // 不同地址撞了同一个文件名（`video.mp4` 这种太常见了，或者两个源
    // 恰好同名）：错开，否则一样是互相踩，连续传记录都会串。
    const taken = new Set(live.map((j) => path.basename(j.targetPath)));
    const filename = uniqueFilename(requested, taken);

    const job = new DownloadJob({
      id: randomUUID(),
      url: spec.url,
      filename,
      requestedFilename: requested,
      bytes: spec.bytes ?? null,
      checksums: spec.checksums ?? {},
      dir: this.dir,
    });
    job.on('update', () => this.emit('update', job.toJSON()));
    this.jobs.set(job.id, job);
    this._queue.push(job);
    this.emit('update', job.toJSON());
    this._pump();
    return job;
  }

  _pump() {
    while (this._running < this.concurrency && this._queue.length > 0) {
      const job = this._queue.shift();
      if (job.status === 'canceled') continue;
      this._running += 1;
      job.run().finally(() => {
        this._running -= 1;
        this._pump();
      });
    }
  }

  list() {
    return [...this.jobs.values()].map((j) => j.toJSON());
  }

  get(id) {
    return this.jobs.get(id) || null;
  }

  cancel(id) {
    const job = this.jobs.get(id);
    if (!job) return false;
    job.cancel();
    return true;
  }
}

export { CHUNK_SIZE, CHUNK_CONCURRENCY, DownloadJob };
