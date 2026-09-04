/**
 * 增量 MD5 / SHA-1 的正确性。
 *
 * 这两个实现是"下载直存本机"那条路的地基：校验在浏览器里做，
 * 而浏览器的 Web Crypto 不支持 MD5、也不支持流式，只能自己写。
 * 自己写的哈希错一个位就全错，而且**错得很安静**——校验永远不通过，
 * 或者更糟，永远通过。所以这里逐一对着 node:crypto 比。
 *
 * 重点在**跨分组边界的喂法**：64 字节一组，正常路径很容易碰巧对，
 * 而在 63/64/65 字节、以及把一份数据切成奇怪的碎片分多次喂进去时才会露馅。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Md5, Sha1, createDigest, pickAlgo } from '../src/web/digest.js';

const ref = (algo, bytes) => createHash(algo).update(Buffer.from(bytes)).digest('hex');

const mine = (algo, chunks) => {
  const h = createDigest(algo);
  for (const c of chunks) h.update(c);
  return h.digest();
};

/** 可重现的伪随机字节，不依赖 Math.random，失败时能原样复现。 */
function bytes(n, seed = 1) {
  const out = new Uint8Array(n);
  let x = seed >>> 0;
  for (let i = 0; i < n; i += 1) {
    x = (x * 1664525 + 1013904223) >>> 0;
    out[i] = (x >>> 24) & 0xff;
  }
  return out;
}

const ALGOS = ['md5', 'sha1'];

test('空输入', () => {
  for (const a of ALGOS) {
    assert.equal(mine(a, [new Uint8Array(0)]), ref(a, new Uint8Array(0)), a);
  }
});

test('经典测试向量', () => {
  const abc = new TextEncoder().encode('abc');
  assert.equal(mine('md5', [abc]), '900150983cd24fb0d6963f7d28e17f72');
  assert.equal(mine('sha1', [abc]), 'a9993e364706816aba3e25717850c26c9cd0d89d');
});

test('分组边界附近的长度：63 / 64 / 65 / 119 / 120 / 121', () => {
  // 补位规则在 56 和 120 字节处换分支，这几个长度专挑那些拐点
  const lens = [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 121, 127, 128, 129];
  const bad = [];
  for (const a of ALGOS) {
    for (const n of lens) {
      const b = bytes(n, n + 7);
      const got = mine(a, [b]);
      const want = ref(a, b);
      if (got !== want) bad.push(`  · ${a} ${n} 字节：${got} ≠ ${want}`);
    }
  }
  assert.equal(bad.length, 0, `${bad.length} 处对不上：\n${bad.join('\n')}`);
});

test('同一份数据切成不同碎片喂进去，结果必须一致', () => {
  // 这是流式实现最容易错的地方：尾巴没接好，或者整块路径漏算
  const data = bytes(5000, 42);
  const splits = [
    [5000],
    [1, 4999],
    [63, 1, 4936],
    [64, 64, 4872],
    [1, 1, 1, 4997],
    [32, 32, 32, 4904],
    ...[[]].map(() => Array.from({ length: 100 }, () => 50)),   // 100 × 50
  ];

  const bad = [];
  for (const a of ALGOS) {
    const want = ref(a, data);
    for (const sizes of splits) {
      const chunks = [];
      let p = 0;
      for (const n of sizes) { chunks.push(data.subarray(p, p + n)); p += n; }
      if (p < data.length) chunks.push(data.subarray(p));
      const got = mine(a, chunks);
      if (got !== want) bad.push(`  · ${a} 切法 [${sizes.slice(0, 5).join(',')}…]：${got} ≠ ${want}`);
    }
  }
  assert.equal(bad.length, 0, `${bad.length} 处切法对不上：\n${bad.join('\n')}`);
});

test('大一点的输入（跨越多个分组，且长度不整除 64）', () => {
  const bad = [];
  for (const a of ALGOS) {
    for (const n of [1000, 1_000_000, 1_048_577]) {
      const b = bytes(n, n);
      const got = mine(a, [b]);
      const want = ref(a, b);
      if (got !== want) bad.push(`  · ${a} ${n} 字节对不上`);
    }
  }
  assert.equal(bad.length, 0, `${bad.length} 处对不上：\n${bad.join('\n')}`);
});

test('随机长度随机切法，跑一批', () => {
  const bad = [];
  for (let seed = 1; seed <= 60 && bad.length < 5; seed += 1) {
    const n = (seed * 977) % 3000;
    const data = bytes(n, seed);
    for (const a of ALGOS) {
      // 按种子决定的碎片大小切开
      const chunks = [];
      let p = 0;
      let x = seed;
      while (p < data.length) {
        x = (x * 1103515245 + 12345) >>> 0;
        const step = 1 + (x % 200);
        chunks.push(data.subarray(p, p + step));
        p += step;
      }
      if (chunks.length === 0) chunks.push(data);
      const got = mine(a, chunks);
      const want = ref(a, data);
      if (got !== want) bad.push(`  · seed=${seed} ${a} ${n} 字节：${got} ≠ ${want}`);
    }
  }
  assert.equal(bad.length, 0, `${bad.length} 处对不上：\n${bad.join('\n')}`);
});

test('输出格式：小写十六进制，长度固定', () => {
  const b = bytes(100, 3);
  assert.match(mine('md5', [b]), /^[0-9a-f]{32}$/);
  assert.match(mine('sha1', [b]), /^[0-9a-f]{40}$/);
  // 高位为 0 的字节不能被吃掉——这是 toString(16) 最常见的坑
  for (let seed = 1; seed <= 200; seed += 1) {
    assert.equal(mine('md5', [bytes(seed, seed)]).length, 32, `md5 seed=${seed} 长度不对`);
    assert.equal(mine('sha1', [bytes(seed, seed)]).length, 40, `sha1 seed=${seed} 长度不对`);
  }
});

test('接受 ArrayBuffer 和 Buffer，不只是 Uint8Array', () => {
  const b = bytes(200, 9);
  const want = ref('md5', b);
  assert.equal(new Md5().update(b).digest(), want, 'Uint8Array');
  assert.equal(new Md5().update(b.buffer.slice(b.byteOffset, b.byteOffset + b.length)).digest(), want, 'ArrayBuffer');
  assert.equal(new Md5().update(Buffer.from(b)).digest(), want, 'Buffer');
});

test('算法选择：与服务端一致，md5 优先、其次 sha1、都没有就没法校验', () => {
  assert.equal(pickAlgo({ md5: 'a', sha1: 'b' }), 'md5');
  assert.equal(pickAlgo({ sha1: 'b' }), 'sha1');
  assert.equal(pickAlgo({ md5: '', sha1: '' }), null);
  assert.equal(pickAlgo({}), null);
  assert.equal(pickAlgo(null), null);
  assert.equal(createDigest('sha256'), null, '不认识的算法要如实返回 null，不能假装能校验');
  assert.ok(new Sha1() instanceof Sha1);
});
