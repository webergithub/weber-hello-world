import React, { useEffect, useState } from 'react';
import { api } from '../api';
import { useApp } from '../ctx';

const TYPES = ['问题', '建议', '其他'];

/** 反馈：后台发送给开发者（接收地址不在界面展示）；发件邮箱未配置时先保存在本机，配置后自动发送 */
export default function FeedbackDialog({ onClose }) {
  const app = useApp();
  const [type, setType] = useState('建议');
  const [text, setText] = useState('');
  const [contact, setContact] = useState('');
  const [withEnv, setWithEnv] = useState(true);
  const [withLog, setWithLog] = useState(false);
  const [busy, setBusy] = useState(false);
  const [st, setSt] = useState(null);
  useEffect(() => { api.feedbackStatus().then(setSt).catch(() => {}); }, []);
  const send = async () => {
    setBusy(true);
    try {
      const r = await api.sendFeedback({ type, text, contact, withEnv, withLog });
      if (r.sent) app.toast('反馈已发送，感谢你的意见！', 'info', { cat: '反馈' });
      else if (r.reason === 'unconfigured') app.toast('反馈已保存。在“设置 → 反馈邮件发送设置”中配置发件邮箱后会自动发送', 'info', { label: '去设置', link: { type: 'view', view: { type: 'settings', focus: 'mail' } }, cat: '反馈' });
      else app.toast(`反馈暂未发出（${r.error || '网络或邮箱错误'}），已保存在本机，稍后自动重试`, 'error', { label: '检查设置', link: { type: 'view', view: { type: 'settings', focus: 'mail' } }, cat: '反馈' });
      onClose();
    } catch (e) { app.toast(e.message, 'error'); } finally { setBusy(false); }
  };
  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal feedback-modal" onClick={(e) => e.stopPropagation()}>
        <div className="detail-head"><div className="dh-title">💬 意见反馈</div><div className="spacer" /><button className="icon-btn" onClick={onClose}>✕</button></div>
        <div className="pad fb-body">
          <div className="seg">{TYPES.map((t) => <button key={t} className={type === t ? 'on' : ''} onClick={() => setType(t)}>{t}</button>)}</div>
          <textarea className="input fb-text" autoFocus placeholder="请描述遇到的问题或建议（必填）" value={text} onChange={(e) => setText(e.target.value)} />
          <input className="input" placeholder="联系方式（选填：邮箱 / 电话，便于回复你）" value={contact} onChange={(e) => setContact(e.target.value)} />
          <label className="chk"><input type="checkbox" checked={withEnv} onChange={(e) => setWithEnv(e.target.checked)} /> 附带运行环境（版本、系统、资料库规模）</label>
          <label className="chk"><input type="checkbox" checked={withLog} onChange={(e) => setWithLog(e.target.checked)} /> 附带最近 200 行运行日志</label>
          {st && !st.configured && <div className="notice small">尚未配置发件邮箱：反馈会先保存在本机，在“设置 → 反馈邮件发送设置”配置后自动发送{st.queued ? `（当前待发送 ${st.queued} 条）` : ''}。</div>}
        </div>
        <div className="detail-head"><div className="spacer" /><button className="btn" onClick={onClose}>取消</button><button className="btn primary" disabled={busy || !text.trim()} onClick={send}>{busy ? '发送中…' : '发送反馈'}</button></div>
      </div>
    </div>
  );
}
