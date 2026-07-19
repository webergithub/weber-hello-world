// End-to-end smoke test: exercises REST endpoints, the translation chain, and
// the WebSocket relay (two clients in a room see each other's messages).
// Run with the server already listening on PORT (default 3000).
import { WebSocket } from 'ws';

const BASE = `http://localhost:${process.env.PORT || 3000}`;
const WS = BASE.replace('http', 'ws') + '/ws';
let failures = 0;

function ok(cond, label) {
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond) failures++;
}

async function main() {
  // --- REST: create room ---
  const created = await (await fetch(`${BASE}/api/rooms`, { method: 'POST' })).json();
  ok(/^[A-Z0-9]{6}$/.test(created.code), `create room -> code ${created.code}`);
  const CODE = created.code;

  // --- REST: room lookup ---
  const look = await fetch(`${BASE}/api/rooms/${CODE}`);
  ok(look.ok, 'existing room lookup 200');
  const missing = await fetch(`${BASE}/api/rooms/ZZZZZZ`);
  ok(missing.status === 404, 'missing room lookup 404');

  // --- REST: QR ---
  const qr = await (await fetch(`${BASE}/api/qr?room=${CODE}`)).json();
  ok(qr.dataUrl?.startsWith('data:image/png;base64,'), 'QR data URL generated');

  // --- Translation chain (offline phrasebook, since egress is blocked) ---
  const t1 = await (await fetch(`${BASE}/api/translate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'Hello', from: 'en', to: 'zh' }),
  })).json();
  ok(t1.text === '你好' && t1.translated, `translate Hello en->zh = ${t1.text}`);

  const t2 = await (await fetch(`${BASE}/api/translate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '你好', from: 'zh', to: 'ja' }),
  })).json();
  ok(t2.text === 'こんにちは' && t2.translated, `translate 你好 zh->ja = ${t2.text}`);

  const t3 = await (await fetch(`${BASE}/api/translate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'Hello', from: 'en', to: 'en' }),
  })).json();
  ok(t3.translated === false, 'same-language short-circuit');

  const t4 = await (await fetch(`${BASE}/api/translate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'unlisted sentence here', from: 'en', to: 'zh' }),
  })).json();
  ok(t4.translated === false && t4.text === 'unlisted sentence here',
    'unknown phrase falls back to original');

  // --- Whisper transcription (mock mode) ---
  const wstat = await (await fetch(`${BASE}/api/transcribe/status`)).json();
  ok(wstat.mock === true, 'transcribe status reports mock mode');
  const tr = await fetch(`${BASE}/api/transcribe?lang=en`, {
    method: 'POST',
    headers: { 'Content-Type': 'audio/webm' },
    body: Buffer.from([1, 2, 3, 4, 5]),
  });
  const trBody = await tr.json();
  ok(tr.ok && trBody.text === 'hello', `mock transcribe returns text = ${trBody.text}`);
  const trEmpty = await fetch(`${BASE}/api/transcribe?lang=en`, {
    method: 'POST', headers: { 'Content-Type': 'audio/webm' }, body: Buffer.alloc(0),
  });
  ok(trEmpty.status === 400, 'empty audio rejected with 400');

  // --- WebSocket relay: two clients in the same room ---
  await relayTest(CODE);

  // --- History: a late joiner catches up on earlier messages ---
  await historyTest();

  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
}

// A joins a fresh room and speaks; B joins later and should receive history.
async function historyTest() {
  const { code } = await (await fetch(`${BASE}/api/rooms`, { method: 'POST' })).json();
  return new Promise((resolve) => {
    const a = new WebSocket(WS);
    let sent = false;
    let historyMsgs = null;

    a.on('open', () =>
      a.send(JSON.stringify({ type: 'join', room: code, name: 'A', speakLang: 'en', host: true })));
    a.on('message', (buf) => {
      const m = JSON.parse(buf.toString());
      if (m.type === 'welcome' && !sent) {
        sent = true;
        a.send(JSON.stringify({ type: 'message', text: 'earlier line', srcLang: 'en' }));
        // Give the server a tick to store history, then join as B.
        setTimeout(joinB, 300);
      }
    });

    function joinB() {
      const b = new WebSocket(WS);
      b.on('open', () =>
        b.send(JSON.stringify({ type: 'join', room: code, name: 'B', speakLang: 'zh' })));
      b.on('message', (buf) => {
        const m = JSON.parse(buf.toString());
        if (m.type === 'history') historyMsgs = m.messages;
      });
      setTimeout(() => {
        ok(Array.isArray(historyMsgs) && historyMsgs.some((x) => x.text === 'earlier line'),
          'late joiner receives prior message in history');
        a.close(); b.close();
        resolve();
      }, 800);
    }
  });
}

function relayTest(code) {
  return new Promise((resolve) => {
    const host = new WebSocket(WS);
    const guest = new WebSocket(WS);
    let hostReady = false, guestReady = false;
    let guestGotRoster = false;
    const received = [];

    const maybeSend = () => {
      if (hostReady && guestReady) {
        // guest should receive host's message, translated on the guest side.
        host.send(JSON.stringify({ type: 'message', text: 'Good morning', srcLang: 'en' }));
      }
    };

    host.on('open', () =>
      host.send(JSON.stringify({ type: 'join', room: code, name: 'Host', speakLang: 'en', host: true })));
    guest.on('open', () =>
      guest.send(JSON.stringify({ type: 'join', room: code, name: 'Guest', speakLang: 'zh' })));

    host.on('message', (b) => {
      const m = JSON.parse(b.toString());
      if (m.type === 'welcome') { hostReady = true; maybeSend(); }
    });

    guest.on('message', (b) => {
      const m = JSON.parse(b.toString());
      if (m.type === 'welcome') { guestReady = true; maybeSend(); }
      if (m.type === 'roster' && m.members.length === 2) guestGotRoster = true;
      if (m.type === 'message') received.push(m);
    });

    setTimeout(() => {
      ok(guestGotRoster, 'guest sees 2-member roster');
      ok(received.length === 1 && received[0].text === 'Good morning' && received[0].srcLang === 'en',
        'guest received host message with source language');
      host.close(); guest.close();
      resolve();
    }, 1500);
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
