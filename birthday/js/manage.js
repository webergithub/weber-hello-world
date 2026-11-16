/* 十岁啦 · 照片管理 Photo manager（在电脑或手机上用）
   照片保存在这个浏览器里；"导出相册包"会下载 album.js，放进 album/ 文件夹后别的设备也能看到。 */
(function () {
  'use strict';
  var T = window.TenUp, CFG = window.TENUP_CONFIG || {}, root = document.getElementById('root');
  var photos = T.photos.map(function (p) { return { age: p.age, zh: p.zh, en: p.en, src: '' }; });
  var meta = { zh: (CFG.name && CFG.name.zh) || '', en: (CFG.name && CFG.name.en) || '' }, target = null, note = null;

  function mini(zh, en, act, cls) { return '<button type="button" class="tu-mini ' + (cls || '') + '" data-act="' + act + '">' + zh + '<small>' + en + '</small></button>'; }
  root.innerHTML = '<div class="tu-mgr"><div class="tu-mgr__head"><div style="display:flex;flex-direction:column">' +
    T.bi('照片管理', 'Photo manager', 'tu-title') + '<span style="height:6px"></span>' + T.bi('每个年龄放一张，电视上的相框会按 0 → 10 岁播放', 'One photo per age — the album plays them from 0 to 10', 'tu-body') +
    '</div><div class="tu-mgr__status" id="status" role="status"></div></div>' +
    '<div class="m-names"><label><span>孩子的名字或小名 · Her name (Chinese)</span><input class="tu-field" id="nzh" maxlength="6" lang="zh-Hans"></label>' +
    '<label><span>英文名 · Her name (English)</span><input class="tu-field" id="nen" maxlength="14" lang="en"></label></div>' +
    '<label class="tu-drop" id="drop">' + T.icon('upload') + '<span style="width:18px"></span>' + T.bi('把照片拖到这里，或点一下选择（可多选）', 'Drop photos here, or tap to choose — several at once is fine') +
    '<input type="file" id="file" accept="image/*" multiple></label><div class="tu-slots" id="slots"></div>' +
    '<div class="m-tools"><a class="tu-mini m-go" href="index.html">去播放<small>Play the album</small></a>' +
    mini('导出相册包', 'Export album file', 'export') + mini('导入相册包', 'Import album file', 'import') + mini('全部清空', 'Clear everything', 'clear', 'tu-mini--danger') +
    '<input type="file" id="pack" accept=".js,.json,application/json,text/javascript"></div>' +
    '<div class="m-help">' + T.bi('照片只保存在这台设备的这个浏览器里，不会上传。要在另一台设备上播放：导出相册包，把下载到的 album.js 放进网站的 album 文件夹。',
      'Photos stay in this browser on this device and are never uploaded. To play on another device, export the album file and put album.js into the site’s album folder.', 'tu-body') + '</div></div>';

  var slots = document.getElementById('slots'), file = document.getElementById('file'), drop = document.getElementById('drop'), status = document.getElementById('status');
  var nzh = document.getElementById('nzh'), nen = document.getElementById('nen'), pack = document.getElementById('pack');

  function count() { return photos.filter(function (p) { return p.src; }).length; }
  function drawStatus() {
    var n = count(), ok = T.store.persistent;
    status.innerHTML = '<span>' + (note ? note[0] : '已导入 ' + n + ' / ' + photos.length + (ok ? ' · 已保存在此浏览器' : ' · 仅本次打开有效')) + '</span>' +
      '<span lang="en">' + (note ? note[1] : n + ' of ' + photos.length + ' imported' + (ok ? ' · saved in this browser' : ' · kept for this visit only')) + '</span>';
  }
  function draw() {
    nzh.value = meta.zh || ''; nen.value = meta.en || '';
    slots.innerHTML = photos.map(function (p, i) {
      return '<div class="tu-slot" data-i="' + i + '"><span class="tu-slot__age">' + p.age + ' 岁<small>age ' + p.age + '</small></span>' +
        '<div class="tu-slot__img" data-act="pick" title="选择照片 Choose a photo">' + (p.src ? '<img alt="" src="' + T.esc(p.src) + '">' : T.placeholder(p)) + '</div>' +
        '<input class="tu-field" data-k="zh" lang="zh-Hans" aria-label="中文说明 Chinese caption，' + p.age + ' 岁" value="' + T.esc(p.zh) + '" maxlength="12">' +
        '<input class="tu-field tu-field--en" data-k="en" lang="en" aria-label="English caption 英文说明, age ' + p.age + '" value="' + T.esc(p.en) + '" maxlength="28">' +
        '<div class="tu-slot__row">' + mini(p.src ? '换一张' : '选照片', p.src ? 'Replace' : 'Choose', 'pick') +
        '<span style="width:8px"></span><button type="button" class="tu-mini tu-mini--danger" data-act="del"' + (p.src ? '' : ' disabled') + '>移除<small>Remove</small></button></div></div>';
    }).join('');
    drawStatus();
  }
  function save() { return Promise.all([T.store.set('photos', photos), T.store.set('meta', meta)]).then(drawStatus); }

  function add(files, at) {
    var list = [].slice.call(files).filter(function (f) { return /^image\//.test(f.type); });
    if (!list.length) { note = ['没有找到图片文件', 'No image files found']; drawStatus(); return; }
    note = ['正在处理 ' + list.length + ' 张…', 'Reading ' + list.length + ' photo(s)…']; drawStatus();
    var order = [], failed = 0;
    if (at != null) order.push(at);
    photos.forEach(function (p, i) { if (!p.src && i !== at) order.push(i); });
    list.slice(0, order.length).reduce(function (chain, f, k) {
      return chain.then(function () { return T.readImage(f, 1600).then(function (src) { photos[order[k]].src = src; }, function () { failed++; }); });
    }, Promise.resolve()).then(function () {
      var extra = list.length - order.length;
      note = failed ? [failed + ' 张读不出来，换一张试试', failed + ' could not be read — try another'] : extra > 0 ? ['相框位满了，多出 ' + extra + ' 张没有导入', 'All slots are full — ' + extra + ' photo(s) were not imported'] : null;
      draw(); save();
    });
  }

  function exportPack() {
    var text = '/* 十岁啦 相册包 — 放进网站的 album 文件夹，文件名保持 album.js */\nwindow.TENUP_ALBUM = ' + JSON.stringify({ v: 1, name: meta, photos: photos }) + ';\n';
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));
    a.download = 'album.js';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
    note = ['已导出 album.js，把它放进 album 文件夹', 'Exported album.js — put it into the album folder']; drawStatus();
  }
  function importPack(f) {
    var rd = new FileReader();
    rd.onload = function () {
      try {
        var s = String(rd.result), data = JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1));
        if (!data || !data.photos) throw new Error('shape');
        meta = { zh: (data.name && data.name.zh) || meta.zh, en: (data.name && data.name.en) || meta.en };
        photos = T.photos.map(function (p) {
          var x = data.photos.filter(function (q) { return q.age === p.age; })[0] || {};
          return { age: p.age, zh: x.zh || p.zh, en: x.en || p.en, src: /^data:image\//.test(x.src || '') ? x.src : '' };
        });
        note = null; draw(); save();
      } catch (e) { note = ['这个文件不是相册包', 'That file is not an album file']; drawStatus(); }
    };
    rd.readAsText(f);
  }

  root.addEventListener('click', function (e) {
    var a = e.target.closest('[data-act]'); if (!a) return;
    var act = a.getAttribute('data-act'), s = e.target.closest('.tu-slot');
    if (act === 'pick' && s) { target = +s.getAttribute('data-i'); file.click(); }
    else if (act === 'del' && s) { photos[+s.getAttribute('data-i')].src = ''; note = null; draw(); save(); }
    else if (act === 'export') exportPack();
    else if (act === 'import') pack.click();
    else if (act === 'clear') {
      if (!window.confirm('清空全部照片和说明？这一步不能撤销。\nClear all photos and captions? This cannot be undone.')) return;
      photos = T.photos.map(function (p) { return { age: p.age, zh: p.zh, en: p.en, src: '' }; });
      note = null; draw(); save();
    }
  });
  slots.addEventListener('change', function (e) {
    var s = e.target.closest('.tu-slot'), k = e.target.getAttribute('data-k'); if (!s || !k) return;
    var i = +s.getAttribute('data-i');
    photos[i][k] = e.target.value.trim() || T.photos[i][k];
    e.target.value = photos[i][k]; note = null; save();
  });
  nzh.addEventListener('change', function () { meta.zh = nzh.value.trim(); note = null; save(); });
  nen.addEventListener('change', function () { meta.en = nen.value.trim(); note = null; save(); });
  file.addEventListener('change', function () { add(file.files, target); target = null; file.value = ''; });
  pack.addEventListener('change', function () { if (pack.files[0]) importPack(pack.files[0]); pack.value = ''; });
  drop.addEventListener('click', function () { target = null; });
  ['dragenter', 'dragover'].forEach(function (ev) {
    root.addEventListener(ev, function (e) {
      e.preventDefault();
      var s = e.target.closest && e.target.closest('.tu-slot');
      [].forEach.call(slots.children, function (c) { c.classList.toggle('is-over', c === s); });
      drop.classList.toggle('is-over', !s);
    });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    root.addEventListener(ev, function (e) {
      e.preventDefault();
      if (ev === 'drop') { var s = e.target.closest && e.target.closest('.tu-slot'); add(e.dataTransfer.files, s ? +s.getAttribute('data-i') : null); }
      if (ev === 'drop' || !root.contains(e.relatedTarget)) { drop.classList.remove('is-over'); [].forEach.call(slots.children, function (c) { c.classList.remove('is-over'); }); }
    });
  });

  draw();
  Promise.all([T.store.get('photos'), T.store.get('meta')]).then(function (r) {
    var saved = r[0], file = window.TENUP_ALBUM;
    if (r[1]) meta = { zh: r[1].zh || '', en: r[1].en || '' };
    if (saved) photos = T.photos.map(function (p) {
      var x = saved.filter(function (q) { return q.age === p.age; })[0] || {};
      return { age: p.age, zh: x.zh || p.zh, en: x.en || p.en, src: x.src || '' };
    });
    draw();
  });
})();
