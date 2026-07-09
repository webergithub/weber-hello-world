#!/usr/bin/env node
/* 烘焙伦敦真实地图数据 -> cities.js
 * 数据来源：
 *   - 伦敦地铁站点/线路/连接: nicola/tubemaps 数据集（源自维基百科/TfL 公开数据）
 *     https://github.com/nicola/tubemaps
 *   - 泰晤士河/主干道/公园/地标: 按真实经纬度手工描摹（OpenStreetMap 目视校准）
 * 用法: node tools/bake-london.js <stations.csv> <connections.csv> <lines.csv> > cities.js
 */
'use strict';
const fs = require('fs');

const [stationsCsv, connectionsCsv, linesCsv] = process.argv.slice(2);
if (!linesCsv) {
  console.error('用法: node bake-london.js stations.csv connections.csv lines.csv > cities.js');
  process.exit(1);
}

/* ---------- CSV 解析 ---------- */
function parseCSV(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQ) {
        if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
        else cur += ch;
      } else if (ch === '"') inQ = true;
      else if (ch === ',') { cells.push(cur); cur = ''; }
      else cur += ch;
    }
    cells.push(cur);
    rows.push(cells);
  }
  const head = rows.shift();
  return rows.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

const stations = parseCSV(fs.readFileSync(stationsCsv, 'utf8'));
const connections = parseCSV(fs.readFileSync(connectionsCsv, 'utf8'));
const lines = parseCSV(fs.readFileSync(linesCsv, 'utf8'));

/* ---------- 投影：中心伦敦 bbox -> 游戏米制坐标 ---------- */
const BBOX = { lonMin: -0.155, lonMax: -0.065, latMin: 51.493, latMax: 51.521 };
const LON0 = (BBOX.lonMin + BBOX.lonMax) / 2;   // -0.11
const LAT0 = (BBOX.latMin + BBOX.latMax) / 2;   // 51.507
const M_PER_LON = 111320 * Math.cos(LAT0 * Math.PI / 180); // ≈69315
const M_PER_LAT = 111132;
const S = 0.24; // 真实世界 -> 游戏缩放

const px = (lon) => +(((lon - LON0) * M_PER_LON) * S).toFixed(1);
const pz = (lat) => +((-(lat - LAT0) * M_PER_LAT) * S).toFixed(1); // 北 = -z
const P = (lon, lat) => [px(lon), pz(lat)];
const inBox = (lon, lat) => lon >= BBOX.lonMin && lon <= BBOX.lonMax && lat >= BBOX.latMin && lat <= BBOX.latMax;

/* ---------- 站点过滤 ---------- */
const stById = new Map();
stations.forEach((s) => {
  const lat = +s.latitude, lon = +s.longitude;
  stById.set(s.id, { id: s.id, lat, lon, name: s.name, keep: inBox(lon, lat) });
});

/* ---------- 每条线提取 bbox 内的站点链 ---------- */
const lineById = new Map();
lines.forEach((l) => lineById.set(l.line, { name: l.name.replace(/ Line$/, ''), colour: '#' + l.colour }));

const adjByLine = new Map();
connections.forEach((c) => {
  const a = stById.get(c.station1), b = stById.get(c.station2);
  if (!a || !b || !a.keep || !b.keep) return;
  if (!adjByLine.has(c.line)) adjByLine.set(c.line, new Map());
  const adj = adjByLine.get(c.line);
  if (!adj.has(a.id)) adj.set(a.id, new Set());
  if (!adj.has(b.id)) adj.set(b.id, new Set());
  adj.get(a.id).add(b.id);
  adj.get(b.id).add(a.id);
});

function extractChains(adj) {
  // 从度=1 的端点开始走链；处理环线
  const visitedEdges = new Set();
  const chains = [];
  const ekey = (a, b) => (a < b ? a + '|' + b : b + '|' + a);
  const walk = (start) => {
    const chain = [start];
    let cur = start, prev = null;
    for (;;) {
      const nexts = [...adj.get(cur)].filter((n) => n !== prev && !visitedEdges.has(ekey(cur, n)));
      if (!nexts.length) break;
      const n = nexts[0];
      visitedEdges.add(ekey(cur, n));
      chain.push(n);
      prev = cur; cur = n;
      if (cur === start) break; // 环
    }
    return chain;
  };
  const deg1 = [...adj.keys()].filter((k) => adj.get(k).size === 1);
  deg1.forEach((k) => {
    const hasUnvisited = [...adj.get(k)].some((n) => !visitedEdges.has(ekey(k, n)));
    if (hasUnvisited) chains.push(walk(k));
  });
  // 剩余（环线）
  [...adj.keys()].forEach((k) => {
    const hasUnvisited = [...adj.get(k)].some((n) => !visitedEdges.has(ekey(k, n)));
    if (hasUnvisited) chains.push(walk(k));
  });
  return chains.filter((c) => c.length >= 2);
}

const outLines = [];
const usedStations = new Set();
[...adjByLine.entries()].forEach(([lineId, adj]) => {
  const info = lineById.get(lineId);
  const chains = extractChains(adj).sort((a, b) => b.length - a.length).slice(0, 2);
  chains.forEach((chain, ci) => {
    if (chain.length < 2) return;
    const loop = chain[0] === chain[chain.length - 1] && chain.length > 3;
    if (loop) chain.pop();
    chain.forEach((id) => usedStations.add(id));
    outLines.push({
      name: info.name + (chains.length > 1 ? ` ${ci + 1}` : ''),
      color: info.colour,
      loop,
      stations: chain,
    });
  });
});

const outStations = [...usedStations].map((id) => {
  const s = stById.get(id);
  return { id: s.id, name: s.name, p: P(s.lon, s.lat) };
});

/* ---------- 手工描摹的地理要素（真实经纬度） ---------- */
const thames = [
  [-0.1268, 51.4895], [-0.1235, 51.4945], [-0.1225, 51.5000], [-0.1210, 51.5045],
  [-0.1180, 51.5065], [-0.1145, 51.5080], [-0.1100, 51.5090], [-0.1040, 51.5097],
  [-0.0985, 51.5098], [-0.0940, 51.5090], [-0.0895, 51.5078], [-0.0865, 51.5068],
  [-0.0820, 51.5058], [-0.0754, 51.5052], [-0.0700, 51.5058], [-0.0640, 51.5070],
].map(([lon, lat]) => P(lon, lat));

const bridges = [
  { name: '威斯敏斯特桥', a: [-0.1243, 51.5006], b: [-0.1196, 51.5013] },
  { name: '滑铁卢桥',    a: [-0.1170, 51.5093], b: [-0.1140, 51.5050] },
  { name: '黑衣修士桥',  a: [-0.1046, 51.5115], b: [-0.1035, 51.5082] },
  { name: '千禧桥',      a: [-0.0986, 51.5109], b: [-0.0982, 51.5078], foot: true },
  { name: '伦敦桥',      a: [-0.0879, 51.5095], b: [-0.0872, 51.5058] },
  { name: '塔桥',        a: [-0.0754, 51.5076], b: [-0.0754, 51.5028], tower: true },
].map((b) => ({ name: b.name, a: P(...b.a), b: P(...b.b), foot: !!b.foot, tower: !!b.tower }));

const streets = [
  { name: '林荫路',      w: 25, pts: [[-0.1405, 51.5019], [-0.1350, 51.5041], [-0.1289, 51.5064]] },
  { name: '白厅街',      w: 25, pts: [[-0.1280, 51.5070], [-0.1262, 51.5035], [-0.1256, 51.5008]] },
  { name: '维多利亚街',  w: 22, pts: [[-0.1256, 51.5000], [-0.1320, 51.4975], [-0.1400, 51.4953]] },
  { name: '河岸街-舰队街', w: 22, pts: [[-0.1270, 51.5080], [-0.1230, 51.5093], [-0.1170, 51.5110], [-0.1120, 51.5125], [-0.1050, 51.5140], [-0.0995, 51.5140], [-0.0940, 51.5122], [-0.0888, 51.5127], [-0.0820, 51.5138], [-0.0757, 51.5142]] },
  { name: '牛津街',      w: 22, pts: [[-0.1550, 51.5150], [-0.1480, 51.5152], [-0.1418, 51.5154], [-0.1360, 51.5160], [-0.1300, 51.5165]] },
  { name: '摄政街',      w: 20, pts: [[-0.1418, 51.5154], [-0.1400, 51.5120], [-0.1346, 51.5100]] },
  { name: '皮卡迪利街',  w: 20, pts: [[-0.1346, 51.5100], [-0.1420, 51.5075], [-0.1510, 51.5033]] },
  { name: '沙夫茨伯里大道', w: 18, pts: [[-0.1346, 51.5100], [-0.1300, 51.5128], [-0.1279, 51.5136]] },
  { name: '查令十字路',  w: 18, pts: [[-0.1280, 51.5078], [-0.1288, 51.5120], [-0.1300, 51.5165]] },
  { name: '国王大道',    w: 20, pts: [[-0.1170, 51.5110], [-0.1185, 51.5140], [-0.1198, 51.5175]] },
  { name: '维多利亚堤岸', w: 20, pts: [[-0.1228, 51.5012], [-0.1215, 51.5060], [-0.1180, 51.5078], [-0.1120, 51.5100], [-0.1046, 51.5112]] },
  { name: '南岸步道',    w: 14, pts: [[-0.1195, 51.5020], [-0.1160, 51.5055], [-0.1110, 51.5070], [-0.1030, 51.5080], [-0.0960, 51.5072], [-0.0880, 51.5052], [-0.0800, 51.5040], [-0.0757, 51.5032]] },
  { name: '博罗高街',    w: 20, pts: [[-0.0872, 51.5058], [-0.0880, 51.5010], [-0.0890, 51.4960]] },
  { name: '主教门大街',  w: 20, pts: [[-0.0885, 51.5120], [-0.0840, 51.5148], [-0.0810, 51.5175]] },
  { name: '坎农街',      w: 18, pts: [[-0.0995, 51.5128], [-0.0940, 51.5115], [-0.0888, 51.5112]] },
].map((s) => ({ name: s.name, w: Math.round(s.w * S * 2.2), pts: s.pts.map(([lon, lat]) => P(lon, lat)) }));

const parks = [
  { name: '圣詹姆斯公园', c: [-0.1349, 51.5027], rx: 430, rz: 170 },
  { name: '绿园',        c: [-0.1447, 51.5042], rx: 300, rz: 220 },
  { name: '禧年花园',    c: [-0.1195, 51.5031], rx: 110, rz: 80 },
  { name: '维多利亚塔花园', c: [-0.1247, 51.4962], rx: 90, rz: 150 },
  { name: '林肯律师学院广场', c: [-0.1160, 51.5162], rx: 120, rz: 100 },
].map((p) => ({ name: p.name, p: P(...p.c), rx: Math.round(p.rx * S), rz: Math.round(p.rz * S) }));

const landmarks = [
  { type: 'bigben',    zh: '大本钟',     c: [-0.12462, 51.50072] },
  { type: 'parliament', zh: '议会大厦',  c: [-0.1252, 51.4998] },
  { type: 'abbey',     zh: '西敏寺',     c: [-0.1273, 51.4993] },
  { type: 'eye',       zh: '摩天轮',     c: [-0.11964, 51.50333] },
  { type: 'stpauls',   zh: '圆顶大教堂', c: [-0.09833, 51.51384] },
  { type: 'shard',     zh: '碎片大厦',   c: [-0.08652, 51.50452] },
  { type: 'gherkin',   zh: '小黄瓜大楼', c: [-0.08033, 51.51442] },
  { type: 'castle',    zh: '古堡',       c: [-0.07594, 51.50811] },
  { type: 'column',    zh: '纪念柱',     c: [-0.12796, 51.50776] },
  { type: 'palace',    zh: '宫殿',       c: [-0.14189, 51.50139] },
].map((l) => ({ type: l.type, zh: l.zh, p: P(...l.c) }));

/* 公交线路（沿真实街道） */
const busRoutes = [
  {
    name: '11 路', color: '#c0281c',
    pts: [[-0.1400, 51.4953], [-0.1320, 51.4975], [-0.1256, 51.5000], [-0.1256, 51.5008], [-0.1262, 51.5035], [-0.1280, 51.5070], [-0.1270, 51.5080], [-0.1230, 51.5093], [-0.1170, 51.5110], [-0.1120, 51.5125], [-0.1050, 51.5140], [-0.0995, 51.5140], [-0.0940, 51.5122], [-0.0888, 51.5127]],
  },
  {
    name: '15 路', color: '#c0281c',
    pts: [[-0.1418, 51.5154], [-0.1400, 51.5120], [-0.1346, 51.5100], [-0.1300, 51.5128], [-0.1288, 51.5120], [-0.1280, 51.5078], [-0.1270, 51.5080], [-0.1230, 51.5093], [-0.1170, 51.5110], [-0.1170, 51.5093], [-0.1140, 51.5050], [-0.1110, 51.5070], [-0.1030, 51.5080], [-0.0960, 51.5072], [-0.0880, 51.5052], [-0.0800, 51.5040], [-0.0757, 51.5032]],
  },
].map((r) => ({ name: r.name, color: r.color, pts: r.pts.map(([lon, lat]) => P(lon, lat)) }));

/* ---------- 输出 ---------- */
const data = {
  london: {
    name: '伦敦',
    nameEn: 'London',
    bounds: {
      minX: px(BBOX.lonMin), maxX: px(BBOX.lonMax),
      minZ: pz(BBOX.latMax), maxZ: pz(BBOX.latMin),
    },
    riverWidth: Math.round(240 * S),
    stations: outStations,
    lines: outLines,
    thames, bridges, streets, parks, landmarks, busRoutes,
  },
};

process.stdout.write(
  '/* 由 tools/bake-london.js 自动生成 —— 请勿手改\n' +
  ' * 地铁数据来源: github.com/nicola/tubemaps (维基百科/TfL 公开数据)\n' +
  ' * 地理要素按真实经纬度描摹, 比例 1:' + Math.round(1 / S) + ' */\n' +
  'window.CITY_DATA = ' + JSON.stringify(data) + ';\n'
);
console.error(`✔ 站点 ${outStations.length} 个, 线路链 ${outLines.length} 条`);
outLines.forEach((l) => console.error(`  - ${l.name} (${l.stations.length} 站${l.loop ? ', 环线' : ''})`));
