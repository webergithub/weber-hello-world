// G-ENG-1 mesh 回归夹具主入口（③E0 出口标准）：
//   node tests/mesh-fixture/run.mjs
// 覆盖：分片重组 / msgId 去重 / 多跳 TTL 泛洪与耗尽 / 队伍过滤 / 记账结算 / 协议常量防漂移
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Radio, SimNode, busEncode, busDecode, HEADER, PAYLOAD, MAX_TTL } from './meshsim.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
let failures = 0
function check(name, cond, detail = '') {
  if (cond) console.log(`  ✅ ${name}`)
  else { console.log(`  ❌ ${name} ${detail}`); failures++ }
}

// ---------- 1. 分片与重组 ----------
console.log('[1] 分片重组（>180B 载荷）')
{
  const radio = new Radio()
  const a = new SimNode('A'), b = new SimNode('B')
  radio.add(a); radio.add(b); radio.link('A', 'B')
  const payload = Buffer.alloc(500, 7)
  a.send(payload)
  check('500B 拆 3 片发送', a.framesSent === Math.ceil(500 / PAYLOAD) && a.framesSent === 3, `sent=${a.framesSent}`)
  check('B 重组还原逐字节相等', b.delivered.length === 1 && b.delivered[0].equals(payload))
}

// ---------- 2. msgId 去重 ----------
console.log('[2] 去重（菱形拓扑 A-B、A-C、B-D、C-D：D 从两路收同一消息）')
{
  const radio = new Radio()
  const [a, b, c, d] = ['A', 'B', 'C', 'D'].map(id => new SimNode(id))
  ;[a, b, c, d].forEach(n => radio.add(n))
  radio.link('A', 'B'); radio.link('A', 'C'); radio.link('B', 'D'); radio.link('C', 'D')
  a.send(Buffer.from('hello camp'))
  check('B、C 各收 1 次', b.delivered.length === 1 && c.delivered.length === 1)
  check('D 经两路中继仍只投递 1 次', d.delivered.length === 1, `got=${d.delivered.length}`)
}

// ---------- 3. 多跳 TTL：可达边界与耗尽 ----------
console.log(`[3] 多跳 TTL 泛洪（MAX_TTL=${MAX_TTL}：链上第 1+${MAX_TTL} 台可达，再远不可达）`)
{
  const radio = new Radio()
  const ids = ['A', 'B', 'C', 'D', 'E', 'F']
  const nodes = ids.map(id => new SimNode(id))
  nodes.forEach(n => radio.add(n))
  for (let i = 0; i < ids.length - 1; i++) radio.link(ids[i], ids[i + 1]) // 仅相邻可达的链
  nodes[0].send(Buffer.from('relay me'))
  // 源 A 以 ttl=4 发出：B(4)→C(3)→D(2)→E(1)。E 收到但 ttl=1 不再转发。
  check('E（第 4 跳）收到', nodes[4].delivered.length === 1)
  check('F（第 5 跳）不可达——TTL 耗尽', nodes[5].delivered.length === 0, `got=${nodes[5].delivered.length}`)
}

// ---------- 4. MeshBus 队伍过滤 ----------
console.log('[4] MeshBus 信封与队伍过滤')
{
  const radio = new Radio()
  const a = new SimNode('A'), b = new SimNode('B')
  radio.add(a); radio.add(b); radio.link('A', 'B')
  const msg = busEncode(1, 'K7Q9ZP', Buffer.from(JSON.stringify({ mid: 'm1', n: '我', t: '3号位集合', ts: 0 })))
  a.send(msg)
  const sameTeam = busDecode(b.delivered[0], 'K7Q9ZP')
  const otherTeam = busDecode(b.delivered[0], 'public')
  check('同队伍码解出 kind=1 与正文', sameTeam !== null && sameTeam.kind === 1 && JSON.parse(sameTeam.body.toString()).t === '3号位集合')
  check('异队伍码被过滤（返回 null）', otherTeam === null)
  check('team 超 32 字节被截断', busEncode(1, 'X'.repeat(40), Buffer.alloc(0))[1] === 32)
}

// ---------- 5. 记账结算（③E0：4 家账目断言笔数与金额） ----------
console.log('[5] 记账结算：web 真实 split.ts 与原生算法逐人一致 + 最优转账')
{
  const { execSync } = await import('node:child_process')
  const bundle = join(ROOT, 'tests/mesh-fixture/.split.bundle.mjs')
  execSync(`${join(ROOT, 'node_modules/.bin/esbuild')} ${join(ROOT, 'src/features/ledger/split.ts')} --bundle --format=esm --outfile=${bundle}`, { stdio: 'pipe' })
  const { shareOf, summarize, settlements } = await import(bundle)

  const nativeShares = (e) => {   // LedgerModel.swift:34-49 / Ledger.kt:16-28 复刻
    const ids = e.participantIds, r = {}
    const base = Math.floor(e.amountCents / ids.length)
    let alloc = 0
    ids.forEach((id, i) => { if (i === ids.length - 1) r[id] = e.amountCents - alloc; else { r[id] = base; alloc += base } })
    return r
  }
  const ids = ['me', 'ming', 'qiang', 'li']
  const mk = (cents, payerId) => ({ id: 'e' + cents, title: 't', payerId, amountCents: cents, participantIds: ids, mode: 'equal', ts: 0 })

  let parity = true
  for (const cents of [50, 101, 103, 999, 60007]) {
    const web = shareOf(mk(cents, 'me')), nat = nativeShares(mk(cents, 'me'))
    for (const id of ids) if (web[id] !== nat[id]) parity = false
  }
  check('5 组除不尽金额逐人与原生全等', parity)

  // 与模拟测试报告同一批账目：240/600/320/180 元
  const members = ids.map(id => ({ id, nickname: id }))
  const expenses = [mk(24000, 'me'), mk(60000, 'qiang'), mk(32000, 'ming'), mk(18000, 'li')]
  const summ = summarize(members, expenses)
  const net = Object.fromEntries(summ.map(s => [s.memberId, s.net]))
  check('净额正确（阿强 +26500，我 -9500，小明 -1500，丽姐 -15500）',
    net.qiang === 26500 && net.me === -9500 && net.ming === -1500 && net.li === -15500, JSON.stringify(net))
  const ts = settlements(summ)   // web Transfer 字段为 {from,to,amount}（settle.ts）
  const toQiang = ts.filter(t => t.to === 'qiang').reduce((a, t) => a + t.amount, 0)
  check('最优转账恰 3 笔且全部汇向阿强、合计 26500', ts.length === 3 && toQiang === 26500, JSON.stringify(ts))
}

// ---------- 5b. 备份往返（G-LG-1：导出→导入完整还原；坏文件拒绝） ----------
console.log('[5b] 备份导出/导入（web 真实 backup.ts）')
{
  const { execSync } = await import('node:child_process')
  const bundle = join(ROOT, 'tests/mesh-fixture/.backup.bundle.mjs')
  execSync(`${join(ROOT, 'node_modules/.bin/esbuild')} ${join(ROOT, 'src/lib/backup.ts')} --bundle --format=esm --outfile=${bundle}`, { stdio: 'pipe' })
  const { exportState, importState } = await import(bundle)

  const state = {
    groups: [{
      id: 'g1', name: '五一露营', code: 'K7Q9ZP', createdAt: 1, myMemberId: 'm1',
      members: [{ id: 'm1', nickname: '我', isMe: true }, { id: 'm2', nickname: '小明' }],
      expenses: [{ id: 'e1', title: '过路费', payerId: 'm1', amountCents: 24000, participantIds: ['m1', 'm2'], mode: 'equal', ts: 2 }],
    }],
    activeGroupId: 'g1',
  }
  const roundtrip = importState(exportState(state, 123))
  check('导出→导入 深度相等（群组/成员/账目完整还原）', JSON.stringify(roundtrip) === JSON.stringify(state))
  check('非 JSON 拒绝', importState('not json{{{') === null)
  check('缺 magic 拒绝', importState(JSON.stringify({ version: 1, state })) === null)
  check('activeGroupId 失效时回退到首个群组',
    importState(exportState({ ...state, activeGroupId: 'gone' }, 1))?.activeGroupId === 'g1')
}

// ---------- 6. 协议常量防漂移（对 Swift/Kotlin 源码 grep 比对） ----------
console.log('[6] 协议常量防漂移（夹具 vs BleMesh.swift vs BleMesh.kt）')
{
  const swift = readFileSync(join(ROOT, 'ios12/Sources/Camp/BleMesh.swift'), 'utf8')
  const kotlin = readFileSync(join(ROOT, 'android-native/app/src/main/java/cc/trailmate/app/BleMesh.kt'), 'utf8')
  const S_UUID = '7b2f9a10-4c3d-4b8e-9f21-0a1b2c3d4e5f'
  const C_UUID = '7b2f9a11-4c3d-4b8e-9f21-0a1b2c3d4e5f'
  check('Service UUID 两端一致', swift.toLowerCase().includes(S_UUID) && kotlin.toLowerCase().includes(S_UUID))
  check('Char UUID 两端一致', swift.toLowerCase().includes(C_UUID) && kotlin.toLowerCase().includes(C_UUID))
  const grab = (src, re) => Number((src.match(re) ?? [])[1])
  check(`HEADER=${HEADER} 与两端一致`,
    grab(swift, /HEADER = (\d+)/) === HEADER && grab(kotlin, /HEADER = (\d+)/) === HEADER)
  check(`PAYLOAD=${PAYLOAD} 与两端一致`,
    grab(swift, /PAYLOAD = (\d+)/) === PAYLOAD && grab(kotlin, /PAYLOAD = (\d+)/) === PAYLOAD)
  check(`MAX_TTL=${MAX_TTL} 与两端一致`,
    grab(swift, /MAX_TTL = (\d+)/) === MAX_TTL && grab(kotlin, /MAX_TTL = (\d+)/) === MAX_TTL)
}

// ---------- 7. 信令服务器鉴权与限流（G-SEC-1，破坏性：错 token 必须被拒） ----------
console.log('[7] 信令服务器（真实进程 + 真实 ws 客户端）')
{
  const { spawn } = await import('node:child_process')
  const { WebSocket } = await import('ws')
  const PORT = 18787
  const TOKEN = 'test-secret'
  const srv = spawn('node', [join(ROOT, 'server/signaling.js')], {
    env: { ...process.env, PORT: String(PORT), SIGNAL_TOKEN: TOKEN },
    stdio: 'pipe',
  })
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('server start timeout')), 5000)
    srv.stdout.on('data', (d) => { if (String(d).includes('已启动')) { clearTimeout(t); res() } })
  })

  const connect = () => new Promise((res, rej) => {
    const c = new WebSocket(`ws://127.0.0.1:${PORT}`)
    c.on('open', () => res(c)); c.on('error', rej)
  })
  const nextEvent = (c, ms = 2000) => new Promise((res) => {
    const t = setTimeout(() => res({ kind: 'timeout' }), ms)
    c.once('message', (d) => { clearTimeout(t); res({ kind: 'message', data: JSON.parse(String(d)) }) })
    c.once('close', (code) => { clearTimeout(t); res({ kind: 'close', code }) })
  })

  // 错 token → 4003 拒绝
  const bad = await connect()
  bad.send(JSON.stringify({ type: 'join', room: 'r1', peerId: 'p-bad', token: 'wrong' }))
  const badRes = await nextEvent(bad)
  check('错 token 被断开（4003），拿不到房间名单', badRes.kind === 'close' && badRes.code === 4003, JSON.stringify(badRes))

  // 对 token → 收到 peers 名单
  const good = await connect()
  good.send(JSON.stringify({ type: 'join', room: 'r1', peerId: 'p-good', token: TOKEN }))
  const goodRes = await nextEvent(good)
  check('正确 token 入房，收到 peers 名单', goodRes.kind === 'message' && goodRes.data.type === 'peers')

  // 未 join 的连接不允许转发（不携带 token 直接发 signal）
  const sneak = await connect()
  sneak.send(JSON.stringify({ type: 'signal', to: 'p-good', from: 'x', data: 'evil' }))
  const sneakRes = await nextEvent(good, 1200)
  check('未鉴权连接的 signal 不被转发', sneakRes.kind === 'timeout', JSON.stringify(sneakRes))

  // 限流：狂发 100 条 → 4008 断开
  const flood = await connect()
  flood.send(JSON.stringify({ type: 'join', room: 'r2', peerId: 'p-flood', token: TOKEN }))
  await nextEvent(flood)
  const floodClosed = new Promise((res) => flood.once('close', (code) => res(code)))
  for (let i = 0; i < 100; i++) flood.send(JSON.stringify({ type: 'signal', to: 'nobody', from: 'p-flood', data: i }))
  const floodCode = await Promise.race([floodClosed, new Promise((r) => setTimeout(() => r(0), 3000))])
  check('100 条/瞬时 触发限流断开（4008）', floodCode === 4008, `code=${floodCode}`)

  for (const c of [bad, good, sneak, flood]) { try { c.close() } catch {} }
  srv.kill()
}

// ---------- 8. 端到端加密（G-CM-3：往返/错队伍拒/篡改拒/固定向量锁管线） ----------
console.log('[8] MeshCrypto 端到端加密')
{
  const mc = await import('./meshcrypto.mjs')
  const plain = Buffer.from(JSON.stringify({ mid: 'm1', n: '我', t: '3号位集合', ts: 0 }), 'utf8')

  const blob = mc.encrypt('K7Q9ZP', plain)
  check('往返：同队伍解密还原', mc.decrypt('K7Q9ZP', blob)?.equals(plain) === true)
  check('错队伍码解密失败（返回 null）', mc.decrypt('public', blob) === null)
  const tampered = Buffer.from(blob); tampered[20] ^= 0xff
  check('密文被篡改 1 字节即拒（MAC 不过）', mc.decrypt('K7Q9ZP', tampered) === null)
  const badVer = Buffer.from(blob); badVer[0] = 9
  check('版本字节不符即拒', mc.decrypt('K7Q9ZP', badVer) === null)
  check('旧版明文 JSON 直接喂入即拒', mc.decrypt('K7Q9ZP', plain) === null)
  const chat100 = mc.encrypt('K7Q9ZP', Buffer.alloc(100, 65))
  check('100B 聊天加密后 ≤180B 仍单片', chat100.length === 1 + 16 + 112 + 16 && chat100.length <= 180, `len=${chat100.length}`)

  // 固定向量：锁死 PBKDF2(10000,盐)+AES-256-CBC+HMAC 截断的整条管线；
  // 同一向量写在 iOS/Android 实现注释中，真机可手工比对
  const iv = Buffer.from(Array.from({ length: 16 }, (_, i) => i))
  const vec = mc.encryptWithIv('K7Q9ZP', Buffer.from('hello camp', 'utf8'), iv)
  check('跨平台固定向量一致',
    vec.toString('hex') === '01000102030405060708090a0b0c0d0e0f93b370e0c48f2abe2f1bb1cdd2b5bf23592198c85af6ed3ae0adbe52a60157e6',
    vec.toString('hex'))

  // 常量防漂移：三端盐/轮数/版本/MAC 长度一致
  const swiftSrc = readFileSync(join(ROOT, 'ios12/Sources/Mesh/MeshCrypto.swift'), 'utf8')
  const ktSrc = readFileSync(join(ROOT, 'android-native/app/src/main/java/cc/trailmate/app/MeshCrypto.kt'), 'utf8')
  check('盐 trailmate-mesh-v1 三端一致', swiftSrc.includes('trailmate-mesh-v1') && ktSrc.includes('trailmate-mesh-v1'))
  check('迭代 10000 三端一致', /10000/.test(swiftSrc) && /10000/.test(ktSrc) && mc.ITER === 10000)
  check('MAC 截断 16 三端一致', /MAC_LEN = 16/.test(swiftSrc) && /MAC_LEN = 16/.test(ktSrc) && mc.MAC_LEN === 16)
}

// ---------- 9. 短语音（G-CM-1：载荷格式往返 + 9KB 大载荷过 mesh + 常量防漂移） ----------
console.log('[9] 营地短语音')
{
  // 载荷格式 [u16 jsonLen][json][m4a]，与 CampFragment.kt / CampViewController.swift 一致
  const meta = Buffer.from(JSON.stringify({ mid: 'v1', n: '我', d: 3.2, ts: 0 }), 'utf8')
  const m4a = Buffer.alloc(9000, 0xAB)   // ≈3s AAC@24kbps
  const payload = Buffer.concat([Buffer.from([(meta.length >> 8) & 0xff, meta.length & 0xff]), meta, m4a])
  const jlen = (payload[0] << 8) | payload[1]
  const parsedMeta = JSON.parse(payload.subarray(2, 2 + jlen).toString('utf8'))
  const parsedBin = payload.subarray(2 + jlen)
  check('语音载荷 [u16][json][m4a] 往返解析', parsedMeta.mid === 'v1' && parsedMeta.d === 3.2 && parsedBin.equals(m4a))

  // 9KB 载荷经 BLE 分片泛洪仍完整送达（约 51 片）
  const radio = new Radio()
  const a = new SimNode('A'), b = new SimNode('B'), c = new SimNode('C')
  ;[a, b, c].forEach(n => radio.add(n))
  radio.link('A', 'B'); radio.link('B', 'C')   // C 只能经 B 中继
  a.send(payload)
  check(`9KB 语音拆 ${Math.ceil(payload.length / PAYLOAD)} 片，B 直收完整`, b.delivered.length === 1 && b.delivered[0].equals(payload))
  check('C 经中继收到完整语音', c.delivered.length === 1 && c.delivered[0].equals(payload))

  // kindVoice=3 三端一致
  const swiftBus = readFileSync(join(ROOT, 'ios12/Sources/Mesh/MeshBus.swift'), 'utf8')
  const ktBus = readFileSync(join(ROOT, 'android-native/app/src/main/java/cc/trailmate/app/MeshBus.kt'), 'utf8')
  check('kindVoice=3 双端一致', /kindVoice: UInt8 = 3/.test(swiftBus) && /KIND_VOICE: Byte = 3/.test(ktBus))

  // 码字符集三端一致（G-PF-1）
  const CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const idTs = readFileSync(join(ROOT, 'src/lib/id.ts'), 'utf8')
  const identSwift = readFileSync(join(ROOT, 'ios12/Sources/Mesh/Identity.swift'), 'utf8')
  check('6 位码字符集三端一致', idTs.includes(CHARSET) && identSwift.includes(CHARSET) && ktBus.includes(CHARSET))
}

// ---------- 10. 保时长变声 WSOLA（G-VC-2：长度守恒 + 主频精确 ×f） ----------
console.log('[10] Android 保时长变调 WSOLA')
{
  const { pitchPreserve, dominantHz, SR } = await import('./pitchshift.mjs')
  const F0 = 200
  const src = new Int16Array(Math.trunc(SR * 0.5))
  for (let i = 0; i < src.length; i++) src[i] = Math.round(12000 * Math.sin((2 * Math.PI * F0 * i) / SR))
  const baseHz = dominantHz(src)
  let allOk = true
  for (const f of [1.45, 1.7, 1.6, 1.25, 0.72, 1.9, 0.6]) {   // 与 VoiceFragment 预设一致
    const out = pitchPreserve(src, f)
    let nan = false, peak = 0
    for (const v of out) { if (!Number.isFinite(v)) nan = true; peak = Math.max(peak, Math.abs(v)) }
    const ratio = dominantHz(out) / baseHz
    if (!(out.length === src.length && !nan && peak > 2000 && Math.abs(ratio - f) / f < 0.08)) {
      allOk = false; console.log(`    f=${f} → ×${ratio.toFixed(2)} peak=${peak}`)
    }
  }
  check('7 个预设：长度守恒 + 主频精确 ×f + 无削波/NaN', allOk)
  check('原声 f=1.0 原样返回', pitchPreserve(new Int16Array([1, 2, 3]), 1.0).length === 3)
}

// ---------- 11. 送达回执（G-CM-2：A→B→回执→A 计数；跨中继；不为他人消息计数） ----------
console.log('[11] 送达回执')
{
  const KIND_CHAT = 1, KIND_ACK = 4
  // 链 A-B-C：C 只能经 B 中继，回执也要能走回程中继
  const radio = new Radio()
  const nodes = { A: new SimNode('A'), B: new SimNode('B'), C: new SimNode('C') }
  Object.values(nodes).forEach(n => radio.add(n))
  radio.link('A', 'B'); radio.link('B', 'C')

  // 模拟营地逻辑：每台机 seen/myMids/ackBy + 收到聊天即回执
  const app = {}
  for (const id of ['A', 'B', 'C']) {
    app[id] = { seen: new Set(), myMids: new Set(), ackBy: new Map() }
    const me = app[id]
    const node = nodes[id]
    node.onBus = (frame) => {
      const d = busDecode(frame, 'K7Q9ZP')
      if (!d) return
      const msg = JSON.parse(d.body.toString('utf8'))
      if (d.kind === KIND_CHAT) {
        if (me.seen.has(msg.mid)) return
        me.seen.add(msg.mid)
        node.send(busEncode(KIND_ACK, 'K7Q9ZP', Buffer.from(JSON.stringify({ mid: msg.mid, by: id }))))
      } else if (d.kind === KIND_ACK) {
        if (!me.myMids.has(msg.mid)) return
        if (!me.ackBy.has(msg.mid)) me.ackBy.set(msg.mid, new Set())
        me.ackBy.get(msg.mid).add(msg.by)
      }
    }
  }
  // 手动驱动：SimNode.delivered 是数组，改为轮询处理新到载荷
  const pump = () => {
    let moved = true
    while (moved) {
      moved = false
      for (const id of ['A', 'B', 'C']) {
        const node = nodes[id], me = app[id]
        while ((me.cursor ?? 0) < node.delivered.length) {
          const frame = node.delivered[me.cursor = (me.cursor ?? 0) + 1, me.cursor - 1]
          node.onBus(frame); moved = true
        }
      }
    }
  }

  const mid = 'chat-001'
  app.A.myMids.add(mid); app.A.seen.add(mid)
  nodes.A.send(busEncode(KIND_CHAT, 'K7Q9ZP', Buffer.from(JSON.stringify({ mid, n: '我', t: '收到请回执', ts: 0 }))))
  pump()

  check('B、C（含经中继者）都收到消息', app.B.seen.has(mid) && app.C.seen.has(mid))
  check('A 聚合到 2 个去重回执（B 直连 + C 经中继）',
    app.A.ackBy.get(mid)?.size === 2, `got=${app.A.ackBy.get(mid)?.size}`)
  check('B 不为别人的消息计数回执', !app.B.ackBy.has(mid))

  // KIND_ACK=4 双端防漂移
  const swiftBus2 = readFileSync(join(ROOT, 'ios12/Sources/Mesh/MeshBus.swift'), 'utf8')
  const ktBus2 = readFileSync(join(ROOT, 'android-native/app/src/main/java/cc/trailmate/app/MeshBus.kt'), 'utf8')
  check('kindAck=4 双端一致', /kindAck: UInt8 = 4/.test(swiftBus2) && /KIND_ACK: Byte = 4/.test(ktBus2))
}

console.log(failures === 0 ? '\n全部通过 ✅' : `\n失败 ${failures} 项 ❌`)
process.exit(failures ? 1 : 0)
