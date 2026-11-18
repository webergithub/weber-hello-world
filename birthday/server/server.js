/* 十岁啦 · 相册服务端 Album server
   纯 Node.js（18+），不依赖任何 npm 包。 用法： node birthday/server/server.js
   它做四件事：登录与短信验证、可信设备与国家判断、相册读写与同步、照片、视频和音频的加密存放。
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
  maxFile: 25 * 1024 * 1024,
  maxVideo: (+env.TENUP_MAX_VIDEO_MB || 200) * 1024 * 1024    /* 一段视频最大多少 MB */
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
function saveAcc() { if (ACC.log.length > 300) ACC.log = ACC.log.slice(-300); writeAtomic(ACC_FILE, seal(K_ACC, Buffer.from(JSON.stringify(ACC)), 'account')); }
/* v1 had one family password. v2 keeps it as an account with no e-mail, so it still works, and adds e-mail accounts,
   the SMS policy and the admin. Sessions from v1 carry no account, so everyone logs in once more. */
if (ACC && !(ACC.v >= 2)) {
  ACC.accounts = [{ id: rand(6), email: '', name: '家庭密码 Family password', salt: ACC.salt, check: ACC.check, wrapped: ACC.wrapped, role: 'member', created: ACC.phonesSetAt || Date.now() }];
  delete ACC.salt; delete ACC.check; delete ACC.wrapped;
  ACC.smsPolicy = 'new-device'; ACC.admin = null; ACC.sessions = {}; ACC.v = 2; ACC.log = ACC.log || [];
  ACC.log.push({ t: Date.now(), what: 'upgraded to accounts (v2)' });
  saveAcc();
}
function audit(what, who) { ACC.log.push({ t: Date.now(), what, who: who || '' }); }

/* One scrypt run gives both the password check value and, together with the master key, the key that wraps the data key. */
function stretch(password, saltHex) { return crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), 32, { N: 32768, r: 8, p: 1, maxmem: 96 * 1024 * 1024 }); }
const checkOf = k => crypto.createHmac('sha256', k).update('tenup verify').digest('hex');
const kekOf = k => hkdf(Buffer.concat([k, MASTER]), 'tenup kek');
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32enc(buf) { let bits = 0, val = 0, out = ''; for (const b of buf) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } } if (bits > 0) out += B32[(val << (5 - bits)) & 31]; return out; }
function b32dec(str) { let bits = 0, val = 0; const out = []; for (const ch of String(str).toUpperCase().replace(/[^A-Z2-7]/g, '')) { val = (val << 5) | B32.indexOf(ch); bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } } return Buffer.from(out); }
function hotp(key, counter) { const c = Buffer.alloc(8); c.writeBigUInt64BE(BigInt(counter)); const h = crypto.createHmac('sha1', key).update(c).digest(), o = h[19] & 15; return String((h.readUInt32BE(o) & 0x7fffffff) % 1000000).padStart(6, '0'); }
/* The matching time step (one step either side allowed for clock drift), or 0. A step at or before `last` is refused, so a code works once. */
function totpCheck(secret, code, last, now) { const k = b32dec(secret), t = Math.floor((now || Date.now()) / 30000), c6 = String(code || '').replace(/\s/g, ''); for (const d of [0, -1, 1]) { const step = t + d; if (step > (last || 0) && /^\d{6}$/.test(c6) && safeEq(hotp(k, step), c6)) return step; } return 0; }
const normEmail = e => String(e || '').trim().toLowerCase();
const okEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);
const acctOf = id => ACC && ACC.accounts.find(a => a.id === id);
function newAccount(email, name, password, role) { const salt = rand(16), k = stretch(password, salt); return { id: rand(6), email, name: String(name || '').slice(0, 30), salt, check: checkOf(k), wrapped: seal(kekOf(k), DEK, 'dek').toString('base64'), role: role || 'member', created: Date.now() }; }
function safeEq(a, b) { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); }

/* ------------------------------------------------------------------ small in-memory state */
const pre = new Map();       /* password was right, SMS still owed: id → { exp, ip, country, dev } */
const otps = new Map();      /* key → { hash, exp, tries, phone } */
const smsLog = new Map();    /* phone → { last, day, count } */
let pwFails = { n: 0, until: 0 };
let setupDraft = null, phoneDraft = null;
const admPre = new Map();     /* admin password + authenticator were right, SMS still owed: id → { exp, ses } */
const admSes = new Map();     /* admin session: sha(token) → { ses, acct, exp } — memory only, so a restart always asks again */
let admFails = { n: 0, until: 0 }, enrollDraft = null;
const ADMIN_IDLE = 15 * 60000;
const POLICIES = ['off', 'new-device', 'always'];
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
  if (!s || !dev || s.dev !== dev.hash || !acctOf(s.acct)) return { state: 'password' };
  if (s.exp && Date.now() > s.exp) { delete ACC.sessions[h]; saveAcc(); return { state: 'password' }; }
  const now = countryOf(req);
  if (countryChanged(dev.rec.country, now)) { delete ACC.sessions[h]; saveAcc(); return { state: 'password', why: 'country' }; }
  if (!DEK) return { state: 'locked' };
  return { state: 'ok', dev, ses: h, acct: acctOf(s.acct) };
}
function startSession(req, res, devHash, acctId) {
  const t = rand(32);
  ACC.sessions[sha(t)] = { dev: devHash, acct: acctId, exp: CFG.sessionDays > 0 ? Date.now() + CFG.sessionDays * DAY : 0, created: Date.now() };
  const a = acctOf(acctId); if (a) a.lastLogin = Date.now();
  ACC.devices[devHash].seen = Date.now();
  for (const k of Object.keys(ACC.sessions)) { const s = ACC.sessions[k]; if ((s.exp && Date.now() > s.exp) || !ACC.devices[s.dev] || !acctOf(s.acct)) delete ACC.sessions[k]; }
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
const VIDEO = /^video\/(mp4|quicktime|webm|x-m4v|3gpp)$/;

/* Videos are big and are played with byte ranges, so they are not sealed in one piece: <id>.seg holds the video
   in 1 MiB parts, each sealed on its own (its number is in the AAD, so parts cannot be swapped or dropped), and
   <id>.meta holds its type and size. A range request opens only the parts it needs, and memory use stays small. */
const SEG = 1024 * 1024;
function receiveVideo(req, id, type) {
  return new Promise((resolve, reject) => {
    const dir = path.join(CFG.data, 'files'), tmp = path.join(dir, id + '.' + rand(4) + '.tmp'), key = fileKey();
    let fd = fs.openSync(tmp, 'w', 0o600), parts = [], have = 0, total = 0, n = 0, dead = false;
    function flush(final) {
      while (have >= SEG || (final && have > 0)) {
        const all = Buffer.concat(parts), part = all.subarray(0, SEG);
        fs.writeSync(fd, seal(key, part, 'file:' + id + ':' + n)); n++;
        parts = [all.subarray(part.length)]; have = all.length - part.length;
      }
    }
    function fail(e) {
      if (dead) return; dead = true; parts = [];
      try { fs.closeSync(fd); } catch (x) {}
      fs.rmSync(tmp, { force: true }); reject(e);
    }
    req.on('data', c => {
      if (dead) return;                       /* after a refusal the rest is read and dropped, so the answer still reaches the phone */
      total += c.length;
      if (total > CFG.maxVideo) return fail(httpErr(413, 'too_large', '视频太大（最大 ' + Math.round(CFG.maxVideo / 1048576) + ' MB） That video is too large'));
      parts.push(c); have += c.length;
      try { flush(false); } catch (e) { fail(e); }
    });
    req.on('end', () => {
      if (dead) return;
      try {
        if (!total) throw httpErr(400, 'empty', '文件是空的 The file is empty');
        flush(true); fs.closeSync(fd); fd = null;
        fs.renameSync(tmp, path.join(dir, id + '.seg'));
        writeAtomic(path.join(dir, id + '.meta'), seal(key, Buffer.from(JSON.stringify({ type, size: total, seg: SEG, at: Date.now() })), 'file:' + id + ':meta'));
        resolve(total);
      } catch (e) { fail(e); }
    });
    req.on('aborted', () => fail(httpErr(400, 'aborted', '上传中断了 The upload was interrupted')));
    req.on('error', fail);
  });
}
function videoMeta(id) {
  const f = path.join(CFG.data, 'files', id + '.meta');
  return fs.existsSync(f) ? JSON.parse(unseal(fileKey(), fs.readFileSync(f), 'file:' + id + ':meta').toString()) : null;
}
function rangeOf(req, total) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (!m || !(m[1] || m[2])) return null;
  let a = m[1] ? +m[1] : total - +m[2], z = m[1] && m[2] ? +m[2] : total - 1;
  a = Math.max(0, a); z = Math.min(total - 1, z);
  return a > z ? false : [a, z];
}
async function serveVideo(req, res, id, meta) {
  const total = meta.size, r = rangeOf(req, total), h = { 'Content-Type': meta.type, 'Cache-Control': 'private, max-age=31536000, immutable', 'Accept-Ranges': 'bytes', 'X-Content-Type-Options': 'nosniff' };
  if (r === false) { res.writeHead(416, { 'Content-Range': 'bytes */' + total }); return res.end(); }
  const a = r ? r[0] : 0, z = r ? r[1] : total - 1;
  if (r) h['Content-Range'] = 'bytes ' + a + '-' + z + '/' + total;
  h['Content-Length'] = z - a + 1;
  const fd = fs.openSync(path.join(CFG.data, 'files', id + '.seg'), 'r'), key = fileKey(), S = meta.seg || SEG;
  let closed = false;
  res.on('close', () => { closed = true; });
  res.writeHead(r ? 206 : 200, h);
  try {
    for (let n = Math.floor(a / S), last = Math.floor(z / S); n <= last && !closed; n++) {
      const len = Math.min(S, total - n * S) + 31, b = Buffer.alloc(len);
      if (fs.readSync(fd, b, 0, len, n * (S + 31)) !== len) throw new Error('video part ' + n + ' is missing');
      const plain = unseal(key, b, 'file:' + id + ':' + n);
      const piece = plain.subarray(n === Math.floor(a / S) ? a - n * S : 0, n === last ? z - n * S + 1 : plain.length);
      if (!res.write(piece)) await new Promise(ok => { res.once('drain', ok); res.once('close', ok); });
    }
  } catch (e) {
    console.error('[tenup] video ' + id + ':', e.message);
    res.destroy();                          /* a part that does not open is never sent; the player sees a broken download, not altered video */
    return;
  } finally { fs.closeSync(fd); }
  res.end();
}

/* ------------------------------------------------------------------ admin sessions */
function admSesKeys() { const o = {}; for (const k of admSes.keys()) o[k] = 1; return o; }
function startAdmin(req, res, s) {
  const t = rand(32);
  admSes.set(sha(t), { ses: s.ses, acct: s.acct.id, exp: Date.now() + ADMIN_IDLE });
  setCookie(res, req, 'tu_adm', t, null);
}
/* An admin session belongs to one login session on one device and lapses after 15 minutes without use. */
function requireAdmin(req, s) {
  const t = cookies(req).tu_adm, h = t && sha(t), a = h && admSes.get(h);
  if (!a || a.ses !== s.ses || Date.now() > a.exp || !ACC.admin) { if (h) admSes.delete(h); throw httpErr(403, 'need_admin', '请先通过管理员验证 Please pass the admin check first'); }
  a.exp = Date.now() + ADMIN_IDLE;
  return s.acct;
}

/* ------------------------------------------------------------------ API */
const api = {
  'GET /api/state': async (req, res) => {
    const s = sessionOf(req);
    send(res, 200, { server: 'tenup', state: s.state, why: s.why || null, setupTokenNeeded: !ACC, sessionDays: CFG.sessionDays, adminSet: !!(ACC && ACC.admin), email: s.acct ? s.acct.email : null, legacy: !!(ACC && ACC.accounts.some(a => !a.email)), maxVideoMB: Math.round(CFG.maxVideo / 1048576) });
  },

  /* ---- first-time setup: password + two phones, each proven by a code. Works exactly once. ---- */
  'POST /api/setup/start': async (req, res) => {
    if (ACC) throw httpErr(409, 'already_set', '已经设置过了 This album is already set up');
    const b = await jsonBody(req), a = normPhone(b.phones && b.phones[0]), c = normPhone(b.phones && b.phones[1]);
    if (!safeEq(SETUP_TOKEN, String(b.token || '').trim())) throw httpErr(403, 'bad_token', '设置口令不对（看服务器启动时打印的那一行） The setup token is not right — it is printed when the server starts');
    if (!okEmail(normEmail(b.email))) throw httpErr(400, 'bad_email', '邮箱格式不对 That e-mail address does not look right');
    if (String(b.password || '').length < 10) throw httpErr(400, 'weak_password', '密码至少 10 位 The password needs at least 10 characters');
    if (!a || !c) throw httpErr(400, 'bad_phone', '手机号格式不对 Those phone numbers do not look right');
    if (a === c) throw httpErr(400, 'same_phone', '两个手机号不能相同 The two numbers must be different');
    setupDraft = { email: normEmail(b.email), password: String(b.password), phones: [a, c], exp: Date.now() + PRE_MS };
    await issueOtp('setup0', a, 'setup'); await issueOtp('setup1', c, 'setup');
    send(res, 200, { ok: true, phones: [mask(a), mask(c)] });
  },
  'POST /api/setup/finish': async (req, res) => {
    if (ACC) throw httpErr(409, 'already_set', '已经设置过了 This album is already set up');
    const b = await jsonBody(req);
    if (!setupDraft || Date.now() > setupDraft.exp) throw httpErr(400, 'setup_expired', '请重新开始设置 Please start the setup again');
    checkOtp('setup0', b.codes && b.codes[0]); checkOtp('setup1', b.codes && b.codes[1]);
    DEK = crypto.randomBytes(32);
    const first = newAccount(setupDraft.email, '', setupDraft.password, 'owner');
    ACC = { v: 2, accounts: [first], smsPolicy: 'new-device', admin: null, phones: setupDraft.phones, phonesSetAt: Date.now(), devices: {}, sessions: {}, log: [] };
    audit('set up', first.email);
    setupDraft = null;
    const dev = trustDevice(req, res, countryOf(req));
    startSession(req, res, dev, first.id);
    send(res, 200, { ok: true });
  },

  /* ---- login: the password every time a session starts; a text message only for a new device or a new country ---- */
  'POST /api/login': async (req, res) => {
    if (!ACC) throw httpErr(409, 'not_set', '还没有设置 This album is not set up yet');
    if (Date.now() < pwFails.until) throw httpErr(429, 'locked_out', '输错太多次，请 15 分钟后再试 Too many wrong tries — try again in 15 minutes');
    const b = await jsonBody(req), email = normEmail(b.email), acct = ACC.accounts.find(a => a.email === email);
    const k = stretch(b.password || '', acct ? acct.salt : 'ab'.repeat(16));      /* the same work for an unknown e-mail, so timing does not tell which exist */
    if (!acct || !safeEq(acct.check, checkOf(k))) {
      if (++pwFails.n >= 5) pwFails = { n: 0, until: Date.now() + 15 * 60000 };
      throw httpErr(401, 'bad_password', '邮箱或密码不对 That e-mail or password is not right');
    }
    pwFails = { n: 0, until: 0 };
    if (!DEK) DEK = unseal(kekOf(k), Buffer.from(acct.wrapped, 'base64'), 'dek');
    const dev = deviceOf(req), country = countryOf(req), policy = ACC.smsPolicy || 'new-device';
    if (policy === 'off' || (policy === 'new-device' && dev && !countryChanged(dev.rec.country, country))) {
      let h = dev ? dev.hash : trustDevice(req, res, country);
      if (country.length === 2 && country !== 'ZZ') ACC.devices[h].country = country;
      startSession(req, res, h, acct.id);
      return send(res, 200, { ok: true });
    }
    const id = rand(16);
    pre.set(id, { exp: Date.now() + PRE_MS, country, dev: dev ? dev.hash : null, acct: acct.id });
    setCookie(res, req, 'tu_pre', id, 600);
    send(res, 200, { ok: false, need: 'sms', why: policy === 'always' && dev && !countryChanged(dev.rec.country, country) ? 'always' : dev ? 'country' : 'new_device', phones: ACC.phones.map(mask) });
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
    startSession(req, res, h, p.acct);
    send(res, 200, { ok: true });
  },
  'POST /api/logout': async (req, res, s) => {
    delete ACC.sessions[s.ses]; delete ACC.devices[s.dev.hash]; saveAcc();
    setCookie(res, req, 'tu_ses', '', 0); setCookie(res, req, 'tu_dev', '', 0);
    send(res, 200, { ok: true });
  },

  /* ---- devices ---- */
  'GET /api/devices': async (req, res, s) => {
    send(res, 200, { me: s.acct.email || s.acct.name, adminSet: !!ACC.admin, phones: ACC.phones.map(mask), devices: Object.keys(ACC.devices).map(h => ({ id: h.slice(0, 12), name: ACC.devices[h].name, country: ACC.devices[h].country, seen: ACC.devices[h].seen, current: h === s.dev.hash })) });
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
    audit('phone ' + (phoneDraft.which + 1) + ' changed');
    phoneDraft = null; saveAcc();
    send(res, 200, { ok: true, phones: ACC.phones.map(mask) });
  },

  /* ---- admin: admin password + authenticator code + a text message to one of the locked phones, every time ---- */
  'POST /api/admin/start': async (req, res, s) => {
    if (!ACC.admin) throw httpErr(409, 'no_admin', '还没有设置管理员 No admin has been set up yet');
    if (Date.now() < admFails.until) throw httpErr(429, 'admin_locked', '输错太多次，请 30 分钟后再试 Too many wrong tries — try again in 30 minutes');
    const b = await jsonBody(req), k = stretch(b.password || '', ACC.admin.salt);
    const pwOk = safeEq(ACC.admin.check, checkOf(k)), step = totpCheck(ACC.admin.totp, b.totp, ACC.admin.totpLast);
    if (!pwOk || !step) {
      if (++admFails.n >= 5) { admFails = { n: 0, until: Date.now() + 30 * 60000 }; audit('admin locked after wrong tries', s.acct.email); saveAcc(); }
      throw httpErr(401, 'bad_admin', '管理员密码或动态码不对 The admin password or the authenticator code is not right');
    }
    admFails = { n: 0, until: 0 }; ACC.admin.totpLast = step; saveAcc();
    const id = rand(16);
    admPre.set(id, { exp: Date.now() + PRE_MS, ses: s.ses });
    setCookie(res, req, 'tu_admpre', id, 600);
    send(res, 200, { ok: false, need: 'sms', phones: ACC.phones.map(mask) });
  },
  'POST /api/admin/sms/send': async (req, res, s) => {
    const id = cookies(req).tu_admpre, p = id && admPre.get(id);
    if (!p || p.ses !== s.ses || Date.now() > p.exp) throw httpErr(401, 'need_admin_password', '请先输入管理员密码和动态码 Enter the admin password and code first');
    const b = await jsonBody(req), which = b.which === 1 ? 1 : 0;
    await issueOtp('admin:' + id, ACC.phones[which], 'admin');
    send(res, 200, { ok: true, sentTo: mask(ACC.phones[which]) });
  },
  'POST /api/admin/sms/verify': async (req, res, s) => {
    const id = cookies(req).tu_admpre, p = id && admPre.get(id);
    if (!p || p.ses !== s.ses || Date.now() > p.exp) throw httpErr(401, 'need_admin_password', '请先输入管理员密码和动态码 Enter the admin password and code first');
    checkOtp('admin:' + id, (await jsonBody(req)).code);
    admPre.delete(id); setCookie(res, req, 'tu_admpre', '', 0);
    startAdmin(req, res, s);
    audit('admin signed in', s.acct.email); saveAcc();
    send(res, 200, { ok: true });
  },
  'POST /api/admin/logout': async (req, res) => {
    const t = cookies(req).tu_adm; if (t) admSes.delete(sha(t));
    setCookie(res, req, 'tu_adm', '', 0); send(res, 200, { ok: true });
  },

  /* ---- setting up the admin: one phone the first time, both phones to replace an existing admin ---- */
  'POST /api/admin/enroll/start': async (req, res, s) => {
    const b = await jsonBody(req), both = !!ACC.admin;
    enrollDraft = { ses: s.ses, exp: Date.now() + PRE_MS, both, ok: false };
    if (both) { await issueOtp('enroll0', ACC.phones[0], 'admin-setup'); await issueOtp('enroll1', ACC.phones[1], 'admin-setup'); }
    else await issueOtp('enroll0', ACC.phones[b.which === 1 ? 1 : 0], 'admin-setup');
    send(res, 200, { ok: true, both, sentTo: both ? ACC.phones.map(mask) : [mask(ACC.phones[b.which === 1 ? 1 : 0])] });
  },
  'POST /api/admin/enroll/verify': async (req, res, s) => {
    if (!enrollDraft || enrollDraft.ses !== s.ses || Date.now() > enrollDraft.exp) throw httpErr(400, 'enroll_expired', '请重新开始 Please start again');
    const b = await jsonBody(req), c = b.codes || [];
    checkOtp('enroll0', c[0]); if (enrollDraft.both) checkOtp('enroll1', c[1]);
    enrollDraft.ok = true; enrollDraft.secret = b32enc(crypto.randomBytes(20));
    send(res, 200, { ok: true, secret: enrollDraft.secret, uri: 'otpauth://totp/' + encodeURIComponent('十岁啦:admin') + '?secret=' + enrollDraft.secret + '&issuer=' + encodeURIComponent('十岁啦') + '&algorithm=SHA1&digits=6&period=30' });
  },
  'POST /api/admin/enroll/finish': async (req, res, s) => {
    if (!enrollDraft || !enrollDraft.ok || enrollDraft.ses !== s.ses || Date.now() > enrollDraft.exp) throw httpErr(400, 'enroll_expired', '请重新开始 Please start again');
    const b = await jsonBody(req);
    if (String(b.password || '').length < 12) throw httpErr(400, 'weak_password', '管理员密码至少 12 位 The admin password needs at least 12 characters');
    const step = totpCheck(enrollDraft.secret, b.totp, 0);
    if (!step) throw httpErr(400, 'bad_totp', '动态码不对，确认验证器 App 已经添加好，再输入它现在显示的 6 位数 That code is not right — check the authenticator app and type the 6 digits it shows now');
    const salt = rand(16), k = stretch(b.password, salt);
    for (const t of Object.keys(admSesKeys())) admSes.delete(t);      /* replacing the admin signs every admin session out */
    ACC.admin = { salt, check: checkOf(k), totp: enrollDraft.secret, totpLast: step, since: Date.now(), by: s.acct.email || s.acct.name };
    enrollDraft = null;
    audit('admin set up', s.acct.email); saveAcc();
    startAdmin(req, res, s);
    send(res, 200, { ok: true });
  },

  /* ---- what the admin can change ---- */
  'GET /api/admin/settings': async (req, res, s) => {
    requireAdmin(req, s);
    send(res, 200, { smsPolicy: ACC.smsPolicy, phones: ACC.phones.map(mask), admin: { since: ACC.admin.since, by: ACC.admin.by }, me: s.acct.id,
      accounts: ACC.accounts.map(a => ({ id: a.id, email: a.email, name: a.name, role: a.role, created: a.created, lastLogin: a.lastLogin || null, devices: Object.values(ACC.sessions).filter(x => x.acct === a.id).length })),
      log: ACC.log.slice(-30).reverse() });
  },
  'POST /api/admin/policy': async (req, res, s) => {
    const a = requireAdmin(req, s), b = await jsonBody(req);
    if (!POLICIES.includes(b.smsPolicy)) throw httpErr(400, 'bad_policy', 'Bad policy');
    ACC.smsPolicy = b.smsPolicy; audit('sms policy → ' + b.smsPolicy, a.email); saveAcc();
    send(res, 200, { ok: true, smsPolicy: ACC.smsPolicy });
  },
  'POST /api/admin/accounts/add': async (req, res, s) => {
    const a = requireAdmin(req, s), b = await jsonBody(req), email = normEmail(b.email);
    if (!okEmail(email)) throw httpErr(400, 'bad_email', '邮箱格式不对 That e-mail address does not look right');
    if (ACC.accounts.some(x => x.email === email)) throw httpErr(409, 'email_taken', '这个邮箱已经有账号了 That e-mail already has an account');
    if (String(b.password || '').length < 10) throw httpErr(400, 'weak_password', '密码至少 10 位 The password needs at least 10 characters');
    if (ACC.accounts.length >= 20) throw httpErr(400, 'too_many', '最多 20 个账号 At most 20 accounts');
    const n = newAccount(email, b.name, String(b.password), 'member');
    ACC.accounts.push(n); audit('account added: ' + email, a.email); saveAcc();
    send(res, 200, { ok: true, id: n.id });
  },
  'POST /api/admin/accounts/update': async (req, res, s) => {
    const a = requireAdmin(req, s), b = await jsonBody(req), t = acctOf(b.id);
    if (!t) throw httpErr(404, 'no_account', 'No such account');
    if (b.email != null) {
      const email = normEmail(b.email);
      if (!okEmail(email)) throw httpErr(400, 'bad_email', '邮箱格式不对 That e-mail address does not look right');
      if (ACC.accounts.some(x => x.email === email && x.id !== t.id)) throw httpErr(409, 'email_taken', '这个邮箱已经有账号了 That e-mail already has an account');
      audit('account e-mail: ' + (t.email || t.name) + ' → ' + email, a.email); t.email = email;
    }
    if (b.name != null) t.name = String(b.name).slice(0, 30);
    if (b.password != null) {
      if (String(b.password).length < 10) throw httpErr(400, 'weak_password', '密码至少 10 位 The password needs at least 10 characters');
      const fresh = newAccount(t.email, t.name, String(b.password), t.role);
      t.salt = fresh.salt; t.check = fresh.check; t.wrapped = fresh.wrapped;
      for (const k of Object.keys(ACC.sessions)) if (ACC.sessions[k].acct === t.id && k !== s.ses) delete ACC.sessions[k];    /* a new password signs that account out elsewhere */
      audit('password changed: ' + (t.email || t.name), a.email);
    }
    saveAcc(); send(res, 200, { ok: true });
  },
  'POST /api/admin/accounts/remove': async (req, res, s) => {
    const a = requireAdmin(req, s), b = await jsonBody(req), t = acctOf(b.id);
    if (!t) throw httpErr(404, 'no_account', 'No such account');
    if (t.id === s.acct.id) throw httpErr(400, 'is_you', '不能移除自己正在用的账号 You cannot remove the account you are using');
    if (ACC.accounts.length <= 1) throw httpErr(400, 'last_account', '至少要留一个账号 At least one account must remain');
    ACC.accounts = ACC.accounts.filter(x => x.id !== t.id);
    for (const k of Object.keys(ACC.sessions)) if (ACC.sessions[k].acct === t.id) delete ACC.sessions[k];
    audit('account removed: ' + (t.email || t.name), a.email); saveAcc();
    send(res, 200, { ok: true });
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
    if (VIDEO.test(type)) { const vid = rand(16); await receiveVideo(req, vid, type); return send(res, 200, { id: vid }); }
    if (!TYPES.test(type)) throw httpErr(415, 'bad_type', '只能上传图片、视频或音频 Only pictures, videos and audio can be uploaded');
    const data = await body(req, CFG.maxFile), id = rand(16), meta = Buffer.from(JSON.stringify({ type, size: data.length, at: Date.now() })), head = Buffer.alloc(2);
    head.writeUInt16BE(meta.length);
    writeAtomic(path.join(CFG.data, 'files', id + '.enc'), seal(fileKey(), Buffer.concat([head, meta, data]), 'file:' + id));
    send(res, 200, { id });
  }
};
function serveFile(req, res, id) {
  if (!/^[0-9a-f]{32}$/.test(id)) throw httpErr(404, 'no_file', 'Not found');
  const vm = videoMeta(id);
  if (vm) return serveVideo(req, res, id, vm);
  const f = readFile(id);
  if (!f) throw httpErr(404, 'no_file', 'Not found');
  const total = f.data.length, h = { 'Content-Type': f.meta.type, 'Cache-Control': 'private, max-age=31536000, immutable', 'Accept-Ranges': 'bytes', 'X-Content-Type-Options': 'nosniff' };
  const r = rangeOf(req, total);       /* Safari will not play audio or video without byte ranges */
  if (r === false) { res.writeHead(416, { 'Content-Range': 'bytes */' + total }); return res.end(); }
  if (r) {
    const a = r[0], z = r[1];
    h['Content-Range'] = 'bytes ' + a + '-' + z + '/' + total; h['Content-Length'] = z - a + 1;
    res.writeHead(206, h); return res.end(f.data.slice(a, z + 1));
  }
  h['Content-Length'] = total; res.writeHead(200, h); res.end(f.data);
}

/* ------------------------------------------------------------------ the site itself: nothing but the login page without a session */
const OPEN_API = new Set(['GET /api/state', 'POST /api/setup/start', 'POST /api/setup/finish', 'POST /api/login', 'POST /api/sms/send', 'POST /api/sms/verify']);
const PUBLIC = [/^\/login\.html$/, /^\/css\/(fonts|tokens|tenup|login)\.css$/, /^\/js\/(tenup|login)\.js$/, /^\/fonts\/[\w.-]+\.woff2$/, /^\/manifest\.webmanifest$/, /^\/icons\/[\w.-]+\.png$/];
const SERVED = /^\/(index\.html|manage\.html|print\.html|login\.html|admin\.html|sw\.js|manifest\.webmanifest|(css|js|fonts|album|vendor|icons|docs)\/[\w./-]+)$/;
const MIME = { html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', json: 'application/json', webmanifest: 'application/manifest+json',
  woff2: 'font/woff2', png: 'image/png', jpg: 'image/jpeg', svg: 'image/svg+xml', wasm: 'application/wasm', task: 'application/octet-stream', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', md: 'text/markdown; charset=utf-8' };
function serveSite(req, res, pathname, authed) {
  if (pathname === '/') pathname = '/index.html';
  if (!SERVED.test(pathname) || pathname.includes('..') || /^\/docs\/build\//.test(pathname)) { res.writeHead(404); return res.end('Not found'); }
  if (!authed && !PUBLIC.some(r => r.test(pathname))) {
    if (/\.html$/.test(pathname)) { res.writeHead(302, { Location: '/login.html' + (pathname === '/manage.html' ? '?next=manage.html' : ''), 'Cache-Control': 'no-store' }); return res.end(); }
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
    if (fn && pathname.startsWith('/api/admin/')) res.setHeader('Cache-Control', 'no-store');
    if (!fn && !isFile) throw httpErr(404, 'no_route', 'Not found');
    let s = null;
    if (!OPEN_API.has(key)) {
      s = sessionOf(req);
      if (s.state !== 'ok') throw httpErr(s.state === 'locked' ? 423 : 401, s.state, s.state === 'locked' ? '服务刚重启，请输入密码解锁 The server restarted — enter the password to unlock' : '请登录 Please log in');
    }
    if (isFile) return await serveFile(req, res, pathname.slice(10));
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
