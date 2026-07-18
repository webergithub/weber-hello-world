import { useEffect, useRef, useState } from 'react'
import { PRESETS, VoiceFX, type VoicePreset } from '../../lib/voicefx'

export function VoiceApp() {
  const [preset, setPreset] = useState<VoicePreset>(PRESETS[1])
  const [monitor, setMonitor] = useState(false)
  const [recording, setRecording] = useState(false)
  const [clips, setClips] = useState<{ url: string; name: string }[]>([])
  const [err, setErr] = useState('')

  const fxRef = useRef<VoiceFX | null>(null)
  const micRef = useRef<MediaStream | null>(null)
  const processedRef = useRef<MediaStream | null>(null)
  const recRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])

  // 初始化引擎 + 麦克风
  async function ensureAudio() {
    if (fxRef.current) return fxRef.current
    const fx = new VoiceFX()
    fx.resume()
    const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
    micRef.current = mic
    processedRef.current = fx.connectMic(mic)
    fx.setPreset(preset)
    fxRef.current = fx
    return fx
  }

  useEffect(() => {
    fxRef.current?.setPreset(preset)
  }, [preset])

  useEffect(() => {
    return () => {
      micRef.current?.getTracks().forEach((t) => t.stop())
      fxRef.current?.dispose()
    }
  }, [])

  async function toggleMonitor() {
    try {
      setErr('')
      const fx = await ensureAudio()
      if (!monitor) {
        fx.monitorToSpeakers()
        setMonitor(true)
      } else {
        // 简化：断开监听即静音输出到扬声器
        fx.output.disconnect(fx.ctx.destination)
        setMonitor(false)
      }
    } catch (e) {
      setErr('需要麦克风权限才能变声。' + (e as Error).message)
    }
  }

  async function toggleRecord() {
    try {
      setErr('')
      const fx = await ensureAudio()
      if (!recording) {
        const stream = processedRef.current!
        const rec = new MediaRecorder(stream)
        chunksRef.current = []
        rec.ondataavailable = (e) => e.data.size && chunksRef.current.push(e.data)
        rec.onstop = () => {
          const blob = new Blob(chunksRef.current, { type: 'audio/webm' })
          const url = URL.createObjectURL(blob)
          setClips((c) => [{ url, name: `${preset.name}-${c.length + 1}` }, ...c])
        }
        rec.start()
        recRef.current = rec
        fx.resume()
        setRecording(true)
      } else {
        recRef.current?.stop()
        setRecording(false)
      }
    } catch (e) {
      setErr('录音失败：' + (e as Error).message)
    }
  }

  return (
    <div>
      <div className="page-head">
        <h1>趣味变声 🎭</h1>
        <p>把你的声音变成卡通角色。可单独玩，也能在「营地」语音/视频中开启。</p>
      </div>

      <div className="card">
        <h3>选择角色</h3>
        <div className="row wrap">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              className={`chk ${preset.id === p.id ? 'on' : ''}`}
              onClick={() => setPreset(p)}
              style={{ fontSize: 15, padding: '10px 12px' }}
            >
              <span style={{ fontSize: 18 }}>{p.emoji}</span> {p.name}
            </button>
          ))}
        </div>
        <p className="small muted" style={{ marginTop: 10 }}>
          当前：{preset.emoji} <strong>{preset.name}</strong> — {preset.desc}
        </p>
      </div>

      <div className="card">
        <h3>试听与录制</h3>
        <div className="row">
          <button className={`btn grow ${monitor ? 'accent' : ''}`} onClick={toggleMonitor}>
            {monitor ? '🔇 关闭实时试听' : '🎧 实时试听'}
          </button>
          <button className={`btn grow ${recording ? 'danger' : 'primary'}`} onClick={toggleRecord}>
            {recording ? '⏹ 停止录音' : '⏺ 录一段'}
          </button>
        </div>
        <p className="small muted" style={{ marginTop: 8 }}>
          实时试听请戴耳机，否则扬声器声音会回灌产生啸叫。
        </p>
        {err && <p className="small" style={{ color: 'var(--danger)' }}>{err}</p>}
      </div>

      {clips.length > 0 && (
        <div className="card">
          <h3>我的变声作品</h3>
          {clips.map((c, i) => (
            <div key={i} className="list-item">
              <span className="grow">{c.name}</span>
              <audio src={c.url} controls style={{ height: 34 }} />
              <a className="btn sm" href={c.url} download={`${c.name}.webm`}>下载</a>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
