import { useRef, useEffect, useState, forwardRef, useImperativeHandle } from 'react'
import type { Video } from '../types'

interface Props {
  video: Video
  active: boolean
  onProgress: (ratio: number) => void
}

export interface VideoPlayerHandle {
  play: () => void
  pause: () => void
}

const VideoPlayer = forwardRef<VideoPlayerHandle, Props>(({ video, active, onProgress }, ref) => {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [liked, setLiked] = useState(false)
  const [likeCount, setLikeCount] = useState(video.stats.likes)
  const [paused, setPaused] = useState(false)

  useImperativeHandle(ref, () => ({
    play: () => videoRef.current?.play(),
    pause: () => videoRef.current?.pause(),
  }))

  useEffect(() => {
    const el = videoRef.current
    if (!el) return
    if (active) {
      el.currentTime = 0
      el.play().catch(() => {})
      setPaused(false)
    } else {
      el.pause()
    }
  }, [active])

  useEffect(() => {
    const el = videoRef.current
    if (!el) return
    const onTime = () => onProgress(el.currentTime / (el.duration || 1))
    el.addEventListener('timeupdate', onTime)
    return () => el.removeEventListener('timeupdate', onTime)
  }, [onProgress])

  const togglePlay = () => {
    const el = videoRef.current
    if (!el) return
    if (el.paused) { el.play(); setPaused(false) }
    else { el.pause(); setPaused(true) }
  }

  const handleLike = (e: React.MouseEvent) => {
    e.stopPropagation()
    setLiked(l => !l)
    setLikeCount(c => liked ? c - 1 : c + 1)
  }

  return (
    <div style={styles.container} onClick={togglePlay}>
      <video
        ref={videoRef}
        src={video.url}
        style={styles.video}
        loop
        muted
        playsInline
        preload="auto"
      />
      {paused && <div style={styles.pauseIcon}>▶</div>}

      {/* Author & caption */}
      <div style={styles.info}>
        <div style={styles.author}>@{video.author.name}</div>
        <div style={styles.title}>{video.title}</div>
        <div style={styles.tags}>{video.tags.map(t => `#${t}`).join(' ')}</div>
      </div>

      {/* Action buttons */}
      <div style={styles.actions}>
        <ActionBtn icon={liked ? '❤️' : '🤍'} count={likeCount} onClick={handleLike} />
        <ActionBtn icon="💬" count={video.stats.comments} onClick={e => e.stopPropagation()} />
        <ActionBtn icon="↗️" count={video.stats.shares} onClick={e => e.stopPropagation()} />
      </div>
    </div>
  )
})

VideoPlayer.displayName = 'VideoPlayer'
export default VideoPlayer

function ActionBtn({ icon, count, onClick }: {
  icon: string; count: number; onClick: (e: React.MouseEvent) => void
}) {
  return (
    <div style={styles.actionBtn} onClick={onClick}>
      <span style={{ fontSize: 28 }}>{icon}</span>
      <span style={styles.actionCount}>{fmtCount(count)}</span>
    </div>
  )
}

function fmtCount(n: number) {
  return n >= 10000 ? `${(n / 10000).toFixed(1)}w` : String(n)
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    position: 'relative', width: '100%', height: '100%',
    background: '#000', overflow: 'hidden', cursor: 'pointer',
  },
  video: { width: '100%', height: '100%', objectFit: 'cover' },
  pauseIcon: {
    position: 'absolute', top: '50%', left: '50%',
    transform: 'translate(-50%,-50%)',
    fontSize: 60, color: 'rgba(255,255,255,0.8)',
    pointerEvents: 'none',
  },
  info: {
    position: 'absolute', bottom: 80, left: 16, right: 70,
    color: '#fff', textShadow: '0 1px 4px rgba(0,0,0,0.6)',
  },
  author: { fontWeight: 700, fontSize: 16, marginBottom: 6 },
  title: { fontSize: 14, marginBottom: 6, lineHeight: 1.4 },
  tags: { fontSize: 13, color: '#e0e0e0' },
  actions: {
    position: 'absolute', right: 12, bottom: 90,
    display: 'flex', flexDirection: 'column', gap: 20, alignItems: 'center',
  },
  actionBtn: {
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    gap: 4, cursor: 'pointer', userSelect: 'none',
  },
  actionCount: { color: '#fff', fontSize: 12, fontWeight: 600 },
}
