import React, { useEffect, useState } from 'react';

const boot = (m, ...a) => window.ppta.boot(m, ...a).catch((e) => { throw new Error(String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); });
const readLS = (k, d) => { try { return localStorage.getItem(k) || d; } catch { return d; } };

/**
 * 启动时选择保存解析数据的目录（单独的启动窗口，资料库服务创建之前）：
 * 当前目录 / 使用过的历史目录 / 选择新目录；可勾选“记住选择，下次不再询问”（设置 → 目录与数据中可改回）。
 * 选定后主进程直接用该目录启动，不需要重启；关闭窗口 = 退出程序。
 */
export default function StartupDataDir() {
  const [info, setInfo] = useState(null);
  const [list, setList] = useState([]);
  const [pick, setPick] = useState('');
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    const mode = readLS('ppta.theme', 'system');
    const dark = mode === 'dark' || (mode !== 'light' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    document.title = 'PPT智能体 · 选择数据目录';
    boot('info').then((r) => { setInfo(r); setList([r.current, ...r.history]); setPick(r.current.dir); }).catch((e) => setErr(e.message));
  }, []);
  const browse = async () => {
    const d = await boot('selectDir').catch((e) => { setErr(e.message); return null; });
    if (!d) return;
    if (!list.some((x) => x.dir === d.dir)) setList((l) => [...l, { ...d, isNew: true }]);
    setPick(d.dir);
  };
  const start = async () => {
    setBusy(true); setErr('');
    try { await boot('choose', pick, remember); } catch (e) { setErr(e.message); setBusy(false); }
  };
  useEffect(() => {
    const h = (e) => { if (e.key === 'Enter' && pick && !busy && !(e.target && e.target.tagName === 'BUTTON')) start(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });
  const usable = (x) => x.exists || x.isNew || x.current; // 上次使用 / 新选择的目录不存在时会自动创建
  const status = (x) => (x.hasData ? '已有解析数据' : usable(x) ? '新建资料库' : '目录已不存在');
  return (
    <div className="boot-dd">
      <div className="boot-head">
        <div className="logo">PPT<span>智能体</span>{info && <sup className="sb-ver">v{info.version}</sup>}</div>
      </div>
      <div className="boot-title">🗄 选择保存解析数据的目录</div>
      <div className="dd-list boot-list">
        {list.map((x) => (
          <label key={x.dir} className={`dd-item ${pick === x.dir ? 'on' : ''} ${usable(x) ? '' : 'missing'}`} onDoubleClick={() => { if (usable(x)) { setPick(x.dir); setTimeout(start, 0); } }}>
            <input type="radio" name="dd" checked={pick === x.dir} disabled={!usable(x)} onChange={() => setPick(x.dir)} />
            <div className="dd-main">
              <div className="dd-path" title={x.dir}>{x.dir}</div>
              <div className="small muted">{x.current ? <span className="tag ok">上次使用</span> : null}{x.isNew ? <span className="tag accent">新选择</span> : null}{info && x.dir === info.defaultDir ? <span className="tag">默认目录</span> : null}{status(x)}</div>
            </div>
          </label>
        ))}
      </div>
      <div className="row"><button className="btn" disabled={busy} onClick={browse}>📁 选择其他目录…</button></div>
      <label className="chk dd-remember"><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> 记住选择，下次启动不再询问（可在“设置 → 目录与数据”中修改）</label>
      {err && <div className="boot-err">{err}</div>}
      <div className="boot-foot">
        <button className="btn ghost" disabled={busy} onClick={() => boot('quit')}>退出</button>
        <div className="spacer" />
        <button className="btn primary big" disabled={busy || !pick} onClick={start}>{busy ? '正在打开…' : '开始使用 →'}</button>
      </div>
    </div>
  );
}
