'use strict';
// AI 调用模块（v3.9）：统一封装“调用 AI”的方式，供智能总结、智能搜索（查询扩展）、智能生成（需求理解）复用。
// 引擎按优先级选择：
//   script —— 设置中的 AI 调用脚本（config.plugins.summary：script / args / timeout / enabled），子进程中异步执行，
//             脚本里可以调用用户自己的大模型；PPT智能体本身不联网；
//   llm    —— 设置中的大模型接口（联网版才可用；单机版 OFFLINE_ONLY 时不可用）；
//   fake   —— 测试用本地替身（环境变量 PPTA_FAKE_LLM=1）。
// 脚本约定：输入 JSON 含 task 字段（summarize / expandQuery / generate）与该任务的输入，脚本把结果写入 output
// （summarize 输出 Markdown；expandQuery / generate 输出 JSON），或写到标准输出；退出码 0 表示成功。
const fs = require('fs');
const os = require('os');
const path = require('path');
const runner = require('./plugins/scriptRunner');
const { client } = require('./llm');
const { OFFLINE_ONLY } = require('./offline');

const TASKS = { summarize: '文档总结', expandQuery: '查询扩展（智能搜索）', generate: '需求理解（智能生成）' };
const isFake = () => process.env.PPTA_FAKE_LLM === '1';

class AiGateway {
  constructor(service) {
    this.svc = service;
    this.calls = { ok: 0, failed: 0 };
  }

  cfg() { return ((this.svc.config.plugins || {}).summary) || {}; }

  /** 当前可用的引擎：{ ok, engine, model, reason } */
  engine() {
    const c = this.cfg();
    if (c.enabled && c.script) {
      const err = runner.validate(c);
      return err ? { ok: false, engine: 'script', reason: `AI 调用脚本不可用：${err}` } : { ok: true, engine: 'script', model: `脚本：${path.basename(c.script)}` };
    }
    if (isFake()) return { ok: true, engine: 'fake', model: '本地测试替身' };
    const llm = this.svc.config.llm || {};
    if (!OFFLINE_ONLY && client(llm)) return { ok: true, engine: 'llm', model: llm.model };
    return { ok: false, engine: null, reason: c.script ? 'AI 调用脚本已设置但未生效：请在“设置 → 常规 → AI 调用脚本”中点“生效”' : '还没有设置 AI 调用脚本：请在“设置 → 常规 → AI 调用脚本”中选择脚本并点“生效”' };
  }

  /** 某项任务能否使用 AI：summarize 只要引擎可用；expandQuery / generate 还要在设置中勾选“用于智能搜索 / 智能生成” */
  can(task) {
    const e = this.engine();
    if (!e.ok) return false;
    const c = this.cfg();
    if (task === 'expandQuery') return e.engine === 'script' ? !!c.useForSearch : e.engine === 'llm' ? !!(this.svc.config.llm || {}).useForQuery : true;
    if (task === 'generate') return e.engine === 'script' ? !!c.useForGenerate : true;
    return true;
  }

  /** 通用调用：返回 { ok, text, ms, error, engine } */
  async run(task, input, { timeoutMs, onSpawn } = {}) {
    const e = this.engine();
    if (!e.ok) return { ok: false, error: e.reason, ms: 0 };
    const t0 = Date.now();
    let r;
    if (e.engine === 'script') r = await this.runScript(task, input, { timeoutMs, onSpawn });
    else if (e.engine === 'fake') r = { ok: true, text: fakeRun(task, input) };
    else r = await this.runLlm(task, input).catch((err) => ({ ok: false, error: String(err.message || err) }));
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

  async runLlm(task, input) {
    const c = client(this.svc.config.llm);
    if (!c) return { ok: false, error: '大模型接口不可用' };
    if (task === 'expandQuery') { const r = await c.expandQuery(input.query); return r ? { ok: true, text: JSON.stringify(r) } : { ok: false, error: '没有返回结果' }; }
    const prompt = task === 'summarize'
      ? [{ role: 'system', content: '根据 PPT / 文档的逐页内容，输出中文 Markdown 总结：# 标题；## 一句话概要；## 核心要点；## 各部分摘要；## 关键词。只输出 Markdown。' }, { role: 'user', content: pagesText(input).slice(0, 14000) }]
      : [{ role: 'system', content: '把用户对新 PPT 的描述整理为检索用的 JSON：{"keywords":[中英文关键词],"topic":"主题"}，只输出 JSON。' }, { role: 'user', content: input.description || '' }];
    const text = await c.chat(prompt, { maxTokens: 1500, timeoutMs: 120000 });
    return text ? { ok: true, text } : { ok: false, error: '没有返回结果' };
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

  state() { const e = this.engine(); const c = this.cfg(); return { ...e, useForSearch: !!c.useForSearch, useForGenerate: !!c.useForGenerate, can: { summarize: this.can('summarize'), expandQuery: this.can('expandQuery'), generate: this.can('generate') }, calls: this.calls }; }
}

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

module.exports = { AiGateway, TASKS, parseJson };
