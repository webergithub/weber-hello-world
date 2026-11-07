'use strict';
// Electron 主进程：窗口、IPC、本地资源协议（ppta://）、日志推送。
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, dialog, shell, protocol, net, Menu, nativeTheme, Tray, nativeImage } = require('electron');
const { pathToFileURL } = require('url');

process.env.NODE_NO_WARNINGS = '1';
const MEDIA_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.bmp': 'image/bmp', '.svg': 'image/svg+xml', '.webp': 'image/webp' };
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
  const w = win || BrowserWindow.getAllWindows()[0]; // 启动时还在“选择数据目录”窗口
  if (!w) return;
  if (w.isMinimized()) w.restore();
  w.show();
  w.focus();
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
  if (service.running) { for (const id of [...service.runningSet]) service.pauseTask(id); logger.child('app').info('退出前中断正在运行的任务（可继续）'); }
  quitting = true;
  if (tray) { tray.destroy(); tray = null; }
  app.quit();
}

/**
 * 各进程内存（v3.11）：Electron 程序固定由多个进程组成——主进程（解析、数据库、检索都在这里）、界面（渲染进程）、
 * GPU 进程（界面绘制加速）、网络服务进程（Chromium 自带，单机版不联网也会存在）；解析时另有 PowerShell / LibreOffice 等外部进程。
 */
const PROC_LABEL = { Browser: '主进程（解析 / 数据库 / 检索）', Tab: '界面（窗口内容）', GPU: 'GPU 进程（界面绘制加速）', Utility: '辅助进程', Zygote: '进程孵化器（Linux）' };
function memInfo() {
  const rows = app.getAppMetrics().map((m) => ({
    pid: m.pid, type: m.type, name: m.serviceName || m.name || '',
    label: m.type === 'Utility' && /network/i.test(m.serviceName || m.name || '') ? '网络服务进程（Chromium 自带）' : PROC_LABEL[m.type] || m.type,
    mb: Math.round(((m.memory && m.memory.workingSetSize) || 0) / 1024), cpu: Math.round(((m.cpu && m.cpu.percentCPUUsage) || 0) * 10) / 10,
  }));
  const ext = require('./core/procs').state().children.map((c) => ({ pid: c.pid, type: 'External', name: c.name, label: `外部程序：${c.name}`, mb: null, cpu: null }));
  return { rows: [...rows, ...ext], totalMB: rows.reduce((a, r) => a + r.mb, 0), main: process.memoryUsage() };
}

const send = (ch, data) => { if (win && !win.isDestroyed()) win.webContents.send(ch, data); };

// 记录使用过的数据目录（最多 10 个）；去掉“刚刚主动切换目录、本次不询问”的一次性标记
function noteDataDir(dir) {
  const b = readBootstrap();
  const hist = [path.resolve(dir), ...(b.dataDirHistory || []).filter((d) => path.resolve(d) !== path.resolve(dir))].slice(0, 10);
  const { skipAskOnce, ...rest } = b; // eslint-disable-line no-unused-vars
  try { writeBootstrap({ ...rest, dataDirHistory: hist }); } catch { /* ignore */ }
}

const dirInfo = (d) => ({ dir: d, exists: fs.existsSync(d), hasData: fs.existsSync(path.join(d, 'ppt-agent.db')) });

// 启动时是否先选择数据目录：未勾选“记住选择”、不是刚刚主动切换目录后的重启；使用环境变量 PPTA_DATA_DIR 时不询问（PPTA_ASK_DIR=1 强制询问）
// v3.4 起选择在加载资料库之前进行；旧版本勾选过“记住选择”的，升级后重新询问一次
function shouldAskDataDir() {
  if (process.env.PPTA_DATA_DIR && process.env.PPTA_ASK_DIR !== '1') return false;
  const b = readBootstrap();
  if (!b.askReset34) {
    b.askReset34 = true;
    if (b.askDataDir === false) delete b.askDataDir;
    try { writeBootstrap(b); } catch { /* ignore */ }
  }
  return b.askDataDir !== false && !b.skipAskOnce;
}

// 启动选择窗口：在创建资料库服务之前选定数据目录，选完直接进入主界面（不需要重启）；关闭窗口 = 退出程序
let booting = false;
function chooseDataDirAtStartup(current) {
  booting = true;
  return new Promise((resolve) => {
    let done = false;
    const bw = new BrowserWindow({
      width: 760, height: 580, minWidth: 600, minHeight: 460, title: 'PPT智能体 · 选择数据目录', backgroundColor: nativeTheme.shouldUseDarkColors ? '#0f1115' : '#f5f6f8', autoHideMenuBar: true, show: false,
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    bw.setMenu(null);
    const finish = (dir) => {
      if (done) return;
      done = true;
      ipcMain.removeHandler('boot');
      resolve(dir);
      if (!bw.isDestroyed()) bw.close();
    };
    ipcMain.handle('boot', async (_e, method, args = []) => {
      if (method === 'info') {
        const b = readBootstrap();
        const hist = (b.dataDirHistory || []).filter((d) => path.resolve(d) !== path.resolve(current));
        return { version: app.getVersion(), current: { ...dirInfo(current), current: true }, history: hist.map(dirInfo), defaultDir: path.join(app.getPath('userData'), 'data') };
      }
      if (method === 'selectDir') {
        const r = await dialog.showOpenDialog(bw, { title: '选择保存解析数据的目录', properties: ['openDirectory', 'createDirectory'] });
        return r.canceled || !r.filePaths[0] ? null : dirInfo(r.filePaths[0]);
      }
      if (method === 'choose') {
        const [dir, remember] = args;
        if (!dir) throw new Error('请选择数据目录');
        try { fs.mkdirSync(dir, { recursive: true }); fs.accessSync(dir, fs.constants.W_OK); } catch { throw new Error('该目录无法写入，请选择其他目录'); }
        const b = readBootstrap();
        if (!process.env.PPTA_DATA_DIR) b.dataDir = dir;
        if (remember) b.askDataDir = false;
        writeBootstrap(b);
        finish(dir);
        return true;
      }
      if (method === 'quit') { finish(null); return true; }
      throw new Error('未知接口 ' + method);
    });
    bw.once('ready-to-show', () => bw.show());
    bw.on('closed', () => finish(null));
    const devUrl = process.env.VITE_DEV_SERVER_URL;
    if (devUrl) bw.loadURL(devUrl + '#boot-datadir'); else bw.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), { hash: 'boot-datadir' });
  });
}

app.whenReady().then(async () => {
  let dataDir = resolveDataDir();
  if (shouldAskDataDir()) {
    dataDir = await chooseDataDirAtStartup(dataDir);
    if (!dataDir) { app.quit(); return; }
  }
  booting = false;
  noteDataDir(dataDir);
  logger = require('./core/logger');
  const { AgentService } = require('./core/service');
  service = new AgentService(dataDir);
  // 外部进程登记（v3.10.1）：退出时结束全部外部进程；上次异常退出留下的 Word / PowerPoint 后台进程启动时清理
  const procs = require('./core/procs');
  procs.configure({ file: path.join(app.getPath('userData'), 'office-procs.json'), logger: logger.child('procs') });
  setTimeout(async () => {
    await procs.cleanupStale().catch(() => 0);
    const others = (await procs.findOrphans().catch(() => [])).filter((o) => !o.ours);
    if (others.length) {
      logger.child('procs').warn(`发现 ${others.length} 个后台 Word / PowerPoint 进程（没有窗口）：${others.map((o) => `${o.image}#${o.pid} ${o.memMB}MB`).join('，')}`);
      send('appNotice', { msg: `发现 ${others.length} 个后台运行的 Word / PowerPoint 进程（没有窗口，约 ${others.reduce((a, o) => a + o.memMB, 0)} MB）`, kind: 'warn', label: '查看并结束', link: { type: 'view', view: { type: 'settings', focus: 'procs' } }, cat: '系统' });
    }
  }, 8000);
  logger.child('app').info(`PPT智能体 v${app.getVersion()} 启动（Electron ${process.versions.electron}，${process.platform}）`);
  // 去掉程序 exe 的下载标记，以后启动不再每次弹出 SmartScreen（便携版为外层 exe）
  const mark = require('./core/winmark').clearDownloadMark(process.env.PORTABLE_EXECUTABLE_FILE || process.execPath);
  if (mark.result === 'cleared') logger.child('app').info(`已去掉程序文件的下载标记（等同于“属性 → 解除锁定”），以后启动不再弹出 SmartScreen：${mark.file}`);
  else if (mark.result === 'failed') logger.child('app').warn(`无法去掉程序文件的下载标记（SmartScreen 可能每次启动都会询问，可右键 exe → 属性 → 勾选“解除锁定”）：${mark.error}`);
  setTimeout(() => service.flushFeedback().catch(() => {}), 15000);
  // 内存监控（v3.11）：每分钟检查一次，总内存超过 1.5GB 时把各进程占用写入运行日志，便于定位
  setInterval(() => {
    try {
      const m = memInfo();
      if (m.totalMB > 1536) logger.child('app').warn(`内存占用较高：合计 ${m.totalMB}MB（${m.rows.filter((r) => r.mb).map((r) => `${r.label} ${r.mb}MB`).join('，')}）`);
    } catch { /* ignore */ }
  }, 60000).unref();

  protocol.handle('ppta', (req) => {
    const u = new URL(req.url);
    // PDF 原文件（只读）：ppta://src/<文件 id>，只提供资料库中 PDF 类型的文件
    // pdf.js 的字符映射与标准字体（中文 PDF 需要 cMap）：ppta://pdfjs/cmaps/...、ppta://pdfjs/standard_fonts/...
    if (u.host === 'pdfjs') {
      const root = path.dirname(path.dirname(require.resolve('pdfjs-dist/build/pdf.mjs')));
      const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
      const p = path.normalize(path.join(root, rel));
      if (!/^(cmaps|standard_fonts|wasm|iccs)[\\/]/.test(rel) || !p.startsWith(root) || !fs.existsSync(p)) return new Response('not found', { status: 404 });
      return new Response(fs.readFileSync(p), { headers: { 'content-type': 'application/octet-stream', 'access-control-allow-origin': '*' } });
    }
    if (u.host === 'src') {
      const f = service.store.getFile(Number(decodeURIComponent(u.pathname).replace(/^\//, '')));
      if (!f || f.kind !== 'pdf' || !fs.existsSync(f.path)) return new Response('not found', { status: 404 });
      return net.fetch(pathToFileURL(f.path).toString());
    }
    const base = u.host === 'thumb' ? service.thumbDir : u.host === 'media' ? service.mediaDir : null;
    if (!base) return new Response('not found', { status: 404 });
    const rel = decodeURIComponent(u.pathname);
    const p = path.normalize(path.join(base, rel));
    if (!p.startsWith(base)) return new Response('not found', { status: 404 });
    if (fs.existsSync(p)) return net.fetch(pathToFileURL(p).toString());
    // 页面图片不再复制到数据目录：按“文件 key / 部件路径”直接从原 PPT / Word 中读取（只读）
    if (u.host === 'media') {
      const [, key, name] = rel.split('/');
      if (key && name) {
        return service.readMedia(key, name).then((buf) => (buf ? new Response(buf, { headers: { 'content-type': MEDIA_TYPES[path.extname(name).toLowerCase()] || 'application/octet-stream', 'cache-control': 'max-age=3600' } })
          : new Response('not found', { status: 404 }))).catch(() => new Response('not found', { status: 404 }));
      }
    }
    return new Response('not found', { status: 404 });
  });

  // 日志批量推送
  let pending = [];
  logger.on('line', (l) => { pending.push(l); });
  setInterval(() => { if (pending.length) { send('log', pending); pending = []; } }, 400);
  // 任务 / 进度事件合并后每 120ms 推送一次：上万个文件时逐个推送会让界面来不及处理而假死。
  // 同一任务只推最新状态；逐页预览事件（slide）每批每个任务最多保留最近 12 条，其余事件全部保留。
  let taskBuf = new Map(), progBuf = [], flushTimer = null, trayRunning;
  const flushEvents = () => {
    flushTimer = null;
    if (taskBuf.size) { send('taskBatch', [...taskBuf.values()]); taskBuf = new Map(); }
    if (progBuf.length) {
      const keep = new Map();
      for (let i = progBuf.length - 1; i >= 0; i--) {
        const e = progBuf[i];
        if (e.stage !== 'slide') continue;
        const n = keep.get(e.taskId) || 0;
        if (n >= 12) e.drop = true; else keep.set(e.taskId, n + 1);
      }
      send('progressBatch', progBuf.filter((e) => !e.drop));
      progBuf = [];
    }
  };
  const scheduleFlush = () => { if (!flushTimer) flushTimer = setTimeout(flushEvents, 120); };
  service.on('task', (t) => { taskBuf.set(t.id, t); scheduleFlush(); if (service.running !== trayRunning) { trayRunning = service.running; updateTrayMenu(); } });
  service.on('embedding', (e) => send('embedding', e));
  service.on('progress', (p) => { progBuf.push(p); scheduleFlush(); });
  service.on('library', (e) => send('library', e));
  service.on('searchProgress', (p) => send('searchProgress', p));
  service.summary.on('update', (st) => send('plugin', st));
  service.summary.on('notice', (n) => send('pluginNotice', n));
  service.on('watch', (w) => send('watch', w));
  service.startScheduler();
  createTray();
  const applyTheme = (t) => { nativeTheme.themeSource = t === 'dark' || t === 'light' ? t : 'system'; };
  applyTheme(service.getConfig().uiTheme);
  nativeTheme.on('updated', () => send('systemTheme', nativeTheme.shouldUseDarkColors ? 'dark' : 'light'));

  const api = {
    stats: () => service.stats(),
    officeProcs: () => require('./core/procs').findOrphans(),
    userActivity: () => service.userActivity(),
    memInfo: () => memInfo(),
    killOfficeProcs: (list) => require('./core/procs').killOrphans(list),
    tasks: () => service.tasks(),
    addTask: (dir, opts) => service.addTask(dir, opts),
    addAllLocalTask: (opts) => service.addAllLocalTask(opts),
    setTaskWatch: (id, on) => service.setTaskWatch(id, on),
    watchInfo: () => service.watchInfo(),
    runWatch: (ids) => service.runWatch('手动增量扫描', ids || null),
    startTask: (id, opts) => service.startTask(id, opts),
    subtaskFiles: (id) => service.subtaskFiles(id),
    // 插件：智能总结
    pluginState: () => service.summary.state(),
    summaryStart: (opts) => service.summaryStart(opts),
    summaryPause: () => service.summary.pause(),
    summaryResume: () => service.summary.resume(),
    summaryCancel: () => service.summary.cancel(),
    summaryClear: () => service.summary.clearFinished(),
    summaryList: () => service.summary.list(),
    pluginCheck: (cfg) => service.pluginCheck(cfg),
    pluginEnable: (on, cfg) => service.pluginEnable(on, cfg),
    pluginExample: () => service.pluginExample(),
    selectScript: async () => {
      const r = await dialog.showOpenDialog(win, { title: '选择智能总结脚本', properties: ['openFile'], filters: [{ name: '脚本 / 程序', extensions: ['js', 'cjs', 'mjs', 'py', 'ps1', 'bat', 'cmd', 'exe'] }, { name: '所有文件', extensions: ['*'] }] });
      return r.canceled ? null : r.filePaths[0];
    },
    resumeTask: (id) => service.resumeTask(id),
    pauseTask: (id) => service.pauseTask(id),
    startAll: () => service.startAll(),
    moveTask: (id, d) => service.moveTask(id, d),
    queueState: () => service.queueState(),
    reparseFiles: (paths, name) => service.reparseFiles(paths, name),
    history: (opts) => service.history(opts),
    overview: (opts) => service.overview(opts),
    docTypes: () => service.docTypes(),
    convertSlides: (items, out) => service.convertSlides(items, out),
    convertHistory: () => service.convertHistory(),
    listPptx: (paths) => service.listPptx(paths),
    convertFile: (src, opts) => service.convertFile(src, opts),
    selectFiles: async (title, kind) => {
      // kind = 'docs'：PPT / Word / PDF 都可选（智能合成）；默认只选 PPT
      const filters = kind === 'docs' ? [{ name: 'PPT / Word / PDF', extensions: ['pptx', 'pptm', 'ppsx', 'potx', 'ppt', 'docx', 'docm', 'doc', 'pdf'] }] : [{ name: 'PowerPoint', extensions: ['pptx', 'pptm', 'ppsx', 'potx', 'ppt'] }];
      const r = await dialog.showOpenDialog(win, { title: title || '选择 PPT 文件', properties: ['openFile', 'multiSelections'], filters });
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
    unifyDeck: (p, ids, theme) => service.unifyDeck(p, ids, theme),
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
      return { current: service.dataDir, bootstrap: b.dataDir || null, env: process.env.PPTA_DATA_DIR || null, defaultDir: path.join(app.getPath('userData'), 'data'), portable: process.env.PORTABLE_EXECUTABLE_DIR || null, history, ask: b.askDataDir !== false };
    },
    setDataDirAsk: (ask) => { writeBootstrap({ ...readBootstrap(), askDataDir: !!ask }); return true; },
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
    deleteTasks: (ids, removeFiles) => service.deleteTasks(ids, removeFiles),
    searchSuggestions: (opts) => service.searchSuggestions(opts),
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
    repairText: () => service.repairTextEncoding(),
    aiState: () => service.ai.state(),
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
      const filters = kind === 'md' ? [{ name: 'Markdown', extensions: ['md'] }] : kind === 'docx' ? [{ name: 'Word', extensions: ['docx'] }] : kind === 'log' ? [{ name: '日志', extensions: ['log', 'txt'] }] : [{ name: 'PowerPoint', extensions: ['pptx'] }];
      const b = readBootstrap();
      const last = (b.lastDirs || {})[key];
      const dir = last && fs.existsSync(last) ? last : app.getPath('documents');
      const r = await dialog.showSaveDialog(win, { title: key === 'convert' ? '保存黑白底转换结果' : '导出', defaultPath: path.join(dir, defaultName), filters });
      if (r.canceled) return null;
      writeBootstrap({ ...readBootstrap(), lastDirs: { ...(b.lastDirs || {}), [key]: path.dirname(r.filePath) } });
      return r.filePath;
    },
    // 帮助 → 需求文档：把内置的需求文档（随版本打包）另存一份
    saveRequirementsDoc: async (kind = 'docx') => {
      const ext = kind === 'md' ? 'md' : 'docx';
      const src = path.join(__dirname, '..', 'docs', `需求文档.${ext}`);
      if (!fs.existsSync(src)) throw new Error('未找到内置的需求文档');
      const out = await api.saveFile(`PPT智能体需求文档_v${app.getVersion()}.${ext}`, ext, 'reqdoc');
      if (!out) return null;
      fs.copyFileSync(src, out);
      return out;
    },
    openPath: (p) => { service.recordOpenPath(p); return shell.openPath(p); },
    analytics: (opts) => service.analytics(opts),
    showItem: (p) => shell.showItemInFolder(p),
    openDataDir: () => shell.openPath(service.dataDir),
  };

  ipcMain.handle('api', async (_e, method, args) => {
    const fn = api[method];
    if (!fn) throw new Error('未知接口 ' + method);
    const t0 = Date.now();
    try { return await fn(...(args || [])); } catch (e) {
      logger.child('ipc').error(`接口 ${method} 出错`, e);
      throw e;
    } finally {
      // 记录慢接口，便于定位“卡顿”（大批量文件时）
      const ms = Date.now() - t0;
      if (ms > 1000 && !['selectDir', 'selectFiles', 'saveFile', 'confirm'].includes(method)) logger.child('ipc').warn(`接口 ${method} 耗时 ${ms}ms`);
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
// 退出时结束程序启动的全部外部进程（PowerShell / Word / PowerPoint / LibreOffice / pdftoppm / ffmpeg / AI 脚本），
// app.exit()（切换数据目录后重启）不触发 will-quit，由 process 'exit' 兜底
const killChildren = () => { try { require('./core/procs').killAll(); } catch { /* ignore */ } };
app.on('will-quit', killChildren);
process.on('exit', killChildren);
app.on('window-all-closed', () => {
  if (booting) return; // 启动选择数据目录的窗口关闭后才创建主窗口
  if (logger) logger.child('app').info('程序退出');
  killChildren();
  if (service) service.close();
  app.quit();
});
