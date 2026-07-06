// BLE 蓝牙自组网 Transport 实现。
//
// 物理层只有一条蓝牙链路，但业务上按「群组验证码」分房间，因此房间过滤在 JS 层完成：
// 发送时把当前 room 一并封进帧；收到帧后 room 不匹配则丢弃。
// 大消息（语音/视频的 base64）不适合走蓝牙，超过阈值直接跳过（由 WebRTC 兜底）。
import { Capacitor } from '@capacitor/core'
import type { PluginListenerHandle } from '@capacitor/core'
import { BleMesh } from './blePlugin'
import type { LinkType, PeerMessage, Transport } from './transport'

interface BleFrame {
  room: string
  msg: PeerMessage
}

// 蓝牙吞吐有限：单帧上限（含分片重组前的完整 JSON）。文字/位置远小于此值。
const MAX_BLE_BYTES = 8 * 1024

export class BleTransport implements Transport {
  readonly link: LinkType = 'bluetooth'
  private room: string | null = null
  private started = false
  private starting: Promise<void> | null = null
  private peers = 0
  private listeners = new Set<(m: PeerMessage) => void>()
  private handles: PluginListenerHandle[] = []

  private available(): boolean {
    return Capacitor.isNativePlatform()
  }

  peerCount(): number {
    return this.peers
  }

  join(groupId: string): void {
    this.room = groupId
    if (!this.available()) return
    if (this.started || this.starting) return
    this.starting = this.boot().finally(() => {
      this.starting = null
    })
  }

  private async boot(): Promise<void> {
    try {
      const init = await BleMesh.initialize()
      if (!init.ok) return
      this.handles.push(
        await BleMesh.addListener('message', (e) => this.onFrame(e.data)),
      )
      this.handles.push(
        await BleMesh.addListener('status', (e) => {
          this.peers = e.peers
        }),
      )
      await BleMesh.start()
      this.started = true
    } catch (err) {
      console.warn('[BLE] 启动失败（将由其它链路兜底）：', err)
    }
  }

  leave(): void {
    // 蓝牙连接建立成本高，切换路由时不立即断开；仅在真正需要时停止。
    // 这里只清空房间标记，物理链路保持，供再次进入复用。
    this.room = null
  }

  async shutdown(): Promise<void> {
    if (!this.available() || !this.started) return
    try {
      await BleMesh.stop()
      await BleMesh.removeAllListeners()
    } catch {
      /* ignore */
    }
    this.handles = []
    this.started = false
    this.peers = 0
  }

  private onFrame(raw: string): void {
    try {
      const frame = JSON.parse(raw) as BleFrame
      if (!frame || frame.room !== this.room) return // 房间过滤
      this.listeners.forEach((cb) => cb(frame.msg))
    } catch {
      /* 非法帧忽略 */
    }
  }

  send(msg: PeerMessage): void {
    if (!this.available() || !this.started || !this.room) return
    const frame: BleFrame = { room: this.room, msg }
    const data = JSON.stringify(frame)
    if (data.length > MAX_BLE_BYTES) return // 大消息不走蓝牙
    void BleMesh.send({ data }).catch(() => {})
  }

  onMessage(cb: (m: PeerMessage) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }
}
