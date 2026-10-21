import React, { useEffect, useState } from 'react';
import { api } from '../api';
import { useApp } from '../ctx';

export default function SettingsView() {
  const app = useApp();
  const [cfg, setCfg] = useState(null);
  const [eng, setEng] = useState(null);
  const [stats, setStats] = useState(null);
  const [embProg, setEmbProg] = useState(null);
  const [types, setTypes] = useState([]);
  const [dd, setDd] = useState(null);
  const [newDir, setNewDir] = useState('');
  useEffect(() => { api.getConfig().then(setCfg); api.engines(false).then(setEng); api.stats().then(setStats); api.docTypes().then(setTypes); api.dataDirInfo().then(setDd); }, []);
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
        <section>
          <h3>界面主题</h3>
          <div className="seg">
            {[['dark', '🌙 黑色'], ['light', '☀️ 白色'], ['system', '🖥 跟随系统']].map(([k, v]) => <button key={k} className={(cfg.uiTheme || 'system') === k ? 'on' : ''} onClick={() => { set({ uiTheme: k }); app.setTheme(k); }}>{v}</button>)}
          </div>
        </section>
        <section>
          <h3>关闭窗口时</h3>
          <div className="seg">
            {[['ask', '每次询问'], ['minimize', '最小化到任务栏'], ['quit', '完全退出']].map(([k, v]) => <button key={k} className={(cfg.closeAction || 'ask') === k ? 'on' : ''} onClick={() => set({ closeAction: k })}>{v}</button>)}
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
        <section>
          <h3>大模型（可选，OpenAI 兼容接口）</h3>
          <p className="muted">用于：查询的中英文解析与扩展、自动打标签（20 个）、基于检索结果的 RAG 回答。支持 DeepSeek、通义千问、Kimi、智谱、OpenAI、本地 Ollama（http://127.0.0.1:11434/v1）等。未配置时使用内置双语词表与 TF-IDF，全部离线可用。</p>
          <div className="row"><label>启用</label><input type="checkbox" checked={cfg.llm.enabled} onChange={(e) => setL({ enabled: e.target.checked })} /></div>
          <div className="row"><label>Base URL</label><input className="input wide" value={cfg.llm.baseUrl} onChange={(e) => setL({ baseUrl: e.target.value })} /></div>
          <div className="row"><label>API Key</label><input className="input wide" type="password" value={cfg.llm.apiKey} onChange={(e) => setL({ apiKey: e.target.value })} /></div>
          <div className="row"><label>模型</label><input className="input" value={cfg.llm.model} onChange={(e) => setL({ model: e.target.value })} /></div>
          <div className="row"><label>用于查询解析</label><input type="checkbox" checked={cfg.llm.useForQuery} onChange={(e) => setL({ useForQuery: e.target.checked })} /></div>
          <div className="row"><label>用于打标签</label><input type="checkbox" checked={cfg.llm.useForTags} onChange={(e) => setL({ useForTags: e.target.checked })} /><span className="muted small">（解析/重算标签时调用，每个文件一次）</span></div>
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
