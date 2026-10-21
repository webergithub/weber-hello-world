'use strict';
// 简洁的 ZIP 写出器：本地头中直接写入 CRC 与大小（不使用 data descriptor），兼容 PowerPoint / LibreOffice / WPS。
// 大文件（视频）以 STORE 方式从源包流式拷贝，CRC 取自源包中央目录，不整体载入内存。
const fs = require('fs');
const zlib = require('zlib');

const crc32 = zlib.crc32 ? (b) => zlib.crc32(b) >>> 0 : (() => {
  const T = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; T[n] = c >>> 0; }
  return (b) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = T[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
})();

function dosTime(d) {
  return {
    time: ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() / 2) & 31),
    date: (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31),
  };
}

class ZipWriter {
  constructor(file) {
    this.fd = fs.openSync(file, 'w');
    this.offset = 0;
    this.entries = [];
    this.names = new Set();
    this.stamp = dosTime(new Date());
  }

  write(buf) {
    let off = 0;
    while (off < buf.length) off += fs.writeSync(this.fd, buf, off, buf.length - off);
    this.offset += buf.length;
  }

  header(name, method, crc, csize, usize) {
    const nb = Buffer.from(name, 'utf8');
    if (this.offset > 0xfffffff0 || csize > 0xfffffff0 || usize > 0xfffffff0) throw new Error('导出文件超过 4GB，暂不支持');
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(method, 8);
    h.writeUInt16LE(this.stamp.time, 10); h.writeUInt16LE(this.stamp.date, 12);
    h.writeUInt32LE(crc, 14); h.writeUInt32LE(csize, 18); h.writeUInt32LE(usize, 22); h.writeUInt16LE(nb.length, 26); h.writeUInt16LE(0, 28);
    this.entries.push({ nb, method, crc, csize, usize, offset: this.offset });
    this.write(h); this.write(nb);
  }

  addBuffer(name, data, { store = false } = {}) {
    if (this.names.has(name)) throw new Error('重复的部件 ' + name);
    this.names.add(name);
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    const crc = crc32(buf);
    const comp = store ? buf : zlib.deflateRawSync(buf, { level: 6 });
    const useStore = store || comp.length >= buf.length;
    this.header(name, useStore ? 0 : 8, crc, useStore ? buf.length : comp.length, buf.length);
    this.write(useStore ? buf : comp);
  }

  /** 以 STORE 方式写入已知 CRC 与大小的流 */
  async addStream(name, readable, size, crc) {
    this.names.add(name);
    this.header(name, 0, crc >>> 0, size, size);
    let n = 0;
    for await (const chunk of readable) { this.write(chunk); n += chunk.length; }
    if (n !== size) throw new Error(`部件大小不一致 ${name}: ${n} != ${size}`);
  }

  finish() {
    const start = this.offset;
    for (const e of this.entries) {
      const c = Buffer.alloc(46);
      c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(e.method, 10);
      c.writeUInt16LE(this.stamp.time, 12); c.writeUInt16LE(this.stamp.date, 14);
      c.writeUInt32LE(e.crc, 16); c.writeUInt32LE(e.csize, 20); c.writeUInt32LE(e.usize, 24); c.writeUInt16LE(e.nb.length, 28);
      c.writeUInt32LE(e.offset, 42);
      this.write(c); this.write(e.nb);
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(this.entries.length, 8); end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(this.offset - start, 12); end.writeUInt32LE(start, 16);
    this.write(end);
    fs.closeSync(this.fd);
  }

  abort() { try { fs.closeSync(this.fd); } catch { /* ignore */ } }
}

module.exports = { ZipWriter, crc32 };
