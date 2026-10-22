import React, { useEffect, useMemo, useState } from 'react';
import { api, fmtSize, fmtTime, THEME_LABEL, KIND_LABEL, STATUS_LABEL, unitOf } from '../api';
import { useApp } from '../ctx';
import SlideWorkspace from './SlideWorkspace';
import SlideViewer from './SlideViewer';
import DataTable from './DataTable';
import { RecycleButton } from './Recycle';
import { CompareButton } from './CompareView';

const MODES = { overview: '📋 总览', gallery: '🖼 PPT 总览库', folder: '📂 按文件夹', name: '🔤 按文件名称', tags: '🏷 按名称与内容归类（标签）' };

/** 资料库浏览：taskId 为空时是“所有资料库”（全部解析过的文档），否则只显示该任务解析到的文档 */
export default function LibraryView({ mode, setMode, taskId, title = '📚 资料库' }) {
  const app = useApp();
  const [files, setFiles] = useState([]);
  const [cats, setCats] = useState({ categories: [], tags: [] });
  useEffect(() => { api.library({ taskId }).then(setFiles); api.categories({ taskId }).then(setCats); }, [app.taskTick, taskId]);
  return (
    <div className="view">
      <div className="view-head">
        <div className="vh-title">{title} <span className="muted small">{files.filter((f) => f.status === 'parsed').length} 个已解析文件</span></div>
      </div>
      <div className="lib-tabs">{Object.entries(MODES).map(([k, v]) => <button key={k} className={mode === k ? 'on' : ''} onClick={() => setMode(k)}>{v}</button>)}</div>
      <div className="tab-body lib-body">
        {mode === 'overview' && <OverviewMode scopeTask={taskId} />}
        {mode === 'gallery' && <GalleryMode key={taskId || 'all'} files={files} />}
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

function useSideCollapse() {
  const [open, setOpen] = useState(() => { try { return localStorage.getItem('ppta.libside') !== '0'; } catch { return true; } });
  const set = (v) => { setOpen(v); try { localStorage.setItem('ppta.libside', v ? '1' : '0'); } catch { /* ignore */ } };
  return [open, set];
}

function SideShell({ open, setOpen, label, children }) {
  if (!open) return <div className="col-collapsed" onClick={() => setOpen(true)} title="展开"><span>▸ {label}</span></div>;
  return <div className="lib-side"><div className="col-head"><span>{label}</span><button className="icon-btn tiny" title="折叠" onClick={() => setOpen(false)}>«</button></div>{children}</div>;
}

function FolderMode({ files }) {
  const tree = useMemo(() => buildTree(files), [files]);
  const [sel, setSel] = useState(null);
  const [open, setOpen] = useSideCollapse();
  const node = sel || tree;
  return (
    <div className={`lib-split ${open ? '' : 'side-collapsed'}`}>
      <SideShell open={open} setOpen={setOpen} label="目录名"><TreeNode node={tree} sel={node} onSel={setSel} /></SideShell>
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
  const [open, setOpen] = useSideCollapse();
  return (
    <div className={`lib-split ${open ? '' : 'side-collapsed'}`}>
      <SideShell open={open} setOpen={setOpen} label="首字母">
        <div className={`tree-row ${!letter ? 'active' : ''}`} onClick={() => setLetter('')}>全部 <span className="muted small">({sorted.length})</span></div>
        {[...groups].map(([k, n]) => <div key={k} className={`tree-row ${letter === k ? 'active' : ''}`} onClick={() => setLetter(k)}>🔤 {k} <span className="muted small">({n})</span></div>)}
      </SideShell>
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
  const [open, setOpen] = useSideCollapse();
  return (
    <div className={`lib-split ${open ? '' : 'side-collapsed'}`}>
      <SideShell open={open} setOpen={setOpen} label="分类与标签">
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
      </SideShell>
      <div className="lib-main">
        {(cat || tag) && <div className="notice">筛选：{cat && <b>分类「{cat}」</b>} {tag && <b>标签「{tag}」</b>} · {list.length} 个文件</div>}
        <SlideWorkspace key={cat + '|' + tag} files={list.map((f) => byId.get(f.id) || f)} />
      </div>
    </div>
  );
}

// PPT 总览库：以逐页浏览窗口的形式浏览资料库中的全部文档（↑↓ 切换文件，←→ 翻页）
function GalleryMode({ files }) {
  const app = useApp();
  const [kind, setKind] = useState('');
  const list = useMemo(() => files.filter((f) => f.status === 'parsed' && f.slide_count > 0 && (!kind || (f.kind || 'ppt') === kind)).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')), [files, kind]);
  const [cur, setCur] = useState(null);
  const [shown, setShown] = useState(null);
  const ids = list.map((f) => f.id);
  const start = cur && ids.includes(cur) ? cur : ids[0];
  useEffect(() => { const el = document.querySelector(`.gallery-side [data-gid="${shown}"]`); if (el) el.scrollIntoView({ block: 'nearest' }); }, [shown]);
  return (
    <div className="gallery">
      <div className="gallery-side">
        <div className="col-head"><span>文档（{list.length}）</span>
          <select className="input" value={kind} onChange={(e) => setKind(e.target.value)}><option value="">全部</option><option value="ppt">PPT</option><option value="word">Word</option></select></div>
        {list.map((f) => <div key={f.id} data-gid={f.id} className={`tree-row ${f.id === (shown || start) ? 'active' : ''}`} title={f.path} onClick={() => setCur(f.id)}>{f.kind === 'word' ? '📄' : '🖼'} {f.name} <span className="muted small">{f.slide_count}</span></div>)}
      </div>
      <div className="gallery-main">{start ? <SlideViewer key={start} fileIds={ids} initialFileId={start} active={!app.modalOpen} compact onFileChange={setShown} /> : <div className="empty-tip">资料库还没有已解析的文档</div>}</div>
    </div>
  );
}

// 总览：每个任务 / 全部任务识别到的所有文档的汇总信息
function OverviewMode({ scopeTask }) {
  const app = useApp();
  const [data, setData] = useState({ tasks: [], files: [] });
  const [pick, setTaskId] = useState('all');
  const taskId = scopeTask || pick;
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('');
  const [sel, setSel] = useState(() => new Set());
  useEffect(() => { api.overview().then(setData); }, [app.taskTick]);
  const byId = useMemo(() => new Map(data.files.map((f) => [f.id, f])), [data]);
  const scope = taskId === 'all' ? data.files : ((data.tasks.find((t) => String(t.id) === String(taskId)) || { fileIds: [] }).fileIds.map((id) => byId.get(id)).filter(Boolean));
  const rows = useMemo(() => {
    const f = q.trim().toLowerCase();
    return scope.filter((x) => (!kind || (x.kind || 'ppt') === kind) && (!f || x.path.toLowerCase().includes(f) || (x.tags || []).join(' ').toLowerCase().includes(f) || (x.author || '').toLowerCase().includes(f) || (x.category || '').includes(f)));
  }, [scope, q, kind]);
  const ok = rows.filter((r) => r.status === 'parsed');
  const sum = (k) => ok.reduce((a, r) => a + (r[k] || 0), 0);
  const ppt = ok.filter((r) => (r.kind || 'ppt') === 'ppt'), word = ok.filter((r) => r.kind === 'word');
  const cats = {}; for (const r of ok) cats[r.category || '其他'] = (cats[r.category || '其他'] || 0) + 1;
  const authors = new Set(ok.map((r) => r.author).filter(Boolean));
  const cards = [['文档总数', rows.length], ['已解析', ok.length], ['PPT 文件', ppt.length], ['PPT 页数', ppt.reduce((a, r) => a + (r.slide_count || 0), 0)], ['黑底页', sum('dark_slides')], ['白底页', ppt.reduce((a, r) => a + (r.light_slides || 0), 0)],
    ['Word 文档', word.length], ['Word 章节', word.reduce((a, r) => a + (r.slide_count || 0), 0)], ['视频', sum('video_count')], ['作者数', authors.size], ['总大小', fmtSize(rows.reduce((a, r) => a + (r.size || 0), 0))]];
  const columns = [
    { key: 'name', label: '文件名', render: (r) => <span className="link" onClick={() => r.status !== 'failed' && app.openFile(r.id)} title={r.path}>{r.name}</span> },
    { key: 'kind', label: '类型', sort: (r) => r.kind || 'ppt', render: (r) => KIND_LABEL[r.kind || 'ppt'] },
    { key: 'dir', label: '目录', className: 'muted small ellipsis', render: (r) => <span title={r.dir}>{r.dir}</span> },
    { key: 'slide_count', label: '页数/节数', sort: (r) => r.slide_count || 0, render: (r) => `${r.slide_count || 0} ${unitOf(r)}` },
    { key: 'dark_slides', label: '黑底页', sort: (r) => r.dark_slides || 0, render: (r) => ((r.kind || 'ppt') === 'ppt' ? r.dark_slides || 0 : '-') },
    { key: 'light_slides', label: '白底页', sort: (r) => r.light_slides || 0, render: (r) => ((r.kind || 'ppt') === 'ppt' ? r.light_slides || 0 : '-') },
    { key: 'theme', label: '底色', render: (r) => ((r.kind || 'ppt') === 'ppt' && r.theme ? <span className={`tag theme-${r.theme}`}>{THEME_LABEL[r.theme]}</span> : '') },
    { key: 'category', label: '主题分类' },
    { key: 'tags', label: '标签', sort: (r) => (r.tags || []).join(' '), filterList: (r) => r.tags || [], className: 'tags-cell', render: (r) => (r.tags || []).map((t) => <span key={t} className="tag">{t}</span>) },
    { key: 'size', label: '大小', sort: (r) => r.size || 0, className: 'nowrap', render: (r) => fmtSize(r.size) },
    { key: 'author', label: '作者' },
    { key: 'mtime', label: '修改时间', sort: (r) => r.mtime || 0, className: 'small nowrap', render: (r) => fmtTime(r.mtime) },
    { key: 'video_count', label: '视频', sort: (r) => r.video_count || 0, hidden: true },
    { key: 'notes_count', label: '含备注页', sort: (r) => r.notes_count || 0, hidden: true },
    { key: 'lang', label: '语言', hidden: true },
    { key: 'parsed_at', label: '解析时间', sort: (r) => r.parsed_at || 0, className: 'small nowrap', render: (r) => fmtTime(r.parsed_at), hidden: true },
    { key: 'status', label: '状态', render: (r) => <span className={`tag act-${r.status === 'parsed' ? 'parsed' : r.status}`}>{{ parsed: '已解析', duplicate: '重复', failed: '失败' }[r.status] || r.status}</span> },
  ];
  return (
    <div className="files-stats">
      <div className="cards">{cards.map(([k, v]) => <div key={k} className="card"><div className="card-v">{v}</div><div className="card-k">{k}</div></div>)}</div>
      <div className="chips">{Object.entries(cats).sort((a, b) => b[1] - a[1]).map(([k, v]) => <span key={k} className="chip">主题分类·{k} {v}</span>)}</div>
      <DataTable id="libOverview" columns={columns} rows={rows} selectable selected={sel} onSelect={setSel} defaultSort={{ k: 'name', d: 1 }} empty="没有匹配的文档"
        actions={<><CompareButton ids={[...sel].filter((id) => (byId.get(id) || {}).status !== 'failed')} /><RecycleButton ids={[...sel]} done={() => setSel(new Set())} /></>}
        toolbar={(
          <>
            {!scopeTask && <select className="input" value={taskId} onChange={(e) => setTaskId(e.target.value)}>
              <option value="all">全部任务（{data.files.length} 个文档）</option>
              {data.tasks.map((t) => <option key={t.id} value={t.id}>#{t.id} {t.name}（{t.fileIds.length}，{STATUS_LABEL[t.status] || t.status}）</option>)}
            </select>}
            <select className="input" value={kind} onChange={(e) => setKind(e.target.value)}><option value="">全部类型</option><option value="ppt">PPT</option><option value="word">Word</option></select>
            <input className="input" placeholder="按路径 / 标签 / 作者 / 分类过滤" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 240 }} />
          </>
        )} />
    </div>
  );
}
