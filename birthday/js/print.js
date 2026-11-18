/* 十岁啦 · 打印与导出 M05 Print and export
   把相册排成一本可以打印的书：封面、每岁一页（封面照片、说明、寄语）、这一年的更多照片、结尾页。
   打印窗口里选"存储为 PDF"就是导出 PDF；"下载照片和视频"把全部原图和视频按年龄打包成 ZIP。
   相册的来源和播放页一样：家庭服务器 → 本浏览器保存的 → album/album.js → 占位图。 */
(function () {
  'use strict';
  var T = window.TenUp, CFG = window.TENUP_CONFIG || {};
  var bar = document.getElementById('bar'), pagesBox = document.getElementById('pages'), sizeStyle = document.getElementById('page-size');
  var PAPER = { a4: [297, 210, 'A4'], letter: [279.4, 215.9, 'Letter'] };
  var opt = { paper: 'a4', portrait: false, more: true, notes: true, skipEmpty: true };
  try { var saved = JSON.parse(localStorage.getItem('tenup-print') || 'null'); if (saved) for (var k in opt) if (k in saved) opt[k] = saved[k]; } catch (e) {}
  var album = null, busy = null;

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function bi(zh, en, cls) { return T.bi(zh, en, cls); }

  /* ---------- the album, merged the same way the player does ---------- */
  function load() {
    var file = window.TENUP_ALBUM || null;
    return Promise.all([T.store.get('photos'), T.store.get('meta'), T.store.get('music')]).then(function (r) {
      var saved = r[0] || [], meta = r[1] || {}, fname = (file && file.name) || {}, base = CFG.name || {};
      var a = meta.avatars || {}, b = (file && file.avatars) || {};
      function pick(list, age) { return (list || []).filter(function (x) { return x.age === age; })[0] || {}; }
      return {
        name: { zh: meta.zh || fname.zh || base.zh || '小寿星', en: meta.en || fname.en || base.en || 'Birthday Girl' },
        avatars: { girl: a.girl || b.girl || '', dad: a.dad || b.dad || '', mom: a.mom || b.mom || '' },
        music: T.music.defaults(r[2] || (file && file.music)),
        photos: T.photos.map(function (p) {
          var s = pick(saved, p.age), f = pick(file && file.photos, p.age), own = s.more && s.more.length;
          return { age: p.age, zh: s.zh || f.zh || p.zh, en: s.en || f.en || p.en, src: s.src || f.src || '', video: (s.src ? s.video : f.video) || '',
            note: s.src ? s.note || null : f.note || null, more: (own ? s.more : f.more || []).slice(0, T.MAX_MORE),
            moreNotes: (own ? s.moreNotes : f.moreNotes) || [], moreVideos: (own ? s.moreVideos : f.moreVideos) || [] };
        })
      };
    });
  }

  /* ---------- pages ---------- */
  function pic(src, video, cls) {
    return '<div class="pr-pic ' + (cls || '') + '">' + (src ? '<img alt="" src="' + esc(src) + '">' : '') +
      (video ? '<span class="pr-vid">' + T.icon('play') + '<span>视频</span><span lang="en">Video</span></span>' : '') + '</div>';
  }
  function note(n, small) {
    if (!opt.notes || !T.hasNote(n)) return '';
    return '<div class="pr-note' + (small ? ' pr-note--s' : '') + '">' + (n.text ? '<p class="pr-note__t" lang="zh-Hans">' + esc(n.text) + '</p>' : '') +
      (n.strokes && n.strokes.length ? '<div class="pr-note__ink">' + T.strokesSvg(n.strokes) + '</div>' : '') +
      (n.image ? '<img class="pr-note__img" alt="" src="' + esc(n.image) + '">' : '') + '</div>';
  }
  function foot(n) { return '<div class="pr-foot"><span>' + esc(album.name.zh) + ' · ' + esc(album.name.en) + '</span><span>' + n + '</span></div>'; }
  function cover() {
    var thumbs = album.photos.filter(function (p) { return p.src; }).slice(0, 11);
    return '<section class="pg pg--cover"><div class="pr-cover">' +
      '<div class="pr-cover__pal">' + T.mascot('plush', 'happy') + '</div>' +
      '<div class="pr-cover__txt">' + bi(album.name.zh + '的成长相册', album.name.en + '’s growing-up album', 'pr-h1') +
      bi('十岁生日快乐', 'Happy 10th Birthday', 'pr-h2') +
      bi('你是上天送给爸爸妈妈的礼物', 'You are heaven’s gift to Mom and Dad', 'pr-p') + '</div></div>' +
      (thumbs.length ? '<div class="pr-strip">' + thumbs.map(function (p) { return '<span class="pr-strip__i"><img alt="" src="' + esc(p.src) + '"><b>' + p.age + '</b></span>'; }).join('') + '</div>' : '') +
      '</section>';
  }
  function agePage(p, n) {
    var empty = !p.src;
    return '<section class="pg pg--age"><div class="pr-age">' +
      (empty ? '<div class="pr-pic pr-hero pr-pic--ph">' + T.placeholder(p) + '</div>' : pic(p.src, p.video, 'pr-hero')) +
      '<div class="pr-age__txt"><div class="pr-badge"><b>' + p.age + '</b>' + bi('岁', p.age === 1 ? 'yr' : 'yrs') + '</div>' +
      bi(p.zh, p.en, 'pr-h2') +
      bi('这一年：你 ' + p.age + ' 岁 · 爸爸 ' + p.age + ' 岁 · 妈妈 ' + (p.age + 1) + ' 岁', 'This year: you ' + p.age + ' · Dad ' + p.age + ' · Mom ' + (p.age + 1), 'pr-p') +
      note(p.note) + '</div></div>' + foot(n) + '</section>';
  }
  function morePages(p, start) {
    var per = 4, out = [], items = (p.more || []).map(function (src, j) { return { src: src, video: (p.moreVideos || [])[j], note: (p.moreNotes || [])[j] }; });
    for (var i = 0; i < items.length; i += per) {
      var n = Math.min(per, items.length - i);
      out.push('<section class="pg pg--more"><div class="pr-more__h">' + bi(p.age + ' 岁这一年的更多照片', 'More from the year you were ' + p.age, 'pr-h3') + '</div><div class="pr-grid pr-grid--' + n + '">' +
        items.slice(i, i + per).map(function (it) { return '<figure class="pr-cell">' + pic(it.src, it.video) + note(it.note, true) + '</figure>'; }).join('') +
        '</div>' + foot(start + out.length) + '</section>');
    }
    return out;
  }
  function closing(n) {
    var av = album.avatars;
    function face(src, who, zh, en, age) { return '<div class="pr-face"><div class="pr-face__pic">' + (src ? '<img alt="" src="' + esc(src) + '">' : T.icon(who)) + '</div>' + bi(zh + ' · ' + age + ' 岁', en + ' · ' + age) + '</div>'; }
    return '<section class="pg pg--end"><div class="pr-end">' +
      '<div class="pr-faces">' + face(av.girl, 'girl', '你', 'You', 10) + face(av.dad, 'dad', '爸爸', 'Dad', 10) + face(av.mom, 'mom', '妈妈', 'Mom', 11) + '</div>' +
      bi('我们也是第一次当爸爸妈妈，是和你一起长大的', 'It was our first time being Mom and Dad — we grew up together with you', 'pr-p') +
      bi('不管你长多大，爸爸妈妈永远爱你', 'However big you grow, Mom and Dad will always love you', 'pr-h2') +
      '</div>' + foot(n) + '</section>';
  }
  function render() {
    var list = album.photos, has = list.filter(function (p) { return p.src || (p.more || []).length; });
    if (opt.skipEmpty && has.length) list = has;
    var html = [cover()], n = 2;
    list.forEach(function (p) {
      html.push(agePage(p, n++));
      if (opt.more) morePages(p, n).forEach(function (pg) { html.push(pg); n++; });
    });
    html.push(closing(n));
    pagesBox.innerHTML = html.join('');
    var ppr = PAPER[opt.paper], w = opt.portrait ? ppr[1] : ppr[0], h = opt.portrait ? ppr[0] : ppr[1];
    document.body.classList.toggle('is-portrait', opt.portrait);
    document.documentElement.style.setProperty('--pw', w + 'mm');
    document.documentElement.style.setProperty('--ph', h + 'mm');
    sizeStyle.textContent = '@page{size:' + w + 'mm ' + h + 'mm;margin:0}';
    fit();
    drawBar(html.length);
  }
  /* on screen the pages are shrunk to fit the window; printing uses their real size */
  function fit() {
    var w = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--pw')) * 96 / 25.4 + 32;
    pagesBox.style.zoom = Math.min(1, (document.documentElement.clientWidth - 24) / w).toFixed(3);
  }
  window.addEventListener('resize', fit);

  /* ---------- the bar ---------- */
  function sel(key, zh, en, opts) {
    return '<label class="pr-opt"><span>' + zh + ' · ' + en + '</span><select data-o="' + key + '">' + opts.map(function (o) {
      return '<option value="' + o[0] + '"' + (String(opt[key]) === String(o[0]) ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select></label>';
  }
  function chk(key, zh, en) { return '<label class="pr-chk"><input type="checkbox" data-o="' + key + '"' + (opt[key] ? ' checked' : '') + '><span>' + zh + '<small>' + en + '</small></span></label>'; }
  function drawBar(pageCount) {
    bar.innerHTML = '<div class="pr-bar__in"><div class="pr-bar__h">' + bi('打印与导出', 'Print and export', 'tu-title') +
      '<span class="pr-count">' + (pageCount ? '共 ' + pageCount + ' 页 · ' + pageCount + ' pages' : '') + '</span></div>' +
      '<div class="pr-opts">' + sel('paper', '纸张', 'Paper', [['a4', 'A4'], ['letter', 'Letter 信纸']]) + sel('portrait', '方向', 'Orientation', [['false', '横向 Landscape'], ['true', '纵向 Portrait']]) +
      chk('more', '这一年的更多照片', 'More photos from each year') + chk('notes', '寄语', 'Notes') + chk('skipEmpty', '跳过还没有照片的年龄', 'Skip ages with no photos') + '</div>' +
      '<div class="pr-acts"><button type="button" class="tu-mini tu-mini--go" data-a="print">打印或存成 PDF<small>Print, or save as PDF</small></button>' +
      '<button type="button" class="tu-mini" data-a="zip">下载照片和视频（ZIP）<small>Download photos and videos</small></button>' +
      '<a class="tu-mini" href="manage.html">回到照片管理<small>Back to the photo manager</small></a></div>' +
      '<div class="pr-msg" role="status">' + (busy ? bi(busy[0], busy[1]) : bi('要导出 PDF：在打印窗口把“目标打印机”选成“存储为 PDF”，并勾选“背景图形”。在 iPhone、iPad 上，打印面板里点分享就能存成 PDF。', 'For a PDF, choose “Save as PDF” as the printer and turn on “Background graphics”. On iPhone and iPad, use Share in the print panel.')) + '</div></div>';
    T.tag('M05', '打印与导出', 'Print and export');
  }
  bar.addEventListener('change', function (e) {
    var k = e.target.getAttribute('data-o'); if (!k) return;
    opt[k] = e.target.type === 'checkbox' ? e.target.checked : e.target.value === 'true' ? true : e.target.value === 'false' ? false : e.target.value;
    try { localStorage.setItem('tenup-print', JSON.stringify(opt)); } catch (x) {}
    render();
  });
  /* print only once every picture has arrived, or the PDF has holes */
  function ready() {
    var imgs = [].slice.call(pagesBox.querySelectorAll('img'));
    return Promise.all(imgs.map(function (i) { return i.complete ? null : new Promise(function (r) { i.onload = i.onerror = r; }); }))
      .then(function () { return document.fonts && document.fonts.ready; });
  }
  bar.addEventListener('click', function (e) {
    var a = e.target.closest('[data-a]'); if (!a) return;
    var act = a.getAttribute('data-a');
    if (act === 'print') ready().then(function () {
      var h = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.tenupPrint;
      if (h) h.postMessage(album.name.zh + '的成长相册'); else window.print();      /* the iPad app prints through iOS */
    });
    if (act === 'zip' && !busy) {
      busy = ['正在准备……', 'Getting ready…']; drawBar(pagesBox.children.length);
      T.exportZip(album, function (d, t) { busy = ['正在打包 ' + d + ' / ' + t + '，请不要关闭页面', 'Packing ' + d + ' of ' + t + ' — please keep this page open']; drawBar(pagesBox.children.length); })
        .then(function (blob) {
          /* an English file name: some browsers drop a Chinese one; the folders inside keep their Chinese names */
          var file = (String(album.name.en || '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'TenUp') + '-growing-up-album.zip';
          T.saveFile(blob, file);
          busy = null; drawBar(pagesBox.children.length);
          var m = bar.querySelector('.pr-msg'); if (m) m.innerHTML = bi('已下载：' + file + '（' + (blob.size / 1048576).toFixed(1) + ' MB），里面每个年龄一个文件夹', 'Downloaded ' + file + ' (' + (blob.size / 1048576).toFixed(1) + ' MB), a folder for each age');
        }, function () { busy = null; drawBar(pagesBox.children.length); var m = bar.querySelector('.pr-msg'); if (m) m.innerHTML = bi('打包没有成功，请再试一次', 'Packing did not work — please try again'); });
    }
  });

  drawBar(0);
  T.cloud.init().then(load).then(function (a) { album = a; render(); });
})();
