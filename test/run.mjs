// Test runner: starts the server (Whisper in mock mode) on a test port, waits
// for it to accept requests, runs every suite against it, then shuts it down.
// Usage: npm test
import { spawn } from 'node:child_process';

const PORT = process.env.PORT || '3199';
const env = { ...process.env, PORT, WHISPER_MOCK: '1' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The shared server has persistence off so the suites don't leave a data file
// behind; the persistence suite spins up its own instances with it forced on.
const server = spawn('node', ['server.js'], {
  env: { ...env, PERSIST: '0' },
  stdio: ['ignore', 'ignore', 'inherit'],
});

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://localhost:${PORT}/api/rooms`, { method: 'POST' });
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await sleep(200);
  }
  return false;
}

function runSuite(file) {
  return new Promise((resolve) => {
    const p = spawn('node', [file], { env, stdio: 'inherit' });
    p.on('exit', (code) => resolve(code ?? 1));
  });
}

const SUITES = [
  'test/e2e.mjs',
  'test/browser.mjs',
  'test/pwa.mjs',
  'test/persist.mjs',
  'test/admin.mjs',
];

let failed = 0;
if (!(await waitReady())) {
  console.error('Server did not start in time');
  failed = 1;
} else {
  for (const suite of SUITES) {
    console.log(`\n───── ${suite} ─────`);
    const code = await runSuite(suite);
    if (code !== 0) failed++;
  }
}

server.kill('SIGKILL');
console.log(failed ? `\n${failed} suite(s) failed` : '\n✔ All suites passed');
process.exit(failed ? 1 : 0);
