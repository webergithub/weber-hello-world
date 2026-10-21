import { useMemo } from 'react';
import { useApp } from './ctx';

// 逐页浏览 / 对比窗口的快捷键：动作 → 按键组合（可在设置中自定义，保存在 config.keymap）
// 按键组合写法：修饰键按 Ctrl、Alt、Shift 顺序，用 + 连接，如 "Shift+ArrowRight"、"Ctrl+Home"、"F"、"Space"

export const ACTIONS = [
  { key: 'next', label: '下一页（到末页自动进入下一个文件）', group: '翻页' },
  { key: 'prev', label: '上一页（到首页自动进入上一个文件）', group: '翻页' },
  { key: 'next5', label: '向后跳 5 页', group: '翻页' },
  { key: 'prev5', label: '向前跳 5 页', group: '翻页' },
  { key: 'first', label: '首页', group: '翻页' },
  { key: 'last', label: '末页', group: '翻页' },
  { key: 'nextFile', label: '下一个文件（对比窗口：下一个窗格）', group: '文件' },
  { key: 'prevFile', label: '上一个文件（对比窗口：上一个窗格）', group: '文件' },
  { key: 'nextFile5', label: '向后跳 5 个文件', group: '文件' },
  { key: 'prevFile5', label: '向前跳 5 个文件', group: '文件' },
  { key: 'firstFile', label: '第一个文件', group: '文件' },
  { key: 'lastFile', label: '最后一个文件', group: '文件' },
  { key: 'max', label: '最大化 / 还原窗口', group: '窗口' },
  { key: 'full', label: '全屏', group: '窗口' },
  { key: 'panes', label: '显示 / 隐藏讲解词与 MD', group: '窗口' },
  { key: 'layout', label: '切换布局（上1下2 / 左1右2；对比窗口：并排 / 田字格）', group: '窗口' },
  { key: 'rail', label: '显示 / 隐藏相关推荐栏', group: '窗口' },
  { key: 'back', label: '返回（点击推荐跳转前的页面）', group: '其他' },
  { key: 'basket', label: '加入 / 移出导出篮', group: '其他' },
  { key: 'close', label: '还原 / 关闭', group: '其他' },
  { key: 'link', label: '对比：开关“一起翻页”', group: '对比窗口' },
  { key: 'paneNext', label: '对比：只让当前窗格后翻一页（跳过一页）', group: '对比窗口' },
  { key: 'panePrev', label: '对比：只让当前窗格前翻一页', group: '对比窗口' },
  { key: 'align', label: '对比：按标题对齐到当前窗格的页面', group: '对比窗口' },
  { key: 'pane1', label: '对比：选中第 1 个窗格', group: '对比窗口' },
  { key: 'pane2', label: '对比：选中第 2 个窗格', group: '对比窗口' },
  { key: 'pane3', label: '对比：选中第 3 个窗格', group: '对比窗口' },
  { key: 'pane4', label: '对比：选中第 4 个窗格', group: '对比窗口' },
];

export const DEFAULT_KEYMAP = {
  next: ['ArrowRight', 'PageDown'],
  prev: ['ArrowLeft', 'PageUp'],
  next5: ['Shift+ArrowRight'],
  prev5: ['Shift+ArrowLeft'],
  first: ['Ctrl+ArrowLeft', 'Home'],
  last: ['Ctrl+ArrowRight', 'End'],
  nextFile: ['ArrowDown'],
  prevFile: ['ArrowUp'],
  nextFile5: ['Shift+ArrowDown'],
  prevFile5: ['Shift+ArrowUp'],
  firstFile: ['Ctrl+Home'],
  lastFile: ['Ctrl+End'],
  max: ['Enter', 'F'],
  full: ['Shift+F'],
  panes: ['N'],
  layout: ['L'],
  rail: ['R'],
  back: ['Backspace'],
  basket: ['Space'],
  close: ['Escape'],
  link: ['K'],
  paneNext: ['Alt+ArrowRight'],
  panePrev: ['Alt+ArrowLeft'],
  align: ['A'],
  pane1: ['1'],
  pane2: ['2'],
  pane3: ['3'],
  pane4: ['4'],
};

// 预设：在默认基础上整体替换
export const PRESETS = [
  { key: 'default', label: '默认：← → 翻页 · ↑ ↓ 切换文件', map: DEFAULT_KEYMAP },
  {
    key: 'vertical',
    label: '↑ ↓ 翻页 · ← → 切换文件',
    map: (() => {
      const m = {};
      const lr2ud = (cs) => cs.map((c) => c.replace(/ArrowRight/, 'ArrowDown').replace(/ArrowLeft/, 'ArrowUp'));
      const ud2lr = (cs) => cs.map((c) => c.replace(/ArrowDown/, 'ArrowRight').replace(/ArrowUp/, 'ArrowLeft'));
      for (const [k, v] of Object.entries(DEFAULT_KEYMAP)) {
        if (['next', 'prev', 'next5', 'prev5', 'first', 'last', 'paneNext', 'panePrev'].includes(k)) m[k] = lr2ud(v);
        else if (['nextFile', 'prevFile', 'nextFile5', 'prevFile5'].includes(k)) m[k] = ud2lr(v);
        else m[k] = [...v];
      }
      return m;
    })(),
  },
];

/** 合并用户自定义（只保存与默认不同的动作）与默认值 */
export function resolveKeymap(custom) {
  const m = {};
  for (const a of ACTIONS) m[a.key] = custom && Array.isArray(custom[a.key]) ? custom[a.key] : DEFAULT_KEYMAP[a.key];
  return m;
}

/** 只保留与默认不同的部分，便于以后默认值升级 */
export function diffKeymap(map) {
  const out = {};
  for (const a of ACTIONS) {
    const v = map[a.key] || [];
    if (JSON.stringify(v) !== JSON.stringify(DEFAULT_KEYMAP[a.key])) out[a.key] = v;
  }
  return out;
}

const MOD_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'CapsLock', 'NumLock', 'ScrollLock', 'Fn', 'OS']);
/** 键盘事件 → 组合字符串；纯修饰键返回 null */
export function comboOf(e) {
  if (MOD_KEYS.has(e.key)) return null;
  let k;
  if (e.code && /^Key[A-Z]$/.test(e.code)) k = e.code.slice(3);
  else if (e.code && /^Digit\d$/.test(e.code)) k = e.code.slice(5);
  else if (e.code && /^Numpad\d$/.test(e.code)) k = e.code.slice(6);
  else if (e.key === ' ' || e.code === 'Space') k = 'Space';
  else k = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  const mods = [];
  if (e.ctrlKey || e.metaKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  return [...mods, k].join('+');
}

/** 建立 组合 → 动作 的查找表 */
export function buildLookup(map) {
  const lut = new Map();
  for (const a of ACTIONS) for (const c of map[a.key] || []) if (!lut.has(c)) lut.set(c, a.key);
  return lut;
}

const KEY_LABEL = { ArrowRight: '→', ArrowLeft: '←', ArrowUp: '↑', ArrowDown: '↓', Space: '空格', Escape: 'Esc', PageUp: 'PgUp', PageDown: 'PgDn', Enter: 'Enter', Delete: 'Del', Backspace: '退格' };
export const comboLabel = (c) => String(c).split('+').map((p) => KEY_LABEL[p] || p).join('+');
export const keysLabel = (map, action, n = 2) => (map[action] || []).slice(0, n).map(comboLabel).join(' / ') || '未设置';

/** 浏览窗口底部的按键提示（根据当前按键设置生成） */
export function viewerHint(map, { compare = false } = {}) {
  const k = (a) => keysLabel(map, a);
  const kp = (a, b) => `${keysLabel(map, a, 1)} ${keysLabel(map, b, 1)}`;
  const parts = compare
    ? [
      `${kp('prev', 'next')} 一起翻页（关闭联动时只翻选中窗格）`,
      `${kp('panePrev', 'paneNext')} 只翻选中窗格（跳过一页）`,
      `${kp('first', 'last')} 首/末页`,
      `${kp('prevFile', 'nextFile')} 切换选中窗格`,
      `${keysLabel(map, 'pane1', 1)}–${keysLabel(map, 'pane4', 1)} 选中窗格`,
      `${k('link')} 开关一起翻页`,
      `${k('align')} 按标题对齐`,
      `${k('panes')} 讲解词`,
      `${k('layout')} 并排/田字格`,
      `${k('full')} 全屏`,
      `${k('basket')} 导出篮`,
      `${k('close')} 关闭`,
    ]
    : [
      `${kp('prev', 'next')} 翻页（到末页自动进入下一个文件）`,
      `${kp('prev5', 'next5')} 跳 5 页`,
      `${kp('first', 'last')} 首/末页`,
      `${kp('prevFile', 'nextFile')} 上/下一个文件（${kp('prevFile5', 'nextFile5')} 跳 5 个）`,
      `${kp('firstFile', 'lastFile')} 第一个/最后一个文件`,
      `${k('max')} 最大化`,
      `${k('full')} 全屏`,
      `${k('panes')} 显示/隐藏讲解词与 MD`,
      `${k('layout')} 切换上1下2/左1右2`,
      `${k('rail')} 相关推荐栏`,
      `${k('back')} 返回推荐前的页面`,
      '拖动模块标题栏可交换位置，拖动分隔条调整大小',
      `${k('basket')} 加入/移出导出篮`,
      `${k('close')} 还原/关闭`,
    ];
  return parts.join(' · ');
}

/** 输入框中不响应浏览快捷键 */
export const isTyping = (t) => !!(t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable));

/** 当前生效的按键设置：{ map: 动作→组合[], lut: 组合→动作 } */
export function useKeymap() {
  const app = useApp();
  const custom = app && app.config ? app.config.keymap : null;
  return useMemo(() => { const map = resolveKeymap(custom); return { map, lut: buildLookup(map) }; }, [custom]);
}
