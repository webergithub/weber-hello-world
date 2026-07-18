// 原生平台初始化（仅在 iOS/Android 的 Capacitor 容器内生效，Web 端为空操作）。
import { Capacitor } from '@capacitor/core'

export async function initNative(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return
  try {
    const { StatusBar, Style } = await import('@capacitor/status-bar')
    await StatusBar.setStyle({ style: Style.Dark })
    if (Capacitor.getPlatform() === 'android') {
      await StatusBar.setBackgroundColor({ color: '#0f766e' })
    }
  } catch {
    /* 插件不可用时忽略 */
  }
}

export function isNative(): boolean {
  return Capacitor.isNativePlatform()
}

export function platform(): string {
  return Capacitor.getPlatform() // 'ios' | 'android' | 'web'
}
