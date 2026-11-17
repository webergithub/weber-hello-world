/* 十岁啦 · 管理员 Admin
   A01 管理员验证：管理员密码 + 验证器 App 动态码 + 发到锁定手机号之一的短信验证码，三样都过才进得去。
   A02 管理员设置：短信验证开关、登录账号（邮箱 + 密码）、重新设置管理员、操作记录。
   A03 设置管理员：第一次用一个手机号验证，替换已有管理员要两个手机号都验证；然后设管理员密码、绑定验证器 App。
   管理员状态只保存在服务器内存里，15 分钟不操作、服务器重启或退出管理后都要重新验证。 */
(function () {
  'use strict';
  var T = window.TenUp, root = document.getElementById('root');
  var view = 'loading', msg = null, okMsg = null, busy = false, info = {}, data = null, edit = null;
  var POL = [
    ['off', '关闭', 'Off', '登录只需要邮箱和密码。', 'E-mail and password only.'],
    ['new-device', '新设备或换了国家时', 'New device or new country', '已经验证过的设备，在同一个国家只需要密码。（默认）', 'A device already checked needs only the password in the same country. (Default)'],
    ['always', '每次登录', 'Every login', '每次输入密码之后都要短信验证码。', 'Every login needs a text-message code after the password.']
  ];

  function api(method, url, body) {
    return fetch('api/' + url, { method: method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-TenUp': '1' }, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) {
        if (r.status === 401 && !/^admin\/(start|sms|enroll)/.test(url)) { location.replace('login.html?next=manage.html'); return new Promise(function () {}); }
        return r.json().then(function (j) { return { status: r.status, json: j }; });
      });
  }
  var esc = T.esc;
  function field(id, zh, en, attrs) { return '<label><span>' + zh + ' <small lang="en">' + en + '</small></span><input class="tu-field" id="' + id + '" ' + (attrs || '') + '></label>'; }
  function go(zh, en) { return '<button type="submit" class="lg__go"' + (busy ? ' disabled' : '') + '>' + zh + '<small lang="en">' + en + '</small></button>'; }
  function alt(zh, en, act, extra) { return '<button type="button" class="lg__alt" data-act="' + act + '"' + (extra || '') + (busy ? ' disabled' : '') + '>' + zh + '<small lang="en">' + en + '</small></button>'; }
  function mini(zh, en, act, cls, extra) { return '<button type="button" class="tu-mini ' + (cls || '') + '" data-act="' + act + '"' + (extra || '') + '>' + zh + '<small>' + en + '</small></button>'; }
  function val(id) { var e = document.getElementById(id); return e ? e.value : ''; }
  function when(t) { if (!t) return '—'; var d = new Date(t); return d.toLocaleDateString() + ' ' + d.toTimeString().slice(0, 5); }
  function codeField(id, zh, en) { return field(id, zh, en, 'inputmode="numeric" maxlength="6" autocomplete="one-time-code" pattern="[0-9]*"'); }

  /* ---------------- views ---------------- */
  var VIEWS = {
    loading: function () { return T.bi('请稍等…', 'One moment…', 'tu-body'); },
    none: function () { return T.bi('管理员设置需要连接相册服务器', 'Admin settings need the album server', 'tu-title') + '<a class="lg__go" href="index.html" style="text-decoration:none;box-sizing:border-box">回到相册<small lang="en">Back to the album</small></a>'; },

    /* A01 */
    signin: function () {
      return T.bi('管理员验证', 'Admin check', 'tu-title') +
        T.bi('三样都要：管理员密码、验证器 App 上的 6 位动态码、一条短信验证码。', 'Three things: the admin password, the 6 digits in the authenticator app, and a text-message code.', 'tu-body') +
        field('apw', '管理员密码', 'Admin password', 'type="password" autocomplete="current-password" autofocus') +
        codeField('totp', '验证器 App 上的动态码', 'Code in the authenticator app') + go('下一步：短信验证', 'Next: text message') +
        '<a class="lg__back" href="manage.html">回到照片管理 · Back to photos</a>';
    },
    signinSms: function () {
      return T.bi('管理员验证 · 短信', 'Admin check · text message', 'tu-title') +
        T.bi('选一个手机号接收验证码。', 'Choose a phone to receive the code.', 'tu-body') +
        '<div class="lg__row">' + alt(info.phones[0], 'Send to phone 1', 'asend', ' data-i="0"') + alt(info.phones[1], 'Send to phone 2', 'asend', ' data-i="1"') + '</div>' +
        (info.sent ? codeField('code', '验证码', 'Code') + go('进入管理员设置', 'Open admin settings') : '');
    },

    /* A03 */
    enroll: function () {
      var again = info.adminSet;
      return T.bi(again ? '重新设置管理员' : '设置管理员', again ? 'Replace the admin' : 'Set up the admin', 'tu-title') +
        T.bi(again ? '替换现有管理员，需要两个手机号都收到验证码。完成后，原来的管理员密码和验证器都失效。' : '管理员可以开关短信验证、添加和移除登录账号。先用一个手机号验证，再设管理员密码、绑定验证器 App。',
          again ? 'Replacing the admin needs a code from both phones. The old admin password and authenticator stop working.' : 'The admin can turn text messages on or off and add or remove accounts. First a code to one phone, then an admin password and an authenticator app.', 'tu-body') +
        (again ? alt('向两个手机号发送验证码', 'Send codes to both phones', 'esend', ' data-i="0"')
               : '<div class="lg__row">' + alt(info.phones[0], 'Send to phone 1', 'esend', ' data-i="0"') + alt(info.phones[1], 'Send to phone 2', 'esend', ' data-i="1"') + '</div>') +
        (info.sent ? (info.both ? codeField('c0', info.sentTo[0] + ' 收到的验证码', 'Code from phone 1') + codeField('c1', info.sentTo[1] + ' 收到的验证码', 'Code from phone 2')
                                : codeField('c0', info.sentTo[0] + ' 收到的验证码', 'Code')) + go('下一步：绑定验证器', 'Next: authenticator app') : '') +
        '<a class="lg__back" href="' + (again ? 'admin.html' : 'manage.html') + '">取消 · Cancel</a>';
    },
    enrollApp: function () {
      var qr = '';
      try { var q = window.qrcode(0, 'M'); q.addData(info.uri); q.make(); qr = q.createSvgTag({ cellSize: 5, margin: 2, scalable: true }); } catch (e) { qr = ''; }
      return T.bi('绑定验证器 App', 'Add the authenticator app', 'tu-title') +
        '<ol class="ad__steps"><li>' + T.bi('在手机上打开验证器 App（Google Authenticator、微软验证器都可以），点"添加"或"+"。', 'Open an authenticator app on your phone (Google Authenticator, Microsoft Authenticator…) and tap Add.') + '</li>' +
        '<li>' + T.bi('扫下面的二维码。扫不了就手动输入下面这串密钥。', 'Scan the code below, or type the key by hand.') + '</li>' +
        '<li>' + T.bi('App 里会出现"十岁啦"，把它现在显示的 6 位数填到下面。', '"十岁啦" appears in the app. Type the 6 digits it shows now.') + '</li></ol>' +
        '<div class="ad__qr">' + (qr ? '<div class="ad__qrimg" role="img" aria-label="验证器二维码 Authenticator QR code">' + qr + '</div>' : '') +
        '<div class="ad__key"><span>密钥 · Key</span><code id="key">' + esc(info.secret.replace(/(.{4})/g, '$1 ').trim()) + '</code>' + mini('复制密钥', 'Copy the key', 'copykey') + '</div></div>' +
        field('apw', '设一个管理员密码（至少 12 位，和登录密码不同）', 'Admin password — at least 12 characters, not your login password', 'type="password" autocomplete="new-password"') +
        field('apw2', '再输一次管理员密码', 'Admin password again', 'type="password" autocomplete="new-password"') +
        codeField('totp', '验证器 App 现在显示的 6 位数', 'The 6 digits the app shows now') + go('完成设置', 'Finish');
    }
  };

  /* A02 */
  function panel() {
    var d = data, h = '';
    h += '<header class="ad__head"><div>' + T.bi('管理员设置', 'Admin settings', 'tu-title') +
      T.bi('管理员自 ' + when(d.admin.since) + ' 起 · 由 ' + (d.admin.by || '—') + ' 设置', 'Admin since ' + when(d.admin.since) + ' · set up by ' + (d.admin.by || '—'), 'tu-body') + '</div>' +
      '<div class="ad__acts"><a class="tu-mini" href="manage.html">回到照片管理<small>Back to photos</small></a>' + mini('退出管理', 'Leave admin', 'alogout', 'tu-mini--danger') + '</div></header>';

    h += '<section class="ad__card"><h2>' + T.bi('短信验证', 'Text-message check') + '</h2><div class="ad__pols" role="radiogroup" aria-label="短信验证 Text-message check">' + POL.map(function (p) {
      var on = d.smsPolicy === p[0];
      return '<button type="button" role="radio" aria-checked="' + on + '" class="ad__pol' + (on ? ' is-on' : '') + '" data-act="pol" data-p="' + p[0] + '"><b>' + p[1] + '</b><small lang="en">' + p[2] + '</small><span>' + p[3] + '</span><span lang="en">' + p[4] + '</span></button>';
    }).join('') + '</div>' +
      (d.smsPolicy === 'off' ? '<p class="ad__warn" role="alert">' + T.bi('已关闭：知道邮箱和密码的人在任何设备上都能登录。', 'Off: anyone who knows an e-mail and its password can log in from any device.') + '</p>' : '') +
      '<p class="ad__note">' + T.bi('进入管理员设置和更换手机号，不管这里怎么设，都要短信验证。接收验证码的手机号：' + d.phones.join('、'), 'Admin settings and changing a phone number always need a text message. Phones: ' + d.phones.join(', ')) + '</p></section>';

    h += '<section class="ad__card"><h2>' + T.bi('登录账号', 'Accounts') + '</h2><div class="ad__accts">' + d.accounts.map(function (a) {
      var me = a.id === d.me, e = edit && edit.id === a.id ? edit.what : null;
      return '<div class="ad__acct' + (e ? ' is-open' : '') + '"><div class="ad__who"><b>' + (a.email ? esc(a.email) : '<i>没有邮箱 · no e-mail</i>') + '</b>' +
        '<span>' + (a.name ? esc(a.name) + ' · ' : '') + (a.role === 'owner' ? '创建者 owner' : '成员 member') + (me ? ' · <b>你自己 you</b>' : '') + '</span>' +
        '<small>上次登录 ' + when(a.lastLogin) + ' · 已登录设备 ' + a.devices + '</small></div>' +
        '<div class="ad__row-acts">' + mini(a.email ? '改邮箱' : '设邮箱', a.email ? 'E-mail' : 'Set e-mail', 'eemail', '', ' data-id="' + a.id + '"') + mini('改密码', 'Password', 'epass', '', ' data-id="' + a.id + '"') +
        (me ? '' : mini('移除', 'Remove', 'rm', 'tu-mini--danger', ' data-id="' + a.id + '"')) + '</div>' +
        (e === 'email' ? '<form class="ad__edit" data-form="email" data-id="' + a.id + '">' + field('ee', '新邮箱', 'New e-mail', 'type="email" value="' + esc(a.email) + '"') + '<div class="ad__btns">' + mini('保存', 'Save', 'save', 'tu-mini--go') + mini('取消', 'Cancel', 'cancel') + '</div></form>' : '') +
        (e === 'pass' ? '<form class="ad__edit" data-form="pass" data-id="' + a.id + '">' + field('ep', '新密码（至少 10 位）', 'New password, 10+ characters', 'type="password" autocomplete="new-password"') + field('ep2', '再输一次', 'Again', 'type="password" autocomplete="new-password"') +
          '<p class="ad__note">' + T.bi('改密码后，这个账号在其他设备上会被退出。', 'Changing it signs this account out on other devices.') + '</p><div class="ad__btns">' + mini('保存', 'Save', 'save', 'tu-mini--go') + mini('取消', 'Cancel', 'cancel') + '</div></form>' : '') +
        (e === 'rm' ? '<div class="ad__edit ad__confirm">' + T.bi('移除 ' + (a.email || a.name || '这个账号') + '？它在所有设备上都会被退出，不能撤销。', 'Remove this account? It is signed out everywhere. This cannot be undone.') +
          '<div class="ad__btns">' + mini('确认移除', 'Remove', 'rmyes', 'tu-mini--danger', ' data-id="' + a.id + '"') + mini('取消', 'Cancel', 'cancel') + '</div></div>' : '') + '</div>';
    }).join('') + '</div>' +
      '<form class="ad__add" data-form="add"><h3>' + T.bi('添加账号', 'Add an account') + '</h3><div class="ad__grid">' +
      field('ne', '邮箱', 'E-mail', 'type="email" autocomplete="off"') + field('nn', '称呼（可不填）', 'Name, optional', 'maxlength="30" autocomplete="off"') +
      field('np', '密码（至少 10 位）', 'Password, 10+ characters', 'type="password" autocomplete="new-password"') + field('np2', '再输一次', 'Again', 'type="password" autocomplete="new-password"') +
      '</div><button type="submit" class="tu-mini tu-mini--go ad__addgo">添加账号<small>Add account</small></button></form></section>';

    h += '<section class="ad__card"><h2>' + T.bi('管理员', 'The admin') + '</h2><p class="ad__note">' +
      T.bi('忘了管理员密码或换了手机上的验证器，可以重新设置管理员。需要两个手机号都收到验证码。', 'Forgot the admin password or changed the authenticator? Replace the admin — it needs a code from both phones.') + '</p>' +
      mini('重新设置管理员', 'Replace the admin', 'reenroll') + '</section>';

    h += '<section class="ad__card"><h2>' + T.bi('操作记录', 'Activity') + '</h2><ol class="ad__log">' + d.log.map(function (l) {
      return '<li><time>' + when(l.t) + '</time><span>' + esc(l.what) + '</span><small>' + esc(l.who || '') + '</small></li>';
    }).join('') + '</ol></section>';
    return h;
  }

  var CODES = { signin: ['A01', '管理员验证', 'Admin check'], signinSms: ['A01', '管理员验证', 'Admin check'], panel: ['A02', '管理员设置', 'Admin settings'], enroll: ['A03', '设置管理员', 'Set up the admin'], enrollApp: ['A03', '设置管理员', 'Set up the admin'] };
  function draw() {
    var body;
    if (view === 'panel') { root.className = 'ad'; body = panel(); }
    else {
      root.className = 'lg';
      body = T.mascot('plush', msg ? 'cry' : 'happy', 'tu-mascot--bob') + '<form class="lg__card" novalidate>' + VIEWS[view]() + '</form>';
    }
    root.innerHTML = body + (msg ? '<div class="lg__msg" role="alert">' + esc(msg) + '</div>' : '') + (okMsg ? '<div class="lg__ok" role="status">' + esc(okMsg) + '</div>' : '');
    var c = CODES[view]; if (c) T.tag(c[0], c[1], c[2]);
    var f = root.querySelector('[autofocus]'); if (f) f.focus();
  }
  function run(p, done) {
    busy = true; msg = null; okMsg = null;
    return p.then(function (r) {
      busy = false;
      if (r.status === 200) return done(r.json);
      if (r.json && r.json.error === 'need_admin') { view = info.adminSet ? 'signin' : 'enroll'; msg = '请重新验证 Please check in again'; return draw(); }
      msg = (r.json && r.json.message) || '出错了 Something went wrong'; draw();
    }).catch(function () { busy = false; msg = '连不上服务器 Cannot reach the server'; draw(); });
  }
  function loadPanel(note) {
    return run(api('GET', 'admin/settings'), function (j) { data = j; edit = null; view = 'panel'; okMsg = note || null; draw(); });
  }

  /* ---------------- events ---------------- */
  root.addEventListener('submit', function (e) {
    e.preventDefault(); if (busy) return;
    var form = e.target.getAttribute('data-form');
    if (view === 'signin') run(api('POST', 'admin/start', { password: val('apw'), totp: val('totp') }), function (j) { info.phones = j.phones; info.sent = false; view = 'signinSms'; draw(); });
    else if (view === 'signinSms') run(api('POST', 'admin/sms/verify', { code: val('code') }), function () { loadPanel(); });
    else if (view === 'enroll') run(api('POST', 'admin/enroll/verify', { codes: [val('c0'), val('c1')] }), function (j) { info.secret = j.secret; info.uri = j.uri; view = 'enrollApp'; draw(); });
    else if (view === 'enrollApp') {
      if (val('apw') !== val('apw2')) { msg = '两次管理员密码不一样 The two admin passwords do not match'; return draw(); }
      run(api('POST', 'admin/enroll/finish', { password: val('apw'), totp: val('totp') }), function () { info.adminSet = true; loadPanel('管理员已设置好 The admin is set up'); });
    }
    else if (form === 'add') {
      if (val('np') !== val('np2')) { msg = '两次密码不一样 The two passwords do not match'; return draw(); }
      run(api('POST', 'admin/accounts/add', { email: val('ne'), name: val('nn'), password: val('np') }), function () { loadPanel('已添加 ' + val('ne') + ' · Account added'); });
    }
    else if (form === 'email') run(api('POST', 'admin/accounts/update', { id: e.target.getAttribute('data-id'), email: val('ee') }), function () { loadPanel('邮箱已更新 E-mail saved'); });
    else if (form === 'pass') {
      if (val('ep') !== val('ep2')) { msg = '两次密码不一样 The two passwords do not match'; return draw(); }
      run(api('POST', 'admin/accounts/update', { id: e.target.getAttribute('data-id'), password: val('ep') }), function () { loadPanel('密码已更新 Password saved'); });
    }
  });
  root.addEventListener('click', function (e) {
    var a = e.target.closest('[data-act]'); if (!a || busy) return;
    var act = a.getAttribute('data-act'), id = a.getAttribute('data-id');
    if (act === 'asend') run(api('POST', 'admin/sms/send', { which: +a.getAttribute('data-i') }), function (j) { info.sent = true; okMsg = '验证码已发到 ' + j.sentTo + ' · Code sent'; draw(); });
    else if (act === 'esend') run(api('POST', 'admin/enroll/start', { which: +a.getAttribute('data-i') }), function (j) { info.sent = true; info.both = j.both; info.sentTo = j.sentTo; okMsg = '验证码已发出 · Code sent'; draw(); });
    else if (act === 'copykey') {
      var k = info.secret;
      try { navigator.clipboard.writeText(k).then(function () { okMsg = '密钥已复制 Key copied'; msg = null; draw(); }, function () {}); } catch (err) {}
    }
    else if (act === 'pol') run(api('POST', 'admin/policy', { smsPolicy: a.getAttribute('data-p') }), function () { loadPanel('短信验证已更新 Saved'); });
    else if (act === 'eemail' || act === 'epass' || act === 'rm') { edit = { id: id, what: act === 'eemail' ? 'email' : act === 'epass' ? 'pass' : 'rm' }; msg = okMsg = null; draw(); var i = root.querySelector('.ad__edit input'); if (i) i.focus(); }
    else if (act === 'cancel') { edit = null; draw(); }
    else if (act === 'save') { var f = a.closest('form'); if (f) f.requestSubmit ? f.requestSubmit() : f.dispatchEvent(new Event('submit', { cancelable: true })); }
    else if (act === 'rmyes') run(api('POST', 'admin/accounts/remove', { id: id }), function () { loadPanel('账号已移除 Account removed'); });
    else if (act === 'reenroll') { info.sent = false; view = 'enroll'; msg = okMsg = null; draw(); }
    else if (act === 'alogout') run(api('POST', 'admin/logout', {}), function () { location.href = 'manage.html'; });
  });

  /* ---------------- start ---------------- */
  draw();
  fetch('api/state', { credentials: 'same-origin' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
    if (!j || j.server !== 'tenup') { view = 'none'; return draw(); }
    if (j.state !== 'ok') { location.replace('login.html?next=manage.html'); return; }
    info.adminSet = j.adminSet;
    return api('GET', 'devices').then(function (d) {
      info.phones = d.json.phones;
      return api('GET', 'admin/settings').then(function (r) {
        if (r.status === 200) { data = r.json; view = 'panel'; }
        else view = j.adminSet ? 'signin' : 'enroll';
        draw();
      });
    });
  }).catch(function () { view = 'none'; draw(); });
})();
