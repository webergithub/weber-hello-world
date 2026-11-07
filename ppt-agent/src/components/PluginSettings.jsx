import React, { useState } from 'react';
import { api } from '../api';
import { useApp } from '../ctx';

const FIELDS = ['script', 'args', 'timeout'];
// 用途开关：改了立即保存（不需要重新检查脚本）
const USES = [['auto', '解析完成的文档自动生成智能总结'], ['useForSearch', '用于智能搜索（扩展查询关键词）'], ['useForGenerate', '用于智能生成（理解需求、提取关键词）']];

/**
 * 设置 → PPT_Agent → AI 调用脚本（v3.7 智能总结脚本，v3.9 抽象为 AI 调用模块，智能总结 / 智能搜索 / 智能生成共用）。
 * 脚本、参数、超时；“生效”先检查（用示例文档试运行一次），通过后才生效；改了脚本 / 参数 / 超时要重新点“生效”；
 * 用途开关（自动总结、用于智能搜索、用于智能生成）改了立即保存。
 */
export default function PluginSettings() {
  const app = useApp();
  const saved = ((app.config && app.config.plugins) || {}).summary || {};
  const [pl, setPl] = useState(() => ({ script: saved.script || '', args: saved.args || '"{input}" "{output}"', timeout: saved.timeout || 300 }));
  // 用途开关先在界面上立即切换，再保存
  const [uses, setUses] = useState(() => ({ auto: saved.auto !== false, useForSearch: !!saved.useForSearch, useForGenerate: !!saved.useForGenerate }));
  const [busy, setBusy] = useState('');
  const [result, setResult] = useState(null);
  const set = (p) => setPl((x) => ({ ...x, ...p }));
  const dirty = FIELDS.some((k) => String(pl[k]) !== String(saved[k] ?? (k === 'args' ? '"{input}" "{output}"' : k === 'timeout' ? 300 : '')));
  const enabled = !!saved.enabled;
  const refresh = async () => app.setConfig(await api.getConfig());
  const check = async () => {
    setBusy('check');
    try { const r = await api.pluginCheck(pl); setResult(r); app.toast(r.ok ? `脚本检查通过（${r.ms}ms）` : `脚本检查未通过：${r.error}`, r.ok ? 'info' : 'error', { cat: '插件' }); } finally { setBusy(''); }
  };
  const toggle = async (on) => {
    setBusy(on ? 'on' : 'off');
    try {
      const r = await api.pluginEnable(on, pl);
      if (on) setResult(r);
      await refresh();
      app.toast(on ? (r.enabled ? 'AI 调用脚本已生效' : `未能生效：${r.error}`) : 'AI 调用脚本已失效（不再执行）', on && !r.enabled ? 'error' : 'info', { cat: '插件' });
    } catch (e) { app.toast(e.message, 'error'); } finally { setBusy(''); }
  };
  return (
    <div className="plugin-settings">
      <div className="row"><label>脚本</label>
        <input className="input grow" value={pl.script} placeholder="选择 .js / .py / .ps1 / .bat / .exe" onChange={(e) => set({ script: e.target.value })} />
        <button className="btn" onClick={async () => { const p = await api.selectScript(); if (p) set({ script: p }); }}>📁 选择…</button>
        <button className="btn ghost" onClick={async () => set({ script: await api.pluginExample() })}>使用示例脚本</button>
      </div>
      <div className="row"><label>参数</label><input className="input grow" value={pl.args} onChange={(e) => set({ args: e.target.value })} /></div>
      <div className="row"><label>超时</label><input className="input split-par" type="number" min="5" max="3600" value={pl.timeout} onChange={(e) => set({ timeout: Math.max(5, Math.min(3600, Number(e.target.value) || 300)) })} /> <span className="muted">秒</span></div>
      <div className="row"><label>用于</label>
        <div className="plugin-uses">{USES.map(([k, label]) => (
          <label key={k} className="chk"><input type="checkbox" checked={!!uses[k]} onChange={async (e) => { const v = e.target.checked; setUses((u) => ({ ...u, [k]: v })); app.setConfig(await api.setConfig({ plugins: { summary: { [k]: v } } })); }} /> {label}</label>
        ))}</div>
      </div>
      <div className="row"><label>状态</label>
        <div className="seg plugin-switch">
          <button className={enabled ? 'on' : ''} disabled={!!busy || !pl.script} onClick={() => toggle(true)}>{busy === 'on' ? '检查中…' : '● 生效'}</button>
          <button className={!enabled ? 'on' : ''} disabled={!!busy || !enabled} onClick={() => toggle(false)}>○ 失效</button>
        </div>
        <button className="btn" disabled={!!busy || !pl.script} onClick={check}>{busy === 'check' ? '检查中…' : '🔍 检查脚本'}</button>
        {enabled && dirty && <span className="tag warn">修改尚未生效</span>}
        <button className="btn ghost" onClick={() => app.go({ type: 'plugins' })}>🤖 打开 PPT_Agent</button>
      </div>
      {result && <div className={`plugin-check ${result.ok ? 'ok' : 'bad'}`}>{result.ok ? `✔ 检查通过（${result.ms}ms）` : `✖ ${result.error}`}{result.ok && result.preview ? <pre>{result.preview}</pre> : null}</div>}
    </div>
  );
}
