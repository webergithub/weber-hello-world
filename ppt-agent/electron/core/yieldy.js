'use strict';
// 长时间计算的“分片”工具：每计算约 budgetMs 毫秒就让出一次事件循环（setImmediate），
// 期间主进程可以处理界面请求（IPC），资料库很大（上万个文件）时界面也不会假死。
// 用法：const tk = ticker(); for (...) { const p = tk(); if (p) await p; ... }
function ticker(budgetMs = 25) {
  let last = Date.now();
  let n = 0;
  return () => {
    if ((++n & 63) !== 0) return null; // 每 64 次才检查一次时间，开销可以忽略
    if (Date.now() - last < budgetMs) return null;
    return new Promise((r) => setImmediate(() => { last = Date.now(); r(); }));
  };
}

module.exports = { ticker };
