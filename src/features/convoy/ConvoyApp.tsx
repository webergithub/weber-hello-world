import { useEffect, useMemo, useRef, useState } from 'react'
import { MapContainer, Marker, Popup, TileLayer, useMap } from 'react-leaflet'
import L from 'leaflet'
import { useStore } from '../../store'
import { colorFor } from '../../lib/id'
import { useChannel } from '../../lib/useChannel'
import { watchPosition } from '../../lib/geo'
import { useKeepAwake, useNetwork } from '../../lib/useNetwork'
import { platform } from '../../lib/native'
import { PRESETS, VoiceFX, type VoicePreset } from '../../lib/voicefx'

interface PeerLoc {
  from: string
  nickname: string
  lat: number
  lng: number
  ts: number
  platform?: string // 'ios' | 'android' | 'web'，不区分机型均可互联
}

const PLAT_LABEL: Record<string, string> = { ios: 'iPhone', android: '安卓', web: '网页' }
function platLabel(p?: string): string {
  return PLAT_LABEL[p ?? ''] ?? '设备'
}

// 彩色圆点头像图标，避免默认图标资源缺失问题
function dotIcon(color: string, label: string, me = false): L.DivIcon {
  return L.divIcon({
    className: '',
    html: `<div style="width:${me ? 26 : 22}px;height:${me ? 26 : 22}px;border-radius:50%;
      background:${color};border:3px solid #fff;box-shadow:0 0 0 2px ${color},0 2px 6px rgba(0,0,0,.5);
      display:flex;align-items:center;justify-content:center;color:#fff;font-size:11px;font-weight:700">${label}</div>`,
    iconSize: [26, 26],
    iconAnchor: [13, 13],
  })
}

function Recenter({ pos }: { pos: [number, number] | null }) {
  const map = useMap()
  const done = useRef(false)
  useEffect(() => {
    if (pos && !done.current) {
      map.setView(pos, 15)
      done.current = true
    }
  }, [pos, map])
  return null
}

export function ConvoyApp() {
  const { activeGroup } = useStore()
  const [layer, setLayer] = useState<'road' | 'satellite'>('road')
  const [myPos, setMyPos] = useState<[number, number] | null>(null)
  const [peers, setPeers] = useState<Record<string, PeerLoc>>({})
  const [geoErr, setGeoErr] = useState('')

  const me = activeGroup?.members.find((m) => m.id === activeGroup.myMemberId)
  const myName = me?.nickname ?? '我'
  const net = useNetwork()
  const [pttPreset, setPttPreset] = useState<VoicePreset>(PRESETS[0])
  useKeepAwake(!!activeGroup) // 跟车时保持屏幕常亮

  const { send } = useChannel(activeGroup?.code ?? null, activeGroup?.myMemberId ?? 'me', (m) => {
    if (m.kind === 'location') {
      const p = m.payload as PeerLoc
      if (p.from === activeGroup?.myMemberId) return
      setPeers((prev) => ({ ...prev, [m.from]: { ...p, from: m.from } }))
    } else if (m.kind === 'ptt') {
      const { audio } = m.payload as { audio: string }
      const el = new Audio(audio)
      void el.play()
    }
  })

  // 定位并广播（原生用 Capacitor GPS，Web 用浏览器定位）
  useEffect(() => {
    if (!activeGroup) return
    const stop = watchPosition(
      ({ lat, lng }) => {
        setGeoErr('')
        setMyPos([lat, lng])
        send('location', {
          from: activeGroup.myMemberId,
          nickname: myName,
          lat,
          lng,
          ts: Date.now(),
          platform: platform(),
        })
      },
      (msg) => setGeoErr(msg),
    )
    return stop
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeGroup?.id, myName])

  const center = myPos ?? [39.9087, 116.3975] // 默认北京

  if (!activeGroup) {
    return (
      <div className="empty">
        <div className="big">🚗</div>
        <div>请先在「群组」中选择或创建一个群组</div>
      </div>
    )
  }

  const peerList = Object.values(peers)

  return (
    <div className="convoy-screen">
      <div className="map-wrap">
        <MapContainer center={center as [number, number]} zoom={13} className="map" zoomControl={false}>
          {layer === 'road' ? (
            <TileLayer
              attribution="&copy; OpenStreetMap"
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            />
          ) : (
            <TileLayer
              attribution="&copy; Esri World Imagery"
              url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
            />
          )}
          <Recenter pos={myPos} />
          {myPos && (
            <Marker position={myPos} icon={dotIcon(colorFor(activeGroup.myMemberId), '我', true)}>
              <Popup>我（{myName}）</Popup>
            </Marker>
          )}
          {peerList.map((p) => (
            <Marker key={p.from} position={[p.lat, p.lng]} icon={dotIcon(colorFor(p.from), p.nickname.slice(0, 1))}>
              <Popup>
                {p.nickname}（{platLabel(p.platform)}）
                <br />
                {new Date(p.ts).toLocaleTimeString()}
              </Popup>
            </Marker>
          ))}
        </MapContainer>
      </div>

      {/* 顶部信息条 */}
      <div className="map-overlay top">
        <div className="glass" style={{ padding: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
          <div className="grow">
            <strong>{activeGroup.name}</strong>
            <div className="small muted">
              验证码 {activeGroup.code} · 在线 {peerList.length + 1} 人 · {net}
            </div>
            {peerList.length > 0 && (
              <div className="small muted">
                同行设备：{deviceBreakdown(peerList, platform())}
              </div>
            )}
          </div>
          <div className="layer-toggle">
            <button className={layer === 'road' ? 'on' : ''} onClick={() => setLayer('road')}>道路</button>
            <button className={layer === 'satellite' ? 'on' : ''} onClick={() => setLayer('satellite')}>卫星</button>
          </div>
        </div>
        {geoErr && (
          <div className="glass small" style={{ padding: 8, marginTop: 8, color: 'var(--accent)' }}>
            {geoErr}（请在浏览器允许定位权限）
          </div>
        )}
      </div>

      {/* 底部对讲机（含变声扩展选项） */}
      <div className="map-overlay bottom" style={{ textAlign: 'center' }}>
        <PttVoicePicker preset={pttPreset} onPick={setPttPreset} />
        <PttButton preset={pttPreset} onClip={(audio) => send('ptt', { audio, preset: pttPreset.id })} />
      </div>
    </div>
  )
}

// 统计同行设备的机型分布，直观体现"iOS/安卓不区分机型都能连"
function deviceBreakdown(peers: PeerLoc[], mine: string): string {
  const counts: Record<string, number> = {}
  for (const p of peers) counts[p.platform ?? 'web'] = (counts[p.platform ?? 'web'] ?? 0) + 1
  counts[mine] = (counts[mine] ?? 0) + 1 // 含自己
  return Object.entries(counts)
    .map(([k, n]) => `${platLabel(k)}×${n}`)
    .join(' · ')
}

// 对讲机变声选项：折叠式，默认原声
function PttVoicePicker({ preset, onPick }: { preset: VoicePreset; onPick: (p: VoicePreset) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <div style={{ marginBottom: 10 }}>
      <button
        className="pill"
        onClick={() => setOpen((v) => !v)}
        style={{ border: 'none', background: 'rgba(19,28,46,0.85)' }}
      >
        🎭 变声：{preset.emoji} {preset.name} {open ? '▾' : '▸'}
      </button>
      {open && (
        <div
          className="glass"
          style={{ padding: 8, marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 6, justifyContent: 'center' }}
        >
          {PRESETS.map((p) => (
            <button
              key={p.id}
              className={`chk ${preset.id === p.id ? 'on' : ''}`}
              onClick={() => {
                onPick(p)
                setOpen(false)
              }}
            >
              {p.emoji} {p.name}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// 按住说话：录音，松开发送。类似对讲机。可叠加变声。
function PttButton({ preset, onClip }: { preset: VoicePreset; onClip: (audioDataUrl: string) => void }) {
  const [talking, setTalking] = useState(false)
  const [err, setErr] = useState('')
  const recRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const streamRef = useRef<MediaStream | null>(null)
  const fxRef = useRef<VoiceFX | null>(null)

  const supported = useMemo(() => typeof MediaRecorder !== 'undefined', [])

  async function start() {
    try {
      setErr('')
      const mic = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = mic
      let recStream = mic
      if (preset.id !== 'off') {
        const fx = new VoiceFX()
        fx.resume()
        fx.setPreset(preset)
        recStream = fx.connectMic(mic)
        fxRef.current = fx
      }
      const rec = new MediaRecorder(recStream)
      chunksRef.current = []
      rec.ondataavailable = (e) => e.data.size && chunksRef.current.push(e.data)
      rec.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' })
        const reader = new FileReader()
        reader.onload = () => onClip(reader.result as string)
        reader.readAsDataURL(blob)
        streamRef.current?.getTracks().forEach((t) => t.stop())
        fxRef.current?.dispose()
        fxRef.current = null
      }
      rec.start()
      recRef.current = rec
      setTalking(true)
    } catch (e) {
      setErr('需要麦克风权限')
    }
  }
  function stop() {
    if (recRef.current && recRef.current.state !== 'inactive') recRef.current.stop()
    setTalking(false)
  }

  if (!supported) return <div className="glass small" style={{ padding: 8 }}>此设备不支持录音</div>

  return (
    <div>
      {err && <div className="glass small" style={{ padding: 6, marginBottom: 8, color: 'var(--danger)' }}>{err}</div>}
      <button
        className={`ptt ${talking ? 'talking' : ''}`}
        onPointerDown={(e) => { e.preventDefault(); start() }}
        onPointerUp={stop}
        onPointerLeave={() => talking && stop()}
        onPointerCancel={stop}
      >
        {talking ? '正在说话…' : '按住 说话'}
      </button>
    </div>
  )
}
