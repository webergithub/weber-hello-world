import React, { useEffect, useMemo, useState } from 'react';
import { api, fmtSize, fmtTime, KIND_LABEL, unitOf } from '../api';
import { useApp } from '../ctx';
import DataTable from './DataTable';
import { RecycleButton } from './Recycle';

const DAY = 86400000;
const RECENT = [['1d', '一天内', 1], ['7d', '一周内', 7], ['30d', '一个月内', 30]];
const STALE = [['180d', '半年以上', 180], ['365d', '1 年以上', 365], ['730d', '2 年以上', 730], ['1095d', '3 年以上', 1095]];
const ago = (t, now) => {
  if (!t) return '未知';
  const d = Math.floor((now - t) / DAY);
  if (d < 1) return '今天'; if (d < 30) return `${d} 天前`; if (d < 365) return `${Math.floor(d / 30)} 个月前`;
  return `${(d / 365).toFixed(1)} 年前`;
};

// 总览分析：近期访问 / 修改、长期未打开、读写数据统计
export default function AnalyticsView() {
  const app = useApp();
  const [data, setData] = useState(null);
  const [tab, setTab] = useState('recent');
  const [recent, setRecent] = useState('7d');
  const [recentBy, setRecentBy] = useState('any');
  const [stale, setStale] = useState('365d');
  const [sel, setSel] = useState(() => new Set());
  const load = () => api.analytics().then(setData);
  useEffect(() => { load(); }, [app.taskTick]);
  useEffect(() => { setSel(new Set()); }, [tab, recent, stale, recentBy]);
  if (!data) return <div className="empty-tip">正在统计…</div>;
  const { now, files } = data;
  const within = (t, days) => t && now - t <= days * DAY;
  const recentDays = RECENT.find((r) => r[0] === recent)[2];
  const staleDays = STALE.find((r) => r[0] === stale)[2];
  const recentRows = files.filter((f) => (recentBy === 'modified' ? within(f.mtime, recentDays) : recentBy === 'accessed' ? within(f.atime, recentDays) || within(f.lastView, recentDays) : within(f.lastOpen, recentDays)));
  const staleRows = files.filter((f) => f.lastOpen && now - f.lastOpen > staleDays * DAY);
  const count = (pred) => files.filter(pred).length;
  const tiles = [
    ['文档总数', files.length],
    ['一周内打开或修改', count((f) => within(f.lastOpen, 7))],
    ['一个月内修改', count((f) => within(f.mtime, 30))],
    ['半年以上未打开', count((f) => f.lastOpen && now - f.lastOpen > 180 * DAY)],
    ['1 年以上未打开', count((f) => f.lastOpen && now - f.lastOpen > 365 * DAY)],
    ['本工具内查看', files.reduce((a, f) => a + f.views, 0) + ' 次'],
    ['解析后又被修改', count((f) => f.modifiedSinceParse)],
  ];
  const columns = [
    { key: 'name', label: '文件名', render: (r) => <span className="link" title={r.path} onClick={() => app.openFile(r.id)}>{r.name}</span> },
    { key: 'kind', label: '类型', render: (r) => KIND_LABEL[r.kind] },
    { key: 'dir', label: '目录', className: 'muted small ellipsis', render: (r) => <span title={r.dir}>{r.dir}</span> },
    { key: 'lastOpen', label: '最近一次打开', sort: (r) => r.lastOpen || 0, className: 'small nowrap', render: (r) => <span title={fmtTime(r.lastOpen)}>{ago(r.lastOpen, now)}</span> },
    { key: 'mtime', label: '修改时间', sort: (r) => r.mtime || 0, className: 'small nowrap', render: (r) => <>{fmtTime(r.mtime)}{r.modifiedSinceParse && <span className="tag warn" title="解析后文件又被修改过，可重新扫描">已修改</span>}</> },
    { key: 'atime', label: '系统访问时间', sort: (r) => r.atime || 0, className: 'small nowrap', render: (r) => (r.atime ? fmtTime(r.atime) : <span className="muted" title="系统未记录或仅有本工具解析时的读取">未知</span>) },
    { key: 'lastView', label: '本工具内查看', sort: (r) => r.lastView || 0, className: 'small nowrap', render: (r) => (r.lastView ? `${fmtTime(r.lastView)}（${r.views} 次）` : '') },
    { key: 'opens', label: '从本工具打开', sort: (r) => r.opens, render: (r) => r.opens || '' , hidden: true },
    { key: 'ctime', label: '创建时间', sort: (r) => r.ctime || 0, className: 'small nowrap', render: (r) => fmtTime(r.ctime), hidden: true },
    { key: 'slide_count', label: '页数/节数', sort: (r) => r.slide_count || 0, render: (r) => `${r.slide_count || 0} ${unitOf(r)}` },
    { key: 'size', label: '大小', sort: (r) => r.size || 0, className: 'nowrap', render: (r) => fmtSize(r.size) },
    { key: 'author', label: '作者' },
    { key: 'category', label: '主题分类', hidden: true },
    { key: 'ops', label: '操作', nosort: true, className: 'nowrap', render: (r) => <><button className="btn tiny" onClick={() => api.openPath(r.path)}>打开</button><button className="btn tiny" onClick={() => api.showItem(r.path)}>位置</button></> },
  ];
  const listRows = tab === 'recent' ? recentRows : staleRows;
  return (
    <div className="view">
      <div className="view-head">
        <div className="vh-title">📈 总览分析</div>
        <span className="muted small">“最近一次打开”综合系统访问时间、修改时间与本工具内的查看 / 打开记录（已扣除本工具解析时产生的读取）</span>
        <div className="spacer" />
        <button className="btn" onClick={load}>刷新统计</button>
      </div>
      <div className="tab-body scroll pad analytics">
        <div className="stat-tiles">{tiles.map(([k, v]) => <div key={k} className="stat-tile"><div className="st-v">{v}</div><div className="st-k">{k}</div></div>)}</div>
        <div className="tabs attached">
          <button className={tab === 'recent' ? 'on' : ''} onClick={() => setTab('recent')}>🕒 近期访问 / 修改</button>
          <button className={tab === 'stale' ? 'on' : ''} onClick={() => setTab('stale')}>💤 长期未打开</button>
          <button className={tab === 'stats' ? 'on' : ''} onClick={() => setTab('stats')}>📊 读写统计</button>
        </div>
        <div className="attached-body">
          {tab !== 'stats' && (
            <DataTable id={`analytics-${tab}`} columns={columns} rows={listRows} selectable selected={sel} onSelect={setSel}
              defaultSort={tab === 'recent' ? { k: 'lastOpen', d: -1 } : { k: 'lastOpen', d: 1 }} maxHeight="56vh"
              empty={tab === 'recent' ? '这个时间范围内没有访问或修改过的文档' : '没有长期未打开的文档'}
              toolbar={tab === 'recent' ? (
                <>
                  <div className="seg small">{RECENT.map(([k, v]) => <button key={k} className={recent === k ? 'on' : ''} onClick={() => setRecent(k)}>{v}</button>)}</div>
                  <div className="seg small">{[['any', '打开或修改'], ['accessed', '仅访问'], ['modified', '仅修改']].map(([k, v]) => <button key={k} className={recentBy === k ? 'on' : ''} onClick={() => setRecentBy(k)}>{v}</button>)}</div>
                </>
              ) : (
                <div className="seg small">{STALE.map(([k, v]) => <button key={k} className={stale === k ? 'on' : ''} onClick={() => setStale(k)}>{v}未打开</button>)}</div>
              )}
              actions={<RecycleButton ids={[...sel]} done={() => { setSel(new Set()); load(); }} />} />
          )}
          {tab === 'stats' && <Stats data={data} />}
        </div>
      </div>
    </div>
  );
}

function Stats({ data }) {
  const { now, files } = data;
  const months = useMemo(() => {
    const out = [];
    const d = new Date(now);
    for (let i = 23; i >= 0; i--) {
      const m = new Date(d.getFullYear(), d.getMonth() - i, 1);
      const next = new Date(d.getFullYear(), d.getMonth() - i + 1, 1);
      out.push({ label: `${String(m.getFullYear()).slice(2)}/${m.getMonth() + 1}`, full: `${m.getFullYear()} 年 ${m.getMonth() + 1} 月`, value: files.filter((f) => f.mtime >= m.getTime() && f.mtime < next.getTime()).length });
    }
    return out;
  }, [files, now]);
  const bucket = (getT, edges) => edges.map(([label, lo, hi]) => ({ label, value: files.filter((f) => { const t = getT(f); if (!t) return lo === null; if (lo === null) return false; const age = (now - t) / DAY; return age >= lo && age < hi; }).length }));
  const AGE = [['一天内', 0, 1], ['一周内', 1, 7], ['一个月内', 7, 30], ['1-6 个月', 30, 180], ['半年-1 年', 180, 365], ['1-2 年', 365, 730], ['2-3 年', 730, 1095], ['3 年以上', 1095, 1e9], ['未知', null, null]];
  const sizeB = [['< 1MB', 0, 1], ['1-10MB', 1, 10], ['10-50MB', 10, 50], ['50-200MB', 50, 200], ['≥ 200MB', 200, 1e9]].map(([label, lo, hi]) => ({ label, value: files.filter((f) => f.size / 1048576 >= lo && f.size / 1048576 < hi).length }));
  const top = (key, n = 10) => {
    const m = new Map();
    for (const f of files) { const k = f[key] || '（未知）'; m.set(k, (m.get(k) || 0) + 1); }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([label, value]) => ({ label, value }));
  };
  const days = useMemo(() => {
    const out = [];
    for (let i = 29; i >= 0; i--) {
      const start = new Date(now - i * DAY); start.setHours(0, 0, 0, 0);
      const end = start.getTime() + DAY;
      out.push({ label: `${start.getMonth() + 1}/${start.getDate()}`, full: `${start.getMonth() + 1} 月 ${start.getDate()} 日`, value: data.history.filter((h) => h.at >= start.getTime() && h.at < end).length, views: data.viewTimes.filter((t) => t >= start.getTime() && t < end).length });
    }
    return out;
  }, [data, now]);
  const viewed = files.filter((f) => f.views || f.opens).sort((a, b) => (b.views + b.opens) - (a.views + a.opens)).slice(0, 10).map((f) => ({ label: f.name, value: f.views + f.opens }));
  return (
    <div className="stats-grid">
      <ChartCard title="按月修改的文档数（近 24 个月）" wide><Columns data={months} unit="个文档" /></ChartCard>
      <ChartCard title="最近一次打开距今"><Bars data={bucket((f) => f.lastOpen, AGE)} unit="个文档" /></ChartCard>
      <ChartCard title="最后修改距今"><Bars data={bucket((f) => f.mtime, AGE.slice(0, 8))} unit="个文档" /></ChartCard>
      <ChartCard title="解析处理量（近 30 天，每日处理文件次数）" wide><Columns data={days} unit="次" /></ChartCard>
      <ChartCard title="本工具内查看（近 30 天，每日次数）" wide><Columns data={days.map((d) => ({ ...d, value: d.views }))} unit="次" /></ChartCard>
      <ChartCard title="文件大小分布"><Bars data={sizeB} unit="个文档" /></ChartCard>
      <ChartCard title="文档类型"><Bars data={top('kind').map((x) => ({ ...x, label: KIND_LABEL[x.label] || x.label }))} unit="个文档" /></ChartCard>
      <ChartCard title="文档最多的目录（Top 10）"><Bars data={top('dir')} unit="个文档" /></ChartCard>
      <ChartCard title="作者（Top 10）"><Bars data={top('author')} unit="个文档" /></ChartCard>
      <ChartCard title="主题分类"><Bars data={top('category')} unit="个文档" /></ChartCard>
      <ChartCard title="本工具内最常查看 / 打开（Top 10）">{viewed.length ? <Bars data={viewed} unit="次" /> : <div className="muted small">还没有查看记录</div>}</ChartCard>
    </div>
  );
}

function ChartCard({ title, wide, children }) {
  return <div className={`chart-card ${wide ? 'wide' : ''}`}><div className="cc-title">{title}</div>{children}</div>;
}

// 横向条形：单一系列，数值标在条形末端，悬停显示提示
function Bars({ data, unit }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <div className="hbars">
      {data.map((d) => (
        <div key={d.label} className="hb-row" title={`${d.label}：${d.value} ${unit}`}>
          <div className="hb-label" title={d.label}>{d.label}</div>
          <div className="hb-track">{d.value > 0 && <div className="hb-bar" style={{ width: `${(d.value / max) * 100}%` }} />}</div>
          <div className="hb-val">{d.value}</div>
        </div>
      ))}
    </div>
  );
}

// 柱状图：单一系列；只标注最大值，其余由悬停提示与坐标轴给出
function Columns({ data, unit }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  const [hover, setHover] = useState(null);
  const peak = data.reduce((a, d, i) => (d.value > (data[a] ? data[a].value : -1) ? i : a), 0);
  const step = niceStep(max);
  const top = Math.ceil(max / step) * step;
  const ticks = []; for (let t = 0; t <= top; t += step) ticks.push(t);
  return (
    <div className="cols">
      <div className="cols-axis">{ticks.map((t) => <span key={t} style={{ bottom: `${(t / top) * 100}%` }}>{t}</span>)}</div>
      <div className="cols-plot">
        {ticks.map((t) => <div key={t} className="cols-grid" style={{ bottom: `${(t / top) * 100}%` }} />)}
        {data.map((d, i) => (
          <div key={i} className="col-slot" onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
            <div className="col-bar" style={{ height: `${(d.value / top) * 100}%` }}>{i === peak && d.value > 0 && <span className="col-val">{d.value}</span>}</div>
            {hover === i && <div className="col-tip"><b>{d.full || d.label}</b><br />{d.value} {unit}</div>}
          </div>
        ))}
      </div>
      <div className="cols-x">{data.map((d, i) => <span key={i}>{i % Math.ceil(data.length / 8) === 0 || i === data.length - 1 ? d.label : ''}</span>)}</div>
    </div>
  );
}

// 坐标轴取整：1 / 2 / 5 × 10^n
function niceStep(max) {
  const raw = Math.max(1, max) / 4;
  const p = 10 ** Math.floor(Math.log10(raw));
  const m = raw / p;
  return Math.max(1, (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p);
}
