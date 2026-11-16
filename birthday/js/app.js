/* 十岁啦 · 体验页 The TV experience
   章节 Chapters: opening → gift → album → ages → together → cake
   遥控器 / 键盘: ← → 翻页或选择，OK(Enter) 下一步，返回(Back/Esc) 上一章，F 全屏。
   互动模式下摄像头动作与按键等效；数字键 1–6 可以模拟动作。 */
(function () {
  'use strict';
  var T = window.TenUp, CFG = window.TENUP_CONFIG || {}, Sense = window.TenUpSense;
  var stage = document.getElementById('stage'), view = document.getElementById('view'), fitBox = document.getElementById('fit');
  var camBox = document.getElementById('cam'), video = camBox.querySelector('video'), camNote = camBox.querySelector('.x-camnote'), debugBox = document.getElementById('debug');
  var Q = {};
  location.search.replace(/^\?/, '').split('&').forEach(function (kv) { if (kv) { var p = kv.split('='); Q[decodeURIComponent(p[0])] = decodeURIComponent(p[1] || '1'); } });

  var ORDER = ['opening', 'gift', 'album', 'ages', 'together', 'cake'];
  var name = { zh: (CFG.name && CFG.name.zh) || '小寿星', en: (CFG.name && CFG.name.en) || 'Birthday Girl' };
  var photos = T.photos, mode = null, screen = 'opening', focus = 0, cur = 0, opened = false, blown = false, mood = 'happy';
  var gal = null, timer = null, camOn = false;
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
    wave: { icon: 'wave', zh: '挥挥手', en: 'Wave' },
    heart: { icon: 'heart', zh: '比个心', en: 'Heart hands' },
    arms: { icon: 'arms', zh: '举高手', en: 'Arms up' },
    blow: { icon: 'blow', zh: '吹口气', en: 'Blow' }
  };
  function cue(id, zh, en) { return { id: id, icon: G[id].icon, zh: G[id].zh, en: G[id].en, does: [zh, en] }; }
  function cuesNow() {
    if (mode !== 'interactive') return [];
    if (screen === 'gift') return opened ? [cue('wave', '翻开相册', 'Open the album')] : [cue('smile', '打开礼物', 'Opens the gift')];
    if (screen === 'album') return [cue('smile', '撒彩带', 'Confetti'), cue('cry', '求抱抱', 'Gets a hug'), cue('wave', '下一张', 'Next photo'), cue('heart', '送爱心', 'Hearts'), cue('arms', '下一章', 'Next chapter')];
    if (screen === 'ages') return [cue('smile', '撒彩带', 'Confetti'), cue('wave', '下一章', 'Next chapter')];
    if (screen === 'together') return [cue('heart', '抱一抱', 'A big hug'), cue('wave', '去许愿', 'To the cake')];
    if (screen === 'cake') return blown ? [cue('smile', '放烟花', 'Fireworks'), cue('wave', '再看一遍', 'Play it again')] : [cue('blow', '吹蜡烛', 'Blows the candles')];
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
        '<div class="x x-ask">' + T.bi('要一起玩互动吗？', 'Want to play along with the camera?', 'tu-title') + '</div>' +
        '<div class="x x-modes">' + T.modeCard('interactive', focus === 0 ? 'is-focus' : '') + T.modeCard('watch', focus === 1 ? 'is-focus' : '') + '</div>' +
        hint([['← →', '选择', 'Choose'], ['OK', '确认', 'Confirm']]);
    },
    gift: function () {
      return '<div class="x x-col x-fade">' + T.bi('你是上天送给\n爸爸妈妈的礼物', 'You are heaven’s gift to Mom and Dad', 'tu-hero x-big') +
        (opened ? T.bi('十年前的今天，我们收到了这辈子最好的礼物', 'Ten years ago today, the best gift of our lives arrived', 'tu-body')
                : T.bi('猜猜盒子里是谁？', 'Guess who is inside the box?', 'tu-body')) +
        T.button(opened ? '翻开相册' : '打开礼物', opened ? 'Open the album' : 'Open the gift', { primary: true, icon: opened ? 'play' : 'gift', cls: 'is-focus', act: 'ok' }) + '</div>' +
        '<div class="x x-giftbox">' + T.gift('plush', opened) + '</div>' + cueRow();
    },
    album: function () {
      return '<div class="x x-head">' + T.bi('成长相册', 'Growing up, ages 0–10', 'tu-title') + '<span id="yr"></span></div>' +
        '<div class="x x-corner x-mood">' + mascot() + '</div><div id="gal"></div>' +
        '<div class="x x-rail' + (mode === 'watch' ? ' x-rail--low' : '') + '" id="rail"></div>' + cueRow() +
        hint(mode === 'watch' ? [['← →', '翻页', 'Browse'], NEXT] : [NEXT]);
    },
    ages: function () {
      return '<div class="x x-center x-fade" style="top:54px">' + T.bi('你十岁，爸爸也十岁，妈妈十一岁', 'You are 10. Dad is 10 too. Mom is 11.', 'tu-title tu-bi--center') + '</div>' +
        '<div class="x x-center x-fade" style="top:236px">' + T.ages(10) + '</div>' + cueRow() + hint([NEXT]);
    },
    together: function () {
      return '<div class="x x-fade" style="left:210px;top:60px">' + T.bi('这十年，我们天天在一起', 'For ten years, we have been together every day', 'tu-title') + '</div>' +
        '<div class="x" style="left:210px;top:270px">' + T.together() + '</div>' +
        '<div class="x x-fade x-close" style="left:210px;top:690px;animation-delay:1.4s">' + T.bi('所以，我们一起好好过每一天', 'So let\u2019s enjoy every day together', 'tu-hero') + '</div>' +
        cueRow() + hint([['OK', '去许愿', 'Make a wish']]);
    },
    cake: function () {
      return '<div class="x x-col x-fade">' + (blown ? T.bi('生日快乐！', 'Happy Birthday!', 'tu-hero') + T.bi('爸爸妈妈永远爱你', 'Mom and Dad love you, always', 'tu-title')
                                                  : T.bi('许个愿，吹蜡烛！', 'Make a wish, then blow!', 'tu-hero x-big') + T.bi('十根蜡烛，十年的故事', 'Ten candles for ten years of stories', 'tu-body')) +
        T.button(blown ? '再看一遍' : '呼——吹！', blown ? 'Play it again' : 'Blow!', { primary: true, icon: blown ? 'play' : 'blow', cls: 'is-focus', act: 'ok' }) + '</div>' +
        '<div class="x x-mood" style="left:96px;bottom:' + (mode === 'interactive' ? 170 : 54) + 'px">' + T.mascot('plush', blown ? 'wow' : 'happy', 'tu-mascot--bob') + '</div>' +
        '<div class="x x-cakebox">' + T.cake(blown) + '</div>' + cueRow();
    }
  };

  function onAlbum(i, p) {
    cur = i;
    var r = document.getElementById('rail'), y = document.getElementById('yr');
    if (r) r.innerHTML = T.rail(i, photos.length);
    if (y) y.innerHTML = T.bi('这一年：你 ' + p.age + ' 岁 · 爸爸 ' + p.age + ' 岁 · 妈妈 ' + (p.age + 1) + ' 岁', 'This year: you ' + p.age + ' · Dad ' + p.age + ' · Mom ' + (p.age + 1), 'tu-body');
  }

  /* watch mode keeps moving by itself; any key press restarts the wait */
  function schedule() {
    clearTimeout(timer);
    if (mode !== 'watch') return;
    var ms = screen === 'album' ? watch.photoMs : screen === 'gift' ? (opened ? 7000 : 3500) : screen === 'cake' ? 0 : watch.chapterMs;
    if (!ms || screen === 'opening') return;
    timer = setTimeout(function () {
      if (screen === 'album' && cur < photos.length - 1) { gal.next(); schedule(); } else ok();
    }, ms);
  }

  function render() {
    gal = null;
    view.innerHTML = SCREENS[screen]();
    if (screen === 'album') {
      gal = T.gallery(document.getElementById('gal'), { photos: photos, start: cur, onChange: onAlbum });
      onAlbum(cur, photos[cur]);
    }
    if (camOn) Sense.arm(cuesNow().map(function (c) { return c.id; }));
    schedule();
  }
  function go(s) {
    screen = s; mood = 'happy';
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
    else if (screen === 'cake') { if (!blown) { blown = true; render(); T.burst(stage, 'fireworks', 60); T.burst(stage, 'confetti', 50); } else go('opening'); }
  }
  function back() { var i = ORDER.indexOf(screen); if (i > 0) go(ORDER[i - 1]); }

  function gesture(id) {
    var c = cuesNow().filter(function (x) { return x.id === id; })[0];
    if (!c) return;
    var b = view.querySelector('[data-cue="' + id + '"]');
    if (b) {
      b.outerHTML = T.cue(c, { on: true, p: 100 });
      setTimeout(function () { var n = view.querySelector('[data-cue="' + id + '"].is-on'); if (n) n.outerHTML = T.cue(c); }, 1500);
    }
    if (screen === 'gift') { ok(); return; }
    if (screen === 'album') {
      if (id === 'smile') { setMood('happy'); T.burst(stage, 'confetti', 60); T.toast(stage, '笑得真甜！', 'What a smile!'); }
      if (id === 'cry') { setMood('cry'); T.burst(stage, 'tears', 22); T.toast(stage, '抱抱，不哭啦', 'Aww — here is a hug'); setTimeout(function () { setMood('happy'); }, 2200); }
      if (id === 'wave') { gal.next(); setMood('wink'); }
      if (id === 'heart') { setMood('wow'); T.burst(stage, 'hearts', 34); T.toast(stage, '收到你的爱心', 'Hearts received'); }
      if (id === 'arms') ok();
      return;
    }
    if (screen === 'ages') { if (id === 'smile') T.burst(stage, 'confetti', 60); else ok(); return; }
    if (screen === 'together') { if (id === 'heart') { T.burst(stage, 'hearts', 40); T.toast(stage, '爸爸妈妈抱抱你', 'A big hug from Mom and Dad'); } else ok(); return; }
    if (screen === 'cake') { if (blown && id === 'smile') T.burst(stage, 'fireworks', 60); else ok(); }
  }

  view.addEventListener('click', function (e) {
    var a = e.target.closest('[data-act]'); if (!a) return;
    var act = a.getAttribute('data-act');
    if (act === 'mode') { focus = a.getAttribute('data-mode') === 'watch' ? 1 : 0; ok(); }
    else if (act === 'ok' || act === 'gift' || act === 'blow') ok();
    else if (act === 'cue') gesture(a.getAttribute('data-cue'));
    else if (act === 'go' && gal) { gal.go(+a.getAttribute('data-i')); schedule(); }
  });
  document.addEventListener('keydown', function (e) {
    var k = e.keyCode;
    if (k === 37 || k === 39) {
      if (screen === 'opening') { focus = k === 39 ? 1 : 0; render(); }
      else if (gal) { if (k === 39) gal.next(); else gal.prev(); schedule(); }
      e.preventDefault();
    } else if (k === 13 || k === 32) { ok(); e.preventDefault(); }
    else if (k === 10009 || k === 27 || k === 8) { back(); e.preventDefault(); }
    else if (k === 70) {
      var d = document, el = d.documentElement;
      try { if (d.fullscreenElement) d.exitFullscreen(); else if (el.requestFullscreen) el.requestFullscreen(); } catch (err) {}
    } else if (k >= 49 && k <= 54 && mode === 'interactive') gesture(['smile', 'cry', 'wave', 'heart', 'arms', 'blow'][k - 49]);
  });

  /* ---------- album: this browser's photos, else the album file, else album/N.jpg, else placeholders ---------- */
  function probe(list) {
    return Promise.all(list.map(function (p) {
      if (p.src) return p;
      return new Promise(function (res) {
        var img = new Image();
        img.onload = function () { p.src = 'album/' + p.age + '.jpg'; res(p); };
        img.onerror = function () { res(p); };
        img.src = 'album/' + p.age + '.jpg';
      });
    }));
  }
  function loadAlbum() {
    var file = window.TENUP_ALBUM || null;
    return Promise.all([T.store.get('photos'), T.store.get('meta')]).then(function (r) {
      var saved = r[0] || [], meta = r[1] || (file && file.name) || {};
      if (meta.zh) name.zh = meta.zh;
      if (meta.en) name.en = meta.en;
      function pick(list, age) { return (list || []).filter(function (x) { return x.age === age; })[0] || {}; }
      return probe(T.photos.map(function (p) {
        var a = pick(saved, p.age), b = pick(file && file.photos, p.age);
        return { age: p.age, zh: a.zh || b.zh || p.zh, en: a.en || b.en || p.en, src: a.src || b.src || '' };
      }));
    });
  }

  render();
  loadAlbum().then(function (list) { photos = list; render(); }).catch(function () {});
  if (Q.mode === 'watch' || Q.mode === 'interactive') { focus = Q.mode === 'watch' ? 1 : 0; ok(); }
})();
