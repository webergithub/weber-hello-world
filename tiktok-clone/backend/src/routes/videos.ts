import { Router } from 'express'
import db from '../db'

const router = Router()

function rowToVideo(row: Record<string, unknown>) {
  return {
    id: row.id,
    url: row.url,
    cover: row.cover,
    title: row.title,
    author: { id: row.author_id, name: row.author_name, avatar: row.author_avatar },
    stats: { likes: row.likes, comments: row.comments, shares: row.shares },
    tags: JSON.parse(row.tags as string),
    duration: row.duration,
  }
}

router.get('/', (_req, res) => {
  const rows = db.prepare('SELECT * FROM videos ORDER BY created_at DESC LIMIT 50').all() as Record<string, unknown>[]
  res.json(rows.map(rowToVideo))
})

router.get('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM videos WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined
  if (!row) return res.status(404).json({ error: 'not found' })
  res.json(rowToVideo(row))
})

router.post('/:id/like', (req, res) => {
  db.prepare('UPDATE videos SET likes = likes + 1 WHERE id = ?').run(req.params.id)
  const row = db.prepare('SELECT likes FROM videos WHERE id = ?').get(req.params.id) as { likes: number }
  res.json({ likes: row.likes })
})

export default router
