// LinkTalk — multi-device live translation relay server.
//
// Responsibilities:
//   1. Serve the static PWA (public/).
//   2. Run a WebSocket relay so devices in the same room see each other's
//      messages in real time.
//   3. Mint room invites (short code + shareable URL) and render join QR codes.
//   4. Proxy machine translation and Whisper transcription so the browser
//      avoids CORS and never holds API keys.
//   5. Operate: health/metrics endpoints, rate limits on the endpoints that
//      cost money, and a token-protected admin console (see BACKEND.md).
//
// The design keeps *translation on the receiver side*: the server relays the
// original text plus its source language, and every receiving device
// translates into its own primary / secondary languages. That is what lets
// each person read the room in whatever language(s) they chose.

import http from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import express from 'express';
import { WebSocketServer } from 'ws';
import QRCode from 'qrcode';
import { offlineTranslate } from './phrasebook.js';
import { metrics, snapshotMetrics, uptimeSec } from './metrics.js';
import { rateLimit, LIMITS } from './ratelimit.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

// Persistence: rooms + their message history are written to disk so a restart
// (or crash) doesn't drop an in-progress conversation. Disable with PERSIST=0.
const PERSIST = process.env.PERSIST !== '0';
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'rooms.json');
const ROOM_TTL_MS = Number(process.env.ROOM_TTL_MS || 24 * 60 * 60 * 1000); // prune empty rooms after 24h

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Pretty URL for the admin console (the page itself is a static shell; all of
// its data requires the admin token — see the Admin API section below).
app.get('/admin', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ---------------------------------------------------------------------------
// Rooms & participants. Members are live WebSocket connections (never
// persisted); each room's message history is snapshotted to disk so it
// survives a restart, and empty rooms are pruned after ROOM_TTL_MS.
// ---------------------------------------------------------------------------

/** @type {Map<string, {code: string, createdAt: number, lastActivity: number, members: Map<string, object>, history: object[]}>} */
const rooms = new Map();

const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I ambiguity
function makeRoomCode() {
  let code;
  do {
    code = Array.from({ length: 6 }, () =>
      ROOM_ALPHABET[Math.floor(Math.random() * ROOM_ALPHABET.length)]
    ).join('');
  } while (rooms.has(code));
  return code;
}

const HISTORY_LIMIT = 100; // recent messages kept per room for late joiners

function ensureRoom(code) {
  let room = rooms.get(code);
  if (!room) {
    const now = Date.now();
    room = { code, createdAt: now, lastActivity: now, members: new Map(), history: [] };
    rooms.set(code, room);
    metrics.rooms.created++;
  }
  return room;
}

function memberCount() {
  let n = 0;
  for (const r of rooms.values()) n += r.members.size;
  return n;
}

// ---------------------------------------------------------------------------
// Persistence — load on boot, debounced save on change, sync save on shutdown.
// ---------------------------------------------------------------------------

function snapshot() {
  return {
    rooms: [...rooms.values()].map((r) => ({
      code: r.code,
      createdAt: r.createdAt,
      lastActivity: r.lastActivity,
      history: r.history,
    })),
  };
}

function loadRooms() {
  if (!PERSIST) return;
  try {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    const now = Date.now();
    for (const r of data.rooms || []) {
      const last = r.lastActivity || r.createdAt || now;
      if (now - last > ROOM_TTL_MS) continue; // stale, skip
      rooms.set(r.code, {
        code: r.code,
        createdAt: r.createdAt || now,
        lastActivity: last,
        members: new Map(),
        history: Array.isArray(r.history) ? r.history : [],
      });
    }
    console.log(`Loaded ${rooms.size} room(s) from ${DATA_FILE}`);
  } catch {
    /* no snapshot yet — first run */
  }
}

let saveTimer = null;
function scheduleSave() {
  if (!PERSIST || saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
      const tmp = `${DATA_FILE}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(snapshot()));
      fs.renameSync(tmp, DATA_FILE); // atomic replace
    } catch (err) {
      console.error('room save failed:', String(err));
    }
  }, 1000);
}

function saveSync() {
  if (!PERSIST) return;
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(snapshot()));
  } catch (err) {
    console.error('room save failed:', String(err));
  }
}

// Periodically drop rooms that have been empty and idle past the TTL.
function sweepRooms() {
  const now = Date.now();
  let changed = false;
  for (const room of rooms.values()) {
    if (room.members.size === 0 && now - room.lastActivity > ROOM_TTL_MS) {
      rooms.delete(room.code);
      retirePinsFor(room.code);
      metrics.rooms.pruned++;
      changed = true;
    }
  }
  if (changed) scheduleSave();
}

// ---------------------------------------------------------------------------
// Face-to-face pairing PINs.
//
// A 6-character room code is fine on a QR or a link, but clumsy to read aloud
// across a table. So a room can also mint a short 4-digit PIN that maps to it.
//
// 4 digits is only 10,000 values, so the safety comes from scarcity and time,
// not from the code itself:
//   • PINs live for PIN_TTL_MS (5 min) and are swept.
//   • Only a handful are ever active at once, so guesses land in empty space.
//   • Lookups are rate limited per IP (see /api/pair below).
//   • A PIN is retired as soon as its room is closed.
// This is the same trade-off AirDrop-style numeric handshakes make: good for
// people standing next to each other, never a substitute for the room link.
// ---------------------------------------------------------------------------

const PIN_TTL_MS = Number(process.env.PIN_TTL_MS || 5 * 60 * 1000);
/** @type {Map<string, {room: string, expiresAt: number}>} */
const pins = new Map();

function sweepPins(now = Date.now()) {
  for (const [pin, rec] of pins) if (rec.expiresAt <= now) pins.delete(pin);
}

function pinForRoom(code) {
  const now = Date.now();
  sweepPins(now);

  // Reuse a live PIN so the host screen doesn't churn while people are typing.
  for (const [pin, rec] of pins) {
    if (rec.room === code) return { pin, expiresAt: rec.expiresAt };
  }

  // 10k space minus whatever is live; pick randomly among the free values.
  if (pins.size >= 9000) return null; // absurd in practice; fail loudly instead of looping
  let pin;
  do {
    pin = String(Math.floor(Math.random() * 10000)).padStart(4, '0');
  } while (pins.has(pin));

  const expiresAt = now + PIN_TTL_MS;
  pins.set(pin, { room: code, expiresAt });
  metrics.pins.minted++;
  return { pin, expiresAt };
}

function retirePinsFor(code) {
  for (const [pin, rec] of pins) if (rec.room === code) pins.delete(pin);
}

// Build the absolute base URL a phone should use to reach this server. We
// honour proxy headers so a tunnelled / LAN address survives.
function baseUrl(req) {
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http')
    .split(',')[0]
    .trim();
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

// ---------------------------------------------------------------------------
// REST endpoints
// ---------------------------------------------------------------------------

// Liveness/readiness probe. Reports 503 while shutting down so a load balancer
// can drain this instance before it disappears.
app.get('/api/health', (_req, res) => {
  const body = {
    status: shuttingDown ? 'shutting_down' : 'ok',
    uptimeSec: uptimeSec(),
    rooms: rooms.size,
    members: memberCount(),
    persist: PERSIST,
    translate: {
      provider: process.env.TRANSLATE_URL ? 'custom' : 'mymemory',
      offlineOnly: OFFLINE_ONLY,
    },
    whisper: {
      configured: WHISPER_MOCK || Boolean(process.env.WHISPER_API_KEY),
      mock: WHISPER_MOCK,
      model: WHISPER_MODEL,
    },
  };
  res.status(shuttingDown ? 503 : 200).json(body);
});

// Cumulative in-process counters (reset on restart).
app.get('/api/metrics', (_req, res) => {
  res.json(snapshotMetrics({ rooms_current: rooms.size, members_current: memberCount() }));
});

// Create a room and hand back its code + invite URL.
app.post('/api/rooms', rateLimit('rooms', LIMITS.rooms), (req, res) => {
  const code = makeRoomCode();
  ensureRoom(code);
  const url = `${baseUrl(req)}/room.html?room=${code}`;
  res.json({ code, url });
});

// Report whether a room exists (so join screens can fail fast).
app.get('/api/rooms/:code', (req, res) => {
  const code = String(req.params.code || '').toUpperCase();
  const room = rooms.get(code);
  if (!room) return res.status(404).json({ error: 'room_not_found' });
  res.json({ code, members: room.members.size });
});

// Mint (or re-use) a 4-digit face-to-face PIN for a room. Cross-platform join
// path: the other person types these 4 digits, no camera or NFC needed.
app.post('/api/rooms/:code/pin', rateLimit('rooms', LIMITS.rooms), (req, res) => {
  const code = String(req.params.code || '').toUpperCase();
  if (!rooms.has(code)) return res.status(404).json({ error: 'room_not_found' });
  const minted = pinForRoom(code);
  if (!minted) return res.status(503).json({ error: 'pin_space_exhausted' });
  res.json({
    pin: minted.pin,
    expiresAt: minted.expiresAt,
    ttlSec: Math.round((minted.expiresAt - Date.now()) / 1000),
  });
});

// Resolve a PIN to its room. Rate limited hard: this is the only guessable
// surface in the app, so a burst of wrong PINs should stop making progress.
app.get('/api/pair/:pin', rateLimit('pair', LIMITS.pair), (req, res) => {
  const pin = String(req.params.pin || '').trim();
  sweepPins();
  const rec = pins.get(pin);
  if (!rec || !rooms.has(rec.room)) {
    metrics.pins.missed++;
    return res.status(404).json({ error: 'pin_not_found' });
  }
  metrics.pins.resolved++;
  res.json({ room: rec.room, expiresAt: rec.expiresAt });
});

// Render an invite QR code as a PNG data URL for a given room.
app.get('/api/qr', async (req, res) => {
  const code = String(req.query.room || '').toUpperCase();
  if (!code) return res.status(400).json({ error: 'missing_room' });
  const url = `${baseUrl(req)}/room.html?room=${code}`;
  try {
    const dataUrl = await QRCode.toDataURL(url, {
      width: 320,
      margin: 1,
      color: { dark: '#0b1020', light: '#ffffff' },
    });
    res.json({ url, dataUrl });
  } catch (err) {
    res.status(500).json({ error: 'qr_failed', detail: String(err) });
  }
});

// ---------------------------------------------------------------------------
// Translation.
//
// Order of resolution for each request:
//   1. Same language or empty  -> return as-is.
//   2. In-memory cache.
//   3. Live provider (default: key-less MyMemory; override via env — see below).
//   4. Offline phrasebook fallback for common phrases.
//   5. Return the original text flagged untranslated, so the UI can say so.
//
// Configure a different provider with env vars:
//   TRANSLATE_URL   a URL template with {q} {from} {to} placeholders
//   TRANSLATE_PICK  dot-path into the JSON response holding the translated text
// e.g. a self-hosted LibreTranslate would use a small adapter; MyMemory is the
// zero-config default. Set TRANSLATE_OFFLINE=1 to skip the network entirely.
// ---------------------------------------------------------------------------

const translateCache = new Map(); // key: `${from}|${to}|${text}` -> translated
const OFFLINE_ONLY = process.env.TRANSLATE_OFFLINE === '1';

function pick(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}

async function callProvider(clean, from, to) {
  const tmpl =
    process.env.TRANSLATE_URL ||
    'https://api.mymemory.translated.net/get?q={q}&langpair={from}|{to}';
  const pickPath = process.env.TRANSLATE_PICK || 'responseData.translatedText';
  const endpoint = tmpl
    .replace('{q}', encodeURIComponent(clean))
    .replace('{from}', encodeURIComponent(from))
    .replace('{to}', encodeURIComponent(to));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const resp = await fetch(endpoint, { signal: controller.signal });
    const data = await resp.json();
    const out = pick(data, pickPath);
    return typeof out === 'string' && out.trim() ? out : null;
  } finally {
    clearTimeout(timer);
  }
}

async function translateText(text, from, to) {
  metrics.translate.requests++;
  const clean = (text || '').trim();
  if (!clean) return { text: '', translated: false };
  if (!from || !to || from === to) {
    metrics.translate.sameLanguage++;
    return { text: clean, translated: false };
  }

  const key = `${from}|${to}|${clean}`;
  if (translateCache.has(key)) {
    metrics.translate.cacheHits++;
    return { text: translateCache.get(key), translated: true, cached: true };
  }

  // 3. Live provider.
  if (!OFFLINE_ONLY) {
    try {
      const out = await callProvider(clean, from, to);
      if (out) {
        translateCache.set(key, out);
        metrics.translate.provider++;
        return { text: out, translated: true };
      }
    } catch {
      metrics.translate.failures++;
      // fall through to the offline phrasebook
    }
  }

  // 4. Offline phrasebook.
  const offline = offlineTranslate(clean, from, to);
  if (offline) {
    translateCache.set(key, offline);
    metrics.translate.offline++;
    return { text: offline, translated: true, source: 'offline' };
  }

  // 5. Give up — hand back the original, flagged.
  metrics.translate.untranslated++;
  return { text: clean, translated: false, error: 'unavailable' };
}

app.post('/api/translate', rateLimit('translate', LIMITS.translate), async (req, res) => {
  const { text, from, to } = req.body || {};
  const result = await translateText(text, from, to);
  res.json(result);
});

// ---------------------------------------------------------------------------
// Speech-to-text via Whisper.
//
// The browser records an audio clip and POSTs the raw bytes here; we forward it
// to a Whisper-compatible transcription endpoint. Configure with env vars:
//   WHISPER_URL     default https://api.openai.com/v1/audio/transcriptions
//   WHISPER_MODEL   default whisper-1
//   WHISPER_API_KEY bearer token for the endpoint (required for real use)
//   WHISPER_MOCK=1  return a canned transcript (for local testing without a key)
//
// This matches the OpenAI audio-transcription API shape, and works unchanged
// against a self-hosted whisper.cpp / faster-whisper server that mimics it.
// ---------------------------------------------------------------------------

const WHISPER_URL =
  process.env.WHISPER_URL || 'https://api.openai.com/v1/audio/transcriptions';
const WHISPER_MODEL = process.env.WHISPER_MODEL || 'whisper-1';
const WHISPER_MOCK = process.env.WHISPER_MOCK === '1';

const MIME_EXT = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'mp4',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
};

app.get('/api/transcribe/status', (_req, res) => {
  res.json({
    mock: WHISPER_MOCK,
    configured: WHISPER_MOCK || Boolean(process.env.WHISPER_API_KEY),
    model: WHISPER_MODEL,
  });
});

app.post(
  '/api/transcribe',
  rateLimit('transcribe', LIMITS.transcribe),
  express.raw({ type: () => true, limit: '25mb' }),
  async (req, res) => {
    const lang = String(req.query.lang || '').slice(0, 8) || undefined;
    const audio = req.body;
    if (!audio || !audio.length) {
      return res.status(400).json({ error: 'no_audio' });
    }
    metrics.transcribe.requests++;
    metrics.transcribe.bytes += audio.length;

    // Mock mode: skip the network, echo a deterministic phrase so the whole
    // record → transcribe → translate → relay pipeline is testable offline.
    if (WHISPER_MOCK) {
      metrics.transcribe.mock++;
      return res.json({ text: process.env.WHISPER_MOCK_TEXT || 'hello', mock: true });
    }
    if (!process.env.WHISPER_API_KEY) {
      metrics.transcribe.failures++;
      return res.status(503).json({ error: 'not_configured' });
    }

    try {
      const ctype = (req.headers['content-type'] || 'audio/webm').split(';')[0].trim();
      const ext = MIME_EXT[ctype] || 'webm';
      const form = new FormData();
      form.append('file', new Blob([audio], { type: ctype }), `speech.${ext}`);
      form.append('model', WHISPER_MODEL);
      if (lang) form.append('language', lang);
      form.append('response_format', 'json');

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30000);
      const resp = await fetch(WHISPER_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.WHISPER_API_KEY}` },
        body: form,
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!resp.ok) {
        const detail = await resp.text();
        metrics.transcribe.failures++;
        return res.status(502).json({ error: 'whisper_failed', status: resp.status, detail });
      }
      const data = await resp.json();
      metrics.transcribe.ok++;
      res.json({ text: (data.text || '').trim() });
    } catch (err) {
      metrics.transcribe.failures++;
      res.status(500).json({ error: 'transcribe_error', detail: String(err) });
    }
  }
);

// ---------------------------------------------------------------------------
// Admin API (see BACKEND.md).
//
// Security posture: the console is *disabled* unless ADMIN_TOKEN is set — an
// unconfigured deployment must never expose room contents. The token is checked
// on every request; serve behind HTTPS so it isn't sent in the clear.
// ---------------------------------------------------------------------------

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) {
    return res.status(503).json({ error: 'admin_disabled', hint: 'set ADMIN_TOKEN to enable' });
  }
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (token !== ADMIN_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

function roomSummary(room) {
  return {
    code: room.code,
    members: room.members.size,
    messages: room.history.length,
    createdAt: room.createdAt,
    lastActivity: room.lastActivity,
    languages: [...new Set([...room.members.values()].map((m) => m.speakLang))],
  };
}

app.get('/api/admin/overview', requireAdmin, (_req, res) => {
  res.json({
    metrics: snapshotMetrics(),
    rooms: { current: rooms.size, members: memberCount() },
    config: {
      persist: PERSIST,
      roomTtlMs: ROOM_TTL_MS,
      historyLimit: HISTORY_LIMIT,
      limits: LIMITS,
      whisperConfigured: WHISPER_MOCK || Boolean(process.env.WHISPER_API_KEY),
    },
  });
});

app.get('/api/admin/rooms', requireAdmin, (_req, res) => {
  const list = [...rooms.values()]
    .map(roomSummary)
    .sort((a, b) => b.lastActivity - a.lastActivity);
  res.json({ rooms: list });
});

app.get('/api/admin/rooms/:code', requireAdmin, (req, res) => {
  const room = rooms.get(String(req.params.code || '').toUpperCase());
  if (!room) return res.status(404).json({ error: 'room_not_found' });
  res.json({
    ...roomSummary(room),
    people: [...room.members.values()].map((m) => ({
      id: m.id,
      name: m.name,
      speakLang: m.speakLang,
      isHost: m.isHost,
    })),
    recent: room.history.slice(-30),
  });
});

// Close a room: tell everyone why, disconnect them, and drop the history.
app.delete('/api/admin/rooms/:code', requireAdmin, (req, res) => {
  const code = String(req.params.code || '').toUpperCase();
  const room = rooms.get(code);
  if (!room) return res.status(404).json({ error: 'room_not_found' });

  const members = room.members.size;
  broadcast(room, { type: 'closed', reason: 'closed_by_admin' });
  for (const m of room.members.values()) {
    try { m.socket.close(); } catch { /* already gone */ }
  }
  rooms.delete(code);
  retirePinsFor(code);
  metrics.rooms.closedByAdmin++;
  scheduleSave();
  res.json({ closed: code, disconnected: members });
});

// ---------------------------------------------------------------------------
// WebSocket relay
// ---------------------------------------------------------------------------

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function roster(room) {
  return [...room.members.values()].map((m) => ({
    id: m.id,
    name: m.name,
    speakLang: m.speakLang,
    isHost: m.isHost,
  }));
}

function broadcast(room, payload, exceptId = null) {
  const raw = JSON.stringify(payload);
  for (const m of room.members.values()) {
    if (m.id === exceptId) continue;
    if (m.socket.readyState === m.socket.OPEN) m.socket.send(raw);
  }
}

let idSeq = 1;

wss.on('connection', (socket) => {
  let member = null;
  let room = null;
  metrics.ws.opened++;
  socket.on('close', () => metrics.ws.closed++);

  socket.on('message', (buf) => {
    let msg;
    try {
      msg = JSON.parse(buf.toString());
    } catch {
      return;
    }

    if (msg.type === 'join') {
      const code = String(msg.room || '').toUpperCase();
      room = ensureRoom(code);
      room.lastActivity = Date.now();
      const isHost = room.members.size === 0 || Boolean(msg.host);
      member = {
        id: `u${idSeq++}`,
        name: (msg.name || 'Guest').slice(0, 40),
        speakLang: msg.speakLang || 'en',
        isHost,
        socket,
      };
      room.members.set(member.id, member);
      metrics.ws.joins++;

      socket.send(
        JSON.stringify({ type: 'welcome', you: member.id, isHost, room: code })
      );
      // Catch the newcomer up on what's already been said.
      if (room.history.length) {
        socket.send(JSON.stringify({ type: 'history', messages: room.history }));
      }
      broadcast(room, { type: 'roster', members: roster(room) });
      broadcast(
        room,
        {
          type: 'system',
          text: `${member.name} joined`,
          ts: Date.now(),
        },
        member.id
      );
      return;
    }

    if (!member || !room) return;

    if (msg.type === 'message') {
      const text = String(msg.text || '').slice(0, 2000);
      if (!text.trim()) return;
      const payload = {
        type: 'message',
        id: `m${idSeq++}`,
        from: member.id,
        fromName: member.name,
        text,
        srcLang: msg.srcLang || member.speakLang,
        ts: Date.now(),
      };
      // Keep a bounded history so anyone who joins or reloads later can catch up.
      room.history.push(payload);
      if (room.history.length > HISTORY_LIMIT) room.history.shift();
      room.lastActivity = payload.ts;
      metrics.messages.relayed++;
      metrics.messages.chars += text.length;
      scheduleSave();
      // Exclude the sender: their own client renders an instant local echo, so
      // relaying it back would show the message twice.
      broadcast(room, payload, member.id);
      return;
    }

    if (msg.type === 'partial') {
      // Live "still speaking…" preview, relayed but not stored.
      broadcast(
        room,
        {
          type: 'partial',
          from: member.id,
          fromName: member.name,
          text: String(msg.text || '').slice(0, 2000),
          srcLang: msg.srcLang || member.speakLang,
        },
        member.id
      );
      return;
    }

    if (msg.type === 'typing') {
      // Ephemeral "is typing…" ping (no text), relayed to everyone else.
      broadcast(
        room,
        { type: 'typing', from: member.id, fromName: member.name },
        member.id
      );
      return;
    }

    if (msg.type === 'setLang') {
      member.speakLang = msg.speakLang || member.speakLang;
      broadcast(room, { type: 'roster', members: roster(room) });
      return;
    }
  });

  socket.on('close', () => {
    if (member && room) {
      room.members.delete(member.id);
      room.lastActivity = Date.now();
      if (room.members.size > 0) {
        broadcast(room, { type: 'roster', members: roster(room) });
        broadcast(room, {
          type: 'system',
          text: `${member.name} left`,
          ts: Date.now(),
        });
      }
      // An empty room is kept (with its history) until the TTL sweep prunes it,
      // so a brief disconnect or a server restart doesn't lose the conversation.
    }
  });
});

// Boot: restore persisted rooms, then start pruning + serving.
loadRooms();
const sweepTimer = setInterval(sweepRooms, 30 * 60 * 1000);
sweepTimer.unref?.();

// Flush to disk on graceful shutdown.
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  saveSync();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

server.listen(PORT, () => {
  console.log(`LinkTalk running on http://localhost:${PORT}`);
});
