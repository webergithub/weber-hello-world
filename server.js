// LinkTalk — multi-device live translation relay server.
//
// Responsibilities:
//   1. Serve the static PWA (public/).
//   2. Run a WebSocket relay so devices in the same room see each other's
//      messages in real time.
//   3. Mint room invites (short code + shareable URL) and render join QR codes.
//   4. Proxy machine translation so the browser avoids CORS and API keys.
//
// The design keeps *translation on the receiver side*: the server relays the
// original text plus its source language, and every receiving device
// translates into its own primary / secondary languages. That is what lets
// each person read the room in whatever language(s) they chose.

import http from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import express from 'express';
import { WebSocketServer } from 'ws';
import QRCode from 'qrcode';
import { offlineTranslate } from './phrasebook.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Rooms & participants (in-memory; a room evaporates when its last device
// leaves). Good enough for a live session — no database required.
// ---------------------------------------------------------------------------

/** @type {Map<string, {code: string, createdAt: number, members: Map<string, object>}>} */
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

function ensureRoom(code) {
  let room = rooms.get(code);
  if (!room) {
    room = { code, createdAt: Date.now(), members: new Map() };
    rooms.set(code, room);
  }
  return room;
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

// Create a room and hand back its code + invite URL.
app.post('/api/rooms', (req, res) => {
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
  const clean = (text || '').trim();
  if (!clean) return { text: '', translated: false };
  if (!from || !to || from === to) return { text: clean, translated: false };

  const key = `${from}|${to}|${clean}`;
  if (translateCache.has(key)) {
    return { text: translateCache.get(key), translated: true, cached: true };
  }

  // 3. Live provider.
  if (!OFFLINE_ONLY) {
    try {
      const out = await callProvider(clean, from, to);
      if (out) {
        translateCache.set(key, out);
        return { text: out, translated: true };
      }
    } catch {
      // fall through to the offline phrasebook
    }
  }

  // 4. Offline phrasebook.
  const offline = offlineTranslate(clean, from, to);
  if (offline) {
    translateCache.set(key, offline);
    return { text: offline, translated: true, source: 'offline' };
  }

  // 5. Give up — hand back the original, flagged.
  return { text: clean, translated: false, error: 'unavailable' };
}

app.post('/api/translate', async (req, res) => {
  const { text, from, to } = req.body || {};
  const result = await translateText(text, from, to);
  res.json(result);
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
      const isHost = room.members.size === 0 || Boolean(msg.host);
      member = {
        id: `u${idSeq++}`,
        name: (msg.name || 'Guest').slice(0, 40),
        speakLang: msg.speakLang || 'en',
        isHost,
        socket,
      };
      room.members.set(member.id, member);

      socket.send(
        JSON.stringify({ type: 'welcome', you: member.id, isHost, room: code })
      );
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
      // Exclude the sender: their own client renders an instant local echo, so
      // relaying it back would show the message twice.
      broadcast(
        room,
        {
          type: 'message',
          id: `m${idSeq++}`,
          from: member.id,
          fromName: member.name,
          text,
          srcLang: msg.srcLang || member.speakLang,
          ts: Date.now(),
        },
        member.id
      );
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

    if (msg.type === 'setLang') {
      member.speakLang = msg.speakLang || member.speakLang;
      broadcast(room, { type: 'roster', members: roster(room) });
      return;
    }
  });

  socket.on('close', () => {
    if (member && room) {
      room.members.delete(member.id);
      if (room.members.size === 0) {
        rooms.delete(room.code);
      } else {
        broadcast(room, { type: 'roster', members: roster(room) });
        broadcast(room, {
          type: 'system',
          text: `${member.name} left`,
          ts: Date.now(),
        });
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`LinkTalk running on http://localhost:${PORT}`);
});
