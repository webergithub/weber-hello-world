// 智能搜索任务队列：多个搜索依次执行，排队中的可调整顺序或移除；完成后结果进入搜索历史（主进程保存）
import { useSyncExternalStore } from 'react';
import { api } from './api';

let state = { items: [], paused: false };
let seq = 0;
const subs = new Set();
const emit = () => { state = { ...state, items: [...state.items] }; for (const f of subs) f(); };
let onDone = null;

export const searchQueue = {
  get: () => state,
  subscribe: (f) => { subs.add(f); return () => subs.delete(f); },
  setOnDone: (f) => { onDone = f; },
  /** opts：{ taskIds, taskNames, useLlm }（taskIds 为空 = 所有资料库） */
  add(q, opts = {}) {
    const text = String(q || '').trim();
    if (!text) return null;
    const it = { qid: ++seq, q: text, opts, status: 'queued', at: Date.now() };
    state.items.push(it); emit(); pump();
    return it.qid;
  },
  move(qid, d) {
    const queued = state.items.filter((x) => x.status === 'queued');
    const i = queued.findIndex((x) => x.qid === qid), j = i + d;
    if (i < 0 || j < 0 || j >= queued.length) return;
    const a = state.items.indexOf(queued[i]), b = state.items.indexOf(queued[j]);
    [state.items[a], state.items[b]] = [state.items[b], state.items[a]];
    emit();
  },
  remove(qid) { state.items = state.items.filter((x) => x.qid !== qid || x.status === 'running'); emit(); },
  clearDone() { state.items = state.items.filter((x) => x.status === 'queued' || x.status === 'running'); emit(); },
  setPaused(p) { state.paused = !!p; emit(); if (!p) pump(); },
};

async function pump() {
  if (state.paused || state.items.some((x) => x.status === 'running')) return;
  const it = state.items.find((x) => x.status === 'queued');
  if (!it) return;
  it.status = 'running'; it.startedAt = Date.now(); emit();
  try {
    const r = await api.search(it.q, { useLlm: it.opts.useLlm, taskIds: it.opts.taskIds || [] });
    Object.assign(it, { status: 'done', historyId: r.historyId, files: r.files.length, light: r.slides.light.length, dark: r.slides.dark.length, word: r.slides.word.length, pdf: (r.slides.pdf || []).length, ms: r.timing.total });
    emit();
    if (onDone) onDone(it, r);
  } catch (e) {
    Object.assign(it, { status: 'failed', error: e.message }); emit();
  }
  pump();
}

export function useSearchQueue() { return useSyncExternalStore(searchQueue.subscribe, searchQueue.get); }
