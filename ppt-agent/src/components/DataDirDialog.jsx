import React, { useState } from 'react';
import { api } from '../api';
import { useApp } from '../ctx';

/** 启动时选择保存解析数据的目录：当前目录 / 历史目录 / 选择新目录；可勾选“记住选择，下次不再询问”（设置中可改回） */
export default function DataDirDialog({ info, onClose }) {
  const app = useApp();
  const [list, setList] = useState(() => {
    const h = info.history || [];
    return h.some((x) => x.current) ? h : [{ dir: info.current, exists: true, hasData: true, current: true }, ...h];
  });
  const [pick, setPick] = useState(info.current);
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const browse = async () => {
    const dirs = await api.selectDir();
    const d = dirs && dirs[0];
    if (!d) return;
    if (!list.some((x) => x.dir === d)) setList((l) => [...l, { dir: d, exists: true, hasData: false, isNew: true }]);
    setPick(d);
  };
  const confirmPick = async () => {
    setBusy(true);
    try {
      if (remember) await api.setDataDirAsk(false);
      if (pick === info.current) { await api.dataDirAsked(); onClose(); return; }
      await api.setDataDir(pick, 'use');
      app.toast('正在切换数据目录并重启…');
    } catch (e) { app.toast(e.message, 'error'); setBusy(false); }
  };
  return (
    <div className="overlay">
      <div className="modal datadir-modal" onClick={(e) => e.stopPropagation()}>
        <div className="detail-head"><div className="dh-title">🗄 选择保存解析数据的目录</div></div>
        <div className="pad">
          <div className="dd-list">
            {list.map((x) => (
              <label key={x.dir} className={`dd-item ${pick === x.dir ? 'on' : ''} ${x.exists ? '' : 'missing'}`}>
                <input type="radio" name="dd" checked={pick === x.dir} disabled={!x.exists && !x.isNew} onChange={() => setPick(x.dir)} />
                <div className="dd-main">
                  <div className="dd-path" title={x.dir}>{x.dir}</div>
                  <div className="small muted">{x.current ? <span className="tag ok">当前使用</span> : null}{x.isNew ? <span className="tag accent">新选择</span> : null}{!x.exists ? '目录已不存在' : x.hasData ? '已有解析数据' : x.isNew ? '' : '空目录（将新建资料库）'}</div>
                </div>
              </label>
            ))}
          </div>
          <div className="row"><button className="btn" onClick={browse}>📁 选择其他目录…</button></div>
          <label className="chk dd-remember"><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> 记住选择，下次启动不再询问（可在“设置 → 数据保存目录”中修改）</label>
        </div>
        <div className="detail-head"><div className="spacer" />
          <button className="btn" disabled={busy} onClick={async () => { if (remember) await api.setDataDirAsk(false); await api.dataDirAsked(); onClose(); }}>使用当前目录</button>
          <button className="btn primary" disabled={busy} onClick={confirmPick}>{pick === info.current ? '确定' : '切换到所选目录并重启'}</button>
        </div>
      </div>
    </div>
  );
}
