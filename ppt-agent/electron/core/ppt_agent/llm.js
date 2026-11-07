'use strict';
// PPT_Agent 大模型接入层（v3.11）：直接复用 DeepSeek Harness 开源库（MIT）的大模型接入层——
// vendor/dsh-llm 中原样拷贝的 llm-deepseek 传输（Messages 接口、SSE 流、事件转换、错误分类、空闲超时、重试策略），
// 由 scripts/build-dsh-llm.mjs 编译为 ./dsh-llm.cjs。本文件只负责：读取设置、联网开关、API Key 加密保存、记录调用。
// 单机版默认不联网：只有在“设置 → PPT_Agent”打开“允许连接大模型接口”后，PPT_Agent 才会向设置的接口地址发请求；
// 其他功能仍不联网（llm.client / embedder 不受影响）。
const dsh = require('./dsh-llm.cjs');

const DEFAULTS = { baseURL: dsh.DEFAULT_BASE_URL, model: dsh.DEFAULT_MODELS[0], reasoningEffort: 'off', maxTokens: 4096, timeoutSec: 300 };
const EFFORTS = ['off', 'low', 'high', 'max'];

/** API Key 加密：有 Electron safeStorage（Windows DPAPI）时加密，否则只做编码（测试 / 不支持加密的环境） */
function seal(box, plain) {
  if (!plain) return '';
  try { if (box && box.isEncryptionAvailable()) return 'safe:' + box.encryptString(plain).toString('base64'); } catch { /* fall through */ }
  return 'b64:' + Buffer.from(plain, 'utf8').toString('base64');
}
function unseal(box, enc) {
  if (!enc) return '';
  try {
    if (enc.startsWith('safe:')) return box ? box.decryptString(Buffer.from(enc.slice(5), 'base64')) : '';
    if (enc.startsWith('b64:')) return Buffer.from(enc.slice(4), 'base64').toString('utf8');
  } catch { /* ignore */ }
  return '';
}

const hostOf = (u) => { try { return new URL(u).host; } catch { return ''; } };

class PptAgentLlm {
  constructor(service) {
    this.svc = service;
    this.box = null; // Electron safeStorage（main.js 注入）
    this.fetchImpl = null; // Electron net.fetch（使用系统代理；main.js 注入），测试时用全局 fetch
    this.calls = { ok: 0, failed: 0, inputTokens: 0, outputTokens: 0 };
  }

  agentCfg() { return this.svc.config.pptAgent || {}; }
  cfg() { const l = this.agentCfg().llm || {}; return { ...DEFAULTS, ...l, reasoningEffort: EFFORTS.includes(l.reasoningEffort) ? l.reasoningEffort : DEFAULTS.reasoningEffort }; }
  allowed() { return !!this.agentCfg().allowNetwork; }
  key() { return unseal(this.box, this.cfg().apiKeyEnc || ''); }
  seal(plain) { return seal(this.box, String(plain || '').trim()); }

  /** 是否可用：{ ok, reason, model, host } */
  status() {
    const c = this.cfg();
    const base = { model: c.model, host: hostOf(c.baseURL), baseURL: c.baseURL, allowNetwork: this.allowed(), hasApiKey: !!c.apiKeyEnc };
    if (!hostOf(c.baseURL)) return { ...base, ok: false, reason: 'PPT_Agent 大模型接口地址无效：请在“设置 → PPT_Agent”中检查接口地址' };
    if (!c.apiKeyEnc) return { ...base, ok: false, reason: '还没有配置 PPT_Agent 大模型接口：请在“设置 → PPT_Agent”中填写 API Key，并打开“允许连接大模型接口”（或改用 AI 调用脚本）' };
    if (!this.key()) return { ...base, ok: false, reason: '无法读取保存的 API Key（可能换了电脑或 Windows 账号）：请在“设置 → PPT_Agent”中重新填写' };
    if (!this.allowed()) return { ...base, ok: false, reason: 'PPT_Agent 未允许连接大模型接口：请在“设置 → PPT_Agent”中打开“允许连接大模型接口”' };
    if (!c.model) return { ...base, ok: false, reason: '没有设置模型：请在“设置 → PPT_Agent”中选择模型' };
    return { ...base, ok: true };
  }

  options(override = {}) {
    const c = { ...this.cfg(), ...override };
    return {
      baseURL: c.baseURL, apiKey: override.apiKey !== undefined ? override.apiKey : this.key(), model: c.model,
      fetch: this.fetchImpl || undefined, userAgent: `PPT_Agent/${this.svc.appVersion || ''}`,
      maxTokens: Number(c.maxTokens) || DEFAULTS.maxTokens, reasoningEffort: c.reasoningEffort,
    };
  }

  /** 一次对话：{ system, user, maxTokens, signal, timeoutMs } → { ok, text, ms, usage, attempts, error, code } */
  async chat({ system, user, maxTokens, signal, timeoutMs, override, force = false } = {}) {
    if (!force) { const s = this.status(); if (!s.ok) return { ok: false, error: s.reason, code: 'NOT_CONFIGURED', ms: 0 }; }
    else if (!this.allowed()) return { ok: false, error: 'PPT_Agent 未允许连接大模型接口', code: 'NOT_ALLOWED', ms: 0 };
    const opts = this.options(override);
    const limit = timeoutMs || Math.max(10, Number(this.cfg().timeoutSec) || DEFAULTS.timeoutSec) * 1000;
    const sigs = [AbortSignal.timeout(limit)];
    if (signal) sigs.push(signal);
    const t0 = Date.now();
    this.svc.log.info(`[PPT_Agent] 请求 ${hostOf(opts.baseURL)}（模型 ${opts.model}）`);
    try {
      const r = await dsh.complete(opts, { system, messages: [{ role: 'user', text: String(user || '') }], maxTokens, signal: AbortSignal.any(sigs) });
      this.calls.ok++;
      if (r.usage) { this.calls.inputTokens += r.usage.inputTokens || 0; this.calls.outputTokens += r.usage.outputTokens || 0; }
      return { ok: true, text: r.text, ms: Date.now() - t0, usage: r.usage, attempts: r.attempts };
    } catch (e) {
      this.calls.failed++;
      const timedOut = sigs[0].aborted && !(signal && signal.aborted);
      const code = timedOut ? 'TIMEOUT' : e.code || 'ERROR';
      const msg = timedOut ? `大模型请求超时（${Math.round(limit / 1000)} 秒）` : describe(e);
      return { ok: false, error: msg, code, ms: Date.now() - t0, aborted: !!(signal && signal.aborted) };
    }
  }

  /** 测试连接：可传入尚未保存的设置（apiKey 为明文；不传则用已保存的） */
  async test(patch = {}) {
    const override = {};
    for (const k of ['baseURL', 'model', 'reasoningEffort']) if (patch[k]) override[k] = patch[k];
    if (patch.apiKey) override.apiKey = String(patch.apiKey).trim();
    if (!(override.apiKey || this.key())) return { ok: false, error: '请先填写 API Key' };
    const r = await this.chat({ system: '只回复 OK', user: 'ping', maxTokens: 16, timeoutMs: 30000, override, force: true });
    return r.ok ? { ok: true, ms: r.ms, reply: r.text.trim().slice(0, 60) } : { ok: false, error: r.error, code: r.code };
  }

  state() {
    const s = this.status();
    const c = this.cfg();
    return { ...s, reasoningEffort: c.reasoningEffort, maxTokens: c.maxTokens, timeoutSec: c.timeoutSec, models: dsh.DEFAULT_MODELS, defaultBaseURL: dsh.DEFAULT_BASE_URL, calls: this.calls };
  }
}

const CODE_TEXT = { AUTH: 'API Key 无效或没有权限', QUOTA: '账户余额 / 额度不足', RATE_LIMIT: '请求过于频繁（已按策略重试）', CONTEXT_WINDOW_EXCEEDED: '文档内容超过模型上下文长度', INVALID_REQUEST: '请求被拒绝', SERVER: '大模型服务暂时不可用（已按策略重试）', TIMEOUT: '大模型响应超时', TRANSPORT: '网络连接失败', ABORTED: '已取消', EMPTY_RESPONSE: '大模型没有返回内容', MALFORMED_RESPONSE: '大模型返回的数据格式不正确', MISSING_CREDENTIAL: '没有 API Key' };
function describe(e) {
  const code = e && e.code;
  const base = CODE_TEXT[code] || '大模型调用失败';
  const detail = e && e.message && !String(e.message).startsWith('DeepSeek Messages request failed') ? `：${dsh.errorChain(e).slice(0, 300)}` : e && e.failure && e.failure.status ? `（HTTP ${e.failure.status}）` : '';
  return `${base}${detail}`;
}

module.exports = { PptAgentLlm, DEFAULTS, seal, unseal, describe };
