import { useEffect, useRef, useState, useCallback } from 'react'
import VideoPlayer from './VideoPlayer'
import { useFeed } from '../hooks/useFeed'

export default function VideoFeed() {
  const { videos, loading, loadMore, reportEvent } = useFeed()
  const [current, setCurrent] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)
  const startY = useRef(0)
  const watchRatio = useRef(0)

  useEffect(() => { loadMore() }, [])

  // Prefetch: load more when 2 videos from the end
  useEffect(() => {
    if (videos.length > 0 && current >= videos.length - 2) loadMore()
  }, [current, videos.length])

  const goNext = useCallback(() => {
    if (current < videos.length - 1) {
      reportEvent(videos[current].id, 'watch', watchRatio.current)
      watchRatio.current = 0
      setCurrent(c => c + 1)
    }
  }, [current, videos, reportEvent])

  const goPrev = useCallback(() => {
    if (current > 0) setCurrent(c => c - 1)
  }, [current])

  // Touch handling
  const onTouchStart = (e: React.TouchEvent) => { startY.current = e.touches[0].clientY }
  const onTouchEnd = (e: React.TouchEvent) => {
    const dy = startY.current - e.changedTouches[0].clientY
    if (Math.abs(dy) > 50) { dy > 0 ? goNext() : goPrev() }
  }

  // Wheel handling (desktop)
  const onWheel = useCallback((e: WheelEvent) => {
    e.preventDefault()
    if (e.deltaY > 30) goNext()
    else if (e.deltaY < -30) goPrev()
  }, [goNext, goPrev])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [onWheel])

  if (videos.length === 0) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center',
        height: '100%', color: '#fff', fontSize: 18 }}>
        {loading ? '加载中...' : '暂无视频'}
      </div>
    )
  }

  return (
    <div ref={containerRef} style={styles.feed}
      onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
      {videos.map((v, i) => (
        <div key={v.id} style={{
          ...styles.slide,
          transform: `translateY(${(i - current) * 100}%)`,
          transition: 'transform 0.3s cubic-bezier(0.25,0.46,0.45,0.94)',
        }}>
          <VideoPlayer
            video={v}
            active={i === current}
            onProgress={r => { watchRatio.current = r }}
          />
        </div>
      ))}
      {loading && (
        <div style={styles.loadingBar}>加载中...</div>
      )}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  feed: {
    position: 'relative', width: '100%', height: '100%', overflow: 'hidden',
  },
  slide: {
    position: 'absolute', top: 0, left: 0, width: '100%', height: '100%',
  },
  loadingBar: {
    position: 'absolute', bottom: 20, left: '50%', transform: 'translateX(-50%)',
    color: 'rgba(255,255,255,0.5)', fontSize: 13,
  },
}
