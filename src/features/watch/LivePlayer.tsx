// 实况播放器：一路流三级降级，保证「点开总能看见画面」。
//
//   1. fMP4  —— <video> 直接播 go2rtc 的 /api/stream.mp4，延迟低、无需第三方播放器
//   2. HLS   —— iOS Safari 原生支持 .m3u8，弱网也稳
//   3. 快照  —— 前两者都不行时轮询 frame.jpeg，至少能看到画面在变
//
// 之所以不上 WebRTC：它延迟最低，但需要 ICE/STUN 打通，跨网络环境失败率高；
// go2rtc 的 WebRTC 地址已经在 play() 里返回，网络条件好的部署可以自行切过去。

import { useEffect, useRef, useState } from 'react'
import { api, type PlayUrls } from './api'

type Mode = 'mp4' | 'hls' | 'snapshot'

export function LivePlayer({ cameraId, name }: { cameraId: string; name: string }) {
  const [urls, setUrls] = useState<PlayUrls | null>(null)
  const [mode, setMode] = useState<Mode>('mp4')
  const [error, setError] = useState('')
  const [tick, setTick] = useState(0)
  const videoRef = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    let alive = true
    setUrls(null)
    setError('')
    setMode('mp4')
    api.play(cameraId)
      .then((r) => alive && setUrls(r.urls))
      .catch((e) => alive && setError(e.message))
    return () => { alive = false }
  }, [cameraId])

  // 快照模式下每秒换一次 URL 参数强制刷新
  useEffect(() => {
    if (mode !== 'snapshot') return
    const timer = setInterval(() => setTick((t) => t + 1), 1000)
    return () => clearInterval(timer)
  }, [mode])

  function degrade() {
    setMode((current) => (current === 'mp4' ? 'hls' : 'snapshot'))
  }

  if (error) {
    return <div className="empty"><div className="big">📵</div>{error}</div>
  }
  if (!urls) {
    return <div className="empty"><div className="big">⏳</div>连接 {name}…</div>
  }

  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      {mode === 'snapshot' ? (
        <img
          src={`${urls.snapshot}&_=${tick}`}
          alt={name}
          style={{ width: '100%', display: 'block', background: '#000', aspectRatio: '16/9', objectFit: 'contain' }}
        />
      ) : (
        <video
          ref={videoRef}
          key={mode}
          src={mode === 'mp4' ? urls.mp4 : urls.hls}
          autoPlay
          muted
          playsInline
          controls
          onError={degrade}
          style={{ width: '100%', display: 'block', background: '#000', aspectRatio: '16/9' }}
        />
      )}
      <div className="row spread" style={{ padding: '8px 12px' }}>
        <span className="small muted">
          {name} · {mode === 'mp4' ? '低延迟' : mode === 'hls' ? '兼容模式' : '快照模式'}
        </span>
        <button className="btn" onClick={degrade} disabled={mode === 'snapshot'}>
          播放不出来？切下一种
        </button>
      </div>
    </div>
  )
}
