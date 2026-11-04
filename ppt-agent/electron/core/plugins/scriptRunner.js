'use strict';
// 插件脚本调用：按脚本类型选择运行方式，在单独的子进程中异步执行（不阻塞解析任务），超时结束进程。
// 参数模板中的占位符：{input} 输入 JSON 路径，{output} 输出 Markdown 路径，{file} 原文件路径，{md} 解析出的 Markdown 路径。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const isWin = process.platform === 'win32';

/** 把参数模板拆成参数数组（支持双引号包住含空格的参数） */
function splitArgs(tpl) {
  const out = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(String(tpl || '')))) out.push(m[1] !== undefined ? m[1] : m[2]);
  return out;
}

/** 脚本 → { cmd, args, env } */
function commandFor(script) {
  const ext = path.extname(script).toLowerCase();
  if (['.js', '.cjs', '.mjs'].includes(ext)) return { cmd: process.execPath, args: [script], env: { ELECTRON_RUN_AS_NODE: '1' } }; // 用 PPT智能体自带的 Node 运行
  if (ext === '.py') return { cmd: isWin ? 'python' : 'python3', args: [script] };
  if (ext === '.ps1') return { cmd: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script] };
  if (ext === '.bat' || ext === '.cmd') return { cmd: 'cmd.exe', args: ['/d', '/c', script] };
  return { cmd: script, args: [] };
}

/** 检查脚本配置（不运行）：返回错误信息或 null */
function validate(cfg) {
  const s = cfg && cfg.script;
  if (!s) return '没有设置脚本';
  if (!fs.existsSync(s)) return `脚本不存在：${s}`;
  if (!fs.statSync(s).isFile()) return `不是文件：${s}`;
  return null;
}

/** 运行一次：返回 { ok, code, ms, stdout, stderr, error } */
function run(cfg, vars, { timeoutMs, onSpawn } = {}) {
  return new Promise((resolve) => {
    const err = validate(cfg);
    if (err) { resolve({ ok: false, error: err, ms: 0 }); return; }
    const c = commandFor(cfg.script);
    const args = [...c.args, ...splitArgs(cfg.args || '"{input}" "{output}"').map((a) => a.replace(/\{(input|output|file|md)\}/g, (_, k) => vars[k] || ''))];
    const t0 = Date.now();
    let stdout = '', stderr = '', done = false;
    let child;
    try {
      child = spawn(c.cmd, args, { cwd: path.dirname(cfg.script), windowsHide: true, env: { ...process.env, ...(c.env || {}), PPTA_INPUT: vars.input || '', PPTA_OUTPUT: vars.output || '' } });
    } catch (e) { resolve({ ok: false, error: `无法启动脚本：${e.message}`, ms: 0 }); return; }
    if (onSpawn) onSpawn(child);
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); resolve({ ms: Date.now() - t0, stdout, stderr: stderr.slice(-4000), ...r }); };
    const limit = timeoutMs || Math.max(5, Number(cfg.timeout) || 300) * 1000;
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } finish({ ok: false, error: `脚本运行超时（${Math.round(limit / 1000)} 秒）` }); }, limit);
    child.stdout.on('data', (d) => { if (stdout.length < 4e6) stdout += d; });
    child.stderr.on('data', (d) => { if (stderr.length < 1e5) stderr += d; });
    child.on('error', (e) => finish({ ok: false, error: `无法启动脚本：${e.message}` }));
    child.on('close', (code) => finish(code === 0 ? { ok: true, code } : { ok: false, code, error: `脚本退出码 ${code}${stderr.trim() ? `：${stderr.trim().split('\n').slice(-3).join(' ')}` : ''}` }));
  });
}

/** 检查：用一份示例文档试运行，确认能生成 Markdown */
async function check(cfg) {
  const err = validate(cfg);
  if (err) return { ok: false, error: err };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppta-plugin-'));
  try {
    const input = path.join(dir, 'input.json'), output = path.join(dir, 'output.md');
    fs.writeFileSync(input, JSON.stringify({ version: 1, file: { id: 0, name: '示例文档.pptx', path: '', kind: 'ppt', pages: 2, author: '', category: '', tags: ['示例'], markdown: '' },
      pages: [{ idx: 1, title: '示例：项目概览', text: '这是用于检查插件脚本的示例内容。', notes: '' }, { idx: 2, title: '示例：下一步计划', text: '确认脚本能读取输入并写出 Markdown 总结。', notes: '' }], output }), 'utf8');
    const r = await run(cfg, { input, output, file: '', md: '' }, { timeoutMs: Math.min(120, Math.max(5, Number(cfg.timeout) || 300)) * 1000 });
    if (!r.ok) return { ok: false, error: r.error, ms: r.ms };
    const md = fs.existsSync(output) ? fs.readFileSync(output, 'utf8') : r.stdout;
    if (!md.trim()) return { ok: false, error: '脚本运行成功，但没有写出 Markdown（输出文件为空，标准输出也为空）', ms: r.ms };
    return { ok: true, ms: r.ms, preview: md.slice(0, 300) };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

module.exports = { run, check, validate, splitArgs, commandFor };
