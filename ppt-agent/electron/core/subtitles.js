'use strict';
// 字幕解析：SRT / WebVTT / TTML，以及 MP4 内封文本轨（tx3g / wvtt）。只读取字幕，不解码视频。

function toSec(t) {
  const m = String(t).trim().replace(',', '.').match(/(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)/);
  if (!m) return 0;
  return (Number(m[1] || 0) * 3600) + Number(m[2]) * 60 + Number(m[3]);
}

function fmt(sec) {
  sec = Math.max(0, sec || 0);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
  const p = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
}

function parseTimedText(text) {
  const cues = [];
  const blocks = String(text).replace(/\r/g, '').split(/\n\s*\n/);
  for (const b of blocks) {
    const lines = b.split('\n').filter((l) => l.trim() !== '');
    const i = lines.findIndex((l) => l.includes('-->'));
    if (i < 0) continue;
    const [a, z] = lines[i].split('-->');
    const body = lines.slice(i + 1).join(' ').replace(/<[^>]+>/g, '').trim();
    if (body) cues.push({ start: toSec(a), end: toSec(z.trim().split(/\s+/)[0]), text: body });
  }
  return cues;
}

function parseTtml(text) {
  const cues = [];
  const re = /<p\b([^>]*)>([\s\S]*?)<\/p>/g;
  let m;
  while ((m = re.exec(text))) {
    const begin = (m[1].match(/begin="([^"]+)"/) || [])[1];
    const end = (m[1].match(/end="([^"]+)"/) || [])[1];
    const body = m[2].replace(/<br\s*\/?>/g, ' ').replace(/<[^>]+>/g, '').trim();
    if (body) cues.push({ start: toSec(begin || '0:0:0'), end: toSec(end || '0:0:0'), text: body });
  }
  return cues;
}

function parseSubtitleText(text, ext = '') {
  ext = ext.toLowerCase();
  if (ext.endsWith('ttml') || ext.endsWith('dfxp') || /^\s*<\?xml|<tt\b/.test(text)) return parseTtml(text);
  return parseTimedText(text);
}

function cuesToText(cues) {
  return cues.map((c) => `[${fmt(c.start)}] ${c.text}`).join('\n');
}

// ---------------- MP4 ----------------
const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf', 'udta']);

async function readBoxHeader(reader, pos) {
  const h = await reader.read(pos, 16);
  if (h.length < 8) return null;
  let size = h.readUInt32BE(0);
  const type = h.toString('latin1', 4, 8);
  let header = 8;
  if (size === 1) { size = Number(h.readBigUInt64BE(8)); header = 16; } else if (size === 0) size = reader.size - pos;
  return { size, type, header };
}

function parseBoxes(buf, start, end, out) {
  let pos = start;
  while (pos + 8 <= end) {
    let size = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    let header = 8;
    if (size === 1) { size = Number(buf.readBigUInt64BE(pos + 8)); header = 16; } else if (size === 0) size = end - pos;
    if (size < header || pos + size > end) break;
    const box = { type, start: pos + header, end: pos + size, children: [] };
    if (CONTAINERS.has(type)) parseBoxes(buf, box.start, box.end, box.children);
    out.push(box);
    pos += size;
  }
  return out;
}

const first = (boxes, type) => boxes.find((b) => b.type === type);

function parseTrack(buf, trak) {
  const mdia = first(trak.children, 'mdia');
  if (!mdia) return null;
  const hdlr = first(mdia.children, 'hdlr');
  const mdhd = first(mdia.children, 'mdhd');
  const minf = first(mdia.children, 'minf');
  const stbl = minf && first(minf.children, 'stbl');
  if (!hdlr || !mdhd || !stbl) return null;
  const handler = buf.toString('latin1', hdlr.start + 8, hdlr.start + 12);
  const v = buf[mdhd.start];
  const timescale = v === 1 ? buf.readUInt32BE(mdhd.start + 20) : buf.readUInt32BE(mdhd.start + 12);
  const lang = v === 1 ? buf.readUInt16BE(mdhd.start + 32) : buf.readUInt16BE(mdhd.start + 20);
  const language = String.fromCharCode(((lang >> 10) & 31) + 0x60, ((lang >> 5) & 31) + 0x60, (lang & 31) + 0x60);
  const stsd = first(stbl.children, 'stsd');
  const format = stsd ? buf.toString('latin1', stsd.start + 12, stsd.start + 16) : '';
  return { handler, timescale, language, format, stbl };
}

function sampleTable(buf, stbl) {
  const get = (t) => first(stbl.children, t);
  const stts = get('stts'), stsz = get('stsz'), stsc = get('stsc');
  const stco = get('stco') || get('co64');
  if (!stts || !stsz || !stsc || !stco) return [];
  const sizes = [];
  const fixed = buf.readUInt32BE(stsz.start + 4), count = buf.readUInt32BE(stsz.start + 8);
  for (let i = 0; i < count; i++) sizes.push(fixed || buf.readUInt32BE(stsz.start + 12 + i * 4));
  const durations = [];
  const n = buf.readUInt32BE(stts.start + 4);
  for (let i = 0; i < n; i++) {
    const c = buf.readUInt32BE(stts.start + 8 + i * 8), d = buf.readUInt32BE(stts.start + 12 + i * 8);
    for (let k = 0; k < c && durations.length < count; k++) durations.push(d);
  }
  const chunkOffsets = [];
  const cn = buf.readUInt32BE(stco.start + 4);
  for (let i = 0; i < cn; i++) {
    chunkOffsets.push(stco.type === 'co64' ? Number(buf.readBigUInt64BE(stco.start + 8 + i * 8)) : buf.readUInt32BE(stco.start + 8 + i * 4));
  }
  const scEntries = [];
  const sn = buf.readUInt32BE(stsc.start + 4);
  for (let i = 0; i < sn; i++) scEntries.push([buf.readUInt32BE(stsc.start + 8 + i * 12), buf.readUInt32BE(stsc.start + 12 + i * 12)]);
  const samples = [];
  let si = 0, t = 0;
  for (let c = 0; c < chunkOffsets.length && si < count; c++) {
    let per = 1;
    for (const [fc, spc] of scEntries) if (c + 1 >= fc) per = spc;
    let off = chunkOffsets[c];
    for (let k = 0; k < per && si < count; k++, si++) {
      samples.push({ offset: off, size: sizes[si], time: t, duration: durations[si] || 0 });
      off += sizes[si];
      t += durations[si] || 0;
    }
  }
  return samples;
}

function decodeTextSample(b, format) {
  if (format === 'wvtt') {
    const boxes = parseBoxes(b, 0, b.length, []);
    const texts = [];
    for (const bx of boxes) {
      if (bx.type === 'vttc') {
        for (const c of parseBoxes(b, bx.start, bx.end, [])) if (c.type === 'payl') texts.push(b.toString('utf8', c.start, c.end));
      }
    }
    return texts.join(' ').trim();
  }
  if (b.length < 2) return '';
  const len = b.readUInt16BE(0);
  const raw = b.subarray(2, 2 + len);
  if (raw[0] === 0xfe && raw[1] === 0xff) return Buffer.from(raw.subarray(2)).swap16().toString('utf16le').trim();
  if (format === 'stpp') return raw.toString('utf8').replace(/<[^>]+>/g, ' ').trim();
  return raw.toString('utf8').trim();
}

/** 读取 mp4/mov/m4v 元数据与内封字幕。reader: {size, read(start,len)} */
async function probeMp4(reader) {
  const info = { duration: 0, tracks: [], subtitles: [] };
  let pos = 0, moov = null;
  for (let guard = 0; pos < reader.size && guard < 10000; guard++) {
    const h = await readBoxHeader(reader, pos);
    if (!h || h.size < 8) break;
    if (h.type === 'moov') { moov = { pos, ...h }; break; }
    pos += h.size;
  }
  if (!moov || moov.size > 64 * 1024 * 1024) return info;
  const buf = await reader.read(moov.pos, moov.size);
  const root = parseBoxes(buf, moov.header, buf.length, []);
  const mvhd = first(root, 'mvhd');
  if (mvhd) {
    const v = buf[mvhd.start];
    const ts = v === 1 ? buf.readUInt32BE(mvhd.start + 20) : buf.readUInt32BE(mvhd.start + 12);
    const du = v === 1 ? Number(buf.readBigUInt64BE(mvhd.start + 24)) : buf.readUInt32BE(mvhd.start + 16);
    info.duration = ts ? du / ts : 0;
  }
  for (const trak of root.filter((b) => b.type === 'trak')) {
    const tr = parseTrack(buf, trak);
    if (!tr) continue;
    info.tracks.push({ handler: tr.handler, format: tr.format, language: tr.language });
    if (!['sbtl', 'text', 'subt'].includes(tr.handler) && !['tx3g', 'wvtt', 'stpp', 'text'].includes(tr.format)) continue;
    const cues = [];
    for (const s of sampleTable(buf, tr.stbl).slice(0, 5000)) {
      if (!s.size || s.size > 64 * 1024) continue;
      const text = decodeTextSample(await reader.read(s.offset, s.size), tr.format);
      if (text) cues.push({ start: s.time / tr.timescale, end: (s.time + s.duration) / tr.timescale, text });
    }
    if (cues.length) info.subtitles.push({ source: `内封字幕轨(${tr.format}/${tr.language})`, cues });
  }
  return info;
}

function fileReader(file) {
  const fs = require('fs');
  const fd = fs.openSync(file, 'r');
  const size = fs.fstatSync(fd).size;
  return {
    size,
    read: async (start, len) => {
      const b = Buffer.alloc(Math.max(0, Math.min(len, size - start)));
      fs.readSync(fd, b, 0, b.length, start);
      return b;
    },
    close: () => fs.closeSync(fd),
  };
}

module.exports = { parseSubtitleText, cuesToText, probeMp4, fileReader, fmt };
