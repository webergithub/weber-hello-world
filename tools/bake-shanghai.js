#!/usr/bin/env node
/* 烘焙上海真实地图数据 -> cities.js（追加）
 * 数据来源：地铁站点/黄浦江/道路/公园/地标按真实经纬度手工描摹（OpenStreetMap 目视校准）
 * 用法: node tools/bake-shanghai.js >> cities.js
 */
'use strict';

const BBOX = { lonMin: 121.440, lonMax: 121.545, latMin: 31.195, latMax: 31.260 };
const LON0 = (BBOX.lonMin + BBOX.lonMax) / 2;   // 121.4925
const LAT0 = (BBOX.latMin + BBOX.latMax) / 2;   // 31.2275
const M_PER_LON = 111320 * Math.cos(LAT0 * Math.PI / 180);
const M_PER_LAT = 111132;
const S = 0.24;
const px = (lon) => +(((lon - LON0) * M_PER_LON) * S).toFixed(1);
const pz = (lat) => +((-(lat - LAT0) * M_PER_LAT) * S).toFixed(1);
const P = (lon, lat) => [px(lon), pz(lat)];

/* ---------- 地铁（真实站名/近似真实坐标） ---------- */
const ST = [
  ['jas', '静安寺', 121.4455, 31.2235], ['nxr', '南京西路', 121.4600, 31.2310],
  ['rmgc', '人民广场', 121.4740, 31.2330], ['njdl', '南京东路', 121.4830, 31.2385],
  ['ljz', '陆家嘴', 121.4985, 31.2395], ['dcl', '东昌路', 121.5110, 31.2345],
  ['sjdd', '世纪大道', 121.5270, 31.2290],
  ['csl', '常熟路', 121.4495, 31.2150], ['sxnl', '陕西南路', 121.4565, 31.2175],
  ['hpnl', '黄陂南路', 121.4690, 31.2205], ['xzl', '新闸路', 121.4700, 31.2400],
  ['hzl', '汉中路', 121.4630, 31.2455],
  ['lxm', '老西门', 121.4820, 31.2170], ['yy', '豫园', 121.4905, 31.2260],
  ['ttl', '天潼路', 121.4820, 31.2480],
];
const stations = ST.map(([id, name, lon, lat]) => ({ id, name, p: P(lon, lat) }));
const lines = [
  { name: '2号线', color: '#97D700', loop: false, stations: ['jas', 'nxr', 'rmgc', 'njdl', 'ljz', 'dcl', 'sjdd'] },
  { name: '1号线', color: '#E4002B', loop: false, stations: ['csl', 'sxnl', 'hpnl', 'rmgc', 'xzl', 'hzl'] },
  { name: '10号线', color: '#C1A7E2', loop: false, stations: ['lxm', 'yy', 'njdl', 'ttl'] },
];

/* ---------- 黄浦江（陆家嘴大转弯） ---------- */
const river = [
  [121.4760, 31.2040], [121.4850, 31.2120], [121.4930, 31.2200], [121.4955, 31.2265],
  [121.4930, 31.2320], [121.4905, 31.2375], [121.4900, 31.2420], [121.4935, 31.2465],
  [121.5010, 31.2500], [121.5110, 31.2520], [121.5250, 31.2525], [121.5400, 31.2510],
].map(([lon, lat]) => P(lon, lat));

const bridges = [
  { name: '南浦大桥', a: [121.4850, 31.2120], b: [121.4975, 31.2075], tower: true },
  { name: '外白渡桥', a: [121.4895, 31.2452], b: [121.4920, 31.2468], foot: true },
].map((b) => ({ name: b.name, a: P(...b.a), b: P(...b.b), foot: !!b.foot, tower: !!b.tower }));

/* 轮渡（上海特色！金陵东路渡口 ↔ 东昌路渡口） */
const ferries = [
  { name: '金陵东路轮渡', a: P(121.4880, 31.2320), b: P(121.5000, 31.2350) },
];

const streets = [
  { name: '南京东路', w: 20, pts: [[121.4740, 31.2330], [121.4800, 31.2365], [121.4855, 31.2390], [121.4893, 31.2400]] },
  { name: '南京西路', w: 20, pts: [[121.4455, 31.2240], [121.4550, 31.2280], [121.4660, 31.2310], [121.4740, 31.2330]] },
  { name: '中山东一路', w: 24, pts: [[121.4908, 31.2265], [121.4898, 31.2330], [121.4890, 31.2390], [121.4900, 31.2440]] },
  { name: '延安东路', w: 24, pts: [[121.4460, 31.2210], [121.4600, 31.2230], [121.4750, 31.2260], [121.4875, 31.2290]] },
  { name: '西藏中路', w: 20, pts: [[121.4705, 31.2200], [121.4735, 31.2330], [121.4715, 31.2420]] },
  { name: '淮海中路', w: 20, pts: [[121.4450, 31.2185], [121.4570, 31.2200], [121.4690, 31.2212]] },
  { name: '河南中路', w: 16, pts: [[121.4850, 31.2280], [121.4840, 31.2380], [121.4830, 31.2440]] },
  { name: '世纪大道', w: 26, pts: [[121.5000, 31.2390], [121.5100, 31.2350], [121.5200, 31.2310], [121.5280, 31.2290]] },
  { name: '陆家嘴环路', w: 16, pts: [[121.4990, 31.2405], [121.5040, 31.2400], [121.5060, 31.2360], [121.5010, 31.2345], [121.4975, 31.2370], [121.4990, 31.2405]] },
  { name: '福州路', w: 16, pts: [[121.4740, 31.2300], [121.4820, 31.2330], [121.4880, 31.2350]] },
].map((s) => ({ name: s.name, w: Math.round(s.w * S * 2.2), pts: s.pts.map(([lon, lat]) => P(lon, lat)) }));

const parks = [
  { name: '人民公园', c: [121.4715, 31.2345], rx: 260, rz: 150 },
  { name: '黄浦公园', c: [121.4905, 31.2442], rx: 90, rz: 80 },
  { name: '陆家嘴绿地', c: [121.4998, 31.2372], rx: 150, rz: 130 },
  { name: '古典园林', c: [121.4928, 31.2268], rx: 95, rz: 85 },
].map((p) => ({ name: p.name, p: P(...p.c), rx: Math.round(p.rx * S), rz: Math.round(p.rz * S) }));

const landmarks = [
  { type: 'customhouse', zh: '钟楼大楼', c: [121.4898, 31.2365] },   // 海关大楼（整点钟声）
  { type: 'pearltower',  zh: '球塔',     c: [121.4995, 31.2415] },   // 东方明珠
  { type: 'twisttower',  zh: '螺旋巨塔', c: [121.5055, 31.2335] },   // 上海中心
  { type: 'jinmao',      zh: '宝塔楼',   c: [121.5045, 31.2365] },   // 金茂大厦
  { type: 'wfc',         zh: '开瓶器楼', c: [121.5075, 31.2350] },   // 环球金融中心
  { type: 'pavilion',    zh: '古亭',     c: [121.4920, 31.2262] },   // 豫园湖心亭
  { type: 'column',      zh: '纪念塔',   c: [121.4903, 31.2448] },   // 人民英雄纪念塔
  { type: 'palace',      zh: '大剧院',   c: [121.4700, 31.2320] },   // 上海大剧院
].map((l) => ({ type: l.type, zh: l.zh, p: P(...l.c) }));

const busRoutes = [
  {
    name: '20 路', color: '#2f7fd6',
    pts: [[121.4455, 31.2240], [121.4550, 31.2280], [121.4660, 31.2310], [121.4740, 31.2330], [121.4800, 31.2365], [121.4855, 31.2390], [121.4893, 31.2400], [121.4890, 31.2390], [121.4898, 31.2330], [121.4908, 31.2265]],
  },
].map((r) => ({ name: r.name, color: r.color, pts: r.pts.map(([lon, lat]) => P(lon, lat)) }));

const data = {
  shanghai: {
    name: '上海',
    nameEn: 'Shanghai',
    bounds: { minX: px(BBOX.lonMin), maxX: px(BBOX.lonMax), minZ: pz(BBOX.latMax), maxZ: pz(BBOX.latMin) },
    riverWidth: Math.round(400 * S),
    stations, lines, river, bridges, streets, parks, landmarks, busRoutes, ferries,
    market: P(121.4915, 31.2252),        // 城隍庙市集
    boothColor: 0x2f6f4f, postbox: false, // 绿色报刊亭
    treeStreet: '中山东一路',
    spawn: { x: px(121.4873), z: pz(31.2375), yaw: -1.57 }, // 外滩，面向对岸
    zones: [
      // 陆家嘴：玻璃超高层
      { r: [px(121.4940), pz(31.2500), px(121.5300), pz(31.2250)], pal: ['玻璃蓝', '玻璃蓝', '灰'], h: [20, 45], tall: { c: 0.3, h: [60, 130] } },
      // 外滩：石材万国建筑
      { r: [px(121.4840), pz(31.2460), px(121.4905), pz(31.2280)], pal: ['米白', '米白', '灰'], h: [14, 24] },
      // 老城厢：低层砖木
      { r: [px(121.4780), pz(31.2300), px(121.4970), pz(31.2180)], pal: ['砖红', '砖红', '彩'], h: [6, 12] },
    ],
    zoneDefault: { pal: ['米白', '灰', '砖红', '彩'], h: [12, 26], tall: { c: 0.06, h: [35, 60] } },
    banned: ['外滩', '陆家嘴', '东方明珠', '明珠', '人民广场', '南京路', '豫园', '城隍庙', '黄浦',
      '浦东', '浦西', '世纪大道', '静安', '淮海', '金茂', '环球', '海关', '大剧院', '轮渡', '渡口',
      'bund', 'pearl', 'lujiazui', 'huangpu', 'pudong', 'yuyuan', 'nanjing road'],
  },
};

process.stdout.write('window.CITY_DATA = Object.assign(window.CITY_DATA || {}, ' + JSON.stringify(data) + ');\n');
console.error(`✔ 上海: 站点 ${stations.length}, 线路 ${lines.length}, 轮渡 ${ferries.length}`);
