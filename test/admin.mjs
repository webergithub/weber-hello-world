// Backend/ops test: health, metrics, rate limiting, and the admin API.
// Spawns its own servers so it can control ADMIN_TOKEN and the rate limits
// without affecting the shared test server.
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import os from 'node:os';
import path from 'node:path';

const PORT = process.env.ADMIN_PORT || '3221';
const PORT_NOAUTH = String(Number(PORT) + 1);
const TOKEN = 'test-admin-token';
const BASE = `http://localhost:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (c, l) => { console.log(`${c ? '✅' : '❌'} ${l}`); if (!c) failures++; };

function startServer(port, env = {}) {
  return spawn('node', ['server.js'], {
    env: {
      ...process.env,
      PORT: port,
      WHISPER_MOCK: '1',
      PERSIST: '0',
      DATA_FILE: path.join(os.tmpdir(), `linktalk-admin-${port}.json`),
      ...env,
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
}

async function waitReady(port) {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://localhost:${port}/api/health`);
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await sleep(200);
  }
  return false;
}

const authed = (extra = {}) => ({ headers: { Authorization: `Bearer ${TOKEN}`, ...extra } });

// Join a room over WebSocket and send one message; resolve once it's stored.
function occupyRoom(code, text) {
  return new Promise((resolve) => {
    const w = new WebSocket(`ws://localhost:${PORT}/ws`);
    w.on('open', () =>
      w.send(JSON.stringify({ type: 'join', room: code, name: 'Tester', speakLang: 'en', host: true })));
    w.on('message', (buf) => {
      const m = JSON.parse(buf.toString());
      if (m.type === 'welcome') {
        w.send(JSON.stringify({ type: 'message', text, srcLang: 'en' }));
        setTimeout(() => resolve(w), 400);
      }
      if (m.type === 'closed') w.__gotClosed = true;
    });
  });
}

async function main() {
  // Low translate limit so the rate-limit check is fast and unambiguous.
  const srv = startServer(PORT, { ADMIN_TOKEN: TOKEN, RATE_TRANSLATE_PER_MIN: '5' });
  ok(await waitReady(PORT), 'server started with ADMIN_TOKEN');

  // ---- Health ----
  const health = await (await fetch(`${BASE}/api/health`)).json();
  ok(health.status === 'ok' && typeof health.uptimeSec === 'number',
    `health reports ok (uptime ${health.uptimeSec}s)`);
  ok(health.whisper?.mock === true, 'health reflects Whisper mock configuration');

  // ---- Console shell is reachable at the pretty URL ----
  const page = await fetch(`${BASE}/admin`);
  const html = await page.text();
  ok(page.ok && html.includes('id="token"'), 'admin console is served at /admin');

  // ---- Auth posture ----
  ok((await fetch(`${BASE}/api/admin/rooms`)).status === 401,
    'admin API rejects a request with no token');
  ok((await fetch(`${BASE}/api/admin/rooms`, { headers: { Authorization: 'Bearer wrong' } })).status === 401,
    'admin API rejects a wrong token');

  // ---- Admin is disabled unless ADMIN_TOKEN is set ----
  const srv2 = startServer(PORT_NOAUTH); // no ADMIN_TOKEN
  await waitReady(PORT_NOAUTH);
  const disabled = await fetch(`http://localhost:${PORT_NOAUTH}/api/admin/rooms`);
  const disabledBody = await disabled.json();
  ok(disabled.status === 503 && disabledBody.error === 'admin_disabled',
    'admin API is disabled (503) when ADMIN_TOKEN is unset');
  srv2.kill('SIGKILL');

  // ---- Rooms appear in the admin listing ----
  const CODE = 'ADMIN1';
  const sock = await occupyRoom(CODE, 'hello from the test');
  const list = await (await fetch(`${BASE}/api/admin/rooms`, authed())).json();
  const entry = list.rooms.find((r) => r.code === CODE);
  ok(entry && entry.members === 1 && entry.messages === 1,
    `admin lists the live room (${entry?.members} member, ${entry?.messages} message)`);

  const detail = await (await fetch(`${BASE}/api/admin/rooms/${CODE}`, authed())).json();
  ok(detail.people?.[0]?.name === 'Tester' &&
     detail.recent?.some((m) => m.text === 'hello from the test'),
    'admin room detail shows people and recent messages');

  ok((await fetch(`${BASE}/api/admin/rooms/NOPE12`, authed())).status === 404,
    'unknown room returns 404');

  // ---- Metrics reflect real activity ----
  await fetch(`${BASE}/api/translate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'Hello', from: 'en', to: 'zh' }),
  });
  const m = await (await fetch(`${BASE}/api/metrics`)).json();
  ok(m.messages.relayed >= 1 && m.ws.joins >= 1, 'metrics count relayed messages and joins');
  ok(m.translate.requests >= 1 && (m.translate.offline + m.translate.provider) >= 1,
    'metrics break translation down by how it was served');

  // ---- Rate limiting (limit is 5/min for translate) ----
  let sawLimit = null;
  for (let i = 0; i < 12; i++) {
    const r = await fetch(`${BASE}/api/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: `burst ${i}`, from: 'en', to: 'zh' }),
    });
    if (r.status === 429) { sawLimit = r; break; }
  }
  ok(sawLimit !== null, 'translate endpoint rate limits a burst');
  ok(sawLimit !== null && sawLimit.headers.get('retry-after') !== null,
    'rate-limited response carries Retry-After');

  // ---- Closing a room disconnects members and removes it ----
  const closed = await (await fetch(`${BASE}/api/admin/rooms/${CODE}`, {
    method: 'DELETE', ...authed(),
  })).json();
  ok(closed.closed === CODE && closed.disconnected === 1,
    'closing a room reports the members it disconnected');
  await sleep(400);
  ok(sock.__gotClosed === true, 'connected client was told the room closed');
  const after = await (await fetch(`${BASE}/api/admin/rooms`, authed())).json();
  ok(!after.rooms.some((r) => r.code === CODE), 'closed room no longer appears in the listing');

  try { sock.close(); } catch {}
  srv.kill('SIGKILL');
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll admin/ops checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
