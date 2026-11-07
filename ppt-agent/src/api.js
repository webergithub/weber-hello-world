// 渲染进程与主进程之间的接口封装
const bridge = window.ppta;

// 正在进行的接口调用（v3.8）：超过 0.3 秒的显示“正在加载…”提示（对话框、轮询类接口除外）
const NO_BUSY = new Set(['selectDir', 'selectFiles', 'saveFile', 'confirm', 'selectScript', 'queueState', 'tasks', 'pluginState', 'logTail', 'clientLog', 'search', 'pluginCheck', 'pluginEnable', 'userActivity', 'memInfo', 'officeProcs', 'pptAgentTest', 'pptAgentTasks']);
const inflight = new Map();
let callSeq = 0;
const busySubs = new Set();
const busyEmit = () => { for (const f of busySubs) f(); };
export const busy = {
  subscribe: (f) => { busySubs.add(f); return () => busySubs.delete(f); },
  oldest: () => { let o = null; for (const c of inflight.values()) if (!o || c.t0 < o.t0) o = c; return o; },
};

export const api = new Proxy({}, {
  get: (_t, method) => (...args) => {
    if (!bridge) return Promise.reject(new Error('请在 PPT智能体 桌面程序中运行'));
    const track = !NO_BUSY.has(method);
    const id = ++callSeq;
    if (track) { inflight.set(id, { method, t0: Date.now() }); busyEmit(); }
    // 去掉 Electron 附加的“Error invoking remote method …”前缀，只保留可读的错误信息
    return bridge.call(method, ...args).catch((e) => { throw new Error(String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); })
      .finally(() => { if (track) { inflight.delete(id); busyEmit(); } });
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
export const ACTION_LABEL = { pending: '待处理', parsed: '已解析', skipped: '已解析过·跳过', duplicate: '重复文件', failed: '失败', removed: '原文件已删除·移出', running: '解析中' };
export const STATUS_LABEL = { draft: '待解析', pending: '排队中', paused: '已暂停', pausing: '暂停中…', running: '解析中', done: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断' };
/** 任务是否仍在执行（解析中或正在暂停）：进度条、解析动态等按此显示；暂停 / 继续按钮仍按具体状态判断 */
export const isActive = (t) => !!t && (t.status === 'running' || t.status === 'pausing');
export const KIND_LABEL = { ppt: 'PPT', word: 'Word', pdf: 'PDF' };
/** 页面宽高比：版式 → 文档页面尺寸（PDF 等）→ 16:9 */
export const slideRatio = (s, f) => (s && s.layout ? s.layout.w / s.layout.h : f && f.meta && f.meta.slideSize && f.meta.slideSize.cy ? f.meta.slideSize.cx / f.meta.slideSize.cy : 16 / 9);
export const KIND_ICON = { ppt: '🖼', word: '📄', pdf: '📕' };
export const unitOf = (f) => (f && f.kind === 'word' ? '节' : '页');
