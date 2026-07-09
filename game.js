/* ============================================================
 * 躲猫猫小镇 —— 3D 模拟城市藏猫猫游戏
 * n 人藏，m 人找；线索不许含地点信息；信用点经济 + 悬赏
 * 纯前端实现（Three.js r147 UMD），双击 index.html 即可游玩
 * ============================================================ */
(() => {
'use strict';

/* ---------------- 小工具 ---------------- */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
let rng = Math.random;
const R  = (a, b) => a + rng() * (b - a);
const RI = (a, b) => Math.floor(R(a, b + 1));
const pick = (arr) => arr[Math.floor(rng() * arr.length)];
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const dist2d = (ax, az, bx, bz) => Math.hypot(ax - bx, az - bz);
const $ = (id) => document.getElementById(id);
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/* ---------------- 音效（WebAudio 合成，无素材） ---------------- */
const AudioSys = {
  ctx: null,
  ensure() {
    if (!this.ctx) {
      try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { /* 无音频 */ }
    }
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  },
  beep(freq, dur = 0.15, type = 'sine', vol = 0.2, delay = 0, slide = 0) {
    if (!this.ctx) return;
    const t0 = this.ctx.currentTime + delay;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t0);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(this.ctx.destination);
    o.start(t0); o.stop(t0 + dur + 0.05);
  },
  click()   { this.beep(1250, 0.05, 'triangle', 0.12); },
  deny()    { this.beep(150, 0.2, 'square', 0.15); this.beep(110, 0.25, 'square', 0.12, 0.1); },
  coin()    { this.beep(988, 0.09, 'square', 0.12); this.beep(1319, 0.18, 'square', 0.12, 0.08); },
  capture() { [523, 659, 784, 1047, 1319].forEach((f, i) => this.beep(f, 0.22, 'triangle', 0.2, i * 0.09)); },
  radar()   { this.beep(880, 0.5, 'sine', 0.18, 0, -500); },
  busDing(v = 0.18) { this.beep(660, 0.12, 'sine', v); this.beep(880, 0.2, 'sine', v, 0.13); },
  taxi()    { this.beep(220, 0.5, 'sawtooth', 0.1, 0, 400); },
  chime(v = 0.15) { this.beep(392, 0.8, 'sine', v); this.beep(262, 1.2, 'sine', v * 0.8, 0.5); },
  giggle(v = 0.1) { this.beep(1200, 0.07, 'sine', v); this.beep(1500, 0.07, 'sine', v, 0.09); this.beep(1350, 0.09, 'sine', v * 0.8, 0.18); },
  chirp(v = 0.08) { this.beep(2400, 0.06, 'sine', v, 0, 800); this.beep(2100, 0.08, 'sine', v, 0.1, 600); },
};

/* ---------------- 常量 ---------------- */
const GRID = 7, BLOCK = 36, ROAD = 10;
const CELL = BLOCK + ROAD;
const WORLD = GRID * CELL + ROAD;    // 332
const HALF = WORLD / 2;
const blockMin = (i) => -HALF + ROAD + i * CELL;
const blockCenter = (i) => blockMin(i) + BLOCK / 2;
const roadLine = (k) => -HALF + ROAD / 2 + k * CELL; // k: 0..GRID

const COST = { bike: 8, bus: 5, taxiBase: 15, taxiPerM: 0.35, radar: 12, captureBase: 50 };
const SPEED = { walk: 4.6, run: 8.2, bike: 11.5, bus: 12, fly: 42, flyFast: 90 };

const PALETTE = [
  ['红', 0xd97b6c], ['橙', 0xe0995c], ['黄', 0xe6cf6f], ['绿', 0x83bf78],
  ['青', 0x6fc4c4], ['蓝', 0x6e8fd6], ['紫', 0xa38ad6], ['粉', 0xe3a0bd],
  ['白', 0xefefe6], ['灰', 0x9aa0a6],
];
const DOWN_COLORS = ['青', '蓝', '灰', '白', '紫'];
const WARM_COLORS = ['红', '橙', '黄', '绿', '粉', '白'];

// 好友模式线索违禁词（地点信息）
const BANNED_WORDS = [
  '公园', '花园', '草坪', '湖', '河', '池塘', '水池', '喷泉', '广场', '钟楼', '塔',
  '市场', '商场', '商店', '店铺', '摊位', '工地', '车站', '公交站', '站台', '桥',
  '街', '马路', '路口', '路边', '巷', '小区', '居民区', '金融区', '商业区', '住宅区',
  '学校', '医院', '体育场', '停车场', '楼顶', '屋顶', '码头', '隧道', '地图', '坐标',
  '东边', '西边', '南边', '北边', '东南', '西南', '东北', '西北', '北面', '南面', '东面', '西面',
  '城东', '城西', '城南', '城北', '中央', '中心', '角上', '边上',
  'park', 'lake', 'plaza', 'square', 'market', 'station', 'street', 'road', 'bridge',
  'north', 'south', 'east', 'west', 'tower', 'corner',
];

const HIDER_NAMES = [
  ['神秘的狐狸', '🦊'], ['机灵的猫咪', '🐱'], ['害羞的刺猬', '🦔'], ['淘气的浣熊', '🦝'],
  ['悄悄的兔子', '🐰'], ['沉默的松鼠', '🐿️'], ['狡猾的狸猫', '🐈'], ['飘忽的雪貂', '🦡'],
];

/* 线索模板：key -> 文案（保证不含地点词） */
const CLUE_TMPL = {
  water:   () => '我能听到近处传来的流水声',
  park:    () => '空气里满是青草和泥土的味道',
  traffic: () => '不时有车辆从我身旁驶过',
  quiet:   () => '我周围非常安静，几乎没有人声',
  shade:   () => '阳光晒不到我，这里很阴凉',
  chime:   () => '每隔一阵子，我能听到清脆的钟声',
  busStop: () => '偶尔能听到公交车到站的叮咚声',
  market:  () => '我能闻到食物和香料的香气',
  dust:    () => '空气里有灰尘和水泥的味道',
  tall:    () => '抬头看，身旁的建筑遮住了大半个天空',
  low:     () => '我附近的房子都不算高',
  bcolor:  (c) => `离我最近的一栋建筑是${c}色的`,
  pipe:    () => '我蜷缩在一个圆滚滚的东西里面',
  trash:   () => '我旁边有一股淡淡的酸味，不太好闻',
  bush:    () => '有叶子轻轻扎着我的后背',
  booth:   () => '我躲在一个又高又窄的小空间旁边',
  bench:   () => '我旁边有一个可以坐下歇脚的东西',
  reed:    () => '细长的植物在我身边随风摇晃',
};

/* ---------------- 全局状态 ---------------- */
const G = {
  phase: 'menu',            // menu | hide | seek | end
  mode: 'ai',               // ai | hot
  seed: 0,
  city: null,
  hiders: [],
  seekers: [],
  curSeeker: 0,
  turnTimer: 0,
  credits: 0,
  timeLeft: 0,
  totalTime: 480,
  hintCount: 3,
  paused: false,
  view3rd: true,
  panelOpen: true,
  hideIdx: 0,               // 好友模式：当前第几位躲藏者在选点
  pendingSpot: null,
  radarRings: [],           // {x,z,d,until}
  captures: 0,
  spent: 0,
  earned: 0,
  msg: null,
};

/* ---------------- Three.js 基础 ---------------- */
let renderer, scene, camera, sunLight;
const glWrap = $('gl');
try {
  renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
} catch (e) {
  document.body.innerHTML = '<div style="padding:40px;font-size:18px;">😢 当前浏览器不支持 WebGL，无法运行游戏。</div>';
  throw e;
}
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputEncoding = THREE.sRGBEncoding;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
glWrap.appendChild(renderer.domElement);

camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.1, 900);
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

function makeScene() {
  scene = new THREE.Scene();
  const sky = 0xa9d7ef;
  scene.background = new THREE.Color(sky);
  scene.fog = new THREE.Fog(sky, 140, 520);
  const hemi = new THREE.HemisphereLight(0xcfe8ff, 0xb0a284, 0.55);
  scene.add(hemi);
  sunLight = new THREE.DirectionalLight(0xfff2dc, 0.95);
  sunLight.position.set(150, 210, 90);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(2048, 2048);
  const sc = sunLight.shadow.camera;
  sc.left = -200; sc.right = 200; sc.top = 200; sc.bottom = -200; sc.far = 600;
  sunLight.shadow.bias = -0.0006;
  scene.add(sunLight);
  scene.add(sunLight.target);
}

/* 材质缓存 */
const MAT = {};
function lambert(color) {
  const key = 'L' + color;
  if (!MAT[key]) MAT[key] = new THREE.MeshLambertMaterial({ color });
  return MAT[key];
}

/* 窗户贴图（画一次，所有建筑共用图像） */
let windowTexImage = null;
function windowTexture(repX, repY) {
  if (!windowTexImage) {
    const c = document.createElement('canvas');
    c.width = 64; c.height = 64;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 64, 64);
    ctx.fillStyle = 'rgba(20,30,50,0.42)';
    for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) ctx.fillRect(7 + x * 20, 8 + y * 20, 11, 12);
    windowTexImage = c;
  }
  const tex = new THREE.CanvasTexture(windowTexImage);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repX, repY);
  return tex;
}

/* ============================================================
 * 城市生成
 * ============================================================ */
function blockType(i, j) {
  if (i === 3 && j === 3) return 'plaza';
  if ((i === 4 || i === 5) && (j === 2 || j === 3)) return i === 5 && j === 3 ? 'pond' : 'park';
  if (i >= 1 && i <= 2 && j >= 1 && j <= 3) return 'down';
  if (j === 5 && i >= 1 && i <= 4) return 'market';
  if (i === 5 && j === 5) return 'constr';
  return 'res';
}
const TYPE_NAME = { plaza: '广场一带', park: '绿地一带', pond: '水边一带', down: '高楼区', market: '热闹的老街', constr: '尘土飞扬处', res: '安静的住宅' };

function genCity() {
  const city = {
    blocks: [], buildings: [], aabbs: [], circles: [],
    trees: [], spots: [], busStops: [], bikeStations: [],
    pond: null, fountain: null, tower: null,
    group: new THREE.Group(),
  };
  const g = city.group;

  /* ---- 地面 ---- */
  const grass = new THREE.Mesh(new THREE.PlaneGeometry(1400, 1400), lambert(0x7fae6e));
  grass.rotation.x = -Math.PI / 2; grass.position.y = -0.05; grass.receiveShadow = true;
  g.add(grass);
  const asphalt = new THREE.Mesh(new THREE.PlaneGeometry(WORLD, WORLD), lambert(0x4a4e55));
  asphalt.rotation.x = -Math.PI / 2; asphalt.receiveShadow = true;
  g.add(asphalt);

  /* 道路虚线（Instanced） */
  {
    const dashGeo = new THREE.BoxGeometry(0.3, 0.03, 2.4);
    const placements = [];
    for (let k = 0; k <= GRID; k++) {
      const line = roadLine(k);
      for (let s = -HALF + 6; s < HALF - 6; s += 8) {
        placements.push([line, s, 0]);           // 纵向路
        placements.push([s, line, Math.PI / 2]); // 横向路
      }
    }
    const dashes = new THREE.InstancedMesh(dashGeo, lambert(0xd8dade), placements.length);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
    placements.forEach((p, idx) => {
      q.setFromAxisAngle(up, p[2]);
      m4.compose(new THREE.Vector3(p[0], 0.02, p[1]), q, new THREE.Vector3(1, 1, 1));
      dashes.setMatrixAt(idx, m4);
    });
    g.add(dashes);
  }

  /* ---- 每个街区 ---- */
  const treePlace = [];   // {x,z,park,cone}
  const benchPlace = [];  // {x,z,rot}
  const lampPlace = [];
  const bushPlace = [];

  for (let i = 0; i < GRID; i++) {
    city.blocks.push([]);
    for (let j = 0; j < GRID; j++) {
      const type = blockType(i, j);
      const cx = blockCenter(i), cz = blockCenter(j);
      city.blocks[i].push({ type, cx, cz });

      // 街区地坪
      const groundColor = { plaza: 0xd9c9a3, park: 0x6fbf73, pond: 0x6fbf73, down: 0xb8bcc2, market: 0xc9b090, constr: 0x9c8f7a, res: 0xb8bcc2 }[type];
      const pad = new THREE.Mesh(new THREE.BoxGeometry(BLOCK, 0.14, BLOCK), lambert(groundColor));
      pad.position.set(cx, 0.07, cz); pad.receiveShadow = true;
      g.add(pad);

      if (type === 'plaza') buildPlaza(city, g, cx, cz, benchPlace, treePlace);
      else if (type === 'park' || type === 'pond') buildPark(city, g, i, j, cx, cz, type === 'pond', treePlace, benchPlace, bushPlace);
      else if (type === 'constr') buildConstruction(city, g, cx, cz);
      else buildBuildingBlock(city, g, i, j, type, cx, cz, treePlace);
    }
  }

  /* 路灯：每个路口一盏 */
  for (let k = 0; k <= GRID; k++) for (let l = 0; l <= GRID; l++) {
    if ((k + l) % 2 === 0) lampPlace.push({ x: roadLine(k) + 3.2, z: roadLine(l) + 3.2 });
  }

  buildInstancedProps(city, g, treePlace, benchPlace, lampPlace, bushPlace);
  buildBusSystem(city, g);
  buildBikeStations(city, g);
  buildExtraProps(city, g);
  computeSpotAttrs(city);

  scene.add(g);
  return city;
}

/* ---- 广场：钟楼 + 喷泉 ---- */
function buildPlaza(city, g, cx, cz, benchPlace, treePlace) {
  city.tower = { x: cx - 4, z: cz - 4 };
  const tw = city.tower;
  // 钟楼
  const base = new THREE.Mesh(new THREE.BoxGeometry(7, 3, 7), lambert(0xcfc4ae));
  base.position.set(tw.x, 1.5, tw.z); base.castShadow = base.receiveShadow = true; g.add(base);
  const shaft = new THREE.Mesh(new THREE.BoxGeometry(4.6, 34, 4.6), lambert(0xe3d9c4));
  shaft.position.set(tw.x, 3 + 17, tw.z); shaft.castShadow = true; g.add(shaft);
  const cap = new THREE.Mesh(new THREE.ConeGeometry(4.2, 5, 4), lambert(0xb0654f));
  cap.position.set(tw.x, 40, tw.z); cap.rotation.y = Math.PI / 4; cap.castShadow = true; g.add(cap);
  city.clockHands = [];
  for (let f = 0; f < 4; f++) {
    const face = new THREE.Mesh(new THREE.CircleGeometry(1.7, 24), new THREE.MeshBasicMaterial({ color: 0xfffbe8 }));
    const ang = f * Math.PI / 2;
    face.position.set(tw.x + Math.sin(ang) * 2.36, 33, tw.z + Math.cos(ang) * 2.36);
    face.rotation.y = ang;
    g.add(face);
    const hand = new THREE.Mesh(new THREE.BoxGeometry(0.14, 1.25, 0.05), new THREE.MeshBasicMaterial({ color: 0x333333 }));
    hand.geometry.translate(0, 0.55, 0);
    hand.position.copy(face.position).add(new THREE.Vector3(Math.sin(ang) * 0.05, 0, Math.cos(ang) * 0.05));
    hand.rotation.y = ang;
    g.add(hand);
    city.clockHands.push(hand);
  }
  city.aabbs.push({ x1: tw.x - 3.6, z1: tw.z - 3.6, x2: tw.x + 3.6, z2: tw.z + 3.6 });
  city.spots.push({ x: tw.x - 4.6, z: tw.z - 4.6, prop: 'tower', label: '一座高耸建筑的背阴角落' });

  // 喷泉
  city.fountain = { x: cx + 9, z: cz + 8 };
  const f = city.fountain;
  const basin = new THREE.Mesh(new THREE.CylinderGeometry(5, 5.3, 1.1, 24), lambert(0xbfb6a2));
  basin.position.set(f.x, 0.55, f.z); basin.castShadow = basin.receiveShadow = true; g.add(basin);
  const water = new THREE.Mesh(new THREE.CylinderGeometry(4.4, 4.4, 0.3, 24),
    new THREE.MeshLambertMaterial({ color: 0x4fa8e8, transparent: true, opacity: 0.85 }));
  water.position.set(f.x, 1.02, f.z); g.add(water);
  const jet = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.9, 4, 12),
    new THREE.MeshLambertMaterial({ color: 0x9fd4f5, transparent: true, opacity: 0.8 }));
  jet.position.set(f.x, 3, f.z); g.add(jet);
  city.fountainJet = jet;
  city.circles.push({ x: f.x, z: f.z, r: 5.5 });
  city.spots.push({ x: f.x + 6.6, z: f.z + 1, prop: 'fountain', label: '水池边沿的外侧' });
  city.spots.push({ x: f.x - 6.6, z: f.z - 1, prop: 'fountain', label: '水池边沿的外侧' });

  for (let b = 0; b < 6; b++) {
    const ang = b * Math.PI / 3 + 0.4;
    benchPlace.push({ x: cx + Math.cos(ang) * 14.5, z: cz + Math.sin(ang) * 14.5, rot: -ang + Math.PI / 2 });
  }
  for (let t = 0; t < 4; t++) {
    const ang = t * Math.PI / 2 + Math.PI / 4;
    treePlace.push({ x: cx + Math.cos(ang) * 15.5, z: cz + Math.sin(ang) * 15.5, park: false, cone: false });
  }
}

/* ---- 公园 / 水塘 ---- */
function buildPark(city, g, i, j, cx, cz, hasPond, treePlace, benchPlace, bushPlace) {
  if (hasPond) {
    city.pond = { x: cx, z: cz, rx: 12.5, rz: 8.5 };
    const sand = new THREE.Mesh(new THREE.CircleGeometry(1, 36), lambert(0xd9c9a3));
    sand.scale.set(14.2, 10.2, 1); sand.rotation.x = -Math.PI / 2;
    sand.position.set(cx, 0.16, cz); g.add(sand);
    const water = new THREE.Mesh(new THREE.CircleGeometry(1, 36),
      new THREE.MeshLambertMaterial({ color: 0x3f8fd6, transparent: true, opacity: 0.92 }));
    water.scale.set(12.5, 8.5, 1); water.rotation.x = -Math.PI / 2;
    water.position.set(cx, 0.2, cz); g.add(water);
    city.circles.push({ x: cx, z: cz, r: 10.5 });
    // 芦苇
    for (let r = 0; r < 10; r++) {
      const ang = R(0, Math.PI * 2);
      const px = cx + Math.cos(ang) * 13.4, pz = cz + Math.sin(ang) * 9.4;
      const reed = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.1, R(1.6, 2.4), 5), lambert(0x8aa64f));
      reed.position.set(px, 1, pz); g.add(reed);
      if (r === 2 || r === 6) city.spots.push({ x: px, z: pz, prop: 'reed', label: '一丛细长植物的中间' });
    }
    for (let t = 0; t < 5; t++) {
      const ang = R(0, Math.PI * 2);
      treePlace.push({ x: cx + Math.cos(ang) * R(15, 17), z: cz + Math.sin(ang) * R(12, 16.5), park: true, cone: rng() < 0.3 });
    }
  } else {
    const treeN = RI(9, 12);
    const localTrees = [];
    for (let t = 0; t < treeN; t++) {
      const tx = cx + R(-15, 15), tz = cz + R(-15, 15);
      treePlace.push({ x: tx, z: tz, park: true, cone: rng() < 0.3 });
      localTrees.push([tx, tz]);
    }
    // 树后藏点：挑 2 棵
    shuffle(localTrees).slice(0, 2).forEach(([tx, tz]) => {
      city.spots.push({ x: tx + R(-1, 1) * 0.5 + 1.1, z: tz + 1.1, prop: 'tree', label: '一棵大树的树干后面' });
    });
    for (let b = 0; b < 3; b++) {
      const bx = cx + R(-13, 13), bz = cz + R(-13, 13);
      bushPlace.push({ x: bx, z: bz });
      if (b === 0) city.spots.push({ x: bx, z: bz, prop: 'bush', label: '一丛茂密灌木的内部' });
    }
    benchPlace.push({ x: cx + R(-12, 12), z: cz + R(-12, 12), rot: R(0, Math.PI * 2) });
    if (rng() < 0.5) {
      const bp = benchPlace[benchPlace.length - 1];
      city.spots.push({ x: bp.x + 0.2, z: bp.z + 1.2, prop: 'bench', label: '一个歇脚设施的后面' });
    }
  }
}

/* ---- 工地 ---- */
function buildConstruction(city, g, cx, cz) {
  // 水泥管（经典藏点！）
  for (let p = 0; p < 2; p++) {
    const px = cx - 8 + p * 9, pz = cz - 6;
    const pipe = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.5, 4.4, 18, 1, true),
      new THREE.MeshLambertMaterial({ color: 0xb6b0a4, side: THREE.DoubleSide }));
    pipe.rotation.z = Math.PI / 2; pipe.position.set(px, 1.5, pz);
    pipe.castShadow = true; g.add(pipe);
    city.aabbs.push({ x1: px - 2.2, z1: pz - 1.6, x2: px + 2.2, z2: pz + 1.6 });
    city.spots.push({ x: px, z: pz + 2.6, prop: 'pipe', label: '一个巨大圆管的内侧' });
  }
  // 木箱堆
  const crateM = lambert(0xa5814f);
  for (let c = 0; c < 5; c++) {
    const s = R(1.4, 2.2);
    const crate = new THREE.Mesh(new THREE.BoxGeometry(s, s, s), crateM);
    const px = cx + R(2, 13), pz = cz + R(-4, 10);
    crate.position.set(px, s / 2, pz); crate.rotation.y = R(0, Math.PI);
    crate.castShadow = true; g.add(crate);
    if (c === 0) {
      city.aabbs.push({ x1: px - s / 2, z1: pz - s / 2, x2: px + s / 2, z2: pz + s / 2 });
      city.spots.push({ x: px + s / 2 + 0.9, z: pz, prop: 'crate', label: '一堆大木箱的后面' });
    }
  }
  // 半成品框架
  const colM = lambert(0x8f8f96);
  for (let c = 0; c < 4; c++) {
    const col = new THREE.Mesh(new THREE.BoxGeometry(0.9, 7, 0.9), colM);
    col.position.set(cx - 12 + (c % 2) * 10, 3.5, cz + 6 + Math.floor(c / 2) * 7);
    col.castShadow = true; g.add(col);
  }
  const slab = new THREE.Mesh(new THREE.BoxGeometry(11.5, 0.5, 8.5), colM);
  slab.position.set(cx - 7, 7.2, cz + 9.5); slab.castShadow = true; g.add(slab);
}

/* ---- 普通建筑街区（住宅/高楼/市场） ---- */
function buildBuildingBlock(city, g, i, j, type, cx, cz, treePlace) {
  const lot = BLOCK / 2;
  let placed = 0;
  for (let li = 0; li < 2; li++) for (let lj = 0; lj < 2; lj++) {
    const prob = { down: 0.95, res: 0.85, market: 0.9 }[type];
    if (rng() > prob) continue;
    placed++;
    const lcx = cx - BLOCK / 4 + li * lot + R(-1, 1);
    const lcz = cz - BLOCK / 4 + lj * lot + R(-1, 1);
    const w = R(10, 14), d = R(10, 14);
    let h, colorName;
    if (type === 'down') { h = R(24, 58); colorName = pick(DOWN_COLORS); }
    else if (type === 'market') { h = R(5, 9); colorName = pick(WARM_COLORS); }
    else { h = R(6, 14); colorName = pick(WARM_COLORS); }
    const colorHex = PALETTE.find((p) => p[0] === colorName)[1];
    const wallMat = new THREE.MeshLambertMaterial({ color: colorHex, map: windowTexture(Math.max(1, Math.round(w / 5)), Math.max(1, Math.round(h / 5))) });
    const roofMat = lambert(new THREE.Color(colorHex).multiplyScalar(0.5).getHex());
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), [wallMat, wallMat, roofMat, roofMat, wallMat, wallMat]);
    mesh.position.set(lcx, h / 2 + 0.14, lcz);
    mesh.castShadow = mesh.receiveShadow = true;
    g.add(mesh);
    city.buildings.push({ x: lcx, z: lcz, w, d, h, colorName, type });
    city.aabbs.push({ x1: lcx - w / 2, z1: lcz - d / 2, x2: lcx + w / 2, z2: lcz + d / 2 });

    // 市场棚子
    if (type === 'market') {
      const awn = new THREE.Mesh(new THREE.BoxGeometry(w * 0.8, 0.3, 2.4), lambert(pick([0xd96b6b, 0xe0995c, 0x6fc4c4])));
      awn.position.set(lcx, 3.2, lcz + d / 2 + 1.2); awn.rotation.x = 0.25; g.add(awn);
    }
  }
  // 街区中央小巷：垃圾桶（藏点）
  if (placed >= 3 && (type === 'res' || type === 'down') && rng() < 0.6) {
    const dx = cx + R(-2, 2), dz = cz + R(-2, 2);
    const dump = new THREE.Mesh(new THREE.BoxGeometry(2.1, 1.4, 1.2), lambert(pick([0x3f7f5f, 0x4a6fa5])));
    dump.position.set(dx, 0.7, dz); dump.rotation.y = R(0, Math.PI); dump.castShadow = true;
    city.group.add(dump);
    city.aabbs.push({ x1: dx - 1.2, z1: dz - 0.9, x2: dx + 1.2, z2: dz + 0.9 });
    city.spots.push({ x: dx + 1.9, z: dz + 0.6, prop: 'trash', label: '两栋楼之间的大箱子后面' });
  }
  // 市场货摊（藏点）
  if (type === 'market') {
    for (let s = 0; s < 2; s++) {
      const sx = cx - 10 + s * 20, sz = cz + BLOCK / 2 - 3;
      const stall = new THREE.Group();
      const table = new THREE.Mesh(new THREE.BoxGeometry(3, 1, 1.6), lambert(0x9c7040));
      table.position.y = 0.5; stall.add(table);
      const roof = new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.18, 2.2), lambert(pick([0xd96b6b, 0xe6cf6f, 0x6fc4c4, 0x83bf78])));
      roof.position.y = 2.3; stall.add(roof);
      [[-1.5, -0.9], [1.5, -0.9], [-1.5, 0.9], [1.5, 0.9]].forEach(([px, pz]) => {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(0.12, 2.3, 0.12), lambert(0x9c7040));
        leg.position.set(px, 1.15, pz); stall.add(leg);
      });
      stall.position.set(sx, 0.14, sz);
      stall.traverse((o) => { o.castShadow = true; });
      city.group.add(stall);
      city.aabbs.push({ x1: sx - 1.7, z1: sz - 1, x2: sx + 1.7, z2: sz + 1 });
      if (s === 0) city.spots.push({ x: sx, z: sz - 1.9, prop: 'stall', label: '一个小货摊的桌板后面' });
    }
  }
  // 住宅区路边树
  if (type === 'res' && rng() < 0.7) {
    treePlace.push({ x: cx + pick([-1, 1]) * (BLOCK / 2 - 1.5), z: cz + R(-10, 10), park: false, cone: true });
  }
}

/* ---- Instanced 树 / 长椅 / 路灯 / 灌木 ---- */
function buildInstancedProps(city, g, treePlace, benchPlace, lampPlace, bushPlace) {
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
  const compose = (mesh, idx, x, y, z, rot = 0, s = 1) => {
    q.setFromAxisAngle(up, rot);
    m4.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(s, s, s));
    mesh.setMatrixAt(idx, m4);
  };
  // 树
  if (treePlace.length) {
    const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.28, 0.4, 2.6, 7), lambert(0x8a6239), treePlace.length);
    const crowns = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 10, 8), new THREE.MeshLambertMaterial({ color: 0xffffff }), treePlace.length);
    const cones  = new THREE.InstancedMesh(new THREE.ConeGeometry(1, 2.4, 9), new THREE.MeshLambertMaterial({ color: 0xffffff }), treePlace.length);
    let ci = 0, coi = 0;
    treePlace.forEach((t, idx) => {
      const s = R(0.85, 1.35);
      compose(trunks, idx, t.x, 1.3 * s, t.z, 0, s);
      const green = new THREE.Color().setHSL(R(0.26, 0.36), 0.5, R(0.32, 0.45));
      if (t.cone) { compose(cones, coi, t.x, (2.6 + 1.0) * s, t.z, 0, s * 1.5); cones.setColorAt(coi, green); coi++; }
      else { compose(crowns, ci, t.x, (2.6 + 0.7) * s, t.z, 0, s * 1.9); crowns.setColorAt(ci, green); ci++; }
      city.circles.push({ x: t.x, z: t.z, r: 0.55 });
      city.trees.push({ x: t.x, z: t.z, park: t.park });
    });
    crowns.count = ci; cones.count = coi;
    trunks.castShadow = crowns.castShadow = cones.castShadow = true;
    g.add(trunks); g.add(crowns); g.add(cones);
  }
  // 长椅
  if (benchPlace.length) {
    const seats = new THREE.InstancedMesh(new THREE.BoxGeometry(1.9, 0.12, 0.55), lambert(0xa5744a), benchPlace.length);
    const backs = new THREE.InstancedMesh(new THREE.BoxGeometry(1.9, 0.5, 0.1), lambert(0xa5744a), benchPlace.length);
    benchPlace.forEach((b, idx) => {
      compose(seats, idx, b.x, 0.52, b.z, b.rot);
      const bx = b.x - Math.sin(b.rot) * 0.28, bz = b.z - Math.cos(b.rot) * 0.28;
      compose(backs, idx, bx, 0.85, bz, b.rot);
    });
    seats.castShadow = true;
    g.add(seats); g.add(backs);
  }
  // 路灯
  if (lampPlace.length) {
    const poles = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.09, 0.13, 5.4, 6), lambert(0x54585e), lampPlace.length);
    const heads = new THREE.InstancedMesh(new THREE.SphereGeometry(0.32, 8, 6), new THREE.MeshBasicMaterial({ color: 0xfff1c4 }), lampPlace.length);
    lampPlace.forEach((l, idx) => { compose(poles, idx, l.x, 2.7, l.z); compose(heads, idx, l.x, 5.5, l.z); });
    g.add(poles); g.add(heads);
  }
  // 灌木
  if (bushPlace.length) {
    const bushes = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 9, 7), new THREE.MeshLambertMaterial({ color: 0xffffff }), bushPlace.length);
    bushPlace.forEach((b, idx) => {
      compose(bushes, idx, b.x, 0.75, b.z, 0, R(1.1, 1.6));
      bushes.setColorAt(idx, new THREE.Color().setHSL(R(0.24, 0.34), 0.5, R(0.3, 0.4)));
    });
    bushes.castShadow = true;
    g.add(bushes);
  }
}

/* ---- 公交系统 ---- */
function buildBusSystem(city, g) {
  const r2 = roadLine(2), r5 = roadLine(5);
  city.busPath = [
    { x: r2, z: r2 }, { x: r5, z: r2 }, { x: r5, z: r5 }, { x: r2, z: r5 },
  ];
  const mids = [
    { x: (r2 + r5) / 2, z: r2, ox: 0, oz: -6.4 },
    { x: r5, z: (r2 + r5) / 2, ox: 6.4, oz: 0 },
    { x: (r2 + r5) / 2, z: r5, ox: 0, oz: 6.4 },
    { x: r2, z: (r2 + r5) / 2, ox: -6.4, oz: 0 },
  ];
  mids.forEach((m, idx) => {
    city.busStops.push({ x: m.x, z: m.z, sx: m.x + m.ox, sz: m.z + m.oz, idx });
    // 站牌 + 顶棚
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 3, 6), lambert(0x54585e));
    pole.position.set(m.x + m.ox, 1.5, m.z + m.oz); g.add(pole);
    const sign = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.7, 0.08), lambert(0x2f7fd6));
    sign.position.set(m.x + m.ox, 2.7, m.z + m.oz); g.add(sign);
    const roof = new THREE.Mesh(new THREE.BoxGeometry(4, 0.16, 1.8), lambert(0xd0d3d8));
    roof.position.set(m.x + m.ox * 1.25, 2.5, m.z + m.oz * 1.25); roof.castShadow = true; g.add(roof);
  });
  // 公交车
  const bus = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(7, 2.6, 2.5), lambert(0x3f8fd6));
  body.position.y = 1.9; body.castShadow = true; bus.add(body);
  const stripe = new THREE.Mesh(new THREE.BoxGeometry(7.02, 0.6, 2.52), lambert(0xefefe6));
  stripe.position.y = 2.3; bus.add(stripe);
  const win = new THREE.Mesh(new THREE.BoxGeometry(7.04, 0.8, 2.4), lambert(0x274158));
  win.position.y = 2.9; bus.add(win);
  for (let w = 0; w < 4; w++) {
    const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 0.4, 10), lambert(0x222428));
    wheel.rotation.x = Math.PI / 2;
    wheel.position.set(-2.2 + (w % 2) * 4.4, 0.55, w < 2 ? -1.15 : 1.15);
    bus.add(wheel);
  }
  bus.position.set(city.busPath[0].x, 0, city.busPath[0].z);
  g.add(bus);
  city.bus = { mesh: bus, seg: 0, t: 0, dwell: 0, stopIdx: -1, riding: false, announced: false };
}

/* ---- 共享单车站 ---- */
function buildBikeStations(city, g) {
  const corners = [[1, 1], [6, 1], [1, 6], [6, 6], [4, 4], [2, 4]];
  corners.forEach(([k, l]) => {
    const x = roadLine(k) + 4, z = roadLine(l) - 4;
    city.bikeStations.push({ x, z });
    const rack = new THREE.Mesh(new THREE.BoxGeometry(3, 0.8, 0.14), lambert(0xe0995c));
    rack.position.set(x, 0.5, z); rack.castShadow = true; g.add(rack);
    for (let b = 0; b < 2; b++) {
      const wheelG = new THREE.TorusGeometry(0.32, 0.05, 6, 12);
      const bx = x - 0.7 + b * 1.4;
      [[-0.45], [0.45]].forEach(([off]) => {
        const wh = new THREE.Mesh(wheelG, lambert(0x33363b));
        wh.position.set(bx + off, 0.34, z + 0.5); g.add(wh);
      });
      const bar = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.06, 0.06), lambert(0x22c1a3));
      bar.position.set(bx, 0.62, z + 0.5); bar.rotation.z = 0.25; g.add(bar);
    }
  });
}

/* ---- 电话亭等杂项 ---- */
function buildExtraProps(city, g) {
  for (let p = 0; p < 2; p++) {
    let bi, bj;
    do { bi = RI(0, 6); bj = RI(0, 6); } while (blockType(bi, bj) !== 'res');
    const x = blockCenter(bi) + pick([-1, 1]) * (BLOCK / 2 - 2.5);
    const z = blockCenter(bj) + R(-8, 8);
    const booth = new THREE.Mesh(new THREE.BoxGeometry(1.5, 3, 1.5), lambert(0xc44536));
    booth.position.set(x, 1.64, z); booth.castShadow = true; g.add(booth);
    const glass = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.6, 1.52), new THREE.MeshLambertMaterial({ color: 0xbfe3f5, transparent: true, opacity: 0.6 }));
    glass.position.set(x, 1.9, z); g.add(glass);
    city.aabbs.push({ x1: x - 0.85, z1: z - 0.85, x2: x + 0.85, z2: z + 0.85 });
    city.spots.push({ x: x + 1.6, z: z + 0.6, prop: 'booth', label: '一个红色小亭子的背面' });
  }
}

/* ---- 计算每个藏点的环境属性（生成线索用） ---- */
function computeSpotAttrs(city) {
  const nearestRoadDist = (x, z) => {
    let best = 1e9;
    for (let k = 0; k <= GRID; k++) {
      best = Math.min(best, Math.abs(x - roadLine(k)), Math.abs(z - roadLine(k)));
    }
    return best;
  };
  city.spots.forEach((s) => {
    const bi = clamp(Math.floor((s.x + HALF - ROAD / 2) / CELL), 0, 6);
    const bj = clamp(Math.floor((s.z + HALF - ROAD / 2) / CELL), 0, 6);
    const bt = blockType(bi, bj);
    const a = {};
    const pondD = city.pond ? dist2d(s.x, s.z, city.pond.x, city.pond.z) : 1e9;
    const ftD = city.fountain ? dist2d(s.x, s.z, city.fountain.x, city.fountain.z) : 1e9;
    a.water = pondD < 26 || ftD < 20;
    a.park = bt === 'park' || bt === 'pond';
    a.traffic = nearestRoadDist(s.x, s.z) < 8.5;
    a.chime = city.tower && dist2d(s.x, s.z, city.tower.x, city.tower.z) < 46;
    a.busStop = city.busStops.some((b) => dist2d(s.x, s.z, b.sx, b.sz) < 22);
    a.market = bt === 'market';
    a.dust = bt === 'constr';
    a.quiet = !a.traffic && !a.market && !a.chime;
    // 树荫
    a.shade = city.trees.some((t) => dist2d(s.x, s.z, t.x, t.z) < 3.2);
    // 最近建筑
    let nb = null, nbD = 1e9;
    city.buildings.forEach((b) => {
      const d = dist2d(s.x, s.z, b.x, b.z);
      if (d < nbD) { nbD = d; nb = b; }
    });
    if (nb && nbD < 20) {
      a.bcolor = nb.colorName;
      a.tall = nb.h > 24;
      a.low = nb.h < 12;
    }
    a.propKey = { pipe: 'pipe', trash: 'trash', bush: 'bush', booth: 'booth', bench: 'bench', reed: 'reed' }[s.prop] || null;
    s.attrs = a;
    s.taken = false;
    s.blockType = bt;
  });
  // 属性稀有度（越少见分数越高）
  const counts = {};
  const keys = ['water', 'park', 'traffic', 'chime', 'busStop', 'market', 'dust', 'quiet', 'shade', 'tall', 'low'];
  keys.forEach((k) => { counts[k] = city.spots.filter((s) => s.attrs[k]).length || 1; });
  city.attrCounts = counts;
}

/* ---- 由藏点生成合法线索句子列表 ---- */
function spotHints(spot) {
  const a = spot.attrs, out = [];
  const push = (key, txt) => out.push({ key, txt });
  if (a.propKey) push(a.propKey, CLUE_TMPL[a.propKey]());
  if (a.water) push('water', CLUE_TMPL.water());
  if (a.park) push('park', CLUE_TMPL.park());
  if (a.market) push('market', CLUE_TMPL.market());
  if (a.dust) push('dust', CLUE_TMPL.dust());
  if (a.chime) push('chime', CLUE_TMPL.chime());
  if (a.busStop) push('busStop', CLUE_TMPL.busStop());
  if (a.traffic) push('traffic', CLUE_TMPL.traffic()); else if (a.quiet) push('quiet', CLUE_TMPL.quiet());
  if (a.shade) push('shade', CLUE_TMPL.shade());
  if (a.tall) push('tall', CLUE_TMPL.tall());
  if (a.low) push('low', CLUE_TMPL.low());
  if (a.bcolor) push('bcolor', CLUE_TMPL.bcolor(a.bcolor));
  return out;
}

function genAIClue(spot, hintCount) {
  const hints = spotHints(spot);
  const counts = G.city.attrCounts;
  hints.sort((h1, h2) => (counts[h1.key] || 3) - (counts[h2.key] || 3)); // 稀有优先
  const chosen = [hints[0]];
  const rest = shuffle(hints.slice(1));
  while (chosen.length < hintCount && rest.length) chosen.push(rest.pop());
  shuffle(chosen);
  return chosen.map((h) => h.txt).join('；') + '。';
}

function spotBounty(spot) {
  const counts = G.city.attrCounts;
  const hints = spotHints(spot);
  let rare = 0;
  hints.forEach((h) => { if ((counts[h.key] || 9) <= 4) rare += 8; });
  const centerD = dist2d(spot.x, spot.z, 0, 0);
  return clamp(Math.round((18 + rare + centerD * 0.12 + R(0, 12)) / 5) * 5, 15, 80);
}

/* ---- 线索合法性校验（好友模式） ---- */
function validateClue(text) {
  const t = text.trim();
  if (t.length < 4) return '线索太短啦，至少写 4 个字～';
  if (/[0-9０-９]/.test(t)) return '不可以带数字（会暴露坐标/门牌）！';
  const lower = t.toLowerCase();
  for (const w of BANNED_WORDS) {
    if (lower.includes(w.toLowerCase())) return `不可以出现地点词「${w}」！换个说法试试～`;
  }
  return null;
}

/* ============================================================
 * 角色
 * ============================================================ */
function makePersonMesh(bodyColor, hatColor) {
  const grp = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.42, 1.0, 10), lambert(bodyColor));
  body.position.y = 0.75; body.castShadow = true; grp.add(body);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.3, 12, 10), lambert(0xf0c8a0));
  head.position.y = 1.55; head.castShadow = true; grp.add(head);
  const hat = new THREE.Mesh(new THREE.ConeGeometry(0.32, 0.45, 10), lambert(hatColor));
  hat.position.y = 1.92; grp.add(hat);
  const e1 = new THREE.Mesh(new THREE.SphereGeometry(0.045, 6, 6), lambert(0x222222));
  const e2 = e1.clone();
  e1.position.set(-0.1, 1.6, 0.26); e2.position.set(0.1, 1.6, 0.26);
  grp.add(e1); grp.add(e2);
  return grp;
}

const player = {
  x: 0, z: 20, yaw: 0, pitch: -0.25,
  mesh: null, bikeMesh: null,
  riding: null,         // null | 'bike' | 'bus'
  stamina: 100,
  camDist: 7.5,
};

function makePlayerMesh() {
  if (player.mesh) scene.add(player.mesh);
  else {
    player.mesh = makePersonMesh(0x2f6fd6, 0xffd166);
    // 单车（骑行时显示）
    const bike = new THREE.Group();
    [[-0.55], [0.55]].forEach(([off]) => {
      const wh = new THREE.Mesh(new THREE.TorusGeometry(0.34, 0.06, 6, 14), lambert(0x33363b));
      wh.position.set(0, 0.36, off); wh.rotation.y = Math.PI / 2; bike.add(wh);
    });
    const frame = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 1.1), lambert(0x22c1a3));
    frame.position.y = 0.62; bike.add(frame);
    player.bikeMesh = bike;
    player.mesh.add(bike);
    bike.visible = false;
    scene.add(player.mesh);
  }
}

/* ============================================================
 * 交通：环境车流
 * ============================================================ */
function makeCars(city) {
  city.cars = [];
  const lines = shuffle([0, 1, 2, 3, 4, 5, 6, 7]).slice(0, 6);
  lines.forEach((k, idx) => {
    for (let c = 0; c < 2; c++) {
      const vertical = (idx + c) % 2 === 0;
      const dir = rng() < 0.5 ? 1 : -1;
      const grp = new THREE.Group();
      const col = pick([0xd96b6c, 0xe6cf6f, 0x6e8fd6, 0xefefe6, 0x9aa0a6, 0x83bf78]);
      const body = new THREE.Mesh(new THREE.BoxGeometry(3.4, 1, 1.7), lambert(col));
      body.position.y = 0.75; body.castShadow = true; grp.add(body);
      const cab = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.75, 1.5), lambert(0x274158));
      cab.position.set(-0.2, 1.55, 0); grp.add(cab);
      for (let w = 0; w < 4; w++) {
        const wh = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.36, 0.3, 8), lambert(0x222428));
        wh.rotation.x = Math.PI / 2;
        wh.position.set(-1.1 + (w % 2) * 2.2, 0.36, w < 2 ? -0.85 : 0.85);
        grp.add(wh);
      }
      city.group.add(grp);
      city.cars.push({ mesh: grp, line: roadLine(k), vertical, dir, pos: R(-HALF, HALF), speed: R(9, 15) });
    }
  });
}

function updateCars(dt) {
  if (!G.city.cars) return;
  G.city.cars.forEach((c) => {
    c.pos += c.dir * c.speed * dt;
    if (c.pos > HALF + 6) c.pos = -HALF - 6;
    if (c.pos < -HALF - 6) c.pos = HALF + 6;
    const lane = c.line + 2.4 * c.dir * (c.vertical ? 1 : -1);
    if (c.vertical) {
      c.mesh.position.set(lane, 0, c.pos);
      c.mesh.rotation.y = c.dir > 0 ? -Math.PI / 2 : Math.PI / 2;
    } else {
      c.mesh.position.set(c.pos, 0, lane);
      c.mesh.rotation.y = c.dir > 0 ? Math.PI : 0;
    }
  });
}

/* ---- 公交运行 ---- */
function updateBus(dt) {
  const bus = G.city.bus, path = G.city.busPath;
  if (bus.dwell > 0) {
    bus.dwell -= dt;
    if (bus.dwell <= 0 && bus.riding) showToast('🚌 公交发车了！到下一站按 <b>E</b> 下车');
    return;
  }
  const a = path[bus.seg], b = path[(bus.seg + 1) % 4];
  const segLen = Math.abs(b.x - a.x) + Math.abs(b.z - a.z);
  bus.t += (SPEED.bus * dt) / segLen;
  // 中点站停靠
  const mid = 0.5;
  if (!bus.announced && bus.t >= mid) {
    bus.announced = true;
    bus.dwell = 4.5;
    bus.stopIdx = bus.seg;
    const stop = G.city.busStops[bus.seg];
    const d = dist2d(player.x, player.z, stop.x, stop.z);
    AudioSys.busDing(clamp(0.22 * (1 - d / 90), 0.02, 0.22));
    if (bus.riding) {
      showToast('🚌 到站了，按 <b>E</b> 可以下车');
    }
  }
  if (bus.t >= 1) { bus.t = 0; bus.announced = false; bus.seg = (bus.seg + 1) % 4; }
  const x = a.x + (b.x - a.x) * bus.t;
  const z = a.z + (b.z - a.z) * bus.t;
  bus.mesh.position.set(x, 0, z);
  const ang = Math.atan2(b.x - a.x, b.z - a.z);
  bus.mesh.rotation.y = ang + Math.PI / 2;
  if (bus.riding) {
    player.x = x; player.z = z;
    player.mesh.position.set(x, 2.8, z);
  }
}

/* ============================================================
 * 碰撞
 * ============================================================ */
function collide(x, z, r = 0.55) {
  const c = G.city;
  for (const b of c.aabbs) {
    const nx = clamp(x, b.x1, b.x2), nz = clamp(z, b.z1, b.z2);
    const dx = x - nx, dz = z - nz;
    const d2 = dx * dx + dz * dz;
    if (d2 < r * r) {
      if (d2 < 1e-6) { x += r; continue; }
      const d = Math.sqrt(d2);
      x = nx + (dx / d) * r; z = nz + (dz / d) * r;
    }
  }
  for (const ci of c.circles) {
    const dx = x - ci.x, dz = z - ci.z;
    const d = Math.hypot(dx, dz), min = ci.r + r * 0.5;
    if (d < min && d > 1e-4) { x = ci.x + (dx / d) * min; z = ci.z + (dz / d) * min; }
  }
  x = clamp(x, -HALF + 1.2, HALF - 1.2);
  z = clamp(z, -HALF + 1.2, HALF - 1.2);
  return [x, z];
}

/* ============================================================
 * 躲藏者
 * ============================================================ */
function createHider(spot, name, emoji, clue, bounty, isHuman, ownerLabel) {
  const bodyC = pick([0xd96b6c, 0xe0995c, 0x83bf78, 0xa38ad6, 0xe3a0bd, 0x6fc4c4]);
  const hatC = pick([0xffd166, 0x22c1a3, 0xef6b6b, 0x6e8fd6]);
  const mesh = makePersonMesh(bodyC, hatC);
  mesh.position.set(spot.x, 0.05, spot.z);
  mesh.rotation.y = R(0, Math.PI * 2);
  mesh.visible = false;
  scene.add(mesh);
  spot.taken = true;
  return {
    spot, name, emoji, clue, bounty, mesh,
    found: false, isHuman, ownerLabel: ownerLabel || name,
    giggleCd: R(2, 5), foundBy: null, capAnim: 0,
  };
}

function placeAIHiders(n) {
  const free = G.city.spots.filter((s) => !s.taken);
  // 贪心挑分散的点
  const chosen = [];
  shuffle(free);
  for (const s of free) {
    if (chosen.length >= n) break;
    if (chosen.every((c) => dist2d(c.x, c.z, s.x, s.z) > 55) || free.length < n * 2) chosen.push(s);
  }
  let gi = 0;
  while (chosen.length < n && gi < free.length) {
    if (!chosen.includes(free[gi])) chosen.push(free[gi]);
    gi++;
  }
  const names = shuffle(HIDER_NAMES.slice());
  chosen.slice(0, n).forEach((spot, idx) => {
    const [nm, emoji] = names[idx % names.length];
    const clue = genAIClue(spot, G.hintCount);
    const bounty = spotBounty(spot);
    G.hiders.push(createHider(spot, nm, emoji, clue, bounty, false));
  });
}

function updateHiders(dt, t) {
  G.hiders.forEach((h) => {
    if (h.found) {
      if (h.capAnim > 0) {
        h.capAnim -= dt;
        h.mesh.position.y = 0.05 + Math.max(0, Math.sin((1.2 - h.capAnim) * 6)) * 1.2;
        h.mesh.rotation.y += dt * 9;
        if (h.capAnim <= 0) h.mesh.visible = false;
      }
      return;
    }
    if (G.phase !== 'seek') return;
    h.mesh.position.y = 0.05 + Math.sin(t * 2 + h.spot.x) * 0.03;
    // 靠近时窸窣声提示
    const d = dist2d(player.x, player.z, h.spot.x, h.spot.z);
    h.giggleCd -= dt;
    if (d < 12 && h.giggleCd <= 0) {
      AudioSys.giggle(clamp(0.16 * (1 - d / 14), 0.02, 0.16));
      h.giggleCd = R(2.5, 5);
    }
  });
}

/* ---- 彩带粒子 ---- */
const confetti = [];
function burstConfetti(x, y, z) {
  for (let i = 0; i < 36; i++) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.28),
      new THREE.MeshBasicMaterial({ color: pick([0xffd166, 0x22c1a3, 0xef6b6b, 0x6e8fd6, 0xe3a0bd]), side: THREE.DoubleSide, transparent: true }));
    m.position.set(x, y + 1, z);
    scene.add(m);
    confetti.push({
      m, vx: R(-4, 4), vy: R(3, 9), vz: R(-4, 4),
      rx: R(-6, 6), rz: R(-6, 6), life: R(1.2, 1.9),
    });
  }
}
function updateConfetti(dt) {
  for (let i = confetti.length - 1; i >= 0; i--) {
    const c = confetti[i];
    c.life -= dt;
    c.vy -= 12 * dt;
    c.m.position.x += c.vx * dt; c.m.position.y += c.vy * dt; c.m.position.z += c.vz * dt;
    c.m.rotation.x += c.rx * dt; c.m.rotation.z += c.rz * dt;
    c.m.material.opacity = clamp(c.life, 0, 1);
    if (c.life <= 0 || c.m.position.y < 0) {
      scene.remove(c.m);
      c.m.geometry.dispose(); c.m.material.dispose();
      confetti.splice(i, 1);
    }
  }
}

/* ============================================================
 * 输入
 * ============================================================ */
const keys = {};
let dragging = false, dragMoved = 0, lastMX = 0, lastMY = 0;

addEventListener('keydown', (e) => {
  if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
  keys[e.code] = true;
  AudioSys.ensure();
  if (e.code === 'Space') e.preventDefault();
  handleKey(e.code);
});
addEventListener('keyup', (e) => { keys[e.code] = false; });

renderer.domElement.addEventListener('pointerdown', (e) => {
  AudioSys.ensure();
  dragging = true; dragMoved = 0;
  lastMX = e.clientX; lastMY = e.clientY;
  renderer.domElement.setPointerCapture(e.pointerId);
});
renderer.domElement.addEventListener('pointermove', (e) => {
  mouseNDC.x = (e.clientX / innerWidth) * 2 - 1;
  mouseNDC.y = -(e.clientY / innerHeight) * 2 + 1;
  if (!dragging) return;
  const dx = e.clientX - lastMX, dy = e.clientY - lastMY;
  dragMoved += Math.abs(dx) + Math.abs(dy);
  lastMX = e.clientX; lastMY = e.clientY;
  player.yaw -= dx * 0.0042;
  player.pitch = clamp(player.pitch - dy * 0.0035, -1.35, 0.55);
});
renderer.domElement.addEventListener('pointerup', (e) => {
  dragging = false;
  if (dragMoved < 5 && G.phase === 'hide') pickSpotAt(e.clientX, e.clientY);
});
renderer.domElement.addEventListener('wheel', (e) => {
  player.camDist = clamp(player.camDist + e.deltaY * 0.008, 3.5, 13);
});

const mouseNDC = new THREE.Vector2();
const raycaster = new THREE.Raycaster();

function handleKey(code) {
  if (G.phase === 'seek' && !G.paused) {
    if (code === 'KeyE') tryInteract();
    else if (code === 'KeyR') tryRadar();
    else if (code === 'KeyM') toggleBigMap();
    else if (code === 'KeyB') tryBike();
    else if (code === 'KeyV') { G.view3rd = !G.view3rd; AudioSys.click(); }
    else if (code === 'KeyC') togglePanel();
    else if (code === 'Escape') {
      if (!$('bigMapWrap').classList.contains('hidden')) toggleBigMap();
      else setPause(true);
    }
  } else if (G.phase === 'seek' && G.paused && code === 'Escape') {
    setPause(false);
  } else if (G.phase === 'hide' && code === 'Escape') {
    if (!$('clueModal').classList.contains('hidden')) closeClueModal();
  }
}

document.querySelectorAll('.abtn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const act = btn.dataset.act;
    AudioSys.ensure();
    if (act === 'radar') tryRadar();
    else if (act === 'map') toggleBigMap();
    else if (act === 'bike') tryBike();
    else if (act === 'view') G.view3rd = !G.view3rd;
    else if (act === 'pause') setPause(true);
  });
});

/* ============================================================
 * 寻找阶段玩法
 * ============================================================ */
function spendCredits(n, what) {
  if (G.credits < n) {
    AudioSys.deny();
    showToast(`💸 信用点不够！${what}需要 ${n}💰`, 'red');
    return false;
  }
  G.credits -= n;
  G.spent += n;
  updateHUD();
  return true;
}

function tryInteract() {
  const bus = G.city.bus;
  // 抓人优先
  const h = nearestActiveHider();
  if (h && h.d < 3.2 && player.riding !== 'bus') { captureHider(h.hider); return; }
  // 公交上下车
  if (player.riding === 'bus') {
    if (bus.dwell > 0) {
      player.riding = null;
      bus.riding = false;
      const stop = G.city.busStops[bus.stopIdx];
      player.x = stop.sx; player.z = stop.sz;
      showToast('🚌 你下车了');
      AudioSys.click();
    } else {
      showToast('🚌 车还在行驶，等到站再下车哦', 'red');
    }
    return;
  }
  if (player.riding === null || player.riding === 'bike') {
    const d = dist2d(player.x, player.z, bus.mesh.position.x, bus.mesh.position.z);
    if (d < 6 && bus.dwell > 0) {
      if (player.riding === 'bike') { showToast('🚲 先按 B 还车再上公交', 'red'); return; }
      if (!spendCredits(COST.bus, '乘公交')) return;
      player.riding = 'bus';
      bus.riding = true;
      AudioSys.busDing();
      showToast(`🚌 上车成功（-${COST.bus}💰），下一站按 E 下车`);
    }
  }
}

function tryRadar() {
  if (G.phase !== 'seek' || G.paused) return;
  if (!spendCredits(COST.radar, '雷达')) return;
  const h = nearestActiveHider();
  AudioSys.radar();
  if (!h) { showToast('📡 附近已经没有躲藏者了'); return; }
  const d = Math.round(h.d);
  let temp;
  if (d < 20) temp = '🔥 滚烫！！';
  else if (d < 45) temp = '♨️ 很热！';
  else if (d < 80) temp = '🌤 温热';
  else if (d < 130) temp = '🧊 有点凉';
  else temp = '❄️ 冰冷';
  G.radarRings.push({ x: player.x, z: player.z, d: h.d, until: performance.now() + 7000 });
  if (G.radarRings.length > 2) G.radarRings.shift();
  showToast(`📡 最近的躲藏者距你约 <b>${d} 米</b> —— ${temp}<br><small>小地图上画出了测距圈，换个位置再测一次就能定位！</small>`, 'gold');
}

function tryBike() {
  if (G.phase !== 'seek' || G.paused) return;
  if (player.riding === 'bus') { showToast('🚌 你在公交车上！', 'red'); return; }
  if (player.riding === 'bike') {
    player.riding = null;
    player.bikeMesh.visible = false;
    showToast('🚲 已还车，步行继续～');
    AudioSys.click();
    return;
  }
  const st = G.city.bikeStations.find((s) => dist2d(player.x, player.z, s.x, s.z) < 7);
  if (!st) { showToast('🚲 附近没有单车站（看小地图上的橙色点）', 'red'); return; }
  if (!spendCredits(COST.bike, '租单车')) return;
  player.riding = 'bike';
  player.bikeMesh.visible = true;
  AudioSys.coin();
  showToast(`🚲 骑上单车（-${COST.bike}💰），速度大提升！随时按 B 还车`);
}

function nearestActiveHider() {
  let best = null, bd = 1e9;
  G.hiders.forEach((h) => {
    if (h.found) return;
    const d = dist2d(player.x, player.z, h.spot.x, h.spot.z);
    if (d < bd) { bd = d; best = h; }
  });
  return best ? { hider: best, d: bd } : null;
}

function captureHider(h) {
  h.found = true;
  h.capAnim = 1.2;
  h.foundBy = G.seekers[G.curSeeker].name;
  const reward = COST.captureBase + h.bounty;
  G.credits += reward;
  G.earned += reward;
  G.captures++;
  G.seekers[G.curSeeker].captures++;
  G.seekers[G.curSeeker].earned += reward;
  AudioSys.capture();
  burstConfetti(h.spot.x, 1, h.spot.z);
  showToast(`🎉 <b>${G.seekers[G.curSeeker].name}</b> 找到了 ${h.emoji} <b>${h.name}</b>！<br>基础 ${COST.captureBase}💰 + 悬赏 ${h.bounty}💰`, 'gold');
  updateHUD();
  renderCluePanel();
  const left = G.hiders.filter((x) => !x.found).length;
  if (left === 0) setTimeout(() => endGame(true), 1400);
}

/* ---- 出租车大地图 ---- */
let bigMapOpen = false;
function toggleBigMap() {
  if (G.phase !== 'seek' || G.paused) return;
  bigMapOpen = !bigMapOpen;
  $('bigMapWrap').classList.toggle('hidden', !bigMapOpen);
  if (bigMapOpen) drawMap($('bigMap').getContext('2d'), 560, true);
}
$('mapClose').addEventListener('click', toggleBigMap);
$('bigMap').addEventListener('mousemove', (e) => {
  const rect = $('bigMap').getBoundingClientRect();
  const wx = ((e.clientX - rect.left) / rect.width) * WORLD - HALF;
  const wz = ((e.clientY - rect.top) / rect.height) * WORLD - HALF;
  const cost = taxiCost(wx, wz);
  $('mapCost').textContent = `${cost}💰`;
});
$('bigMap').addEventListener('click', (e) => {
  const rect = $('bigMap').getBoundingClientRect();
  const wx = ((e.clientX - rect.left) / rect.width) * WORLD - HALF;
  const wz = ((e.clientY - rect.top) / rect.height) * WORLD - HALF;
  callTaxi(wx, wz);
});
function taxiCost(x, z) {
  return COST.taxiBase + Math.round(dist2d(player.x, player.z, x, z) * COST.taxiPerM);
}
function callTaxi(x, z) {
  if (player.riding === 'bus') { showToast('🚌 你在公交车上，先下车！', 'red'); return; }
  const cost = taxiCost(x, z);
  if (!spendCredits(cost, '打车')) return;
  // 落点吸附到最近道路
  let bestK = 0, bestAxis = 'x', bestD = 1e9;
  for (let k = 0; k <= GRID; k++) {
    const dX = Math.abs(x - roadLine(k)), dZ = Math.abs(z - roadLine(k));
    if (dX < bestD) { bestD = dX; bestK = k; bestAxis = 'x'; }
    if (dZ < bestD) { bestD = dZ; bestK = k; bestAxis = 'z'; }
  }
  let tx = x, tz = z;
  if (bestAxis === 'x') tx = roadLine(bestK) + 3.5; else tz = roadLine(bestK) + 3.5;
  tx = clamp(tx, -HALF + 3, HALF - 3); tz = clamp(tz, -HALF + 3, HALF - 3);
  toggleBigMap();
  AudioSys.taxi();
  const fade = $('fade');
  fade.style.opacity = 1;
  if (player.riding === 'bike') { player.riding = null; player.bikeMesh.visible = false; }
  setTimeout(() => {
    [player.x, player.z] = collide(tx, tz);
    fade.style.opacity = 0;
    showToast(`🚕 出租车把你送到了目的地（-${cost}💰）`);
  }, 550);
}

/* ============================================================
 * 玩家更新 & 摄像机
 * ============================================================ */
const flyCam = { x: 0, y: 90, z: 80 };

function updatePlayer(dt) {
  if (player.riding === 'bus') {
    updateCamera(dt);
    return;
  }
  let mx = 0, mz = 0;
  if (keys['KeyW'] || keys['ArrowUp']) mz += 1;
  if (keys['KeyS'] || keys['ArrowDown']) mz -= 1;
  if (keys['KeyA'] || keys['ArrowLeft']) mx -= 1;
  if (keys['KeyD'] || keys['ArrowRight']) mx += 1;
  const moving = mx !== 0 || mz !== 0;
  let sp = SPEED.walk;
  const wantRun = keys['ShiftLeft'] || keys['ShiftRight'];
  if (player.riding === 'bike') sp = SPEED.bike;
  else if (wantRun && player.stamina > 1 && moving) {
    sp = SPEED.run;
    player.stamina = Math.max(0, player.stamina - 26 * dt);
  }
  if (!(wantRun && moving) || player.riding === 'bike') player.stamina = Math.min(100, player.stamina + 15 * dt);
  $('staminaBar').style.width = player.stamina + '%';
  $('staminaBar').style.background = player.stamina < 25 ? '#ef6b6b' : '#22c1a3';

  if (moving) {
    const len = Math.hypot(mx, mz);
    mx /= len; mz /= len;
    const sin = Math.sin(player.yaw), cos = Math.cos(player.yaw);
    const wx = mz * -sin + mx * cos;
    const wz = mz * -cos - mx * sin;
    let nx = player.x + wx * sp * dt;
    let nz = player.z + wz * sp * dt;
    [nx, nz] = collide(nx, nz);
    player.x = nx; player.z = nz;
    const targetRot = Math.atan2(wx, wz);
    let dr = targetRot - player.mesh.rotation.y;
    while (dr > Math.PI) dr -= Math.PI * 2;
    while (dr < -Math.PI) dr += Math.PI * 2;
    player.mesh.rotation.y += dr * Math.min(1, dt * 12);
  }
  player.mesh.position.set(player.x, 0.05, player.z);
  updateCamera(dt);
}

function updateCamera() {
  const py = player.riding === 'bus' ? 3.4 : 1.6;
  if (G.view3rd) {
    const cd = player.camDist;
    const cx = player.x + Math.sin(player.yaw) * cd * Math.cos(player.pitch);
    const cz = player.z + Math.cos(player.yaw) * cd * Math.cos(player.pitch);
    const cy = py + 1.6 - Math.sin(player.pitch) * cd;
    camera.position.set(cx, Math.max(0.6, cy), cz);
    camera.lookAt(player.x, py + 0.6, player.z);
    player.mesh.visible = player.riding !== 'bus';
  } else {
    camera.position.set(player.x, py, player.z);
    const lx = player.x - Math.sin(player.yaw) * 10 * Math.cos(player.pitch);
    const lz = player.z - Math.cos(player.yaw) * 10 * Math.cos(player.pitch);
    camera.lookAt(lx, py + Math.sin(-player.pitch) * -10, lz);
    player.mesh.visible = false;
  }
  sunLight.target.position.set(player.x, 0, player.z);
}

/* 自由飞行（躲藏阶段） */
function updateFlyCam(dt) {
  const fast = keys['ShiftLeft'] || keys['ShiftRight'];
  const sp = fast ? SPEED.flyFast : SPEED.fly;
  let mx = 0, mz = 0, my = 0;
  if (keys['KeyW']) mz += 1;
  if (keys['KeyS']) mz -= 1;
  if (keys['KeyA']) mx -= 1;
  if (keys['KeyD']) mx += 1;
  if (keys['Space']) my += 1;
  if (keys['KeyZ']) my -= 1;
  const sin = Math.sin(player.yaw), cos = Math.cos(player.yaw);
  flyCam.x += (mz * -sin + mx * cos) * sp * dt;
  flyCam.z += (mz * -cos - mx * sin) * sp * dt;
  flyCam.y = clamp(flyCam.y + my * sp * dt, 4, 260);
  flyCam.x = clamp(flyCam.x, -HALF - 60, HALF + 60);
  flyCam.z = clamp(flyCam.z, -HALF - 60, HALF + 60);
  camera.position.set(flyCam.x, flyCam.y, flyCam.z);
  const lx = flyCam.x - Math.sin(player.yaw) * 10 * Math.cos(player.pitch);
  const ly = flyCam.y + Math.sin(player.pitch) * 10;
  const lz = flyCam.z - Math.cos(player.yaw) * 10 * Math.cos(player.pitch);
  camera.lookAt(lx, ly, lz);
}

/* ============================================================
 * 小地图 / 大地图
 * ============================================================ */
function drawMap(ctx, size, big) {
  const sc = size / WORLD;
  const T = (v) => (v + HALF) * sc;
  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = '#3a3f46'; ctx.fillRect(0, 0, size, size);
  const cols = { plaza: '#c9b78a', park: '#4f9e5f', pond: '#4f9e5f', down: '#7f8ba0', market: '#b58a5f', constr: '#8a7f6a', res: '#9aa0a8' };
  for (let i = 0; i < GRID; i++) for (let j = 0; j < GRID; j++) {
    ctx.fillStyle = cols[blockType(i, j)];
    ctx.fillRect(T(blockMin(i)), T(blockMin(j)), BLOCK * sc, BLOCK * sc);
  }
  const c = G.city;
  if (c) {
    if (c.pond) {
      ctx.fillStyle = '#3f8fd6';
      ctx.beginPath(); ctx.ellipse(T(c.pond.x), T(c.pond.z), c.pond.rx * sc, c.pond.rz * sc, 0, 0, Math.PI * 2); ctx.fill();
    }
    if (c.tower) {
      ctx.fillStyle = '#e3d9c4';
      ctx.fillRect(T(c.tower.x) - 3, T(c.tower.z) - 3, 6, 6);
    }
    // 公交站
    c.busStops.forEach((b) => {
      ctx.fillStyle = '#2f7fd6';
      ctx.fillRect(T(b.sx) - (big ? 4 : 2.5), T(b.sz) - (big ? 4 : 2.5), big ? 8 : 5, big ? 8 : 5);
    });
    // 单车站
    c.bikeStations.forEach((b) => {
      ctx.fillStyle = '#e0995c';
      ctx.beginPath(); ctx.arc(T(b.x), T(b.z), big ? 4 : 2.5, 0, Math.PI * 2); ctx.fill();
    });
    // 公交车
    if (c.bus && G.phase === 'seek') {
      ctx.fillStyle = '#61b3ff';
      ctx.beginPath(); ctx.arc(T(c.bus.mesh.position.x), T(c.bus.mesh.position.z), big ? 5 : 3.5, 0, Math.PI * 2); ctx.fill();
    }
    // 雷达测距圈
    const now = performance.now();
    G.radarRings = G.radarRings.filter((r) => r.until > now);
    G.radarRings.forEach((r) => {
      ctx.strokeStyle = 'rgba(255,209,102,0.9)';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(T(r.x), T(r.z), r.d * sc, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = 'rgba(255,209,102,0.9)';
      ctx.beginPath(); ctx.arc(T(r.x), T(r.z), 2.5, 0, Math.PI * 2); ctx.fill();
    });
    // 已找到的躲藏者
    if (G.phase === 'seek' || G.phase === 'end') {
      ctx.font = `${big ? 14 : 10}px sans-serif`;
      G.hiders.forEach((h) => {
        if (h.found) ctx.fillText('✅', T(h.spot.x) - 5, T(h.spot.z) + 4);
      });
    }
  }
  // 玩家箭头
  if (G.phase === 'seek') {
    const px = T(player.x), pz = T(player.z);
    ctx.save();
    ctx.translate(px, pz);
    ctx.rotate(-player.yaw + Math.PI);
    ctx.fillStyle = '#ffd166';
    ctx.strokeStyle = '#0b1220'; ctx.lineWidth = 1.5;
    ctx.beginPath();
    const s = big ? 9 : 6.5;
    ctx.moveTo(0, -s); ctx.lineTo(s * 0.7, s); ctx.lineTo(0, s * 0.5); ctx.lineTo(-s * 0.7, s);
    ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.restore();
  }
}

/* ============================================================
 * UI 辅助
 * ============================================================ */
function showToast(html, kind = '') {
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.innerHTML = html;
  $('toasts').appendChild(t);
  setTimeout(() => {
    t.style.transition = 'opacity .5s'; t.style.opacity = 0;
    setTimeout(() => t.remove(), 550);
  }, 4200);
  while ($('toasts').children.length > 4) $('toasts').firstChild.remove();
}

function updateHUD() {
  $('credits').textContent = G.credits;
  const m = Math.floor(Math.max(0, G.timeLeft) / 60), s = Math.floor(Math.max(0, G.timeLeft) % 60);
  $('timer').textContent = `${m}:${String(s).padStart(2, '0')}`;
  $('found').textContent = `${G.captures}/${G.hiders.length}`;
  $('seekerName').textContent = G.seekers.length ? G.seekers[G.curSeeker].name : '-';
  $('seekerStat').style.display = G.seekers.length > 1 ? '' : 'none';
}

function renderCluePanel() {
  const list = $('clueList');
  list.innerHTML = '';
  G.hiders.forEach((h) => {
    const card = document.createElement('div');
    card.className = 'clueCard' + (h.found ? ' found' : '');
    card.innerHTML = `<span class="bounty">悬赏 ${h.bounty}💰</span><div class="who">${h.emoji} ${h.name}</div><div class="clue">"${h.clue}"</div>`;
    list.appendChild(card);
  });
}

function togglePanel() {
  G.panelOpen = !G.panelOpen;
  $('clueList').style.display = G.panelOpen ? '' : 'none';
  $('panelArrow').textContent = G.panelOpen ? '▾' : '▸';
}
$('panelToggle').addEventListener('click', togglePanel);

function setPrompt(html) {
  const p = $('prompt');
  if (!html) { p.classList.add('hidden'); return; }
  p.classList.remove('hidden');
  if (p.innerHTML !== html) p.innerHTML = html;
}

function setPause(v) {
  if (G.phase !== 'seek') return;
  G.paused = v;
  $('pauseMenu').classList.toggle('hidden', !v);
}
$('resumeBtn').addEventListener('click', () => setPause(false));
$('quitBtn').addEventListener('click', () => { setPause(false); backToMenu(); });

/* ============================================================
 * 游戏流程
 * ============================================================ */
function resetWorld() {
  G.seed = (Math.random() * 2 ** 31) | 0;
  rng = mulberry32(G.seed);
  makeScene();
  G.city = genCity();
  makeCars(G.city);
  makePlayerMesh();
  G.hiders = [];
  G.radarRings = [];
  spotMarkers = [];
  confetti.length = 0;
}

function readConfig() {
  G.mode = $('modeAI').classList.contains('sel') ? 'ai' : 'hot';
  G.nHiders = parseInt($('numHiders').value);
  G.mSeekers = parseInt($('numSeekers').value);
  const diff = $('difficulty').value;
  G.hintCount = { easy: 4, normal: 3, hard: 2 }[diff];
  G.startCredits = { easy: 160, normal: 110, hard: 70 }[diff];
  G.totalTime = parseInt($('timeLimit').value);
}

function startGame() {
  AudioSys.ensure();
  readConfig();
  resetWorld();
  G.captures = 0; G.spent = 0; G.earned = 0;
  G.credits = G.startCredits;
  G.timeLeft = G.totalTime;
  G.curSeeker = 0;
  G.seekers = [];
  for (let i = 0; i < G.mSeekers; i++) {
    G.seekers.push({ name: G.mSeekers > 1 ? `寻找者${i + 1}号` : '你', captures: 0, earned: 0 });
  }
  $('menu').classList.add('hidden');
  $('endScreen').classList.add('hidden');

  if (G.mode === 'ai') {
    placeAIHiders(G.nHiders);
    beginSeekPhase();
  } else {
    beginHidePhase();
  }
}

/* ---- 好友模式：躲藏阶段 ---- */
let spotMarkers = [];
function beginHidePhase() {
  G.phase = 'hide';
  G.hideIdx = 0;
  $('hud').classList.add('hidden');
  $('hideBanner').classList.remove('hidden');
  flyCam.x = 0; flyCam.y = 110; flyCam.z = 90;
  player.yaw = 0; player.pitch = -0.85;
  makeSpotMarkers();
  showTurnOverlay(`🙈 躲藏者 ${G.hideIdx + 1} 号请就位`, '其他玩家请回避屏幕！飞到城市里挑一个青色圆环藏身', () => {
    updateHideBanner();
  });
}

function updateHideBanner() {
  $('hideBannerText').textContent = `🙈 躲藏者 ${G.hideIdx + 1}/${G.nHiders} 号正在选点`;
}

function makeSpotMarkers() {
  clearSpotMarkers();
  G.city.spots.forEach((s) => {
    if (s.taken) return;
    const grp = new THREE.Group();
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(1.25, 1.25, 0.25, 20),
      new THREE.MeshBasicMaterial({ color: 0x22e1c3, transparent: true, opacity: 0.75 }));
    disc.position.y = 0.4;
    grp.add(disc);
    // 竖直光柱：空中也能一眼看到
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.9, 46, 10, 1, true),
      new THREE.MeshBasicMaterial({ color: 0x22e1c3, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false }));
    beam.position.y = 23;
    grp.add(beam);
    grp.position.set(s.x, 0, s.z);
    grp.userData.spot = s;
    grp.userData.disc = disc;
    scene.add(grp);
    spotMarkers.push(grp);
  });
}
function clearSpotMarkers() {
  spotMarkers.forEach((m) => scene.remove(m));
  spotMarkers = [];
}

function pickSpotAt(cx, cy) {
  if (!$('clueModal').classList.contains('hidden')) return;
  const ndc = new THREE.Vector2((cx / innerWidth) * 2 - 1, -(cy / innerHeight) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObjects(spotMarkers, true);
  if (!hits.length) return;
  let obj = hits[0].object;
  while (obj && !obj.userData.spot) obj = obj.parent;
  if (!obj) return;
  G.pendingSpot = obj.userData.spot;
  openClueModal(G.pendingSpot);
}

function openClueModal(spot) {
  AudioSys.click();
  $('clueModal').classList.remove('hidden');
  $('spotDesc').innerHTML = `你选中的藏身点：<b style="color:#ffd166">${spot.label}</b>（${TYPE_NAME[spot.blockType] || '某处'}）<br>请写一条<b>不含任何地点信息</b>的线索——禁止方位词、地名、数字。`;
  const chips = $('hintChips');
  chips.innerHTML = '';
  spotHints(spot).forEach((h) => {
    const c = document.createElement('span');
    c.className = 'chip';
    c.textContent = '+ ' + h.txt;
    c.addEventListener('click', () => {
      const ta = $('clueInput');
      ta.value = ta.value ? ta.value.replace(/[。；;]?\s*$/, '') + '；' + h.txt : h.txt;
    });
    chips.appendChild(c);
  });
  $('clueInput').value = '';
  $('clueError').textContent = '';
  $('bountyRange').value = spotBounty(spot);
  $('bountyVal').textContent = $('bountyRange').value + ' 💰';
}
function closeClueModal() {
  $('clueModal').classList.add('hidden');
  G.pendingSpot = null;
}
$('bountyRange').addEventListener('input', () => { $('bountyVal').textContent = $('bountyRange').value + ' 💰'; });
$('clueCancel').addEventListener('click', closeClueModal);
$('clueOk').addEventListener('click', () => {
  const text = $('clueInput').value.trim();
  const err = validateClue(text);
  if (err) { $('clueError').textContent = '⚠️ ' + err; AudioSys.deny(); return; }
  const spot = G.pendingSpot;
  const bounty = parseInt($('bountyRange').value);
  const [nm, emoji] = HIDER_NAMES[G.hideIdx % HIDER_NAMES.length];
  const label = `躲藏者${G.hideIdx + 1}号`;
  G.hiders.push(createHider(spot, `${label}·${nm}`, emoji, text + '。', bounty, true, label));
  closeClueModal();
  AudioSys.coin();
  // 移除被占的标记
  const mk = spotMarkers.find((m) => m.userData.spot === spot);
  if (mk) { scene.remove(mk); spotMarkers.splice(spotMarkers.indexOf(mk), 1); }
  G.hideIdx++;
  if (G.hideIdx < G.nHiders) {
    flyCam.x = 0; flyCam.y = 110; flyCam.z = 90;
    player.yaw = R(0, Math.PI * 2); player.pitch = -0.85;
    showTurnOverlay(`🙈 躲藏者 ${G.hideIdx + 1} 号请就位`, '其他玩家请回避屏幕！', updateHideBanner);
  } else {
    clearSpotMarkers();
    $('hideBanner').classList.add('hidden');
    showTurnOverlay('🔎 寻找阶段开始！', '躲藏者们请把键盘交给寻找者', beginSeekPhase);
  }
});

/* ---- 寻找阶段 ---- */
function beginSeekPhase() {
  G.phase = 'seek';
  G.paused = false;
  G.hiders.forEach((h) => { h.mesh.visible = !h.found; });
  // 出生点：广场旁
  player.x = blockCenter(3) + 2;
  player.z = blockCenter(3) + 16;
  player.yaw = Math.PI; player.pitch = -0.3;
  player.riding = null;
  player.bikeMesh.visible = false;
  player.stamina = 100;
  G.city.bus.riding = false;
  G.turnTimer = 75;
  $('hud').classList.remove('hidden');
  $('hideBanner').classList.add('hidden');
  updateHUD();
  renderCluePanel();
  if (G.mode === 'ai') {
    showToast(`🕵️ ${G.nHiders} 位躲藏者藏好了！读读左侧线索开始寻找吧`, 'gold');
  } else {
    showToast('🕵️ 所有躲藏者已就位！寻找者出发！', 'gold');
  }
  if (G.seekers.length > 1) {
    showTurnOverlay(`🧢 ${G.seekers[0].name} 先上场`, '每 75 秒轮换一位寻找者', null);
  }
  chimeTimer = 15;
}

function showTurnOverlay(text, sub, cb) {
  $('turnOverlay').classList.remove('hidden');
  $('turnText').textContent = text;
  $('turnSub').textContent = sub || '';
  G.msg = { cb };
  setTimeout(() => {
    $('turnOverlay').classList.add('hidden');
    if (cb) cb();
  }, 2200);
}

function rotateSeeker() {
  G.curSeeker = (G.curSeeker + 1) % G.seekers.length;
  G.turnTimer = 75;
  AudioSys.busDing();
  showTurnOverlay(`🧢 轮到 ${G.seekers[G.curSeeker].name}`, '快去接手键盘！', null);
  updateHUD();
}

/* ---- 结算 ---- */
function endGame(allFound) {
  G.phase = 'end';
  $('hud').classList.add('hidden');
  const bonus = allFound ? Math.round(G.timeLeft) : 0;
  const finalScore = G.credits + bonus;
  $('endTitle').innerHTML = allFound ? '🏆 大获全胜！' : '⏰ 时间到！';
  $('endSub').textContent = allFound
    ? `所有躲藏者都被找到了！剩余时间奖励 +${bonus}💰`
    : `还有 ${G.hiders.filter((h) => !h.found).length} 位躲藏者没被找到，他们赢了这一局`;
  let html = `<table class="result"><tr><th>躲藏者</th><th>悬赏</th><th>结果</th></tr>`;
  G.hiders.forEach((h) => {
    html += `<tr><td>${h.emoji} ${h.name}</td><td class="gold">${h.bounty}💰</td>` +
      (h.found ? `<td class="teal">被 ${h.foundBy} 找到</td>` : `<td class="redt">成功隐藏到最后 🎖</td>`) + `</tr>`;
  });
  html += `</table>`;
  if (G.seekers.length > 1) {
    html += `<table class="result"><tr><th>寻找者</th><th>抓到</th><th>赚取</th></tr>`;
    [...G.seekers].sort((a, b) => b.earned - a.earned).forEach((s) => {
      html += `<tr><td>🧢 ${s.name}</td><td>${s.captures} 人</td><td class="gold">${s.earned}💰</td></tr>`;
    });
    html += `</table>`;
  }
  html += `<div style="font-size:15px;line-height:2">共获得 <b class="teal">${G.earned}💰</b> · 花费 <b class="redt">${G.spent}💰</b> · 最终结余 <b class="gold" style="font-size:20px">${finalScore}💰</b></div>`;
  $('endStats').innerHTML = html;
  $('endScreen').classList.remove('hidden');
  if (allFound) AudioSys.capture();
  else AudioSys.chime(0.2);
}

function backToMenu() {
  G.phase = 'menu';
  $('hud').classList.add('hidden');
  $('endScreen').classList.add('hidden');
  $('hideBanner').classList.add('hidden');
  $('menu').classList.remove('hidden');
  resetWorld();  // 换一张新地图做背景
  menuOrbit = 0;
}

$('startBtn').addEventListener('click', startGame);
$('againBtn').addEventListener('click', startGame);
$('backMenuBtn').addEventListener('click', backToMenu);
$('modeAI').addEventListener('click', () => { $('modeAI').classList.add('sel'); $('modeHot').classList.remove('sel'); });
$('modeHot').addEventListener('click', () => { $('modeHot').classList.add('sel'); $('modeAI').classList.remove('sel'); });

/* ============================================================
 * 主循环
 * ============================================================ */
let lastT = performance.now();
let menuOrbit = 0;
let chimeTimer = 20;
let birdTimer = 8;
let miniTimer = 0;

function tick() {
  requestAnimationFrame(tick);
  const now = performance.now();
  const dt = clamp((now - lastT) / 1000, 0, 0.05);
  lastT = now;
  const t = now / 1000;

  if (G.phase === 'menu') {
    // 菜单背景：缓慢环绕城市
    menuOrbit += dt * 0.08;
    camera.position.set(Math.cos(menuOrbit) * 190, 110, Math.sin(menuOrbit) * 190);
    camera.lookAt(0, 0, 0);
    updateCars(dt);
    updateBus(dt);
  } else if (G.phase === 'hide') {
    updateFlyCam(dt);
    // 标记呼吸动画
    spotMarkers.forEach((m, i) => {
      const disc = m.userData.disc;
      disc.scale.setScalar(1 + Math.sin(t * 3 + i) * 0.18);
      disc.material.opacity = 0.55 + Math.sin(t * 3 + i) * 0.25;
    });
    updateCars(dt);
    updateBus(dt);
  } else if (G.phase === 'seek' && !G.paused) {
    G.timeLeft -= dt;
    if (G.timeLeft <= 0) { endGame(false); }
    updatePlayer(dt);
    updateCars(dt);
    updateBus(dt);
    updateHiders(dt, t);
    updateConfetti(dt);

    // 轮换
    if (G.seekers.length > 1) {
      G.turnTimer -= dt;
      if (G.turnTimer <= 0) rotateSeeker();
    }
    // 钟楼报时
    chimeTimer -= dt;
    if (chimeTimer <= 0) {
      chimeTimer = 90;
      const d = dist2d(player.x, player.z, G.city.tower.x, G.city.tower.z);
      AudioSys.chime(clamp(0.3 * (1 - d / 160), 0.02, 0.3));
    }
    // 公园鸟叫
    birdTimer -= dt;
    if (birdTimer <= 0) {
      birdTimer = R(5, 9);
      const bi = clamp(Math.floor((player.x + HALF - ROAD / 2) / CELL), 0, 6);
      const bj = clamp(Math.floor((player.z + HALF - ROAD / 2) / CELL), 0, 6);
      const bt = blockType(bi, bj);
      if (bt === 'park' || bt === 'pond') AudioSys.chirp();
    }
    // 交互提示
    updateInteractPrompt();
    // HUD 时间
    updateHUD();
    // 小地图节流
    miniTimer -= dt;
    if (miniTimer <= 0) {
      miniTimer = 0.12;
      drawMap($('minimap').getContext('2d'), 220, false);
      if (bigMapOpen) drawMap($('bigMap').getContext('2d'), 560, true);
    }
  } else if (G.phase === 'end') {
    menuOrbit += dt * 0.05;
    camera.position.set(Math.cos(menuOrbit) * 150, 90, Math.sin(menuOrbit) * 150);
    camera.lookAt(0, 0, 0);
    updateConfetti(dt);
  }

  // 喷泉动画
  if (G.city && G.city.fountainJet) {
    G.city.fountainJet.scale.y = 1 + Math.sin(t * 3.2) * 0.18;
  }
  // 钟楼指针
  if (G.city && G.city.clockHands) {
    G.city.clockHands.forEach((h) => { h.rotation.z = -(t % 60) / 60 * Math.PI * 2; });
  }

  renderer.render(scene, camera);
}

function updateInteractPrompt() {
  const near = nearestActiveHider();
  const bus = G.city.bus;
  if (near && near.d < 3.2 && player.riding !== 'bus') {
    setPrompt(`🫳 按 <kbd>E</kbd> 抓住 ${near.hider.emoji} ${near.hider.name}！`);
    return;
  }
  if (player.riding === 'bus') {
    setPrompt(bus.dwell > 0 ? '🚌 到站！按 <kbd>E</kbd> 下车' : '🚌 公交行驶中…');
    return;
  }
  const busD = dist2d(player.x, player.z, bus.mesh.position.x, bus.mesh.position.z);
  if (busD < 6 && bus.dwell > 0 && player.riding !== 'bike') {
    setPrompt(`🚌 按 <kbd>E</kbd> 上公交（${COST.bus}💰）`);
    return;
  }
  const st = G.city.bikeStations.find((s) => dist2d(player.x, player.z, s.x, s.z) < 7);
  if (st && player.riding === null) {
    setPrompt(`🚲 按 <kbd>B</kbd> 租单车（${COST.bike}💰）`);
    return;
  }
  if (near && near.d < 14) {
    setPrompt('👀 好像有窸窸窣窣的声音……就在附近！');
    return;
  }
  setPrompt('');
}

/* ---- 启动 ---- */
resetWorld();
updateHUD();
tick();

// 调试钩子（仅用于自动化测试/研究地图）
window.__hs = { G, player, camera, markers: () => spotMarkers, capture: captureHider };

})();
