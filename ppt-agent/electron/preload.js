'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ppta', {
  call: (method, ...args) => ipcRenderer.invoke('api', method, args),
  on: (channel, cb) => {
    if (!['task', 'log', 'embedding', 'progress', 'systemTheme', 'watch'].includes(channel)) return () => {};
    const h = (_e, data) => cb(data);
    ipcRenderer.on(channel, h);
    return () => ipcRenderer.removeListener(channel, h);
  },
  platform: process.platform,
});
