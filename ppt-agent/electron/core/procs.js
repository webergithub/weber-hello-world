'use strict';
// 外部进程登记（v3.10.1）：程序启动的所有外部进程（PowerShell、LibreOffice、pdftoppm、ffmpeg、AI 调用脚本）都在这里登记，
// 超时 / 暂停时结束整个进程树（Windows 用 taskkill /T，其他系统结束进程组），程序退出时全部结束。
// Word / PowerPoint 是 COM 自动化启动的独立进程（父进程不是 PowerShell，结束 PowerShell 不会带走它们）：
// 自动化脚本把自己新启动的 Office 进程 PID 与启动时间报给这里（PPTA_PID:<pid>:<启动时间>），
// 脚本没能正常收尾（超时、出错、程序退出）时按 PID + 启动时间核对后结束，并记到文件里，程序异常退出后下次启动再清理。
// 核对启动时间可避免 PID 被系统复用后误结束别的程序；从不结束用户自己打开的 Word / PowerPoint。
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');

const isWin = process.platform === 'win32';
const children = new Map(); // pid -> { name, at }
const office = new Map(); // `${pid}:${start}` -> { pid, start, image, at }
let stateFile = null;
let log = null;
let psRunner = null; // 测试用：替换执行 PowerShell 的函数 (script, { sync }) => ...

function configure({ file, logger } = {}) {
  if (file !== undefined) stateFile = file;
  if (logger !== undefined) log = logger;
}

function psArgs(script) {
  const encoded = Buffer.from('$ErrorActionPreference="Stop"\n[Console]::OutputEncoding=[Text.Encoding]::UTF8\n' + script, 'utf16le').toString('base64');
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded];
}

/** 登记子进程；进程结束后自动移除 */
function track(child, name) {
  if (!child || !child.pid) return;
  const pid = child.pid;
  children.set(pid, { name: name || 'process', at: Date.now() });
  child.once('exit', () => children.delete(pid));
  child.once('error', () => children.delete(pid));
}

/** 结束进程及其子进程（异步，不等待） */
function killTree(pid) {
  if (!pid) return;
  if (isWin) {
    try { spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {}); } catch { /* ignore */ }
  } else {
    try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ } }
  }
}

function killTreeSync(pid) {
  if (!pid) return;
  if (isWin) { try { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 5000 }); } catch { /* ignore */ } }
  else killTree(pid);
}

// ---------- Word / PowerPoint（COM 自动化启动的进程） ----------
const key = (o) => `${o.pid}:${o.start}`;
const valid = (o) => o && /^\d{1,10}$/.test(String(o.pid)) && /^\d{1,20}$/.test(String(o.start));

function save() {
  if (!stateFile) return;
  try {
    if (office.size) fs.writeFileSync(stateFile, JSON.stringify([...office.values()], null, 1), 'utf8');
    else if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile);
  } catch { /* ignore */ }
}

function addOffice(o) {
  if (!valid(o)) return;
  office.set(key(o), { pid: Number(o.pid), start: String(o.start), image: o.image || '', at: Date.now() });
  save();
}

function doneOffice(list) {
  for (const o of list || []) office.delete(key(o));
  save();
}

/** 结束指定的 Office 进程：只结束 PID 与启动时间都一致的进程 */
function reapScript(list) {
  return list.filter(valid).map((o) => `Get-Process -Id ${Number(o.pid)} -ErrorAction SilentlyContinue | Where-Object { $_.StartTime.ToFileTimeUtc() -eq ${String(o.start)} } | ForEach-Object { "KILLED:"+$_.Id; Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }`).join('\n');
}

function runPs(script, { sync = false, timeout = 30000 } = {}) {
  if (psRunner) return psRunner(script, { sync });
  if (!isWin) return sync ? '' : Promise.resolve('');
  if (sync) {
    try { return String(spawnSync('powershell.exe', psArgs(script), { windowsHide: true, timeout, encoding: 'utf8' }).stdout || ''); } catch { return ''; }
  }
  return new Promise((resolve) => {
    let out = '';
    let p;
    try { p = spawn('powershell.exe', psArgs(script), { windowsHide: true }); } catch { resolve(''); return; }
    track(p, 'powershell');
    const timer = setTimeout(() => killTree(p.pid), timeout);
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', () => { clearTimeout(timer); resolve(out); });
    p.on('close', () => { clearTimeout(timer); resolve(out); });
  });
}

const killedCount = (out) => (String(out || '').match(/KILLED:\d+/g) || []).length;

async function reapOffice(list, why = '') {
  const l = (list || []).filter(valid);
  if (!l.length) return 0;
  const n = killedCount(await runPs(reapScript(l)));
  doneOffice(l);
  if (n && log) log.warn(`结束未关闭的 Office 后台进程 ${n} 个${why ? `（${why}）` : ''}`);
  return n;
}

function reapOfficeSync(list, why = '') {
  const l = (list || []).filter(valid);
  if (!l.length) return 0;
  const n = killedCount(runPs(reapScript(l), { sync: true }));
  doneOffice(l);
  if (n && log) log.warn(`结束未关闭的 Office 后台进程 ${n} 个${why ? `（${why}）` : ''}`);
  return n;
}

/** 程序退出：结束全部登记的外部进程与 Office 后台进程（同步执行） */
let quitDone = false;
function killAll(why = '程序退出') {
  if (quitDone) return { children: 0, office: 0 };
  quitDone = true;
  const kids = [...children.keys()];
  for (const pid of kids) killTreeSync(pid);
  children.clear();
  const n = reapOfficeSync([...office.values()], why);
  if ((kids.length || n) && log) log.info(`${why}：结束外部进程 ${kids.length} 个、Office 后台进程 ${n} 个`);
  return { children: kids.length, office: n };
}

/** 启动时清理上次异常退出留下的 Office 进程（记录在 stateFile 中） */
async function cleanupStale() {
  if (!stateFile || !fs.existsSync(stateFile)) return 0;
  let list = [];
  try { list = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { /* ignore */ }
  try { fs.unlinkSync(stateFile); } catch { /* ignore */ }
  return reapOffice(Array.isArray(list) ? list : [], '上次退出时未关闭');
}

/**
 * 查找后台运行的 Word / PowerPoint 自动化进程（没有窗口、命令行带 /Automation 或 -Embedding），
 * 例如旧版本或其他程序遗留的进程。返回 [{ pid, image, start, memMB, ours }]。
 */
async function findOrphans() {
  if (!isWin && !psRunner) return [];
  const out = await runPs(`$list=$null
try { $list=Get-CimInstance Win32_Process -Filter "Name='WINWORD.EXE' OR Name='POWERPNT.EXE'" } catch { $list=Get-WmiObject Win32_Process -Filter "Name='WINWORD.EXE' OR Name='POWERPNT.EXE'" }
foreach($w in @($list)){ if(-not $w){ continue }
  $p=Get-Process -Id $w.ProcessId -ErrorAction SilentlyContinue
  if($p -and $p.MainWindowHandle -eq 0 -and "$($w.CommandLine)" -match '(?i)[/-](automation|embedding)'){
    "ORPHAN|"+$p.Id+"|"+$w.Name+"|"+$p.StartTime.ToFileTimeUtc()+"|"+[int]($p.WorkingSet64/1MB) } }`);
  return String(out || '').split(/\r?\n/).map((l) => l.match(/^ORPHAN\|(\d+)\|([^|]+)\|(\d+)\|(\d+)/)).filter(Boolean)
    .map((m) => ({ pid: Number(m[1]), image: m[2], start: m[3], memMB: Number(m[4]), ours: office.has(`${m[1]}:${m[3]}`) }));
}

async function killOrphans(list) {
  const l = (list || []).filter(valid);
  if (!l.length) return 0;
  const n = killedCount(await runPs(reapScript(l)));
  doneOffice(l);
  if (log) log.info(`手动结束后台 Word / PowerPoint 进程 ${n} 个`);
  return n;
}

function state() {
  return { children: [...children.entries()].map(([pid, c]) => ({ pid, ...c })), office: [...office.values()] };
}

// 端到端测试用（PPTA_FAKE_OFFICE_PROCS=1）：模拟两个遗留的后台进程，结束后不再列出
if (process.env.PPTA_FAKE_OFFICE_PROCS === '1') {
  const alive = new Map([[4321, 'WINWORD.EXE|133500000000000000|210'], [4322, 'POWERPNT.EXE|133500000100000000|180']]);
  psRunner = (script, { sync } = {}) => {
    let out = '';
    if (script.includes('ORPHAN|')) out = [...alive].map(([pid, v]) => { const [img, st, mb] = v.split('|'); return `ORPHAN|${pid}|${img}|${st}|${mb}`; }).join('\n');
    else for (const m of script.matchAll(/Get-Process -Id (\d+)/g)) if (alive.delete(Number(m[1]))) out += `KILLED:${m[1]}\n`;
    return sync ? out : Promise.resolve(out);
  };
}

function procsCheckable() { return isWin || !!psRunner; }

function _reset({ runner } = {}) { children.clear(); office.clear(); quitDone = false; psRunner = runner || null; }

module.exports = { procsCheckable, configure, psArgs, track, killTree, killTreeSync, addOffice, doneOffice, reapOffice, reapOfficeSync, reapScript, killAll, cleanupStale, findOrphans, killOrphans, state, _reset };
