#!/usr/bin/env node
/* 迪拜（市中心+河湾）真实地图数据 -> cities.js（追加） */
'use strict';
const BBOX = { lonMin: 55.255, lonMax: 55.315, latMin: 25.175, latMax: 25.235 };
const LON0 = (BBOX.lonMin + BBOX.lonMax) / 2, LAT0 = (BBOX.latMin + BBOX.latMax) / 2;
const M_PER_LON = 111320 * Math.cos(LAT0 * Math.PI / 180), M_PER_LAT = 111132, S = 0.24;
const px = (lon) => +(((lon - LON0) * M_PER_LON) * S).toFixed(1);
const pz = (lat) => +((-(lat - LAT0) * M_PER_LAT) * S).toFixed(1);
const P = (lon, lat) => [px(lon), pz(lat)];
const ST = [
  ['bby', 'Business Bay', 55.2610, 25.1930], ['bkm', 'Burj Khalifa/Dubai Mall', 55.2690, 25.2020],
  ['fc', 'Financial Centre', 55.2760, 25.2110], ['et', 'Emirates Towers', 55.2810, 25.2170],
  ['wtc', 'World Trade Centre', 55.2870, 25.2230],
];
const stations = ST.map(([id, name, lon, lat]) => ({ id, name, p: P(lon, lat) }));
const lines = [
  { name: '红线', color: '#E11B22', loop: false, stations: ['bby', 'bkm', 'fc', 'et', 'wtc'] },
];
const river = [
  [55.2560, 25.1830], [55.2680, 25.1800], [55.2800, 25.1830], [55.2900, 25.1900],
  [55.2960, 25.2000], [55.3010, 25.2110], [55.3060, 25.2200], [55.3120, 25.2310],
].map(([lon, lat]) => P(lon, lat));
const bridges = [
  { name: '湾区大桥', a: [55.2690, 25.1750], b: [55.2710, 25.1860] },
].map((b) => ({ name: b.name, a: P(...b.a), b: P(...b.b), foot: !!b.foot, tower: !!b.tower }));
const ferries = [{ name: '河湾 Abra 摆渡', a: P(55.2985, 25.2070), b: P(55.3060, 25.2110) }];
const streets = [
  { name: '谢赫扎耶德路', w: 34, pts: [[55.2560, 25.1850], [55.2650, 25.1960], [55.2740, 25.2070], [55.2820, 25.2170], [55.2890, 25.2260]] },
  { name: '林荫大道', w: 18, pts: [[55.2700, 25.1950], [55.2760, 25.1970], [55.2780, 25.2020], [55.2730, 25.2050], [55.2680, 25.2020], [55.2700, 25.1950]] },
  { name: '金融中心路', w: 22, pts: [[55.2690, 25.2020], [55.2760, 25.1960], [55.2820, 25.1900]] },
  { name: '河湾路', w: 20, pts: [[55.2960, 25.2050], [55.3030, 25.2120], [55.3090, 25.2190]] },
  { name: '阿尔哈伊尔路', w: 26, pts: [[55.2600, 25.1780], [55.2700, 25.1900], [55.2790, 25.2000], [55.2860, 25.2090]] },
].map((s) => ({ name: s.name, w: Math.round(s.w * S * 2.2), pts: s.pts.map(([lon, lat]) => P(lon, lat)) }));
const parks = [
  { name: '塔畔公园', c: [55.2720, 25.1935], rx: 220, rz: 160 },
].map((p) => ({ name: p.name, p: P(...p.c), rx: Math.round(p.rx * S), rz: Math.round(p.rz * S) }));
const landmarks = [
  { type: 'burj', zh: '通天塔', c: [55.2744, 25.1972] },
  { type: 'palace', zh: '巨型商场', c: [55.2795, 25.1985] },
  { type: 'shard', zh: '双子尖楼·一', c: [55.2828, 25.2178] },
  { type: 'shard', zh: '双子尖楼·二', c: [55.2845, 25.2158] },
  { type: 'mofuture', zh: '银环建筑', c: [55.2870, 25.2205] },
  { type: 'wfc', zh: '会展巨楼', c: [55.2885, 25.2255] },
].map((l) => ({ type: l.type, zh: l.zh, p: P(...l.c) }));
const busRoutes = [
  { name: 'F13 路', color: '#c49a3f',
    pts: [[55.2700, 25.1950], [55.2760, 25.1970], [55.2780, 25.2020], [55.2760, 25.2110], [55.2810, 25.2170], [55.2870, 25.2230]] },
].map((r) => ({ name: r.name, color: r.color, pts: r.pts.map(([lon, lat]) => P(lon, lat)) }));
const data = { dubai: {
  name: '迪拜', nameEn: 'Dubai',
  bounds: { minX: px(BBOX.lonMin), maxX: px(BBOX.lonMax), minZ: pz(BBOX.latMax), maxZ: pz(BBOX.latMin) },
  riverWidth: Math.round(140 * S),
  stations, lines, river, bridges, streets, parks, landmarks, busRoutes, ferries,
  market: P(55.3045, 25.2125), boothColor: 0xc49a3f, postbox: false, treeStreet: '林荫大道',
  spawn: { x: px(55.2762), z: pz(25.1975), yaw: 1.6 },
  zones: [
    { r: [px(55.2600), pz(25.2300), px(55.2950), pz(25.1850)], pal: ['玻璃蓝', '玻璃蓝', '灰', '米白'], h: [22, 55], tall: { c: 0.35, h: [70, 150] } },
    { r: [px(55.2950), pz(25.2350), px(55.3150), pz(25.2000)], pal: ['米白', '米白', '灰'], h: [6, 12] },
  ],
  zoneDefault: { pal: ['米白', '灰', '米白'], h: [10, 22] },
  banned: ['哈利法', '迪拜塔', '帆船', '朱美拉', '谢赫', '扎耶德', '河湾', '未来博物馆', '商场', '摆渡',
    'burj', 'khalifa', 'jumeirah', 'zayed', 'creek', 'deira', 'mall', 'abra'],
} };
process.stdout.write('window.CITY_DATA = Object.assign(window.CITY_DATA || {}, ' + JSON.stringify(data) + ');\n');
console.error(`✔ 迪拜: 站点 ${stations.length}, 线路 ${lines.length}`);
