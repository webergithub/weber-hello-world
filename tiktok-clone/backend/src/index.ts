import express from 'express'
import cors from 'cors'
import morgan from 'morgan'
import './db' // init DB
import videosRouter from './routes/videos'
import feedRouter from './routes/feed'
import eventsRouter from './routes/events'

const app = express()
const PORT = process.env.PORT || 3001

app.use(cors())
app.use(morgan('dev'))
app.use(express.json())

// sendBeacon sends text/plain; handle both
app.use('/api/events', (req, _res, next) => {
  if (req.headers['content-type']?.startsWith('text/plain')) {
    let raw = ''
    req.on('data', chunk => { raw += chunk })
    req.on('end', () => {
      try { req.body = JSON.parse(raw) } catch { req.body = {} }
      next()
    })
  } else next()
})

app.use('/api/videos', videosRouter)
app.use('/api/feed', feedRouter)
app.use('/api/events', eventsRouter)

app.get('/api/health', (_req, res) => res.json({ ok: true }))

app.listen(PORT, () => console.log(`Backend running on http://localhost:${PORT}`))
