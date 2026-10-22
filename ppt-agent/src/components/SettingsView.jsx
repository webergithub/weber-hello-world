import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useApp } from '../ctx';
import KeymapEditor from './KeymapEditor';
import WatchSettings from './WatchSettings';
import { LANG_NAMES } from './Panels';

const LLM_PRESETS = [
  { key: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { key: 'qwen', label: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { key: 'kimi', label: 'Kimi', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  { key: 'glm', label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  { key: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { key: 'ollama', label: '本地 Ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b' },
];

export default function SettingsView({ focus }) {
  const app = useApp();
  const keysRef = useRef(null);
  const watchRef = useRef(null);
  const agentRef = useRef(null);
  const [cfg, setCfg] = useState(null);
  const [eng, setEng] = useState(null);
  const [stats, setStats] = useState(null);
  const [embProg, setEmbProg] = useState(null);
  const [types, setTypes] = useState([]);
  const [dd, setDd] = useState(null);
  const [newDir, setNewDir] = useState('');
  useEffect(() => { api.getConfig().then(setCfg); api.engines(false).then(setEng); api.stats().then(setStats); api.docTypes().then(setTypes); api.dataDirInfo().then(setDd); }, []);
  useEffect(() => { const r = focus === 'keys' ? keysRef : focus === 'watch' ? watchRef : focus === 'agent' ? agentRef : null; if (cfg && r && r.current) r.current.scrollIntoView({ block: 'start' }); }, [!!cfg, focus]);
  if (!cfg) return null;
  const set = (patch) => setCfg({ ...cfg, ...patch });
  const setL = (patch) => setCfg({ ...cfg, llm: { ...cfg.llm, ...patch } });
  const setE = (patch) => setCfg({ ...cfg, embedding: { ...cfg.embedding, ...patch } });
  const save = async () => { const c = await api.setConfig(cfg); setCfg(c); app.setConfig(c); app.toast('设置已保存'); };
  return (
    <div className="view">
      <div className="view-head"><div className="vh-title">⚙️ 设置</div><div className="spacer" /><button className="btn primary" onClick={save}>保存设置</button></div>
      <div className="tab-body scroll pad settings">
        <section>
          <h3>解析文档类型（多选）</h3>
          <p className="muted">选择要扫描、解析和检索的文档类型。修改后对之后开始的解析任务生效；已解析的文档仍可检索。</p>
          <div className="row wrap">
            {types.map((t) => {
              const on = (cfg.docTypes || []).includes(t.key);
              return (
                <label key={t.key} className={`type-chip ${on ? 'on' : ''}`}>
                  <input type="checkbox" checked={on} onChange={() => {
                    const next = on ? cfg.docTypes.filter((k) => k !== t.key) : [...(cfg.docTypes || []), t.key];
                    if (!next.length) { app.toast('至少保留一种文档类型', 'error'); return; }
                    set({ docTypes: next });
                  }} />
                  <b>{t.label}</b> <span className="muted small">{t.exts.join(' ')}</span>
                </label>
              );
            })}
          </div>
        </section>
        <section ref={watchRef} className={focus === 'watch' ? 'flash-sec' : ''}>
          <h3>定时监测更新（增量解析）</h3>
          <p className="muted">对开启监测的任务（如“本机全部文档”），每天在设定的时间自动重新扫描：新增的文档自动解析入库，修改过的文档重新解析并替换旧结果，原文件已删除的移入回收站（仅移出资料库，可还原），未变化的直接跳过。需要程序在运行（可最小化到右下角图标栏）。修改立即生效。</p>
          <WatchSettings />
        </section>
        <section>
          <h3>界面主题</h3>
          <div className="seg">
            {[['dark', '🌙 黑色'], ['light', '☀️ 白色'], ['system', '🖥 跟随系统']].map(([k, v]) => <button key={k} className={(cfg.uiTheme || 'system') === k ? 'on' : ''} onClick={() => { set({ uiTheme: k }); app.setTheme(k); }}>{v}</button>)}
          </div>
        </section>
        <section ref={keysRef} className={focus === 'keys' ? 'flash-sec' : ''}>
          <h3>快捷键（逐页浏览 / 对比窗口）</h3>
          <p className="muted">每个动作可设置多个按键组合；例如选择预设“↑ ↓ 翻页 · ← → 切换文件”即可用上下键翻 PPT 页、左右键切换文件。修改立即生效。</p>
          <KeymapEditor />
        </section>
        <section>
          <h3>关闭窗口时</h3>
          <div className="seg">
            {[['ask', '每次询问'], ['minimize', '最小化到右下角图标栏'], ['quit', '完全退出']].map(([k, v]) => <button key={k} className={(cfg.closeAction || 'ask') === k ? 'on' : ''} onClick={() => set({ closeAction: k })}>{v}</button>)}
          </div>
          <p className="muted small">在关闭提示框中勾选“记住我的选择”会自动设置这里；改完点击右上角“保存设置”生效。</p>
        </section>
        <section>
          <h3>数据保存目录（解析结果 · 数据库 · 本地 RAG 索引）</h3>
          <p className="muted">解析出的页面、Markdown、标签、全文索引与向量都保存在本地 SQLite 数据库中，检索完全在本机进行（本地 RAG）。可把数据目录放到空间更大的磁盘。切换后程序会自动重启。</p>
          {dd && <p>当前目录：<code>{dd.current}</code>{dd.env ? '（由环境变量 PPTA_DATA_DIR 指定）' : dd.bootstrap ? '（自定义）' : dd.portable ? '（便携版默认：exe 同级目录）' : '（默认）'}</p>}
          <div className="row"><label>新目录</label><input className="input wide" value={newDir} placeholder="选择或输入目录路径" onChange={(e) => setNewDir(e.target.value)} />
            <button className="btn" onClick={async () => { const r = await api.selectDir('选择数据保存目录', true); if (r && r[0]) setNewDir(r[0]); }}>浏览…</button></div>
          <div className="row"><label />
            <button className="btn primary" disabled={!newDir} onClick={async () => {
              if (!confirm(`把现有数据（数据库、Markdown、截图、日志）迁移到：\n${newDir}\n\n完成后程序将自动重启。`)) return;
              try { await api.setDataDir(newDir, 'migrate'); app.toast('正在迁移并重启…'); } catch (e) { app.toast(e.message, 'error'); }
            }}>迁移数据到新目录</button>
            <button className="btn" disabled={!newDir} onClick={async () => {
              if (!confirm(`直接使用目录：\n${newDir}\n（若该目录已有本工具的数据则沿用，否则从空库开始；原目录数据保留不动）`)) return;
              try { await api.setDataDir(newDir, 'use'); app.toast('正在切换并重启…'); } catch (e) { app.toast(e.message, 'error'); }
            }}>直接使用该目录</button>
            {dd && dd.bootstrap && <button className="btn ghost" onClick={() => confirm('恢复为默认数据目录并重启？') && api.resetDataDir()}>恢复默认</button>}
          </div>
        </section>
        <section>
          <h3>页面截图（PPT 原始页预览）</h3>
          <p className="muted">优先使用 PowerPoint 导出每页截图（保真度最高），其次 LibreOffice；均不可用时使用内置版式渲染。截图也会用于更准确地判断黑底/白底。</p>
          <div className="row"><label>截图引擎</label>
            <select className="input" value={cfg.thumbnails} onChange={(e) => set({ thumbnails: e.target.value })}>
              <option value="auto">自动（PowerPoint → LibreOffice）</option><option value="powerpoint">仅 PowerPoint</option><option value="libreoffice">仅 LibreOffice</option><option value="off">关闭（只用内置渲染，速度最快）</option>
            </select>
          </div>
          <div className="row"><label>截图宽度</label><input className="input" type="number" value={cfg.thumbWidth} onChange={(e) => set({ thumbWidth: Number(e.target.value) || 1280 })} /></div>
          {eng && <div className="engines">
            <span className={`tag ${eng.powerpoint ? 'ok' : ''}`}>PowerPoint：{eng.powerpoint ? '可用' : '未检测到'}</span>
            <span className={`tag ${eng.soffice ? 'ok' : ''}`}>LibreOffice：{eng.soffice || '未检测到'}</span>
            <span className={`tag ${eng.ffmpeg ? 'ok' : ''}`}>ffmpeg（仅提取字幕流）：{eng.ffmpeg || '未检测到'}</span>
            <button className="btn tiny" onClick={() => api.engines(true).then(setEng)}>重新检测</button>
          </div>}
        </section>
        <section ref={agentRef} className={focus === 'agent' ? 'flash-sec' : ''}>
          <h3>🤖 Agent 接口（大模型，OpenAI 兼容）</h3>
          <p className="muted">用于：讲解词生成、讲解词翻译（中文 / English / 小语种）、查询的中英文解析与扩展、自动打标签、RAG 回答、转换规则生成。应用中没有内置任何 API Key，所有调用都使用这里的配置；未配置时，讲解词生成（建设中）与翻译不可用，其余功能使用内置双语词表与 TF-IDF，完全离线。</p>
          <div className="row"><label>服务商</label>
            <div className="seg small wrap">{LLM_PRESETS.map((pr) => <button key={pr.key} className={cfg.llm.baseUrl === pr.baseUrl ? 'on' : ''} onClick={() => setL({ baseUrl: pr.baseUrl, model: pr.model })} title={pr.baseUrl}>{pr.label}</button>)}</div>
          </div>
          <div className="row"><label>启用</label><input type="checkbox" checked={cfg.llm.enabled} onChange={(e) => setL({ enabled: e.target.checked })} /></div>
          <div className="row"><label>接口地址</label><input className="input wide" value={cfg.llm.baseUrl} onChange={(e) => setL({ baseUrl: e.target.value })} /></div>
          <div className="row"><label>API Key</label><input className="input wide" type="password" value={cfg.llm.apiKey} placeholder="在服务商控制台创建的 API Key（本地 Ollama 可留空）" onChange={(e) => setL({ apiKey: e.target.value })} /></div>
          <div className="row"><label>模型</label><input className="input" value={cfg.llm.model} onChange={(e) => setL({ model: e.target.value })} />
            <button className="btn" onClick={async () => { try { const r = await api.testLlm(cfg.llm); app.toast(`连接成功（${r.ms}ms）：${r.reply}`); } catch (e) { app.toast('连接失败：' + e.message, 'error'); } }}>测试连接</button></div>
          <div className="row"><label>用于查询解析</label><input type="checkbox" checked={cfg.llm.useForQuery} onChange={(e) => setL({ useForQuery: e.target.checked })} /></div>
          <div className="row"><label>用于打标签</label><input type="checkbox" checked={cfg.llm.useForTags} onChange={(e) => setL({ useForTags: e.target.checked })} /><span className="muted small">（解析 / 重算标签时调用，每个文件一次）</span></div>
          <h4>讲解词翻译</h4>
          <p className="muted small">译文只保存在应用知识库，不会改动原文件；需要时在讲解词模块手动点击“写入 PPT 备注”（确认后先备份再写入）。</p>
          <div className="row"><label>常用小语种</label>
            <div className="row wrap" style={{ margin: 0 }}>{Object.entries(LANG_NAMES).filter(([k]) => k !== 'zh' && k !== 'en').map(([k, v]) => {
              const on = (cfg.minorLangs || []).includes(k);
              return <label key={k} className={`type-chip small ${on ? 'on' : ''}`}><input type="checkbox" checked={on} onChange={() => set({ minorLangs: on ? cfg.minorLangs.filter((x) => x !== k) : [...(cfg.minorLangs || []), k] })} />{v}</label>;
            })}</div>
          </div>
          <p className="muted small">修改后点击右上角“保存设置”生效。</p>
        </section>
        <section>
          <h3>语义向量（可选，增强 RAG 召回）</h3>
          <p className="muted">内置“中英概念哈希向量”离线可用；如需更强的语义召回，可接入 Ollama（推荐 bge-m3，多语言）或 OpenAI 兼容的 embeddings 接口。</p>
          <div className="row"><label>提供方</label>
            <select className="input" value={cfg.embedding.provider} onChange={(e) => setE({ provider: e.target.value })}>
              <option value="none">仅内置（离线）</option><option value="ollama">Ollama</option><option value="openai">OpenAI 兼容</option>
            </select>
          </div>
          {cfg.embedding.provider !== 'none' && <>
            <div className="row"><label>Base URL</label><input className="input wide" value={cfg.embedding.baseUrl} onChange={(e) => setE({ baseUrl: e.target.value })} /></div>
            <div className="row"><label>API Key</label><input className="input wide" type="password" value={cfg.embedding.apiKey} onChange={(e) => setE({ apiKey: e.target.value })} /></div>
            <div className="row"><label>模型</label><input className="input" value={cfg.embedding.model} onChange={(e) => setE({ model: e.target.value })} /></div>
            <div className="row"><label /><button className="btn" onClick={async () => {
              await save();
              const off = window.ppta.on('embedding', setEmbProg);
              try { const n = await api.buildEmbeddings(false); app.toast(`语义向量生成完成：${n} 页`); } catch (e) { app.toast('生成失败：' + e.message, 'error'); } finally { off(); }
            }}>为已解析页面生成语义向量</button>{embProg && <span className="muted">{embProg.done}/{embProg.total}</span>}</div>
          </>}
        </section>
        <section>
          <h3>相似分组与维护</h3>
          <div className="row"><label>内容相似阈值</label><input className="input" type="number" step="0.01" min="0.5" max="0.99" value={cfg.similarityThreshold} onChange={(e) => set({ similarityThreshold: Number(e.target.value) })} /></div>
          <div className="row"><label /><button className="btn" onClick={async () => { await save(); await api.rebuild(); app.bump(); app.toast('已重新计算标签、分组与黑白底对应关系'); }}>重新计算标签 / 分组 / 黑白底对应</button></div>
        </section>
        <section>
          <h3>数据</h3>
          {stats && <p>数据目录：<code>{stats.dataDir}</code>（数据库、Markdown、截图缓存、唯一的运行日志 ppt-agent.log）<br />已解析 {stats.files} 个文件、{stats.slides} 页；重复 {stats.duplicates}；失败 {stats.failed}；任务 {stats.tasks} 个。</p>}
          <button className="btn" onClick={() => api.openDataDir()}>打开数据目录</button>
        </section>
      </div>
    </div>
  );
}
