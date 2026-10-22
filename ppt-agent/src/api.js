// 渲染进程与主进程之间的接口封装
const bridge = window.ppta;

export const api = new Proxy({}, {
  get: (_t, method) => (...args) => {
    if (!bridge) return Promise.reject(new Error('请在 PPT智能体 桌面程序中运行'));
    // 去掉 Electron 附加的“Error invoking remote method …”前缀，只保留可读的错误信息
    return bridge.call(method, ...args).catch((e) => { throw new Error(String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); });
  },
});

export const on = (channel, cb) => (bridge ? bridge.on(channel, cb) : () => {});

export const assetUrl = (kind, rel) => (rel ? `ppta://${kind}/${String(rel).split('/').map(encodeURIComponent).join('/')}` : '');

export const fmtSize = (n) => {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
};

export const fmtTime = (t) => (t ? new Date(t).toLocaleString('zh-CN', { hour12: false }) : '');

export const fmtDur = (s) => {
  s = Math.round(s || 0);
  const m = Math.floor(s / 60), r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
};

export const THEME_LABEL = { dark: '黑底', light: '白底', mixed: '黑白混合' };
export const ACTION_LABEL = { parsed: '已解析', skipped: '已解析过·跳过', duplicate: '重复文件', failed: '失败', removed: '原文件已删除·移出', running: '解析中' };
export const STATUS_LABEL = { draft: '待解析', pending: '排队中', paused: '已暂停', running: '解析中', done: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断' };
export const KIND_LABEL = { ppt: 'PPT', word: 'Word' };
export const unitOf = (f) => (f && f.kind === 'word' ? '节' : '页');
