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

console.log(failures === 0 ? '\n全部通过 ✅' : `\n失败 ${failures} 项 ❌`)
process.exit(failures ? 1 : 0)
