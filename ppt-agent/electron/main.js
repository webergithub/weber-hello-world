'use strict';
// Electron 主进程：窗口、IPC、本地资源协议（ppta://）、日志推送。
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, dialog, shell, protocol, net, Menu, nativeTheme, Tray, nativeImage } = require('electron');
const { pathToFileURL } = require('url');

process.env.NODE_NO_WARNINGS = '1';
protocol.registerSchemesAsPrivileged([{ scheme: 'ppta', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }]);

let win = null;
let service = null;
let logger = null;
let tray = null;
let trayHinted = false;

// 只允许运行一个实例：再次启动时恢复已有窗口（包括已最小化到系统托盘的窗口）
if (!app.requestSingleInstanceLock()) app.quit();
else app.on('second-instance', () => showWindow());

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/** 系统托盘图标（右下角图标栏）：单击 / 双击恢复窗口，右键菜单可彻底退出 */
function createTray() {
  if (tray) return;
  try {
    let img = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png'));
    if (process.platform === 'win32') img = img.resize({ width: 16, height: 16 });
    tray = new Tray(img);
    tray.setToolTip('PPT智能体');
    tray.on('click', showWindow);
    tray.on('double-click', showWindow);
    updateTrayMenu();
  } catch (e) { if (logger) logger.child('app').warn('创建系统托盘图标失败', e); }
}
function updateTrayMenu() {
  if (!tray) return;
  const running = service && service.running ? service.store.getTask(service.running) : null;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示主窗口', click: showWindow },
    ...(running ? [{ label: `正在解析：${running.name}`, enabled: false }] : []),
    { type: 'separator' },
    { label: '完全退出', click: () => { showWindow(); confirmQuit(); } },
  ]));
  tray.setToolTip(running ? `PPT智能体 · 正在解析：${running.name}` : 'PPT智能体');
}
/** 最小化到系统托盘：隐藏窗口，程序与解析任务继续在后台运行 */
function hideToTray() {
  createTray();
  if (!tray) { win.minimize(); return; }
  win.hide();
  if (!trayHinted && process.platform === 'win32') {
    trayHinted = true;
    try { tray.displayBalloon({ title: 'PPT智能体 仍在运行', content: '已最小化到右下角图标栏。单击图标恢复窗口，右击图标可完全退出。' }); } catch { /* ignore */ }
  }
}

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
  // 关闭窗口：询问“完全退出”还是“最小化到系统托盘”，可记住选择
  win.on('close', (e) => {
    if (quitting || !service) return;
    e.preventDefault();
    handleClose();
  });
}

let quitting = false;
let closeDialogOpen = false;
async function handleClose() {
  if (closeDialogOpen) return;
  const action = service.getConfig().closeAction || 'ask';
  if (action === 'minimize') { hideToTray(); return; }
  if (action === 'quit') { await confirmQuit(); return; }
  closeDialogOpen = true;
  try {
    const running = service.running ? '\n\n当前有解析任务正在运行；完全退出后，下次启动可点击“继续”从断点继续。' : '';
    const r = await dialog.showMessageBox(win, {
      type: 'question', title: '退出 PPT智能体', message: '要完全关闭程序，还是最小化到右下角图标栏？',
      detail: '最小化后程序继续在后台运行（解析任务不中断）：单击右下角图标栏中的 PPT智能体 图标即可恢复，右击图标可完全退出。' + running,
      buttons: ['最小化到图标栏', '完全退出', '取消'], defaultId: 0, cancelId: 2, noLink: true,
      checkboxLabel: '记住我的选择（可在“设置”中修改）', checkboxChecked: false,
    });
    if (r.response === 2) return;
    const choice = r.response === 0 ? 'minimize' : 'quit';
    if (r.checkboxChecked) service.setConfig({ closeAction: choice });
    logger.child('app').info(`关闭窗口：用户选择${choice === 'minimize' ? '最小化到系统托盘' : '完全退出'}${r.checkboxChecked ? '（已记住）' : ''}`);
    if (choice === 'minimize') hideToTray(); else await confirmQuit(true);
  } finally { closeDialogOpen = false; }
}

async function confirmQuit(skipAsk = false) {
  if (service.running && !skipAsk) {
    const r = await dialog.showMessageBox(win, { type: 'warning', title: '退出', message: '有解析任务正在运行，确定退出？', detail: '退出后任务会中断，下次启动可点击“继续”从断点继续。', buttons: ['退出', '取消'], defaultId: 1, cancelId: 1, noLink: true });
    if (r.response !== 0) return;
  }
  if (service.running) { service.pauseTask(service.running); logger.child('app').info('退出前中断正在运行的任务（可继续）'); }
  quitting = true;
  if (tray) { tray.destroy(); tray = null; }
  app.quit();
}

const send = (ch, data) => { if (win && !win.isDestroyed()) win.webContents.send(ch, data); };

// 启动时是否询问数据目录：未勾选“记住选择”且不是刚刚主动切换目录后的重启；记录使用过的目录（最多 10 个）
let askDataDirNow = false;
function noteDataDir(dir) {
  const b = readBootstrap();
  const hist = [path.resolve(dir), ...(b.dataDirHistory || []).filter((d) => path.resolve(d) !== path.resolve(dir))].slice(0, 10);
  askDataDirNow = (!process.env.PPTA_DATA_DIR || process.env.PPTA_ASK_DIR === '1') && b.askDataDir !== false && !b.skipAskOnce;
  const { skipAskOnce, ...rest } = b; // eslint-disable-line no-unused-vars
  try { writeBootstrap({ ...rest, dataDirHistory: hist }); } catch { /* ignore */ }
}

app.whenReady().then(async () => {
  const dataDir = resolveDataDir();
  noteDataDir(dataDir);
  logger = require('./core/logger');
  const { AgentService } = require('./core/service');
  service = new AgentService(dataDir);
  logger.child('app').info(`PPT智能体 v${app.getVersion()} 启动（Electron ${process.versions.electron}，${process.platform}）`);
  setTimeout(() => service.flushFeedback().catch(() => {}), 15000);

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
  service.on('task', (t) => { send('task', t); updateTrayMenu(); });
  service.on('embedding', (e) => send('embedding', e));
  service.on('progress', (p) => send('progress', p));
  service.on('watch', (w) => send('watch', w));
  service.startScheduler();
  createTray();
  const applyTheme = (t) => { nativeTheme.themeSource = t === 'dark' || t === 'light' ? t : 'system'; };
  applyTheme(service.getConfig().uiTheme);
  nativeTheme.on('updated', () => send('systemTheme', nativeTheme.shouldUseDarkColors ? 'dark' : 'light'));

  const api = {
    stats: () => service.stats(),
    tasks: () => service.tasks(),
    addTask: (dir, opts) => service.addTask(dir, opts),
    addAllLocalTask: (opts) => service.addAllLocalTask(opts),
    setTaskWatch: (id, on) => service.setTaskWatch(id, on),
    watchInfo: () => service.watchInfo(),
    runWatch: (ids) => service.runWatch('手动增量扫描', ids || null),
    startTask: (id, opts) => service.startTask(id, opts),
    resumeTask: (id) => service.resumeTask(id),
    pauseTask: (id) => service.pauseTask(id),
    startAll: () => service.startAll(),
    moveTask: (id, d) => service.moveTask(id, d),
    queueState: () => service.queueState(),
    reparseFiles: (paths, name) => service.reparseFiles(paths, name),
    history: (opts) => service.history(opts),
    overview: () => service.overview(),
    docTypes: () => service.docTypes(),
    convertSlides: (items, out) => service.convertSlides(items, out),
    convertHistory: () => service.convertHistory(),
    listPptx: (paths) => service.listPptx(paths),
    convertFile: (src, opts) => service.convertFile(src, opts),
    selectFiles: async (title) => {
      const r = await dialog.showOpenDialog(win, { title: title || '选择 PPT 文件', properties: ['openFile', 'multiSelections'], filters: [{ name: 'PowerPoint', extensions: ['pptx', 'pptm', 'ppsx', 'potx', 'ppt'] }] });
      return r.canceled ? [] : r.filePaths;
    },
    notesChanges: () => service.notesChanges(),
    notesWritebackHistory: () => service.notesWritebackHistory(),
    writeBackNotesBatch: (keys) => service.writeBackNotesBatch(keys),
    convertHistoryResult: (id) => service.convertHistoryResult(id),
    convertHistoryDelete: (ids) => service.convertHistoryDelete(ids),
    smartCandidates: (desc, opts) => service.smartCandidates(desc, opts),
    updateSlideText: (id, f) => service.updateSlideText(id, f),
    recycleFiles: (ids, opts) => service.recycleFiles(ids, opts),
    recycleList: () => service.recycleList(),
    restoreRecycled: (ids) => service.restoreRecycled(ids),
    purgeRecycled: (ids) => service.purgeRecycled(ids),
    generateNotes: (id) => service.generateNotes(id),
    getConvertRules: () => service.getConvertRules(),
    defaultConvertRules: () => require('./core/converter').normalizeRules(null),
    setConvertRules: (r) => service.setConvertRules(r),
    resetConvertRules: () => service.resetConvertRules(),
    convertRulesFromText: (t) => service.convertRulesFromText(t),
    generateDeck: (ids, out, opts) => service.generateDeck(ids, out, opts),
    localRoots: () => require('./core/service').localRoots(),
    systemTheme: () => (nativeTheme.shouldUseDarkColors ? 'dark' : 'light'),
    setUiTheme: (t) => { applyTheme(t); return service.setConfig({ uiTheme: t }); },
    dataDirInfo: () => {
      const b = readBootstrap();
      const history = (b.dataDirHistory || []).map((d) => ({ dir: d, exists: fs.existsSync(d), hasData: fs.existsSync(path.join(d, 'ppt-agent.db')), current: path.resolve(d) === path.resolve(service.dataDir) }));
      return { current: service.dataDir, bootstrap: b.dataDir || null, env: process.env.PPTA_DATA_DIR || null, defaultDir: path.join(app.getPath('userData'), 'data'), portable: process.env.PORTABLE_EXECUTABLE_DIR || null, history, ask: b.askDataDir !== false, askNow: askDataDirNow };
    },
    setDataDirAsk: (ask) => { writeBootstrap({ ...readBootstrap(), askDataDir: !!ask }); askDataDirNow = false; return true; },
    dataDirAsked: () => { askDataDirNow = false; return true; },
    removeDataDirHistory: (dir) => { const b = readBootstrap(); writeBootstrap({ ...b, dataDirHistory: (b.dataDirHistory || []).filter((d) => path.resolve(d) !== path.resolve(dir)) }); return true; },
    sendFeedback: (fb) => service.sendFeedback(fb, { version: app.getVersion() }),
    feedbackStatus: () => service.feedbackStatus(),
    testMail: (mail) => service.testMail(mail),
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
      writeBootstrap({ ...readBootstrap(), dataDir: dir, skipAskOnce: true });
      setTimeout(() => { app.relaunch(); app.exit(0); }, 300);
      return { changed: true, restarting: true };
    },
    resetDataDir: () => { const b = readBootstrap(); delete b.dataDir; b.skipAskOnce = true; writeBootstrap(b); setTimeout(() => { app.relaunch(); app.exit(0); }, 300); return true; },
    rerunTask: (id) => service.rerunTask(id),
    cancelTask: (id) => service.cancelTask(id),
    deleteTask: (id, removeFiles) => service.deleteTask(id, removeFiles),
    taskDetail: (id) => service.taskDetail(id),
    library: (opts) => service.library(opts),
    fileDetail: (id) => service.fileDetail(id),
    slideDetail: (id) => service.slideDetail(id),
    related: (id) => service.related(id),
    appVersion: () => app.getVersion(),
    notesI18n: (id) => service.notesI18n(id),
    translateNotes: (id, opts) => service.translateNotes(id, opts),
    writeBackNotes: (id, opts) => service.writeBackNotes(id, opts),
    testLlm: (cfg) => service.testLlm(cfg),
    categories: (opts) => service.categories(opts),
    groups: (opts) => service.groups(opts),
    search: (q, opts) => service.searchQuery(q, opts),
    searchHistory: (opts) => service.searchHistory(opts),
    searchHistoryResult: (id) => service.searchHistoryResult(id),
    searchHistoryDelete: (ids) => service.searchHistoryDelete(ids),
    searchHistoryClear: () => service.searchHistoryClear(),
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
    // 导出运行日志：lines 为界面上筛选后的行；不传时复制完整日志文件
    exportLog: (out, lines) => {
      if (Array.isArray(lines)) fs.writeFileSync(out, '\ufeff' + lines.join('\r\n') + '\r\n', 'utf8');
      else fs.copyFileSync(logger.file, out);
      return { path: out, size: fs.statSync(out).size };
    },
    clientLog: (level, msg) => logger.write(level === 'error' ? 'ERROR' : 'INFO', 'ui', msg),
    selectDir: async (title, single) => {
      const r = await dialog.showOpenDialog(win, { title: title || '选择要解析的 PPT / Word 目录', properties: single ? ['openDirectory', 'createDirectory'] : ['openDirectory', 'multiSelections'] });
      return r.canceled ? [] : r.filePaths;
    },
    // 保存对话框：按用途（key）记住上一次选择的目录
    saveFile: async (defaultName, kind = 'pptx', key = 'export') => {
      const filters = kind === 'md' ? [{ name: 'Markdown', extensions: ['md'] }] : kind === 'log' ? [{ name: '日志', extensions: ['log', 'txt'] }] : [{ name: 'PowerPoint', extensions: ['pptx'] }];
      const b = readBootstrap();
      const last = (b.lastDirs || {})[key];
      const dir = last && fs.existsSync(last) ? last : app.getPath('documents');
      const r = await dialog.showSaveDialog(win, { title: key === 'convert' ? '保存黑白底转换结果' : '导出', defaultPath: path.join(dir, defaultName), filters });
      if (r.canceled) return null;
      writeBootstrap({ ...readBootstrap(), lastDirs: { ...(b.lastDirs || {}), [key]: path.dirname(r.filePath) } });
      return r.filePath;
    },
    openPath: (p) => { service.recordOpenPath(p); return shell.openPath(p); },
    analytics: (opts) => service.analytics(opts),
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

app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => {
  if (logger) logger.child('app').info('程序退出');
  if (service) service.close();
  app.quit();
});
