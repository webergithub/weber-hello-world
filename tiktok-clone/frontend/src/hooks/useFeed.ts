import { useState, useCallback } from 'react'
import type { Video } from '../types'

const USER_ID = 'user_' + Math.random().toString(36).slice(2, 8)

export function useFeed() {
  const [videos, setVideos] = useState<Video[]>([])
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(0)

  const loadMore = useCallback(async () => {
    if (loading) return
    setLoading(true)
    try {
      const res = await fetch(`/api/feed?userId=${USER_ID}&page=${page}&limit=5`)
      const data: Video[] = await res.json()
      setVideos(prev => [...prev, ...data])
      setPage(p => p + 1)
    } catch (e) {
      console.error('Feed load failed', e)
    } finally {
      setLoading(false)
    }
  }, [loading, page])

  const reportEvent = useCallback(async (videoId: string, action: string, watchRatio: number) => {
    navigator.sendBeacon('/api/events', JSON.stringify({
      videoId, userId: USER_ID, action, watchRatio, timestamp: Date.now(),
    }))
  }, [])

  return { videos, loading, loadMore, reportEvent }
}
