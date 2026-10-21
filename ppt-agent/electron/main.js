'use strict';
// Electron 主进程：窗口、IPC、本地资源协议（ppta://）、日志推送。
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, dialog, shell, protocol, net, Menu, nativeTheme } = require('electron');
const { pathToFileURL } = require('url');

process.env.NODE_NO_WARNINGS = '1';
protocol.registerSchemesAsPrivileged([{ scheme: 'ppta', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }]);

let win = null;
let service = null;
let logger = null;

const bootstrapFile = () => path.join(app.getPath('userData'), 'bootstrap.json');
function readBootstrap() { try { return JSON.parse(fs.readFileSync(bootstrapFile(), 'utf8')); } catch { return {}; } }
function writeBootstrap(b) { fs.mkdirSync(path.dirname(bootstrapFile()), { recursive: true }); fs.writeFileSync(bootstrapFile(), JSON.stringify(b, null, 2)); }

function resolveDataDir() {
  if (process.env.PPTA_DATA_DIR) return process.env.PPTA_DATA_DIR;
  const b = readBootstrap();
  if (b.dataDir) { try { fs.mkdirSync(b.dataDir, { recursive: true }); fs.accessSync(b.dataDir, fs.constants.W_OK); return b.dataDir; } catch { /* 指定目录不可用时退回默认 */ } }
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
  service.on('progress', (p) => send('progress', p));
  const applyTheme = (t) => { nativeTheme.themeSource = t === 'dark' || t === 'light' ? t : 'system'; };
  applyTheme(service.getConfig().uiTheme);
  nativeTheme.on('updated', () => send('systemTheme', nativeTheme.shouldUseDarkColors ? 'dark' : 'light'));

  const api = {
    stats: () => service.stats(),
    tasks: () => service.tasks(),
    addTask: (dir, opts) => service.addTask(dir, opts),
    addAllLocalTask: () => service.addAllLocalTask(),
    startTask: (id) => service.startTask(id),
    startAll: () => service.startAll(),
    moveTask: (id, d) => service.moveTask(id, d),
    queueState: () => service.queueState(),
    reparseFiles: (paths, name) => service.reparseFiles(paths, name),
    history: (opts) => service.history(opts),
    overview: () => service.overview(),
    docTypes: () => service.docTypes(),
    convertSlides: (items, out) => service.convertSlides(items, out),
    smartCandidates: (desc, opts) => service.smartCandidates(desc, opts),
    generateDeck: (ids, out, opts) => service.generateDeck(ids, out, opts),
    localRoots: () => require('./core/service').localRoots(),
    systemTheme: () => (nativeTheme.shouldUseDarkColors ? 'dark' : 'light'),
    setUiTheme: (t) => { applyTheme(t); return service.setConfig({ uiTheme: t }); },
    dataDirInfo: () => ({ current: service.dataDir, bootstrap: readBootstrap().dataDir || null, env: process.env.PPTA_DATA_DIR || null, defaultDir: path.join(app.getPath('userData'), 'data'), portable: process.env.PORTABLE_EXECUTABLE_DIR || null }),
    setDataDir: async (dir, mode) => {
      // mode: 'migrate' 迁移现有数据 | 'use' 直接使用目标目录（已有数据则沿用）
      if (!dir) throw new Error('请选择目录');
      dir = path.resolve(dir);
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      const cur = path.resolve(service.dataDir);
      if (dir === cur) return { changed: false };
      if (dir.startsWith(cur + path.sep)) throw new Error('新目录不能位于当前数据目录内部');
      if (service.running) throw new Error('有任务正在解析，请等待完成或取消后再切换目录');
      logger.child('app').info(`数据目录切换：${cur} → ${dir}（${mode === 'migrate' ? '迁移数据' : '使用目标目录'}）`);
      if (mode === 'migrate') {
        if (fs.existsSync(path.join(dir, 'ppt-agent.db'))) throw new Error('目标目录已有数据库，请选择“直接使用该目录”或换一个空目录');
        service.close();
        for (const f of fs.readdirSync(cur)) fs.cpSync(path.join(cur, f), path.join(dir, f), { recursive: true });
      }
      writeBootstrap({ ...readBootstrap(), dataDir: dir });
      setTimeout(() => { app.relaunch(); app.exit(0); }, 300);
      return { changed: true, restarting: true };
    },
    resetDataDir: () => { const b = readBootstrap(); delete b.dataDir; writeBootstrap(b); setTimeout(() => { app.relaunch(); app.exit(0); }, 300); return true; },
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
    selectDir: async (title, single) => {
      const r = await dialog.showOpenDialog(win, { title: title || '选择要解析的 PPT / Word 目录', properties: single ? ['openDirectory', 'createDirectory'] : ['openDirectory', 'multiSelections'] });
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
