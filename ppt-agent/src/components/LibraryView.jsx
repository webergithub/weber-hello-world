import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { useApp } from '../ctx';
import SlideWorkspace from './SlideWorkspace';

const MODES = { folder: '按文件夹', name: '按 PPT 名称', tags: '按名称与内容归类（标签）' };

export default function LibraryView({ mode, setMode }) {
  const app = useApp();
  const [files, setFiles] = useState([]);
  const [cats, setCats] = useState({ categories: [], tags: [] });
  useEffect(() => { api.library().then(setFiles); api.categories().then(setCats); }, [app.taskTick]);
  return (
    <div className="view">
      <div className="view-head">
        <div className="vh-title">📚 PPT 资料库 <span className="muted small">{files.filter((f) => f.status === 'parsed').length} 个已解析文件</span></div>
        <div className="spacer" />
        <div className="seg">{Object.entries(MODES).map(([k, v]) => <button key={k} className={mode === k ? 'on' : ''} onClick={() => setMode(k)}>{v}</button>)}</div>
      </div>
      <div className="tab-body">
        {mode === 'folder' && <FolderMode files={files} />}
        {mode === 'name' && <NameMode files={files} />}
        {mode === 'tags' && <TagMode files={files} cats={cats} />}
      </div>
    </div>
  );
}

function buildTree(files) {
  const root = { name: '', path: '', children: new Map(), files: [] };
  for (const f of files) {
    const parts = f.dir.split(/[\\/]+/).filter(Boolean);
    let node = root, acc = f.dir.startsWith('/') ? '' : '';
    for (const p of parts) {
      acc = acc ? acc + '/' + p : (f.dir.startsWith('/') ? '/' + p : p);
      if (!node.children.has(p)) node.children.set(p, { name: p, path: acc, children: new Map(), files: [] });
      node = node.children.get(p);
    }
    node.files.push(f);
  }
  // 压缩单链路径
  const compress = (n) => {
    while (n.children.size === 1 && !n.files.length && n !== root) {
      const [c] = n.children.values();
      n.name = n.name + '/' + c.name; n.path = c.path; n.children = c.children; n.files = c.files;
    }
    for (const c of n.children.values()) compress(c);
    n.count = n.files.length + [...n.children.values()].reduce((a, c) => a + c.count, 0);
    return n;
  };
  for (const c of root.children.values()) compress(c);
  root.count = [...root.children.values()].reduce((a, c) => a + c.count, 0);
  let top = root;
  while (top.children.size === 1 && !top.files.length) { [top] = top.children.values(); }
  return top;
}

function allFiles(n) { return [...n.files, ...[...n.children.values()].flatMap(allFiles)]; }

function TreeNode({ node, sel, onSel, depth = 0 }) {
  const [open, setOpen] = useState(depth < 2);
  const kids = [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  return (
    <div>
      <div className={`tree-row ${sel === node ? 'active' : ''}`} style={{ paddingLeft: 8 + depth * 14 }} onClick={() => onSel(node)}>
        <span className="tw" onClick={(e) => { e.stopPropagation(); setOpen(!open); }}>{kids.length ? (open ? '▾' : '▸') : '·'}</span>
        📂 {node.name || '全部'} <span className="muted small">({node.count})</span>
      </div>
      {open && kids.map((c) => <TreeNode key={c.path} node={c} sel={sel} onSel={onSel} depth={depth + 1} />)}
    </div>
  );
}

function FolderMode({ files }) {
  const tree = useMemo(() => buildTree(files), [files]);
  const [sel, setSel] = useState(null);
  const node = sel || tree;
  return (
    <div className="lib-split">
      <div className="lib-side"><TreeNode node={tree} sel={node} onSel={setSel} /></div>
      <div className="lib-main"><SlideWorkspace key={node.path} files={allFiles(node)} /></div>
    </div>
  );
}

function initialOf(name) {
  const c = name.trim()[0] || '#';
  if (/[a-z]/i.test(c)) return c.toUpperCase();
  if (/\d/.test(c)) return '0-9';
  if (/[一-鿿]/.test(c)) return '中文';
  return '#';
}

function NameMode({ files }) {
  const [letter, setLetter] = useState('');
  const sorted = useMemo(() => [...files].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')), [files]);
  const groups = useMemo(() => { const m = new Map(); for (const f of sorted) { const k = initialOf(f.name); m.set(k, (m.get(k) || 0) + 1); } return m; }, [sorted]);
  const list = letter ? sorted.filter((f) => initialOf(f.name) === letter) : sorted;
  return (
    <div className="lib-split">
      <div className="lib-side">
        <div className={`tree-row ${!letter ? 'active' : ''}`} onClick={() => setLetter('')}>全部 <span className="muted small">({sorted.length})</span></div>
        {[...groups].map(([k, n]) => <div key={k} className={`tree-row ${letter === k ? 'active' : ''}`} onClick={() => setLetter(k)}>🔤 {k} <span className="muted small">({n})</span></div>)}
      </div>
      <div className="lib-main"><SlideWorkspace key={letter} files={list} /></div>
    </div>
  );
}

function TagMode({ files, cats }) {
  const [cat, setCat] = useState('');
  const [tag, setTag] = useState('');
  const byId = useMemo(() => new Map(files.map((f) => [f.id, f])), [files]);
  let list = files.filter((f) => f.status === 'parsed');
  if (cat) list = list.filter((f) => (f.category || '其他') === cat);
  if (tag) list = list.filter((f) => (f.tags || []).includes(tag));
  const content = cats.tags.filter((t) => !t.attr), attrs = cats.tags.filter((t) => t.attr);
  const max = Math.max(1, ...content.map((t) => t.n));
  return (
    <div className="lib-split">
      <div className="lib-side">
        <div className="side-title">内容分类</div>
        <div className={`tree-row ${!cat ? 'active' : ''}`} onClick={() => setCat('')}>全部分类</div>
        {cats.categories.map((c) => <div key={c.name} className={`tree-row ${cat === c.name ? 'active' : ''}`} onClick={() => setCat(c.name)}>🏷 {c.name} <span className="muted small">({c.files.length})</span></div>)}
        <div className="side-title">标签云 {tag && <button className="btn tiny" onClick={() => setTag('')}>清除</button>}</div>
        <div className="tag-cloud">
          {content.slice(0, 150).map((t) => (
            <span key={t.tag} className={`cloud-tag ${tag === t.tag ? 'on' : ''}`} style={{ fontSize: 11 + (t.n / max) * 8 }} onClick={() => setTag(tag === t.tag ? '' : t.tag)}>{t.tag}<sup>{t.n}</sup></span>
          ))}
        </div>
        <div className="side-title">属性标签</div>
        <div className="tag-cloud">
          {attrs.map((t) => <span key={t.tag} className={`cloud-tag ${tag === t.tag ? 'on' : ''}`} style={{ fontSize: 11.5 }} onClick={() => setTag(tag === t.tag ? '' : t.tag)}>{t.tag}<sup>{t.n}</sup></span>)}
        </div>
      </div>
      <div className="lib-main">
        {(cat || tag) && <div className="notice">筛选：{cat && <b>分类「{cat}」</b>} {tag && <b>标签「{tag}」</b>} · {list.length} 个文件</div>}
        <SlideWorkspace key={cat + '|' + tag} files={list.map((f) => byId.get(f.id) || f)} />
      </div>
    </div>
  );
}
