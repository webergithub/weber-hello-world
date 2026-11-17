/* 生成界面编号总览： node birthday/docs/build/screens-page.js  →  birthday/docs/screens.html（单个文件，截图内嵌）
   截图和每个标号区域的位置来自 screens/（由 screens-capture.js 截取）。 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const here = __dirname, marks = JSON.parse(fs.readFileSync(path.join(here, 'screens', 'marks.json'), 'utf8'));
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const img = f => 'data:image/jpeg;base64,' + fs.readFileSync(path.join(here, 'screens', f)).toString('base64');

/* the names of the ages, read from the site's own code so the table never drifts from it */
const box = { window: {}, document: { readyState: 'complete', getElementById: () => 1, body: null }, location: { search: '', hash: '' } };
vm.runInNewContext(fs.readFileSync(path.join(here, '..', '..', 'js', 'tenup.js'), 'utf8'), box);
const NAMES = box.window.TenUp.ageNames;

const GROUPS = [
  { id: 'P', zh: '播放（电视大屏）', en: 'The album on the TV', note: '打开 index.html。截图按 1920 × 1080 拍摄，照片是示例色块。', screens: [
    { code: 'P01', zh: '开场', en: 'Opening', shots: ['P01'], reach: '打开网站后的第一屏。', job: '叫她的名字，说生日快乐，问她要不要用摄像头一起玩。' },
    { code: 'P02', zh: '礼物', en: 'The gift', shots: ['P02', 'P02B'], states: ['打开前', '打开后'], reach: '在 P01 选好模式之后。', job: '核心信息一：你是上天送给爸爸妈妈的礼物。礼物盒打开，小兔子探出头。' },
    { code: 'P03', zh: '成长相册', en: 'The album', shots: ['P03'], reach: '在 P02 按 OK 或向左挥手。', job: '0 到 10 岁，一岁一张，旋转木马式 3D 相册；照片旁边显示寄语。' },
    { code: 'P04', zh: '这一年', en: 'One year’s photos', shots: ['P04'], reach: '在 P03 按 ↓ 或张开双手；按 ↑ 或握拳回到 P03。', job: '某一岁的更多照片，每张都可以带自己的寄语。' },
    { code: 'P05', zh: '年龄', en: 'Our ages', shots: ['P05'], reach: 'P03 翻过最后一张，或按 OK。', job: '核心信息二：你十岁，爸爸也十岁，妈妈十一岁。' },
    { code: 'P06', zh: '陪伴', en: 'Time together', shots: ['P06'], reach: '在 P05 按 OK 或挥手。', job: '核心信息三：三条越来越短的陪伴时间。' },
    { code: 'P07', zh: '许愿', en: 'Make a wish', shots: ['P07'], reach: '在 P06 按 OK 或挥手。', job: '十根蜡烛的蛋糕，等她吹。' },
    { code: 'P08', zh: '生日快乐', en: 'Happy birthday', shots: ['P08'], reach: '在 P07 吹蜡烛（按 OK 或对镜头吹气）。', job: '蜡烛吹灭，放烟花，爸爸妈妈说一句话。' },
    { code: 'P09', zh: '年岁的名字', en: 'Names of the ages', shots: ['P09', 'P09-20'], states: ['第一个：幼学（你在这里）', '换到 20 岁：桃李年华'], reach: '在 P08 按 OK。← → 或挥手换一个，OK 回到开场。', job: '从十岁起，中国传统里每个年岁的叫法。下面附全部十个名字。', names: true }
  ] },
  { id: 'M', zh: '照片管理（电脑或手机）', en: 'Managing photos', note: '打开 manage.html，或点 P01 右上角的"整理照片"。', screens: [
    { code: 'M01', zh: '照片管理', en: 'Photo manager', shots: ['M01'], reach: 'manage.html。', job: '导入封面和每年的更多照片，写说明和寄语，选背景音乐，填名字和头像。', tall: true },
    { code: 'M02', zh: '寄语对话框', en: 'Note dialog', shots: ['M02'], reach: '在 M01 点封面下的"寄语"，或点"这一年的更多照片"里的缩略图。', job: '给一张照片写一句话、手写一段、配一张小图。' },
    { code: 'M03', zh: '账户与设备', en: 'Account and devices', shots: ['M03'], reach: '连接相册服务器时，M01 页面的最下方。', job: '看和移除可信设备，更换手机号，退出这台设备。' }
  ] },
  { id: 'L', zh: '登录（连接相册服务器时）', en: 'Signing in', note: '只有由相册服务器提供网页时才会出现。', screens: [
    { code: 'L01', zh: '首次设置', en: 'First-time setup', shots: ['L01'], reach: '服务器第一次使用时，打开任何页面都会到这里。', job: '填设置口令、你的邮箱、密码和两个手机号。这个邮箱就是第一个登录账号。' },
    { code: 'L02', zh: '设置验证码', en: 'Setup codes', shots: ['L02'], reach: 'L01 点"发送验证码"之后。', job: '两个手机号各收一条短信，两个验证码都填对才算设置完成。' },
    { code: 'L03', zh: '输入密码', en: 'Password', shots: ['L03'], reach: '登录过期或服务器重启后。截图是输错密码的样子。', job: '输入邮箱和密码。用原来的家庭密码时邮箱留空。' },
    { code: 'L04', zh: '短信验证', en: 'Text-message check', shots: ['L04'], reach: 'L03 之后，按管理员设的短信开关：默认是新设备或换了国家时。', job: '选一个手机号收验证码，填进去。' }
  ] },
  { id: 'A', zh: '管理员（连接相册服务器时）', en: 'Admin', note: '从 M03 的"管理员设置"进入，或打开 admin.html。管理员状态 15 分钟不操作、退出管理或服务器重启后要重新验证。', screens: [
    { code: 'A01', zh: '管理员验证', en: 'Admin check', shots: ['A01', 'A01B'], states: ['管理员密码与动态码', '短信验证码'], reach: '已登录后点 M03 的"管理员设置"；管理员已经设置好时。', job: '三样都过才能进入：管理员密码、验证器 App 上的 6 位动态码、发到两个锁定手机号之一的短信验证码。' },
    { code: 'A02', zh: '管理员设置', en: 'Admin settings', shots: ['A02'], reach: '通过 A01 或 A03 之后。', job: '短信验证开关（关闭 / 新设备或换国家 / 每次登录）；添加、改邮箱、改密码、移除登录账号；重新设置管理员；操作记录。', tall: true },
    { code: 'A03', zh: '设置管理员', en: 'Set up the admin', shots: ['A03', 'A03B'], states: ['短信验证', '绑定验证器 App'], reach: '还没有管理员时点"管理员设置"；或在 A02 点"重新设置管理员"（要两个手机号都验证）。', job: '验证手机号后，设管理员密码，用验证器 App 扫码绑定。' }
  ] }
];
const GLOBAL = [
  ['G01', '摄像头小窗', 'Camera bubble', '互动模式下 P02–P09 右上角，显示孩子自己（镜像）。见 P03 的标号。'],
  ['G02', '提示气泡', 'Toast', '屏幕上方中间短暂出现的一句话，例如"笑得真甜！""爱心收到啦"。'],
  ['G03', '彩带、爱心、烟花', 'Confetti, hearts, fireworks', '笑一笑、比个心、吹完蜡烛时满屏飞的效果。'],
  ['G04', '焦点环', 'Focus ring', '遥控器选中的东西外面那圈深玫红色的环，例如 P01 里的互动模式卡片。'],
  ['G05', '编号徽章', 'Screen code badge', '网址后面加 ?labels，每个界面角落会显示它的编号和名字。'],
  ['G06', '背景音乐', 'Background music', '没有画面。从选完模式开始播放，吹完蜡烛后换曲，按 M 静音。在 M01 里选择。']
];

function figure(code, shot, startAt, state) {
  const m = marks[shot] || { w: 1920, h: 1080, items: [] }, items = m.items;
  const pins = items.map((it, i) => {
    const n = startAt + i, l = (it.x / m.w * 100), t = (it.y / m.h * 100), w = (it.w / m.w * 100), h = (it.h / m.h * 100);
    return '<span class="area" data-k="' + code + '-' + n + '" style="left:' + l.toFixed(2) + '%;top:' + t.toFixed(2) + '%;width:' + w.toFixed(2) + '%;height:' + h.toFixed(2) + '%"></span>' +
      '<button type="button" class="pin" data-k="' + code + '-' + n + '" style="left:' + Math.min(97, Math.max(0, l + .4)).toFixed(2) + '%;top:' + Math.min(97, Math.max(0, t + .4)).toFixed(2) + '%" aria-label="' + code + '-' + n + ' ' + esc(it.zh) + '">' + n + '</button>';
  }).join('');
  return '<figure class="shot">' + (state ? '<figcaption class="state">' + esc(state) + '</figcaption>' : '') +
    '<div class="frame"><img loading="lazy" src="' + img(shot + '.jpg') + '" width="' + Math.round(m.w) + '" height="' + Math.round(m.h) + '" alt="' + code + ' ' + esc(state || '') + '">' + pins + '</div></figure>';
}
function legend(code, list) {
  return '<ol class="legend">' + list.map(([n, it]) => '<li><button type="button" class="key" data-k="' + code + '-' + n + '"><span class="num">' + code + '-' + n + '</span><span class="lab"><span>' + esc(it.zh) + '</span><small>' + esc(it.en) + '</small></span></button></li>').join('') + '</ol>';
}
function screenBlock(s) {
  let n = 1, figs = '', all = [];
  s.shots.forEach((shot, i) => {
    figs += figure(s.code, shot, n, s.states && s.states[i]);
    (marks[shot] ? marks[shot].items : []).forEach(it => all.push([n++, it]));
  });
  let extra = '';
  if (s.names) extra = '<div class="tw"><table class="names"><thead><tr><th>年龄</th><th>名字</th><th>拼音 · 英文</th><th>含义</th><th>适用</th></tr></thead><tbody>' +
    NAMES.map(x => '<tr><td class="age">' + x.age + '</td><td class="nm">' + esc(x.zh) + '</td><td>' + esc(x.py) + '<br><small>' + esc(x.en) + '</small></td><td>' + esc(x.mz) + '</td><td>' + (x.who ? esc(x.who[0]) : '都可以') + '</td></tr>').join('') + '</tbody></table></div>';
  return '<section class="screen' + (s.tall ? ' tall' : '') + '" id="' + s.code + '"><header class="sh"><span class="code">' + s.code + '</span><h3>' + esc(s.zh) + '<small>' + esc(s.en) + '</small></h3></header>' +
    '<dl class="facts"><div><dt>作用</dt><dd>' + esc(s.job) + '</dd></div><div><dt>怎么到这里</dt><dd>' + esc(s.reach) + '</dd></div></dl>' +
    '<div class="body"><div class="figs">' + figs + '</div>' + legend(s.code, all) + '</div>' + extra + '</section>';
}

const total = GROUPS.reduce((a, g) => a + g.screens.length, 0);
const html = `<!doctype html>
<html lang="zh-Hans">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>十岁啦 界面编号</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fredoka:wght@500;600&family=Nunito:wght@500;700;800&family=ZCOOL+KuaiLe&display=swap">
<style>
/* Layout: a reference sheet. Index of codes on top, then one block per screen: screenshot with numbered pins on the left, the key on the right. */
:root{
  --ground:#f6ede3; --surface:#fffaf4; --band:#efe2d4; --ink:#4a3b33; --muted:#75625a; --line:#dcc8b6;
  --pin:#a8415f; --on-pin:#fffaf4; --hi:#e8a0b4; --code:#f0cf8a; --on-code:#4a3b33;
  --display:"Fredoka","ZCOOL KuaiLe","PingFang SC","Microsoft YaHei",sans-serif;
  --body:"Nunito","PingFang SC","Microsoft YaHei","Noto Sans SC",system-ui,sans-serif;
  --mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;
  color-scheme:light;
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--ground:#221b18;--surface:#2d2420;--band:#382d28;--ink:#f3e7dc;--muted:#c4b2a5;--line:#4d3f38;--pin:#e8a0b4;--on-pin:#2a1a20;--hi:#e8a0b4;--code:#f0cf8a;--on-code:#2d2420;color-scheme:dark}}
:root[data-theme="dark"]{--ground:#221b18;--surface:#2d2420;--band:#382d28;--ink:#f3e7dc;--muted:#c4b2a5;--line:#4d3f38;--pin:#e8a0b4;--on-pin:#2a1a20;--hi:#e8a0b4;--code:#f0cf8a;--on-code:#2d2420;color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:var(--ground);color:var(--ink);font:15px/1.6 var(--body);padding-left:max(16px, env(safe-area-inset-left, 0px));padding-right:max(16px, env(safe-area-inset-right, 0px))}
.wrap{max-width:1240px;margin:0 auto;padding-block:32px 80px}
h1,h2,h3{font-family:var(--display);font-weight:600;text-wrap:balance;margin:0}
h1{font-size:clamp(30px,5vw,44px);line-height:1.1}
.lede{max-width:66ch;margin:12px 0 0;color:var(--muted)}
.howto{display:flex;flex-wrap:wrap;gap:10px 18px;align-items:center;margin-top:18px;padding:14px 18px;border-radius:18px;background:var(--surface)}
.howto b{font-family:var(--mono);font-size:14px;padding:2px 8px;border-radius:8px;background:var(--code);color:var(--on-code)}
.howto label{display:inline-flex;gap:8px;align-items:center;margin-left:auto;font-weight:700;cursor:pointer}
.howto input{width:18px;height:18px;accent-color:var(--pin)}
.index{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px;margin-top:22px}
.index section{padding:14px 16px;border-radius:18px;background:var(--surface)}
.index h2{font-size:17px}
.index h2 small,.grp h2 small{display:block;font:700 12px/1.3 var(--body);color:var(--muted);letter-spacing:.02em}
.index ul{list-style:none;margin:10px 0 0;padding:0;display:grid;gap:4px}
.index a{display:flex;gap:10px;align-items:baseline;padding:4px 6px;border-radius:8px;color:var(--ink);text-decoration:none}
.index a:hover,.index a:focus-visible{background:var(--band);outline:none}
.index a > span:first-child,.code{font-family:var(--mono);font-weight:700;font-size:13px;padding:1px 7px;border-radius:7px;background:var(--code);color:var(--on-code);font-variant-numeric:tabular-nums}
.index .g{font-size:13px;color:var(--muted)}
.grp{margin-top:48px}
.grp>header{display:flex;flex-wrap:wrap;gap:6px 16px;align-items:baseline;padding-bottom:10px;border-bottom:2px solid var(--line)}
.grp h2{font-size:26px}
.grp>header p{margin:0;color:var(--muted)}
.screen{margin-top:28px;padding:20px;border-radius:24px;background:var(--surface);scroll-margin-top:16px}
.sh{display:flex;gap:12px;align-items:center}
.sh .code{font-size:18px;padding:3px 12px}
.sh h3{font-size:24px;line-height:1.2}
.sh h3 small{display:block;font:700 13px/1.3 var(--body);color:var(--muted)}
.facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:8px 24px;margin:12px 0 16px}
.facts div{min-width:0}
.facts dt{font-size:12px;font-weight:800;letter-spacing:.06em;color:var(--muted)}
.facts dd{margin:2px 0 0}
.body{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:20px;align-items:start}
.figs{display:grid;gap:16px;min-width:0}
.shot{margin:0;min-width:0}
.state{font-weight:800;font-size:13px;margin-bottom:6px;color:var(--muted)}
.frame{position:relative;border-radius:14px;overflow:hidden;box-shadow:0 0 0 1px var(--line)}
.frame img{display:block;width:100%;height:auto;max-width:100%}
.tall .frame{max-width:640px}
.pin{position:absolute;z-index:2;display:grid;place-items:center;min-width:24px;height:24px;padding:0 5px;border:2px solid var(--on-pin);border-radius:12px;background:var(--pin);color:var(--on-pin);font:800 12px/1 var(--body);font-variant-numeric:tabular-nums;cursor:pointer;box-shadow:0 2px 6px rgba(0,0,0,.3)}
.area{position:absolute;z-index:1;border:2px dashed transparent;border-radius:6px;pointer-events:none;transition:border-color .15s,background-color .15s}
.lines .area{border-color:color-mix(in srgb, var(--pin) 55%, transparent)}
.area.on{border:3px solid var(--pin);background:color-mix(in srgb, var(--hi) 22%, transparent)}
.pin.on{transform:scale(1.25);background:var(--ink);color:var(--ground)}
.legend{list-style:none;margin:0;padding:0;display:grid;gap:2px;position:sticky;top:12px}
.key{display:flex;gap:10px;align-items:flex-start;width:100%;padding:6px 8px;border:0;border-radius:10px;background:none;color:var(--ink);text-align:left;font:inherit;cursor:pointer}
.key:hover,.key.on{background:var(--band)}
.key:focus-visible,.pin:focus-visible,.index a:focus-visible{outline:3px solid var(--pin);outline-offset:2px}
.num{flex:none;min-width:56px;font-family:var(--mono);font-weight:700;font-size:13px;color:var(--pin);font-variant-numeric:tabular-nums;padding-top:1px}
.lab{display:flex;flex-direction:column;min-width:0}
.lab small{color:var(--muted);font-size:12px}
.tw{margin-top:18px;overflow-x:auto;border-radius:14px;box-shadow:0 0 0 1px var(--line)}
table{width:100%;min-width:640px;border-collapse:collapse;font-size:14px}
th,td{text-align:left;vertical-align:top;padding:8px 12px;border-bottom:1px solid var(--line)}
th{background:var(--band);font-size:12px;letter-spacing:.04em}
tbody tr:last-child td{border-bottom:0}
td.age{font-variant-numeric:tabular-nums;font-weight:800}
td.nm{font-family:var(--display);font-size:18px;white-space:nowrap}
td small{color:var(--muted)}
.glob{margin-top:16px;display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px}
.glob div{padding:14px 16px;border-radius:18px;background:var(--surface);scroll-margin-top:16px}
.glob h3{font-size:18px;display:flex;gap:10px;align-items:center}
.glob h3 small{font:700 12px var(--body);color:var(--muted)}
.glob p{margin:6px 0 0}
.toast{position:fixed;left:50%;bottom:calc(20px + env(safe-area-inset-bottom, 0px));transform:translateX(-50%);padding:10px 18px;border-radius:999px;background:var(--ink);color:var(--ground);font-weight:800;z-index:10}
footer{margin-top:48px;color:var(--muted);font-size:13px}
@media (max-width:880px){.body{grid-template-columns:minmax(0,1fr)}.legend{position:static;grid-template-columns:repeat(auto-fill,minmax(220px,1fr))}}
@media (prefers-reduced-motion:reduce){.area,.pin{transition:none}.pin.on{transform:none}}
</style>
</head>
<body>
<div class="wrap" id="top">
  <h1>十岁啦 · 界面编号</h1>
  <p class="lede">成长相册一共 ${total} 个主要界面。每个界面有一个编号，界面里的每个区域再有一个小号。想改哪里，告诉我编号就行。截图里的照片都是示例色块。</p>
  <div class="howto"><span>例如：<b>P03-5</b> 寄语的字再大一点；<b>M01-6</b> 拖放区挪到最上面；<b>P09</b> 加一个名字。</span>
    <label for="lines"><input type="checkbox" id="lines">显示全部区域框线</label></div>
  <div class="index">
${GROUPS.map(g => '    <section><h2>' + esc(g.zh) + '<small>' + esc(g.en) + '</small></h2><ul>' + g.screens.map(s => '<li><a href="#' + s.code + '"><span>' + s.code + '</span><span>' + esc(s.zh) + ' <span class="g">' + esc(s.en) + '</span></span></a></li>').join('') + '</ul></section>').join('\n')}
    <section><h2>全局元素<small>Shown on many screens</small></h2><ul>${GLOBAL.map(g => '<li><a href="#' + g[0] + '"><span>' + g[0] + '</span><span>' + esc(g[1]) + ' <span class="g">' + esc(g[2]) + '</span></span></a></li>').join('')}</ul></section>
  </div>
${GROUPS.map(g => '  <div class="grp"><header><h2>' + esc(g.zh) + '<small>' + esc(g.en) + '</small></h2><p>' + esc(g.note) + '</p></header>\n' + g.screens.map(screenBlock).join('\n') + '</div>').join('\n')}
  <div class="grp"><header><h2>全局元素<small>Shown on many screens</small></h2><p>不属于某一个界面，在好几个地方出现。</p></header>
    <div class="glob">${GLOBAL.map(g => '<div id="' + g[0] + '"><h3><span class="code">' + g[0] + '</span>' + esc(g[1]) + '<small>' + esc(g[2]) + '</small></h3><p>' + esc(g[3]) + '</p></div>').join('')}</div></div>
  <footer>2026-11-17 · v2.2 · 对应分支 claude/determined-ritchie-rc72lc。点右侧任一条可复制它的编号和名字。</footer>
</div>
<script>
(function () {
  var doc = document, lines = doc.getElementById('lines'), toast = null;
  function mark(k, on) {
    [].forEach.call(doc.querySelectorAll('[data-k="' + k + '"]'), function (el) { el.classList.toggle('on', on); });
  }
  function say(t) {
    if (!toast) { toast = doc.createElement('div'); toast.className = 'toast'; toast.setAttribute('role', 'status'); doc.body.appendChild(toast); }
    toast.textContent = t; toast.hidden = false; clearTimeout(say.t); say.t = setTimeout(function () { toast.hidden = true; }, 1600);
  }
  ['mouseover', 'focusin'].forEach(function (ev) { doc.addEventListener(ev, function (e) { var el = e.target.closest && e.target.closest('[data-k]'); if (el) mark(el.getAttribute('data-k'), true); }); });
  ['mouseout', 'focusout'].forEach(function (ev) { doc.addEventListener(ev, function (e) { var el = e.target.closest && e.target.closest('[data-k]'); if (el) mark(el.getAttribute('data-k'), false); }); });
  doc.addEventListener('click', function (e) {
    var el = e.target.closest && e.target.closest('button[data-k]'); if (!el) return;
    var k = el.getAttribute('data-k'), key = doc.querySelector('.key[data-k="' + k + '"]'), text = k + ' ' + (key ? key.querySelector('.lab span').textContent : '');
    if (el.classList.contains('pin') && key) { key.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); key.focus({ preventScroll: true }); }
    try { navigator.clipboard.writeText(text).then(function () { say('已复制 ' + text); }, function () { say(text); }); } catch (err) { say(text); }
  });
  lines.addEventListener('change', function () { doc.body.classList.toggle('lines', lines.checked); });
})();
</script>
</body>
</html>
`;
fs.writeFileSync(path.join(here, '..', 'screens.html'), html);
console.log('screens.html written', Math.round(html.length / 1024) + ' KB', total + ' screens');
