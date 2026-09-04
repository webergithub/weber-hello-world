#!/usr/bin/env node
/**
 * 跑全量测试并生成一份可读的 HTML 报告。
 *
 *   node tools/test-report.mjs [--out report.html] [--jobs 4]
 *
 * 为什么不直接用 `node --test` 的输出：它把所有文件的用例**拍平**成一串
 * `ok 1..N`，不带文件归属；junit reporter 的 classname 也只是目录名。
 * 想看"哪个文件在验什么、每条用例花了多久、失败的那条断言到底说了什么"，
 * 就得按文件分别跑再自己聚合。
 *
 * 顺带把每个测试文件顶部的说明注释抽出来当小节导语——这个项目的测试文件
 * 头注释写了"这一层到底在守什么线"，是报告里最有信息量的一段，
 * 不放上去等于扔掉了。
 */

import { readFile, writeFile } from 'node:fs/promises';
import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const OUT = path.resolve(ROOT, arg('--out', 'test-report.html'));
const JOBS = Math.max(1, Number(arg('--jobs', '4')) || 4);
// 只改版式不重跑：套件要六分钟，为了调一行 CSS 再跑一遍很蠢
const FROM = arg('--from', null);

/* ── 跑 ──────────────────────────────────────────────────── */

function runFile(file) {
  return new Promise((resolve) => {
    const started = Date.now();
    // 逐文件跑才拿得到文件归属。TAP 是这里最好解析的一种输出。
    const p = spawn(process.execPath, ['--test', '--test-reporter=tap', file], {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    p.stdout.on('data', (c) => { out += c; });
    p.stderr.on('data', (c) => { err += c; });
    p.on('close', (code) => resolve({ file, code, out, err, elapsedMs: Date.now() - started }));
  });
}

/** 简单的并发闸：一次最多跑 JOBS 个文件，别把机器打满。 */
async function pool(items, worker, size) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  }));
  return results;
}

/* ── 解析 TAP ────────────────────────────────────────────── */

/**
 * 把一个文件的 TAP 输出解析成用例列表。
 *
 * 只认顶层用例（这个项目的测试都是平铺的）。YAML 块里真正有用的是
 * duration_ms 和失败时的 error/stack，逐行摘出来即可——为了这点东西
 * 引一个 YAML 解析器不值当。
 */
function parseTap(text) {
  const lines = text.split('\n');
  const tests = [];
  const totals = {};
  let cur = null;
  let yaml = null;

  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');

    const m = /^(not ok|ok)\s+(\d+)\s+-\s+(.*)$/.exec(line);
    if (m) {
      const [, verdict, , rest] = m;
      // `ok 3 - 名字 # SKIP 原因`
      const skip = /\s+#\s+(SKIP|TODO)\b\s*(.*)$/i.exec(rest);
      cur = {
        name: (skip ? rest.slice(0, skip.index) : rest).trim(),
        status: skip ? 'skipped' : (verdict === 'ok' ? 'passed' : 'failed'),
        skipReason: skip ? (skip[2] || '').trim() : null,
        durationMs: null,
        detail: '',
      };
      tests.push(cur);
      continue;
    }

    if (/^\s*---\s*$/.test(line) && cur) { yaml = []; continue; }
    if (/^\s*\.\.\.\s*$/.test(line) && yaml && cur) {
      const block = yaml.join('\n');
      const d = /duration_ms:\s*([\d.]+)/.exec(block);
      if (d) cur.durationMs = Number(d[1]);
      // 失败时把整块留着——断言的 expected/actual/stack 都在里面，
      // 这正是"中间过程"最该看的部分
      if (cur.status === 'failed') cur.detail = block;
      yaml = null;
      continue;
    }
    if (yaml) { yaml.push(line); continue; }

    const t = /^#\s+(tests|pass|fail|skipped|todo|cancelled|duration_ms)\s+([\d.]+)$/.exec(line);
    if (t) totals[t[1]] = Number(t[2]);
  }
  return { tests, totals };
}

/** 抽测试文件顶部的块注释，当小节导语。 */
async function fileIntro(file) {
  const src = await readFile(path.resolve(ROOT, file), 'utf8');
  const m = /^\s*\/\*\*([\s\S]*?)\*\//.exec(src);
  if (!m) return '';
  return m[1]
    .split('\n')
    .map((l) => l.replace(/^\s*\*\s?/, '').trimEnd())
    .join('\n')
    .trim();
}

/* ── HTML ────────────────────────────────────────────────── */

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/** 注释里的 `code`、**粗体** 转成标签，其余原样。 */
const rich = (s) => esc(s)
  .replace(/`([^`]+)`/g, '<code>$1</code>')
  .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');

const ms = (n) => (n == null ? '—' : (n >= 1000 ? `${(n / 1000).toFixed(2)}s` : `${Math.round(n)}ms`));

/**
 * 每个测试文件在守什么。
 *
 * 这不是装饰：这套用例里"慢"和"快"的分布不是随机的——对抗性模糊测试和
 * 真开浏览器那几个文件吃掉了绝大部分时间，而它们恰恰是最该看的几个。
 * 标出来，读报告的人才知道该往哪儿看。
 */
const ROLES = {
  containerFuzz: ['对抗性', '喂畸形 MP4，验解析器不崩、不卡死、不吃光内存'],
  matroskaFuzz: ['对抗性', '喂畸形 MKV，同上，外加"兜住之后必须说出来"'],
  forensics: ['取证', '容器解析与报告：时长、码率、样本表、校验和'],
  webRender: ['真浏览器', '真启动 Chromium 打开页面，验转义与 XSS'],
  serpFramework: ['自有检索', 'HTML 抽取 · 引擎配方 · http 策略 · 策略阶梯 · 编码判定'],
  serpBackend: ['自有检索', '后端选路；browser 那几条要真有浏览器才跑'],
  pipeline: ['编排', '并发、去重、两趟排名、进度上报'],
  score: ['打分', '六维可解释打分与硬门槛'],
  match: ['准入', '片名归一化与相似度——挡"搜 A 返回 B"'],
  videoSanity: ['准入', '只看时长与体积的有效性初判'],
  titles: ['语料', '真实中英文片名清单跑归一化与解析'],
  titlesPipeline: ['语料', '同一份清单跑完整管线'],
  mediaGuard: ['安全边界', '媒体代理与下载的域名白名单'],
  filenameSafety: ['安全边界', '落盘文件名：路径穿越、超长、控制字符'],
  localDownload: ['下载', '浏览器端分块并发直存与读回校验'],
  downloader: ['下载', '服务端下载队列'],
  digest: ['下载', '纯 JS 的增量 MD5 / SHA-1'],
  registry: ['配置', '按配置装配适配器 + 白名单不被撑大'],
  sourceConfig: ['配置', '配置规范化：坏值、缺字段、迁移'],
  searchEngine: ['适配器', '引擎适配器：翻页、解析、产品边界'],
  verify: ['验证', '深度验证与截图取证'],
  expand: ['检索词', '近似词生成与推荐词过滤'],
  progress: ['进度', '粗算百分比：不倒退、跑完到 100%'],
};

function buildHtml(report) {
  const { files, summary, generatedAt, nodeVersion } = report;
  const key = (f) => f.file.replace(/^test\//, '').replace(/\.test\.js$/, '');
  const slowest = files.flatMap((f) => f.tests.map((t) => ({ ...t, file: key(f) })))
    .filter((t) => t.durationMs != null)
    .sort((a, b) => b.durationMs - a.durationMs).slice(0, 8);
  const maxFileMs = Math.max(...files.map((f) => f.elapsedMs), 1);
  const byTime = [...files].sort((a, b) => b.elapsedMs - a.elapsedMs);
  const pct = summary.total ? (summary.passed / summary.total) * 100 : 0;

  const sections = byTime.map((f) => {
    const k = key(f);
    const [role, what] = ROLES[k] || ['', ''];
    const rows = f.tests.map((t) => `
        <tr class="case" data-st="${t.status}">
          <td class="st"><i class="dot ${t.status}"></i></td>
          <td class="nm">${esc(t.name)}${t.skipReason ? `<em class="why">${esc(t.skipReason)}</em>` : ''}${
            t.detail ? `<pre class="detail">${esc(t.detail)}</pre>` : ''}</td>
          <td class="ms">${ms(t.durationMs)}</td>
        </tr>`).join('');
    return `
      <section class="file" id="f-${esc(k)}" data-name="${esc(k)} ${esc(what)}">
        <header class="fh">
          <div class="fh-l">
            <h2>${esc(f.file)}</h2>
            ${role ? `<span class="role">${esc(role)}</span>` : ''}
          </div>
          <div class="fh-r">
            <span class="n-pass">${f.passed}</span>${
              f.failed ? `<span class="n-fail">${f.failed} 失败</span>` : ''}${
              f.skipped ? `<span class="n-skip">${f.skipped} 跳过</span>` : ''}
            <span class="n-time">${ms(f.elapsedMs)}</span>
          </div>
        </header>
        ${what ? `<p class="what">${esc(what)}</p>` : ''}
        <div class="bar"><i style="width:${(f.elapsedMs / maxFileMs) * 100}%"></i></div>
        ${f.intro ? `<div class="intro">${rich(f.intro)}</div>` : ''}
        <table>${rows}</table>
      </section>`;
  }).join('');

  const index = byTime.map((f) => `<a href="#f-${esc(key(f))}" class="${f.failed ? 'x' : 'o'}">
      <span>${esc(key(f))}</span><b>${f.total}</b></a>`).join('');

  return `<title>CineRoute 用例全景</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap">
<style>
  :root{
    --bg:#f5f7fa; --panel:#fff; --sunk:#eef1f6;
    --ink:#131820; --dim:#5b6675; --faint:#8b95a3; --line:#e0e5ec;
    --pass:#1e7a4c; --fail:#c0342a; --skip:#8a6a1c; --accent:#2f6296;
    --sans:"IBM Plex Sans","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
    --mono:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,monospace;
  }
  @media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
    --bg:#0f1319; --panel:#161b23; --sunk:#1c222b;
    --ink:#e3e8ef; --dim:#8e99a8; --faint:#6b7686; --line:#242b35;
    --pass:#4fbf82; --fail:#f0726a; --skip:#cfa955; --accent:#74acdf;
  }}
  :root[data-theme="dark"]{
    --bg:#0f1319; --panel:#161b23; --sunk:#1c222b;
    --ink:#e3e8ef; --dim:#8e99a8; --faint:#6b7686; --line:#242b35;
    --pass:#4fbf82; --fail:#f0726a; --skip:#cfa955; --accent:#74acdf;
  }
  *{box-sizing:border-box}
  body{background:var(--bg);color:var(--ink);font-family:var(--sans);
    font-size:14px;line-height:1.62;margin:0;padding:40px 20px 96px}
  .wrap{max-width:1060px;margin:0 auto}
  h1{font-size:27px;font-weight:600;letter-spacing:-.015em;margin:0 0 5px;text-wrap:balance}
  .meta{color:var(--dim);font-size:12.5px;margin:0 0 30px;font-family:var(--mono)}

  /* 总览：一条带，不是六张卡 —— 341/341 是这页的主角 */
  .band{background:var(--panel);border:1px solid var(--line);border-radius:12px;
    padding:22px 26px;margin:0 0 14px}
  .head{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap}
  .score{font-family:var(--mono);font-size:40px;font-weight:600;line-height:1;
    letter-spacing:-.02em;font-variant-numeric:tabular-nums}
  .score .sep{color:var(--faint);font-weight:400}
  .verdict{font-size:13px;font-weight:600;color:var(--pass);
    border:1px solid currentColor;border-radius:999px;padding:3px 12px}
  .verdict.bad{color:var(--fail)}
  .track{height:6px;background:var(--sunk);border-radius:3px;overflow:hidden;margin:16px 0 14px}
  .track i{display:block;height:100%;background:var(--pass);border-radius:3px}
  .facts{display:flex;flex-wrap:wrap;gap:0 30px;color:var(--dim);font-size:12.5px}
  .facts b{color:var(--ink);font-weight:600;font-family:var(--mono);
    font-variant-numeric:tabular-nums}

  /* 最慢的用例：这套里"慢"集中在模糊测试和真浏览器，值得单独点出来 */
  .slow{background:var(--panel);border:1px solid var(--line);border-radius:12px;
    padding:18px 26px 20px;margin:0 0 14px}
  .cap{font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;
    color:var(--faint);margin:0 0 12px}
  .slow ol{list-style:none;margin:0;padding:0;display:grid;gap:5px}
  .slow li{display:grid;grid-template-columns:1fr auto;gap:14px;align-items:baseline;
    font-size:12.5px;border-bottom:1px dotted var(--line);padding-bottom:5px}
  .slow li:last-child{border-bottom:0}
  .slow .f{font-family:var(--mono);color:var(--accent);font-size:11.5px}
  .slow .d{font-family:var(--mono);color:var(--dim);font-variant-numeric:tabular-nums}

  /* 操作条 */
  .ops{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:26px 0 12px;
    position:sticky;top:0;background:var(--bg);padding:10px 0;z-index:5}
  #q{flex:1;min-width:190px;background:var(--panel);border:1px solid var(--line);
    border-radius:8px;padding:8px 12px;color:var(--ink);font-family:var(--sans);font-size:13px}
  #q::placeholder{color:var(--faint)}
  .chip{background:var(--panel);border:1px solid var(--line);border-radius:8px;
    padding:8px 14px;font-size:12.5px;color:var(--dim);cursor:pointer;font-family:var(--sans)}
  .chip[aria-pressed="true"]{border-color:var(--accent);color:var(--accent);font-weight:600}
  #q:focus-visible,.chip:focus-visible,a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}

  .index{display:grid;grid-template-columns:repeat(auto-fill,minmax(178px,1fr));
    gap:5px;margin:0 0 34px}
  .index a{display:flex;justify-content:space-between;gap:8px;align-items:baseline;
    background:var(--panel);border:1px solid var(--line);border-radius:7px;
    padding:6px 11px;text-decoration:none;color:var(--ink);
    font-family:var(--mono);font-size:11.5px}
  .index a b{color:var(--faint);font-weight:400;font-variant-numeric:tabular-nums}
  .index a.x{border-color:var(--fail)}
  .index a:hover{border-color:var(--accent);color:var(--accent)}

  .file{background:var(--panel);border:1px solid var(--line);border-radius:12px;
    margin:0 0 16px;overflow:hidden}
  .fh{display:flex;justify-content:space-between;align-items:center;gap:12px;
    flex-wrap:wrap;padding:14px 20px 10px}
  .fh-l{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
  .fh h2{font-family:var(--mono);font-size:13.5px;font-weight:600;margin:0}
  .role{font-size:10.5px;letter-spacing:.06em;color:var(--accent);
    border:1px solid var(--line);border-radius:999px;padding:2px 9px}
  .fh-r{display:flex;gap:12px;font-size:12px;font-family:var(--mono);
    font-variant-numeric:tabular-nums}
  .n-pass{color:var(--pass)} .n-fail{color:var(--fail);font-weight:600}
  .n-skip{color:var(--skip)} .n-time{color:var(--faint)}
  .what{margin:0;padding:0 20px 10px;color:var(--dim);font-size:12.5px}
  .bar{height:2px;background:var(--sunk)}
  .bar i{display:block;height:100%;background:var(--accent);opacity:.55}
  .intro{padding:14px 20px;background:var(--sunk);color:var(--dim);
    font-size:12.5px;line-height:1.72;white-space:pre-wrap;overflow-x:auto}
  .intro code{color:var(--accent);font-family:var(--mono);font-size:.92em}
  .intro b{color:var(--ink);font-weight:600}

  table{width:100%;border-collapse:collapse}
  tr.case{border-top:1px solid var(--line)}
  tr.case[data-st="failed"]{background:color-mix(in srgb,var(--fail) 9%,transparent)}
  td{padding:7px 10px;vertical-align:top}
  td.st{width:24px;padding-left:20px}
  .dot{display:inline-block;width:6px;height:6px;border-radius:50%;margin-top:8px}
  .dot.passed{background:var(--pass)} .dot.failed{background:var(--fail)}
  .dot.skipped{background:var(--skip)}
  td.nm{font-size:13px}
  td.ms{width:74px;text-align:right;color:var(--faint);font-size:11.5px;
    font-family:var(--mono);font-variant-numeric:tabular-nums;padding-right:20px;white-space:nowrap}
  .why{color:var(--skip);font-size:12px;margin-left:8px;font-style:normal}
  .detail{margin:8px 0 2px;padding:11px 13px;background:var(--sunk);border-radius:7px;
    border-left:2px solid var(--fail);font-family:var(--mono);font-size:11.5px;
    line-height:1.6;white-space:pre-wrap;overflow-x:auto;color:var(--fail)}
  code{font-family:var(--mono)}
  .hide{display:none}
  footer{color:var(--dim);font-size:12px;margin-top:34px;border-top:1px solid var(--line);
    padding-top:16px;line-height:1.75}
  footer code{color:var(--accent);font-size:.92em}
  @media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
</style>

<div class="wrap">
  <h1>CineRoute 用例全景</h1>
  <p class="meta">${esc(generatedAt)} · Node ${esc(nodeVersion)} · 全程离线，不连外网</p>

  <div class="band">
    <div class="head">
      <div class="score">${summary.passed}<span class="sep">/</span>${summary.total}</div>
      <span class="verdict${summary.failed ? ' bad' : ''}">${summary.failed ? `${summary.failed} 条失败` : '全部通过'}</span>
    </div>
    <div class="track"><i style="width:${pct.toFixed(2)}%"></i></div>
    <div class="facts">
      <span>测试文件 <b>${files.length}</b></span>
      <span>跳过 <b>${summary.skipped}</b></span>
      <span>墙钟耗时 <b>${(summary.wallMs / 1000).toFixed(1)}s</b></span>
      <span>累计用例耗时 <b>${(files.reduce((n, f) => n + f.elapsedMs, 0) / 1000).toFixed(1)}s</b></span>
    </div>
  </div>

  <div class="slow">
    <p class="cap">耗时最长的 8 条</p>
    <ol>${slowest.map((t) => `<li><span>${esc(t.name)} <span class="f">${esc(t.file)}</span></span><span class="d">${ms(t.durationMs)}</span></li>`).join('')}</ol>
  </div>

  <div class="ops">
    <input id="q" type="search" placeholder="按用例名或文件名筛选…" autocomplete="off">
    <button class="chip" data-f="all" aria-pressed="true">全部</button>
    <button class="chip" data-f="failed" aria-pressed="false">只看失败</button>
    <button class="chip" data-f="skipped" aria-pressed="false">只看跳过</button>
  </div>

  <div class="index">${index}</div>
  ${sections}

  <footer>
    逐文件跑 <code>node --test --test-reporter=tap</code> 再聚合而成 ——
    <code>node --test</code> 一次跑全部会把用例拍平成一串 <code>ok 1..N</code>，不带文件归属，
    junit reporter 的 classname 也只是目录名。<br>
    每个小节的灰底段落是该测试文件顶部的原始注释，讲的是这一层在守什么线。<br>
    重跑：<code>node tools/test-report.mjs</code>　只改版式不重跑：<code>node tools/test-report.mjs --from test-report.json</code>
  </footer>
</div>

<script>
  const q = document.getElementById('q');
  const chips = [...document.querySelectorAll('.chip')];
  let mode = 'all';
  function apply() {
    const term = q.value.trim().toLowerCase();
    for (const sec of document.querySelectorAll('.file')) {
      const hay = sec.dataset.name.toLowerCase();
      let shown = 0;
      for (const row of sec.querySelectorAll('tr.case')) {
        const okMode = mode === 'all' || row.dataset.st === mode;
        const text = (row.querySelector('.nm').textContent + ' ' + hay).toLowerCase();
        const okTerm = !term || text.includes(term);
        const show = okMode && okTerm;
        row.classList.toggle('hide', !show);
        if (show) shown += 1;
      }
      sec.classList.toggle('hide', shown === 0);
    }
  }
  q.addEventListener('input', apply);
  for (const c of chips) {
    c.addEventListener('click', () => {
      mode = c.dataset.f;
      for (const o of chips) o.setAttribute('aria-pressed', String(o === c));
      apply();
    });
  }
</script>`;
}

/* ── 主流程 ──────────────────────────────────────────────── */

if (FROM) {
  const prev = JSON.parse(await readFile(path.resolve(ROOT, FROM), 'utf8'));
  await writeFile(OUT, buildHtml(prev), 'utf8');
  process.stderr.write(`只重建版式，用例数据来自 ${FROM}\n报告：${OUT}\n`);
  process.exit(0);
}

const entries = (await readdir(path.join(ROOT, 'test')))
  .filter((f) => f.endsWith('.test.js'))
  .sort()
  .map((f) => `test/${f}`);

process.stderr.write(`跑 ${entries.length} 个测试文件（并发 ${JOBS}）…\n`);
const wallStart = Date.now();
const raw = await pool(entries, async (file) => {
  const r = await runFile(file);
  const { tests, totals } = parseTap(r.out);
  process.stderr.write(`  ${totals.fail ? '✗' : '✓'} ${file}  ${tests.length} 条\n`);
  return {
    file,
    elapsedMs: r.elapsedMs,
    exitCode: r.code,
    stderr: r.err.trim(),
    intro: await fileIntro(file),
    tests,
    total: tests.length,
    passed: tests.filter((t) => t.status === 'passed').length,
    failed: tests.filter((t) => t.status === 'failed').length,
    skipped: tests.filter((t) => t.status === 'skipped').length,
  };
}, JOBS);

const summary = {
  total: raw.reduce((n, f) => n + f.total, 0),
  passed: raw.reduce((n, f) => n + f.passed, 0),
  failed: raw.reduce((n, f) => n + f.failed, 0),
  skipped: raw.reduce((n, f) => n + f.skipped, 0),
  wallMs: Date.now() - wallStart,
};

const report = {
  generatedAt: new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC',
  nodeVersion: process.version,
  summary,
  files: raw,
};

await writeFile(OUT, buildHtml(report), 'utf8');
await writeFile(OUT.replace(/\.html$/, '.json'), JSON.stringify(report, null, 2), 'utf8');

process.stderr.write(`\n用例 ${summary.total} · 通过 ${summary.passed} · 失败 ${summary.failed}`
  + ` · 跳过 ${summary.skipped} · 耗时 ${(summary.wallMs / 1000).toFixed(1)}s\n报告：${OUT}\n`);
process.exitCode = summary.failed > 0 ? 1 : 0;
