import { Router } from 'express'
import db from '../db'

const router = Router()

const insert = db.prepare(`
  INSERT INTO events (video_id, user_id, action, watch_ratio, ts)
  VALUES (?, ?, ?, ?, ?)
`)

router.post('/', (req, res) => {
  const { videoId, userId, action, watchRatio, timestamp } = req.body
  if (!videoId || !userId || !action) return res.status(400).json({ error: 'missing fields' })

  insert.run(
    String(videoId),
    String(userId),
    String(action),
    Number(watchRatio) || 0,
    Number(timestamp) || Date.now(),
  )

  // Update video stats based on action
  if (action === 'like') {
    db.prepare('UPDATE videos SET likes = likes + 1 WHERE id = ?').run(videoId)
  } else if (action === 'comment') {
    db.prepare('UPDATE videos SET comments = comments + 1 WHERE id = ?').run(videoId)
  } else if (action === 'share') {
    db.prepare('UPDATE videos SET shares = shares + 1 WHERE id = ?').run(videoId)
  }

  res.json({ ok: true })
})

export default router
