/* 十岁啦 TenUp — vanilla helpers for the birthday album. No framework, no network. */
(function () {
  'use strict';
  var T = {};
  var NS = 'http://www.w3.org/2000/svg';

  T.plans = [
    { id: 'toon', key: 'A', zh: '卡通派对', en: 'Toon Pop' },
    { id: 'plush', key: 'B', zh: '毛绒云朵', en: 'Plush Cloud' },
    { id: 'star', key: 'C', zh: '星光剧场', en: 'Starlight Stage' }
  ];

  /* Default album: one slot per age, 0–10. `src` is filled by the photo manager. */
  T.photos = [
    { age: 0, zh: '出生啦', en: 'Hello, world' },
    { age: 1, zh: '第一步', en: 'First steps' },
    { age: 2, zh: '爱上绘本', en: 'Story time' },
    { age: 3, zh: '上幼儿园', en: 'Preschool days' },
    { age: 4, zh: '小小画家', en: 'Little artist' },
    { age: 5, zh: '学骑车', en: 'Learning to ride' },
    { age: 6, zh: '上小学', en: 'First day of school' },
    { age: 7, zh: '换牙啦', en: 'Tooth fairy visit' },
    { age: 8, zh: '去旅行', en: 'Big adventure' },
    { age: 9, zh: '登上舞台', en: 'On stage' },
    { age: 10, zh: '十岁啦', en: 'Double digits!' }
  ];

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  T.esc = esc;

  /* Bilingual text: the Chinese line, the English line right under it. */
  T.bi = function (zh, en, cls) {
    return '<span class="tu-bi ' + (cls || '') + '"><span class="zh" lang="zh-Hans">' + esc(zh).replace(/\n/g, '<br>') +
      '</span><span class="en" lang="en">' + esc(en).replace(/\n/g, '<br>') + '</span></span>';
  };

  /* ---------- icons (48 grid, stroke = currentColor) ---------- */
  var I = {
    smile: '<circle cx="24" cy="24" r="19"/><path d="M15 27c2 6 16 6 18 0"/><path d="M17 18v2M31 18v2"/>',
    cry: '<circle cx="24" cy="24" r="19"/><path d="M16 33c3-5 13-5 16 0"/><path d="M17 18v2M31 18v2"/><path d="M33 25c2 3 2 5 0 6c-2-1-2-3 0-6z" fill="currentColor"/>',
    wave: '<path d="M16 26V12M22 24V8M28 24V9M34 27V14"/><path d="M16 26l-5-5c-2-2-5 1-3 3l7 12c3 5 8 7 13 6c5-1 7-6 6-12V14"/><path d="M40 6c3 2 4 5 4 8M4 30c0 3 1 6 3 8"/>',
    heart: '<path d="M24 41C10 31 5 24 5 16c0-10 13-13 19-4c6-9 19-6 19 4c0 8-5 15-19 25z"/>',
    arms: '<circle cx="24" cy="12" r="5"/><path d="M24 18v14M24 22L11 7M24 22L37 7M24 32l-8 12M24 32l8 12"/>',
    blow: '<circle cx="18" cy="24" r="14"/><circle cx="23" cy="28" r="3"/><path d="M13 19v2M22 19v2M36 20h8M37 27h9M36 34h6"/>',
    camera: '<rect x="4" y="13" width="40" height="27" rx="6"/><circle cx="24" cy="26" r="8"/><path d="M16 13l3-6h10l3 6"/>',
    play: '<path d="M14 7l26 17L14 41z" fill="currentColor"/>',
    upload: '<path d="M24 31V7M14 16l10-10l10 10"/><path d="M6 30v8c0 2 2 4 4 4h28c2 0 4-2 4-4v-8"/>',
    check: '<path d="M8 25l11 11L41 12"/>',
    gift: '<rect x="7" y="20" width="34" height="22" rx="3"/><rect x="4" y="12" width="40" height="8" rx="3"/><path d="M24 12v30M24 12c-9 0-11-9-5-9c4 0 5 5 5 9zM24 12c9 0 11-9 5-9c-4 0-5 5-5 9z"/>',
    star: '<path d="M24 4l6 13l14 2l-10 10l2 14l-12-7l-12 7l2-14L4 19l14-2z" fill="currentColor"/>',
    girl: '<circle cx="24" cy="18" r="10"/><path d="M12 14c-6 2-6 12-2 16M36 14c6 2 6 12 2 16"/><path d="M10 44c2-9 8-12 14-12s12 3 14 12"/>',
    dad: '<circle cx="24" cy="16" r="10"/><path d="M15 12c3-6 15-6 18 0"/><path d="M8 44c2-10 8-14 16-14s14 4 16 14"/>',
    mom: '<circle cx="24" cy="16" r="9"/><path d="M14 18c-5-14 25-14 20 0c3 5 2 9 1 11M14 18c-3 5-2 9-1 11"/><path d="M8 44c2-10 8-13 16-13s14 3 16 13"/>'
  };
  T.icon = function (name) {
    return '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (I[name] || '') + '</svg>';
  };

  /* ---------- SVG filter defs: plush fur ---------- */
  T.defs = function () {
    if (document.getElementById('tu-defs') || !document.body) return;
    var s = document.createElementNS(NS, 'svg');
    s.setAttribute('id', 'tu-defs');
    s.setAttribute('width', '0'); s.setAttribute('height', '0');
    s.setAttribute('aria-hidden', 'true');
    s.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
    function fur(id, freq, scale) {
      return '<filter id="' + id + '" x="-20%" y="-20%" width="140%" height="140%" color-interpolation-filters="sRGB">' +
        '<feTurbulence type="fractalNoise" baseFrequency="' + freq + '" numOctaves="2" seed="7" result="n"/>' +
        '<feDisplacementMap in="SourceGraphic" in2="n" scale="' + scale + '" xChannelSelector="R" yChannelSelector="G" result="d"/>' +
        '<feColorMatrix in="n" type="matrix" values="0 0 0 0 0.5  0 0 0 0 0.36  0 0 0 0 0.28  0 0 0 -2.2 0.82" result="sp"/>' +
        '<feComposite in="sp" in2="d" operator="in" result="spc"/>' +
        '<feMerge><feMergeNode in="d"/><feMergeNode in="spc"/></feMerge></filter>';
    }
    s.innerHTML = fur('tu-fur', '0.7', '20') + fur('tu-fur-s', '0.55', '9');
    document.body.appendChild(s);
  };

  /* ---------- mascots: Pop (toon), Mochi (plush), Luna (star) ---------- */
  function face(mood, style, ink) {
    var ex = 17, eyes = '', mouth = '', extra = '';
    function eye(x) {
      if (style === 'toon') return '<ellipse cx="' + x + '" cy="-5" rx="6" ry="9.5" fill="' + ink + '"/><circle cx="' + (x - 2) + '" cy="-9" r="2.4" fill="#fff"/>';
      if (style === 'plush') return '<circle cx="' + x + '" cy="-4" r="4.6" fill="' + ink + '"/><circle cx="' + (x - 1.4) + '" cy="-5.6" r="1.3" fill="#fff"/>';
      return '<circle cx="' + x + '" cy="-4" r="5" fill="' + ink + '"/>';
    }
    function arc(x) { return '<path d="M' + (x - 7) + ' -3q7 -9 14 0" fill="none" stroke="' + ink + '" stroke-width="4" stroke-linecap="round"/>'; }
    if (mood === 'wink') eyes = eye(-ex) + arc(ex);
    else if (mood === 'happy' && style === 'star') eyes = arc(-ex) + arc(ex);
    else eyes = eye(-ex) + eye(ex);
    if (mood === 'wow') mouth = '<ellipse cx="0" cy="15" rx="6.5" ry="8.5" fill="' + ink + '"/>';
    else if (mood === 'cry') {
      mouth = '<path d="M-11 20q11 -11 22 0" fill="none" stroke="' + ink + '" stroke-width="4" stroke-linecap="round"/>';
      extra = '<path class="tu-tear" d="M-17 8c4 6 4 10 0 11c-4 -1 -4 -5 0 -11z" fill="var(--sky)" stroke="' + ink + '" stroke-width="1.5"/>' +
        '<path class="tu-tear" style="animation-delay:.5s" d="M17 8c4 6 4 10 0 11c-4 -1 -4 -5 0 -11z" fill="var(--sky)" stroke="' + ink + '" stroke-width="1.5"/>' +
        '<path d="M-26 -14l12 -5M26 -14l-12 -5" stroke="' + ink + '" stroke-width="3.5" stroke-linecap="round"/>';
    } else if (style === 'plush') {
      mouth = '<path d="M0 6v5M-8 12q4 6 8 -1q4 7 8 1" fill="none" stroke="' + ink + '" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><ellipse cx="0" cy="5" rx="4.5" ry="3.2" fill="var(--focus)"/>';
    } else {
      mouth = '<path d="M-13 8q13 20 26 0z" fill="' + ink + '" stroke="' + ink + '" stroke-width="3" stroke-linejoin="round"/><path d="M-6 16q6 -5 12 0q-6 6 -12 0z" fill="var(--primary)"/>';
    }
    var cheeks = '<circle cx="-29" cy="9" r="6.5" fill="var(--primary)" opacity=".6"/><circle cx="29" cy="9" r="6.5" fill="var(--primary)" opacity=".6"/>';
    return cheeks + eyes + mouth + extra;
  }
  function starPath(R, r) {
    var d = '';
    for (var i = 0; i < 10; i++) {
      var a = -Math.PI / 2 + i * Math.PI / 5, rad = i % 2 ? r : R;
      d += (i ? 'L' : 'M') + (Math.cos(a) * rad).toFixed(1) + ' ' + (Math.sin(a) * rad).toFixed(1);
    }
    return d + 'Z';
  }
  T.mascot = function (kind, mood, cls) {
    mood = mood || 'happy';
    var body = '', label = '';
    if (kind === 'plush') {
      label = 'Mochi';
      body = '<ellipse cx="0" cy="96" rx="52" ry="7" fill="var(--ink)" opacity=".14"/>' +
        '<g filter="url(#tu-fur-s)">' +
        '<ellipse cx="-27" cy="-58" rx="16" ry="42" transform="rotate(-10 -27 -58)" fill="var(--primary)"/>' +
        '<ellipse cx="27" cy="-58" rx="16" ry="42" transform="rotate(14 27 -58)" fill="var(--primary)"/>' +
        '<ellipse cx="0" cy="56" rx="43" ry="38" fill="var(--primary)"/>' +
        '<ellipse cx="-24" cy="88" rx="19" ry="11" fill="var(--primary)"/><ellipse cx="24" cy="88" rx="19" ry="11" fill="var(--primary)"/>' +
        '<ellipse cx="-42" cy="44" rx="12" ry="20" transform="rotate(24 -42 44)" fill="var(--primary)"/><ellipse cx="42" cy="44" rx="12" ry="20" transform="rotate(-24 42 44)" fill="var(--primary)"/>' +
        '<ellipse cx="0" cy="-8" rx="52" ry="45" fill="var(--primary)"/>' +
        '<ellipse cx="0" cy="62" rx="24" ry="22" fill="var(--surface)"/>' +
        '<ellipse cx="-27" cy="-56" rx="7" ry="28" transform="rotate(-10 -27 -56)" fill="var(--surface)"/>' +
        '<ellipse cx="27" cy="-56" rx="7" ry="28" transform="rotate(14 27 -56)" fill="var(--surface)"/></g>' +
        '<ellipse cx="-18" cy="-30" rx="22" ry="10" fill="#fff" opacity=".28"/>' +
        '<g transform="translate(0 -4)">' + face(mood, 'plush', 'var(--ink)') + '</g>';
    } else if (kind === 'star') {
      label = 'Luna';
      body = '<ellipse cx="0" cy="6" rx="94" ry="24" transform="rotate(-18)" fill="none" stroke="var(--primary)" stroke-width="7"/>' +
        '<circle cx="0" cy="0" r="62" fill="var(--sun)"/>' +
        '<path d="M-44 -44a62 62 0 0 1 88 0a70 70 0 0 0 -88 0z" fill="#fff" opacity=".45"/>' +
        '<path d="M-89 35A94 24 -18 0 0 89 -23" fill="none" stroke="var(--primary)" stroke-width="7" stroke-linecap="round"/>' +
        '<g fill="var(--sky)"><path transform="translate(-74 -66) scale(.2)" d="' + starPath(60, 26) + '"/><path transform="translate(78 -54) scale(.14)" d="' + starPath(60, 26) + '"/><path transform="translate(70 70) scale(.17)" d="' + starPath(60, 26) + '"/></g>' +
        '<g transform="translate(0 2) scale(1.1)">' + face(mood, 'star', 'var(--on-pop)') + '</g>';
    } else {
      label = 'Pop';
      var sp = starPath(92, 52);
      body = '<path d="' + sp + '" transform="translate(9 9)" fill="var(--ink)" stroke="var(--ink)" stroke-width="16" stroke-linejoin="round"/>' +
        '<path d="' + sp + '" fill="var(--sun)" stroke="var(--ink)" stroke-width="16" stroke-linejoin="round"/>' +
        '<path d="' + sp + '" fill="var(--sun)"/>' +
        '<path d="M-30 -40q14 -16 34 -18" fill="none" stroke="#fff" stroke-width="7" stroke-linecap="round" opacity=".8"/>' +
        '<g transform="translate(0 10) scale(1.2)">' + face(mood, 'toon', 'var(--ink)') + '</g>';
    }
    return '<svg class="tu-mascot ' + (cls || '') + '" viewBox="-110 -110 220 220" role="img" aria-label="' + label + ' — ' + mood + '">' + body + '</svg>';
  };
  T.mascotFor = function (theme, mood, cls) { return T.mascot(theme === 'plush' ? 'plush' : theme === 'star' ? 'star' : 'toon', mood, cls); };

  /* ---------- markup builders ---------- */
  T.button = function (zh, en, o) {
    o = o || {};
    return '<button type="button" class="tu-btn' + (o.primary ? ' tu-btn--primary' : '') + (o.cls ? ' ' + o.cls : '') + '"' + (o.act ? ' data-act="' + o.act + '"' : '') + '>' +
      (o.icon ? T.icon(o.icon) : '') + T.bi(zh, en) + '</button>';
  };
  T.age = function (n) { return '<span class="tu-age"><b>' + n + '</b>' + T.bi('岁', n === 1 ? 'yr' : 'yrs') + '</span>'; };
  T.placeholder = function (p) {
    return '<div class="tu-ph tu-ph--' + (p.age % 5) + '"><span class="tu-ph__n">' + p.age + '</span>' +
      '<span class="tu-ph__t"><span lang="zh-Hans">照片占位</span><br><span lang="en">Photo placeholder</span></span></div>';
  };
  T.photoCard = function (p, cls) {
    return '<figure class="tu-photo ' + (cls || '') + '"><div class="tu-photo__img">' +
      (p.src ? '<img alt="' + esc(p.zh + ' ' + p.en) + '" src="' + esc(p.src) + '">' : T.placeholder(p)) +
      '</div><figcaption class="tu-photo__cap">' + T.bi(p.zh, p.en, 'tu-label') + T.age(p.age) + '</figcaption></figure>';
  };
  T.modeCard = function (kind, cls) {
    var b = kind === 'watch';
    return '<button type="button" class="tu-mode' + (b ? ' tu-mode--b' : '') + (cls ? ' ' + cls : '') + '" data-act="mode" data-mode="' + (b ? 'watch' : 'interactive') + '">' +
      '<span class="tu-mode__ico">' + T.icon(b ? 'play' : 'camera') + '</span>' +
      (b ? T.bi('观看模式', 'Just watch', 'tu-label') + T.bi('坐好啦，照片自己播放', 'Sit back — the photos play by themselves', 'tu-body')
         : T.bi('互动模式', 'Interactive', 'tu-label') + T.bi('对着镜头笑一笑、挥挥手、摆个姿势', 'Smile, wave or strike a pose for the camera', 'tu-body')) +
      '</button>';
  };
  T.cues = [
    { id: 'smile', icon: 'smile', zh: '笑一笑', en: 'Smile', does: ['撒彩带', 'Confetti'] },
    { id: 'cry', icon: 'cry', zh: '装哭脸', en: 'Sad face', does: ['求抱抱', 'Gets a hug'] },
    { id: 'wave', icon: 'wave', zh: '挥挥手', en: 'Wave', does: ['下一张', 'Next photo'] },
    { id: 'heart', icon: 'heart', zh: '比个心', en: 'Heart hands', does: ['送爱心', 'Hearts'] },
    { id: 'arms', icon: 'arms', zh: '举高手', en: 'Arms up', does: ['去许愿', 'To the cake'] }
  ];
  T.cue = function (c, o) {
    o = o || {};
    return '<button type="button" class="tu-cue' + (o.on ? ' is-on' : '') + '" data-act="cue" data-cue="' + c.id + '"' + (o.p != null ? ' style="--p:' + o.p + '"' : '') + '>' +
      '<span class="tu-cue__ico">' + T.icon(o.on ? 'check' : c.icon) + '</span>' + T.bi(o.on ? c.does[0] : c.zh, o.on ? c.does[1] : c.en) + '</button>';
  };
  T.rail = function (cur, n) {
    var h = '<div class="tu-rail" role="list">';
    for (var i = 0; i < (n || 11); i++) h += '<span role="listitem" class="tu-rail__dot' + (i < cur ? ' is-done' : i === cur ? ' is-current' : '') + '" data-act="go" data-i="' + i + '"' + (i === cur ? ' aria-current="true"' : '') + '>' + i + '</span>';
    return h + '</div>';
  };
  T.gift = function (theme, open) {
    return '<div class="tu-giftscene' + (open ? ' is-open' : '') + '" data-act="gift"><div class="tu-gift__light"></div>' +
      '<div class="tu-gift__baby">' + T.mascotFor(theme, 'happy') + '</div>' +
      '<div class="tu-gift"><div class="tu-gift__f tu-gift__f--back"></div><div class="tu-gift__f tu-gift__f--left"></div><div class="tu-gift__f tu-gift__f--bottom"></div>' +
      '<div class="tu-gift__f tu-gift__f--right"></div><div class="tu-gift__f tu-gift__f--front"></div><div class="tu-gift__lid"><i></i></div></div></div>';
  };
  T.ages = function (age) {
    age = age == null ? 10 : age;
    function card(icon, n, plus, zh, en, nz, ne) {
      return '<div class="tu-agecard"><span class="tu-agecard__chip">' + T.icon(icon) + '</span>' +
        '<div class="tu-agecard__n">' + n + (plus ? '<small>' + plus + '</small>' : '') + '</div>' +
        T.bi(zh, en, 'tu-label tu-bi--center') + T.bi(nz, ne, 'tu-body tu-bi--center') + '</div>';
    }
    return '<div class="tu-ages">' +
      card('girl', age, '', '你', 'You', '今天满 ' + age + ' 岁', 'Turning ' + age + ' today') +
      card('dad', age, '', '爸爸', 'Dad', '你出生那天，他才当上爸爸', 'He became a dad the day you were born') +
      card('mom', age + 1, '+1', '妈妈', 'Mom', '你在妈妈肚子里住了十个月', 'You lived in her tummy for ten months first') + '</div>';
  };
  T.together = function () {
    function row(zh, en, w, fz, fe, nz, ne) {
      return '<div class="tu-together__row">' + T.bi(zh, en, 'tu-label') +
        '<div class="tu-together__track" style="--w:' + w + '"><div class="tu-together__fill">' + (fz ? T.bi(fz, fe) : '') + '</div>' +
        (nz ? T.bi(nz, ne, 'tu-body tu-together__note') : '') + '</div></div>';
    }
    return '<div class="tu-together">' +
      row('0 – 10 岁', 'Ages 0–10', 100, '十年，天天在一起', 'Ten years, together every day') +
      row('10 – 20 岁', 'Ages 10–20', 50, '大约五年', 'About five years', '你要上学，还会有自己的好朋友', 'You have school, and good friends of your own') +
      row('上大学、工作以后', 'University, then work', 34, '', '', '会慢慢变少，就像爸爸妈妈和外公外婆、爷爷奶奶', 'A little less each year — like Mom and Dad with your grandparents') + '</div>';
  };
  T.cake = function (out, n) {
    var c = '';
    for (var i = 0; i < (n || 10); i++) c += '<i class="tu-candle"><b></b></i>';
    return '<div class="tu-cake' + (out ? ' is-out' : '') + '" data-act="blow"><div class="tu-cake__candles">' + c + '</div>' +
      '<div class="tu-cake__tier tu-cake__tier--top"></div><div class="tu-cake__tier tu-cake__tier--base"></div><div class="tu-cake__plate"></div></div>';
  };
  T.hint = function (items) {
    return '<div class="tu-hint">' + items.map(function (it) {
      return '<span class="tu-hint__i"><span class="tu-key">' + it[0] + '</span>' + T.bi(it[1], it[2]) + '</span>';
    }).join('') + '</div>';
  };

  /* ---------- three-up comparison (component previews) ---------- */
  T.tri = function (root, render, o) {
    o = o || {};
    T.defs();
    root.className = 'tu-tri';
    root.innerHTML = T.plans.map(function (p) {
      return '<section class="tu-panel" data-theme="' + p.id + '"><div class="tu-panel__h"><b>' + p.key + ' · ' + p.zh + '</b><span lang="en">' + p.en + '</span></div>' +
        '<div class="tu-panel__b"><div class="tu-zoom"' + (o.zoom ? ' style="zoom:' + o.zoom + '"' : '') + '>' + render(p.id, p) + '</div></div></section>';
    }).join('');
  };

  /* ---------- stage fit: scale the 1920×1080 stage to its box ---------- */
  T.fit = function (stage, box) {
    box = box || stage.parentNode;
    function f() {
      var s = box.clientWidth / 1920;
      stage.style.transform = 'scale(' + s + ')';
      box.style.height = Math.round(1080 * s) + 'px';
    }
    f();
    window.addEventListener('resize', f);
    return f;
  };
  T.themeOf = function (el) {
    var t = el.closest ? el.closest('[data-theme]') : null;
    return (t && t.getAttribute('data-theme')) || 'plush';
  };

  /* ---------- 3D gallery: one engine, three layouts ---------- */
  var LAYOUT = {
    /* A · pop-up coverflow: neighbours fold back like comic panels */
    toon: function (d) {
      var a = Math.abs(d), s = d < 0 ? -1 : 1;
      if (!d) return { x: 0, y: -10, z: 120, ry: 0, rz: -2, sc: 1.12, o: 1 };
      return { x: s * (300 + a * 250), y: 20 + a * 8, z: -a * 230, ry: -s * 46, rz: s * 3, sc: 1, o: a > 3 ? 0 : 1 };
    },
    /* B · carousel ring: pillows on a merry-go-round */
    plush: function (d, i, n) {
      if (d > n / 2) d -= n; if (d < -n / 2) d += n;
      var a = Math.abs(d);
      return { ring: d * (360 / n), R: 1010, x: 0, y: d ? 14 : -6, z: 0, ry: 0, rz: 0, sc: d ? 0.94 : 1.1, o: a > 3 ? 0 : 1 };
    },
    /* C · time tunnel: the years fly toward you out of the night */
    star: function (d, i) {
      var side = i % 2 ? 1 : -1;
      if (d < 0) return { x: side * 1100, y: -160, z: 1000, ry: 0, rz: 0, sc: 1, o: 0 };
      if (!d) return { x: 0, y: 0, z: 150, ry: 0, rz: 0, sc: 1.1, o: 1 };
      return { x: side * (640 + d * 170), y: (d % 2 ? -1 : 1) * (30 + d * 80) - 60, z: -d * 700, ry: -side * 18, rz: 0, sc: 1, o: d > 5 ? 0 : 1 - d * 0.1 };
    }
  };
  T.gallery = function (root, o) {
    o = o || {};
    T.defs();
    var photos = o.photos || T.photos, cur = o.start || 0, cards = [];
    root.classList.add('tu-gal');
    function build() {
      root.innerHTML = photos.map(function (p) { return T.photoCard(p, 'tu-gal__card'); }).join('');
      cards = [].slice.call(root.children);
      cards.forEach(function (c, i) { c.addEventListener('click', function () { api.go(i); }); });
    }
    function layout() {
      var fn = LAYOUT[T.themeOf(root)] || LAYOUT.plush, n = cards.length;
      cards.forEach(function (c, i) {
        var d = i - cur, s = fn(d, i, n);
        var t = 'translate(-50%,-50%) ';
        if (s.ring != null) t += 'translateZ(' + (-s.R) + 'px) rotateY(' + s.ring + 'deg) translateZ(' + s.R + 'px) ';
        t += 'translate3d(' + s.x + 'px,' + s.y + 'px,' + s.z + 'px) rotateY(' + s.ry + 'deg) rotateZ(' + s.rz + 'deg) scale(' + s.sc + ')';
        c.style.transform = t;
        c.style.opacity = s.o;
        c.style.zIndex = 100 - Math.abs(s.ring != null ? Math.round(s.ring / (360 / n)) : d);
        c.style.pointerEvents = s.o < 0.05 ? 'none' : '';
        c.classList.toggle('is-current', !d);
        c.setAttribute('aria-hidden', d ? 'true' : 'false');
      });
    }
    var api = {
      go: function (i) {
        var n = cards.length;
        cur = ((i % n) + n) % n;
        layout();
        if (o.onChange) o.onChange(cur, photos[cur]);
      },
      next: function () { api.go(cur + 1); },
      prev: function () { api.go(cur - 1); },
      layout: layout,
      index: function () { return cur; },
      setPhotos: function (p) { photos = p; build(); layout(); }
    };
    build(); layout();
    return api;
  };

  /* ---------- particles ---------- */
  var HEART = '<svg viewBox="0 0 48 48"><path fill="currentColor" d="M24 41C10 31 5 24 5 16c0-10 13-13 19-4c6-9 19-6 19 4c0 8-5 15-19 25z"/></svg>';
  var STAR = '<svg viewBox="0 0 48 48"><path fill="currentColor" d="M24 4l6 13l14 2l-10 10l2 14l-12-7l-12 7l2-14L4 19l14-2z"/></svg>';
  var DROP = '<svg viewBox="0 0 48 48"><path fill="currentColor" d="M24 4c12 16 14 26 0 40c-14-14-12-24 0-40z"/></svg>';
  T.burst = function (host, kind, n) {
    var calm = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    n = calm ? 8 : (n || 46);
    var W = host.offsetWidth || 1920, H = host.offsetHeight || 1080;
    var cols = ['var(--primary)', 'var(--sky)', 'var(--sun)', 'var(--mint)', 'var(--grape)'];
    var fx = document.createElement('div'), h = '';
    fx.className = 'tu-fx';
    for (var i = 0; i < n; i++) {
      var r = Math.random, x0, y0, dx, dy, s, inner = '', cls = '', c = cols[i % 5], t = 1.4 + r() * 1.2;
      if (kind === 'hearts') { x0 = W * (0.3 + r() * 0.4); y0 = H * 0.8; dx = (r() - 0.5) * W * 0.7; dy = -H * (0.5 + r() * 0.4); s = 40 + r() * 70; inner = HEART; c = i % 3 ? 'var(--primary)' : 'var(--sun)'; }
      else if (kind === 'tears') { x0 = W * r(); y0 = -40; dx = 0; dy = H * (0.6 + r() * 0.5); s = 26 + r() * 30; inner = DROP; c = 'var(--sky)'; }
      else if (kind === 'fireworks') { var a = r() * 6.283, d = 200 + r() * 520; x0 = W * (0.2 + (i % 3) * 0.3); y0 = H * (0.3 + (i % 2) * 0.12); dx = Math.cos(a) * d; dy = Math.sin(a) * d; s = 24 + r() * 44; inner = STAR; }
      else { x0 = W * r(); y0 = -40; dx = (r() - 0.5) * 300; dy = H * (0.7 + r() * 0.5); s = 18 + r() * 26; cls = 'r'; }
      h += '<i class="' + cls + '" style="--x0:' + x0.toFixed(0) + 'px;--y0:' + y0.toFixed(0) + 'px;--dx:' + dx.toFixed(0) + 'px;--dy:' + dy.toFixed(0) + 'px;--s:' + s.toFixed(0) + 'px;--c:' + c + ';--t:' + t.toFixed(2) + 's;--dl:' + (r() * 0.5).toFixed(2) + 's;--rot:' + ((r() - 0.5) * 900).toFixed(0) + 'deg">' + inner + '</i>';
    }
    fx.innerHTML = h;
    host.appendChild(fx);
    setTimeout(function () { if (fx.parentNode) fx.parentNode.removeChild(fx); }, 3400);
  };
  T.toast = function (host, zh, en) {
    var old = host.querySelector('.tu-toast');
    if (old) old.parentNode.removeChild(old);
    var t = document.createElement('div');
    t.className = 'tu-toast';
    t.setAttribute('role', 'status');
    t.innerHTML = T.bi(zh, en, 'tu-bi--center');
    host.appendChild(t);
    setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 2300);
  };

  /* ---------- photo store: this browser only (IndexedDB), memory as fallback ---------- */
  var mem = {};
  function db() {
    return new Promise(function (res, rej) {
      try {
        var rq = indexedDB.open('tenup', 1);
        rq.onupgradeneeded = function () { rq.result.createObjectStore('kv'); };
        rq.onsuccess = function () { res(rq.result); };
        rq.onerror = function () { rej(rq.error); };
      } catch (e) { rej(e); }
    });
  }
  T.store = {
    persistent: true,
    get: function (key) {
      return db().then(function (d) {
        return new Promise(function (res, rej) {
          var rq = d.transaction('kv').objectStore('kv').get(key);
          rq.onsuccess = function () { res(rq.result == null ? null : rq.result); };
          rq.onerror = function () { rej(rq.error); };
        });
      }).catch(function () { T.store.persistent = false; return mem[key] == null ? null : mem[key]; });
    },
    set: function (key, val) {
      mem[key] = val;
      return db().then(function (d) {
        return new Promise(function (res, rej) {
          var tx = d.transaction('kv', 'readwrite');
          tx.objectStore('kv').put(val, key);
          tx.oncomplete = function () { res(true); };
          tx.onerror = function () { rej(tx.error); };
        });
      }).catch(function () { T.store.persistent = false; return false; });
    },
    load: function () { return T.store.get('photos'); },
    save: function (list) { return T.store.set('photos', list); }
  };
  /* Saved photos over the defaults, one per age. */
  T.loadPhotos = function () {
    return T.store.load().then(function (saved) {
      return T.photos.map(function (p) {
        var s = saved && saved.filter(function (x) { return x.age === p.age; })[0];
        return s ? { age: p.age, zh: s.zh || p.zh, en: s.en || p.en, src: s.src || '' } : { age: p.age, zh: p.zh, en: p.en, src: '' };
      });
    });
  };
  /* A picked file → a JPEG data URL no larger than `max` px on its long side. */
  T.readImage = function (file, max) {
    max = max || 1600;
    return new Promise(function (res, rej) {
      if (!file || !/^image\//.test(file.type)) { rej(new Error('not an image')); return; }
      var url = URL.createObjectURL(file), img = new Image();
      img.onload = function () {
        var k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
        var c = document.createElement('canvas');
        c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        try { res(c.toDataURL('image/jpeg', 0.86)); } catch (e) { rej(e); }
      };
      img.onerror = function () { URL.revokeObjectURL(url); rej(new Error('cannot read image')); };
      img.src = url;
    });
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', T.defs); else T.defs();
  window.TenUp = T;
})();
