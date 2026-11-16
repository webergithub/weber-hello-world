/* IP → 国家。读取 MaxMind 格式（.mmdb）的国家库，例如 DB-IP Lite 或 GeoLite2 Country。
   country(ip) 返回两位国家代码；家用内网地址返回 'LAN'；查不到或没有加载库返回 'ZZ'。 */
'use strict';
const fs = require('fs'), net = require('net');
let db = null;

function decode(buf, base, off) {
  let ctrl = buf[off++], type = ctrl >> 5, size = ctrl & 0x1f;
  if (type === 1) {                                  /* pointer into the data section */
    const ps = (ctrl >> 3) & 3, v = ctrl & 7; let p;
    if (ps === 0) { p = (v << 8) | buf[off]; off += 1; }
    else if (ps === 1) { p = ((v << 16) | buf.readUInt16BE(off)) + 2048; off += 2; }
    else if (ps === 2) { p = ((v << 24) | buf.readUIntBE(off, 3)) + 526336; off += 3; }
    else { p = buf.readUInt32BE(off); off += 4; }
    return { v: decode(buf, base, base + p).v, off };
  }
  if (type === 0) type = 7 + buf[off++];
  if (size === 29) size = 29 + buf[off++];
  else if (size === 30) { size = 285 + buf.readUInt16BE(off); off += 2; }
  else if (size === 31) { size = 65821 + buf.readUIntBE(off, 3); off += 3; }
  if (type === 7) { const m = {}; for (let i = 0; i < size; i++) { const k = decode(buf, base, off); const x = decode(buf, base, k.off); m[k.v] = x.v; off = x.off; } return { v: m, off }; }
  if (type === 11) { const a = []; for (let i = 0; i < size; i++) { const x = decode(buf, base, off); a.push(x.v); off = x.off; } return { v: a, off }; }
  if (type === 14) return { v: !!size, off };
  let v;
  if (type === 2) v = buf.toString('utf8', off, off + size);
  else if (type === 5 || type === 6 || type === 9 || type === 10) { v = 0; for (let i = 0; i < size; i++) v = v * 256 + buf[off + i]; }
  else if (type === 8) v = size ? buf.readIntBE(off, size) : 0;
  else if (type === 3) v = buf.readDoubleBE(off);
  else if (type === 15) v = buf.readFloatBE(off);
  else v = buf.slice(off, off + size);
  return { v, off: off + size };
}

exports.load = function (file) {
  db = null;
  if (!file) return false;
  try {
    const buf = fs.readFileSync(file), at = buf.lastIndexOf(Buffer.from('\xab\xcd\xefMaxMind.com', 'latin1'));
    if (at < 0) throw new Error('not an mmdb file');
    const meta = decode(buf, at + 14, at + 14).v, tree = meta.node_count * meta.record_size / 4;
    db = { buf, nodes: meta.node_count, rs: meta.record_size, v6: meta.ip_version === 6, data: tree + 16, type: meta.database_type };
    if (![24, 28, 32].includes(db.rs)) throw new Error('unsupported record size');
    return true;
  } catch (e) { console.error('[tenup] could not load the IP country file: ' + e.message); db = null; return false; }
};
exports.ready = () => !!db;

function record(node, right) {
  const b = db.buf, o = node * db.rs / 4;
  if (db.rs === 24) return b.readUIntBE(o + (right ? 3 : 0), 3);
  if (db.rs === 32) return b.readUInt32BE(o + (right ? 4 : 0));
  return right ? ((b[o + 3] & 0x0f) << 24 | b.readUIntBE(o + 4, 3)) >>> 0 : ((b[o + 3] & 0xf0) << 20 | b.readUIntBE(o, 3)) >>> 0;
}
function bytesOf(ip) {
  if (net.isIPv4(ip)) return ip.split('.').map(Number);
  if (!net.isIPv6(ip)) return null;
  let [head, tail] = ip.split('::'), h = head ? head.split(':') : [], t = tail != null && tail !== '' ? tail.split(':') : [];
  const last = (t.length ? t : h)[(t.length ? t : h).length - 1];
  if (last && last.includes('.')) { const q = last.split('.').map(Number); (t.length ? t : h).splice(-1, 1, ((q[0] << 8) | q[1]).toString(16), ((q[2] << 8) | q[3]).toString(16)); }
  const mid = tail != null ? new Array(8 - h.length - t.length).fill('0') : [], out = [];
  h.concat(mid, t).forEach(x => { const n = parseInt(x || '0', 16); out.push(n >> 8, n & 255); });
  return out.length === 16 ? out : null;
}
const PRIVATE = /^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|::1$|f[cd][0-9a-f]{2}:|fe80:)/i;

exports.country = function (ip) {
  ip = String(ip || '').replace(/^::ffff:/i, '');
  if (!ip || PRIVATE.test(ip)) return 'LAN';
  if (!db) return 'ZZ';
  let bytes = bytesOf(ip);
  if (!bytes) return 'ZZ';
  let node = 0;
  if (bytes.length === 4 && db.v6) for (let i = 0; i < 96 && node < db.nodes; i++) node = record(node, 0);
  if (bytes.length === 16 && !db.v6) return 'ZZ';
  for (let i = 0; i < bytes.length * 8 && node < db.nodes; i++) node = record(node, (bytes[i >> 3] >> (7 - (i & 7))) & 1);
  if (node <= db.nodes) return 'ZZ';
  try {
    const r = decode(db.buf, db.data, db.data + node - db.nodes - 16).v;
    const c = (r.country && r.country.iso_code) || r.country_code || (r.registered_country && r.registered_country.iso_code);
    return typeof c === 'string' && c.length === 2 ? c.toUpperCase() : 'ZZ';
  } catch (e) { return 'ZZ'; }
};
