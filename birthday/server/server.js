/* 十岁啦 · 相册服务端 Album server
   纯 Node.js（18+），不依赖任何 npm 包。 用法： node birthday/server/server.js
   它做四件事：登录与短信验证、可信设备与国家判断、相册读写与同步、照片和音频的加密存放。
   配置全部来自环境变量，见 README.md。设计说明见 ../docs/。 */
'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const sms = require('./sms.js'), geo = require('./geo.js');

const env = process.env;
const CFG = {
  port: +env.TENUP_PORT || 8787,
  host: env.TENUP_HOST || '127.0.0.1',
  data: path.resolve(env.TENUP_DATA || path.join(__dirname, 'data')),
  site: path.resolve(env.TENUP_SITE || path.join(__dirname, '..')),
  keyFile: path.resolve(env.TENUP_MASTER_KEY_FILE || path.join(__dirname, 'master.key')),
  sessionDays: env.TENUP_SESSION_DAYS == null || env.TENUP_SESSION_DAYS === '' ? 30 : +env.TENUP_SESSION_DAYS,
  trustProxy: env.TENUP_TRUST_PROXY === '1',
  countryHeader: (env.TENUP_COUNTRY_HEADER || '').toLowerCase(),
  geoip: env.TENUP_GEOIP || '',
  insecure: env.TENUP_INSECURE === '1',          /* 仅本机调试：允许在 http 下使用登录 cookie */
  setupToken: env.TENUP_SETUP_TOKEN || '',
  smsWaitMs: env.TENUP_SMS_WAIT_MS == null || env.TENUP_SMS_WAIT_MS === '' ? 60000 : +env.TENUP_SMS_WAIT_MS,   /* 同一号码两次短信之间的间隔 */
  maxFile: 25 * 1024 * 1024
};
const DAY = 86400000, OTP_MS = 5 * 60000, PRE_MS = 10 * 60000;

/* ------------------------------------------------------------------ keys and sealing */
function loadMaster() {
  if (env.TENUP_MASTER_KEY) {
    if (!/^[0-9a-f]{64}$/i.test(env.TENUP_MASTER_KEY)) throw new Error('TENUP_MASTER_KEY must be 64 hex characters');
    return Buffer.from(env.TENUP_MASTER_KEY, 'hex');
  }
  if (!fs.existsSync(CFG.keyFile)) {
    fs.writeFileSync(CFG.keyFile, crypto.randomBytes(32).toString('hex') + '\n', { mode: 0o600 });
    console.log('[tenup] 生成了新的服务器主密钥： ' + CFG.keyFile + '\n[tenup] 请另外保存一份，并且不要和数据文件夹放在一起。丢了它，数据无法解密。');
  }
  return Buffer.from(fs.readFileSync(CFG.keyFile, 'utf8').trim(), 'hex');
}
const MASTER = loadMaster();
const hkdf = (key, info) => Buffer.from(crypto.hkdfSync('sha256', key, Buffer.alloc(0), info, 32));
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const rand = n => crypto.randomBytes(n).toString('hex');

/* AES-256-GCM: 'TU1' | 12-byte nonce | 16-byte tag | ciphertext. `aad` binds a blob to its name. */
function seal(key, plain, aad) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key, iv);
  if (aad) c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([Buffer.from('TU1'), iv, c.getAuthTag(), ct]);
}
function unseal(key, blob, aad) {
  if (blob.length < 31 || blob.slice(0, 3).toString() !== 'TU1') throw new Error('not a sealed file');
  const d = crypto.createDecipheriv('aes-256-gcm', key, blob.slice(3, 15));
  if (aad) d.setAAD(Buffer.from(aad));
  d.setAuthTag(blob.slice(15, 31));
  return Buffer.concat([d.update(blob.slice(31)), d.final()]);
}
function writeAtomic(file, buf) { const tmp = file + '.' + rand(4) + '.tmp'; fs.writeFileSync(tmp, buf, { mode: 0o600 }); fs.renameSync(tmp, file); }

/* ------------------------------------------------------------------ account (sealed with the master key only) */
fs.mkdirSync(path.join(CFG.data, 'files'), { recursive: true, mode: 0o700 });
const ACC_FILE = path.join(CFG.data, 'account.enc'), ALBUM_FILE = path.join(CFG.data, 'album.enc');
const K_ACC = hkdf(MASTER, 'tenup account');
let ACC = null, DEK = null;           /* DEK stays in memory only, and only after someone has logged in with the password */
if (fs.existsSync(ACC_FILE)) ACC = JSON.parse(unseal(K_ACC, fs.readFileSync(ACC_FILE), 'account').toString());
function saveAcc() { writeAtomic(ACC_FILE, seal(K_ACC, Buffer.from(JSON.stringify(ACC)), 'account')); }

/* One scrypt run gives both the password check value and, together with the master key, the key that wraps the data key. */
function stretch(password, saltHex) { return crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), 32, { N: 32768, r: 8, p: 1, maxmem: 96 * 1024 * 1024 }); }
const checkOf = k => crypto.createHmac('sha256', k).update('tenup verify').digest('hex');
const kekOf = k => hkdf(Buffer.concat([k, MASTER]), 'tenup kek');
function safeEq(a, b) { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); }

/* ------------------------------------------------------------------ small in-memory state */
const pre = new Map();       /* password was right, SMS still owed: id → { exp, ip, country, dev } */
const otps = new Map();      /* key → { hash, exp, tries, phone } */
const smsLog = new Map();    /* phone → { last, day, count } */
let pwFails = { n: 0, until: 0 };
let setupDraft = null, phoneDraft = null;
const SETUP_TOKEN = CFG.setupToken || (ACC ? '' : rand(4));

function normPhone(p) {
  p = String(p || '').replace(/[\s-]/g, '');
  if (/^1\d{10}$/.test(p)) p = '+86' + p;
  return /^\+\d{8,15}$/.test(p) ? p : null;
}
const mask = p => '•••• ' + p.slice(-4);
function issueOtp(key, phone, purpose) {
  const now = Date.now(), day = new Date().toISOString().slice(0, 10), log = smsLog.get(phone) || { last: 0, day, count: 0 };
  if (log.day !== day) { log.day = day; log.count = 0; }
  if (now - log.last < CFG.smsWaitMs) return Promise.reject(httpErr(429, 'sms_wait', '一分钟内只能发一次 Please wait a minute before asking again'));
  if (log.count >= 10) return Promise.reject(httpErr(429, 'sms_daily', '今天发送次数已用完 Daily limit reached'));
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  log.last = now; log.count++; smsLog.set(phone, log);
  otps.set(key, { hash: sha(key + code), exp: now + OTP_MS, tries: 0, phone });
  return sms.send(phone, code, purpose).catch(e => { otps.delete(key); log.last = 0; throw httpErr(502, 'sms_failed', '短信没有发出去 The text message could not be sent: ' + e.message); });
}
function checkOtp(key, code) {
  const o = otps.get(key);
  if (!o || Date.now() > o.exp) { otps.delete(key); throw httpErr(400, 'code_expired', '验证码已过期，请重新获取 The code has expired — ask for a new one'); }
  if (++o.tries > 5) { otps.delete(key); throw httpErr(400, 'code_locked', '试的次数太多，请重新获取 Too many tries — ask for a new code'); }
  if (!safeEq(o.hash, sha(key + String(code || '').trim()))) throw httpErr(400, 'code_wrong', '验证码不对 That code is not right');
  otps.delete(key);
  return o.phone;
}
function httpErr(status, code, message) { const e = new Error(message); e.status = status; e.code = code; return e; }

/* ------------------------------------------------------------------ request helpers */
function cookies(req) {
  const o = {};
  (req.headers.cookie || '').split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return o;
}
function isHttps(req) { return CFG.trustProxy ? req.headers['x-forwarded-proto'] === 'https' : !!req.socket.encrypted; }
function setCookie(res, req, name, value, maxAgeSec) {
  const secure = isHttps(req) || !CFG.insecure;
  const c = name + '=' + encodeURIComponent(value) + '; Path=/; HttpOnly; SameSite=Lax' + (secure ? '; Secure' : '') + (maxAgeSec != null ? '; Max-Age=' + maxAgeSec : '');
  res.setHeader('Set-Cookie', [].concat(res.getHeader('Set-Cookie') || [], c));
}
function ipOf(req) {
  let ip = req.socket.remoteAddress || '';
  if (CFG.trustProxy && req.headers['x-forwarded-for']) ip = String(req.headers['x-forwarded-for']).split(',')[0].trim();
  return ip.replace(/^::ffff:/, '');
}
function countryOf(req) {
  if (CFG.trustProxy && CFG.countryHeader && req.headers[CFG.countryHeader]) return String(req.headers[CFG.countryHeader]).toUpperCase().slice(0, 2);
  return geo.country(ipOf(req));
}
function body(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > limit) { reject(httpErr(413, 'too_large', '文件太大 That file is too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function jsonBody(req) { const b = await body(req, 4 * 1024 * 1024); try { return b.length ? JSON.parse(b.toString()) : {}; } catch (e) { throw httpErr(400, 'bad_json', 'Bad request'); } }
function send(res, status, obj) {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': b.length, 'Cache-Control': 'no-store' });
  res.end(b);
}

/* ------------------------------------------------------------------ devices and sessions */
function deviceOf(req) { const t = cookies(req).tu_dev; const h = t && sha(t); return h && ACC && ACC.devices[h] ? { hash: h, rec: ACC.devices[h] } : null; }
/* The country matters only when both sides are known public countries; an unknown or home-network address never forces a text message. */
function countryChanged(was, now) { return !!was && !!now && was.length === 2 && now.length === 2 && was !== 'ZZ' && now !== 'ZZ' && was !== now; }
function sessionOf(req) {
  if (!ACC) return { state: 'setup' };
  const t = cookies(req).tu_ses, h = t && sha(t), s = h && ACC.sessions[h], dev = deviceOf(req);
  if (!s || !dev || s.dev !== dev.hash) return { state: 'password' };
  if (s.exp && Date.now() > s.exp) { delete ACC.sessions[h]; saveAcc(); return { state: 'password' }; }
  const now = countryOf(req);
  if (countryChanged(dev.rec.country, now)) { delete ACC.sessions[h]; saveAcc(); return { state: 'password', why: 'country' }; }
  if (!DEK) return { state: 'locked' };
  return { state: 'ok', dev, ses: h };
}
function startSession(req, res, devHash) {
  const t = rand(32);
  ACC.sessions[sha(t)] = { dev: devHash, exp: CFG.sessionDays > 0 ? Date.now() + CFG.sessionDays * DAY : 0, created: Date.now() };
  ACC.devices[devHash].seen = Date.now();
  for (const k of Object.keys(ACC.sessions)) { const s = ACC.sessions[k]; if ((s.exp && Date.now() > s.exp) || !ACC.devices[s.dev]) delete ACC.sessions[k]; }
  saveAcc();
  setCookie(res, req, 'tu_ses', t, CFG.sessionDays > 0 ? CFG.sessionDays * 86400 : null);
}
function trustDevice(req, res, country) {
  const t = rand(32), h = sha(t), ua = String(req.headers['user-agent'] || '');
  const name = (/iPad/.test(ua) ? 'iPad' : /iPhone/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android' : /Macintosh/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Tizen|TV/i.test(ua) ? 'TV' : 'Browser');
  ACC.devices[h] = { name, country: country || 'ZZ', created: Date.now(), seen: Date.now() };
  setCookie(res, req, 'tu_dev', t, 400 * 86400);
  return h;
}

/* ------------------------------------------------------------------ album and files (sealed with the data key) */
let ALBUM = null;      /* { version, album } once unlocked */
function loadAlbum() {
  if (ALBUM) return ALBUM;
  ALBUM = fs.existsSync(ALBUM_FILE) ? JSON.parse(unseal(hkdf(DEK, 'tenup album'), fs.readFileSync(ALBUM_FILE), 'album').toString()) : { version: 0, album: null };
  return ALBUM;
}
function saveAlbum() { writeAtomic(ALBUM_FILE, seal(hkdf(DEK, 'tenup album'), Buffer.from(JSON.stringify(ALBUM)), 'album')); }
const fileKey = () => hkdf(DEK, 'tenup file');
const fileCache = new Map();
function readFile(id) {
  if (fileCache.has(id)) return fileCache.get(id);
  const f = path.join(CFG.data, 'files', id + '.enc');
  if (!fs.existsSync(f)) return null;
  const plain = unseal(fileKey(), fs.readFileSync(f), 'file:' + id), n = plain.readUInt16BE(0);
  const rec = { meta: JSON.parse(plain.slice(2, 2 + n).toString()), data: plain.slice(2 + n) };
  if (fileCache.size > 40) fileCache.delete(fileCache.keys().next().value);
  fileCache.set(id, rec);
  return rec;
}
const TYPES = /^(image\/(jpeg|png|webp|gif)|audio\/(mpeg|mp4|aac|ogg|wav|x-wav|webm|x-m4a|mp3))$/;

/* ------------------------------------------------------------------ API */
const api = {
  'GET /api/state': async (req, res) => {
    const s = sessionOf(req);
    send(res, 200, { server: 'tenup', state: s.state, why: s.why || null, setupTokenNeeded: !ACC, sessionDays: CFG.sessionDays });
  },

  /* ---- first-time setup: password + two phones, each proven by a code. Works exactly once. ---- */
  'POST /api/setup/start': async (req, res) => {
    if (ACC) throw httpErr(409, 'already_set', '已经设置过了 This album is already set up');
    const b = await jsonBody(req), a = normPhone(b.phones && b.phones[0]), c = normPhone(b.phones && b.phones[1]);
    if (!safeEq(SETUP_TOKEN, String(b.token || '').trim())) throw httpErr(403, 'bad_token', '设置口令不对（看服务器启动时打印的那一行） The setup token is not right — it is printed when the server starts');
    if (String(b.password || '').length < 10) throw httpErr(400, 'weak_password', '密码至少 10 位 The password needs at least 10 characters');
    if (!a || !c) throw httpErr(400, 'bad_phone', '手机号格式不对 Those phone numbers do not look right');
    if (a === c) throw httpErr(400, 'same_phone', '两个手机号不能相同 The two numbers must be different');
    setupDraft = { password: String(b.password), phones: [a, c], exp: Date.now() + PRE_MS };
    await issueOtp('setup0', a, 'setup'); await issueOtp('setup1', c, 'setup');
    send(res, 200, { ok: true, phones: [mask(a), mask(c)] });
  },
  'POST /api/setup/finish': async (req, res) => {
    if (ACC) throw httpErr(409, 'already_set', '已经设置过了 This album is already set up');
    const b = await jsonBody(req);
    if (!setupDraft || Date.now() > setupDraft.exp) throw httpErr(400, 'setup_expired', '请重新开始设置 Please start the setup again');
    checkOtp('setup0', b.codes && b.codes[0]); checkOtp('setup1', b.codes && b.codes[1]);
    const salt = rand(16), k = stretch(setupDraft.password, salt);
    DEK = crypto.randomBytes(32);
    ACC = { v: 1, salt, check: checkOf(k), wrapped: seal(kekOf(k), DEK, 'dek').toString('base64'), phones: setupDraft.phones, phonesSetAt: Date.now(), devices: {}, sessions: {}, log: [] };
    setupDraft = null;
    const dev = trustDevice(req, res, countryOf(req));
    startSession(req, res, dev);
    send(res, 200, { ok: true });
  },

  /* ---- login: the password every time a session starts; a text message only for a new device or a new country ---- */
  'POST /api/login': async (req, res) => {
    if (!ACC) throw httpErr(409, 'not_set', '还没有设置 This album is not set up yet');
    if (Date.now() < pwFails.until) throw httpErr(429, 'locked_out', '输错太多次，请 15 分钟后再试 Too many wrong tries — try again in 15 minutes');
    const b = await jsonBody(req), k = stretch(b.password || '', ACC.salt);
    if (!safeEq(ACC.check, checkOf(k))) {
      if (++pwFails.n >= 5) pwFails = { n: 0, until: Date.now() + 15 * 60000 };
      throw httpErr(401, 'bad_password', '密码不对 That password is not right');
    }
    pwFails = { n: 0, until: 0 };
    if (!DEK) DEK = unseal(kekOf(k), Buffer.from(ACC.wrapped, 'base64'), 'dek');
    const dev = deviceOf(req), country = countryOf(req);
    if (dev && !countryChanged(dev.rec.country, country)) {
      if (country.length === 2 && country !== 'ZZ') dev.rec.country = country;
      startSession(req, res, dev.hash);
      return send(res, 200, { ok: true });
    }
    const id = rand(16);
    pre.set(id, { exp: Date.now() + PRE_MS, country, dev: dev ? dev.hash : null });
    setCookie(res, req, 'tu_pre', id, 600);
    send(res, 200, { ok: false, need: 'sms', why: dev ? 'country' : 'new_device', phones: ACC.phones.map(mask) });
  },
  'POST /api/sms/send': async (req, res) => {
    const id = cookies(req).tu_pre, p = id && pre.get(id);
    if (!p || Date.now() > p.exp) throw httpErr(401, 'need_password', '请先输入密码 Please enter the password first');
    const b = await jsonBody(req), which = b.which === 1 ? 1 : 0;
    await issueOtp('login:' + id, ACC.phones[which], 'login');
    send(res, 200, { ok: true, sentTo: mask(ACC.phones[which]) });
  },
  'POST /api/sms/verify': async (req, res) => {
    const id = cookies(req).tu_pre, p = id && pre.get(id);
    if (!p || Date.now() > p.exp) throw httpErr(401, 'need_password', '请先输入密码 Please enter the password first');
    const b = await jsonBody(req);
    checkOtp('login:' + id, b.code);
    pre.delete(id); setCookie(res, req, 'tu_pre', '', 0);
    let h = p.dev && ACC.devices[p.dev] ? p.dev : null;
    if (h) ACC.devices[h].country = p.country || ACC.devices[h].country; else h = trustDevice(req, res, p.country);
    startSession(req, res, h);
    send(res, 200, { ok: true });
  },
  'POST /api/logout': async (req, res, s) => {
    delete ACC.sessions[s.ses]; delete ACC.devices[s.dev.hash]; saveAcc();
    setCookie(res, req, 'tu_ses', '', 0); setCookie(res, req, 'tu_dev', '', 0);
    send(res, 200, { ok: true });
  },

  /* ---- devices ---- */
  'GET /api/devices': async (req, res, s) => {
    send(res, 200, { phones: ACC.phones.map(mask), devices: Object.keys(ACC.devices).map(h => ({ id: h.slice(0, 12), name: ACC.devices[h].name, country: ACC.devices[h].country, seen: ACC.devices[h].seen, current: h === s.dev.hash })) });
  },
  'POST /api/devices/remove': async (req, res, s) => {
    const b = await jsonBody(req), h = Object.keys(ACC.devices).find(x => x.slice(0, 12) === b.id);
    if (!h) throw httpErr(404, 'no_device', 'No such device');
    delete ACC.devices[h];
    for (const k of Object.keys(ACC.sessions)) if (ACC.sessions[k].dev === h) delete ACC.sessions[k];
    saveAcc(); send(res, 200, { ok: true });
  },

  /* ---- changing a phone number: only with a code sent to the OTHER number, then one to the new number ---- */
  'POST /api/phone/change/start': async (req, res) => {
    const b = await jsonBody(req), which = b.which === 1 ? 1 : 0, other = 1 - which;
    phoneDraft = { which, step: 1, exp: Date.now() + PRE_MS };
    await issueOtp('phone:other', ACC.phones[other], 'change-phone');
    send(res, 200, { ok: true, sentTo: mask(ACC.phones[other]) });
  },
  'POST /api/phone/change/confirm': async (req, res) => {
    const b = await jsonBody(req), np = normPhone(b.newPhone);
    if (!phoneDraft || phoneDraft.step !== 1 || Date.now() > phoneDraft.exp) throw httpErr(400, 'change_expired', '请重新开始 Please start again');
    if (!np) throw httpErr(400, 'bad_phone', '手机号格式不对 That phone number does not look right');
    if (ACC.phones.includes(np)) throw httpErr(400, 'same_phone', '这个号码已经在用了 That number is already in use');
    checkOtp('phone:other', b.code);
    phoneDraft.step = 2; phoneDraft.newPhone = np;
    await issueOtp('phone:new', np, 'change-phone');
    send(res, 200, { ok: true, sentTo: mask(np) });
  },
  'POST /api/phone/change/finish': async (req, res) => {
    const b = await jsonBody(req);
    if (!phoneDraft || phoneDraft.step !== 2 || Date.now() > phoneDraft.exp) throw httpErr(400, 'change_expired', '请重新开始 Please start again');
    checkOtp('phone:new', b.code);
    ACC.phones[phoneDraft.which] = phoneDraft.newPhone;
    ACC.log.push({ t: Date.now(), what: 'phone ' + phoneDraft.which + ' changed' });
    phoneDraft = null; saveAcc();
    send(res, 200, { ok: true, phones: ACC.phones.map(mask) });
  },

  /* ---- album ---- */
  'GET /api/album': async (req, res) => {
    const a = loadAlbum(), have = new URL(req.url, 'http://x').searchParams.get('v');
    if (have != null && +have === a.version) return send(res, 200, { version: a.version, same: true });
    send(res, 200, a);
  },
  'PUT /api/album': async (req, res) => {
    const b = await jsonBody(req), a = loadAlbum();
    if (!b.album || typeof b.album !== 'object') throw httpErr(400, 'bad_album', 'Bad album');
    if (+b.base !== a.version) return send(res, 409, a);
    ALBUM = { version: a.version + 1, album: b.album, saved: Date.now() };
    saveAlbum();
    send(res, 200, { version: ALBUM.version });
  },

  /* ---- files: one upload each, stored sealed, served only to a logged-in device ---- */
  'POST /api/file': async (req, res) => {
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!TYPES.test(type)) throw httpErr(415, 'bad_type', '只能上传图片或音频 Only pictures and audio can be uploaded');
    const data = await body(req, CFG.maxFile), id = rand(16), meta = Buffer.from(JSON.stringify({ type, size: data.length, at: Date.now() })), head = Buffer.alloc(2);
    head.writeUInt16BE(meta.length);
    writeAtomic(path.join(CFG.data, 'files', id + '.enc'), seal(fileKey(), Buffer.concat([head, meta, data]), 'file:' + id));
    send(res, 200, { id });
  }
};
function serveFile(req, res, id) {
  if (!/^[0-9a-f]{32}$/.test(id)) throw httpErr(404, 'no_file', 'Not found');
  const f = readFile(id);
  if (!f) throw httpErr(404, 'no_file', 'Not found');
  const total = f.data.length, h = { 'Content-Type': f.meta.type, 'Cache-Control': 'private, max-age=31536000, immutable', 'Accept-Ranges': 'bytes', 'X-Content-Type-Options': 'nosniff' };
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (m && (m[1] || m[2])) {       /* Safari will not play audio without byte ranges */
    let a = m[1] ? +m[1] : total - +m[2], z = m[1] && m[2] ? +m[2] : total - 1;
    a = Math.max(0, a); z = Math.min(total - 1, z);
    if (a > z) { res.writeHead(416, { 'Content-Range': 'bytes */' + total }); return res.end(); }
    h['Content-Range'] = 'bytes ' + a + '-' + z + '/' + total; h['Content-Length'] = z - a + 1;
    res.writeHead(206, h); return res.end(f.data.slice(a, z + 1));
  }
  h['Content-Length'] = total; res.writeHead(200, h); res.end(f.data);
}

/* ------------------------------------------------------------------ the site itself: nothing but the login page without a session */
const OPEN_API = new Set(['GET /api/state', 'POST /api/setup/start', 'POST /api/setup/finish', 'POST /api/login', 'POST /api/sms/send', 'POST /api/sms/verify']);
const PUBLIC = [/^\/login\.html$/, /^\/css\/(fonts|tokens|tenup|login)\.css$/, /^\/js\/(tenup|login)\.js$/, /^\/fonts\/[\w.-]+\.woff2$/, /^\/manifest\.webmanifest$/, /^\/icons\/[\w.-]+\.png$/];
const SERVED = /^\/(index\.html|manage\.html|login\.html|sw\.js|manifest\.webmanifest|(css|js|fonts|album|vendor|icons|docs)\/[\w./-]+)$/;
const MIME = { html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', json: 'application/json', webmanifest: 'application/manifest+json',
  woff2: 'font/woff2', png: 'image/png', jpg: 'image/jpeg', svg: 'image/svg+xml', wasm: 'application/wasm', task: 'application/octet-stream', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', md: 'text/markdown; charset=utf-8' };
function serveSite(req, res, pathname, authed) {
  if (pathname === '/') pathname = '/index.html';
  if (!SERVED.test(pathname) || pathname.includes('..') || /^\/docs\/build\//.test(pathname)) { res.writeHead(404); return res.end('Not found'); }
  if (!authed && !PUBLIC.some(r => r.test(pathname))) {
    if (/\.html$/.test(pathname)) { res.writeHead(302, { Location: '/login.html', 'Cache-Control': 'no-store' }); return res.end(); }
    res.writeHead(401); return res.end('Login required');
  }
  const file = path.join(CFG.site, pathname);
  fs.stat(file, (err, stt) => {
    if (err || !stt.isFile()) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).slice(1)] || 'application/octet-stream', 'Content-Length': stt.size, 'Cache-Control': /\.(woff2|wasm|task)$/.test(file) ? 'private, max-age=604800' : 'no-cache' });
    fs.createReadStream(file).pipe(res);
  });
}

/* ------------------------------------------------------------------ server */
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname), key = req.method + ' ' + pathname;
  try {
    if (!pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
      return serveSite(req, res, pathname, sessionOf(req).state === 'ok');
    }
    /* a page on another site cannot set this header, so it cannot make a logged-in browser change anything */
    if (req.method !== 'GET' && req.headers['x-tenup'] !== '1') throw httpErr(403, 'bad_origin', 'Forbidden');
    const isFile = req.method === 'GET' && pathname.startsWith('/api/file/');
    const fn = api[key];
    if (!fn && !isFile) throw httpErr(404, 'no_route', 'Not found');
    let s = null;
    if (!OPEN_API.has(key)) {
      s = sessionOf(req);
      if (s.state !== 'ok') throw httpErr(s.state === 'locked' ? 423 : 401, s.state, s.state === 'locked' ? '服务刚重启，请输入密码解锁 The server restarted — enter the password to unlock' : '请登录 Please log in');
    }
    if (isFile) return serveFile(req, res, pathname.slice(10));
    await fn(req, res, s);
  } catch (e) {
    if (!e.status) console.error('[tenup]', e);
    if (!res.headersSent) send(res, e.status || 500, { error: e.code || 'server', message: e.status ? e.message : 'Server error' });
  }
});
geo.load(CFG.geoip);
server.listen(CFG.port, CFG.host, () => {
  console.log('[tenup] listening on http://' + CFG.host + ':' + CFG.port + '  data: ' + CFG.data + '  sms: ' + sms.name() + '  geoip: ' + (geo.ready() ? 'loaded' : CFG.countryHeader ? 'header ' + CFG.countryHeader : 'none (country checks are off)'));
  if (!ACC) console.log('[tenup] 还没有设置。打开网站完成首次设置，设置口令 Setup token: ' + SETUP_TOKEN);
  else console.log('[tenup] 数据已上锁，等待有人用密码登录解锁 Data is locked until someone logs in with the password');
});
module.exports = server;
