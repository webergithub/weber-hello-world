'use strict';
// AI 调用模块（v3.9）：统一封装“调用 AI”的方式，供智能总结、智能搜索（查询扩展）、智能生成（需求理解）复用。
// 引擎（v3.11，设置 → PPT_Agent → 调用方式 config.pptAgent.engine：llm | script，未设置时有生效的脚本用脚本，否则用大模型接口）：
//   llm    —— PPT_Agent 大模型接口：DeepSeek Harness 的大模型接入层（ppt_agent/llm.js → dsh-llm.cjs），
//             需要填写 API Key 并打开“允许连接内网大模型”（默认关闭；其他功能仍不联网）；
//   script —— 设置中的 AI 调用脚本（config.plugins.summary：script / args / timeout / enabled），子进程中异步执行；
//   fake   —— 测试用本地替身（环境变量 PPTA_FAKE_LLM=1），上面两种都不可用时使用。
// 脚本约定：输入 JSON 含 task 字段（summarize / expandQuery / generate）与该任务的输入，脚本把结果写入 output
// （summarize 输出 Markdown；expandQuery / generate 输出 JSON），或写到标准输出；退出码 0 表示成功。
const fs = require('fs');
const os = require('os');
const path = require('path');
const runner = require('./plugins/scriptRunner');
const { PptAgentLlm } = require('./ppt_agent/llm');

const TASKS = { summarize: '文档总结', expandQuery: '查询扩展（智能搜索）', generate: '需求理解（智能生成）', wikiIngest: 'LLMWiki 炼丹', wikiQuery: 'LLMWiki 问答', speakerNotes: '生成讲解词', translate: '翻译讲解词', ragAnswer: '资料库问答', convertRules: '转换规则' };
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
    if (s.ok) return { ok: true, engine: 'llm', model: `${s.providerName} · ${s.model}`, host: s.host };
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
    else if (e.engine === 'fake') { await new Promise((res) => setTimeout(res, 120)); r = { ok: true, text: fakeRun(task, input) }; } // 测试替身：模拟一点耗时
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

  /** PPT_Agent 大模型接口（复用 DeepSeek Harness 的连接框架，服务商由用户选择）：按任务组织提示词 */
  async runLlm(task, input, { timeoutMs, signal } = {}) {
    const p = PROMPTS[task];
    if (!p) return { ok: false, error: `未知的 AI 任务：${task}` };
    const custom = task === 'summarize' ? String((this.svc.config.pptAgent || {}).prompt || '').trim() : '';
    const r = await this.llm.chat({ system: custom || p.system, user: p.user(input), maxTokens: p.maxTokens, timeoutMs, signal });
    return r.ok ? { ok: true, text: r.text, usage: r.usage } : { ok: false, error: r.error, aborted: r.aborted };
  }

  // ---------- 各功能使用的便捷方法（失败时返回 null，不影响调用方的正常流程） ----------
  async summarize(doc, opts) { const r = await this.run('summarize', doc, opts); return r; }

  /** 需要大模型才能完成的功能（讲解词生成、翻译、问答等）：不可用时抛出带原因的错误（指向“设置 → PPT_Agent”） */
  async require(task, input, opts = {}) {
    const e = this.engine();
    if (!e.ok) throw new Error(`${TASKS[task] || task}需要大模型：${e.reason || '请在“设置 → PPT_Agent”中配置并允许连接内网大模型'}`);
    const r = await this.run(task, input, { timeoutMs: 120000, ...opts });
    if (!r.ok) throw new Error(`${TASKS[task] || task}失败：${r.error}`);
    const text = String(r.text || '').trim();
    if (!text) throw new Error(`${TASKS[task] || task}：大模型没有返回内容`);
    return { text, model: e.model, engine: e.engine, ms: r.ms };
  }

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
  // LLMWiki（v3.13）：炼丹 = 把一份原始资料提炼为资料页；问答 = 只基于选出的 Wiki 页面作答并引用页面
  // v3.16：原“其他大模型功能”（讲解词生成 / 翻译 / RAG 回答 / 转换规则）改为复用 PPT_Agent 的大模型
  speakerNotes: { system: '你是资深演讲教练。根据幻灯片内容写一段中文讲解词（150~300 字），口语化、条理清楚，先点题再分点讲解，最后一句承上启下。只输出讲解词正文。', maxTokens: 1200, user: (i) => `文件：${i.fileName}\n标题：${i.title}\n页面内容：\n${String(i.text || '').slice(0, 2500)}\n${i.notes ? '原讲解词（可参考）：' + String(i.notes).slice(0, 800) : ''}` },
  translate: { system: '你是专业的演讲稿翻译。把用户给出的 PPT 讲解词翻译成目标语言，保持口语化与原有分段，专业术语准确，不要增删内容，不要解释。只输出译文。', maxTokens: 4000, user: (i) => `目标语言：${i.langName}\n\n${String(i.text || '').slice(0, 8000)}` },
  ragAnswer: { system: '你是 PPT 资料库问答助手。只依据给定的检索片段回答，用中文，条理清晰，并在句末用 [编号] 标注出处；资料不足时直接说明。', maxTokens: 2000, user: (i) => `问题：${i.q}\n\n检索片段：\n${(i.contexts || []).map((c, k) => `[${k + 1}] ${c.file} 第 ${c.idx} 页 ${c.title}\n${c.text}${c.notes ? `\n讲解词：${c.notes}` : ''}`).join('\n\n')}` },
  convertRules: { system: '你是 PPT 配色转换规则助手。根据用户要求修改给定的 JSON 规则，只输出修改后的完整 JSON。颜色使用 6 位十六进制（不带#），null 表示无/透明。', maxTokens: 3000, user: (i) => `当前规则：${JSON.stringify(i.current)}\n修改要求：${i.request}` },
  wikiIngest: { system: '你是 LLM Wiki 的维护者，按下面的 Wiki 规则把一份原始资料提炼为资料页。只依据给定内容，不要编造。只输出 JSON：{"summary":"一句话概要（不超过 60 字）","points":["要点（3~10 条，每条不超过 40 字）"],"entities":["资料中的关键实体 / 概念名称（人名、系统、项目、产品、术语，最多 10 个）"]}', maxTokens: 1500, user: (input) => `# Wiki 规则\n${String(input.schema || '').slice(0, 4000)}\n\n# 原始资料\n${pagesText(input).slice(0, 40000)}` },
  wikiQuery: { system: '你是 LLM Wiki 的问答助手。只根据给定的 Wiki 页面回答问题，用中文 Markdown；引用页面时用 [[页面路径|标题]] 的格式写出来源；页面中没有的信息要明确说明“Wiki 中没有相关内容”，不要编造；不同页面说法冲突时并列列出。', maxTokens: 3000, user: (input) => `${(input.history || []).length ? `# 之前的问答（追问的上下文）\n${input.history.map((h) => `问：${h.q}\n答：${h.a}`).join('\n\n')}\n\n` : ''}# 问题\n${input.question}\n\n# Wiki 页面\n${(input.pages || []).map((p) => `## [[${p.slug}|${p.title}]]\n${p.content}`).join('\n\n').slice(0, 60000)}` },
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
  if (task === 'wikiIngest') { const ps = input.pages || []; return JSON.stringify({ summary: `${(input.file && input.file.name) || ''}：共 ${ps.length} 页`, points: ps.slice(0, 5).map((p) => p.title).filter(Boolean), entities: ['测试实体'] }); }
  if (task === 'speakerNotes') return `这一页讲的是“${input.title || ''}”。`;
  if (task === 'translate') return `[${input.langName}] ${input.text}`;
  if (task === 'ragAnswer') return `根据资料：${(input.contexts || []).map((c, k) => `${c.title} [${k + 1}]`).join('；')}`;
  if (task === 'convertRules') return JSON.stringify(input.current || {});
  if (task === 'wikiQuery') return `关于“${input.question}”：\n\n${(input.pages || []).map((p) => `- 见 [[${p.slug}|${p.title}]]`).join('\n')}`;
  const pages = input.pages || [];
  return `# ${(input.file && input.file.name) || ''} · 总结\n\n## 一句话概要\n共 ${pages.length} 页。\n\n## 核心要点\n${pages.slice(0, 8).map((p) => `- ${p.title}`).join('\n')}\n`;
}

module.exports = { AiGateway, TASKS, parseJson, PROMPTS };
