/* 短信通道。 TENUP_SMS 选择： console（默认，验证码打印在服务器日志里，仅供调试）、aliyun、tencent、webhook。
   aliyun 和 tencent 按各自的官方签名方法实现，但没有用真实账号发过短信：上线前请先各发一条试试。 */
'use strict';
const https = require('https'), crypto = require('crypto');
const env = process.env, kind = (env.TENUP_SMS || 'console').toLowerCase();

function request(url, opt, bodyStr) {
  return new Promise((resolve, reject) => {
    const r = https.request(url, Object.assign({ timeout: 10000 }, opt), res => {
      const c = []; res.on('data', d => c.push(d)); res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(c).toString() }));
    });
    r.on('timeout', () => r.destroy(new Error('timeout'))); r.on('error', reject);
    if (bodyStr) r.write(bodyStr);
    r.end();
  });
}
const pct = s => encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());

const providers = {
  console: async (phone, code, purpose) => { console.log('[tenup] 短信（测试通道）→ ' + phone + '  验证码 code: ' + code + '  (' + purpose + ')'); },

  /* 阿里云短信 Dysmsapi SendSms。需要： TENUP_ALIYUN_KEY_ID, TENUP_ALIYUN_KEY_SECRET, TENUP_ALIYUN_SIGN, TENUP_ALIYUN_TEMPLATE（模板里的变量名为 code） */
  aliyun: async (phone, code) => {
    const p = { AccessKeyId: env.TENUP_ALIYUN_KEY_ID, Action: 'SendSms', Format: 'JSON', PhoneNumbers: phone.replace(/^\+86/, ''), RegionId: 'cn-hangzhou', SignName: env.TENUP_ALIYUN_SIGN,
      SignatureMethod: 'HMAC-SHA1', SignatureNonce: crypto.randomBytes(16).toString('hex'), SignatureVersion: '1.0', TemplateCode: env.TENUP_ALIYUN_TEMPLATE,
      TemplateParam: JSON.stringify({ code }), Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), Version: '2017-05-25' };
    const query = Object.keys(p).sort().map(k => pct(k) + '=' + pct(p[k])).join('&');
    const sig = crypto.createHmac('sha1', env.TENUP_ALIYUN_KEY_SECRET + '&').update('GET&%2F&' + pct(query)).digest('base64');
    const r = await request('https://dysmsapi.aliyuncs.com/?Signature=' + pct(sig) + '&' + query, { method: 'GET' });
    let j = {}; try { j = JSON.parse(r.text); } catch (e) {}
    if (j.Code !== 'OK') throw new Error('aliyun: ' + (j.Message || j.Code || r.status));
  },

  /* 腾讯云短信 SendSms（API 3.0，TC3-HMAC-SHA256）。需要： TENUP_TENCENT_SECRET_ID, TENUP_TENCENT_SECRET_KEY, TENUP_TENCENT_APP_ID, TENUP_TENCENT_SIGN, TENUP_TENCENT_TEMPLATE */
  tencent: async (phone, code) => {
    const host = 'sms.tencentcloudapi.com', ts = Math.floor(Date.now() / 1000), date = new Date(ts * 1000).toISOString().slice(0, 10);
    const payload = JSON.stringify({ PhoneNumberSet: [phone], SmsSdkAppId: env.TENUP_TENCENT_APP_ID, SignName: env.TENUP_TENCENT_SIGN, TemplateId: env.TENUP_TENCENT_TEMPLATE, TemplateParamSet: [code] });
    const hash = s => crypto.createHash('sha256').update(s).digest('hex'), hmac = (k, s) => crypto.createHmac('sha256', k).update(s).digest();
    const canonical = 'POST\n/\n\ncontent-type:application/json; charset=utf-8\nhost:' + host + '\n\ncontent-type;host\n' + hash(payload);
    const scope = date + '/sms/tc3_request', toSign = 'TC3-HMAC-SHA256\n' + ts + '\n' + scope + '\n' + hash(canonical);
    const sig = crypto.createHmac('sha256', hmac(hmac(hmac('TC3' + env.TENUP_TENCENT_SECRET_KEY, date), 'sms'), 'tc3_request')).update(toSign).digest('hex');
    const r = await request('https://' + host + '/', { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8', Host: host, 'X-TC-Action': 'SendSms', 'X-TC-Version': '2021-01-11', 'X-TC-Region': env.TENUP_TENCENT_REGION || 'ap-guangzhou', 'X-TC-Timestamp': String(ts),
      Authorization: 'TC3-HMAC-SHA256 Credential=' + env.TENUP_TENCENT_SECRET_ID + '/' + scope + ', SignedHeaders=content-type;host, Signature=' + sig } }, payload);
    let j = {}; try { j = JSON.parse(r.text).Response || {}; } catch (e) {}
    const st = j.SendStatusSet && j.SendStatusSet[0];
    if (!st || st.Code !== 'Ok') throw new Error('tencent: ' + ((st && st.Message) || (j.Error && j.Error.Message) || r.status));
  },

  /* 自己的短信网关： POST JSON { phone, code, purpose } 到 TENUP_SMS_WEBHOOK，可带 TENUP_SMS_WEBHOOK_TOKEN */
  webhook: async (phone, code, purpose) => {
    const body = JSON.stringify({ phone, code, purpose });
    const r = await request(env.TENUP_SMS_WEBHOOK, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, env.TENUP_SMS_WEBHOOK_TOKEN ? { Authorization: 'Bearer ' + env.TENUP_SMS_WEBHOOK_TOKEN } : {}) }, body);
    if (r.status < 200 || r.status >= 300) throw new Error('webhook: ' + r.status);
  }
};
if (!providers[kind]) throw new Error('TENUP_SMS must be one of: ' + Object.keys(providers).join(', '));
exports.name = () => kind;
exports.send = (phone, code, purpose) => providers[kind](phone, code, purpose);
