import React, { useState } from 'react';
import { api } from '../api';
import { useApp } from '../ctx';

const EFFORTS = [['off', '关闭（更快）'], ['low', '低'], ['high', '高'], ['max', '最高']];

/**
 * 设置 → PPT_Agent（v3.11）：大模型接入层沿用 DeepSeek Harness（DeepSeek Messages 接口）。
 * “允许连接大模型接口”默认关闭，打开时二次确认（会把文档内容发给接口地址）；开关、调用方式、自动总结改了立即保存；
 * 接口地址 / 模型 / API Key / 推理强度 / 超时 / 轮询间隔 / 提示词点“保存”；API Key 只写不读（加密保存，界面只显示是否已保存）。
 */
export default function PptAgentSettings() {
  const app = useApp();
  const pa = (app.config && app.config.pptAgent) || {};
  const llm = pa.llm || {};
  const ai = (app.config && app.config.ai) || {};
  const models = (ai.llm && ai.llm.models) || ['deepseek-flash', 'deepseek-v4-pro'];
  const defBase = (ai.llm && ai.llm.defaultBaseURL) || 'https://api.deepseek.com/anthropic';
  const [f, setF] = useState(() => ({ baseURL: llm.baseURL || defBase, model: llm.model || models[0], reasoningEffort: llm.reasoningEffort || 'off', timeoutSec: llm.timeoutSec || 300, pollSec: pa.pollSec || 30, prompt: pa.prompt || '' }));
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState('');
  const [result, setResult] = useState(null);
  const set = (p) => setF((x) => ({ ...x, ...p }));
  const apply = async (patch, msg) => {
    try { app.setConfig(await api.pptAgentSetConfig(patch)); if (msg) app.toast(msg, 'info', { cat: 'PPT_Agent' }); } catch (e) { app.toast(e.message, 'error'); }
  };
  const host = (() => { try { return new URL(f.baseURL).host; } catch { return f.baseURL; } })();
  const toggleNet = async (on) => {
    if (on && !confirm(`允许 PPT_Agent 连接大模型接口？\n\n打开后，PPT_Agent 会把要总结的文档内容（页面标题、正文、讲解词）发送到：\n${host}\n\n其他功能仍不联网；可随时关闭。`)) return;
    await apply({ allowNetwork: on }, on ? `已允许连接大模型接口（${host}）` : '已关闭大模型接口连接');
  };
  const save = async () => {
    setBusy('save');
    const patch = { llm: { baseURL: f.baseURL.trim() || defBase, model: f.model.trim(), reasoningEffort: f.reasoningEffort, timeoutSec: Math.max(10, Math.min(3600, Number(f.timeoutSec) || 300)) }, pollSec: Math.max(5, Math.min(3600, Number(f.pollSec) || 30)), prompt: f.prompt };
    if (key.trim()) patch.llm.apiKey = key.trim();
    await apply(patch, 'PPT_Agent 设置已保存');
    setKey('');
    setBusy('');
  };
  const test = async () => {
    setBusy('test');
    try {
      const r = await api.pptAgentTest({ baseURL: f.baseURL.trim(), model: f.model.trim(), reasoningEffort: f.reasoningEffort, ...(key.trim() ? { apiKey: key.trim() } : {}) });
      setResult(r);
      app.toast(r.ok ? `连接成功（${r.ms}ms）：${r.reply}` : `连接失败：${r.error}`, r.ok ? 'info' : 'error', { cat: 'PPT_Agent' });
    } finally { setBusy(''); }
  };
  const mode = ai.mode || 'llm';
  return (
    <div className="agent-settings plugin-settings">
      <div className="row"><label>联网</label>
        <div className="seg plugin-switch">
          <button className={pa.allowNetwork ? 'on' : ''} onClick={() => !pa.allowNetwork && toggleNet(true)}>● 允许连接大模型接口</button>
          <button className={!pa.allowNetwork ? 'on' : ''} onClick={() => pa.allowNetwork && toggleNet(false)}>○ 不联网</button>
        </div>
        {pa.allowNetwork ? <span className="tag warn">会向 {host} 发送文档内容</span> : null}
      </div>
      <div className="row"><label>调用方式</label>
        <div className="seg">
          <button className={mode === 'llm' ? 'on' : ''} onClick={() => apply({ engine: 'llm' })}>大模型接口</button>
          <button className={mode === 'script' ? 'on' : ''} onClick={() => apply({ engine: 'script' })}>AI 调用脚本</button>
        </div>
        <span className={`tag ${ai.ok ? 'ok' : 'warn'}`}>{ai.ok ? `可用：${ai.model}` : '不可用'}</span>
      </div>
      {!ai.ok && ai.reason && <div className="row"><label /><span className="small muted">{ai.reason}</span></div>}
      <div className="row"><label>接口地址</label><input className="input grow" value={f.baseURL} onChange={(e) => set({ baseURL: e.target.value })} />
        {f.baseURL !== defBase && <button className="btn ghost small" onClick={() => set({ baseURL: defBase })}>恢复 DeepSeek 官方</button>}</div>
      <div className="row"><label>模型</label>
        <input className="input" list="agent-models" value={f.model} onChange={(e) => set({ model: e.target.value })} />
        <datalist id="agent-models">{models.map((m) => <option key={m} value={m} />)}</datalist>
        <label>推理</label>
        <select className="input" value={f.reasoningEffort} onChange={(e) => set({ reasoningEffort: e.target.value })}>{EFFORTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
      </div>
      <div className="row"><label>API Key</label>
        <input className="input grow" type="password" autoComplete="off" value={key} placeholder={llm.hasApiKey ? '已保存（加密，不显示）；输入新的 Key 可替换' : '在 DeepSeek 开放平台创建的 API Key'} onChange={(e) => setKey(e.target.value)} />
        {llm.hasApiKey && <button className="btn ghost small" onClick={() => confirm('清除已保存的 API Key？') && apply({ llm: { apiKey: '' } }, '已清除 API Key')}>清除</button>}
      </div>
      <div className="row"><label>超时</label><input className="input split-par" type="number" min="10" max="3600" value={f.timeoutSec} onChange={(e) => set({ timeoutSec: e.target.value })} /> <span className="muted">秒 / 文档</span>
        <label>轮询间隔</label><input className="input split-par" type="number" min="5" max="3600" value={f.pollSec} onChange={(e) => set({ pollSec: e.target.value })} /> <span className="muted">秒</span></div>
      <div className="row"><label>用于</label>
        <label className="chk"><input type="checkbox" checked={!!pa.auto} onChange={(e) => apply({ auto: e.target.checked })} /> 解析完成的文档自动总结入库（大模型接口）</label>
      </div>
      <div className="row top"><label>总结提示词</label><textarea className="input grow" rows={3} value={f.prompt} placeholder="留空使用内置提示词（标题 / 一句话概要 / 核心要点 / 各部分摘要 / 关键词）" onChange={(e) => set({ prompt: e.target.value })} /></div>
      <div className="row"><label />
        <button className="btn primary" disabled={!!busy} onClick={save}>{busy === 'save' ? '保存中…' : '💾 保存'}</button>
        <button className="btn" disabled={!!busy || !pa.allowNetwork || !(key.trim() || llm.hasApiKey)} onClick={test}>{busy === 'test' ? '连接中…' : '🔌 测试连接'}</button>
        <button className="btn ghost" onClick={() => app.go({ type: 'plugins' })}>🤖 打开 PPT_Agent</button>
      </div>
      {result && <div className={`plugin-check ${result.ok ? 'ok' : 'bad'}`}>{result.ok ? `✔ 连接成功（${result.ms}ms）：${result.reply}` : `✖ ${result.error}`}</div>}
    </div>
  );
}
