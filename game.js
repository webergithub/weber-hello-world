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

/* ---------------- 国际化 ---------------- */
const LANG = localStorage.getItem('ct_lang')
  || (((navigator.language || 'zh').toLowerCase().indexOf('zh') === 0) ? 'zh' : 'en');
function setLang(l) { localStorage.setItem('ct_lang', l); location.reload(); }

const I18N = {
zh: {
  sub: '城市孪生躲猫猫 · 真实地图数据 3D 城市 · n 人藏，m 人找 · 线索 + 悬赏 + 信用点',
  mode_ai_h: '🤖 快速游戏', mode_ai_p: 'AI 躲藏者藏进城市各处，发布线索和悬赏，你来找！',
  mode_hot_h: '👥 好友同乐', mode_hot_p: '轮流传键盘：躲的人飞行选点、写线索、设悬赏，找的人轮流上场。',
  cfg_hiders: '躲藏 n =', cfg_seekers: '寻找 m =', cfg_diff: '难度', cfg_time: '时限',
  diff: ['简单', '普通', '困难'], times: ['5 分钟', '8 分钟', '12 分钟'],
  btn_start: '开 始 游 戏',
  help: '<kbd>W A S D</kbd> 移动 · <kbd>Shift</kbd> 奔跑 · 按住鼠标拖动转视角 · <kbd>E</kbd> 抓人 / 上下车<br><kbd>B</kbd> 借还单车 · <kbd>M</kbd> 打车 · <kbd>R</kbd> 雷达测距 · <kbd>V</kbd> 切换视角 · <kbd>C</kbd> 收起线索',
  admin_label: '⚙️ 管理员 · 世界倍速', admin_hint: '人物与交通工具的移动速度 = 现实速度 × n（默认 3）',
  admin_val: (n) => `${n}× 现实`,
  city_town: '🏙 随机小镇', city_town_sub: '程序生成', city_london_sub: '真实地图数据', city_soon: '敬请期待', city_wip: '开发中，敬请期待!',
  city_names: { london: '伦敦', istanbul: '伊斯坦布尔', dubai: '迪拜', shanghai: '上海', newyork: '纽约' },
  map_title: '🚕 出租车地图', found_tag: ' ✅ 已找到',
  hud_credits: '信用点', hud_time: '剩余时间', hud_found: '已找到', hud_seeker: '当前寻找者',
  panel_title: '🕵️ 躲藏者线索', mm_title: '🗺 小地图', mm_min: '最小化', mm_restore: '还原', mm_close: '关闭', mm_open: '打开小地图',
  ab_radar: '📡 雷达', ab_taxi: '🚕 打车', ab_bike: '🚲 单车', ab_view: '🎥 视角', ab_menu: '⏸ 菜单',
  hide_banner: (i, n) => `🙈 躲藏者 ${i}/${n} 号正在选点`,
  hide_help: 'WASD 飞行 · <kbd>空格</kbd> 上升 · <kbd>Z</kbd> 下降 · 拖动鼠标转视角 · 点击地上的 <span style="color:#22c1a3">青色光柱</span> 选择藏身点',
  hide_turn: (i) => `🙈 躲藏者 ${i} 号请就位`, hide_turn_sub: '其他玩家请回避屏幕！飞到城市里挑一个青色光柱藏身',
  clue_h2: '✍️ 发布你的线索',
  clue_desc: (label, area) => `你选中的藏身点：<b style="color:#ffd166">${label}</b>（${area}）<br>请写一条<b>不含任何地点信息</b>的线索——禁止方位词、地名、数字。`,
  clue_chips: '点击灵感标签可以直接加进线索：',
  clue_ph: '写一条不暴露地点的线索，比如：我能听到流水声，身边有一股淡淡的青草味…',
  clue_bounty: '悬赏', clue_cancel: '↩ 重新选点', clue_ok: '✅ 藏好了！',
  map_hint: '🚕 点击地图任意位置打车前往 —— 预计费用 ', map_close: '取消 (M)',
  pause_h: '⏸ 暂停', pause_resume: '继续游戏', pause_quit: '回到主菜单',
  end_again: '🔁 再来一局', end_back: '回到主菜单',
  end_win: '🏆 大获全胜！', end_lose: '⏰ 时间到！',
  end_win_sub: (b) => `所有躲藏者都被找到了！剩余时间奖励 +${b}💰`,
  end_lose_sub: (n) => `还有 ${n} 位躲藏者没被找到，他们赢了这一局`,
  th_hider: '躲藏者', th_bounty: '悬赏', th_result: '结果', th_seeker: '寻找者', th_caught: '抓到', th_earned: '赚取',
  found_by: (w) => `被 ${w} 找到`, survived: '成功隐藏到最后 🎖', persons: (n) => `${n} 人`,
  end_total: (e, s, f) => `共获得 <b class="teal">${e}💰</b> · 花费 <b class="redt">${s}💰</b> · 最终结余 <b class="gold" style="font-size:20px">${f}💰</b>`,
  you: '你', seeker_n: (i) => `寻找者${i}号`, hider_n: (i) => `躲藏者${i}号`,
  turn_first: (n) => `🧢 ${n} 先上场`, turn_rotate: '每 75 秒轮换一位寻找者',
  turn_next: (n) => `🧢 轮到 ${n}`, turn_next_sub: '快去接手键盘！',
  seek_go: '🔎 寻找阶段开始！', seek_go_sub: '躲藏者们请把键盘交给寻找者',
  toast_ai_ready: (n) => `🕵️ ${n} 位躲藏者藏好了！读读左侧线索开始寻找吧`,
  toast_hot_ready: '🕵️ 所有躲藏者已就位！寻找者出发！',
  no_credit: (n, w) => `💸 信用点不够！${w}需要 ${n}💰`,
  w_radar: '雷达', w_bike: '租单车', w_bus: '乘公交', w_train: '乘地铁', w_taxi: '打车', w_ferry: '乘轮渡',
  radar_none: '📡 附近已经没有躲藏者了',
  radar_result: (d, temp) => `📡 最近的躲藏者距你约 <b>${d} 米</b> —— ${temp}<br><small>小地图上画出了测距圈，换个位置再测一次就能定位！</small>`,
  r_hot4: '🔥 滚烫！！', r_hot3: '♨️ 很热！', r_hot2: '🌤 温热', r_hot1: '🧊 有点凉', r_hot0: '❄️ 冰冷',
  bike_on: (c) => `🚲 骑上单车（-${c}💰），速度大提升！随时按 B 还车`,
  bike_off: '🚲 已还车，步行继续～', bike_none: '🚲 附近没有单车站（看小地图上的橙色点）', bike_bus: '🚌 你在公交车上！', bike_first: '🚲 先按 B 还车再乘车',
  bus_on: (c) => `🚌 上车成功（-${c}💰），下一站按 E 下车`, bus_off: '🚌 你下车了', bus_wait: '🚌 车还在行驶，等到站再下车哦',
  bus_go: '🚌 公交发车了！到下一站按 <b>E</b> 下车', bus_arrive: '🚌 到站了，按 <b>E</b> 可以下车',
  transit_on: (icon, c, line) => `${icon} 上车成功（-${c}💰）<b>${line}</b> —— 到站按 E 下车`,
  transit_arrive: (n) => `🚉 到站：<b>${n}</b> —— 按 <kbd>E</kbd> 下车，或者坐过站`,
  transit_run: '🚇 行驶中不能下车，等到站！', transit_off: (n) => `🚶 你在 <b>${n}</b> 下车了`,
  taxi_busy: '🚌 你在车上，先下车！', taxi_done: (c) => `🚕 出租车把你送到了目的地（-${c}💰）`,
  cap_toast: (s, e, n, base, b) => `🎉 <b>${s}</b> 找到了 ${e} <b>${n}</b>！<br>基础 ${base}💰 + 悬赏 ${b}💰`,
  p_catch: (e, n) => `🫳 按 <kbd>E</kbd> 抓住 ${e} ${n}！`,
  p_bus_arr: '🚌 到站！按 <kbd>E</kbd> 下车', p_bus_run: '🚌 公交行驶中…',
  p_bus_board: (c) => `🚌 按 <kbd>E</kbd> 上公交（${c}💰）`,
  p_transit_arr: (n) => `🚉 <b>${n}</b> 到站！按 <kbd>E</kbd> 下车`,
  p_transit_run: (icon, line) => `${icon} ${line} 行驶中…`,
  p_transit_board: (icon, line, c) => `${icon} 按 <kbd>E</kbd> 乘坐 ${line}（${c}💰）`,
  p_bike: (c) => `🚲 按 <kbd>B</kbd> 租单车（${c}💰）`,
  p_rustle: '👀 好像有窸窸窣窣的声音……就在附近！',
  err_short: '线索太短啦，至少写 4 个字～', err_digits: '不可以带数字（会暴露坐标/门牌）！',
  err_banned: (w) => `不可以出现地点词「${w}」！换个说法试试～`,
  bounty_tag: (b) => `悬赏 ${b}💰`,
  av_btn: '👤 自定义形象', av_title: '👤 自定义你的形象', av_skin: '肤色', av_shirt: '上衣', av_pants: '裤子', av_hair: '发色', av_save: '✅ 保存', av_random: '🎲 随机',
  names: [['神秘的狐狸', '🦊'], ['机灵的猫咪', '🐱'], ['害羞的刺猬', '🦔'], ['淘气的浣熊', '🦝'], ['悄悄的兔子', '🐰'], ['沉默的松鼠', '🐿️'], ['狡猾的狸猫', '🐈'], ['飘忽的雪貂', '🦡']],
  area: { plaza: '广场一带', park: '绿地一带', pond: '水边一带', down: '高楼区', market: '热闹的老街', constr: '尘土飞扬处', res: '安静的住宅', london: '伦敦街头', shanghai: '上海街头', istanbul: '伊斯坦布尔街头' },
  colors: { 红: '红', 橙: '橙', 黄: '黄', 绿: '绿', 青: '青', 蓝: '蓝', 紫: '紫', 粉: '粉', 白: '白', 灰: '灰', 米白: '米白', 砖红: '砖红', 玻璃蓝: '玻璃蓝', 彩色: '彩色' },
  spots: {
    tower: '一座高塔脚下的背阴处', fountain: '水池边沿的外侧', reed: '一丛细长植物的中间',
    tree: '一棵大树的树干后面', bush: '一丛茂密灌木的内部', bench: '一张长椅的后面',
    pipe: '一个巨大圆管的内侧', crate: '一堆大木箱的后面', trash: '小巷里大箱子的后面',
    stall: '市集小摊的桌板后面', booth: '一个红色小亭子的背面', postbox: '一个红色圆筒的后面',
    bridge: '一座大桥的桥墩旁', abbey: '古老石墙的墙根处', eye: '巨大钢架支脚的后面',
    stpauls: '宏伟建筑的侧面立柱后', shard: '尖顶玻璃巨塔的墙角', gherkin: '圆滚滚玻璃楼旁的花坛',
    castle: '古老城墙的墙角', column: '高大纪念柱的基座后', palace: '金色围栏尽头的石墩后',
  },
  clues: {
    water: '我能听到近处传来的流水声', park: '空气里满是青草和泥土的味道', traffic: '不时有车辆从我身旁驶过',
    quiet: '我周围非常安静，几乎没有人声', shade: '阳光晒不到我，这里很阴凉', chime: '每隔一阵子，我能听到清脆的钟声',
    busStop: '偶尔能听到公交车到站的叮咚声', market: '我能闻到食物和香料的香气', dust: '空气里有灰尘和水泥的味道',
    tall: '抬头看，身旁的建筑遮住了大半个天空', low: '我附近的房子都不算高',
    bcolor: (c) => `离我最近的一栋建筑是${c}色的`,
    pipe: '我蜷缩在一个圆滚滚的东西里面', trash: '我旁边有一股淡淡的酸味，不太好闻', bush: '有叶子轻轻扎着我的后背',
    booth: '我躲在一个又高又窄的小空间旁边', bench: '我旁边有一个可以坐下歇脚的东西', reed: '细长的植物在我身边随风摇晃',
    bigbell: '每隔一阵子，我能听到浑厚悠扬的钟声', river: '我能听到河水拍岸的声音，还有海鸥的叫声',
    trains: '我能听到列车进站出站的轰鸣和广播声', tourists: '我周围游人如织，快门声此起彼伏',
    bridge: '我头顶上方是巨大的拱形结构，很阴凉', coffee: '空气里飘着咖啡和烘焙点心的香气',
    lawn: '我脚下是松软的草坪，空气很清新', waterfowl: '近处传来水鸟扑腾水面的声音',
  },
},
en: {
  sub: 'City-twin hide & seek · real-map 3D cities · n hide, m seek · clues + bounties + credits',
  mode_ai_h: '🤖 Quick Game', mode_ai_p: 'AI hiders hide across the city and post clues & bounties. You go find them!',
  mode_hot_h: '👥 Party Mode', mode_hot_p: 'Pass the keyboard: hiders fly to pick a spot, write a clue and set a bounty; seekers take turns.',
  cfg_hiders: 'Hiders n =', cfg_seekers: 'Seekers m =', cfg_diff: 'Difficulty', cfg_time: 'Time',
  diff: ['Easy', 'Normal', 'Hard'], times: ['5 min', '8 min', '12 min'],
  btn_start: 'S T A R T',
  help: '<kbd>W A S D</kbd> move · <kbd>Shift</kbd> run · drag mouse to look · <kbd>E</kbd> catch / board & alight<br><kbd>B</kbd> rent/return bike · <kbd>M</kbd> taxi map · <kbd>R</kbd> radar ping · <kbd>V</kbd> camera · <kbd>C</kbd> toggle clues',
  admin_label: '⚙️ Admin · world speed', admin_hint: 'People & vehicles move at n× real-world speed (default 3)',
  admin_val: (n) => `${n}× real`,
  city_town: '🏙 Random Town', city_town_sub: 'procedural', city_london_sub: 'real map data', city_soon: 'coming soon', city_wip: 'In development!',
  city_names: { london: 'London', istanbul: 'Istanbul', dubai: 'Dubai', shanghai: 'Shanghai', newyork: 'New York' },
  map_title: '🚕 Taxi Map', found_tag: ' ✅ found',
  hud_credits: 'credits', hud_time: 'time left', hud_found: 'found', hud_seeker: 'current seeker',
  panel_title: '🕵️ Hider Clues', mm_title: '🗺 Minimap', mm_min: 'Minimize', mm_restore: 'Restore', mm_close: 'Close', mm_open: 'Open minimap',
  ab_radar: '📡 Radar', ab_taxi: '🚕 Taxi', ab_bike: '🚲 Bike', ab_view: '🎥 View', ab_menu: '⏸ Menu',
  hide_banner: (i, n) => `🙈 Hider ${i}/${n} is picking a spot`,
  hide_help: 'WASD fly · <kbd>Space</kbd> up · <kbd>Z</kbd> down · drag to look · click a <span style="color:#22c1a3">cyan beacon</span> to choose your hiding spot',
  hide_turn: (i) => `🙈 Hider ${i}, you're up`, hide_turn_sub: 'Everyone else, look away! Fly around and pick a cyan beacon',
  clue_h2: '✍️ Publish your clue',
  clue_desc: (label, area) => `Your hiding spot: <b style="color:#ffd166">${label}</b> (${area})<br>Write a clue with <b>no location info</b> — no place names, directions or numbers.`,
  clue_chips: 'Click a hint chip to add it to your clue:',
  clue_ph: 'Write a clue that gives away no location, e.g. “I can hear running water, and there is a smell of fresh grass…”',
  clue_bounty: 'Bounty', clue_cancel: '↩ Pick again', clue_ok: '✅ Hidden!',
  map_hint: '🚕 Click anywhere on the map to take a taxi — est. fare ', map_close: 'Cancel (M)',
  pause_h: '⏸ Paused', pause_resume: 'Resume', pause_quit: 'Back to menu',
  end_again: '🔁 Play again', end_back: 'Back to menu',
  end_win: '🏆 Flawless victory!', end_lose: '⏰ Time is up!',
  end_win_sub: (b) => `All hiders found! Time bonus +${b}💰`,
  end_lose_sub: (n) => `${n} hider(s) were never found — they win this round`,
  th_hider: 'Hider', th_bounty: 'Bounty', th_result: 'Result', th_seeker: 'Seeker', th_caught: 'Caught', th_earned: 'Earned',
  found_by: (w) => `found by ${w}`, survived: 'stayed hidden 🎖', persons: (n) => `${n}`,
  end_total: (e, s, f) => `Earned <b class="teal">${e}💰</b> · spent <b class="redt">${s}💰</b> · final balance <b class="gold" style="font-size:20px">${f}💰</b>`,
  you: 'You', seeker_n: (i) => `Seeker ${i}`, hider_n: (i) => `Hider ${i}`,
  turn_first: (n) => `🧢 ${n} goes first`, turn_rotate: 'Seekers rotate every 75 seconds',
  turn_next: (n) => `🧢 ${n}'s turn`, turn_next_sub: 'Grab the keyboard!',
  seek_go: '🔎 The hunt begins!', seek_go_sub: 'Hiders, hand the keyboard to the seekers',
  toast_ai_ready: (n) => `🕵️ ${n} hiders are in place! Read the clues on the left and start hunting`,
  toast_hot_ready: '🕵️ All hiders are in place. Seekers, go!',
  no_credit: (n, w) => `💸 Not enough credits! ${w} costs ${n}💰`,
  w_radar: 'Radar', w_bike: 'Bike rental', w_bus: 'Bus ride', w_train: 'Metro ride', w_taxi: 'Taxi', w_ferry: 'Ferry ride',
  radar_none: '📡 No hiders left nearby',
  radar_result: (d, temp) => `📡 Nearest hider is about <b>${d} m</b> away — ${temp}<br><small>A range ring was drawn on the minimap. Ping from another spot to triangulate!</small>`,
  r_hot4: '🔥 Scorching!!', r_hot3: '♨️ Hot!', r_hot2: '🌤 Warm', r_hot1: '🧊 Cool', r_hot0: '❄️ Freezing',
  bike_on: (c) => `🚲 On the bike (-${c}💰). Much faster! Press B anytime to return it`,
  bike_off: '🚲 Bike returned. Back on foot~', bike_none: '🚲 No bike dock nearby (orange dots on the minimap)', bike_bus: '🚌 You are on a vehicle!', bike_first: '🚲 Return the bike (B) before boarding',
  bus_on: (c) => `🚌 Boarded (-${c}💰). Press E at the next stop to get off`, bus_off: '🚌 You got off', bus_wait: '🚌 Still moving — wait for the stop',
  bus_go: '🚌 Bus departing! Press <b>E</b> at the next stop to get off', bus_arrive: '🚌 Arrived. Press <b>E</b> to get off',
  transit_on: (icon, c, line) => `${icon} Boarded (-${c}💰) <b>${line}</b> — press E at a station to alight`,
  transit_arrive: (n) => `🚉 Arriving: <b>${n}</b> — press <kbd>E</kbd> to alight, or stay on`,
  transit_run: '🚇 Cannot alight while moving — wait for the station!', transit_off: (n) => `🚶 You got off at <b>${n}</b>`,
  taxi_busy: '🚌 You are on a vehicle — get off first!', taxi_done: (c) => `🚕 The taxi dropped you off (-${c}💰)`,
  cap_toast: (s, e, n, base, b) => `🎉 <b>${s}</b> caught ${e} <b>${n}</b>!<br>Base ${base}💰 + bounty ${b}💰`,
  p_catch: (e, n) => `🫳 Press <kbd>E</kbd> to catch ${e} ${n}!`,
  p_bus_arr: '🚌 At the stop! Press <kbd>E</kbd> to get off', p_bus_run: '🚌 Bus is moving…',
  p_bus_board: (c) => `🚌 Press <kbd>E</kbd> to board (${c}💰)`,
  p_transit_arr: (n) => `🚉 <b>${n}</b> — press <kbd>E</kbd> to alight`,
  p_transit_run: (icon, line) => `${icon} ${line} en route…`,
  p_transit_board: (icon, line, c) => `${icon} Press <kbd>E</kbd> to ride ${line} (${c}💰)`,
  p_bike: (c) => `🚲 Press <kbd>B</kbd> to rent a bike (${c}💰)`,
  p_rustle: '👀 You hear rustling… someone is close!',
  err_short: 'Too short — write at least 4 characters', err_digits: 'No digits allowed (they could reveal coordinates)!',
  err_banned: (w) => `The location word “${w}” is not allowed! Try another phrasing`,
  bounty_tag: (b) => `Bounty ${b}💰`,
  av_btn: '👤 Avatar', av_title: '👤 Customize your avatar', av_skin: 'Skin', av_shirt: 'Shirt', av_pants: 'Pants', av_hair: 'Hair', av_save: '✅ Save', av_random: '🎲 Random',
  names: [['Sly Fox', '🦊'], ['Clever Cat', '🐱'], ['Shy Hedgehog', '🦔'], ['Naughty Raccoon', '🦝'], ['Quiet Rabbit', '🐰'], ['Silent Squirrel', '🐿️'], ['Cunning Tanuki', '🐈'], ['Elusive Ferret', '🦡']],
  area: { plaza: 'near the plaza', park: 'among greenery', pond: 'by the water', down: 'downtown', market: 'the busy old street', constr: 'a dusty corner', res: 'a quiet neighbourhood', london: 'the streets of London', shanghai: 'the streets of Shanghai', istanbul: 'the streets of Istanbul' },
  colors: { 红: 'red', 橙: 'orange', 黄: 'yellow', 绿: 'green', 青: 'teal', 蓝: 'blue', 紫: 'purple', 粉: 'pink', 白: 'white', 灰: 'grey', 米白: 'cream', 砖红: 'brick-red', 玻璃蓝: 'glass-blue', 彩色: 'colourful' },
  spots: {
    tower: 'the shaded foot of a tall tower', fountain: 'the outer rim of a water basin', reed: 'among a clump of tall reeds',
    tree: 'behind the trunk of a big tree', bush: 'inside a dense bush', bench: 'behind a bench',
    pipe: 'inside a huge round pipe', crate: 'behind a stack of crates', trash: 'behind a big bin in a back alley',
    stall: 'behind a market stall', booth: 'behind a little red kiosk', postbox: 'behind a red pillar box',
    bridge: 'beside the pier of a big bridge', abbey: 'at the base of an ancient stone wall', eye: 'behind a giant steel support leg',
    stpauls: 'behind a column of a grand building', shard: 'at the corner of a glass spire', gherkin: 'by a rounded glass tower',
    castle: 'at the corner of ancient walls', column: 'behind the base of a tall column', palace: 'behind a plinth by golden railings',
  },
  clues: {
    water: 'I can hear running water nearby', park: 'The air is full of the smell of grass and earth', traffic: 'Cars keep passing right by me',
    quiet: 'It is very quiet around me, hardly any voices', shade: 'The sun cannot reach me — nice and shady', chime: 'Every so often I hear crisp bell chimes',
    busStop: 'Now and then I hear the ding of a bus arriving', market: 'I can smell food and spices', dust: 'The air tastes of dust and cement',
    tall: 'Looking up, the building beside me blocks half the sky', low: 'The buildings around me are all quite low',
    bcolor: (c) => `The nearest building to me is ${c}`,
    pipe: 'I am curled up inside something big and round', trash: 'There is a faint sour smell next to me', bush: 'Leaves keep tickling my back',
    booth: 'I am next to a tall, narrow little box', bench: 'There is something to sit on right beside me', reed: 'Tall thin plants sway around me',
    bigbell: 'Every so often I hear deep, resonant bell tolls', river: 'I can hear water lapping, and seagulls crying',
    trains: 'I hear the rumble and announcements of trains', tourists: 'Crowds bustle around me, camera shutters clicking',
    bridge: 'A huge arched structure looms right above me', coffee: 'The air smells of coffee and fresh pastries',
    lawn: 'Soft lawn under my feet, the air is fresh', waterfowl: 'I hear waterfowl splashing nearby',
  },
},
};
const t = (k, ...a) => {
  let s = I18N[LANG][k];
  if (s === undefined) s = I18N.zh[k];
  if (s === undefined) return k;
  return typeof s === 'function' ? s(...a) : s;
};
const tClue = (k, ...a) => {
  const d = I18N[LANG].clues[k] || I18N.zh.clues[k];
  return typeof d === 'function' ? d(...a) : d;
};
const tSpot = (k) => I18N[LANG].spots[k] || I18N.zh.spots[k] || k;
const tColor = (c) => I18N[LANG].colors[c] || c;

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
    if (!this.ctx || vol <= 0.002) return;
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

const COST = { bike: 8, bus: 5, taxiBase: 15, taxiPerM: 0.35, radar: 12, captureBase: 50, train: 6 };
// 基准速度按「现实 3 倍」手感标定；管理员可改倍速 n（SIM.mul），实际速度 = 基准 / 3 × n
const SPEED = { walk: 4.6, run: 8.2, bike: 11.5, bus: 12, fly: 42, flyFast: 90 };
const SIM = { mul: parseInt(localStorage.getItem('hs_simMul') || '3', 10) || 3 };
const simK = () => SIM.mul / 3;

/* ---------------- 多段线工具 ---------------- */
function buildPath(pts) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  }
  return { pts, cum, total: cum[cum.length - 1] };
}
function pathPoint(path, s) {
  const { pts, cum, total } = path;
  s = clamp(s, 0, total);
  let i = 1;
  while (i < cum.length - 1 && cum[i] < s) i++;
  const t = (s - cum[i - 1]) / Math.max(0.001, cum[i] - cum[i - 1]);
  const x = pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t;
  const z = pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t;
  const dx = pts[i][0] - pts[i - 1][0], dz = pts[i][1] - pts[i - 1][1];
  const len = Math.hypot(dx, dz) || 1;
  return { x, z, dx: dx / len, dz: dz / len };
}
function distToSeg(x, z, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const L2 = dx * dx + dz * dz;
  const t = L2 ? clamp(((x - ax) * dx + (z - az) * dz) / L2, 0, 1) : 0;
  const px2 = ax + dx * t, pz2 = az + dz * t;
  return { d: Math.hypot(x - px2, z - pz2), px: px2, pz: pz2 };
}
function distToPolyline(x, z, pts) {
  let best = { d: 1e9, px: 0, pz: 0 };
  for (let i = 1; i < pts.length; i++) {
    const r = distToSeg(x, z, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
    if (r.d < best.d) best = r;
  }
  return best;
}

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

const HIDER_NAMES = I18N[LANG].names;

/* 线索模板：key -> 文案（保证不含地点词，走 i18n 词典） */
const CLUE_TMPL = {};
['water', 'park', 'traffic', 'quiet', 'shade', 'chime', 'busStop', 'market', 'dust',
  'tall', 'low', 'bcolor', 'pipe', 'trash', 'bush', 'booth', 'bench', 'reed']
  .forEach((k) => { CLUE_TMPL[k] = (...a) => tClue(k, ...a); });

/* ---------------- 全局状态 ---------------- */
const G = {
  phase: 'menu',            // menu | hide | seek | end
  mode: 'ai',               // ai | hot
  citySel: 'town',          // town | london | ...
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


/* ---------------- 真实感程序化立面纹理 ---------------- */
function makeNoiseTexture(baseCss, dotAlpha, dotCount) {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 128;
  const x = c.getContext('2d');
  x.fillStyle = baseCss; x.fillRect(0, 0, 128, 128);
  for (let i = 0; i < dotCount; i++) {
    const l = rng() < 0.5;
    x.fillStyle = `rgba(${l ? '255,255,255' : '0,0,0'},${rng() * dotAlpha})`;
    x.fillRect(rng() * 128 | 0, rng() * 128 | 0, 1 + rng() * 2, 1 + rng() * 2);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.encoding = THREE.sRGBEncoding;
  return tex;
}

function makeFacadeTexture(style, floors, bays, litRatio) {
  const W = 128, H = 256;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const x = c.getContext('2d');
  const base = { brick: '#8a5a48', stone: '#cfc3a8', glass: '#8ba3b5', concrete: '#9b9b98' }[style] || '#9b9b98';
  x.fillStyle = base; x.fillRect(0, 0, W, H);

  if (style === 'brick') {
    for (let yy = 0; yy < H; yy += 6) { x.fillStyle = 'rgba(30,10,5,0.22)'; x.fillRect(0, yy, W, 1); }
    for (let yy = 0; yy < H; yy += 6) {
      for (let xx = (yy % 12 ? 0 : 8); xx < W; xx += 16) { x.fillStyle = 'rgba(30,10,5,0.18)'; x.fillRect(xx, yy, 1, 6); }
    }
    for (let i = 0; i < 150; i++) {
      x.fillStyle = `rgba(${rng() < 0.5 ? '255,235,220' : '60,25,15'},${0.04 + rng() * 0.07})`;
      x.fillRect((rng() * 8 | 0) * 16 + 1, (rng() * 42 | 0) * 6 + 1, 14, 5);
    }
  } else if (style === 'stone') {
    for (let yy = 20; yy < H; yy += 26) { x.fillStyle = 'rgba(80,70,50,0.28)'; x.fillRect(0, yy, W, 2); }
    for (let i = 0; i < 60; i++) {
      x.fillStyle = `rgba(${rng() < 0.5 ? '255,250,235' : '90,80,60'},${rng() * 0.06})`;
      x.fillRect(rng() * W | 0, rng() * H | 0, 10 + rng() * 20, 4 + rng() * 8);
    }
    x.fillStyle = 'rgba(70,60,45,0.35)'; x.fillRect(0, H - 30, W, 30); // 基座
  } else if (style === 'concrete') {
    for (let i = 0; i < 24; i++) {
      x.fillStyle = `rgba(60,60,58,${0.04 + rng() * 0.08})`;
      const sx = rng() * W | 0;
      x.fillRect(sx, 0, 1 + rng() * 3, H);
    }
    for (let i = 0; i < 30; i++) {
      x.fillStyle = `rgba(40,42,40,${rng() * 0.1})`;
      x.fillRect(rng() * W | 0, rng() * H | 0, 6 + rng() * 26, 3 + rng() * 14);
    }
  }

  if (style === 'glass') {
    // 玻璃幕墙：整面分格
    const cols = Math.max(3, bays * 2), rows = Math.max(4, floors);
    const cw = W / cols, rh = H / rows;
    for (let r = 0; r < rows; r++) for (let col = 0; col < cols; col++) {
      const grd = x.createLinearGradient(0, r * rh, 0, (r + 1) * rh);
      const bright = 0.75 + rng() * 0.5;
      if (rng() < litRatio * 0.4) { grd.addColorStop(0, '#ffe3b0'); grd.addColorStop(1, '#e8b878'); }
      else {
        grd.addColorStop(0, `rgba(${185 * bright | 0},${208 * bright | 0},${226 * bright | 0},1)`);
        grd.addColorStop(1, `rgba(${92 * bright | 0},${112 * bright | 0},${128 * bright | 0},1)`);
      }
      x.fillStyle = grd;
      x.fillRect(col * cw + 1, r * rh + 1, cw - 2, rh - 2);
    }
    for (let col = 0; col <= cols; col++) { x.fillStyle = 'rgba(235,240,245,0.5)'; x.fillRect(col * cw, 0, 1, H); }
  } else {
    // 窗洞：floors 排 × bays 列
    const mTop = 16, mBot = 14, mSide = 9;
    const gw = (W - mSide * 2) / bays, gh = (H - mTop - mBot) / floors;
    for (let r = 0; r < floors; r++) for (let col = 0; col < bays; col++) {
      const wx = mSide + col * gw + gw * 0.18, wy = mTop + r * gh + gh * 0.18;
      const ww = gw * 0.64, wh = gh * 0.6;
      x.fillStyle = '#23282e'; x.fillRect(wx - 1.5, wy - 1.5, ww + 3, wh + 3); // 窗框
      if (rng() < litRatio) {
        x.fillStyle = rng() < 0.5 ? '#ffdca4' : '#f2c37e';
        x.fillRect(wx, wy, ww, wh);
      } else {
        const grd = x.createLinearGradient(0, wy, 0, wy + wh);
        grd.addColorStop(0, '#b7cddd'); grd.addColorStop(1, '#57707f');
        x.fillStyle = grd; x.fillRect(wx, wy, ww, wh);
      }
      x.fillStyle = 'rgba(255,255,255,0.35)'; x.fillRect(wx - 2, wy + wh + 1.5, ww + 4, 2); // 窗台
    }
  }
  x.fillStyle = 'rgba(30,30,32,0.5)'; x.fillRect(0, 0, W, 5); // 檐口
  const tex = new THREE.CanvasTexture(c);
  tex.encoding = THREE.sRGBEncoding;
  tex.anisotropy = 4;
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
const TYPE_NAME = I18N[LANG].area;

function genCity() {
  const city = {
    kind: 'town',
    bounds: { minX: -HALF, maxX: HALF, minZ: -HALF, maxZ: HALF },
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
  city.spots.push({ x: tw.x - 4.6, z: tw.z - 4.6, prop: 'tower', label: tSpot('tower') });

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
  city.spots.push({ x: f.x + 6.6, z: f.z + 1, prop: 'fountain', label: tSpot('fountain') });
  city.spots.push({ x: f.x - 6.6, z: f.z - 1, prop: 'fountain', label: tSpot('fountain') });

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
      if (r === 2 || r === 6) city.spots.push({ x: px, z: pz, prop: 'reed', label: tSpot('reed') });
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
      city.spots.push({ x: tx + R(-1, 1) * 0.5 + 1.1, z: tz + 1.1, prop: 'tree', label: tSpot('tree') });
    });
    for (let b = 0; b < 3; b++) {
      const bx = cx + R(-13, 13), bz = cz + R(-13, 13);
      bushPlace.push({ x: bx, z: bz });
      if (b === 0) city.spots.push({ x: bx, z: bz, prop: 'bush', label: tSpot('bush') });
    }
    benchPlace.push({ x: cx + R(-12, 12), z: cz + R(-12, 12), rot: R(0, Math.PI * 2) });
    if (rng() < 0.5) {
      const bp = benchPlace[benchPlace.length - 1];
      city.spots.push({ x: bp.x + 0.2, z: bp.z + 1.2, prop: 'bench', label: tSpot('bench') });
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
    city.spots.push({ x: px, z: pz + 2.6, prop: 'pipe', label: tSpot('pipe') });
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
      city.spots.push({ x: px + s / 2 + 0.9, z: pz, prop: 'crate', label: tSpot('crate') });
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
    city.spots.push({ x: dx + 1.9, z: dz + 0.6, prop: 'trash', label: tSpot('trash') });
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
      if (s === 0) city.spots.push({ x: sx, z: sz - 1.9, prop: 'stall', label: tSpot('stall') });
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
    city.spots.push({ x: x + 1.6, z: z + 0.6, prop: 'booth', label: tSpot('booth') });
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

/* ---- 由藏点生成合法线索句子列表（按城市分发） ---- */
function spotHints(spot) {
  return G.city.kind === 'real' ? londonSpotHints(spot) : townSpotHints(spot);
}
function townSpotHints(spot) {
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
  if (a.bcolor) push('bcolor', CLUE_TMPL.bcolor(tColor(a.bcolor)));
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
  const joiner = LANG === 'zh' ? '；' : '; ';
  return chosen.map((h) => h.txt).join(joiner) + (LANG === 'zh' ? '。' : '.');
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
  if (t.length < 4) return t('err_short');
  if (/[0-9０-９]/.test(t)) return t('err_digits');
  const lower = t.toLowerCase();
  for (const w of BANNED_WORDS) {
    if (lower.includes(w.toLowerCase())) return t('err_banned', w);
  }
  if (G.city && G.city.bannedExtra) {
    for (const w of G.city.bannedExtra) {
      if (w.length >= 2 && lower.includes(w.toLowerCase())) return t('err_banned', w);
    }
  }
  return null;
}

/* ============================================================
 * 伦敦 —— 真实地图数据城市
 * 站点/线路: nicola/tubemaps (TfL 公开数据)；地理要素按真实经纬度描摹
 * ============================================================ */
const LONDON_CLUE_TMPL = {};
['bigbell', 'river', 'trains', 'tourists', 'bridge', 'coffee', 'lawn', 'waterfowl']
  .forEach((k) => { LONDON_CLUE_TMPL[k] = (...a) => tClue(k, ...a); });

/* 带状网格：沿多段线铺一条宽 w 的面 */
function ribbonMesh(pts, w, color, y = 0.05, opacity = 1) {
  const hw = w / 2;
  const verts = [], idx = [];
  let px = 0, pz = 0;
  for (let i = 0; i < pts.length; i++) {
    const prev = pts[Math.max(0, i - 1)], next = pts[Math.min(pts.length - 1, i + 1)];
    let dx = next[0] - prev[0], dz = next[1] - prev[1];
    const L = Math.hypot(dx, dz) || 1;
    dx /= L; dz /= L;
    px = -dz; pz = dx; // 法向
    verts.push(pts[i][0] + px * hw, y, pts[i][1] + pz * hw);
    verts.push(pts[i][0] - px * hw, y, pts[i][1] - pz * hw);
    if (i > 0) {
      const b = i * 2;
      idx.push(b - 2, b - 1, b, b - 1, b + 1, b);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mat = new THREE.MeshLambertMaterial({ color, transparent: opacity < 1, opacity });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  return mesh;
}

function makeTextSprite(text, bg = 'rgba(15,30,80,0.92)', fg = '#ffffff') {
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  ctx.font = '600 26px sans-serif';
  const tw = Math.ceil(ctx.measureText(text).width) + 26;
  c.width = tw; c.height = 44;
  const ctx2 = c.getContext('2d');
  ctx2.fillStyle = bg;
  ctx2.beginPath();
  ctx2.roundRect ? ctx2.roundRect(0, 0, tw, 44, 10) : ctx2.rect(0, 0, tw, 44);
  ctx2.fill();
  ctx2.font = '600 26px sans-serif';
  ctx2.fillStyle = fg;
  ctx2.textAlign = 'center'; ctx2.textBaseline = 'middle';
  ctx2.fillText(text, tw / 2, 23);
  const tex = new THREE.CanvasTexture(c);
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  spr.scale.set(tw / 44 * 2.6, 2.6, 1);
  return spr;
}

const LONDON_PAL = [
  ['米白', 0xd9cfb8], ['米白', 0xcfc4ae], ['米白', 0xe3dac6],
  ['砖红', 0x9c5a48], ['砖红', 0xa5654f], ['砖红', 0x8a5244],
  ['玻璃蓝', 0x6f9fc4], ['玻璃蓝', 0x7fb0d0], ['灰', 0x8898a8],
  ['彩', 0xd97b6c], ['彩', 0x6fc4c4], ['彩', 0xe6cf6f], ['彩', 0x83bf78],
];

function genRealCity(cityKey) {
  const D = window.CITY_DATA[cityKey];
  const B = D.bounds;
  const city = {
    kind: 'real',
    cityKey,
    bounds: B,
    name: D.name,
    buildings: [], aabbs: [], circles: [],
    trees: [], spots: [], bikeStations: [],
    stations: [], railLines: [], vehicles: [], cars: [], npcs: [], transitStops: [],
    pond: null, fountain: null, tower: null,
    river: { pts: D.river, halfW: D.riverWidth / 2 },
    bridgeCorridors: D.bridges.map((b) => ({ a: b.a, b: b.b, hw: b.foot ? 4 : 7 })),
    streets: D.streets,
    parks: D.parks,
    landmarks: D.landmarks,
    group: new THREE.Group(),
    orbitR: Math.round((B.maxX - B.minX) * 0.38), orbitH: Math.round((B.maxX - B.minX) * 0.2),
    spawn: null, flyMul: (B.maxX - B.minX) / 800, radarScale: Math.max(2, (B.maxX - B.minX) / 620), taxiPerM: 0.12,
    bannedExtra: [],
  };
  const g = city.group;
  const W = B.maxX - B.minX, H = B.maxZ - B.minZ;

  scene.fog = new THREE.Fog(scene.background, 200, 1200);
  camera.far = 2600; camera.updateProjectionMatrix();

  /* ---- 地面 ---- */
  const base = new THREE.Mesh(new THREE.PlaneGeometry(W + 700, H + 700), lambert(0x8fa878));
  base.rotation.x = -Math.PI / 2; base.position.y = -0.08; base.receiveShadow = true;
  g.add(base);
  const urbanTex = makeNoiseTexture('#94979d', 0.16, 900);
  urbanTex.repeat.set(90, 45);
  const urban = new THREE.Mesh(new THREE.PlaneGeometry(W, H), new THREE.MeshLambertMaterial({ map: urbanTex }));
  urban.rotation.x = -Math.PI / 2; urban.position.set((B.minX + B.maxX) / 2, -0.02, (B.minZ + B.maxZ) / 2);
  urban.receiveShadow = true;
  g.add(urban);

  /* ---- 泰晤士河 ---- */
  const riverBed = ribbonMesh(D.river, D.riverWidth + 5, 0xa89c80, 0.0);
  g.add(riverBed);
  const water = ribbonMesh(D.river, D.riverWidth, 0x2e6598, 0.05, 0.97);
  g.add(water);
  city.waterMesh = water;

  /* ---- 街道（含人行道） ---- */
  D.streets.forEach((st) => {
    g.add(ribbonMesh(st.pts, st.w + 7, 0xaeb1b5, 0.02));   // 人行道
    g.add(ribbonMesh(st.pts, st.w, 0x3e4147, 0.035));       // 沥青路面
    g.add(ribbonMesh(st.pts, 0.35, 0xd8dade, 0.06));        // 中线
  });

  /* ---- 云层 ---- */
  city.clouds = [];
  for (let i = 0; i < 9; i++) {
    const cl = new THREE.Group();
    const puffs = RI(3, 5);
    for (let p = 0; p < puffs; p++) {
      const puff = new THREE.Mesh(new THREE.SphereGeometry(R(9, 18), 8, 6),
        new THREE.MeshLambertMaterial({ color: 0xffffff, transparent: true, opacity: 0.82, fog: false }));
      puff.position.set(R(-18, 18), R(-3, 3), R(-9, 9));
      puff.scale.y = 0.45;
      cl.add(puff);
    }
    cl.position.set(R(B.minX, B.maxX), R(130, 190), R(B.minZ, B.maxZ));
    g.add(cl);
    city.clouds.push({ mesh: cl, vx: R(1.2, 2.6) });
  }

  /* ---- 桥梁 ---- */
  D.bridges.forEach((br) => {
    const pts = [br.a, br.b];
    const bw = br.foot ? 6 : 12;
    g.add(ribbonMesh(pts, bw, 0xb8b3a6, 1.4));
    g.add(ribbonMesh(pts, bw + 2.4, 0x8d887c, 0.9));
    // 塔桥双塔
    if (br.tower) {
      [0.33, 0.67].forEach((t) => {
        const x = br.a[0] + (br.b[0] - br.a[0]) * t;
        const z = br.a[1] + (br.b[1] - br.a[1]) * t;
        const tower = new THREE.Mesh(new THREE.BoxGeometry(7, 26, 7), lambert(0xd9cfb8));
        tower.position.set(x, 13, z); tower.castShadow = true; g.add(tower);
        const cap = new THREE.Mesh(new THREE.ConeGeometry(4.8, 6, 4), lambert(0x4a7f9f));
        cap.position.set(x, 29, z); cap.rotation.y = Math.PI / 4; g.add(cap);
        city.aabbs.push({ x1: x - 3.8, z1: z - 3.8, x2: x + 3.8, z2: z + 3.8 });
      });
      const dx = br.b[0] - br.a[0], dz = br.b[1] - br.a[1];
      for (const t of [0.5]) {
        const x = br.a[0] + dx * t, z = br.a[1] + dz * t;
        const walk = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.5, Math.hypot(dx, dz) * 0.34), lambert(0x4a7f9f));
        walk.position.set(x, 22, z);
        walk.rotation.y = Math.atan2(dx, dz);
        g.add(walk);
      }
    }
    // 桥下藏点（南岸端）
    if (!br.foot && rng() < 0.7) {
      const end = br.b[1] > br.a[1] ? br.b : br.a;
      city.spots.push({ x: end[0] + R(-3, 3), z: end[1] + 5, prop: 'bridge', label: tSpot('bridge') });
    }
  });

  /* ---- 公园 ---- */
  const treePlace = [];
  D.parks.forEach((pk) => {
    const grass = new THREE.Mesh(new THREE.CircleGeometry(1, 30), lambert(0x6faf68));
    grass.scale.set(pk.rx, pk.rz, 1);
    grass.rotation.x = -Math.PI / 2;
    grass.position.set(pk.p[0], 0.04, pk.p[1]);
    grass.receiveShadow = true;
    g.add(grass);
    const nTree = Math.round(pk.rx * pk.rz / 900);
    for (let t = 0; t < nTree; t++) {
      const a = R(0, Math.PI * 2), rr = Math.sqrt(rng());
      treePlace.push({ x: pk.p[0] + Math.cos(a) * pk.rx * rr * 0.9, z: pk.p[1] + Math.sin(a) * pk.rz * rr * 0.9, park: true, cone: rng() < 0.25 });
    }
    // 圣詹姆斯公园的湖
    if (pk.name === '圣詹姆斯公园') {
      const lake = new THREE.Mesh(new THREE.CircleGeometry(1, 30),
        new THREE.MeshLambertMaterial({ color: 0x4f97c9, transparent: true, opacity: 0.93 }));
      lake.scale.set(pk.rx * 0.62, pk.rz * 0.45, 1);
      lake.rotation.x = -Math.PI / 2;
      lake.position.set(pk.p[0], 0.09, pk.p[1]);
      g.add(lake);
      city.pond = { x: pk.p[0], z: pk.p[1], rx: pk.rx * 0.62, rz: pk.rz * 0.45 };
      city.circles.push({ x: pk.p[0], z: pk.p[1], r: Math.min(pk.rx * 0.62, pk.rz * 0.45) * 0.85 });
    }
    for (let b = 0; b < 3; b++) {
      const a = R(0, Math.PI * 2);
      const bx = pk.p[0] + Math.cos(a) * pk.rx * 0.7, bz = pk.p[1] + Math.sin(a) * pk.rz * 0.7;
      if (b === 0) city.spots.push({ x: bx, z: bz, prop: 'bench', label: tSpot('bench') });
    }
  });

  /* ---- 地标 ---- */
  city.clockHands = [];
  D.landmarks.forEach((lm) => buildLondonLandmark(city, g, lm));

  /* ---- 地铁 ---- */
  buildLondonTransit(city, g, D);

  /* ---- 建筑填充 ---- */
  buildLondonBuildings(city, g, D);

  /* ---- 街头道具 & 藏点 ---- */
  buildLondonProps(city, g, D, treePlace);

  /* ---- 树 ---- */
  buildLondonTrees(city, g, treePlace);

  /* ---- 环境车流（含黑色出租车） ---- */
  for (let i = 0; i < 10; i++) {
    const st = pick(D.streets.filter((s) => s.w > 8));
    const isCab = i < 3;
    const grp = new THREE.Group();
    const col = isCab ? 0x1a1c1f : pick([0xd96b6c, 0xe6cf6f, 0x6e8fd6, 0xefefe6, 0x9aa0a6]);
    const body = new THREE.Mesh(new THREE.BoxGeometry(3.2, 1.1, 1.6), lambert(col));
    body.position.y = 0.75; body.castShadow = true; grp.add(body);
    const cab = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.7, 1.5), lambert(isCab ? 0x2a2d31 : 0x274158));
    cab.position.set(0, 1.55, 0); grp.add(cab);
    g.add(grp);
    const path = buildPath(st.pts);
    city.cars.push({ mesh: grp, path, s: R(0, path.total), dir: rng() < 0.5 ? 1 : -1, speed: R(7, 12) });
  }

  /* ---- 藏点属性 ---- */
  londonComputeAttrs(city);

  /* ---- 好友模式违禁词（站名 + 地标名，数据驱动） ---- */
  city.bannedExtra = [...D.stations.map((s) => s.name.toLowerCase()), ...(D.banned || [])];

  city.spawn = D.spawn || { x: 0, z: 20, yaw: Math.PI };
  scene.add(g);
  return city;
}

/* ---- 地标模型 ---- */
function buildLondonLandmark(city, g, lm) {
  const [x, z] = lm.p;
  const stone = lambert(0xd9cfb8);
  const addBox = (w, h, d, cx, cy, cz, mat = stone, ry = 0) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(cx, cy, cz); m.rotation.y = ry;
    m.castShadow = m.receiveShadow = true;
    g.add(m);
    return m;
  };
  switch (lm.type) {
    case 'bigben': {
      addBox(7, 46, 7, x, 23, z, lambert(0xcfc0a0));
      const cap = new THREE.Mesh(new THREE.ConeGeometry(4.6, 9, 4), lambert(0x3f5a4f));
      cap.position.set(x, 50.5, z); cap.rotation.y = Math.PI / 4; cap.castShadow = true; g.add(cap);
      for (let f = 0; f < 4; f++) {
        const ang = f * Math.PI / 2;
        const face = new THREE.Mesh(new THREE.CircleGeometry(2.3, 24), new THREE.MeshBasicMaterial({ color: 0xfff6d8 }));
        face.position.set(x + Math.sin(ang) * 3.56, 40, z + Math.cos(ang) * 3.56);
        face.rotation.y = ang;
        g.add(face);
        const hand = new THREE.Mesh(new THREE.BoxGeometry(0.16, 1.7, 0.05), new THREE.MeshBasicMaterial({ color: 0x2a2a2a }));
        hand.geometry.translate(0, 0.75, 0);
        hand.position.copy(face.position).add(new THREE.Vector3(Math.sin(ang) * 0.06, 0, Math.cos(ang) * 0.06));
        hand.rotation.y = ang;
        g.add(hand);
        city.clockHands.push(hand);
      }
      city.aabbs.push({ x1: x - 3.8, z1: z - 3.8, x2: x + 3.8, z2: z + 3.8 });
      city.tower = { x, z };
      city.spots.push({ x: x - 5.2, z: z - 5.2, prop: 'tower', label: tSpot('tower') });
      break;
    }
    case 'parliament': {
      addBox(16, 14, 52, x, 7, z, lambert(0xd4c49e));
      addBox(10, 26, 10, x, 13, z + 30, lambert(0xcfc0a0));
      city.aabbs.push({ x1: x - 8.5, z1: z - 26.5, x2: x + 8.5, z2: z + 35.5 });
      break;
    }
    case 'abbey': {
      addBox(14, 12, 26, x, 6, z, lambert(0xd9cfb8));
      addBox(5, 22, 5, x - 4, 11, z - 15, lambert(0xe0d6c0));
      addBox(5, 22, 5, x + 4, 11, z - 15, lambert(0xe0d6c0));
      city.aabbs.push({ x1: x - 7.5, z1: z - 18, x2: x + 7.5, z2: z + 13.5 });
      city.spots.push({ x: x + 9, z: z + 10, prop: 'abbey', label: tSpot('abbey') });
      break;
    }
    case 'eye': {
      const wheel = new THREE.Group();
      const rim = new THREE.Mesh(new THREE.TorusGeometry(26, 0.9, 10, 44), lambert(0xe8ecf0));
      wheel.add(rim);
      for (let sp = 0; sp < 10; sp++) {
        const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.35, 51, 0.35), lambert(0xc8ced4));
        spoke.rotation.z = sp * Math.PI / 10;
        wheel.add(spoke);
      }
      for (let pod = 0; pod < 12; pod++) {
        const a = pod * Math.PI * 2 / 12;
        const p = new THREE.Mesh(new THREE.SphereGeometry(1.5, 8, 6), lambert(0x8fd0e8));
        p.position.set(Math.cos(a) * 26, Math.sin(a) * 26, 0);
        wheel.add(p);
      }
      wheel.position.set(x, 29, z);
      wheel.rotation.y = Math.PI / 2;
      wheel.traverse((o) => { o.castShadow = true; });
      g.add(wheel);
      city.eyeWheel = wheel;
      [-1, 1].forEach((s2) => {
        const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 1.1, 32, 8), lambert(0xc8ced4));
        leg.position.set(x, 15, z + s2 * 7);
        leg.rotation.x = s2 * 0.42;
        leg.castShadow = true;
        g.add(leg);
      });
      city.circles.push({ x, z, r: 4 });
      city.spots.push({ x: x + 4, z: z + 10, prop: 'eye', label: tSpot('eye') });
      break;
    }
    case 'stpauls': {
      addBox(20, 12, 34, x, 6, z, lambert(0xe3dac6));
      const drum = new THREE.Mesh(new THREE.CylinderGeometry(8, 8, 10, 20), lambert(0xd9cfb8));
      drum.position.set(x, 17, z); drum.castShadow = true; g.add(drum);
      const dome = new THREE.Mesh(new THREE.SphereGeometry(8, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2), lambert(0x6f8f7f));
      dome.position.set(x, 22, z); dome.castShadow = true; g.add(dome);
      const lantern = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.2, 5, 8), lambert(0xe3dac6));
      lantern.position.set(x, 32, z); g.add(lantern);
      city.aabbs.push({ x1: x - 10.5, z1: z - 17.5, x2: x + 10.5, z2: z + 17.5 });
      city.spots.push({ x: x - 12, z: z + 6, prop: 'stpauls', label: tSpot('stpauls') });
      break;
    }
    case 'shard': {
      const shard = new THREE.Mesh(new THREE.ConeGeometry(13, 100, 4), new THREE.MeshLambertMaterial({ color: 0x9fc4dc, transparent: true, opacity: 0.92 }));
      shard.position.set(x, 50, z);
      shard.rotation.y = Math.PI / 4;
      shard.castShadow = true;
      g.add(shard);
      city.aabbs.push({ x1: x - 8, z1: z - 8, x2: x + 8, z2: z + 8 });
      city.spots.push({ x: x + 10.5, z: z - 4, prop: 'shard', label: tSpot('shard') });
      break;
    }
    case 'gherkin': {
      const ghk = new THREE.Mesh(new THREE.SphereGeometry(9, 16, 14), new THREE.MeshLambertMaterial({ color: 0x7fae9a }));
      ghk.scale.set(1, 2.6, 1);
      ghk.position.set(x, 22, z);
      ghk.castShadow = true;
      g.add(ghk);
      city.circles.push({ x, z, r: 9.5 });
      city.spots.push({ x: x - 11, z: z + 3, prop: 'gherkin', label: tSpot('gherkin') });
      break;
    }
    case 'castle': {
      addBox(15, 13, 15, x, 6.5, z, lambert(0xe0d6bc));
      [[-8, -8], [8, -8], [-8, 8], [8, 8]].forEach(([ox, oz]) => {
        const tur = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.4, 17, 10), lambert(0xd4c8a8));
        tur.position.set(x + ox, 8.5, z + oz); tur.castShadow = true; g.add(tur);
        const cap = new THREE.Mesh(new THREE.ConeGeometry(2.6, 3.4, 10), lambert(0x8a8f96));
        cap.position.set(x + ox, 18.5, z + oz); g.add(cap);
      });
      addBox(26, 4.5, 1.6, x, 2.25, z - 12, lambert(0xcfc4a4));
      addBox(26, 4.5, 1.6, x, 2.25, z + 12, lambert(0xcfc4a4));
      addBox(1.6, 4.5, 26, x - 12, 2.25, z, lambert(0xcfc4a4));
      addBox(1.6, 4.5, 26, x + 12, 2.25, z, lambert(0xcfc4a4));
      city.aabbs.push({ x1: x - 8.5, z1: z - 8.5, x2: x + 8.5, z2: z + 8.5 });
      city.spots.push({ x: x - 13.8, z: z - 13.8, prop: 'castle', label: tSpot('castle') });
      break;
    }
    case 'column': {
      const col = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 1.6, 30, 12), lambert(0xc8bda0));
      col.position.set(x, 16, z); col.castShadow = true; g.add(col);
      addBox(5, 2, 5, x, 1, z, lambert(0xb8ad92));
      const figure = new THREE.Mesh(new THREE.BoxGeometry(1, 2.4, 1), lambert(0x5a5f66));
      figure.position.set(x, 32.2, z); g.add(figure);
      // 喷泉
      const f = { x: x + 12, z: z + 4 };
      city.fountain = f;
      const basin = new THREE.Mesh(new THREE.CylinderGeometry(4.2, 4.5, 1, 20), lambert(0xbfb6a2));
      basin.position.set(f.x, 0.5, f.z); g.add(basin);
      const fw = new THREE.Mesh(new THREE.CylinderGeometry(3.6, 3.6, 0.3, 20),
        new THREE.MeshLambertMaterial({ color: 0x4fa8e8, transparent: true, opacity: 0.85 }));
      fw.position.set(f.x, 0.92, f.z); g.add(fw);
      city.circles.push({ x: f.x, z: f.z, r: 4.6 });
      city.circles.push({ x, z, r: 3 });
      city.spots.push({ x: x - 4.5, z: z - 4.5, prop: 'column', label: tSpot('column') });
      break;
    }
    case 'palace': {
      addBox(30, 12, 12, x, 6, z, lambert(0xe0d6c0));
      addBox(32, 1.2, 13, x, 12.6, z, lambert(0xcfc4ae));
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 8, 6), lambert(0x8a8f96));
      pole.position.set(x, 17, z); g.add(pole);
      const flag = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 1.4), new THREE.MeshBasicMaterial({ color: 0xc0281c, side: THREE.DoubleSide }));
      flag.position.set(x + 1.2, 19.6, z); g.add(flag);
      city.aabbs.push({ x1: x - 15.5, z1: z - 6.5, x2: x + 15.5, z2: z + 6.5 });
      city.spots.push({ x: x + 17.5, z: z + 4, prop: 'palace', label: tSpot('palace') });
      break;
    }
    case 'customhouse': {  // 外滩海关大楼：石材楼 + 大钟（整点钟声）
      addBox(14, 20, 22, x, 10, z, lambert(0xcfc3a8));
      addBox(7, 22, 7, x, 31, z, lambert(0xd9cfb8));
      const cap2 = new THREE.Mesh(new THREE.ConeGeometry(4.6, 5, 4), lambert(0x3f5a4f));
      cap2.position.set(x, 44.5, z); cap2.rotation.y = Math.PI / 4; cap2.castShadow = true; g.add(cap2);
      for (let f = 0; f < 4; f++) {
        const ang = f * Math.PI / 2;
        const face = new THREE.Mesh(new THREE.CircleGeometry(2.1, 24), new THREE.MeshBasicMaterial({ color: 0xfff6d8 }));
        face.position.set(x + Math.sin(ang) * 3.56, 38, z + Math.cos(ang) * 3.56);
        face.rotation.y = ang;
        g.add(face);
        const hand = new THREE.Mesh(new THREE.BoxGeometry(0.15, 1.5, 0.05), new THREE.MeshBasicMaterial({ color: 0x2a2a2a }));
        hand.geometry.translate(0, 0.65, 0);
        hand.position.copy(face.position);
        hand.rotation.y = ang;
        g.add(hand);
        city.clockHands.push(hand);
      }
      city.aabbs.push({ x1: x - 7.5, z1: z - 11.5, x2: x + 7.5, z2: z + 11.5 });
      city.tower = { x, z };
      city.spots.push({ x: x - 8.6, z: z - 12.6, prop: 'tower', label: tSpot('tower') });
      break;
    }
    case 'pearltower': {   // 三球塔
      [[-4.5, 0], [2.25, 3.9], [2.25, -3.9]].forEach(([ox, oz]) => {
        const leg = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.4, 40, 8), lambert(0xb8bcc2));
        leg.position.set(x + ox * 0.8, 20, z + oz * 0.8);
        leg.rotation.z = ox > 0 ? -0.06 : 0.12;
        leg.castShadow = true; g.add(leg);
      });
      const shaft2 = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.6, 70, 10), lambert(0xc4c9cf));
      shaft2.position.set(x, 55, z); shaft2.castShadow = true; g.add(shaft2);
      const ball1 = new THREE.Mesh(new THREE.SphereGeometry(9, 16, 12), new THREE.MeshLambertMaterial({ color: 0xc45a7a }));
      ball1.position.set(x, 42, z); ball1.castShadow = true; g.add(ball1);
      const ball2 = new THREE.Mesh(new THREE.SphereGeometry(5.5, 14, 10), new THREE.MeshLambertMaterial({ color: 0xd06a88 }));
      ball2.position.set(x, 80, z); ball2.castShadow = true; g.add(ball2);
      const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.7, 26, 6), lambert(0x9aa0a6));
      ant.position.set(x, 100, z); g.add(ant);
      city.circles.push({ x, z, r: 7 });
      city.spots.push({ x: x + 8.5, z: z + 5, prop: 'eye', label: tSpot('eye') });
      break;
    }
    case 'twisttower': {   // 螺旋巨塔（最高）
      const tw2 = new THREE.Mesh(new THREE.CylinderGeometry(7.5, 12.5, 145, 12), new THREE.MeshLambertMaterial({ color: 0x9fc4dc, transparent: true, opacity: 0.94 }));
      tw2.position.set(x, 72.5, z); tw2.castShadow = true; g.add(tw2);
      const fin = new THREE.Mesh(new THREE.BoxGeometry(2, 145, 6), new THREE.MeshLambertMaterial({ color: 0x8ab4cc }));
      fin.position.set(x + 8, 72.5, z); fin.rotation.y = 0.5; g.add(fin);
      city.circles.push({ x, z, r: 13 });
      city.spots.push({ x: x - 14.5, z: z + 4, prop: 'shard', label: tSpot('shard') });
      break;
    }
    case 'jinmao': {       // 宝塔式退台塔
      let hh = 0;
      [[16, 40], [13, 30], [10, 22], [7.5, 16], [5, 12]].forEach(([ww, sh]) => {
        addBox(ww, sh, ww, x, hh + sh / 2, z, lambert(0xb0b8c4));
        hh += sh;
      });
      const spire = new THREE.Mesh(new THREE.ConeGeometry(2, 14, 8), lambert(0x9aa0a6));
      spire.position.set(x, hh + 7, z); spire.castShadow = true; g.add(spire);
      city.aabbs.push({ x1: x - 8.5, z1: z - 8.5, x2: x + 8.5, z2: z + 8.5 });
      break;
    }
    case 'wfc': {          // 开瓶器：方塔 + 顶部门洞
      addBox(15, 100, 9, x, 50, z, new THREE.MeshLambertMaterial({ color: 0x8898a8 }));
      addBox(15, 6, 9.2, x, 106, z, lambert(0x7f8ba0));
      addBox(3.5, 22, 9.2, x - 5.75, 92, z, lambert(0x7f8ba0));
      addBox(3.5, 22, 9.2, x + 5.75, 92, z, lambert(0x7f8ba0));
      city.aabbs.push({ x1: x - 8, z1: z - 5, x2: x + 8, z2: z + 5 });
      break;
    }
    case 'mosque': {       // 大圆顶 + 四座宣礼塔
      addBox(20, 12, 20, x, 6, z, lambert(0xd4c8a8));
      const dome2 = new THREE.Mesh(new THREE.SphereGeometry(9, 18, 12, 0, Math.PI * 2, 0, Math.PI / 2), lambert(0x7a8a94));
      dome2.position.set(x, 12, z); dome2.castShadow = true; g.add(dome2);
      [[-12, -12], [12, -12], [-12, 12], [12, 12]].forEach(([ox, oz]) => {
        const mn = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.1, 26, 8), lambert(0xe0d6c0));
        mn.position.set(x + ox, 13, z + oz); mn.castShadow = true; g.add(mn);
        const cp = new THREE.Mesh(new THREE.ConeGeometry(1.3, 3.6, 8), lambert(0x8a8f96));
        cp.position.set(x + ox, 27.8, z + oz); g.add(cp);
      });
      city.aabbs.push({ x1: x - 10.5, z1: z - 10.5, x2: x + 10.5, z2: z + 10.5 });
      city.spots.push({ x: x + 12.2, z: z - 12.2, prop: 'abbey', label: tSpot('abbey') });
      break;
    }
    case 'galata': {       // 石砌圆塔
      const gt = new THREE.Mesh(new THREE.CylinderGeometry(4.2, 4.8, 30, 14), lambert(0xc9bda0));
      gt.position.set(x, 15, z); gt.castShadow = true; g.add(gt);
      const ring2 = new THREE.Mesh(new THREE.CylinderGeometry(5.2, 5.2, 2.4, 14), lambert(0xb8ac90));
      ring2.position.set(x, 29, z); g.add(ring2);
      const cone2 = new THREE.Mesh(new THREE.ConeGeometry(4.6, 7, 14), lambert(0x5f6f7a));
      cone2.position.set(x, 34, z); cone2.castShadow = true; g.add(cone2);
      city.circles.push({ x, z, r: 5.2 });
      city.spots.push({ x: x + 6, z: z + 3, prop: 'tower', label: tSpot('tower') });
      break;
    }
    case 'pavilion': {     // 古典园林亭子（翘檐）
      [[-1.6, -1.6], [1.6, -1.6], [-1.6, 1.6], [1.6, 1.6]].forEach(([ox, oz]) => {
        const col = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 3.2, 8), lambert(0x8a2018));
        col.position.set(x + ox, 1.6, z + oz); col.castShadow = true; g.add(col);
      });
      const roof1 = new THREE.Mesh(new THREE.ConeGeometry(4.2, 1.8, 4), lambert(0x4a5a3a));
      roof1.position.set(x, 4.1, z); roof1.rotation.y = Math.PI / 4; roof1.scale.y = 0.75; roof1.castShadow = true; g.add(roof1);
      const roof2 = new THREE.Mesh(new THREE.ConeGeometry(2.6, 1.4, 4), lambert(0x55663f));
      roof2.position.set(x, 5.2, z); roof2.rotation.y = Math.PI / 4; g.add(roof2);
      city.spots.push({ x: x + 3.4, z: z + 3.4, prop: 'bench', label: tSpot('bench') });
      break;
    }
  }
}

/* ---- 地铁网络 + 交通工具 ---- */
function buildLondonTransit(city, g, D) {
  const stById = new Map();
  D.stations.forEach((s) => stById.set(s.id, s));

  D.lines.forEach((ln) => {
    const pts = ln.stations.map((id) => stById.get(id).p);
    if (ln.loop) pts.push(pts[0]);
    const path = buildPath(pts);
    const color = new THREE.Color(ln.color);
    g.add(ribbonMesh(pts, 3.4, 0x3a3d42, 0.07));
    g.add(ribbonMesh(pts, 0.9, color.getHex(), 0.12));
    city.railLines.push({ name: ln.name, color: ln.color, pts, path });

    // 站点参数位置
    const stops = ln.stations.map((id, idx) => {
      const st = stById.get(id);
      return { s: path.cum[idx], x: st.p[0], z: st.p[1], name: st.name, id };
    });

    // 列车：按线路长度决定数量
    const nTrains = path.total > 520 ? 2 : 1;
    for (let tI = 0; tI < nTrains; tI++) {
      const train = new THREE.Group();
      const cars = [];
      for (let cI = 0; cI < 3; cI++) {
        const car = new THREE.Group();
        const body = new THREE.Mesh(new THREE.BoxGeometry(5.4, 2.3, 2.3), lambert(0xe8eaec));
        body.position.y = 1.5; body.castShadow = true; car.add(body);
        const stripe = new THREE.Mesh(new THREE.BoxGeometry(5.42, 0.55, 2.32), new THREE.MeshLambertMaterial({ color: color.getHex() }));
        stripe.position.y = 1.15; car.add(stripe);
        const win = new THREE.Mesh(new THREE.BoxGeometry(5.44, 0.6, 2.28), lambert(0x2a3540));
        win.position.y = 2.05; car.add(win);
        train.add(car);
        cars.push(car);
      }
      g.add(train);
      city.vehicles.push({
        kind: 'train', line: ln.name, color: ln.color, mesh: train, cars,
        path, loop: !!ln.loop, stops,
        s: (path.total / nTrains) * tI, dir: 1, speed: 0,
        maxSpeed: 34, accel: 9, state: 'run', dwell: 0, curStop: null, riding: false,
        cost: COST.train,
      });
    }
  });

  // 站台 + 站名牌 + 候车 NPC 点
  const seen = new Set();
  city.railLines.forEach((ln) => {
    ln.pts.forEach(() => {});
  });
  D.stations.forEach((st) => {
    if (seen.has(st.id)) return;
    seen.add(st.id);
    const [x, z] = st.p;
    const plat = new THREE.Mesh(new THREE.BoxGeometry(11, 0.55, 3.2), lambert(0xcfd3d8));
    plat.position.set(x, 0.28, z + 3.4);
    plat.receiveShadow = true;
    g.add(plat);
    // 地铁圆标（roundel）
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1.05, 0.3, 8, 20), lambert(0xdc241f));
    ring.position.set(x + 4.6, 4.2, z + 3.4);
    g.add(ring);
    const bar = new THREE.Mesh(new THREE.BoxGeometry(2.9, 0.55, 0.18), lambert(0x0019a8));
    bar.position.set(x + 4.6, 4.2, z + 3.4);
    g.add(bar);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 4.2, 6), lambert(0x54585e));
    pole.position.set(x + 4.6, 2.1, z + 3.4);
    g.add(pole);
    const label = makeTextSprite(st.name);
    label.position.set(x, 7.6, z + 3.4);
    g.add(label);
    city.stations.push({ id: st.id, x, z, name: st.name });
    city.transitStops.push({ x, z: z + 3.4, kind: 'train', waiters: [], respawn: R(2, 14) });
  });

  /* ---- 红色双层巴士 ---- */
  D.busRoutes.forEach((rt) => {
    const path = buildPath(rt.pts);
    // 每 ~110m 一个站
    const stops = [];
    for (let s = 55; s < path.total - 30; s += 110) {
      const p = pathPoint(path, s);
      stops.push({ s, x: p.x, z: p.z, name: rt.name + ' 站' });
      const sign = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 3.2, 6), lambert(0x54585e));
      sign.position.set(p.x - p.dz * 4, 1.6, p.z + p.dx * 4);
      g.add(sign);
      const flag2 = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.6, 0.08), lambert(0xc0281c));
      flag2.position.set(p.x - p.dz * 4, 3.1, p.z + p.dx * 4);
      g.add(flag2);
      city.transitStops.push({ x: p.x - p.dz * 4, z: p.z + p.dx * 4, kind: 'bus', waiters: [], respawn: R(4, 20) });
    }
    for (let bI = 0; bI < 2; bI++) {
      const bus = new THREE.Group();
      const body = new THREE.Mesh(new THREE.BoxGeometry(6.6, 3.9, 2.4), lambert(0xc0281c));
      body.position.y = 2.5; body.castShadow = true; bus.add(body);
      const win1 = new THREE.Mesh(new THREE.BoxGeometry(6.62, 0.65, 2.42), lambert(0x33261f));
      win1.position.y = 1.9; bus.add(win1);
      const win2 = win1.clone(); win2.position.y = 3.6; bus.add(win2);
      for (let w = 0; w < 4; w++) {
        const wh = new THREE.Mesh(new THREE.CylinderGeometry(0.52, 0.52, 0.4, 10), lambert(0x222428));
        wh.rotation.x = Math.PI / 2;
        wh.position.set(-2 + (w % 2) * 4, 0.52, w < 2 ? -1.1 : 1.1);
        bus.add(wh);
      }
      g.add(bus);
      city.vehicles.push({
        kind: 'bus', line: rt.name, color: rt.color, mesh: bus, cars: null,
        path, loop: false, stops,
        s: path.total * (0.15 + bI * 0.5), dir: bI ? -1 : 1, speed: 0,
        maxSpeed: 13, accel: 5, state: 'run', dwell: 0, curStop: null, riding: false,
        cost: COST.bus,
      });
    }
  });

  /* ---- 轮渡（跨江水上交通） ---- */
  (D.ferries || []).forEach((f) => {
    const path = buildPath([f.a, f.b]);
    const stops = [
      { s: 0, x: f.a[0], z: f.a[1], name: f.name },
      { s: path.total, x: f.b[0], z: f.b[1], name: f.name },
    ];
    // 渡口栈桥
    [f.a, f.b].forEach((pt) => {
      const pier = new THREE.Mesh(new THREE.BoxGeometry(6, 0.8, 10), lambert(0x8a7f6e));
      pier.position.set(pt[0], 0.4, pt[1]); pier.castShadow = true; g.add(pier);
      city.transitStops.push({ x: pt[0], z: pt[1], kind: 'ferry', waiters: [], respawn: R(6, 20) });
    });
    const boat = new THREE.Group();
    const hull = new THREE.Mesh(new THREE.BoxGeometry(9, 1.6, 4), lambert(0xf0f0ea));
    hull.position.y = 0.9; hull.castShadow = true; boat.add(hull);
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(6, 1.6, 3), lambert(0x2f6f8f));
    cabin.position.y = 2.4; boat.add(cabin);
    const stack = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.36, 1.6, 8), lambert(0xc0281c));
    stack.position.set(-2, 3.6, 0); boat.add(stack);
    g.add(boat);
    city.vehicles.push({
      kind: 'ferry', line: f.name, color: '#e8f0f5', mesh: boat, cars: null,
      path, loop: false, stops,
      s: 0, dir: 1, speed: 0,
      maxSpeed: 8, accel: 2.5, state: 'dwell', dwell: 5, curStop: stops[0], riding: false,
      cost: 2,
    });
  });
}

/* ---- 建筑填充（避开路/河/园/轨/地标） ---- */
function buildLondonBuildings(city, g, D) {
  const B = city.bounds;
  const towerPlaces = [], lowPlaces = [];
  const step = 30;
  for (let x = B.minX + 14; x < B.maxX - 14; x += step) {
    for (let z = B.minZ + 14; z < B.maxZ - 14; z += step) {
      const jx = x + R(-7, 7), jz = z + R(-7, 7);
      if (rng() < 0.22) continue;
      if (distToPolyline(jx, jz, D.river).d < city.river.halfW + 16) continue;
      let bad = false;
      for (const st of D.streets) { if (distToPolyline(jx, jz, st.pts).d < st.w / 2 + 7) { bad = true; break; } }
      if (bad) continue;
      for (const pk of D.parks) {
        const dx = (jx - pk.p[0]) / (pk.rx + 10), dz = (jz - pk.p[1]) / (pk.rz + 10);
        if (dx * dx + dz * dz < 1) { bad = true; break; }
      }
      if (bad) continue;
      for (const ln of city.railLines) { if (distToPolyline(jx, jz, ln.pts).d < 9) { bad = true; break; } }
      if (bad) continue;
      for (const lm of D.landmarks) { if (dist2d(jx, jz, lm.p[0], lm.p[1]) < 38) { bad = true; break; } }
      if (bad) continue;
      for (const st of city.stations) { if (dist2d(jx, jz, st.x, st.z) < 17) { bad = true; break; } }
      if (bad) continue;
      for (const br of city.bridgeCorridors) { if (distToSeg(jx, jz, br.a[0], br.a[1], br.b[0], br.b[1]).d < 14) { bad = true; break; } }
      if (bad) continue;

      // 分区风格（数据驱动：先匹配的分区生效）
      const w = R(13, 21), d = R(13, 21);
      const zone = (D.zones || []).find((zn) => {
        const x1 = Math.min(zn.r[0], zn.r[2]), x2 = Math.max(zn.r[0], zn.r[2]);
        const z1 = Math.min(zn.r[1], zn.r[3]), z2 = Math.max(zn.r[1], zn.r[3]);
        return jx >= x1 && jx <= x2 && jz >= z1 && jz <= z2;
      }) || D.zoneDefault;
      let h = R(zone.h[0], zone.h[1]);
      if (zone.tall && rng() < zone.tall.c) h = R(zone.tall.h[0], zone.tall.h[1]);
      const pal = zone.pal;
      const colorName = pick(pal);
      const options = LONDON_PAL.filter((p) => p[0] === colorName);
      const colorHex = pick(options)[1];
      (h > 40 ? towerPlaces : lowPlaces).push({ x: jx, z: jz, w, d, h, colorHex, styleName: colorName });
      city.buildings.push({ x: jx, z: jz, w, d, h, colorName: colorName === '彩' ? '彩色' : colorName });
      city.aabbs.push({ x1: jx - w / 2, z1: jz - d / 2, x2: jx + w / 2, z2: jz + d / 2 });
    }
  }
  // 按"立面风格 × 高度档"分桶 InstancedMesh，每桶一张真实感立面纹理
  const styleOf = { 玻璃蓝: 'glass', 灰: 'concrete', 米白: 'stone', 砖红: 'brick', 彩: 'brick' };
  const buckets = {};
  lowPlaces.concat(towerPlaces).forEach((p) => {
    const style = styleOf[p.styleName] || 'stone';
    const size = p.h >= 40 ? 'tall' : p.h >= 18 ? 'mid' : 'low';
    const key = style + '_' + size;
    (buckets[key] = buckets[key] || { style, size, places: [] }).places.push(p);
  });
  const roofMat = new THREE.MeshLambertMaterial({ color: 0x3c3f43 });
  Object.values(buckets).forEach((b) => {
    const avgH = b.places.reduce((s2, p) => s2 + p.h, 0) / b.places.length;
    const floors = clamp(Math.round(avgH / 3.1), 2, 26);
    const bays = b.size === 'low' ? 3 : 4;
    const lit = b.style === 'glass' ? 0.25 : 0.18;
    const wallMat = new THREE.MeshLambertMaterial({ color: 0xffffff, map: makeFacadeTexture(b.style, floors, bays, lit) });
    const geo = new THREE.BoxGeometry(1, 1, 1);
    geo.translate(0, 0.5, 0);
    const inst = new THREE.InstancedMesh(geo, [wallMat, wallMat, roofMat, roofMat, wallMat, wallMat], b.places.length);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion();
    const tint = new THREE.Color();
    b.places.forEach((p, i) => {
      m4.compose(new THREE.Vector3(p.x, 0, p.z), q, new THREE.Vector3(p.w, p.h, p.d));
      inst.setMatrixAt(i, m4);
      // 轻微色相/明度抖动，避免同桶建筑一模一样
      tint.setHex(p.colorHex).lerp(new THREE.Color(0xffffff), 0.72).offsetHSL(0, 0, R(-0.05, 0.05));
      inst.setColorAt(i, tint);
    });
    inst.castShadow = inst.receiveShadow = true;
    g.add(inst);
  });
}

/* ---- 街头道具 & 藏点 ---- */
function buildLondonProps(city, g, D, treePlace) {
  const alongStreet = (st, t, side = 1) => {
    const path = buildPath(st.pts);
    const p = pathPoint(path, path.total * t);
    return { x: p.x - p.dz * (st.w / 2 + 2.5) * side, z: p.z + p.dx * (st.w / 2 + 2.5) * side, p };
  };
  // 红色电话亭 ×6
  for (let i = 0; i < 6; i++) {
    const st = pick(D.streets);
    const pos = alongStreet(st, R(0.12, 0.88), pick([-1, 1]));
    const booth = new THREE.Mesh(new THREE.BoxGeometry(1.5, 3, 1.5), lambert(D.boothColor || 0xc0281c));
    booth.position.set(pos.x, 1.56, pos.z); booth.castShadow = true; g.add(booth);
    const glass = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.5, 1.52), new THREE.MeshLambertMaterial({ color: 0xbfe3f5, transparent: true, opacity: 0.55 }));
    glass.position.set(pos.x, 1.8, pos.z); g.add(glass);
    city.aabbs.push({ x1: pos.x - 0.85, z1: pos.z - 0.85, x2: pos.x + 0.85, z2: pos.z + 0.85 });
    if (i % 2 === 0) city.spots.push({ x: pos.x + 1.7, z: pos.z + 0.5, prop: 'booth', label: tSpot('booth') });
  }
  // 红色邮筒 ×6（伦敦特色）
  for (let i = 0; i < (D.postbox ? 6 : 0); i++) {
    const st = pick(D.streets);
    const pos = alongStreet(st, R(0.1, 0.9), pick([-1, 1]));
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 1.5, 10), lambert(0xc0281c));
    post.position.set(pos.x, 0.75, pos.z); post.castShadow = true; g.add(post);
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.44, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), lambert(0xa02318));
    cap.position.set(pos.x, 1.5, pos.z); g.add(cap);
    if (i % 2 === 0) city.spots.push({ x: pos.x + 1.1, z: pos.z + 0.6, prop: 'postbox', label: tSpot('postbox') });
  }
  // 垃圾箱小巷 ×5
  for (let i = 0; i < 5; i++) {
    const b = pick(city.buildings.filter((bb) => bb.h < 30));
    if (!b) break;
    const dx2 = b.x + b.w / 2 + 1.6, dz2 = b.z + R(-3, 3);
    const dump = new THREE.Mesh(new THREE.BoxGeometry(2.1, 1.4, 1.2), lambert(pick([0x3f7f5f, 0x4a6fa5])));
    dump.position.set(dx2, 0.7, dz2); dump.castShadow = true; g.add(dump);
    city.aabbs.push({ x1: dx2 - 1.2, z1: dz2 - 0.8, x2: dx2 + 1.2, z2: dz2 + 0.8 });
    city.spots.push({ x: dx2 + 1.9, z: dz2 + 0.5, prop: 'trash', label: tSpot('trash') });
  }
  // 市集摊位 ×3（坐标来自城市数据）
  const mkX = D.market[0], mkZ = D.market[1];
  city.market = { x: mkX, z: mkZ };
  for (let i = 0; i < 3; i++) {
    const sx = mkX + R(-14, 14), sz = mkZ + R(-10, 10);
    const stall = new THREE.Group();
    const table = new THREE.Mesh(new THREE.BoxGeometry(3, 1, 1.6), lambert(0x9c7040));
    table.position.y = 0.5; stall.add(table);
    const roof = new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.18, 2.2), lambert(pick([0xc0281c, 0xe6cf6f, 0x22c1a3])));
    roof.position.y = 2.3; stall.add(roof);
    stall.position.set(sx, 0.05, sz);
    stall.traverse((o) => { o.castShadow = true; });
    g.add(stall);
    city.aabbs.push({ x1: sx - 1.7, z1: sz - 1, x2: sx + 1.7, z2: sz + 1 });
    if (i < 2) city.spots.push({ x: sx, z: sz - 1.9, prop: 'stall', label: tSpot('stall') });
  }
  // 公园树藏点
  const parkTrees = treePlace.filter((t) => t.park);
  shuffle(parkTrees).slice(0, 6).forEach((t) => {
    city.spots.push({ x: t.x + 1.1, z: t.z + 1.1, prop: 'tree', label: tSpot('tree') });
  });
  // 共享单车桩 ×8
  const dockStreets = shuffle(D.streets.slice());
  for (let i = 0; i < 8; i++) {
    const st = dockStreets[i % dockStreets.length];
    const pos = alongStreet(st, R(0.2, 0.8), pick([-1, 1]));
    city.bikeStations.push({ x: pos.x, z: pos.z });
    const rack = new THREE.Mesh(new THREE.BoxGeometry(3, 0.8, 0.14), lambert(0xc0281c));
    rack.position.set(pos.x, 0.5, pos.z); g.add(rack);
    for (let bk = 0; bk < 2; bk++) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.06, 0.06), lambert(0x8a2018));
      bar.position.set(pos.x - 0.7 + bk * 1.4, 0.62, pos.z + 0.45); bar.rotation.z = 0.25; g.add(bar);
    }
  }
}

function buildLondonTrees(city, g, treePlace) {
  // 河堤树
  const emb = city.streets.find((s) => s.name === (window.CITY_DATA[city.cityKey] || {}).treeStreet);
  if (emb) {
    const path = buildPath(emb.pts);
    for (let s = 20; s < path.total; s += 34) {
      const p = pathPoint(path, s);
      treePlace.push({ x: p.x - p.dz * (emb.w / 2 + 4), z: p.z + p.dx * (emb.w / 2 + 4), park: false, cone: false });
    }
  }
  if (!treePlace.length) return;
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
  const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.28, 0.4, 2.6, 7), lambert(0x8a6239), treePlace.length);
  const crowns = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 10, 8), new THREE.MeshLambertMaterial({ color: 0xffffff }), treePlace.length);
  treePlace.forEach((t, idx) => {
    const s = R(0.9, 1.5);
    q.setFromAxisAngle(up, 0);
    m4.compose(new THREE.Vector3(t.x, 1.3 * s, t.z), q, new THREE.Vector3(s, s, s));
    trunks.setMatrixAt(idx, m4);
    m4.compose(new THREE.Vector3(t.x, 3.4 * s, t.z), q, new THREE.Vector3(s * 2, s * 2, s * 2));
    crowns.setMatrixAt(idx, m4);
    crowns.setColorAt(idx, new THREE.Color().setHSL(R(0.24, 0.35), 0.45, R(0.3, 0.42)));
    city.circles.push({ x: t.x, z: t.z, r: 0.55 });
    city.trees.push({ x: t.x, z: t.z, park: t.park });
  });
  trunks.castShadow = crowns.castShadow = true;
  g.add(trunks); g.add(crowns);
}

/* ---- 伦敦藏点属性 ---- */
function londonComputeAttrs(city) {
  city.spots.forEach((s) => {
    const a = {};
    a.river = distToPolyline(s.x, s.z, city.river.pts).d < city.river.halfW + 42;
    a.bigbell = city.tower && dist2d(s.x, s.z, city.tower.x, city.tower.z) < 130;
    a.trains = city.stations.some((st) => dist2d(s.x, s.z, st.x, st.z) < 26);
    a.park = city.parks.some((pk) => {
      const dx = (s.x - pk.p[0]) / pk.rx, dz = (s.z - pk.p[1]) / pk.rz;
      return dx * dx + dz * dz < 1.25;
    });
    a.lawn = a.park;
    a.water = (city.pond && dist2d(s.x, s.z, city.pond.x, city.pond.z) < Math.max(city.pond.rx, city.pond.rz) + 26)
      || (city.fountain && dist2d(s.x, s.z, city.fountain.x, city.fountain.z) < 20);
    a.waterfowl = !!(city.pond && dist2d(s.x, s.z, city.pond.x, city.pond.z) < Math.max(city.pond.rx, city.pond.rz) + 22);
    a.tourists = city.landmarks.some((lm) => dist2d(s.x, s.z, lm.p[0], lm.p[1]) < 42);
    a.market = city.market && dist2d(s.x, s.z, city.market.x, city.market.z) < 30;
    a.coffee = a.market;
    let trafficD = 1e9;
    city.streets.forEach((st) => { trafficD = Math.min(trafficD, distToPolyline(s.x, s.z, st.pts).d); });
    a.traffic = trafficD < 14;
    a.quiet = !a.traffic && !a.tourists && !a.market;
    a.shade = city.trees.some((t) => dist2d(s.x, s.z, t.x, t.z) < 3.4);
    a.bridge = s.prop === 'bridge';
    let nb = null, nbD = 1e9;
    city.buildings.forEach((b) => {
      const d = dist2d(s.x, s.z, b.x, b.z);
      if (d < nbD) { nbD = d; nb = b; }
    });
    if (nb && nbD < 26) {
      a.bcolor = nb.colorName;
      a.tall = nb.h > 40;
      a.low = nb.h < 16;
    }
    a.propKey = { trash: 'trash', bench: 'bench', booth: 'booth' }[s.prop] || null;
    s.attrs = a;
    s.taken = false;
    s.blockType = city.cityKey;
  });
  const counts = {};
  ['river', 'bigbell', 'trains', 'park', 'water', 'waterfowl', 'tourists', 'market', 'traffic', 'quiet', 'shade', 'bridge', 'tall', 'low', 'lawn', 'coffee']
    .forEach((k) => { counts[k] = city.spots.filter((sp) => sp.attrs[k]).length || 1; });
  city.attrCounts = counts;
}

function londonSpotHints(spot) {
  const a = spot.attrs, out = [];
  const push = (key, txt) => out.push({ key, txt });
  if (a.propKey && CLUE_TMPL[a.propKey]) push(a.propKey, CLUE_TMPL[a.propKey]());
  if (a.bridge) push('bridge', LONDON_CLUE_TMPL.bridge());
  if (a.bigbell) push('bigbell', LONDON_CLUE_TMPL.bigbell());
  if (a.river) push('river', LONDON_CLUE_TMPL.river());
  if (a.waterfowl) push('waterfowl', LONDON_CLUE_TMPL.waterfowl());
  else if (a.water) push('water', CLUE_TMPL.water());
  if (a.park) push('lawn', LONDON_CLUE_TMPL.lawn());
  if (a.trains) push('trains', LONDON_CLUE_TMPL.trains());
  if (a.tourists) push('tourists', LONDON_CLUE_TMPL.tourists());
  if (a.coffee) push('coffee', LONDON_CLUE_TMPL.coffee());
  if (a.traffic) push('traffic', CLUE_TMPL.traffic()); else if (a.quiet) push('quiet', CLUE_TMPL.quiet());
  if (a.shade) push('shade', CLUE_TMPL.shade());
  if (a.tall) push('tall', CLUE_TMPL.tall());
  if (a.low) push('low', CLUE_TMPL.low());
  if (a.bcolor) push('bcolor', CLUE_TMPL.bcolor(tColor(a.bcolor)));
  return out;
}

/* ---- NPC 乘客 ---- */
function spawnNPC(city, x, z) {
  const mesh = makePersonMesh(pick([0x8a5244, 0x4a6fa5, 0x3f7f5f, 0x9c7040, 0x6e5a8a, 0xb0685a]), pick([0x33363b, 0x8a2018, 0x1f3a5f]));
  mesh.scale.setScalar(0.92);
  mesh.position.set(x, 0.05, z);
  mesh.rotation.y = R(0, Math.PI * 2);
  scene.add(mesh);
  const npc = { mesh, x, z, state: 'wait', tx: x, tz: z, timer: 0, vRef: null };
  city.npcs.push(npc);
  return npc;
}

function updateNPCs(city, dt, t) {
  // 候车点补充乘客
  city.transitStops.forEach((stop) => {
    stop.respawn -= dt;
    if (stop.respawn <= 0 && stop.waiters.length < 2 && city.npcs.length < 34) {
      const n = spawnNPC(city, stop.x + R(-2.5, 2.5), stop.z + R(-1.2, 1.2));
      stop.waiters.push(n);
      stop.respawn = R(16, 38);
    }
  });
  for (let i = city.npcs.length - 1; i >= 0; i--) {
    const n = city.npcs[i];
    if (n.state === 'wait') {
      animateHuman(n.mesh.userData.human, t, 0);
    } else if (n.state === 'board') {
      animateHuman(n.mesh.userData.human, t, 0.55);
      const tx = n.vRef.mesh.position.x, tz = n.vRef.mesh.position.z;
      const dx = tx - n.x, dz = tz - n.z;
      const d = Math.hypot(dx, dz);
      if (d < 1.6 || n.vRef.dwell <= 0.2) {
        scene.remove(n.mesh);
        city.npcs.splice(i, 1);
        continue;
      }
      n.x += (dx / d) * 3.4 * simK() * dt; n.z += (dz / d) * 3.4 * simK() * dt;
      n.mesh.position.set(n.x, 0.05, n.z);
      n.mesh.rotation.y = Math.atan2(dx, dz);
    } else if (n.state === 'leave') {
      const dx = n.tx - n.x, dz = n.tz - n.z;
      const d = Math.hypot(dx, dz);
      n.timer -= dt;
      if (d > 0.5 && n.timer > 0) {
        n.x += (dx / d) * 2.8 * simK() * dt; n.z += (dz / d) * 2.8 * simK() * dt;
        n.mesh.position.set(n.x, 0.05, n.z);
        n.mesh.rotation.y = Math.atan2(dx, dz);
        animateHuman(n.mesh.userData.human, t, 0.5);
      }
      if (n.timer <= 0) {
        scene.remove(n.mesh);
        city.npcs.splice(i, 1);
      }
    }
  }
}

/* ---- 交通工具运行（进站减速-停靠上客-发车） ---- */
function nextStopFor(v) {
  if (!v.stops.length) return null;
  const eps = 0.5;
  if (v.dir > 0) {
    let best = null;
    for (const st of v.stops) if (st.s > v.s + eps && (!best || st.s < best.s)) best = st;
    if (!best && v.loop) best = v.stops[0];
    return best;
  }
  let best = null;
  for (const st of v.stops) if (st.s < v.s - eps && (!best || st.s > best.s)) best = st;
  if (!best && v.loop) best = v.stops[v.stops.length - 1];
  return best;
}

function vehicleArrive(v, stop, city) {
  v.speed = 0;
  v.state = 'dwell';
  v.curStop = stop;
  // 站台候车者上车
  const near = city.transitStops.filter((ts) => dist2d(ts.x, ts.z, stop.x, stop.z) < 10);
  let boarding = 0;
  near.forEach((ts) => {
    ts.waiters.forEach((n) => { n.state = 'board'; n.vRef = v; boarding++; });
    ts.waiters = [];
  });
  // 下车的乘客
  const nOff = RI(0, 2);
  for (let i = 0; i < nOff; i++) {
    const n = spawnNPC(city, v.mesh.position.x + R(-1, 1), v.mesh.position.z + R(-1, 1));
    n.state = 'leave';
    n.tx = n.x + R(-14, 14); n.tz = n.z + R(-14, 14);
    n.timer = R(5, 8);
  }
  v.dwell = Math.max(4.2, 3 + boarding * 1.3 + nOff * 0.6);
  const d = dist2d(player.x, player.z, stop.x, stop.z);
  if (v.kind === 'train') AudioSys.busDing(clamp(0.2 * (1 - d / 120), 0, 0.2));
  else AudioSys.beep(520, 0.15, 'sine', clamp(0.15 * (1 - d / 90), 0, 0.15));
  if (v.riding) {
    showToast(t('transit_arrive', stop.name));
  }
}

function updateVehicle(v, dt, city) {
  if (v.state === 'dwell') {
    v.dwell -= dt;
    if (v.dwell <= 0) {
      v.state = 'run';
      // 到达端点后调头
      if (!v.loop) {
        if (v.dir > 0 && v.s >= v.path.total - 1) v.dir = -1;
        else if (v.dir < 0 && v.s <= 1) v.dir = 1;
      }
    }
  } else {
    const k = simK();
    const maxSp = v.maxSpeed * k, acc = v.accel * k;
    const stop = nextStopFor(v);
    let distToStop = Infinity;
    if (stop) {
      distToStop = v.dir > 0 ? stop.s - v.s : v.s - stop.s;
      if (v.loop && distToStop < 0) distToStop += v.path.total;
    } else if (!v.loop) {
      distToStop = v.dir > 0 ? v.path.total - v.s : v.s;
    }
    const brake = (v.speed * v.speed) / (2 * acc) + 1.5;
    if (distToStop <= brake) v.speed = Math.max(2.5 * k, v.speed - acc * dt);
    else v.speed = Math.min(maxSp, v.speed + acc * dt);
    v.s += v.dir * v.speed * dt;
    if (v.loop) {
      if (v.s >= v.path.total) v.s -= v.path.total;
      if (v.s < 0) v.s += v.path.total;
    } else {
      v.s = clamp(v.s, 0, v.path.total);
    }
    if (stop && distToStop <= Math.max(0.6, v.speed * dt * 1.2)) {
      v.s = stop.s;
      vehicleArrive(v, stop, city);
    } else if (!v.loop && (v.s <= 0 || v.s >= v.path.total)) {
      v.speed = 0;
      v.state = 'dwell';
      v.dwell = 2;
    }
  }
  // 摆放车体
  if (v.cars) {
    v.cars.forEach((car, ci) => {
      const cs = v.loop
        ? (v.s - v.dir * ci * 6 + v.path.total) % v.path.total
        : clamp(v.s - v.dir * ci * 6, 0, v.path.total);
      const p = pathPoint(v.path, cs);
      car.position.set(p.x, 0, p.z);
      car.rotation.y = Math.atan2(p.dx * v.dir, p.dz * v.dir) + Math.PI / 2;
    });
    const head = pathPoint(v.path, v.s);
    v.mesh.position.set(0, 0, 0);
    v.headPos = head;
  } else {
    const p = pathPoint(v.path, v.s);
    v.mesh.position.set(p.x, 0, p.z);
    v.mesh.rotation.y = Math.atan2(p.dx * v.dir, p.dz * v.dir) + Math.PI / 2;
    v.headPos = p;
  }
  // 玩家乘坐
  if (v.riding) {
    const hp = v.headPos;
    player.x = hp.x; player.z = hp.z;
    player.mesh.position.set(hp.x, 2.6, hp.z);
  }
}

function updateLondon(dt, t) {
  const city = G.city;
  city.vehicles.forEach((v) => updateVehicle(v, dt, city));
  city.cars.forEach((c) => {
    c.s += c.dir * c.speed * simK() * dt;
    if (c.s > c.path.total) { c.s = c.path.total; c.dir = -1; }
    if (c.s < 0) { c.s = 0; c.dir = 1; }
    const p = pathPoint(c.path, c.s);
    const off = 2.2 * c.dir;
    c.mesh.position.set(p.x - p.dz * off, 0, p.z + p.dx * off);
    c.mesh.rotation.y = Math.atan2(p.dx * c.dir, p.dz * c.dir);
  });
  updateNPCs(city, dt, t);
  if (city.eyeWheel) city.eyeWheel.rotation.z += dt * 0.06;
  if (city.waterMesh) city.waterMesh.material.opacity = 0.9 + Math.sin(t * 1.4) * 0.04;
  if (city.clouds) {
    city.clouds.forEach((c) => {
      c.mesh.position.x += c.vx * dt;
      if (c.mesh.position.x > city.bounds.maxX + 120) c.mesh.position.x = city.bounds.minX - 120;
    });
  }
  // 海鸥
  if (!city.gullTimer) city.gullTimer = 6;
  city.gullTimer -= dt;
  if (city.gullTimer <= 0) {
    city.gullTimer = R(7, 14);
    const d = distToPolyline(player.x, player.z, city.river.pts).d;
    if (d < 90) AudioSys.chirp(clamp(0.12 * (1 - d / 110), 0.02, 0.12));
  }
}

/* ---- 乘车交互 ---- */
const vIcon = (v) => (v.kind === 'train' ? '🚇' : v.kind === 'ferry' ? '⛴️' : '🚌');

function transitNear() {
  if (G.city.kind !== 'real') return null;
  let best = null, bd = 1e9;
  G.city.vehicles.forEach((v) => {
    if (v.state !== 'dwell' || v.dwell <= 0.3) return;
    const hp = v.headPos || { x: v.mesh.position.x, z: v.mesh.position.z };
    const d = dist2d(player.x, player.z, hp.x, hp.z);
    if (d < 8 && d < bd) { bd = d; best = v; }
  });
  return best;
}

function boardTransit(v) {
  if (!spendCredits(v.cost, v.kind === 'train' ? t('w_train') : v.kind === 'ferry' ? t('w_ferry') : t('w_bus'))) return;
  player.riding = 'transit';
  player.tv = v;
  v.riding = true;
  AudioSys.busDing();
  showToast(t('transit_on', vIcon(v), v.cost, v.line));
}

function alightTransit() {
  const v = player.tv;
  if (!v) return;
  if (v.state !== 'dwell') { showToast(t('transit_run'), 'red'); return; }
  v.riding = false;
  player.riding = null;
  player.tv = null;
  const stop = v.curStop;
  if (stop) {
    [player.x, player.z] = collide(stop.x + 2, stop.z + 4);
  }
  AudioSys.click();
  showToast(t('transit_off', stop ? stop.name : ''));
}

/* ============================================================
 * 角色 —— 拟真人物（真实比例 + 关节走路动画）
 * ============================================================ */
const SKIN_TONES = [0xf2cfb3, 0xe8b992, 0xd9a878, 0xc98d63, 0x9c6b46, 0x6f4a30];
const CLOTH_TONES = [0x3a4a5f, 0x54585e, 0x6e5a4a, 0x2f4a3f, 0x5f3a3a, 0x7a7f88, 0x2a3444, 0x8a6f54, 0x74584c, 0x46586a];
const PANTS_TONES = [0x2b3038, 0x3a3f46, 0x2f3a4f, 0x4a4238, 0x33383f, 0x1f242b];
const HAIR_TONES = [0x2a2320, 0x4a3623, 0x6b4a2a, 0x8a8a8a, 0x151517, 0x7a5535];

function makeHumanPalette() {
  return { skin: pick(SKIN_TONES), shirt: pick(CLOTH_TONES), pants: pick(PANTS_TONES), hair: pick(HAIR_TONES) };
}

/* 人物：原点在双脚，面朝本地 +Z，身高约 1.75m */
function makeHuman(pal) {
  const p = pal || makeHumanPalette();
  const grp = new THREE.Group();
  const bob = new THREE.Group();           // 走路上下起伏用
  grp.add(bob);
  const M = (geo, color) => {
    const m = new THREE.Mesh(geo, lambert(color));
    m.castShadow = true;
    return m;
  };
  // 骨盆 & 躯干
  const pelvis = M(new THREE.BoxGeometry(0.30, 0.17, 0.19), p.pants);
  pelvis.position.y = 0.97; bob.add(pelvis);
  const torso = M(new THREE.BoxGeometry(0.34, 0.46, 0.20), p.shirt);
  torso.position.y = 1.28; bob.add(torso);
  const shoulders = M(new THREE.BoxGeometry(0.40, 0.10, 0.19), p.shirt);
  shoulders.position.y = 1.50; bob.add(shoulders);
  // 脖子 & 头
  const neck = M(new THREE.CylinderGeometry(0.05, 0.06, 0.08, 8), p.skin);
  neck.position.y = 1.58; bob.add(neck);
  const head = M(new THREE.SphereGeometry(0.115, 12, 10), p.skin);
  head.scale.y = 1.18;
  head.position.y = 1.70; bob.add(head);
  const hair = M(new THREE.SphereGeometry(0.118, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.55), p.hair);
  hair.scale.y = 1.2;
  hair.position.y = 1.715; bob.add(hair);
  // 四肢：pivot 在关节处，geometry 下移
  const limb = (r1, r2, len, color) => {
    const pv = new THREE.Group();
    const g = new THREE.CylinderGeometry(r1, r2, len, 8);
    g.translate(0, -len / 2, 0);
    pv.add(M(g, color));
    return pv;
  };
  const armL = limb(0.048, 0.04, 0.56, p.shirt);
  const armR = limb(0.048, 0.04, 0.56, p.shirt);
  armL.position.set(-0.235, 1.50, 0); armR.position.set(0.235, 1.50, 0);
  bob.add(armL); bob.add(armR);
  const handG = new THREE.SphereGeometry(0.045, 8, 6);
  const handL = M(handG, p.skin); handL.position.set(0, -0.58, 0); armL.add(handL);
  const handR = M(handG, p.skin); handR.position.set(0, -0.58, 0); armR.add(handR);
  const legL = limb(0.075, 0.05, 0.86, p.pants);
  const legR = limb(0.075, 0.05, 0.86, p.pants);
  legL.position.set(-0.095, 0.90, 0); legR.position.set(0.095, 0.90, 0);
  bob.add(legL); bob.add(legR);
  const shoeG = new THREE.BoxGeometry(0.10, 0.07, 0.24);
  shoeG.translate(0, -0.885, 0.05);
  const shoeL = M(shoeG, 0x22242a); legL.add(shoeL);
  const shoeR = M(shoeG.clone(), 0x22242a); legR.add(shoeR);
  // 眼睛
  const eyeG = new THREE.SphereGeometry(0.016, 6, 6);
  const e1 = M(eyeG, 0x1a1a1a), e2 = M(eyeG, 0x1a1a1a);
  e1.position.set(-0.045, 1.72, 0.105); e2.position.set(0.045, 1.72, 0.105);
  bob.add(e1); bob.add(e2);
  grp.userData.human = { bob, armL, armR, legL, legR, torso, head, phase: R(0, Math.PI * 2) };
  return grp;
}

/* 走路/站立动画（每帧调用，零分配）
 * speed01: 0=站立(呼吸) → 1=奔跑 */
function animateHuman(h, time, speed01) {
  if (!h) return;
  const ph = h.phase;
  if (speed01 < 0.02) {
    const b = Math.sin(time * 1.7 + ph);
    h.bob.position.y = 0;
    h.torso.rotation.x = 0;
    h.armL.rotation.x = b * 0.035;
    h.armR.rotation.x = -b * 0.035;
    h.legL.rotation.x = 0;
    h.legR.rotation.x = 0;
    h.head.rotation.y = Math.sin(time * 0.6 + ph) * 0.12;
  } else {
    const f = time * (5 + 5.5 * speed01) + ph;
    const swing = 0.32 + 0.42 * speed01;
    const s = Math.sin(f);
    h.legL.rotation.x = s * swing;
    h.legR.rotation.x = -s * swing;
    h.armL.rotation.x = -s * swing * 0.78;
    h.armR.rotation.x = s * swing * 0.78;
    h.bob.position.y = Math.abs(Math.cos(f)) * 0.045 * (0.4 + speed01);
    h.torso.rotation.x = 0.06 + 0.1 * speed01;
    h.head.rotation.y = 0;
  }
}

/* 兼容旧接口：shirt 用 bodyColor，戴 hatColor 的毛线帽（躲藏者识别度） */
function makePersonMesh(bodyColor, hatColor) {
  const pal = makeHumanPalette();
  pal.shirt = bodyColor;
  const grp = makeHuman(pal);
  if (hatColor !== undefined) {
    const beanie = new THREE.Mesh(
      new THREE.SphereGeometry(0.125, 10, 7, 0, Math.PI * 2, 0, Math.PI * 0.5), lambert(hatColor));
    beanie.scale.y = 0.9;
    beanie.position.y = 1.73;
    beanie.castShadow = true;
    grp.userData.human.bob.add(beanie);
  }
  return grp;
}

const player = {
  x: 0, z: 20, yaw: 0, pitch: -0.25,
  mesh: null, bikeMesh: null,
  riding: null,         // null | 'bike' | 'bus'
  stamina: 100,
  camDist: 7.5,
};

function playerPalette() {
  try {
    const saved = JSON.parse(localStorage.getItem('ct_avatar') || 'null');
    if (saved && saved.skin) return saved;
  } catch (e) { /* 忽略损坏存档 */ }
  return { skin: 0xe8b992, shirt: 0x2f6fd6, pants: 0x2b3038, hair: 0x2a2320 };
}
function rebuildPlayerMesh() {
  if (player.mesh) { scene.remove(player.mesh); player.mesh = null; }
  makePlayerMesh();
}
function makePlayerMesh() {
  if (player.mesh) scene.add(player.mesh);
  else {
    player.mesh = makeHuman(playerPalette());
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
    c.pos += c.dir * c.speed * simK() * dt;
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
    if (bus.dwell <= 0 && bus.riding) showToast(t('bus_go'));
    return;
  }
  const a = path[bus.seg], b = path[(bus.seg + 1) % 4];
  const segLen = Math.abs(b.x - a.x) + Math.abs(b.z - a.z);
  bus.t += (SPEED.bus * simK() * dt) / segLen;
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
      showToast(t('bus_arrive'));
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
  // 河流：除桥面走廊外不可进入
  if (c.river) {
    const onBridge = c.bridgeCorridors.some((br) => distToSeg(x, z, br.a[0], br.a[1], br.b[0], br.b[1]).d < br.hw);
    if (!onBridge) {
      const near = distToPolyline(x, z, c.river.pts);
      const min = c.river.halfW + r;
      if (near.d < min) {
        const dx = x - near.px, dz = z - near.pz;
        const d = Math.max(0.001, Math.hypot(dx, dz));
        x = near.px + (dx / d) * min;
        z = near.pz + (dz / d) * min;
      }
    }
  }
  const B = c.bounds;
  x = clamp(x, B.minX + 1.2, B.maxX - 1.2);
  z = clamp(z, B.minZ + 1.2, B.maxZ - 1.2);
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
  const spread = G.city.kind === 'real' ? 140 : 55;
  const chosen = [];
  shuffle(free);
  for (const s of free) {
    if (chosen.length >= n) break;
    if (chosen.every((c) => dist2d(c.x, c.z, s.x, s.z) > spread) || free.length < n * 2) chosen.push(s);
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
    h.mesh.position.y = 0.03;
    animateHuman(h.mesh.userData.human, t, 0);
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
    showToast(t('no_credit', n, what), 'red');
    return false;
  }
  G.credits -= n;
  G.spent += n;
  updateHUD();
  return true;
}

function tryInteract() {
  // 抓人优先
  const h = nearestActiveHider();
  if (h && h.d < 3.2 && player.riding !== 'bus' && player.riding !== 'transit') { captureHider(h.hider); return; }
  // 伦敦：地铁/公交
  if (G.city.kind === 'real') {
    if (player.riding === 'transit') { alightTransit(); return; }
    const v = transitNear();
    if (v && player.riding === null) { boardTransit(v); return; }
    if (v && player.riding === 'bike') { showToast(t('bike_first'), 'red'); }
    return;
  }
  const bus = G.city.bus;
  // 公交上下车
  if (player.riding === 'bus') {
    if (bus.dwell > 0) {
      player.riding = null;
      bus.riding = false;
      const stop = G.city.busStops[bus.stopIdx];
      player.x = stop.sx; player.z = stop.sz;
      showToast(t('bus_off'));
      AudioSys.click();
    } else {
      showToast(t('bus_wait'), 'red');
    }
    return;
  }
  if (player.riding === null || player.riding === 'bike') {
    const d = dist2d(player.x, player.z, bus.mesh.position.x, bus.mesh.position.z);
    if (d < 6 && bus.dwell > 0) {
      if (player.riding === 'bike') { showToast(t('bike_first'), 'red'); return; }
      if (!spendCredits(COST.bus, t('w_bus'))) return;
      player.riding = 'bus';
      bus.riding = true;
      AudioSys.busDing();
      showToast(t('bus_on', COST.bus));
    }
  }
}

function tryRadar() {
  if (G.phase !== 'seek' || G.paused) return;
  if (!spendCredits(COST.radar, t('w_radar'))) return;
  const h = nearestActiveHider();
  AudioSys.radar();
  if (!h) { showToast(t('radar_none')); return; }
  const d = Math.round(h.d);
  const k = G.city.radarScale || 1;
  let temp;
  if (d < 20 * k) temp = t('r_hot4');
  else if (d < 45 * k) temp = t('r_hot3');
  else if (d < 80 * k) temp = t('r_hot2');
  else if (d < 130 * k) temp = t('r_hot1');
  else temp = t('r_hot0');
  G.radarRings.push({ x: player.x, z: player.z, d: h.d, until: performance.now() + 7000 });
  if (G.radarRings.length > 2) G.radarRings.shift();
  showToast(t('radar_result', d, temp), 'gold');
}

function tryBike() {
  if (G.phase !== 'seek' || G.paused) return;
  if (player.riding === 'bus' || player.riding === 'transit') { showToast(t('bike_bus'), 'red'); return; }
  if (player.riding === 'bike') {
    player.riding = null;
    player.bikeMesh.visible = false;
    showToast(t('bike_off'));
    AudioSys.click();
    return;
  }
  const st = G.city.bikeStations.find((s) => dist2d(player.x, player.z, s.x, s.z) < 7);
  if (!st) { showToast(t('bike_none'), 'red'); return; }
  if (!spendCredits(COST.bike, t('w_bike'))) return;
  player.riding = 'bike';
  player.bikeMesh.visible = true;
  AudioSys.coin();
  showToast(t('bike_on', COST.bike));
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
  showToast(t('cap_toast', G.seekers[G.curSeeker].name, h.emoji, h.name, COST.captureBase, h.bounty), 'gold');
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
  if (bigMapOpen) drawMap($('bigMap').getContext('2d'), $('bigMap').width, true);
}
$('mapClose').addEventListener('click', toggleBigMap);
function mapToWorld(e) {
  const cv = $('bigMap');
  const rect = cv.getBoundingClientRect();
  const xf = cv.__xf;
  if (!xf) return null;
  const px2 = ((e.clientX - rect.left) / rect.width) * cv.width;
  const pz2 = ((e.clientY - rect.top) / rect.height) * cv.height;
  return {
    x: (px2 - xf.ox) / xf.sc + xf.minX,
    z: (pz2 - xf.oy) / xf.sc + xf.minZ,
  };
}
$('bigMap').addEventListener('mousemove', (e) => {
  const w = mapToWorld(e);
  if (w) $('mapCost').textContent = `${taxiCost(w.x, w.z)}💰`;
});
$('bigMap').addEventListener('click', (e) => {
  const w = mapToWorld(e);
  if (w) callTaxi(w.x, w.z);
});
function taxiCost(x, z) {
  const perM = G.city.taxiPerM || COST.taxiPerM;
  return COST.taxiBase + Math.round(dist2d(player.x, player.z, x, z) * perM);
}
function callTaxi(x, z) {
  if (player.riding === 'bus' || player.riding === 'transit') { showToast(t('taxi_busy'), 'red'); return; }
  const cost = taxiCost(x, z);
  if (!spendCredits(cost, t('w_taxi'))) return;
  // 落点吸附到最近道路
  let tx = x, tz = z;
  if (G.city.kind === 'real') {
    let best = { d: 1e9, px: x, pz: z };
    G.city.streets.forEach((st) => {
      const r = distToPolyline(x, z, st.pts);
      if (r.d < best.d) best = r;
    });
    tx = best.px + 3; tz = best.pz + 3;
  } else {
    let bestK = 0, bestAxis = 'x', bestD = 1e9;
    for (let k = 0; k <= GRID; k++) {
      const dX = Math.abs(x - roadLine(k)), dZ = Math.abs(z - roadLine(k));
      if (dX < bestD) { bestD = dX; bestK = k; bestAxis = 'x'; }
      if (dZ < bestD) { bestD = dZ; bestK = k; bestAxis = 'z'; }
    }
    if (bestAxis === 'x') tx = roadLine(bestK) + 3.5; else tz = roadLine(bestK) + 3.5;
  }
  const B = G.city.bounds;
  tx = clamp(tx, B.minX + 3, B.maxX - 3); tz = clamp(tz, B.minZ + 3, B.maxZ - 3);
  toggleBigMap();
  AudioSys.taxi();
  const fade = $('fade');
  fade.style.opacity = 1;
  if (player.riding === 'bike') { player.riding = null; player.bikeMesh.visible = false; }
  setTimeout(() => {
    [player.x, player.z] = collide(tx, tz);
    fade.style.opacity = 0;
    showToast(t('taxi_done', cost));
  }, 550);
}

/* ============================================================
 * 玩家更新 & 摄像机
 * ============================================================ */
const flyCam = { x: 0, y: 90, z: 80 };

function updatePlayer(dt) {
  if (player.riding === 'bus' || player.riding === 'transit') {
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
  sp *= simK();
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
  // 拟真步态：走 0.5 / 跑 0.95 / 骑车与静止 0
  let s01 = 0;
  if (player.riding !== 'bike' && moving) s01 = sp > SPEED.walk * simK() * 1.2 ? 0.95 : 0.5;
  animateHuman(player.mesh.userData.human, G.now || 0, s01);
  updateCamera(dt);
}

function updateCamera() {
  const onVehicle = player.riding === 'bus' || player.riding === 'transit';
  const py = onVehicle ? 3.6 : 1.6;
  if (G.view3rd) {
    const cd = player.camDist;
    const cx = player.x + Math.sin(player.yaw) * cd * Math.cos(player.pitch);
    const cz = player.z + Math.cos(player.yaw) * cd * Math.cos(player.pitch);
    const cy = py + 1.6 - Math.sin(player.pitch) * cd;
    camera.position.set(cx, Math.max(0.6, cy), cz);
    camera.lookAt(player.x, py + 0.6, player.z);
    player.mesh.visible = !onVehicle;
  } else {
    camera.position.set(player.x, py, player.z);
    const lx = player.x - Math.sin(player.yaw) * 10 * Math.cos(player.pitch);
    const lz = player.z - Math.cos(player.yaw) * 10 * Math.cos(player.pitch);
    camera.lookAt(lx, py + Math.sin(-player.pitch) * -10, lz);
    player.mesh.visible = false;
  }
  sunLight.position.set(player.x + 150, 210, player.z + 90);
  sunLight.target.position.set(player.x, 0, player.z);
}

/* 自由飞行（躲藏阶段） */
function updateFlyCam(dt) {
  const fast = keys['ShiftLeft'] || keys['ShiftRight'];
  const sp = (fast ? SPEED.flyFast : SPEED.fly) * (G.city.flyMul || 1);
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
  const B = G.city.bounds;
  flyCam.y = clamp(flyCam.y + my * sp * dt, 4, 420);
  flyCam.x = clamp(flyCam.x, B.minX - 60, B.maxX + 60);
  flyCam.z = clamp(flyCam.z, B.minZ - 60, B.maxZ + 60);
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
  const c = G.city;
  const B = c.bounds;
  const W = B.maxX - B.minX, H = B.maxZ - B.minZ;
  const sc = Math.min(size / W, size / H);
  const ox = (size - W * sc) / 2, oy = (size - H * sc) / 2;
  const TX = (x) => (x - B.minX) * sc + ox;
  const TZ = (z) => (z - B.minZ) * sc + oy;
  ctx.canvas.__xf = { sc, ox, oy, minX: B.minX, minZ: B.minZ };
  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = '#141a22'; ctx.fillRect(0, 0, size, size);

  if (c.kind === 'real') {
    ctx.fillStyle = '#2a313a';
    ctx.fillRect(TX(B.minX), TZ(B.minZ), W * sc, H * sc);
    // 公园
    c.parks.forEach((pk) => {
      ctx.fillStyle = '#3f7f52';
      ctx.beginPath();
      ctx.ellipse(TX(pk.p[0]), TZ(pk.p[1]), pk.rx * sc, pk.rz * sc, 0, 0, Math.PI * 2);
      ctx.fill();
    });
    // 街道
    ctx.strokeStyle = '#55606c';
    ctx.lineWidth = big ? 2.5 : 1.4;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    c.streets.forEach((st) => {
      ctx.beginPath();
      st.pts.forEach((p, i) => (i ? ctx.lineTo(TX(p[0]), TZ(p[1])) : ctx.moveTo(TX(p[0]), TZ(p[1]))));
      ctx.stroke();
    });
    // 泰晤士河
    ctx.strokeStyle = '#2f6fa8';
    ctx.lineWidth = c.river.halfW * 2 * sc;
    ctx.beginPath();
    c.river.pts.forEach((p, i) => (i ? ctx.lineTo(TX(p[0]), TZ(p[1])) : ctx.moveTo(TX(p[0]), TZ(p[1]))));
    ctx.stroke();
    // 桥
    ctx.strokeStyle = '#8d887c'; ctx.lineWidth = big ? 3 : 1.6;
    c.bridgeCorridors.forEach((br) => {
      ctx.beginPath(); ctx.moveTo(TX(br.a[0]), TZ(br.a[1])); ctx.lineTo(TX(br.b[0]), TZ(br.b[1])); ctx.stroke();
    });
    // 地铁线（官方配色）
    c.railLines.forEach((ln) => {
      ctx.strokeStyle = ln.color;
      ctx.lineWidth = big ? 2.2 : 1.2;
      ctx.beginPath();
      ln.pts.forEach((p, i) => (i ? ctx.lineTo(TX(p[0]), TZ(p[1])) : ctx.moveTo(TX(p[0]), TZ(p[1]))));
      ctx.stroke();
    });
    // 站点
    c.stations.forEach((st) => {
      ctx.fillStyle = '#ffffff';
      ctx.beginPath(); ctx.arc(TX(st.x), TZ(st.z), big ? 3 : 1.7, 0, Math.PI * 2); ctx.fill();
      if (big) {
        ctx.strokeStyle = '#dc241f'; ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.arc(TX(st.x), TZ(st.z), 4.4, 0, Math.PI * 2); ctx.stroke();
      }
    });
    if (big) {
      ctx.font = '10px sans-serif'; ctx.fillStyle = '#c8d2e0';
      c.stations.forEach((st, i) => { if (i % 2 === 0) ctx.fillText(st.name, TX(st.x) + 6, TZ(st.z) + 3); });
    }
    // 地标
    ctx.fillStyle = '#ffd166';
    c.landmarks.forEach((lm) => {
      ctx.beginPath(); ctx.arc(TX(lm.p[0]), TZ(lm.p[1]), big ? 3.4 : 2, 0, Math.PI * 2); ctx.fill();
    });
    // 运行中的车辆
    if (G.phase === 'seek') {
      c.vehicles.forEach((v) => {
        const hp = v.headPos || { x: v.mesh.position.x, z: v.mesh.position.z };
        ctx.fillStyle = v.kind === 'train' ? v.color : v.kind === 'ferry' ? '#e8f0f5' : '#ff5a4a';
        ctx.beginPath(); ctx.arc(TX(hp.x), TZ(hp.z), big ? 4 : 2.6, 0, Math.PI * 2); ctx.fill();
        if (v.state === 'dwell') {
          ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.arc(TX(hp.x), TZ(hp.z), big ? 6 : 4, 0, Math.PI * 2); ctx.stroke();
        }
      });
    }
  } else {
    const cols = { plaza: '#c9b78a', park: '#4f9e5f', pond: '#4f9e5f', down: '#7f8ba0', market: '#b58a5f', constr: '#8a7f6a', res: '#9aa0a8' };
    ctx.fillStyle = '#3a3f46';
    ctx.fillRect(TX(B.minX), TZ(B.minZ), W * sc, H * sc);
    for (let i = 0; i < GRID; i++) for (let j = 0; j < GRID; j++) {
      ctx.fillStyle = cols[blockType(i, j)];
      ctx.fillRect(TX(blockMin(i)), TZ(blockMin(j)), BLOCK * sc, BLOCK * sc);
    }
    if (c.pond) {
      ctx.fillStyle = '#3f8fd6';
      ctx.beginPath(); ctx.ellipse(TX(c.pond.x), TZ(c.pond.z), c.pond.rx * sc, c.pond.rz * sc, 0, 0, Math.PI * 2); ctx.fill();
    }
    if (c.tower) {
      ctx.fillStyle = '#e3d9c4';
      ctx.fillRect(TX(c.tower.x) - 3, TZ(c.tower.z) - 3, 6, 6);
    }
    c.busStops.forEach((b) => {
      ctx.fillStyle = '#2f7fd6';
      ctx.fillRect(TX(b.sx) - (big ? 4 : 2.5), TZ(b.sz) - (big ? 4 : 2.5), big ? 8 : 5, big ? 8 : 5);
    });
    if (c.bus && G.phase === 'seek') {
      ctx.fillStyle = '#61b3ff';
      ctx.beginPath(); ctx.arc(TX(c.bus.mesh.position.x), TZ(c.bus.mesh.position.z), big ? 5 : 3.5, 0, Math.PI * 2); ctx.fill();
    }
  }

  // 单车站（两种城市共用）
  c.bikeStations.forEach((b) => {
    ctx.fillStyle = '#e0995c';
    ctx.beginPath(); ctx.arc(TX(b.x), TZ(b.z), big ? 4 : 2.5, 0, Math.PI * 2); ctx.fill();
  });
  // 雷达测距圈
  const now = performance.now();
  G.radarRings = G.radarRings.filter((r) => r.until > now);
  G.radarRings.forEach((r) => {
    ctx.strokeStyle = 'rgba(255,209,102,0.9)';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(TX(r.x), TZ(r.z), r.d * sc, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = 'rgba(255,209,102,0.9)';
    ctx.beginPath(); ctx.arc(TX(r.x), TZ(r.z), 2.5, 0, Math.PI * 2); ctx.fill();
  });
  // 已找到的躲藏者
  if (G.phase === 'seek' || G.phase === 'end') {
    ctx.font = `${big ? 14 : 10}px sans-serif`;
    G.hiders.forEach((h) => {
      if (h.found) ctx.fillText('✅', TX(h.spot.x) - 5, TZ(h.spot.z) + 4);
    });
  }
  // 玩家箭头
  if (G.phase === 'seek') {
    ctx.save();
    ctx.translate(TX(player.x), TZ(player.z));
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
    card.innerHTML = `<span class="bounty">${t('bounty_tag', h.bounty)}</span><div class="who">${h.emoji} ${h.name}</div><div class="clue">"${h.clue}"</div>`;
    list.appendChild(card);
  });
}

/* ============================================================
 * 浮动窗口系统：拖动 / 缩放 / 最小化 / 关闭 / 恢复托盘
 * ============================================================ */
function enableDrag(el, handle) {
  let drag = false, sx = 0, sy = 0, ox = 0, oy = 0;
  handle.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    drag = true; sx = e.clientX; sy = e.clientY;
    const r = el.getBoundingClientRect(); ox = r.left; oy = r.top;
    el.style.left = ox + 'px'; el.style.top = oy + 'px';
    el.style.right = 'auto'; el.style.bottom = 'auto';
    el.style.position = 'absolute'; el.style.margin = '0';
    handle.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  handle.addEventListener('pointermove', (e) => {
    if (!drag) return;
    el.style.left = clamp(ox + e.clientX - sx, 0, innerWidth - 80) + 'px';
    el.style.top = clamp(oy + e.clientY - sy, 0, innerHeight - 40) + 'px';
  });
  handle.addEventListener('pointerup', () => { drag = false; });
}
function addResizeHandle(el, onSize) {
  const h = document.createElement('div');
  h.className = 'wResize';
  el.appendChild(h);
  let drag = false, sx = 0, sy = 0, sw = 0, sh = 0;
  h.addEventListener('pointerdown', (e) => {
    drag = true; sx = e.clientX; sy = e.clientY;
    const r = el.getBoundingClientRect(); sw = r.width; sh = r.height;
    h.setPointerCapture(e.pointerId);
    e.preventDefault(); e.stopPropagation();
  });
  h.addEventListener('pointermove', (e) => {
    if (!drag) return;
    onSize(sw + e.clientX - sx, sh + e.clientY - sy);
  });
  h.addEventListener('pointerup', () => { drag = false; });
  return h;
}

const WIN = { mm: { open: true, min: false }, cp: { open: true, min: false }, bm: { min: false } };

function renderDockTray() {
  const tray = $('dockTray');
  tray.innerHTML = '';
  const add = (icon, title, cb) => {
    const b = document.createElement('button');
    b.className = 'dockBtn'; b.textContent = icon; b.title = title;
    b.addEventListener('click', cb);
    tray.appendChild(b);
  };
  if (!WIN.mm.open) add('🗺', t('mm_open'), () => setWinOpen('mm', true));
  if (!WIN.cp.open) add('🕵️', t('panel_title'), () => setWinOpen('cp', true));
}
function setWinOpen(key, open) {
  WIN[key].open = open;
  (key === 'mm' ? $('minimapWrap') : $('cluePanel')).classList.toggle('hidden', !open);
  renderDockTray();
  AudioSys.click();
}
function setWinMin(key, min) {
  WIN[key].min = min;
  if (key === 'mm') {
    $('minimap').style.display = min ? 'none' : 'block';
    $('mmMin').textContent = min ? '▢' : '–';
    $('mmMin').title = min ? t('mm_restore') : t('mm_min');
  } else if (key === 'cp') {
    $('clueList').style.display = min ? 'none' : '';
    const p = $('cluePanel');
    if (min) { p.dataset.h = p.style.height || ''; p.style.height = 'auto'; }
    else p.style.height = p.dataset.h || '';
    $('cpMin').textContent = min ? '▢' : '–';
  } else if (key === 'bm') {
    $('bigMap').style.display = min ? 'none' : 'block';
    $('mapHint').style.display = min ? 'none' : '';
    $('mapClose').style.display = min ? 'none' : '';
    const rh = $('bigMapPanel').querySelector('.wResize');
    if (rh) rh.style.display = min ? 'none' : 'block';
    $('bmMin').textContent = min ? '▢' : '–';
  }
  ['mm'].forEach(() => {});
  AudioSys.click();
}
function togglePanel() {
  if (!WIN.cp.open) setWinOpen('cp', true);
  else setWinMin('cp', !WIN.cp.min);
}
$('panelToggle').addEventListener('dblclick', () => setWinMin('cp', !WIN.cp.min));
$('cpMin').addEventListener('click', () => setWinMin('cp', !WIN.cp.min));
$('cpClose').addEventListener('click', () => setWinOpen('cp', false));
$('mmMin').addEventListener('click', () => setWinMin('mm', !WIN.mm.min));
$('mmClose').addEventListener('click', () => setWinOpen('mm', false));
$('bmMin').addEventListener('click', () => setWinMin('bm', !WIN.bm.min));
$('bmClose').addEventListener('click', () => toggleBigMap());

enableDrag($('minimapWrap'), $('minimapBar'));
enableDrag($('cluePanel'), $('panelToggle'));
enableDrag($('bigMapPanel'), $('bigMapBar'));

$('clueList').style.flex = '1';
$('clueList').style.minHeight = '0';
addResizeHandle($('minimapWrap'), (w, h) => {
  const s = Math.round(clamp(Math.min(w, h - 34), 150, 430));
  const c = $('minimap');
  c.width = c.height = s;
  if (G.phase === 'seek') drawMap(c.getContext('2d'), s, false);
});
addResizeHandle($('cluePanel'), (w, h) => {
  const p = $('cluePanel');
  p.style.width = clamp(w, 230, 560) + 'px';
  p.style.height = clamp(h, 110, innerHeight - 30) + 'px';
  p.style.maxHeight = 'none';
});
addResizeHandle($('bigMapPanel'), (w, h) => {
  const s = Math.round(clamp(Math.min(w - 40, h - 150), 300, 760));
  const c = $('bigMap');
  c.width = c.height = s;
  drawMap(c.getContext('2d'), s, true);
});

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
  camera.far = 900; camera.updateProjectionMatrix();
  if (G.citySel !== 'town' && window.CITY_DATA && window.CITY_DATA[G.citySel]) {
    G.city = genRealCity(G.citySel);
  } else {
    G.city = genCity();
    makeCars(G.city);
  }
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
    G.seekers.push({ name: G.mSeekers > 1 ? t('seeker_n', i + 1) : t('you'), captures: 0, earned: 0 });
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
  flyCam.x = 0; flyCam.y = G.city.kind === 'real' ? 240 : 110; flyCam.z = G.city.kind === 'real' ? 200 : 90;
  player.yaw = 0; player.pitch = -0.85;
  makeSpotMarkers();
  showTurnOverlay(t('hide_turn', G.hideIdx + 1), t('hide_turn_sub'), () => {
    updateHideBanner();
  });
}

function updateHideBanner() {
  $('hideBannerText').textContent = t('hide_banner', G.hideIdx + 1, G.nHiders);
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
  $('spotDesc').innerHTML = t('clue_desc', spot.label, TYPE_NAME[spot.blockType] || '');
  const chips = $('hintChips');
  chips.innerHTML = '';
  spotHints(spot).forEach((h) => {
    const c = document.createElement('span');
    c.className = 'chip';
    c.textContent = '+ ' + h.txt;
    c.addEventListener('click', () => {
      const ta = $('clueInput');
      ta.value = ta.value ? ta.value.replace(/[。.；;]?\s*$/, '') + (LANG === 'zh' ? '；' : '; ') + h.txt : h.txt;
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
  const label = t('hider_n', G.hideIdx + 1);
  G.hiders.push(createHider(spot, `${label}·${nm}`, emoji, text + (LANG === 'zh' ? '。' : '.'), bounty, true, label));
  closeClueModal();
  AudioSys.coin();
  // 移除被占的标记
  const mk = spotMarkers.find((m) => m.userData.spot === spot);
  if (mk) { scene.remove(mk); spotMarkers.splice(spotMarkers.indexOf(mk), 1); }
  G.hideIdx++;
  if (G.hideIdx < G.nHiders) {
    flyCam.x = 0; flyCam.y = G.city.kind === 'real' ? 240 : 110; flyCam.z = G.city.kind === 'real' ? 200 : 90;
    player.yaw = R(0, Math.PI * 2); player.pitch = -0.85;
    showTurnOverlay(t('hide_turn', G.hideIdx + 1), t('hide_turn_sub'), updateHideBanner);
  } else {
    clearSpotMarkers();
    $('hideBanner').classList.add('hidden');
    showTurnOverlay(t('seek_go'), t('seek_go_sub'), beginSeekPhase);
  }
});

/* ---- 寻找阶段 ---- */
function beginSeekPhase() {
  G.phase = 'seek';
  G.paused = false;
  G.hiders.forEach((h) => { h.mesh.visible = !h.found; });
  // 出生点
  if (G.city.spawn) {
    [player.x, player.z] = collide(G.city.spawn.x, G.city.spawn.z);
  } else {
    player.x = blockCenter(3) + 2;
    player.z = blockCenter(3) + 16;
  }
  player.yaw = (G.city.spawn && G.city.spawn.yaw) || Math.PI;
  player.pitch = -0.18;
  player.riding = null;
  player.tv = null;
  player.bikeMesh.visible = false;
  player.stamina = 100;
  if (G.city.bus) G.city.bus.riding = false;
  if (G.city.vehicles) G.city.vehicles.forEach((v) => { v.riding = false; });
  G.turnTimer = 75;
  $('hud').classList.remove('hidden');
  $('hideBanner').classList.add('hidden');
  updateHUD();
  renderCluePanel();
  if (G.mode === 'ai') {
    showToast(t('toast_ai_ready', G.nHiders), 'gold');
  } else {
    showToast(t('toast_hot_ready'), 'gold');
  }
  if (G.seekers.length > 1) {
    showTurnOverlay(t('turn_first', G.seekers[0].name), t('turn_rotate'), null);
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
  showTurnOverlay(t('turn_next', G.seekers[G.curSeeker].name), t('turn_next_sub'), null);
  updateHUD();
}

/* ---- 结算 ---- */
function endGame(allFound) {
  G.phase = 'end';
  $('hud').classList.add('hidden');
  const bonus = allFound ? Math.round(G.timeLeft) : 0;
  const finalScore = G.credits + bonus;
  $('endTitle').innerHTML = allFound ? t('end_win') : t('end_lose');
  $('endSub').textContent = allFound
    ? t('end_win_sub', bonus)
    : t('end_lose_sub', G.hiders.filter((h) => !h.found).length);
  let html = `<table class="result"><tr><th>${t('th_hider')}</th><th>${t('th_bounty')}</th><th>${t('th_result')}</th></tr>`;
  G.hiders.forEach((h) => {
    html += `<tr><td>${h.emoji} ${h.name}</td><td class="gold">${h.bounty}💰</td>` +
      (h.found ? `<td class="teal">${t('found_by', h.foundBy)}</td>` : `<td class="redt">${t('survived')}</td>`) + `</tr>`;
  });
  html += `</table>`;
  if (G.seekers.length > 1) {
    html += `<table class="result"><tr><th>${t('th_seeker')}</th><th>${t('th_caught')}</th><th>${t('th_earned')}</th></tr>`;
    [...G.seekers].sort((a, b) => b.earned - a.earned).forEach((s) => {
      html += `<tr><td>🧢 ${s.name}</td><td>${t('persons', s.captures)}</td><td class="gold">${s.earned}💰</td></tr>`;
    });
    html += `</table>`;
  }
  html += `<div style="font-size:15px;line-height:2">${t('end_total', G.earned, G.spent, finalScore)}</div>`;
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

/* 管理员：世界倍速 */
{
  const slider = $('simSpeed'), val = $('simSpeedVal');
  const renderSim = () => { val.textContent = t('admin_val', SIM.mul); };
  slider.value = SIM.mul;
  renderSim();
  slider.addEventListener('input', () => {
    SIM.mul = parseInt(slider.value, 10);
    localStorage.setItem('hs_simMul', String(SIM.mul));
    renderSim();
  });
}

/* 城市选择 */
document.querySelectorAll('.cityCard').forEach((card) => {
  card.addEventListener('click', () => {
    AudioSys.ensure();
    if (card.classList.contains('locked')) {
      AudioSys.deny();
      const small = card.querySelector('small');
      const orig = small.textContent;
      small.textContent = t('city_wip');
      setTimeout(() => { small.textContent = orig; }, 1200);
      return;
    }
    if (G.citySel === card.dataset.city) return;
    G.citySel = card.dataset.city;
    document.querySelectorAll('.cityCard').forEach((c2) => c2.classList.toggle('sel', c2 === card));
    AudioSys.click();
    resetWorld(); // 立即切换菜单背景到所选城市
    menuOrbit = 0;
  });
});

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
  const dt = clamp((now - lastT) / 1000, 0, 0.1);
  lastT = now;
  const t = now / 1000;
  G.now = t;

  const isLondon = G.city && G.city.kind === 'real';
  const cityAmbient = () => {
    if (isLondon) updateLondon(dt, t);
    else { updateCars(dt); updateBus(dt); }
  };
  if (G.phase === 'menu') {
    // 菜单背景：缓慢环绕城市
    menuOrbit += dt * 0.08;
    const oR = G.city.orbitR || 190, oH = G.city.orbitH || 110;
    camera.position.set(Math.cos(menuOrbit) * oR, oH, Math.sin(menuOrbit) * oR);
    camera.lookAt(0, 0, 0);
    cityAmbient();
  } else if (G.phase === 'hide') {
    updateFlyCam(dt);
    // 标记呼吸动画
    spotMarkers.forEach((m, i) => {
      const disc = m.userData.disc;
      disc.scale.setScalar(1 + Math.sin(t * 3 + i) * 0.18);
      disc.material.opacity = 0.55 + Math.sin(t * 3 + i) * 0.25;
    });
    cityAmbient();
  } else if (G.phase === 'seek' && !G.paused) {
    G.timeLeft -= dt;
    if (G.timeLeft <= 0) { endGame(false); }
    updatePlayer(dt);
    cityAmbient();
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
      let inPark = false;
      if (isLondon) {
        inPark = G.city.parks.some((pk) => {
          const dx = (player.x - pk.p[0]) / pk.rx, dz = (player.z - pk.p[1]) / pk.rz;
          return dx * dx + dz * dz < 1;
        });
      } else {
        const bi = clamp(Math.floor((player.x + HALF - ROAD / 2) / CELL), 0, 6);
        const bj = clamp(Math.floor((player.z + HALF - ROAD / 2) / CELL), 0, 6);
        const bt = blockType(bi, bj);
        inPark = bt === 'park' || bt === 'pond';
      }
      if (inPark) AudioSys.chirp();
    }
    // 交互提示
    updateInteractPrompt();
    // HUD 时间
    updateHUD();
    // 小地图节流（窗口关闭/最小化时不绘制）
    miniTimer -= dt;
    if (miniTimer <= 0) {
      miniTimer = 0.12;
      if (WIN.mm.open && !WIN.mm.min) drawMap($('minimap').getContext('2d'), $('minimap').width, false);
      if (bigMapOpen) drawMap($('bigMap').getContext('2d'), $('bigMap').width, true);
    }
  } else if (G.phase === 'end') {
    menuOrbit += dt * 0.05;
    const oR = (G.city.orbitR || 190) * 0.8, oH = (G.city.orbitH || 110) * 0.8;
    camera.position.set(Math.cos(menuOrbit) * oR, oH, Math.sin(menuOrbit) * oR);
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
  const onVehicle = player.riding === 'bus' || player.riding === 'transit';
  if (near && near.d < 3.2 && !onVehicle) {
    setPrompt(t('p_catch', near.hider.emoji, near.hider.name));
    return;
  }
  if (G.city.kind === 'real') {
    if (player.riding === 'transit') {
      const v = player.tv;
      setPrompt(v && v.state === 'dwell'
        ? t('p_transit_arr', v.curStop ? v.curStop.name : '')
        : t('p_transit_run', v ? vIcon(v) : '🚌', v ? v.line : ''));
      return;
    }
    const v = transitNear();
    if (v && player.riding === null) {
      setPrompt(t('p_transit_board', vIcon(v), v.line, v.cost));
      return;
    }
  } else {
    const bus = G.city.bus;
    if (player.riding === 'bus') {
      setPrompt(bus.dwell > 0 ? t('p_bus_arr') : t('p_bus_run'));
      return;
    }
    const busD = dist2d(player.x, player.z, bus.mesh.position.x, bus.mesh.position.z);
    if (busD < 6 && bus.dwell > 0 && player.riding !== 'bike') {
      setPrompt(t('p_bus_board', COST.bus));
      return;
    }
  }
  const st = G.city.bikeStations.find((s) => dist2d(player.x, player.z, s.x, s.z) < 7);
  if (st && player.riding === null) {
    setPrompt(t('p_bike', COST.bike));
    return;
  }
  if (near && near.d < 14) {
    setPrompt(t('p_rustle'));
    return;
  }
  setPrompt('');
}

/* ---- 玩家自定义形象 ---- */
function initAvatarUI() {
  const rows = [
    ['av_skin', 'skin', SKIN_TONES],
    ['av_shirt', 'shirt', CLOTH_TONES],
    ['av_pants', 'pants', PANTS_TONES],
    ['av_hair', 'hair', HAIR_TONES],
  ];
  const cur = playerPalette();
  const wrap = $('avRows');
  wrap.innerHTML = '';
  rows.forEach(([labelKey, key, tones]) => {
    const row = document.createElement('div');
    row.className = 'avRow';
    row.innerHTML = `<label>${t(labelKey)}</label>`;
    const sw = document.createElement('div');
    sw.className = 'avSwatches';
    tones.forEach((hex) => {
      const b = document.createElement('button');
      b.className = 'avSw' + (cur[key] === hex ? ' on' : '');
      b.style.background = '#' + hex.toString(16).padStart(6, '0');
      b.addEventListener('click', () => {
        cur[key] = hex;
        sw.querySelectorAll('.avSw').forEach((x) => x.classList.remove('on'));
        b.classList.add('on');
      });
      sw.appendChild(b);
    });
    row.appendChild(sw);
    wrap.appendChild(row);
  });
  $('avSave').onclick = () => {
    localStorage.setItem('ct_avatar', JSON.stringify(cur));
    rebuildPlayerMesh();
    $('avatarModal').classList.add('hidden');
    AudioSys.coin();
  };
  $('avRandom').onclick = () => {
    Object.assign(cur, makeHumanPalette());
    localStorage.setItem('ct_avatar', JSON.stringify(cur));
    initAvatarUI();
  };
  $('avClose').onclick = () => $('avatarModal').classList.add('hidden');
}
$('avatarBtn').addEventListener('click', () => {
  AudioSys.click();
  initAvatarUI();
  $('avatarModal').classList.remove('hidden');
});

/* ---- 静态界面文案（i18n） ---- */

function applyStaticLang() {
  document.title = LANG === 'zh' ? 'CityTwin · 城市孪生躲猫猫' : 'CityTwin · City-Twin Hide & Seek';
  const q = (sel) => document.querySelector(sel);
  q('#menu .sub').innerHTML = t('sub');
  q('#modeAI h3').textContent = t('mode_ai_h');
  q('#modeAI p').textContent = t('mode_ai_p');
  q('#modeHot h3').textContent = t('mode_hot_h');
  q('#modeHot p').textContent = t('mode_hot_p');
  $('lblHiders').textContent = t('cfg_hiders');
  $('lblSeekers').textContent = t('cfg_seekers');
  $('lblDiff').textContent = t('cfg_diff');
  $('lblTime').textContent = t('cfg_time');
  [...$('difficulty').options].forEach((o, i) => { o.text = t('diff')[i]; });
  [...$('timeLimit').options].forEach((o, i) => { o.text = t('times')[i]; });
  $('startBtn').textContent = t('btn_start');
  $('avatarBtn').textContent = t('av_btn');
  $('avTitle').textContent = t('av_title');
  $('avSave').textContent = t('av_save');
  $('avRandom').textContent = t('av_random');
  $('controlsHelp').innerHTML = t('help');
  $('lblAdmin').textContent = t('admin_label');
  $('adminHint').textContent = t('admin_hint');
  // 城市卡
  const flags = { london: '🇬🇧', istanbul: '🇹🇷', dubai: '🇦🇪', shanghai: '🇨🇳', newyork: '🇺🇸' };
  document.querySelectorAll('.cityCard').forEach((card) => {
    const c = card.dataset.city;
    if (c === 'town') {
      card.innerHTML = `${t('city_town')}<small>${t('city_town_sub')}</small>`;
    } else if (window.CITY_DATA && window.CITY_DATA[c]) {
      card.innerHTML = `${flags[c]} ${t('city_names')[c]}<small>${t('city_london_sub')}</small><span class="new">NEW</span>`;
      card.classList.remove('locked');
    } else {
      card.innerHTML = `${flags[c]} ${t('city_names')[c]}<small>${t('city_soon')}</small>`;
    }
  });
  // HUD
  $('smCredits').textContent = t('hud_credits');
  $('smTime').textContent = t('hud_time');
  $('smFound').textContent = t('hud_found');
  $('smSeeker').textContent = t('hud_seeker');
  $('panelTitle').textContent = t('panel_title');
  $('mmTitle').textContent = t('mm_title');
  $('mmMin').title = t('mm_min'); $('mmClose').title = t('mm_close');
  $('cpMin').title = t('mm_min'); $('cpClose').title = t('mm_close');
  $('bmMin').title = t('mm_min'); $('bmClose').title = t('mm_close');
  const abKeys = { radar: ['ab_radar', 'R'], map: ['ab_taxi', 'M'], bike: ['ab_bike', 'B'], view: ['ab_view', 'V'], pause: ['ab_menu', 'Esc'] };
  document.querySelectorAll('.abtn').forEach((b) => {
    const [k, kbd] = abKeys[b.dataset.act];
    b.innerHTML = `${t(k)} <kbd>${kbd}</kbd>`;
  });
  $('hideHelp').innerHTML = t('hide_help');
  $('clueH2').textContent = t('clue_h2');
  $('chipsHint').textContent = t('clue_chips');
  $('clueInput').placeholder = t('clue_ph');
  $('lblBounty').textContent = t('clue_bounty');
  $('clueCancel').textContent = t('clue_cancel');
  $('clueOk').textContent = t('clue_ok');
  $('mapHint').innerHTML = t('map_hint') + '<span id="mapCost">--</span>';
  $('mapClose').textContent = t('map_close');
  $('bmTitle').textContent = t('map_title');
  q('#pauseMenu h2').textContent = t('pause_h');
  $('resumeBtn').textContent = t('pause_resume');
  $('quitBtn').textContent = t('pause_quit');
  $('againBtn').textContent = t('end_again');
  $('backMenuBtn').textContent = t('end_back');
  // “已找到”角标（CSS content）
  const st = document.createElement('style');
  st.textContent = `.clueCard.found .who::after { content: "${t('found_tag')}"; }`;
  document.head.appendChild(st);
  // 语言按钮
  document.querySelectorAll('.langBtn').forEach((b) => {
    b.classList.toggle('on', b.dataset.lang === LANG);
    b.addEventListener('click', () => { if (b.dataset.lang !== LANG) setLang(b.dataset.lang); });
  });
}

/* ---- 启动 ---- */
applyStaticLang();
resetWorld();
updateHUD();
tick();

// 调试钩子（仅用于自动化测试/研究地图）
window.__hs = { G, player, camera, markers: () => spotMarkers, capture: captureHider };

})();
