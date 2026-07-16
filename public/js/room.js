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
// Speech-to-text uses the browser's Web Speech API where available.

import { LANGS, langName, speechLocale, fillLangSelect } from '/js/langs.js';

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
fillLangSelect($('recv-primary'), { selected: state.recvPrimary });
fillLangSelect($('recv-secondary'), { includeNone: true, selected: state.recvSecondary });
$('speak-aloud').checked = state.speakAloud;

$('speak-lang').addEventListener('change', (e) => {
  state.speakLang = e.target.value;
  savePrefs();
  send({ type: 'setLang', speakLang: state.speakLang });
  setupRecognition(); // speech locale follows the speak language
});
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

// ---- Invite panel ---------------------------------------------------------
$('room-code').textContent = ROOM;
const inviteUrl = `${location.origin}/room.html?room=${ROOM}`;
$('invite-url').value = inviteUrl;

if (!IS_HOST) {
  // Guests don't need to see the big QR block; keep it collapsible though.
  $('invite-card').classList.add('hidden');
}

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

$('collapse-invite').addEventListener('click', () =>
  $('invite-card').classList.add('hidden')
);

// ---- WebSocket ------------------------------------------------------------
let ws;
let reconnectTimer = null;

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.addEventListener('open', () => {
    send({
      type: 'join',
      room: ROOM,
      name: state.name,
      speakLang: state.speakLang,
      host: IS_HOST,
    });
  });

  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handle(msg);
  });

  ws.addEventListener('close', () => {
    scheduleReconnect();
  });
  ws.addEventListener('error', () => ws.close());
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 1500);
}

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
    case 'system':
      addSystemLine(msg.text);
      break;
    case 'partial':
      renderPartial(msg);
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

async function renderMessage(msg) {
  const mine = msg.from === state.me;
  const el = document.createElement('div');
  el.className = 'msg' + (mine ? ' me' : '');

  const who = document.createElement('div');
  who.className = 'who';
  who.textContent = mine ? 'You' : msg.fromName;
  el.appendChild(who);

  const primary = document.createElement('div');
  primary.className = 'primary';
  primary.textContent = msg.text; // filled/translated below
  el.appendChild(primary);

  el.dataset.src = msg.srcLang;
  feed.appendChild(el);
  scrollFeed();

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

  scrollFeed();

  // Speak the primary translation aloud, if enabled and it's not my own line.
  if (state.speakAloud && !mine) speakAloud(pri.text, state.recvPrimary);
}

function renderPartial(msg) {
  let el = partials.get(msg.from);
  if (!el) {
    el = document.createElement('div');
    el.className = 'msg partial';
    feed.appendChild(el);
    partials.set(msg.from, el);
  }
  el.textContent = `${msg.fromName} is speaking… ${msg.text}`;
  scrollFeed();
}
function clearPartial(from) {
  const el = partials.get(from);
  if (el) { el.remove(); partials.delete(from); }
}

function makeTag(text) {
  const t = document.createElement('span');
  t.className = 'tag';
  t.textContent = text;
  return t;
}

function scrollFeed() {
  feed.scrollTop = feed.scrollHeight;
}

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
$('composer').addEventListener('input', autoGrow);

// ---- Text-to-speech -------------------------------------------------------
function speakAloud(text, lang) {
  if (!('speechSynthesis' in window) || !text) return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = speechLocale(lang);
  speechSynthesis.speak(u);
}

// ---- Speech-to-text (Web Speech API) --------------------------------------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let listening = false;

function setupRecognition() {
  if (!SR) return;
  if (recognition) recognition.abort();
  recognition = new SR();
  recognition.lang = speechLocale(state.speakLang);
  recognition.interimResults = true;
  recognition.continuous = true;

  let finalBuffer = '';

  recognition.addEventListener('result', (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const chunk = e.results[i][0].transcript;
      if (e.results[i].isFinal) {
        finalBuffer += chunk + ' ';
      } else {
        interim += chunk;
      }
    }
    // Broadcast a live preview of what I'm saying.
    send({ type: 'partial', text: (finalBuffer + interim).trim(), srcLang: state.speakLang });
    $('composer').value = (finalBuffer + interim).trim();
    autoGrow();
  });

  recognition.addEventListener('end', () => {
    if (finalBuffer.trim()) {
      sendText(finalBuffer.trim());
      finalBuffer = '';
    }
    $('composer').value = '';
    autoGrow();
    if (listening) {
      // continuous mode sometimes stops on silence — restart while held on
      try { recognition.start(); } catch {}
    }
  });

  recognition.addEventListener('error', (e) => {
    if (e.error === 'not-allowed') {
      toast('Microphone permission denied');
      listening = false;
      $('mic-btn').classList.remove('on');
    }
  });
}

function startListening() {
  if (!recognition) return;
  listening = true;
  $('mic-btn').classList.add('on');
  try { recognition.start(); } catch {}
}
function stopListening() {
  listening = false;
  $('mic-btn').classList.remove('on');
  try { recognition.stop(); } catch {}
}

const micBtn = $('mic-btn');
if (SR) {
  setupRecognition();
  // Tap to toggle (mobile-friendly); also supports press-and-hold.
  micBtn.addEventListener('click', () => {
    if (listening) stopListening();
    else startListening();
  });
  $('mic-note').textContent =
    'Tap the mic to start/stop dictation in your speak language. Interim words preview live to the room.';
} else {
  micBtn.disabled = true;
  $('mic-note').textContent =
    'Live dictation needs a browser with the Web Speech API (Chrome / Safari). You can still type.';
}

// ---- Go --------------------------------------------------------------------
connect();
window.addEventListener('beforeunload', () => { if (ws) ws.close(); });
