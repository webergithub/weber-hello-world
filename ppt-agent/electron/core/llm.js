'use strict';
// 可选的大模型（OpenAI 兼容接口：OpenAI / DeepSeek / 通义千问 / Kimi / Ollama 等）——用于查询中英解析、打标签与 RAG 回答。
const { postJson } = require('./vectors');

function client(cfg) {
  if (!cfg || !cfg.enabled || !cfg.model) return null;
  const base = (cfg.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  async function chat(messages, { temperature = 0.2, maxTokens = 1200, timeoutMs = 90000 } = {}) {
    const r = await postJson(`${base}/chat/completions`, { model: cfg.model, messages, temperature, max_tokens: maxTokens },
      cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}, timeoutMs);
    return (r.choices && r.choices[0] && r.choices[0].message && r.choices[0].message.content) || '';
  }
  function json(text) {
    const m = String(text).match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (!m) return null;
    try { return JSON.parse(m[0]); } catch { return null; }
  }
  return {
    chat,
    async expandQuery(q) {
      const out = await chat([
        { role: 'system', content: '你是检索查询分析助手。把用户输入（关键词或句子）解析为中英文检索关键词，补全缩写、同义词和对应的另一种语言译名。只输出 JSON：{"zh":["中文关键词"],"en":["english keywords"],"intent":"一句话意图"}，每类不超过 8 个。' },
        { role: 'user', content: q },
      ], { maxTokens: 400, timeoutMs: 30000 });
      return json(out);
    },
    async tags(title, text) {
      const out = await chat([
        { role: 'system', content: '你是文档归档助手。根据 PPT 的标题和内容，给出恰好 20 个标签（中文为主，专业术语可附英文），覆盖主题、领域、业务对象、技术、用途。只输出 JSON 数组。' },
        { role: 'user', content: `标题：${title}\n内容：\n${String(text).slice(0, 6000)}` },
      ], { maxTokens: 500, timeoutMs: 60000 });
      const arr = json(out);
      return Array.isArray(arr) ? arr.map(String).filter(Boolean).slice(0, 20) : [];
    },
    async answer(q, contexts) {
      const ctx = contexts.map((c, i) => `[${i + 1}] 《${c.file}》第${c.idx}页 ${c.title}\n${c.text}\n讲解词：${c.notes}`).join('\n\n').slice(0, 14000);
      return chat([
        { role: 'system', content: '你是 PPT 资料库问答助手。只依据给定的检索片段回答，用中文，条理清晰，并在句末用 [编号] 标注出处；资料不足时直接说明。' },
        { role: 'user', content: `问题：${q}\n\n检索片段：\n${ctx}` },
      ], { maxTokens: 1200 });
    },
  };
}

module.exports = { client };
