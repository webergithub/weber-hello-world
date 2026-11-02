import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import StartupDataDir from './components/DataDirDialog';
import './styles.css';

window.addEventListener('error', (e) => { try { window.ppta && window.ppta.call('clientLog', 'error', `界面错误：${e.message}`); } catch { /* ignore */ } });
// 启动时先在单独的窗口中选择数据目录（#boot-datadir），选定后主进程再创建资料库与主窗口
createRoot(document.getElementById('root')).render(location.hash === '#boot-datadir' ? <StartupDataDir /> : <App />);
