// mesh 内存回归夹具：BLE 泛洪协议的忠实复刻（G-ENG-1，③E0）
// 逐字节镜像 ios12/Sources/Camp/BleMesh.swift 与 android-native/.../BleMesh.kt：
//   帧 = [8B msgId][1B ttl][2B seq][2B total][<=180B chunk]
//   收帧：seen(msgId) 即丢；按 msgId 重组；重组完成才标 seen、投递、ttl>1 才以 ttl-1 转发
// Radio 用邻接表模拟"蓝牙范围"，无定时器（同步投递），供 CI 回归分片/去重/多跳。

import { randomBytes } from 'node:crypto'

export const HEADER = 13
export const PAYLOAD = 180
export const MAX_TTL = 4

export class Radio {
  constructor() { this.nodes = new Map(); this.links = new Set() }
  add(node) { this.nodes.set(node.id, node); node.radio = this }
  link(a, b) { this.links.add(a + '|' + b); this.links.add(b + '|' + a) }
  neighbors(id) {
    return [...this.nodes.values()].filter(n => n.id !== id && this.links.has(id + '|' + n.id))
  }
  // 模拟"从 from 广播一帧"：范围内邻居都收到（写者不回收自己的帧）
  deliver(fromId, frame) {
    for (const n of this.neighbors(fromId)) n.onFrameReceived(frame)
  }
}

class Reasm {
  constructor(total) { this.chunks = new Array(total).fill(null); this.received = 0; this.ttl = 0; this.msgId = null }
}

export class SimNode {
  constructor(id) {
    this.id = id
    this.radio = null
    this.seen = new Map()      // msgIdHex -> true（与真实实现同：源头自标记）
    this.reasm = new Map()
    this.delivered = []        // 上抛给业务层的完整 payload（Buffer）
    this.framesSent = 0
  }

  send(payload) {
    const msgId = randomBytes(8)
    this.seen.set(msgId.toString('hex'), true)   // 源头自标记，避免回环（BleMesh.swift:70）
    this.broadcast(payload, msgId, MAX_TTL)
  }

  broadcast(payload, msgId, ttl) {
    const total = Math.max(1, Math.ceil(payload.length / PAYLOAD))
    for (let seq = 0; seq < total; seq++) {
      const chunk = payload.subarray(seq * PAYLOAD, Math.min((seq + 1) * PAYLOAD, payload.length))
      const frame = Buffer.alloc(HEADER + chunk.length)
      msgId.copy(frame, 0)
      frame[8] = ttl & 0xff
      frame[9] = (seq >> 8) & 0xff; frame[10] = seq & 0xff
      frame[11] = (total >> 8) & 0xff; frame[12] = total & 0xff
      chunk.copy(frame, HEADER)
      this.framesSent++
      this.radio.deliver(this.id, frame)
    }
  }

  onFrameReceived(frame) {
    if (frame.length < HEADER) return
    const id = frame.subarray(0, 8).toString('hex')
    if (this.seen.has(id)) return                        // BleMesh.swift:133
    const ttl = frame[8]
    const seq = (frame[9] << 8) | frame[10]
    const total = (frame[11] << 8) | frame[12]
    if (!(total > 0 && seq >= 0 && seq < total)) return
    const chunk = frame.subarray(HEADER)

    let r = this.reasm.get(id)
    if (!r) { r = new Reasm(total); r.ttl = ttl; r.msgId = frame.subarray(0, 8); this.reasm.set(id, r) }
    if (r.chunks[seq] === null) { r.chunks[seq] = chunk; r.received++ }
    if (r.received === total) {                          // BleMesh.swift:145-156
      this.reasm.delete(id)
      this.seen.set(id, true)
      const full = Buffer.concat(r.chunks)
      this.delivered.push(full)
      if (r.ttl > 1) this.broadcast(full, r.msgId, r.ttl - 1)
    }
  }
}

// MeshBus 信封（MeshBus.swift:26-33 / MeshBus.kt:74-79）：[kind][teamLen][team][payload]
export function busEncode(kind, team, payload) {
  const t = Buffer.from(team, 'utf8').subarray(0, 32)
  return Buffer.concat([Buffer.from([kind, t.length]), t, payload])
}
export function busDecode(frame, myTeam) {
  if (frame.length < 2) return null
  const kind = frame[0], tlen = frame[1]
  if (frame.length < 2 + tlen) return null
  const team = frame.subarray(2, 2 + tlen).toString('utf8')
  if (team !== myTeam) return null                       // 队伍过滤（MeshBus.swift:55）
  return { kind, body: frame.subarray(2 + tlen) }
}
