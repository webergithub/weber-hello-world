'use strict';
// 外部引擎集成（均为可选）：PowerPoint COM（Windows）/ LibreOffice 生成页面截图、把旧版 .ppt 转为 .pptx；ffmpeg 仅提取字幕流。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { parseSubtitleText } = require('./subtitles');

const isWin = process.platform === 'win32';

function run(cmd, args, { timeout = 180000, env, input } = {}) {
  return new Promise((resolve) => {
    const p = execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, ...(env || {}) } }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? err.code : 0, stdout: String(stdout || ''), stderr: String(stderr || ''), error: err });
    });
    if (input && p.stdin) { p.stdin.end(input); }
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

function ps(script, env, timeout = 600000) {
  const encoded = Buffer.from('$ErrorActionPreference="Stop"\n[Console]::OutputEncoding=[Text.Encoding]::UTF8\n' + script, 'utf16le').toString('base64');
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { env, timeout });
}

class Office {
  constructor(log) {
    this.log = log;
    this.detected = null;
  }

  async detect(force = false) {
    if (this.detected && !force) return this.detected;
    const d = { powerpoint: false, soffice: null, pdftoppm: null, ffmpeg: null, platform: process.platform };
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
  async convertPpt(src, outDir) {
    const d = await this.detect();
    fs.mkdirSync(outDir, { recursive: true });
    const dest = path.join(outDir, path.basename(src).replace(/\.(ppt|pps|pot)$/i, '') + '.pptx');
    if (fs.existsSync(dest) && fs.statSync(dest).mtimeMs >= fs.statSync(src).mtimeMs) return dest;
    if (d.powerpoint) {
      const r = await ps(`$was=Get-Process POWERPNT -ErrorAction SilentlyContinue
$app=New-Object -ComObject PowerPoint.Application
try { $p=$app.Presentations.Open($env:PPTA_SRC, -1, 0, 0); $p.SaveAs($env:PPTA_DEST, 24); $p.Close() } finally { if(-not $was){ $app.Quit() } }
"OK"`, { PPTA_SRC: src, PPTA_DEST: dest });
      if (r.ok && fs.existsSync(dest)) return dest;
      this.log.warn(`PowerPoint 转换 .ppt 失败: ${src}`, r.stderr.slice(0, 500));
    }
    if (d.soffice) {
      const r = await run(d.soffice, ['--headless', '--norestore', '--convert-to', 'pptx', '--outdir', outDir, src], { timeout: 300000 });
      if (fs.existsSync(dest)) return dest;
      this.log.warn(`LibreOffice 转换 .ppt 失败: ${src}`, r.stderr.slice(0, 500));
    }
    throw new Error('旧版 .ppt 需要安装 PowerPoint 或 LibreOffice 才能解析');
  }

  /**
   * 生成每页截图，返回 {engine, images:[相对路径...]} 或 {engine:'pdf', pdf}。
   * mode: 'auto' | 'powerpoint' | 'libreoffice' | 'off'
   */
  async thumbnails(src, outDir, relBase, mode = 'auto', width = 1280) {
    if (mode === 'off') return null;
    const d = await this.detect();
    fs.mkdirSync(outDir, { recursive: true });
    const list = () => fs.readdirSync(outDir).filter((f) => /^slide-\d+\.png$/i.test(f))
      .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0])).map((f) => `${relBase}/${f}`);
    if ((mode === 'auto' || mode === 'powerpoint') && d.powerpoint) {
      const r = await ps(`$was=Get-Process POWERPNT -ErrorAction SilentlyContinue
$app=New-Object -ComObject PowerPoint.Application
try {
  $p=$app.Presentations.Open($env:PPTA_SRC, -1, 0, 0)
  $w=[int]$env:PPTA_W; $h=[int]($w*$p.PageSetup.SlideHeight/$p.PageSetup.SlideWidth)
  foreach($s in $p.Slides){ $s.Export((Join-Path $env:PPTA_OUT ("slide-"+$s.SlideIndex+".png")), "PNG", $w, $h) }
  $p.Close()
} finally { if(-not $was){ $app.Quit() } }
"OK"`, { PPTA_SRC: src, PPTA_OUT: outDir, PPTA_W: String(width) });
      const imgs = list();
      if (r.ok && imgs.length) return { engine: 'powerpoint', images: imgs };
      this.log.warn(`PowerPoint 截图失败: ${src}`, r.stderr.slice(0, 500));
    }
    if ((mode === 'auto' || mode === 'libreoffice') && d.soffice) {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ppta-'));
      try {
        // 使用独立的用户配置目录，避免与正在运行的 LibreOffice 冲突
        const profile = 'file:///' + path.join(tmp, 'profile').replace(/\\/g, '/').replace(/^\//, '');
        const input = path.join(tmp, 'in' + path.extname(src));
        fs.copyFileSync(src, input);
        const r = await run(d.soffice, [`-env:UserInstallation=${profile}`, '--headless', '--norestore', '--convert-to', 'pdf', '--outdir', tmp, input], { timeout: 600000 });
        const pdf = path.join(tmp, 'in.pdf');
        if (!fs.existsSync(pdf)) { this.log.warn(`LibreOffice 转 PDF 失败: ${src}`, r.stderr.slice(0, 300)); return null; }
        if (d.pdftoppm) {
          const scale = String(Math.round(width / 2));
          await run(d.pdftoppm, ['-png', '-scale-to', scale, pdf, path.join(outDir, 'slide')], { timeout: 600000 });
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
      } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
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
        const r = await run(d.ffmpeg, ['-v', 'error', '-i', file, '-map', '0:s:0', '-f', 'srt', 'pipe:1'], { timeout: 120000 });
        return r.ok ? parseSubtitleText(r.stdout, '.srt') : [];
      } finally { if (tmp) fs.rmSync(tmp, { force: true }); }
    };
  }
}

module.exports = { Office, which, run };
