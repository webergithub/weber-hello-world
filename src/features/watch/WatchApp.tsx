// 监控查看端：实况 / 事件 / 一日剪影 / 设置。
//
// 定位是「远程查看端」—— 所有重活（拉流、分析、剪辑、推送）都在服务端做完了，
// 这里只负责把结果好好呈现出来，所以它在低端机和弱网上也应该是流畅的。

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  api, fmtDateTime, getConfig, mediaUrl, scoreLabel, setConfig,
  subscribeEvents, type CameraStatus, type DigestItem, type Health, type WatchEvent,
} from './api'
import { LivePlayer } from './LivePlayer'

type Tab = 'live' | 'events' | 'digest' | 'settings'

const TABS: { key: Tab; label: string; icon: string }[] = [
  { key: 'live', label: '实况', icon: '📹' },
  { key: 'events', label: '事件', icon: '🚶' },
  { key: 'digest', label: '剪影', icon: '🎞️' },
  { key: 'settings', label: '设置', icon: '⚙️' },
]

export function WatchApp() {
  const [tab, setTab] = useState<Tab>('live')
  const [connected, setConnected] = useState(false)
  const [live, setLive] = useState<WatchEvent[]>([])
  const [configured, setConfigured] = useState(() => Boolean(getConfig().base))

  // SSE：App 在前台时事件秒到，不用等系统推送
  useEffect(() => {
    if (!configured) return
    return subscribeEvents(
      (kind, data) => {
        if (kind === 'event') setLive((prev) => [data as WatchEvent, ...prev].slice(0, 30))
      },
      setConnected,
    )
  }, [configured])

  if (!configured) {
    return <SettingsTab onSaved={() => setConfigured(true)} />
  }

  return (
    <div>
      <div className="page-head row spread">
        <strong>监控</strong>
        <span className="small muted">
          <span className="dot" style={{ background: connected ? '#22c55e' : '#94a3b8' }} />
          {connected ? '实时已连接' : '未连接'}
        </span>
      </div>

      <div className="seg row">
        {TABS.map((t) => (
          <button
            key={t.key}
            className={`btn ${tab === t.key ? 'pill' : ''}`}
            onClick={() => setTab(t.key)}
          >
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {tab === 'live' && <LiveTab />}
      {tab === 'events' && <EventsTab liveFeed={live} />}
      {tab === 'digest' && <DigestTab />}
      {tab === 'settings' && <SettingsTab onSaved={() => setConfigured(true)} />}
    </div>
  )
}

// ---------------------------------------------------------------- 实况

function LiveTab() {
  const [cameras, setCameras] = useState<CameraStatus[] | null>(null)
  const [current, setCurrent] = useState<string>('')
  const [error, setError] = useState('')

  const load = useCallback(() => {
    api.cameras()
      .then((list) => {
        setCameras(list)
        setCurrent((c) => c || list.find((x) => x.online)?.id || list[0]?.id || '')
      })
      .catch((e) => setError(e.message))
  }, [])

  useEffect(() => { load() }, [load])

  if (error) return <div className="empty"><div className="big">⚠️</div>{error}</div>
  if (!cameras) return <div className="empty"><div className="big">⏳</div>加载中…</div>
  if (cameras.length === 0) {
    return (
      <div className="empty">
        <div className="big">📷</div>
        还没有摄像头。在服务端执行 <code>watchtower add-camera</code> 添加，
        或用 <code>watchtower discover</code> 扫一遍局域网。
      </div>
    )
  }

  const active = cameras.find((c) => c.id === current)

  return (
    <div>
      <div className="row" style={{ gap: 8, overflowX: 'auto', paddingBottom: 8 }}>
        {cameras.map((cam) => (
          <button
            key={cam.id}
            className={`btn ${cam.id === current ? 'pill' : ''}`}
            onClick={() => setCurrent(cam.id)}
          >
            <span className="dot" style={{ background: cam.online ? '#22c55e' : '#ef4444' }} />
            {cam.name}
          </button>
        ))}
      </div>

      {active && <LivePlayer cameraId={active.id} name={active.name} />}

      {active && (active.error || active.note) && (
        <div className="card small" style={{ marginTop: 10 }}>
          {active.error ? (
            <>
              <strong>这一路有问题：</strong>
              <div className="muted">{active.error}</div>
              <button
                className="btn"
                style={{ marginTop: 8 }}
                onClick={() => api.syncCamera(active.id).then(load)}
              >
                重新解析地址
              </button>
            </>
          ) : (
            <span className="muted">💡 {active.note}</span>
          )}
        </div>
      )}

      <div className="card small" style={{ marginTop: 10 }}>
        <div className="row spread">
          <span className="muted">共 {cameras.length} 路，在线 {cameras.filter((c) => c.online).length} 路</span>
          <button className="btn" onClick={load}>刷新</button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- 事件

function EventsTab({ liveFeed }: { liveFeed: WatchEvent[] }) {
  const [events, setEvents] = useState<WatchEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    api.events({ limit: 100 })
      .then(setEvents)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  // 实时来的事件插到最前面，并按 id 去重（列表里可能已经有了）
  const merged = useMemo(() => {
    const seen = new Set<string>()
    return [...liveFeed, ...events].filter((e) => {
      if (seen.has(e.id)) return false
      seen.add(e.id)
      return true
    })
  }, [liveFeed, events])

  if (loading) return <div className="empty"><div className="big">⏳</div>加载中…</div>
  if (error) return <div className="empty"><div className="big">⚠️</div>{error}</div>
  if (merged.length === 0) {
    return <div className="empty"><div className="big">🌙</div>还没有检测到人员活动</div>
  }

  return (
    <div>
      {merged.map((event) => <EventCard key={event.id} event={event} />)}
    </div>
  )
}

function EventCard({ event }: { event: WatchEvent }) {
  const [open, setOpen] = useState(false)
  const movements = (event.meta?.movements as string[] | undefined) ?? []

  return (
    <div className="card" style={{ marginBottom: 10 }}>
      <div className="row" style={{ gap: 10 }}>
        {event.thumb ? (
          <img
            src={mediaUrl(event.thumb)}
            alt=""
            style={{ width: 96, height: 62, objectFit: 'cover', borderRadius: 8, background: '#000' }}
          />
        ) : (
          <div style={{ width: 96, height: 62, borderRadius: 8, background: '#1e293b' }} />
        )}
        <div className="grow">
          <div className="row spread">
            <strong>{event.zone || event.camera_name}</strong>
            <span className="tag">{scoreLabel(event.score)}</span>
          </div>
          <div className="small muted">
            {fmtDateTime(event.started_at)} · {event.duration.toFixed(0)} 秒
            {event.max_persons > 1 && ` · 最多 ${event.max_persons} 人`}
          </div>
          {movements.length > 0 && (
            <div className="small muted">{movements.join('、')}</div>
          )}
        </div>
      </div>

      {event.clip && (
        <>
          <button className="btn" style={{ marginTop: 8 }} onClick={() => setOpen((v) => !v)}>
            {open ? '收起回放' : '看回放'}
          </button>
          {open && (
            <video
              src={mediaUrl(event.clip)}
              controls
              autoPlay
              playsInline
              style={{ width: '100%', marginTop: 8, borderRadius: 8, background: '#000' }}
            />
          )}
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- 一日剪影

function DigestTab() {
  const [items, setItems] = useState<DigestItem[] | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    api.digests().then(setItems).catch((e) => setError(e.message))
  }, [])

  useEffect(() => { load() }, [load])

  async function buildToday() {
    setBusy(true)
    setError('')
    try {
      const today = new Date().toISOString().slice(0, 10)
      await api.buildDigest(today)
      load()
    } catch (e: any) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <div className="card row spread">
        <span className="small muted">服务端每天定时生成，也可以现在就补一份</span>
        <button className="btn" onClick={buildToday} disabled={busy}>
          {busy ? '生成中…' : '生成今天'}
        </button>
      </div>

      {error && <div className="card small" style={{ color: '#f87171' }}>{error}</div>}
      {!items && <div className="empty"><div className="big">⏳</div>加载中…</div>}
      {items?.length === 0 && (
        <div className="empty"><div className="big">🎞️</div>还没有剪影</div>
      )}

      {items?.map((digest) => <DigestCard key={digest.id} digest={digest} />)}
    </div>
  )
}

function DigestCard({ digest }: { digest: DigestItem }) {
  const [playing, setPlaying] = useState(false)
  const stats = digest.stats || {}
  const clips: any[] = stats.clips ?? []

  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div className="row spread">
        <strong>{digest.day}</strong>
        <span className="small muted">{stats.total_events ?? 0} 起活动</span>
      </div>

      {digest.summary && <p style={{ margin: '8px 0' }}>{digest.summary}</p>}

      {digest.video ? (
        playing ? (
          <video
            src={mediaUrl(digest.video)}
            controls
            autoPlay
            playsInline
            style={{ width: '100%', borderRadius: 8, background: '#000' }}
          />
        ) : (
          <button
            onClick={() => setPlaying(true)}
            style={{ border: 0, padding: 0, background: 'transparent', width: '100%', cursor: 'pointer' }}
          >
            {digest.cover ? (
              <img
                src={mediaUrl(digest.cover)}
                alt={`${digest.day} 剪影`}
                style={{ width: '100%', borderRadius: 8, display: 'block' }}
              />
            ) : (
              <div className="empty"><div className="big">▶️</div>播放剪影</div>
            )}
          </button>
        )
      ) : (
        digest.cover && (
          <img src={mediaUrl(digest.cover)} alt="" style={{ width: '100%', borderRadius: 8 }} />
        )
      )}

      {clips.length > 0 && (
        <div className="small muted" style={{ marginTop: 8 }}>
          章节：{clips.slice(0, 6).map((c) => c.caption).join(' / ')}
          {clips.length > 6 && ` … 共 ${clips.length} 段`}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- 设置

function SettingsTab({ onSaved }: { onSaved: () => void }) {
  const initial = getConfig()
  const [base, setBase] = useState(initial.base)
  const [token, setToken] = useState(initial.token)
  const [health, setHealth] = useState<Health | null>(null)
  const [message, setMessage] = useState('')
  const [channel, setChannel] = useState('bark')
  const [target, setTarget] = useState('')

  async function save() {
    setConfig({ base, token })
    setMessage('')
    try {
      setHealth(await api.health())
      setMessage('连接成功')
      onSaved()
    } catch (e: any) {
      setHealth(null)
      setMessage(e.message)
    }
  }

  async function addPush() {
    try {
      await api.testPush({ channel, target })
      await api.addSubscriber({ channel, target, label: '我的手机' })
      setMessage('已订阅，测试消息已发出')
      setTarget('')
    } catch (e: any) {
      setMessage(e.message)
    }
  }

  return (
    <div>
      <div className="card">
        <div className="small muted">服务端地址（例：https://watch.example.com）</div>
        <input
          className="input"
          value={base}
          onChange={(e) => setBase(e.target.value)}
          placeholder="https://…"
          autoCapitalize="off"
          autoCorrect="off"
        />
        <div className="small muted" style={{ marginTop: 8 }}>访问令牌（服务端 api_token）</div>
        <input
          className="input"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          type="password"
          placeholder="公网部署必填"
        />
        <button className="btn" style={{ marginTop: 10 }} onClick={save}>保存并测试</button>
        {message && <div className="small" style={{ marginTop: 8 }}>{message}</div>}
      </div>

      {health && (
        <div className="card small">
          <div className="row spread"><span className="muted">版本</span><span>{health.version}</span></div>
          <div className="row spread"><span className="muted">检测器</span><span>{health.detector}</span></div>
          <div className="row spread"><span className="muted">摄像头</span><span>{health.cameras} 路</span></div>
          <div className="row spread"><span className="muted">推送订阅</span><span>{health.subscribers} 个</span></div>
          {!health.auth_required && (
            <div style={{ color: '#fbbf24', marginTop: 8 }}>
              ⚠️ 服务端未设置访问令牌，任何人都能看你的摄像头，公网部署请务必配置。
            </div>
          )}
        </div>
      )}

      <div className="card">
        <strong className="small">离线也想收到通知</strong>
        <div className="small muted" style={{ margin: '4px 0 8px' }}>
          App 没开时靠这些通道叫你（Bark 适合 iOS，企业微信/钉钉适合团队）。
        </div>
        <select className="input" value={channel} onChange={(e) => setChannel(e.target.value)}>
          <option value="bark">Bark（iOS）</option>
          <option value="wecom">企业微信机器人</option>
          <option value="dingtalk">钉钉机器人</option>
          <option value="telegram">Telegram</option>
          <option value="webhook">自定义 Webhook</option>
        </select>
        <input
          className="input"
          style={{ marginTop: 8 }}
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          placeholder={channel === 'bark' ? 'Bark device key' : 'Webhook 地址'}
        />
        <button className="btn" style={{ marginTop: 10 }} onClick={addPush} disabled={!target}>
          测试并订阅
        </button>
      </div>
    </div>
  )
}
