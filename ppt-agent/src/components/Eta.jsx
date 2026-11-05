import React, { useEffect, useMemo, useState } from 'react';

/** 时长：已用时间精确到秒，预计时间取整（不到 1 分钟 / 约 N 分钟 / 约 H 小时 M 分） */
export function fmtSpan(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分 ${s % 60} 秒`;
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}
export function fmtGuess(ms) {
  if (ms === null || ms === undefined) return null;
  const m = Math.round(ms / 60000);
  if (ms < 60000) return '不到 1 分钟';
  if (m < 60) return `约 ${m} 分钟`;
  return `约 ${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}

/**
 * 已用时间 / 预计剩余 / 预计总耗时（v3.10）。eta 来自主进程（解析任务的 task.eta、智能总结的 state.eta），
 * 两次更新之间按收到的时间每秒自行走动；compact 只显示“剩余约 …”。
 */
export default function EtaLine({ eta, compact = false, unit = '个' }) {
  const at = useMemo(() => Date.now(), [eta]);
  const [, tick] = useState(0);
  useEffect(() => { if (!eta) return undefined; const iv = setInterval(() => tick((x) => x + 1), 1000); return () => clearInterval(iv); }, [eta]);
  if (!eta) return null;
  const since = Date.now() - at;
  const elapsed = (eta.elapsed || 0) + since;
  const remaining = eta.remainingMs === null || eta.remainingMs === undefined ? null : Math.max(0, eta.remainingMs - since);
  const guess = eta.paused ? '已暂停' : remaining === null ? '正在估算…' : fmtGuess(remaining);
  if (compact) return <span className="eta-compact" title={`已用 ${fmtSpan(elapsed)}`}>{remaining === null ? '估算中' : `剩余${guess.replace(/^约 /, '约')}`}</span>;
  return (
    <span className="eta-line">
      <span>已用 <b>{fmtSpan(elapsed)}</b></span>
      <span>预计剩余 <b>{guess}</b></span>
      {remaining !== null && !eta.paused && <span>预计总耗时 <b>{fmtGuess(elapsed + remaining)}</b></span>}
      {eta.rate ? <span>速度 {eta.rate} {unit}/秒</span> : eta.avgMs ? <span>平均每个 {fmtSpan(eta.avgMs)}</span> : null}
    </span>
  );
}
