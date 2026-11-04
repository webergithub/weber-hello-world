'use strict';
// 智能总结插件的工作线程（worker_threads）：逐个接收文档内容，调用设置中的大模型接口（OpenAI 兼容）生成 Markdown 总结。
// 只用 Node 内置模块，由主进程读出本文件内容后以 eval 方式启动（打包后位于 app.asar 内也能运行）。
const { parentPort, workerData } = require('worker_threads');
const https = require('https');
const http = require('http');

const cfg = (workerData && workerData.llm) || {};
const fake = !!(workerData && workerData.fake);

function postJson(url, body, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = Buffer.from(JSON.stringify(body));
    const req = (u.protocol === 'http:' ? http : https).request(u, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': data.length, ...headers }, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 400) return reject(new Error(`接口返回 ${res.statusCode}：${text.slice(0, 200)}`));
        try { resolve(JSON.parse(text)); } catch { reject(new Error('接口返回的不是 JSON')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    req.end(data);
  });
}

async function llmSummary(job) {
  const base = String(cfg.baseUrl || '').replace(/\/+$/, '');
  const r = await postJson(`${base}/chat/completions`, {
    model: cfg.model,
    temperature: 0.2,
    max_tokens: 1500,
    messages: [
      { role: 'system', content: '你是资深的文档分析师。根据 PPT / 文档的逐页内容，输出一份中文 Markdown 总结，结构为：# 文档标题；## 一句话概要；## 核心要点（5~10 条）；## 各部分摘要（按章节或页面分组）；## 关键词（10 个以内，逗号分隔）。只输出 Markdown。' },
      { role: 'user', content: `文件：${job.name}\n\n${String(job.text).slice(0, 14000)}` },
    ],
  }, cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}, 120000);
  const md = r && r.choices && r.choices[0] && r.choices[0].message && r.choices[0].message.content;
  if (!md) throw new Error('大模型没有返回内容');
  return md;
}

// 测试用的本地替身（环境变量 PPTA_FAKE_LLM=1）：按页标题生成固定格式的总结，不联网
async function fakeSummary(job) {
  await new Promise((r) => setTimeout(r, 150));
  const pages = String(job.text).split('\n## ').slice(1).map((p) => p.split('\n')[0]).filter(Boolean);
  return `# ${job.name} · 总结\n\n## 一句话概要\n本文档共 ${pages.length} 页，主要内容：${pages.slice(0, 3).join('、')}。\n\n## 核心要点\n${pages.slice(0, 8).map((t) => `- ${t}`).join('\n')}\n\n## 关键词\n${pages.slice(0, 5).join('，')}\n`;
}

parentPort.on('message', async (msg) => {
  if (!msg || msg.type !== 'job') return;
  const t0 = Date.now();
  parentPort.postMessage({ type: 'start', id: msg.id });
  try {
    const md = await (fake ? fakeSummary(msg) : llmSummary(msg));
    parentPort.postMessage({ type: 'done', id: msg.id, md, ms: Date.now() - t0 });
  } catch (e) {
    parentPort.postMessage({ type: 'error', id: msg.id, error: String((e && e.message) || e), ms: Date.now() - t0 });
  }
});
