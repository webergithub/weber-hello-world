// Electron 主进程：
//  1) 拉起已测好的 Python 后端 (serve.py)，从它的输出里解析出本机 URL
//  2) 在窗口里加载那个 URL（复用同一套网页界面）
//  3) 提供 macOS/Windows 原生「选择文件」对话框（拿到真实绝对路径，无需上传）
//  4) 退出时清理 Python 子进程
'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const fs = require('fs');

let pyProc = null;
let win = null;
let serverUrl = null;

// ---------------------------------------------------------------- 后端定位
function backendDir() {
  // 开发：electron/.. 就是 rar-recovery/；打包后：resources/backend
  return app.isPackaged
    ? path.join(process.resourcesPath, 'backend')
    : path.join(__dirname, '..');
}

function pythonCandidates() {
  const list = [];
  if (process.env.RAR_RECOVERY_PYTHON) list.push(process.env.RAR_RECOVERY_PYTHON);
  if (process.platform === 'win32') list.push('python', 'py', 'python3');
  else list.push('python3', 'python');
  return list;
}

// ---------------------------------------------------------------- 启动后端
function startBackend() {
  return new Promise((resolve, reject) => {
    const cwd = backendDir();
    const serve = path.join(cwd, 'serve.py');
    if (!fs.existsSync(serve)) {
      return reject(new Error('找不到后端 serve.py：' + serve));
    }

    const candidates = pythonCandidates();
    let idx = 0;

    const tryNext = () => {
      if (idx >= candidates.length) {
        return reject(new Error(
          '未找到可用的 Python 3。请先安装 Python 3（macOS 可用 brew install python），\n' +
          '或设置环境变量 RAR_RECOVERY_PYTHON 指向你的 python 可执行文件。'));
      }
      const py = candidates[idx++];
      // -u 关闭输出缓冲，确保能实时读到后端打印的 URL
      const proc = spawn(py, ['-u', 'serve.py', '--no-browser', '--port', '0'], {
        cwd,
        env: { ...process.env, PYTHONUNBUFFERED: '1' },
      });

      let settled = false;
      let buf = '';
      const onData = (chunk) => {
        buf += chunk.toString();
        const m = buf.match(/http:\/\/127\.0\.0\.1:(\d+)/);
        if (m && !settled) {
          settled = true;
          pyProc = proc;
          serverUrl = m[0];
          resolve(serverUrl);
        }
      };
      proc.stdout.on('data', onData);
      proc.stderr.on('data', (d) => { process.stderr.write('[py] ' + d); onData(d); });

      proc.on('error', () => { if (!settled) { settled = true; tryNext(); } });
      proc.on('exit', (code) => {
        if (!settled) { settled = true; tryNext(); }
        else if (proc === pyProc) { pyProc = null; }
      });

      // 单个候选 6 秒没起来就换下一个
      setTimeout(() => {
        if (!settled) { settled = true; try { proc.kill(); } catch (_) {} tryNext(); }
      }, 6000);
    };

    tryNext();
  });
}

function waitForHttp(url, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const ping = () => {
      const req = http.get(url, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        if (Date.now() > deadline) reject(new Error('后端启动超时'));
        else setTimeout(ping, 200);
      });
    };
    ping();
  });
}

function stopBackend() {
  if (pyProc && !pyProc.killed) {
    try { pyProc.kill(); } catch (_) {}
  }
  pyProc = null;
}

// ---------------------------------------------------------------- 窗口
async function createWindow() {
  win = new BrowserWindow({
    width: 840,
    height: 920,
    minWidth: 640,
    minHeight: 560,
    title: '压缩包密码恢复',
    backgroundColor: '#0f1419',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
  });

  win.once('ready-to-show', () => win.show());
  await win.loadFile('loading.html');

  try {
    const url = await startBackend();
    await waitForHttp(url);
    await win.loadURL(url);
  } catch (e) {
    const msg = String((e && e.message) || e);
    await win.loadFile('loading.html', { hash: 'error=' + encodeURIComponent(msg) });
  }
}

// ---------------------------------------------------------------- 原生对话框 IPC
ipcMain.handle('pick-file', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '选择要恢复的压缩包',
    properties: ['openFile'],
    filters: [
      { name: '压缩包', extensions: ['rar', 'zip', '7z'] },
      { name: '所有文件', extensions: ['*'] },
    ],
  });
  if (r.canceled || !r.filePaths || !r.filePaths[0]) return null;
  return r.filePaths[0];
});

ipcMain.handle('reveal-path', async (_e, p) => {
  if (p && fs.existsSync(p)) shell.showItemInFolder(p);
  return true;
});

// ---------------------------------------------------------------- 生命周期
app.whenReady().then(createWindow);

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('window-all-closed', () => {
  stopBackend();
  app.quit();
});

app.on('before-quit', stopBackend);
process.on('exit', stopBackend);
