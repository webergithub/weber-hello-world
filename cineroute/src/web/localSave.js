/**
 * 离线下载：直接存到**你自己的机器**上。
 *
 * 以前点「离线下载」是让服务端把文件下到它自己的 `downloads/` 目录里。
 * 服务跑在本机时那还说得过去；一旦按 deploy/ 里的方式部署到远程服务器，
 * 那个目录对你毫无用处——文件下到了别人的机器上。
 *
 * 现在走两条路，按浏览器能力自动选：
 *
 *  A. **分块并发直存**（Chromium 系 + https/localhost）
 *     用 File System Access API 让你选保存位置，拿到一个可写流，
 *     然后开 N 路 Range 请求并发下载，各自写到文件的对应偏移上。
 *     写完再把文件读一遍算校验和。全程不经过内存缓冲整个文件，
 *     2GB 的片子也不会把标签页撑爆。
 *
 *  B. **浏览器直接下载**（Firefox / Safari，或非安全上下文）
 *     退化成一个普通的下载链接，由浏览器自己流式存到下载目录。
 *     换来的代价是**没法校验**——校验要在写盘的同时算，而这条路
 *     字节根本不经过我们的代码。界面上会如实说明这一点，不假装校验过。
 *
 * 两条路都经过本机的 `/media` 代理，所以白名单、逐跳跳转校验这些
 * 安全边界一个都没绕过。
 */

import { createDigest, pickAlgo } from './digest.js';

/** 分块大小。与服务端下载器保持一致，方便对照。 */
const CHUNK_BYTES = 8 * 1024 * 1024;
/** 并发路数。 */
const THREADS = 4;
/** 单个分块的重试次数。 */
const CHUNK_RETRIES = 3;
/** 校验时每次读多大。 */
const VERIFY_SLICE = 4 * 1024 * 1024;

const proxied = (url) => `/media?url=${encodeURIComponent(url)}`;

/** 这个浏览器能不能走 A 路（直接写到你选的文件里）。 */
export function canSaveToPickedFile() {
  return typeof globalThis.showSaveFilePicker === 'function';
}

/** 批量下载要一次选一个目录，否则每个文件都弹一次窗（而且弹不出来）。 */
export function canPickDirectory() {
  return typeof globalThis.showDirectoryPicker === 'function';
}

/**
 * 让用户选保存位置。
 *
 * **必须在用户手势里同步调用**（点击处理函数的第一件事），
 * 中间只要 await 过一次，浏览器就会以"不是用户操作触发的"为由拒绝弹窗。
 *
 * @param {string} filename
 * @returns {Promise<FileSystemFileHandle|null>} 用户取消返回 null
 */
export async function pickSaveTarget(filename) {
  try {
    return await globalThis.showSaveFilePicker({
      suggestedName: filename,
      startIn: 'downloads',
    });
  } catch (err) {
    if (err?.name === 'AbortError') return null;   // 用户点了取消，不是错误
    throw err;
  }
}

/** 批量：选一个目录。 */
export async function pickSaveDirectory() {
  try {
    return await globalThis.showDirectoryPicker({ mode: 'readwrite', startIn: 'downloads' });
  } catch (err) {
    if (err?.name === 'AbortError') return null;
    throw err;
  }
}

/* ── B 路：交给浏览器自己下 ───────────────────────────────── */

/**
 * 退化路径：造一个下载链接点一下。
 *
 * 字节不经过我们的代码，所以**校验不了**——调用方要如实告诉用户。
 */
export function browserDownload(source) {
  const a = document.createElement('a');
  a.href = `${proxied(source.url)}&download=1`;
  a.download = source.filename || 'video.mp4';
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
}

/* ── A 路：分块并发直存 ───────────────────────────────────── */

/** 先摸一次：总大小、支不支持 Range。 */
async function probe(url, signal) {
  const res = await fetch(proxied(url), { headers: { range: 'bytes=0-1' }, signal });
  if (!res.ok && res.status !== 206) {
    throw new Error(`上游返回 HTTP ${res.status}`);
  }
  // 读掉这两个字节，别让连接挂着
  await res.arrayBuffer().catch(() => {});

  const cr = res.headers.get('content-range');
  let size = null;
  if (cr) {
    const m = cr.match(/\/(\d+)\s*$/);
    if (m) size = Number(m[1]);
  }
  if (size == null) {
    const cl = res.headers.get('content-length');
    if (cl) size = Number(cl);
  }
  return { size, rangeSupported: res.status === 206 };
}

/**
 * 校验：把写好的文件读一遍算哈希。
 *
 * 为什么不边下边算：分块是并发的，到达顺序是乱的，而 MD5/SHA-1 必须
 * 按字节顺序喂。所以写完之后顺序读一遍——多一次本地磁盘 I/O，
 * 但不多占内存（一次只读 4MB），也不多耗网络。
 */
async function verifyFile(handle, checksums, onProgress) {
  const algo = pickAlgo(checksums);
  if (!algo) return { checked: false, reason: '上游未提供校验和' };

  const file = await handle.getFile();
  const hasher = createDigest(algo);
  let read = 0;
  for (let pos = 0; pos < file.size; pos += VERIFY_SLICE) {
    const slice = file.slice(pos, Math.min(pos + VERIFY_SLICE, file.size));
    hasher.update(new Uint8Array(await slice.arrayBuffer()));
    read += slice.size;
    if (onProgress) onProgress(read, file.size);
  }

  const got = hasher.digest();
  const want = String(checksums[algo]).toLowerCase();
  return { checked: true, algo, ok: got === want, expected: want, actual: got };
}

/**
 * 把一个片源下载并写进你选好的文件。
 *
 * @param {object} source 片源（要有 url / filename / bytes / checksums）
 * @param {FileSystemFileHandle} handle 目标文件
 * @param {{threads?: number, signal?: AbortSignal,
 *          onUpdate?: (state: object) => void}} [opts]
 */
export async function saveToDisk(source, handle, opts = {}) {
  const { threads = THREADS, signal, onUpdate = () => {} } = opts;
  const startedAt = Date.now();

  let received = 0;
  let total = source.bytes ?? null;
  let status = 'downloading';
  let error = null;
  let verify = null;

  const emit = () => {
    const elapsed = (Date.now() - startedAt) / 1000;
    onUpdate({
      status,
      receivedBytes: received,
      totalBytes: total,
      percent: total ? Math.min(100, Math.round((received / total) * 1000) / 10) : null,
      bytesPerSec: elapsed > 0 ? Math.round(received / elapsed) : 0,
      verify,
      error,
    });
  };
  emit();

  const writable = await handle.createWritable();

  try {
    const info = await probe(source.url, signal);
    if (info.size) total = info.size;
    emit();

    if (!info.rangeSupported || !total) {
      // 上游不支持 Range：只能单流顺序写
      const res = await fetch(proxied(source.url), { signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const reader = res.body.getReader();
      let pos = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        await writable.write({ type: 'write', position: pos, data: value });
        pos += value.length;
        received = pos;
        emit();
      }
      if (!total) total = pos;
    } else {
      // 分块并发。每块下完立刻写到它该在的偏移上，顺序无所谓。
      const chunkCount = Math.ceil(total / CHUNK_BYTES);
      let next = 0;

      const worker = async () => {
        for (;;) {
          const index = next++;
          if (index >= chunkCount) return;
          if (signal?.aborted) throw new Error('已取消');

          const start = index * CHUNK_BYTES;
          const end = Math.min(start + CHUNK_BYTES, total) - 1;

          let lastErr = null;
          for (let attempt = 0; attempt <= CHUNK_RETRIES; attempt += 1) {
            try {
              const res = await fetch(proxied(source.url), {
                headers: { range: `bytes=${start}-${end}` },
                signal,
              });
              if (res.status !== 206 && res.status !== 200) {
                throw new Error(`分块 ${index} 返回 HTTP ${res.status}`);
              }
              const buf = await res.arrayBuffer();
              await writable.write({ type: 'write', position: start, data: buf });
              received += buf.byteLength;
              emit();
              lastErr = null;
              break;
            } catch (err) {
              if (signal?.aborted) throw err;
              lastErr = err;
              // 退避一下再试，上游偶发 5xx 很常见
              await new Promise((r) => setTimeout(r, 300 * 2 ** attempt));
            }
          }
          if (lastErr) throw lastErr;
        }
      };

      await Promise.all(Array.from({ length: Math.min(threads, chunkCount) }, worker));
    }

    await writable.close();

    status = 'verifying';
    emit();
    verify = await verifyFile(handle, source.checksums, (done, all) => {
      // 校验阶段借用同一个进度条，让用户知道还在忙
      received = all ? Math.round(total * (done / all)) : received;
      emit();
    });
    received = total ?? received;

    status = verify.checked && verify.ok === false ? 'failed' : 'done';
    if (status === 'failed') error = `${verify.algo} 校验不通过，文件可能已损坏`;
    emit();
    return { status, verify };
  } catch (err) {
    // 关掉可写流，否则浏览器会把半截文件留在那儿并一直占着句柄
    await writable.abort?.().catch(() => {});
    status = signal?.aborted ? 'canceled' : 'failed';
    error = signal?.aborted ? '已取消' : String(err?.message || err);
    emit();
    return { status, error };
  }
}
