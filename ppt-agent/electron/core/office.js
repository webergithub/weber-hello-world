'use strict';
// 外部引擎集成（均为可选）：PowerPoint COM（Windows）/ LibreOffice 生成页面截图、把旧版 .ppt 转为 .pptx；ffmpeg 仅提取字幕流。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const procs = require('./procs');
const { parseSubtitleText } = require('./subtitles');

const isWin = process.platform === 'win32';

const MAX_OUT = 32 * 1024 * 1024;

/**
 * 运行外部程序：登记到 procs（程序退出时结束），超时结束整个进程树（不只是直接子进程）。
 * onLine：逐行读取标准输出（用于 Office 自动化脚本报告 PID）。返回 { ok, code, stdout, stderr, error, timedOut }。
 */
function run(cmd, args, { timeout = 180000, env, input, name, onLine } = {}) {
  return new Promise((resolve) => {
    let p;
    try {
      p = spawn(cmd, args, { windowsHide: true, detached: !isWin, env: { ...process.env, ...(env || {}) } });
    } catch (e) { resolve({ ok: false, code: null, stdout: '', stderr: '', error: e }); return; }
    procs.track(p, name || path.basename(cmd));
    const out = [], err = [];
    let outLen = 0, errLen = 0, buf = '', done = false, timedOut = false;
    p.stdout.on('data', (d) => {
      if (outLen < MAX_OUT) { out.push(d); outLen += d.length; }
      if (onLine) {
        buf += d.toString('utf8');
        let i;
        while ((i = buf.indexOf('\n')) >= 0) { try { onLine(buf.slice(0, i).replace(/\r$/, '')); } catch { /* ignore */ } buf = buf.slice(i + 1); }
      }
    });
    p.stderr.on('data', (d) => { if (errLen < 1024 * 1024) { err.push(d); errLen += d.length; } });
    const timer = timeout ? setTimeout(() => { timedOut = true; procs.killTree(p.pid); }, timeout) : null;
    const finish = (code, e) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      if (onLine && buf) { try { onLine(buf.replace(/\r$/, '')); } catch { /* ignore */ } }
      const error = e || (timedOut ? Object.assign(new Error(`运行超时（${Math.round(timeout / 1000)} 秒）`), { code: 'ETIMEDOUT' }) : code !== 0 ? Object.assign(new Error(`退出码 ${code}`), { code }) : null);
      resolve({ ok: !error, code: error ? (error.code ?? code) : 0, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), error, timedOut });
    };
    p.on('error', (e) => finish(null, e));
    p.on('close', (code) => finish(code));
    if (p.stdin) { p.stdin.on('error', () => {}); if (input) p.stdin.end(input); else p.stdin.end(); }
  });
}

function which(names, extra = []) {
  const dirs = (process.env.PATH || '').split(path.delimiter).concat(extra);
  for (const n of names) {
    if (path.isAbsolute(n) && fs.existsSync(n)) return n;
    for (const d of dirs) {
      if (!d) continue;
      for (const ext of isWin ? ['.exe', '.com', '.bat', ''] : ['']) {
        const p = path.join(d, n + ext);
        if (fs.existsSync(p)) return p;
      }
    }
  }
  return null;
}

/**
 * 运行 PowerShell 脚本。脚本输出的 PPTA_PID:<pid>:<启动时间> 是它新启动的 Word / PowerPoint 进程，
 * PPTA_DONE 表示脚本已确认这些进程退出；没有 PPTA_DONE（超时、出错被结束）时按 PID + 启动时间结束它们。
 */
async function ps(script, env, timeout = 600000, runner = run) {
  const mine = [];
  let closed = false;
  const r = await runner('powershell.exe', procs.psArgs(script), {
    env, timeout, name: 'powershell',
    onLine: (l) => {
      const m = l.match(/^PPTA_PID:(\d+):(\d+):?(\w*)$/);
      if (m) { const o = { pid: Number(m[1]), start: m[2], image: m[3] }; mine.push(o); procs.addOffice(o); }
      else if (l.trim() === 'PPTA_DONE') closed = true;
    },
  });
  if (mine.length) {
    if (closed) procs.doneOffice(mine);
    else await procs.reapOffice(mine, r.timedOut ? '自动化超时' : '自动化未正常结束');
  }
  return r;
}

/**
 * Office COM 自动化脚本：只关闭自己启动的实例。
 * - 记录 New-Object 前后的进程，新出现的（命令行带 /Automation 或 -Embedding）就是本次启动的，报告 PID 给主进程；
 * - 关闭提示框（DisplayAlerts）、禁用宏（AutomationSecurity = 3）、只读打开；
 * - 结束时：是本次启动的实例，或是没有窗口、没有打开文档的后台实例，就 Quit；释放 COM 对象；
 *   等待本次启动的进程退出，8 秒内没有退出就强制结束；最后输出 PPTA_DONE。
 * 用户自己打开的 Word / PowerPoint（有窗口或打开着文档）不会被关闭。
 */
function comScript({ image, progId, setup, body, cleanup, idle }) {
  return `$img='${image}'
$before=@(Get-Process $img -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
$app=New-Object -ComObject ${progId}
$mine=@(Get-Process $img -ErrorAction SilentlyContinue | Where-Object { $before -notcontains $_.Id } | Where-Object {
  $c=$null; try { $c=(Get-CimInstance Win32_Process -Filter ("ProcessId="+$_.Id) -ErrorAction Stop).CommandLine } catch { }
  (-not $c) -or ("$c" -match '(?i)automation|embedding') })
foreach($x in $mine){ [Console]::Out.WriteLine("PPTA_PID:"+$x.Id+":"+$x.StartTime.ToFileTimeUtc()+":"+$img); [Console]::Out.Flush() }
$doc=$null
try {
${setup}
${body}
} finally {
  try { ${cleanup} } catch { }
  $quit=$mine.Count -gt 0
  if(-not $quit){ try { $quit=(${idle}) } catch { } }
  if($quit){ try { $app.Quit() } catch { } }
  foreach($o in @($doc,$app)){ if($o){ try { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($o) } catch { } } }
  $doc=$null; $app=$null
  [GC]::Collect(); [GC]::WaitForPendingFinalizers(); [GC]::Collect()
  foreach($x in $mine){ try { if(-not $x.WaitForExit(8000)){ $x.Kill() } } catch { } }
  [Console]::Out.WriteLine("PPTA_DONE"); [Console]::Out.Flush()
}
"OK"`;
}

const PPT = {
  image: 'POWERPNT', progId: 'PowerPoint.Application',
  setup: `try { $app.DisplayAlerts=1 } catch { }
try { $app.AutomationSecurity=3 } catch { }`,
  cleanup: 'if($doc){ $doc.Saved=-1; $doc.Close() }',
  idle: '$app.Presentations.Count -eq 0 -and $app.Visible -eq 0',
};
const WORD = {
  image: 'WINWORD', progId: 'Word.Application',
  setup: `$app.Visible=$false
try { $app.DisplayAlerts=0 } catch { }
try { $app.AutomationSecurity=3 } catch { }`,
  cleanup: 'if($doc){ $doc.Close(0) }',
  idle: '$app.Documents.Count -eq 0 -and -not $app.Visible',
};

/** LibreOffice 命令行参数：独立的临时用户配置（不与用户正在使用的 LibreOffice 共用进程，超时可整个结束） */
function sofficeArgs(profileDir) {
  const profile = 'file:///' + profileDir.replace(/\\/g, '/').replace(/^\//, '');
  return [`-env:UserInstallation=${profile}`, '--headless', '--norestore', '--nologo', '--nodefault', '--nolockcheck'];
}

const rmTmp = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* ignore */ } };

class Office {
  constructor(log) {
    this.log = log;
    this.detected = null;
    this.chain = Promise.resolve();
  }

  /**
   * 逐个执行：PowerPoint / Word 自动化与 LibreOffice 不能同时被多个子任务调用
   * （一个调用结束时可能关闭另一个正在使用的 PowerPoint），并行解析时这些步骤排队执行。
   */
  serial(fn) {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => {});
    return run;
  }

  /** LibreOffice 转换（临时用户配置，用完删除） */
  async soffice(d, args, timeout) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ppta-lo-'));
    try { return await run(d.soffice, [...sofficeArgs(path.join(tmp, 'profile')), ...args], { timeout, name: 'LibreOffice' }); } finally { rmTmp(tmp); }
  }

  async detect(force = false) {
    if (this.detected && !force) return this.detected;
    const d = { powerpoint: false, soffice: null, pdftoppm: null, ffmpeg: null, platform: process.platform, procsCheck: procs.procsCheckable() };
    const pf = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean).map((p) => path.join(p, 'LibreOffice', 'program'));
    d.soffice = which(['soffice', 'libreoffice'], [...pf, '/usr/bin', '/usr/local/bin', '/Applications/LibreOffice.app/Contents/MacOS']);
    d.pdftoppm = which(['pdftoppm']);
    d.ffmpeg = which(['ffmpeg']);
    if (isWin) {
      const r = await ps('$t=[Type]::GetTypeFromProgID("PowerPoint.Application"); if($t){"YES"}else{"NO"}', {}, 30000);
      d.powerpoint = r.ok && r.stdout.includes('YES');
    }
    this.detected = d;
    this.log.info(`外部引擎检测: PowerPoint=${d.powerpoint ? '可用' : '无'} LibreOffice=${d.soffice || '无'} pdftoppm=${d.pdftoppm || '无'} ffmpeg=${d.ffmpeg || '无'}`);
    return d;
  }

  /** 旧版 .ppt → .pptx，返回转换后的路径（缓存目录） */
  convertPpt(src, outDir) { return this.serial(() => this._convertPpt(src, outDir)); }

  async _convertPpt(src, outDir) {
    const d = await this.detect();
    fs.mkdirSync(outDir, { recursive: true });
    const dest = path.join(outDir, path.basename(src).replace(/\.(ppt|pps|pot)$/i, '') + '.pptx');
    if (fs.existsSync(dest) && fs.statSync(dest).mtimeMs >= fs.statSync(src).mtimeMs) return dest;
    if (d.powerpoint) {
      const r = await ps(comScript({ ...PPT, body: '$doc=$app.Presentations.Open($env:PPTA_SRC, -1, 0, 0); $doc.SaveAs($env:PPTA_DEST, 24)' }), { PPTA_SRC: src, PPTA_DEST: dest }, 300000);
      if (r.ok && fs.existsSync(dest)) return dest;
      this.log.warn(`PowerPoint 转换 .ppt 失败: ${src}`, r.stderr.slice(0, 500));
    }
    if (d.soffice) {
      const r = await this.soffice(d, ['--convert-to', 'pptx', '--outdir', outDir, src], 300000);
      if (fs.existsSync(dest)) return dest;
      this.log.warn(`LibreOffice 转换 .ppt 失败: ${src}`, r.stderr.slice(0, 500));
    }
    throw new Error('旧版 .ppt 需要安装 PowerPoint 或 LibreOffice 才能解析');
  }

  /** 旧版 .doc → .docx（Word COM 或 LibreOffice） */
  convertDoc(src, outDir) { return this.serial(() => this._convertDoc(src, outDir)); }

  async _convertDoc(src, outDir) {
    const d = await this.detect();
    fs.mkdirSync(outDir, { recursive: true });
    const dest = path.join(outDir, path.basename(src).replace(/\.(doc|dot)$/i, '') + '.docx');
    if (fs.existsSync(dest) && fs.statSync(dest).mtimeMs >= fs.statSync(src).mtimeMs) return dest;
    if (isWin) {
      // 只读打开；给一个假密码：加密文档直接报错，不会弹出密码框卡住 Word
      const r = await ps(comScript({ ...WORD, body: "$doc=$app.Documents.Open($env:PPTA_SRC, $false, $true, $false, 'ppta-nopass', 'ppta-nopass', $false, 'ppta-nopass', 'ppta-nopass'); $doc.SaveAs2($env:PPTA_DEST, 16)" }), { PPTA_SRC: src, PPTA_DEST: dest }, 300000);
      if (r.ok && fs.existsSync(dest)) return dest;
      this.log.warn(`Word 转换 .doc 失败: ${src}`, r.stderr.slice(0, 300));
    }
    if (d.soffice) {
      const r = await this.soffice(d, ['--convert-to', 'docx', '--outdir', outDir, src], 300000);
      if (fs.existsSync(dest)) return dest;
      this.log.warn(`LibreOffice 转换 .doc 失败: ${src}`, r.stderr.slice(0, 300));
    }
    throw new Error('旧版 .doc 需要安装 Word 或 LibreOffice 才能解析');
  }

  /**
   * 生成每页截图，返回 {engine, images:[相对路径...]} 或 {engine:'pdf', pdf}。
   * mode: 'auto' | 'powerpoint' | 'libreoffice' | 'off'
   */
  thumbnails(src, outDir, relBase, mode = 'auto', width = 1280) { return this.serial(() => this._thumbnails(src, outDir, relBase, mode, width)); }

  async _thumbnails(src, outDir, relBase, mode = 'auto', width = 1280) {
    if (mode === 'off') return null;
    const d = await this.detect();
    fs.mkdirSync(outDir, { recursive: true });
    // 清掉旧的截图，避免页数变少时残留旧页面
    for (const f of fs.readdirSync(outDir)) if (/^slide-\d+\.png$|^slides\.pdf$/i.test(f)) fs.rmSync(path.join(outDir, f), { force: true });
    const list = () => fs.readdirSync(outDir).filter((f) => /^slide-\d+\.png$/i.test(f))
      .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0])).map((f) => `${relBase}/${f}`);
    if ((mode === 'auto' || mode === 'powerpoint') && d.powerpoint) {
      const r = await ps(comScript({ ...PPT, body: `$doc=$app.Presentations.Open($env:PPTA_SRC, -1, 0, 0)
$w=[int]$env:PPTA_W; $h=[int]($w*$doc.PageSetup.SlideHeight/$doc.PageSetup.SlideWidth)
foreach($s in $doc.Slides){ $s.Export((Join-Path $env:PPTA_OUT ("slide-"+$s.SlideIndex+".png")), "PNG", $w, $h) }` }), { PPTA_SRC: src, PPTA_OUT: outDir, PPTA_W: String(width) });
      const imgs = list();
      if (r.ok && imgs.length) return { engine: 'powerpoint', images: imgs };
      this.log.warn(`PowerPoint 截图失败: ${src}`, r.stderr.slice(0, 500));
    }
    if ((mode === 'auto' || mode === 'libreoffice') && d.soffice) {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ppta-'));
      try {
        // 不复制原文件：同一磁盘用硬链接（不占空间），否则符号链接；都不行时才临时复制（转换完立即删除）
        const input = path.join(tmp, 'in' + path.extname(src));
        try { fs.linkSync(src, input); } catch { try { fs.symlinkSync(src, input); } catch { fs.copyFileSync(src, input); } }
        // 使用独立的用户配置目录，避免与正在运行的 LibreOffice 冲突
        const r = await run(d.soffice, [...sofficeArgs(path.join(tmp, 'profile')), '--convert-to', 'pdf', '--outdir', tmp, input], { timeout: 600000, name: 'LibreOffice' });
        const pdf = path.join(tmp, 'in.pdf');
        if (!fs.existsSync(pdf)) { this.log.warn(`LibreOffice 转 PDF 失败: ${src}`, r.stderr.slice(0, 300)); return null; }
        if (d.pdftoppm) {
          const scale = String(Math.round(width / 2));
          await run(d.pdftoppm, ['-png', '-scale-to', scale, pdf, path.join(outDir, 'slide')], { timeout: 600000, name: 'pdftoppm' });
          // pdftoppm 输出 slide-01.png 等，统一命名
          for (const f of fs.readdirSync(outDir)) {
            const m = f.match(/^slide-0*(\d+)\.png$/);
            if (m && f !== `slide-${m[1]}.png`) fs.renameSync(path.join(outDir, f), path.join(outDir, `slide-${m[1]}.png`));
          }
          const imgs = list();
          if (imgs.length) return { engine: 'libreoffice', images: imgs };
        }
        const dest = path.join(outDir, 'slides.pdf');
        fs.copyFileSync(pdf, dest);
        return { engine: 'pdf', pdf: `${relBase}/slides.pdf` };
      } finally { rmTmp(tmp); }
    }
    return null;
  }

  /** 用 ffmpeg 只提取字幕流（-map 0:s:0），不处理视频画面 */
  ffmpegExtractor(cacheDir) {
    return async (localFile, embedded) => {
      const d = await this.detect();
      if (!d.ffmpeg) return [];
      let file = localFile, tmp = null;
      if (!file && embedded) {
        const size = embedded.pkg.zip.size(embedded.part);
        if (size > 2 * 1024 * 1024 * 1024) return [];
        tmp = path.join(cacheDir, 'tmp-' + Date.now() + path.extname(embedded.part));
        fs.mkdirSync(cacheDir, { recursive: true });
        const rs = await embedded.pkg.zip.stream(embedded.part);
        await new Promise((res, rej) => rs.pipe(fs.createWriteStream(tmp)).on('finish', res).on('error', rej));
        file = tmp;
      }
      try {
        const r = await run(d.ffmpeg, ['-v', 'error', '-i', file, '-map', '0:s:0', '-f', 'srt', 'pipe:1'], { timeout: 120000, name: 'ffmpeg' });
        return r.ok ? parseSubtitleText(r.stdout, '.srt') : [];
      } finally { if (tmp) fs.rmSync(tmp, { force: true }); }
    };
  }
}

module.exports = { Office, which, run, ps, comScript, sofficeArgs };
