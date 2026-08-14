// 预加载脚本：通过 contextBridge 安全地把原生能力暴露给网页。
// 网页里用 window.electronAPI.pickFile() 打开系统「选择文件」对话框。
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  pickFile: () => ipcRenderer.invoke('pick-file'),
  revealPath: (p) => ipcRenderer.invoke('reveal-path', p),
});
