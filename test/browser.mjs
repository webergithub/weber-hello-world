// Browser end-to-end test using the pre-installed Chromium.
// Drives the *real* client code: host creates a room in the UI, a guest joins,
// the host sends a message, and we assert the guest's screen shows it
// translated into the guest's chosen read language.
import { chromium } from 'playwright-core';

const EXEC = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const BASE = `http://localhost:${process.env.PORT || 3111}`;
let failures = 0;
const ok = (c, l) => { console.log(`${c ? '✅' : '❌'} ${l}`); if (!c) failures++; };

const browser = await chromium.launch({
  executablePath: EXEC,
  args: [
    '--no-sandbox',
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
  ],
});

// Open My menu -> Settings so the language selects are interactable.
async function openSettings(page) {
  await page.click('#menu-btn');
  await page.click('#menu-settings');
  await page.waitForSelector('#settings-sheet:not(.hidden)');
}
async function closeSettings(page) {
  await page.click('#settings-sheet [data-close]');
  await page.waitForSelector('#settings-sheet', { state: 'hidden' });
}

try {
  // ---- Host creates a room ----
  const hostCtx = await browser.newContext();
  const host = await hostCtx.newPage();
  const errors = [];
  host.on('pageerror', (e) => errors.push(String(e)));
  await host.goto(BASE);
  await host.fill('#host-name', 'Weber');
  await host.selectOption('#host-lang', 'en');
  await host.click('#create-btn');
  await host.waitForURL('**/room.html?room=*');
  const roomCode = new URL(host.url()).searchParams.get('room');
  ok(/^[A-Z0-9]{6}$/.test(roomCode), `host landed in room ${roomCode}`);

  // QR image should load as a data URL.
  await host.waitForFunction(() => {
    const img = document.getElementById('qr-img');
    return img && img.src.startsWith('data:image/png');
  }, { timeout: 5000 });
  ok(true, 'QR code rendered on host screen');

  // Invite link is populated (invite sheet auto-opens for the host).
  const inviteVal = await host.inputValue('#invite-url');
  ok(inviteVal.includes(roomCode), 'invite link contains room code');
  // Close it so the host can chat.
  await host.click('#invite-sheet [data-close]');
  await host.waitForSelector('#invite-sheet', { state: 'hidden' });

  // ---- Guest joins the same room, reading in Chinese ----
  const guestCtx = await browser.newContext();
  const guest = await guestCtx.newPage();
  guest.on('pageerror', (e) => errors.push(String(e)));
  await guest.goto(`${BASE}/room.html?room=${roomCode}`);
  await guest.waitForSelector('#menu-btn');
  await openSettings(guest);                           // settings live under My menu now
  await guest.selectOption('#speak-lang', 'zh');       // guest speaks Chinese
  await guest.selectOption('#recv-primary', 'zh');     // and reads Chinese
  await guest.selectOption('#recv-secondary', 'fr');   // secondary: French
  const whisperStatus = await guest.textContent('#whisper-status');
  ok(/mock|whisper|configured/i.test(whisperStatus || ''), `settings shows Whisper status (${whisperStatus?.trim()})`);
  await closeSettings(guest);

  // Wait for both to appear in the roster (2 members).
  await guest.waitForFunction(
    () => document.querySelectorAll('#members .member').length === 2,
    { timeout: 5000 }
  );
  ok(true, 'guest sees both members in roster');

  // ---- Host sends "Good morning" ----
  await host.fill('#composer', 'Good morning');
  await host.click('#send-btn');

  // Guest should see it translated to Chinese (primary) with French secondary.
  await guest.waitForFunction(() => {
    const msgs = [...document.querySelectorAll('#feed .msg')];
    return msgs.some((m) => (m.querySelector('.primary')?.textContent || '').includes('早上好'));
  }, { timeout: 8000 });
  ok(true, 'guest received message translated to primary (早上好 / Chinese)');

  // Secondary + original render after a second async translate, so wait.
  const secondaryFound = await guest.waitForFunction(() =>
    [...document.querySelectorAll('#feed .msg .secondary')].some((m) =>
      m.textContent.toLowerCase().includes('bonjour')), { timeout: 8000 })
    .then(() => true).catch(() => false);
  ok(secondaryFound, 'guest also sees secondary translation (bonjour / French)');

  const origFound = await guest.waitForFunction(() =>
    [...document.querySelectorAll('#feed .msg .orig')].some((m) =>
      m.textContent.includes('Good morning')), { timeout: 8000 })
    .then(() => true).catch(() => false);
  ok(origFound, 'original English text kept under the translation');

  // Sender must see its own message exactly once (no local-echo + relay dupe).
  await host.waitForTimeout(400);
  const hostOwnCount = await host.evaluate(() =>
    [...document.querySelectorAll('#feed .msg .primary')]
      .filter((m) => m.textContent.includes('Good morning')).length);
  ok(hostOwnCount === 1, `host sees its own message once (got ${hostOwnCount})`);

  // ---- Guest replies in Chinese; host reads English ----
  await openSettings(host);
  await host.selectOption('#recv-primary', 'en');
  await closeSettings(host);
  await guest.fill('#composer', '你好');
  await guest.click('#send-btn');
  await host.waitForFunction(() => {
    const msgs = [...document.querySelectorAll('#feed .msg')];
    return msgs.some((m) => (m.querySelector('.primary')?.textContent || '').toLowerCase().includes('hello'));
  }, { timeout: 8000 });
  ok(true, 'host received guest reply translated to English (hello)');

  // ---- Whisper voice input: record → transcribe (mock) → send ----
  // Guest speaks Chinese; the mock Whisper returns "hello", which the host
  // (reading English) should receive. Fake media devices supply the audio.
  const beforeCount = await host.evaluate(() =>
    document.querySelectorAll('#feed .msg').length);
  await guest.click('#mic-btn');                 // start recording
  await guest.waitForTimeout(700);
  await guest.click('#mic-btn');                 // stop -> upload -> transcribe
  const voiceArrived = await host.waitForFunction((n) =>
    document.querySelectorAll('#feed .msg').length > n, beforeCount, { timeout: 12000 })
    .then(() => true).catch(() => false);
  ok(voiceArrived, 'voice message transcribed by Whisper and relayed');

  ok(errors.length === 0, `no client-side JS errors (${errors.length})`);
  if (errors.length) console.log(errors.join('\n'));
} catch (e) {
  console.error('EXCEPTION', e);
  failures++;
} finally {
  await browser.close();
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll browser checks passed');
process.exit(failures ? 1 : 0);
