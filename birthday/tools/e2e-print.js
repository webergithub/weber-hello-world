/* 打印与导出（M05）的浏览器测试 Browser test for printing and exporting the album
   用法 Usage:  node birthday/tools/e2e-print.js
   需要 Needs:  playwright (with Chromium) and ffmpeg (for a test photo and video).
   走一遍 It walks through: 照片管理里放进照片、视频和寄语 → 打印预览的页数和内容 → 生成的 PDF（A4 横向 / 纵向、Letter）
   → 下载 ZIP 并逐个核对里面的文件 → 家庭服务器上没登录打不开打印页、登录后能打包服务器上的照片和视频。 */
'use strict';
const { chromium } = require('playwright');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), zlib = require('zlib');

const SITE = path.join(__dirname, '..'), tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tenup-print-')), M = n => path.join(tmp, n);
let passed = 0, failed = 0;
function ok(name, cond, extra) { if (cond) { passed++; console.log('  ok   ' + name); } else { failed++; console.log('  FAIL ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); } }
const sleep = ms => new Promise(r => setTimeout(r, ms));
function ff(args) { execFileSync('ffmpeg', ['-loglevel', 'error', '-y'].concat(args)); }
ff(['-f', 'lavfi', '-i', 'color=c=pink:size=1200x900', '-frames:v', '1', '-update', '1', M('photo.jpg')]);
ff(['-f', 'lavfi', '-i', 'color=c=skyblue:size=900x1200', '-frames:v', '1', '-update', '1', M('tall.jpg')]);
ff(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=2', '-c:v', 'libvpx', '-b:v', '300k', M('clip.webm')]);

/* a tiny ZIP reader for the central directory (stored entries only, which is what the page writes) */
function readZip(buf) {
  let e = buf.length - 22; while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  const n = buf.readUInt16LE(e + 10), out = []; let p = buf.readUInt32LE(e + 16);
  for (let i = 0; i < n; i++) {
    const flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10), crc = buf.readUInt32LE(p + 16), size = buf.readUInt32LE(p + 20), nl = buf.readUInt16LE(p + 28), el = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nl).toString('utf8'), lnl = buf.readUInt16LE(off + 26), lel = buf.readUInt16LE(off + 28), data = buf.slice(off + 30 + lnl + lel, off + 30 + lnl + lel + size);
    out.push({ name, utf8: !!(flags & 0x800), method, crcOk: zlib.crc32 ? zlib.crc32(data) === crc : true, data });
    p += 46 + nl + el + cl;
  }
  return out;
}
const pdfPages = b => (b.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
function staticServer(port) {
  const types = { html: 'text/html; charset=utf-8', js: 'text/javascript', css: 'text/css', woff2: 'font/woff2', png: 'image/png', jpg: 'image/jpeg' };
  return http.createServer((q, s) => {
    let f = path.join(SITE, decodeURIComponent(new URL(q.url, 'http://x').pathname)); if (f.endsWith('/')) f += 'index.html';
    fs.readFile(f, (e, b) => { if (e) { s.writeHead(404); return s.end(); } s.writeHead(200, { 'Content-Type': types[path.extname(f).slice(1)] || 'application/octet-stream' }); s.end(b); });
  }).listen(port);
}
async function pick(page, sel, files) { const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click(sel)]); await fc.setFiles(files); }
const idle = page => page.waitForFunction(() => !/正在|Uploading|Reading/.test(document.querySelector('.tu-mgr__status').innerText), null, { timeout: 30000 });

(async () => {
  const b = await chromium.launch(), stat = staticServer(18801), S = 'http://127.0.0.1:18801';
  let srv = null;
  try {
    console.log('\n没有服务器 No server');
    const ctx = await b.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true }), pg = await ctx.newPage(), errs = [];
    pg.on('pageerror', e => errs.push(String(e)));
    await pg.goto(S + '/manage.html'); await pg.waitForSelector('.tu-slot');
    ok('照片管理里有“打印与导出”', await pg.$eval('.tu-mgr__tools a[href="print.html"]', e => e.innerText.includes('打印与导出')));
    await pick(pg, '.tu-slot[data-i="0"] .tu-slot__img', M('photo.jpg')); await idle(pg);
    await pick(pg, '.tu-slot[data-i="2"] .tu-slot__img', M('clip.webm')); await pg.waitForSelector('.tu-slot[data-i="2"] .tu-vbadge'); await idle(pg);
    await pick(pg, '.tu-slot[data-i="0"] [data-act=more]', [M('tall.jpg'), M('photo.jpg'), M('tall.jpg'), M('photo.jpg'), M('tall.jpg')]); await idle(pg);
    await pg.click('.tu-slot[data-i="0"] [data-act=note][data-j="-1"]'); await pg.fill('[data-d=text]', '第一次笑出声');
    const pad = await (await pg.$('.tu-pad')).boundingBox(); await pg.mouse.move(pad.x + 30, pad.y + 30); await pg.mouse.down(); await pg.mouse.move(pad.x + 200, pad.y + 90, { steps: 5 }); await pg.mouse.up();
    await pg.click('[data-act=notesave]'); await sleep(600);
    await pg.click('.tu-mgr__tools a[href="print.html"]'); await pg.waitForSelector('.pg--end'); await sleep(800);
    const kinds = await pg.$$eval('.pg', p => p.map(x => x.className.replace('pg pg--', '')));
    ok('封面 + 0 岁 + 两页更多照片（5 张）+ 2 岁 + 结尾，空的年龄跳过', kinds.join(',') === 'cover,age,more,more,age,end', kinds);
    ok('页数显示在顶部', /共 6 页/.test(await pg.$eval('.pr-count', e => e.textContent)));
    ok('寄语：一句话和手写都在 0 岁那页', await pg.$eval('.pg--age', e => e.innerText.includes('第一次笑出声') && !!e.querySelector('.pr-note__ink path')));
    ok('视频那页标着“视频”', await pg.$$eval('.pg--age', p => !!p[1].querySelector('.pr-vid')));
    ok('“这一年”三个人的年龄印在每岁那页', await pg.$$eval('.pg--age', p => p[1].innerText.includes('你 2 岁 · 爸爸 2 岁 · 妈妈 3 岁')));
    await pg.emulateMedia({ media: 'print' });
    let pdf = await pg.pdf({ preferCSSPageSize: true, printBackground: true });
    ok('PDF：A4 横向 6 页，没有多出的空白页', pdfPages(pdf) === 6 && /MediaBox\s*\[0 0 841\.9\d* 59[45]\.\d*\]/.test(pdf.toString('latin1')), pdfPages(pdf));
    await pg.emulateMedia({ media: 'screen' }); await pg.selectOption('[data-o=portrait]', 'true'); await pg.selectOption('[data-o=paper]', 'letter'); await sleep(400);
    await pg.emulateMedia({ media: 'print' }); pdf = await pg.pdf({ preferCSSPageSize: true, printBackground: true });
    ok('PDF：Letter 纵向', pdfPages(pdf) === 6 && /MediaBox\s*\[0 0 612 792\]/.test(pdf.toString('latin1')));
    await pg.emulateMedia({ media: 'screen' });
    await pg.click('label:has([data-o=more])'); await sleep(300);
    ok('不打印更多照片时只剩 4 页', (await pg.$$('.pg')).length === 4);
    await pg.click('label:has([data-o=skipEmpty])'); await sleep(300);
    ok('不跳过空的年龄时 0–10 岁都有一页（共 13 页）', (await pg.$$('.pg')).length === 13);
    await pg.reload(); await pg.waitForSelector('.pg--end');
    ok('选项会记住', await pg.$eval('[data-o=paper]', e => e.value) === 'letter' && (await pg.$$('.pg')).length === 13);
    const [dl] = await Promise.all([pg.waitForEvent('download', { timeout: 30000 }), pg.click('[data-a=zip]')]);
    const zip = readZip(fs.readFileSync(await dl.path())), names = zip.map(z => z.name);
    ok('ZIP 文件名用英文，所有浏览器都保得住', /^[\w-]+-growing-up-album\.zip$/.test(dl.suggestedFilename()), dl.suggestedFilename());
    ok('ZIP：说明 + 0 岁封面和 5 张更多照片 + 手写寄语 + 2 岁视频和截图，共 10 个文件', zip.length === 10, names);
    ok('文件名是 UTF-8，中文文件夹不乱码', zip.every(z => z.utf8) && names.some(n => /\/00岁 age 0 · 出生啦\/1 封面\.jpg$/.test(n)));
    ok('视频原样放进去，一个字节都不差', zip.some(z => /02岁.*1 封面（视频）\.webm$/.test(z.name) && z.data.equals(fs.readFileSync(M('clip.webm')))));
    ok('手写寄语存成可以单独打开的 SVG', zip.some(z => /1 封面-手写寄语\.svg$/.test(z.name) && z.data.toString().startsWith('<?xml') && z.data.toString().includes('<path')));
    const about = zip.find(z => /相册说明/.test(z.name));
    ok('相册说明里有每岁的说明和寄语', about && about.data.toString().includes('第一次笑出声') && about.data.toString().includes('2 岁 · age 2'));
    ok('每个文件都没坏（CRC 校验）', zip.every(z => z.crcOk && z.method === 0));
    ok('没有页面错误', errs.length === 0, errs);
    await ctx.close();

    console.log('\n家庭服务器 Family server');
    srv = spawn(process.execPath, [path.join(SITE, 'server', 'server.js')], { env: Object.assign({}, process.env, { TENUP_PORT: '18802', TENUP_DATA: M('data'), TENUP_MASTER_KEY: 'ef'.repeat(32), TENUP_INSECURE: '1', TENUP_SETUP_TOKEN: 'k7Q2', TENUP_SMS_WAIT_MS: '0', TENUP_SMS: 'console' }) });
    let out = ''; srv.stdout.on('data', d => out += d); await sleep(900);
    const B = 'http://127.0.0.1:18802', codes = () => [...out.matchAll(/code: (\d{6})/g)].map(m => m[1]);
    const r = await fetch(B + '/print.html', { redirect: 'manual' });
    ok('没登录打不开打印页', r.status === 302 && /login\.html/.test(r.headers.get('location')));
    const c2 = await b.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true }), p2 = await c2.newPage();
    await p2.goto(B + '/manage.html'); await p2.waitForSelector('#em');
    await p2.fill('#token', 'k7Q2'); await p2.fill('#em', 'mom@example.com'); await p2.fill('#pw', 'a long password 1'); await p2.fill('#pw2', 'a long password 1'); await p2.fill('#p0', '13800000001'); await p2.fill('#p1', '13800000002');
    await p2.click('.lg__go'); await p2.waitForSelector('#c0'); await sleep(300); await p2.fill('#c0', codes()[0]); await p2.fill('#c1', codes()[1]); await p2.click('.lg__go'); await p2.waitForSelector('.tu-slot');
    await pick(p2, '.tu-slot[data-i="5"] .tu-slot__img', M('clip.webm')); await p2.waitForSelector('.tu-slot[data-i="5"] .tu-vbadge', { timeout: 30000 }); await idle(p2);
    await p2.waitForFunction(() => /已同步|synced/.test(document.querySelector('.tu-mgr__status').innerText), null, { timeout: 15000 });
    await p2.goto(B + '/print.html'); await p2.waitForSelector('.pg--end'); await sleep(500);
    ok('登录后打印页读的是服务器上的相册', (await p2.$$('.pg--age')).length === 1 && await p2.$eval('.pg--age', e => e.innerText.includes('5')));
    const [d2] = await Promise.all([p2.waitForEvent('download', { timeout: 30000 }), p2.click('[data-a=zip]')]);
    const z2 = readZip(fs.readFileSync(await d2.path()));
    ok('ZIP 里是从服务器取回、解密后的原视频', z2.some(z => /05岁.*（视频）\.webm$/.test(z.name) && z.data.equals(fs.readFileSync(M('clip.webm')))), z2.map(z => z.name));
    await c2.close();
  } catch (e) { failed++; console.log('  FAIL ' + e.message.split('\n')[0]); }
  await b.close(); stat.close(); if (srv) srv.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
