import { useEffect, useState } from 'react'
import { Capacitor } from '@capacitor/core'

// 显示当前网络类型：原生用 @capacitor/network，Web 用 navigator 兜底。
export function useNetwork(): string {
  const [label, setLabel] = useState('—')
  useEffect(() => {
    let cleanup = () => {}
    if (Capacitor.isNativePlatform()) {
      import('@capacitor/network').then(({ Network }) => {
        const map = (s: { connected: boolean; connectionType: string }) =>
          !s.connected
            ? '离线'
            : ({ wifi: 'WiFi', cellular: '移动网络', none: '离线' } as Record<string, string>)[s.connectionType] ?? '在线'
        void Network.getStatus().then((s) => setLabel(map(s)))
        void Network.addListener('networkStatusChange', (s) => setLabel(map(s))).then((h) => {
          cleanup = () => void h.remove()
        })
      })
    } else {
      const nav = navigator as Navigator & { connection?: { effectiveType?: string } }
      const upd = () =>
        setLabel(nav.onLine === false ? '离线' : nav.connection?.effectiveType?.toUpperCase() ?? '在线')
      upd()
      window.addEventListener('online', upd)
      window.addEventListener('offline', upd)
      cleanup = () => {
        window.removeEventListener('online', upd)
        window.removeEventListener('offline', upd)
      }
    }
    return () => cleanup()
  }, [])
  return label
}

// 保持屏幕常亮（跟车导航时不熄屏）。Web Wake Lock 在原生 WebView 内同样可用。
export function useKeepAwake(active: boolean): void {
  useEffect(() => {
    if (!active) return
    let lock: { release: () => Promise<void> } | null = null
    let stopped = false
    const nav = navigator as Navigator & {
      wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> }
    }
    const req = async () => {
      try {
        if (nav.wakeLock && !stopped) lock = await nav.wakeLock.request('screen')
      } catch {
        /* 不支持或被拒绝时忽略 */
      }
    }
    void req()
    const onVis = () => {
      if (document.visibilityState === 'visible') void req()
    }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      stopped = true
      document.removeEventListener('visibilitychange', onVis)
      void lock?.release().catch(() => {})
    }
  }, [active])
}
