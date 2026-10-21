import React, { useEffect, useState } from 'react';
import { api } from '../api';
import { useApp } from '../ctx';
import { ACTIONS, PRESETS, DEFAULT_KEYMAP, resolveKeymap, diffKeymap, comboOf, comboLabel } from '../keymap';

// 设置 → 快捷键：每个动作可绑定多个按键组合；点击“＋”后按下新组合即可录制；修改立即保存
export default function KeymapEditor() {
  const app = useApp();
  const [map, setMap] = useState(() => resolveKeymap(app.config && app.config.keymap));
  const [rec, setRec] = useState(null);
  useEffect(() => { setMap(resolveKeymap(app.config && app.config.keymap)); }, [app.config && app.config.keymap]);

  const save = async (next, msg = '快捷键已保存') => {
    setMap(next);
    try { const c = await api.setConfig({ keymap: diffKeymap(next) }); app.setConfig(c); app.toast(msg); } catch (e) { app.toast(e.message, 'error'); }
  };
  const label = (k) => (ACTIONS.find((a) => a.key === k) || {}).label || k;

  useEffect(() => {
    if (!rec) return undefined;
    const k = (e) => {
      e.preventDefault(); e.stopPropagation();
      if (e.key === 'Escape' && !e.shiftKey && !e.ctrlKey && !e.altKey) { setRec(null); return; }
      const c = comboOf(e);
      if (!c) return;
      setRec(null);
      const owner = Object.keys(map).find((a) => a !== rec && (map[a] || []).includes(c));
      if (owner && !confirm(`按键 ${comboLabel(c)} 已用于「${label(owner)}」。\n改为用于「${label(rec)}」？`)) return;
      const next = { ...map };
      if (owner) next[owner] = next[owner].filter((x) => x !== c);
      if (!(next[rec] || []).includes(c)) next[rec] = [...(next[rec] || []), c];
      save(next);
    };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, [rec, map]);

  const groups = [...new Set(ACTIONS.map((a) => a.group))];
  const changed = Object.keys(diffKeymap(map)).length;
  return (
    <div className="keymap">
      <div className="row wrap">
        <span className="muted">预设方案：</span>
        {PRESETS.map((p) => <button key={p.key} className={`btn small ${JSON.stringify(resolveKeymap(p.map)) === JSON.stringify(map) ? 'primary' : ''}`} onClick={() => save(resolveKeymap(p.map), `已切换为：${p.label}`)}>{p.label}</button>)}
        <div className="spacer" />
        <span className="muted small">{changed ? `已自定义 ${changed} 项` : '当前为默认设置'}</span>
        <button className="btn small ghost" disabled={!changed} onClick={() => confirm('恢复全部快捷键为默认？') && save(resolveKeymap(DEFAULT_KEYMAP), '已恢复默认快捷键')}>↺ 全部恢复默认</button>
      </div>
      {rec && <div className="notice">正在为「{label(rec)}」录制按键：请按下新的按键组合（可带 Ctrl / Alt / Shift），Esc 取消</div>}
      <table className="grid km-table">
        <thead><tr><th>分组</th><th>动作</th><th>按键</th><th /></tr></thead>
        <tbody>
          {groups.flatMap((g) => ACTIONS.filter((a) => a.group === g).map((a, i) => {
            const cur = map[a.key] || [];
            const dirty = JSON.stringify(cur) !== JSON.stringify(DEFAULT_KEYMAP[a.key]);
            return (
              <tr key={a.key} className={rec === a.key ? 'row-sel' : ''} data-action={a.key}>
                <td className="muted small">{i === 0 ? g : ''}</td>
                <td>{a.label}{dirty && <span className="tag warn">已修改</span>}</td>
                <td className="km-keys">
                  {cur.map((c) => <span key={c} className="kbd">{comboLabel(c)}<b title="移除" onClick={() => save({ ...map, [a.key]: cur.filter((x) => x !== c) })}>×</b></span>)}
                  {!cur.length && <span className="muted small">未设置</span>}
                </td>
                <td className="nowrap">
                  <button className="btn tiny" onClick={() => setRec(rec === a.key ? null : a.key)}>{rec === a.key ? '取消' : '＋ 添加按键'}</button>
                  <button className="btn tiny ghost" disabled={!dirty} onClick={() => save({ ...map, [a.key]: [...DEFAULT_KEYMAP[a.key]] })}>默认</button>
                </td>
              </tr>
            );
          }))}
        </tbody>
      </table>
    </div>
  );
}
