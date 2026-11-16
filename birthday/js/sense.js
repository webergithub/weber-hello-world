/* 十岁啦 · 摄像头识别 Camera sensing
   Face blendshapes + hand landmarks, all on this computer. Nothing is recorded or uploaded.
   TenUpSense.start({ video, config, cpu, onProgress(id, 0–100), onFire(id), onScores(scores) }) → Promise
   TenUpSense.arm(['smile', 'wave', …])   which gestures count right now
   TenUpSense.stop() */
(function () {
  'use strict';
  var S = {}, face = null, hands = null, stream = null, timer = null, opt = null;
  var armed = {}, prog = {}, coolUntil = {}, wristX = [], last = 0, lastFire = 0;
  var IDS = ['smile', 'cry', 'blow', 'wave', 'heart', 'arms'];

  function dist(a, b) { var dx = a.x - b.x, dy = a.y - b.y; return Math.sqrt(dx * dx + dy * dy); }
  function clamp(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

  /* One frame → a 0–1 score per gesture. */
  S.score = function (fr, hr) {
    var sc = { smile: 0, cry: 0, blow: 0, wave: 0, heart: 0, arms: 0 }, b = {}, i;
    var hasFace = fr && fr.faceBlendshapes && fr.faceBlendshapes.length;
    if (hasFace) {
      var cats = fr.faceBlendshapes[0].categories;
      for (i = 0; i < cats.length; i++) b[cats[i].categoryName] = cats[i].score;
      var smile = ((b.mouthSmileLeft || 0) + (b.mouthSmileRight || 0)) / 2;
      var frown = ((b.mouthFrownLeft || 0) + (b.mouthFrownRight || 0)) / 2;
      var pout = b.mouthShrugLower || 0, brow = b.browInnerUp || 0;
      var pucker = Math.max(b.mouthPucker || 0, (b.mouthFunnel || 0) * 1.3);
      sc.smile = clamp(smile);
      /* a pretend-cry face: mouth corners down or lower lip pushed up, inner brows raised, and not smiling */
      sc.cry = clamp(Math.max(frown * 2.4, pout * 0.9 + brow * 0.45) - smile * 1.5);
      sc.blow = clamp(pucker - smile);
    }
    var H = (hr && hr.landmarks) || [], G = (hr && hr.gestures) || [], now = Date.now();
    var headY = hasFace && fr.faceLandmarks && fr.faceLandmarks[0] ? fr.faceLandmarks[0][10].y : 0.3;
    var up = 0, open = 0, love = 0, lead = null;
    for (i = 0; i < H.length; i++) {
      var g = G[i] && G[i][0] ? G[i][0] : { categoryName: '', score: 0 };
      if (H[i][0].y < headY - 0.02 && H[i][9].y < headY) up++;
      if (g.categoryName === 'Open_Palm') { open = Math.max(open, g.score); lead = H[i][0]; }
      if (g.categoryName === 'ILoveYou') love = Math.max(love, g.score);
    }
    if (H.length >= 2) {
      var size = (dist(H[0][0], H[0][9]) + dist(H[1][0], H[1][9])) / 2 || 0.1;
      var gap = Math.max(dist(H[0][8], H[1][8]), dist(H[0][4], H[1][4])) / size;   /* index tips and thumb tips touching */
      sc.heart = clamp(1.5 - gap);
      sc.arms = up >= 2 ? 1 : up === 1 ? 0.4 : 0;
    } else {
      sc.arms = 0;
    }
    sc.heart = Math.max(sc.heart, love);
    /* wave: an open palm, better still a moving one; not while both arms are up or the hands make a heart */
    wristX = wristX.filter(function (p) { return now - p.t < 1200; });
    if (lead) wristX.push({ t: now, x: lead.x });
    var lo = 1, hi = 0;
    for (i = 0; i < wristX.length; i++) { lo = Math.min(lo, wristX[i].x); hi = Math.max(hi, wristX[i].x); }
    var sway = wristX.length > 2 ? clamp((hi - lo) / 0.12) : 0;
    sc.wave = sc.arms >= 1 || sc.heart > 0.6 ? 0 : clamp(open * 0.75 + sway * 0.4);
    return sc;
  };

  function tick() {
    var v = opt.video, now = performance.now(), dt = last ? now - last : opt.config.intervalMs, sc;
    last = now;
    if (v.readyState < 2 || !v.videoWidth) return;
    try {
      sc = S.score(face.detectForVideo(v, now), hands.recognizeForVideo(v, now));
    } catch (e) { return; }
    if (opt.onScores) opt.onScores(sc);
    var th = opt.config.thresholds, t = Date.now(), best = null;
    IDS.forEach(function (id) {
      if (!armed[id] || t < (coolUntil[id] || 0) || t - lastFire < 900) { if (prog[id]) { prog[id] = 0; opt.onProgress(id, 0); } return; }
      var p = prog[id] || 0;
      p += sc[id] >= th[id] ? dt / opt.config.holdMs * 100 : -dt / 350 * 100;
      p = p < 0 ? 0 : p > 100 ? 100 : p;
      if (p !== prog[id]) { prog[id] = p; opt.onProgress(id, p); }
      if (p >= 100 && (!best || sc[id] > sc[best])) best = id;
    });
    if (best) {
      lastFire = t; coolUntil[best] = t + opt.config.cooldownMs;
      IDS.forEach(function (id) { prog[id] = 0; opt.onProgress(id, id === best ? 100 : 0); });
      opt.onFire(best);
    }
  }

  S.arm = function (ids) {
    armed = {};
    (ids || []).forEach(function (id) { armed[id] = true; });
    IDS.forEach(function (id) { if (!armed[id]) prog[id] = 0; });
  };

  S.start = function (o) {
    opt = o;
    var c = o.config, lib = c.local ? c.localLib : c.lib;
    var faceModel = c.local ? c.localFaceModel : c.faceModel, handModel = c.local ? c.localHandModel : c.handModel;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return Promise.reject(new Error('no-camera-api'));
    function abs(u) { var a = document.createElement('a'); a.href = u; return a.href; }
    function make(mod, files, delegate) {
      return Promise.all([
        mod.FaceLandmarker.createFromOptions(files, { baseOptions: { modelAssetPath: abs(faceModel), delegate: delegate }, runningMode: 'VIDEO', numFaces: 1, outputFaceBlendshapes: true }),
        mod.GestureRecognizer.createFromOptions(files, { baseOptions: { modelAssetPath: abs(handModel), delegate: delegate }, runningMode: 'VIDEO', numHands: 2 })
      ]);
    }
    return navigator.mediaDevices.getUserMedia({ audio: false, video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' } })
      .then(function (st) {
        stream = st; o.video.srcObject = st; o.video.muted = true; o.video.setAttribute('playsinline', '');
        return o.video.play();
      })
      .then(function () { return (new Function('u', 'return import(u)'))(abs(lib + '/vision_bundle.mjs')); })
      .then(function (mod) {
        return mod.FilesetResolver.forVisionTasks(abs(lib + '/wasm')).then(function (files) {
          if (o.cpu) return make(mod, files, 'CPU');
          return make(mod, files, 'GPU').catch(function () { return make(mod, files, 'CPU'); });
        });
      })
      .then(function (r) {
        face = r[0]; hands = r[1]; last = 0;
        timer = setInterval(tick, c.intervalMs);
        return true;
      })
      .catch(function (e) { S.stop(); throw e; });
  };

  S.stop = function () {
    clearInterval(timer); timer = null;
    if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
    stream = null;
    try { if (face) face.close(); if (hands) hands.close(); } catch (e) {}
    face = hands = null;
  };
  S.running = function () { return !!timer; };
  window.addEventListener('pagehide', S.stop);
  window.TenUpSense = S;
})();
