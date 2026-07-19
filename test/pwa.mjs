// PWA / offline test: the service worker must register, precache the app shell,
// and serve the home + room screens with the network fully offline.
import { chromium } from 'playwright-core';

const EXEC = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const BASE = `http://localhost:${process.env.PORT || 3111}`;
let failures = 0;
const ok = (c, l) => { console.log(`${c ? '✅' : '❌'} ${l}`); if (!c) failures++; };

const browser = await chromium.launch({ executablePath: EXEC, args: ['--no-sandbox'] });

try {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  // First online load registers + activates the worker and precaches the shell.
  await page.goto(BASE);
  await page.waitForFunction(() => navigator.serviceWorker?.controller != null, { timeout: 8000 })
    .then(() => ok(true, 'service worker registered and controlling the page'))
    .catch(() => ok(false, 'service worker never took control'));

  // Warm the room shell into the cache while still online.
  await page.goto(`${BASE}/room.html?room=TESTAA`);
  await page.waitForSelector('#menu-btn');
  ok(true, 'room screen loads online');

  // Go fully offline and reload both screens — they must come from the cache.
  await ctx.setOffline(true);

  await page.goto(`${BASE}/room.html?room=TESTAA`).catch(() => {});
  const roomOffline = await page.waitForSelector('#menu-btn', { timeout: 6000 })
    .then(() => true).catch(() => false);
  ok(roomOffline, 'room screen still loads while offline (from cache)');

  await page.goto(BASE).catch(() => {});
  const homeOffline = await page.waitForSelector('#create-btn', { timeout: 6000 })
    .then(() => true).catch(() => false);
  ok(homeOffline, 'home screen still loads while offline (from cache)');

  await ctx.setOffline(false);
} catch (e) {
  console.error('EXCEPTION', e);
  failures++;
} finally {
  await browser.close();
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll PWA checks passed');
process.exit(failures ? 1 : 0);
