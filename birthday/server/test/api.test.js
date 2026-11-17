/* 服务端自检： node birthday/server/test/api.test.js [国家库.mmdb]
   启动一个临时服务（测试短信通道、临时数据目录），把登录、短信、可信设备、国家变化、改手机号、加密、重启解锁走一遍。 */
'use strict';
const { spawn } = require('child_process'), fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenup-')), PORT = 18787, BASE = 'http://127.0.0.1:' + PORT, MMDB = process.argv[2] || '';
const KEY = crypto.randomBytes(32).toString('hex'), PW = 'correct horse 42', EMAIL = 'mom@example.com', APW = 'admin password 2026!';
let proc, out = '', passed = 0, failed = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
function start(extra) {
  out = '';
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: Object.assign({}, process.env, { TENUP_PORT: PORT, TENUP_DATA: path.join(dir, 'data'), TENUP_MASTER_KEY: KEY, TENUP_INSECURE: '1', TENUP_TRUST_PROXY: '1', TENUP_SETUP_TOKEN: 'tok123', TENUP_GEOIP: MMDB, TENUP_SMS: 'console' }, extra || {}) });
  proc.stdout.on('data', d => out += d); proc.stderr.on('data', d => out += d);
  return new Promise(async (res, rej) => { for (let i = 0; i < 50; i++) { if (/listening/.test(out)) return res(); await sleep(100); } rej(new Error('server did not start: ' + out)); });
}
const stop = () => new Promise(r => { proc.on('exit', r); proc.kill(); });
const codes = () => [...out.matchAll(/code: (\d{6})/g)].map(m => m[1]);
function client(ip) {
  const jar = {};
  return { jar, ip, async call(method, url, body, o) {
    o = o || {};
    const h = { 'X-Forwarded-For': this.ip, Cookie: Object.keys(jar).map(k => k + '=' + jar[k]).join('; ') };
    if (method !== 'GET' && !o.noHeader) h['X-TenUp'] = '1';
    let b = body;
    if (body && !(body instanceof Buffer)) { b = JSON.stringify(body); h['Content-Type'] = 'application/json'; } else if (body) h['Content-Type'] = o.type || 'image/jpeg';
    const r = await fetch(BASE + url, { method, headers: Object.assign(h, o.headers || {}), body: b, redirect: 'manual' });
    (r.headers.getSetCookie ? r.headers.getSetCookie() : []).forEach(c => { const [kv] = c.split(';'), i = kv.indexOf('='), k = kv.slice(0, i), v = kv.slice(i + 1); if (v) jar[k] = v; else delete jar[k]; });
    const buf = Buffer.from(await r.arrayBuffer()); let json = null; try { json = JSON.parse(buf.toString()); } catch (e) {}
    return { status: r.status, json, buf, headers: r.headers };
  } };
}
function totp(secret, offset) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = 0, val = 0; const key = [];
  for (const ch of secret) { val = (val << 5) | A.indexOf(ch); bits += 5; if (bits >= 8) { key.push((val >>> (bits - 8)) & 255); bits -= 8; } }
  const c = Buffer.alloc(8); c.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000) + (offset || 0)));
  const h = crypto.createHmac('sha1', Buffer.from(key)).update(c).digest(), o = h[19] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1000000).padStart(6, '0');
}
function ok(name, cond, extra) { if (cond) { passed++; console.log('  ok   ' + name); } else { failed++; console.log('  FAIL ' + name + (extra ? '  → ' + JSON.stringify(extra) : '')); } }

(async () => {
  const US = '8.8.8.8', US2 = '8.8.4.4', CN = '114.114.114.114', HOME = '192.168.1.20';
  await start();
  const a = client(US);
  let r = await a.call('GET', '/api/state'); ok('fresh server asks for setup', r.json.state === 'setup');
  r = await a.call('GET', '/index.html'); ok('pages redirect to login before any session', r.status === 302 && r.headers.get('location') === '/login.html');
  r = await a.call('POST', '/api/setup/start', { email: 'Mom@Example.com', token: 'nope', password: PW, phones: ['13800000001', '13800000002'] }); ok('setup refuses a wrong setup token', r.status === 403);
  r = await a.call('POST', '/api/setup/start', { email: 'Mom@Example.com', token: 'tok123', password: 'short', phones: ['13800000001', '13800000002'] }); ok('setup refuses a short password', r.status === 400);
  r = await a.call('POST', '/api/setup/start', { email: 'not-an-email', token: 'tok123', password: PW, phones: ['13800000001', '13800000002'] }); ok('setup refuses a bad e-mail', r.status === 400 && r.json.error === 'bad_email');
  r = await a.call('POST', '/api/setup/start', { email: 'Mom@Example.com', token: 'tok123', password: PW, phones: ['13800000001', '13800000001'] }); ok('setup refuses two identical numbers', r.status === 400);
  r = await a.call('POST', '/api/setup/start', { email: 'Mom@Example.com', token: 'tok123', password: PW, phones: ['13800000001', '13800000002'] }); ok('setup sends a code to each number', r.status === 200 && codes().length === 2, r.json);
  ok('phone numbers come back masked', r.json.phones[0] === '•••• 0001');
  let c = codes();
  r = await a.call('POST', '/api/setup/finish', { codes: [c[0], '000000'] }); ok('setup refuses one wrong code', r.status === 400);
  await sleep(50); r = await a.call('POST', '/api/setup/start', { email: 'Mom@Example.com', token: 'tok123', password: PW, phones: ['13800000001', '13800000002'] });
  ok('asking again within a minute is refused', r.status === 429);
  const FAST = { TENUP_SMS_WAIT_MS: '0' };      /* the one-minute wait is checked above; the rest of the run skips it */
  await stop(); fs.rmSync(path.join(dir, 'data'), { recursive: true, force: true }); await start(FAST);
  r = await a.call('POST', '/api/setup/start', { email: 'Mom@Example.com', token: 'tok123', password: PW, phones: ['13800000001', '13800000002'] }); c = codes();
  r = await a.call('POST', '/api/setup/finish', { codes: [c[0], c[1]] }); ok('setup completes with both codes', r.status === 200 && a.jar.tu_ses && a.jar.tu_dev, r.json);
  r = await a.call('POST', '/api/setup/start', { email: 'Mom@Example.com', token: 'tok123', password: PW, phones: ['13800000003', '13800000004'] }); ok('setup cannot be run a second time', r.status === 409);

  r = await a.call('GET', '/api/album'); ok('album starts empty at version 0', r.json.version === 0 && r.json.album === null);
  r = await a.call('PUT', '/api/album', { base: 0, album: { meta: { zh: '朵朵' }, photos: [] } }); ok('album saves', r.json.version === 1);
  r = await a.call('PUT', '/api/album', { base: 0, album: { meta: { zh: 'old' } } }); ok('a stale save is refused with the latest album', r.status === 409 && r.json.version === 1 && r.json.album.meta.zh === '朵朵');
  r = await a.call('GET', '/api/album?v=1'); ok('polling with the current version answers "same"', r.json.same === true);
  r = await a.call('PUT', '/api/album', { base: 1, album: { x: 1 } }, { noHeader: true }); ok('a write without the app header is refused', r.status === 403);
  const pic = Buffer.concat([Buffer.from('PLAINTEXT-MARKER-'), crypto.randomBytes(5000)]);
  r = await a.call('POST', '/api/file', pic); const id = r.json && r.json.id; ok('picture uploads', r.status === 200 && /^[0-9a-f]{32}$/.test(id), r.json);
  r = await a.call('GET', '/api/file/' + id); ok('picture reads back identical', r.status === 200 && r.buf.equals(pic) && r.headers.get('content-type') === 'image/jpeg');
  r = await a.call('GET', '/api/file/' + id, null, { headers: { Range: 'bytes=10-19' } }); ok('byte ranges work (needed for audio)', r.status === 206 && r.buf.equals(pic.slice(10, 20)));
  r = await a.call('POST', '/api/file', Buffer.from('<script>'), { type: 'text/html' }); ok('other file types are refused', r.status === 415);
  const disk = fs.readdirSync(path.join(dir, 'data', 'files')).map(f => fs.readFileSync(path.join(dir, 'data', 'files', f)));
  ok('the stored picture is not readable on disk', disk.length === 1 && !disk[0].includes('PLAINTEXT-MARKER') && !fs.readFileSync(path.join(dir, 'data', 'album.enc')).includes('朵朵'));
  ok('the account file does not show phone numbers', !fs.readFileSync(path.join(dir, 'data', 'account.enc')).includes('13800000001'));

  const b = client(US2);
  r = await b.call('GET', '/api/file/' + id); ok('a stranger cannot read a picture', r.status === 401);
  r = await b.call('GET', '/api/album'); ok('a stranger cannot read the album', r.status === 401);
  r = await b.call('POST', '/api/login', { email: EMAIL, password: 'wrong password!' }); ok('wrong password is refused', r.status === 401);
  r = await b.call('POST', '/api/sms/send', { which: 0 }); ok('no text message before the password', r.status === 401);
  r = await b.call('POST', '/api/login', { email: EMAIL, password: PW }); ok('new device: right password still needs a text message', r.json.ok === false && r.json.need === 'sms' && r.json.why === 'new_device');
  r = await b.call('GET', '/api/album'); ok('…and gets nothing until the code is entered', r.status === 401);
  await sleep(50); const before = codes().length;
  r = await b.call('POST', '/api/sms/send', { which: 1 }); ok('code goes to the chosen number', r.status === 200 && r.json.sentTo === '•••• 0002' && /\+8613800000002/.test(out.split('\n').filter(l => /code:/.test(l)).pop()), r.json);
  r = await b.call('POST', '/api/sms/verify', { code: '000000' }); ok('wrong code is refused', r.status === 400);
  r = await b.call('POST', '/api/sms/verify', { code: codes()[before] }); ok('right code makes the device trusted', r.status === 200 && b.jar.tu_dev);
  r = await b.call('GET', '/api/album'); ok('trusted device reads the album', r.status === 200 && r.json.version === 1);

  delete b.jar.tu_ses;
  r = await b.call('GET', '/api/album'); ok('session gone: needs the password again', r.status === 401);
  r = await b.call('POST', '/api/login', { email: EMAIL, password: PW }); ok('trusted device: password alone is enough, no text message', r.json.ok === true);
  b.ip = HOME; r = await b.call('GET', '/api/album'); ok('home-network address does not trigger anything', r.status === 200);
  if (MMDB) {
    b.ip = CN; r = await b.call('GET', '/api/album'); ok('same device from another country is stopped', r.status === 401, r.json);
    r = await b.call('POST', '/api/login', { email: EMAIL, password: PW }); ok('…and must pass a text message again', r.json.need === 'sms' && r.json.why === 'country', r.json);
    await sleep(50); const n2 = codes().length; await b.call('POST', '/api/sms/send', { which: 0 });
    r = await b.call('POST', '/api/sms/verify', { code: codes()[n2] }); ok('after the code the device works from the new country', r.status === 200 && (await b.call('GET', '/api/album')).status === 200);
    b.ip = US2; r = await b.call('GET', '/api/album'); ok('going back to the first country counts as a change too', r.status === 401);
  } else console.log('  skip country tests (no database given)');

  r = await a.call('GET', '/api/devices'); ok('device list shows both devices', r.json.devices.length === 2 && r.json.devices.filter(d => d.current).length === 1);
  await sleep(50); let n3 = codes().length;
  r = await a.call('POST', '/api/phone/change/start', { which: 0 }); ok('changing number 1 sends the code to number 2', r.json.sentTo === '•••• 0002', r.json);
  r = await a.call('POST', '/api/phone/change/confirm', { code: '111111', newPhone: '13900000009' }); ok('…a wrong code changes nothing', r.status === 400);
  r = await a.call('POST', '/api/phone/change/confirm', { code: codes()[n3], newPhone: '13900000009' }); ok('…the right code sends one to the new number', r.status === 200 && r.json.sentTo === '•••• 0009', r.json);
  r = await a.call('POST', '/api/phone/change/finish', { code: codes()[n3 + 1] }); ok('…and the new number is saved', r.status === 200 && r.json.phones[0] === '•••• 0009', r.json);
  r = await client('9.9.9.10').call('POST', '/api/phone/change/start', { which: 0 }); ok('a device without a session cannot start a number change', r.status === 401);


  /* ---- admin ---- */
  r = await a.call('GET', '/api/admin/settings'); ok('admin pages are closed before an admin exists', r.status === 403);
  r = await a.call('POST', '/api/admin/start', { password: APW, totp: '000000' }); ok('admin sign-in needs an admin first', r.status === 409);
  let n0 = codes().length;
  r = await a.call('POST', '/api/admin/enroll/start', { which: 1 }); ok('first admin setup: one code, to the chosen phone', r.status === 200 && !r.json.both && r.json.sentTo[0] === '•••• 0002' && codes().length === n0 + 1, r.json);
  r = await a.call('POST', '/api/admin/enroll/verify', { codes: ['000000'] }); ok('…a wrong code is refused', r.status === 400);
  r = await a.call('POST', '/api/admin/enroll/verify', { codes: [codes()[n0]] }); const secret = r.json && r.json.secret;
  ok('…the right code returns an authenticator secret and link', r.status === 200 && /^[A-Z2-7]{32}$/.test(secret) && /^otpauth:\/\/totp\//.test(r.json.uri), r.json);
  r = await a.call('POST', '/api/admin/enroll/finish', { password: 'too short', totp: totp(secret) }); ok('…a short admin password is refused', r.status === 400 && r.json.error === 'weak_password');
  r = await a.call('POST', '/api/admin/enroll/finish', { password: APW, totp: '123456' === totp(secret) ? '654321' : '123456' }); ok('…a wrong authenticator code is refused', r.status === 400 && r.json.error === 'bad_totp');
  r = await a.call('POST', '/api/admin/enroll/finish', { password: APW, totp: totp(secret) }); ok('…admin set up, and signed in', r.status === 200 && !!a.jar.tu_adm, r.json);
  r = await a.call('GET', '/api/admin/settings'); ok('admin sees settings, accounts and the log', r.status === 200 && r.json.smsPolicy === 'new-device' && r.json.accounts.length === 1 && r.json.accounts[0].email === EMAIL && r.json.log.length > 0, r.json);
  r = await a.call('POST', '/api/admin/accounts/add', { email: 'dad@example.com', name: '爸爸', password: 'dad password 1' }); ok('admin adds an e-mail account', r.status === 200);
  r = await a.call('POST', '/api/admin/accounts/add', { email: 'DAD@example.com', password: 'dad password 1' }); ok('…the same e-mail twice is refused', r.status === 409);
  r = await a.call('POST', '/api/admin/accounts/add', { email: 'kid@example.com', password: 'short' }); ok('…a short password is refused', r.status === 400);
  const d = client('8.8.8.8');
  r = await d.call('POST', '/api/login', { email: 'dad@example.com', password: 'dad password 1' }); ok('the new account logs in (new device → text message)', r.json.need === 'sms', r.json);
  n0 = codes().length; await d.call('POST', '/api/sms/send', { which: 0 }); r = await d.call('POST', '/api/sms/verify', { code: codes()[n0] });
  r = await d.call('GET', '/api/album'); ok('…and reads the same album, unlocked by its own password', r.status === 200 && r.json.album && r.json.album.meta.zh === '朵朵');
  r = await d.call('GET', '/api/admin/settings'); ok('a member without the admin check cannot open admin settings', r.status === 403);
  r = await d.call('POST', '/api/admin/policy', { smsPolicy: 'off' }); ok('…nor change the SMS policy', r.status === 403);
  r = await d.call('POST', '/api/admin/start', { password: APW, totp: totp(secret, 1) }); ok('admin password + authenticator still need a text message', r.json.need === 'sms', r.json);
  r = await d.call('GET', '/api/admin/settings'); ok('…and nothing opens before it', r.status === 403);
  n0 = codes().length; await d.call('POST', '/api/admin/sms/send', { which: 1 }); r = await d.call('POST', '/api/admin/sms/verify', { code: codes()[n0] });
  r = await d.call('GET', '/api/admin/settings'); ok('…with the text message, admin opens on this device too', r.status === 200);
  r = await d.call('POST', '/api/admin/start', { password: APW, totp: totp(secret, 1) }); ok('an authenticator code works only once', r.status === 401);
  r = await a.call('POST', '/api/admin/policy', { smsPolicy: 'sometimes' }); ok('an unknown SMS policy is refused', r.status === 400);
  r = await a.call('POST', '/api/admin/policy', { smsPolicy: 'off' }); ok('admin turns text messages off', r.status === 200 && r.json.smsPolicy === 'off');
  const e = client('1.1.1.1');
  r = await e.call('POST', '/api/login', { email: 'dad@example.com', password: 'dad password 1' }); ok('…a new device now gets in with e-mail and password alone', r.json.ok === true, r.json);
  r = await a.call('POST', '/api/admin/policy', { smsPolicy: 'always' }); ok('admin sets text messages for every login', r.status === 200);
  delete e.jar.tu_ses; r = await e.call('POST', '/api/login', { email: 'dad@example.com', password: 'dad password 1' }); ok('…a known device now needs one too', r.json.need === 'sms' && r.json.why === 'always', r.json);
  await a.call('POST', '/api/admin/policy', { smsPolicy: 'new-device' });
  const dadId = (await a.call('GET', '/api/admin/settings')).json.accounts.find(x => x.email === 'dad@example.com').id;
  r = await a.call('POST', '/api/admin/accounts/update', { id: dadId, password: 'new dad pass 22' }); ok('admin changes a password…', r.status === 200);
  r = await d.call('GET', '/api/album'); ok('…which signs that account out', r.status === 401);
  r = await d.call('POST', '/api/login', { email: 'dad@example.com', password: 'new dad pass 22' }); ok('…and the new password works', r.json.ok === true, r.json);
  r = await a.call('POST', '/api/admin/accounts/remove', { id: (await a.call('GET', '/api/admin/settings')).json.me }); ok('admin cannot remove the account in use', r.status === 400);
  r = await a.call('POST', '/api/admin/accounts/remove', { id: dadId }); ok('admin removes an account…', r.status === 200);
  r = await d.call('GET', '/api/album'); ok('…which is signed out everywhere', r.status === 401);
  r = await d.call('POST', '/api/login', { email: 'dad@example.com', password: 'new dad pass 22' }); ok('…and cannot log in', r.status === 401);
  n0 = codes().length;
  r = await a.call('POST', '/api/admin/enroll/start', {}); ok('replacing the admin needs codes from both phones', r.json.both === true && codes().length === n0 + 2, r.json);
  r = await a.call('POST', '/api/admin/enroll/verify', { codes: [codes()[n0], '000000'] }); ok('…one code is not enough', r.status === 400);
  r = await a.call('POST', '/api/admin/logout', {}); r = await a.call('GET', '/api/admin/settings'); ok('admin sign-out closes admin pages', r.status === 403);
  const accFile = fs.readFileSync(path.join(dir, 'data', 'account.enc'));
  ok('the account file shows neither e-mails nor the authenticator secret', !accFile.includes('dad@example.com') && !accFile.includes(secret));
  await stop(); await start(FAST);
  r = await a.call('GET', '/api/state'); ok('after a restart the data is locked', r.json.state === 'locked');
  r = await a.call('GET', '/api/file/' + id); ok('…and pictures are refused until unlocked', r.status === 423);
  r = await a.call('GET', '/api/admin/settings'); ok('after a restart the admin must sign in again', r.status === 401 || r.status === 423 || r.status === 403);
  r = await a.call('POST', '/api/login', { email: EMAIL, password: PW }); ok('the password unlocks it, no text message', r.json.ok === true);
  r = await a.call('GET', '/api/file/' + id); ok('…and the picture is back', r.status === 200 && r.buf.equals(pic));
  r = await a.call('GET', '/api/album'); ok('…with the album as saved', r.json.version === 1 && r.json.album.meta.zh === '朵朵');

  const x = client('9.9.9.9');
  for (let i = 0; i < 5; i++) r = await x.call('POST', '/api/login', { email: EMAIL, password: 'bad guess ' + i });
  r = await x.call('POST', '/api/login', { email: EMAIL, password: PW }); ok('five wrong passwords lock logins for a while', r.status === 429);
  await stop();
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: Object.assign({}, process.env, { TENUP_PORT: PORT, TENUP_DATA: path.join(dir, 'data'), TENUP_MASTER_KEY: crypto.randomBytes(32).toString('hex') }) });
  const code = await new Promise(res => proc.on('exit', res)); ok('with the wrong master key the server cannot open the data at all', code !== 0);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch(async e => { console.error(e, '\n--- server output ---\n' + out); try { proc.kill(); } catch (x) {} process.exit(1); });
