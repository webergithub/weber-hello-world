'use strict';
// 向量：内置离线"哈希向量"（词 + 概念 token，支持中英跨语言），可选接入 Ollama / OpenAI 兼容的语义向量模型。
const { tokenize } = require('./textproc');

const DIM = 768;

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

function hashVector(text, extraTokens = []) {
  const v = new Float32Array(DIM);
  const tf = new Map();
  for (const t of tokenize(text)) tf.set(t, (tf.get(t) || 0) + (t[0] === 'c' && /^c\d+$/.test(t) ? 1.5 : 1));
  for (const t of extraTokens) tf.set(t, (tf.get(t) || 0) + 1);
  for (const [t, n] of tf) {
    const h = fnv1a(t);
    v[h % DIM] += (h & 0x80000000 ? -1 : 1) * (1 + Math.log(n));
  }
  return normalize(v);
}

function normalize(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  s = Math.sqrt(s);
  if (s > 0) for (let i = 0; i < v.length; i++) v[i] /= s;
  return v;
}

/**
 * 稀疏向量（v3.11，降低内存）：哈希向量 768 维里通常只有几十个非零值，从数据库读出后改用“下标 + 数值”存放，
 * 每页从约 3KB 降到约 0.3KB；2 万个文档、几十万页时检索缓存 / 相似分组 / 页面关联不再各占 1~2GB。
 * 数据库中仍存稠密向量（兼容旧数据）；只通过 cosine / toDense 使用，不要按下标直接读写。
 */
class SparseVec {
  constructor(idx, val, length) { this.idx = idx; this.val = val; this.length = length; }
  toDense() { const v = new Float32Array(this.length); for (let k = 0; k < this.idx.length; k++) v[this.idx[k]] = this.val[k]; return v; }
}

/** 非零值不超过 1/4 时转为稀疏向量，否则原样返回（语义向量等稠密向量不变） */
function sparsify(v) {
  if (!v || !(v instanceof Float32Array) || v.length > 65535) return v;
  let nz = 0;
  for (let i = 0; i < v.length; i++) if (v[i] !== 0) nz++;
  if (nz > v.length / 4) return v;
  const idx = new Uint16Array(nz), val = new Float32Array(nz);
  for (let i = 0, k = 0; i < v.length; i++) if (v[i] !== 0) { idx[k] = i; val[k++] = v[i]; }
  return new SparseVec(idx, val, v.length);
}

const dense = (v) => (v instanceof SparseVec ? v.toDense() : v);

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  const sa = a instanceof SparseVec, sb = b instanceof SparseVec;
  let s = 0;
  if (sa && sb) {
    const ai = a.idx, bi = b.idx;
    for (let i = 0, j = 0; i < ai.length && j < bi.length;) {
      if (ai[i] === bi[j]) { s += a.val[i++] * b.val[j++]; } else if (ai[i] < bi[j]) i++; else j++;
    }
    return s;
  }
  if (sa || sb) {
    const sp = sa ? a : b, d = sa ? b : a;
    for (let k = 0; k < sp.idx.length; k++) s += sp.val[k] * d[sp.idx[k]];
    return s;
  }
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function mean(vecs) {
  const list = vecs.filter(Boolean).map(dense);
  if (!list.length) return null;
  const v = new Float32Array(list[0].length);
  for (const x of list) for (let i = 0; i < v.length; i++) v[i] += x[i];
  return normalize(v);
}

async function postJson(url, body, headers = {}, timeoutMs = 60000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: ac.signal });
    const txt = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${txt.slice(0, 300)}`);
    return JSON.parse(txt);
  } finally { clearTimeout(t); }
}

/** 语义向量提供方。cfg: {provider:'none'|'ollama'|'openai', baseUrl, apiKey, model} */
function embedder(cfg) {
  if (require('./offline').OFFLINE_ONLY) return null; // 单机版不联网：只用内置向量
  if (!cfg || !cfg.provider || cfg.provider === 'none' || !cfg.model) return null;
  const base = (cfg.baseUrl || (cfg.provider === 'ollama' ? 'http://127.0.0.1:11434' : 'https://api.openai.com/v1')).replace(/\/+$/, '');
  return {
    id: `${cfg.provider}:${cfg.model}`,
    async embed(texts) {
      const out = [];
      for (let i = 0; i < texts.length; i += 16) {
        const batch = texts.slice(i, i + 16).map((t) => String(t || ' ').slice(0, 6000));
        let vecs;
        if (cfg.provider === 'ollama') vecs = (await postJson(`${base}/api/embed`, { model: cfg.model, input: batch })).embeddings;
        else vecs = (await postJson(`${base}/embeddings`, { model: cfg.model, input: batch }, cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {})).data.map((d) => d.embedding);
        for (const v of vecs) out.push(normalize(Float32Array.from(v)));
      }
      return out;
    },
  };
}

module.exports = { SparseVec, sparsify, dense, hashVector, cosine, mean, normalize, embedder, postJson, DIM };
