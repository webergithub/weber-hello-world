// 自定义 Capacitor 原生插件 BleMesh 的 TypeScript 桥接。
// 原生实现见 android/.../BleMeshPlugin.kt 与 ios/App/App/BleMeshPlugin.swift。
//
// 该插件让手机同时作为 BLE 外围(advertise + GATT server) 与 中心(scan + connect)，
// 从而在没有任何移动网络/WiFi 的营地，用手机蓝牙实现设备间点对点自组网。
import { registerPlugin, type PluginListenerHandle } from '@capacitor/core'

export interface BleMeshMessageEvent {
  data: string // 邻居发来的原始帧（我们在 JS 层封装的 JSON 字符串）
}
export interface BleMeshStatusEvent {
  state: 'on' | 'off' | 'unauthorized' | 'unsupported'
  peers: number // 当前直连邻居数
}

export interface BleMeshPlugin {
  /** 检查/申请蓝牙权限并初始化适配器。 */
  initialize(): Promise<{ ok: boolean; state: string }>
  /** 开始广播 + 扫描 + 连接（同时扮演外围与中心）。 */
  start(): Promise<void>
  /** 停止所有蓝牙活动。 */
  stop(): Promise<void>
  /** 向所有直连邻居广播一帧数据（原生负责分片与重组）。 */
  send(options: { data: string }): Promise<void>
  addListener(
    eventName: 'message',
    cb: (e: BleMeshMessageEvent) => void,
  ): Promise<PluginListenerHandle>
  addListener(
    eventName: 'status',
    cb: (e: BleMeshStatusEvent) => void,
  ): Promise<PluginListenerHandle>
  removeAllListeners(): Promise<void>
}

export const BleMesh = registerPlugin<BleMeshPlugin>('BleMesh')
