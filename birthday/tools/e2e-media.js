/* 拍照 / 录视频 / 视频自动播放 的浏览器测试 Browser test for camera capture, video upload and video playback
   用法 Usage:  node birthday/tools/e2e-media.js [输出文件夹 out-dir]
   需要 Needs:  playwright (with Chromium) and ffmpeg, to make the test video and photo.
   走一遍 It walks through:
     · 家庭服务器模式 server mode, on a phone (touch): 拍照、录视频按钮带 capture、M04 选择面板、上传进度、视频存成加密文件、按字节范围读取
     · 电视播放页 the TV page: 视频在前面时自动播放、背景音乐让开、观看模式等视频放完再翻页、这一年的相册里的视频
     · 浏览器不让带声音自动播放时 when sound needs a tap: 静音播放并出现“点一下听声音”
     · 没有服务器 no server: 视频存在浏览器里、刷新后还在、超过上限的视频被拒绝
     · 电脑 desktop: 不显示拍照按钮，点封面直接打开选择文件 */
'use strict';
const { chromium, devices } = require('playwright');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');

const SITE = path.join(__dirname, '..'), OUT = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'tenup-media-e2e'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tenup-media-')), MEDIA = path.join(tmp, 'media');
fs.mkdirSync(OUT, { recursive: true }); fs.mkdirSync(MEDIA);
let passed = 0, failed = 0;
function ok(name, cond, extra) { if (cond) { passed++; console.log('  ok   ' + name); } else { failed++; console.log('  FAIL ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); } }
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* test media: a 3-second WebM with a tone (Chromium plays it), an iPhone-style .mov (H.264), a photo, and an oversized "video" */
function ff(args) { execFileSync('ffmpeg', ['-loglevel', 'error', '-y'].concat(args)); }
ff(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=3', '-f', 'lavfi', '-i', 'sine=frequency=660:duration=3', '-c:v', 'libvpx', '-b:v', '400k', '-c:a', 'libvorbis', '-shortest', path.join(MEDIA, 'clip.webm')]);
ff(['-f', 'lavfi', '-i', 'testsrc=size=640x480:rate=25:duration=3', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-f', 'mov', path.join(MEDIA, 'IMG_0001.MOV')]);
ff(['-f', 'lavfi', '-i', 'color=c=pink:size=1200x900', '-frames:v', '1', '-update', '1', path.join(MEDIA, 'photo.jpg')]);
fs.writeFileSync(path.join(MEDIA, 'too-big.mp4'), Buffer.alloc(31 * 1048576 + 1, 7));
const M = n => path.join(MEDIA, n);

function startServer(port, dir) {
  let out = '';
  const p = spawn(process.execPath, [path.join(SITE, 'server', 'server.js')], { env: Object.assign({}, process.env, { TENUP_PORT: String(port), TENUP_DATA: dir, TENUP_MASTER_KEY: 'ab'.repeat(32), TENUP_INSECURE: '1', TENUP_SETUP_TOKEN: 'k7Q2', TENUP_SMS_WAIT_MS: '0', TENUP_SMS: 'console' }) });
  p.stdout.on('data', d => out += d); p.stderr.on('data', d => out += d);
  return { p, out: () => out, codes: () => [...out.matchAll(/code: (\d{6})/g)].map(m => m[1]) };
}
function staticServer(port) {
  const types = { html: 'text/html; charset=utf-8', js: 'text/javascript', css: 'text/css', woff2: 'font/woff2', png: 'image/png', jpg: 'image/jpeg', svg: 'image/svg+xml', webmanifest: 'application/manifest+json' };
  return http.createServer((q, s) => {
    let f = path.join(SITE, decodeURIComponent(new URL(q.url, 'http://x').pathname));
    if (f.endsWith('/')) f += 'index.html';
    fs.readFile(f, (e, b) => { if (e) { s.writeHead(404); return s.end(); } s.writeHead(200, { 'Content-Type': types[path.extname(f).slice(1)] || 'application/octet-stream' }); s.end(b); });
  }).listen(port);
}
async function pick(page, clickSel, files) {
  const [fc] = await Promise.all([page.waitForEvent('filechooser', { timeout: 5000 }), page.click(clickSel)]);
  const el = fc.element(), info = await el.evaluate(e => ({ f: e.getAttribute('data-f'), accept: e.accept, capture: e.getAttribute('capture'), multiple: e.multiple }));
  await fc.setFiles(files);
  return info;
}
const idle = page => page.waitForFunction(() => !/正在|Uploading|Reading/.test(document.querySelector('.tu-mgr__status').innerText), null, { timeout: 30000 });

(async () => {
  const browser = await chromium.launch();
  const srv = startServer(18799, path.join(tmp, 'data')), B = 'http://127.0.0.1:18799';
  await sleep(900);
  try {
    /* ---------------- 1. phone, family server ---------------- */
    console.log('\n手机 · 家庭服务器 Phone · family server');
    const phone = await browser.newContext(Object.assign({}, devices['Pixel 7']));
    const pg = await phone.newPage(); const errs = [];
    pg.on('pageerror', e => errs.push(String(e)));
    await pg.goto(B + '/manage.html'); await pg.waitForSelector('#em');
    await pg.fill('#token', 'k7Q2'); await pg.fill('#em', 'mom@example.com'); await pg.fill('#pw', 'a long password 1'); await pg.fill('#pw2', 'a long password 1');
    await pg.fill('#p0', '13800000001'); await pg.fill('#p1', '13800000002'); await pg.click('.lg__go');
    await pg.waitForSelector('#c0'); await pg.fill('#c0', srv.codes()[0]); await pg.fill('#c1', srv.codes()[1]); await pg.click('.lg__go');
    await pg.waitForSelector('.tu-slot');
    await pg.goto(B + '/manage.html?labels'); await pg.waitForSelector('.tu-slot');     /* ?labels shows the screen codes */
    ok('on a phone the camera buttons show', await pg.isVisible('.tu-capbar [data-act="shoot"]') && await pg.isVisible('.tu-capbar [data-act="film"]'));
    await pg.screenshot({ path: path.join(OUT, 'phone-M01.png') });

    let info = await pick(pg, '.tu-capbar [data-act="shoot"]', M('photo.jpg'));
    ok('拍照 opens the camera for a photo (accept image/*, capture=environment)', info.f === 'shoot' && info.accept === 'image/*' && info.capture === 'environment', info);
    await pg.waitForSelector('.tu-slot[data-i="0"] .tu-slot__img img');
    ok('…and the photo becomes the first cover', true);

    const seen = [];
    const watchStatus = setInterval(() => pg.$eval('.tu-mgr__status', e => e.innerText).then(t => { if (/%/.test(t) && seen.indexOf(t) < 0) seen.push(t); }).catch(() => {}), 40);
    info = await pick(pg, '.tu-capbar [data-act="film"]', M('clip.webm'));
    ok('录视频 opens the camera for a video (accept video/*, capture=environment)', info.f === 'film' && info.accept === 'video/*' && info.capture === 'environment', info);
    await pg.waitForSelector('.tu-slot[data-i="1"] .tu-vbadge', { timeout: 30000 }); await idle(pg); clearInterval(watchStatus);
    ok('the recorded video fills the next cover, marked as a video', true);
    ok('upload progress is shown while it goes up', seen.some(t => /上传视频/.test(t)), seen);
    ok('the slot shows a still taken from the video', /^(data:image|api\/file\/)/.test(await pg.$eval('.tu-slot[data-i="1"] .tu-slot__img img', e => e.getAttribute('src'))));

    await pg.click('.tu-slot[data-i="3"] .tu-slot__img');
    await pg.waitForSelector('.tu-sheet [data-act="library"]');
    ok('tapping a cover on a phone opens M04 (camera or library)', await pg.$eval('#tu-tag b', e => e.textContent) === 'M04');
    await pg.screenshot({ path: path.join(OUT, 'phone-M04.png') });
    info = await pick(pg, '.tu-sheet [data-act="library"]', M('IMG_0001.MOV'));
    ok('从相册选 opens the library for photos and videos', info.f === 'cover' && /image\/\*/.test(info.accept) && /video\/\*/.test(info.accept) && !info.capture, info);
    await pg.waitForSelector('.tu-slot[data-i="3"] .tu-vbadge', { timeout: 30000 }).catch(async e => { console.log('    status: ' + await pg.$eval('.tu-mgr__status', x => x.innerText)); await pg.screenshot({ path: path.join(OUT, 'fail-mov.png'), fullPage: true }); throw e; }); await idle(pg);
    const movNote = await pg.$eval('.tu-mgr__status', e => e.innerText.replace(/\n/g, ' '));
    ok('an iPhone .mov goes into the chosen slot', true, movNote);

    await pg.click('.tu-slot[data-i="0"] [data-act="more"]'); await pg.waitForSelector('.tu-sheet');
    ok('the sheet says which year it adds to', /0 岁/.test(await pg.$eval('.tu-sheet .tu-title', e => e.innerText)));
    info = await pick(pg, '.tu-sheet [data-act="film"]', M('clip.webm'));
    ok('录视频 from the sheet adds to that year', info.f === 'film', info);
    await pg.waitForSelector('.tu-slot[data-i="0"] .tu-more__it.is-video', { timeout: 30000 }); await idle(pg);
    ok('…shown with a play mark among the year’s extras', true);
    await pg.click('.tu-slot[data-i="0"] [data-act="more"]'); await pg.click('.tu-sheet [data-act="sheetno"]');
    ok('取消 closes the sheet', !(await pg.$('.tu-sheet')));
    await pg.screenshot({ path: path.join(OUT, 'phone-M01-videos.png'), fullPage: true });

    await pg.waitForFunction(() => /已同步|synced/.test(document.querySelector('.tu-mgr__status').innerText), null, { timeout: 15000 });
    const alb = await pg.evaluate(() => fetch('api/album').then(r => r.json()));
    const ps = alb.album.photos;
    ok('the album on the server refers to the videos as sealed files', /^f:[0-9a-f]{32}$/.test(ps[1].video) && /^f:[0-9a-f]{32}$/.test(ps[3].video) && /^f:[0-9a-f]{32}$/.test(ps[0].moreVideos[0]), { v1: ps[1].video, v3: ps[3].video, m: ps[0].moreVideos });
    ok('…and the still pictures as files too', /^f:/.test(ps[1].src) && /^f:/.test(ps[0].more[0]));
    const vid1 = ps[1].video.slice(2), webm = fs.readFileSync(M('clip.webm'));
    const rng = await pg.evaluate(id => fetch('api/file/' + id, { headers: { Range: 'bytes=100-199' } }).then(r => r.arrayBuffer().then(b => ({ s: r.status, n: b.byteLength, t: r.headers.get('content-type'), first: new Uint8Array(b)[0] }))), vid1);
    ok('the video comes back from the server in byte ranges', rng.s === 206 && rng.n === 100 && rng.t === 'video/webm' && rng.first === webm[100], rng);
    const stored = fs.readdirSync(path.join(tmp, 'data', 'files'));
    ok('on disk the videos are sealed parts, nothing readable', stored.filter(f => /\.seg$/.test(f)).length === 3 && !fs.readFileSync(path.join(tmp, 'data', 'files', vid1 + '.seg')).includes(webm.slice(0, 64)), stored.length);
    ok('no page errors on the phone', errs.length === 0, errs);

    /* ---------------- 2. the TV page plays them ---------------- */
    console.log('\n电视播放页 The TV page');
    const tv = await phone.newPage(); const tvErr = [];
    tv.on('pageerror', e => tvErr.push(String(e)));
    await tv.setViewportSize({ width: 1280, height: 720 });
    await tv.goto(B + '/index.html?mode=watch'); await tv.waitForSelector('.tu-giftscene');
    await tv.keyboard.press('Enter'); await sleep(300); await tv.keyboard.press('Enter');
    await tv.waitForSelector('.tu-gal__card.is-current'); await sleep(400);
    ok('a photo shows as before (no video element)', !(await tv.$('.tu-photo__video')));
    await tv.keyboard.press('ArrowRight');
    await tv.waitForSelector('.tu-gal__card.is-current .tu-photo__video');
    await sleep(1300);
    let st = await tv.evaluate(() => { const v = document.querySelector('.tu-photo__video'); return { paused: v.paused, t: v.currentTime, muted: v.muted, playing: !!v.closest('.is-playing'), duck: TenUp.music.ducked, inline: v.hasAttribute('playsinline') }; });
    ok('the video in front starts by itself', !st.paused && st.t > 0.5 && st.playing, st);
    ok('…inline (playsinline, so iPhone and iPad do not jump to full screen)', st.inline);
    ok('…with sound, and the background music steps back', !st.muted && st.duck === true, st);
    await tv.screenshot({ path: path.join(OUT, 'tv-P03-video.png') });
    const at = await tv.$eval('#yr', e => e.innerText);
    await sleep(2600);
    ok('watch mode waits for the video, then moves on by itself', (await tv.$eval('#yr', e => e.innerText)) !== at && !(await tv.$('.tu-photo__video')));
    ok('…and the music comes back', await tv.evaluate(() => TenUp.music.ducked === false));
    await tv.keyboard.press('ArrowLeft'); await tv.waitForSelector('.tu-photo__video'); await tv.keyboard.press('ArrowLeft');
    ok('moving away stops the video', !(await tv.$('.tu-photo__video')) && await tv.evaluate(() => TenUp.music.ducked === false));
    await tv.keyboard.press('ArrowDown'); await tv.waitForSelector('.tu-stage.is-year, #stage.is-year'); await tv.keyboard.press('ArrowRight');
    await tv.waitForSelector('.tu-gal__card.is-current .tu-photo__video'); await sleep(900);
    ok('a video among one year’s extras plays too (P04)', await tv.$eval('.tu-photo__video', v => !v.paused && v.currentTime > 0.2));
    await tv.keyboard.press('ArrowUp'); await sleep(200);
    ok('leaving the year stops it', !(await tv.$('.tu-photo__video')));
    ok('no page errors on the TV page', tvErr.length === 0, tvErr);
    await phone.close();

    /* ---------------- 3. sound needs a tap ---------------- */
    console.log('\n需要点一下才能有声音 Sound needs a tap');
    /* headless Chromium lets everything autoplay, so the page is given a browser that behaves like Safari or a TV
       without a tap yet: play() with sound is refused (NotAllowedError), silent play is allowed */
    const strict = await chromium.launch();
    const sc = await strict.newContext({ viewport: { width: 1280, height: 720 } });
    await sc.addInitScript(() => {
      const play = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function () {
        if (this.tagName === 'VIDEO' && !this.muted && !window.__tapped) return Promise.reject(new DOMException('needs a tap', 'NotAllowedError'));
        return play.call(this);
      };
      document.addEventListener('pointerdown', () => { window.__tapped = true; }, true);
    });
    const login = await sc.newPage();
    await login.goto(B + '/login.html'); await login.waitForSelector('#em');
    await login.fill('#em', 'mom@example.com'); await login.fill('#pw', 'a long password 1'); await login.click('.lg__go');
    await login.waitForSelector('[data-act=send]'); let n = srv.codes().length; await login.click('[data-act=send]'); await login.waitForSelector('#code');
    await login.fill('#code', srv.codes()[n]); await login.click('.lg__go'); await login.waitForURL(/index\.html|\/$/);
    const sp = await sc.newPage();
    await sp.goto(B + '/index.html?mode=watch&lowfx=1'); await sp.waitForSelector('.tu-giftscene');
    /* no key press on this page: the browser does not allow sound yet */
    await sp.evaluate(() => { const e = new KeyboardEvent('keydown', { keyCode: 13, bubbles: true }); document.dispatchEvent(e); document.dispatchEvent(e); });
    await sp.waitForSelector('.tu-gal__card'); await sp.evaluate(() => { const e = new KeyboardEvent('keydown', { keyCode: 39, bubbles: true }); document.dispatchEvent(e); });
    await sp.waitForSelector('.tu-photo__video'); await sleep(1200);
    st = await sp.evaluate(() => { const v = document.querySelector('.tu-photo__video'); return { paused: v.paused, muted: v.muted, btn: !!document.querySelector('.tu-vsound'), duck: TenUp.music.ducked }; });
    ok('without a tap the video still plays, silently', !st.paused && st.muted, st);
    ok('…and offers “点一下听声音 Tap for sound”', st.btn, st);
    await sp.screenshot({ path: path.join(OUT, 'tv-tap-for-sound.png') });
    await sp.click('.tu-vsound'); await sleep(300);
    st = await sp.evaluate(() => { const v = document.querySelector('.tu-photo__video'); return { muted: v.muted, btn: !!document.querySelector('.tu-vsound'), duck: TenUp.music.ducked }; });
    ok('one tap turns the sound on and steps the music back', !st.muted && !st.btn && st.duck, st);
    await strict.close();

    /* ---------------- 4. no server: kept in this browser ---------------- */
    console.log('\n没有服务器 No server');
    const stat = staticServer(18798);
    const lc = await browser.newContext(Object.assign({}, devices['iPhone 13']));
    const lp = await lc.newPage(); const lErr = [];
    lp.on('pageerror', e => lErr.push(String(e)));
    await lp.goto('http://127.0.0.1:18798/manage.html'); await lp.waitForSelector('.tu-slot');
    ok('the camera buttons show here too (iPhone)', await lp.isVisible('.tu-capbar'));
    await pick(lp, '.tu-capbar [data-act="film"]', M('clip.webm'));
    await lp.waitForSelector('.tu-slot[data-i="0"] .tu-vbadge', { timeout: 20000 }); await idle(lp);
    await pick(lp, '.tu-capbar [data-act="film"]', M('too-big.mp4')); await idle(lp);
    ok('a video over 30 MB is turned away with a reason', /30 MB/.test(await lp.$eval('.tu-mgr__status', e => e.innerText)), await lp.$eval('.tu-mgr__status', e => e.innerText));
    await sleep(500); await lp.reload(); await lp.waitForSelector('.tu-slot[data-i="0"] .tu-vbadge', { timeout: 10000 });
    ok('the video is still there after a reload', true);
    const lt = await lc.newPage(); await lt.setViewportSize({ width: 1280, height: 720 });
    await lt.goto('http://127.0.0.1:18798/index.html?mode=watch'); await lt.waitForSelector('.tu-giftscene');
    await lt.keyboard.press('Enter'); await sleep(300); await lt.keyboard.press('Enter');
    await lt.waitForSelector('.tu-photo__video'); await sleep(1000);
    ok('…and it plays on the album page', await lt.$eval('.tu-photo__video', v => !v.paused && v.currentTime > 0.3 && /^data:video\/webm/.test(v.src)));
    ok('no page errors without the server', lErr.length === 0, lErr);
    await lc.close(); stat.close();

    /* ---------------- 5. a computer ---------------- */
    console.log('\n电脑 A computer');
    const dc = await browser.newContext({ viewport: { width: 1280, height: 900 } }), dp = await dc.newPage();
    const st2 = staticServer(18798); await dp.goto('http://127.0.0.1:18798/manage.html'); await dp.waitForSelector('.tu-slot');
    ok('on a computer the camera buttons are hidden', !(await dp.isVisible('.tu-capbar')));
    info = await pick(dp, '.tu-slot[data-i="2"] .tu-slot__img', M('photo.jpg'));
    ok('…and clicking a cover opens the file chooser straight away, photos and videos', info.f === 'cover' && /video/.test(info.accept) && !(await dp.$('.tu-sheet')), info);
    await dc.close(); st2.close();
  } catch (e) {
    failed++; console.log('  FAIL ' + e.message.split('\n')[0]);
  }
  await browser.close(); srv.p.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\n' + passed + ' passed, ' + failed + ' failed · screenshots: ' + OUT);
  process.exit(failed ? 1 : 0);
})();
