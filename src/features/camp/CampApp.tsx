import { useEffect, useRef, useState } from 'react'
import { useStore } from '../../store'
import { uid } from '../../lib/id'
import { useChannel } from '../../lib/useChannel'
import { PRESETS, VoiceFX, type VoicePreset } from '../../lib/voicefx'

type ChatKind = 'text' | 'voice' | 'video'
interface ChatMsg {
  id: string
  from: string
  nickname: string
  kind: ChatKind
  text?: string
  media?: string // dataURL
  preset?: string
  ts: number
}

export function CampApp() {
  const { activeGroup } = useStore()
  const [authorized, setAuthorized] = useState(false)
  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [text, setText] = useState('')
  const [preset, setPreset] = useState<VoicePreset>(PRESETS[0])
  const [busy, setBusy] = useState('')
  const logRef = useRef<HTMLDivElement>(null)

  const myId = activeGroup?.myMemberId ?? 'me'
  const myName = activeGroup?.members.find((m) => m.id === myId)?.nickname ?? '我'

  const { send } = useChannel(authorized ? activeGroup?.code ?? null : null, myId, (m) => {
    if (m.kind === 'chat') {
      const msg = m.payload as ChatMsg
      if (msg.from === myId) return
      setMessages((prev) => [...prev, msg])
    }
  })

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages])

  function push(msg: ChatMsg) {
    setMessages((prev) => [...prev, msg])
    send('chat', msg)
  }

  function sendText() {
    if (!text.trim()) return
    push({ id: uid(), from: myId, nickname: myName, kind: 'text', text: text.trim(), ts: Date.now() })
    setText('')
  }

  if (!activeGroup) {
    return (
      <div className="empty">
        <div className="big">🏕️</div>
        <div>请先在「群组」中选择或创建一个群组</div>
      </div>
    )
  }

  if (!authorized) {
    return (
      <div>
        <div className="page-head">
          <h1>营地自组网</h1>
          <p>山里没有信号时，通过蓝牙 / WiFi 自组网让大家互联互通。</p>
        </div>
        <div className="card">
          <h3>开启离线互联</h3>
          <p className="small muted">
            营地常常没有移动网络。授权后，App 将按 <strong>蓝牙 → WiFi直连 → 移动网络</strong> 的优先级
            尝试与附近的同伴自动组网，实现无信号下的文字、语音、视频互通。
          </p>
          <ul className="small muted" style={{ paddingLeft: 18 }}>
            <li>需要授权蓝牙与本地网络权限</li>
            <li>消息在设备间点对点传输，不经过服务器</li>
            <li>Web 版为本机演示（BroadcastChannel）；打包为原生 App 后接入真实 BLE/WiFi Direct</li>
          </ul>
          <button className="btn primary block" onClick={() => setAuthorized(true)}>
            授权并开启自组网
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="camp-screen" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="page-head" style={{ marginBottom: 10 }}>
        <h1>营地群聊 · {activeGroup.name}</h1>
        <p>已开启自组网 · 文字 / 语音 / 视频 · 变声可选</p>
      </div>

      <div className="card" style={{ marginBottom: 10 }}>
        <div className="row spread">
          <span className="small muted">变声（对语音/视频生效）</span>
          <span className="small">{preset.emoji} {preset.name}</span>
        </div>
        <div className="row wrap" style={{ marginTop: 8 }}>
          {PRESETS.map((p) => (
            <button key={p.id} className={`chk ${preset.id === p.id ? 'on' : ''}`} onClick={() => setPreset(p)}>
              {p.emoji} {p.name}
            </button>
          ))}
        </div>
      </div>

      <div ref={logRef} className="chat-log grow" style={{ overflowY: 'auto', padding: '4px 0', minHeight: 120 }}>
        {messages.length === 0 && <div className="empty small">还没有消息，发送第一条吧</div>}
        {messages.map((m) => (
          <div key={m.id} className={`msg ${m.from === myId ? 'me' : ''}`}>
            <div className="who">
              {m.nickname}
              {m.preset && m.preset !== 'off' ? ` · ${presetName(m.preset)}` : ''}
            </div>
            {m.kind === 'text' && <div>{m.text}</div>}
            {m.kind === 'voice' && m.media && <audio src={m.media} controls />}
            {m.kind === 'video' && m.media && <video src={m.media} controls playsInline />}
          </div>
        ))}
      </div>

      {busy && <div className="scan-status">{busy}</div>}

      <div className="composer" style={{ marginTop: 8 }}>
        <input
          className="input grow"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && sendText()}
          placeholder="说点什么…"
        />
        <VoiceRecordButton
          preset={preset}
          onStart={() => setBusy('录音中…松开发送')}
          onDone={(audio) => {
            setBusy('')
            push({ id: uid(), from: myId, nickname: myName, kind: 'voice', media: audio, preset: preset.id, ts: Date.now() })
          }}
          onError={(e) => setBusy(e)}
        />
        <VideoRecordButton
          preset={preset}
          onStart={() => setBusy('录像中…点按停止')}
          onDone={(video) => {
            setBusy('')
            push({ id: uid(), from: myId, nickname: myName, kind: 'video', media: video, preset: preset.id, ts: Date.now() })
          }}
          onError={(e) => setBusy(e)}
        />
        <button className="btn primary" onClick={sendText}>发送</button>
      </div>
    </div>
  )
}

function presetName(id: string): string {
  return PRESETS.find((p) => p.id === id)?.name ?? ''
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader()
    r.onload = () => res(r.result as string)
    r.onerror = rej
    r.readAsDataURL(blob)
  })
}

// 按住录语音，可叠加变声
function VoiceRecordButton({
  preset,
  onStart,
  onDone,
  onError,
}: {
  preset: VoicePreset
  onStart: () => void
  onDone: (audio: string) => void
  onError: (e: string) => void
}) {
  const [rec, setRec] = useState(false)
  const recRef = useRef<MediaRecorder | null>(null)
  const chunks = useRef<Blob[]>([])
  const micRef = useRef<MediaStream | null>(null)
  const fxRef = useRef<VoiceFX | null>(null)

  async function start() {
    try {
      onStart()
      const mic = await navigator.mediaDevices.getUserMedia({ audio: true })
      micRef.current = mic
      let stream = mic
      if (preset.id !== 'off') {
        const fx = new VoiceFX()
        fx.resume()
        fx.setPreset(preset)
        stream = fx.connectMic(mic)
        fxRef.current = fx
      }
      const r = new MediaRecorder(stream)
      chunks.current = []
      r.ondataavailable = (e) => e.data.size && chunks.current.push(e.data)
      r.onstop = async () => {
        const blob = new Blob(chunks.current, { type: 'audio/webm' })
        onDone(await blobToDataUrl(blob))
        micRef.current?.getTracks().forEach((t) => t.stop())
        fxRef.current?.dispose()
        fxRef.current = null
      }
      r.start()
      recRef.current = r
      setRec(true)
    } catch {
      onError('需要麦克风权限')
    }
  }
  function stop() {
    if (recRef.current?.state !== 'inactive') recRef.current?.stop()
    setRec(false)
  }

  return (
    <button
      className={`btn ${rec ? 'danger' : ''}`}
      title="按住说话"
      onPointerDown={(e) => { e.preventDefault(); start() }}
      onPointerUp={stop}
      onPointerLeave={() => rec && stop()}
    >
      🎤
    </button>
  )
}

// 点按开始/停止录视频，音轨可叠加变声
function VideoRecordButton({
  preset,
  onStart,
  onDone,
  onError,
}: {
  preset: VoicePreset
  onStart: () => void
  onDone: (video: string) => void
  onError: (e: string) => void
}) {
  const [rec, setRec] = useState(false)
  const recRef = useRef<MediaRecorder | null>(null)
  const chunks = useRef<Blob[]>([])
  const rawRef = useRef<MediaStream | null>(null)
  const fxRef = useRef<VoiceFX | null>(null)

  async function toggle() {
    if (rec) {
      if (recRef.current?.state !== 'inactive') recRef.current?.stop()
      setRec(false)
      return
    }
    try {
      onStart()
      const raw = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user' },
        audio: true,
      })
      rawRef.current = raw
      let audioTracks = raw.getAudioTracks()
      if (preset.id !== 'off') {
        const fx = new VoiceFX()
        fx.resume()
        fx.setPreset(preset)
        const processed = fx.connectMic(new MediaStream(raw.getAudioTracks()))
        audioTracks = processed.getAudioTracks()
        fxRef.current = fx
      }
      const mixed = new MediaStream([...raw.getVideoTracks(), ...audioTracks])
      const r = new MediaRecorder(mixed, mimeForVideo())
      chunks.current = []
      r.ondataavailable = (e) => e.data.size && chunks.current.push(e.data)
      r.onstop = async () => {
        const blob = new Blob(chunks.current, { type: r.mimeType || 'video/webm' })
        onDone(await blobToDataUrl(blob))
        rawRef.current?.getTracks().forEach((t) => t.stop())
        fxRef.current?.dispose()
        fxRef.current = null
      }
      r.start()
      recRef.current = r
      setRec(true)
    } catch {
      onError('需要摄像头与麦克风权限')
    }
  }

  return (
    <button className={`btn ${rec ? 'danger' : ''}`} title="录视频" onClick={toggle}>
      {rec ? '⏹' : '📹'}
    </button>
  )
}

function mimeForVideo(): MediaRecorderOptions | undefined {
  const candidates = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
  for (const mimeType of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(mimeType)) {
      return { mimeType }
    }
  }
  return undefined
}
