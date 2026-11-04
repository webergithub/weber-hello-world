'use strict';
// 大任务拆分为子任务（v3.5）：扫描到的文件按“盘符 → 文件夹”的层级拆分，每个子任务不超过 size 个文件。
// 规则：一个文件夹（含子文件夹）不超过上限时整体作为一个子任务；超过时向下拆到子文件夹，
// 相邻的小文件夹按顺序合并到同一个子任务（不超过上限）；同一文件夹里直接存放的文件过多时按顺序分段。
// 不同的扫描根目录（如 C:\ 与 D:\）一定分在不同的子任务中。输出顺序与扫描顺序一致。
const path = require('path');

function newNode(full, name) { return { full, name, files: [], kids: new Map(), count: 0 }; }

/** files 为扫描顺序的绝对路径；roots 为扫描根目录；返回 [{ label, dir, files }] */
function splitFiles(files, roots, size = 1000, p = path) {
  size = Math.max(1, Math.floor(size) || 1000);
  const tops = roots.map((r) => newNode(p.resolve(r), p.basename(p.resolve(r)) || p.resolve(r)));
  const other = newNode('', '其他位置');
  const sorted = [...tops].sort((a, b) => b.full.length - a.full.length);
  for (const f of files) {
    const top = sorted.find((t) => f === t.full || f.startsWith(t.full.endsWith(p.sep) ? t.full : t.full + p.sep)) || other;
    const rel = top === other ? [] : p.relative(top.full, p.dirname(f)).split(p.sep).filter(Boolean);
    let node = top;
    node.count++;
    for (const seg of rel) {
      let k = node.kids.get(seg);
      if (!k) { k = newNode(p.join(node.full, seg), seg); node.kids.set(seg, k); }
      node = k;
      node.count++;
    }
    node.files.push(f);
  }
  const all = (node) => { const out = [...node.files]; for (const k of node.kids.values()) out.push(...all(k)); return out; };
  const groups = [];
  const label = (top, node) => (node === top ? top.name : p.join(top.name, p.relative(top.full, node.full)));
  const plan = (top, node) => {
    if (node.count <= size) { groups.push({ label: label(top, node), dir: node.full, files: all(node) }); return; }
    const items = [];
    if (node.files.length) items.push({ own: true, count: node.files.length });
    for (const k of node.kids.values()) items.push({ node: k, count: k.count });
    let pack = [], n = 0;
    const flush = () => {
      if (!pack.length) return;
      const names = pack.map((it) => (it.own ? '本目录文件' : it.node.name));
      const one = pack.length === 1;
      groups.push({
        label: one ? (pack[0].own ? `${label(top, node)}（本目录文件）` : label(top, pack[0].node)) : `${label(top, node)}：${names.length <= 3 ? names.join('、') : `${names.slice(0, 2).join('、')} 等 ${names.length} 项`}`,
        dir: one && !pack[0].own ? pack[0].node.full : node.full,
        files: pack.flatMap((it) => (it.own ? node.files : all(it.node))),
      });
      pack = []; n = 0;
    };
    for (const it of items) {
      if (it.count > size) {
        flush();
        if (it.own) {
          const parts = Math.ceil(node.files.length / size);
          for (let i = 0; i < parts; i++) groups.push({ label: `${label(top, node)}（本目录文件 第 ${i + 1}/${parts} 段）`, dir: node.full, files: node.files.slice(i * size, (i + 1) * size) });
        } else plan(top, it.node);
        continue;
      }
      if (n + it.count > size) flush();
      pack.push(it); n += it.count;
    }
    flush();
  };
  for (const t of [...tops, other]) if (t.count) plan(t, t);
  return groups;
}

module.exports = { splitFiles };
