// Persistence test: a message sent to one server instance must still be there
// after that instance is stopped and a fresh instance boots from the same data
// file. Spawns its own servers (independent of the shared test runner).
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = process.env.PERSIST_PORT || '3212';
const DATA_FILE = path.join(os.tmpdir(), `linktalk-persist-${PORT}.json`);
const BASE = `http://localhost:${PORT}`;
const WS = `ws://localhost:${PORT}/ws`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (c, l) => { console.log(`${c ? '✅' : '❌'} ${l}`); if (!c) failures++; };

try { fs.unlinkSync(DATA_FILE); } catch {}

function startServer() {
  // Force PERSIST on for our own instances even if the parent disabled it.
  const env = { ...process.env, PORT, DATA_FILE, WHISPER_MOCK: '1', PERSIST: '1' };
  const p = spawn('node', ['server.js'], { env, stdio: ['ignore', 'ignore', 'inherit'] });
  return p;
}

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${BASE}/api/rooms`, { method: 'POST' }); if (r.ok) return true; }
    catch { /* not up */ }
    await sleep(200);
  }
  return false;
}

function stopServer(p) {
  return new Promise((resolve) => {
    p.on('exit', resolve);
    p.kill('SIGTERM'); // triggers the synchronous saveSync() on shutdown
    setTimeout(() => { try { p.kill('SIGKILL'); } catch {} resolve(); }, 3000);
  });
}

// Join a room and send one message, then resolve with the room code.
function sendMessage(code, text) {
  return new Promise((resolve) => {
    const w = new WebSocket(WS);
    w.on('open', () =>
      w.send(JSON.stringify({ type: 'join', room: code, name: 'A', speakLang: 'en', host: true })));
    w.on('message', (buf) => {
      const m = JSON.parse(buf.toString());
      if (m.type === 'welcome') {
        w.send(JSON.stringify({ type: 'message', text, srcLang: 'en' }));
        setTimeout(() => { w.close(); resolve(); }, 400);
      }
    });
  });
}

// Join a room and collect the history the server sends on join.
function fetchHistory(code) {
  return new Promise((resolve) => {
    const w = new WebSocket(WS);
    let history = null;
    w.on('open', () =>
      w.send(JSON.stringify({ type: 'join', room: code, name: 'B', speakLang: 'en' })));
    w.on('message', (buf) => {
      const m = JSON.parse(buf.toString());
      if (m.type === 'history') history = m.messages;
    });
    setTimeout(() => { w.close(); resolve(history); }, 700);
  });
}

async function main() {
  const CODE = 'PERSA1';

  // --- Instance 1: create a room, send a message, then shut down. ---
  let srv = startServer();
  ok(await waitReady(), 'first server instance started');
  await sendMessage(CODE, 'survives restart');
  await sleep(1300); // let the debounced save flush
  await stopServer(srv);
  ok(fs.existsSync(DATA_FILE), 'data file written to disk');

  // --- Instance 2: boot from the same data file, expect the history back. ---
  srv = startServer();
  ok(await waitReady(), 'second server instance started from saved data');
  const history = await fetchHistory(CODE);
  ok(Array.isArray(history) && history.some((m) => m.text === 'survives restart'),
    'message history survived the restart');
  await stopServer(srv);

  try { fs.unlinkSync(DATA_FILE); } catch {}
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll persistence checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
