#!/usr/bin/env node
/* 烘焙伊斯坦布尔真实地图数据 -> cities.js（追加）
 * 轨交站点/海峡/道路/地标按真实经纬度手工描摹（OpenStreetMap 目视校准）
 * 用法: node tools/bake-istanbul.js >> cities.js
 */
'use strict';
const BBOX = { lonMin: 28.930, lonMax: 29.040, latMin: 40.985, latMax: 41.045 };
const LON0 = (BBOX.lonMin + BBOX.lonMax) / 2, LAT0 = (BBOX.latMin + BBOX.latMax) / 2;
const M_PER_LON = 111320 * Math.cos(LAT0 * Math.PI / 180), M_PER_LAT = 111132, S = 0.24;
const px = (lon) => +(((lon - LON0) * M_PER_LON) * S).toFixed(1);
const pz = (lat) => +((-(lat - LAT0) * M_PER_LAT) * S).toFixed(1);
const P = (lon, lat) => [px(lon), pz(lat)];

const ST = [
  ['byz', 'Beyazıt', 28.9650, 41.0105], ['sul', 'Sultanahmet', 28.9755, 41.0055],
  ['gul', 'Gülhane', 28.9810, 41.0115], ['emi', 'Eminönü', 28.9705, 41.0166],
  ['kar', 'Karaköy', 28.9760, 41.0245], ['top', 'Tophane', 28.9820, 41.0270],
  ['kab', 'Kabataş', 28.9920, 41.0380],
  ['vez', 'Vezneciler', 28.9540, 41.0130], ['hal', 'Haliç', 28.9660, 41.0250],
  ['sis', 'Şişhane', 28.9720, 41.0290], ['tak', 'Taksim', 28.9860, 41.0370],
  ['sir', 'Sirkeci', 28.9770, 41.0130], ['usk', 'Üsküdar', 29.0140, 41.0250],
  ['ayr', 'Ayrılık Çeşmesi', 29.0295, 41.0000],
];
const stations = ST.map(([id, name, lon, lat]) => ({ id, name, p: P(lon, lat) }));
const lines = [
  { name: 'T1 电车', color: '#2456A4', loop: false, stations: ['byz', 'sul', 'gul', 'emi', 'kar', 'top', 'kab'] },
  { name: 'M2 地铁', color: '#00A650', loop: false, stations: ['vez', 'hal', 'sis', 'tak'] },
  { name: 'Marmaray', color: '#8a8f96', loop: false, stations: ['sir', 'usk', 'ayr'] },
];

/* 博斯普鲁斯海峡（北 → 南） */
const river = [
  [29.0060, 41.0480], [29.0080, 41.0330], [29.0030, 41.0230], [28.9980, 41.0130],
  [29.0000, 41.0030], [29.0080, 40.9930], [29.0150, 40.9840],
].map(([lon, lat]) => P(lon, lat));

const bridges = [
  { name: '跨海大桥', a: [28.9980, 41.0430], b: [29.0180, 41.0430], tower: true },
].map((b) => ({ name: b.name, a: P(...b.a), b: P(...b.b), foot: !!b.foot, tower: !!b.tower }));

/* 轮渡：伊斯坦布尔的灵魂 */
const ferries = [
  { name: 'Eminönü–Kadıköy 渡轮', a: P(28.9760, 41.0175), b: P(29.0230, 40.9900) },
  { name: 'Karaköy–Üsküdar 渡轮', a: P(28.9800, 41.0235), b: P(29.0130, 41.0265) },
];

const streets = [
  { name: '独立大街', w: 16, pts: [[28.9860, 41.0370], [28.9800, 41.0330], [28.9750, 41.0295]] },
  { name: '迪旺约卢大街', w: 18, pts: [[28.9760, 41.0060], [28.9700, 41.0085], [28.9650, 41.0105], [28.9560, 41.0128]] },
  { name: '肯尼迪滨海路', w: 22, pts: [[28.9600, 41.0035], [28.9740, 41.0000], [28.9860, 41.0060], [28.9880, 41.0130]] },
  { name: '梅吉利斯大道', w: 20, pts: [[28.9800, 41.0250], [28.9880, 41.0300], [28.9950, 41.0360], [29.0000, 41.0392]] },
  { name: '阿塔图尔克大道', w: 20, pts: [[28.9560, 41.0130], [28.9590, 41.0210], [28.9640, 41.0255]] },
  { name: '里赫特姆大街', w: 18, pts: [[29.0180, 40.9980], [29.0240, 40.9920], [29.0300, 40.9880]] },
  { name: '巴格达大街', w: 18, pts: [[29.0230, 40.9900], [29.0300, 40.9950], [29.0360, 41.0000]] },
].map((s) => ({ name: s.name, w: Math.round(s.w * S * 2.2), pts: s.pts.map(([lon, lat]) => P(lon, lat)) }));

const parks = [
  { name: '居尔哈内公园', c: [28.9815, 41.0135], rx: 280, rz: 200 },
  { name: '盖齐公园', c: [28.9870, 41.0385], rx: 150, rz: 120 },
  { name: '海滨绿地', c: [29.0250, 40.9935], rx: 150, rz: 110 },
].map((p) => ({ name: p.name, p: P(...p.c), rx: Math.round(p.rx * S), rz: Math.round(p.rz * S) }));

const landmarks = [
  { type: 'mosque',   zh: '大圆顶殿', c: [28.9800, 41.0086] },   // 圣索菲亚
  { type: 'mosque',   zh: '蓝顶殿',   c: [28.9768, 41.0054] },   // 蓝色清真寺
  { type: 'galata',   zh: '石塔',     c: [28.9741, 41.0256] },   // 加拉塔塔
  { type: 'castle',   zh: '宫墙',     c: [28.9840, 41.0118] },   // 托普卡帕
  { type: 'palace',   zh: '滨水宫殿', c: [29.0000, 41.0392] },   // 多尔玛巴赫切
  { type: 'column',   zh: '古方尖碑', c: [28.9750, 41.0060] },   // 赛马场方尖碑
].map((l) => ({ type: l.type, zh: l.zh, p: P(...l.c) }));

const busRoutes = [
  { name: '28 路', color: '#c0281c',
    pts: [[28.9560, 41.0128], [28.9650, 41.0105], [28.9700, 41.0085], [28.9760, 41.0060], [28.9800, 41.0086], [28.9810, 41.0115], [28.9770, 41.0130], [28.9705, 41.0166]] },
].map((r) => ({ name: r.name, color: r.color, pts: r.pts.map(([lon, lat]) => P(lon, lat)) }));

const data = {
  istanbul: {
    name: '伊斯坦布尔', nameEn: 'Istanbul',
    bounds: { minX: px(BBOX.lonMin), maxX: px(BBOX.lonMax), minZ: pz(BBOX.latMax), maxZ: pz(BBOX.latMin) },
    riverWidth: Math.round(750 * S),
    stations, lines, river, bridges, streets, parks, landmarks, busRoutes, ferries,
    market: P(28.9680, 41.0106),          // 大巴扎
    boothColor: 0xc49a3f, postbox: false,
    treeStreet: '肯尼迪滨海路',
    spawn: { x: px(28.9740), z: pz(41.0180), yaw: -1.57 }, // Eminönü 码头望海峡
    zones: [
      // 老城（苏丹阿赫迈特）：低层暖色
      { r: [px(28.9500), pz(41.0180), px(28.9900), pz(40.9980)], pal: ['米白', '砖红', '彩'], h: [6, 13] },
      // 贝伊奥卢/加拉塔：中层砖石
      { r: [px(28.9650), pz(41.0420), px(29.0000), pz(41.0200)], pal: ['砖红', '米白', '彩'], h: [10, 20] },
      // 卡德柯伊（亚洲岸）：现代中高层
      { r: [px(29.0100), pz(41.0100), px(29.0400), pz(40.9850)], pal: ['米白', '灰', '玻璃蓝'], h: [12, 26], tall: { c: 0.08, h: [32, 55] } },
    ],
    zoneDefault: { pal: ['米白', '砖红', '灰'], h: [9, 18] },
    banned: ['博斯普鲁斯', '海峡', '金角湾', '圣索菲亚', '清真寺', '加拉塔', '塔克西姆', '大巴扎',
      '苏丹', '托普卡帕', '多尔玛巴赫切', '独立大街', '方尖碑', '渡轮', '码头',
      'bosphorus', 'hagia', 'sophia', 'mosque', 'galata', 'taksim', 'bazaar', 'sultanahmet',
      'kadikoy', 'uskudar', 'eminonu', 'karakoy', 'istiklal'],
  },
};
process.stdout.write('window.CITY_DATA = Object.assign(window.CITY_DATA || {}, ' + JSON.stringify(data) + ');\n');
console.error(`✔ 伊斯坦布尔: 站点 ${stations.length}, 线路 ${lines.length}, 轮渡 ${ferries.length}`);
