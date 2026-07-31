// LinkTalk room client.
//
// Flow:
//   1. Connect to the relay over WebSocket and `join` the room from the URL.
//   2. Whatever I type or speak is sent as a `message` tagged with my speak
//      language.
//   3. Every incoming message is translated *on my device* into my primary and
//      (optional) secondary read languages, then rendered — original text kept
//      available underneath.
//
// Translation goes through the server's /api/translate proxy (key-less, cached).
// Speech-to-text records audio (MediaRecorder) and posts it to the server's
// /api/transcribe endpoint, which runs it through Whisper.

import { langName, speechLocale, fillLangSelect } from '/js/langs.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const ROOM = (params.get('room') || '').toUpperCase();
const IS_HOST = params.get('host') === '1';

if (!ROOM) location.href = '/';

const toast = (m) => {
  const t = $('toast');
  t.textContent = m;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2200);
};

// ---- Profile / preferences ------------------------------------------------
const profile = JSON.parse(localStorage.getItem('linktalk.profile') || '{}');
const prefs = JSON.parse(localStorage.getItem('linktalk.prefs') || '{}');

const state = {
  me: null,
  name: profile.name || (IS_HOST ? 'Host' : 'Guest'),
  speakLang: profile.speakLang || 'en',
  recvPrimary: prefs.recvPrimary || profile.speakLang || 'en',
  recvSecondary: prefs.recvSecondary || '',
  speakAloud: Boolean(prefs.speakAloud),
  members: [],
};

function savePrefs() {
  localStorage.setItem(
    'linktalk.prefs',
    JSON.stringify({
      recvPrimary: state.recvPrimary,
      recvSecondary: state.recvSecondary,
      speakAloud: state.speakAloud,
    })
  );
  localStorage.setItem(
    'linktalk.profile',
    JSON.stringify({ ...profile, name: state.name, speakLang: state.speakLang })
  );
}

// ---- Language selectors ---------------------------------------------------
fillLangSelect($('speak-lang'), { selected: state.speakLang });
fillLangSelect($('quick-speak'), { selected: state.speakLang });
fillLangSelect($('recv-primary'), { selected: state.recvPrimary });
fillLangSelect($('recv-secondary'), { includeNone: true, selected: state.recvSecondary });
$('speak-aloud').checked = state.speakAloud;

// The speak language is settable from two places — the Settings sheet and the
// quick-switch under the composer — so route both through one function that
// keeps them mirrored and tells the room.
function setSpeakLang(code) {
  state.speakLang = code;
  $('speak-lang').value = code;
  $('quick-speak').value = code;
  savePrefs();
  send({ type: 'setLang', speakLang: code });
}

$('speak-lang').addEventListener('change', (e) => setSpeakLang(e.target.value));
$('quick-speak').addEventListener('change', (e) => setSpeakLang(e.target.value));
$('recv-primary').addEventListener('change', (e) => {
  state.recvPrimary = e.target.value;
  savePrefs();
});
$('recv-secondary').addEventListener('change', (e) => {
  state.recvSecondary = e.target.value;
  savePrefs();
});
$('speak-aloud').addEventListener('change', (e) => {
  state.speakAloud = e.target.checked;
  savePrefs();
});

// ---- My menu + sheets -----------------------------------------------------
const menuBtn = $('menu-btn');
const menuDrop = $('menu-drop');

function toggleMenu(open) {
  const show = open ?? menuDrop.classList.contains('hidden');
  menuDrop.classList.toggle('hidden', !show);
  menuBtn.setAttribute('aria-expanded', String(show));
}
menuBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(); });
document.addEventListener('click', () => toggleMenu(false));

function openSheet(id) { $(id).classList.remove('hidden'); toggleMenu(false); }
function closeSheet(id) { $(id).classList.add('hidden'); }

// Close buttons and backdrop taps.
document.querySelectorAll('[data-close]').forEach((b) =>
  b.addEventListener('click', () => closeSheet(b.dataset.close)));
document.querySelectorAll('.sheet-backdrop').forEach((bd) =>
  bd.addEventListener('click', (e) => { if (e.target === bd) closeSheet(bd.id); }));

$('menu-settings').addEventListener('click', () => openSheet('settings-sheet'));
$('menu-invite').addEventListener('click', () => openSheet('invite-sheet'));
$('menu-leave').addEventListener('click', () => {
  if (ws) ws.close();
  location.href = '/';
});

// ---- Invite sheet ---------------------------------------------------------
$('room-code').textContent = ROOM;
const inviteUrl = `${location.origin}/room.html?room=${ROOM}`;
$('invite-url').value = inviteUrl;

// The host lands on an empty room, so surface the invite immediately.
if (IS_HOST) openSheet('invite-sheet');

fetch(`/api/qr?room=${ROOM}`)
  .then((r) => r.json())
  .then((d) => { if (d.dataUrl) $('qr-img').src = d.dataUrl; })
  .catch(() => {});

$('copy-btn').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(inviteUrl);
    toast('Invite link copied');
  } catch {
    $('invite-url').select();
    toast('Copy with ⌘/Ctrl-C');
  }
});

// Web Share API — on iOS this surfaces AirDrop, on Android Nearby Share.
if (navigator.share) {
  $('share-btn').addEventListener('click', async () => {
    try {
      await navigator.share({
        title: 'Join my LinkTalk room',
        text: `Join my live-translation room (${ROOM}):`,
        url: inviteUrl,
      });
    } catch { /* user dismissed */ }
  });
} else {
  $('share-btn').disabled = true;
  $('share-note').textContent =
    'Native share (AirDrop / Nearby Share) is available when opened from a phone browser.';
}

// Web NFC — Android Chrome can write the invite to a tag for tap-to-join.
if ('NDEFReader' in window) {
  $('nfc-btn').addEventListener('click', async () => {
    try {
      const ndef = new window.NDEFReader();
      await ndef.write({ records: [{ recordType: 'url', data: inviteUrl }] });
      toast('Hold a phone to the NFC tag to join');
    } catch (err) {
      toast('NFC write failed or was cancelled');
    }
  });
} else {
  $('nfc-btn').disabled = true;
}

// ---- WebSocket ------------------------------------------------------------
let ws;
let reconnectTimer = null;
let everConnected = false;
let roomClosed = false; // set when an admin closes the room — stop reconnecting

function setConnected(up) {
  // Only nag about the connection once we've actually been online — a first
  // connection in progress shouldn't flash "Reconnecting…".
  $('conn-banner').classList.toggle('hidden', up || !everConnected);
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const sock = new WebSocket(`${proto}://${location.host}/ws`);
  ws = sock;

  // Only the current socket drives UI/reconnect — a superseded one (e.g. a
  // failed offline retry closing late) must not flap the banner back on.
  const current = () => sock === ws;

  sock.addEventListener('open', () => {
    if (!current()) return;
    everConnected = true;
    setConnected(true);
    send({
      type: 'join',
      room: ROOM,
      name: state.name,
      speakLang: state.speakLang,
      host: IS_HOST,
    });
  });

  sock.addEventListener('message', (ev) => {
    if (!current()) return;
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handle(msg);
  });

  sock.addEventListener('close', () => {
    if (!current()) return;
    setConnected(false);
    scheduleReconnect();
  });
  sock.addEventListener('error', () => { try { sock.close(); } catch {} });
}

function scheduleReconnect() {
  if (roomClosed || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 1500);
}

// React immediately when the device itself goes offline/online, rather than
// waiting for the socket to notice — snappier banner + reconnect.
window.addEventListener('offline', () => {
  setConnected(false);
  if (ws) { try { ws.close(); } catch {} }
});
window.addEventListener('online', () => {
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
    connect();
  }
});

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// ---- Incoming message handling -------------------------------------------
const feed = $('feed');
const partials = new Map(); // from -> element, for live "still speaking" preview

function handle(msg) {
  switch (msg.type) {
    case 'welcome':
      state.me = msg.you;
      break;
    case 'roster':
      state.members = msg.members;
      renderMembers();
      break;
    case 'history':
      replaceHistory(msg.messages);
      break;
    case 'system':
      addSystemLine(msg.text);
      break;
    case 'closed':
      // An admin ended this room. Don't reconnect — that would recreate it.
      roomClosed = true;
      addSystemLine('This room was closed.');
      $('conn-banner').textContent = 'This room was closed by an administrator.';
      $('conn-banner').classList.remove('hidden');
      setTimeout(() => { location.href = '/'; }, 2500);
      break;
    case 'partial':
      renderPartial(msg);
      break;
    case 'typing':
      renderTyping(msg);
      break;
    case 'message':
      clearPartial(msg.from);
      renderMessage(msg);
      break;
  }
}

function renderMembers() {
  const box = $('members');
  box.innerHTML = '';
  for (const m of state.members) {
    const el = document.createElement('span');
    el.className = 'member' + (m.isHost ? ' host' : '');
    const you = m.id === state.me ? ' (you)' : '';
    el.textContent = `${m.name}${you} · ${langName(m.speakLang).split(' · ')[0]}`;
    box.appendChild(el);
  }
}

function addSystemLine(text) {
  const el = document.createElement('div');
  el.className = 'system-line';
  el.textContent = text;
  feed.appendChild(el);
  scrollFeed();
}

// The server sends a history payload on join AND on every reconnect, so treat
// it as the authoritative recent state: reset the feed and replay it rather
// than appending (which would duplicate the whole conversation on reconnect).
function replaceHistory(messages) {
  feed.innerHTML = '';
  partials.clear();
  for (const id of typingTimers.values()) clearTimeout(id);
  typingTimers.clear();
  clearUnread();
  for (const m of messages) renderMessage({ ...m, history: true });
}

async function renderMessage(msg) {
  const mine = msg.from === state.me;
  // Decide once, before appending (which changes scrollHeight): follow the
  // feed for my own lines, history replay, or when already reading the tail.
  const stick = mine || Boolean(msg.history) || isNearBottom();
  const el = document.createElement('div');
  el.className = 'msg' + (mine ? ' me' : '');

  const who = document.createElement('div');
  who.className = 'who';
  who.textContent = mine ? 'You' : msg.fromName;
  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = formatTime(msg.ts);
  who.appendChild(time);
  el.appendChild(who);

  const primary = document.createElement('div');
  primary.className = 'primary';
  primary.textContent = msg.text; // filled/translated below
  el.appendChild(primary);

  el.dataset.src = msg.srcLang;
  feed.appendChild(el);
  if (stick) scrollFeed(true);
  else bumpUnread();

  // Translate into my primary read language.
  const pri = await translate(msg.text, msg.srcLang, state.recvPrimary);
  primary.textContent = pri.text;
  if (pri.translated) {
    primary.appendChild(makeTag(langName(state.recvPrimary).split(' · ')[0]));
  }

  // Optional secondary read language.
  if (state.recvSecondary && state.recvSecondary !== state.recvPrimary) {
    const sec = await translate(msg.text, msg.srcLang, state.recvSecondary);
    const secEl = document.createElement('div');
    secEl.className = 'secondary';
    secEl.textContent = sec.text;
    secEl.appendChild(makeTag(langName(state.recvSecondary).split(' · ')[0]));
    el.appendChild(secEl);
  }

  // Always keep the original available.
  if (msg.srcLang !== state.recvPrimary) {
    const orig = document.createElement('div');
    orig.className = 'orig';
    orig.textContent = `“${msg.text}” — ${langName(msg.srcLang).split(' · ')[0]}`;
    el.appendChild(orig);
  }

  // Per-message actions: copy the text I read, or hear this one line aloud
  // (independent of the global read-aloud setting).
  const spokenLang = pri.translated ? state.recvPrimary : msg.srcLang;
  const actions = document.createElement('div');
  actions.className = 'msg-actions';

  const copyBtn = document.createElement('button');
  copyBtn.className = 'msg-action copy';
  copyBtn.title = 'Copy';
  copyBtn.textContent = '⧉';
  copyBtn.addEventListener('click', async () => {
    // Copy what I read; include the original when it differs.
    const parts = [pri.text];
    if (msg.text !== pri.text) parts.push(msg.text);
    try {
      await navigator.clipboard.writeText(parts.join('\n'));
      toast('Copied');
    } catch {
      toast('Copy failed');
    }
  });
  actions.appendChild(copyBtn);

  const sayBtn = document.createElement('button');
  sayBtn.className = 'msg-action say';
  sayBtn.title = 'Read aloud';
  sayBtn.textContent = '🔊';
  sayBtn.addEventListener('click', () => speakAloud(pri.text, spokenLang));
  actions.appendChild(sayBtn);

  el.appendChild(actions);
  if (stick) scrollFeed(true);

  // Speak the primary translation aloud, if enabled and it's a fresh incoming
  // line (never replay the whole history through the speakers).
  if (state.speakAloud && !mine && !msg.history) speakAloud(pri.text, state.recvPrimary);
}

function formatTime(ts) {
  const d = ts ? new Date(ts) : new Date();
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// A single ephemeral indicator per person, shared by "speaking…" (voice) and
// "typing…" (composer). Typing pings auto-expire; a real message clears it.
const typingTimers = new Map(); // from -> timeout id

function ensureIndicator(from) {
  let el = partials.get(from);
  if (!el) {
    el = document.createElement('div');
    el.className = 'msg partial';
    feed.appendChild(el);
    partials.set(from, el);
  }
  return el;
}

function renderPartial(msg) {
  const el = ensureIndicator(msg.from);
  el.textContent = msg.text
    ? `${msg.fromName} is speaking… ${msg.text}`
    : `${msg.fromName} is speaking…`;
  scrollFeed();
}

function renderTyping(msg) {
  const el = ensureIndicator(msg.from);
  el.textContent = `${msg.fromName} is typing…`;
  scrollFeed();
  // Auto-clear if no further typing pings arrive shortly.
  clearTimeout(typingTimers.get(msg.from));
  typingTimers.set(msg.from, setTimeout(() => clearPartial(msg.from), 3500));
}

function clearPartial(from) {
  const el = partials.get(from);
  if (el) { el.remove(); partials.delete(from); }
  clearTimeout(typingTimers.get(from));
  typingTimers.delete(from);
}

function makeTag(text) {
  const t = document.createElement('span');
  t.className = 'tag';
  t.textContent = text;
  return t;
}

// Scroll handling: follow the conversation only while the reader is already at
// (or near) the bottom. If they've scrolled up to re-read, leave them there
// and count arrivals into the "↓ N new" chip instead.
function isNearBottom() {
  return feed.scrollHeight - feed.scrollTop - feed.clientHeight < 60;
}

function scrollFeed(force = false) {
  if (force || isNearBottom()) feed.scrollTop = feed.scrollHeight;
}

let unread = 0;
const newMsgsBtn = $('new-msgs');

function bumpUnread() {
  unread++;
  newMsgsBtn.textContent = `↓ ${unread} new`;
  newMsgsBtn.classList.remove('hidden');
}
function clearUnread() {
  unread = 0;
  newMsgsBtn.classList.add('hidden');
}
newMsgsBtn.addEventListener('click', () => {
  scrollFeed(true);
  clearUnread();
});
feed.addEventListener('scroll', () => {
  if (isNearBottom()) clearUnread();
});

// ---- Translation proxy ----------------------------------------------------
const localCache = new Map();
async function translate(text, from, to) {
  if (!from || !to || from === to) return { text, translated: false };
  const key = `${from}|${to}|${text}`;
  if (localCache.has(key)) return localCache.get(key);
  try {
    const r = await fetch('/api/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, from, to }),
    });
    const data = await r.json();
    localCache.set(key, data);
    return data;
  } catch {
    return { text, translated: false };
  }
}

// ---- Sending --------------------------------------------------------------
function sendText(text) {
  const clean = text.trim();
  if (!clean) return;
  send({ type: 'message', text: clean, srcLang: state.speakLang });
  // Echo locally so the sender sees their own line immediately.
  renderMessage({
    type: 'message',
    from: state.me,
    fromName: 'You',
    text: clean,
    srcLang: state.speakLang,
    ts: Date.now(),
  });
}

$('send-btn').addEventListener('click', () => {
  sendText($('composer').value);
  $('composer').value = '';
  autoGrow();
});
$('composer').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendText($('composer').value);
    $('composer').value = '';
    autoGrow();
  }
});
function autoGrow() {
  const ta = $('composer');
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
}

// Let others see "is typing…" while I compose — throttled to one ping/second.
let lastTypingSent = 0;
function notifyTyping() {
  const now = Date.now();
  if (now - lastTypingSent < 1000) return;
  lastTypingSent = now;
  send({ type: 'typing' });
}
$('composer').addEventListener('input', () => {
  autoGrow();
  if ($('composer').value.trim()) notifyTyping();
});

// ---- Text-to-speech -------------------------------------------------------
function speakAloud(text, lang) {
  if (!('speechSynthesis' in window) || !text) return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = speechLocale(lang);
  speechSynthesis.speak(u);
}

// ---- Speech-to-text (Whisper) ---------------------------------------------
// Tap the mic to record audio; tap again to stop. The clip is uploaded to
// /api/transcribe, which runs Whisper, and the returned text is sent as a
// message in the speaker's language.
const micBtn = $('mic-btn');
const canRecord =
  typeof MediaRecorder !== 'undefined' &&
  navigator.mediaDevices &&
  navigator.mediaDevices.getUserMedia;

let mediaRecorder = null;
let recStream = null;
let recChunks = [];
let recording = false;

function pickMime() {
  const prefs = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];
  return prefs.find((t) => MediaRecorder.isTypeSupported?.(t)) || '';
}

async function startRecording() {
  try {
    recStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    toast('Microphone permission denied');
    return;
  }
  const mime = pickMime();
  mediaRecorder = new MediaRecorder(recStream, mime ? { mimeType: mime } : undefined);
  recChunks = [];
  mediaRecorder.addEventListener('dataavailable', (e) => {
    if (e.data && e.data.size) recChunks.push(e.data);
  });
  mediaRecorder.addEventListener('stop', onRecordingStop);
  mediaRecorder.start();
  recording = true;
  micBtn.classList.add('on');
  // Let others know I've started talking.
  send({ type: 'partial', text: '🎙️ recording…', srcLang: state.speakLang });
}

function stopRecording() {
  if (!mediaRecorder) return;
  recording = false;
  micBtn.classList.remove('on');
  try { mediaRecorder.stop(); } catch {}
}

async function onRecordingStop() {
  recStream?.getTracks().forEach((t) => t.stop());
  const blob = new Blob(recChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
  recChunks = [];
  if (!blob.size) return;

  micBtn.classList.add('busy');
  micBtn.disabled = true;
  const prev = $('mic-note').textContent;
  $('mic-note').textContent = 'Transcribing with Whisper…';
  try {
    const r = await fetch(`/api/transcribe?lang=${encodeURIComponent(state.speakLang)}`, {
      method: 'POST',
      headers: { 'Content-Type': blob.type },
      body: blob,
    });
    const data = await r.json();
    if (data.text && data.text.trim()) {
      sendText(data.text.trim());
    } else {
      toast(data.error === 'not_configured'
        ? 'Whisper is not configured on the server'
        : 'Nothing transcribed — try again');
    }
  } catch {
    toast('Transcription failed');
  } finally {
    micBtn.classList.remove('busy');
    micBtn.disabled = false;
    $('mic-note').textContent = prev;
  }
}

if (canRecord) {
  micBtn.addEventListener('click', () => {
    if (recording) stopRecording();
    else startRecording();
  });
  $('mic-note').textContent = 'Tap the mic to record; tap again to stop and send (Whisper).';
} else {
  micBtn.disabled = true;
  $('mic-note').textContent = 'Audio recording is unavailable in this browser. You can still type.';
}

// Reflect the Whisper engine's status inside Settings.
fetch('/api/transcribe/status')
  .then((r) => r.json())
  .then((s) => {
    const el = $('whisper-status');
    if (!el) return;
    if (s.mock) el.textContent = '🧪 Mock mode (returns a canned transcript for testing).';
    else if (s.configured) el.textContent = `✅ Whisper ready · model ${s.model}`;
    else el.textContent = '⚠️ Not configured — set WHISPER_API_KEY (and optionally WHISPER_URL/MODEL) on the server.';
  })
  .catch(() => {});

// ---- Go --------------------------------------------------------------------
connect();
window.addEventListener('beforeunload', () => { if (ws) ws.close(); });
