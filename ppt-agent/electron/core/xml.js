'use strict';
// 将 XML 解析为保持顺序的轻量节点树 {tag, attrs, children, text}
const { XMLParser } = require('fast-xml-parser');

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  processEntities: true,
  htmlEntities: true,
});

function convert(list) {
  const out = [];
  for (const item of list) {
    const attrs = item[':@'] || {};
    for (const key of Object.keys(item)) {
      if (key === ':@') continue;
      if (key === '#text') { out.push({ tag: '#text', attrs: {}, children: [], text: String(item[key]) }); continue; }
      if (key.startsWith('?')) continue;
      out.push({ tag: key, attrs, children: convert(item[key] || []) });
    }
  }
  return out;
}

function parseXml(xml) {
  if (!xml) return null;
  const root = convert(parser.parse(xml));
  return root.find((n) => n.tag !== '#text') || null;
}

const local = (tag) => { const i = tag.indexOf(':'); return i >= 0 ? tag.slice(i + 1) : tag; };

function child(node, tag) {
  if (!node) return null;
  for (const c of node.children) if (c.tag === tag) return c;
  return null;
}
function kids(node, tag) { return node ? node.children.filter((c) => c.tag === tag) : []; }
function path(node, ...tags) {
  let cur = node;
  for (const t of tags) { cur = child(cur, t); if (!cur) return null; }
  return cur;
}
function findAll(node, tag, out = []) {
  if (!node) return out;
  for (const c of node.children) {
    if (c.tag === tag) out.push(c);
    findAll(c, tag, out);
  }
  return out;
}
function findFirst(node, tag) {
  if (!node) return null;
  for (const c of node.children) {
    if (c.tag === tag) return c;
    const r = findFirst(c, tag);
    if (r) return r;
  }
  return null;
}
function textOf(node) {
  if (!node) return '';
  if (node.tag === '#text') return node.text;
  return node.children.map(textOf).join('');
}

module.exports = { parseXml, child, kids, path, findAll, findFirst, textOf, local };
