'use strict';
/*
 * PPT智能体 · AI 调用脚本 · 示例
 *
 * 调用方式（设置 → 常规 → AI 调用脚本，参数默认为 "{input}" "{output}"）：
 *   <本脚本> <input.json> <output>
 * input.json 中的 task 表示要做的事：
 *   task = "summarize"   智能总结：{ file: { id, name, path, kind, pages, author, category, tags, markdown }, pages: [ { idx, title, text, notes } ] }
 *                        → 把 Markdown 总结写入 output
 *   task = "expandQuery" 智能搜索的查询扩展（设置中勾选“用于智能搜索”时）：{ query }
 *                        → 写入 JSON：{ "zh": [中文关键词], "en": [英文关键词], "synonyms": [] }
 *   task = "generate"    智能生成的需求理解（勾选“用于智能生成”时）：{ description }
 *                        → 写入 JSON：{ "keywords": [关键词], "topic": "主题" }
 * 结果写入 output（或输出到标准输出），退出码 0 表示成功；非 0 或超时表示失败。
 * .js 脚本用 PPT智能体自带的 Node 运行，不需要另外安装；也可以写成 .py（需要本机有 Python）、.ps1、.bat / .cmd 或 .exe。
 *
 * 本示例不调用任何大模型：按页标题与正文做“抽取式”总结、按空格与标点拆分关键词。要接入大模型，在对应函数中改为调用你自己的模型接口即可
 * （PPT智能体本身不联网，网络调用由你的脚本负责）。
 */
const fs = require('fs');

const [, , inputPath, outputPath] = process.argv;
if (!inputPath) { console.error('用法：summary-example.js <input.json> <output.md>'); process.exit(2); }
const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));

function summarize({ file, pages }) {
  const titles = pages.map((p) => (p.title || '').trim()).filter(Boolean);
  const firstLines = pages.map((p) => String(p.text || '').split('\n').map((l) => l.trim()).filter((l) => l.length > 6)[0]).filter(Boolean);
  const words = new Map();
  for (const p of pages) for (const w of `${p.title} ${p.text}`.match(/[一-龥]{2,6}|[A-Za-z][A-Za-z-]{3,}/g) || []) words.set(w, (words.get(w) || 0) + 1);
  const keywords = [...words.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([w]) => w);
  return [
    `# ${file.name} · 总结`,
    '',
    '## 一句话概要',
    `本文档共 ${pages.length} 页，主要讲述：${titles.slice(0, 3).join('、') || file.name}。`,
    '',
    '## 核心要点',
    ...titles.slice(0, 10).map((t) => `- ${t}`),
    '',
    '## 各页摘要',
    ...pages.slice(0, 30).map((p, i) => `- 第 ${p.idx} 页 ${p.title || ''}${firstLines[i] ? `：${firstLines[i].slice(0, 80)}` : ''}`),
    '',
    '## 关键词',
    keywords.join('，'),
    '',
  ].join('\n');
}

// 查询扩展 / 需求理解：示例只做简单拆分（接入大模型后可返回同义词、英文译名等）
const words = (s) => String(s || '').split(/[\s，,、；;。]+/).map((w) => w.trim()).filter((w) => w.length > 1);
function expandQuery({ query }) {
  const ws = words(query);
  return JSON.stringify({ zh: ws.filter((w) => /[\u4e00-\u9fa5]/.test(w)), en: ws.filter((w) => /^[A-Za-z]/.test(w)), synonyms: [] });
}
function generate({ description }) { return JSON.stringify({ keywords: words(description).slice(0, 12), topic: String(description || '').slice(0, 40) }); }

const task = input.task || 'summarize';
const out = task === 'expandQuery' ? expandQuery(input) : task === 'generate' ? generate(input) : summarize(input);
if (outputPath) fs.writeFileSync(outputPath, out, 'utf8');
else process.stdout.write(out);
