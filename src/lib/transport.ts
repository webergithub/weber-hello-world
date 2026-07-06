// 可插拔的对等传输层。
//
// 需求要求联网优先级：蓝牙 > WiFi/局域网自组网 > 移动网络。
// 浏览器沙箱内无法直接使用 BLE Mesh / WiFi Direct，因此这里定义统一接口，
// 并提供一个 Web 环境下可运行的实现（BroadcastChannel，跨同源标签页/PWA 实例互通）。
// 打包成原生 App（Capacitor / React Native）时，替换为下方标注的原生适配器即可，
// 上层业务代码（跟车、营地聊天、记账同步）无需改动。

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
}

// 首选链路探测：为原生实现预留。Web 端统一回落为 local。
export function preferredLink(): LinkType {
  // 原生 App 中应依次探测：BLE 可用? -> WiFi Direct/局域网可用? -> 蜂窝网络
  return 'local'
}

/** Web 实现：BroadcastChannel（同一设备多标签/多 PWA 实例之间实时互通，用于演示与本机联调）。 */
export class BroadcastTransport implements Transport {
  readonly link: LinkType = 'local'
  private ch: BroadcastChannel | null = null
  private listeners = new Set<(m: PeerMessage) => void>()

  join(groupId: string): void {
    this.leave()
    this.ch = new BroadcastChannel(`trailmate:${groupId}`)
    this.ch.onmessage = (e: MessageEvent) => {
      const m = e.data as PeerMessage
      this.listeners.forEach((cb) => cb(m))
    }
  }
  leave(): void {
    this.ch?.close()
    this.ch = null
  }
  send(msg: PeerMessage): void {
    this.ch?.postMessage(msg)
  }
  onMessage(cb: (m: PeerMessage) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }
}

// 单例，供各功能模块共享同一条链路
export const transport: Transport = new BroadcastTransport()
