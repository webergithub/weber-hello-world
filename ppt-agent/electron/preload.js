'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ppta', {
  call: (method, ...args) => ipcRenderer.invoke('api', method, args),
  // 启动时选择数据目录（资料库服务创建之前，只在启动窗口中可用）
  boot: (method, ...args) => ipcRenderer.invoke('boot', method, args),
  on: (channel, cb) => {
    if (!['task', 'taskBatch', 'log', 'embedding', 'progress', 'progressBatch', 'library', 'systemTheme', 'watch', 'plugin'].includes(channel)) return () => {};
    const h = (_e, data) => cb(data);
    ipcRenderer.on(channel, h);
    return () => ipcRenderer.removeListener(channel, h);
  },
  platform: process.platform,
});
