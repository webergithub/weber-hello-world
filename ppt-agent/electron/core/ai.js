'use strict';
// AI 调用模块（v3.9）：统一封装“调用 AI”的方式，供智能总结、智能搜索（查询扩展）、智能生成（需求理解）复用。
// 引擎（v3.11，设置 → PPT_Agent → 调用方式 config.pptAgent.engine：llm | script，未设置时有生效的脚本用脚本，否则用大模型接口）：
//   llm    —— PPT_Agent 大模型接口：DeepSeek Harness 的大模型接入层（ppt_agent/llm.js → dsh-llm.cjs），
//             需要填写 API Key 并打开“允许连接大模型接口”（默认关闭；其他功能仍不联网）；
//   script —— 设置中的 AI 调用脚本（config.plugins.summary：script / args / timeout / enabled），子进程中异步执行；
//   fake   —— 测试用本地替身（环境变量 PPTA_FAKE_LLM=1），上面两种都不可用时使用。
// 脚本约定：输入 JSON 含 task 字段（summarize / expandQuery / generate）与该任务的输入，脚本把结果写入 output
// （summarize 输出 Markdown；expandQuery / generate 输出 JSON），或写到标准输出；退出码 0 表示成功。
const fs = require('fs');
const os = require('os');
const path = require('path');
const runner = require('./plugins/scriptRunner');
const { PptAgentLlm } = require('./ppt_agent/llm');

const TASKS = { summarize: '文档总结', expandQuery: '查询扩展（智能搜索）', generate: '需求理解（智能生成）' };
const isFake = () => process.env.PPTA_FAKE_LLM === '1';

class AiGateway {
  constructor(service) {
    this.svc = service;
    this.calls = { ok: 0, failed: 0 };
    this.llm = new PptAgentLlm(service); // PPT_Agent 大模型接入层
  }

  /** 调用方式：llm | script */
  mode() {
    const m = (this.svc.config.pptAgent || {}).engine;
    if (m === 'llm' || m === 'script') return m;
    const c = this.cfg();
    return c.enabled && c.script ? 'script' : 'llm';
  }

  cfg() { return ((this.svc.config.plugins || {}).summary) || {}; }

  /** 当前可用的引擎：{ ok, engine, model, reason } */
  engine() {
    const c = this.cfg();
    if (this.mode() === 'script') {
      if (c.enabled && c.script) {
        const err = runner.validate(c);
        return err ? { ok: false, engine: 'script', reason: `AI 调用脚本不可用：${err}` } : { ok: true, engine: 'script', model: `脚本：${path.basename(c.script)}` };
      }
      if (isFake()) return { ok: true, engine: 'fake', model: '本地测试替身' };
      return { ok: false, engine: 'script', reason: c.script ? 'AI 调用脚本已设置但未生效：请在“设置 → PPT_Agent → AI 调用脚本”中点“生效”' : '还没有设置 AI 调用脚本：请在“设置 → PPT_Agent → AI 调用脚本”中选择脚本并点“生效”' };
    }
    const s = this.llm.status();
    if (s.ok) return { ok: true, engine: 'llm', model: `DeepSeek · ${s.model}`, host: s.host };
    if (isFake()) return { ok: true, engine: 'fake', model: '本地测试替身' };
    return { ok: false, engine: 'llm', reason: s.reason };
  }

  /** 某项任务能否使用 AI：summarize 只要引擎可用；expandQuery / generate 还要在设置中勾选“用于智能搜索 / 智能生成” */
  can(task) {
    const e = this.engine();
    if (!e.ok) return false;
    const c = this.cfg();
    if (task === 'expandQuery') return e.engine === 'fake' ? true : !!c.useForSearch;
    if (task === 'generate') return e.engine === 'fake' ? true : !!c.useForGenerate;
    return true;
  }

  /** 通用调用：返回 { ok, text, ms, error, engine } */
  async run(task, input, { timeoutMs, onSpawn, signal } = {}) {
    const e = this.engine();
    if (!e.ok) return { ok: false, error: e.reason, ms: 0 };
    const t0 = Date.now();
    let r;
    if (e.engine === 'script') r = await this.runScript(task, input, { timeoutMs, onSpawn });
    else if (e.engine === 'fake') { await new Promise((res) => setTimeout(res, 15)); r = { ok: true, text: fakeRun(task, input) }; } // 测试替身：模拟一点耗时
    else r = await this.runLlm(task, input, { timeoutMs, signal }).catch((err) => ({ ok: false, error: String(err.message || err) }));
    r = { ...r, ms: Date.now() - t0, engine: e.engine };
    this.calls[r.ok ? 'ok' : 'failed']++;
    this.svc.log[r.ok ? 'info' : 'warn'](`[AI] ${TASKS[task] || task}：${r.ok ? `完成（${r.ms}ms，${e.model}）` : `失败：${r.error}`}`);
    return r;
  }

  async runScript(task, input, { timeoutMs, onSpawn } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppta-ai-'));
    try {
      const inPath = path.join(dir, 'input.json'), outPath = path.join(dir, task === 'summarize' ? 'output.md' : 'output.json');
      fs.writeFileSync(inPath, JSON.stringify({ version: 1, task, ...input, output: outPath }), 'utf8');
      const vars = { input: inPath, output: outPath, file: (input.file && input.file.path) || '', md: (input.file && input.file.markdown) || '' };
      const r = await runner.run(this.cfg(), vars, { timeoutMs, onSpawn });
      if (!r.ok) return { ok: false, error: r.error, aborted: r.code === null };
      const text = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8') : r.stdout;
      return text.trim() ? { ok: true, text } : { ok: false, error: '脚本没有输出结果' };
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }

  /** PPT_Agent 大模型接口（DeepSeek Harness 接入层）：按任务组织提示词 */
  async runLlm(task, input, { timeoutMs, signal } = {}) {
    const p = PROMPTS[task];
    if (!p) return { ok: false, error: `未知的 AI 任务：${task}` };
    const custom = task === 'summarize' ? String((this.svc.config.pptAgent || {}).prompt || '').trim() : '';
    const r = await this.llm.chat({ system: custom || p.system, user: p.user(input), maxTokens: p.maxTokens, timeoutMs, signal });
    return r.ok ? { ok: true, text: r.text, usage: r.usage } : { ok: false, error: r.error, aborted: r.aborted };
  }

  // ---------- 各功能使用的便捷方法（失败时返回 null，不影响调用方的正常流程） ----------
  async summarize(doc, opts) { const r = await this.run('summarize', doc, opts); return r; }

  async expandQuery(query) {
    if (!this.can('expandQuery')) return null;
    const r = await this.run('expandQuery', { query }, { timeoutMs: 30000 });
    return r.ok ? parseJson(r.text) : null;
  }

  async generateKeywords(description) {
    if (!this.can('generate')) return null;
    const r = await this.run('generate', { description }, { timeoutMs: 60000 });
    const j = r.ok ? parseJson(r.text) : null;
    return j && Array.isArray(j.keywords) ? j : null;
  }

  state() { const e = this.engine(); const c = this.cfg(); return { ...e, mode: this.mode(), useForSearch: !!c.useForSearch, useForGenerate: !!c.useForGenerate, can: { summarize: this.can('summarize'), expandQuery: this.can('expandQuery'), generate: this.can('generate') }, calls: this.calls, llm: this.llm.state() }; }
}

/** 大模型提示词（summarize 可在设置中自定义系统提示词） */
const SUMMARY_SYSTEM = '你是企业资料库的文档分析助手。根据 PPT / 文档的逐页内容（标题、正文、讲解词），输出中文 Markdown 总结，结构为：# 文档标题；## 一句话概要；## 核心要点（5~10 条）；## 各部分摘要（按页或章节）；## 关键词（10~20 个，逗号分隔）。只依据给定内容，不要编造；只输出 Markdown。';
const PROMPTS = {
  summarize: { system: SUMMARY_SYSTEM, maxTokens: 4096, user: (input) => pagesText(input).slice(0, 60000) },
  expandQuery: { system: '你是检索查询分析助手。把用户的检索输入解析为中英文检索关键词与同义词，只输出 JSON：{"zh":[...],"en":[...],"synonyms":[...]}', maxTokens: 600, user: (input) => String(input.query || '') },
  generate: { system: '把用户对新 PPT 的描述整理为检索用的 JSON：{"keywords":[中英文关键词],"topic":"主题"}，只输出 JSON。', maxTokens: 800, user: (input) => String(input.description || '') },
};

function parseJson(text) {
  const m = String(text || '').match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

function pagesText(input) {
  return `文件：${(input.file && input.file.name) || ''}\n\n${(input.pages || []).map((p) => `## 第 ${p.idx} 页 ${p.title || ''}\n${p.text || ''}${p.notes ? `\n讲解词：${p.notes}` : ''}`).join('\n\n')}`;
}

/** 测试替身：按任务给出固定格式的结果 */
function fakeRun(task, input) {
  if (task === 'expandQuery') return JSON.stringify({ zh: [String(input.query || '')], en: [], synonyms: [] });
  if (task === 'generate') return JSON.stringify({ keywords: String(input.description || '').split(/[\s，,、]+/).filter(Boolean), topic: input.description || '' });
  const pages = input.pages || [];
  return `# ${(input.file && input.file.name) || ''} · 总结\n\n## 一句话概要\n共 ${pages.length} 页。\n\n## 核心要点\n${pages.slice(0, 8).map((p) => `- ${p.title}`).join('\n')}\n`;
}

module.exports = { AiGateway, TASKS, parseJson, PROMPTS };
