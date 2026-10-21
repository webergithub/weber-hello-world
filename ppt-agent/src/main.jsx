import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

window.addEventListener('error', (e) => { try { window.ppta && window.ppta.call('clientLog', 'error', `界面错误：${e.message}`); } catch { /* ignore */ } });
createRoot(document.getElementById('root')).render(<App />);
