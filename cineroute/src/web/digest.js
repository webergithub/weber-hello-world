/**
 * 增量 MD5 / SHA-1（纯 JS，零依赖）。
 *
 * 为什么要自己写：下载改成直接存到你本机之后，校验也得在浏览器里做。
 * 而浏览器的 Web Crypto **不支持 MD5**（只有 SHA-1/256/384/512），
 * 就算是 SHA-1 也**不支持流式**——`crypto.subtle.digest` 要一次吃进整个
 * 缓冲区。一部 2GB 的电影没法整个塞进内存去算一次哈希。
 *
 * 所以这里实现成可以一块一块喂的形式：下载到哪儿就算到哪儿，
 * 内存里只留 64 字节的尾巴。
 *
 * 两个算法都是 Merkle–Damgård 结构、64 字节分组、末尾补长度，
 * 差别只在压缩函数，所以缓冲那一层是共用的。
 *
 * 正确性由测试对着 node:crypto 逐一比对保证（见 test/digest.test.js），
 * 包括跨分组边界的喂法——那是这类实现最容易写错的地方。
 */

/** 32 位左循环。 */
const rotl = (x, n) => (x << n) | (x >>> (32 - n));

/**
 * 分组缓冲：把任意长度的输入切成 64 字节的块喂给压缩函数，
 * 不足一块的尾巴留着等下一次 update。
 */
class BlockHasher {
  constructor() {
    this.buf = new Uint8Array(64);
    this.bufLen = 0;
    /** 已处理的总字节数，补位时要写进末尾 8 字节 */
    this.total = 0;
  }

  update(bytes) {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    this.total += data.length;
    let off = 0;

    // 先把上次剩下的尾巴补满
    if (this.bufLen > 0) {
      const need = 64 - this.bufLen;
      if (data.length < need) {
        this.buf.set(data, this.bufLen);
        this.bufLen += data.length;
        return this;
      }
      this.buf.set(data.subarray(0, need), this.bufLen);
      this._compress(this.buf, 0);
      this.bufLen = 0;
      off = need;
    }

    // 整块直接压，不复制
    for (; off + 64 <= data.length; off += 64) this._compress(data, off);

    // 剩下的存起来
    if (off < data.length) {
      this.buf.set(data.subarray(off), 0);
      this.bufLen = data.length - off;
    }
    return this;
  }

  /** 补位：0x80 + 若干 0 + 8 字节长度（字节序由子类决定）。 */
  _pad(lengthLittleEndian) {
    const bitLen = this.total * 8;
    const padLen = this.bufLen < 56 ? 56 - this.bufLen : 120 - this.bufLen;
    const tail = new Uint8Array(padLen + 8);
    tail[0] = 0x80;

    // 长度按 64 位写。JS 的位运算是 32 位的，所以高低位分开算。
    const lo = bitLen >>> 0;
    const hi = Math.floor(bitLen / 2 ** 32) >>> 0;
    const dv = new DataView(tail.buffer, tail.byteOffset + padLen, 8);
    if (lengthLittleEndian) {
      dv.setUint32(0, lo, true);
      dv.setUint32(4, hi, true);
    } else {
      dv.setUint32(0, hi, false);
      dv.setUint32(4, lo, false);
    }
    this.update(tail);
  }
}

/* ── MD5 ──────────────────────────────────────────────────── */

/** 每轮的左移位数。 */
const MD5_S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

/** K[i] = floor(2^32 × |sin(i+1)|)。 */
const MD5_K = new Int32Array(
  Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32)),
);

export class Md5 extends BlockHasher {
  constructor() {
    super();
    this.h = new Int32Array([0x67452301, -0x10325477, -0x67452302, 0x10325476]);
    this.w = new Int32Array(16);
  }

  _compress(block, off) {
    const { w } = this;
    // MD5 的分组是小端 32 位字
    for (let i = 0; i < 16; i += 1) {
      const p = off + i * 4;
      w[i] = block[p] | (block[p + 1] << 8) | (block[p + 2] << 16) | (block[p + 3] << 24);
    }

    let [a, b, c, d] = this.h;

    for (let i = 0; i < 64; i += 1) {
      let f;
      let g;
      if (i < 16) { f = (b & c) | (~b & d); g = i; }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
      else { f = c ^ (b | ~d); g = (7 * i) % 16; }

      const tmp = d;
      d = c;
      c = b;
      b = (b + rotl((a + f + MD5_K[i] + w[g]) | 0, MD5_S[i])) | 0;
      a = tmp;
    }

    this.h[0] = (this.h[0] + a) | 0;
    this.h[1] = (this.h[1] + b) | 0;
    this.h[2] = (this.h[2] + c) | 0;
    this.h[3] = (this.h[3] + d) | 0;
  }

  digest() {
    this._pad(true);                  // MD5 的长度字段是小端
    let out = '';
    for (let i = 0; i < 4; i += 1) {
      const v = this.h[i];
      // 输出也是小端：低位字节在前
      for (let b = 0; b < 4; b += 1) {
        out += (((v >>> (b * 8)) & 0xff) + 0x100).toString(16).slice(1);
      }
    }
    return out;
  }
}

/* ── SHA-1 ────────────────────────────────────────────────── */

export class Sha1 extends BlockHasher {
  constructor() {
    super();
    // SHA-1 的初始值：67452301 EFCDAB89 98BADCFE 10325476 C3D2E1F0
    // 这里写成有符号 32 位。最后一个 0xC3D2E1F0 换算过来是 -0x3C2D1E10，
    // 不是 -0x3C2D1E0F —— 差一位的话每个结果都错，而且错得很安静。
    this.h = new Int32Array([0x67452301, -0x10325477, -0x67452302, 0x10325476, -0x3c2d1e10]);
    this.w = new Int32Array(80);
  }

  _compress(block, off) {
    const { w } = this;
    // SHA-1 的分组是大端 32 位字
    for (let i = 0; i < 16; i += 1) {
      const p = off + i * 4;
      w[i] = (block[p] << 24) | (block[p + 1] << 16) | (block[p + 2] << 8) | block[p + 3];
    }
    for (let i = 16; i < 80; i += 1) {
      w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    }

    let [a, b, c, d, e] = this.h;

    for (let i = 0; i < 80; i += 1) {
      let f;
      let k;
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = -0x70e44324; }
      else { f = b ^ c ^ d; k = -0x359d3e2a; }

      const tmp = (rotl(a, 5) + f + e + k + w[i]) | 0;
      e = d;
      d = c;
      c = rotl(b, 30);
      b = a;
      a = tmp;
    }

    this.h[0] = (this.h[0] + a) | 0;
    this.h[1] = (this.h[1] + b) | 0;
    this.h[2] = (this.h[2] + c) | 0;
    this.h[3] = (this.h[3] + d) | 0;
    this.h[4] = (this.h[4] + e) | 0;
  }

  digest() {
    this._pad(false);                 // SHA-1 的长度字段是大端
    let out = '';
    for (let i = 0; i < 5; i += 1) {
      out += ((this.h[i] >>> 0) + 0x1_0000_0000).toString(16).slice(1);
    }
    return out;
  }
}

/** 按名字造一个增量哈希器。认不出来的算法返回 null（表示"没法校验"）。 */
export function createDigest(algo) {
  if (algo === 'md5') return new Md5();
  if (algo === 'sha1') return new Sha1();
  return null;
}

/**
 * 挑一个能用的校验算法。
 * 与服务端下载器保持一致：优先 md5，其次 sha1，都没有就没法校验。
 */
export function pickAlgo(checksums) {
  if (checksums?.md5) return 'md5';
  if (checksums?.sha1) return 'sha1';
  return null;
}
