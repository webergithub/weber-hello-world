/* 十岁啦 · 体验页 The TV experience
   章节 Chapters: opening → gift → album → ages → together → cake → names
   遥控器 / 键盘: ← → 翻页或选择，↓ 进入当年相册，↑ 回到相册，OK(Enter) 下一步，返回(Back/Esc) 上一章，F 全屏。
   互动模式下摄像头动作与按键等效；数字键 1–8 可以模拟动作（调试用）。
   文案都在本文件的 SCREENS 里，中文在前、英文在后。 */
(function () {
  'use strict';
  var T = window.TenUp, CFG = window.TENUP_CONFIG || {}, Sense = window.TenUpSense;
  var stage = document.getElementById('stage'), view = document.getElementById('view'), fitBox = document.getElementById('fit');
  var camBox = document.getElementById('cam'), video = camBox.querySelector('video'), camNote = camBox.querySelector('.x-camnote'), debugBox = document.getElementById('debug');
  var Q = {};
  location.search.replace(/^\?/, '').split('&').forEach(function (kv) { if (kv) { var p = kv.split('='); Q[decodeURIComponent(p[0])] = decodeURIComponent(p[1] || '1'); } });

  var ORDER = ['opening', 'gift', 'album', 'ages', 'together', 'cake', 'names'];
  var name = { zh: (CFG.name && CFG.name.zh) || '小寿星', en: (CFG.name && CFG.name.en) || 'Birthday Girl' }, avatars = {};
  var photos = T.photos, mode = null, screen = 'opening', focus = 0, cur = 0, opened = false, blown = false, mood = 'happy';
  var year = null;      /* inside one year's album: the photos of that year, else null */
  var nameAt = 0;       /* which name of the ages is showing */
  var gal = null, timer = null, camOn = false, music = T.music.defaults();
  var watch = CFG.watch || { photoMs: 4500, chapterMs: 12000 };

  /* ---------- fit the 1920×1080 stage into the window, letterboxed ---------- */
  function fit() {
    var w = fitBox.clientWidth, h = fitBox.clientHeight, s = Math.min(w / 1920, h / 1080);
    stage.style.transform = 'translate(' + Math.round((w - 1920 * s) / 2) + 'px,' + Math.round((h - 1080 * s) / 2) + 'px) scale(' + s + ')';
  }
  window.addEventListener('resize', fit);
  fit();
  if (Q.lowfx) stage.classList.add('tu-lowfx');
  if (Q.debug) stage.classList.add('is-debug');

  /* ---------- what each gesture does, chapter by chapter ---------- */
  var G = {
    smile: { icon: 'smile', zh: '笑一笑', en: 'Smile' },
    cry: { icon: 'cry', zh: '装哭脸', en: 'Sad face' },
    swipe: { icon: 'swipe', zh: '向左挥手', en: 'Swipe left' },
    heart: { icon: 'heart', zh: '比个心', en: 'Heart hands' },
    palms: { icon: 'palms', zh: '张开双手', en: 'Both palms open' },
    fist: { icon: 'fist', zh: '握个拳', en: 'Make a fist' },
    arms: { icon: 'arms', zh: '举高手', en: 'Arms up' },
    blow: { icon: 'blow', zh: '吹口气', en: 'Blow' }
  };
  function cue(id, zh, en) { return { id: id, icon: G[id].icon, zh: G[id].zh, en: G[id].en, does: [zh, en] }; }
  function cuesNow() {
    if (mode !== 'interactive') return [];
    if (screen === 'gift') return opened ? [cue('swipe', '翻开相册', 'Open the album')] : [cue('smile', '打开礼物', 'Opens the gift')];
    if (screen === 'album') {
      return year ? [cue('swipe', '下一张', 'Next photo'), cue('fist', '回到相册', 'Back to the album')]
                  : [cue('smile', '撒彩带', 'Confetti'), cue('cry', '求抱抱', 'Gets a hug'), cue('swipe', '下一张', 'Next photo'), cue('heart', '送爱心', 'Hearts'), cue('palms', '看这一年', 'This year’s photos')];
    }
    if (screen === 'ages') return [cue('smile', '撒彩带', 'Confetti'), cue('swipe', '下一章', 'Next chapter')];
    if (screen === 'together') return [cue('heart', '抱一抱', 'A big hug'), cue('swipe', '去许愿', 'To the cake')];
    if (screen === 'cake') return blown ? [cue('arms', '放烟花', 'Fireworks'), cue('swipe', '下一章', 'Next chapter')] : [cue('blow', '吹蜡烛', 'Blows the candles')];
    if (screen === 'names') return [cue('swipe', '下一个', 'Next name'), cue('heart', '送爱心', 'Hearts')];
    return [];
  }
  function cueRow() {
    var list = cuesNow();
    return list.length ? '<div class="x x-cues" id="cues">' + list.map(function (c) { return T.cue(c); }).join('') + '</div>' : '';
  }

  /* ---------- screens ---------- */
  function mascot() { return T.mascot('plush', mood, 'tu-mascot--bob'); }
  function setMood(m) { mood = m; var el = view.querySelector('.x-mood'); if (el) el.innerHTML = mascot(); }
  function hint(items) { return '<div class="x x-foot">' + T.hint(items) + '</div>'; }
  var NEXT = ['OK', '下一章', 'Next'];

  var SCREENS = {
    opening: function () {
      return '<div class="x x-head x-fade">' + T.bi('亲爱的' + name.zh, 'Dear ' + name.en, 'tu-title') + T.bi('十岁生日快乐！', 'Happy 10th Birthday!', 'tu-hero') + '</div>' +
        '<div class="x x-mascot x-mood">' + mascot() + '</div>' +
        '<div class="x x-ask">' + T.bi('准备好了吗？选一种玩法吧', 'Ready? Pick a way to play', 'tu-title') + '</div>' +
        '<div class="x x-modes">' + T.modeCard('interactive', focus === 0 ? 'is-focus' : '') + T.modeCard('watch', focus === 1 ? 'is-focus' : '') + '</div>' +
        hint([['← →', '选择', 'Choose'], ['OK', '确认', 'Confirm']]);
    },
    gift: function () {
      return '<div class="x x-col x-fade">' + T.bi('你是上天送给\n爸爸妈妈的礼物', 'You are heaven’s gift to Mom and Dad', 'tu-hero x-big') +
        (opened ? T.bi('是你呀！这是爸爸妈妈收到过最好的礼物', 'It’s you! The best gift Mom and Dad ever got', 'tu-body')
                : T.bi('十年前的今天，有一份礼物来到我们家。猜猜是谁？', 'Ten years ago today, a gift arrived at our home. Guess who?', 'tu-body')) +
        T.button(opened ? '翻开相册' : '打开礼物', opened ? 'Open the album' : 'Open the gift', { primary: true, icon: opened ? 'play' : 'gift', cls: 'is-focus', act: 'ok' }) + '</div>' +
        '<div class="x x-giftbox">' + T.gift('plush', opened) + '</div>' + cueRow();
    },
    album: function () {
      if (year) {
        var p = photos[cur];
        return '<div class="x x-yearroom"></div><div class="x x-head">' + T.bi(p.age + ' 岁这一年', 'The year you were ' + p.age, 'tu-title') + '<span id="yr"></span></div>' +
          '<div id="gal"></div><div class="x x-note" id="note"></div>' + cueRow() + hint([['← →', '翻页', 'Browse'], ['↑', '回到相册', 'Back']]);
      }
      return '<div class="x x-head">' + T.bi('看，你是这样一点点长大的', 'Look how you grew, little by little', 'tu-title') + '<span id="yr"></span></div>' +
        '<div class="x x-corner x-mood">' + mascot() + '</div><div id="gal"></div><div class="x x-note" id="note"></div>' +
        '<div class="x x-rail" id="rail"></div>' + cueRow() +
        hint(mode === 'watch' ? [['← →', '翻页', 'Browse'], ['↓', '这一年', 'This year'], NEXT] : [NEXT]);
    },
    ages: function () {
      return '<div class="x x-center x-fade" style="top:40px">' + T.bi('你十岁，爸爸也十岁，妈妈十一岁', 'You are 10. Dad is 10 too. Mom is 11.', 'tu-title tu-bi--center') + '</div>' +
        '<div class="x x-center x-fade" style="top:152px">' + T.bi('我们也是第一次当爸爸妈妈，是和你一起长大的', 'It was our first time being Mom and Dad — we grew up together with you', 'tu-body tu-bi--center') + '</div>' +
        '<div class="x x-center x-fade" style="top:240px">' + T.ages(10, avatars) + '</div>' + cueRow() + hint([NEXT]);
    },
    together: function () {
      return '<div class="x x-fade" style="left:210px;top:60px">' + T.bi('这十年，每一天都有你', 'For ten years, every single day had you in it', 'tu-title') + '</div>' +
        '<div class="x" style="left:210px;top:270px">' + T.together() + '</div>' +
        '<div class="x x-fade x-close" style="left:210px;top:690px;animation-delay:1.4s">' + T.bi('所以，每一天我们都想好好陪你', 'So we want to be right here with you, every day', 'tu-hero') + '</div>' +
        cueRow() + hint([['OK', '去许愿', 'Make a wish']]);
    },
    cake: function () {
      return '<div class="x x-col x-fade">' + (blown ? T.bi('生日快乐！', 'Happy Birthday!', 'tu-hero') + T.bi('不管你长多大，\n爸爸妈妈永远爱你', 'However big you grow,\nMom and Dad will always love you', 'tu-title')
                                                  : T.bi('许个愿，吹蜡烛！', 'Make a wish, then blow!', 'tu-hero x-big') + T.bi('十根蜡烛，都是为你点亮的', 'Ten candles, all lit just for you', 'tu-body')) +
        T.button(blown ? '看看以后的你' : '呼——吹！', blown ? 'A peek at the years ahead' : 'Blow!', { primary: true, icon: blown ? 'play' : 'blow', cls: 'is-focus', act: 'ok' }) + '</div>' +
        '<div class="x x-mood x-cakepal">' + T.mascot('plush', blown ? 'wow' : 'happy', 'tu-mascot--bob') + '</div>' +
        '<div class="x x-cakebox">' + T.cake(blown) + '</div>' + cueRow();
    },
    names: function () {
      return '<div class="x x-head x-fade">' + T.bi('每一个年岁，都有一个好听的名字', 'Every age has a beautiful name of its own', 'tu-title') +
        T.bi('今天你十岁，古人把它叫作“幼学”。往后的每一岁，我们都陪你慢慢走', 'Today you are ten — the ancients called it Youxue. We will walk every year ahead with you', 'tu-body') + '</div>' +
        '<div class="x x-center" style="top:256px" id="namecard"></div>' +
        '<div class="x x-rail x-rail--names" id="rail"></div>' + cueRow() +
        hint([['← →', '换一个', 'Browse'], ['OK', '再看一遍', 'Play it again']]);
    }
  };

  function onAlbum(i, p) {
    var r = document.getElementById('rail'), y = document.getElementById('yr'), n = document.getElementById('note');
    if (n) n.innerHTML = T.noteCard(p.note);
    if (year) {
      if (y) y.innerHTML = T.bi(p.zh + ' · 第 ' + (i + 1) + ' / ' + year.length + ' 张', p.en + ' · photo ' + (i + 1) + ' of ' + year.length, 'tu-body');
      return;
    }
    cur = i;
    if (r) r.innerHTML = T.rail(i, photos.length);
    if (y) y.innerHTML = T.bi('这一年：你 ' + p.age + ' 岁 · 爸爸 ' + p.age + ' 岁 · 妈妈 ' + (p.age + 1) + ' 岁', 'This year: you ' + p.age + ' · Dad ' + p.age + ' · Mom ' + (p.age + 1), 'tu-body');
  }
  function drawName() {
    var c = document.getElementById('namecard'), r = document.getElementById('rail');
    if (c) c.innerHTML = '<div class="x-fade">' + T.nameCard(nameAt, nameAt === 0) + '</div>';
    if (r) r.innerHTML = T.rail(nameAt, T.ageNames.map(function (n) { return n.age; }));
  }
  function stepName(d) { var n = T.ageNames.length; nameAt = (nameAt + d + n) % n; drawName(); schedule(); }

  /* the album moves forward to the next chapter after the last photo; it does not wrap round */
  function albumNext() { if (year) gal.next(); else if (cur >= photos.length - 1) ok(); else gal.next(); schedule(); }
  function albumPrev() { if (year) gal.prev(); else if (cur > 0) gal.prev(); schedule(); }
  function enterYear() {
    if (screen !== 'album' || year) return;
    var list = T.yearPhotos(photos[cur]);
    if (list.length < 2) { T.toast(stage, '这一年只有一张照片', 'Just one photo for this year'); return; }
    year = list; render();
  }
  function exitYear() { if (year) { year = null; render(); } }

  /* watch mode keeps moving by itself; any key press restarts the wait */
  function schedule() {
    clearTimeout(timer);
    if (mode !== 'watch' || year) return;
    var ms = screen === 'album' ? watch.photoMs : screen === 'gift' ? (opened ? 7000 : 3500) : screen === 'names' ? 7000 : screen === 'cake' ? 0 : watch.chapterMs;
    if (!ms || screen === 'opening') return;
    timer = setTimeout(function () {
      if (screen === 'album') albumNext();
      else if (screen === 'names') { if (nameAt < T.ageNames.length - 1) stepName(1); }
      else ok();
    }, ms);
  }

  function render() {
    gal = null;
    stage.classList.toggle('is-year', !!year);
    view.innerHTML = SCREENS[screen]();
    if (screen === 'album') {
      gal = T.gallery(document.getElementById('gal'), { photos: year || photos, start: year ? 0 : cur, onChange: onAlbum });
      onAlbum(year ? 0 : cur, (year || photos)[year ? 0 : cur]);
    }
    if (screen === 'names') drawName();
    if (camOn) Sense.arm(cuesNow().map(function (c) { return c.id; }));
    if (mode) tune();
    schedule();
  }
  function go(s) {
    screen = s; mood = 'happy'; year = null;
    if (s === 'names') nameAt = 0;
    if (s === 'opening') { opened = false; blown = false; cur = 0; stopCamera(); mode = null; }
    render();
  }

  /* ---------- camera ---------- */
  function note(zh, en) { camNote.innerHTML = zh ? '<span class="zh" lang="zh-Hans">' + zh + '</span><span class="en" lang="en">' + en + '</span>' : ''; }
  function startCamera() {
    stage.classList.add('has-cam');
    note('正在唤醒镜头…', 'Waking up the camera…');
    var cam = {}, k, base = CFG.camera || {};
    for (k in base) cam[k] = base[k];
    if (Q.local) cam.local = true;
    Sense.start({
      video: video, config: cam, cpu: !!Q.cpu,
      onProgress: function (id, p) { var b = view.querySelector('[data-cue="' + id + '"]'); if (b) b.style.setProperty('--p', p.toFixed(0)); },
      onFire: gesture,
      onScores: Q.debug ? function (sc) { debugBox.textContent = Object.keys(sc).map(function (id) { return (id + '     ').slice(0, 6) + sc[id].toFixed(2); }).join('\n'); } : null
    }).then(function () {
      camOn = true; note('', '');
      Sense.arm(cuesNow().map(function (c) { return c.id; }));
    }).catch(function (e) {
      if (window.console) console.warn('camera unavailable:', e && e.message ? e.message : e);
      stage.classList.remove('has-cam'); camOn = false; mode = 'watch';
      T.toast(stage, '镜头没准备好，改为观看模式', 'Camera is not ready — switching to Just watch');
      render();
    });
  }
  function stopCamera() { if (Sense) Sense.stop(); camOn = false; stage.classList.remove('has-cam'); }

  /* ---------- music ---------- */
  function tune() {
    T.music.volume(music.volume);
    T.music.play(screen === 'opening' ? '' : (screen === 'cake' && blown) || screen === 'names' ? (music.cake || music.album) : music.album);
  }

  /* ---------- actions ---------- */
  function ok() {
    if (screen === 'opening') {
      mode = focus ? 'watch' : 'interactive';
      go('gift');
      if (mode === 'interactive') startCamera();
    }
    else if (screen === 'gift') { if (!opened) { opened = true; render(); T.burst(stage, 'hearts', 30); } else go('album'); }
    else if (screen === 'album') go('ages');
    else if (screen === 'ages') go('together');
    else if (screen === 'together') go('cake');
    else if (screen === 'cake') { if (!blown) { blown = true; render(); T.burst(stage, 'fireworks', 60); T.burst(stage, 'confetti', 50); } else go('names'); }
    else if (screen === 'names') go('opening');
  }
  function back() {
    if (year) { exitYear(); return; }
    var i = ORDER.indexOf(screen); if (i > 0) go(ORDER[i - 1]);
  }

  /* dir: 'next' or 'prev', only for 'swipe' */
  function gesture(id, dir) {
    var c = cuesNow().filter(function (x) { return x.id === id; })[0];
    if (!c) return;
    var b = view.querySelector('[data-cue="' + id + '"]');
    if (b) {
      b.outerHTML = T.cue(c, { on: true, p: 100 });
      setTimeout(function () { var n = view.querySelector('[data-cue="' + id + '"].is-on'); if (n) n.outerHTML = T.cue(c); }, 1200);
    }
    var prev = dir === 'prev';
    if (screen === 'album') {
      if (id === 'swipe') { if (prev) albumPrev(); else albumNext(); if (!year) setMood('wink'); }
      else if (id === 'palms') enterYear();
      else if (id === 'fist') exitYear();
      else if (id === 'smile') { setMood('happy'); T.burst(stage, 'confetti', 60); T.toast(stage, '笑得真甜！', 'What a lovely smile!'); }
      else if (id === 'cry') { setMood('cry'); T.burst(stage, 'tears', 22); T.toast(stage, '不哭不哭，抱一个', 'There, there — come here for a hug'); setTimeout(function () { setMood('happy'); }, 2200); }
      else if (id === 'heart') { setMood('wow'); T.burst(stage, 'hearts', 34); T.toast(stage, '爱心收到啦，我们也爱你', 'Got your heart — we love you too'); }
      return;
    }
    if (screen === 'names') { if (id === 'swipe') stepName(prev ? -1 : 1); else T.burst(stage, 'hearts', 34); return; }
    if (id === 'swipe') { if (prev) back(); else ok(); return; }
    if (screen === 'gift') { ok(); return; }
    if (screen === 'ages') { T.burst(stage, 'confetti', 60); return; }
    if (screen === 'together') { T.burst(stage, 'hearts', 40); T.toast(stage, '爸爸妈妈抱抱你', 'A big hug from Mom and Dad'); return; }
    if (screen === 'cake') { if (blown) T.burst(stage, 'fireworks', 60); else ok(); }
  }

  view.addEventListener('click', function (e) {
    var a = e.target.closest('[data-act]'); if (!a) return;
    var act = a.getAttribute('data-act');
    if (act === 'mode') { focus = a.getAttribute('data-mode') === 'watch' ? 1 : 0; ok(); }
    else if (act === 'ok' || act === 'gift' || act === 'blow') ok();
    else if (act === 'cue') gesture(a.getAttribute('data-cue'), 'next');
    else if (act === 'go') {
      if (screen === 'names') { nameAt = +a.getAttribute('data-i'); drawName(); schedule(); }
      else if (gal) { gal.go(+a.getAttribute('data-i')); schedule(); }
    }
  });
  document.addEventListener('keydown', function (e) {
    var k = e.keyCode, SIM = ['smile', 'cry', 'swipe', 'heart', 'palms', 'fist', 'arms', 'blow'];
    if (k === 37 || k === 39) {
      if (screen === 'opening') { focus = k === 39 ? 1 : 0; render(); }
      else if (screen === 'names') stepName(k === 39 ? 1 : -1);
      else if (gal) { if (k === 39) albumNext(); else albumPrev(); }
      e.preventDefault();
    } else if (k === 40) { enterYear(); e.preventDefault(); }
    else if (k === 38) { exitYear(); e.preventDefault(); }
    else if (k === 13 || k === 32) { if (year) exitYear(); else ok(); e.preventDefault(); }
    else if (k === 10009 || k === 27 || k === 8 || k === 4) { back(); e.preventDefault(); }
    else if (k === 77) { T.toast(stage, T.music.mute() ? '音乐已静音' : '音乐已打开', T.music.muted ? 'Music muted' : 'Music on'); }
    else if (k === 70) {
      var d = document, el = d.documentElement;
      try { if (d.fullscreenElement) d.exitFullscreen(); else if (el.requestFullscreen) el.requestFullscreen(); } catch (err) {}
    } else if (k >= 49 && k <= 56 && mode === 'interactive') gesture(SIM[k - 49], 'next');
  });

  /* ---------- album: this browser's photos, else the album file, else album/N.jpg, else placeholders ---------- */
  function exists(url) {
    return new Promise(function (res) {
      var img = new Image();
      img.onload = function () { res(true); };
      img.onerror = function () { res(false); };
      img.src = url;
    });
  }
  /* album/3.jpg is the cover for age 3; album/3-1.jpg, album/3-2.jpg … are more photos from that year */
  function probe(list) {
    if (CFG.albumFolder === false || T.cloud.on) return Promise.resolve(list);      /* with the family server the album lives there, not in the folder */
    return Promise.all(list.map(function (p) {
      var cover = p.src ? Promise.resolve() : exists('album/' + p.age + '.jpg').then(function (yes) { if (yes) p.src = 'album/' + p.age + '.jpg'; });
      function more(j) {
        if (p.more.length >= T.MAX_MORE) return null;
        var url = 'album/' + p.age + '-' + j + '.jpg';
        return exists(url).then(function (yes) { if (yes) { p.more.push(url); return more(j + 1); } return null; });
      }
      return cover.then(function () { return p.more.length ? null : more(1); }).then(function () { return p; });
    }));
  }
  function loadAlbum() {
    var file = window.TENUP_ALBUM || null;
    return Promise.all([T.store.get('photos'), T.store.get('meta'), T.store.get('music')]).then(function (r) {
      var saved = r[0] || [], meta = r[1] || {}, fname = (file && file.name) || {};
      music = T.music.defaults(r[2] || (file && file.music));
      if (meta.zh || fname.zh) name.zh = meta.zh || fname.zh;
      if (meta.en || fname.en) name.en = meta.en || fname.en;
      var a = meta.avatars || {}, b = (file && file.avatars) || {};
      avatars = { girl: a.girl || b.girl || '', dad: a.dad || b.dad || '', mom: a.mom || b.mom || '' };
      function pick(list, age) { return (list || []).filter(function (x) { return x.age === age; })[0] || {}; }
      return probe(T.photos.map(function (p) {
        var s = pick(saved, p.age), f = pick(file && file.photos, p.age);
        var own = s.more && s.more.length;
        return { age: p.age, zh: s.zh || f.zh || p.zh, en: s.en || f.en || p.en, src: s.src || f.src || '', note: s.src ? s.note || null : f.note || null,
          more: (own ? s.more : f.more || []).slice(0, T.MAX_MORE), moreNotes: (own ? s.moreNotes : f.moreNotes) || [] };
      }));
    });
  }

  render();
  function refresh() { return loadAlbum().then(function (list) { photos = list; if (cur >= photos.length) cur = 0; if (screen === 'opening' || screen === 'album' || screen === 'ages') render(); }).catch(function () {}); }
  /* with the family server: follow what the other devices change; without it this resolves at once and nothing differs */
  T.cloud.init().then(function (on) { if (on) T.cloud.onChange(function (remote) { if (remote && !year) refresh(); }); return refresh(); });
  if (Q.mode === 'watch' || Q.mode === 'interactive') { focus = Q.mode === 'watch' ? 1 : 0; ok(); }
})();
