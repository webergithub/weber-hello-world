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
    swipe: '<g transform="translate(7 -3) scale(.78)" stroke-width="5"><path d="M16 26V12M22 24V8M28 24V9M34 27V14"/><path d="M16 26l-5-5c-2-2-5 1-3 3l7 12c3 5 8 7 13 6c5-1 7-6 6-12V14"/></g><path d="M40 42H9M15 36l-6 6l6 5"/>',
    palms: '<g transform="translate(-4 8) scale(.62)" stroke-width="6"><path d="M16 26V12M22 24V8M28 24V9M34 27V14"/><path d="M16 26l-5-5c-2-2-5 1-3 3l7 12c3 5 8 7 13 6c5-1 7-6 6-12V14"/></g><g transform="translate(52 8) scale(-.62 .62)" stroke-width="6"><path d="M16 26V12M22 24V8M28 24V9M34 27V14"/><path d="M16 26l-5-5c-2-2-5 1-3 3l7 12c3 5 8 7 13 6c5-1 7-6 6-12V14"/></g>',
    fist: '<path d="M12 23c0-5 6-5 6 0M18 22c0-6 6-6 6 0M24 22c0-6 6-6 6 0M30 23c0-5 6-5 6 0"/><path d="M12 23v8c0 8 5 12 12 12s12-5 12-12v-8"/><path d="M12 30c5-4 10-3 13 1"/>',
    /* pictures for the names of the ages */
    book: '<path d="M24 12c-5-4-12-4-18-2v28c6-2 13-2 18 2c5-4 12-4 18-2V10c-6-2-13-2-18 2z"/><path d="M24 12v28"/>',
    bud: '<path d="M24 44V24"/><path d="M24 24c-7-3-8-12 0-19c8 7 7 16 0 19z"/><path d="M24 36c-6 0-10-3-11-8c6 0 10 3 11 8zM24 32c5 0 8-3 9-7c-5 0-8 3-9 7z"/>',
    hairpin: '<circle cx="24" cy="15" r="9"/><path d="M9 45c0-13 6-21 15-21s15 8 15 21"/><path d="M7 9l33 9"/><circle cx="42" cy="19" r="3" fill="currentColor"/>',
    cap: '<path d="M13 34V21c0-9 22-9 22 0v13"/><path d="M8 34h32M5 23h38"/><path d="M19 34v8M29 34v8"/>',
    stand: '<circle cx="24" cy="9" r="5"/><path d="M24 15v15M24 20l-10 6M24 20l10 6M24 30l-8 12M24 30l8 12M6 43h36"/>',
    compass: '<circle cx="24" cy="24" r="19"/><path d="M31 17l-4 10l-10 4l4-10z"/><path d="M24 5v4M24 39v4M5 24h4M39 24h4"/>',
    skystar: '<path d="M24 4l3 7l8 1l-6 5l2 8l-7-4l-7 4l2-8l-6-5l8-1z"/><path d="M4 43l11-13l7 7l6-6l16 12z"/>',
    cycle: '<circle cx="24" cy="24" r="19"/><circle cx="24" cy="24" r="5"/><path d="M24 5v6M24 37v6M5 24h6M37 24h6M10.5 10.5l4 4M33.5 33.5l4 4M37.5 10.5l-4 4M14.5 33.5l-4 4"/>',
    pine: '<path d="M24 4L13 18h6L9 30h9L8 40h32L30 30h9L29 18h6z"/><path d="M24 40v5"/>',
    blossom: '<circle cx="24" cy="22" r="4.5"/><path d="M24 17.5c-3-7 3-12 6-8c2 3 0 6-6 8zM28.3 20.6c5-5 12-2 10 3c-1.5 3-5 3-10-3zM26.6 25.7c6 3 6 10 1 10c-3 0-4-4-1-10zM21.4 25.7c-6 3-6 10-1 10c3 0 4-4 1-10zM19.7 20.6c-5-5-12-2-10 3c1.5 3 5 3 10-3z"/><path d="M24 36v8M24 41c-4 0-7-2-8-5"/>',
    bowl: '<path d="M6 24h36c0 10-8 16-18 16S6 34 6 24z"/><path d="M15 40h18"/><path d="M17 7c-2 3 2 5 0 9M24 5c-2 3 2 5 0 9M31 7c-2 3 2 5 0 9"/>',
    swaddle: '<circle cx="24" cy="15" r="7"/><path d="M15 17c-5 8-4 21 9 27c13-6 14-19 9-27"/><path d="M15 29l18-7M16 37l16-6"/>',
    carry: '<circle cx="24" cy="12" r="6"/><path d="M17 31c0-7 3-11 7-11s7 4 7 11z"/><path d="M5 28c5 0 9 3 12 3M43 28c-5 0-9 3-12 3"/><path d="M20 31v9M28 31v9"/>',
    buns: '<circle cx="24" cy="26" r="11"/><path d="M17 16c-5-1-8-6-5-9c3-2 6 1 6 5M31 16c5-1 8-6 5-9c-3-2-6 1-6 5"/><path d="M13.5 24c-3 6-3 13-1 19M34.5 24c3 6 3 13 1 19"/><path d="M20 30c2 2 6 2 8 0"/><path d="M19.5 24.5h.5M28 24.5h.5"/>',
    tooth: '<path d="M14 7c4-2 7 1 10 1s6-3 10-1c6 3 5 12 2 18c-2 5-2 15-6 15c-3 0-3-10-6-10s-3 10-6 10c-4 0-4-10-6-15C9 19 8 10 14 7z"/>',
    goldpin: '<circle cx="24" cy="10" r="5"/><path d="M19 10h-4M33 10h-4"/><path d="M24 15v4M19 19h10M21 19l-3 25M27 19l3 25"/>',
    jade: '<circle cx="24" cy="28" r="15"/><circle cx="24" cy="28" r="5"/><path d="M24 13V5M19 5h10"/>',
    flowerwind: '<circle cx="31" cy="19" r="4"/><path d="M31 11c3-5 9-2 6 3M39 19c5 2 3 8-2 6M31 27c-1 5-7 4-6-1M23 19c-5-2-3-8 2-6"/><path d="M31 27v17"/><path d="M4 14h12M2 22h10M4 30h12"/>',
    cane: '<path d="M14 13c0-5 4-9 9-9s9 4 9 9"/><path d="M32 13v30"/><path d="M27 43h10"/><path d="M14 13v3"/>',
    fish: '<path d="M5 25c6-11 21-13 31-4l8-6v20l-8-6c-10 9-25 7-31-4z"/><circle cx="13" cy="23" r="1.6" fill="currentColor"/><path d="M19 17.5h.5M24.5 16h.5M30 17.5h.5M22 21h.5M27.5 20.5h.5"/>',
    peach: '<path d="M24 43C9 39 6 23 16 15c3-2 6-2 8 0c2-2 5-2 8 0c10 8 7 24-8 28z"/><path d="M24 15c0-5 3-9 9-10c0 5-3 9-9 10zM24 15v14"/>',
    heart: '<path d="M24 41C10 31 5 24 5 16c0-10 13-13 19-4c6-9 19-6 19 4c0 8-5 15-19 25z"/>',
    arms: '<circle cx="24" cy="12" r="5"/><path d="M24 18v14M24 22L11 7M24 22L37 7M24 32l-8 12M24 32l8 12"/>',
    blow: '<circle cx="18" cy="24" r="14"/><circle cx="23" cy="28" r="3"/><path d="M13 19v2M22 19v2M36 20h8M37 27h9M36 34h6"/>',
    camera: '<rect x="4" y="13" width="40" height="27" rx="6"/><circle cx="24" cy="26" r="8"/><path d="M16 13l3-6h10l3 6"/>',
    play: '<path d="M14 7l26 17L14 41z" fill="currentColor"/>',
    video: '<rect x="4" y="12" width="28" height="24" rx="5"/><path d="M32 21l12-7v20l-12-7z"/>',
    images: '<rect x="4" y="9" width="40" height="30" rx="5"/><circle cx="16" cy="19" r="4"/><path d="M5 35l12-11l9 8l6-5l11 9"/>',
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

  /* ---------- screen codes ----------
     Every main screen has a code and a name (P01 开场 …), listed in docs/screens.html. With ?labels or #labels in the
     address, T.tag shows the current one in a corner so people can say which screen they mean. */
  T.labels = /[?&#]labels\b/.test(location.search + location.hash);
  T.tag = function (code, zh, en, host) {
    if (!T.labels || !document.body) return;
    var el = document.getElementById('tu-tag');
    if (!el) { el = document.createElement('div'); el.id = 'tu-tag'; el.className = 'tu-tag'; }
    var to = host || document.body;
    if (el.parentNode !== to) to.appendChild(el);
    el.innerHTML = '<b>' + esc(code) + '</b>' + T.bi(zh, en);
  };

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
  /* a video is kept as a still picture (src, shown until it plays) plus the video itself (video) */
  T.photoCard = function (p, cls) {
    return '<figure class="tu-photo ' + (cls || '') + (p.video ? ' has-video' : '') + '"><div class="tu-photo__img">' +
      (p.src ? '<img alt="' + esc(p.zh + ' ' + p.en) + '" src="' + esc(p.src) + '">' : T.placeholder(p)) +
      (p.video ? '<span class="tu-photo__vid" aria-hidden="true">' + T.icon('play') + '</span>' : '') +
      '</div><figcaption class="tu-photo__cap">' + T.bi(p.zh, p.en, 'tu-label') + T.age(p.age) + '</figcaption></figure>';
  };
  T.modeCard = function (kind, cls) {
    var b = kind === 'watch';
    return '<button type="button" class="tu-mode' + (b ? ' tu-mode--b' : '') + (cls ? ' ' + cls : '') + '" data-act="mode" data-mode="' + (b ? 'watch' : 'interactive') + '">' +
      '<span class="tu-mode__ico">' + T.icon(b ? 'play' : 'camera') + '</span>' +
      (b ? T.bi('观看模式', 'Just watch', 'tu-label') + T.bi('和爸爸妈妈靠在一起，慢慢看', 'Snuggle up with Mom and Dad and just watch', 'tu-body')
         : T.bi('互动模式', 'Interactive', 'tu-label') + T.bi('对着镜头笑一笑、挥挥手、摆个姿势', 'Smile, wave or strike a pose for the camera', 'tu-body')) +
      '</button>';
  };
  /* The album's gestures. Other chapters arm a subset; inside one year's album it is swipe + fist. */
  T.cues = [
    { id: 'smile', icon: 'smile', zh: '笑一笑', en: 'Smile', does: ['撒彩带', 'Confetti'] },
    { id: 'cry', icon: 'cry', zh: '装哭脸', en: 'Sad face', does: ['求抱抱', 'Gets a hug'] },
    { id: 'swipe', icon: 'swipe', zh: '向左挥手', en: 'Swipe left', does: ['下一张', 'Next photo'] },
    { id: 'heart', icon: 'heart', zh: '比个心', en: 'Heart hands', does: ['送爱心', 'Hearts'] },
    { id: 'palms', icon: 'palms', zh: '张开双手', en: 'Both palms open', does: ['看这一年', 'This year\u2019s photos'] }
  ];
  T.yearCues = [
    { id: 'swipe', icon: 'swipe', zh: '向左挥手', en: 'Swipe left', does: ['下一张', 'Next photo'] },
    { id: 'fist', icon: 'fist', zh: '握个拳', en: 'Make a fist', does: ['回到相册', 'Back to the album'] }
  ];
  /* One year's photos: the cover first, then the extras. */
  T.yearPhotos = function (p) {
    return [p].concat((p.more || []).map(function (src, j) { return { age: p.age, zh: p.zh, en: p.en, src: src, video: (p.moreVideos || [])[j] || '', note: (p.moreNotes || [])[j] || null }; }));
  };
  T.cue = function (c, o) {
    o = o || {};
    return '<button type="button" class="tu-cue' + (o.on ? ' is-on' : '') + '" data-act="cue" data-cue="' + c.id + '"' + (o.p != null ? ' style="--p:' + o.p + '"' : '') + '>' +
      '<span class="tu-cue__ico">' + T.icon(o.on ? 'check' : c.icon) + '</span>' + T.bi(o.on ? c.does[0] : c.zh, o.on ? c.does[1] : c.en) + '</button>';
  };
  /* n: how many dots (labelled 0…n-1), or an array of labels */
  T.rail = function (cur, n) {
    var labels = n && n.length ? n : null, count = labels ? labels.length : (n || 11), h = '<div class="tu-rail" role="list">';
    for (var i = 0; i < count; i++) h += '<span role="listitem" class="tu-rail__dot' + (i < cur ? ' is-done' : i === cur ? ' is-current' : '') + '" data-act="go" data-i="' + i + '"' + (i === cur ? ' aria-current="true"' : '') + '>' + (labels ? labels[i] : i) + '</span>';
    return h + '</div>';
  };
  T.gift = function (theme, open) {
    return '<div class="tu-giftscene' + (open ? ' is-open' : '') + '" data-act="gift"><div class="tu-gift__light"></div>' +
      '<div class="tu-gift__baby">' + T.mascotFor(theme, 'happy') + '</div>' +
      '<div class="tu-gift"><div class="tu-gift__f tu-gift__f--back"></div><div class="tu-gift__f tu-gift__f--left"></div><div class="tu-gift__f tu-gift__f--bottom"></div>' +
      '<div class="tu-gift__f tu-gift__f--right"></div><div class="tu-gift__f tu-gift__f--front"></div><div class="tu-gift__lid"><i></i></div></div></div>';
  };
  /* avatars: { girl, dad, mom } image URLs; a missing one shows its drawn icon as the placeholder */
  T.ages = function (age, avatars) {
    age = age == null ? 10 : age;
    avatars = avatars || {};
    function card(who, n, plus, zh, en, nz, ne) {
      return '<div class="tu-agecard"><span class="tu-agecard__chip">' + (avatars[who] ? '<img alt="" src="' + esc(avatars[who]) + '">' : T.icon(who)) + '</span>' +
        '<div class="tu-agecard__n">' + n + (plus ? '<small>' + plus + '</small>' : '') + '</div>' +
        T.bi(zh, en, 'tu-label tu-bi--center') + T.bi(nz, ne, 'tu-body tu-bi--center') + '</div>';
    }
    return '<div class="tu-ages">' +
      card('girl', age, '', '你', 'You', '今天，你十岁啦', 'Today you turn ten!') +
      card('dad', age, '', '爸爸', 'Dad', '你来那天，他才学着当爸爸', 'He began learning to be a dad the day you came') +
      card('mom', age + 1, '+1', '妈妈', 'Mom', '你在妈妈肚子里住了十个月', 'You lived in her tummy for ten months first') + '</div>';
  };
  T.together = function () {
    function row(zh, en, w, fz, fe, nz, ne) {
      return '<div class="tu-together__row">' + T.bi(zh, en, 'tu-label') +
        '<div class="tu-together__track" style="--w:' + w + '"><div class="tu-together__fill">' + (fz ? T.bi(fz, fe) : '') + '</div>' +
        (nz ? T.bi(nz, ne, 'tu-body tu-together__note') : '') + '</div></div>';
    }
    return '<div class="tu-together">' +
      row('0 – 10 岁', 'Ages 0–10', 100, '三千六百多天，天天在一起', 'More than 3,600 days, together every day') +
      row('10 – 20 岁', 'Ages 10–20', 50, '大约五年', 'About five years', '你会去上学，也会交到好多好朋友', 'You will be at school, making lots of good friends') +
      row('上大学、工作以后', 'University, then work', 34, '', '', '你会越飞越远，就像爸爸妈妈离开爷爷奶奶、外公外婆', 'You will fly farther — as Mom and Dad did from your grandparents') + '</div>';
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


  /* ---------- the names of the ages 年岁的名字 ----------
     Traditional Chinese names for the stages of life, from a baby's third day to a hundred.
     `who` marks a name used only for girls; `boy` gives the boys' name for the same age, for comparison;
     `at` is the age on the badge when it is not a plain number of years; `tag` is the label on the rail;
     `here` is the age she is now. */
  T.ageNames = [
    { age: 0, tag: '3天', at: ['3', '天', 'days'], zh: '汤饼之期', py: 'Tāngbǐng zhī qī', en: 'The noodle-feast day', icon: 'bowl',
      mz: '你出生的第三天，家里煮汤饼请客，为你庆贺', me: 'On your third day, the family made noodle soup for everyone to celebrate you',
      fz: '旧时婴儿出生三日，家中设汤饼宴庆贺，这一天叫汤饼之期', fe: 'An old custom: a noodle-soup feast on a baby’s third day' },
    { age: 0, tag: '0–1', at: ['0–1', '岁', 'yr'], zh: '襁褓', py: 'Qiǎngbǎo', en: 'In swaddling clothes', icon: 'swaddle',
      mz: '小小的你被包在软软的小被子里，抱在爸爸妈妈怀里', me: 'Tiny you, wrapped in a soft little blanket, held in Mom and Dad’s arms',
      fz: '原指包裹婴儿的被带，后来借指婴儿和婴儿时期', fe: 'First the cloth that wraps a baby, then the baby years themselves' },
    { age: 2, tag: '2–3', at: ['2–3', '岁', 'yrs'], zh: '孩提', py: 'Háití', en: 'Small enough to carry', icon: 'carry',
      mz: '两三岁，还要大人抱着、牵着的小娃娃', me: 'Two or three: little enough to be carried and led by the hand',
      fz: '指还可以由大人提抱的孩子；今天说“孩提时代”，也泛指童年', fe: 'A child grown-ups can still pick up; “childhood days” today' },
    { age: 4, tag: '童年', at: ['童年', '', 'childhood'], zh: '垂髫', py: 'Chuítiáo', en: 'Hair hanging loose', icon: 'buns',
      mz: '小时候头发自然垂下来；扎成两个小髻，就叫“总角”', me: 'Little ones wore their hair down — or in two small buns, called zongjiao',
      fz: '都来自儿童的发式。“总角之交”就是小时候认识的好朋友', fe: 'Both come from children’s hairstyles; a “zongjiao friend” is a friend from childhood' },
    { age: 7, tag: '7–8', at: ['7–8', '岁', 'yrs'], zh: '始龀', py: 'Shǐchèn', en: 'Losing the first teeth', icon: 'tooth',
      mz: '七八岁，乳牙一颗颗掉了，长出新牙', me: 'Seven or eight: baby teeth fall out one by one and new ones grow',
      fz: '“龀”就是换乳牙，也叫“龆龀”。《说文》：女孩七岁换牙，男孩八岁', fe: 'Chen means changing baby teeth; girls at seven, boys at eight, says the Shuowen' },
    { age: 10, here: true, zh: '幼学', py: 'Yòuxué', en: 'The age to begin learning', icon: 'book',
      mz: '十岁，开始好好上学读书的年纪', me: 'Ten: the age to start school and study in earnest',
      fz: '出自《礼记》：人生十年曰幼，学。也叫“外傅之年”：十年出就外傅，出门跟老师学习', fe: 'From the Book of Rites; also “the age to go out and study with a teacher”' },
    { age: 12, zh: '金钗之年', py: 'Jīnchāi zhī nián', en: 'The golden hairpin', icon: 'goldpin', who: ['女孩', 'Girls'],
      mz: '十二岁的女孩，头上可以插一支漂亮的金钗', me: 'A girl of twelve, old enough for a pretty golden hairpin',
      fz: '“金钗”出自梁武帝的诗句：头上金钗十二行；后来用作女孩十二岁的代称', fe: 'From a line by Emperor Wu of Liang; later a name for a girl of twelve' },
    { age: 13, zh: '豆蔻年华', py: 'Dòukòu niánhuá', en: 'The cardamom bud', icon: 'bud', who: ['女孩', 'Girls'], boy: ['舞勺之年', 'Wǔsháo — learning music, poems and the spoon dance'],
      mz: '十三四岁的女孩，像枝头刚冒出的花苞', me: 'A girl of thirteen or fourteen, like a bud just showing on the branch',
      fz: '出自唐代杜牧的诗', fe: 'From a Tang poem by Du Mu' },
    { age: 15, zh: '及笄之年', py: 'Jíjī zhī nián', en: 'The hairpin age', icon: 'hairpin', who: ['女孩', 'Girls'], boy: ['束发之年、志学之年；再大些叫“成童”', 'Shùfà, Zhìxué — hair tied up, a mind set on learning; a little older, chéngtóng'],
      mz: '十五岁的女孩把头发盘起，插上发簪，表示长大了', me: 'At fifteen a girl pins up her hair — a sign of growing up',
      fz: '“笄”是簪子。出自《礼记·内则》：十有五年而笄', fe: 'Ji is a hairpin; from the Book of Rites' },
    { age: 16, zh: '二八年华', py: 'Èrbā niánhuá', en: 'Two times eight', icon: 'jade', who: ['女孩', 'Girls'],
      mz: '二乘八，正好十六岁；也叫“碧玉年华”，像一块清透的碧玉', me: 'Two times eight is sixteen; also “the jade years”, clear and bright as jade',
      fz: '旧时诗文里对十六岁少女的称呼，常说“年方二八”', fe: 'How old poems speak of a girl of sixteen — “just two-eight”' },
    { age: 20, zh: '桃李年华', py: 'Táolǐ niánhuá', en: 'The peach-and-plum years', icon: 'blossom', who: ['女孩', 'Girls'], boy: ['弱冠之年', 'Ruòguàn — the capping ceremony at twenty'],
      mz: '二十岁的女孩，像春天里开满枝头的桃花和李花', me: 'A young woman of twenty, like peach and plum trees in full spring bloom',
      fz: '旧时对女子二十岁的美称', fe: 'A traditional name for a young woman of twenty' },
    { age: 24, zh: '花信年华', py: 'Huāxìn niánhuá', en: 'The flower-wind years', icon: 'flowerwind', who: ['女孩', 'Girls'],
      mz: '二十四岁，像一年里二十四阵花信风吹开的花，开得正好', me: 'Twenty-four, like the flowers opened by the year’s twenty-four flower winds — in full bloom',
      fz: '从小寒到谷雨，每五天吹来一阵“花信风”，一共二十四番，从梅花开到楝花', fe: 'From Minor Cold to Grain Rain, a new flower wind every five days — twenty-four in all, plum to chinaberry' },
    { age: 30, zh: '而立', py: 'Érlì', en: 'Standing firm', icon: 'stand',
      mz: '三十岁，能靠自己站稳了', me: 'Thirty: able to stand on your own feet', fz: '出自《论语》：三十而立', fe: 'From the Analects of Confucius' },
    { age: 40, zh: '不惑', py: 'Búhuò', en: 'Free of doubt', icon: 'compass',
      mz: '四十岁，遇到事情不再迷糊', me: 'Forty: no longer confused by things', fz: '出自《论语》：四十而不惑', fe: 'From the Analects of Confucius' },
    { age: 50, zh: '知天命', py: 'Zhī tiānmìng', en: 'Knowing heaven’s will', icon: 'skystar',
      mz: '五十岁，明白自己这一生该做什么', me: 'Fifty: understanding what your life is for', fz: '出自《论语》：五十而知天命', fe: 'From the Analects of Confucius' },
    { age: 60, zh: '花甲', py: 'Huājiǎ', en: 'A full cycle', icon: 'cycle',
      mz: '六十岁，古人记年份的六十个名字正好转完一圈', me: 'Sixty: the sixty year-names of the old calendar come full circle', fz: '来自干支纪年', fe: 'From the sixty-year calendar cycle' },
    { age: 70, zh: '古稀', py: 'Gǔxī', en: 'Rare since ancient times', icon: 'pine',
      mz: '七十岁，古时候能活到七十的人很少', me: 'Seventy: long ago, few people lived to seventy', fz: '出自唐代杜甫的诗：人生七十古来稀', fe: 'From a Tang poem by Du Fu' },
    { age: 80, zh: '杖朝之年', py: 'Zhàngcháo zhī nián', en: 'A cane at court', icon: 'cane',
      mz: '八十岁，古时候可以拄着拐杖上朝，人人都尊敬', me: 'Eighty: in old times you could bring your cane even to court, and everyone honoured you',
      fz: '出自《礼记·王制》：八十杖于朝。八九十岁也合称“耄耋”', fe: 'From the Book of Rites; the eighties and nineties together are called maodie' },
    { age: 90, zh: '鲐背', py: 'Táibèi', en: 'Spots like a globefish', icon: 'fish',
      mz: '九十岁，背上长出像鲐鱼一样的斑点，是很长寿的样子', me: 'Ninety: spots on the back like a globefish — the look of a very long life', fz: '出自《释名》：九十曰鲐背，背有鲐文也。也叫“鲐背之年”', fe: 'From the Shiming: “ninety is taibei — spots on the back like a globefish”' },
    { age: 100, zh: '期颐', py: 'Qīyí', en: 'A hundred years', icon: 'peach',
      mz: '一百岁，被大家好好照顾的年纪', me: 'One hundred: the age to be lovingly cared for', fz: '出自《礼记》：百年曰期，颐', fe: 'From the Book of Rites' }
  ];
  /* One name as a big card: picture, age, the name with pinyin and English, what it means, where it comes from. */
  T.nameCard = function (i, here) {
    var n = T.ageNames[i], wells = ['sky', 'sun', 'mint', 'grape', 'primary'];
    var badge = n.at ? '<span class="tu-age' + (n.at[1] ? '' : ' tu-age--word') + '"><b>' + n.at[0] + '</b>' + (n.at[1] ? T.bi(n.at[1], n.at[2]) : '') + '</span>' : T.age(n.age);
    here = here == null ? !!n.here : here;
    return '<div class="tu-namecard' + (n.boy || n.fz.length > 26 ? ' tu-namecard--long' : '') + '"><div class="tu-namecard__pic tu-namecard__pic--' + wells[i % 5] + '">' + T.icon(n.icon) + badge + '</div>' +
      '<div class="tu-namecard__txt"><div class="tu-namecard__tags">' +
      (here ? '<span class="tu-namecard__tag tu-namecard__tag--here">' + T.bi('你在这里', 'You are here') + '</span>' : '') +
      (n.who ? '<span class="tu-namecard__tag">' + T.bi(n.who[0], n.who[1]) + '</span>' : '') + '</div>' +
      T.bi(n.zh, n.py + ' · ' + n.en, 'tu-hero tu-namecard__name') + T.bi(n.mz, n.me, 'tu-label tu-namecard__mean') + T.bi(n.fz, n.fe, 'tu-body') +
      (n.boy ? '<div class="tu-namecard__boy">' + T.bi('同样年纪的男孩叫：' + n.boy[0], 'Boys of this age: ' + n.boy[1], 'tu-body') + '</div>' : '') + '</div></div>';
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
      if (T.cloud && T.cloud.on) return Promise.resolve(cAlbum[key] == null ? null : clone(cAlbum[key]));
      return db().then(function (d) {
        return new Promise(function (res, rej) {
          var rq = d.transaction('kv').objectStore('kv').get(key);
          rq.onsuccess = function () { res(rq.result == null ? null : rq.result); };
          rq.onerror = function () { rej(rq.error); };
        });
      }).catch(function () { T.store.persistent = false; return mem[key] == null ? null : mem[key]; });
    },
    set: function (key, val) {
      if (T.cloud && T.cloud.on) { cAlbum[key] = clone(val); schedule(); return Promise.resolve(true); }
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

  /* ---------- cloud: the family's own album server ----------
     When the pages are served by the album server, T.store reads and writes the album there instead of in this
     browser, pictures are uploaded once and referred to by id, and every open device follows the others.
     T.cloud.init() → Promise<true|false>; call it before the first T.store.get. Without a server nothing changes. */
  var C = T.cloud = { on: false, version: 0, status: 'local' };
  var cAlbum = {}, cSynced = '{}', cDirty = false, cTimer = null, cBusy = null, cSeen = [], cUploaded = {};
  function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
  function toLogin() {
    var here = location.pathname.split('/').pop() || 'index.html';
    location.replace('login.html?next=' + encodeURIComponent(here + location.search));
    return new Promise(function () {});
  }
  function call(method, url, body, type) {
    var h = { 'X-TenUp': '1' };
    if (body != null && !type) { h['Content-Type'] = 'application/json'; body = JSON.stringify(body); } else if (type) h['Content-Type'] = type;
    return fetch('api/' + url, { method: method, headers: h, body: body, credentials: 'same-origin' }).then(function (r) {
      if (r.status === 401 || r.status === 423) return toLogin();
      return r.json().then(function (j) { return { status: r.status, json: j }; });
    });
  }
  C.call = call;
  /* a big file (a video) goes up straight from the phone, with progress; → Promise<'api/file/<id>'> */
  C.send = function (blob, type, onProgress) {
    return new Promise(function (res, rej) {
      var x = new XMLHttpRequest();
      x.open('POST', 'api/file'); x.setRequestHeader('X-TenUp', '1'); x.setRequestHeader('Content-Type', type);
      x.upload.onprogress = function (e) { if (onProgress && e.lengthComputable) onProgress(e.loaded / e.total); };
      x.onload = function () {
        var j = {}; try { j = JSON.parse(x.responseText); } catch (e) {}
        if (x.status === 401 || x.status === 423) { toLogin(); return; }
        if (x.status === 200 && j.id) res('api/file/' + j.id); else rej(new Error(j.message || '上传没有成功 The upload did not go through'));
      };
      x.onerror = function () { rej(new Error('连不上服务器 Cannot reach the server')); };
      x.send(blob);
    });
  };
  /* every string in the album: 'f:<id>' on the server ↔ 'api/file/<id>' in the page */
  function walk(o, fn) {
    if (Array.isArray(o)) return Promise.all(o.map(function (v, i) { return Promise.resolve(typeof v === 'string' ? fn(v) : walk(v, fn)).then(function (r) { if (typeof v === 'string') o[i] = r; }); })).then(function () { return o; });
    if (o && typeof o === 'object') return Promise.all(Object.keys(o).map(function (k) { var v = o[k]; return Promise.resolve(typeof v === 'string' ? fn(v) : walk(v, fn)).then(function (r) { if (typeof v === 'string') o[k] = r; }); })).then(function () { return o; });
    return Promise.resolve(o);
  }
  function hydrate(a) { return walk(clone(a) || {}, function (v) { return /^f:[0-9a-f]{32}$/.test(v) ? 'api/file/' + v.slice(2) : v; }); }
  function upload(dataUrl) {
    if (cUploaded[dataUrl]) return Promise.resolve(cUploaded[dataUrl]);
    return fetch(dataUrl).then(function (r) { return r.blob(); }).then(function (b) { return call('POST', 'file', b, b.type); }).then(function (r) {
      if (r.status !== 200) throw new Error((r.json && r.json.message) || 'upload failed');
      return (cUploaded[dataUrl] = 'f:' + r.json.id);
    });
  }
  function dehydrate(a) {
    return walk(clone(a), function (v) {
      if (/^api\/file\/[0-9a-f]{32}$/.test(v)) return 'f:' + v.slice(9);
      if (/^data:(image|audio)\//.test(v)) return upload(v);
      return v;
    });
  }
  function tell(remote) { cSeen.forEach(function (fn) { try { fn(remote); } catch (e) {} }); }
  function setStatus(st) { if (C.status !== st) { C.status = st; tell(false); } }
  function push(tries) {
    cDirty = false; setStatus('saving');
    var mine = clone(cAlbum);
    return dehydrate(mine).then(function (out) {
      /* uploads turned data: URLs into file references; keep those in the page's copy so they are not sent twice */
      return hydrate(out).then(function (h) { if (!cDirty) cAlbum = h; return call('PUT', 'album', { base: C.version, album: out }); }).then(function (r) {
        if (r.status === 200) { C.version = r.json.version; cSynced = JSON.stringify(cAlbum); setStatus(cDirty ? 'saving' : 'synced'); return cDirty ? push(0) : null; }
        if (r.status !== 409 || tries >= 3) throw new Error('save failed');
        /* someone else saved first: take theirs, then put back the ages and settings this device changed */
        return hydrate(r.json.album).then(function (theirs) {
          var was = JSON.parse(cSynced), now = cAlbum;
          Object.keys(now).forEach(function (k) {
            if (k === 'photos' && Array.isArray(now.photos) && Array.isArray(theirs.photos)) {
              now.photos.forEach(function (p, i) { if (JSON.stringify(p) !== JSON.stringify((was.photos || [])[i])) theirs.photos[i] = p; });
            } else if (JSON.stringify(now[k]) !== JSON.stringify(was[k])) theirs[k] = now[k];
          });
          cAlbum = theirs; C.version = r.json.version; cSynced = JSON.stringify(r.json.album ? theirs : {});
          tell(true);
          return push(tries + 1);
        });
      });
    }).catch(function (e) { cDirty = true; setStatus('offline'); if (window.console) console.warn('[tenup] save failed', e); });
  }
  function schedule() { cDirty = true; setStatus('saving'); clearTimeout(cTimer); cTimer = setTimeout(function () { cBusy = (cBusy || Promise.resolve()).then(function () { return cDirty ? push(0) : null; }); }, 350); }
  function pull() {
    return call('GET', 'album?v=' + C.version).then(function (r) {
      if (r.status !== 200) throw new Error('load failed');
      if (r.json.same) { if (C.status === 'offline' && !cDirty) setStatus('synced'); return false; }
      if (cDirty) return false;                      /* this device has unsaved changes: its own save will sort the two out */
      return hydrate(r.json.album).then(function (a) { cAlbum = a; C.version = r.json.version; cSynced = JSON.stringify(a); C.status = 'synced'; return true; });
    });
  }
  C.onChange = function (fn) { cSeen.push(fn); };
  C.init = function () {
    if (!/^https?:$/.test(location.protocol) || !window.fetch) return Promise.resolve(false);
    return fetch('api/state', { credentials: 'same-origin' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
      if (!j || j.server !== 'tenup') return false;
      if (j.state !== 'ok') return toLogin();
      C.on = true; C.version = -1; C.maxVideoMB = j.maxVideoMB || 200;
      return pull().then(function () {
        setInterval(function () { if (document.hidden) return; pull().then(function (changed) { if (changed) tell(true); }).catch(function () { if (!cDirty) setStatus('offline'); }); }, 4000);
        return true;
      });
    }).catch(function () { return false; });
  };
  C.logout = function () { return call('POST', 'logout', {}).then(function () { location.replace('login.html'); }); };

  /* Saved photos over the defaults, one per age. */
  T.loadPhotos = function () {
    return T.store.load().then(function (saved) {
      return T.photos.map(function (p) {
        var s = saved && saved.filter(function (x) { return x.age === p.age; })[0];
        return s ? { age: p.age, zh: s.zh || p.zh, en: s.en || p.en, src: s.src || '', more: s.more || [] } : { age: p.age, zh: p.zh, en: p.en, src: '', more: [] };
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
  /* ---------- videos ----------
     Phones label their videos video/mp4 (Android) or video/quicktime (iPhone .mov); a few send no type, so the name decides. */
  var VEXT = { mp4: 'video/mp4', m4v: 'video/x-m4v', mov: 'video/quicktime', qt: 'video/quicktime', webm: 'video/webm', '3gp': 'video/3gpp' };
  T.videoType = function (f) {
    if (f && /^video\//.test(f.type)) return f.type.toLowerCase();
    var m = /\.([a-z0-9]+)$/i.exec((f && f.name) || '');
    return m && VEXT[m[1].toLowerCase()] || '';
  };
  T.isVideo = function (f) { return !!T.videoType(f); };
  T.isMedia = function (f) { return !!f && (/^image\//.test(f.type) || T.isVideo(f)); };
  /* a still for a video that this browser cannot open: a soft card with a play mark */
  T.videoStill = function () {
    var c = document.createElement('canvas'), x = c.getContext('2d');
    c.width = 960; c.height = 720;
    var g = x.createLinearGradient(0, 0, 960, 720); g.addColorStop(0, '#ffd9cf'); g.addColorStop(1, '#cfe4ff');
    x.fillStyle = g; x.fillRect(0, 0, 960, 720);
    x.fillStyle = 'rgba(255,255,255,.85)'; x.beginPath(); x.arc(480, 340, 120, 0, 6.2832); x.fill();
    x.fillStyle = '#e0607e'; x.beginPath(); x.moveTo(445, 280); x.lineTo(545, 340); x.lineTo(445, 400); x.closePath(); x.fill();
    x.fillStyle = '#5b3a2e'; x.font = 'bold 44px sans-serif'; x.textAlign = 'center'; x.fillText('视频 · Video', 480, 560);
    return c.toDataURL('image/jpeg', 0.86);
  };
  /* a picked video → { poster: a JPEG data URL from about half a second in, playable: whether this browser can show it, duration } */
  T.videoPoster = function (file, max) {
    max = max || 1600;
    return new Promise(function (res) {
      var url = URL.createObjectURL(file), v = document.createElement('video'), done = false, tm;
      function finish(poster, playable) {
        if (done) return; done = true; clearTimeout(tm);
        var d = isFinite(v.duration) ? v.duration : 0;
        try { v.pause(); v.removeAttribute('src'); v.load(); } catch (e) {}
        URL.revokeObjectURL(url);
        res({ poster: poster || T.videoStill(), playable: playable, duration: d });
      }
      function grab() {
        if (done || !v.videoWidth || v.readyState < 2) return;
        try {
          var k = Math.min(1, max / Math.max(v.videoWidth, v.videoHeight)), c = document.createElement('canvas');
          c.width = Math.round(v.videoWidth * k); c.height = Math.round(v.videoHeight * k);
          c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
          finish(c.toDataURL('image/jpeg', 0.86), true);
        } catch (e) { finish('', true); }
      }
      tm = setTimeout(function () { finish('', v.readyState >= 1); }, 12000);
      v.muted = true; v.playsInline = true; v.setAttribute('playsinline', ''); v.setAttribute('muted', ''); v.preload = 'auto';
      v.onloadedmetadata = function () { var t = Math.min(0.5, (v.duration || 1) / 3); try { v.currentTime = t; } catch (e) {} };
      v.onseeked = grab; v.onloadeddata = function () { setTimeout(grab, 60); }; v.ontimeupdate = grab;
      v.onerror = function () { finish('', false); };
      v.src = url;
      /* iPhones load nothing until asked to play; a muted, inline play is allowed and is stopped at once */
      var p = v.play && v.play(); if (p && p.then) p.then(function () { v.pause(); }, function () {});
    });
  };
  /* the video itself, ready for the album: on the family server it is uploaded now (it is too big to wait for
     the next save), else it is kept in this browser as a data URL */
  T.LOCAL_VIDEO_MB = 30;
  T.videoLimitMB = function () { return T.cloud.on ? T.cloud.maxVideoMB || 200 : T.LOCAL_VIDEO_MB; };
  T.keepVideo = function (file, onProgress) {
    var type = T.videoType(file);
    if (T.cloud.on) return T.cloud.send(file, type, onProgress);
    return new Promise(function (res, rej) {
      var rd = new FileReader();
      rd.onload = function () { var u = String(rd.result); res(u.replace(/^data:[^;,]*/, 'data:' + type)); };
      rd.onerror = function () { rej(new Error('cannot read video')); };
      rd.readAsDataURL(file);
    });
  };



  /* ---------- a note that goes with a photo: one line, handwriting, a small picture — any mix ----------
     note = { text, strokes: [[x, y, x, y, …], …] on a 1000 × 500 pad, image } */
  T.hasNote = function (n) { return !!(n && (n.text || (n.strokes && n.strokes.length) || n.image)); };
  T.strokesSvg = function (strokes, animate) {
    var t = 0;
    return '<svg class="tu-ink' + (animate ? ' tu-ink--write' : '') + '" viewBox="0 0 1000 500" role="img" aria-label="手写寄语 Handwritten note">' + (strokes || []).map(function (st) {
      var d = '', i, len = 0;
      for (i = 0; i + 1 < st.length; i += 2) { d += (i ? 'L' : 'M') + st[i] + ' ' + st[i + 1]; if (i) len += Math.abs(st[i] - st[i - 2]) + Math.abs(st[i + 1] - st[i - 1]); }
      if (st.length === 2) d += 'l0.1 0';
      var dur = Math.max(0.15, Math.min(1.2, len / 1400)), delay = t; t += dur + 0.08;
      return '<path d="' + d + '" pathLength="1"' + (animate ? ' style="animation-duration:' + dur.toFixed(2) + 's;animation-delay:' + delay.toFixed(2) + 's"' : '') + '/>';
    }).join('') + '</svg>';
  };
  T.noteCard = function (n) {
    if (!T.hasNote(n)) return '';
    return '<div class="tu-note">' + (n.image ? '<span class="tu-note__pic"><img alt="" src="' + esc(n.image) + '"></span>' : '') +
      (n.text ? '<span class="tu-note__text" lang="zh-Hans">' + esc(n.text) + '</span>' : '') +
      (n.strokes && n.strokes.length ? T.strokesSvg(n.strokes, true) : '') + '</div>';
  };

  /* ---------- background music ----------
     src: '' (none) · 'builtin:birthday' · 'builtin:lullaby' (two public-domain tunes played by a small music-box synth) · or the URL of an uploaded audio file.
     Browsers only let sound start after a key press or tap, so call T.music.play from one. */
  var TUNES = {
    birthday: { bpm: 104, notes: 'D4 .75,D4 .25,E4 1,D4 1,G4 1,F#4 2,D4 .75,D4 .25,E4 1,D4 1,A4 1,G4 2,D4 .75,D4 .25,D5 1,B4 1,G4 1,F#4 1,E4 1,C5 .75,C5 .25,B4 1,G4 1,A4 1,G4 2,- 1.5' },
    lullaby: { bpm: 84, notes: 'E4 .5,E4 .5,G4 2,E4 .5,E4 .5,G4 2,E4 .5,G4 .5,C5 1,B4 1,A4 1,A4 1,G4 1,D4 .5,E4 .5,F4 1,D4 1,D4 .5,E4 .5,F4 2,D4 .5,F4 .5,B4 .5,A4 .5,G4 1,B4 1,C5 2,C4 .5,C4 .5,C5 2,A4 .5,F4 .5,G4 2,E4 .5,C4 .5,F4 1,G4 1,A4 1,G4 2,C4 .5,C4 .5,C5 2,A4 .5,F4 .5,G4 2,E4 .5,C4 .5,F4 1,E4 1,D4 1,C4 2,- 1.5' }
  };
  T.tunes = [['', '不放音乐', 'No music'], ['builtin:birthday', '生日快乐歌（八音盒）', 'Happy Birthday (music box)'], ['builtin:lullaby', '摇篮曲（八音盒）', 'Lullaby (music box)']];
  function freq(name) { var m = /^([A-G])(#?)(\d)$/.exec(name); if (!m) return 0; var n = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1]] + (m[2] ? 1 : 0) + (+m[3] + 1) * 12; return 440 * Math.pow(2, (n - 69) / 12); }
  var M = T.music = { src: '', vol: 0.6, muted: false, ducked: false };
  var actx = null, gainAll = null, synthTimer = null, audioEl = null;
  function synth(tune) {
    var AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
    actx = actx || new AC();
    if (actx.state === 'suspended') actx.resume();
    gainAll = actx.createGain(); gainAll.gain.value = M.muted ? 0 : M.vol * (M.ducked ? 0.12 : 1); gainAll.connect(actx.destination);
    var seq = tune.notes.split(',').map(function (x) { var p = x.split(' '); return [freq(p[0]), +p[1]]; }), beat = 60 / tune.bpm, i = 0, when = actx.currentTime + 0.15, out = gainAll;
    function ahead() {
      while (when < actx.currentTime + 0.6) {
        var f = seq[i][0], len = seq[i][1] * beat;
        if (f) [1, 2, 4].forEach(function (mult, k) {          /* a struck-bar sound: the note, an octave, two octaves, each fading fast */
          var o = actx.createOscillator(), g = actx.createGain(), peak = [0.5, 0.16, 0.05][k];
          o.type = 'sine'; o.frequency.value = f * mult;
          g.gain.setValueAtTime(0.0001, when); g.gain.exponentialRampToValueAtTime(peak, when + 0.008); g.gain.exponentialRampToValueAtTime(0.0001, when + Math.max(0.9, len * 1.6) / (k + 1));
          o.connect(g); g.connect(out); o.start(when); o.stop(when + 2.6);
        });
        when += len; i = (i + 1) % seq.length;
      }
    }
    ahead(); synthTimer = setInterval(ahead, 200);
  }
  M.stop = function () {
    clearInterval(synthTimer); synthTimer = null;
    if (gainAll) { try { gainAll.gain.setTargetAtTime(0, actx.currentTime, 0.08); } catch (e) {} gainAll = null; }
    if (audioEl) { audioEl.pause(); audioEl.removeAttribute('src'); audioEl = null; }
    M.src = '';
  };
  M.play = function (src) {
    src = src || '';
    if (src === M.src) return;
    M.stop(); M.src = src;
    if (!src) return;
    if (/^builtin:/.test(src)) { if (TUNES[src.slice(8)]) synth(TUNES[src.slice(8)]); return; }
    audioEl = new Audio(src); audioEl.loop = true; audioEl.volume = M.muted ? 0 : M.vol * (M.ducked ? 0.12 : 1);
    var p = audioEl.play(); if (p && p.catch) p.catch(function () {});
  };
  M.volume = function (v) { M.vol = Math.max(0, Math.min(1, v)); var g = M.muted ? 0 : M.vol * (M.ducked ? 0.12 : 1); if (gainAll) gainAll.gain.value = g; if (audioEl) audioEl.volume = g; };
  /* while a video plays with its own sound, the background music steps back */
  M.duck = function (on) { if (M.ducked === !!on) return; M.ducked = !!on; M.volume(M.vol); };
  M.mute = function (on) { M.muted = on == null ? !M.muted : !!on; M.volume(M.vol); return M.muted; };
  M.defaults = function (m) { m = m || {}; return { album: m.album || '', cake: m.cake == null ? 'builtin:birthday' : m.cake, volume: m.volume == null ? 0.6 : m.volume, tracks: m.tracks || [] }; };

  /* ---------- photo manager (phone / computer) ----------
     T.manager(root, { playHref, defaultName }) — one cover photo per age plus up to T.MAX_MORE more per year,
     captions in both languages, her name, album export / import. Everything stays in this browser. */
  T.MAX_MORE = 8;
  T.manager = function (root, o) {
    o = o || {};
    T.defs();
    function blank() { return T.photos.map(function (p) { return { age: p.age, zh: p.zh, en: p.en, src: '', video: '', more: [], note: null, moreNotes: [], moreVideos: [] }; }); }
    var photos = blank(), meta = { zh: (o.defaultName && o.defaultName.zh) || '', en: (o.defaultName && o.defaultName.en) || '', avatars: {} };
    var WHO = [['girl', '她', 'Her'], ['dad', '爸爸', 'Dad'], ['mom', '妈妈', 'Mom']], avatarTarget = null;
    /* where the next picked photos or videos go: { more: false, i: null } fills empty covers, { more: true, i } adds to a year */
    var dest = null, note = null, music = T.music.defaults(), dlg = null;
    /* phones and tablets: offer the camera next to the library */
    var touch = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
    function mini(zh, en, act, cls) { return '<button type="button" class="tu-mini ' + (cls || '') + '" data-act="' + act + '">' + zh + '<small>' + en + '</small></button>'; }
    function capBtn(act, icon, zh, en) { return '<button type="button" class="tu-cap" data-act="' + act + '">' + T.icon(icon) + T.bi(zh, en) + '</button>'; }

    root.innerHTML = '<div class="tu-mgr"><div class="tu-mgr__head"><div class="tu-mgr__title">' +
      T.bi('照片管理', 'Photo manager', 'tu-title') + T.bi('每个年龄一张封面，照片或视频都可以；还可以再加这一年的更多照片和视频', 'One cover per age, a photo or a video, plus more photos and videos from that year', 'tu-body') +
      '</div><div class="tu-mgr__status" role="status"></div></div>' +
      '<div class="tu-mgr__names"><label><span>孩子的名字或小名 · Her name (Chinese)</span><input class="tu-field" data-n="zh" maxlength="6" lang="zh-Hans"></label>' +
      '<label><span>英文名 · Her name (English)</span><input class="tu-field" data-n="en" maxlength="14" lang="en"></label>' +
      '<div class="tu-avatars"><span>头像（年龄那一页用）· Portraits for the ages page</span><div class="tu-avatars__row"></div></div></div>' +
      '<div class="tu-musicbox"></div>' +
      '<label class="tu-drop">' + T.icon('upload') + T.bi('把封面照片或视频拖到这里，或点一下选择（可多选）', 'Drop cover photos or videos here, or tap to choose — several at once is fine') +
      '<input type="file" data-f="cover" accept="image/*,video/*" multiple></label>' +
      '<div class="tu-capbar">' + capBtn('shoot', 'camera', '拍照', 'Take a photo') + capBtn('film', 'video', '录视频', 'Record a video') + capBtn('library', 'images', '从相册选', 'Photos & videos') + '</div>' +
      '<div class="tu-slots"></div>' +
      '<div class="tu-mgr__tools">' + (o.playHref ? '<a class="tu-mini tu-mini--go" href="' + esc(o.playHref) + '">去播放<small>Play the album</small></a>' : '') +
      mini('导出相册包', 'Export album file', 'export') + mini('导入相册包', 'Import album file', 'import') + mini('全部清空', 'Clear everything', 'clear', 'tu-mini--danger') +
      '<input type="file" data-f="more" accept="image/*,video/*" multiple><input type="file" data-f="shoot" accept="image/*" capture="environment"><input type="file" data-f="film" accept="video/*" capture="environment"><input type="file" data-f="avatar" accept="image/*"><input type="file" data-f="noteimg" accept="image/*"><input type="file" data-f="audio" accept="audio/*"><input type="file" data-f="pack" accept=".js,.json,application/json,text/javascript"></div>' +
      '<div class="tu-mgr__help">' + T.bi('照片只保存在这台设备的这个浏览器里，不会上传；视频每段不超过 ' + T.LOCAL_VIDEO_MB + ' MB。要在另一台设备上播放：导出相册包，把下载到的 album.js 放进网站的 album 文件夹。',
        'Photos stay in this browser on this device and are never uploaded; each video can be up to ' + T.LOCAL_VIDEO_MB + ' MB. To play on another device, export the album file and put album.js into the site’s album folder.', 'tu-body') + '</div></div>';
    root.querySelector('.tu-mgr').classList.toggle('is-touch', touch);

    function q(sel) { return root.querySelector(sel); }
    var slots = q('.tu-slots'), drop = q('.tu-drop'), status = q('.tu-mgr__status');
    var musicBox = q('.tu-musicbox'), avRow = q('.tu-avatars__row'), avFile = q('[data-f="avatar"]'), file = q('[data-f="cover"]'), moreFile = q('[data-f="more"]'), shootFile = q('[data-f="shoot"]'), filmFile = q('[data-f="film"]'), pack = q('[data-f="pack"]'), nzh = q('[data-n="zh"]'), nen = q('[data-n="en"]');

    function drawStatus() {
      var n = photos.filter(function (p) { return p.src; }).length, m = 0, ok = T.store.persistent;
      photos.forEach(function (p) { m += p.more.length; });
      var where = T.cloud.on ? { synced: [' · 已同步到家里的服务器', ' · synced with the family server'], saving: [' · 正在保存…', ' · saving…'], offline: [' · 连不上服务器，稍后自动重试', ' · cannot reach the server — will retry'] }[T.cloud.status] || ['', '']
        : ok ? [' · 已保存在此浏览器', ' · saved in this browser'] : [' · 仅本次打开有效', ' · kept for this visit only'];
      status.classList.toggle('is-warn', T.cloud.on && T.cloud.status === 'offline');
      status.innerHTML = '<span>' + (note ? note[0] : '封面 ' + n + ' / ' + photos.length + ' · 更多照片 ' + m + ' 张' + where[0]) + '</span>' +
        '<span lang="en">' + (note ? note[1] : n + ' of ' + photos.length + ' covers · ' + m + ' more' + where[1]) + '</span>';
    }
    function draw() {
      nzh.value = meta.zh || ''; nen.value = meta.en || '';
      avRow.innerHTML = WHO.map(function (w) {
        var src = meta.avatars[w[0]];
        return '<span class="tu-avatar"><button type="button" class="tu-avatar__pic" data-act="avatar" data-who="' + w[0] + '" aria-label="选择头像 Choose a portrait: ' + w[2] + '">' +
          (src ? '<img alt="" src="' + esc(src) + '">' : T.icon(w[0])) + '</button><span class="tu-avatar__name">' + w[1] + '<small lang="en">' + w[2] + '</small></span>' +
          (src ? '<button type="button" class="tu-avatar__del" data-act="delavatar" data-who="' + w[0] + '" aria-label="移除头像 Remove portrait: ' + w[2] + '">×</button>' : '') + '</span>';
      }).join('');
      slots.innerHTML = photos.map(function (p, i) {
        return '<div class="tu-slot" data-i="' + i + '"><span class="tu-slot__age">' + p.age + ' 岁<small>age ' + p.age + '</small></span>' +
          '<div class="tu-slot__img" data-act="pick" title="选择封面 Choose the cover">' + (p.src ? '<img alt="" src="' + esc(p.src) + '">' : T.placeholder(p)) + (p.video ? vbadge() : '') + '</div>' +
          '<input class="tu-field" data-k="zh" lang="zh-Hans" aria-label="中文说明 Chinese caption，' + p.age + ' 岁" value="' + esc(p.zh) + '" maxlength="12">' +
          '<input class="tu-field tu-field--en" data-k="en" lang="en" aria-label="English caption 英文说明, age ' + p.age + '" value="' + esc(p.en) + '" maxlength="28">' +
          '<div class="tu-slot__row">' + mini(p.src ? '换封面' : '选封面', p.src ? 'Replace' : 'Choose', 'pick') +
          '<button type="button" class="tu-mini' + (T.hasNote(p.note) ? ' is-set' : '') + '" data-act="note" data-j="-1"' + (p.src ? '' : ' disabled') + '>寄语<small>Note</small></button>' +
          '<button type="button" class="tu-mini tu-mini--danger" data-act="del"' + (p.src ? '' : ' disabled') + '>移除<small>Remove</small></button></div>' +
          '<div class="tu-more"><span class="tu-more__h"><span lang="zh-Hans">这一年的更多照片和视频 ' + p.more.length + ' / ' + T.MAX_MORE + '</span><span lang="en">More photos and videos from this year</span></span><div class="tu-more__list">' +
          p.more.map(function (src, j) {
            var isV = !!(p.moreVideos || [])[j];
            return '<span class="tu-more__it' + (T.hasNote(p.moreNotes[j]) ? ' is-set' : '') + (isV ? ' is-video' : '') + '"><button type="button" class="tu-more__pic" data-act="note" data-j="' + j + '" aria-label="' + (isV ? '给这段视频写寄语 Add a note to this video' : '给这张写寄语 Add a note to this photo') + '"><img alt="" src="' + esc(src) + '">' + (isV ? '<span class="tu-more__v" aria-hidden="true">' + T.icon('play') + '</span>' : '') + '</button><button type="button" class="tu-more__x" data-act="delmore" data-j="' + j + '" aria-label="移除这张 Remove this photo">×</button></span>';
          }).join('') +
          (p.more.length < T.MAX_MORE ? '<button type="button" class="tu-more__add" data-act="more" aria-label="添加更多照片或视频 Add more photos or videos, age ' + p.age + '">+</button>' : '') +
          '</div></div></div>';
      }).join('');
      drawMusic();
      drawStatus();
      if (!dlg) T.tag('M01', '照片管理', 'Photo manager');
    }
    function vbadge() { return '<span class="tu-vbadge">' + T.icon('play') + '<span lang="zh-Hans">视频</span><span lang="en">Video</span></span>'; }
    function save() { return Promise.all([T.store.set('photos', photos), T.store.set('meta', meta), T.store.set('music', music)]).then(drawStatus); }

    /* ----- background music ----- */
    function drawMusic() {
      function pick(key, zh, en) {
        var opts = T.tunes.map(function (t) { return [t[0], t[1] + ' · ' + t[2]]; }).concat(music.tracks.map(function (t) { return [t.src, t.name]; }));
        return '<label><span>' + zh + ' · ' + en + '</span><select class="tu-field" data-m="' + key + '">' + opts.map(function (v) { return '<option value="' + esc(v[0]) + '"' + (music[key] === v[0] ? ' selected' : '') + '>' + esc(v[1]) + '</option>'; }).join('') + '</select></label>';
      }
      musicBox.innerHTML = '<div class="tu-musicbox__h">' + T.bi('背景音乐', 'Background music') + '</div><div class="tu-musicbox__grid">' +
        pick('album', '整部相册', 'Whole album') + pick('cake', '吹完蜡烛之后', 'After the candles') +
        '<label><span>音量 · Volume</span><input type="range" min="0" max="100" value="' + Math.round(music.volume * 100) + '" data-m="volume"></label></div>' +
        '<div class="tu-musicbox__tracks">' + music.tracks.map(function (t, i) {
          return '<span class="tu-track">' + esc(t.name) + mini('试听', 'Listen', 'listen', '', ' data-i="' + i + '"') + mini('移除', 'Remove', 'deltrack', 'tu-mini--danger', ' data-i="' + i + '"') + '</span>';
        }).join('') + mini('上传音乐', 'Upload a song', 'audio') + mini('停止试听', 'Stop', 'hush') + '</div>' +
        '<div class="tu-musicbox__note">' + T.bi('请只上传你有权使用的音乐。两段八音盒旋律是公有领域的曲子。', 'Please upload only music you have the right to use. The two music-box tunes are in the public domain.', 'tu-body') + '</div>';
    }
    function addAudio(f) {
      if (!f || !/^audio\//.test(f.type)) { note = ['这不是音频文件', 'That is not an audio file']; return drawStatus(); }
      if (f.size > 20 * 1024 * 1024) { note = ['音乐文件不能超过 20 MB', 'A song can be at most 20 MB']; return drawStatus(); }
      var rd = new FileReader();
      rd.onload = function () { music.tracks.push({ name: f.name.replace(/\.[^.]+$/, '').slice(0, 40), src: String(rd.result) }); note = null; draw(); save(); };
      rd.readAsDataURL(f);
    }

    /* ----- the note dialog: one line, handwriting, a small picture ----- */
    function noteOf(i, j) { return j < 0 ? photos[i].note : photos[i].moreNotes[j]; }
    function openNote(i, j) {
      var cur = noteOf(i, j) || {};
      dlg = { i: i, j: j, text: cur.text || '', strokes: (cur.strokes || []).map(function (s) { return s.slice(); }), image: cur.image || '' };
      drawDlg();
    }
    function drawDlg() {
      var old = root.querySelector('.tu-dlg'); if (old) old.parentNode.removeChild(old);
      if (!dlg) return T.tag('M01', '照片管理', 'Photo manager');
      var p = photos[dlg.i], src = dlg.j < 0 ? p.src : p.more[dlg.j], el = document.createElement('div');
      el.className = 'tu-dlg';
      el.innerHTML = '<div class="tu-dlg__box" role="dialog" aria-modal="true" aria-label="照片寄语 Photo note"><div class="tu-dlg__head"><img alt="" src="' + esc(src) + '">' + T.bi(p.age + ' 岁 · 给这张照片的寄语', 'Age ' + p.age + ' · A note for this photo', 'tu-title') + '</div>' +
        '<label><span>写一句话 · One line</span><input class="tu-field" data-d="text" maxlength="40" lang="zh-Hans" value="' + esc(dlg.text) + '"></label>' +
        '<div class="tu-dlg__lab">手写寄语 · Handwriting<span>用手指、触控笔或鼠标写 · Write with a finger, pen or mouse</span></div>' +
        '<div class="tu-pad">' + T.strokesSvg(dlg.strokes) + '</div>' +
        '<div class="tu-slot__row">' + mini('撤销一笔', 'Undo a stroke', 'undo') + mini('清空手写', 'Clear', 'wipe') + '</div>' +
        '<div class="tu-dlg__lab">配一张图 · A small picture<span>比如当年的画、奖状、小纸条 · A drawing, a certificate, a little note</span></div>' +
        '<div class="tu-dlg__img">' + (dlg.image ? '<img alt="" src="' + esc(dlg.image) + '">' : '') + mini(dlg.image ? '换一张' : '选图片', dlg.image ? 'Replace' : 'Choose', 'noteimg') + (dlg.image ? mini('移除', 'Remove', 'noteimgdel', 'tu-mini--danger') : '') + '</div>' +
        '<div class="tu-dlg__foot">' + mini('保存寄语', 'Save the note', 'notesave', 'tu-mini--go') + mini('取消', 'Cancel', 'noteno') + '</div></div>';
      root.appendChild(el);
      T.tag('M02', '寄语对话框', 'Note dialog');
      var pad = el.querySelector('.tu-pad'), live = null;
      function at(e) { var r = pad.getBoundingClientRect(); return [Math.round((e.clientX - r.left) / r.width * 1000), Math.round((e.clientY - r.top) / r.height * 500)]; }
      function redraw() { pad.innerHTML = T.strokesSvg(dlg.strokes); }
      pad.addEventListener('pointerdown', function (e) { e.preventDefault(); if (pad.setPointerCapture) { try { pad.setPointerCapture(e.pointerId); } catch (x) {} } live = at(e); dlg.strokes.push(live); redraw(); });
      pad.addEventListener('pointermove', function (e) { if (!live) return; var q = at(e), n = live.length; if (Math.abs(q[0] - live[n - 2]) + Math.abs(q[1] - live[n - 1]) < 6) return; live.push(q[0], q[1]); redraw(); });
      ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (ev) { pad.addEventListener(ev, function () { live = null; }); });
      el.querySelector('[data-d="text"]').addEventListener('input', function (e) { dlg.text = e.target.value; });
    }
    function saveNote() {
      var n = { text: dlg.text.trim(), strokes: dlg.strokes.filter(function (s) { return s.length >= 2; }).slice(0, 60), image: dlg.image }, v = T.hasNote(n) ? n : null;
      if (dlg.j < 0) photos[dlg.i].note = v; else photos[dlg.i].moreNotes[dlg.j] = v;
      dlg = null; drawDlg(); note = null; draw(); save();
    }
    function media(files) { return [].slice.call(files || []).filter(T.isMedia); }
    /* photos are shrunk here; a video keeps its own file and gets a still picture for the slot and for the moment before it plays */
    function readAll(list, max, each) {
      var r = { failed: 0, big: 0, odd: 0 }, lim = T.videoLimitMB(), vids = list.filter(T.isVideo).length, vn = 0;
      return list.reduce(function (chain, f, k) {
        return chain.then(function () {
          if (!T.isVideo(f)) return T.readImage(f, max).then(function (src) { each({ src: src, video: '' }, k); }, function () { r.failed++; });
          if (f.size > lim * 1048576) { r.big++; return; }
          vn++; busy(list.length, vn, vids, 0);
          return T.videoPoster(f, max).then(function (pv) {
            if (!pv.playable) r.odd++;
            return T.keepVideo(f, function (x) { busy(list.length, vn, vids, x); }).then(function (url) { each({ src: pv.poster, video: url }, k); });
          }).catch(function (e) { r.failed++; r.why = e && e.message; });
        });
      }, Promise.resolve()).then(function () { return r; });
    }
    function busy(n, vn, vids, x) {
      note = vn ? [(T.cloud.on ? '正在上传视频 ' : '正在处理视频 ') + vn + ' / ' + vids + (T.cloud.on ? ' · ' + Math.round(x * 100) + '%' : '') + '，请不要关闭页面',
                   (T.cloud.on ? 'Uploading video ' : 'Reading video ') + vn + ' of ' + vids + (T.cloud.on ? ' · ' + Math.round(x * 100) + '%' : '') + ' — please keep this page open']
                : ['正在处理 ' + n + ' 个…', 'Reading ' + n + ' item(s)…'];
      drawStatus();
    }
    function done(r, extra, fullZh, fullEn) {
      var lim = T.videoLimitMB();
      note = r.failed ? [r.failed + ' 个读不出来或没传上去，换一个试试', r.failed + ' could not be read or uploaded — try another']
        : r.big ? [r.big + ' 段视频超过 ' + lim + ' MB，没有导入。可以在手机上剪短一点再传', r.big + ' video(s) are over ' + lim + ' MB and were not added — trim them on the phone and try again']
        : extra > 0 ? [fullZh.replace('#', extra), fullEn.replace('#', extra)]
        : r.odd ? ['视频已加入。这台设备的浏览器放不了这种格式，电视或别的设备上通常可以', 'Video added. This browser cannot play its format; the TV or another device usually can']
        : null;
      draw(); save();
    }
    function none() { note = ['没有找到照片或视频', 'No photos or videos found']; drawStatus(); }
    function addCovers(files, at) {
      var list = media(files), order = [];
      if (!list.length) return none();
      if (at != null) order.push(at);
      photos.forEach(function (p, i) { if (!p.src && i !== at) order.push(i); });
      busy(list.length);
      readAll(list.slice(0, order.length), 1600, function (m, k) { var p = photos[order[k]]; p.src = m.src; p.video = m.video; }).then(function (r) {
        done(r, list.length - order.length, '封面位满了，多出 # 个没有导入', 'All cover slots are full — # item(s) were not imported');
      });
    }
    function addMore(files, i) {
      var list = media(files), room = T.MAX_MORE - photos[i].more.length;
      if (!list.length) return none();
      busy(list.length);
      readAll(list.slice(0, room), 1280, function (m) {
        var p = photos[i], j = p.more.length;
        p.more.push(m.src); p.moreVideos = p.moreVideos || []; p.moreVideos[j] = m.video; p.moreNotes[j] = p.moreNotes[j] || null;
      }).then(function (r) {
        done(r, list.length - room, '这一年最多 ' + T.MAX_MORE + ' 个，多出 # 个没有导入', 'A year holds ' + T.MAX_MORE + ' — # item(s) were not imported');
      });
    }
    /* ----- M04: on a phone or tablet, choose camera or library ----- */
    function sheet(open) {
      var old = root.querySelector('.tu-sheet'); if (old) old.parentNode.removeChild(old);
      if (!open) { if (!dlg) T.tag('M01', '照片管理', 'Photo manager'); return; }
      var el = document.createElement('div'), p = dest && dest.i != null ? photos[dest.i] : null;
      el.className = 'tu-sheet';
      el.innerHTML = '<div class="tu-sheet__box" role="dialog" aria-modal="true" aria-label="添加照片或视频 Add a photo or video">' +
        T.bi(p ? (dest.more ? p.age + ' 岁 · 再加一个' : p.age + ' 岁 · 封面') : '添加照片或视频', p ? (dest.more ? 'Age ' + p.age + ' · add one more' : 'Age ' + p.age + ' · the cover') : 'Add a photo or video', 'tu-title') +
        '<div class="tu-sheet__opts">' + capBtn('shoot', 'camera', '拍照', 'Take a photo') + capBtn('film', 'video', '录视频', 'Record a video') + capBtn('library', 'images', '从相册选', 'Photos & videos') + '</div>' +
        mini('取消', 'Cancel', 'sheetno') + '</div>';
      root.appendChild(el);
      T.tag('M04', '拍照或选择', 'Camera or library');
    }
    function choose(d) { dest = d; if (touch) sheet(true); else (d.more ? moreFile : file).click(); }
    function deliver(files) { var d = dest || { more: false, i: null }; dest = null; if (d.more) addMore(files, d.i); else addCovers(files, d.i); }
    function fromData(data) {
      /* a picture is either held in the page (data:) or kept on the family server (api/file/<id>); anything else is dropped */
      function img(v) { return /^(data:image\/|api\/file\/[0-9a-f]{32}$)/.test(v || '') ? v : ''; }
      function vid(v) { return /^(data:video\/|api\/file\/[0-9a-f]{32}$)/.test(v || '') ? v : ''; }
      var av = data.avatars || meta.avatars || {};
      meta = { zh: (data.name && data.name.zh) || meta.zh, en: (data.name && data.name.en) || meta.en, avatars: { girl: img(av.girl), dad: img(av.dad), mom: img(av.mom) } };
      photos = T.photos.map(function (p) {
        var x = (data.photos || []).filter(function (r) { return r.age === p.age; })[0] || {};
        function clean(n) { return T.hasNote(n) ? { text: String(n.text || '').slice(0, 40), strokes: (n.strokes || []).slice(0, 60), image: img(n.image) } : null; }
        var more = [], notes = [], vids = [];
        (x.more || []).forEach(function (v, k) { if (img(v) && more.length < T.MAX_MORE) { more.push(v); notes.push(clean((x.moreNotes || [])[k])); vids.push(vid((x.moreVideos || [])[k])); } });
        return { age: p.age, zh: x.zh || p.zh, en: x.en || p.en, src: img(x.src), video: img(x.src) ? vid(x.video) : '', more: more, note: clean(x.note), moreNotes: notes, moreVideos: vids };
      });
    }
    function exportPack() {
      var text = '/* 十岁啦 相册包 — 放进网站的 album 文件夹，文件名保持 album.js */\nwindow.TENUP_ALBUM = ' + JSON.stringify({ v: 3, name: { zh: meta.zh, en: meta.en }, avatars: meta.avatars, music: music, photos: photos }) + ';\n';
      var a = document.createElement('a'), url = URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));
      a.href = url; a.download = 'album.js';
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
      note = ['已导出 album.js，把它放进 album 文件夹', 'Exported album.js — put it into the album folder']; drawStatus();
    }
    function importPack(f) {
      var rd = new FileReader();
      rd.onload = function () {
        try {
          var t = String(rd.result), data = JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1));
          if (!data || !data.photos) throw new Error('shape');
          fromData(data); if (data.music) music = T.music.defaults(data.music); note = null; draw(); save();
        } catch (e) { note = ['这个文件不是相册包', 'That file is not an album file']; drawStatus(); }
      };
      rd.readAsText(f);
    }

    root.addEventListener('click', function (e) {
      var a = e.target.closest('[data-act]'); if (!a) return;
      var act = a.getAttribute('data-act'), sl = e.target.closest('.tu-slot'), i = sl ? +sl.getAttribute('data-i') : -1;
      if (act === 'pick' && sl) choose({ more: false, i: i });
      else if (act === 'del' && sl) { photos[i].src = ''; photos[i].video = ''; note = null; draw(); save(); }
      else if (act === 'more' && sl) choose({ more: true, i: i });
      else if (act === 'delmore' && sl) { var dj = +a.getAttribute('data-j'); photos[i].more.splice(dj, 1); photos[i].moreNotes.splice(dj, 1); (photos[i].moreVideos || []).splice(dj, 1); note = null; draw(); save(); }
      else if (act === 'shoot' || act === 'film' || act === 'library') {
        /* the camera opens straight away on iPhone, iPad and Android: capture="environment" asks for the back camera */
        if (!a.closest('.tu-sheet')) dest = { more: false, i: null };
        sheet(false);
        (act === 'shoot' ? shootFile : act === 'film' ? filmFile : dest && dest.more ? moreFile : file).click();
      }
      else if (act === 'sheetno') { dest = null; sheet(false); }
      else if (act === 'note' && sl) openNote(i, +a.getAttribute('data-j'));
      else if (act === 'undo') { dlg.strokes.pop(); drawDlg(); }
      else if (act === 'wipe') { dlg.strokes = []; drawDlg(); }
      else if (act === 'noteimg') q('[data-f="noteimg"]').click();
      else if (act === 'noteimgdel') { dlg.image = ''; drawDlg(); }
      else if (act === 'notesave') saveNote();
      else if (act === 'noteno') { dlg = null; drawDlg(); }
      else if (act === 'audio') q('[data-f="audio"]').click();
      else if (act === 'listen') T.music.play(music.tracks[+a.getAttribute('data-i')].src);
      else if (act === 'hush') T.music.stop();
      else if (act === 'deltrack') { var gone = music.tracks.splice(+a.getAttribute('data-i'), 1)[0]; ['album', 'cake'].forEach(function (k) { if (music[k] === gone.src) music[k] = ''; }); T.music.stop(); note = null; draw(); save(); }
      else if (act === 'avatar') { avatarTarget = a.getAttribute('data-who'); avFile.click(); }
      else if (act === 'delavatar') { meta.avatars[a.getAttribute('data-who')] = ''; note = null; draw(); save(); }
      else if (act === 'export') exportPack();
      else if (act === 'import') pack.click();
      else if (act === 'clear') {
        if (!window.confirm('清空全部照片和说明？这一步不能撤销。\nClear all photos and captions? This cannot be undone.')) return;
        photos = blank(); meta.avatars = {}; music = T.music.defaults(); note = null; draw(); save();
      }
    });
    root.addEventListener('change', function (e) {
      var t = e.target, sl = t.closest('.tu-slot'), k = t.getAttribute('data-k'), f = t.getAttribute('data-f'), n = t.getAttribute('data-n');
      if (sl && k) { var i = +sl.getAttribute('data-i'); photos[i][k] = t.value.trim() || T.photos[i][k]; t.value = photos[i][k]; note = null; save(); }
      else if (n) { meta[n] = t.value.trim(); note = null; save(); }
      else if (f === 'cover' || f === 'more' || f === 'shoot' || f === 'film') { deliver(t.files); t.value = ''; }
      else if (f === 'noteimg') { var nf = t.files[0]; t.value = ''; if (nf && dlg) T.readImage(nf, 900).then(function (src) { dlg.image = src; drawDlg(); }, function () {}); }
      else if (f === 'audio') { addAudio(t.files[0]); t.value = ''; }
      else if (t.getAttribute('data-m')) {
        var mk = t.getAttribute('data-m');
        if (mk === 'volume') { music.volume = +t.value / 100; T.music.volume(music.volume); } else { music[mk] = t.value; T.music.play(t.value); }
        note = null; save();
      }
      else if (f === 'avatar') {
        var who = avatarTarget, pick = t.files[0]; avatarTarget = null; t.value = '';
        if (who && pick) T.readImage(pick, 480).then(function (src) { meta.avatars[who] = src; note = null; draw(); save(); }, function () { note = ['这张读不出来，换一张试试', 'That one could not be read — try another']; drawStatus(); });
      }
      else if (f === 'pack') { if (t.files[0]) importPack(t.files[0]); t.value = ''; }
    });
    /* a tap on the drop box fills empty covers; a click the page itself sends to the input (for one slot) also passes through here and must keep its slot */
    drop.addEventListener('click', function (e) { if (e.target !== file) dest = { more: false, i: null }; });
    function mark(e) {
      var more = e && e.target.closest ? e.target.closest('.tu-more') : null, sl = e && e.target.closest ? e.target.closest('.tu-slot') : null;
      [].forEach.call(root.querySelectorAll('.is-over'), function (c) { c.classList.remove('is-over'); });
      if (!e) return null;
      if (more) more.classList.add('is-over'); else if (sl) sl.classList.add('is-over'); else drop.classList.add('is-over');
      return { more: !!more, i: sl ? +sl.getAttribute('data-i') : null };
    }
    ['dragenter', 'dragover'].forEach(function (ev) { root.addEventListener(ev, function (e) { e.preventDefault(); mark(e); }); });
    root.addEventListener('dragleave', function (e) { e.preventDefault(); if (!root.contains(e.relatedTarget)) mark(null); });
    root.addEventListener('drop', function (e) {
      e.preventDefault();
      var at = mark(e); mark(null);
      if (at.more) addMore(e.dataTransfer.files, at.i); else addCovers(e.dataTransfer.files, at.i);
    });

    function reload() {
      return Promise.all([T.store.get('photos'), T.store.get('meta'), T.store.get('music')]).then(function (r) {
        music = T.music.defaults(r[2]);
        if (r[1]) meta = { zh: r[1].zh || '', en: r[1].en || '', avatars: r[1].avatars || {} };
        if (r[0]) fromData({ name: meta, avatars: meta.avatars, photos: r[0] });
        draw();
      });
    }
    draw();
    T.cloud.init().then(function (on) {
      if (on) {
        if (o.account !== false) T.account(root.querySelector('.tu-mgr'));
        root.querySelector('.tu-mgr__help').innerHTML = T.bi('照片加密保存在家里的服务器上。所有登录过的设备都能上传和整理，改动几秒钟内自动同步。', 'Photos are kept sealed on the family server. Every logged-in device can add and arrange them, and changes reach the others within seconds.', 'tu-body');
        /* another device changed the album: show it, unless someone is typing here right now */
        T.cloud.onChange(function (remote) { if (!remote) return drawStatus(); if (dlg || /^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement || {}).tagName || '')) return; reload(); });
      }
      return reload();
    });
  };

  /* ---------- account panel (cloud only): trusted devices, the two phone numbers, log out ---------- */
  T.account = function (host) {
    var box = document.createElement('div'), step = null, msg = null;
    box.className = 'tu-acct';
    host.appendChild(box);
    function mini(zh, en, act, cls, extra) { return '<button type="button" class="tu-mini ' + (cls || '') + '" data-act="' + act + '"' + (extra || '') + '>' + zh + '<small>' + en + '</small></button>'; }
    function draw(d) {
      var h = '<div class="tu-acct__head">' + T.bi('账户与设备', 'Account and devices', 'tu-title') + '<span class="tu-acct__acts">' +
        '<a class="tu-mini" href="admin.html">管理员设置<small>Admin settings</small></a>' + mini('退出这台设备', 'Log out this device', 'out', 'tu-mini--danger') + '</span></div>' +
        (d.me ? '<div class="tu-acct__me">' + T.bi('当前账号：' + esc(d.me), 'Signed in as ' + esc(d.me)) + '</div>' : '');
      h += '<div class="tu-acct__grid"><div><div class="tu-acct__h">' + T.bi('可信设备', 'Trusted devices') + '</div>' + d.devices.map(function (v) {
        return '<div class="tu-acct__row"><span>' + esc(v.name) + ' · ' + esc(v.country) + (v.current ? ' · <b>这台 this one</b>' : '') + '<small>' + new Date(v.seen).toLocaleDateString() + '</small></span>' +
          (v.current ? '' : mini('移除', 'Remove', 'rmdev', 'tu-mini--danger', ' data-id="' + esc(v.id) + '"')) + '</div>';
      }).join('') + '</div><div><div class="tu-acct__h">' + T.bi('接收验证码的手机号', 'Phones that receive codes') + '</div>' + d.phones.map(function (ph, i) {
        return '<div class="tu-acct__row"><span>' + esc(ph) + '</span>' + mini('更换', 'Change', 'chg', '', ' data-i="' + i + '"') + '</div>';
      }).join('');
      if (step) h += '<div class="tu-acct__form"><span class="tu-acct__say">' + step.say + '</span>' +
        (step.n === 1 ? '<input class="tu-field" data-a="code" inputmode="numeric" maxlength="6" placeholder="验证码 Code"><input class="tu-field" data-a="phone" inputmode="tel" placeholder="新手机号 New number">' : '<input class="tu-field" data-a="code" inputmode="numeric" maxlength="6" placeholder="验证码 Code">') +
        '<div class="tu-slot__row">' + mini('确认', 'Confirm', 'chgok') + mini('取消', 'Cancel', 'chgno') + '</div></div>';
      h += '<div class="tu-acct__note">' + T.bi('要换掉一个手机号，验证码会发到另一个手机号上。', 'To change one number, the code is sent to the other one.', 'tu-body') + '</div>';
      if (msg) h += '<div class="tu-acct__msg" role="alert">' + esc(msg) + '</div>';
      box.innerHTML = h + '</div></div>';
      if (T.labels) { var t = document.createElement('span'); t.className = 'tu-tag tu-tag--inline'; t.innerHTML = '<b>M03</b>' + T.bi('账户与设备', 'Account and devices'); box.insertBefore(t, box.firstChild); }
    }
    function load() { return T.cloud.call('GET', 'devices').then(function (r) { draw(r.json); }); }
    function post(url, body) { return T.cloud.call('POST', url, body).then(function (r) { msg = r.status === 200 ? null : r.json.message; return r; }); }
    box.addEventListener('click', function (e) {
      var a = e.target.closest('[data-act]'); if (!a) return;
      var act = a.getAttribute('data-act');
      if (act === 'out') { if (window.confirm('退出后，这台设备下次需要重新短信验证。\nAfter logging out, this device will need a text message again.')) T.cloud.logout(); }
      else if (act === 'rmdev') post('devices/remove', { id: a.getAttribute('data-id') }).then(load);
      else if (act === 'chg') { var i = +a.getAttribute('data-i'); post('phone/change/start', { which: i }).then(function (r) { step = r.status === 200 ? { n: 1, say: '验证码已发到 ' + esc(r.json.sentTo) + ' · Code sent to the other phone' } : null; load(); }); }
      else if (act === 'chgno') { step = null; msg = null; load(); }
      else if (act === 'chgok') {
        var code = (box.querySelector('[data-a="code"]') || {}).value, ph = (box.querySelector('[data-a="phone"]') || {}).value;
        if (step.n === 1) post('phone/change/confirm', { code: code, newPhone: ph }).then(function (r) { if (r.status === 200) step = { n: 2, say: '再输入发到新号码 ' + esc(r.json.sentTo) + ' 的验证码 · Now the code sent to the new number' }; load(); });
        else post('phone/change/finish', { code: code }).then(function (r) { if (r.status === 200) step = null; load(); });
      }
    });
    load();
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', T.defs); else T.defs();
  window.TenUp = T;
})();
