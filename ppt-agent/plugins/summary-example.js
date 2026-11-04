'use strict';
/*
 * PPT智能体 · 智能总结插件 · 示例脚本
 *
 * 调用方式（设置 → 常规 → 插件：智能总结脚本，参数默认为 "{input}" "{output}"）：
 *   <本脚本> <input.json> <output.md>
 * input.json 内容：
 *   {
 *     "version": 1,
 *     "file":  { "id", "name", "path", "kind", "pages", "author", "category", "tags", "markdown" },
 *     "pages": [ { "idx", "title", "text", "notes" }, ... ],
 *     "output": "<output.md 的完整路径>"
 *   }
 * 脚本把 Markdown 总结写入 output.md（或输出到标准输出），退出码 0 表示成功；非 0 或超时表示失败。
 * .js 脚本用 PPT智能体自带的 Node 运行，不需要另外安装；也可以写成 .py（需要本机有 Python）、.ps1、.bat / .cmd 或 .exe。
 *
 * 本示例不调用任何大模型：按页标题与正文做“抽取式”总结。要接入大模型，在 summarize() 中改为调用你自己的模型接口即可
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

const md = summarize(input);
if (outputPath) fs.writeFileSync(outputPath, md, 'utf8');
else process.stdout.write(md);
