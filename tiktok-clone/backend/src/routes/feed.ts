import { Router } from 'express'
import db from '../db'

const router = Router()

interface VideoRow {
  id: string; url: string; cover: string; title: string
  author_id: string; author_name: string; author_avatar: string
  tags: string; duration: number; likes: number; comments: number; shares: number
  created_at: number
}

interface StatsRow { video_id: string; avg_ratio: number; like_cnt: number; total_events: number }

function score(v: VideoRow, statsMap: Map<string, StatsRow>): number {
  const s = statsMap.get(v.id)
  if (!s) {
    // Cold start: boost recent videos slightly
    const ageDays = (Date.now() / 1000 - v.created_at) / 86400
    return 0.5 + Math.max(0, 0.1 - ageDays * 0.01)
  }
  const watchScore = s.avg_ratio * 0.4
  const likeRate = s.total_events > 0 ? s.like_cnt / s.total_events : 0
  const likeScore = likeRate * 0.3
  const popularityScore = Math.log10(v.likes + 1) / 10 * 0.3
  return watchScore + likeScore + popularityScore
}

router.get('/', (req, res) => {
  const userId = String(req.query.userId || 'anonymous')
  const page = parseInt(String(req.query.page || '0'))
  const limit = Math.min(parseInt(String(req.query.limit || '5')), 20)

  // Get aggregate stats per video from behavior events
  const stats = db.prepare(`
    SELECT
      video_id,
      AVG(watch_ratio) as avg_ratio,
      SUM(CASE WHEN action='like' THEN 1 ELSE 0 END) as like_cnt,
      COUNT(*) as total_events
    FROM events
    GROUP BY video_id
  `).all() as StatsRow[]

  const statsMap = new Map(stats.map(s => [s.video_id, s]))

  // Get videos not yet seen by this user in this session
  const seen = db.prepare(`
    SELECT DISTINCT video_id FROM events WHERE user_id = ? AND action = 'watch'
  `).all(userId) as { video_id: string }[]
  const seenIds = new Set(seen.map(r => r.video_id))

  const allVideos = db.prepare('SELECT * FROM videos').all() as VideoRow[]

  const unseen = allVideos.filter(v => !seenIds.has(v.id))
  const fallback = allVideos // use all if everything seen

  const pool = unseen.length >= limit ? unseen : fallback

  // Score and sort
  const scored = pool
    .map(v => ({ v, s: score(v, statsMap) }))
    .sort((a, b) => b.s - a.s)

  // Paginate
  const slice = scored.slice(page * limit, (page + 1) * limit)

  res.json(slice.map(({ v }) => ({
    id: v.id,
    url: v.url,
    cover: v.cover,
    title: v.title,
    author: { id: v.author_id, name: v.author_name, avatar: v.author_avatar },
    stats: { likes: v.likes, comments: v.comments, shares: v.shares },
    tags: JSON.parse(v.tags),
    duration: v.duration,
  })))
})

export default router
