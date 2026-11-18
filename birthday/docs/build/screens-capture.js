/* 重新截取界面总览用的截图。需要 playwright，并且 birthday/ 已在 8080 端口提供（python3 -m http.server 8080）。
   用法：cd birthday/docs/build && mkdir -p screens-raw && node screens-capture.js，然后把 screens-raw/*.png 转成 screens/*.jpg（宽不超过 1600）并复制 marks.json。 */
/* 截每个界面，并记录每个标号区域的位置。输出 screens/<code>.png 和 screens/marks.json */
const { chromium, devices } = require('playwright');
const crypto = require('crypto');
function totp(secret, off) { const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = 0, val = 0; const key = []; for (const ch of secret.replace(/\s/g, '')) { val = (val << 5) | A.indexOf(ch); bits += 5; if (bits >= 8) { key.push((val >>> (bits - 8)) & 255); bits -= 8; } } const c = Buffer.alloc(8); c.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000) + (off || 0))); const h = crypto.createHmac('sha1', Buffer.from(key)).update(c).digest(), o = h[19] & 15; return String((h.readUInt32BE(o) & 0x7fffffff) % 1000000).padStart(6, '0'); }
const CAMCSS = '#cam video{background:repeating-linear-gradient(45deg,#e6d6c6 0 14px,#efe2d4 14px 28px)!important}'; const { spawn } = require('child_process'); const fs = require('fs'), os = require('os'), path = require('path');
const OUT = path.join(__dirname, 'screens-raw'), SITE = 'http://127.0.0.1:8080', marks = {};
async function grab(pg, code, list, opt) {
  opt = opt || {};
  let clip = null;
  if (opt.clip) {      /* one selector, or several: the box around all of them */
    const b = await pg.evaluate(sels => { let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9; sels.forEach(s => { const r = document.querySelector(s).getBoundingClientRect(); x0 = Math.min(x0, r.left); y0 = Math.min(y0, r.top); x1 = Math.max(x1, r.right); y1 = Math.max(y1, r.bottom); }); return { x: x0 + scrollX, y: y0 + scrollY, w: x1 - x0, h: y1 - y0 }; }, [].concat(opt.clip));
    clip = { x: Math.max(0, b.x - 16), y: Math.max(0, b.y - 16), width: b.w + 32, height: b.h + 32 };
  }
  const items = [];
  for (const [sel, zh, en] of list) {
    const r = await pg.$eval(sel, e => { const r = e.getBoundingClientRect(); return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height }; }).catch(() => null);
    if (!r) { console.log('MISSING', code, sel); continue; }
    items.push({ zh, en, x: r.x - (clip ? clip.x : 0), y: r.y - (clip ? clip.y : 0), w: r.w, h: r.h });
  }
  const file = path.join(OUT, code + '.png');
  await pg.screenshot({ path: file, fullPage: !!(opt.full || clip), clip: clip || undefined });
  const size = await pg.evaluate(f => f ? [document.documentElement.scrollWidth, document.documentElement.scrollHeight] : [innerWidth, innerHeight], !!opt.full);
  marks[code] = { w: clip ? clip.width : size[0], h: clip ? clip.height : size[1], items };
  console.log(code, items.length);
}
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } }), pg = await ctx.newPage();
  pg.on('pageerror', e => console.log('PAGEERROR', String(e)));
  /* example content, made in the manager */
  await pg.goto(SITE + '/manage.html'); await pg.waitForTimeout(900);
  await pg.evaluate(() => indexedDB.deleteDatabase('tenup')); await pg.reload(); await pg.waitForTimeout(900);
  await pg.setInputFiles('[data-f=cover]', [path.join(__dirname, 'samples/') + 'p0.jpg', path.join(__dirname, 'samples/') + 'p1.jpg', path.join(__dirname, 'samples/') + 'p2.jpg', path.join(__dirname, 'samples/') + 'p3.jpg']); await pg.waitForTimeout(1800);
  let fc = pg.waitForEvent('filechooser'); await pg.click('.tu-slot[data-i="1"] [data-act=more]'); (await fc).setFiles([path.join(__dirname, 'samples/') + 'p4.jpg', path.join(__dirname, 'samples/') + 'p5.jpg', path.join(__dirname, 'samples/') + 'p2.jpg']); await pg.waitForTimeout(1800);
  fc = pg.waitForEvent('filechooser'); await pg.click('.tu-slot[data-i="2"] .tu-slot__img'); (await fc).setFiles(path.join(__dirname, 'samples/') + 'clip.webm'); await pg.waitForSelector('.tu-slot[data-i="2"] .tu-vbadge'); await pg.waitForTimeout(800);
  fc = pg.waitForEvent('filechooser'); await pg.click('[data-act=avatar][data-who=dad]'); (await fc).setFiles(path.join(__dirname, 'samples/') + 'p5.jpg'); await pg.waitForTimeout(700);
  fc = pg.waitForEvent('filechooser'); await pg.click('[data-act=avatar][data-who=mom]'); (await fc).setFiles(path.join(__dirname, 'samples/') + 'p3.jpg'); await pg.waitForTimeout(700);
  await pg.fill('[data-n=zh]', '朵朵'); await pg.press('[data-n=zh]', 'Tab'); await pg.fill('[data-n=en]', 'Dora'); await pg.press('[data-n=en]', 'Tab');
  await pg.click('.tu-slot[data-i="1"] [data-act=note][data-j="-1"]'); await pg.waitForSelector('.tu-dlg');
  await pg.fill('[data-d=text]', '第一次自己走到妈妈怀里');
  const pad = await pg.$('.tu-pad'), r = await pad.boundingBox();
  const stroke = async pts => { await pg.mouse.move(r.x + pts[0][0] * r.width, r.y + pts[0][1] * r.height); await pg.mouse.down(); for (const p of pts.slice(1)) await pg.mouse.move(r.x + p[0] * r.width, r.y + p[1] * r.height, { steps: 6 }); await pg.mouse.up(); };
  await stroke([[.1, .35], [.16, .7], [.22, .45], [.28, .7], [.34, .35]]); await stroke([[.44, .3], [.44, .72]]); await stroke([[.54, .5], [.62, .35], [.7, .5], [.62, .7], [.54, .5]]); await stroke([[.8, .3], [.86, .7], [.92, .3]]);
  fc = pg.waitForEvent('filechooser'); await pg.click('[data-act=noteimg]'); (await fc).setFiles(path.join(__dirname, 'samples/') + 'drawing.jpg'); await pg.waitForTimeout(800);
  await grab(pg, 'M02', [['.tu-dlg__head', '照片与标题', 'Photo and title'], ['.tu-dlg__box > label', '写一句话', 'One line'], ['.tu-pad', '手写板', 'Handwriting pad'], ['.tu-dlg__box > .tu-slot__row', '撤销一笔 / 清空', 'Undo / clear'], ['.tu-dlg__img', '配一张图', 'A small picture'], ['.tu-dlg__foot', '保存 / 取消', 'Save / cancel']]);
  await pg.click('[data-act=notesave]'); await pg.waitForTimeout(500);
  await pg.click('.tu-slot[data-i="1"] .tu-more__pic[data-j="1"]'); await pg.waitForSelector('.tu-dlg'); await pg.fill('[data-d=text]', '在公园里追鸽子'); await pg.click('[data-act=notesave]'); await pg.waitForTimeout(400);
  await pg.selectOption('[data-m=album]', 'builtin:lullaby'); await pg.click('[data-act=hush]'); await pg.waitForTimeout(400);
  await pg.evaluate(() => { document.activeElement && document.activeElement.blur(); scrollTo(0, 0); });
  await grab(pg, 'M01', [['.tu-mgr__title', '标题', 'Title'], ['.tu-mgr__status', '保存状态', 'Save status'], ['.tu-mgr__names > label:nth-child(1)', '中文名字', 'Her name in Chinese'], ['.tu-mgr__names > label:nth-child(2)', '英文名字', 'Her name in English'], ['.tu-avatars', '三个人的头像', 'Portraits'],
    ['.tu-musicbox', '背景音乐', 'Background music'], ['.tu-drop', '封面拖放区', 'Drop zone for covers'], ['.tu-slot[data-i="1"] .tu-slot__age', '年龄标签', 'Age label'], ['.tu-slot[data-i="1"] .tu-slot__img', '封面照片', 'Cover photo'],
    ['.tu-slot[data-i="1"] [data-k=zh]', '中文说明', 'Chinese caption'], ['.tu-slot[data-i="1"] [data-k=en]', '英文说明', 'English caption'], ['.tu-slot[data-i="1"] .tu-slot__row', '换封面 / 寄语 / 移除', 'Replace / note / remove'],
    ['.tu-slot[data-i="1"] .tu-more', '这一年的更多照片', 'More from this year'], ['.tu-slot[data-i="2"]', '一个年龄格（共 11 格）', 'One age slot (11 in all)'], ['.tu-slot[data-i="2"] .tu-vbadge', '视频封面的标记', 'A video cover'], ['.tu-mgr__tools', '去播放 / 导出 / 导入 / 清空', 'Play / export / import / clear'], ['.tu-mgr__help', '保存说明', 'Where photos are kept']], { full: true });

  /* the player, at TV size */
  await pg.setViewportSize({ width: 1920, height: 1080 });
  await pg.goto(SITE + '/index.html'); await pg.waitForTimeout(1300);
  await grab(pg, 'P01', [['.x-head .tu-title', '称呼', 'Her name'], ['.x-head .tu-hero', '大标题', 'Headline'], ['.x-mascot', '小兔子 Mochi', 'Mochi the bunny'], ['.x-ask', '提问', 'The question'], ['.tu-mode[data-mode=interactive]', '互动模式', 'Interactive'], ['.tu-mode[data-mode=watch]', '观看模式', 'Just watch'], ['.x-manage', '整理照片入口', 'Manage photos'], ['.x-foot', '按键提示', 'Key hints']]);
  await pg.evaluate(() => { window.TenUpSense.start = () => Promise.resolve(); window.TenUpSense.arm = () => {}; });
  await pg.keyboard.press('Enter'); await pg.addStyleTag({ content: CAMCSS }); await pg.waitForTimeout(2600);
  await grab(pg, 'P02', [['.x-col .tu-hero', '核心信息一：礼物', 'Message one: the gift'], ['.x-col .tu-body', '说明', 'Line under it'], ['.x-col .tu-btn', '主按钮', 'Main button'], ['.tu-giftscene', '3D 礼物盒', '3D gift box'], ['#cues', '动作提示条', 'Gesture cues']]);
  await pg.keyboard.press('1'); await pg.waitForTimeout(3400);
  marks.P02b = null;
  await grab(pg, 'P02B', [['.x-col .tu-body', '打开后的说明', 'Line after opening'], ['.x-col .tu-btn', '翻开相册', 'Open the album'], ['.tu-gift__baby', '探出头的小兔子', 'The bunny peeking out'], ['#cues', '动作提示条', 'Gesture cues']]);
  await pg.keyboard.press('Enter'); await pg.waitForTimeout(1500); await pg.keyboard.press('ArrowRight'); await pg.waitForTimeout(3000);
  await grab(pg, 'P03', [['.x-head .tu-title', '标题', 'Title'], ['#yr', '这一年三个人的年龄', 'Our ages that year'], ['.x-corner', '小兔子', 'The bunny'], ['.tu-gal__card.is-current', '当前照片（相框）', 'Photo in front'], ['#note .tu-note__text', '寄语：一句话', 'Note: one line'], ['#note .tu-ink', '寄语：手写', 'Note: handwriting'], ['#note .tu-note__pic', '寄语：配图', 'Note: picture'],
    ['.tu-gal__card:nth-child(3)', '两侧的照片', 'Photos at the sides'], ['#rail', '年龄时间轴', 'Age timeline'], ['#cues', '动作提示条', 'Gesture cues'], ['.x-foot', '按键提示', 'Key hints'], ['#cam', '摄像头小窗（互动模式下显示孩子自己）', 'Camera bubble (shows her, in interactive mode)']]);
  await pg.keyboard.press('ArrowRight'); await pg.waitForSelector('.tu-photo__video'); await pg.waitForTimeout(1800);
  await grab(pg, 'P03B', [['.tu-gal__card.is-current .tu-photo__video', '视频：转到前面就自动播放', 'A video plays by itself when it comes to the front'], ['.tu-gal__card.is-current .tu-photo__cap', '说明与年龄', 'Caption and age'], ['.tu-gal__card:nth-child(4)', '下一张', 'The next one']]);
  await pg.keyboard.press('ArrowLeft'); await pg.waitForTimeout(1500);
  await pg.keyboard.press('ArrowDown'); await pg.waitForTimeout(1500); await pg.keyboard.press('ArrowRight'); await pg.keyboard.press('ArrowRight'); await pg.waitForTimeout(2200);
  await grab(pg, 'P04', [['.x-head .tu-title', '标题', 'Title'], ['#yr', '说明与第几张', 'Caption and photo count'], ['.x-yearroom', '当年的"房间"背景', 'The year’s room'], ['.tu-gal__card.is-current', '当前照片', 'Photo in front'], ['#note .tu-note', '这张照片的寄语', 'This photo’s note'], ['#cues', '动作提示：挥手 / 握拳', 'Cues: swipe / fist'], ['.x-foot', '按键提示', 'Key hints']]);
  await pg.keyboard.press('ArrowUp'); await pg.waitForTimeout(800); await pg.keyboard.press('Enter'); await pg.waitForTimeout(1600);
  await grab(pg, 'P05', [['#view > .x-center:nth-child(1)', '核心信息二：年龄', 'Message two: our ages'], ['#view > .x-center:nth-child(2)', '副标题', 'Line under it'], ['.tu-agecard:nth-child(1)', '你的卡片', 'Her card'], ['.tu-agecard:nth-child(2)', '爸爸的卡片', 'Dad’s card'], ['.tu-agecard:nth-child(3)', '妈妈的卡片', 'Mom’s card'], ['.tu-agecard:nth-child(2) .tu-agecard__chip', '头像', 'Portrait'], ['.tu-agecard__n small', '+1 徽章', 'The +1 badge'], ['#cues', '动作提示条', 'Gesture cues']]);
  await pg.keyboard.press('Enter'); await pg.waitForTimeout(3600);
  await grab(pg, 'P06', [['#view > .x:nth-child(1)', '核心信息三：陪伴', 'Message three: time together'], ['.tu-together__row:nth-child(1)', '0–10 岁', 'Ages 0–10'], ['.tu-together__row:nth-child(2)', '10–20 岁', 'Ages 10–20'], ['.tu-together__row:nth-child(3)', '上大学、工作以后', 'University, then work'], ['.x-close', '结尾的一句话', 'Closing line'], ['#cues', '动作提示条', 'Gesture cues'], ['.x-foot', '按键提示', 'Key hints']]);
  await pg.keyboard.press('Enter'); await pg.waitForTimeout(1500);
  await grab(pg, 'P07', [['.x-col .tu-hero', '标题', 'Title'], ['.x-col .tu-body', '说明', 'Line under it'], ['.x-col .tu-btn', '吹蜡烛按钮', 'Blow button'], ['.tu-cake', '蛋糕与十根蜡烛', 'Cake and ten candles'], ['.x-cakepal', '小兔子', 'The bunny'], ['#cues', '动作提示：吹口气', 'Cue: blow']]);
  await pg.keyboard.press('8'); await pg.waitForTimeout(4200);
  await grab(pg, 'P08', [['.x-col .tu-hero', '生日快乐', 'Happy birthday'], ['.x-col .tu-title', '爸爸妈妈的话', 'Words from Mom and Dad'], ['.x-col .tu-btn', '去看年岁的名字', 'On to the names'], ['.tu-cake', '吹灭的蜡烛', 'Candles out'], ['#cues', '动作提示条', 'Gesture cues']]);
  await pg.keyboard.press('Enter'); await pg.waitForTimeout(1800);
  for (let i = 0; i < 5; i++) await pg.keyboard.press('ArrowRight'); await pg.waitForTimeout(1500);      /* from the third day on to ten: you are here */
  await grab(pg, 'P09', [['.x-head .tu-title', '标题', 'Title'], ['.x-head .tu-body', '说明', 'Line under it'], ['.tu-namecard__pic', '图示与年龄', 'Picture and age'], ['.tu-namecard__tags', '标签', 'Tags'], ['.tu-namecard__name', '名字、拼音、英文名', 'Name, pinyin, English'], ['.tu-namecard__mean', '含义', 'Meaning'], ['.tu-namecard__txt > .tu-body', '出处', 'Source'], ['#rail', '年龄时间轴', 'Age timeline'], ['#cues', '动作提示条', 'Gesture cues'], ['.x-foot', '按键提示', 'Key hints']]);
  for (let i = 0; i < 5; i++) await pg.keyboard.press('ArrowRight'); await pg.waitForTimeout(1500);
  await pg.screenshot({ path: path.join(OUT, 'P09-20.png') });

  /* on a phone: the camera buttons (M01) and camera-or-library (M04) */
  const pc = await b.newContext(Object.assign({}, devices['Pixel 7'], { deviceScaleFactor: 2 })), pp = await pc.newPage();
  await pp.goto(SITE + '/manage.html'); await pp.waitForSelector('.tu-capbar');
  await pp.evaluate(() => document.querySelector('.tu-drop').scrollIntoView());
  await grab(pp, 'M01B', [['.tu-drop', '拖放或选择', 'Drop or choose'], ['.tu-capbar [data-act=shoot]', '拍照：直接打开相机', 'Take a photo: opens the camera'], ['.tu-capbar [data-act=film]', '录视频：直接打开相机录像', 'Record a video: opens the camera'], ['.tu-capbar [data-act=library]', '从相册选照片或视频', 'Photos and videos from the library']], { clip: ['.tu-drop', '.tu-capbar', '.tu-slot[data-i="0"] .tu-slot__img'] });
  await pp.click('.tu-slot[data-i="3"] .tu-slot__img'); await pp.waitForSelector('.tu-sheet'); await pp.waitForTimeout(400);
  await grab(pp, 'M04', [['.tu-sheet__box > .tu-bi', '加到哪一格', 'Where it goes'], ['.tu-sheet [data-act=shoot]', '拍照', 'Take a photo'], ['.tu-sheet [data-act=film]', '录视频', 'Record a video'], ['.tu-sheet [data-act=library]', '从相册选', 'Photos and videos'], ['.tu-sheet [data-act=sheetno]', '取消', 'Cancel']]);
  await b.close();

  /* login and account: these need the album server */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenup-shots-')); let out = '';
  const srv = spawn(process.execPath, ['/home/user/weber-hello-world/birthday/server/server.js'], { env: Object.assign({}, process.env, { TENUP_PORT: '18795', TENUP_DATA: dir, TENUP_MASTER_KEY: 'cd'.repeat(32), TENUP_INSECURE: '1', TENUP_SETUP_TOKEN: 'k7Q2', TENUP_SMS_WAIT_MS: '0' }) });
  srv.stdout.on('data', d => out += d); await new Promise(r => setTimeout(r, 900));
  const codes = () => [...out.matchAll(/code: (\d{6})/g)].map(m => m[1]), B = 'http://127.0.0.1:18795';
  const b2 = await chromium.launch(), lp = await (await b2.newContext({ viewport: { width: 1000, height: 1040 } })).newPage();
  await lp.goto(B + '/manage.html'); await lp.waitForSelector('#token');
  await lp.fill('#token', 'k7Q2'); await lp.fill('#em', 'mom@example.com'); await lp.fill('#pw', 'a long password 1'); await lp.fill('#pw2', 'a long password 1'); await lp.fill('#p0', '13800000001'); await lp.fill('#p1', '13800000002');
  await grab(lp, 'L01', [['.lg .tu-mascot', '小兔子', 'The bunny'], ['.lg__card > .tu-bi:nth-child(1)', '标题', 'Title'], ['.lg__card > .tu-bi:nth-child(2)', '规则说明', 'The rules'], ['label:has(#token)', '设置口令', 'Setup token'], ['label:has(#em)', '你的邮箱', 'Your e-mail'], ['label:has(#pw)', '密码', 'Password'], ['label:has(#pw2)', '再输一次密码', 'Password again'], ['label:has(#p0)', '手机号一', 'Phone 1'], ['label:has(#p1)', '手机号二', 'Phone 2'], ['.lg__go', '发送验证码', 'Send the codes']]);
  await lp.click('.lg__go'); await lp.waitForSelector('#c0');
  await grab(lp, 'L02', [['.lg__card > .tu-bi:nth-child(1)', '标题', 'Title'], ['label:has(#c0)', '手机号一的验证码', 'Code from phone 1'], ['label:has(#c1)', '手机号二的验证码', 'Code from phone 2'], ['.lg__go', '完成设置', 'Finish setup']]);
  await lp.fill('#c0', codes()[0]); await lp.fill('#c1', codes()[1]); await lp.click('.lg__go'); await lp.waitForSelector('.tu-acct__row'); await lp.waitForTimeout(800);
  await lp.evaluate(() => scrollTo(0, document.body.scrollHeight)); await lp.waitForTimeout(300);
  await grab(lp, 'M03', [['.tu-acct__head', '标题 / 管理员设置入口 / 退出这台设备', 'Title / admin settings / log out'], ['.tu-acct__me', '当前账号', 'Signed in as'], ['.tu-acct__grid > div:nth-child(1)', '可信设备列表', 'Trusted devices'], ['.tu-acct__grid > div:nth-child(2) .tu-acct__row:nth-of-type(2)', '手机号与"更换"', 'Phones and Change'], ['.tu-acct__note', '更换规则', 'How changing works']], { clip: '.tu-acct' });

  /* admin: A03 set up, A02 settings, A01 the three checks */
  await lp.goto(B + '/admin.html'); await lp.waitForSelector('[data-act=esend]');
  let n = codes().length; await lp.click('[data-act=esend][data-i="0"]'); await lp.waitForSelector('#c0');
  await grab(lp, 'A03', [['.lg__card > .tu-bi:nth-child(1)', '标题', 'Title'], ['.lg__card > .tu-bi:nth-child(2)', '说明', 'What it does'], ['.lg__row', '选一个手机号收验证码', 'Choose a phone'], ['label:has(#c0)', '验证码', 'Code'], ['.lg__go', '下一步', 'Next'], ['.lg__back', '取消', 'Cancel']]);
  await lp.fill('#c0', codes()[n]); await lp.click('.lg__go'); await lp.waitForSelector('#key');
  const secret = (await lp.$eval('#key', e => e.textContent)).replace(/\s/g, '');
  await lp.fill('#apw', 'admin password 2026!'); await lp.fill('#apw2', 'admin password 2026!');
  await grab(lp, 'A03B', [['.ad__steps', '三步说明', 'Three steps'], ['.ad__qrimg', '二维码', 'QR code'], ['.ad__key', '密钥与复制', 'Key and copy'], ['label:has(#apw)', '管理员密码', 'Admin password'], ['label:has(#apw2)', '再输一次', 'Again'], ['label:has(#totp)', '验证器上的 6 位数', 'Code from the app'], ['.lg__go', '完成设置', 'Finish']]);
  await lp.fill('#totp', totp(secret)); await lp.click('.lg__go'); await lp.waitForSelector('.ad__pols');
  await lp.fill('#ne', 'dad@example.com'); await lp.fill('#nn', '爸爸'); await lp.fill('#np', 'dad password 1'); await lp.fill('#np2', 'dad password 1'); await lp.click('.ad__addgo'); await lp.waitForTimeout(700);
  await lp.evaluate(() => { const t = document.querySelector('.lg__ok'); if (t) t.remove(); scrollTo(0, 0); });
  await grab(lp, 'A02', [['.ad__head > div:first-child', '标题与管理员信息', 'Title and admin info'], ['.ad__acts', '回到照片管理 / 退出管理', 'Back / leave admin'], ['.ad__pol[data-p=off]', '短信：关闭', 'SMS: off'], ['.ad__pol[data-p=new-device]', '短信：新设备或换国家（默认）', 'SMS: new device or country (default)'], ['.ad__pol[data-p=always]', '短信：每次登录', 'SMS: every login'], ['.ad__card:nth-of-type(1) .ad__note', '始终需要短信的事', 'Always needs a text'],
    ['.ad__acct:nth-child(1)', '账号一行', 'One account'], ['.ad__acct:nth-child(1) .ad__row-acts', '改邮箱 / 改密码 / 移除', 'E-mail / password / remove'], ['.ad__add', '添加账号', 'Add an account'], ['.ad__card:nth-of-type(3)', '重新设置管理员', 'Replace the admin'], ['.ad__log', '操作记录', 'Activity']], { full: true });
  await lp.click('[data-act=alogout]'); await lp.waitForURL(/manage/);
  await lp.goto(B + '/admin.html'); await lp.waitForSelector('#apw');
  await lp.fill('#apw', 'admin password 2026!'); await lp.fill('#totp', totp(secret, 1));
  await grab(lp, 'A01', [['.lg__card > .tu-bi:nth-child(1)', '标题', 'Title'], ['.lg__card > .tu-bi:nth-child(2)', '三样都要', 'All three'], ['label:has(#apw)', '管理员密码', 'Admin password'], ['label:has(#totp)', '验证器动态码', 'Authenticator code'], ['.lg__go', '下一步：短信', 'Next: text message'], ['.lg__back', '回到照片管理', 'Back to photos']]);
  await lp.click('.lg__go'); await lp.waitForSelector('[data-act=asend]'); n = codes().length; await lp.click('[data-act=asend][data-i="1"]'); await lp.waitForSelector('#code');
  await grab(lp, 'A01B', [['.lg__row', '选一个手机号', 'Choose a phone'], ['label:has(#code)', '短信验证码', 'Text-message code'], ['.lg__go', '进入管理员设置', 'Open admin settings'], ['.lg__ok', '已发送提示', 'Sent notice']]);
  const np = await (await b2.newContext({ viewport: { width: 1000, height: 900 } })).newPage();
  await np.goto(B + '/index.html'); await np.waitForSelector('#pw'); await np.fill('#em', 'mom@example.com'); await np.fill('#pw', 'wrong password!!'); await np.click('.lg__go'); await np.waitForSelector('.lg__msg');
  await grab(np, 'L03', [['.lg__card > .tu-bi:nth-child(1)', '标题', 'Title'], ['label:has(#em)', '邮箱', 'E-mail'], ['label:has(#pw)', '密码', 'Password'], ['.lg__go', '进入相册', 'Open the album'], ['.lg__msg', '出错提示', 'Error message'], ['.lg .tu-mascot', '小兔子（难过）', 'The bunny, sad']]);
  await np.fill('#pw', 'a long password 1'); await np.click('.lg__go'); await np.waitForSelector('[data-act=send]'); await np.click('[data-act=send][data-i="0"]'); await np.waitForSelector('#code');
  await grab(np, 'L04', [['.lg__card > .tu-bi:nth-child(1)', '标题', 'Title'], ['.lg__card > .tu-bi:nth-child(2)', '为什么要验证', 'Why it asks'], ['.lg__row', '选择接收的手机号', 'Choose a phone'], ['label:has(#code)', '验证码', 'Code'], ['.lg__go', '确认', 'Confirm'], ['.lg__ok', '已发送提示', 'Sent notice']]);
  await b2.close(); srv.kill(); fs.rmSync(dir, { recursive: true, force: true });
  delete marks.P02b;
  fs.writeFileSync(path.join(OUT, 'marks.json'), JSON.stringify(marks));
})().catch(e => { console.error(e); process.exit(1); });
