'use strict';
// 极简 SMTP 客户端（不依赖第三方库）：支持 SSL（465）与 STARTTLS（587 / 25），AUTH LOGIN / PLAIN，UTF-8 正文（base64）。
// 用于“反馈”：发件邮箱由用户在设置中配置，应用内不内置任何账号或密码。
const net = require('net');
const tls = require('tls');
const os = require('os');

const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');
const encHeader = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);
const wrap76 = (s) => s.replace(/.{1,76}/g, (m) => `${m}\r\n`);

function reader(sock) {
  let buf = '';
  let waiting = null;
  const lines = [];
  const pump = () => {
    if (!waiting) return;
    // 一条完整响应：最后一行形如 "250 xxx"（第 4 个字符是空格）
    const idx = lines.findIndex((l) => /^\d{3} /.test(l) || /^\d{3}$/.test(l));
    if (idx < 0) return;
    const resp = lines.splice(0, idx + 1);
    const w = waiting; waiting = null;
    w.resolve({ code: Number(resp[resp.length - 1].slice(0, 3)), lines: resp });
  };
  const onData = (d) => { buf += d.toString('utf8'); let i; while ((i = buf.indexOf('\n')) >= 0) { lines.push(buf.slice(0, i).replace(/\r$/, '')); buf = buf.slice(i + 1); } pump(); };
  sock.on('data', onData);
  return {
    next: (timeout = 20000) => new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('邮件服务器响应超时')), timeout);
      waiting = { resolve: (r) => { clearTimeout(t); resolve(r); }, reject };
      pump();
    }),
    detach: () => sock.removeListener('data', onData),
  };
}

/**
 * opts: { host, port, secure, user, pass, from, to, subject, text, replyTo }
 * secure=true：直接 TLS（465）；否则明文连接后若服务器支持则 STARTTLS
 */
async function sendMail(opts) {
  const { host, port = 465, secure = true, user, pass, from, to, subject, text, replyTo } = opts;
  if (!host || !from || !to) throw new Error('发件邮箱未配置完整');
  let sock = await new Promise((resolve, reject) => {
    const s = secure ? tls.connect({ host, port, servername: host }) : net.connect({ host, port });
    s.setTimeout(30000, () => { s.destroy(new Error('连接邮件服务器超时')); });
    s.once(secure ? 'secureConnect' : 'connect', () => resolve(s));
    s.once('error', reject);
  });
  let rd = reader(sock);
  const cmd = async (line, ok) => {
    if (line !== null) sock.write(`${line}\r\n`);
    const r = await rd.next();
    if (ok && !ok.includes(r.code)) throw new Error(`邮件服务器拒绝（${r.code}）：${r.lines.join(' ').slice(0, 200)}`);
    return r;
  };
  try {
    await cmd(null, [220]);
    let ehlo = await cmd(`EHLO ${os.hostname() || 'localhost'}`, [250]);
    if (!secure && ehlo.lines.some((l) => /STARTTLS/i.test(l))) {
      await cmd('STARTTLS', [220]);
      rd.detach();
      sock = await new Promise((resolve, reject) => { const s = tls.connect({ socket: sock, servername: host }, () => resolve(s)); s.once('error', reject); });
      rd = reader(sock);
      ehlo = await cmd(`EHLO ${os.hostname() || 'localhost'}`, [250]);
    }
    if (user) {
      const caps = ehlo.lines.join(' ');
      if (/AUTH[^\n]*PLAIN/i.test(caps) && !/AUTH[^\n]*LOGIN/i.test(caps)) {
        await cmd(`AUTH PLAIN ${Buffer.from(`\u0000${user}\u0000${pass || ''}`, 'utf8').toString('base64')}`, [235]);
      } else {
        await cmd('AUTH LOGIN', [334]);
        await cmd(b64(user), [334]);
        await cmd(b64(pass || ''), [235]);
      }
    }
    await cmd(`MAIL FROM:<${from}>`, [250]);
    for (const r of [].concat(to)) await cmd(`RCPT TO:<${r}>`, [250, 251]);
    await cmd('DATA', [354]);
    const headers = [
      `From: ${encHeader('PPT智能体')} <${from}>`,
      `To: <${[].concat(to).join('>, <')}>`,
      ...(replyTo ? [`Reply-To: <${replyTo}>`] : []),
      `Subject: ${encHeader(subject || '')}`,
      `Date: ${new Date().toUTCString()}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
    ];
    sock.write(`${headers.join('\r\n')}\r\n\r\n${wrap76(b64(text || ''))}.\r\n`);
    await cmd(null, [250]);
    try { await cmd('QUIT'); } catch { /* ignore */ }
  } finally {
    sock.end();
  }
  return true;
}

module.exports = { sendMail };
