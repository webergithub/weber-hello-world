/* ============================================================
 * CityTwin 网络适配层（可缺失、可降级）
 *
 * 设计铁律：后端不可用时，游戏必须与加它之前完全一致。
 * 因此本文件所有失败路径都静默回退到 localStorage，绝不抛错、绝不阻塞开局。
 * file:// 离线双击游玩时，探测会直接失败，游戏照常运行。
 * ============================================================ */
(function () {
  'use strict';

  var BASE = '/citytwin/api';
  var LS_TOKEN = 'ct_token';

  var Net = {
    online: false,          // 后端是否可用（探测后确定）
    config: null,           // /api/config 返回内容
    token: null,
    _ready: null,
  };

  function timeout(ms) {
    var c = new AbortController();
    setTimeout(function () { c.abort(); }, ms);
    return c.signal;
  }

  function api(path, opts) {
    opts = opts || {};
    var headers = { 'content-type': 'application/json' };
    if (Net.token) headers.authorization = 'Bearer ' + Net.token;
    return fetch(BASE + path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: timeout(opts.timeoutMs || 6000),
    }).then(function (r) {
      return r.json().catch(function () { return null; }).then(function (j) {
        return { status: r.status, json: j };
      });
    });
  }

  /** 启动探测：拿配置、确保有匿名身份。失败即保持离线模式。 */
  Net.init = function () {
    if (Net._ready) return Net._ready;
    if (location.protocol === 'file:') {          // 离线单机：不探测，直接离线模式
      Net._ready = Promise.resolve(false);
      return Net._ready;
    }
    Net.token = localStorage.getItem(LS_TOKEN);
    Net._ready = api('/config', { timeoutMs: 3500 })
      .then(function (r) {
        if (r.status !== 200 || !r.json) throw new Error('no backend');
        Net.config = r.json;
        Net.online = true;
        if (Net.token) return null;
        // 首次访问：领一个匿名身份（把本地已有昵称/形象带上去）
        var avatar = null;
        try { avatar = JSON.parse(localStorage.getItem('ct_avatar') || 'null'); } catch (e) { avatar = null; }
        return api('/identity', { method: 'POST', body: {
          avatar: avatar, lang: localStorage.getItem('ct_lang') || 'zh',
        } }).then(function (r2) {
          if (r2.status === 200 && r2.json && r2.json.token) {
            Net.token = r2.json.token;
            localStorage.setItem(LS_TOKEN, Net.token);
          }
        });
      })
      .then(function () { return Net.online; })
      .catch(function () { Net.online = false; return false; });
    return Net._ready;
  };

  /** 上报整局摘要。离线或失败均静默忽略——绝不影响结算界面。 */
  Net.submitMatch = function (summary) {
    if (!Net.online || !Net.token) return Promise.resolve(null);
    return api('/matches', { method: 'POST', body: summary })
      .then(function (r) { return r.json; })
      .catch(function () { return null; });
  };

  Net.leaderboard = function (params) {
    if (!Net.online) return Promise.resolve(null);
    var q = Object.keys(params || {}).filter(function (k) { return params[k] != null; })
      .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); }).join('&');
    return api('/leaderboard' + (q ? '?' + q : ''))
      .then(function (r) { return r.json; }).catch(function () { return null; });
  };

  Net.daily = function () {
    if (!Net.online) return Promise.resolve(null);
    return api('/daily').then(function (r) { return r.json; }).catch(function () { return null; });
  };

  /** 云端生涯战绩；离线时回退到 localStorage 的 ct_stats */
  Net.stats = function () {
    if (!Net.online || !Net.token) {
      try { return Promise.resolve(JSON.parse(localStorage.getItem('ct_stats') || 'null')); }
      catch (e) { return Promise.resolve(null); }
    }
    return api('/me').then(function (r) { return r.json && r.json.stats; }).catch(function () { return null; });
  };

  Net.pushProfile = function (patch) {
    if (!Net.online || !Net.token) return Promise.resolve(null);
    return api('/me', { method: 'PUT', body: patch }).then(function (r) { return r.json; }).catch(function () { return null; });
  };

  /** 换设备：生成迁移码 / 用迁移码接管身份 */
  Net.migrationCode = function () {
    if (!Net.online || !Net.token) return Promise.resolve(null);
    return api('/migrate/code', { method: 'POST' }).then(function (r) { return r.json; }).catch(function () { return null; });
  };
  Net.redeemCode = function (code) {
    if (!Net.online) return Promise.resolve(null);
    return api('/migrate/redeem', { method: 'POST', body: { code: code } }).then(function (r) {
      if (r.status === 200 && r.json && r.json.token) {
        Net.token = r.json.token;
        localStorage.setItem(LS_TOKEN, Net.token);
      }
      return r.json;
    }).catch(function () { return null; });
  };

  window.CTNet = Net;
  Net.init();   // 页面加载即后台探测，不阻塞任何流程
})();
