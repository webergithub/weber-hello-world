#!/usr/bin/env node
/* 纽约（曼哈顿中下城）真实地图数据 -> cities.js（追加） */
'use strict';
const BBOX = { lonMin: -74.025, lonMax: -73.955, latMin: 40.700, latMax: 40.775 };
const LON0 = (BBOX.lonMin + BBOX.lonMax) / 2, LAT0 = (BBOX.latMin + BBOX.latMax) / 2;
const M_PER_LON = 111320 * Math.cos(LAT0 * Math.PI / 180), M_PER_LAT = 111132, S = 0.24;
const px = (lon) => +(((lon - LON0) * M_PER_LON) * S).toFixed(1);
const pz = (lat) => +((-(lat - LAT0) * M_PER_LAT) * S).toFixed(1);
const P = (lon, lat) => [px(lon), pz(lat)];
const ST = [
  ['sf', 'South Ferry', -74.0135, 40.7020], ['ch', 'Chambers St', -74.0090, 40.7150],
  ['s14', '14 St', -73.9990, 40.7370], ['ts', 'Times Sq–42 St', -73.9870, 40.7560],
  ['cc', '59 St–Columbus', -73.9820, 40.7680],
  ['bg', 'Bowling Green', -74.0140, 40.7050], ['bb', 'Brooklyn Bridge', -74.0040, 40.7130],
  ['us', 'Union Sq–14 St', -73.9900, 40.7350], ['gc', 'Grand Central', -73.9770, 40.7520],
  ['s59', '59 St', -73.9675, 40.7625],
  ['ca', 'Canal St', -74.0000, 40.7190], ['hs', 'Herald Sq–34 St', -73.9880, 40.7500],
  ['s57', '57 St–7 Av', -73.9800, 40.7645],
];
const stations = ST.map(([id, name, lon, lat]) => ({ id, name, p: P(lon, lat) }));
const lines = [
  { name: '1 线', color: '#EE352E', loop: false, stations: ['sf', 'ch', 's14', 'ts', 'cc'] },
  { name: '4·5·6 线', color: '#00933C', loop: false, stations: ['bg', 'bb', 'us', 'gc', 's59'] },
  { name: 'N·Q 线', color: '#FCCC0A', loop: false, stations: ['ca', 'us', 'hs', 'ts', 's57'] },
];
const river = [
  [-73.9580, 40.7750], [-73.9620, 40.7600], [-73.9680, 40.7450], [-73.9710, 40.7350],
  [-73.9740, 40.7200], [-73.9780, 40.7100], [-73.9950, 40.7020], [-74.0100, 40.7005],
].map(([lon, lat]) => P(lon, lat));
const bridges = [
  { name: '布鲁克林大桥', a: [-74.0040, 40.7128], b: [-73.9900, 40.7040], tower: true },
  { name: '曼哈顿大桥', a: [-73.9930, 40.7145], b: [-73.9840, 40.7045] },
].map((b) => ({ name: b.name, a: P(...b.a), b: P(...b.b), foot: !!b.foot, tower: !!b.tower }));
const ferries = [{ name: '东河轮渡', a: P(-74.0080, 40.7035), b: P(-73.9890, 40.7028) }];
const streets = [
  { name: '百老汇', w: 22, pts: [[-74.0135, 40.7050], [-74.0090, 40.7150], [-74.0005, 40.7190], [-73.9900, 40.7350], [-73.9880, 40.7500], [-73.9870, 40.7560], [-73.9820, 40.7680]] },
  { name: '第五大道', w: 20, pts: [[-73.9950, 40.7320], [-73.9895, 40.7400], [-73.9857, 40.7460], [-73.9790, 40.7560], [-73.9730, 40.7645]] },
  { name: '42 街', w: 20, pts: [[-73.9710, 40.7500], [-73.9770, 40.7520], [-73.9870, 40.7560], [-74.0000, 40.7590]] },
  { name: '34 街', w: 18, pts: [[-73.9740, 40.7440], [-73.9880, 40.7500], [-74.0020, 40.7550]] },
  { name: '华尔街', w: 14, pts: [[-74.0135, 40.7062], [-74.0090, 40.7052], [-74.0050, 40.7042]] },
  { name: '坚尼街', w: 18, pts: [[-74.0080, 40.7225], [-74.0005, 40.7190], [-73.9930, 40.7175]] },
  { name: '公园大道', w: 20, pts: [[-73.9900, 40.7320], [-73.9820, 40.7440], [-73.9770, 40.7520], [-73.9700, 40.7620]] },
].map((s) => ({ name: s.name, w: Math.round(s.w * S * 2.2), pts: s.pts.map(([lon, lat]) => P(lon, lat)) }));
const parks = [
  { name: '中央公园南端', c: [-73.9720, 40.7715], rx: 480, rz: 300 },
  { name: '布莱恩特公园', c: [-73.9840, 40.7536], rx: 150, rz: 100 },
  { name: '华盛顿广场', c: [-73.9975, 40.7310], rx: 130, rz: 110 },
  { name: '炮台公园', c: [-74.0155, 40.7028], rx: 200, rz: 150 },
].map((p) => ({ name: p.name, p: P(...p.c), rx: Math.round(p.rx * S), rz: Math.round(p.rz * S) }));
const landmarks = [
  { type: 'jinmao', zh: '尖顶摩天楼', c: [-73.9857, 40.7484] },     // 帝国大厦(退台)
  { type: 'twisttower', zh: '玻璃尖塔', c: [-74.0133, 40.7127] },   // 世贸一号
  { type: 'shard', zh: '银色尖楼', c: [-73.9755, 40.7516] },        // 克莱斯勒
  { type: 'wfc', zh: '石板巨楼', c: [-73.9787, 40.7587] },          // 洛克菲勒
  { type: 'palace', zh: '石柱大楼', c: [-73.9822, 40.7532] },       // 公共图书馆
  { type: 'column', zh: '环岛纪念柱', c: [-73.9820, 40.7683] },     // 哥伦布圆环
].map((l) => ({ type: l.type, zh: l.zh, p: P(...l.c) }));
const busRoutes = [
  { name: 'M5 路', color: '#2456A4',
    pts: [[-74.0090, 40.7150], [-74.0005, 40.7190], [-73.9900, 40.7350], [-73.9880, 40.7500], [-73.9870, 40.7560], [-73.9820, 40.7680]] },
].map((r) => ({ name: r.name, color: r.color, pts: r.pts.map(([lon, lat]) => P(lon, lat)) }));
const data = { newyork: {
  name: '纽约', nameEn: 'New York',
  bounds: { minX: px(BBOX.lonMin), maxX: px(BBOX.lonMax), minZ: pz(BBOX.latMax), maxZ: pz(BBOX.latMin) },
  riverWidth: Math.round(650 * S),
  stations, lines, river, bridges, streets, parks, landmarks, busRoutes, ferries,
  market: P(-73.9872, 40.7565), boothColor: 0x2a6f4f, postbox: false, treeStreet: '第五大道',
  spawn: { x: px(-73.9865), z: pz(40.7545), yaw: 3.14 },
  zones: [
    { r: [px(-74.020), pz(40.716), px(-73.998), pz(40.700)], pal: ['玻璃蓝', '玻璃蓝', '灰'], h: [25, 50], tall: { c: 0.3, h: [60, 120] } },
    { r: [px(-74.010), pz(40.746), px(-73.984), pz(40.718)], pal: ['砖红', '砖红', '彩'], h: [8, 16] },
    { r: [px(-74.010), pz(40.775), px(-73.958), pz(40.744)], pal: ['玻璃蓝', '灰', '米白'], h: [25, 55], tall: { c: 0.25, h: [60, 110] } },
  ],
  zoneDefault: { pal: ['米白', '砖红', '灰'], h: [14, 30], tall: { c: 0.05, h: [38, 60] } },
  banned: ['百老汇', '中央公园', '时代广场', '帝国大厦', '华尔街', '世贸', '布鲁克林', '曼哈顿',
    '联合广场', '大中央', '第五大道', '洛克菲勒', '克莱斯勒', '哥伦布',
    'broadway', 'central park', 'times', 'empire', 'wall st', 'brooklyn', 'manhattan', 'soho', 'union sq'],
} };
process.stdout.write('window.CITY_DATA = Object.assign(window.CITY_DATA || {}, ' + JSON.stringify(data) + ');\n');
console.error(`✔ 纽约: 站点 ${stations.length}, 线路 ${lines.length}`);
