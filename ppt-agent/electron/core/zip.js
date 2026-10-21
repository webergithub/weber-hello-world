'use strict';
// 基于 yauzl 的随机访问 zip 读取：只解压需要的部件，视频等大文件按区间读取，不整体载入内存。
const fs = require('fs');
const yauzl = require('yauzl');

function openZip(file) {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: false, decodeStrings: true, strictFileNames: false }, (err, zip) => {
      if (err) return reject(err);
      const entries = new Map();
      zip.on('entry', (e) => { entries.set(e.fileName, e); zip.readEntry(); });
      zip.on('end', () => resolve(new ZipPackage(zip, entries, file)));
      zip.on('error', reject);
      zip.readEntry();
    });
  });
}

class ZipPackage {
  constructor(zip, entries, file) {
    this.zip = zip;
    this.file = file;
    this.entries = entries;
    // OOXML 部件名大小写不敏感
    this.lower = new Map();
    for (const k of entries.keys()) this.lower.set(k.toLowerCase(), k);
  }

  resolveName(name) {
    name = name.replace(/^\//, '');
    if (this.entries.has(name)) return name;
    return this.lower.get(name.toLowerCase()) || null;
  }

  has(name) { return this.resolveName(name) !== null; }

  size(name) {
    const n = this.resolveName(name);
    return n ? this.entries.get(n).uncompressedSize : 0;
  }

  names() { return [...this.entries.keys()]; }

  dataOffset(entry) {
    if (entry._dataStart !== undefined) return entry._dataStart;
    const fd = fs.openSync(this.file, 'r');
    try {
      const lh = Buffer.alloc(30);
      fs.readSync(fd, lh, 0, 30, entry.relativeOffsetOfLocalHeader);
      if (lh.readUInt32LE(0) !== 0x04034b50) throw new Error('本地文件头损坏: ' + entry.fileName);
      entry._dataStart = entry.relativeOffsetOfLocalHeader + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
      return entry._dataStart;
    } finally { fs.closeSync(fd); }
  }

  stream(name, opts = {}) {
    const n = this.resolveName(name);
    if (!n) return Promise.reject(new Error('部件不存在: ' + name));
    const entry = this.entries.get(n);
    if (entry.compressionMethod === 0 && this.file && !entry.isEncrypted()) {
      // 未压缩部件直接按文件偏移读取（yauzl 对大的 STORE 条目可能挂起）
      try {
        const start = this.dataOffset(entry);
        if (!entry.uncompressedSize) return Promise.resolve(require('stream').Readable.from([]));
        return Promise.resolve(fs.createReadStream(this.file, { start, end: start + entry.uncompressedSize - 1, highWaterMark: 1 << 20 }));
      } catch (e) { return Promise.reject(e); }
    }
    return new Promise((resolve, reject) => {
      this.zip.openReadStream(entry, opts, (err, rs) => (err ? reject(err) : resolve(rs)));
    });
  }

  async buffer(name, maxBytes = 512 * 1024 * 1024) {
    const n = this.resolveName(name);
    if (!n) return null;
    if (this.entries.get(n).uncompressedSize > maxBytes) throw new Error(`部件过大(${n})`);
    const rs = await this.stream(n);
    const chunks = [];
    for await (const c of rs) chunks.push(c);
    return Buffer.concat(chunks);
  }

  async text(name) {
    const b = await this.buffer(name);
    if (!b) return null;
    let s = b.toString('utf8');
    if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
    return s;
  }

  // 对未压缩（STORED）的部件提供区间读取；压缩部件退化为整体读取
  async rangeReader(name) {
    const n = this.resolveName(name);
    if (!n) return null;
    const entry = this.entries.get(n);
    const size = entry.uncompressedSize;
    if (entry.compressionMethod === 0 && this.file) {
      // 未压缩部件：按数据偏移直接用文件句柄区间读取
      const dataStart = this.dataOffset(entry);
      const fd = fs.openSync(this.file, 'r');
      return {
        size,
        read: async (start, len) => {
          const l = Math.max(0, Math.min(len, size - start));
          const b = Buffer.alloc(l);
          if (l) fs.readSync(fd, b, 0, l, dataStart + start);
          return b;
        },
        close: () => { try { fs.closeSync(fd); } catch { /* ignore */ } },
      };
    }
    if (size > 300 * 1024 * 1024) return null;
    const all = await this.buffer(n);
    return { size, read: async (start, len) => all.subarray(start, Math.min(all.length, start + len)) };
  }

  close() { try { this.zip.close(); } catch { /* ignore */ } }
}

module.exports = { openZip };
