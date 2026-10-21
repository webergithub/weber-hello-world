'use strict';
// Electron 主进程：窗口、IPC、本地资源协议（ppta://）、日志推送。
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, dialog, shell, protocol, net, Menu } = require('electron');
const { pathToFileURL } = require('url');

process.env.NODE_NO_WARNINGS = '1';
protocol.registerSchemesAsPrivileged([{ scheme: 'ppta', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }]);

let win = null;
let service = null;
let logger = null;

function resolveDataDir() {
  if (process.env.PPTA_DATA_DIR) return process.env.PPTA_DATA_DIR;
  const portable = process.env.PORTABLE_EXECUTABLE_DIR;
  if (portable) {
    const d = path.join(portable, 'PPT智能体数据');
    try { fs.mkdirSync(d, { recursive: true }); fs.accessSync(d, fs.constants.W_OK); return d; } catch { /* 不可写时退回用户目录 */ }
  }
  return path.join(app.getPath('userData'), 'data');
}

function createWindow() {
  win = new BrowserWindow({
    width: 1480, height: 920, minWidth: 1100, minHeight: 680,
    title: 'PPT智能体', backgroundColor: '#0f1115', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) win.loadURL(devUrl); else win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.on('closed', () => { win = null; });
}

const send = (ch, data) => { if (win && !win.isDestroyed()) win.webContents.send(ch, data); };

app.whenReady().then(async () => {
  const dataDir = resolveDataDir();
  logger = require('./core/logger');
  const { AgentService } = require('./core/service');
  service = new AgentService(dataDir);
  logger.child('app').info(`PPT智能体 v${app.getVersion()} 启动（Electron ${process.versions.electron}，${process.platform}）`);

  protocol.handle('ppta', (req) => {
    const u = new URL(req.url);
    const base = u.host === 'thumb' ? service.thumbDir : u.host === 'media' ? service.mediaDir : null;
    if (!base) return new Response('not found', { status: 404 });
    const p = path.normalize(path.join(base, decodeURIComponent(u.pathname)));
    if (!p.startsWith(base) || !fs.existsSync(p)) return new Response('not found', { status: 404 });
    return net.fetch(pathToFileURL(p).toString());
  });

  // 日志批量推送
  let pending = [];
  logger.on('line', (l) => { pending.push(l); });
  setInterval(() => { if (pending.length) { send('log', pending); pending = []; } }, 400);
  service.on('task', (t) => send('task', t));
  service.on('embedding', (e) => send('embedding', e));

  const api = {
    stats: () => service.stats(),
    tasks: () => service.tasks(),
    addTask: (dir) => service.addTask(dir),
    rerunTask: (id) => service.rerunTask(id),
    cancelTask: (id) => service.cancelTask(id),
    deleteTask: (id, removeFiles) => service.deleteTask(id, removeFiles),
    taskDetail: (id) => service.taskDetail(id),
    library: () => service.library(),
    fileDetail: (id) => service.fileDetail(id),
    slideDetail: (id) => service.slideDetail(id),
    categories: () => service.categories(),
    groups: (opts) => service.groups(opts),
    search: (q, opts) => service.searchQuery(q, opts),
    answer: (q, ids) => service.ragAnswer(q, ids),
    exportSlides: (ids, out, opts) => service.exportSlides(ids, out, opts),
    getConfig: () => service.getConfig(),
    setConfig: (patch) => service.setConfig(patch),
    engines: (force) => service.office.detect(force),
    buildEmbeddings: (force) => service.buildEmbeddings(force),
    rebuild: () => service.rebuildAll(),
    logTail: (n) => logger.tail(n),
    logClear: () => logger.clear(),
    logPath: () => logger.file,
    clientLog: (level, msg) => logger.write(level === 'error' ? 'ERROR' : 'INFO', 'ui', msg),
    selectDir: async () => {
      const r = await dialog.showOpenDialog(win, { title: '选择要解析的 PPT 目录', properties: ['openDirectory', 'multiSelections'] });
      return r.canceled ? [] : r.filePaths;
    },
    saveFile: async (defaultName, kind = 'pptx') => {
      const filters = kind === 'md' ? [{ name: 'Markdown', extensions: ['md'] }] : [{ name: 'PowerPoint', extensions: ['pptx'] }];
      const r = await dialog.showSaveDialog(win, { title: '导出', defaultPath: path.join(app.getPath('documents'), defaultName), filters });
      return r.canceled ? null : r.filePath;
    },
    openPath: (p) => shell.openPath(p),
    showItem: (p) => shell.showItemInFolder(p),
    openDataDir: () => shell.openPath(service.dataDir),
  };

  ipcMain.handle('api', async (_e, method, args) => {
    const fn = api[method];
    if (!fn) throw new Error('未知接口 ' + method);
    try { return await fn(...(args || [])); } catch (e) {
      logger.child('ipc').error(`接口 ${method} 出错`, e);
      throw e;
    }
  });

  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: '文件', submenu: [{ label: '打开数据目录', click: () => shell.openPath(service.dataDir) }, { type: 'separator' }, { role: 'quit', label: '退出' }] },
    { label: '视图', submenu: [{ role: 'reload', label: '刷新' }, { role: 'toggleDevTools', label: '开发者工具' }, { type: 'separator' }, { role: 'resetZoom', label: '实际大小' }, { role: 'zoomIn', label: '放大' }, { role: 'zoomOut', label: '缩小' }, { role: 'togglefullscreen', label: '全屏' }] },
  ]));
  createWindow();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});

app.on('window-all-closed', () => {
  if (logger) logger.child('app').info('程序退出');
  if (service) service.close();
  app.quit();
});
