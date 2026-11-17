/* 十岁啦 · 登录 Log in
   三种情况：首次设置（设置口令 + 密码 + 两个手机号，各验证一次）；输入密码；新设备或换了国家时再输入短信验证码。 */
(function () {
  'use strict';
  var T = window.TenUp, root = document.getElementById('root');
  var next = (/[?&]next=([^&]+)/.exec(location.search) || [])[1];
  next = next ? decodeURIComponent(next) : 'index.html';
  if (!/^(index|manage)\.html(\?[\w=&.%-]*)?$/.test(next)) next = 'index.html';
  var view = 'loading', msg = null, okMsg = null, busy = false, info = {};

  function api(method, url, body) {
    return fetch('api/' + url, { method: method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-TenUp': '1' }, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json().then(function (j) { return { status: r.status, json: j }; }); });
  }
  function field(id, zh, en, attrs) { return '<label><span>' + zh + ' <small lang="en">' + en + '</small></span><input class="tu-field" id="' + id + '" ' + (attrs || '') + '></label>'; }
  function go(zh, en) { return '<button type="submit" class="lg__go"' + (busy ? ' disabled' : '') + '>' + zh + '<small lang="en">' + en + '</small></button>'; }
  function alt(zh, en, act, extra) { return '<button type="button" class="lg__alt" data-act="' + act + '"' + (extra || '') + (busy ? ' disabled' : '') + '>' + zh + '<small lang="en">' + en + '</small></button>'; }
  function val(id) { var e = document.getElementById(id); return e ? e.value : ''; }

  var VIEWS = {
    loading: function () { return T.bi('请稍等…', 'One moment…', 'tu-body'); },
    none: function () { return T.bi('这里没有连接相册服务器', 'No album server here', 'tu-title') + T.bi('直接打开相册即可，照片保存在这台设备上。', 'Just open the album — photos are kept on this device.', 'tu-body') + '<a class="lg__go" href="index.html" style="text-decoration:none;box-sizing:border-box">打开相册<small lang="en">Open the album</small></a>'; },
    setup: function () {
      return T.bi('第一次设置', 'First-time setup', 'tu-title') +
        T.bi('设一个密码，再填两个接收验证码的手机号。手机号写入后不能直接修改，只能由另一个号码验证后更换。', 'Choose a password and two phones for codes. A number can later be changed only with a code sent to the other one.', 'tu-body') +
        field('token', '设置口令', 'Setup token — printed when the server starts', 'autocomplete="off"') +
        field('pw', '密码（至少 10 位）', 'Password, at least 10 characters', 'type="password" autocomplete="new-password"') +
        field('pw2', '再输一次密码', 'Password again', 'type="password" autocomplete="new-password"') +
        field('p0', '手机号一', 'Phone 1', 'inputmode="tel" autocomplete="off"') + field('p1', '手机号二', 'Phone 2', 'inputmode="tel" autocomplete="off"') +
        go('发送验证码', 'Send the codes');
    },
    setupCodes: function () {
      return T.bi('输入两个验证码', 'Enter both codes', 'tu-title') + T.bi('两个手机号各收到了一条短信。', 'Each phone has received a text message.', 'tu-body') +
        field('c0', info.phones[0] + ' 收到的验证码', 'Code sent to phone 1', 'inputmode="numeric" maxlength="6" autocomplete="one-time-code"') +
        field('c1', info.phones[1] + ' 收到的验证码', 'Code sent to phone 2', 'inputmode="numeric" maxlength="6" autocomplete="off"') + go('完成设置', 'Finish setup');
    },
    password: function () {
      return T.bi(info.locked ? '输入密码解锁' : '输入密码', info.locked ? 'Enter the password to unlock' : 'Enter the password', 'tu-title') +
        (info.why === 'country' ? T.bi('这台设备换了国家，需要重新验证。', 'This device is in a different country, so it needs checking again.', 'tu-body') : '') +
        field('pw', '密码', 'Password', 'type="password" autocomplete="current-password" autofocus') + go('进入相册', 'Open the album');
    },
    sms: function () {
      return T.bi('短信验证', 'Text-message check', 'tu-title') +
        T.bi(info.why === 'country' ? '这台设备换了国家。选一个手机号接收验证码。' : '这是一台新设备。选一个手机号接收验证码。', info.why === 'country' ? 'This device is in a different country. Choose a phone to receive the code.' : 'This is a new device. Choose a phone to receive the code.', 'tu-body') +
        '<div class="lg__row">' + alt(info.phones[0], 'Send to phone 1', 'send', ' data-i="0"') + alt(info.phones[1], 'Send to phone 2', 'send', ' data-i="1"') + '</div>' +
        (info.sent ? field('code', '验证码', 'Code', 'inputmode="numeric" maxlength="6" autocomplete="one-time-code" autofocus') + go('确认', 'Confirm') : '');
    }
  };
  function draw() {
    root.innerHTML = T.mascot('plush', msg ? 'cry' : view === 'sms' || view === 'setupCodes' ? 'wow' : 'happy', 'tu-mascot--bob') +
      '<form class="lg__card" novalidate>' + VIEWS[view]() + (msg ? '<div class="lg__msg" role="alert">' + T.esc(msg) + '</div>' : '') + (okMsg ? '<div class="lg__ok" role="status">' + T.esc(okMsg) + '</div>' : '') + '</form>';
    var f = root.querySelector('[autofocus]'); if (f) f.focus();
    var code = { setup: ['L01', '首次设置', 'First-time setup'], setupCodes: ['L02', '设置验证码', 'Setup codes'], password: ['L03', '输入密码', 'Password'], sms: ['L04', '短信验证', 'Text-message check'] }[view];
    if (code) T.tag(code[0], code[1], code[2]);
  }
  function run(p, done) {
    busy = true; msg = null; okMsg = null;
    return p.then(function (r) { busy = false; if (r.status === 200) done(r.json); else { msg = (r.json && r.json.message) || '出错了 Something went wrong'; draw(); } })
      .catch(function () { busy = false; msg = '连不上服务器 Cannot reach the server'; draw(); });
  }
  function enter() { location.replace(next); }

  root.addEventListener('submit', function (e) {
    e.preventDefault(); if (busy) return;
    if (view === 'setup') {
      if (val('pw') !== val('pw2')) { msg = '两次密码不一样 The two passwords do not match'; return draw(); }
      run(api('POST', 'setup/start', { token: val('token'), password: val('pw'), phones: [val('p0'), val('p1')] }), function (j) { info.phones = j.phones; view = 'setupCodes'; draw(); });
    } else if (view === 'setupCodes') run(api('POST', 'setup/finish', { codes: [val('c0'), val('c1')] }), enter);
    else if (view === 'password') run(api('POST', 'login', { password: val('pw') }), function (j) { if (j.ok) return enter(); info.phones = j.phones; info.why = j.why; info.sent = false; view = 'sms'; draw(); });
    else if (view === 'sms') run(api('POST', 'sms/verify', { code: val('code') }), enter);
  });
  root.addEventListener('click', function (e) {
    var a = e.target.closest('[data-act="send"]'); if (!a || busy) return;
    run(api('POST', 'sms/send', { which: +a.getAttribute('data-i') }), function (j) { info.sent = true; okMsg = '验证码已发到 ' + j.sentTo + ' · Code sent'; draw(); });
  });

  draw();
  fetch('api/state', { credentials: 'same-origin' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
    if (!j || j.server !== 'tenup') { view = 'none'; return draw(); }
    if (j.state === 'ok') return enter();
    info.why = j.why; info.locked = j.state === 'locked';
    view = j.state === 'setup' ? 'setup' : 'password'; draw();
  }).catch(function () { view = 'none'; draw(); });
})();
