// Watchtower 查看端 API 客户端。
//
// 服务端地址与访问令牌存在 localStorage —— 同一个 App 可以在家/公司之间切服务器。
//
// 一个必须注意的点：<img>/<video>/EventSource **无法设置请求头**，
// 所以媒体与 SSE 用 `?token=` 传令牌（服务端两种都认）。普通 JSON 请求仍走 Bearer。

const LS_BASE = 'watchtower.base'
const LS_TOKEN = 'watchtower.token'

export type WatchConfig = { base: string; token: string }

export function getConfig(): WatchConfig {
  return {
    base: (localStorage.getItem(LS_BASE) || '').replace(/\/+$/, ''),
    token: localStorage.getItem(LS_TOKEN) || '',
  }
}

export function setConfig(cfg: WatchConfig) {
  localStorage.setItem(LS_BASE, cfg.base.replace(/\/+$/, ''))
  localStorage.setItem(LS_TOKEN, cfg.token)
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

async function req<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { base, token } = getConfig()
  if (!base) throw new ApiError(0, '还没配置服务器地址，请到「设置」里填写')
  const headers = new Headers(init.headers)
  headers.set('Content-Type', 'application/json')
  if (token) headers.set('Authorization', `Bearer ${token}`)

  let resp: Response
  try {
    resp = await fetch(`${base}${path}`, { ...init, headers })
  } catch {
    throw new ApiError(0, '连不上服务器，检查地址与网络')
  }
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '')
    throw new ApiError(resp.status, resp.status === 401 ? '访问令牌无效' : detail || resp.statusText)
  }
  return (await resp.json()) as T
}

/** 把服务端返回的 `/api/media?path=...` 变成带令牌的可直接 src 的地址。 */
export function mediaUrl(path: string): string {
  if (!path) return ''
  const { base, token } = getConfig()
  const sep = path.includes('?') ? '&' : '?'
  return `${base}${path}${token ? `${sep}token=${encodeURIComponent(token)}` : ''}`
}

// ---------------- 数据类型 ----------------

export type CameraStatus = {
  id: string; name: string; platform: string; zone: string
  enabled: boolean; online: boolean; protocol: string
  expires_in: number | null; note: string; error: string
}

export type PlayUrls = {
  webrtc: string; mp4: string; hls: string; snapshot: string; mjpeg: string; rtsp: string
}

export type WatchEvent = {
  id: string; camera_id: string; camera_name: string; zone: string
  started_at: number; ended_at: number; duration: number
  kind: string; score: number; person_count: number; max_persons: number
  thumb: string; clip: string; meta: Record<string, unknown>
}

export type DigestItem = {
  id: string; day: string; camera_id: string; summary: string
  video: string; cover: string; stats: Record<string, any>; created_at: number
}

export type Health = {
  ok: boolean; version: string; detector: string
  cameras: number; subscribers: number; sse_clients: number; auth_required: boolean
}

// ---------------- 接口 ----------------

export const api = {
  health: () => req<Health>('/api/health'),
  cameras: () => req<CameraStatus[]>('/api/cameras'),
  syncCamera: (id: string) => req<{ ok: boolean; error: string }>(`/api/cameras/${id}/sync`, { method: 'POST' }),
  play: (id: string) => req<{ urls: PlayUrls; protocol: string }>(`/api/cameras/${id}/play`),
  events: (params: { limit?: number; camera_id?: string; since?: number } = {}) => {
    const q = new URLSearchParams()
    if (params.limit) q.set('limit', String(params.limit))
    if (params.camera_id) q.set('camera_id', params.camera_id)
    if (params.since) q.set('since', String(params.since))
    return req<WatchEvent[]>(`/api/events?${q}`)
  },
  digests: () => req<DigestItem[]>('/api/digests'),
  digest: (day: string) => req<DigestItem>(`/api/digests/${day}`),
  buildDigest: (day: string) => req<DigestItem>(`/api/digests/${day}/build`, { method: 'POST' }),
  subscribers: () => req<{ id: string; channel: string; label: string; levels: string[]; target: string }[]>('/api/subscribers'),
  addSubscriber: (body: { channel: string; target: string; label?: string; levels?: string[] }) =>
    req<{ id: string }>('/api/subscribers', { method: 'POST', body: JSON.stringify(body) }),
  deleteSubscriber: (id: string) => req<{ ok: boolean }>(`/api/subscribers/${id}`, { method: 'DELETE' }),
  testPush: (body: { channel: string; target: string }) =>
    req<{ ok: boolean }>('/api/subscribers/test', { method: 'POST', body: JSON.stringify(body) }),
  pushChannels: () => req<{ channel: string; target: string; note: string }[]>('/api/push/channels'),
}

/**
 * 订阅服务端实时消息（SSE）。返回取消函数。
 * App 在前台时事件秒到，不依赖系统推送 —— 系统推送只负责把人叫回来。
 */
export function subscribeEvents(
  onEvent: (kind: string, data: any) => void,
  onState?: (connected: boolean) => void,
): () => void {
  const { base, token } = getConfig()
  if (!base) return () => {}
  const url = `${base}/api/stream/events${token ? `?token=${encodeURIComponent(token)}` : ''}`
  const source = new EventSource(url)

  source.onopen = () => onState?.(true)
  source.onerror = () => onState?.(false)     // EventSource 会自己重连
  for (const kind of ['event', 'digest', 'hello']) {
    source.addEventListener(kind, (e) => {
      try {
        const payload = JSON.parse((e as MessageEvent).data)
        onEvent(payload.kind ?? kind, payload.data)
      } catch {
        /* 忽略坏帧，等下一条 */
      }
    })
  }
  return () => source.close()
}

// ---------------- 展示辅助 ----------------

export function fmtTime(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

export function fmtDateTime(ts: number): string {
  return new Date(ts * 1000).toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  })
}

export function scoreLabel(score: number): string {
  if (score >= 0.7) return '重要'
  if (score >= 0.45) return '一般'
  return '轻微'
}
