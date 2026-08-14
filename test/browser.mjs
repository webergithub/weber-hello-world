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

  // ---- Face-to-face 4-digit code is shown on the host's invite sheet ----
  const pin = await host.waitForFunction(() => {
    const v = document.getElementById('pin-value')?.textContent || '';
    return /^\d{4}$/.test(v) ? v : null;
  }, { timeout: 6000 }).then((h) => h.jsonValue()).catch(() => null);
  ok(pin !== null, `host shows a 4-digit face-to-face code (${pin})`);
  const expiryShown = await host.waitForFunction(() =>
    /Expires in/.test(document.getElementById('pin-expiry')?.textContent || ''),
    { timeout: 4000 }).then(() => true).catch(() => false);
  ok(expiryShown, 'face-to-face code shows a countdown');

  // ---- A third phone joins by typing only those 4 digits ----
  const pinCtx = await browser.newContext();
  const pinPhone = await pinCtx.newPage();
  pinPhone.on('pageerror', (e) => errors.push(String(e)));
  await pinPhone.goto(BASE);
  await pinPhone.fill('#join-name', 'PinJoiner');
  await pinPhone.fill('#join-code', pin);
  await pinPhone.click('#join-btn');
  const pinJoined = await pinPhone.waitForURL(`**/room.html?room=${roomCode}`, { timeout: 8000 })
    .then(() => true).catch(() => false);
  ok(pinJoined, 'typing the 4-digit code joins the right room');
  // Let it leave again so later roster assertions see a clean two-phone room.
  await pinCtx.close();
  await host.waitForFunction(() =>
    document.querySelectorAll('#members .member').length === 1, { timeout: 6000 })
    .catch(() => {});

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

  // ---- Per-message actions: copy + read-aloud ----
  await guestCtx.grantPermissions(['clipboard-read', 'clipboard-write']);
  await guest.evaluate(() => {
    // Spy on TTS so we can assert without audio hardware.
    window.__spoken = [];
    speechSynthesis.speak = (u) => window.__spoken.push({ text: u.text, lang: u.lang });
  });
  await guest.evaluate(() => {
    const el = [...document.querySelectorAll('#feed .msg')].find((m) =>
      (m.querySelector('.primary')?.textContent || '').includes('早上好'));
    el.querySelector('.msg-action.copy').click();
    el.querySelector('.msg-action.say').click();
  });
  await guest.waitForTimeout(300);
  const clip = await guest.evaluate(() => navigator.clipboard.readText());
  ok(clip.includes('早上好') && clip.includes('Good morning'),
    'copy button puts translation + original on the clipboard');
  const spoken = await guest.evaluate(() => window.__spoken);
  ok(spoken.length === 1 && spoken[0].text.includes('早上好') && spoken[0].lang === 'zh-CN',
    `read-aloud button speaks the translation in the right locale (${JSON.stringify(spoken[0] || null)})`);

  // Sender must see its own message exactly once (no local-echo + relay dupe).
  await host.waitForTimeout(400);
  const hostOwnCount = await host.evaluate(() =>
    [...document.querySelectorAll('#feed .msg .primary')]
      .filter((m) => m.textContent.includes('Good morning')).length);
  ok(hostOwnCount === 1, `host sees its own message once (got ${hostOwnCount})`);

  // Messages carry a timestamp in their header.
  const hasTime = await guest.evaluate(() =>
    [...document.querySelectorAll('#feed .msg .who .time')]
      .some((t) => /\d{1,2}[:.]\d{2}/.test(t.textContent)));
  ok(hasTime, 'messages show a timestamp');

  // Typing in the host composer shows a live "is typing…" line on the guest.
  // Type over >1s so more than one throttled ping is emitted (robust to timing).
  await host.type('#composer', 'typing indicator now', { delay: 90 });
  const typingSeen = await guest.waitForFunction(() =>
    [...document.querySelectorAll('#feed .msg.partial')].some((m) =>
      /is typing/.test(m.textContent)), { timeout: 5000 })
    .then(() => true).catch(() => false);
  ok(typingSeen, 'guest sees a live "is typing…" indicator');
  // Sending clears the indicator.
  await host.click('#send-btn');
  const typingCleared = await guest.waitForFunction(() =>
    ![...document.querySelectorAll('#feed .msg.partial')].some((m) =>
      /is typing/.test(m.textContent)), { timeout: 5000 })
    .then(() => true).catch(() => false);
  ok(typingCleared, 'typing indicator clears once the message arrives');

  // ---- Quick language switch under the composer ----
  await guest.selectOption('#quick-speak', 'ja');
  const mirrored = await guest.evaluate(() => document.getElementById('speak-lang').value);
  ok(mirrored === 'ja', 'quick-switch mirrors into the Settings sheet');
  const rosterUpdated = await host.waitForFunction(() =>
    [...document.querySelectorAll('#members .member')].some((m) =>
      m.textContent.includes('Japanese')), { timeout: 5000 })
    .then(() => true).catch(() => false);
  ok(rosterUpdated, 'room roster reflects the quick-switched language');
  await guest.selectOption('#quick-speak', 'zh'); // restore for later steps

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

  // ---- Reconnect: dropping and restoring the network must not duplicate the
  //      conversation, and should surface then clear the reconnect banner. ----
  const msgsBefore = await guest.evaluate(() =>
    document.querySelectorAll('#feed .msg:not(.partial)').length);
  await guestCtx.setOffline(true);
  const bannerShown = await guest.waitForSelector('#conn-banner', { state: 'visible', timeout: 6000 })
    .then(() => true).catch(() => false);
  ok(bannerShown, 'reconnect banner appears when the connection drops');
  await guestCtx.setOffline(false);
  const bannerCleared = await guest.waitForSelector('#conn-banner', { state: 'hidden', timeout: 8000 })
    .then(() => true).catch(() => false);
  ok(bannerCleared, 'reconnect banner clears once reconnected');
  await guest.waitForTimeout(600); // let history replay settle
  const msgsAfter = await guest.evaluate(() =>
    document.querySelectorAll('#feed .msg:not(.partial)').length);
  ok(msgsAfter === msgsBefore,
    `reconnect does not duplicate messages (before ${msgsBefore}, after ${msgsAfter})`);

  // ---- Unread chip: scrolling up must not be yanked down by new arrivals ----
  // Shrink the feed so it definitely overflows, then read from the top.
  await guest.evaluate(() => {
    const f = document.getElementById('feed');
    f.style.maxHeight = '120px';
    f.scrollTop = 0;
  });
  await host.fill('#composer', 'Scroll test one');
  await host.click('#send-btn');
  const chipShown = await guest.waitForSelector('#new-msgs', { state: 'visible', timeout: 6000 })
    .then(() => true).catch(() => false);
  ok(chipShown, 'unread chip appears for messages arriving while scrolled up');
  const stayedPut = await guest.evaluate(() => document.getElementById('feed').scrollTop < 60);
  ok(stayedPut, 'feed does not auto-scroll away from the reading position');
  await guest.click('#new-msgs');
  const chipGone = await guest.waitForSelector('#new-msgs', { state: 'hidden', timeout: 4000 })
    .then(() => true).catch(() => false);
  const atBottom = await guest.evaluate(() => {
    const f = document.getElementById('feed');
    return f.scrollHeight - f.scrollTop - f.clientHeight < 60;
  });
  ok(chipGone && atBottom, 'tapping the chip jumps to the newest message and clears it');
  await guest.evaluate(() => { document.getElementById('feed').style.maxHeight = ''; });

  // ---- History: a phone that reloads mid-conversation sees prior messages ----
  await guest.reload();
  await guest.waitForSelector('#menu-btn');
  const historyShown = await guest.waitForFunction(() =>
    document.querySelectorAll('#feed .msg').length > 0, { timeout: 8000 })
    .then(() => true).catch(() => false);
  ok(historyShown, 'reloaded phone catches up on the conversation history');

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
