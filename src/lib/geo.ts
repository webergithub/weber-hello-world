// 统一定位接口：原生(iOS/Android) 用 Capacitor Geolocation，Web 用浏览器 API。
import { Capacitor } from '@capacitor/core'

export interface GeoPos {
  lat: number
  lng: number
  accuracy?: number
}

type OnPos = (p: GeoPos) => void
type OnErr = (msg: string) => void

// 返回一个取消函数
export function watchPosition(onPos: OnPos, onErr: OnErr): () => void {
  if (Capacitor.isNativePlatform()) return watchNative(onPos, onErr)
  return watchWeb(onPos, onErr)
}

function watchWeb(onPos: OnPos, onErr: OnErr): () => void {
  if (!('geolocation' in navigator)) {
    onErr('设备不支持定位')
    return () => {}
  }
  const id = navigator.geolocation.watchPosition(
    (pos) => onPos({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy }),
    (err) => onErr('无法获取定位：' + err.message),
    { enableHighAccuracy: true, maximumAge: 3000, timeout: 10000 },
  )
  return () => navigator.geolocation.clearWatch(id)
}

function watchNative(onPos: OnPos, onErr: OnErr): () => void {
  let watchId: string | null = null
  let cancelled = false
  ;(async () => {
    try {
      const { Geolocation } = await import('@capacitor/geolocation')
      const perm = await Geolocation.requestPermissions()
      if (perm.location === 'denied') {
        onErr('定位权限被拒绝，请在系统设置中开启')
        return
      }
      const id = await Geolocation.watchPosition(
        { enableHighAccuracy: true, timeout: 10000 },
        (pos, err) => {
          if (err) {
            onErr('定位错误：' + err.message)
            return
          }
          if (pos) onPos({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy })
        },
      )
      if (cancelled) {
        await Geolocation.clearWatch({ id })
      } else {
        watchId = id
      }
    } catch (e) {
      onErr('定位初始化失败：' + (e as Error).message)
    }
  })()
  return () => {
    cancelled = true
    if (watchId) {
      import('@capacitor/geolocation').then(({ Geolocation }) => Geolocation.clearWatch({ id: watchId! }))
    }
  }
}
