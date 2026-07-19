// 可插拔的对等传输层。
//
// 需求要求联网优先级：蓝牙 > WiFi/局域网自组网 > 移动网络。
// 浏览器沙箱内无法直接使用 BLE Mesh / WiFi Direct，因此这里定义统一接口，并提供两种
// Web 环境可运行的实现：
//   1) BroadcastTransport —— 同一设备多标签/多 PWA 实例互通（免服务器，用于本机演示）。
//   2) WebRTCTransport    —— 真正的跨设备 P2P 网状连接（WiFi/移动网络），仅需一个极小的
//                            信令服务器牵线，数据走设备直连。
// 默认使用 CompositeTransport 同时挂载两者：本机标签页 + 远端手机都能收到消息。
// 打包成原生 App（Capacitor / React Native）时，再新增一个真实的 BLE / WiFi Direct
// 适配器加入组合即可，上层业务（跟车、营地、记账同步）无需改动。

import { Capacitor } from '@capacitor/core'
import { uid } from './id'
import { BleTransport } from './bleTransport'

export type LinkType = 'bluetooth' | 'wifi' | 'cellular' | 'local'

export interface PeerMessage {
  id: string
  from: string // 成员 id
  kind: string // 业务类型：'location' | 'chat' | 'ptt' | 'ledger' | 'presence'
  payload: unknown
  ts: number
}

export interface Transport {
  readonly link: LinkType
  join(groupId: string): void
  leave(): void
  send(msg: PeerMessage): void
  onMessage(cb: (m: PeerMessage) => void): () => void
  peerCount?(): number
}

// 首选链路探测：为原生实现预留。Web 端由具体 transport 决定。
export function preferredLink(): LinkType {
  return activeTransport.link
}

/** Web 实现①：BroadcastChannel（同设备多标签实时互通）。 */
export class BroadcastTransport implements Transport {
  readonly link: LinkType = 'local'
  private ch: BroadcastChannel | null = null
  private room: string | null = null
  private listeners = new Set<(m: PeerMessage) => void>()

  join(groupId: string): void {
    if (this.room === groupId && this.ch) return
    this.leave()
    this.room = groupId
    this.ch = new BroadcastChannel(`trailmate:${groupId}`)
    this.ch.onmessage = (e: MessageEvent) => {
      const m = e.data as PeerMessage
      this.listeners.forEach((cb) => cb(m))
    }
  }
  leave(): void {
    this.ch?.close()
    this.ch = null
    this.room = null
  }
  send(msg: PeerMessage): void {
    this.ch?.postMessage(msg)
  }
  onMessage(cb: (m: PeerMessage) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }
}

interface PeerConn {
  pc: RTCPeerConnection
  dc: RTCDataChannel | null
  pending: RTCIceCandidateInit[]
  remoteSet: boolean
}

/** Web 实现②：WebRTC 全网状 P2P。跨设备真实互联。 */
export class WebRTCTransport implements Transport {
  readonly link: LinkType = 'wifi'
  private url: string
  private selfId = uid('peer_')
  private ws: WebSocket | null = null
  private desired: string | null = null
  private peers = new Map<string, PeerConn>()
  private listeners = new Set<(m: PeerMessage) => void>()
  private leaveTimer: ReturnType<typeof setTimeout> | null = null
  private retry = 0
  private readonly ice: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }]

  constructor(url: string) {
    this.url = url
  }

  peerCount(): number {
    let n = 0
    for (const p of this.peers.values()) if (p.dc?.readyState === 'open') n++
    return n
  }

  join(groupId: string): void {
    if (this.leaveTimer) {
      clearTimeout(this.leaveTimer)
      this.leaveTimer = null
    }
    if (this.desired === groupId && this.ws) return
    if (this.desired && this.desired !== groupId) this.teardown()
    this.desired = groupId
    this.connect()
  }

  leave(): void {
    // 宽限期，避免路由切换导致的连接抖动
    if (this.leaveTimer) clearTimeout(this.leaveTimer)
    this.leaveTimer = setTimeout(() => this.teardown(), 800)
  }

  private teardown(): void {
    this.desired = null
    for (const { pc } of this.peers.values()) {
      try {
        pc.close()
      } catch {
        /* ignore */
      }
    }
    this.peers.clear()
    try {
      this.ws?.close()
    } catch {
      /* ignore */
    }
    this.ws = null
  }

  private connect(): void {
    if (!this.desired) return
    let ws: WebSocket
    try {
      ws = new WebSocket(this.url)
    } catch {
      return // 无信令服务器时静默降级（BroadcastChannel 仍可用）
    }
    this.ws = ws
    ws.onopen = () => {
      this.retry = 0
      // token 鉴权（G-SEC-1）：服务器设了 SIGNAL_TOKEN 时必须携带一致的 token
      const token = (import.meta.env.VITE_SIGNAL_TOKEN as string | undefined) ?? ''
      ws.send(JSON.stringify({ type: 'join', room: this.desired, peerId: this.selfId, token }))
    }
    ws.onmessage = (e) => this.onSignal(JSON.parse(e.data))
    ws.onclose = () => {
      if (this.ws !== ws) return
      this.ws = null
      // 断线自动重连（指数退避，最长 8s）
      if (this.desired) {
        const delay = Math.min(8000, 500 * 2 ** this.retry++)
        setTimeout(() => this.connect(), delay)
      }
    }
    ws.onerror = () => ws.close()
  }

  private shouldInitiate(other: string): boolean {
    return this.selfId < other
  }

  private ensurePeer(other: string): PeerConn {
    let p = this.peers.get(other)
    if (p) return p
    const pc = new RTCPeerConnection({ iceServers: this.ice })
    p = { pc, dc: null, pending: [], remoteSet: false }
    this.peers.set(other, p)

    pc.onicecandidate = (ev) => {
      if (ev.candidate) this.relay(other, { candidate: ev.candidate.toJSON() })
    }
    pc.onconnectionstatechange = () => {
      if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
        pc.close()
        this.peers.delete(other)
      }
    }
    pc.ondatachannel = (ev) => this.setupDC(other, ev.channel)

    if (this.shouldInitiate(other)) {
      const dc = pc.createDataChannel('data')
      this.setupDC(other, dc)
      pc.createOffer()
        .then((offer) => pc.setLocalDescription(offer))
        .then(() => this.relay(other, { sdp: pc.localDescription }))
        .catch(() => {})
    }
    return p
  }

  private setupDC(other: string, dc: RTCDataChannel): void {
    const p = this.peers.get(other)
    if (p) p.dc = dc
    dc.onmessage = (e) => {
      try {
        const m = JSON.parse(e.data) as PeerMessage
        this.listeners.forEach((cb) => cb(m))
      } catch {
        /* ignore */
      }
    }
    dc.onclose = () => {
      const pp = this.peers.get(other)
      if (pp) pp.dc = null
    }
  }

  private relay(to: string, data: unknown): void {
    this.ws?.send(JSON.stringify({ type: 'signal', to, from: this.selfId, data }))
  }

  private async onSignal(msg: {
    type: string
    peers?: string[]
    peerId?: string
    from?: string
    data?: { sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit }
  }): Promise<void> {
    if (msg.type === 'peers') {
      for (const other of msg.peers ?? []) this.ensurePeer(other)
      return
    }
    if (msg.type === 'joined' && msg.peerId) {
      this.ensurePeer(msg.peerId)
      return
    }
    if (msg.type === 'left' && msg.peerId) {
      const p = this.peers.get(msg.peerId)
      if (p) {
        p.pc.close()
        this.peers.delete(msg.peerId)
      }
      return
    }
    if (msg.type === 'signal' && msg.from && msg.data) {
      const p = this.ensurePeer(msg.from)
      const { sdp, candidate } = msg.data
      if (sdp) {
        await p.pc.setRemoteDescription(sdp)
        p.remoteSet = true
        for (const c of p.pending.splice(0)) await p.pc.addIceCandidate(c).catch(() => {})
        if (sdp.type === 'offer') {
          const answer = await p.pc.createAnswer()
          await p.pc.setLocalDescription(answer)
          this.relay(msg.from, { sdp: p.pc.localDescription })
        }
      } else if (candidate) {
        if (p.remoteSet) await p.pc.addIceCandidate(candidate).catch(() => {})
        else p.pending.push(candidate)
      }
    }
  }

  send(msg: PeerMessage): void {
    const data = JSON.stringify(msg)
    for (const p of this.peers.values()) {
      if (p.dc?.readyState === 'open') {
        try {
          p.dc.send(data)
        } catch {
          /* ignore */
        }
      }
    }
  }

  onMessage(cb: (m: PeerMessage) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }
}

/** 组合多个 transport：发送时全部下发，接收时合并去重。 */
export class CompositeTransport implements Transport {
  private parts: Transport[]
  private seen = new Set<string>()
  constructor(parts: Transport[]) {
    this.parts = parts
  }
  get link(): LinkType {
    // 按需求优先级报告当前生效链路：蓝牙 > WiFi直连 > 本机
    const ble = this.parts.find((p) => p.link === 'bluetooth')
    if (ble && (ble.peerCount?.() ?? 0) > 0) return 'bluetooth'
    const rtc = this.parts.find((p) => p.link === 'wifi')
    if (rtc && (rtc.peerCount?.() ?? 0) > 0) return 'wifi'
    return 'local'
  }
  join(groupId: string): void {
    this.parts.forEach((p) => p.join(groupId))
  }
  leave(): void {
    this.parts.forEach((p) => p.leave())
  }
  send(msg: PeerMessage): void {
    this.parts.forEach((p) => p.send(msg))
  }
  onMessage(cb: (m: PeerMessage) => void): () => void {
    const wrapped = (m: PeerMessage) => {
      if (this.seen.has(m.id)) return // 同一消息经多条链路到达时去重
      this.seen.add(m.id)
      if (this.seen.size > 500) this.seen = new Set([...this.seen].slice(-200))
      cb(m)
    }
    const offs = this.parts.map((p) => p.onMessage(wrapped))
    return () => offs.forEach((off) => off())
  }
  peerCount(): number {
    return this.parts.reduce((n, p) => n + (p.peerCount?.() ?? 0), 0)
  }
}

// 信令服务器地址：优先取构建期环境变量 VITE_SIGNALING_URL；
// 开发环境下默认连本机 8787；生产环境未配置则仅用 BroadcastChannel。
function signalingUrl(): string | undefined {
  const env = import.meta.env.VITE_SIGNALING_URL as string | undefined
  if (env) return env
  if (import.meta.env.DEV && typeof location !== 'undefined') {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    return `${proto}://${location.hostname}:8787`
  }
  return undefined
}

function buildTransport(): Transport {
  const parts: Transport[] = [new BroadcastTransport()]
  const url = signalingUrl()
  if (url) parts.push(new WebRTCTransport(url))
  // 原生 App(iOS/Android) 追加真实蓝牙自组网链路，实现无网营地互通
  if (Capacitor.isNativePlatform()) parts.push(new BleTransport())
  return new CompositeTransport(parts)
}

// 单例，供各功能模块共享同一条链路
export const activeTransport: Transport = buildTransport()
export const transport = activeTransport
